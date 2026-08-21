'use strict';

// Handing work to another session: the wrapper, and the two counts a handoff
// must not disturb.
//
// Here rather than against a live bridge because the case that matters cannot be
// reached from one. A handoff is delivered down `claude`'s stdin as an ordinary
// user message — it carries none of the `isMeta` flagging that keeps a peer
// message out of the turn counts — so the only thing standing between "one agent
// handed work to another" and "the session list quietly reordered itself" is the
// gate in scanMeta. Asserting that needs a transcript, not a request.
//
// The rate limiter is exercised here too, for the same reason as `restart`: the
// interesting behaviour is a refusal, and provoking it against a live bridge
// would mean starting real turns.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    handoffEnvelope, parseHandoff, isHandoff, scanMeta,
} = require('../bridge/transcript.js');
const { HandoffLimit, stateOf, wakes, wakeFailure } = require('../bridge/handoff.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-handoff-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ } });

// --- the wrapper round-trips ----------------------------------------------

const MSG = 'GET /api/sites returns {sites:[…]} now, not a bare array.\n\nweb/mobile.js:412 unwraps the old shape.';
const wrapped = handoffEnvelope({
    text: MSG,
    fromId: '0f8c3a1e-1111-2222-3333-444455556666',
    fromTitle: 'sitevisits API',
    fromProject: 'LTCDataPlus',
    title: 'API shape changed',
});

const parsed = parseHandoff(wrapped);
assert.ok(parsed, 'a wrapped message is recognised');
assert.strictEqual(parsed.text, MSG);
assert.strictEqual(parsed.from, '0f8c3a1e-1111-2222-3333-444455556666');
assert.strictEqual(parsed.fromTitle, 'sitevisits API');
assert.strictEqual(parsed.fromProject, 'LTCDataPlus');
assert.strictEqual(parsed.title, 'API shape changed');
ok('the message and the sender survive the wrapper');

// The trailer is addressed to the model, not to a reader. It must not reach the
// card — which is the same rule the peer wrapper's trailer follows.
assert.ok(!parsed.text.includes('plan mode'), 'the trailer is not part of the message');
assert.ok(wrapped.includes('plan mode'), 'but it is in what the model receives');
ok('the standing instructions stay out of what is rendered');

// --- provenance is optional -----------------------------------------------
// `from` is whatever the sending session was started as, and a session that has
// forked since reports an id nothing can look up. A card with no sender is worth
// drawing; a crash is not.
const bare = parseHandoff(handoffEnvelope({ text: 'something happened' }));
assert.ok(bare);
assert.strictEqual(bare.text, 'something happened');
assert.strictEqual(bare.from, null);
assert.strictEqual(bare.fromTitle, null);
ok('a handoff with no provenance still parses');

// `title` reaches the envelope from a model. A quote would close the attribute
// early and a `>` would close the tag, and either one spills the rest of the
// header into the message body.
const quoted = parseHandoff(handoffEnvelope({
    text: 'x', fromTitle: 'the "good" branch', title: 'a > b',
}));
assert.strictEqual(quoted.fromTitle, 'the good branch');
assert.strictEqual(quoted.title, 'a  b');
assert.strictEqual(quoted.text, 'x', 'nothing from the header leaked into the body');
ok('a quote or a bracket in an attribute cannot break out of the tag');

// --- anchoring -------------------------------------------------------------
// An agent quoting a handoff it received is a turn somebody took. The same trade
// the peer parse and the task-notification parse both make.
for (const t of [
    `Here is what I was sent:\n\n${wrapped}`,
    'I would use <session-handoff> for this but it is not mine to send',
    '', null, undefined,
]) {
    assert.strictEqual(isHandoff(t), false, JSON.stringify(String(t).slice(0, 40)));
    assert.strictEqual(parseHandoff(t), null);
}
ok('a quoted handoff is not an arriving one');

// --- the counts a handoff must not move ------------------------------------

function transcript(name, lines) {
    const file = path.join(TMP, `${name}.jsonl`);
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    return file;
}

const said = (text, timestamp) => ({
    type: 'user',
    timestamp,
    cwd: '/home/dylan_hays/Other/claude-sessions',
    message: { role: 'user', content: [{ type: 'text', text }] },
});

const before = scanMeta(transcript('before', [
    said('have a look at the importer', '2026-08-21T10:00:00.000Z'),
    said('yes, that one', '2026-08-21T10:05:00.000Z'),
]));
const after = scanMeta(transcript('after', [
    said('have a look at the importer', '2026-08-21T10:00:00.000Z'),
    said('yes, that one', '2026-08-21T10:05:00.000Z'),
    said(wrapped, '2026-08-21T18:30:00.000Z'),
]));

assert.strictEqual(before.userMessages, 2);
assert.strictEqual(after.userMessages, 2, 'a handoff is not a turn the user took');
ok('a handoff does not count as a turn');

assert.strictEqual(after.lastUserTs, before.lastUserTs,
    'lastUserTs is what the rail sorts on — a handoff must not move it');
ok('a handoff does not reorder the session list');

assert.strictEqual(before.handoffs, 0);
assert.strictEqual(after.handoffs, 1);
assert.strictEqual(after.lastHandoffFrom, 'sitevisits API');
assert.strictEqual(after.lastHandoffTs, '2026-08-21T18:30:00.000Z');
ok('but it is counted, so the bridge can notice it arriving');

// Two handoffs are two, because this bridge wrote them and wrote each once —
// unlike a peer message, which can reach disk twice and is deduplicated on id.
const twice = scanMeta(transcript('twice', [
    said(wrapped, '2026-08-21T18:30:00.000Z'),
    said(handoffEnvelope({ text: 'and another thing', fromTitle: 'importer' }),
        '2026-08-21T18:40:00.000Z'),
]));
assert.strictEqual(twice.handoffs, 2);
assert.strictEqual(twice.lastHandoffFrom, 'importer');
assert.strictEqual(twice.userMessages, 0);
ok('two handoffs count as two, and still as no turns');

// A message *quoting* the wrapper is a turn, and must be counted as one. This is
// the other half of the anchoring rule, and the half a substring gate would get
// wrong.
const discussed = scanMeta(transcript('discussed', [
    said(`I was handed this:\n\n${wrapped}\n\nwhat do you make of it?`,
        '2026-08-21T19:00:00.000Z'),
]));
assert.strictEqual(discussed.userMessages, 1, 'quoting a handoff is a turn');
assert.strictEqual(discussed.handoffs, 0, 'and is not an arrival');
assert.strictEqual(discussed.lastUserTs, '2026-08-21T19:00:00.000Z');
ok('quoting a handoff counts as the turn it is');

// --- the loop guard --------------------------------------------------------
// The case this exists for: two agents that each think the other should know
// something, waking each other until somebody notices.

const A = 'aaaa1111';
const B = 'bbbb2222';
const C = 'cccc3333';
let t = 1_000_000;

const lim = new HandoffLimit();
assert.strictEqual(lim.refuse(A, B, t), null, 'the first one goes');
assert.ok(lim.refuse(A, B, t + 1_000), 'the second one to the same session does not');
ok('the same pair cannot hand off twice inside the minute');

// The reply must be usable by the model that reads it: a refusal that only says
// "429" leaves it with nothing to do but try again.
assert.match(lim.refuse(A, B, t + 1_000), /reply/, 'says what to do instead');
ok('and the refusal says what to do instead');

// The ping-pong, which is the shape that actually loops. B answering A is a
// different pair, so it is allowed — one exchange is a conversation. What stops
// it going round again is that each direction is then on its own cooldown.
assert.strictEqual(lim.refuse(B, A, t + 2_000), null, 'the reply direction is its own pair');
assert.ok(lim.refuse(A, B, t + 3_000), 'but A cannot come straight back');
assert.ok(lim.refuse(B, A, t + 3_000), 'and nor can B');
ok('a handoff and its answer are allowed; a third message is not');

// And a different recipient is a different pair, so a fan-out is not stopped by
// the pair window — it is stopped by the hourly one, below.
assert.strictEqual(lim.refuse(A, C, t + 4_000), null);
ok('a different recipient is a different pair');

// Once the pair window is past, the same pair may hand off again. A long session
// that genuinely learns something new an hour later is not a loop.
assert.strictEqual(lim.refuse(A, B, t + 61_000), null);
ok('after the minute, the same pair may hand off again');

// The fan-out limit. Fresh, so the three above do not count against it.
const fan = new HandoffLimit();
t = 2_000_000;
for (let i = 0; i < fan.max; i++) {
    assert.strictEqual(fan.refuse(`s${i}`, `d${i}`, t + i), null, `handoff ${i}`);
}
const stopped = fan.refuse('sX', 'dX', t + fan.max);
assert.ok(stopped, 'the one after the cap is refused');
assert.match(stopped, /looping/);
ok(`${fan.max} handoffs in the hour is the cap, whoever sent them`);

// And it lifts once the window has rolled past.
assert.strictEqual(fan.refuse('sX', 'dX', t + fan.windowMs + 1), null);
ok('the hourly cap lifts as the window rolls');

// A caller that will not say who it is shares one bucket with every other such
// caller — the tighter limit, which is the safe direction to be wrong in.
const anon = new HandoffLimit();
t = 3_000_000;
assert.strictEqual(anon.refuse(null, B, t), null);
assert.ok(anon.refuse(undefined, B, t + 1_000), 'no provenance means one shared bucket');
ok('a handoff with no sender gets the tighter limit');

// Pair entries are dropped once they can no longer refuse anything, so a bridge
// that runs for weeks does not accumulate one per pair that ever spoke.
const kept = new HandoffLimit();
t = 4_000_000;
for (let i = 0; i < 50; i++) kept.refuse(`from${i}`, `to${i}`, t + i * 10_000);
assert.ok(kept.pairs.size < 10, `pairs pruned, held ${kept.pairs.size}`);
ok('the pair table is pruned rather than grown');

// --- what a handoff would run into ----------------------------------------
// Three answers where the taskboard gives two, because "busy" and "not ours"
// mean different things here: one is queued, the other is refused.

const dead = { live: null };
const elsewhere = { live: { running: true } };

assert.strictEqual(stateOf(dead, null), 'idle', 'no process anywhere');
assert.strictEqual(stateOf(dead, { state: 'stopped', queued: 0 }), 'idle', 'our runner, stopped');
assert.strictEqual(stateOf(dead, { state: 'idle', queued: 0 }), 'idle', 'our runner, waiting');
assert.strictEqual(stateOf(dead, { state: 'busy', queued: 0 }), 'working');
assert.strictEqual(stateOf(dead, { state: 'starting', queued: 0 }), 'working');
assert.strictEqual(stateOf(dead, { state: 'idle', queued: 2 }), 'working', 'messages waiting');
assert.strictEqual(stateOf(elsewhere, null), 'elsewhere', 'a process, and not ours');
// The distinction the taskboard's `column` deliberately loses: a process we
// started is never "elsewhere", however idle it looks.
assert.strictEqual(stateOf(elsewhere, { state: 'idle', queued: 0 }), 'idle',
    'ours, so resumable, even with a registry entry');
ok('idle, working and elsewhere are told apart');

assert.strictEqual(wakes(null), true, 'no runner at all');
assert.strictEqual(wakes({ state: 'stopped' }), true);
assert.strictEqual(wakes({ state: 'error' }), true, 'a failed runner is replaced');
assert.strictEqual(wakes({ state: 'idle' }), false, 'already up');
assert.strictEqual(wakes({ state: 'busy' }), false);
ok('waking is told apart from joining something already up');

// --- a handoff that never landed ------------------------------------------
// The failure that is worse here than in the composer. When `claude --resume` is
// refused — a session id still locked by a process that was killed — the runner
// hands the unsent text back, and a person gets it returned to their composer. A
// handoff has nobody to hand it back to: the sender is finishing its turn and is
// about to tell the user it passed the work on. So the route has to notice.

(async () => {
    const { EventEmitter } = require('events');

    // Failed before anything could be attached: a spawn that threw outright.
    const alreadyDead = Object.assign(new EventEmitter(), {
        state: 'error', errorKind: 'busy-elsewhere', lastError: 'Session ID x is already in use.',
    });
    const already = await wakeFailure(alreadyDead, 50);
    assert.ok(already, 'a runner already in error is a failure');
    assert.strictEqual(already.kind, 'busy-elsewhere');
    assert.match(already.message, /already in use/);
    ok('a spawn that failed before we looked is still reported');

    // The ordinary shape: the process starts, then exits refusing to resume.
    const late = Object.assign(new EventEmitter(), { state: 'starting' });
    setTimeout(() => late.emit('failed', {
        kind: 'busy-elsewhere', message: 'running somewhere else', unsent: ['the message'],
    }), 10);
    const failed = await wakeFailure(late, 2_000);
    assert.ok(failed);
    assert.strictEqual(failed.kind, 'busy-elsewhere');
    ok('a resume refused a moment later is reported too');

    // And the happy path: still booting when the grace elapses, which is normal
    // and is not a failure. Nothing here waits for success.
    //
    // The keepalive is load-bearing and worth explaining rather than deleting.
    // wakeFailure's timer is unref'd, so it cannot hold the bridge open while it
    // shuts down mid-handoff — which also means that in a process with nothing
    // else pending, node exits before the grace elapses. The bridge always has a
    // listening server and an open response socket; a test has neither, so it
    // supplies the thing the bridge already has.
    const booting = Object.assign(new EventEmitter(), { state: 'starting' });
    const keepalive = setTimeout(() => {}, 5_000);
    assert.strictEqual(await wakeFailure(booting, 30), null);
    clearTimeout(keepalive);
    ok('a session still booting is not treated as a failure');
    // The listener is removed either way, or a long-lived runner accumulates one
    // per handoff it ever received.
    assert.strictEqual(booting.listenerCount('failed'), 0);
    assert.strictEqual(late.listenerCount('failed'), 0);
    ok('and the watcher does not outlive the wait');

    console.log(`\n${pass} groups passed`);
})();
