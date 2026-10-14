'use strict';

// Full-text search across every session's transcript: `GET /api/search`.
//
// The rail's filter matches a title, the first and last prompt and a path, so
// "the session where I fixed the mirrored-networking thing" was unfindable unless
// those words happened to be in one of them. This keeps the words you and Claude
// actually said, per session, where a query can reach them all.
//
// Decided:
//
// - **An index, not brute force.** docs/plans/03-search.md argued for walking
//   the raw JSONL per query. That was written against ~300MB; the corpus here is
//   over a gigabyte, and most of it is tool output nobody is searching for. The
//   argument against an index was staleness, and bridge/turn-index.js already
//   settled how to keep one honest against a file Claude Code appends to: the
//   same `consumed` offset, the same first-line hash, the same rebuild on a file
//   that shrank or was swapped. This copies that shape exactly.
//
// - **Kept outside the transcript,** in CACHE_DIR/search/<id>.json, compact
//   JSON, one file per session — for the reasons turn-index.js gives.
//
// - **Turns are the turn index's turns.** Every line is parsed through
//   `buildEvents`, and a `user` event's uuid and line offset are what the turn
//   index records as a mark. So a hit's `turnId` is a tick on the rail the page
//   can jump to, and its `turnOffset` is a window boundary `/range` accepts —
//   no second idea of where a turn starts.
//
// - **What is kept, and how much.** Your messages and Claude's prose, each
//   clipped at TEXT_MAX. Tool calls are kept too, but clipped hard (TOOL_MAX,
//   input and result together) and only searched when asked: they are most of a
//   transcript's bytes and almost all of its noise. Thinking is not kept.
//
// - **Never a long stall.** `update` takes a byte budget and stops at a line
//   boundary inside it, holding the rest for the next call, so the warmer
//   (below) can build a 50MB transcript in slices of a few milliseconds and a
//   query can stop mid-session when its time is up. A line that is huge and is
//   only a tool result (a 20MB `cat`) is skipped unparsed — it can carry no turn.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { CACHE_DIR } = require('./config');
const { buildEvents } = require('./transcript');
const { linesFrom } = require('./turn-index');

const INDEX_DIR = path.join(CACHE_DIR, 'search');
// Bump when what is stored, or how it is derived, changes.
const INDEX_VERSION = 1;

const TEXT_MAX = 16_000;
const TOOL_MAX = 1_200;
const HEAD_BYTES = 4096;
// A tool-result line larger than this is skipped rather than parsed.
const HUGE_LINE = 1 << 20;
// Calls still waiting on their result, remembered across reads. Bounded: a call
// that was interrupted never gets one.
const OPEN_MAX = 200;
// What is held in memory at once, as characters of text. Above it the least
// recently used indexes are dropped and reloaded from disk when next asked for.
const MEM_MAX = 96 * 1024 * 1024;
// Progress on a session not yet caught up is written out at least this often.
const SAVE_EVERY = 8 * 1024 * 1024;
// How much a query reads of a session that is behind before checking its clock.
// A query runs on the bridge's one thread, so its budget is a stall; the warmer
// does the bulk of a cold build and a query only tops up what is newest.
const QUERY_SLICE = 1024 * 1024;

const KIND_CODE = { user: 'u', assistant: 'a', tool: 't' };
const KIND_NAME = { u: 'user', a: 'assistant', t: 'tool' };

const clip = (s, n) => {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function toolText(ev) {
    let input = '';
    const i = ev.input || {};
    // The fields a person would search a call by, before falling back to the
    // whole input: a command, a path, a pattern, a description.
    const lead = [i.command, i.file_path, i.path, i.pattern, i.url, i.description, i.prompt]
        .filter(v => typeof v === 'string');
    input = lead.length ? lead.join(' ') : JSON.stringify(i);
    return clip(`${ev.name || ''} ${input}`, Math.floor(TOOL_MAX / 2));
}

function resultText(result) {
    const t = result && typeof result.text === 'string' ? result.text : '';
    return t ? clip(t, Math.ceil(TOOL_MAX / 2)) : '';
}

/** Read `[from, to)` of a file. */
function readRange(file, from, to) {
    const len = Math.max(0, to - from);
    const buf = Buffer.alloc(len);
    if (!len) return buf;
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
    return buf;
}

function headOf(file, size) {
    const n = Math.min(size, HEAD_BYTES);
    if (!n) return '';
    const buf = readRange(file, 0, n);
    const nl = buf.indexOf(0x0a);
    return crypto.createHash('sha1').update(nl === -1 ? buf : buf.subarray(0, nl)).digest('hex');
}

/** Every line, except a huge one that can only be a tool result. */
function wantLine(s) {
    return !(s.length > HUGE_LINE && s.includes('"tool_result"') && !s.includes('"type":"assistant"'));
}

/** Rough size of an index in memory, for the LRU. */
function weigh(idx) {
    let n = 0;
    for (const d of idx.docs) n += d[3].length;
    return n + idx.turns.length * 64;
}

/**
 * Add what `lines` say to `idx`. Lines are in file order.
 */
function absorb(idx, lines) {
    if (!lines.length) return;
    const offsetOf = new Map();
    for (const { entry, offset } of lines) if (entry.uuid) offsetOf.set(entry.uuid, offset);
    const { events } = buildEvents(lines.map(l => l.entry));
    const open = new Map(Object.entries(idx.open));
    for (const ev of events) {
        const t = idx.turns.length - 1;
        if (ev.kind === 'user') {
            const offset = offsetOf.get(ev.id);
            if (offset === undefined) continue;
            idx.turns.push([ev.id, offset, ev.ts || null]);
            if (ev.text) idx.docs.push([t + 1, 'u', ev.id, clip(ev.text, TEXT_MAX)]);
        } else if (ev.kind === 'assistant') {
            idx.docs.push([t, 'a', ev.id, clip(ev.text, TEXT_MAX)]);
        } else if (ev.kind === 'tool') {
            const r = resultText(ev.result);
            idx.docs.push([t, 't', ev.id, r ? `${toolText(ev)}\n${r}` : toolText(ev)]);
            if (!ev.result) open.set(ev.id, idx.docs.length - 1);
        } else if (ev.kind === 'tool-result' && open.has(ev.toolId)) {
            const d = idx.docs[open.get(ev.toolId)];
            const r = resultText(ev.result);
            if (d && d[2] === ev.toolId && r) d[3] = `${d[3]}\n${r}`;
            open.delete(ev.toolId);
        }
    }
    // Only the newest calls are worth waiting on.
    const keep = [...open.entries()].slice(-OPEN_MAX);
    idx.open = Object.fromEntries(keep);
}

class SearchIndex {
    constructor(dir = INDEX_DIR, { memMax = MEM_MAX } = {}) {
        this.dir = dir;
        this.memMax = memMax;
        /** sessionId -> index, in least-recently-used order. */
        this.mem = new Map();
        this.memSize = 0;
        /** sessionId -> bytes consumed when last written to disk. */
        this.savedAt = new Map();
        /**
         * sessionId -> [file, consumed] for every index on disk, so asking
         * whether one is behind costs a stat and not a parse of the index. Read
         * once; written, a little behind, as indexes are saved.
         */
        this.manifest = null;
        this._manifestTimer = null;
    }

    _manifestPath() {
        return path.join(this.dir, '_manifest.json');
    }

    _known(sessionId) {
        if (!this.manifest) {
            this.manifest = new Map();
            try {
                const m = JSON.parse(fs.readFileSync(this._manifestPath(), 'utf8'));
                if (m && m.version === INDEX_VERSION) {
                    for (const [id, v] of Object.entries(m.sessions || {})) this.manifest.set(id, v);
                }
            } catch { /* none yet */ }
        }
        return this.manifest.get(sessionId) || null;
    }

    _note(sessionId, idx) {
        this._known(sessionId);
        if (idx) this.manifest.set(sessionId, [idx.file, idx.consumed]);
        else this.manifest.delete(sessionId);
        if (this._manifestTimer) return;
        this._manifestTimer = setTimeout(() => this.flushManifest(), 2000);
        this._manifestTimer.unref();
    }

    flushManifest() {
        clearTimeout(this._manifestTimer);
        this._manifestTimer = null;
        if (!this.manifest) return;
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const dest = this._manifestPath();
            const tmp = `${dest}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({
                version: INDEX_VERSION, sessions: Object.fromEntries(this.manifest),
            }));
            fs.renameSync(tmp, dest);
        } catch { /* rebuilt from the indexes' own files on demand */ }
    }

    _path(sessionId) {
        return path.join(this.dir, `${sessionId}.json`);
    }

    _remember(sessionId, idx) {
        const had = this.mem.get(sessionId);
        if (had) { this.memSize -= had._w || 0; this.mem.delete(sessionId); }
        idx._w = weigh(idx);
        this.mem.set(sessionId, idx);
        this.memSize += idx._w;
        for (const [id, old] of this.mem) {
            if (this.memSize <= this.memMax || id === sessionId) break;
            // Partial progress is written before it is let go, or a slice of
            // work would be thrown away and done again.
            if (old.consumed !== this.savedAt.get(id)) this._save(id, old);
            this.mem.delete(id);
            this.memSize -= old._w || 0;
        }
    }

    _load(sessionId) {
        const held = this.mem.get(sessionId);
        if (held) {
            // Touch, for the LRU.
            this.mem.delete(sessionId);
            this.mem.set(sessionId, held);
            return held;
        }
        try {
            const idx = JSON.parse(fs.readFileSync(this._path(sessionId), 'utf8'));
            if (idx.version === INDEX_VERSION) {
                this.savedAt.set(sessionId, idx.consumed);
                this._remember(sessionId, idx);
                return idx;
            }
        } catch { /* none yet */ }
        return null;
    }

    _save(sessionId, idx) {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const dest = this._path(sessionId);
            const tmp = `${dest}.${process.pid}.tmp`;
            const { _w, ...plain } = idx;
            fs.writeFileSync(tmp, JSON.stringify(plain));
            fs.renameSync(tmp, dest);
            this.savedAt.set(sessionId, idx.consumed);
            this._note(sessionId, idx);
        } catch { /* an optimisation; the next read rebuilds it */ }
    }

    /**
     * Is this session's index behind its file? One stat; never a parse.
     */
    stale(sessionId, file) {
        let st;
        try { st = fs.statSync(file); } catch { return false; }
        const held = this.mem.get(sessionId);
        const [f, consumed] = held ? [held.file, held.consumed] : (this._known(sessionId) || []);
        return f !== file || consumed !== st.size;
    }

    /**
     * The index for this transcript, brought up to date with the file — or as
     * far towards it as `maxBytes` of new bytes allows. Returns null if the file
     * cannot be read. `idx.done` says whether it reached the end.
     */
    update(sessionId, file, { maxBytes = Infinity } = {}) {
        let st;
        try { st = fs.statSync(file); } catch { return null; }
        let idx = this._load(sessionId);
        let head = null;
        const fresh = () => ({
            version: INDEX_VERSION, file, head, consumed: 0, turns: [], docs: [], open: {},
        });
        try {
            if (!idx || idx.file !== file || st.size < idx.consumed) {
                head = headOf(file, st.size);
                idx = fresh();
            } else if (st.size === idx.consumed) {
                idx.done = true;
                return idx;
            } else {
                // Checked only when there is something to read anyway, so an
                // unchanged file costs one stat — turn-index.js's bargain.
                head = headOf(file, st.size);
                if (head !== idx.head) idx = fresh();
            }
            if (!idx.head) idx.head = head;

            // Read up to the budget, and further only if not one whole line fit:
            // progress has to be made, and a line cannot be read in halves.
            let want = Math.min(st.size - idx.consumed, Math.max(1, maxBytes));
            let buf;
            let got;
            for (;;) {
                buf = readRange(file, idx.consumed, idx.consumed + want);
                got = linesFrom(buf, idx.consumed, wantLine);
                if (got.consumed || idx.consumed + want >= st.size) break;
                want = Math.min(st.size - idx.consumed, want * 4);
            }
            absorb(idx, got.lines);
            // A read that reached the end of the file is caught up even if a
            // last line is left over: that line has no newline yet, so it is
            // still being written and is not ours to read.
            idx.done = idx.consumed + want >= st.size;
            idx.consumed += got.consumed;
        } catch { return null; }
        this._remember(sessionId, idx);
        const last = this.savedAt.get(sessionId) || 0;
        if (idx.done || idx.consumed - last >= SAVE_EVERY || idx.consumed < last) {
            this._save(sessionId, idx);
        }
        return idx;
    }

    /** Whatever is held for this session, without touching its file. */
    peek(sessionId) {
        return this._load(sessionId);
    }

    forget(sessionId) {
        const had = this.mem.get(sessionId);
        if (had) { this.memSize -= had._w || 0; this.mem.delete(sessionId); }
        this.savedAt.delete(sessionId);
        this._note(sessionId, null);
        try { fs.rmSync(this._path(sessionId), { force: true }); } catch { /* none */ }
    }
}

// -- queries ----------------------------------------------------------------

/**
 * Words, all required, and `"quoted phrases"` kept whole. Case-insensitive.
 * Returns the needles, lower-cased, longest first so the rarest is tried first.
 */
function parseQuery(q) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(String(q || '')))) {
        const t = (m[1] !== undefined ? m[1] : m[2]).trim().toLowerCase();
        if (t && !out.includes(t)) out.push(t);
    }
    return out.sort((a, b) => b.length - a.length);
}

const SNIP_BEFORE = 60;
const SNIP_AFTER = 140;

/**
 * The text around the first needle found, cut into segments with every needle
 * occurrence inside the window marked. Plain strings — the page puts them in
 * text nodes and a `<mark>`, never into innerHTML.
 */
function snippet(text, lower, needles) {
    let first = -1;
    for (const n of needles) {
        const i = lower.indexOf(n);
        if (i !== -1 && (first === -1 || i < first)) first = i;
    }
    if (first === -1) first = 0;
    let from = Math.max(0, first - SNIP_BEFORE);
    let to = Math.min(text.length, first + SNIP_AFTER);
    // Do not start or end in the middle of a word when there is a space near.
    if (from > 0) { const sp = text.indexOf(' ', from); if (sp !== -1 && sp < first) from = sp + 1; }
    if (to < text.length) { const sp = text.lastIndexOf(' ', to); if (sp > first) to = sp; }

    const marks = [];
    const win = lower.slice(from, to);
    for (const n of needles) {
        let i = win.indexOf(n);
        while (i !== -1) { marks.push([i, i + n.length]); i = win.indexOf(n, i + n.length); }
    }
    marks.sort((a, b) => a[0] - b[0]);
    const segs = [];
    const flat = (s) => s.replace(/\s+/g, ' ');
    if (from > 0) segs.push({ text: '…', hit: false });
    let at = 0;
    for (const [s, e] of marks) {
        if (s < at) continue;   // overlapping needles: the first wins
        if (s > at) segs.push({ text: flat(text.slice(from + at, from + s)), hit: false });
        segs.push({ text: text.slice(from + s, from + e), hit: true });
        at = e;
    }
    if (at < win.length) segs.push({ text: flat(text.slice(from + at, to)), hit: false });
    if (to < text.length) segs.push({ text: '…', hit: false });
    return segs;
}

/**
 * The hits in one session's index. Every needle has to be in the same message,
 * not merely somewhere in the session: a session that mentions "build" once and
 * "flaky" once, an hour apart, is not the one you were looking for.
 */
function matchIndex(idx, needles, kinds, perSession) {
    const hits = [];
    let count = 0;
    for (const d of idx.docs) {
        if (!kinds.has(d[1])) continue;
        const text = d[3];
        const lower = text.toLowerCase();
        let all = true;
        for (const n of needles) if (!lower.includes(n)) { all = false; break; }
        if (!all) continue;
        count++;
        if (hits.length >= perSession) continue;
        const turn = d[0] >= 0 ? idx.turns[d[0]] : null;
        hits.push({
            turnId: turn ? turn[0] : null,
            turnOffset: turn ? turn[1] : 0,
            turnNo: d[0] + 1,
            eventId: d[2],
            kind: KIND_NAME[d[1]],
            ts: turn ? turn[2] : null,
            segments: snippet(text, lower, needles),
        });
    }
    return { hits, count };
}

const clampInt = (v, dflt, lo, hi) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * Search every session the list would show.
 *
 * `candidates` is [{sessionId, file, summary}], newest first — what
 * SessionIndex.searchCandidates hands over, already without temporary and (on
 * the everyday bridge) test sessions. Each is brought up to date while the time
 * budget lasts; once it runs out, what is already indexed is still searched and
 * the sessions left behind their files are counted in `pending`, so a cold index
 * answers at once and says it is still filling rather than stalling.
 */
function search(sidx, candidates, { q, kinds = ['user', 'assistant'], limit, perSession,
    budgetMs = 600, now = () => Date.now() } = {}) {
    const started = now();
    const needles = parseQuery(q);
    limit = clampInt(limit, 30, 1, 100);
    perSession = clampInt(perSession, 5, 1, 20);
    const kindSet = new Set(kinds.map(k => KIND_CODE[k]).filter(Boolean));
    if (!kindSet.size) kindSet.add('u').add('a');

    const sessions = [];
    let pending = 0;
    let truncated = false;
    let matched = 0;
    for (const c of candidates) {
        let idx;
        if (now() - started < budgetMs) {
            idx = sidx.update(c.sessionId, c.file, { maxBytes: QUERY_SLICE });
            // A big session is caught up in slices, while the budget holds.
            while (idx && !idx.done && now() - started < budgetMs) {
                idx = sidx.update(c.sessionId, c.file, { maxBytes: QUERY_SLICE });
            }
            if (idx && !idx.done) pending++;
        } else {
            idx = sidx.peek(c.sessionId);
            if (sidx.stale(c.sessionId, c.file)) pending++;
        }
        if (!idx || !needles.length) continue;
        const { hits, count } = matchIndex(idx, needles, kindSet, perSession);
        if (!count) continue;
        matched++;
        if (sessions.length >= limit) { truncated = true; continue; }
        const s = c.summary || {};
        sessions.push({
            sessionId: c.sessionId,
            title: s.title || null,
            projectName: s.projectName || null,
            cwd: s.cwd || null,
            projectCwd: s.projectCwd || null,
            mtimeMs: s.mtimeMs || null,
            test: Boolean(s.test),
            turns: idx.turns.length,
            hitCount: count,
            more: Math.max(0, count - hits.length),
            hits,
        });
    }
    return {
        query: q, terms: needles, kinds: [...kindSet].map(k => KIND_NAME[k]),
        sessions, matched, truncated, pending, elapsedMs: now() - started,
    };
}

// -- the warmer ---------------------------------------------------------------

/**
 * Builds the index in the background, a slice at a time.
 *
 * Each tick does one bounded `update` — SLICE_BYTES of transcript at most, which
 * is a couple of milliseconds of parsing — and then gives the event loop back
 * with a timer, not `setImmediate`, so a request that arrives meanwhile is never
 * behind more than one slice. Once a pass finds nothing stale it sleeps for
 * IDLE_MS; a query that left sessions pending wakes it.
 *
 * `list` returns the candidates as search() takes them; it is asked again at the
 * start of every pass, so new sessions are picked up and deleted ones dropped.
 */
class Warmer {
    constructor(sidx, list, { sliceBytes = 192 * 1024, gapMs = 15, idleMs = 120_000,
        startMs = 30_000 } = {}) {
        this.sidx = sidx;
        this.list = list;
        this.sliceBytes = sliceBytes;
        this.gapMs = gapMs;
        this.idleMs = idleMs;
        this.startMs = startMs;
        this.queue = [];
        this.timer = null;
        this.stopped = true;
    }

    start() {
        this.stopped = false;
        this._schedule(this.startMs);
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.timer);
        this.timer = null;
    }

    /** Something is behind: start a pass now rather than after the idle sleep. */
    poke() {
        if (this.stopped || this.queue.length) return;
        this._schedule(this.gapMs);
    }

    _schedule(ms) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this._tick(), ms);
        this.timer.unref();
    }

    _tick() {
        if (this.stopped) return;
        try {
            if (!this.queue.length) {
                this.queue = this.list().map(c => ({ sessionId: c.sessionId, file: c.file }));
                this._passHadWork = false;
            }
            // Skip what is current — a stat each — until there is a slice to do.
            let did = false;
            let checked = 0;
            while (this.queue.length && !did && checked < 50) {
                const c = this.queue[0];
                checked++;
                if (!this.sidx.stale(c.sessionId, c.file)) { this.queue.shift(); continue; }
                const held = this.sidx.mem.get(c.sessionId);
                const before = held ? held.consumed : -1;
                const idx = this.sidx.update(c.sessionId, c.file, { maxBytes: this.sliceBytes });
                if (!idx || idx.done) this.queue.shift();
                did = true;
                // A file ending in a line still being written is "behind" with
                // nothing to read; only real progress earns another pass.
                if (idx && idx.consumed !== before) this._passHadWork = true;
            }
            if (this.queue.length) return this._schedule(this.gapMs);
            // A pass that did work may have raced an append; go round once more.
            return this._schedule(this._passHadWork ? this.gapMs : this.idleMs);
        } catch (err) {
            console.error(`[tgxcode] search index warm failed: ${err.message}`);
            this.queue = [];
            return this._schedule(this.idleMs);
        }
    }
}

module.exports = {
    SearchIndex, Warmer, search, parseQuery, snippet, matchIndex,
    INDEX_DIR, INDEX_VERSION, TEXT_MAX, TOOL_MAX,
};
