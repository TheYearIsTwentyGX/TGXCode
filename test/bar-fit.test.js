'use strict';

// What the top bar gives up in a narrow window — web/bar-fit.js.
//
// No bridge needed. The cases worth pinning are the order things are given up
// in (words before buttons, buttons from the end, never the quota pill), the
// More button's own width being paid for exactly once, and the band where the
// answer must not change: a bar that flipped between two layouts as a badge
// ticked or a window was dragged a pixel at a time would be worse than either.

const assert = require('assert');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

process.removeAllListeners('warning');

(async () => {
    const { planBar } = await import('../web/bar-fit.js');

    // Six view buttons 100 wide (40 without words), then the quota pill (200,
    // never moves) and DevBrowser (100, 60). 300 of wordmark and search floor.
    const items = [
        ...['tasks', 'live', 'dashboard', 'history', 'drafts', 'schedules']
            .map(id => ({ id, full: 100, compact: 40, spillable: true })),
        { id: 'quota', full: 200, compact: 200, spillable: false },
        { id: 'devbrowser', full: 100, compact: 60, spillable: true },
    ];
    const base = { fixed: 300, items, more: 40 };
    const fullW = 300 + 600 + 200 + 100;      // 1200
    const compactW = 300 + 240 + 200 + 60;    // 800
    const plan = (avail, extra = {}) => planBar({ ...base, avail, ...extra });

    assert.deepStrictEqual(plan(fullW), { compact: false, spill: [] });
    assert.deepStrictEqual(plan(2000), { compact: false, spill: [] });
    ok('a bar that fits gives up nothing');

    assert.deepStrictEqual(plan(fullW - 1), { compact: true, spill: [] });
    assert.deepStrictEqual(plan(compactW), { compact: true, spill: [] });
    ok('the words go before any button does');

    // 799: compact is 800, and spilling means paying 40 for More, so DevBrowser
    // (60) alone gets it to 780.
    assert.deepStrictEqual(plan(compactW - 1), { compact: true, spill: ['devbrowser'] });
    // 760 needs 80 out: DevBrowser (60) then Schedules (40) — the quota pill,
    // between them, is skipped rather than ending the walk.
    assert.deepStrictEqual(plan(740), { compact: true, spill: ['schedules', 'devbrowser'] });
    ok('buttons leave from the end, in bar order, past the quota pill');

    const tight = plan(100);
    assert.ok(!tight.spill.includes('quota'));
    assert.strictEqual(tight.spill.length, 7);
    ok('the quota pill stays on the bar however narrow it gets');

    // Settings already put something in More: its 40 is in the bar's width
    // from the start, and is not charged again when something spills.
    assert.deepStrictEqual(plan(compactW + 40, { moreShown: true }), { compact: true, spill: [] });
    assert.deepStrictEqual(plan(compactW + 39, { moreShown: true }), { compact: true, spill: ['devbrowser'] });
    ok('the More button is paid for once');

    // Hysteresis. Spilled at 799; back at 805 there is room again, but not 24
    // pixels of it, so the spill stays. At 824 it comes back.
    const spilled = plan(compactW - 1);
    assert.deepStrictEqual(plan(compactW + 5, { prev: spilled, slack: 24 }), spilled);
    assert.deepStrictEqual(plan(compactW + 24, { prev: spilled, slack: 24 }), { compact: true, spill: [] });
    // And compact holds through the same band below the full width.
    const compact = plan(fullW - 1);
    assert.deepStrictEqual(plan(fullW, { prev: compact, slack: 24 }), compact);
    assert.deepStrictEqual(plan(fullW + 24, { prev: compact, slack: 24 }), { compact: false, spill: [] });
    ok('giving something back takes room to spare');

    // Going the other way needs no slack: narrower than it fits is narrower.
    assert.deepStrictEqual(plan(740, { prev: compact, slack: 24 }), { compact: true, spill: ['schedules', 'devbrowser'] });
    ok('giving something up never waits');

    // A remembered spill that names a button no longer on the bar (Settings
    // moved it, or hid it) is not held on to.
    const stale = { compact: true, spill: ['gone'] };
    const out = plan(compactW + 5, { prev: stale, slack: 24 });
    assert.ok(!out.spill.includes('gone'));
    ok('a stale plan is dropped rather than kept by the slack');

    console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
