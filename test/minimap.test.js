'use strict';

// Where the minimap puts things — web/transcript/minimap-layout.js.
//
// No bridge needed. What it gets wrong never throws: a mark a turn too low is a
// click that lands on the wrong message, a cluster that keeps the wrong kind is
// a failure drawn as an edit, and a band that stops short of the bottom is a
// rail that says you are somewhere you are not. Each case below is one of those.

const assert = require('assert');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

process.removeAllListeners('warning');

(async () => {
    const { placeMarks, clusterMarks, turnAt, viewBand, PRIORITY } =
        await import('../web/transcript/minimap-layout.js');

    // Three turns at bytes 0, 1000 and 1100; the file ends at 2100.
    const starts = [0, 1000, 1100];
    const end = 2100;
    const T = (turn) => ({ key: `t${turn}`, kind: 'turn', turn, at: starts[turn] });

    // --- placement ---------------------------------------------------------
    {
        const placed = placeMarks([
            T(0), { key: 'e', kind: 'edit', turn: 0, at: 500 },
            T(1), { key: 'x', kind: 'error', turn: 1, at: 1050 },
            T(2), { key: 'p', kind: 'pr', turn: 2, at: 2000 },
        ], starts, end);
        const y = Object.fromEntries(placed.map(m => [m.key, m.y]));
        // By turn, not by bytes: turn 1 is 100 bytes long and still a third of the rail.
        assert.strictEqual(y.t0, 0);
        assert.strictEqual(y.t1, 1 / 3);
        assert.strictEqual(y.t2, 2 / 3);
        // Inside a turn, by bytes.
        assert.ok(Math.abs(y.e - 0.5 / 3) < 1e-9, 'halfway through turn 0');
        assert.ok(Math.abs(y.x - (1 + 0.5) / 3) < 1e-9, 'halfway through turn 1');
        assert.ok(y.p > y.t2 && y.p < 1);
        const ys = placed.map(m => m.y);
        assert.deepStrictEqual(ys, ys.slice().sort((a, b) => a - b), 'document order is rail order');
        ok('turns share the rail equally, and a mark sits by bytes inside its turn');
    }
    {
        // A mark at the very end of its turn does not land on the next turn's line.
        const [, m] = placeMarks([T(0), { key: 'e', kind: 'edit', turn: 0, at: 999 }], starts, end);
        assert.ok(m.y < 1 / 3 - 0.01);
        ok('a mark never sits on the next turn');
    }
    {
        // Live marks have no offset: spread after the last one that does.
        const placed = placeMarks([
            T(2), { key: 'a', kind: 'edit', turn: 2, at: 1600 },
            { key: 'b', kind: 'edit', turn: 2, at: null },
            { key: 'c', kind: 'error', turn: 2, at: null },
            // A turn that arrived live, and its edit.
            { key: 't3', kind: 'turn', turn: 3, at: null },
            { key: 'd', kind: 'edit', turn: 3, at: null },
        ], [...starts, null], end);
        const y = Object.fromEntries(placed.map(m => [m.key, m.y]));
        assert.ok(y.a < y.b && y.b < y.c && y.c < y.t3, `live marks follow in order: ${JSON.stringify(y)}`);
        assert.strictEqual(y.t3, 3 / 4);
        assert.ok(y.d > y.t3 && y.d < 1);
        ok('marks that arrived live are spread by order after the last placed one');
    }
    {
        // Before the first turn (a compaction summary, a PR raised in a resumed
        // session's preamble), and no turns at all.
        const placed = placeMarks([{ key: 'p', kind: 'pr', turn: -1, at: 10 }, T(0)], [0], 100);
        assert.strictEqual(placed[0].y, 0);
        assert.deepStrictEqual(placeMarks([], [], null), []);
        const lone = placeMarks([{ key: 'p', kind: 'pr', turn: -1, at: 3 }], [], 10);
        assert.strictEqual(lone[0].y, 0);
        ok('marks before the first turn sit at the top, and an empty session places nothing');
    }

    // --- clustering --------------------------------------------------------
    {
        const placed = [
            { key: 'e1', kind: 'edit', y: 0.100 },
            { key: 'e2', kind: 'edit', y: 0.101 },
            { key: 's1', kind: 'subagent', y: 0.102 },
            { key: 'x1', kind: 'error', y: 0.101 },
            { key: 't1', kind: 'turn', y: 0.1 },
            { key: 'e3', kind: 'edit', y: 0.5 },
            { key: 'p1', kind: 'pr', y: 0.501 },
            // Failures have their lane to themselves, so a PR is never under one.
            { key: 'x2', kind: 'error', y: 0.5 },
        ];
        const c = clusterMarks(placed, 400, 4);
        const left = c.filter(k => k.lane === 'left');
        assert.strictEqual(left.length, 2, 'two left-lane clusters');
        assert.strictEqual(left[1].kind, 'pr', 'a PR outranks the edits beside it');
        assert.strictEqual(left[0].members.length, 3);
        assert.strictEqual(left[0].kind, 'subagent', 'a subagent outranks an edit');
        assert.strictEqual(left[0].px, 0.100 * 400, 'drawn at its first member, so buttons never overlap');
        for (const lane of ['left', 'mid', 'right']) {
            const pxs = c.filter(k => k.lane === lane).map(k => k.px);
            for (let i = 1; i < pxs.length; i++) assert.ok(pxs[i] - pxs[i - 1] >= 4, `${lane} lane keeps its gap`);
        }
        const right = c.filter(k => k.lane === 'right');
        assert.deepStrictEqual(right.map(k => k.kind), ['error', 'error']);
        const mid = c.filter(k => k.lane === 'mid');
        assert.strictEqual(mid.length, 1, 'lanes never merge into each other');
        assert.strictEqual(mid[0].px, 40);
        // Sorted by position across lanes, so tab order runs down the rail.
        const px = c.map(k => k.px);
        assert.deepStrictEqual(px, px.slice().sort((a, b) => a - b));
        ok('marks within a few pixels in one lane cluster, and keep the most telling kind');
    }
    {
        // A taller rail pulls them apart.
        const placed = [{ key: 'a', kind: 'edit', y: 0.1 }, { key: 'b', kind: 'edit', y: 0.105 }];
        assert.strictEqual(clusterMarks(placed, 400, 4).length, 1);
        assert.strictEqual(clusterMarks(placed, 2000, 4).length, 2);
        // A chain of marks each 3px apart does not snowball into one cluster:
        // the gap is from the cluster's first, not its last.
        const chain = Array.from({ length: 10 }, (_, i) => ({ key: `c${i}`, kind: 'edit', y: (i * 3) / 1000 }));
        assert.strictEqual(clusterMarks(chain, 1000, 4).length, 5);
        assert.ok(PRIORITY.error > PRIORITY.pr && PRIORITY.pr > PRIORITY.plan
            && PRIORITY.subagent > PRIORITY.turn && PRIORITY.turn > PRIORITY.edit);
        ok('clusters depend on height, never chain, and rank error > pr > plan > subagent > turn > edit');
    }

    // --- the band ----------------------------------------------------------
    {
        // Four turns loaded, tops at 0, 100, 300, 600; the log ends at 1000.
        const tops = [0, 100, 300, 600];
        const topOf = (i) => tops[i];
        assert.strictEqual(turnAt(-50, 4, topOf, 1000), 0, 'above the first loaded turn');
        assert.strictEqual(turnAt(50, 4, topOf, 1000), 0.5);
        assert.strictEqual(turnAt(300, 4, topOf, 1000), 2);
        assert.strictEqual(turnAt(800, 4, topOf, 1000), 3.5);
        assert.strictEqual(turnAt(5000, 4, topOf, 1000), 4, 'past the end');
        assert.strictEqual(turnAt(10, 0, topOf, 1000), 0, 'nothing loaded');
        ok('turnAt finds the fractional turn under a position');

        // The last 4 of 8 turns are loaded.
        const at = (viewTop, viewBottom) => viewBand({ viewTop, viewBottom, count: 4, topOf,
            endTop: 1000, first: 4, total: 8 });
        // Pinned to the bottom: the band reaches the end of the rail.
        assert.deepStrictEqual(at(600, 1000), [7 / 8, 1]);
        // At the top of what is loaded: the band starts at the first loaded turn.
        assert.deepStrictEqual(at(-200, 100), [4 / 8, 5 / 8]);
        // In the middle.
        const [y0, y1] = at(200, 450);
        assert.strictEqual(y0, (4 + 1.5) / 8);
        assert.strictEqual(y1, (4 + 2.5) / 8);
        // Everything loaded, one turn: the whole rail.
        assert.deepStrictEqual(viewBand({ viewTop: 0, viewBottom: 500, count: 1, topOf: () => 0,
            endTop: 400, first: 0, total: 1 }), [0, 1]);
        ok('the band covers what is on screen, reaches the bottom when pinned, and handles one turn');
    }

    console.log(`minimap: ${pass} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
