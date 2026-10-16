'use strict';

// The per-worker half of the orchestrator page's model — web/orchestrator-model.js — over
// payloads shaped like the bridge's. No bridge, no DOM.
//
// What it guards is a card that says something false: a timeline that shows a
// worker as never having planned because its plan aged out of the inbox, an ask
// offered for answering that the worker is no longer waiting on (the buttons
// would 409, or worse, answer a newer ask with an older one's decision), or a
// "last report" that is really the orchestrator's own note.

const assert = require('assert');

let pass = 0;
const ok = (what) => { pass++; console.log(`  ok  ${what}`); };

const T0 = 1_700_000_000_000;
const worker = (over = {}) => ({
    id: 'W', title: 'worker', cwd: '/x', worktree: { path: '/x/wt', branch: 'worktree-w' },
    spawnedAt: T0, closedAt: null, state: 'idle', pending: null, pr: null, ...over,
});
let seq = 0;
const item = (over = {}) => ({
    id: `i${++seq}`, workerId: 'W', kind: 'update', text: 'x', at: T0 + seq * 1000, seq,
    status: 'new', requestId: null, ask: null, outcome: null, by: null, ...over,
});
// The payload's inbox is newest first.
const newestFirst = (...items) => items.slice().sort((a, b) => b.at - a.at);
const states = (steps) => Object.fromEntries(steps.map(s => [s.key, s.state]));

(async () => {
    const {
        workerStateWord, blockedOn, lastReport, workerTimeline,
    } = await import('../web/orchestrator-model.js');

    {
        assert.strictEqual(workerStateWord(worker({ state: 'busy' })), 'running');
        assert.strictEqual(workerStateWord(worker({ state: 'starting' })), 'running');
        assert.strictEqual(workerStateWord(worker({ state: 'idle' })), 'idle');
        assert.strictEqual(workerStateWord(worker({ state: 'stopped' })), 'stopped');
        assert.strictEqual(workerStateWord(worker({ state: 'error' })), 'error');
        assert.strictEqual(workerStateWord(worker({ state: 'busy', closedAt: T0 })), 'closed');
        ok('a worker\'s state comes down to one word, and closed wins');
    }

    {
        // Waiting on a tool prompt, with an older settled one and the current one
        // filed: the open one is the one to answer.
        const old = item({ kind: 'permission', requestId: 'r1', status: 'resolved', outcome: 'allow' });
        const now = item({ kind: 'permission', requestId: 'r2', status: 'read' });
        const w = worker({ state: 'busy', pending: 'tool' });
        const b = blockedOn(w, newestFirst(old, now));
        assert.strictEqual(b.kind, 'tool');
        assert.strictEqual(b.item.requestId, 'r2');

        // The runner waits on a plan, but the open item is a stale permission:
        // not that.
        const w2 = worker({ pending: 'plan' });
        const b2 = blockedOn(w2, newestFirst(item({ kind: 'permission', requestId: 'r3' })));
        assert.deepStrictEqual(b2, { kind: 'plan', item: null }, 'kind alone when nothing on file matches');

        assert.strictEqual(blockedOn(worker(), newestFirst(now)), null, 'not waiting, nothing to answer');
        assert.strictEqual(blockedOn(worker({ pending: 'tool', closedAt: T0 }), newestFirst(now)), null,
            'a closed worker is never blocked');
        // Another worker's ask is not this one's.
        const other = item({ kind: 'permission', requestId: 'r4', workerId: 'V' });
        assert.strictEqual(blockedOn(worker({ pending: 'tool' }), [other]).item, null);
        ok('the ask on a card is the one the worker is waiting on now, or none');
    }

    {
        const note = item({ kind: 'note', text: 'the user answered first' });
        const upd = item({ kind: 'update', text: 'halfway' });
        const turn = item({ kind: 'turn', text: 'finished the parser' });
        assert.strictEqual(lastReport(worker(), newestFirst(upd, turn, note)).text, 'finished the parser',
            'a note is the bridge talking, not the worker');
        assert.strictEqual(lastReport(worker(), []), null);
        ok('the last report is the newest thing the worker itself said');
    }

    {
        // Never planned, working: the plan steps are skipped and work is `now`.
        const s = states(workerTimeline(worker({ state: 'busy' }), []));
        assert.deepStrictEqual(s, { spawned: 'done', plan: 'skipped', approved: 'skipped', done: 'now', pr: 'todo' });
        // The same worker idle between turns is waiting, not working.
        assert.strictEqual(states(workerTimeline(worker({ state: 'idle' }), [])).done, 'todo');

        // Plan waiting.
        const plan = item({ kind: 'plan', requestId: 'p1' });
        const s2 = states(workerTimeline(worker({ pending: 'plan' }), [plan]));
        assert.deepStrictEqual(s2, { spawned: 'done', plan: 'done', approved: 'now', done: 'todo', pr: 'todo' });

        // Waiting on a plan with nothing on file yet.
        const s3 = states(workerTimeline(worker({ pending: 'plan' }), []));
        assert.strictEqual(s3.plan, 'now');
        assert.strictEqual(s3.approved, 'todo');

        // Approved, working, then done with a PR.
        const approved = { ...plan, status: 'resolved', outcome: 'allow', by: 'orchestrator' };
        const s4 = states(workerTimeline(worker({ state: 'busy' }), [approved]));
        assert.deepStrictEqual(s4, { spawned: 'done', plan: 'done', approved: 'done', done: 'now', pr: 'todo' });
        const done = item({ kind: 'done', text: 'PR #9' });
        const w5 = worker({ pr: { number: 9, url: 'u', status: 'open' } });
        const steps5 = workerTimeline(w5, newestFirst(approved, done));
        assert.deepStrictEqual(states(steps5),
            { spawned: 'done', plan: 'done', approved: 'done', done: 'done', pr: 'done' });
        assert.strictEqual(steps5.find(x => x.key === 'done').at, done.at);
        assert.strictEqual(steps5.find(x => x.key === 'plan').at, plan.at);
        ok('the timeline follows a worker from spawn through plan and approval to done and PR');
    }

    {
        // Turned down and re-planned: the newest plan is what decides `approved`,
        // and the road starts at the first one.
        const first = item({ kind: 'plan', requestId: 'p1', status: 'resolved', outcome: 'deny' });
        const second = item({ kind: 'plan', requestId: 'p2', status: 'read' });
        const steps = workerTimeline(worker({ pending: 'plan' }), newestFirst(first, second));
        assert.strictEqual(states(steps).approved, 'now');
        assert.strictEqual(steps.find(x => x.key === 'plan').at, first.at);

        // Denied and not re-planned yet, no longer waiting: not approved, not now.
        const s = states(workerTimeline(worker({ state: 'busy' }), [first]));
        assert.strictEqual(s.approved, 'todo');
        ok('a plan sent back is not an approval, and a second plan picks up the step');
    }

    {
        // Approved once, then a second plan filed: the second is what it waits on,
        // so the approval step is `now`, not `done` from the first.
        const first = item({ kind: 'plan', requestId: 'p1', status: 'resolved', outcome: 'plan-approved' });
        const second = item({ kind: 'plan', requestId: 'p2', status: 'read' });
        const s = states(workerTimeline(worker({ pending: 'plan' }), newestFirst(first, second)));
        assert.strictEqual(s.approved, 'now');
        // Approved, then a second plan sent back: not approved, whatever the first was.
        const back = { ...second, status: 'resolved', outcome: 'deny' };
        const s2 = states(workerTimeline(worker({ state: 'busy' }), newestFirst(first, back)));
        assert.strictEqual(s2.approved, 'todo');
        ok('an earlier approval does not cover a newer plan');
    }

    {
        // A full inbox whose oldest item is younger than the worker: its plan may
        // have been trimmed, so the steps are `unknown`, not `skipped`.
        const filler = Array.from({ length: 100 }, (_, i) => item({ workerId: 'V', at: T0 + 10_000 + i }));
        const inbox = newestFirst(...filler);
        const s = states(workerTimeline(worker({ pr: { number: 3, status: 'open' } }), inbox));
        assert.strictEqual(s.plan, 'unknown');
        assert.strictEqual(s.approved, 'unknown');
        assert.strictEqual(s.done, 'unknown', 'has a PR, so got past the work, but no done on file');
        assert.strictEqual(s.pr, 'done');

        // A short inbox is complete: nothing there means it never happened.
        const s2 = states(workerTimeline(worker({ pr: { number: 3, status: 'open' } }), filler.slice(0, 5)));
        assert.strictEqual(s2.plan, 'skipped');
        ok('a step the inbox can no longer show is unknown, not skipped');
    }

    {
        // Closed with no done report: the close is the end.
        const steps = workerTimeline(worker({ closedAt: T0 + 5000 }), []);
        assert.strictEqual(states(steps).done, 'done');
        assert.strictEqual(steps.find(x => x.key === 'done').at, T0 + 5000);
        ok('a closed worker is done when it was closed');
    }

    console.log(`\n${pass} orchestrator view checks passed`);
})().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
