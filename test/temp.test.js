'use strict';

// The /tmp rule, which decides whether a session appears in any list.
//
// It is here rather than checked against a live bridge because the boundary that
// matters — /tmpfoo must not match — needs a directory only root can create, and
// it is exactly the case a future `startsWith('/tmp')` would silently break.

const assert = require('assert');
const { isTemp } = require('../bridge/sessions.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// --- what scratch space actually looks like on this machine ---------------
for (const p of [
    '/tmp',
    '/tmp/',
    '/tmp/probe-6Ivg5W',
    '/tmp/perm-test',
    '/tmp/claude-1000/-home-dylan-hays-Other-claude-sessions/3f4edaf4/scratchpad',
]) {
    assert.strictEqual(isTemp(p), true, p);
}
ok('/tmp and everything under it is scratch');

// --- the boundary ---------------------------------------------------------
// A prefix test without the separator would call all of these scratch.
for (const p of ['/tmpfoo', '/tmp-probe', '/tmpy/x', '/home/dylan_hays/tmp',
    '/home/dylan_hays/Other/claude-sessions', '/var/tmp/x']) {
    assert.strictEqual(isTemp(p), false, p);
}
ok('a name merely beginning with tmp is not scratch');

// --- nothing at all -------------------------------------------------------
for (const p of ['', null, undefined]) {
    assert.strictEqual(isTemp(p), false, String(p));
}
ok('a missing path is not scratch');

console.log(`\n${pass} groups passed`);
