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
    const { planBar, resolveLayout } = await import('../web/bar-fit.js');

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

    // The slack holds only while the window holds still. Compacted at 1100 and
    // widened to 1210, the words fit with 10 to spare: less than the slack, but
    // the window moved, so they come back — this is the window that opened small
    // and was maximised, and sat in icons at a width with room for its labels.
    const narrowed = plan(1100);
    assert.deepStrictEqual(plan(fullW + 10, { prev: narrowed, prevAvail: 1100, slack: 24 }), { compact: false, spill: [] });
    // Spilled at 799 and widened to 805: the spill comes back too.
    assert.deepStrictEqual(plan(compactW + 5, { prev: spilled, prevAvail: compactW - 1, slack: 24 }), { compact: true, spill: [] });
    // At the same width — a badge that shrank back — the slack still holds.
    assert.deepStrictEqual(plan(fullW + 10, { prev: narrowed, prevAvail: fullW + 10, slack: 24 }), narrowed);
    ok('a window that widened gets the exact answer, not the held one');

    // Going the other way needs no slack: narrower than it fits is narrower.
    assert.deepStrictEqual(plan(740, { prev: compact, slack: 24 }), { compact: true, spill: ['schedules', 'devbrowser'] });
    ok('giving something up never waits');

    // A remembered spill that names a button no longer on the bar (Settings
    // moved it, or hid it) is not held on to.
    const stale = { compact: true, spill: ['gone'] };
    const out = plan(compactW + 5, { prev: stale, slack: 24 });
    assert.ok(!out.spill.includes('gone'));
    ok('a stale plan is dropped rather than kept by the slack');

    // ── resolveLayout: where a button the saved list never mentioned lands ──
    // The catalogue's tail as web/settings/toolbar.js has it.
    const CAT = [
        { id: 'schedules' },
        { id: 'hooks', start: 'more' },
        { id: 'settings', label: false, places: ['bar', 'more'] },
        { id: 'phoneInstalls', before: 'quota' },
        { id: 'quota', places: ['bar'] },
        { id: 'devbrowser' },
    ];
    const lay = (saved) => resolveLayout(CAT, saved).map(o => `${o.def.id}:${o.place}`);

    assert.deepStrictEqual(lay(undefined),
        ['schedules:bar', 'hooks:more', 'settings:bar', 'phoneInstalls:bar', 'quota:bar', 'devbrowser:bar']);
    // Saved before the phone pill could be placed, with Settings moved to the
    // front: the pill goes beside quota, where it always sat, not after Settings.
    const old = [
        { id: 'settings', place: 'more', label: false }, { id: 'schedules', place: 'bar', label: true },
        { id: 'hooks', place: 'more', label: true }, { id: 'devbrowser', place: 'bar', label: true },
        { id: 'quota', place: 'bar', label: true },
    ];
    assert.deepStrictEqual(lay(old),
        ['settings:more', 'schedules:bar', 'hooks:more', 'devbrowser:bar', 'phoneInstalls:bar', 'quota:bar']);
    ok('a layout saved before the phone pill puts it right before quota, on the bar');

    for (const place of ['more', 'hidden', 'bar']) {
        const saved = [{ id: 'phoneInstalls', place, label: true }, ...old];
        assert.deepStrictEqual(lay(saved)[0], `phoneInstalls:${place}`);
    }
    // A place the catalogue does not allow falls back to the bar.
    assert.ok(lay([{ id: 'quota', place: 'hidden' }]).includes('quota:bar'));
    ok('the phone pill keeps the place and position it was saved with');

    console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
