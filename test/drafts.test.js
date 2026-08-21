'use strict';

// The draft store, on its own — no bridge.
//
// A unit test rather than a live one because everything worth checking here is a
// pure question about one file: does a patch stay partial, does the list come
// back newest-first, does a save survive a reload, and do the three branches of
// load() that only ever run on a bad day actually run. None of that needs a
// socket, and the routes on top are thin enough that testing them would be
// testing http.
//
// **XDG_DATA_HOME is set before the require, and that order is load-bearing.**
// bridge/config.js reads the variable once, at require time, to build STATE_DIR —
// so setting it afterwards would point the module at the real
// ~/.local/share/claude-sessions and this test would eat the user's drafts.
// test/ports.test.js does the same thing for the same reason.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-drafts-'));
process.env.XDG_DATA_HOME = home;

const { Drafts, STATE_FILE, MAX_DRAFTS } = require('../bridge/drafts');

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
    return new Drafts();
}

const FIELDS = ['id', 'cwd', 'prompt', 'title', 'model', 'permissionMode',
    'test', 'createdAt', 'updatedAt'];

// --- the round trip ------------------------------------------------------

{
    const d = fresh();
    assert.deepStrictEqual(d.list(), []);
    assert.strictEqual(d.get('nope'), null);

    const made = d.create({
        cwd: '/home/someone/proj', prompt: 'Wire up the export button',
        model: 'opus', permissionMode: 'plan', test: true,
    });
    assert.ok(made.id, 'a draft gets an id');
    assert.deepStrictEqual(Object.keys(made).sort(), [...FIELDS].sort());
    assert.strictEqual(made.cwd, '/home/someone/proj');
    assert.strictEqual(made.prompt, 'Wire up the export button');
    assert.strictEqual(made.model, 'opus');
    assert.strictEqual(made.permissionMode, 'plan');
    assert.strictEqual(made.test, true);
    // Not given, so derived by the client rather than guessed here.
    assert.strictEqual(made.title, null);

    assert.strictEqual(d.list().length, 1);
    assert.deepStrictEqual(d.get(made.id), made);

    assert.strictEqual(d.remove(made.id), true);
    assert.strictEqual(d.remove(made.id), false, 'removing twice is not an error');
    assert.deepStrictEqual(d.list(), []);
    ok('create → get → list → remove round-trips, and every field survives');
}

// --- the store hands out copies -----------------------------------------
//
// Worth its own group: `list()` feeds a route response, and a caller that could
// mutate the row it was handed would be editing the store without saving it.

{
    const d = fresh();
    const made = d.create({ cwd: '/a', prompt: 'x' });
    d.list()[0].prompt = 'clobbered';
    d.get(made.id).prompt = 'clobbered';
    assert.strictEqual(d.get(made.id).prompt, 'x');
    ok('list() and get() hand out copies, not the stored row');
}

// --- update is a genuine partial ----------------------------------------

{
    const d = fresh();
    const made = d.create({
        cwd: '/a', prompt: 'first', model: 'sonnet',
        permissionMode: 'acceptEdits', test: true, title: 'Kept',
    });

    const next = d.update(made.id, { prompt: 'second' });
    assert.strictEqual(next.prompt, 'second');
    // Everything not named is untouched — this is the whole point of PATCH.
    assert.strictEqual(next.model, 'sonnet');
    assert.strictEqual(next.permissionMode, 'acceptEdits');
    assert.strictEqual(next.test, true);
    assert.strictEqual(next.title, 'Kept');
    assert.strictEqual(next.cwd, '/a');
    assert.strictEqual(next.id, made.id);
    ok('update leaves every field it was not given alone');

    assert.strictEqual(d.update('nope', { prompt: 'x' }), null,
        'update on an unknown id is null, not a throw');
    ok('update on an unknown id returns null');

    // `undefined` is the absence of a field and `null` is a value, which is what
    // lets a client clear a title it had set.
    assert.strictEqual(d.update(made.id, { title: null }).title, null);
    assert.strictEqual(d.update(made.id, { model: '   ' }).model, null,
        'whitespace is not a model');
    assert.strictEqual(d.update(made.id, {}).title, null, 'an empty patch is legal');
    ok('null clears an optional string; whitespace does too; {} is a no-op');
}

// --- the timestamps -----------------------------------------------------

{
    const d = fresh();
    const made = d.create({ cwd: '/a', prompt: 'x' });
    assert.strictEqual(made.createdAt, made.updatedAt);

    // Both stamps come from Date.now(), so an edit in the same millisecond is
    // indistinguishable from no edit. Forced apart rather than slept through.
    d.rows[0].updatedAt = made.updatedAt - 5_000;
    d.rows[0].createdAt = made.createdAt - 5_000;
    const bumped = d.update(made.id, { prompt: 'y' });

    assert.ok(bumped.updatedAt > bumped.createdAt, 'updatedAt moved');
    assert.strictEqual(bumped.createdAt, made.createdAt - 5_000,
        'createdAt is when you first wrote it down and never moves');
    ok('update bumps updatedAt and never touches createdAt');
}

// --- newest-updated first -----------------------------------------------

{
    const d = fresh();
    // Three in a row, almost certainly within one millisecond of each other —
    // which is exactly the tie the unshift in create() is there to break.
    const a = d.create({ cwd: '/a', prompt: 'a' });
    const b = d.create({ cwd: '/b', prompt: 'b' });
    const c = d.create({ cwd: '/c', prompt: 'c' });
    assert.deepStrictEqual(d.list().map(r => r.prompt), ['c', 'b', 'a'],
        'a same-millisecond burst still reads newest first');
    ok('list() is newest first, including for drafts made in the same millisecond');

    // And an edit moves a row to the front, which is the behaviour the panel
    // relies on after Save changes.
    d.rows.forEach(r => { r.updatedAt -= 5_000; });
    d.update(a.id, { prompt: 'a again' });
    assert.deepStrictEqual(d.list().map(r => r.id), [a.id, c.id, b.id]);
    ok('editing a draft moves it to the front');
}

// --- save and reload ----------------------------------------------------

{
    const d = fresh();
    const made = d.create({
        cwd: '/home/someone/proj', prompt: 'line one\nline two',
        title: 'A title', model: 'fable', permissionMode: 'bypassPermissions',
        test: true,
    });
    const other = d.create({ cwd: '/b', prompt: 'plain' });
    d.flush();

    const back = new Drafts();
    assert.strictEqual(back.list().length, 2);
    // Field for field, including the multi-line prompt and the falsey defaults on
    // the second row — a reload that quietly dropped `test: false` would look
    // fine until somebody's test session showed up in the everyday window.
    assert.deepStrictEqual(back.get(made.id), made);
    assert.deepStrictEqual(back.get(other.id), other);
    assert.strictEqual(back.get(other.id).test, false);
    assert.strictEqual(back.get(other.id).model, null);
    ok('a save-then-reload keeps every field, on both a full and a bare row');
}

// --- the bad-day branches in load() -------------------------------------

{
    const write = (text) => fs.writeFileSync(STATE_FILE, text);
    const rows = () => new Drafts().list();

    write('{"version":99,"drafts":[{"id":"a","cwd":"/a","prompt":"x"}]}');
    assert.deepStrictEqual(rows(), [], 'a future version loads as empty');

    write('not json at all');
    assert.deepStrictEqual(rows(), [], 'garbage loads as empty rather than throwing');

    write('{"version":1}');
    assert.deepStrictEqual(rows(), [], 'a missing drafts array loads as empty');

    write('{"version":1,"drafts":"nope"}');
    assert.deepStrictEqual(rows(), [], 'a drafts field of the wrong type loads as empty');

    // A BOM, which is what an editor on this machine may leave behind.
    write('﻿{"version":1,"drafts":[{"id":"a","cwd":"/a","prompt":"x"}]}');
    assert.strictEqual(rows().length, 1, 'a BOM is tolerated');

    fs.unlinkSync(STATE_FILE);
    assert.deepStrictEqual(rows(), [], 'no file at all loads as empty');
    ok('a bad, future, absent or BOM-prefixed file loads as empty instead of throwing');
}

{
    // Rows that cannot do anything are dropped one at a time, not taken as
    // grounds to throw the file away.
    fs.writeFileSync(STATE_FILE, JSON.stringify({
        version: 1,
        drafts: [
            { id: 'keep', cwd: '/a', prompt: 'x' },
            { cwd: '/a', prompt: 'no id' },
            { id: 'b', prompt: 'no cwd' },
            { id: 'c', cwd: '/a' },
            { id: 'd', cwd: '', prompt: 'empty cwd' },
            { id: 'e', cwd: '/a', prompt: '' },
            null,
            'not an object',
            { id: 'also-keep', cwd: '/b', prompt: 'y', test: 'truthy' },
        ],
    }));
    const back = new Drafts().list();
    assert.deepStrictEqual(back.map(r => r.id).sort(), ['also-keep', 'keep']);
    assert.strictEqual(back.find(r => r.id === 'also-keep').test, true,
        'test is coerced to a boolean rather than stored as it arrived');
    ok('an unusable row is dropped without taking the good rows with it');
}

// --- two bridges over one file ------------------------------------------
//
// The reason flush() merges rather than overwrites. Two Drafts instances over the
// same path are exactly the situation on this machine: the everyday bridge on
// 45888 and an agent's dev bridge, both reading ~/.local/share/claude-sessions.

{
    const a = fresh();
    const mine = a.create({ cwd: '/a', prompt: 'made on bridge A' });
    a.flush();

    // B boots and sees A's row, then both add one without knowing about the other.
    const b = new Drafts();
    assert.strictEqual(b.list().length, 1, 'B loaded what A had written');
    const hers = b.create({ cwd: '/b', prompt: 'made on bridge B' });
    const alsoMine = a.create({ cwd: '/a', prompt: 'also on bridge A' });

    b.flush();
    a.flush();

    const onDisk = new Drafts().list();
    assert.deepStrictEqual(onDisk.map(r => r.id).sort(),
        [mine.id, hers.id, alsoMine.id].sort(),
        'A writing last did not erase what B had added');
    ok('two bridges both add drafts and neither loses the other’s');
}

{
    const a = fresh();
    const row = a.create({ cwd: '/a', prompt: 'original' });
    a.flush();

    // B edits it. A still holds the pre-edit copy and then writes for its own
    // reasons — which must not undo the edit it never saw.
    const b = new Drafts();
    b.update(row.id, { prompt: 'edited on bridge B' });
    b.flush();

    a.create({ cwd: '/a', prompt: 'something else entirely' });
    a.flush();

    const back = new Drafts();
    assert.strictEqual(back.get(row.id).prompt, 'edited on bridge B',
        'the newer updatedAt won, so a stale snapshot did not roll the edit back');
    assert.strictEqual(back.list().length, 2);
    ok('a stale copy cannot overwrite another bridge’s later edit');
}

{
    const a = fresh();
    const doomed = a.create({ cwd: '/a', prompt: 'to be deleted' });
    const kept = a.create({ cwd: '/a', prompt: 'to be kept' });
    a.flush();

    // A delete has to survive the merge, which reads the row straight back off
    // disk. Getting this wrong is how a started draft comes back and starts a
    // second session.
    assert.strictEqual(a.remove(doomed.id), true);
    a.flush();

    const back = new Drafts().list();
    assert.deepStrictEqual(back.map(r => r.id), [kept.id]);
    // And it stays gone across a second write, i.e. `_removed` being cleared
    // after the flush does not resurrect it.
    a.create({ cwd: '/a', prompt: 'later still' });
    a.flush();
    assert.strictEqual(new Drafts().list().some(r => r.id === doomed.id), false);
    ok('a deletion survives the merge, and stays deleted on the next write');
}

// --- the cap ------------------------------------------------------------

{
    const d = fresh();
    for (let i = 0; i < MAX_DRAFTS; i++) {
        assert.ok(d.create({ cwd: '/a', prompt: `n${i}` }), `draft ${i} was made`);
    }
    assert.strictEqual(d.list().length, MAX_DRAFTS);
    assert.strictEqual(d.create({ cwd: '/a', prompt: 'one too many' }), null,
        'the cap returns null, which the route turns into a 409');
    assert.strictEqual(d.list().length, MAX_DRAFTS, 'and nothing was stored');

    // Room again once one goes, so the cap is a ceiling rather than a lifetime
    // budget.
    d.remove(d.list()[0].id);
    assert.ok(d.create({ cwd: '/a', prompt: 'room again' }));
    ok(`the ${MAX_DRAFTS}-draft cap refuses the next one, and lifts when one is deleted`);
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} groups passed`);
