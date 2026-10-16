'use strict';

// The orchestrator page's model — the second half of web/orchestrator-model.js —
// over payloads shaped like the bridge's. No bridge, no DOM.
//
// The page is read by somebody who has been away, so what this guards is a
// glance that lies: a worker drawn as building while its plan sits unapproved,
// a question for the user that vanishes from "Needs you" because it was
// answered in a window they never saw, an ask flagged as stuck while the
// orchestrator is in the middle of answering it, or a merge order that
// quietly drops a PR the brief named.

const assert = require('assert');

let pass = 0;
const ok = (what) => { pass++; console.log(`  ok  ${what}`); };

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const worker = (over = {}) => ({
    id: 'W', title: 'worker', cwd: '/x', worktree: null,
    spawnedAt: T0, closedAt: null, state: 'idle', pending: null, pr: null, ...over,
});
let seq = 0;
const item = (over = {}) => ({
    id: `i${++seq}`, workerId: 'W', kind: 'update', text: 'x', at: T0 + seq * 1000, seq,
    status: 'new', requestId: null, ask: null, outcome: null, by: null, settledAt: null, ...over,
});
const newestFirst = (...items) => items.slice().sort((a, b) => b.at - a.at);
const pr = (number, status = 'open') => ({ number, url: `https://github.com/o/r/pull/${number}`,
    repo: 'o/r', title: `PR ${number}`, status, label: null });

(async () => {
    const {
        workerStage, stageLine, progress, needsYou, mergeOrder, usageMeters, shortAge, openDecisionFor, STAGES,
    } = await import('../web/orchestrator-model.js');

    {
        assert.deepStrictEqual(STAGES, ['plan', 'approved', 'building', 'done', 'pr', 'merged']);

        // Plan filed and not yet approved: on Approved, waiting, plan behind it.
        const plan = item({ kind: 'plan', requestId: 'r1', status: 'read' });
        let s = workerStage(worker({ state: 'busy', pending: 'plan' }), newestFirst(plan));
        assert.strictEqual(s.at, 2);
        assert.strictEqual(s.tone, 'wait');
        assert.deepStrictEqual(s.steps, ['done', 'now', 'todo', 'todo', 'todo', 'todo']);

        // Approved and working.
        const approved = { ...plan, status: 'resolved', outcome: 'plan-approved' };
        s = workerStage(worker({ state: 'busy' }), newestFirst(approved));
        assert.strictEqual(s.at, 3);
        assert.strictEqual(s.tone, 'run');
        assert.deepStrictEqual(s.steps.slice(0, 3), ['done', 'done', 'now']);

        // Auto mode, no plan ever: the plan stages are skipped, not pending.
        s = workerStage(worker({ state: 'busy' }), []);
        assert.strictEqual(s.at, 3);
        assert.deepStrictEqual(s.steps.slice(0, 3), ['skip', 'skip', 'now']);

        // Plan mode with no plan filed yet is still planning — not building.
        s = workerStage(worker({ state: 'busy' }), [], { mode: 'plan' });
        assert.strictEqual(s.at, 1);
        assert.strictEqual(s.tone, 'run');
        ok('a worker sits on the stage it is really on: planning, waiting for approval, or building');
    }

    {
        // A plan sent back, in plan mode: planning again, on the Plan stage, and
        // nothing drawn as approved.
        const denied = item({ kind: 'plan', requestId: 'r1', status: 'resolved', outcome: 'deny' });
        let s = workerStage(worker({ state: 'busy' }), [denied], { mode: 'plan' });
        assert.strictEqual(s.at, 1);
        assert.notStrictEqual(s.steps[1], 'done');
        // Out of plan mode it gets on with the work, but the approval it never
        // had is still not drawn as one.
        s = workerStage(worker({ state: 'busy' }), [denied], { mode: 'auto' });
        assert.strictEqual(s.at, 3);
        assert.deepStrictEqual(s.steps.slice(0, 3), ['done', 'todo', 'now']);

        // Approved once, then a second plan waiting: on Approved, waiting.
        const first = item({ kind: 'plan', requestId: 'r2', status: 'resolved', outcome: 'plan-approved' });
        const second = item({ kind: 'plan', requestId: 'r3', status: 'read' });
        s = workerStage(worker({ state: 'busy', pending: 'plan' }), newestFirst(first, second));
        assert.strictEqual(s.at, 2);
        assert.strictEqual(s.steps[1], 'now');
        // …and that second plan sent back, in plan mode: planning again.
        const back = { ...second, status: 'resolved', outcome: 'deny' };
        s = workerStage(worker({ state: 'busy' }), newestFirst(first, back), { mode: 'plan' });
        assert.strictEqual(s.at, 1);
        ok('a sent-back or second plan is never drawn as approved');
    }

    {
        // A PR: on the PR stage, coloured by the app's fresher status over the
        // payload's, and Merged once it is merged.
        const w = worker({ closedAt: T0 + 5 * MIN, pr: pr(12, 'open') });
        let s = workerStage(w, []);
        assert.strictEqual(s.at, 5);
        assert.strictEqual(s.tone, 'pr');
        assert.strictEqual(s.steps[3], 'done', 'closed counts as done');
        s = workerStage(w, [], { prStatus: 'checks-failed' });
        assert.strictEqual(s.tone, 'fail');
        assert.strictEqual(s.prStatus, 'checks-failed');
        s = workerStage(w, [], { prStatus: 'merged' });
        assert.strictEqual(s.at, 6);
        assert.strictEqual(s.tone, 'merged');

        // An open worker with a PR and no done report: done is unknown, not
        // skipped — it plainly finished something.
        s = workerStage(worker({ pr: pr(13) }), []);
        assert.strictEqual(s.steps[3], 'unknown');

        // Idle on a decision the orchestrator put to the user: "you", and only
        // while it is not working.
        const d = { id: 'd1', text: 'Keep the hover card?', workerId: 'W', at: T0, answeredAt: null };
        assert.strictEqual(workerStage(worker(), [], { decision: d }).tone, 'you');
        assert.strictEqual(workerStage(worker({ state: 'busy' }), [], { decision: d }).tone, 'run');
        ok('finished workers are coloured by their PR, and a decision about a worker shows on its row');
    }

    {
        const now = T0 + 10 * MIN;
        const plan = item({ kind: 'plan', requestId: 'r9', status: 'new', at: now - 2 * MIN });
        const w = worker({ state: 'busy', pending: 'plan' });
        let line = stageLine(w, workerStage(w, [plan]), [plan], { now });
        assert.strictEqual(line.lead, 'Plan waiting 2m');
        assert.strictEqual(line.detail, 'the orchestrator has not read it yet');
        const read = { ...plan, status: 'read' };
        line = stageLine(w, workerStage(w, [read]), [read], { now });
        assert.strictEqual(line.detail, 'the orchestrator is on it');

        const busy = worker({ state: 'busy' });
        line = stageLine(busy, workerStage(busy, []), [], { runner: { activity: 'Pondering… Editing app.js', detail: 'Editing app.js' } });
        assert.strictEqual(line.lead, 'Editing app.js', 'the informative half, not the themed verb');
        line = stageLine(busy, workerStage(busy, []), [], { runner: null });
        assert.strictEqual(line.lead, 'Working');

        const idle = worker();
        const rep = item({ kind: 'turn', text: '\nBuilt the panel.\nMore detail' });
        line = stageLine(idle, workerStage(idle, [rep]), [rep]);
        assert.deepStrictEqual(line, { lead: 'Idle', detail: 'Built the panel.' });
        ok('a row says what the worker is doing in words, from its ask, its runner or its last report');
    }

    {
        const p = {
            settings: { maxRunning: 3 },
            workers: [
                worker({ id: 'A', spawnedAt: T0 + 3, state: 'busy' }),
                worker({ id: 'B', spawnedAt: T0 + 1, closedAt: T0 + 9, pr: pr(1, 'merged') }),
                worker({ id: 'C', spawnedAt: T0 + 2, state: 'busy', pending: 'plan' }),
                worker({ id: 'D', spawnedAt: T0 + 4, pr: pr(2, 'open') }),
                worker({ id: 'E', spawnedAt: T0 + 5, closedAt: T0 + 9 }),
            ],
            pendingSpawns: [{ id: 'q1', title: 'Queued one', at: T0 }],
        };
        const g = progress(p, { prStatusOf: (id) => (id === 'D' ? 'checks-failed' : null) });
        assert.deepStrictEqual(g.segments.map(x => `${x.id}:${x.s}`),
            ['B:merged', 'C:wait', 'A:run', 'D:fail', 'E:done', 'q1:queued'], 'started order, then the queue');
        assert.strictEqual(g.total, 6);
        assert.strictEqual(g.finished, 3, 'closed or with a PR');
        assert.strictEqual(g.running, 2, 'busy ones hold a slot, blocked included');
        assert.strictEqual(g.max, 3);
        assert.strictEqual(g.queued, 1);

        // Said it was done and stopped: finished, whether or not it was closed —
        // but not while it is working again.
        const said = { ...p, inbox: [item({ workerId: 'A', kind: 'done' })] };
        assert.strictEqual(progress(said).finished, 3, 'still working, so not yet');
        said.workers = said.workers.map(w => (w.id === 'A' ? { ...w, state: 'idle' } : w));
        const g2 = progress(said);
        assert.strictEqual(g2.finished, 4);
        assert.strictEqual(g2.segments.find(x => x.id === 'A').s, 'done');
        ok('the progress strip has one segment per task, in the order they were started');
    }

    {
        const now = T0 + 30 * MIN;
        const old = item({ workerId: 'S', kind: 'permission', requestId: 'r1', status: 'read', at: now - 5 * MIN });
        const fresh = item({ workerId: 'F', kind: 'plan', requestId: 'r2', status: 'new', at: now - 1 * MIN });
        const p = {
            paused: null,
            summary: { text: 'x', decisions: [
                { id: 'late', text: 'Second?', at: T0 + 2, answeredAt: null },
                { id: 'done', text: 'Answered?', at: T0, answeredAt: T0 + 5, answer: 'yes' },
                { id: 'early', text: 'First?', at: T0 + 1, answeredAt: null },
            ] },
            workers: [
                worker({ id: 'S', state: 'busy', pending: 'tool' }),
                worker({ id: 'F', state: 'busy', pending: 'plan' }),
                worker({ id: 'X', state: 'error' }),
                worker({ id: 'Z', state: 'error', closedAt: T0 }),
            ],
            inbox: newestFirst(old, fresh),
        };
        // The orchestrator is idle: the five-minute-old ask is stuck, the
        // one-minute one is not yet.
        let n = needsYou(p, { orchRunner: { state: 'idle' }, now });
        assert.deepStrictEqual(n.map(x => x.key), ['d:early', 'd:late', 'd:done', 's:S', 'e:X']);

        // While it is working, nothing is stuck — it may be answering right now.
        n = needsYou(p, { orchRunner: { state: 'busy' }, now });
        assert.ok(!n.some(x => x.kind === 'stuck'));

        // Paused trumps everything and makes the old ask stuck whatever the runner says.
        n = needsYou({ ...p, paused: { reason: 'five-hour at 91%', resumeAt: null } },
            { orchRunner: { state: 'busy' }, now });
        assert.strictEqual(n[0].kind, 'paused');
        assert.ok(n.some(x => x.key === 's:S'));

        // The orchestrator asking in its own conversation is second only to a pause.
        n = needsYou(p, { orchRunner: { state: 'busy', pendingPermission: { kind: 'question' } }, now });
        assert.strictEqual(n[0].kind, 'ask');
        assert.ok(n.some(x => x.key === 's:S'), 'an orchestrator waiting on the user is not working');

        assert.strictEqual(openDecisionFor({ summary: { decisions: [
            { id: 'a', workerId: 'W', answeredAt: T0 }, { id: 'b', workerId: 'W', answeredAt: null }] } }, 'W').id, 'b');
        ok('Needs you: pause, the orchestrator\'s own ask, decisions oldest first and answered last, then stuck asks and errors');
    }

    {
        const p = {
            summary: { text: 'x', mergeOrder: [3, 1, 99] },
            workers: [
                worker({ id: 'A', spawnedAt: T0 + 1, pr: pr(1, 'approved'), closedAt: T0 }),
                worker({ id: 'B', spawnedAt: T0 + 2, pr: pr(3, 'open') }),
                worker({ id: 'C', spawnedAt: T0 + 3, title: 'Still going', state: 'busy' }),
            ],
        };
        let m = mergeOrder(p, { prStatusOf: (id) => (id === 'B' ? 'merged' : null) });
        assert.strictEqual(m.fromBrief, true);
        assert.deepStrictEqual(m.rows.map(r => [r.n, r.number, r.status]), [[1, 3, 'merged'], [2, 1, 'approved'], [3, 99, 'unknown']]);
        assert.strictEqual(m.rows[2].title, null, 'a PR no worker owns is kept, by number alone');
        assert.strictEqual(m.rows[2].workerId, null);
        assert.deepStrictEqual(m.rest.map(r => r.id), ['C']);

        m = mergeOrder({ ...p, summary: { text: 'x', mergeOrder: [] } });
        assert.strictEqual(m.fromBrief, false);
        assert.deepStrictEqual(m.rows.map(r => r.number), [1, 3], 'without a brief, in the order the workers started');
        assert.deepStrictEqual(m.rows.map(r => r.key), ['o/r#1', 'o/r#3']);

        // Two repositories' #7: two rows with two keys, not one row twice.
        const other = { ...pr(7), repo: 'o/other' };
        m = mergeOrder({ workers: [worker({ id: 'X', pr: pr(7) }), worker({ id: 'Y', spawnedAt: T0 + 1, pr: other })] });
        assert.deepStrictEqual(m.rows.map(r => [r.key, r.workerId]), [['o/r#7', 'X'], ['o/other#7', 'Y']]);
        // A number the brief names twice is listed once.
        m = mergeOrder({ ...p, summary: { text: 'x', mergeOrder: [3, 3, 1] } });
        assert.deepStrictEqual(m.rows.map(r => [r.n, r.number]), [[1, 3], [2, 1]]);
        ok('the merge order follows the brief, keeps what it names, and falls back to start order');
    }

    {
        const windows = [{ type: 'five_hour', usedPercent: 82.4 }, { type: 'seven_day', usedPercent: 40 },
            { type: 'seven_day_opus', usedPercent: 99 }];
        let m = usageMeters({ enabled: true, window: 'five_hour', percent: 90, limits: {} }, windows);
        assert.deepStrictEqual(m.map(x => [x.label, x.used, x.cutoff, x.tone]),
            [['5h', 82, 90, 'near'], ['Week', 40, null, 'ok']]);
        m = usageMeters({ enabled: true, window: 'all', percent: 90,
            limits: { five_hour: 80, seven_day: 95, seven_day_opus: 98, seven_day_sonnet: null } }, windows);
        assert.deepStrictEqual(m.map(x => [x.label, x.cutoff, x.tone]),
            [['5h', 80, 'over'], ['Week', 95, 'ok'], ['Week Opus', 98, 'over']]);
        m = usageMeters({ enabled: false }, []);
        assert.deepStrictEqual(m.map(x => [x.used, x.cutoff, x.tone]), [[null, null, 'ok'], [null, null, 'ok']]);
        ok('the usage meters show the cutoff each window is held to, and say when it is close');
    }

    {
        assert.strictEqual(shortAge(10_000), 'now');
        assert.strictEqual(shortAge(12 * MIN), '12m');
        assert.strictEqual(shortAge(3 * 60 * MIN + 5), '3h');
        assert.strictEqual(shortAge(50 * 60 * MIN), '2d');
        ok('ages are short enough for a row');
    }

    console.log(`\n${pass} orchestrator page checks passed`);
})().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
