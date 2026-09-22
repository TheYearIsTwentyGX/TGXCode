'use strict';

// The scheduled-message store, on its own — no bridge.
//
// A unit test rather than a live one, drafts.test.js's argument: everything worth
// checking here is a pure question about one file, and the routes on top are thin
// enough that testing them would be testing http.
//
// **What it is really guarding is a set of bugs nobody would see happen.** This
// store's whole job runs at 2am. A message delivered twice, a message dropped
// because a claim was written and then forgotten, a message delivered seven hours
// after it stopped being true — none of those announce themselves, and all of them
// look identical to "it worked" from every surface the app has until somebody
// reads a transcript in the morning. schedule.test.js exists for the same reason
// one file over, and this is the same list of hazards a layer down.
//
// **XDG_DATA_HOME is set before the require, and that order is load-bearing.**
// bridge/config.js reads the variable once, at require time, to build STATE_DIR —
// so setting it afterwards would point the module at the real
// ~/.local/share/claude-sessions and this test would eat the user's real messages.
// drafts.test.js and ports.test.js do the same thing for the same reason.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-later-'));
process.env.XDG_DATA_HOME = home;

const {
    Later, STATE_FILE, LATE_MS, KEEP_MS, MAX_PER_SESSION,
} = require('../bridge/later');

// Where the module will actually write, now that the env var is in place. Asserted
// rather than assumed: if this ever pointed at the real directory the rest of the
// file would be destructive, so it is worth failing loudly on instead.
assert.ok(STATE_FILE.startsWith(home),
    `refusing to run: STATE_FILE is ${STATE_FILE}, outside the throwaway ${home}`);

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

/** A fresh store over a wiped file, so groups cannot leak into each other. */
function fresh() {
    try { fs.unlinkSync(STATE_FILE); } catch { /* first run */ }
    return new Later();
}

const MIN = 60_000;

/** The fields a caller has to give; the rest have defaults worth testing. */
function make(store, over = {}) {
    return store.create({
        sessionId: 's1',
        cwd: '/tmp/project',
        text: 'you may now modify app data',
        permissionMode: 'bypassPermissions',
        at: Date.now() + 30 * MIN,
        ...over,
    });
}

const FIELDS = ['at', 'attachments', 'createdAt', 'cwd', 'error', 'id', 'model',
    'permissionMode', 'sentAt', 'sessionId', 'state', 'test', 'text', 'updatedAt'];

// --- the wire shape -----------------------------------------------------

{
    const s = fresh();
    const row = make(s);
    assert.deepStrictEqual(Object.keys(row).sort(), FIELDS,
        'the stored shape is the whitelist');

    // `create` takes a patch straight off a request body one route away, so a key
    // it has never heard of must not reach the file. schedule.test.js asserts the
    // same thing about schedules and for the same reason.
    const sneaky = s.create({
        sessionId: 's1', cwd: '/tmp', text: 'hi', permissionMode: 'auto',
        at: Date.now() + MIN, evil: 'yes', state: 'sent',
    });
    assert.deepStrictEqual(Object.keys(sneaky).sort(), FIELDS);
    assert.strictEqual(sneaky.evil, undefined, 'an unknown key is dropped');
    assert.strictEqual(sneaky.state, 'pending',
        'and a caller cannot declare its own message already sent');
    ok('the wire shape is the whitelist, and a body cannot smuggle a key in');
}

// --- defaults worth being sure of ---------------------------------------

{
    const s = fresh();
    const row = make(s, { model: '  ' });
    assert.strictEqual(row.state, 'pending');
    assert.strictEqual(row.sentAt, null);
    assert.strictEqual(row.error, null);
    assert.strictEqual(row.test, false);
    assert.strictEqual(row.model, null, 'a blank model is `inherit`, not a model named " "');
    assert.deepStrictEqual(row.attachments, []);
    assert.strictEqual(row.createdAt, row.updatedAt,
        'a message nobody has edited reads as untouched');
    ok('the defaults are the ones the composer means');
}

// --- being late is not the same as being due ----------------------------

{
    const s = fresh();
    const now = Date.now();
    const soon = make(s, { at: now + 5 * MIN });
    const due = make(s, { at: now - MIN });
    const late = make(s, { at: now - LATE_MS - MIN });

    const ids = s.due(now).map(r => r.id);
    assert.ok(!ids.includes(soon.id), 'a message whose time has not come is not due');
    assert.ok(ids.includes(due.id), 'one whose time has come is');
    assert.ok(ids.includes(late.id),
        'and so is one that is past its window — telling those apart is the tick\'s '
        + 'job, because "deliver it" and "report it missed" both start here');

    // The rule the window exists for. A session started seven hours late is merely
    // late; "you may now modify app data" seven hours late is the wrong
    // instruction, and it arrives carrying the permission to act on itself.
    assert.ok(now - late.at > LATE_MS, 'the late one really is outside the window');
    assert.strictEqual(LATE_MS, 60 * 60 * 1000,
        'the window is an hour — far tighter than the schedule tick\'s 12h catch-up, '
        + 'on purpose');
    ok('due() answers "is it time", and leaves "is it too late" to the caller');
}

// --- the claim, which is what stops a message going twice ----------------

{
    const s = fresh();
    const row = make(s, { at: Date.now() - MIN });

    assert.strictEqual(s.claim(row.id), true);
    assert.strictEqual(s.get(row.id).state, 'delivering');

    // The claim is on disk before the caller does anything that can throw or
    // block — an exception *after* it is what loses a run silently, which is the
    // bug docs/plans/15-scheduling.md records under section C.
    const onDisk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.strictEqual(onDisk.messages.find(m => m.id === row.id).state, 'delivering',
        'the claim is flushed, not left to the 400ms debounce');

    assert.strictEqual(s.claim(row.id), false,
        'a second tick overlapping the first cannot also claim it');
    assert.deepStrictEqual(s.due(Date.now()).map(r => r.id), [],
        'and a claimed message is no longer due');
    ok('a claim goes to disk before the send, and only one tick can take it');
}

// --- a failure leaves `failed`, never `pending` --------------------------

{
    const s = fresh();
    const row = make(s, { at: Date.now() - MIN });
    s.claim(row.id);
    s.note(row.id, { state: 'failed', error: 'that session no longer exists' });

    const after = s.get(row.id);
    assert.strictEqual(after.state, 'failed');
    assert.strictEqual(after.error, 'that session no longer exists');
    assert.deepStrictEqual(s.due(Date.now()).map(r => r.id), [],
        'a failed message is never due again — the text is recoverable from the '
        + 'chip, and re-sending is a decision for a person');
    ok('a delivery that did not work is recorded, and does not come back');
}

// --- release, which is the one way back to pending ----------------------

{
    const s = fresh();
    const row = make(s, { at: Date.now() - MIN });
    s.claim(row.id);
    assert.strictEqual(s.release(row.id), true);
    assert.strictEqual(s.get(row.id).state, 'pending');
    assert.deepStrictEqual(s.due(Date.now()).map(r => r.id), [row.id],
        'released, it is due again — which is what "the session is held in a '
        + 'terminal" has to mean, since the terminal may close in a minute');

    // Only from `delivering`. Releasing anything else would be the double-delivery
    // the whole store is built to make impossible.
    s.note(row.id, { state: 'sent', sentAt: Date.now() });
    assert.strictEqual(s.release(row.id), false, 'a sent message cannot be released');
    assert.strictEqual(s.get(row.id).state, 'sent');
    ok('a claim can go back only while nothing has been attempted');
}

// --- a message is never delivered twice, including across a reload -------

{
    const s = fresh();
    const row = make(s, { at: Date.now() - MIN });
    s.claim(row.id);
    s.note(row.id, { state: 'sent', sentAt: Date.now() });
    s.flush();

    const reborn = new Later();
    assert.strictEqual(reborn.get(row.id).state, 'sent');
    assert.deepStrictEqual(reborn.due(Date.now()).map(r => r.id), [],
        'a bridge that restarts does not re-send what the last one sent');
    ok('a sent message survives a reload as sent, and is not due again');
}

// --- a bridge that died mid-delivery -------------------------------------

{
    const s = fresh();
    const row = make(s, { at: Date.now() - MIN });
    s.claim(row.id);
    s.flush();                       // the bridge stops here

    const reborn = new Later();
    assert.strictEqual(reborn.get(row.id).state, 'delivering',
        'the claim is still on disk, which is the whole point of flushing it');

    const stuck = reborn.recover();
    assert.strictEqual(stuck.length, 1);
    assert.strictEqual(reborn.get(row.id).state, 'failed');
    assert.match(reborn.get(row.id).error, /may already have arrived/);
    assert.deepStrictEqual(reborn.due(Date.now()).map(r => r.id), [],
        'recovered means failed, never retried: `claude` writes its user entry at '
        + 'submission, so re-sending would re-run work the transcript already shows');
    assert.deepStrictEqual(new Later().recover(), [],
        'and recovering twice finds nothing the second time');
    ok('a message interrupted mid-delivery fails loudly rather than going twice');
}

{
    // Every bridge on this machine shares STATE_DIR, so a pass that recovered
    // every claim would let a dev bridge coming up at 02:00:05 mark the everyday
    // bridge's in-flight message as failed — while it is being delivered perfectly
    // well, one process over. The caller passes the dev/test rule the tick uses.
    const s = fresh();
    const mine = make(s, { at: Date.now() - MIN, test: true });
    const theirs = make(s, { at: Date.now() - MIN, test: false });
    s.claim(mine.id);
    s.claim(theirs.id);

    const recovered = s.recover(r => r.test === true);
    assert.deepStrictEqual(recovered.map(r => r.id), [mine.id]);
    assert.strictEqual(s.get(theirs.id).state, 'delivering',
        'the other bridge\'s claim is left exactly where it was');
    ok('recovery only touches claims this bridge could have written');
}

// --- edits, and what cannot be edited ------------------------------------

{
    const s = fresh();
    const row = make(s, { at: Date.now() + 30 * MIN });

    const moved = s.update(row.id, { at: row.at + 60 * MIN });
    assert.strictEqual(moved.at, row.at + 60 * MIN);
    assert.strictEqual(moved.text, row.text, 'a genuine partial leaves the text alone');
    assert.strictEqual(moved.permissionMode, 'bypassPermissions',
        'and the mode — which is the trap /send has, and the reason this is a PATCH');
    assert.strictEqual(moved.createdAt, row.createdAt, 'createdAt is never touched');
    assert.ok(moved.updatedAt > row.updatedAt);

    assert.strictEqual(s.update('nope', { text: 'x' }), null, 'an unknown id is null');

    s.note(row.id, { state: 'sent', sentAt: Date.now() });
    assert.deepStrictEqual(s.update(row.id, { text: 'too late' }), { conflict: 'sent' },
        'a message already handed to a process cannot be edited — that would be '
        + 'editing the past, and the route turns this into a 409');
    assert.strictEqual(s.get(row.id).text, row.text, 'and nothing was written');
    ok('an edit is a genuine partial, and stops being possible once it has gone');
}

// --- what the rail asks for ----------------------------------------------

{
    const s = fresh();
    const now = Date.now();
    const later = make(s, { at: now + 90 * MIN });
    make(s, { at: now + 30 * MIN });
    make(s, { sessionId: 's2', at: now + 10 * MIN });
    const gone = make(s, { at: now + 5 * MIN });
    s.note(gone.id, { state: 'sent', sentAt: now });

    const mine = s.pendingFor('s1');
    assert.strictEqual(mine.pending, 2, 'a sent one is not pending');
    assert.strictEqual(mine.nextAt, now + 30 * MIN, 'and the soonest one is the next one');
    assert.strictEqual(s.pendingFor('s3'), null,
        'a session with nothing waiting carries nothing, so a client tests one field');
    assert.strictEqual(s.forSession('s2').length, 1);
    // Soonest-due first — the order these will happen in, which is the order to
    // read them in. Every row, not only the pending ones: a delivered message
    // keeps its place in the day rather than jumping to an end of the list.
    assert.deepStrictEqual(
        s.list().map(r => r.at - now),
        [5 * MIN, 10 * MIN, 30 * MIN, 90 * MIN],
        'the list is soonest-due first');
    assert.strictEqual(s.list().at(-1).id, later.id);
    ok('pendingFor answers the rail, and the list is in the order things happen');
}

// --- merge-on-write ------------------------------------------------------

{
    // Several bridges share STATE_DIR by design. A whole-file rewrite from a
    // snapshot taken at startup would erase every row another bridge has added
    // since — and what would be lost here is a message somebody wrote.
    const a = fresh();
    const mine = make(a, { text: 'from bridge A' });
    a.flush();

    const b = new Later();
    const theirs = make(b, { sessionId: 's9', text: 'from bridge B' });
    b.flush();

    a.update(mine.id, { text: 'edited on A after B wrote' });
    a.flush();

    const both = new Later().list();
    assert.strictEqual(both.length, 2, 'neither bridge lost the other\'s message');
    assert.strictEqual(both.find(r => r.id === theirs.id).text, 'from bridge B');
    assert.strictEqual(both.find(r => r.id === mine.id).text, 'edited on A after B wrote');
    ok('two bridges writing one file keep both sets of messages');
}

{
    // Deletions are tracked rather than inferred from absence: the merge starts
    // from the file, so a row we dropped would otherwise be read straight back in.
    const a = fresh();
    const doomed = make(a);
    a.flush();

    const b = new Later();          // holds a copy of `doomed`
    a.remove(doomed.id);
    a.flush();
    assert.strictEqual(new Later().list().length, 0);

    // B still has it in memory and writes for its own reasons. It comes back —
    // which is drafts.js's documented limitation, carried here deliberately
    // rather than fixed with tombstones on disk, because the cost is deleting a
    // chip a second time.
    b.flush();
    assert.strictEqual(new Later().list().length, 1,
        'a row another bridge still holds does come back; the header says so');
    ok('a deletion survives this bridge\'s own next write');
}

// --- pruning --------------------------------------------------------------

{
    const s = fresh();
    const live = make(s, { sessionId: 'alive' });
    const orphan = make(s, { sessionId: 'deleted-session' });
    const stale = make(s, { sessionId: 'alive' });
    s.note(stale.id, { state: 'sent', sentAt: Date.now() });

    // Nothing at all without a set of known ids: the index is not always ready,
    // and pruning against an empty one would delete every message on the machine.
    assert.strictEqual(s.prune(null), 0);
    assert.strictEqual(s.list().length, 3);

    assert.strictEqual(s.prune(new Set(['alive'])), 1, 'the orphan goes');
    assert.ok(!s.get(orphan.id));
    assert.ok(s.get(live.id) && s.get(stale.id),
        'a sent message is kept for a week — "sent at 02:00" is something you come '
        + 'back in the morning to read');

    assert.strictEqual(s.prune(new Set(['alive']), Date.now() + KEEP_MS + MIN), 1);
    assert.ok(!s.get(stale.id), 'and after that it is noise');
    assert.ok(s.get(live.id), 'a pending message is never pruned by age');
    ok('pruning drops orphans now and terminal rows after a week');
}

{
    const s = fresh();
    make(s, { sessionId: 'doomed' });
    make(s, { sessionId: 'doomed' });
    make(s, { sessionId: 'other' });
    assert.strictEqual(s.forget('doomed'), 2);
    assert.strictEqual(s.list().length, 1);
    s.flush();
    assert.strictEqual(new Later().list().length, 1,
        'deleting a session takes its messages with it, and they stay gone');
    ok('forget() clears one session\'s messages when the session itself goes');
}

// --- reading a file somebody has edited -----------------------------------

{
    // Not paranoia: this file is small, plain, and holds messages you wrote, which
    // makes it one of the few here somebody will actually open.
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
        version: 1,
        messages: [
            { id: 'ok', sessionId: 's1', at: Date.now() + MIN, text: 'fine' },
            { id: 'no-session', at: Date.now() + MIN, text: 'orphaned' },
            { id: 'no-time', sessionId: 's1', text: 'when?' },
            { id: 'no-content', sessionId: 's1', at: Date.now() + MIN, text: '   ' },
            { id: 'bad-state', sessionId: 's1', at: Date.now() + MIN, text: 'x', state: 'wat' },
        ],
    }, null, 2));

    const s = new Later();
    const ids = s.list().map(r => r.id).sort();
    assert.deepStrictEqual(ids, ['bad-state', 'ok'],
        'a row with no session, no time, or nothing to send is dropped rather than '
        + 'repaired — there is nothing sensible to invent for any of them');
    assert.strictEqual(s.get('bad-state').state, 'pending',
        'but a state this build does not know is not a reason to lose the message');
    assert.strictEqual(s.get('ok').permissionMode, 'auto',
        'and an absent mode reads as auto, which every route normalises again');

    fs.writeFileSync(STATE_FILE, '{ this is not json');
    assert.deepStrictEqual(new Later().list(), [],
        'an unreadable file is empty rather than a crash on boot');

    fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 99, messages: [{ id: 'x' }] }));
    assert.deepStrictEqual(new Later().list(), [],
        'and a version this build does not own is left alone');
    ok('a hand-edited file loses only the rows that cannot mean anything');
}

// --- the cap ---------------------------------------------------------------

{
    const s = fresh();
    for (let i = 0; i < MAX_PER_SESSION; i++) {
        assert.ok(make(s, { text: `n${i}` }), `message ${i} was made`);
    }
    assert.strictEqual(make(s, { text: 'one too many' }), null,
        'the cap returns null, which the route turns into a 409');
    assert.ok(make(s, { sessionId: 's2' }),
        'and it is per session, not per file');

    // Room again once one goes: a ceiling, not a lifetime budget.
    s.remove(s.forSession('s1')[0].id);
    assert.ok(make(s, { text: 'room again' }));

    // A sent one does not hold a slot either — the cap is about what is waiting.
    const sent = s.forSession('s1')[0];
    s.note(sent.id, { state: 'sent', sentAt: Date.now() });
    assert.ok(make(s, { text: 'and a delivered one frees its place' }));
    ok(`the ${MAX_PER_SESSION}-per-session cap counts what is waiting, and lifts`);
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} groups passed`);
