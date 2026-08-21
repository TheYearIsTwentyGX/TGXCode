'use strict';

// An index over every transcript under ~/.claude/projects.
//
// There are ~700 files totalling a few hundred MB here, so a full rescan on
// every request is not viable. Metadata is cached keyed by (path, size, mtime) and
// persisted to disk, making a warm start instant and a cold start a one-off
// few-second scan. Directory watches keep the index fresh afterwards.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { PROJECTS_DIR, CACHE_DIR } = require('./config');
const { scanMeta, parseLines, buildEvents, readSubagentIndex,
    readSubagentTranscript, lastActivity } = require('./transcript');

const CACHE_FILE = path.join(CACHE_DIR, 'index.json');
// Bump whenever scanMeta's output shape or derivation changes, so a stale cache
// is discarded rather than silently serving metadata from the old rules.
const CACHE_VERSION = 13;

// A transcript touched this recently is treated as live.
const ACTIVE_WINDOW_MS = 90_000;

// How long a session created here is allowed to exist without a transcript
// before the state attached to it is treated as orphaned. See note().
const PENDING_TTL_MS = 5 * 60_000;

class SessionIndex extends EventEmitter {
    /** @param {import('./flags').Flags} [flags] user pin/archive state */
    constructor(flags = null) {
        super();
        this.flags = flags;
        /**
         * Which sessions are actually running, when we have it. Set from
         * server.js rather than constructed here: the index is about files on
         * disk, and a registry that is missing or unreadable has to leave it
         * working exactly as before.
         * @type {import('./registry').SessionRegistry|null}
         */
        this.registry = null;
        /**
         * What was done about each suggested follow-up. Set from server.js for
         * the same reason as the registry: this is a store the index does not
         * need to work, and one that is absent must change nothing.
         * @type {import('./suggestions').Suggestions|null}
         */
        this.suggestions = null;
        /** @type {Map<string, {file, dir, size, mtimeMs, meta}>} keyed by sessionId */
        this.sessions = new Map();
        /**
         * The same records keyed by path. A session id can name a file in more
         * than one project directory, so the path is what a parse is actually
         * about; keying the parse cache by id re-parses the copy that lost.
         * @type {Map<string, {file, dir, size, mtimeMs, meta}>}
         */
        this.byFile = new Map();
        /**
         * Sessions created through this bridge whose transcript has not appeared
         * yet, as id -> when. See note() for what goes wrong without it.
         * @type {Map<string, number>}
         */
        this.pending = new Map();
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

        // Built fresh rather than mutated in place, because which file a session
        // resolves to depends on every candidate for it having been seen — an
        // answer that only exists once the pass is over.
        const byFile = new Map();
        const chosen = new Map();
        let parsed = 0;
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
                scanned++;

                let rec = this.byFile.get(file);
                if (!rec || rec.size !== st.size || rec.mtimeMs !== st.mtimeMs) {
                    const meta = scanMeta(file);
                    if (!meta) continue;
                    rec = { file, dir, size: st.size, mtimeMs: st.mtimeMs, meta };
                    parsed++;
                    // Yield periodically so a cold scan doesn't stall the event loop.
                    if (parsed % 25 === 0) await new Promise(r => setImmediate(r));
                }
                byFile.set(file, rec);
                chosen.set(id, conversationRecord(chosen.get(id), rec));
            }
        }

        let changed = 0;
        // Messages that arrived from another session since the last pass.
        //
        // Detected here rather than anywhere nicer because this is the only
        // place that holds both the old metadata and the new. A peer message is
        // not a runner event — it can land in a session running in somebody's
        // terminal, with no process of ours anywhere near it — so the transcript
        // is the only thing that knows, and the count scanMeta already keeps is
        // the cheapest way to ask.
        const arrived = [];
        // And handoffs, which this bridge delivered itself. Noticed the same way
        // rather than at the route that sent them, because the route knows a
        // message was *queued* and this knows it reached the transcript — and
        // because a handoff is worth announcing in whichever window is open, not
        // only to whoever happened to be posting.
        const handed = [];
        for (const [id, rec] of chosen) {
            const prev = this.sessions.get(id);
            if (!prev || prev.file !== rec.file || prev.size !== rec.size
                || prev.mtimeMs !== rec.mtimeMs) changed++;
            // A session seen for the first time says nothing: a cold start would
            // otherwise announce every message this machine has ever received.
            if (prev && rec.meta.peerMessages > (prev.meta.peerMessages || 0)) {
                arrived.push({
                    sessionId: id,
                    from: rec.meta.lastPeerFrom,
                    at: rec.meta.lastPeerTs,
                    count: rec.meta.peerMessages - (prev.meta.peerMessages || 0),
                });
            }
            if (prev && (rec.meta.handoffs || 0) > (prev.meta.handoffs || 0)) {
                handed.push({
                    sessionId: id,
                    from: rec.meta.lastHandoffFrom,
                    at: rec.meta.lastHandoffTs,
                    count: (rec.meta.handoffs || 0) - (prev.meta.handoffs || 0),
                });
            }
        }
        // Sessions whose files disappeared.
        for (const id of this.sessions.keys()) if (!chosen.has(id)) changed++;

        this.sessions = chosen;
        this.byFile = byFile;
        // Don't accumulate pins and archives for transcripts that are long gone —
        // but knownIds(), not the index alone, or a session created a moment ago
        // loses its flags before it has written anything. See note().
        const known = this.knownIds();
        if (this.flags) this.flags.prune(known);
        if (this.suggestions) this.suggestions.prune(known);

        if (changed) { this._scheduleSave(); this.emit('changed'); }
        // After the index is in place, so a listener asking for the summary of
        // the session that was messaged gets the current one.
        for (const a of arrived) this.emit('peer-message', a);
        for (const h of handed) this.emit('handoff', h);
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
                // So the first rescan re-parses only what changed on disk. The
                // cache holds one file per session; a session with a second copy
                // pays for it once, on the pass that first sees the other.
                if (rec.file) this.byFile.set(rec.file, rec);
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

    /**
     * Session summaries for the list, newest activity first.
     *
     * `includeTest` is the everyday window's protection from the development
     * one: sessions an agent started to try something out are labelled, and only
     * the development bridge passes true. The transcripts are all in the same
     * place — the two instances read the same directory — so this is the only
     * thing keeping scratch work out of a list of real conversations.
     */
    list({ query = '', project = null, limit = 500, includeTest = false } = {}) {
        const now = Date.now();
        const q = query.trim().toLowerCase();
        const out = [];

        for (const rec of this.sessions.values()) {
            const m = rec.meta;
            if (project && m.projectCwd !== project) continue;
            if (inTemp(m)) continue;
            if (!includeTest && this.flags && this.flags.test.has(m.sessionId)) continue;
            if (q) {
                const hay = [m.title, m.firstPrompt, m.lastPrompt, m.cwd,
                    m.worktree && m.worktree.name, m.sessionId]
                    .filter(Boolean).join(' ').toLowerCase();
                if (!hay.includes(q)) continue;
            }
            out.push(this._summary(rec, now));
        }

        // Ordered by when the user last spoke, not by file activity. Sorting on
        // activity meant a working agent kept bumping its session to the top and
        // shuffling everything else beneath the cursor.
        out.sort((a, b) => sortKey(b) - sortKey(a));
        return out.slice(0, limit);
    }

    /**
     * Every suggested follow-up on this machine, newest first.
     *
     * The offers come off `meta.suggestions`, which scanMeta collected on the
     * pass that reads every transcript; the decision beside each one comes off
     * the store, which has always been keyed session-then-tool-use for exactly
     * this join. So this route needs no transcript read of its own, and a task
     * is answerable without the conversation it was raised in being open.
     *
     * **Named listSuggestions rather than suggestions** because
     * `index.suggestions` is the decision store, injected above.
     *
     * A task from an *archived* session is still returned, carrying
     * `archived: true` so a caller can group or dim it. Dismiss is already the
     * gesture for "not this"; if archiving hid tasks there would be two ways to
     * dismiss, one of them invisible — and an outstanding task is exactly the
     * loose end you still want to find after filing a conversation away. Temp
     * and test sessions are filtered as in list(), for the same reasons.
     */
    listSuggestions({ session = null, project = null, status = null,
        limit = 500, includeTest = false } = {}) {
        const wanted = status
            ? new Set(String(status).split(',').map(v => v.trim()).filter(Boolean))
            : null;
        const out = [];

        for (const rec of this.sessions.values()) {
            const m = rec.meta;
            if (!m.suggestions || !m.suggestions.length) continue;
            if (session && m.sessionId !== session) continue;
            if (project && m.projectCwd !== project) continue;
            if (inTemp(m)) continue;
            const flags = this.flags
                ? this.flags.get(m.sessionId)
                : { pinned: false, archived: false, test: false };
            if (!includeTest && flags.test) continue;

            const acted = this.suggestions ? this.suggestions.forSession(m.sessionId) : {};
            for (const s of m.suggestions) {
                const decision = acted[s.id] || null;
                const state = decision ? decision.status : 'open';
                if (wanted && !wanted.has(state)) continue;
                out.push({
                    ...s,
                    sessionId: m.sessionId,
                    status: state,
                    startedId: decision ? decision.startedId : null,
                    at: decision ? decision.at : 0,
                    archived: flags.archived,
                    // Enough to say where a task came from without a second
                    // call. Not the whole summary: this list is read whole and
                    // the fields a board labels a row with are these.
                    session: {
                        title: m.title,
                        projectName: projectName(m.projectCwd || m.cwd),
                        projectCwd: m.projectCwd,
                        worktree: m.worktree,
                        test: flags.test,
                    },
                    // When it was raised, resolved for the sort. A transcript
                    // entry has always carried a timestamp, but the file's mtime
                    // is a truthful fallback rather than sorting it to 1970.
                    sortAt: tsMs(s.ts) || rec.mtimeMs,
                });
            }
        }

        out.sort((a, b) => b.sortAt - a.sortAt);
        return out.slice(0, limit).map(({ sortAt, ...row }) => row);
    }

    _summary(rec, now = Date.now()) {
        const m = rec.meta;
        const flags = this.flags
            ? this.flags.get(m.sessionId)
            : { pinned: false, archived: false, test: false };
        const live = this.registry ? this.registry.for(m.sessionId) : null;
        return {
            sessionId: m.sessionId,
            pinned: flags.pinned,
            archived: flags.archived,
            test: flags.test,
            // The registry's own label, for a session whose transcript produced
            // no title of its own — scanMeta falls back to "Untitled session",
            // and a name Claude Code already derived beats that.
            title: (m.titleSource === 'none' && live && live.name) ? live.name : m.title,
            titleSource: (m.titleSource === 'none' && live && live.name)
                ? 'registry' : m.titleSource,
            cwd: m.cwd,
            projectCwd: m.projectCwd,
            projectName: projectName(m.projectCwd || m.cwd),
            gitBranch: m.gitBranch,
            worktree: m.worktree,
            prs: m.prs,
            model: m.model,
            // What the composer should open on for a session with no process of
            // its own — the mode it was last seen running in, not the app default.
            permissionMode: m.permissionMode,
            version: m.version,
            sessionKind: m.sessionKind,
            userMessages: m.userMessages,
            assistantMessages: m.assistantMessages,
            toolCalls: m.toolCalls,
            // How many handoffs this session has been sent, and by whom last.
            // Beside the turn counts rather than in them: a handoff is work
            // arriving, not a turn the user took. See HANDOFF_TAG in
            // transcript.js for why that distinction has to be made twice.
            handoffs: m.handoffs || 0,
            lastHandoffFrom: m.lastHandoffFrom || null,
            lastHandoffTs: m.lastHandoffTs || null,
            firstTs: m.firstTs,
            lastTs: m.lastTs,
            lastUserTs: m.lastUserTs,
            lastPrompt: m.lastPrompt || m.firstPrompt,
            bytes: rec.size,
            mtimeMs: rec.mtimeMs,
            // Two different questions, deliberately kept apart.
            //
            // `live` is the registry: is there a process, right now. It is the
            // one to believe when it is there.
            //
            // `active` is the file: has the transcript been written to lately.
            // It is wrong in both directions — a session thinking for two
            // minutes looks dead, one that finished eighty seconds ago looks
            // alive — but it is all there is for a Claude Code old enough to
            // write no registry entry, so it stays as the fallback.
            live,
            active: (now - rec.mtimeMs) < ACTIVE_WINDOW_MS,
        };
    }

    /** Distinct projects, ordered by most recent activity. */
    projects() {
        const byCwd = new Map();
        for (const rec of this.sessions.values()) {
            if (inTemp(rec.meta)) continue;
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

    /**
     * Every subagent this session spawned.
     *
     * Deliberately does not say whether an agent succeeded: that is written in
     * the *parent* transcript, as the result of the tool call that spawned it,
     * and the client already has those events rendered. What only the bridge can
     * see is the agent's own file — how recently it was written to, and the last
     * thing in it — so that is what this adds.
     */
    subagents(sessionId) {
        const rec = this.sessions.get(sessionId);
        if (!rec) return null;
        const idx = readSubagentIndex(path.join(rec.dir, sessionId));
        const now = Date.now();
        const out = [];
        for (const entry of idx.values()) {
            const { file, ...rest } = entry;
            const activity = entry.bytes ? lastActivity(file) : null;
            out.push({
                ...rest,
                updatedAt: entry.mtimeMs ? new Date(entry.mtimeMs).toISOString() : null,
                // Same 90s window the session rail treats as live, for the same
                // reason: a file nobody has touched in a minute and a half is not
                // being worked on.
                warm: entry.mtimeMs > 0 && (now - entry.mtimeMs) < ACTIVE_WINDOW_MS,
                activity: activity ? activity.text : null,
                activityTs: activity ? activity.ts : null,
            });
        }
        out.sort((a, b) => a.mtimeMs - b.mtimeMs);
        return out;
    }

    /**
     * One subagent's transcript, addressed by the tool_use id that spawned it.
     * `offset` follows the same contract as readSince: pass back what you were
     * given to receive only what has been appended since.
     */
    subagent(sessionId, toolUseId, offset = 0) {
        const rec = this.sessions.get(sessionId);
        if (!rec) return null;
        const sessionDir = path.join(rec.dir, sessionId);
        const idx = readSubagentIndex(sessionDir);
        const entry = idx.get(toolUseId);
        if (!entry) return null;
        // Passing the index through means a subagent that spawned its own
        // subagents renders them as links too, rather than as bare tool calls.
        const chunk = readSubagentTranscript(entry.file, offset, { subagentsByToolUse: idx });
        if (!chunk) {
            // The meta file exists but the transcript does not yet — an agent
            // that has just started. An empty transcript is the honest answer.
            return { ...entry, file: undefined, events: [], offset: 0, reset: false };
        }
        return { ...entry, file: undefined, ...chunk };
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

    /**
     * Register a session created outside a rescan so it appears immediately.
     *
     * It also has to be held against pruning, and that is not a nicety. A
     * session is created, flagged — `test: true` is the one that matters — and
     * only *then* does `claude` write its first line, seconds later. The rescan
     * this schedules therefore runs while the transcript does not exist, and
     * prune() concluded the flags belonged to a session that was gone and threw
     * them away. Every test session an agent started has been arriving in the
     * everyday window ever since, which is the exact opposite of what the label
     * is for.
     */
    note(sessionId) {
        if (sessionId) this.pending.set(sessionId, Date.now());
        this._scheduleRescan();
    }

    /**
     * Ids that exist as far as anything owning per-session state is concerned:
     * everything indexed, plus everything created in the last few minutes that
     * has not shown up on disk yet.
     *
     * The window matters in both directions. Too short and the race above comes
     * back on a busy machine; too long and a session that never wrote anything —
     * `claude` failed to start, the directory was wrong — keeps its flags
     * forever. A few minutes is far longer than a first line takes and far
     * shorter than anyone would notice.
     */
    knownIds() {
        const ids = new Set(this.sessions.keys());
        const cutoff = Date.now() - PENDING_TTL_MS;
        for (const [id, at] of this.pending) {
            if (ids.has(id) || at < cutoff) this.pending.delete(id);
            else ids.add(id);
        }
        return ids;
    }

    /**
     * Delete a transcript and everything filed under it. Irreversible.
     *
     * This is the only thing the app ever removes from ~/.claude, so it is
     * deliberately narrow. What goes is the `.jsonl` this index recorded for the
     * session and the sibling directory of the same name, which is where Claude
     * Code keeps that session's subagent transcripts and spilled tool output —
     * leaving it behind would orphan tens of megabytes with nothing left to
     * reach it by.
     *
     * Both paths come from the record's own `file`, never from the id. A record
     * loaded from cache is keyed by whatever `sessionId` the transcript claimed,
     * which is not ours to trust: joining `..` onto the project directory
     * resolves to the projects directory itself, and this method would then
     * recursively delete every transcript on the machine. The sidecar is always
     * the transcript's path minus its extension, and it has to sit strictly
     * below the project directory or it is not removed at all.
     *
     * @returns {{file: string, dir: string|null}|null} null if the session is
     *   unknown, or if its recorded path does not resolve where it should.
     */
    remove(sessionId) {
        const rec = this.sessions.get(sessionId);
        if (!rec) return null;

        const removed = this._removeFile(rec);
        if (!removed) return null;

        // A session that crossed into a worktree has a second transcript, under
        // that worktree's project directory. Leaving it behind would leave the
        // row in the list too, now holding whatever bookkeeping that copy has and
        // none of the conversation: a session the user deleted, apparently
        // emptied instead. The id comes from each file's own name, as above.
        for (const other of [...this.byFile.values()]) {
            if (other.file === rec.file) continue;
            if (path.basename(other.file, '.jsonl') !== sessionId) continue;
            this._removeFile(other);
        }

        this.sessions.delete(sessionId);
        // Deleting is deliberate, so it takes the reprieve with it: a session
        // removed on purpose must not be held alive by having been recent.
        this.pending.delete(sessionId);
        const left = this.knownIds();
        if (this.flags) this.flags.prune(left);
        if (this.suggestions) this.suggestions.prune(left);
        this._scheduleSave();
        this.emit('changed');
        return removed;
    }

    /** One transcript and its sidecar directory. Path rules per remove(). */
    _removeFile(rec) {
        const root = path.resolve(PROJECTS_DIR);
        const projectDir = path.resolve(rec.dir);
        const file = path.resolve(rec.file);
        if (file === root || !file.startsWith(root + path.sep)) return null;
        if (!file.endsWith('.jsonl')) return null;

        const dir = file.slice(0, -'.jsonl'.length);
        const sidecar = dir.startsWith(projectDir + path.sep) ? dir : null;

        // The transcript first: with it gone the session is off the list even if
        // clearing the directory fails, which is the outcome the user asked for.
        fs.rmSync(file, { force: true });
        let removedDir = null;
        try {
            if (sidecar && fs.statSync(sidecar).isDirectory()) {
                fs.rmSync(sidecar, { recursive: true, force: true });
                removedDir = sidecar;
            }
        } catch { /* most sessions never spawn an agent, so there is no directory */ }

        this.byFile.delete(rec.file);
        return { file, dir: removedDir };
    }
}

/**
 * Which of two files claiming one session id holds the session.
 *
 * A session that crosses into a worktree ends up with two transcripts, because
 * Claude Code files one under the directory it is running in and a worktree is
 * a project directory of its own. One copy holds the conversation and the other
 * holds only bookkeeping — a title, a mode, the worktree state — and which is
 * which goes either way: a session that moved into a worktree mid-conversation
 * keeps its turns in the project it started from, while one launched straight
 * into a worktree keeps them there. Both cases are on this machine.
 *
 * Nothing used to choose. The index was keyed by session id alone and set
 * unconditionally, so the copy scanned last won and the order `readdir` happened
 * to return project directories in decided whether a session showed its history
 * or showed nothing at all — one session on disk got each answer.
 */
function conversationRecord(a, b) {
    if (!a) return b;
    if (!b) return a;
    const turns = (r) => r.meta.userMessages + r.meta.assistantMessages;
    if (turns(a) !== turns(b)) return turns(a) > turns(b) ? a : b;
    // Equal conversation: the longer file holds more of everything else. Falling
    // back to mtime keeps this deterministic rather than order-dependent, which
    // is the whole point.
    if (a.size !== b.size) return a.size > b.size ? a : b;
    return a.mtimeMs >= b.mtimeMs ? a : b;
}

/**
 * Position in the session list: the user's last message, falling back to the
 * transcript's own timestamps for sessions that somehow have no user turn.
 */
/** A transcript timestamp as ms, or 0 for anything unparseable. */
function tsMs(ts) {
    const n = ts ? Date.parse(ts) : NaN;
    return Number.isFinite(n) ? n : 0;
}

function sortKey(s) {
    const ts = s.lastUserTs || s.firstTs || s.lastTs;
    return ts ? Date.parse(ts) : s.mtimeMs;
}

/** A readable label for a project directory. */
function projectName(cwd) {
    if (!cwd) return 'unknown';
    const parts = String(cwd).split('/').filter(Boolean);
    return parts[parts.length - 1] || cwd;
}

/**
 * Scratch space is not work.
 *
 * Agents run in /tmp constantly — a probe, a scratchpad a hook made, one of the
 * per-session /tmp/claude-<uid>/… directories — and every one of them arrived in
 * the rail as a project of its own, sitting beside real checkouts. Worse, they
 * are by definition recent, so the newest of them became the directory the new
 * session dialog offered first.
 *
 * The transcripts stay indexed and reachable by id; this decides only what the
 * *lists* offer, exactly as the `test` flag does.
 *
 * /tmp itself counts and /tmp/anything counts; /tmpfoo does not, which is why
 * the separator is spelled out rather than left to startsWith.
 *
 * Deliberately the literal path and not os.tmpdir(): that reads TMPDIR from the
 * environment the *bridge* was launched in, not the one the session ran in, so
 * two bridges over the same ~/.claude/projects could disagree about the same
 * transcript.
 */
const TEMP_ROOT = '/tmp';

function isTemp(p) {
    return !!p && (p === TEMP_ROOT || p.startsWith(`${TEMP_ROOT}/`));
}

/**
 * Does this session live in scratch space, by either path it carries?
 *
 * Both, because the two differ for a worktree session and each one is what some
 * surface shows: `cwd` is the rail's label and what the dashboard groups by,
 * `projectCwd` is what projects() keys on. It does not catch a session that
 * merely started in /tmp and walked into a checkout — trailCheckout() resolves
 * projectCwd to the checkout and cwd follows it, so neither field is /tmp.
 */
function inTemp(meta) {
    return isTemp(meta.projectCwd) || isTemp(meta.cwd);
}

module.exports = { SessionIndex, projectName, isTemp, ACTIVE_WINDOW_MS };
