'use strict';

// Where a session stands, in one line, for its rail card.
//
// The rail says *which* sessions exist and whether they are running; it does
// not say what any of them is waiting for, so triaging it meant opening each one
// and reading its last reply. This is that last reply, boiled down —
// "PR #150 opened, waiting on review", "blocked: needs DB password" — and
// written down after each turn so the rail can show it for nothing.
//
// What it decided, and why:
//
//   * **A short model call, with the last reply as the fallback.** The final
//     assistant message is the cheapest source and it is often fine, but its
//     last line is as likely to be "Let me know if you want anything else" as a
//     status. So one `claude -p` on haiku is asked to say it in a line, and if
//     that fails — timeout, auth, a non-zero exit, an empty answer — the line is
//     extracted from the reply instead, and marked `source: 'extract'` so the
//     rail can tell the two apart.
//
//   * **`claude -p`, not an API client.** `"dependencies": {}` is load-bearing
//     (CLAUDE.md), and the CLI is already authenticated. bridge/beacon.js is the
//     other background `claude` and the one this borrows from — `cfg.CLAUDE_BIN`
//     (so tests can stub it), the scrubbed environment, an empty MCP config, a
//     timeout and a process-group kill — but not its approach: the beacon runs a
//     TUI and sends nothing, because what it wants is the status line. This
//     wants an answer. `--no-session-persistence` is what keeps it out of
//     `~/.claude/projects` and so out of the rail; measured, it writes nothing.
//     `--system-prompt` replaces the agent prompt (without it haiku tries to run
//     the tests it was asked to summarise), `--tools ""` and
//     `--setting-sources ""` keep it from doing anything or firing the user's
//     hooks, and cwd is STATE_DIR so no project's CLAUDE.md is read.
//
//   * **Only sessions this bridge runs.** `turn-complete` is the only reliable
//     "a turn just ended" there is. A session in a terminal shows up only as a
//     transcript that changed, and summarising on that would spend quota on
//     every write of a turn still in progress. Those sessions carry
//     `standing: null` — or the line from the last turn the bridge did run,
//     which stays until the next one replaces it.
//
//   * **Quota is spent at most once per reply.** Three guards:
//       - debounce: nothing happens until DEBOUNCE_MS after the turn ends, and
//         if the session is busy again by then (a quick follow-up, a queued
//         message) the call is dropped; the next turn-complete re-arms it.
//       - cache by uuid: the key is the uuid of the transcript's last assistant
//         entry. If it matches what is stored, nothing is called — which is what
//         makes the turn-complete re-emitted for an adopted turn after a bridge
//         restart free.
//       - failed turns never call; their line is extracted.
//     And one call at a time, in order, so a burst of idle sessions is a queue
//     rather than a fan-out.
//
//   * **Stored in STATE_DIR/standing.json, never in a transcript.** Those belong
//     to Claude Code. One row per session `{uuid, text, source, at}`, merged on
//     write the way the other shared stores here are, because every bridge on
//     the machine shares STATE_DIR and a whole-file rewrite from a stale
//     snapshot would drop another bridge's lines. Pruned against the index at
//     boot and on delete.
//
//   * **Opt-out is `standing.mode` in ~/.tgxcode/settings.json** — `'model'`
//     (default), `'extract'` (the line, at no quota cost) or `'off'` (no line and
//     no work). User-only: a project file is checked into a repository, and
//     whether this machine spends quota is not that repository's call.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const cfg = require('./config');
const { STATE_DIR } = cfg;
const { writeAtomic, readJson } = require('./jsonfile');
const { deleteBoth } = require('./legacy-env');

const STATE_FILE = path.join(STATE_DIR, 'standing.json');
const VERSION = 1;
const MAX_LEN = 80;
const DEBOUNCE_MS = 15_000;
const TIMEOUT_MS = 60_000;
const TAIL_BYTES = 256 * 1024;
const REPLY_CHARS = 3000;
const MODES = ['model', 'extract', 'off'];

const SYSTEM_PROMPT = 'You write one-line status notes for a list of coding sessions. '
    + 'Given the last request and the final reply of a session, answer with ONE line of at most '
    + `${MAX_LEN} characters saying where the session stands, for example `
    + '"PR #150 opened, waiting on review", "blocked: needs DB password", '
    + '"tests passing, ready to land". Lead with the state, not the topic. '
    + 'No quotes, no preamble, no markdown.';

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

/**
 * The last assistant entry with text in it, from the tail of a transcript.
 *
 * The tail is read from an arbitrary byte offset, so its first line is usually
 * half a line; anything that does not parse is skipped rather than fatal.
 * Sidechain entries are a subagent talking, not the session, and an entry that
 * is only tool calls says nothing about where things stand.
 * @returns {{uuid: string, text: string} | null}
 */
function lastAssistant(tail) {
    if (typeof tail !== 'string' || !tail) return null;
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line || line[0] !== '{') continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (!e || e.type !== 'assistant' || e.isSidechain || !e.uuid) continue;
        const content = e.message && e.message.content;
        let text = '';
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
            text = content.filter(b => b && b.type === 'text' && typeof b.text === 'string')
                .map(b => b.text).join('\n');
        }
        text = text.trim();
        if (!text) continue;
        return { uuid: e.uuid, text };
    }
    return null;
}

/** Markdown off one line: links to their text, emphasis and code marks gone. */
function plainLine(s) {
    return s
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/`+/g, '')
        .replace(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/g, '$2')
        .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function clip(s, max = MAX_LEN) {
    if (s.length <= max) return s;
    const cut = s.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '') + '…';
}

/**
 * The fallback line: the last line of the reply that is prose, cleaned and cut.
 * Code blocks and tables are skipped — a closing ``` or a table row is not a
 * status — and so is a bare sign-off, which is where replies usually end.
 */
function extractLine(text) {
    if (typeof text !== 'string') return '';
    const out = [];
    let fence = false;
    for (const raw of text.split('\n')) {
        if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
        if (fence) continue;
        if (/^\s*\|/.test(raw) || /^\s*[-=*_]{3,}\s*$/.test(raw)) continue;
        const line = plainLine(raw);
        if (line) out.push(line);
    }
    const signoff = /^(let me know|happy to|feel free|hope this helps|anything else)/i;
    for (let i = out.length - 1; i >= 0; i--) {
        if (out.length > 1 && signoff.test(out[i])) continue;
        return clip(out[i]);
    }
    return '';
}

/** What the model is handed on stdin. */
function buildPrompt(lastPrompt, reply) {
    const ask = typeof lastPrompt === 'string' ? lastPrompt.trim().slice(0, 600) : '';
    const said = typeof reply === 'string' ? reply.trim().slice(-REPLY_CHARS) : '';
    return `Last request:\n${ask || '(unknown)'}\n\nFinal reply:\n${said}\n`;
}

/** The model's answer, held to one clean line; '' if there is nothing usable. */
function cleanModelLine(stdout) {
    if (typeof stdout !== 'string') return '';
    const first = stdout.split('\n').map(s => s.trim()).find(Boolean) || '';
    const line = plainLine(first).replace(/^(status|standing)\s*:\s*/i, '')
        .replace(/^["'“‘]+|["'”’]+$/g, '').trim();
    return line ? clip(line) : '';
}

/** Is a fresh line needed for this reply, given what is stored? */
function shouldSummarise(entry, uuid) {
    if (!uuid) return false;
    return !entry || entry.uuid !== uuid;
}

function normalizeMode(m) { return MODES.includes(m) ? m : 'model'; }

/**
 * One pending call per key, re-armed by each note. Timers are injected so the
 * test can drive it with a fake clock.
 */
class Debouncer {
    constructor(ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
        this.ms = ms;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.pending = new Map();
    }
    arm(key, fn) {
        this.cancel(key);
        const t = this.setTimer(() => { this.pending.delete(key); fn(); }, this.ms);
        if (t && typeof t.unref === 'function') t.unref();
        this.pending.set(key, t);
    }
    cancel(key) {
        const t = this.pending.get(key);
        if (t === undefined) return false;
        this.clearTimer(t);
        this.pending.delete(key);
        return true;
    }
    clear() { for (const k of [...this.pending.keys()]) this.cancel(k); }
    get size() { return this.pending.size; }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function cleanRow(r) {
    if (!r || typeof r !== 'object') return null;
    if (typeof r.text !== 'string' || !r.text) return null;
    return {
        uuid: typeof r.uuid === 'string' ? r.uuid : null,
        text: r.text.slice(0, MAX_LEN + 1),
        source: r.source === 'model' ? 'model' : 'extract',
        at: Number.isFinite(r.at) ? r.at : 0,
    };
}

class StandingStore {
    constructor(file = STATE_FILE) {
        this.file = file;
        this.rows = new Map();
        this._removed = new Set();
        this._load();
    }
    _read() {
        const doc = readJson(this.file, { maxBytes: 4 * 1024 * 1024 }).data;
        const out = new Map();
        this._foreign = false;
        if (!doc || typeof doc !== 'object' || !doc.sessions) return out;
        // A file written by a newer build is read but never rewritten: the next
        // write would put a version 1 document over one that build owns.
        this._foreign = Number(doc.version) > VERSION;
        for (const [id, r] of Object.entries(doc.sessions)) {
            const row = cleanRow(r);
            if (row) out.set(id, row);
        }
        return out;
    }
    _load() { this.rows = this._read(); }
    get(id) { return this.rows.get(id) || null; }
    set(id, row) {
        const clean = cleanRow(row);
        if (!clean) return null;
        this.rows.set(id, clean);
        this._removed.delete(id);
        this._save(id);
        return clean;
    }
    delete(id) {
        const had = this.rows.delete(id);
        this._removed.add(id);
        if (had) this._save(null);
        return had;
    }
    /** Drop rows whose session is gone. `known` is a Set of ids. */
    prune(known) {
        let n = 0;
        for (const id of [...this.rows.keys()]) {
            if (!known.has(id)) { this.rows.delete(id); this._removed.add(id); n++; }
        }
        if (n) this._save(null);
        return n;
    }
    /** Merge-on-write: what is on disk now, plus the row written, minus deletions. */
    _save(changed) {
        const disk = this._read();
        if (this._foreign) return;
        // What is on disk is the truth for every row but the one being written:
        // another bridge may have written lines since we last read.
        for (const id of this._removed) disk.delete(id);
        if (changed && this.rows.has(changed)) disk.set(changed, this.rows.get(changed));
        this.rows = disk;
        const sessions = {};
        for (const [id, row] of disk) sessions[id] = row;
        try {
            writeAtomic(this.file, JSON.stringify({ version: VERSION, sessions }, null, 2) + '\n');
        } catch (err) {
            console.error(`[tgxcode] could not save session standing: ${err.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// The feature
// ---------------------------------------------------------------------------

/** The last TAIL_BYTES of a file, as text; '' if it cannot be read. */
function readTail(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, TAIL_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return buf.toString('utf8');
    } catch { return ''; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

class Standing extends EventEmitter {
    /**
     * @param {object} o
     * @param {() => string} o.mode           'model' | 'extract' | 'off'
     * @param {(id: string) => any} o.record  the index record ({file, meta})
     * @param {(id: string) => boolean} o.busy is the runner working again?
     * @param {(id: string) => string|null} [o.resultText] the runner's last text
     */
    constructor({ mode, record, busy, resultText = () => null, store, debounceMs = DEBOUNCE_MS,
        timers, summarise } = {}) {
        super();
        this.mode = () => normalizeMode(mode ? mode() : 'model');
        this.record = record;
        this.busy = busy || (() => false);
        this.resultText = resultText;
        this.store = store || new StandingStore();
        this.debounce = new Debouncer(debounceMs, timers);
        this.summarise = summarise || ((prompt) => this._callModel(prompt));
        this.queue = Promise.resolve();
        this.child = null;
    }

    /** What `/api/sessions` carries for this session. */
    forSession(id) {
        if (this.mode() === 'off') return null;
        const row = this.store.get(id);
        return row ? { text: row.text, source: row.source, at: row.at } : null;
    }

    /** A turn ended. `r` is the pool's turn-complete payload. */
    noteTurn(r) {
        if (!r || !r.sessionId || this.mode() === 'off') return;
        const id = r.sessionId;
        const failed = !!r.isError;
        this.debounce.arm(id, () => {
            this.queue = this.queue.then(() => this._refresh(id, failed))
                .catch(err => console.error(`[tgxcode] session standing failed: ${err && err.message}`));
        });
    }

    async _refresh(id, failed) {
        const mode = this.mode();
        if (mode === 'off' || this.busy(id)) return null;
        const rec = this.record(id);
        const last = rec && rec.file ? lastAssistant(readTail(rec.file)) : null;
        const reply = last ? last.text : (this.resultText(id) || '');
        if (!reply) return null;
        const uuid = last ? last.uuid : null;
        // No uuid means the transcript could not be read; the runner's text still
        // makes a line, but nothing can be cached against, so do not pay for it.
        if (uuid && !shouldSummarise(this.store.get(id), uuid)) return null;

        let text = '';
        let source = 'extract';
        if (mode === 'model' && !failed && uuid) {
            const lastPrompt = rec && rec.meta ? (rec.meta.lastPrompt || rec.meta.firstPrompt) : '';
            try { text = cleanModelLine(await this.summarise(buildPrompt(lastPrompt, reply))); }
            catch { text = ''; }
            if (text) source = 'model';
            // The answer took a while; a session that started working meanwhile
            // has moved past the reply this line is about.
            if (this.busy(id)) return null;
        }
        if (!text) text = extractLine(reply);
        if (!text) return null;
        const row = this.store.set(id, { uuid, text, source, at: Date.now() });
        if (row) this.emit('changed', { sessionId: id, standing: this.forSession(id) });
        return row;
    }

    _callModel(prompt) {
        return new Promise((resolve, reject) => {
            const env = { ...process.env };
            delete env.CLAUDE_CODE_ENTRYPOINT;
            delete env.CLAUDE_CODE_SIMPLE;
            delete env.TGXCODE_SESSION_ID;
            deleteBoth(env, 'PORT');
            try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* spawn will say */ }
            const proc = spawn(cfg.CLAUDE_BIN, [
                '-p', '--no-session-persistence', '--model', 'haiku',
                '--tools', '', '--setting-sources', '',
                '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                '--system-prompt', SYSTEM_PROMPT,
            ], { cwd: STATE_DIR, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
            this.child = proc;
            let out = '';
            let done = false;
            const finish = (err, val) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                this.child = null;
                if (err) { this._kill(proc); reject(err); } else resolve(val);
            };
            const timer = setTimeout(() => finish(new Error('timed out')), TIMEOUT_MS);
            timer.unref();
            proc.stdout.on('data', (d) => { if (out.length < 8192) out += d; });
            proc.stderr.on('data', () => { /* discarded; the fallback is the report */ });
            proc.on('error', (err) => finish(err));
            proc.on('close', (code) => code === 0 ? finish(null, out) : finish(new Error(`exit ${code}`)));
            proc.stdin.on('error', () => { /* closed early; close reports it */ });
            proc.stdin.end(prompt);
        });
    }

    _kill(proc) {
        if (!proc || !proc.pid || proc.pid <= 1) return;
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ }
    }

    forget(id) {
        this.debounce.cancel(id);
        return this.store.delete(id);
    }

    prune(known) { return this.store.prune(known); }

    shutdown() {
        this.debounce.clear();
        this._kill(this.child);
    }
}

module.exports = {
    Standing, StandingStore, Debouncer, STATE_FILE, MODES, MAX_LEN, DEBOUNCE_MS,
    lastAssistant, extractLine, buildPrompt, cleanModelLine, shouldSummarise, normalizeMode,
};
