'use strict';

// Tokens and API-equivalent cost, per session, per project and per day, read
// out of the transcripts' `message.usage`.
//
// Why the transcripts and not the runner. A turn's result carries
// `total_cost_usd`, but only for turns this bridge ran, and on a subscription
// plan it is not a bill (bridge/usage.js). Measured against one, the figure
// computed here came out within 1% of it. The transcripts cover every session on the
// machine — the ones started in a terminal, and the history from before this
// app existed — and carry the exact token counts. The cost is computed from
// them at list prices (bridge/pricing.js), and is labelled API-equivalent
// everywhere it is shown. A finished turn is used only as a nudge to re-read
// that session now rather than on the next request.
//
// Decided:
//
// - **Incremental, by byte offset,** the way bridge/turn-index.js is: a file
//   remembers how far it was read (`consumed`) and the hash of its first line
//   (`head`); a file that shrank or whose first line changed is re-read from
//   zero. There is about 1.4GB of transcript on this machine, so the first pass
//   is read in bounded chunks and yields between them; after that a refresh is
//   a stat per file and a read of what was appended.
//
// - **One message counts once.** Claude Code writes each content block of an
//   assistant message as its own line, and every one of those lines carries the
//   same `message.id` and the same `usage` — 179 lines for 91 messages in the
//   file this was measured on. Summing per line roughly doubles everything. The
//   lines of one message are consecutive, so a file keeps the last message it
//   counted (`last`), and a line with the same id *replaces* that message's
//   contribution rather than adding to it: the last occurrence wins, and a
//   message split across two reads is still counted once. `recent` also holds
//   the few ids before it, in case a writer ever interleaves two messages.
//
// - **Every copy of a session is summed.** A session that walked into a worktree
//   has a transcript in two project directories, and conversationRecord picks
//   one to *show*. For spend, each line was written to exactly one of the
//   copies, so the copies add up rather than overlap. Subagent transcripts
//   (`<projectDir>/<id>/subagents/*.jsonl`) are added to their parent, because
//   a subagent's tokens are that session's spend.
//
// - **Buckets, not messages.** A file is reduced to `day|model` buckets as it
//   is read, so the cache is small and a rollup is a sum. `day` is the local
//   date of the entry's timestamp.
//
// - **Persisted to CACHE_DIR/spend.json,** debounced, written to a temporary
//   file and renamed. Losing it costs one cold pass and nothing else.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { CACHE_DIR } = require('./config');
const { costOf, tokensOf, normalizeModel } = require('./pricing');
const { projectName, isTemp } = require('./sessions');

const CACHE_FILE = path.join(CACHE_DIR, 'spend.json');
// Bump when a bucket's shape or derivation changes, so old caches are re-read.
const INDEX_VERSION = 2;
const HEAD_BYTES = 4096;
const CHUNK = 8 * 1024 * 1024;
const RECENT = 16;
const TOP_SESSIONS = 50;

// -- pure parts ---------------------------------------------------------------

function emptyTotals() {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0,
        messages: 0, costUsd: 0, unpricedTokens: 0 };
}

function addInto(into, b, sign = 1) {
    into.input += sign * b.input;
    into.output += sign * b.output;
    into.cacheRead += sign * b.cacheRead;
    into.cacheWrite += sign * b.cacheWrite;
    into.tokens += sign * b.tokens;
    into.messages += sign * b.messages;
    into.costUsd += sign * b.costUsd;
    into.unpricedTokens += sign * b.unpricedTokens;
    return into;
}

/** Local YYYY-MM-DD of a timestamp, or null. */
function dayOf(ts) {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** One message's contribution: the bucket key it lands in and its counts. */
function contribution(entry) {
    const msg = entry.message;
    const day = dayOf(entry.timestamp);
    if (!day) return null;
    const model = normalizeModel(msg.model) || 'unknown';
    const t = tokensOf(msg.usage);
    const tokens = t.input + t.output + t.cacheRead + t.cacheWrite;
    if (!tokens) return null; // `<synthetic>` and friends
    const cost = costOf(msg.usage, model);
    return {
        key: `${day}|${model}`,
        c: { input: t.input, output: t.output, cacheRead: t.cacheRead,
            cacheWrite: t.cacheWrite, tokens, messages: 1,
            costUsd: cost === null ? 0 : cost, unpricedTokens: cost === null ? tokens : 0 },
    };
}

function freshState(head) {
    return { head, consumed: 0, last: null, recent: [], buckets: {} };
}

/**
 * Fold assistant entries, in file order, into a file's state. The dedupe lives
 * here, so it is what the test drives.
 */
function absorb(state, entries) {
    for (const entry of entries) {
        if (!entry || entry.type !== 'assistant' || !entry.message || !entry.message.usage) continue;
        const id = entry.message.id || null;
        const add = contribution(entry);
        if (id && state.last && state.last.id === id) {
            // Another block of the message just counted: the newest line wins.
            unapply(state, state.last);
            state.last = add ? { id, key: add.key, c: add.c } : { id, key: null, c: null };
            if (add) apply(state, state.last);
            continue;
        }
        if (id && state.recent.includes(id)) continue;
        if (state.last && state.last.id) {
            state.recent.push(state.last.id);
            if (state.recent.length > RECENT) state.recent.shift();
        }
        state.last = add ? { id, key: add.key, c: add.c } : { id, key: null, c: null };
        if (add) apply(state, state.last);
    }
    return state;
}

function apply(state, m) {
    if (!m.key) return;
    const b = state.buckets[m.key] || (state.buckets[m.key] = emptyTotals());
    addInto(b, m.c, 1);
}

function unapply(state, m) {
    if (!m.key || !state.buckets[m.key]) return;
    addInto(state.buckets[m.key], m.c, -1);
    if (state.buckets[m.key].messages <= 0) delete state.buckets[m.key];
}

/** Sum several files' buckets into one `day|model` map. */
function mergeBuckets(list) {
    const out = {};
    for (const buckets of list) {
        for (const [k, b] of Object.entries(buckets || {})) {
            addInto(out[k] || (out[k] = emptyTotals()), b);
        }
    }
    return out;
}

const round = (t) => ({ ...t, costUsd: Math.round(t.costUsd * 1e6) / 1e6 });

/** The last `days` local dates, oldest first, ending with `now`'s. */
function dayRange(days, now) {
    const out = [];
    const d = new Date(now);
    d.setHours(12, 0, 0, 0); // noon, so a DST change cannot skip or repeat a date
    for (let i = days - 1; i >= 0; i--) {
        const x = new Date(d);
        x.setDate(d.getDate() - i);
        out.push(dayOf(x));
    }
    return out;
}

/**
 * The rollup the route serves.
 *
 * `entries` is `[{sessionId, projectCwd, projectName, buckets}]`; every
 * breakdown is restricted to the last `days` days ending today, and `allTime`
 * is the one figure that is not.
 */
function rollup(entries, { days = 30, now = Date.now(), top = TOP_SESSIONS } = {}) {
    const range = dayRange(days, now);
    const inRange = new Set(range);
    const daily = new Map(range.map(d => [d, emptyTotals()]));
    const projects = new Map();
    const models = new Map();
    const sessions = [];
    const totals = emptyTotals();
    const allTime = emptyTotals();

    for (const e of entries) {
        const s = emptyTotals();
        let lastDay = null;
        for (const [key, b] of Object.entries(e.buckets || {})) {
            addInto(allTime, b);
            const [day, model] = key.split('|');
            if (!inRange.has(day)) continue;
            addInto(s, b);
            addInto(daily.get(day), b);
            addInto(models.get(model) || models.set(model, emptyTotals()).get(model), b);
            if (!lastDay || day > lastDay) lastDay = day;
        }
        if (!s.messages) continue;
        addInto(totals, s);
        const cwd = e.projectCwd || null;
        const pkey = cwd || '(unknown)';
        const p = projects.get(pkey) || projects.set(pkey, {
            cwd, name: e.projectName || projectName(cwd), sessions: 0, ...emptyTotals(),
        }).get(pkey);
        p.sessions++;
        addInto(p, s);
        sessions.push({ sessionId: e.sessionId, projectCwd: cwd,
            projectName: e.projectName || projectName(cwd), lastDay, ...s });
    }

    const byCost = (a, b) => (b.costUsd - a.costUsd) || (b.tokens - a.tokens);
    return {
        days,
        totals: round(totals),
        allTime: round(allTime),
        daily: range.map(d => ({ date: d, ...round(daily.get(d)) })),
        projects: [...projects.values()].sort(byCost).map(round),
        sessions: sessions.sort(byCost).slice(0, top).map(round),
        models: [...models.entries()].map(([model, t]) => ({ model, ...round(t) })).sort(byCost),
        unpricedTokens: totals.unpricedTokens,
    };
}

/** All-time totals and per-model split for one session's buckets. */
function sessionTotals(buckets) {
    const totals = emptyTotals();
    const models = new Map();
    let firstDay = null; let lastDay = null;
    for (const [key, b] of Object.entries(buckets || {})) {
        const [day, model] = key.split('|');
        addInto(totals, b);
        addInto(models.get(model) || models.set(model, emptyTotals()).get(model), b);
        if (!firstDay || day < firstDay) firstDay = day;
        if (!lastDay || day > lastDay) lastDay = day;
    }
    return {
        totals: round(totals), firstDay, lastDay,
        models: [...models.entries()].map(([model, t]) => ({ model, ...round(t) }))
            .sort((a, b) => b.costUsd - a.costUsd),
    };
}

// -- reading -----------------------------------------------------------------

/** Lines that could carry usage, tested on the raw JSON before parsing. */
const wanted = (s) => s.includes('"usage"') && s.includes('"type":"assistant"');

/** Complete lines of `buf` that `wanted` accepts, parsed; and how far it read. */
function parseChunk(buf) {
    const entries = [];
    let consumed = 0;
    let start = 0;
    while (true) {
        const nl = buf.indexOf(0x0a, start);
        if (nl === -1) break;
        const slice = buf.subarray(start, nl);
        start = nl + 1;
        consumed = start;
        if (!slice.length) continue;
        const s = slice.toString('utf8');
        if (!wanted(s)) continue;
        try { entries.push(JSON.parse(s)); } catch { /* not a whole line */ }
    }
    return { entries, consumed };
}

async function headOf(fh, size) {
    const n = Math.min(size, HEAD_BYTES);
    if (!n) return '';
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, 0);
    const nl = buf.indexOf(0x0a);
    return crypto.createHash('sha1').update(nl === -1 ? buf : buf.subarray(0, nl)).digest('hex');
}

/**
 * Bring one file's state up to date. Returns the (possibly new) state, or null
 * when the file cannot be read. Async and chunked, so a cold read of a large
 * transcript does not hold the event loop.
 */
async function updateFile(file, state) {
    let fh;
    try {
        // A stat before an open: nearly every file is unchanged, and this is the
        // whole cost of a warm refresh.
        const { size } = await fs.promises.stat(file);
        if (state && size === state.consumed) return state;
        fh = await fs.promises.open(file, 'r');
        const head = await headOf(fh, size);
        if (!state || size < state.consumed || head !== state.head) state = freshState(head);
        let chunk = CHUNK;
        while (state.consumed < size) {
            const len = Math.min(chunk, size - state.consumed);
            const buf = Buffer.alloc(len);
            const { bytesRead } = await fh.read(buf, 0, len, state.consumed);
            const { entries, consumed } = parseChunk(buf.subarray(0, bytesRead));
            if (!consumed) {
                // A single line longer than the chunk, or a final line still
                // being written. Widen once the chunk is full; otherwise wait.
                if (len < chunk) break;
                chunk *= 2;
                continue;
            }
            absorb(state, entries);
            state.consumed += consumed;
            await new Promise(r => setImmediate(r));
        }
        return state;
    } catch {
        return null;
    } finally {
        if (fh) await fh.close().catch(() => {});
    }
}

class SpendIndex {
    /**
     * @param {object} [opts]
     * @param {string} [opts.cacheFile] where the per-file state is kept
     */
    constructor({ cacheFile = CACHE_FILE } = {}) {
        this.cacheFile = cacheFile;
        /** @type {Map<string, object>} file path -> state */
        this.files = new Map();
        this._loaded = false;
        this._running = null;
        this._saveTimer = null;
    }

    _load() {
        if (this._loaded) return;
        this._loaded = true;
        try {
            const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
            if (data.version !== INDEX_VERSION) return;
            for (const [f, st] of Object.entries(data.files || {})) this.files.set(f, st);
        } catch { /* none yet */ }
    }

    _scheduleSave() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            try {
                fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
                const tmp = `${this.cacheFile}.${process.pid}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify({
                    version: INDEX_VERSION, files: Object.fromEntries(this.files),
                }));
                fs.renameSync(tmp, this.cacheFile);
            } catch { /* an optimisation; the next start re-reads */ }
        }, 2000);
        if (this._saveTimer.unref) this._saveTimer.unref();
    }

    /** The subagent transcripts beside a top-level `<dir>/<id>.jsonl`. */
    static subagentFiles(file) {
        const id = path.basename(file, '.jsonl');
        const sub = path.join(path.dirname(file), id, 'subagents');
        let names = [];
        try { names = fs.readdirSync(sub); } catch { return []; }
        return names.filter(n => n.endsWith('.jsonl')).map(n => path.join(sub, n));
    }

    /** Session id -> every file holding its spend: each top-level copy and its subagents. */
    static fileMap(index, only = null) {
        const map = new Map();
        for (const rec of index.byFile.values()) {
            const id = path.basename(rec.file, '.jsonl');
            if (only && id !== only) continue;
            const files = map.get(id) || map.set(id, []).get(id);
            files.push(rec.file, ...SpendIndex.subagentFiles(rec.file));
        }
        return map;
    }

    async _updateAll(paths) {
        let changed = false;
        for (const f of paths) {
            const prev = this.files.get(f);
            const before = prev ? prev.consumed : -1;
            const next = await updateFile(f, prev);
            if (!next) { if (prev) { this.files.delete(f); changed = true; } continue; }
            if (next !== prev || next.consumed !== before) changed = true;
            this.files.set(f, next);
        }
        return changed;
    }

    /**
     * Bring every transcript the session index knows up to date. Concurrent
     * callers share one pass.
     */
    refresh(index) {
        if (this._running) return this._running;
        this._load();
        this._running = (async () => {
            try {
                const map = SpendIndex.fileMap(index);
                const all = new Set();
                for (const files of map.values()) for (const f of files) all.add(f);
                let changed = await this._updateAll(all);
                for (const f of [...this.files.keys()]) {
                    if (!all.has(f)) { this.files.delete(f); changed = true; }
                }
                if (changed) this._scheduleSave();
                this._map = map;
            } finally {
                this._running = null;
            }
        })();
        return this._running;
    }

    /** The cheap path: one session's files, after a turn of it finished. */
    async refreshSession(index, sessionId) {
        this._load();
        const files = SpendIndex.fileMap(index, sessionId).get(sessionId) || [];
        if (await this._updateAll(files)) this._scheduleSave();
        if (this._map) this._map.set(sessionId, files);
        return this.forSession(index, sessionId);
    }

    _bucketsOf(files) {
        return mergeBuckets(files.map(f => (this.files.get(f) || {}).buckets));
    }

    /** `{sessionId, totals, models, firstDay, lastDay}`, or null if unknown. */
    forSession(index, sessionId) {
        const files = (this._map && this._map.get(sessionId))
            || SpendIndex.fileMap(index, sessionId).get(sessionId);
        if (!files || !files.length) return null;
        return { sessionId, ...sessionTotals(this._bucketsOf(files)) };
    }

    /**
     * The rollup input: one entry per listed session. Sessions in scratch space
     * are left out, and test sessions unless `includeTest`, as list() does.
     */
    entries(index, { includeTest = false } = {}) {
        const out = [];
        const map = this._map || SpendIndex.fileMap(index);
        for (const [id, files] of map) {
            const rec = index.sessions.get(id);
            if (!rec) continue;
            const m = rec.meta;
            if (isTemp(m.projectCwd) || isTemp(m.cwd)) continue;
            if (!includeTest && index.flags && index.flags.test.has(id)) continue;
            const cwd = m.projectCwd || m.cwd || null;
            out.push({ sessionId: id, projectCwd: cwd, projectName: projectName(cwd),
                buckets: this._bucketsOf(files) });
        }
        return out;
    }
}

module.exports = {
    SpendIndex, rollup, sessionTotals, absorb, freshState, mergeBuckets, parseChunk,
    updateFile, dayOf, dayRange, INDEX_VERSION, CACHE_FILE,
};
