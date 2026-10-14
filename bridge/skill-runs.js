'use strict';

// Every skill, slash command and subagent a session ran, with where each one
// started, when it ended and the text it finished with. What the Reviews pane
// is built from: bridge/code-reviews.js picks out the runs whose skill is one of
// the configured review types, and reads their findings.
//
// Decided:
//
// - **Unfiltered.** The index records every run, not only the ones that are
//   reviews today, so changing which skills count as reviews (Settings → Code
//   reviews) is a filter at query time rather than a rebuild of every index.
//   A run is small; the one big field is the text it finished with, which is
//   capped.
//
// - **Shaped by what the transcripts actually hold**, read off ~1,100 of them:
//
//   · A **forked** skill (`code-review` runs this way) leaves only its result in
//     the parent: the Skill call's tool_result reads `Skill "x" completed
//     (forked execution).\n\nResult:\n…`, and `toolUseResult` carries
//     `{status: "forked", agentId, result}`. Its findings, if it reported any
//     with the ReportFindings tool, are only in the fork's own file under
//     `<id>/subagents/agent-<agentId>.jsonl` — read at query time, not here.
//
//   · An **inline** skill answers `Launching skill: x`, has its body injected as
//     an `isMeta` user entry, and then the model simply works. So does a slash
//     command: a user entry carrying `<command-name>/x</command-name>`. There is
//     no end marker for either; the run ends at the next prompt you typed, and
//     its result is the last assistant text before it that looks like a review
//     (a verdict line, a findings heading, a `file:line`), else the last text.
//
//   · A **subagent** is an Agent (or the older Task) call. Its result is in its
//     own transcript — often the parent only has a pointer to a handback — so
//     this records the agent id and leaves the reading to query time too.
//
// - **Incremental and filtered before parsing**, turn-index.js's two rules. A
//   transcript is append-only, so the index remembers how far it read; most of
//   its bytes cannot start or settle a run, so only lines that could reach
//   JSON.parse. The exception is while an inline run is open: then every
//   assistant line might be its result, and every prompt might end it.
//
// - **`prompt_snapshot` attachments are skipped by name.** Each one lists every
//   tool's definition, so it contains `"name":"Skill"` and `ReportFindings` and
//   is hundreds of kilobytes — the commonest false positive a substring test has.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { CACHE_DIR } = require('./config');
const { parseCommand } = require('./transcript');

const INDEX_DIR = path.join(CACHE_DIR, 'skill-runs');
// Bump when a run's shape or derivation changes, so an old file is rebuilt.
const INDEX_VERSION = 2;

const TEXT_MAX = 200 * 1024;
const PROMPT_MAX = 2000;
const ARGS_MAX = 2000;
const HEAD_BYTES = 4096;

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const FORKED_RE = /completed \(forked execution\)\.?(?:\s*Result:[ \t]*\n)?\s*/;
const TASK_NOTE_RE = /<task-notification>[\s\S]*?<tool-use-id>([^<]+)<\/tool-use-id>/;
const TASK_STATUS_RE = /<status>([^<]+)<\/status>/;

const clip = (s, n) => {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// What makes an assistant text a review's result rather than its preamble or
// the "want me to fix these?" after it.
const REVIEWISH = [
    /^[ \t]*(?:[#>*-]+[ \t]*)?(?:\*\*)?VERDICT(?:\*\*)?[ \t]*:/im,
    /^#{1,4}[ \t]+[^\n]*\b(?:critical|warnings?|findings?|notes|issues|review)\b/im,
    /[A-Za-z0-9_$-]\.[A-Za-z0-9]{1,8}:\d+/,
];
const reviewish = (t) => REVIEWISH.some(re => re.test(t));

function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
}

/**
 * Could this line start, settle or end a run? Substring tests on the raw JSON,
 * which Claude Code writes compact.
 */
function wanted(idx) {
    return (s) => {
        if (s.includes('"type":"attachment"')) {
            return !s.includes('prompt_snapshot') && s.includes('task-notification');
        }
        if (s.includes('"isSidechain":true')) return false;
        if (s.includes('"type":"pr-link"')) return true;
        if (s.includes('"type":"system"')) {
            return s.includes('"local_command"') && (Boolean(idx.open) || s.includes('"content":"/'));
        }
        if (s.includes('"type":"assistant"')) {
            if (idx.open) return true;
            return s.includes('"name":"Skill"') || s.includes('"name":"Agent"') || s.includes('"name":"Task"');
        }
        if (!s.includes('"type":"user"')) return false;
        if (s.includes('"tool_result"')) {
            for (const id of idx.pending) if (s.includes(id)) return true;
            return false;
        }
        if (s.includes('task-notification')) return true;
        return Boolean(idx.open) || s.includes('command-name') || s.includes('"content":"/');
    };
}

function findRun(idx, id) {
    for (let i = idx.runs.length - 1; i >= 0; i--) if (idx.runs[i].id === id) return idx.runs[i];
    return null;
}

function closeOpen(idx) {
    const run = idx.open && findRun(idx, idx.open);
    idx.open = null;
    if (!run) return;
    run.status = 'done';
    if (!run.endedAt) run.endedAt = run.lastTs || run.startedAt;
}

function openRun(idx, run) {
    closeOpen(idx);
    idx.runs.push(run);
    idx.open = run.id;
}

/** Fold one transcript entry into the index. `offset` is where its line starts. */
function absorbEntry(idx, e, offset) {
    if (!e || typeof e !== 'object') return;
    const ts = e.timestamp || null;

    if (e.type === 'pr-link') {
        if (Number.isInteger(e.prNumber)) {
            idx.prLink = { number: e.prNumber, url: e.prUrl || null, repo: e.prRepository || null };
        }
        return;
    }

    if (e.type === 'attachment') {
        const a = e.attachment || {};
        const m = TASK_NOTE_RE.exec(typeof a.prompt === 'string' ? a.prompt : '');
        if (m) settleAsync(idx, m[1].trim(), a.prompt, ts);
        return;
    }

    if (e.isSidechain) return;

    // A slash command the bridge sent over stream-json is run by Claude Code
    // itself, and leaves no assistant turn: the command is a plain `/name args`
    // user entry (below) or a `local_command` system entry echoing it, and what
    // it printed — a forked review's whole result — is a second `local_command`
    // entry wrapped in <local-command-stdout>.
    if (e.type === 'system') {
        if (e.subtype !== 'local_command' || typeof e.content !== 'string') return;
        const out = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)(?:<\/local-command-\1>\s*)?$/.exec(e.content);
        if (out) {
            const run = idx.open && findRun(idx, idx.open);
            if (!run || run.via !== 'command') return;
            const text = out[2].trim();
            run.resultText = clip(text, TEXT_MAX);
            run.status = out[1] === 'stderr' || /^Unknown (?:command|skill)\b/.test(text) ? 'error' : 'done';
            run.endedAt = ts;
            run.printed = true;
            idx.open = null;
            return;
        }
        const typed = slashOf(e.content);
        if (typed && e.uuid) openRun(idx, commandRun(e, typed, offset, ts, idx));
        return;
    }

    const content = e.message && e.message.content;

    if (e.type === 'assistant') {
        if (!Array.isArray(content)) return;
        for (const b of content) {
            if (!b) continue;
            if (b.type === 'tool_use' && b.name === 'Skill' && b.id) {
                const input = b.input || {};
                idx.runs.push({
                    id: b.id, via: 'skill', skill: String(input.skill || ''),
                    args: clip(input.args, ARGS_MAX), forked: false, agentId: null,
                    anchor: { kind: 'tool', id: b.id, offset },
                    startedAt: ts, endedAt: null, status: 'running',
                    resultText: null, lastText: null, prLink: idx.prLink || null,
                });
                idx.pending.push(b.id);
            } else if (b.type === 'tool_use' && AGENT_TOOLS.has(b.name) && b.id) {
                const input = b.input || {};
                idx.runs.push({
                    id: b.id, via: 'agent', skill: String(input.subagent_type || 'general-purpose'),
                    args: clip(input.description, ARGS_MAX), prompt: clip(input.prompt, PROMPT_MAX),
                    forked: false, agentId: null, async: false,
                    anchor: { kind: 'tool', id: b.id, offset },
                    startedAt: ts, endedAt: null, status: 'running',
                    resultText: null, lastText: null, prLink: idx.prLink || null,
                });
                idx.pending.push(b.id);
            } else if (b.type === 'text' && idx.open && b.text && b.text.trim()) {
                const run = findRun(idx, idx.open);
                if (!run) continue;
                const t = clip(b.text, TEXT_MAX);
                if (reviewish(t)) { run.resultText = t; run.lastText = null; }
                else run.lastText = t;
            }
        }
        if (idx.open) {
            const run = findRun(idx, idx.open);
            if (run) run.lastTs = ts || run.lastTs;
        }
        return;
    }

    if (e.type !== 'user') return;

    if (Array.isArray(content) && content.some(b => b && b.type === 'tool_result')) {
        for (const b of content) {
            if (!b || b.type !== 'tool_result' || !idx.pending.includes(b.tool_use_id)) continue;
            settleResult(idx, b, e.toolUseResult, ts);
        }
        return;
    }
    // A skill's body, the caveat a local command leaves, a compaction summary:
    // none of them is you typing, so none of them ends a run.
    if (e.isMeta || e.isCompactSummary) return;
    const text = textOf(content);
    const note = TASK_NOTE_RE.exec(text);
    if (note && /^\s*<task-notification>/.test(text)) {
        settleAsync(idx, note[1].trim(), text, ts);
        return;
    }
    if (/^\s*<local-command-(?:stdout|stderr|caveat)>/.test(text)) return;
    if (!text.trim() && !(Array.isArray(content) && content.some(b => b && b.type === 'image'))) return;

    // A prompt you typed. It ends whatever inline run was open, and is one if it
    // is a slash command.
    closeOpen(idx);
    const command = parseCommand(text) || (typeof content === 'string' ? slashOf(content) : null);
    if (command && command.name && e.uuid) openRun(idx, commandRun(e, command, offset, ts, idx));
}

// `/code-review low` as typed — the whole entry, one command name and its
// arguments. Prose that merely starts with a slash (a path) is not one: the
// name has to be followed by whitespace or the end.
function slashOf(text) {
    const m = /^\/([A-Za-z][A-Za-z0-9:_.-]*)(?:[ \t]+([\s\S]*))?$/.exec(String(text).trim());
    return m ? { name: m[1], args: (m[2] || '').trim() } : null;
}

function commandRun(e, command, offset, ts, idx) {
    return {
        id: e.uuid, via: 'command', skill: command.name,
        args: clip(command.args, ARGS_MAX), forked: false, agentId: null,
        // What ties a forked skill's own transcript to the prompt that ran it,
        // when nothing in the parent names its agent id.
        promptId: e.promptId || null,
        anchor: { kind: 'turn', id: e.uuid, offset },
        startedAt: ts, endedAt: null, status: 'running',
        resultText: null, lastText: null, prLink: idx.prLink || null,
    };
}

function settleResult(idx, block, tur, ts) {
    const run = findRun(idx, block.tool_use_id);
    idx.pending = idx.pending.filter(id => id !== block.tool_use_id);
    if (!run) return;
    const text = typeof block.content === 'string' ? block.content : textOf(block.content);
    const rejected = (typeof tur === 'string' && /rejected/i.test(tur))
        || /^(?:User rejected|The user doesn't want|\[Request interrupted)/.test(text);

    if (run.via === 'skill') {
        if (tur && typeof tur === 'object' && tur.status === 'forked') {
            run.forked = true;
            run.agentId = tur.agentId || null;
            run.resultText = clip(typeof tur.result === 'string' ? tur.result : text.replace(/^[\s\S]*?Result:\s*\n/, ''), TEXT_MAX);
            run.status = 'done';
            run.endedAt = ts;
        } else if (FORKED_RE.test(text)) {
            run.forked = true;
            run.resultText = clip(text.slice(text.search(FORKED_RE)).replace(FORKED_RE, ''), TEXT_MAX);
            run.status = 'done';
            run.endedAt = ts;
        } else if (rejected) {
            run.status = 'rejected';
            run.endedAt = ts;
        } else if (/^Launching skill:/.test(text.trim()) || (tur && tur.success === true)) {
            // Inline: the run is the rest of this turn.
            closeOpen(idx);
            idx.open = run.id;
            run.lastTs = ts;
        } else {
            run.status = 'error';
            run.endedAt = ts;
            run.resultText = clip(text, 2000);
        }
        return;
    }

    // An agent.
    if (tur && typeof tur === 'object') {
        if (tur.agentId) run.agentId = tur.agentId;
        if (tur.status === 'async_launched' || tur.isAsync) {
            run.async = true;
            return;   // settled by its task-notification
        }
    }
    if (rejected) { run.status = 'rejected'; run.endedAt = ts; return; }
    run.status = block.is_error ? 'error' : 'done';
    run.endedAt = ts;
    run.resultText = clip(text, TEXT_MAX);
}

function settleAsync(idx, toolUseId, note, ts) {
    const run = findRun(idx, toolUseId);
    if (!run || run.via !== 'agent' || run.status !== 'running') return;
    const status = TASK_STATUS_RE.exec(note || '');
    run.status = status && /fail|error|kill/i.test(status[1]) ? 'error' : 'done';
    run.endedAt = ts;
    // The agent's final text, when it did not hand its report back separately.
    const result = /<result>([\s\S]*?)<\/result>/.exec(note || '');
    if (result) run.resultText = clip(result[1].trim(), TEXT_MAX);
}

/**
 * Split a buffer into complete lines and absorb the ones `want` accepts, in
 * order — the filter depends on what the lines before it opened, so this is one
 * pass rather than turn-index's filter-then-absorb.
 */
function absorbBuffer(idx, buf, base) {
    const want = wanted(idx);
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
        try { entry = JSON.parse(s); } catch { continue; }
        absorbEntry(idx, entry, base + off);
    }
    return consumed;
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

class SkillRunIndex {
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
        } catch { /* an optimisation; the next request rebuilds it */ }
    }

    /**
     * The runs in this transcript, brought up to date with the file, plus the
     * file's mtime (so a caller can tell an open run that is still being
     * written from one whose session went quiet). Null if it cannot be read.
     */
    update(sessionId, file) {
        let st;
        try { st = fs.statSync(file); } catch { return null; }
        let idx = this._load(sessionId);
        let head = null;
        const fresh = () => ({ version: INDEX_VERSION, file, head, consumed: 0,
            runs: [], pending: [], open: null, prLink: null });
        try {
            if (!idx || idx.file !== file || st.size < idx.consumed) {
                head = headOf(file, st.size);
                idx = fresh();
            } else if (st.size === idx.consumed) {
                return { idx, mtimeMs: st.mtimeMs };
            } else {
                head = headOf(file, st.size);
                if (head !== idx.head) idx = fresh();
            }
            const buf = readRange(file, idx.consumed, st.size);
            if (idx.consumed === 0 && !idx.head) idx.head = head;
            idx.consumed += absorbBuffer(idx, buf, idx.consumed);
        } catch { return null; }
        this._save(sessionId, idx);
        return { idx, mtimeMs: st.mtimeMs };
    }

    forget(sessionId) {
        this.mem.delete(sessionId);
        try { fs.rmSync(this._path(sessionId), { force: true }); } catch { /* none */ }
    }
}

module.exports = { SkillRunIndex, absorbEntry, reviewish, INDEX_DIR, INDEX_VERSION };
