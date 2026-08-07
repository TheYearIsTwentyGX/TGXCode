'use strict';

// An index over every transcript under ~/.claude/projects.
//
// There are ~700 files totalling a few hundred MB here, so a full rescan on
// every request is not viable. Metadata is cached keyed by (size, mtime) and
// persisted to disk, making a warm start instant and a cold start a one-off
// few-second scan. Directory watches keep the index fresh afterwards.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { PROJECTS_DIR, CACHE_DIR } = require('./config');
const { scanMeta, parseLines, buildEvents, readSubagentIndex,
    readSubagentTranscript } = require('./transcript');

const CACHE_FILE = path.join(CACHE_DIR, 'index.json');
// Bump whenever scanMeta's output shape or derivation changes, so a stale cache
// is discarded rather than silently serving metadata from the old rules.
const CACHE_VERSION = 4;

// A transcript touched this recently is treated as live.
const ACTIVE_WINDOW_MS = 90_000;

class SessionIndex extends EventEmitter {
    /** @param {import('./flags').Flags} [flags] user pin/archive state */
    constructor(flags = null) {
        super();
        this.flags = flags;
        /** @type {Map<string, {file, dir, size, mtimeMs, meta}>} keyed by sessionId */
        this.sessions = new Map();
        this.watchers = [];
        this.ready = false;
        this._saveTimer = null;
        this._rescanTimer = null;
    }

    // -- lifecycle ---------------------------------------------------------

    async start() {
        this._loadCache();
        await this.rescan();
        this.ready = true;
        this._watch();
    }

    stop() {
        for (const w of this.watchers) { try { w.close(); } catch { /* already gone */ } }
        this.watchers = [];
        if (this._saveTimer) clearTimeout(this._saveTimer);
        if (this._rescanTimer) clearTimeout(this._rescanTimer);
    }

    // -- scanning ----------------------------------------------------------

    /** Re-stat every transcript, parsing only the ones whose bytes changed. */
    async rescan() {
        let projectDirs;
        try {
            projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
                .filter(e => e.isDirectory())
                .map(e => path.join(PROJECTS_DIR, e.name));
        } catch {
            return { scanned: 0, changed: 0 };
        }

        const seen = new Set();
        let changed = 0;
        let scanned = 0;

        for (const dir of projectDirs) {
            let files;
            try { files = fs.readdirSync(dir); } catch { continue; }
            for (const f of files) {
                if (!f.endsWith('.jsonl')) continue;
                const file = path.join(dir, f);
                let st;
                try { st = fs.statSync(file); } catch { continue; }
                if (!st.isFile() || st.size === 0) continue;

                const id = f.slice(0, -'.jsonl'.length);
                seen.add(id);
                scanned++;

                const prev = this.sessions.get(id);
                if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;

                const meta = scanMeta(file);
                if (!meta) continue;
                this.sessions.set(id, {
                    file, dir, size: st.size, mtimeMs: st.mtimeMs, meta,
                });
                changed++;
                // Yield periodically so a cold scan doesn't stall the event loop.
                if (changed % 25 === 0) await new Promise(r => setImmediate(r));
            }
        }

        // Drop sessions whose files disappeared.
        for (const id of [...this.sessions.keys()]) {
            if (!seen.has(id)) { this.sessions.delete(id); changed++; }
        }
        // Don't accumulate pins and archives for transcripts that are long gone.
        if (this.flags) this.flags.prune(new Set(this.sessions.keys()));

        if (changed) { this._scheduleSave(); this.emit('changed'); }
        return { scanned, changed };
    }

    _watch() {
        const watchDir = (dir) => {
            try {
                const w = fs.watch(dir, { persistent: false }, () => this._scheduleRescan());
                w.on('error', () => { /* directory removed; the next rescan notices */ });
                this.watchers.push(w);
            } catch { /* unwatchable directory, polling rescan still covers it */ }
        };

        watchDir(PROJECTS_DIR);
        try {
            for (const e of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
                if (e.isDirectory()) watchDir(path.join(PROJECTS_DIR, e.name));
            }
        } catch { /* nothing to watch yet */ }

        // A slow safety net: watches miss events under some filesystems, and new
        // project directories need picking up regardless.
        this._poll = setInterval(() => this.rescan(), 30_000);
        this._poll.unref();
    }

    _scheduleRescan() {
        if (this._rescanTimer) return;
        this._rescanTimer = setTimeout(() => {
            this._rescanTimer = null;
            this.rescan();
        }, 500);
    }

    // -- cache -------------------------------------------------------------

    _loadCache() {
        try {
            const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            if (raw.version !== CACHE_VERSION) return;
            for (const rec of raw.sessions) {
                this.sessions.set(rec.meta.sessionId, rec);
            }
        } catch { /* no cache yet, or unreadable: a full scan rebuilds it */ }
    }

    _scheduleSave() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            try {
                fs.mkdirSync(CACHE_DIR, { recursive: true });
                const tmp = CACHE_FILE + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify({
                    version: CACHE_VERSION,
                    sessions: [...this.sessions.values()],
                }));
                fs.renameSync(tmp, CACHE_FILE);
            } catch { /* cache is an optimisation; losing it is survivable */ }
        }, 2000);
        this._saveTimer.unref();
    }

    // -- queries -----------------------------------------------------------

    /** Session summaries for the list, newest activity first. */
    list({ query = '', project = null, limit = 500 } = {}) {
        const now = Date.now();
        const q = query.trim().toLowerCase();
        const out = [];

        for (const rec of this.sessions.values()) {
            const m = rec.meta;
            if (project && m.projectCwd !== project) continue;
            if (q) {
                const hay = [m.title, m.firstPrompt, m.lastPrompt, m.cwd,
                    m.worktree && m.worktree.name, m.sessionId]
                    .filter(Boolean).join(' ').toLowerCase();
                if (!hay.includes(q)) continue;
            }
            out.push(this._summary(rec, now));
        }

        out.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return out.slice(0, limit);
    }

    _summary(rec, now = Date.now()) {
        const m = rec.meta;
        const flags = this.flags ? this.flags.get(m.sessionId) : { pinned: false, archived: false };
        return {
            sessionId: m.sessionId,
            pinned: flags.pinned,
            archived: flags.archived,
            title: m.title,
            titleSource: m.titleSource,
            cwd: m.cwd,
            projectCwd: m.projectCwd,
            projectName: projectName(m.projectCwd || m.cwd),
            gitBranch: m.gitBranch,
            worktree: m.worktree,
            pr: m.pr,
            model: m.model,
            version: m.version,
            sessionKind: m.sessionKind,
            userMessages: m.userMessages,
            assistantMessages: m.assistantMessages,
            toolCalls: m.toolCalls,
            firstTs: m.firstTs,
            lastTs: m.lastTs,
            lastPrompt: m.lastPrompt || m.firstPrompt,
            bytes: rec.size,
            mtimeMs: rec.mtimeMs,
            active: (now - rec.mtimeMs) < ACTIVE_WINDOW_MS,
        };
    }

    /** Distinct projects, ordered by most recent activity. */
    projects() {
        const byCwd = new Map();
        for (const rec of this.sessions.values()) {
            const cwd = rec.meta.projectCwd || rec.meta.cwd;
            if (!cwd) continue;
            const cur = byCwd.get(cwd) || {
                cwd, name: projectName(cwd), sessions: 0, mtimeMs: 0, active: 0,
            };
            cur.sessions++;
            cur.mtimeMs = Math.max(cur.mtimeMs, rec.mtimeMs);
            if (Date.now() - rec.mtimeMs < ACTIVE_WINDOW_MS) cur.active++;
            byCwd.set(cwd, cur);
        }
        return [...byCwd.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
    }

    get(sessionId) {
        return this.sessions.get(sessionId) || null;
    }

    summary(sessionId) {
        const rec = this.sessions.get(sessionId);
        return rec ? this._summary(rec) : null;
    }

    /**
     * Full transcript for the conversation view.
     * Returns {summary, events, offset} — `offset` is the byte position the
     * caller should tail from to receive subsequent appends.
     */
    read(sessionId) {
        const rec = this.sessions.get(sessionId);
        if (!rec) return null;

        let buf;
        try { buf = fs.readFileSync(rec.file); } catch { return null; }
        const { entries, consumed } = parseLines(buf);

        const sessionDir = path.join(rec.dir, sessionId);
        const subagentsByToolUse = readSubagentIndex(sessionDir);
        const { events } = buildEvents(entries, { subagentsByToolUse });

        return { summary: this._summary(rec), events, offset: consumed };
    }

    /** Events appended since `offset`. Used by the live tail. */
    readSince(sessionId, offset) {
        const rec = this.sessions.get(sessionId);
        if (!rec) return null;

        let st;
        try { st = fs.statSync(rec.file); } catch { return null; }
        // A shrinking file means the transcript was replaced; ask for a full reload.
        if (st.size < offset) return { reset: true, offset: 0, events: [] };
        if (st.size === offset) return { reset: false, offset, events: [] };

        let buf;
        try {
            const fd = fs.openSync(rec.file, 'r');
            const len = st.size - offset;
            buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, offset);
            fs.closeSync(fd);
        } catch { return null; }

        const { entries, consumed } = parseLines(buf);
        const sessionDir = path.join(rec.dir, sessionId);
        const subagentsByToolUse = readSubagentIndex(sessionDir);
        const { events } = buildEvents(entries, { subagentsByToolUse });

        return { reset: false, offset: offset + consumed, events };
    }

    /** A subagent's transcript, addressed by the tool_use id that spawned it. */
    subagent(sessionId, toolUseId) {
        const rec = this.sessions.get(sessionId);
        if (!rec) return null;
        const idx = readSubagentIndex(path.join(rec.dir, sessionId));
        const entry = idx.get(toolUseId);
        if (!entry) return null;
        const events = readSubagentTranscript(entry.file);
        if (!events) return null;
        return { ...entry, file: undefined, events };
    }

    /** Tool output that was too large to inline, read from its spill file. */
    persistedOutput(sessionId, filePath) {
        const rec = this.sessions.get(sessionId);
        if (!rec) return null;
        // Only ever read from inside this session's own directory.
        const root = path.resolve(rec.dir, sessionId);
        const resolved = path.resolve(filePath);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
        try {
            const st = fs.statSync(resolved);
            const MAX = 2 * 1024 * 1024;
            if (st.size <= MAX) return { text: fs.readFileSync(resolved, 'utf8'), truncated: false };
            const fd = fs.openSync(resolved, 'r');
            const buf = Buffer.alloc(MAX);
            fs.readSync(fd, buf, 0, MAX, 0);
            fs.closeSync(fd);
            return { text: buf.toString('utf8'), truncated: true, size: st.size };
        } catch { return null; }
    }

    /** Register a session created outside a rescan so it appears immediately. */
    note(sessionId) {
        this._scheduleRescan();
    }
}

/** A readable label for a project directory. */
function projectName(cwd) {
    if (!cwd) return 'unknown';
    const parts = String(cwd).split('/').filter(Boolean);
    return parts[parts.length - 1] || cwd;
}

module.exports = { SessionIndex, projectName, ACTIVE_WINDOW_MS };
