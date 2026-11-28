'use strict';

// The rail's bulk fold and the keyboard walks — web/rail-nav.js.
//
// No bridge needed. Pinned: Collapse all becomes Expand all only once *every*
// drawn card is shut (and never for an empty rail); the walks stop at the ends rather than wrap.

const assert = require('assert');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

process.removeAllListeners('warning');

(async () => {
    const { allShut, stepId, stepTurn } = await import('../web/rail-nav.js');

    const shut = new Set(['a', 'b']);
    assert.strictEqual(allShut(['a', 'b'], k => shut.has(k)), true);
    assert.strictEqual(allShut(['a', 'b', 'c'], k => shut.has(k)), false);
    assert.strictEqual(allShut([], () => true), false);
    ok('allShut needs every drawn card shut, and is false for none');

    const ids = ['s1', 's2', 's3'];
    assert.strictEqual(stepId(ids, 's2', 1), 's3');
    assert.strictEqual(stepId(ids, 's2', -1), 's1');
    assert.strictEqual(stepId(ids, 's3', 1), null);
    assert.strictEqual(stepId(ids, 's1', -1), null);
    assert.strictEqual(stepId(ids, null, 1), 's1');
    assert.strictEqual(stepId(ids, 'gone', -1), 's3');
    assert.strictEqual(stepId([], 's1', 1), null);
    ok('stepId walks the drawn rows and stops at the ends');

    assert.strictEqual(stepTurn(5, 2, 1), 3);
    assert.strictEqual(stepTurn(5, 4, 1), -1);
    assert.strictEqual(stepTurn(5, 0, -1), -1);
    assert.strictEqual(stepTurn(5, -1, -1), 4);
    assert.strictEqual(stepTurn(5, -1, 1), 0);
    assert.strictEqual(stepTurn(0, -1, 1), -1);
    ok('stepTurn walks the turns and stops at the ends');

    console.log(`\n${pass} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
