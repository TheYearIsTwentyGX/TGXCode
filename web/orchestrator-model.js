// What the orchestrator's workers view draws, worked out from the bridge's
// `orchestrator` payload — web/orchestrator-view.js draws it.
//
// Pure, and with no imports, so test/orchestrator-view.test.js can load it in
// node the way test/pr-owners.test.js loads web/pr-resolve.js.
//
// Everything a worker's card says beyond its own row is read out of the inbox:
// the plan it filed, whether that was approved, the last thing it reported. The
// inbox is a lossy record of that — the payload carries the newest 100 items,
// and the store drops settled ones first once it is full — so a step this
// cannot find is `unknown`, never quietly `todo`. A worker that has a PR or has
// said it is done plainly got past its plan, whether or not the plan is still
// on file, and the timeline says so rather than drawing a gap.

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
 * and the plan text — and otherwise just the kind the runner reports, so a card
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
    const approved = plans.find(p => settled(p) && APPROVED.has(p.outcome)) || null;
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

/**
 * The inbox counts the view heads with: `unread` the orchestrator has not pulled,
 * and `waiting` — asks still open, read or not, which are the ones a worker is
 * stopped on.
 */
export function inboxCounts(p) {
    const items = (p && p.inbox) || [];
    let unread = 0;
    let waiting = 0;
    for (const i of items) {
        if (i.status === 'new') unread += 1;
        if (ASK_KINDS[i.kind] && i.requestId && !settled(i)) waiting += 1;
    }
    return { unread, waiting };
}

/**
 * The workers in the order the view lays them out: blocked first (they want
 * somebody), then running, then the rest, closed last; newest spawn first within
 * each. A stable order matters more than a clever one — cards are keyed, and a
 * grid reshuffling on every status tick is unreadable.
 */
export function workerOrder(workers) {
    const rank = (w) => (w.closedAt ? 4 : w.pending ? 0 : workerStateWord(w) === 'running' ? 1
        : workerStateWord(w) === 'error' ? 2 : 3);
    return (workers || []).slice().sort((a, b) => rank(a) - rank(b) || (b.spawnedAt || 0) - (a.spawnedAt || 0));
}

/**
 * The usage cutoff in one line, from the payload's `settings.usageStop` and the
 * windows `GET …/orchestrator/usage` reports. `{tone, text}`: `off`, `ok`, or
 * `near` once the reading is within ten points of the cutoff. A pause is drawn
 * from `paused` itself, not from here.
 */
export function cutoffLine(stop, windows) {
    if (!stop || !stop.enabled) return { tone: 'off', text: 'No usage cutoff' };
    const ws = windows || [];
    const read = (type) => {
        const w = ws.find(x => x.type === type);
        return w && Number.isFinite(w.usedPercent) ? Math.round(w.usedPercent) : null;
    };
    const pairs = stop.window === 'all'
        ? Object.entries(stop.limits || {}).filter(([, v]) => Number.isFinite(v))
        : [[stop.window, stop.percent]];
    if (!pairs.length) return { tone: 'off', text: 'No usage cutoff' };
    let tone = 'ok';
    const parts = pairs.map(([type, pct]) => {
        const now = read(type);
        if (now != null && now >= pct - 10) tone = 'near';
        return `${WINDOW_WORD[type] || type} ${now == null ? '—' : `${now}%`} of ${pct}%`;
    });
    return { tone, text: `Stops at the cutoff · ${parts.join(' · ')}` };
}

const WINDOW_WORD = {
    five_hour: 'five-hour', seven_day: 'weekly',
    seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet',
};
