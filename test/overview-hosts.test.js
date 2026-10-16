'use strict';

// The live board's orchestrators: when one carries its workers, and whose a
// worker's ask is. `hostWorkers` in bridge/overview.js, and `build` around it
// over a stub index and pool. No bridge, no DOM.
//
// What it guards is a board that says something false in a way nobody would
// report as a bug: an orchestrator missing from the board while its workers are
// busy (it reads as "nothing is coordinating these"), a worker cut by the card
// ceiling while the card it is drawn inside stays, a host card that never
// re-renders because a worker moved and its own fingerprint did not, and the
// "waiting for you" badge counting asks the orchestrator is about to answer.

const assert = require('assert');
const overview = require('../bridge/overview');

const { hostWorkers, capUnits, build, STUCK_MS, MAX_CARDS } = overview;

let pass = 0;
const ok = (what) => { pass++; console.log(`  ok  ${what}`); };

const NOW = 1_800_000_000_000;
const summary = (id, over = {}) => ({
    sessionId: id, title: id, projectName: 'p', cwd: '/x', lastTs: null, toolCalls: 0,
    userMessages: 0, archived: false, pinned: false, live: null, ...over,
});
const orch = (id, workers, over = {}) => ({
    id, workers: workers.map(w => (typeof w === 'string' ? { id: w, spawnedAt: 0, closedAt: null } : w)),
    pendingSpawns: [], paused: null, ...over,
});
const busy = { state: 'busy' };
const idle = { state: 'idle' };
const asking = (askedAt, kind = 'tool') => ({
    state: 'busy', pendingPermission: { requestId: `r-${askedAt}`, kind, askedAt },
});

/** hostWorkers over summaries and statuses, with reasons worked out the way build does. */
function plan(summaries, orchs, statuses, now = NOW) {
    const reasons = new Map(summaries.map(s => [s.sessionId, overview.why(s, statuses[s.sessionId] || null)]));
    return hostWorkers({ summaries, reasons, orchs, statuses, now });
}

/** build() over a stub index and pool. */
function board(summaries, orchs, statuses, now = NOW) {
    const index = {
        list: () => summaries,
        get: () => null,
        orchestrators: { byId: new Map(orchs.map(o => [o.id, o])) },
    };
    return build(index, { statuses: () => statuses }, null, { now });
}

(async () => {
    const { STUCK_MS: pageStuck } = await import('../web/orchestrator-model.js');

    {
        assert.strictEqual(STUCK_MS, pageStuck);
        ok('the board and the orchestrator page agree on when a worker\'s ask is stuck');
    }

    {
        const s = [summary('O'), summary('A'), summary('B')];
        const c = plan(s, [orch('O', ['A', 'B'])], { O: idle, A: busy, B: idle });
        const h = c.hosts.get('O');
        assert.ok(h, 'an idle orchestrator with a busy worker hosts');
        assert.strictEqual(h.reason, 'here');
        assert.strictEqual(h.workers.own, false);
        assert.deepStrictEqual(h.workers.ids, ['A']);
        assert.strictEqual(h.workers.idle, 1);
        assert.strictEqual(c.workerOf.get('A'), 'O');
        assert.strictEqual(c.workerOf.get('B'), undefined, 'an idle worker is counted, not carried');
        ok('an idle orchestrator is on the board for its busy worker, and says it is there for them');
    }

    {
        const s = [summary('O'), summary('A'), summary('B')];
        const workers = [{ id: 'A', closedAt: NOW - 1 }, { id: 'B', closedAt: null }];
        const c = plan(s, [orch('O', workers)], { A: busy, B: idle });
        assert.strictEqual(c.hosts.size, 0, 'a closed worker, busy or not, does not make a host');

        const c2 = plan(s, [orch('O', ['A'], { pendingSpawns: [{ id: 'q1', title: 'next', at: 5 }] })], {});
        assert.deepStrictEqual(c2.hosts.get('O').workers.queued, [{ id: 'q1', title: 'next', at: 5 }]);
        assert.strictEqual(c2.hosts.get('O').reason, 'here');
        ok('closed workers are finished, and a queued spawn alone is enough to host');
    }

    {
        const s = [summary('O', { archived: true }), summary('A')];
        const c = plan(s, [orch('O', ['A'])], { A: busy });
        assert.strictEqual(c.hosts.size, 0);
        assert.strictEqual(c.workerOf.size, 0);
        // And one the list does not have at all — deleted, or a test session on
        // the everyday bridge.
        const c2 = plan([summary('A')], [orch('O', ['A'])], { A: busy });
        assert.strictEqual(c2.hosts.size, 0);
        ok('an archived or missing orchestrator hosts nothing, so its workers stay ordinary cards');
    }

    {
        const s = [summary('O'), summary('A')];
        const fresh = plan(s, [orch('O', ['A'])], { O: idle, A: asking(NOW - 1000) });
        assert.strictEqual(fresh.askFor.get('A'), 'orchestrator');
        assert.strictEqual(fresh.hosts.get('O').reason, 'here', 'an ask that is not yours does not lend `ask`');

        const old = plan(s, [orch('O', ['A'])], { O: idle, A: asking(NOW - STUCK_MS) });
        assert.strictEqual(old.askFor.get('A'), 'you');
        assert.strictEqual(old.hosts.get('O').reason, 'ask');

        const working = plan(s, [orch('O', ['A'])], { O: busy, A: asking(NOW - STUCK_MS * 4) });
        assert.strictEqual(working.askFor.get('A'), 'orchestrator', 'a working orchestrator may still get to it');

        const paused = plan(s, [orch('O', ['A'], { paused: { reason: 'usage' } })],
            { O: busy, A: asking(NOW - 1000) });
        assert.strictEqual(paused.askFor.get('A'), 'you', 'nobody answers for a paused orchestrator');

        // An orchestrator itself stopped on an ask is not working.
        const blocked = plan(s, [orch('O', ['A'])], {
            O: { state: 'busy', pendingPermission: { requestId: 'o', askedAt: NOW } },
            A: asking(NOW - STUCK_MS),
        });
        assert.strictEqual(blocked.askFor.get('A'), 'you');
        ok('a worker\'s ask is the orchestrator\'s until it is stuck, by the orchestrator page\'s rule');
    }

    {
        const s = [summary('O'), summary('A'), summary('B'), summary('C')];
        const st = {
            O: { state: 'error', error: 'o' },
            A: busy,
            B: { state: 'error', error: 'x' },
            C: asking(NOW - STUCK_MS),
        };
        const c = plan(s, [orch('O', ['A', 'B', 'C'])], st);
        assert.strictEqual(c.hosts.get('O').reason, 'ask', 'a stuck ask outranks the orchestrator\'s own error');
        assert.strictEqual(c.hosts.get('O').workers.own, true);
        assert.deepStrictEqual(c.hosts.get('O').workers.ids, ['C', 'B', 'A'], 'what needs somebody first');

        const c2 = plan(s.slice(0, 3), [orch('O', ['A', 'B'])], { O: idle, A: busy, B: st.B });
        assert.strictEqual(c2.hosts.get('O').reason, 'error');

        const pinned = [summary('O', { pinned: true }), summary('A')];
        const c3 = plan(pinned, [orch('O', ['A'])], { A: busy });
        assert.strictEqual(c3.hosts.get('O').reason, 'here', 'its workers move a pinned orchestrator to Live');
        assert.strictEqual(c3.hosts.get('O').workers.own, false);
        ok('a host takes the stronger of its own reason and the one its workers lend it');
    }

    {
        // Two hosts, each with workers, and a ceiling of two.
        const cards = [
            { sessionId: 'W1', orchestratorId: 'O1' },
            { sessionId: 'X', orchestratorId: null },
            { sessionId: 'O1', workers: { ids: ['W1', 'W2'] } },
            { sessionId: 'W2', orchestratorId: 'O1' },
            { sessionId: 'O2', workers: { ids: ['W3'] } },
            { sessionId: 'W3', orchestratorId: 'O2' },
        ];
        const kept = capUnits(cards, 2).map(c => c.sessionId);
        assert.deepStrictEqual(kept, ['W1', 'X', 'O1', 'W2']);
        ok('the card ceiling counts a host and its workers as one, and keeps or cuts them together');
    }

    {
        const s = [summary('O'), summary('A'), summary('B'), summary('L')];
        const orchs = [orch('O', ['A', 'B'])];
        const one = board(s, orchs, { O: idle, A: busy, B: asking(NOW - 1000), L: asking(NOW) });
        const o = one.sessions.find(c => c.sessionId === 'O');
        assert.ok(o, 'the idle orchestrator has a card');
        assert.deepStrictEqual(o.workers.ids.sort(), ['A', 'B']);
        assert.strictEqual(one.sessions.find(c => c.sessionId === 'A').orchestratorId, 'O');
        assert.strictEqual(one.sessions.find(c => c.sessionId === 'B').askFor, 'orchestrator');
        assert.strictEqual(one.sessions.find(c => c.sessionId === 'L').askFor, 'you');
        assert.strictEqual(one.sessions.find(c => c.sessionId === 'L').orchestratorId, null);
        assert.ok(!one.recent.some(c => c.sessionId === 'O'), 'a host is not also recent');
        assert.strictEqual(one.waiting, 1, 'only the ask that is yours is waiting');
        assert.strictEqual(one.running, 1, 'the busy worker is running; the idle orchestrator is not');

        // A worker's activity moves; the host's card must move with it.
        const two = board(s, orchs, {
            O: idle, A: { state: 'busy', activity: 'Reading a file' }, B: asking(NOW - 1000), L: asking(NOW),
        });
        const o2 = two.sessions.find(c => c.sessionId === 'O');
        assert.notStrictEqual(o2.sig, o.sig);
        const three = board(s, orchs, { O: idle, A: busy, B: asking(NOW - 1000), L: asking(NOW) });
        assert.strictEqual(three.sessions.find(c => c.sessionId === 'O').sig, o.sig, 'and only then');

        // Stuck is a matter of the clock alone.
        const later = board(s, orchs, { O: idle, A: busy, B: asking(NOW - 1000), L: asking(NOW) }, NOW + STUCK_MS);
        assert.strictEqual(later.waiting, 2);
        assert.strictEqual(later.sessions.find(c => c.sessionId === 'O').reason, 'ask');
        assert.notStrictEqual(later.sessions.find(c => c.sessionId === 'O').sig, o.sig);
        ok('build carries workers on their orchestrator, and a worker moving moves the host\'s sig');
    }

    {
        const s = [];
        const orchs = [];
        for (let i = 0; i < MAX_CARDS; i++) s.push(summary(`S${i}`));
        s.push(summary('O'));
        orchs.push(orch('O', ['W1', 'W2']));
        s.push(summary('W1'), summary('W2'));
        const st = Object.fromEntries(s.map(x => [x.sessionId, busy]));
        st.O = idle;
        const d = board(s, orchs, st);
        const ids = new Set(d.sessions.map(c => c.sessionId));
        for (const c of d.sessions) {
            if (c.orchestratorId) assert.ok(ids.has(c.orchestratorId), `${c.sessionId} kept without its host`);
            if (c.workers) for (const w of c.workers.ids) assert.ok(ids.has(w), `${w} cut from its host`);
        }
        ok('a full board never splits a host from its workers');
    }

    console.log(`\n${pass} live board host checks passed`);
})().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
