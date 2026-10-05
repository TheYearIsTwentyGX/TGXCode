'use strict';

// What a new window opens to — web/startup.js.
//
// No bridge needed. The cases worth pinning are the ones where Settings must
// *not* win: a refresh, which reaches the same bare address as a launch when
// nothing was open; an address somebody opened on purpose; and a notification
// pressed with no window up, whose conversation must not come up under a panel.

const assert = require('assert');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

process.removeAllListeners('warning');

(async () => {
    const { startupQuery } = await import('../web/startup.js');
    const launch = { navType: 'navigate', search: '', hash: '' };
    const dashLive = { view: 'dashboard', live: true };
    const q = (prefs, nav = launch) => {
        const r = startupQuery(prefs, nav);
        return r && r.toString();
    };

    assert.strictEqual(q(dashLive, { ...launch, navType: 'reload' }), null);
    ok('a reload restores the address, never the startup choice');

    assert.strictEqual(q(dashLive, { ...launch, search: '?session=abc' }), null);
    assert.strictEqual(q(dashLive, { ...launch, search: '?view=drafts' }), null);
    ok('an address that names something wins');

    assert.strictEqual(q(dashLive, { ...launch, hash: '#/session/abc' }), null);
    ok('a notification deep link is not covered by a panel');

    assert.strictEqual(q({ view: 'conversation', live: false }), null);
    assert.strictEqual(q(undefined), null);
    assert.strictEqual(q({}), null);
    ok('the defaults, or no prefs at all, open nothing — what a launch always did');

    assert.strictEqual(q(dashLive), 'view=dashboard&live=1');
    assert.strictEqual(q({ view: 'conversation', live: true }), 'view=live');
    assert.strictEqual(q({ view: 'taskboard', live: false }), 'view=taskboard');
    assert.strictEqual(q(dashLive, { ...launch, navType: 'back_forward' }), 'view=dashboard&live=1');
    assert.strictEqual(q(dashLive, { ...launch, search: '?' }), 'view=dashboard&live=1');
    ok('a launch gets the address rememberView would have written for that view');

    console.log(`${pass} startup checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
