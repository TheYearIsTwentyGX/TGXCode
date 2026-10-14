'use strict';

// The polling viewer's lease — bridge/viewers.js.
//
// What it gets wrong does not throw. A lease that never lapses holds every ask
// open for a phone that was put away an hour ago, so the turn waits forever; a
// lease that lapses too early auto-denies an ask the person was about to answer.
// Neither shows up anywhere but in the outcome, so each is pinned here on a
// clock the test owns.

const assert = require('assert');
const { ViewerLeases, LEASE_MS } = require('../bridge/viewers.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

let t = 1_000_000;
const now = () => t;

{
    const l = new ViewerLeases({ now });
    assert.strictEqual(l.active(), 0);
    assert.strictEqual(l.touch('phone'), true);
    assert.strictEqual(l.active(), 1);
    t += LEASE_MS - 1;
    assert.strictEqual(l.active(), 1, 'still live a moment before the lease runs out');
    t += 1;
    assert.strictEqual(l.active(), 0, 'gone the moment it does');
    ok('a lease lasts thirty seconds and no longer');
}

{
    const l = new ViewerLeases({ now });
    l.touch('phone');
    t += LEASE_MS - 1000;
    l.touch('phone');
    t += LEASE_MS - 1000;
    assert.strictEqual(l.active(), 1, 'each poll renews it');
    l.touch('phone');
    assert.strictEqual(l.active(), 1, 'one client is one lease however often it polls');
    ok('polling keeps the lease alive, as one lease');
}

{
    const l = new ViewerLeases({ now });
    for (const id of ['', '   ', undefined, null, 42]) {
        assert.strictEqual(l.touch(id), false, `${JSON.stringify(id)} is not a lease`);
    }
    assert.strictEqual(l.active(), 0);
    l.touch('x'.repeat(500));
    l.touch('x'.repeat(200));
    assert.strictEqual(l.active(), 1, 'ids are clipped, so two long ids sharing a prefix are one');
    ok('a blank or non-string id holds nothing, and a long one is clipped');
}

{
    const l = new ViewerLeases({ now, max: 3 });
    l.touch('a'); l.touch('b'); l.touch('c');
    l.touch('a');           // renewed, so b is now the longest silent
    l.touch('d');
    assert.strictEqual(l.active(), 3);
    assert.deepStrictEqual([...l.leases.keys()].sort(), ['a', 'c', 'd']);
    ok('the table is bounded, and evicts the longest-silent client first');
}

console.log(`viewers: ${pass} passed`);
