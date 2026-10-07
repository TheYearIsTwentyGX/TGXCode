'use strict';

// Which sessions are orchestrators, which are their workers, and what the
// workers have said that the orchestrator has not read yet.
//
// An orchestrator is an ordinary session the user has marked as one. It starts
// workers — ordinary sessions too, usually each in a worktree of its own — and
// they show up nested under it in the rail. What makes it more than a session
// that called `start_task` a few times is the **inbox**: everything a worker
// produces for it (a report, a plan waiting for approval, a permission prompt,
// the end of a turn) lands here instead of in the orchestrator's conversation.
// The orchestrator pulls from it when it is ready, with `next_message`.
//
// **The inbox exists because the runner's own queue interrupts.** A message
// sent to a session mid-turn is handed over to the CLI at the next tool boundary
// and folded into the turn (runner.js, `_handOver`). That is right for a person
// typing "stop, wrong file", and wrong for six workers reporting in while the
// orchestrator is in the middle of deciding something. So nothing a worker says
// goes through `runner.send` on the orchestrator. The only thing that does is a
// one-line nudge, and only while the orchestrator is idle — see
// bridge/orchestration.js, which owns the timing; this file owns the state.
//
// **One level deep, enforced here.** A worker cannot be marked an orchestrator
// and an orchestrator cannot be spawned as somebody's worker. A tree of these
// is a way to spend a week's quota in an afternoon, and nothing anybody has
// asked for needs one.
//
// **Merge-on-write, for drafts.js's reason.** Every bridge on this machine
// shares STATE_DIR, the everyday one and each agent's dev bridge, and a whole-
// file rewrite from a snapshot would erase another bridge's orchestrators. So
// `flush()` reads the file back and merges per orchestrator, newer `updatedAt`
// winning, with removals tracked rather than inferred from absence. Only the
// bridge whose pool runs a worker ever acts on it, so two bridges writing the
// *same* orchestrator is not a case that arises in practice.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { STATE_DIR } = require('./config');

const DEFAULT_FILE = path.join(STATE_DIR, 'orchestrators.json');
const VERSION = 1;

// What a worker can say, and what the bridge files on its behalf. The first
// group comes from `report_to_orchestrator`; `turn` from a worker's turn ending;
// the last three from routing the worker's own asks here instead of to a window.
const REPORT_KINDS = ['question', 'update', 'done'];
const ASK_ITEM_KINDS = ['plan', 'permission', 'ask'];
const KINDS = [...REPORT_KINDS, 'turn', ...ASK_ITEM_KINDS, 'note'];

// Pulled first. Every one of these is a worker that cannot move until somebody
// answers it, which is the whole case for having an order at all.
const URGENT = new Set(['plan', 'permission', 'ask', 'question']);

// Enough history for the panel to be useful, and a ceiling so a worker in a loop
// cannot grow the file without bound. Only settled items are ever dropped.
const MAX_INBOX = 300;
const MAX_TEXT = 8000;
const MAX_SUMMARY = 1500;
const MAX_WORKERS = 50;

const WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

const DEFAULT_SETTINGS = Object.freeze({
    maxRunning: 3,
    worktree: true,
    usageStop: Object.freeze({ enabled: true, percent: 90, window: 'five_hour' }),
});

/**
 * Settings as the store keeps them, from whatever arrived. A field that fails is
 * replaced by `base`'s, so a bad PUT changes nothing rather than half of it.
 */
function cleanSettings(raw, base = DEFAULT_SETTINGS) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const u = s.usageStop && typeof s.usageStop === 'object' ? s.usageStop : {};
    const bu = base.usageStop || DEFAULT_SETTINGS.usageStop;
    return {
        maxRunning: Number.isInteger(s.maxRunning) && s.maxRunning >= 1 && s.maxRunning <= 10
            ? s.maxRunning : base.maxRunning,
        worktree: typeof s.worktree === 'boolean' ? s.worktree : base.worktree,
        usageStop: {
            enabled: typeof u.enabled === 'boolean' ? u.enabled : bu.enabled,
            percent: Number.isInteger(u.percent) && u.percent >= 1 && u.percent <= 100
                ? u.percent : bu.percent,
            window: WINDOWS.includes(u.window) ? u.window : bu.window,
        },
    };
}

/**
 * Inbox order: the items a worker is blocked on, then everything else; oldest
 * first within each. Pure, so the test can hold it to that.
 */
function sortInbox(items) {
    return items.slice().sort((a, b) => {
        const ua = URGENT.has(a.kind) ? 0 : 1;
        const ub = URGENT.has(b.kind) ? 0 : 1;
        if (ua !== ub) return ua - ub;
        return a.seq - b.seq;
    });
}

/**
 * Should the orchestrator be nudged now?
 *
 * Only when it is not working, has nothing queued and nothing pending — a nudge
 * mid-turn is exactly the interruption the inbox exists to prevent — and only
 * when something has arrived since the last nudge, so an orchestrator that
 * chooses to leave its inbox alone is told once rather than on every turn.
 *
 * `status` is the runner's status() or null when there is no process; no
 * process is as idle as a session gets.
 */
function shouldNudge(orch, status) {
    if (!orch || orch.paused) return false;
    const unread = orch.inbox.filter(i => i.status === 'new');
    if (!unread.length) return false;
    const newest = Math.max(...unread.map(i => i.seq));
    if (newest <= (orch.lastNudgedSeq || 0)) return false;
    if (!status) return true;
    if (status.state === 'busy' || status.state === 'starting') return false;
    if (status.pendingPermission) return false;
    if (status.queued) return false;
    return true;
}

/**
 * The usage window that trips the cutoff, or null. `windows` is
 * `usage.snapshot().windows`.
 */
function usageTrip(settings, windows) {
    const u = settings && settings.usageStop;
    if (!u || !u.enabled) return null;
    const w = (windows || []).find(x => x && x.type === u.window);
    if (!w || typeof w.usedPercent !== 'number') return null;
    return w.usedPercent >= u.percent ? { window: w.type, usedPercent: w.usedPercent, percent: u.percent } : null;
}

/** "1 plan, 2 turn reports" — what a nudge says is waiting. */
function describeCounts(items) {
    const by = new Map();
    for (const i of items) by.set(i.kind, (by.get(i.kind) || 0) + 1);
    const word = {
        plan: ['plan to approve', 'plans to approve'],
        permission: ['permission prompt', 'permission prompts'],
        ask: ['question for you to answer', 'questions for you to answer'],
        question: ['question', 'questions'],
        update: ['update', 'updates'],
        done: ['done report', 'done reports'],
        turn: ['turn report', 'turn reports'],
        note: ['note', 'notes'],
    };
    return KINDS.filter(k => by.has(k))
        .map(k => `${by.get(k)} ${word[k][by.get(k) === 1 ? 0 : 1]}`)
        .join(', ');
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

function cleanItem(i) {
    if (!i || typeof i.id !== 'string' || !KINDS.includes(i.kind)) return null;
    return {
        id: i.id,
        workerId: str(i.workerId, 100),
        kind: i.kind,
        text: str(i.text, MAX_TEXT) || '',
        at: Number.isFinite(i.at) ? i.at : 0,
        seq: Number.isFinite(i.seq) ? i.seq : 0,
        status: ['new', 'read', 'resolved', 'stale'].includes(i.status) ? i.status : 'new',
        requestId: str(i.requestId, 200),
        // The ask itself, for the three kinds that can be answered: the plan text
        // or the questions, as the runner holds them in `input`.
        ask: i.ask && typeof i.ask === 'object' ? i.ask : null,
        outcome: str(i.outcome, 60),
        by: str(i.by, 40),
    };
}

function cleanWorker(w) {
    if (!w || typeof w.id !== 'string') return null;
    return {
        id: w.id,
        title: str(w.title, 200),
        cwd: str(w.cwd, 4096),
        worktree: w.worktree && typeof w.worktree === 'object'
            ? { path: str(w.worktree.path, 4096), branch: str(w.worktree.branch, 300) }
            : null,
        spawnedAt: Number.isFinite(w.spawnedAt) ? w.spawnedAt : 0,
        closedAt: Number.isFinite(w.closedAt) ? w.closedAt : null,
        // Set by `report_to_orchestrator` with kind `done`, cleared at the end
        // of the turn it was said in, so that turn does not also file a `turn`.
        reportedDone: !!w.reportedDone,
    };
}

function cleanSpawn(p) {
    if (!p || typeof p.id !== 'string' || typeof p.prompt !== 'string') return null;
    return {
        id: p.id,
        prompt: p.prompt.slice(0, 100_000),
        title: str(p.title, 200),
        opts: p.opts && typeof p.opts === 'object' ? p.opts : {},
        at: Number.isFinite(p.at) ? p.at : 0,
    };
}

function cleanOrch(id, o) {
    if (!o || typeof o !== 'object') return null;
    return {
        id,
        createdAt: Number.isFinite(o.createdAt) ? o.createdAt : 0,
        updatedAt: Number.isFinite(o.updatedAt) ? o.updatedAt : 0,
        settings: cleanSettings(o.settings),
        paused: o.paused && typeof o.paused === 'object'
            ? { reason: str(o.paused.reason, 500) || 'paused', at: Number(o.paused.at) || 0 }
            : null,
        summary: o.summary && typeof o.summary.text === 'string'
            ? { text: o.summary.text.slice(0, MAX_SUMMARY), at: Number(o.summary.at) || 0 }
            : null,
        workers: (Array.isArray(o.workers) ? o.workers : []).map(cleanWorker).filter(Boolean),
        pendingSpawns: (Array.isArray(o.pendingSpawns) ? o.pendingSpawns : [])
            .map(cleanSpawn).filter(Boolean),
        inbox: (Array.isArray(o.inbox) ? o.inbox : []).map(cleanItem).filter(Boolean),
        seq: Number.isFinite(o.seq) ? o.seq : 0,
        lastNudgedSeq: Number.isFinite(o.lastNudgedSeq) ? o.lastNudgedSeq : 0,
    };
}

function readFile(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return new Map(); }
    try {
        const data = JSON.parse(raw.replace(/^﻿/, ''));
        if (data.version !== VERSION || !data.orchestrators) return new Map();
        const out = new Map();
        for (const [id, o] of Object.entries(data.orchestrators)) {
            const c = cleanOrch(id, o);
            if (c) out.set(id, c);
        }
        return out;
    } catch (err) {
        console.error(`[tgxcode] ignoring unreadable ${file}: ${err.message}`);
        return new Map();
    }
}

class Orchestrators {
    /** @param {{file?: string}} [opts] `file` is for the test. */
    constructor({ file = DEFAULT_FILE } = {}) {
        this.file = file;
        /** @type {Map<string, object>} */
        this.byId = new Map();
        /** worker id -> orchestrator id */
        this.workerOf = new Map();
        this._removed = new Set();
        this._saveTimer = null;
        this.load();
    }

    load() {
        this.byId = readFile(this.file);
        this._reindex();
    }

    _reindex() {
        this.workerOf.clear();
        for (const o of this.byId.values()) {
            for (const w of o.workers) this.workerOf.set(w.id, o.id);
        }
    }

    save() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => this.flush(), 300);
        this._saveTimer.unref();
    }

    flush() {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        try {
            const merged = readFile(this.file);
            for (const id of this._removed) merged.delete(id);
            for (const [id, o] of this.byId) {
                const theirs = merged.get(id);
                if (!theirs || theirs.updatedAt <= o.updatedAt) merged.set(id, o);
            }
            // Adopt what another bridge wrote, so the next read here sees it.
            for (const [id, o] of merged) if (!this.byId.has(id) && !this._removed.has(id)) this.byId.set(id, o);
            this._reindex();
            const out = { version: VERSION, orchestrators: Object.fromEntries(merged) };
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
            fs.renameSync(tmp, this.file);
            this._removed.clear();
        } catch (err) {
            console.error(`[tgxcode] could not write ${this.file}: ${err.message}`);
        }
    }

    _touch(o) {
        o.updatedAt = Date.now();
        this.save();
        return o;
    }

    // -- roles --------------------------------------------------------------

    get(id) { return this.byId.get(id) || null; }

    orchestratorOf(workerId) {
        const id = this.workerOf.get(workerId);
        return id ? this.byId.get(id) || null : null;
    }

    /** 'orchestrator' | 'worker' | null — what `claude` is told at spawn. */
    roleOf(sessionId) {
        if (this.byId.has(sessionId)) return 'orchestrator';
        const o = this.orchestratorOf(sessionId);
        if (o) {
            const w = o.workers.find(x => x.id === sessionId);
            if (w && !w.closedAt) return 'worker';
        }
        return null;
    }

    /** Make a session an orchestrator. Throws, with a sentence, when it cannot be. */
    enable(sessionId, { settings } = {}) {
        if (this.workerOf.has(sessionId)) {
            throw refusal('that session is a worker of another orchestrator, and orchestrators '
                + 'only go one level deep');
        }
        let o = this.byId.get(sessionId);
        if (o) {
            if (settings) o.settings = cleanSettings(settings, o.settings);
            return this._touch(o);
        }
        o = cleanOrch(sessionId, { createdAt: Date.now(), settings });
        this.byId.set(sessionId, o);
        this._removed.delete(sessionId);
        return this._touch(o);
    }

    /** Stop being an orchestrator. The workers carry on as ordinary sessions. */
    disable(sessionId) {
        const o = this.byId.get(sessionId);
        if (!o) return false;
        this.byId.delete(sessionId);
        this._removed.add(sessionId);
        this._reindex();
        this.save();
        return true;
    }

    setSettings(sessionId, patch) {
        const o = this.byId.get(sessionId);
        if (!o) return null;
        const merged = { ...o.settings, ...patch,
            usageStop: { ...o.settings.usageStop, ...(patch && patch.usageStop) } };
        o.settings = cleanSettings(merged, o.settings);
        return this._touch(o);
    }

    setSummary(sessionId, text) {
        const o = this.byId.get(sessionId);
        if (!o) return null;
        const t = String(text || '').trim().slice(0, MAX_SUMMARY);
        o.summary = t ? { text: t, at: Date.now() } : null;
        return this._touch(o);
    }

    setPaused(sessionId, paused) {
        const o = this.byId.get(sessionId);
        if (!o) return null;
        o.paused = paused ? { reason: String(paused.reason || 'paused'), at: Date.now() } : null;
        return this._touch(o);
    }

    // -- workers ------------------------------------------------------------

    addWorker(orchId, w) {
        const o = this.byId.get(orchId);
        if (!o) throw refusal('that session is not an orchestrator');
        if (this.byId.has(w.id)) throw refusal('an orchestrator cannot be a worker');
        if (o.workers.filter(x => !x.closedAt).length >= MAX_WORKERS) {
            throw refusal(`an orchestrator can hold at most ${MAX_WORKERS} open workers — close some first`);
        }
        const row = cleanWorker({ ...w, spawnedAt: Date.now() });
        o.workers.push(row);
        this.workerOf.set(row.id, orchId);
        this._touch(o);
        return row;
    }

    worker(orchId, workerId) {
        const o = this.byId.get(orchId);
        return o ? o.workers.find(w => w.id === workerId) || null : null;
    }

    closeWorker(orchId, workerId) {
        const w = this.worker(orchId, workerId);
        if (!w) return null;
        w.closedAt = Date.now();
        this._touch(this.byId.get(orchId));
        return w;
    }

    /** Take a worker off the list altogether — for a session that was deleted. */
    removeWorker(orchId, workerId) {
        const o = this.byId.get(orchId);
        if (!o) return false;
        const before = o.workers.length;
        o.workers = o.workers.filter(w => w.id !== workerId);
        if (o.workers.length === before) return false;
        this.workerOf.delete(workerId);
        this._touch(o);
        return true;
    }

    openWorkers(orchId) {
        const o = this.byId.get(orchId);
        return o ? o.workers.filter(w => !w.closedAt) : [];
    }

    noteDone(workerId, done) {
        const o = this.orchestratorOf(workerId);
        const w = o && o.workers.find(x => x.id === workerId);
        if (!w) return;
        w.reportedDone = !!done;
        this._touch(o);
    }

    queueSpawn(orchId, spawn) {
        const o = this.byId.get(orchId);
        if (!o) return null;
        const row = cleanSpawn({ ...spawn, id: randomUUID(), at: Date.now() });
        o.pendingSpawns.push(row);
        this._touch(o);
        return row;
    }

    takeSpawn(orchId) {
        const o = this.byId.get(orchId);
        if (!o || !o.pendingSpawns.length) return null;
        const row = o.pendingSpawns.shift();
        this._touch(o);
        return row;
    }

    // -- inbox --------------------------------------------------------------

    /** File an item. Returns it, or null when there is no orchestrator to file it with. */
    push(orchId, item) {
        const o = this.byId.get(orchId);
        if (!o) return null;
        o.seq += 1;
        const row = cleanItem({
            ...item, id: randomUUID(), at: Date.now(), seq: o.seq, status: 'new',
        });
        if (!row) return null;
        o.inbox.push(row);
        // Drop the oldest settled items first; never one still waiting.
        while (o.inbox.length > MAX_INBOX) {
            const i = o.inbox.findIndex(x => x.status !== 'new');
            if (i < 0) break;
            o.inbox.splice(i, 1);
        }
        this._touch(o);
        return row;
    }

    /** Up to `max` unread items in inbox order, marked read. */
    pull(orchId, max = 1) {
        const o = this.byId.get(orchId);
        if (!o) return [];
        const out = sortInbox(o.inbox.filter(i => i.status === 'new')).slice(0, Math.max(1, max));
        for (const i of out) i.status = 'read';
        if (out.length) this._touch(o);
        return out;
    }

    item(orchId, itemId) {
        const o = this.byId.get(orchId);
        return o ? o.inbox.find(i => i.id === itemId) || null : null;
    }

    settle(orchId, itemId, { status = 'resolved', outcome = null, by = null } = {}) {
        const i = this.item(orchId, itemId);
        if (!i) return null;
        i.status = status;
        if (outcome) i.outcome = outcome;
        if (by) i.by = by;
        this._touch(this.byId.get(orchId));
        return i;
    }

    /** The item filed for a worker's ask, by the ask's request id. */
    byRequest(workerId, requestId) {
        const o = this.orchestratorOf(workerId);
        if (!o) return null;
        return o.inbox.find(i => i.workerId === workerId && i.requestId === requestId) || null;
    }

    noteNudged(orchId, seq) {
        const o = this.byId.get(orchId);
        if (!o) return;
        o.lastNudgedSeq = seq;
        this._touch(o);
    }

    unread(orchId) {
        const o = this.byId.get(orchId);
        return o ? sortInbox(o.inbox.filter(i => i.status === 'new')) : [];
    }

    // -- read side ----------------------------------------------------------

    /** What a session summary carries, or `{}` for a session with no part in this. */
    forSummary(sessionId) {
        const o = this.byId.get(sessionId);
        if (o) {
            return {
                orchestrator: {
                    inbox: o.inbox.filter(i => i.status === 'new').length,
                    workers: o.workers.filter(w => !w.closedAt).length,
                    paused: !!o.paused,
                },
            };
        }
        const owner = this.orchestratorOf(sessionId);
        if (owner) {
            const w = owner.workers.find(x => x.id === sessionId);
            return { worker: { orchestratorId: owner.id, title: w.title || null, closed: !!w.closedAt } };
        }
        return {};
    }
}

function refusal(message) {
    const err = new Error(message);
    err.refusal = true;
    return err;
}

module.exports = {
    Orchestrators, cleanSettings, sortInbox, shouldNudge, usageTrip, describeCounts,
    DEFAULT_SETTINGS, REPORT_KINDS, KINDS, WINDOWS, MAX_SUMMARY,
};
