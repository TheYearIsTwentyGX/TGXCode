'use strict';

// A written record of everything that reached out to you.
//
// Until this file existed, a notification was a thing that happened and then
// was gone. The condition is detected here in the bridge, broadcast over SSE,
// and turned into an OS toast in the renderer — and that was the end of it.
// Nothing was written down, `broadcast()` has no replay buffer, and Windows'
// own notification centre swallows toasts often enough that "something pinged
// me and I have no idea what" is the normal experience rather than the rare
// one. This is the answer to that question, after the fact.
//
// It is written by the bridge rather than by the page for two reasons. The page
// only exists while a window is open, so a log kept there would miss exactly the
// hours you were away — which are the hours a log is for. And two windows would
// each record the same event.
//
// The cost of recording here is one thing the page knows that the bridge cannot:
// whether you were looking straight at that session when its turn landed. So
// `loud` on an entry means "this cleared the bar for interrupting somebody", not
// "a toast definitely appeared on your screen". The UI says as much — the filter
// is called Notable, not "pinged me" — because a log that overstates what it
// knows is worse than one that admits the gap.
//
// JSONL rather than the single JSON blob flags.js writes, and that is not a
// style choice. Two bridges run on this machine at once — the everyday one and
// whatever development bridge an agent has up — and both of them write this
// file. A whole-file rewrite means the last writer silently discards the other
// one's rows. Appending a single short line is atomic, so two processes
// interleave instead of clobbering.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const { describeTool, firstLine } = require('./transcript');

const STATE_DIR = path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'claude-sessions');
const LOG_FILE = path.join(STATE_DIR, 'notifications.jsonl');

// How much history is worth keeping. Both limits apply: whichever bites first.
const KEEP = 1000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Lines written since the last rewrite before compacting. Resolutions are
// appended rather than patched in place, so the file grows faster than the
// number of entries in it.
const ROTATE_AFTER = 4000;

// The same line announceTurn() draws in the page: under this and you were
// almost certainly still sitting in front of it.
const MIN_TURN_MS = 30_000;

const TYPE_BY_KIND = { tool: 'permission', plan: 'plan', question: 'question' };

const clip = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Rounded, not precise — this is read at a glance next to a relative time. */
function dur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

class NotificationLog {
    /**
     * @param {object} opts
     * @param {(sessionId: string) => ({title?:string, projectName?:string, cwd?:string}|null)} opts.describe
     *   Session details as they are *now*, copied onto the entry as it is
     *   recorded. A log that resolved titles at read time would go blank the
     *   moment a session was deleted, which is when you most want to know what
     *   it was.
     * @param {(sessionId: string) => boolean} [opts.isTest]
     *   Asked at read time, not record time: labelling a session as a test
     *   afterwards should take its rows out of the everyday window too.
     */
    constructor({ describe, isTest } = {}) {
        this.describe = describe || (() => null);
        this.isTest = isTest || (() => false);
        /** @type {object[]} oldest first, same order as the file */
        this.rows = [];
        /** sessionId -> when its running turn started, from runner statuses */
        this.busy = new Map();
        this._lines = 0;
        this._broken = false;
        this.load();
    }

    // -- storage ------------------------------------------------------------

    load() {
        let raw;
        try { raw = fs.readFileSync(LOG_FILE, 'utf8'); } catch { return; }
        const lines = raw.split('\n').filter(l => l.trim());
        this._lines = lines.length;
        const byId = new Map();
        for (const line of lines) {
            let rec;
            // One unreadable line is one lost notification, not a lost log.
            try { rec = JSON.parse(line); } catch { continue; }
            if (rec && rec.op === 'resolve') {
                const row = byId.get(rec.requestId);
                if (row) { row.outcome = rec.outcome; row.outcomeAt = rec.outcomeAt; }
                continue;
            }
            if (!rec || !rec.id) continue;
            this.rows.push(rec);
            if (rec.requestId) byId.set(rec.requestId, rec);
        }
        this._prune();
    }

    /** Drop what has aged out or fallen off the end. Does not touch the file. */
    _prune() {
        const cutoff = Date.now() - MAX_AGE_MS;
        let from = 0;
        while (from < this.rows.length && this.rows[from].at < cutoff) from++;
        if (this.rows.length - from > KEEP) from = this.rows.length - KEEP;
        if (from) this.rows = this.rows.slice(from);
    }

    _write(rec) {
        try {
            fs.mkdirSync(STATE_DIR, { recursive: true });
            fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n');
            this._lines++;
            if (this._lines >= ROTATE_AFTER) this._compact();
        } catch (err) {
            // Say it once. A disk that cannot be written to will not be fixed by
            // being told about it on every notification.
            if (!this._broken) {
                this._broken = true;
                console.error(`[claude-sessions] could not write ${LOG_FILE}: ${err.message}`);
            }
        }
    }

    /**
     * Rewrite the file from what is in memory.
     *
     * The one non-atomic step here, so it is also the one place a concurrent
     * append from the other bridge can be lost. That is an acceptable trade for
     * a log: it happens once every few thousand lines, and it costs a row.
     */
    _compact() {
        this._prune();
        try {
            const tmp = LOG_FILE + '.tmp';
            fs.writeFileSync(tmp, this.rows.map(r => JSON.stringify(r) + '\n').join(''));
            fs.renameSync(tmp, LOG_FILE);
            this._lines = this.rows.length;
        } catch (err) {
            console.error(`[claude-sessions] could not compact ${LOG_FILE}: ${err.message}`);
            this._lines = 0;   // do not retry on every single append
        }
    }

    // -- recording ----------------------------------------------------------

    /**
     * File one entry. `sessionId` and `type` are required; everything else is
     * filled in from the session index.
     */
    record(entry) {
        const at = Date.now();
        const s = this.describe(entry.sessionId) || {};
        const row = {
            // Unique across both bridges, since both append to one file.
            id: `${at}-${randomUUID().slice(0, 8)}`,
            at,
            type: entry.type,
            sessionId: entry.sessionId,
            title: s.title || 'A session',
            project: s.projectName || null,
            cwd: s.cwd || null,
            summary: clip(entry.summary, 200) || null,
            detail: entry.detail ? clip(entry.detail, 400) : null,
            loud: Boolean(entry.loud),
            requestId: entry.requestId || null,
            outcome: null,
            outcomeAt: null,
            anchorId: entry.anchorId || null,
        };
        this.rows.push(row);
        this._prune();
        this._write(row);
        return row;
    }

    /**
     * Note how an ask ended, on the row that already exists for it.
     *
     * A second row would be wrong twice over: it doubles the count of things
     * that wanted you, and it separates the answer from the question.
     */
    resolve(requestId, outcome) {
        if (!requestId) return null;
        // Only look back a little way. An ask is answered in seconds or minutes,
        // and a requestId is only unique within a process anyway.
        for (let i = this.rows.length - 1, seen = 0; i >= 0 && seen < 200; i--, seen++) {
            const row = this.rows[i];
            if (row.requestId !== requestId || row.outcome) continue;
            row.outcome = outcome;
            row.outcomeAt = Date.now();
            this._write({ op: 'resolve', requestId, outcome, outcomeAt: row.outcomeAt });
            return row;
        }
        return null;
    }

    // -- the events, as they arrive from the runner pool ---------------------

    /**
     * How long the turn kept somebody waiting.
     *
     * Measured here rather than taken from the result, for the reason the page
     * gives at waitedMs(): the CLI's own duration is `duration_ms ||
     * duration_api_ms`, and the second of those is API time only, so a build
     * that omits the first quietly starts reporting a fraction of the wall
     * clock. Every status carries `busySince`, so keep the last one per session
     * and subtract when the turn lands.
     *
     * The stamp has to be read whether or not this turn gets logged as loud, or
     * the next turn inherits it.
     */
    noteRunner(status) {
        if (status && status.busySince) this.busy.set(status.sessionId, status.busySince);
    }

    _waited(sessionId, fallbackMs) {
        const started = this.busy.get(sessionId);
        this.busy.delete(sessionId);
        return started ? Date.now() - started : (fallbackMs || 0);
    }

    /** A blocked turn: a tool permission, a plan to approve, or a question. */
    ask(p) {
        const kind = p.kind || 'tool';
        return this.record({
            sessionId: p.sessionId,
            type: TYPE_BY_KIND[kind] || 'permission',
            summary: askSummary(p, kind),
            detail: askDetail(p, kind),
            // Always. The turn does not move until you answer, so unlike a
            // finished turn there is nothing to be gained by holding back.
            loud: true,
            requestId: p.requestId,
            // The tool call this ask belongs to is a real node in the
            // transcript, so the row can scroll you to it.
            anchorId: p.toolUseId || null,
        });
    }

    /** A finished turn — the ordinary ending, and the bad one. */
    turn(r) {
        const waited = this._waited(r.sessionId, r.durationMs);
        const bad = Boolean(r.isError);
        return this.record({
            sessionId: r.sessionId,
            type: bad ? 'failed' : 'finished',
            summary: bad ? clip(r.detail || 'The turn ended with an error.', 200)
                : `Ran for ${dur(waited)}.`,
            detail: bad ? r.detail : null,
            // A turn that ended badly always counts: every other kind of ending
            // you find out about by waiting, and this one leaves you waiting
            // forever. Otherwise, half a minute is the line between a turn you
            // sat through and one you walked away from.
            loud: bad || waited >= MIN_TURN_MS,
        });
    }

    /**
     * A send that never became a turn.
     *
     * Filed as a failure rather than as a warning because that is what it is
     * from where you sit: nothing more is coming, and unlike everything else on
     * this list it can quietly eat a message you queued and walked away from.
     */
    sendFailed(f) {
        this.busy.delete(f.sessionId);
        return this.record({
            sessionId: f.sessionId,
            type: 'failed',
            summary: clip(f.message || 'The message never reached Claude.', 200),
            detail: (f.unsent && f.unsent.length)
                ? `${f.unsent.length} unsent message(s): ${clip(f.unsent.join(' / '), 300)}`
                : null,
            loud: true,
        });
    }

    /**
     * A subagent finishing.
     *
     * Never loud, because nothing notifies for one of these today — it renders
     * inline in the transcript and that is all. It is here so that "what has
     * been happening" has an answer, which is what the Everything filter is for.
     *
     * The summary a subagent hands back is its whole report, so the row takes
     * the first line of it and keeps the rest for the detail.
     */
    agentDone(a) {
        const said = a.summary || 'A subagent finished.';
        const failed = a.status && a.status !== 'completed';
        return this.record({
            sessionId: a.sessionId,
            type: 'agent-done',
            summary: (failed ? `${a.status}: ` : '') + firstLine(said, 200),
            detail: said,
            loud: false,
            anchorId: a.toolUseId || null,
        });
    }

    /**
     * A message from another Claude session.
     *
     * Loud, unlike a subagent finishing. The difference is who it is from and
     * what it wants: an agent reporting back is this session's own work landing,
     * whereas this is somebody else's session asking yours for something, and it
     * may sit unanswered for as long as nobody looks. It is also the one event
     * here that can arrive at a session with no process of ours anywhere near
     * it, which is exactly the case a log is for.
     *
     * `from` is the peer's name, which is also its address — so the row names
     * the thing you would type to reply.
     */
    peerMessage(p) {
        const who = p.from || 'another session';
        const many = p.count > 1 ? ` (${p.count} messages)` : '';
        return this.record({
            sessionId: p.sessionId,
            type: 'peer-message',
            summary: `${who} sent a message${many}`,
            detail: null,
            loud: true,
        });
    }

    // -- reading ------------------------------------------------------------

    /**
     * Newest first, because that is the order the question is asked in: what
     * was that, just now.
     */
    list({ limit = 200, scope = 'all', type = null, sessionId = null, includeTest = false } = {}) {
        const out = [];
        for (let i = this.rows.length - 1; i >= 0 && out.length < limit; i--) {
            const row = this.rows[i];
            if (scope === 'notable' && !row.loud) continue;
            if (type && row.type !== type) continue;
            if (sessionId && row.sessionId !== sessionId) continue;
            if (!includeTest && this.isTest(row.sessionId)) continue;
            out.push(row);
        }
        return out;
    }

    clear() {
        this.rows = [];
        this._lines = 0;
        try {
            fs.mkdirSync(STATE_DIR, { recursive: true });
            fs.writeFileSync(LOG_FILE, '');
        } catch (err) {
            console.error(`[claude-sessions] could not clear ${LOG_FILE}: ${err.message}`);
        }
    }
}

function askSummary(p, kind) {
    if (kind === 'plan') {
        return firstLine((p.input && p.input.plan) || p.description || 'A plan is ready.', 200);
    }
    if (kind === 'question') {
        const qs = (p.input && p.input.questions) || [];
        return clip(qs.length ? qs[0].question : 'A question is waiting.', 200);
    }
    return clip(describeTool({ name: p.tool, input: p.input }) || p.displayName || 'A tool call', 200);
}

function askDetail(p, kind) {
    if (kind === 'plan') return (p.input && p.input.plan) || null;
    if (kind === 'question') {
        const qs = (p.input && p.input.questions) || [];
        return qs.length ? qs.map(q => q.question).join(' · ') : null;
    }
    return p.reason || p.description || null;
}

module.exports = { NotificationLog, LOG_FILE };
