'use strict';

// Orchestrator sessions, in motion: the half of the feature that acts. The store
// — who is an orchestrator, who works for whom, what is in the inbox — is
// bridge/orchestrators.js, and is deliberately inert; this is what moves things
// between it and the runner pool.
//
// Five jobs, each small:
//
//   **Roles at spawn.** `roleOf` tells a starting `claude` whether it is an
//   orchestrator or a worker, which decides the MCP tools it lists and the
//   brief appended to its system prompt (with the user's addendum from
//   Settings). See RunnerPool#recycle for why a role change waits for a restart.
//
//   **Filing.** A worker's turn ending, a worker's report, and a worker's ask —
//   a plan, a question, a permission prompt — become inbox items instead of
//   reaching the orchestrator's conversation. A worker's asks are *also* still
//   pending on its runner exactly as before, so a window can answer them too;
//   the first answer wins, as between two windows.
//
//   **Nudging.** The one thing that does reach the orchestrator's conversation:
//   a single line saying how many items are waiting, sent only while it is idle
//   (`shouldNudge`), debounced so a burst of reports is one nudge, and not again
//   until something newer arrives. Never mid-turn, which is the whole point.
//
//   **The cap.** At most `maxRunning` workers mid-turn at once. A spawn over it
//   is queued and started when a worker's turn ends.
//
//   **The cutoff.** Past a usage threshold every busy worker and the
//   orchestrator itself are soft-stopped, and the orchestrator is paused — no
//   nudges, no spawns — until somebody presses Resume. Usage is account-wide,
//   and an orchestrator is the one thing in this app that can spend it with
//   nobody watching.
//
// **Only this bridge's pool is acted on.** The store is shared with every other
// bridge on the machine; a dev bridge's orchestrator is in the everyday
// bridge's file too. Nothing here starts or stops a session unless the event
// came from this pool or the runner is in it.

const { randomUUID } = require('crypto');

const cfg = require('./config');
const { broadcast } = require('./events');
const { resolveWorkdir } = require('./runner');
const { createWorktree } = require('./worktree');
const { shouldNudge, usageTrip, describeCounts, cleanSettings, DEFAULT_SETTINGS } = require('./orchestrators');
const workerRead = require('./worker-read');

// Handed over by server.js.
let store = null;
let pool = null;
let index = null;
let flags = null;
let prefs = null;
let usage = null;
let normalizeMode = null;
let sessionCwd = null;
let tooManyCreates = null;

const NUDGE_DEBOUNCE_MS = 2000;
const nudgeTimers = new Map();
// Request ids an orchestrator answered through `answer_worker`, so the resolve
// that follows can say who answered it.
const answeredByOrchestrator = new Set();

function init(deps) {
    ({ store, pool, index, flags, prefs, usage, normalizeMode, sessionCwd, tooManyCreates } = deps);
    pool.roleOf = roleOf;
    pool.delegateFor = (id) => store.roleOf(id) === 'worker';
}

function userPrefs() {
    try { return prefs.forCwd().orchestrator || {}; } catch { return {}; }
}

/** The settings a new orchestrator starts with: the user's defaults from Settings. */
function defaultSettings() {
    const p = userPrefs();
    return cleanSettings({
        maxRunning: p.maxRunning,
        worktree: p.worktree,
        usageStop: { enabled: p.usageStopEnabled, percent: p.usageStopPercent, window: p.usageStopWindow },
    }, DEFAULT_SETTINGS);
}

// ---------------------------------------------------------------------------
// Roles and briefs
// ---------------------------------------------------------------------------

function orchestratorBrief(id) {
    const add = String(userPrefs().addendum || '').trim();
    return [
        '# You are an orchestrator',
        '',
        `You are an orchestrator session in TGXCode (session id ${id}). You coordinate`,
        'worker sessions rather than doing the work yourself: break the task down, start',
        'workers with spawn_worker (each gets its own git worktree by default), and steer',
        'them to done.',
        '',
        'Workers do not talk to you directly. Everything they produce — reports, plans',
        'waiting for approval, permission prompts, questions, and the final message of',
        'each turn they finish — goes into your inbox. TGXCode tells you when items are',
        'waiting with a one-line message, only while you are idle. Then call next_message',
        '(pass max to take several), deal with each item, and end your turn. Do not poll',
        'in a loop: when nothing is waiting, finish your turn and you will be told.',
        '',
        '- Items of kind plan, permission and ask mean a worker is blocked until somebody',
        '  answers. Answer them with answer_worker. Approve a plan only if it does what you',
        '  asked; deny with feedback to send it back. The user may answer one first — you',
        '  will be told.',
        '- send_to_worker gives a worker more instructions or an answer to its question.',
        '- read_worker shows a worker\'s transcript. Start with mode digest; use tail or',
        '  full only when you need detail, and ask to have the worker summarise itself.',
        '- At most a few workers run at once; extra spawns are queued, not refused.',
        '- get_usage shows the account\'s quota. If it passes the configured cutoff,',
        '  TGXCode stops everything and waits for the user.',
        '- close_worker when a worker is finished with, so it stops counting.',
        '',
        'Keep a summary for the user with set_summary: one or two short paragraphs on',
        'what has been done, what is in flight, and anything waiting on them. Rewrite it',
        'after each batch of inbox items you handle and whenever you spawn or close a',
        'worker. It is shown pinned beneath your conversation, and it is what the user',
        'reads to catch up — keep it current rather than complete.',
        ...(add ? ['', '## From the user', '', add] : []),
    ].join('\n');
}

function workerBrief(orchId) {
    const add = String(userPrefs().workerAddendum || '').trim();
    return [
        '# You are a worker',
        '',
        `You were started by an orchestrator session (${orchId}) in TGXCode, which`,
        'hands you work and reads what you report. It is a model, not the user.',
        '',
        '- The final message of every turn you finish is forwarded to it automatically,',
        '  so end each turn by saying plainly where things stand.',
        '- report_to_orchestrator files something in its inbox: kind "question" when you',
        '  are blocked on a decision (then end your turn — the answer comes as a message),',
        '  "update" for progress worth knowing mid-turn, "done" when the work is finished,',
        '  with what you did and where it is (branch, PR).',
        '- Your plans and permission prompts go to the orchestrator for approval.',
        '- Messages from it arrive wrapped in <orchestrator-message>.',
        ...(add ? ['', '## From the user', '', add] : []),
    ].join('\n');
}

function roleOf(sessionId) {
    const role = store.roleOf(sessionId);
    if (role === 'orchestrator') return { role, brief: orchestratorBrief(sessionId) };
    if (role === 'worker') return { role, brief: workerBrief(store.orchestratorOf(sessionId).id) };
    return null;
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

function workerRow(w) {
    const r = pool.get(w.id);
    const st = r ? r.status() : null;
    const s = index.summary(w.id);
    return {
        id: w.id,
        title: (s && s.title) || w.title,
        cwd: w.cwd,
        worktree: w.worktree,
        spawnedAt: w.spawnedAt,
        closedAt: w.closedAt,
        state: st ? st.state : 'stopped',
        pending: st && st.pendingPermission ? st.pendingPermission.kind : null,
    };
}

/** Everything a client draws an orchestrator from. Also the `orchestrator` event. */
function payload(id) {
    const o = store.get(id);
    if (!o) return { orchestratorId: id, enabled: false };
    const inbox = o.inbox.slice(-100).reverse();
    return {
        orchestratorId: id,
        enabled: true,
        settings: o.settings,
        paused: o.paused,
        summary: o.summary,
        workers: o.workers.map(workerRow),
        pendingSpawns: o.pendingSpawns.map(p => ({ id: p.id, title: p.title, at: p.at })),
        unread: o.inbox.filter(i => i.status === 'new').length,
        inbox,
    };
}

// A burst of filings — six workers finishing at once — is one broadcast per
// orchestrator and one `sessions-changed`, not one each: that event makes every
// window and phone refetch the whole session list.
const EMIT_DEBOUNCE_MS = 250;
const emitTimers = new Map();
let listTimer = null;

function emit(id) {
    if (emitTimers.has(id)) return;
    const t = setTimeout(() => {
        emitTimers.delete(id);
        broadcast('orchestrator', payload(id));
    }, EMIT_DEBOUNCE_MS);
    t.unref();
    emitTimers.set(id, t);
    if (!listTimer) {
        listTimer = setTimeout(() => {
            listTimer = null;
            broadcast('sessions-changed', { at: Date.now() });
        }, EMIT_DEBOUNCE_MS);
        listTimer.unref();
    }
}

// ---------------------------------------------------------------------------
// Nudging
// ---------------------------------------------------------------------------

function scheduleNudge(orchId) {
    if (!store.get(orchId) || nudgeTimers.has(orchId)) return;
    const t = setTimeout(() => { nudgeTimers.delete(orchId); nudge(orchId); }, NUDGE_DEBOUNCE_MS);
    t.unref();
    nudgeTimers.set(orchId, t);
}

function nudge(orchId) {
    const o = store.get(orchId);
    const r = pool.get(orchId);
    if (!shouldNudge(o, r ? r.status() : null)) return false;
    const summary = index.summary(orchId);
    if (!summary) return false;
    const unread = store.unread(orchId);
    const text = [
        `<orchestrator-inbox count="${unread.length}">`,
        `${unread.length} item${unread.length === 1 ? '' : 's'} waiting in your inbox `
            + `(${describeCounts(unread)}). Call next_message to read them.`,
        '</orchestrator-inbox>',
    ].join('\n');
    const runner = r || pool.ensure(orchId, {
        cwd: sessionCwd(summary), permissionMode: normalizeMode(summary.permissionMode),
    });
    runner.send(text);
    store.noteNudged(orchId, Math.max(...unread.map(i => i.seq)));
    return true;
}

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

function file(orchId, item) {
    const row = store.push(orchId, item);
    if (!row) return null;
    emit(orchId);
    scheduleNudge(orchId);
    return row;
}

/** A worker's report, from `report_to_orchestrator`. */
function report(workerId, kind, text) {
    const o = store.orchestratorOf(workerId);
    if (!o) return null;
    if (kind === 'done') store.noteDone(workerId, true);
    return file(o.id, { workerId, kind, text });
}

function askText(p) {
    const input = p.input || {};
    if (p.kind === 'plan') return String(input.plan || '');
    if (p.kind === 'question') {
        return (input.questions || []).map((q) => {
            const opts = (q.options || []).map(o => `  - ${o.label}${o.description ? `: ${o.description}` : ''}`);
            return [`${q.question}${q.multiSelect ? ' (pick any)' : ''}`, ...opts].join('\n');
        }).join('\n\n');
    }
    const detail = p.description || (input.command ? `$ ${input.command}` : JSON.stringify(input).slice(0, 2000));
    return `${p.displayName || p.tool}: ${detail}`;
}

function onPermissionRequest(p) {
    const o = store.orchestratorOf(p.sessionId);
    if (!o) return;
    file(o.id, {
        workerId: p.sessionId,
        kind: p.kind === 'plan' ? 'plan' : p.kind === 'question' ? 'ask' : 'permission',
        text: askText(p),
        requestId: p.requestId,
        ask: { kind: p.kind, tool: p.tool, displayName: p.displayName, input: p.input },
    });
}

const STALE_OUTCOMES = new Set(['superseded', 'abandoned', 'stopped', 'auto-denied']);

function onPermissionResolved(p) {
    const o = store.orchestratorOf(p.sessionId);
    if (!o) return;
    const item = store.byRequest(p.sessionId, p.requestId);
    if (!item || item.status === 'resolved' || item.status === 'stale') {
        answeredByOrchestrator.delete(p.requestId);
        return;
    }
    const byOrch = answeredByOrchestrator.delete(p.requestId);
    const wasRead = item.status === 'read';
    store.settle(o.id, item.id, {
        status: STALE_OUTCOMES.has(p.outcome) ? 'stale' : 'resolved',
        outcome: p.outcome, by: byOrch ? 'orchestrator' : 'user',
    });
    // The orchestrator has seen this one and may be about to answer it; tell it
    // somebody else did. An unread one just leaves the inbox quietly.
    if (!byOrch && wasRead && !STALE_OUTCOMES.has(p.outcome)) {
        const w = store.worker(o.id, p.sessionId);
        file(o.id, {
            workerId: p.sessionId, kind: 'note',
            text: `The user answered ${w && w.title ? `"${w.title}"` : 'a worker'}'s ${item.kind} `
                + `(${p.outcome}) before you did — there is nothing left to answer there.`,
        });
    } else {
        emit(o.id);
    }
}

function onTurnComplete(res) {
    const id = res.sessionId;
    if (store.get(id)) {
        checkUsage();
        scheduleNudge(id);
        return;
    }
    const o = store.orchestratorOf(id);
    if (!o) return;
    const w = store.worker(o.id, id);
    if (w && !w.closedAt) {
        if (w.reportedDone) {
            store.noteDone(id, false);
            emit(o.id);
        } else {
            const r = pool.get(id);
            const text = (r && r.lastResultText) || '(the turn ended without a final message)';
            file(o.id, { workerId: id, kind: 'turn', text: res.isError ? `[ended with an error] ${text}` : text });
        }
    }
    drainSpawns(o.id);
    checkUsage();
}

/** The orchestrator going idle by any route — a stop, an answered ask — is a chance to nudge. */
function onStatus(s) {
    if (!s || !s.sessionId) return;
    if (store.get(s.sessionId) && s.state === 'idle') scheduleNudge(s.sessionId);
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

// Starts in progress, per orchestrator. A worker has no runner — and so does
// not count as running — until its worktree exists, which is an await; without
// these a drain or a batch of parallel spawn_worker calls all saw the same
// headroom and started every one of them.
const starting = new Map();

function reserve(orchId) {
    starting.set(orchId, (starting.get(orchId) || 0) + 1);
}

function release(orchId) {
    const n = (starting.get(orchId) || 1) - 1;
    if (n > 0) starting.set(orchId, n);
    else starting.delete(orchId);
}

function running(orchId) {
    return (starting.get(orchId) || 0) + store.openWorkers(orchId).filter((w) => {
        const r = pool.get(w.id);
        return r && (r.state === 'busy' || r.state === 'starting');
    }).length;
}

function slug(s) {
    return String(s || 'worker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'worker';
}

function refuse(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

/**
 * Start a worker, or queue it when the cap is reached. `opts` is what
 * `spawn_worker` takes: {prompt, title, cwd, worktree, permissionMode, model, effort}.
 */
async function spawn(orchId, opts) {
    const o = store.get(orchId);
    if (!o) throw refuse(404, 'that session is not an orchestrator');
    if (o.paused) {
        throw refuse(409, `this orchestrator is paused (${o.paused.reason}) — nothing new starts `
            + 'until the user resumes it');
    }
    if (!opts.prompt || !String(opts.prompt).trim()) throw refuse(400, 'prompt is required');
    if (running(orchId) >= o.settings.maxRunning) {
        const row = store.queueSpawn(orchId, { prompt: String(opts.prompt), title: opts.title || null, opts });
        emit(orchId);
        return { queued: true, id: row.id, position: store.get(orchId).pendingSpawns.length,
            running: running(orchId), maxRunning: o.settings.maxRunning };
    }
    // Reserved before the first await, so the next caller sees this slot taken.
    reserve(orchId);
    return { queued: false, ...(await startWorker(orchId, opts)) };
}

/** Start one worker. The caller has reserved its slot; this releases it. */
async function startWorker(orchId, opts) {
    try {
        return await launch(orchId, opts);
    } finally {
        release(orchId);
    }
}

async function launch(orchId, opts) {
    const o = store.get(orchId);
    const summary = index.summary(orchId);
    const base = opts.cwd || (summary ? sessionCwd(summary) : null);
    if (!base) throw refuse(400, 'cwd is required — the orchestrator\'s own directory is not known yet');
    if (tooManyCreates()) throw refuse(429, 'too many sessions started in the last minute — try again shortly');

    const title = String(opts.title || '').trim() || String(opts.prompt).split('\n')[0].slice(0, 60);
    const sessionId = randomUUID();
    const wantTree = opts.worktree === undefined || opts.worktree === null
        ? o.settings.worktree : opts.worktree !== false;

    let worktree = null;
    let startIn = base;
    if (wantTree) {
        const repo = resolveWorkdir(base);
        const name = typeof opts.worktree === 'string' && opts.worktree.trim()
            ? opts.worktree.trim() : `${slug(title)}-${sessionId.slice(0, 6)}`;
        try {
            const wt = await createWorktree(repo, name, undefined, { allow: (p) => cfg.withinRoots(p) });
            worktree = { path: wt.path, branch: wt.branch };
            startIn = wt.path;
        } catch (err) {
            throw refuse(err.code === 'worktree-exists' ? 409 : 400,
                `could not make a worktree: ${err.message}. Pass worktree: false to start in ${base} instead.`);
        }
    }

    // Filed before the spawn: the role is read off the store as `claude` starts.
    store.addWorker(orchId, { id: sessionId, title, cwd: startIn, worktree });
    try {
        pool.create({
            sessionId, cwd: startIn, prompt: String(opts.prompt),
            model: opts.model || null, effort: opts.effort || null,
            permissionMode: normalizeMode(opts.permissionMode || 'auto'),
        });
    } catch (err) {
        store.closeWorker(orchId, sessionId);
        throw refuse(400, err.message);
    }
    const parentFlags = flags.get(orchId);
    flags.set(sessionId, { title, ...(parentFlags.test ? { test: true } : {}) });
    index.note(sessionId);
    emit(orchId);
    return { sessionId, title, cwd: startIn, worktree };
}

function drainSpawns(orchId) {
    const o = store.get(orchId);
    if (!o || o.paused) return;
    while (o.pendingSpawns.length && running(orchId) < o.settings.maxRunning) {
        const next = store.takeSpawn(orchId);
        reserve(orchId);
        startWorker(orchId, { ...next.opts, prompt: next.prompt, title: next.title }).catch((err) => {
            file(orchId, { kind: 'note', text: `A queued worker "${next.title || 'untitled'}" could `
                + `not be started: ${err.message}` });
        });
    }
}

function ownWorker(orchId, workerId) {
    if (!store.get(orchId)) throw refuse(404, 'that session is not an orchestrator');
    const w = store.worker(orchId, workerId);
    if (!w) throw refuse(404, 'no worker with that id belongs to this orchestrator — see list_workers');
    return w;
}

function runnerFor(w) {
    const r = pool.get(w.id);
    if (r) return r;
    const s = index.summary(w.id);
    return pool.ensure(w.id, {
        cwd: s ? sessionCwd(s) : w.cwd,
        permissionMode: normalizeMode(s ? s.permissionMode : 'auto'),
    });
}

function envelope(orchId, text) {
    const s = index.summary(orchId);
    const title = s && s.title ? ` from-title="${String(s.title).replace(/["<>]/g, '')}"` : '';
    return `<orchestrator-message from="${orchId}"${title}>\n${String(text).trim()}\n</orchestrator-message>`;
}

function sendTo(orchId, workerId, text) {
    const w = ownWorker(orchId, workerId);
    if (w.closedAt) throw refuse(409, 'that worker is closed');
    if (!String(text || '').trim()) throw refuse(400, 'text is required');
    const r = runnerFor(w);
    const entry = r.send(envelope(orchId, text));
    const st = r.status();
    return { ok: true, queued: st.queue.some(q => q.id === entry.id), state: st.state };
}

const ASK_PROMPT = 'Your orchestrator asks for a summary of where you are: in 200 words or fewer, '
    + 'what you have done, what is left, and anything you are blocked on. Reply with that and '
    + 'nothing else — do not carry on with the work in this turn.';

async function read(orchId, workerId, { mode = 'digest', turns, offset } = {}) {
    const w = ownWorker(orchId, workerId);
    if (mode === 'ask') {
        sendTo(orchId, workerId, ASK_PROMPT);
        return { text: 'Asked. The worker\'s summary will arrive in your inbox as its next turn report.' };
    }
    const rec = index.get(workerId);
    if (!rec || !rec.file) {
        return { text: 'That worker has no transcript yet — it may still be starting. Try again in a few seconds.' };
    }
    if (mode === 'tail') return workerRead.tail(rec.file, Number(turns) || 3);
    if (mode === 'full') return workerRead.full(rec.file, Number(offset) || 0);
    const r = pool.get(workerId);
    const s = index.summary(workerId);
    return workerRead.digest(rec.file, {
        cwd: (s && s.cwd) || w.cwd, status: r ? r.status() : null, lastResult: r ? r.lastResultText : null,
    });
}

function answer(orchId, itemId, decision, extra = {}) {
    if (!store.get(orchId)) throw refuse(404, 'that session is not an orchestrator');
    const item = store.item(orchId, itemId);
    if (!item) throw refuse(404, 'no inbox item with that id');
    if (!item.requestId) throw refuse(400, `a ${item.kind} item has nothing to answer — use send_to_worker`);
    if (item.status === 'resolved' || item.status === 'stale') {
        throw refuse(409, `already ${item.status}${item.by ? ` by the ${item.by}` : ''}`
            + `${item.outcome ? ` (${item.outcome})` : ''}`);
    }
    const r = pool.get(item.workerId);
    const pending = r && r.pendingPermission;
    if (!pending || pending.id !== item.requestId) {
        store.settle(orchId, itemId, { status: 'stale', outcome: 'gone' });
        emit(orchId);
        throw refuse(409, 'that worker is no longer waiting on this — it was answered, stopped or restarted');
    }
    // A plan approved without a mode would leave the worker in plan mode, where
    // the work it was just told to do is refused.
    const mode = extra.mode || (item.kind === 'plan' && decision !== 'deny' ? 'auto' : null);
    answeredByOrchestrator.add(item.requestId);
    const out = r.answerPermission(item.requestId, decision === 'allow-always' ? 'allow-always' : decision, {
        answers: extra.answers || null, feedback: extra.feedback || '', mode,
        updatedInput: null,
    });
    if (!out.ok) {
        answeredByOrchestrator.delete(item.requestId);
        throw refuse(409, out.error);
    }
    return { ok: true };
}

/**
 * Stop a session's turn on the bridge's own initiative. Whatever was queued on
 * it — a chip the user typed, an instruction the orchestrator sent — goes back
 * as a `send-failed` with its text, the way the Stop button hands it to the
 * composer, rather than vanishing with `stop()`'s return value.
 */
function stopKeeping(r, why, opts = {}) {
    r.handOverQueue(why);
    return r.stop(opts);
}

async function stopWorker(orchId, workerId, { hard = false } = {}) {
    const w = ownWorker(orchId, workerId);
    const r = pool.get(w.id);
    if (!r) return { ok: true, how: null };
    const out = await stopKeeping(r, 'Its orchestrator stopped this session before these were sent.', { hard });
    return { ok: true, how: out.how };
}

async function closeWorker(orchId, workerId, { archive = true } = {}) {
    const w = ownWorker(orchId, workerId);
    const r = pool.get(w.id);
    if (r && r.state === 'busy') {
        await stopKeeping(r, 'Its orchestrator closed this session before these were sent.');
    }
    store.closeWorker(orchId, workerId);
    if (archive) flags.set(workerId, { archived: true });
    emit(orchId);
    drainSpawns(orchId);
    return { ok: true, worktree: w.worktree };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function windows() {
    try { return usage.snapshot().windows || []; } catch { return []; }
}

function usageFor(orchId) {
    const o = store.get(orchId);
    return {
        windows: windows().map(w => ({ type: w.type, usedPercent: w.usedPercent, usedPercentAt: w.usedPercentAt,
            resetsAt: w.resetsAt, status: w.status })),
        cutoff: o ? o.settings.usageStop : null,
        paused: o ? o.paused : null,
    };
}

/** Does this bridge run anything of this orchestrator's? */
function ours(o) {
    return !!pool.get(o.id) || o.workers.some(w => pool.get(w.id));
}

function checkUsage() {
    const ws = windows();
    for (const o of store.byId.values()) {
        if (o.paused || !ours(o)) continue;
        const trip = usageTrip(o.settings, ws);
        if (trip) pause(o.id, tripReason(trip));
    }
}

function tripReason(trip) {
    return `${trip.window.replace(/_/g, '-')} usage at ${Math.round(trip.usedPercent)}%, `
        + `past the ${trip.percent}% cutoff`;
}

function pause(orchId, reason) {
    store.setPaused(orchId, { reason });
    const o = store.get(orchId);
    for (const id of [orchId, ...o.workers.filter(w => !w.closedAt).map(w => w.id)]) {
        const r = pool.get(id);
        if (r && r.state === 'busy') {
            stopKeeping(r, 'The usage cutoff stopped this session before these were sent.')
                .catch(() => { /* already gone */ });
        }
    }
    broadcast('notice', { sessionId: orchId, level: 'warn', kind: 'orchestrator_paused',
        text: `Orchestrator paused: ${reason}. Every running worker was stopped. Resume it when you are ready.` });
    emit(orchId);
}

function resume(orchId) {
    const o = store.get(orchId);
    if (!o) throw refuse(404, 'that session is not an orchestrator');
    // Resuming while still over the line would start the queued workers and
    // nudge the orchestrator, only for the next reading to stop them again a
    // minute later — turns spent on work that is cut off before it gets anywhere.
    const trip = usageTrip(o.settings, windows());
    if (trip) {
        throw refuse(409, `still over the cutoff (${tripReason(trip)}). Raise or turn off `
            + 'the cutoff in this orchestrator\u2019s settings, or wait for the window to reset.');
    }
    store.setPaused(orchId, null);
    emit(orchId);
    drainSpawns(orchId);
    scheduleNudge(orchId);
    return payload(orchId);
}

// ---------------------------------------------------------------------------
// Turning it on and off
// ---------------------------------------------------------------------------

function enable(sessionId, settings) {
    const base = defaultSettings();
    store.enable(sessionId, { settings: settings ? cleanSettings(settings, base) : base });
    const now = pool.recycle(sessionId);
    emit(sessionId);
    return { ...payload(sessionId), restarted: now ? 'now' : 'after-turn' };
}

/**
 * Deny whatever this orchestrator's workers are blocked on, where no window is
 * open to answer it instead. Called as the orchestrator goes away: delegation
 * was the only thing keeping the no-window auto-deny off those asks, and one
 * already held never passes that check again — so without this the worker
 * waits, silently, until somebody happens to open its page.
 */
function releaseAsks(orchId) {
    for (const w of store.openWorkers(orchId)) {
        const r = pool.get(w.id);
        if (r && r.pendingPermission && !r.hasViewer()) {
            r.denyPending('Its orchestrator went away before answering, and no TGXCode window was '
                + 'open to answer instead, so this was denied.');
        }
    }
}

function disable(sessionId) {
    releaseAsks(sessionId);
    store.disable(sessionId);
    pool.recycle(sessionId);
    emit(sessionId);
    return payload(sessionId);
}

/**
 * A session deleted. An orchestrator stops being one; a worker leaves its
 * orchestrator's list. Its inbox items stay — what it said still happened.
 */
function forget(sessionId) {
    if (store.get(sessionId)) {
        releaseAsks(sessionId);
        store.disable(sessionId);
        return;
    }
    const o = store.orchestratorOf(sessionId);
    if (o && store.removeWorker(o.id, sessionId)) emit(o.id);
}

function setSummary(orchId, text) {
    if (!store.setSummary(orchId, text)) throw refuse(404, 'that session is not an orchestrator');
    emit(orchId);
    return store.get(orchId).summary;
}

module.exports = {
    init, payload, roleOf, enable, disable, spawn, sendTo, read, answer, stopWorker, closeWorker,
    report, resume, usageFor, setSummary, checkUsage, forget, nudge, scheduleNudge, emit, defaultSettings,
    onPermissionRequest, onPermissionResolved, onTurnComplete, onStatus,
};
