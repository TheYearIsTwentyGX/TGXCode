// What the orchestrator page draws, worked out from the bridge's `orchestrator`
// payload — web/orchestrator-page.js draws it.
//
// Pure, and with no imports, so test/orchestrator-view.test.js and
// test/orchestrator-page.test.js can load it in node the way
// test/pr-owners.test.js loads web/pr-resolve.js. The first half is the
// per-worker reading (state, what it is blocked on, its timeline); the second,
// from `STAGES` down, is what the page lays out from it.
//
// Everything the page says about a worker beyond its own row is read out of the inbox:
// the plan it filed, whether that was approved, the last thing it reported. The
// inbox is a lossy record of that — the payload carries the newest 100 items,
// and the store drops settled ones first once it is full — so a step this
// cannot find is `unknown`, never quietly `todo`. A worker that has a PR or has
// said it is done plainly got past its plan, whether or not the plan is still
// on file, and the timeline says so rather than drawing a gap.

import { toolDisplayName } from './tool-name.js';

/** The inbox kinds that are a worker asking, and the runner's word for each. */
const ASK_KINDS = { plan: 'plan', permission: 'tool', ask: 'question' };

/** What a worker last said, in the kinds a person reads as "where it is". */
const REPORT_KINDS = new Set(['update', 'done', 'turn', 'question']);

/** Plan outcomes that let the worker carry on. */
const APPROVED = new Set(['allow', 'allow-always', 'plan-approved', 'plan-approved-note']);

const mine = (inbox, id) => (inbox || []).filter(i => i && i.workerId === id);
const settled = (i) => i.status === 'resolved' || i.status === 'stale';

/**
 * One word for where a worker is: `running`, `idle`, `stopped`, `closed`, or
 * `error`. `starting` counts as running — it holds a slot under the cap.
 */
export function workerStateWord(w) {
    if (!w) return 'stopped';
    if (w.closedAt) return 'closed';
    if (w.state === 'busy' || w.state === 'starting') return 'running';
    if (w.state === 'idle' || w.state === 'error') return w.state;
    return 'stopped';
}

/**
 * What the worker is waiting on, if anything.
 *
 * The inbox item when there is one — it carries the `requestId` an answer needs
 * and the plan text — and otherwise just the kind the runner reports, so the page
 * can still say "waiting on a plan" and offer to open the session. Only an item
 * that matches what the runner is waiting on now counts: an older plan the
 * orchestrator never settled is not what the worker is stuck on.
 *
 * @returns {null | {kind: 'plan'|'tool'|'question', item: object|null}}
 */
export function blockedOn(w, inbox) {
    if (!w || w.closedAt || !w.pending) return null;
    const item = mine(inbox, w.id).find(i => ASK_KINDS[i.kind] === w.pending
        && i.requestId && !settled(i)) || null;
    return { kind: w.pending, item };
}

/** The newest report-like item for a worker, or null. Inbox is newest first. */
export function lastReport(w, inbox) {
    if (!w) return null;
    return mine(inbox, w.id).find(i => REPORT_KINDS.has(i.kind)) || null;
}

/**
 * The worker's road so far: spawned → plan → approved → done → PR.
 *
 * Each step is `{key, at, state}`, with `state` one of:
 *   done     happened (`at` when it is known)
 *   now      what it is on — the plan waiting, or approved and working
 *   todo     not reached yet
 *   skipped  went past it without it happening — no plan, straight to work
 *   unknown  it must have happened, or may have, but the inbox no longer says
 *
 * @param {object} w a payload worker row
 * @param {object[]} inbox the payload's inbox, newest first
 */
export function workerTimeline(w, inbox) {
    const items = mine(inbox, w.id);
    // Oldest plan first: the road starts at the first one, and the newest says
    // whether the worker has been let through yet.
    const plans = items.filter(i => i.kind === 'plan');
    const firstPlan = plans[plans.length - 1] || null;
    const lastPlan = plans[0] || null;
    // Only the newest plan says whether the worker is through: an older plan
    // that was approved does not cover a second one filed since, and a plan sent
    // back is not an approval however many came before it.
    const approved = lastPlan && settled(lastPlan) && APPROVED.has(lastPlan.outcome) ? lastPlan : null;
    const doneItem = items.find(i => i.kind === 'done') || null;
    const pr = w.pr || null;
    const finished = !!doneItem || !!pr || !!w.closedAt;
    const planWaiting = w.pending === 'plan' || (lastPlan && !settled(lastPlan) && !approved);

    const steps = [{ key: 'spawned', at: w.spawnedAt || null, state: 'done' }];

    // Plan and approval. With a plan on file this is plain. Without one, a
    // worker that got on with the work either never planned (`skipped`) or
    // planned so long ago the item is gone (`unknown`) — and only a worker
    // whose inbox has been trimmed past its own spawn could be the second.
    const trimmed = isTrimmed(inbox, w);
    if (firstPlan) {
        steps.push({ key: 'plan', at: firstPlan.at, state: 'done' });
        if (approved) steps.push({ key: 'approved', at: null, state: 'done' });
        else if (planWaiting) steps.push({ key: 'approved', at: null, state: 'now' });
        else steps.push({ key: 'approved', at: null, state: finished ? 'unknown' : 'todo' });
    } else if (w.pending === 'plan') {
        steps.push({ key: 'plan', at: null, state: 'now' });
        steps.push({ key: 'approved', at: null, state: 'todo' });
    } else {
        const gone = trimmed ? 'unknown' : 'skipped';
        steps.push({ key: 'plan', at: null, state: gone });
        steps.push({ key: 'approved', at: null, state: gone });
    }

    // `now` only while a turn is running: an idle worker between turns is
    // waiting on its orchestrator, not working towards done.
    const working = !planWaiting && !finished && workerStateWord(w) === 'running';
    steps.push({
        key: 'done',
        at: doneItem ? doneItem.at : w.closedAt || null,
        state: doneItem || w.closedAt ? 'done' : pr ? 'unknown' : working ? 'now' : 'todo',
    });
    steps.push({ key: 'pr', at: null, state: pr ? 'done' : 'todo' });
    return steps;
}

/**
 * Whether the inbox might be missing this worker's oldest items: it is full,
 * and its oldest item is younger than the worker. A short inbox has every item
 * the store still holds for it.
 */
function isTrimmed(inbox, w) {
    if (!inbox || inbox.length < 100) return false;
    const oldest = inbox[inbox.length - 1];
    return !!oldest && (oldest.at || 0) > (w.spawnedAt || 0);
}

// ---------------------------------------------------------------------------
// The orchestrator page — web/orchestrator-page.js draws these.
//
// The page answers "where are we, and what needs me?" for somebody coming back
// after an hour away, so every function here turns the payload into something
// that can be read at a glance: where each worker is on one track, what it is
// doing there in a few words, what is waiting on the user rather than on the
// orchestrator, and the PRs in the order they should land. What the bridge does
// not know (a worker's live activity, a PR's freshest status, the orchestrator's
// own state) is passed in from what the rest of the app already holds.
// ---------------------------------------------------------------------------

/** The page's track, left to right. */
export const STAGES = ['plan', 'approved', 'building', 'done', 'pr', 'merged'];

/** PR statuses that mean somebody has to do something before it can land. */
const PR_TROUBLE = new Set(['checks-failed', 'changes', 'conflicting']);

/** "12m", "3h", "2d" — the age of something, short enough for a row. */
export function shortAge(ms) {
    const m = Math.max(0, Math.floor((Number(ms) || 0) / 60_000));
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}

/** The brief's open decisions, or none. */
const decisionsOf = (p) => ((p && p.summary && p.summary.decisions) || []);

/** An unanswered decision the orchestrator filed about this worker, or null. */
export function openDecisionFor(p, workerId) {
    return decisionsOf(p).find(d => d.workerId === workerId && !d.answeredAt) || null;
}

/** A PR's status: the app's fresher reading when it has one, else the payload's. */
const prStatusOf = (w, fresh) => (fresh || (w.pr && w.pr.status) || 'unknown');

/**
 * Where a worker is on the page's track.
 *
 * `at` is the stage it is on, 1–6 (`STAGES`). `steps` says, per stage, `done`,
 * `skip` (went past without it — no plan in auto mode), `unknown` (it must have
 * happened, but the inbox no longer says), `now`, or `todo`. `tone` is the one
 * word the row is coloured by:
 *
 *   wait     stopped on an ask (a plan, a prompt, a question) — the
 *            orchestrator's to answer, and the user's if they get there first
 *   you      idle on a decision the orchestrator has put to the user
 *   error    the turn ended in an error
 *   run      working
 *   pr | fail | merged   finished, with a PR in that state
 *   done     closed without a PR
 *   idle | stopped       between turns, or with no process
 *
 * @param {object} w payload worker row
 * @param {object[]} inbox payload inbox, newest first
 * @param {{prStatus?: string, mode?: string, decision?: object|null}} [o]
 *   `prStatus` is the app's freshest word for its PR, `mode` its permission mode
 *   (a plan-mode worker with no plan filed yet is still planning), `decision`
 *   an open decision about it.
 */
export function workerStage(w, inbox, { prStatus = null, mode = null, decision = null } = {}) {
    const tl = Object.fromEntries(workerTimeline(w, inbox).map(s => [s.key, s.state]));
    const status = w.pr ? prStatusOf(w, prStatus) : null;
    const word = workerStateWord(w);
    const planFiled = tl.plan === 'done' || tl.plan === 'unknown';
    // In plan mode, a plan that was sent back leaves the worker planning again.
    const planningAgain = mode === 'plan' && tl.plan === 'done' && tl.approved === 'todo' && !w.closedAt;

    let at;
    if (w.pr && status === 'merged') at = 6;
    else if (w.pr) at = 5;
    else if (tl.done === 'done') at = 4;
    else if (tl.approved === 'now') at = 2;
    else if (tl.plan === 'now' || planningAgain || (mode === 'plan' && !planFiled && !w.closedAt)) at = 1;
    else at = 3;

    const passed = {
        plan: tl.plan === 'skipped' ? 'skip' : tl.plan === 'unknown' ? 'unknown' : 'done',
        approved: tl.approved === 'skipped' ? 'skip' : tl.approved === 'unknown' ? 'unknown'
            : tl.approved === 'todo' ? 'todo' : 'done',
        building: 'done',
        done: tl.done === 'unknown' || tl.done === 'todo' ? 'unknown' : 'done',
        pr: 'done',
        merged: 'done',
    };
    const steps = STAGES.map((k, i) => (i + 1 < at ? passed[k] : i + 1 === at ? 'now' : 'todo'));

    let tone;
    if (w.pending && !w.closedAt) tone = 'wait';
    else if (decision && !w.closedAt && word !== 'running') tone = 'you';
    else if (word === 'error') tone = 'error';
    else if (word === 'running') tone = 'run';
    else if (w.pr) tone = status === 'merged' ? 'merged' : PR_TROUBLE.has(status) ? 'fail' : 'pr';
    else if (w.closedAt) tone = 'done';
    else tone = word === 'idle' ? 'idle' : 'stopped';

    return { at, tone, steps, prStatus: status };
}

/**
 * What a worker's row says beside the stage it is on: `lead`, the part to read,
 * and `detail`, the quieter rest. Both may be null — a PR row's chip says it.
 *
 * @param {{runner?: {activity?, detail?}|null, now?: number, decision?: object|null}} [o]
 *   `runner` is the rail's copy of the worker's runner status.
 */
export function stageLine(w, stage, inbox, { runner = null, now = Date.now(), decision = null } = {}) {
    const b = blockedOn(w, inbox);
    // "now" reads as a time of day after "waiting"; under a minute is "<1m".
    const since = (at) => (at ? ` ${shortAge(now - at).replace(/^now$/, '<1m')}` : '');
    switch (stage.tone) {
        case 'wait': {
            const item = b && b.item;
            const what = b && b.kind === 'plan' ? 'Plan' : b && b.kind === 'tool' ? 'Permission' : 'Question';
            const reader = !item ? null : item.status === 'new' ? 'the orchestrator has not read it yet'
                : 'the orchestrator is on it';
            const tool = b && b.kind === 'tool' && item && item.ask ? toolDisplayName(item.ask.displayName || item.ask.tool) : null;
            return { lead: `${what} waiting${since(item && item.at)}`, detail: [tool, reader].filter(Boolean).join(' · ') || null };
        }
        case 'you':
            return { lead: 'Waiting on you', detail: decision ? `${clipText(decision.text, 60)}${since(decision.at)}` : null };
        case 'error':
            return { lead: 'Stopped with an error', detail: null };
        case 'run': {
            const doing = runner && (runner.detail || runner.activity);
            return { lead: doing ? clipText(String(doing).replace(/…$/, ''), 70) : 'Working', detail: null };
        }
        case 'idle': {
            const r = lastReport(w, inbox);
            return { lead: 'Idle', detail: r ? clipText(firstLineOf(r.text), 70) : null };
        }
        case 'done':
            return { lead: 'Closed', detail: null };
        case 'stopped':
            return { lead: 'Not running', detail: null };
        default:
            return { lead: null, detail: null };
    }
}

const firstLineOf = (t) => String(t || '').split('\n').map(s => s.trim()).find(Boolean) || '';
const clipText = (t, n) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/**
 * The progress strip and the counts beside it: one segment per task — every
 * worker in the order it was started, then the queued spawns — and how many are
 * finished, running against the cap, and queued.
 *
 * A worker is finished once it is closed, has a PR, or has said it is done and
 * is not working again; past that the orchestrator has nothing left to ask of it.
 */
export function progress(p, { prStatusOf: fresh = () => null } = {}) {
    const workers = ((p && p.workers) || []).slice().sort((a, b) => (a.spawnedAt || 0) - (b.spawnedAt || 0));
    const said = new Set(((p && p.inbox) || []).filter(i => i.kind === 'done').map(i => i.workerId));
    const finished = (w) => !!(w.closedAt || w.pr || (said.has(w.id) && workerStateWord(w) !== 'running' && !w.pending));
    const segments = workers.map((w) => {
        const st = w.pr ? prStatusOf(w, fresh(w.id)) : null;
        let s;
        if (w.pr && st === 'merged') s = 'merged';
        else if (w.pr && PR_TROUBLE.has(st)) s = 'fail';
        else if (w.pending && !w.closedAt) s = 'wait';
        else if (workerStateWord(w) === 'running') s = 'run';
        else if (w.pr) s = 'pr';
        else if (finished(w)) s = 'done';
        else if (workerStateWord(w) === 'error') s = 'fail';
        else s = 'idle';
        return { id: w.id, title: w.title || 'worker', s, status: st };
    });
    for (const q of (p && p.pendingSpawns) || []) segments.push({ id: q.id, title: q.title || 'queued', s: 'queued' });
    return {
        segments,
        total: segments.length,
        finished: workers.filter(finished).length,
        running: workers.filter(w => !w.closedAt && (w.state === 'busy' || w.state === 'starting')).length,
        max: (p && p.settings && p.settings.maxRunning) || null,
        queued: ((p && p.pendingSpawns) || []).length,
    };
}

/**
 * How long a worker's ask may wait, with the orchestrator not working on it,
 * before it is the user's to answer. bridge/overview.js applies the same rule
 * to decide a live-board card's `askFor`, and keeps its own copy because the
 * bridge cannot import this module; test/overview-hosts.test.js asserts the two
 * agree.
 */
export const STUCK_MS = 180_000;

/**
 * Everything that is waiting on the user rather than on the orchestrator, most
 * pressing first. Each is `{kind, key, …}`:
 *
 *   paused    the usage cutoff stopped everything — `{reason, resumeAt}`
 *   ask       the orchestrator itself is waiting on an answer in its conversation
 *   decision  a question from the brief — `{decision}`; answered ones come last,
 *             drawn as answered until the orchestrator drops them
 *   stuck     a worker has waited on an ask for longer than `stuckMs` while the
 *             orchestrator is not working, so nobody is going to answer it —
 *             `{worker, item}`
 *   error     a worker's turn ended in an error — `{worker}`
 *
 * @param {{orchRunner?: {state?, pendingPermission?}|null, now?: number, stuckMs?: number}} [o]
 */
export function needsYou(p, { orchRunner = null, now = Date.now(), stuckMs = STUCK_MS } = {}) {
    if (!p) return [];
    const out = [];
    if (p.paused) out.push({ kind: 'paused', key: 'paused', reason: p.paused.reason, resumeAt: p.paused.resumeAt });
    if (orchRunner && orchRunner.pendingPermission) {
        out.push({ kind: 'ask', key: 'ask', ask: orchRunner.pendingPermission });
    }
    const ds = decisionsOf(p).slice().sort((a, b) => (!!a.answeredAt - !!b.answeredAt) || (a.at || 0) - (b.at || 0));
    for (const d of ds) out.push({ kind: 'decision', key: `d:${d.id}`, decision: d });
    const orchWorking = orchRunner && (orchRunner.state === 'busy' || orchRunner.state === 'starting')
        && !orchRunner.pendingPermission;
    for (const w of (p.workers || [])) {
        if (w.closedAt) continue;
        const b = blockedOn(w, p.inbox);
        if (b && b.item && (p.paused || !orchWorking) && now - (b.item.at || now) >= stuckMs) {
            out.push({ kind: 'stuck', key: `s:${w.id}`, worker: w, item: b.item });
        }
        if (workerStateWord(w) === 'error') out.push({ kind: 'error', key: `e:${w.id}`, worker: w });
    }
    return out;
}

/**
 * The PRs in the order they should land: the brief's `mergeOrder` when the
 * orchestrator wrote one, otherwise every worker's PR in the order the workers
 * were started. `rest` is the open workers with no PR yet, which will join the
 * end as they open one.
 *
 * Each row is `{n, key, number, repo, title, workerId, url, status}`, `key` being
 * `repo#number` — a number alone is not unique once workers open PRs in more than
 * one repository. A number the brief names that no worker owns is still listed,
 * with a null title and workerId; one it names twice is listed once.
 */
export function mergeOrder(p, { prStatusOf: fresh = () => null } = {}) {
    const workers = ((p && p.workers) || []).slice().sort((a, b) => (a.spawnedAt || 0) - (b.spawnedAt || 0));
    const byNumber = new Map(workers.filter(w => w.pr).map(w => [w.pr.number, w]));
    const listed = (p && p.summary && p.summary.mergeOrder) || [];
    // From the brief, each number resolved to the worker that opened it; with no
    // brief, each worker's own PR, so two repositories' #12s stay two rows.
    const picks = listed.length ? listed.map(number => ({ number, w: byNumber.get(number) || null }))
        : workers.filter(w => w.pr).map(w => ({ number: w.pr.number, w }));
    const seen = new Set();
    const rows = [];
    for (const { number, w } of picks) {
        const repo = w ? w.pr.repo || null : null;
        const key = `${repo || ''}#${number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
            n: rows.length + 1, key, number, repo, workerId: w ? w.id : null,
            // A number the brief names that no worker here opened: kept, with no
            // title to give it rather than its own number twice.
            title: w ? w.pr.title || w.title || `#${number}` : null,
            url: w ? w.pr.url : null,
            status: w ? prStatusOf(w, fresh(w.id)) : 'unknown',
        });
    }
    const rest = workers.filter(w => !w.closedAt && !w.pr).map(w => ({ id: w.id, title: w.title || 'worker' }));
    return { rows, rest, fromBrief: listed.length > 0 };
}

const METER_LABEL = { five_hour: '5h', seven_day: 'Week', seven_day_opus: 'Week Opus', seven_day_sonnet: 'Week Sonnet' };

/**
 * The usage meters in the page's head: the five-hour and weekly windows always,
 * and Opus and Sonnet when the cutoff watches them. Each is
 * `{type, label, used, cutoff, tone}`, `used` and `cutoff` whole percents or null,
 * and `tone` `ok`, `near` (within ten points of the cutoff) or `over`.
 */
export function usageMeters(stop, windows) {
    const read = (type) => {
        const w = (windows || []).find(x => x && x.type === type);
        return w && Number.isFinite(w.usedPercent) ? Math.round(w.usedPercent) : null;
    };
    const cutoffFor = (type) => {
        if (!stop || !stop.enabled) return null;
        if (stop.window === 'all') return Number.isFinite(stop.limits && stop.limits[type]) ? stop.limits[type] : null;
        return stop.window === type ? stop.percent : null;
    };
    const types = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']
        .filter(t => t === 'five_hour' || t === 'seven_day' || cutoffFor(t) != null);
    return types.map((type) => {
        const used = read(type);
        const cutoff = cutoffFor(type);
        const tone = used == null || cutoff == null ? 'ok' : used >= cutoff ? 'over' : used >= cutoff - 10 ? 'near' : 'ok';
        return { type, label: METER_LABEL[type], used, cutoff, tone };
    });
}
