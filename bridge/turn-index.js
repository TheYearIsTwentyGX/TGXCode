'use strict';

// A small index of the moments in a transcript the turn rail marks — every
// message you sent, every plan and every question — with the byte offset each
// one starts at.
//
// It exists so a long conversation can be opened from its end. The rail wants
// the whole conversation (a tick per turn, and "Turn 3 of 40" means 40), and
// before this the only way to know the turns was to parse and draw every event,
// which on a 6MB transcript is the lag you feel on open. With the index the
// bridge reads, and the page draws, the last few turns; the rail is drawn from
// the index; and the offsets are where an earlier chunk can be read from when
// you scroll up or click a tick you have not loaded.
//
// Decided:
//
// - **Kept outside the transcript**, in CACHE_DIR/turns/<id>.json. The `.jsonl`
//   is Claude Code's: it appends to it while we read, and resumes from it.
//   Writing anything of ours into it risks both.
//
// - **Incremental.** Transcripts are append-only, so the index remembers how
//   far it has read (`consumed`) and parses only what was added since. A file
//   that shrank, a different file (conversationRecord picked the other copy),
//   or a different first line means the file was replaced, and it is rebuilt.
//
// - **Filtered before parsing,** the way scanMeta is. Most of a transcript's
//   bytes are assistant output and tool results, and none of that is a mark.
//   Only lines that could be one reach JSON.parse, and those go through
//   `buildEvents` itself so a turn's text, command and a plan's outcome come out
//   exactly as the full read derives them — never a second interpretation of
//   the same entry.
//
// - **A plan or question's offset is the turn it belongs to,** not its own line,
//   so every offset in the index is a place a window can begin without starting
//   halfway through a turn.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { CACHE_DIR } = require('./config');
const { buildEvents } = require('./transcript');

const INDEX_DIR = path.join(CACHE_DIR, 'turns');
// Bump when a mark's shape or derivation changes, so an old file is rebuilt
// rather than served.
const INDEX_VERSION = 1;

const REVIEWABLE = { ExitPlanMode: 'plan', AskUserQuestion: 'question' };
// What the rail's popover shows of a message; more would be bytes on every open.
const TEXT_MAX = 460;
const HEAD_BYTES = 4096;

const clip = (s, n) => {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/**
 * Split a buffer into complete lines with the byte offset each starts at,
 * parsing only those `want` accepts. Like parseLines, a final line with no
 * newline is left for the next read.
 */
function linesFrom(buf, base, want) {
    const out = [];
    let consumed = 0;
    let start = 0;
    while (true) {
        const nl = buf.indexOf(0x0a, start);
        if (nl === -1) break;
        const off = start;
        const slice = buf.subarray(start, nl);
        start = nl + 1;
        consumed = start;
        if (!slice.length) continue;
        const s = slice.toString('utf8');
        if (!want(s)) continue;
        let entry;
        try { entry = JSON.parse(s); } catch { continue; /* partial */ }
        out.push({ entry, offset: base + off });
        if (want.saw) want.saw(entry);
    }
    return { lines: out, consumed };
}

/**
 * Could this line be a mark, or settle one? Substring tests on the raw JSON,
 * which Claude Code writes compact — `"type":"user"` inside a message's text is
 * escaped and cannot match.
 */
function wanted(pendingIds) {
    // Grows as the read goes: a plan asked and answered inside the same read
    // has to have its answer kept, and it was not pending when the read began.
    const pending = new Set(pendingIds);
    const want = (s) => {
        if (s.includes('"ExitPlanMode"') || s.includes('"AskUserQuestion"')) return true;
        if (s.includes('"type":"attachment"')) return s.includes('queued_command');
        if (!s.includes('"type":"user"')) return false;
        // A tool result is never a turn; it matters only if it answers a plan or
        // a question we are still waiting on. These are the big lines, so this
        // is most of the saving.
        if (s.includes('"tool_result"')) {
            for (const id of pending) if (s.includes(id)) return true;
            return false;
        }
        return true;
    };
    want.saw = (entry) => {
        const content = entry.type === 'assistant' && entry.message && entry.message.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
            if (b.type === 'tool_use' && REVIEWABLE[b.name] && b.id) pending.add(b.id);
        }
    };
    return want;
}

function toolMark(ev, offset) {
    const input = ev.input || {};
    return {
        kind: REVIEWABLE[ev.name], id: ev.id, offset, ts: ev.ts || null, name: ev.name,
        status: ev.status || 'pending',
        // Just what the rail says about it: toolSummary reads these two.
        input: ev.name === 'ExitPlanMode'
            ? { plan: clip(input.plan, 200) }
            : { questions: (input.questions || []).map(q => ({ header: q.header || null,
                question: clip(q.question, 200) })) },
        result: resultStub(ev.result),
    };
}

function resultStub(r) {
    if (!r) return null;
    return { text: clip(r.text, 200), planWasEdited: Boolean(r.planWasEdited) };
}

/**
 * Add the marks found in `lines` to `idx`. `lines` are in file order.
 */
function absorb(idx, lines) {
    if (!lines.length) return false;
    const offsetOf = new Map();
    for (const { entry, offset } of lines) if (entry.uuid) offsetOf.set(entry.uuid, offset);
    const { events } = buildEvents(lines.map(l => l.entry));
    let changed = false;
    let turnAt = idx.marks.length
        ? idx.marks[idx.marks.length - 1].offset : 0;
    for (const ev of events) {
        if (ev.kind === 'user') {
            const offset = offsetOf.get(ev.id);
            if (offset === undefined) continue;
            turnAt = offset;
            idx.marks.push({
                kind: 'turn', id: ev.id, offset, ts: ev.ts || null,
                text: clip(ev.text, TEXT_MAX), command: ev.command || null,
                images: (ev.images || []).length,
            });
            changed = true;
        } else if (ev.kind === 'tool' && REVIEWABLE[ev.name]) {
            if (idx.marks.some(m => m.id === ev.id)) continue;
            idx.marks.push(toolMark(ev, turnAt));
            if (!ev.result) idx.pending.push(ev.id);
            changed = true;
        } else if (ev.kind === 'tool-result' && idx.pending.includes(ev.toolId)) {
            const m = idx.marks.find(x => x.id === ev.toolId);
            if (m) { m.status = ev.status || m.status; m.result = resultStub(ev.result); }
            idx.pending = idx.pending.filter(id => id !== ev.toolId);
            changed = true;
        }
    }
    return changed;
}

function headOf(file, size) {
    const n = Math.min(size, HEAD_BYTES);
    if (!n) return '';
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
    const nl = buf.indexOf(0x0a);
    return crypto.createHash('sha1').update(nl === -1 ? buf : buf.subarray(0, nl)).digest('hex');
}

function readRange(file, from, to) {
    const len = to - from;
    const buf = Buffer.alloc(len);
    if (!len) return buf;
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
    return buf;
}

class TurnIndex {
    constructor(dir = INDEX_DIR) {
        this.dir = dir;
        /** @type {Map<string, object>} */
        this.mem = new Map();
    }

    _path(sessionId) {
        return path.join(this.dir, `${sessionId}.json`);
    }

    _load(sessionId) {
        if (this.mem.has(sessionId)) return this.mem.get(sessionId);
        try {
            const idx = JSON.parse(fs.readFileSync(this._path(sessionId), 'utf8'));
            if (idx.version === INDEX_VERSION) { this.mem.set(sessionId, idx); return idx; }
        } catch { /* none yet */ }
        return null;
    }

    _save(sessionId, idx) {
        this.mem.set(sessionId, idx);
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const dest = this._path(sessionId);
            const tmp = `${dest}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(idx));
            fs.renameSync(tmp, dest);
        } catch { /* an optimisation; the next open rebuilds it */ }
    }

    /**
     * The index for this transcript, brought up to date with the file.
     * Returns null if the file cannot be read.
     */
    update(sessionId, file) {
        let st;
        try { st = fs.statSync(file); } catch { return null; }
        let idx = this._load(sessionId);
        let head = null;
        const fresh = () => ({ version: INDEX_VERSION, file, head, consumed: 0, marks: [], pending: [] });
        try {
            if (!idx || idx.file !== file || st.size < idx.consumed) {
                head = headOf(file, st.size);
                idx = fresh();
            } else if (st.size === idx.consumed) {
                return idx;
            } else {
                // Grown. The first line is checked only now, when there is
                // something to read anyway, so an unchanged file costs one stat.
                head = headOf(file, st.size);
                if (head !== idx.head) idx = fresh();
            }
            const buf = readRange(file, idx.consumed, st.size);
            const { lines, consumed } = linesFrom(buf, idx.consumed, wanted(idx.pending));
            if (idx.consumed === 0 && !idx.head) idx.head = head;
            absorb(idx, lines);
            idx.consumed += consumed;
        } catch { return null; }
        this._save(sessionId, idx);
        return idx;
    }

    forget(sessionId) {
        this.mem.delete(sessionId);
        try { fs.rmSync(this._path(sessionId), { force: true }); } catch { /* none */ }
    }
}

/** The offsets a window may begin or end at: the start, and every turn. */
function boundaries(idx) {
    const set = new Set([0]);
    for (const m of idx.marks) set.add(m.offset);
    return set;
}

module.exports = { TurnIndex, boundaries, linesFrom, wanted, INDEX_DIR, INDEX_VERSION };
