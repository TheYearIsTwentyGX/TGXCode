'use strict';

// Exercises the one rule in bridge/taskboard.js that decides what the board
// says: which column a session lands in.
//
// A pure function over a summary and a runner status, so every case here is a
// table row rather than a live bridge in a particular mood. The states it
// distinguishes are the ones you cannot conveniently arrange on demand — a
// session erroring, a queue behind a stopped turn, a process in somebody else's
// terminal — which is exactly why they are worth a test.
//
// It is deliberately the same predicate set as `why()` in overview.js. If the
// two ever disagree, one of the two boards is lying about what "blocked" means,
// and the last three cases here are the ones that would catch it.

const assert = require('assert');
const { column } = require('../bridge/taskboard.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const is = (want, s, runner, name) => {
    const got = column(s, runner);
    assert.strictEqual(got, want, `${name}: got ${got}, wanted ${want}`);
    ok(name);
};

// --- off the board --------------------------------------------------------
// Archiving is the gesture for "not this, not now", and the board is what it is
// for. It beats every other state: an archived session with a live process is
// still archived.
is(null, { archived: true }, null, 'an archived session is off the board');
is(null, { archived: true }, { state: 'busy' }, 'archived beats busy');
is(null, { archived: true }, { pendingPermission: { kind: 'tool' } }, 'archived beats an ask');

// --- needs you ------------------------------------------------------------
is('needs', {}, { state: 'busy', pendingPermission: { kind: 'tool' } },
    'a pending tool permission needs you');
is('needs', {}, { state: 'idle', pendingPermission: { kind: 'plan' } },
    'a plan to approve needs you');
is('needs', {}, { state: 'idle', pendingPermission: { kind: 'question' } },
    'a question needs you');
is('needs', {}, { state: 'error', error: 'overloaded' }, 'a turn that failed needs you');

// An ask outranks the state it arrived in. A session is busy right up to the
// moment it asks, so reading `state` first would put every permission prompt in
// the wrong column.
is('needs', {}, { state: 'busy', pendingPermission: { kind: 'tool' } },
    'an ask outranks busy');

// --- working --------------------------------------------------------------
is('working', {}, { state: 'busy' }, 'a running turn is working');
is('working', {}, { state: 'starting' }, 'a session still starting is working');

// Messages waiting behind a turn that is no longer running will never go out on
// their own. That is work in flight from where the user sits, whatever the
// runner calls itself.
is('working', {}, { state: 'idle', queued: 2 }, 'a queue behind a stopped turn is working');
is('idle', {}, { state: 'idle', queued: 0 }, 'an empty queue is not');

// The registry's own answer, for a process this bridge did not start — a
// terminal, VS Code, a background agent.
is('working', { live: { running: true } }, null, 'a process running elsewhere is working');

// ...but only when it is *not* ours. A runner we own is never "elsewhere",
// however idle it is; saying so once told the user their own session was
// running in another window.
is('idle', { live: { running: true } }, { state: 'idle' },
    'our own idle runner is idle, not elsewhere');

// A registry entry for a process that has gone away.
is('idle', { live: { running: false } }, null, 'a dead registry entry is idle');

// --- idle -----------------------------------------------------------------
is('idle', {}, null, 'a session with no process is idle');
is('idle', {}, { state: 'stopped' }, 'a stopped runner is idle');

// A pin is a reason to draw a card on the live board, where a session with no
// state of its own would otherwise get none. Here every session gets a card, so
// a pin says nothing about which column — it is still just idle.
is('idle', { pinned: true }, null, 'a pinned idle session is idle');

console.log(`\n${pass} passed`);
