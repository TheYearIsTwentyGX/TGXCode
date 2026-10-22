'use strict';

// Whether the live board stays up over a panel, and how — web/live-over.js.
//
// No bridge needed. The case worth pinning is the one that was reported as the
// setting not working: every screen on Stacked, the dock toggle on Side by side.
// Under the old rule `stacked` meant "only while the toggle says Stacked", so
// that combination covered the board on every screen.

const assert = require('assert');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

process.removeAllListeners('warning');

(async () => {
    const { liveOverDock, liveOverFixed } = await import('../web/live-over.js');

    assert.strictEqual(liveOverDock('stacked', 'side'), 'bottom');
    assert.strictEqual(liveOverDock('stacked', 'bottom'), 'bottom');
    ok('stacked keeps the board under the screen, whatever the toggle says');

    assert.strictEqual(liveOverDock('side', 'bottom'), 'side');
    assert.strictEqual(liveOverDock('side', 'side'), 'side');
    ok('side keeps the board beside the screen, whatever the toggle says');

    assert.strictEqual(liveOverDock('always', 'side'), 'side');
    assert.strictEqual(liveOverDock('always', 'bottom'), 'bottom');
    ok('always keeps the board and follows the toggle');

    for (const dock of ['side', 'bottom']) {
        assert.strictEqual(liveOverDock('hidden', dock), null);
        assert.strictEqual(liveOverDock(undefined, dock), null);
        assert.strictEqual(liveOverDock(null, dock), null);
        assert.strictEqual(liveOverDock('bogus', dock), null);
    }
    ok('hidden, a panel with no setting, and anything unknown cover the board');

    assert.ok(liveOverFixed('side') && liveOverFixed('stacked'));
    assert.ok(!liveOverFixed('always') && !liveOverFixed('hidden') && !liveOverFixed(null));
    ok('only side and stacked take the arrangement away from the toggle');

    // The four values the bridge accepts are the four this answers for, so a
    // fifth added to one and not the other shows up here rather than as a radio
    // that saves and does nothing.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../bridge/prefs.js'), 'utf8');
    const accepted = JSON.parse(src.match(/const LIVE_OVER = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
    assert.deepStrictEqual(accepted, ['hidden', 'always', 'side', 'stacked']);
    ok('the bridge accepts exactly the values the rule knows');

    console.log(`${pass} live-over checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
