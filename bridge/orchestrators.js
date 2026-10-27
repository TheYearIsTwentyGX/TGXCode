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
// `flush()` reads the file back and writes over it only the orchestrators this
// bridge changed since its last write (newer `updatedAt` winning), with removals
// tracked rather than inferred from absence — then adopts the file as it stands.
// Writing back a copy it never touched is how an orchestrator another bridge had
// disabled used to come back. Only the
// bridge whose pool runs a worker ever acts on it, so two bridges writing the
// *same* orchestrator is not a case that arises in practice.

const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');

const { STATE_DIR } = require('./config');

const DEFAULT_FILE = path.join(STATE_DIR, 'orchestrators.json');
const VERSION = 1;

// What a worker can say, and what the bridge files on its behalf. The first
// group comes from `report_to_orchestrator`; `turn` from a worker's turn ending;
// the next three from routing the worker's own asks here instead of to a window.
// `task` is the one that comes from the user rather than a worker: a draft, or
// the Start dialog as it stood, handed over for the orchestrator to fit in.
const REPORT_KINDS = ['question', 'update', 'done'];
const ASK_ITEM_KINDS = ['plan', 'permission', 'ask'];
const KINDS = [...REPORT_KINDS, 'turn', ...ASK_ITEM_KINDS, 'note', 'task'];

// Pulled first. Every one of these is a worker that cannot move until somebody
// answers it, which is the whole case for having an order at all.
const URGENT = new Set(['plan', 'permission', 'ask', 'question']);

// Enough history for the panel to be useful, and a ceiling so a worker in a loop
// cannot grow the file without bound. Only settled items are ever dropped.
const MAX_INBOX = 300;
const MAX_TEXT = 8000;
const MAX_SUMMARY = 1500;
const MAX_WORKERS = 50;

// Tasks the user handed over that nobody has started yet. An open task is never
// trimmed (it is the only copy of what the user wrote), so this is what bounds
// the file instead — a client in a loop gets a 409 rather than an inbox that
// grows for ever.
const MAX_OPEN_TASKS = 20;
const MAX_TASK_PROMPT = 100_000;

// The brief's structured half — what the orchestrator page draws from rather
// than parsing prose. Small on purpose: a goal is a line, a decision is a
// question somebody can answer in one breath, and six of them waiting is
// already more than anybody is going to answer.
const MAX_GOAL = 200;
const MAX_DECISIONS = 6;
const MAX_DECISION_TEXT = 400;
const MAX_OPTIONS = 4;
const MAX_OPTION = 80;
const MAX_ANSWER = 2000;
const MAX_MERGE = 30;

const WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
// What `usageStop.window` may be: one window, measured against `percent`, or
// `all`, where each window has its own threshold in `limits` and any one of
// them past its own trips the cutoff.
const STOP_WINDOWS = [...WINDOWS, 'all'];

const DEFAULT_SETTINGS = Object.freeze({
    maxRunning: 3,
    worktree: true,
    usageStop: Object.freeze({
        enabled: true,
        percent: 90,
        window: 'five_hour',
        // For `window: "all"`. Null leaves that window out.
        limits: Object.freeze({ five_hour: 90, seven_day: 95, seven_day_opus: null, seven_day_sonnet: null }),
        // Lift the pause by itself once the window that tripped it resets, and
        // tell the orchestrator so it can carry on. Off: wait for Resume.
        autoResume: false,
        // Who last set `autoResume`, and why: {by: 'user'|'agent', at, reason}.
        // Null while it is still the default it started with. Stamped by the
        // PUT route, never taken from a client, so the page can say when the
        // orchestrator changed it for itself.
        autoResumeBy: null,
    }),
});

const pct = (v) => Number.isInteger(v) && v >= 1 && v <= 100;

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
            percent: pct(u.percent) ? u.percent : bu.percent,
            window: STOP_WINDOWS.includes(u.window) ? u.window : bu.window,
            limits: cleanLimits(u.limits, bu.limits || DEFAULT_SETTINGS.usageStop.limits),
            autoResume: typeof u.autoResume === 'boolean' ? u.autoResume
                : (typeof bu.autoResume === 'boolean' ? bu.autoResume : false),
            autoResumeBy: 'autoResumeBy' in u ? cleanAutoResumeBy(u.autoResumeBy) : (bu.autoResumeBy || null),
        },
    };
}

const MAX_REASON = 200;

function cleanAutoResumeBy(raw) {
    if (!raw || typeof raw !== 'object' || !['user', 'agent'].includes(raw.by)) return null;
    const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, MAX_REASON).trim() : '';
    return { by: raw.by, at: Number.isFinite(raw.at) ? raw.at : 0, reason: reason || null };
}

/** One threshold per window; a key that fails keeps `base`'s, null clears it. */
function cleanLimits(raw, base) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const w of WINDOWS) {
        if (r[w] === null) out[w] = null;
        else if (pct(r[w])) out[w] = r[w];
        else out[w] = base && w in base ? base[w] : null;
    }
    return out;
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

/** `resetsAt` as epoch ms — unix seconds from bridge/usage.js, ms tolerated — or null. */
function resetMs(w) {
    if (!w || !Number.isFinite(w.resetsAt) || w.resetsAt <= 0) return null;
    return w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt;
}

/**
 * Every window over its threshold: `[{window, usedPercent, percent, resetsAt}]`,
 * `resetsAt` epoch ms or null. Empty when the cutoff is off or nothing is over.
 * `windows` is `usage.snapshot().windows`.
 *
 * One window against `percent`, or with `window: "all"` each window against its
 * own entry in `limits` — so five-hour past 90 *or* weekly past 95.
 */
function usageTrips(settings, windows, now = Date.now()) {
    const u = settings && settings.usageStop;
    if (!u || !u.enabled) return [];
    const wanted = u.window === 'all'
        ? WINDOWS.filter(w => u.limits && pct(u.limits[w])).map(w => [w, u.limits[w]])
        : [[u.window, u.percent]];
    const out = [];
    for (const [type, percent] of wanted) {
        const w = (windows || []).find(x => x && x.type === type);
        if (!w || typeof w.usedPercent !== 'number') continue;
        // A reading from before the window reset describes a period that is
        // over. While paused nothing runs, so nothing brings a fresh one — and a
        // stale 92% would keep refusing Resume long after the window had emptied.
        const reset = resetMs(w);
        if (reset !== null && reset <= now) continue;
        if (w.usedPercent >= percent) out.push({ window: type, usedPercent: w.usedPercent, percent, resetsAt: reset });
    }
    return out;
}

/** The first window over its threshold, or null — `usageTrips` for a yes or no. */
function usageTrip(settings, windows, now = Date.now()) {
    return usageTrips(settings, windows, now)[0] || null;
}

/**
 * When a pause for these trips can lift by itself: the *latest* reset among
 * them, since until every tripped window has reset the cutoff would trip again
 * at once. Null when any of them has no reset time to wait for.
 */
function resumeAtFor(trips) {
    if (!trips.length || trips.some(t => t.resetsAt === null)) return null;
    return Math.max(...trips.map(t => t.resetsAt));
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
        task: ['task from the user', 'tasks from the user'],
    };
    return KINDS.filter(k => by.has(k))
        .map(k => `${by.get(k)} ${word[k][by.get(k) === 1 ? 0 : 1]}`)
        .join(', ');
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

/**
 * Where a piece of work came from, when it was not the orchestrator's idea: a
 * draft (`draftId` names it, so Take back can say which) or the Start dialog.
 * Null for everything an orchestrator thought of itself.
 */
function cleanOrigin(o) {
    if (!o || typeof o !== 'object' || !['draft', 'dialog'].includes(o.from)) return null;
    return { from: o.from, draftId: str(o.draftId, 100), title: str(o.title, 200),
        draftCreatedAt: Number.isFinite(o.draftCreatedAt) ? o.draftCreatedAt : null };
}

/**
 * A task's payload: exactly a draft's fields plus a worktree hint and where it
 * came from. Spelled out, as drafts.js's `clean` is, so a body cannot smuggle a
 * key into the store.
 */
function cleanTask(t) {
    if (!t || typeof t !== 'object' || typeof t.prompt !== 'string' || !t.prompt) return null;
    if (typeof t.cwd !== 'string' || !t.cwd) return null;
    const wt = t.worktree && typeof t.worktree === 'object' && typeof t.worktree.name === 'string'
        && t.worktree.name.trim()
        ? { name: t.worktree.name.trim().slice(0, 200), base: str(t.worktree.base, 200) || null }
        : null;
    return {
        prompt: t.prompt.slice(0, MAX_TASK_PROMPT),
        cwd: t.cwd.slice(0, 4096),
        title: str(t.title, 200) || null,
        model: str(t.model, 100) || null,
        effort: str(t.effort, 40) || null,
        permissionMode: str(t.permissionMode, 40) || 'auto',
        test: !!t.test,
        worktree: wt,
        origin: cleanOrigin(t.origin),
    };
}

/** Still the orchestrator's to act on: not started, taken back or gone. */
const isOpenTask = (i) => i.kind === 'task' && (i.status === 'new' || i.status === 'read');

/**
 * What a spawn from a task asks for: `opts` is what the orchestrator passed to
 * spawn_worker, `task` the item's payload. Pure, so the precedence is tested.
 *
 * **The user's choices win where they made one** — directory, model, effort,
 * permission mode, test. Those were picked by a person in a dialog, and the
 * orchestrator copying them faithfully is not something to depend on; it may
 * only fill a gap (a model left on inherit). What the orchestrator may change is
 * what fitting the work into its plan needs: the prompt (to add context), the
 * title, and the worktree.
 */
function spawnOptsFromTask(task, opts = {}) {
    const set = (v) => v !== null && v !== undefined && v !== '';
    const theirsTree = set(opts.worktree);
    return {
        prompt: typeof opts.prompt === 'string' && opts.prompt.trim() ? opts.prompt : task.prompt,
        title: (set(opts.title) ? opts.title : task.title) || null,
        cwd: set(task.cwd) ? task.cwd : opts.cwd || null,
        model: set(task.model) ? task.model : opts.model || null,
        effort: set(task.effort) ? task.effort : opts.effort || null,
        permissionMode: set(task.permissionMode) ? task.permissionMode : opts.permissionMode || null,
        worktree: theirsTree ? opts.worktree : task.worktree ? task.worktree.name : null,
        worktreeBase: !theirsTree && task.worktree ? task.worktree.base || null : null,
        test: !!task.test,
        origin: task.origin || null,
    };
}

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
        // When it was answered, dismissed or went stale. Null while open, and on
        // every item settled before this was recorded.
        settledAt: Number.isFinite(i.settledAt) ? i.settledAt : null,
        // The work itself, on a `task` item; null on every other kind.
        task: i.kind === 'task' ? cleanTask(i.task) : null,
    };
}

/**
 * A decision's id: a hash of its question, so the orchestrator can rewrite the
 * whole list on every `set_summary` and a question it keeps keeps its id — and
 * with it when it was first asked and any answer already recorded against it.
 */
function decisionId(text) {
    return createHash('sha1').update(String(text).trim().toLowerCase()).digest('hex').slice(0, 12);
}

function cleanDecision(d) {
    if (!d || typeof d.text !== 'string' || !d.text.trim()) return null;
    const text = d.text.trim().slice(0, MAX_DECISION_TEXT);
    return {
        id: typeof d.id === 'string' && d.id ? d.id.slice(0, 40) : decisionId(text),
        text,
        options: (Array.isArray(d.options) ? d.options : [])
            .filter(o => typeof o === 'string' && o.trim())
            .map(o => o.trim().slice(0, MAX_OPTION)).slice(0, MAX_OPTIONS),
        workerId: str(d.workerId, 100),
        at: Number.isFinite(d.at) ? d.at : 0,
        answer: str(d.answer, MAX_ANSWER),
        answeredAt: Number.isFinite(d.answeredAt) ? d.answeredAt : null,
    };
}

/** PR numbers, in the order to merge them. `#212` and `"212"` are read as 212. */
function cleanMergeOrder(list) {
    const out = [];
    for (const v of Array.isArray(list) ? list : []) {
        const n = typeof v === 'number' ? v : Number.parseInt(String(v).replace(/^#/, ''), 10);
        if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
        if (out.length >= MAX_MERGE) break;
    }
    return out;
}

function cleanSummary(s) {
    if (!s || typeof s.text !== 'string') return null;
    return {
        text: s.text.slice(0, MAX_SUMMARY),
        at: Number(s.at) || 0,
        goal: str(s.goal, MAX_GOAL),
        decisions: (Array.isArray(s.decisions) ? s.decisions : [])
            .map(cleanDecision).filter(Boolean).slice(0, MAX_DECISIONS),
        mergeOrder: cleanMergeOrder(s.mergeOrder),
    };
}

/**
 * The decisions a `set_summary` asked for, merged with the ones already held.
 * Each arrives as a question string or `{text, options?, worker?}`. A question
 * the list already had keeps its `at` and its answer; one that is new is asked
 * now; one left out is gone — answered, or no longer worth asking.
 */
function mergeDecisions(prev, incoming, now) {
    const held = new Map((prev || []).map(d => [d.id, d]));
    const out = [];
    for (const raw of Array.isArray(incoming) ? incoming : []) {
        const d = typeof raw === 'string' ? { text: raw } : raw && typeof raw === 'object'
            ? { text: raw.text, options: raw.options, workerId: raw.worker || raw.workerId } : null;
        const c = cleanDecision(d && { ...d, id: null });
        if (!c || out.some(x => x.id === c.id)) continue;
        const old = held.get(c.id);
        out.push({ ...c, at: old ? old.at : now,
            answer: old ? old.answer : null, answeredAt: old ? old.answeredAt : null });
        if (out.length >= MAX_DECISIONS) break;
    }
    return out;
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
        origin: cleanOrigin(w.origin),
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
        origin: cleanOrigin(p.origin),
    };
}

/**
 * A pause as the store keeps it. `resumeAt` (epoch ms) is when it lifts by
 * itself, or null for Resume only; `by` is the port of the bridge that set it,
 * which is the only one that will lift it — the store is shared by every bridge;
 * `interrupted` the sessions the cutoff stopped mid-turn, for the note the
 * orchestrator gets when it wakes.
 */
function cleanPaused(p, at) {
    return {
        reason: str(p.reason, 500) || 'paused',
        at,
        resumeAt: Number.isFinite(p.resumeAt) && p.resumeAt > 0 ? p.resumeAt : null,
        by: Number.isInteger(p.by) ? p.by : null,
        interrupted: Array.isArray(p.interrupted)
            ? p.interrupted.filter(x => typeof x === 'string').slice(0, MAX_WORKERS) : [],
    };
}

/**
 * Where the user moved an orchestrator to: `{cwd, from, at}`, or null.
 *
 * A session that ended up running in a worktree without EnterWorktree has no
 * way out by itself. The transcript is what decides where it resumes, and every
 * line its process writes is recorded in the worktree, so the evidence for the
 * worktree is always the newest; ExitWorktree refuses, having nothing to exit;
 * and a `cd` is undone by the CLI after the call. So the bridge keeps its own
 * answer, here, rather than editing a transcript that is Claude Code's.
 */
function cleanCwdOverride(c) {
    if (!c || typeof c !== 'object' || typeof c.cwd !== 'string' || !c.cwd) return null;
    return {
        cwd: c.cwd,
        from: typeof c.from === 'string' && c.from ? c.from : null,
        at: Number.isFinite(c.at) ? c.at : 0,
    };
}

/**
 * A move asked for while the orchestrator was mid-turn, waiting for the turn to
 * end: `{cwd, from, force, at}`. Kept here rather than on the runner so a
 * bridge restart in between does not lose it — the runner is adopted from the
 * session host, but nothing it carries would say a move was asked for. One at a
 * time: a second request replaces the first. See orchestration.settleMove.
 */
function cleanPendingMove(c) {
    if (!c || typeof c !== 'object' || typeof c.cwd !== 'string' || !c.cwd) return null;
    return {
        cwd: c.cwd,
        from: typeof c.from === 'string' && c.from ? c.from : null,
        force: c.force === true,
        at: Number.isFinite(c.at) ? c.at : 0,
    };
}

/**
 * The override as it stands against the transcript, or null once it no longer
 * applies. It stops applying when a worktree-state entry is written after it —
 * the session really entered (or left) a worktree with EnterWorktree since, and
 * that is a decision of its own that the old move must not undo. Pure, for the
 * test; `meta` is the scanned transcript (or a summary-shaped stand-in).
 */
function liveCwdOverride(c, meta) {
    if (!c) return null;
    const ts = meta && meta.worktreeStateTs ? Date.parse(meta.worktreeStateTs) : NaN;
    if (Number.isFinite(ts) && ts > c.at) return null;
    return c;
}

function cleanOrch(id, o) {
    if (!o || typeof o !== 'object') return null;
    return {
        id,
        createdAt: Number.isFinite(o.createdAt) ? o.createdAt : 0,
        updatedAt: Number.isFinite(o.updatedAt) ? o.updatedAt : 0,
        settings: cleanSettings(o.settings),
        paused: o.paused && typeof o.paused === 'object'
            ? cleanPaused(o.paused, Number(o.paused.at) || 0)
            : null,
        summary: cleanSummary(o.summary),
        workers: (Array.isArray(o.workers) ? o.workers : []).map(cleanWorker).filter(Boolean),
        pendingSpawns: (Array.isArray(o.pendingSpawns) ? o.pendingSpawns : [])
            .map(cleanSpawn).filter(Boolean),
        inbox: (Array.isArray(o.inbox) ? o.inbox : []).map(cleanItem).filter(Boolean),
        seq: Number.isFinite(o.seq) ? o.seq : 0,
        lastNudgedSeq: Number.isFinite(o.lastNudgedSeq) ? o.lastNudgedSeq : 0,
        cwdOverride: cleanCwdOverride(o.cwdOverride),
        pendingMove: cleanPendingMove(o.pendingMove),
    };
}

/**
 * The file as a map — empty when there is no file — or **null when there is one
 * this build cannot read**: torn, hand-broken, or written by a newer build with
 * another `version`. Null is not empty. A save that treated it as empty would
 * write back only what it had just changed and adopt the result, which quietly
 * un-makes every other orchestrator on the machine.
 */
function readFile(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
        return err.code === 'ENOENT' ? new Map() : null;
    }
    try {
        const data = JSON.parse(raw.replace(/^﻿/, ''));
        if (data.version !== VERSION || !data.orchestrators) {
            console.error(`[tgxcode] not touching ${file}: version ${data.version} is not ${VERSION}`);
            return null;
        }
        const out = new Map();
        for (const [id, o] of Object.entries(data.orchestrators)) {
            const c = cleanOrch(id, o);
            if (c) out.set(id, c);
        }
        return out;
    } catch (err) {
        console.error(`[tgxcode] not touching unreadable ${file}: ${err.message}`);
        return null;
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
        /** Ids this bridge changed since its last write — the only ones it writes. */
        this._dirty = new Set();
        this._saveTimer = null;
        this.load();
    }

    load() {
        // Unreadable reads as empty here, so the bridge still starts; `flush`
        // reads again and refuses to write over a file it cannot read.
        this.byId = readFile(this.file) || new Map();
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
            // Only what *this* bridge changed since the last write goes over the
            // file. Everything else on disk is newer than our copy or the same,
            // and writing our copy of an orchestrator we never touched is how one
            // another bridge disabled used to come back: absent from the file
            // looked the same as never written.
            const merged = readFile(this.file);
            if (!merged) {
                // Keep what we have in memory and leave the file alone: writing
                // over a newer build's file, or a torn one somebody is mending,
                // loses everything in it that this bridge never saw.
                return;
            }
            for (const id of this._removed) merged.delete(id);
            for (const id of this._dirty) {
                const o = this.byId.get(id);
                if (!o) continue;
                const theirs = merged.get(id);
                if (!theirs || theirs.updatedAt <= o.updatedAt) merged.set(id, o);
            }
            const out = { version: VERSION, orchestrators: Object.fromEntries(merged) };
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
            fs.renameSync(tmp, this.file);
            // And adopt the file as it now stands, removals by others included,
            // so the next read here sees what every bridge sees.
            this.byId = merged;
            this._reindex();
            this._removed.clear();
            this._dirty.clear();
        } catch (err) {
            console.error(`[tgxcode] could not write ${this.file}: ${err.message}`);
        }
    }

    _touch(o) {
        o.updatedAt = Date.now();
        this._dirty.add(o.id);
        this.save();
        return o;
    }

    // -- roles --------------------------------------------------------------

    get(id) { return this.byId.get(id) || null; }

    ids() { return [...this.byId.keys()]; }

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
        this._dirty.delete(sessionId);
        this._reindex();
        this.save();
        return true;
    }

    setSettings(sessionId, patch) {
        const o = this.byId.get(sessionId);
        if (!o) return null;
        const merged = { ...o.settings, ...patch,
            usageStop: {
                ...o.settings.usageStop, ...(patch && patch.usageStop),
                limits: { ...o.settings.usageStop.limits, ...(patch && patch.usageStop && patch.usageStop.limits) },
            } };
        o.settings = cleanSettings(merged, o.settings);
        return this._touch(o);
    }

    /**
     * The brief. `text` is the prose and is required: empty clears the whole
     * summary, structured fields with it. `fields` is the structured half —
     * `goal`, `decisions`, `mergeOrder` — and each is optional: left out, it
     * keeps what it was; null or empty, it is cleared.
     */
    setSummary(sessionId, text, fields = {}) {
        const o = this.byId.get(sessionId);
        if (!o) return null;
        const t = String(text || '').trim().slice(0, MAX_SUMMARY);
        if (!t) {
            o.summary = null;
            return this._touch(o);
        }
        const prev = o.summary || { goal: null, decisions: [], mergeOrder: [] };
        const f = fields && typeof fields === 'object' ? fields : {};
        const now = Date.now();
        const has = (k) => Object.prototype.hasOwnProperty.call(f, k) && f[k] !== undefined;
        o.summary = {
            text: t,
            at: now,
            goal: has('goal') ? (str(typeof f.goal === 'string' ? f.goal.trim() : null, MAX_GOAL) || null)
                : prev.goal,
            decisions: has('decisions') ? mergeDecisions(prev.decisions, f.decisions, now) : prev.decisions,
            mergeOrder: has('mergeOrder') ? cleanMergeOrder(f.mergeOrder) : prev.mergeOrder,
        };
        return this._touch(o);
    }

    /**
     * Record that the user answered one of the brief's decisions. Delivery is not
     * this: the answer reaches the orchestrator as an ordinary message, and this
     * is what lets every window show the question as answered until the
     * orchestrator rewrites its brief without it. Null when there is no such
     * decision any more.
     */
    answerDecision(sessionId, decisionIdArg, text) {
        const o = this.byId.get(sessionId);
        const d = o && o.summary && o.summary.decisions.find(x => x.id === decisionIdArg);
        if (!d) return null;
        d.answer = String(text || '').trim().slice(0, MAX_ANSWER) || null;
        d.answeredAt = d.answer ? Date.now() : null;
        this._touch(o);
        return d;
    }

    /** Pin where an orchestrator resumes — see cleanCwdOverride. Null clears it. */
    setCwdOverride(sessionId, override) {
        const o = this.byId.get(sessionId);
        if (!o) return null;
        o.cwdOverride = override ? cleanCwdOverride({ at: Date.now(), ...override }) : null;
        return this._touch(o);
    }

    /** Queue a move for the end of the turn — see cleanPendingMove. Null clears it. */
    setPendingMove(sessionId, move) {
        const o = this.byId.get(sessionId);
        if (!o) return null;
        o.pendingMove = move ? cleanPendingMove({ at: Date.now(), ...move }) : null;
        return this._touch(o);
    }

    /** The move waiting for this orchestrator's turn to end, or null. */
    pendingMove(sessionId) {
        const o = this.byId.get(sessionId);
        return (o && o.pendingMove) || null;
    }

    /**
     * The directory override that applies to this session now, or null. Only an
     * orchestrator has one; `meta` is what decides whether a later EnterWorktree
     * has superseded it (liveCwdOverride).
     */
    cwdOverride(sessionId, meta) {
        const o = this.byId.get(sessionId);
        return o ? liveCwdOverride(o.cwdOverride, meta) : null;
    }

    setPaused(sessionId, paused) {
        const o = this.byId.get(sessionId);
        if (!o) return null;
        o.paused = paused ? cleanPaused(paused, Date.now()) : null;
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
        this._staleAsks(this.byId.get(orchId), workerId);
        this._touch(this.byId.get(orchId));
        return w;
    }

    /**
     * A closed or removed worker's open asks are gone with it. Trimming never
     * drops an ask still waiting, so without this they would be "waiting"
     * forever and the inbox would grow past its cap for the life of the
     * orchestrator.
     */
    _staleAsks(o, workerId) {
        for (const i of o.inbox) {
            if (i.workerId === workerId && i.requestId && (i.status === 'new' || i.status === 'read')) {
                i.status = 'stale';
                i.outcome = 'worker-closed';
            }
        }
    }

    /** Take a worker off the list altogether — for a session that was deleted. */
    removeWorker(orchId, workerId) {
        const o = this.byId.get(orchId);
        if (!o) return false;
        const before = o.workers.length;
        o.workers = o.workers.filter(w => w.id !== workerId);
        if (o.workers.length === before) return false;
        this.workerOf.delete(workerId);
        this._staleAsks(o, workerId);
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
        // Drop the oldest settled items first; never one still waiting — and a
        // plan or prompt the orchestrator has *read* but not answered is still
        // waiting: dropping it would leave a worker blocked on an ask nobody can
        // name any more. Past the cap with nothing settled, the inbox grows.
        // An open task is the only copy of what the user wrote, so it is held
        // like an unanswered ask.
        const settled = (x) => x.status === 'resolved' || x.status === 'stale'
            || (x.status === 'read' && !x.requestId && x.kind !== 'task');
        while (o.inbox.length > MAX_INBOX) {
            const i = o.inbox.findIndex(settled);
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
        i.settledAt = Date.now();
        this._touch(this.byId.get(orchId));
        return i;
    }

    /**
     * Put a settled item back to `read` — a task whose spawn was accepted and
     * then failed (a worktree that could not be made), so it is not lost.
     */
    reopen(orchId, itemId) {
        const i = this.item(orchId, itemId);
        if (!i) return null;
        i.status = 'read';
        i.outcome = null;
        i.by = null;
        i.settledAt = null;
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

    /** Tasks handed over and not yet started, taken back or gone; oldest first. */
    openTasks(orchId) {
        const o = this.byId.get(orchId);
        return o ? o.inbox.filter(isOpenTask) : [];
    }

    /**
     * File a task. Throws a refusal at the cap, and when the payload is not one
     * (no prompt, no directory) — the route validates first, so that is a bug
     * rather than a user's mistake, but a silent null would lose their words.
     */
    pushTask(orchId, task) {
        if (!this.byId.has(orchId)) return null;
        const t = cleanTask(task);
        if (!t) throw refusal('a task needs a prompt and a directory');
        if (this.openTasks(orchId).length >= MAX_OPEN_TASKS) {
            throw refusal(`this orchestrator already has ${MAX_OPEN_TASKS} tasks it has not started — `
                + 'wait for it to pick some up, or take some back');
        }
        return this.push(orchId, { kind: 'task', text: t.prompt.slice(0, MAX_TEXT), task: t });
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
    usageTrips, resumeAtFor, decisionId, cleanMergeOrder, cleanTask, spawnOptsFromTask, isOpenTask,
    liveCwdOverride,
    DEFAULT_SETTINGS, REPORT_KINDS, KINDS, WINDOWS, STOP_WINDOWS, MAX_SUMMARY, MAX_DECISIONS,
    MAX_OPEN_TASKS,
};
