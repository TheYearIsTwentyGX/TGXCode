'use strict';

// Where a composer scrolls to show its caret — web/composer/caret.js.
//
// No bridge needed. `revealTop` is the arithmetic; the mirror that measures the
// caret's line needs a browser. What is pinned is that it moves only when it has
// to and only as far as it has to: a box that jumps on every insertion reads as
// broken as one that never moves.

const assert = require('assert');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

process.removeAllListeners('warning');

(async () => {
    const { revealTop } = await import('../web/composer/caret.js');
    const at = (top, scrollTop, max) => revealTop({ top, bottom: top + 20, scrollTop, height: 200, max });

    assert.strictEqual(at(50, 0), 0);
    assert.strictEqual(at(180, 0), 0, 'a line touching the bottom edge is in view');
    assert.strictEqual(at(150, 100), 100);
    ok('a line already in view leaves the scroll alone');

    assert.strictEqual(at(500, 0), 320, 'below: just far enough to sit at the bottom edge');
    assert.strictEqual(at(40, 300), 40, 'above: just far enough to sit at the top edge');
    ok('a line out of view is brought to the nearer edge');

    assert.strictEqual(at(500, 0, 250), 250, 'never past the end');
    assert.strictEqual(at(-5, 100), 0, 'never above the start');
    assert.strictEqual(revealTop({ top: 0, bottom: 400, scrollTop: 50, height: 200 }), 0,
        'a line taller than the box shows its top');
    ok('clamped to the scroll range');

    console.log(`\n${pass} groups passed`);
})().catch((err) => { console.error(err); process.exit(1); });
