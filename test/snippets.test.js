'use strict';

// The snippet store, on its own — no bridge.
//
// A unit test rather than a live one for drafts.test.js's reason: everything worth
// checking here is a pure question about one file, and the routes on top are thin
// enough that testing them would be testing http.
//
// The group that earns this file on its own is **seeding**. The failure it guards
// is a deleted LGTM coming back on the next restart, which does not read as a
// policy — it reads as the delete not having worked, and it is the only bug in this
// feature somebody would report as data loss. Three of its assertions are about
// situations that never arise while you are looking at them: a file whose list you
// emptied, a file written before seeding existed, and a file written by a *newer*
// build, which must not be seeded at all because the write that followed would put
// a version 1 document over the top of one the next build owns.
//
// **XDG_DATA_HOME is set before the require, and that order is load-bearing.**
// bridge/config.js reads the variable once, at require time, to build STATE_DIR —
// so setting it afterwards would point the module at the real
// ~/.local/share/claude-sessions and this test would eat the user's snippets.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-snippets-'));
process.env.XDG_DATA_HOME = home;
// cleanProjects and matchesCwd both expand `~`, and a test that asserted about
// paths under the real home would be asserting about whoever ran it.
process.env.HOME = path.join(home, 'home');

const {
    Snippets, STATE_FILE, VERSION, SEEDS,
    MAX_SNIPPETS, MAX_GROUPS, MAX_PARAMS, MAX_PROJECTS,
    matchesCwd, scanPlaceholders, fillBody,
} = require('../bridge/snippets');

// Asserted rather than assumed: if this ever pointed at the real directory the
// rest of the file would be destructive, so it is worth failing loudly on instead.
assert.ok(STATE_FILE.startsWith(home),
    `refusing to run: STATE_FILE is ${STATE_FILE}, outside the throwaway ${home}`);

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

/**
 * A fresh store over a wiped file, so groups cannot leak into each other.
 *
 * Unseeded by default, and that is not tidiness: with the seed in, every count in
 * every other group would be one out, and the group that is actually about seeding
 * would be testing it twice over.
 */
function fresh({ seed = false } = {}) {
    try { fs.unlinkSync(STATE_FILE); } catch { /* first run */ }
    return new Snippets({ seed });
}

/** Write a file by hand, to test what the store makes of one it did not write. */
function put(doc) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, typeof doc === 'string' ? doc : JSON.stringify(doc));
}

const read = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

const FIELDS = ['id', 'title', 'body', 'hint', 'groupId', 'params', 'insert',
    'autoSubmit', 'permissionMode', 'pinned', 'order', 'projects',
    'createdAt', 'updatedAt'];
const GROUP_FIELDS = ['id', 'name', 'accent', 'order', 'createdAt', 'updatedAt'];

console.log('\n--- the round trip ---');
{
    const s = fresh();
    const made = s.create({ title: 'Ship it', body: 'Ship {{what}} now.' });

    assert.deepStrictEqual(Object.keys(made).sort(), [...FIELDS].sort());
    assert.strictEqual(made.title, 'Ship it');
    assert.strictEqual(made.body, 'Ship {{what}} now.');
    assert.strictEqual(made.insert, 'overwrite');
    assert.strictEqual(made.autoSubmit, false);
    assert.strictEqual(made.permissionMode, null);
    assert.strictEqual(made.pinned, false);
    assert.strictEqual(made.order, null);
    assert.deepStrictEqual(made.projects, []);
    assert.strictEqual(made.createdAt, made.updatedAt);

    assert.deepStrictEqual(s.get(made.id), made);
    assert.strictEqual(s.list().length, 1);
    assert.strictEqual(s.get('nope'), null);

    assert.strictEqual(s.remove(made.id), true);
    assert.strictEqual(s.remove(made.id), false);
    assert.strictEqual(s.list().length, 0);
    ok('create, get, list and remove, with exactly the fields clean() names');
}
{
    const s = fresh();
    const g = s.createGroup({ name: 'Review', accent: '#6dd58c' });
    assert.deepStrictEqual(Object.keys(g).sort(), [...GROUP_FIELDS].sort());
    assert.strictEqual(g.accent, '#6dd58c');
    assert.deepStrictEqual(s.getGroup(g.id), g);
    assert.strictEqual(s.getGroup('nope'), null);
    ok('groups round-trip the same way');
}

console.log('\n--- the store hands out copies ---');
{
    const s = fresh();
    const g = s.createGroup({ name: 'G' });
    const made = s.create({
        title: 'T', body: 'B', groupId: g.id,
        params: [{ name: 'x', type: 'text' }],
        projects: ['/tmp/one'],
    });

    // Flat fields first, which is all the drafts version of this group had.
    const listed = s.list()[0];
    listed.title = 'clobbered';
    // Then the two nested ones. A shared array reference is the version of this
    // bug that survives copying the pattern across from a store with no arrays.
    listed.params.push({ name: 'y', type: 'text' });
    listed.params[0].label = 'clobbered';
    listed.projects.push('/tmp/two');

    const again = s.get(made.id);
    assert.strictEqual(again.title, 'T');
    assert.strictEqual(again.params.length, 1);
    assert.strictEqual(again.params[0].label, null);
    assert.deepStrictEqual(again.projects, ['/tmp/one']);

    const groups = s.listGroups();
    groups[0].name = 'clobbered';
    assert.strictEqual(s.getGroup(g.id).name, 'G');
    ok('mutating what list() returned does not reach the store, arrays included');
}

console.log('\n--- update is a genuine partial ---');
{
    const s = fresh();
    const g = s.createGroup({ name: 'G' });
    const made = s.create({
        title: 'T', body: 'B', hint: 'H', groupId: g.id,
        insert: 'append', autoSubmit: true, permissionMode: 'plan',
        pinned: true, order: 3, projects: ['/tmp/one'],
        params: [{ name: 'x', type: 'integer', required: true }],
    });

    // {} touches nothing but the stamp.
    const same = s.update(made.id, {});
    for (const k of FIELDS) {
        if (k === 'updatedAt') continue;
        assert.deepStrictEqual(same[k], made[k], `${k} moved on an empty patch`);
    }
    assert.ok(same.updatedAt > made.updatedAt);

    // undefined is absence; null is a value.
    const one = s.update(made.id, { title: 'T2', body: undefined });
    assert.strictEqual(one.title, 'T2');
    assert.strictEqual(one.body, 'B');

    const cleared = s.update(made.id, {
        groupId: null, permissionMode: null, hint: null, order: null,
    });
    assert.strictEqual(cleared.groupId, null);
    assert.strictEqual(cleared.permissionMode, null);
    assert.strictEqual(cleared.hint, null);
    assert.strictEqual(cleared.order, null);
    // Untouched by that patch.
    assert.strictEqual(cleared.insert, 'append');
    assert.strictEqual(cleared.autoSubmit, true);
    assert.strictEqual(cleared.pinned, true);

    // A whitespace-only string is an absence for a trimmed field.
    assert.strictEqual(s.update(made.id, { hint: '   ' }).hint, null);

    assert.strictEqual(s.update('nope', { title: 'x' }), null);
    ok('undefined is absence, null is a value, and {} is legal');
}
{
    const s = fresh();
    const made = s.create({
        title: 'T', body: 'B',
        params: [{ name: 'a', type: 'text' }, { name: 'b', type: 'date' }],
    });
    // params replaces rather than merges, because a param has no id.
    assert.deepStrictEqual(
        s.update(made.id, { params: [{ name: 'c', type: 'text' }] }).params.map(p => p.name),
        ['c']);
    assert.strictEqual(s.update(made.id, { params: [] }).params.length, 0);
    ok('params replaces the whole array, and [] clears it');
}
{
    const s = fresh();
    const made = s.create({ title: 'T', body: 'B', insert: 'cursor' });
    // An unrecognised insert leaves the field where it was rather than silently
    // choosing the destructive default. The route refuses it outright.
    assert.strictEqual(s.update(made.id, { insert: 'sideways' }).insert, 'cursor');
    ok('an unrecognised insert on update keeps the value it had');
}

console.log('\n--- params ---');
{
    const s = fresh();
    const made = s.create({
        title: 'T', body: 'B',
        params: [
            { name: 'good', label: '  Spaced  ', type: 'decimal', required: 'yes', default: ' 3 ' },
            { name: 'good', type: 'text' },              // duplicate; first wins
            { name: '2bad', type: 'text' },              // leading digit
            { name: 'has-hyphen', type: 'text' },        // not \w
            { name: '', type: 'text' },                  // empty
            { name: 'nameless' },                        // no type -> text
            { type: 'text' },                            // no name at all
            null,
            'not an object',
            { name: 'novel', type: 'duration' },         // unknown type -> text
        ],
    });
    assert.deepStrictEqual(made.params.map(p => p.name), ['good', 'nameless', 'novel']);
    assert.strictEqual(made.params[0].label, 'Spaced');   // a label is trimmed
    assert.strictEqual(made.params[0].default, ' 3 ');    // a default is not
    assert.strictEqual(made.params[0].required, true);
    assert.strictEqual(made.params[1].type, 'text');
    assert.strictEqual(made.params[2].type, 'text');
    ok('bad params are dropped one at a time, and an unknown type widens to text');
}
{
    const s = fresh();
    const many = Array.from({ length: MAX_PARAMS + 5 },
        (_, i) => ({ name: `p${i}`, type: 'text' }));
    assert.strictEqual(s.create({ title: 'T', body: 'B', params: many }).params.length,
        MAX_PARAMS);
    ok(`params are capped at ${MAX_PARAMS}`);
}

console.log('\n--- placeholders ---');
{
    const params = [{ name: 'a', type: 'text', default: null },
        { name: 'unused', type: 'text', default: null }];
    const scan = scanPlaceholders('Do {{a}} then {{b}}, and { {c} }.', params);
    assert.deepStrictEqual(scan.used.sort(), ['a', 'b']);
    assert.deepStrictEqual(scan.undeclared, ['b']);
    assert.deepStrictEqual(scan.unused, ['unused']);

    // Whitespace inside the braces is the same name; a hyphen is not a name at all.
    assert.deepStrictEqual(scanPlaceholders('{{ a }}', params).used, ['a']);
    assert.deepStrictEqual(scanPlaceholders('{{a-b}}', params).used, []);
    // An unterminated brace is prose, not a crash.
    assert.deepStrictEqual(scanPlaceholders('a {{ b', params).used, []);
    assert.deepStrictEqual(scanPlaceholders('', []).used, []);
    ok('scanPlaceholders reports both directions and neither is an error');
}
{
    const params = [
        { name: 'a', type: 'text', default: null },
        { name: 'withDefault', type: 'text', default: 'fallback' },
    ];
    assert.strictEqual(fillBody('x {{a}} y', params, { a: 'A' }), 'x A y');
    // An undeclared name is left verbatim — fillPrompt's rule in schedule.js.
    assert.strictEqual(fillBody('x {{nope}} y', params, { nope: 'N' }), 'x {{nope}} y');
    // A declared name with no answer falls back to its default...
    assert.strictEqual(fillBody('x {{withDefault}} y', params, {}), 'x fallback y');
    // ...and then to the placeholder. Never to the empty string.
    assert.strictEqual(fillBody('x {{a}} y', params, {}), 'x {{a}} y');
    assert.strictEqual(fillBody('x {{a}} y', params, { a: '' }), 'x {{a}} y');
    // A number answer is stringified rather than dropped.
    assert.strictEqual(fillBody('x {{a}} y', params, { a: 0 }), 'x 0 y');
    ok('fillBody never blanks a placeholder it cannot answer');
}

console.log('\n--- where a snippet applies ---');
{
    const anywhere = { projects: [] };
    assert.strictEqual(matchesCwd(anywhere, '/anything'), true);
    assert.strictEqual(matchesCwd(anywhere, null), true);
    assert.strictEqual(matchesCwd({ projects: null }, '/anything'), true);

    const scoped = { projects: ['/home/me/proj'] };
    assert.strictEqual(matchesCwd(scoped, '/home/me/proj'), true);
    assert.strictEqual(matchesCwd(scoped, '/home/me/proj/web/src'), true);
    // The whole point of the boundary: a different repository sharing a prefix.
    assert.strictEqual(matchesCwd(scoped, '/home/me/proj-old'), false);
    assert.strictEqual(matchesCwd(scoped, '/home/me'), false);
    // A scoped snippet with nowhere to be is not everywhere.
    assert.strictEqual(matchesCwd(scoped, null), false);
    // A trailing slash on the way in is the same directory.
    assert.strictEqual(matchesCwd(scoped, '/home/me/proj/'), true);
    ok('projects is a prefix match at a path boundary, and empty is everywhere');
}
{
    const s = fresh();
    s.create({ title: 'Everywhere', body: 'B' });
    s.create({ title: 'Scoped', body: 'B', projects: ['~/work/', '/tmp/x', '/tmp/x'] });

    const scoped = s.list().find(r => r.title === 'Scoped');
    // `~` expanded, trailing separator stripped, duplicate collapsed.
    assert.deepStrictEqual(scoped.projects, [path.join(process.env.HOME, 'work'), '/tmp/x']);

    assert.deepStrictEqual(s.list({ cwd: '/tmp/x/deep' }).map(r => r.title),
        ['Everywhere', 'Scoped']);
    assert.deepStrictEqual(s.list({ cwd: '/elsewhere' }).map(r => r.title), ['Everywhere']);
    assert.strictEqual(s.list().length, 2, 'an unfiltered list is still the whole list');
    ok('projects are expanded and de-duplicated, and list({cwd}) narrows');
}
{
    const s = fresh();
    const many = Array.from({ length: MAX_PROJECTS + 5 }, (_, i) => `/tmp/p${i}`);
    assert.strictEqual(s.create({ title: 'T', body: 'B', projects: many }).projects.length,
        MAX_PROJECTS);
    ok(`projects are capped at ${MAX_PROJECTS}`);
}

console.log('\n--- display order ---');
{
    const s = fresh();
    s.create({ title: 'zebra', body: 'B' });          // no order
    s.create({ title: 'apple', body: 'B' });          // no order
    s.create({ title: 'last', body: 'B', order: 9 });
    s.create({ title: 'first', body: 'B', order: 1 });

    // Numbered ones ascending, then the unnumbered ones alphabetically — never
    // interleaved, because null is the absence of a decision.
    assert.deepStrictEqual(s.list().map(r => r.title),
        ['first', 'last', 'apple', 'zebra']);
    ok('an explicit order sorts first, and unset falls back to alphabetical');
}
{
    const s = fresh();
    s.createGroup({ name: 'zebra' });
    s.createGroup({ name: 'apple' });
    s.createGroup({ name: 'pinned', order: 0 });
    assert.deepStrictEqual(s.listGroups().map(g => g.name), ['pinned', 'apple', 'zebra']);
    ok('groups follow the same rule, on name');
}
{
    // Two rows can genuinely share an order — the file is hand-editable and two
    // bridges number independently — so the tiebreak has to be total.
    put({
        version: VERSION,
        seeded: [],
        groups: [],
        snippets: [
            { id: 'b', title: 'same', body: 'B', order: 0 },
            { id: 'a', title: 'same', body: 'B', order: 0 },
        ],
    });
    const one = new Snippets({ seed: false }).list().map(r => r.id);
    const two = new Snippets({ seed: false }).list().map(r => r.id);
    assert.deepStrictEqual(one, ['a', 'b']);
    assert.deepStrictEqual(one, two);
    ok('a shared order breaks down to the id, so the order never depends on array position');
}

console.log('\n--- reorder ---');
{
    const s = fresh();
    const a = s.create({ title: 'a', body: 'B' });
    const b = s.create({ title: 'b', body: 'B' });
    const c = s.create({ title: 'c', body: 'B', order: 7 });

    const moved = s.reorder({ snippets: [b.id, a.id] });
    assert.deepStrictEqual(moved, { snippets: 2, groups: 0 });
    assert.deepStrictEqual(s.list().map(r => r.title), ['b', 'a', 'c']);
    // Unmentioned rows keep what they had — a client holding a stale list cannot
    // renumber snippets it has never seen.
    assert.strictEqual(s.get(c.id).order, 7);

    // Idempotent, and a no-op reports nothing moved so the route can skip the push.
    assert.deepStrictEqual(s.reorder({ snippets: [b.id, a.id] }),
        { snippets: 0, groups: 0 });
    // An id that is not here is ignored rather than failing the save — and it does
    // not take a slot on the way past, so this is the same arrangement as
    // [a, b] would be rather than one with a hole at the front.
    assert.strictEqual(s.reorder({ snippets: ['ghost', a.id, b.id] }).snippets, 2);
    assert.deepStrictEqual(s.list().map(r => r.title), ['a', 'b', 'c']);
    assert.strictEqual(s.get(a.id).order, 0);
    assert.strictEqual(s.get(b.id).order, 1);
    assert.strictEqual(s.reorder({ snippets: ['ghost', a.id, b.id] }).snippets, 0,
        'a stranger must not stop the call being idempotent');
    assert.deepStrictEqual(s.reorder({}), { snippets: 0, groups: 0 });
    ok('reorder writes a whole arrangement, ignores strangers and is idempotent');
}
{
    const s = fresh();
    const a = s.create({ title: 'a', body: 'B' });
    const b = s.create({ title: 'b', body: 'B' });
    // The first call moves both, since they start unordered. What matters is the
    // second: it names the same arrangement, so nothing may be stamped.
    s.reorder({ snippets: [a.id, b.id] });
    const was = s.get(a.id).updatedAt;
    assert.strictEqual(s.reorder({ snippets: [a.id, b.id] }).snippets, 0);
    assert.strictEqual(s.get(a.id).updatedAt, was,
        'a row that did not move must not be stamped — it would win a merge it should lose');

    // And a partial no-op stamps only the half that moved.
    s.reorder({ snippets: [b.id, a.id] });
    const bMoved = s.get(b.id).updatedAt;
    s.reorder({ snippets: [b.id, a.id] });
    assert.strictEqual(s.get(b.id).updatedAt, bMoved);
    ok('updatedAt moves only on rows whose order actually changed');
}
{
    const s = fresh();
    const g1 = s.createGroup({ name: 'one' });
    const g2 = s.createGroup({ name: 'two' });
    assert.deepStrictEqual(s.reorder({ groups: [g2.id, g1.id] }),
        { snippets: 0, groups: 2 });
    assert.deepStrictEqual(s.listGroups().map(g => g.name), ['two', 'one']);
    ok('reorder does groups too, in the same call');
}

console.log('\n--- groups and their snippets ---');
{
    const s = fresh();
    const g = s.createGroup({ name: 'G', accent: '#abc' });
    const a = s.create({ title: 'a', body: 'B', groupId: g.id });
    const b = s.create({ title: 'b', body: 'B', groupId: g.id });
    const loose = s.create({ title: 'c', body: 'B' });

    assert.deepStrictEqual(s.removeGroup(g.id), { orphaned: 2 });
    assert.strictEqual(s.removeGroup(g.id), null);
    assert.strictEqual(s.listGroups().length, 0);
    assert.strictEqual(s.list().length, 3, 'deleting a heading must not delete what is under it');
    // The groupId is kept, not nulled: another bridge may still hold that group,
    // and recreating it by id puts these straight back.
    assert.strictEqual(s.get(a.id).groupId, g.id);
    assert.strictEqual(s.get(b.id).groupId, g.id);
    assert.strictEqual(s.get(loose.id).groupId, null);
    ok('removeGroup orphans rather than cascades, and keeps the groupId');
}
{
    const s = fresh();
    assert.strictEqual(s.createGroup({ name: 'G', accent: 'red' }).accent, null);
    assert.strictEqual(s.createGroup({ name: 'G', accent: '#ff0000;}' }).accent, null);
    assert.strictEqual(s.createGroup({ name: 'G', accent: 'var(--red)' }).accent, null);
    assert.strictEqual(s.createGroup({ name: 'G', accent: '#abc' }).accent, '#abc');
    assert.strictEqual(s.createGroup({ name: 'G', accent: '#AABBCC' }).accent, '#AABBCC');
    ok('an accent is a hex colour or nothing — it lands in a stylesheet');
}

console.log('\n--- the timestamps ---');
{
    const s = fresh();
    const made = s.create({ title: 'T', body: 'B' });
    // Forced apart rather than slept through: the point is that same-millisecond
    // writes must still be strictly ordered.
    s.rows[0].updatedAt = made.updatedAt - 5_000;
    const after = s.update(made.id, { title: 'T2' });
    assert.ok(after.updatedAt > made.updatedAt - 5_000);
    assert.strictEqual(after.createdAt, made.createdAt, 'createdAt never moves');
    ok('update bumps updatedAt and leaves createdAt alone');
}
{
    const s = fresh();
    // A group and a snippet written together must not tie, or the merge in flush()
    // could not tell a newer write from an older one.
    const stamps = new Set();
    for (let i = 0; i < 20; i++) {
        stamps.add(s.create({ title: `s${i}`, body: 'B' }).updatedAt);
        stamps.add(s.createGroup({ name: `g${i}` }).updatedAt);
    }
    assert.strictEqual(stamps.size, 40, 'a stamp repeated across the two collections');
    ok('_stamp() is strictly increasing across both collections');
}

console.log('\n--- save and reload ---');
{
    const s = fresh();
    const g = s.createGroup({ name: 'G', accent: '#6dd58c', order: 2 });
    const full = s.create({
        title: 'Full', body: 'line one\n\n  line two  ', hint: 'a hint',
        groupId: g.id, insert: 'cursor', autoSubmit: true, permissionMode: 'plan',
        pinned: true, order: 4, projects: ['/tmp/a', '/tmp/b'],
        params: [{ name: 'a', label: 'A', type: 'integer', required: true, default: '2' },
            { name: 'b', type: 'datetime' }],
    });
    // A bare one too: a reload that quietly dropped `autoSubmit: false` looks fine
    // right up until a snippet sends itself.
    const bare = s.create({ title: 'Bare', body: 'B' });
    s.flush();

    const back = new Snippets({ seed: false });
    assert.deepStrictEqual(back.get(full.id), full);
    assert.deepStrictEqual(back.get(bare.id), bare);
    assert.deepStrictEqual(back.getGroup(g.id), g);
    assert.strictEqual(back.get(full.id).body, 'line one\n\n  line two  ',
        'a body is stored untrimmed — whitespace is part of what append and cursor mean');
    ok('every field survives a save and a reload, populated or bare');
}

console.log('\n--- the bad-day branches in load() ---');
{
    for (const [what, doc] of [
        ['a future version', { version: VERSION + 1, snippets: [{ id: 'a', title: 'T', body: 'B' }] }],
        ['garbage', 'not json at all'],
        ['no arrays', { version: VERSION }],
        ['arrays of the wrong type', { version: VERSION, snippets: 'nope', groups: 7 }],
        ['a null document', 'null'],
    ]) {
        put(doc);
        const s = new Snippets({ seed: false });
        assert.strictEqual(s.list().length, 0, `${what} should load empty`);
        assert.strictEqual(s.listGroups().length, 0, `${what} should load empty`);
    }
    // A BOM is what an editor adds, and this is a file somebody may open.
    put('﻿' + JSON.stringify({
        version: VERSION, seeded: [], groups: [],
        snippets: [{ id: 'a', title: 'T', body: 'B' }],
    }));
    assert.strictEqual(new Snippets({ seed: false }).list().length, 1);

    try { fs.unlinkSync(STATE_FILE); } catch { /* already gone */ }
    assert.strictEqual(new Snippets({ seed: false }).list().length, 0);
    ok('a broken, future, empty or missing file loads empty rather than throwing');
}
{
    put({
        version: VERSION,
        seeded: [],
        groups: [{ id: 'g', name: 'G' }, { id: 'nameless' }, null, 'string'],
        snippets: [
            { id: 'keep', title: 'T', body: 'B', groupId: 'ghost' },
            { id: 'no-title', body: 'B' },
            { title: 'no id', body: 'B' },
            { id: 'no-body', title: 'T' },
            { id: 'blank-body', title: 'T', body: '' },
            null,
            'a string',
        ],
    });
    const s = new Snippets({ seed: false });
    assert.deepStrictEqual(s.list().map(r => r.id), ['keep']);
    assert.deepStrictEqual(s.listGroups().map(g => g.id), ['g']);
    // A groupId naming a group that is not here is kept, not nulled: another
    // bridge may hold it, and rewriting a row we do not own is what
    // merge-on-write exists to avoid.
    assert.strictEqual(s.get('keep').groupId, 'ghost');
    ok('an unusable row is dropped without taking the good ones, and a stray groupId is kept');
}

console.log('\n--- two bridges over one file ---');
{
    const a = fresh();
    const one = a.create({ title: 'from a', body: 'B' });
    a.flush();

    const b = new Snippets({ seed: false });
    const two = b.create({ title: 'from b', body: 'B' });
    b.flush();
    a.create({ title: 'also a', body: 'B' });
    a.flush();

    const both = new Snippets({ seed: false }).list().map(r => r.title).sort();
    assert.deepStrictEqual(both, ['also a', 'from a', 'from b']);
    assert.ok(one && two);
    ok('neither bridge loses the other rows');
}
{
    const a = fresh();
    const made = a.create({ title: 'T', body: 'B' });
    a.flush();

    const b = new Snippets({ seed: false });
    b.update(made.id, { title: 'edited by b' });
    b.flush();

    // `a` still holds its older copy. Writing must not roll b's edit back.
    a.flush();
    assert.strictEqual(new Snippets({ seed: false }).get(made.id).title, 'edited by b');
    ok('a stale copy cannot overwrite a later edit');
}
{
    const a = fresh();
    const made = a.create({ title: 'T', body: 'B' });
    a.flush();

    const b = new Snippets({ seed: false });
    b.remove(made.id);
    b.flush();
    assert.strictEqual(new Snippets({ seed: false }).get(made.id), null);
    // The tombstone is what makes the deletion survive the merge, which reads the
    // file back before writing.
    b.flush();
    assert.strictEqual(new Snippets({ seed: false }).get(made.id), null);
    ok('a deletion survives the merge and stays deleted');
}
{
    const a = fresh();
    const g = a.createGroup({ name: 'G' });
    const s1 = a.create({ title: 'in g', body: 'B', groupId: g.id });
    a.flush();

    const b = new Snippets({ seed: false });
    b.removeGroup(g.id);
    b.flush();

    const back = new Snippets({ seed: false });
    assert.strictEqual(back.listGroups().length, 0);
    assert.strictEqual(back.get(s1.id).groupId, g.id, 'the snippet outlives its group');
    ok('a group deleted on one bridge does not take its snippets with it on either');
}

console.log('\n--- seeding ---');
{
    try { fs.unlinkSync(STATE_FILE); } catch { /* first run */ }
    const s = new Snippets();
    const lgtm = s.get('seed-lgtm');
    assert.ok(lgtm, 'a missing file gets the shipped snippets');
    assert.strictEqual(lgtm.title, 'LGTM');
    assert.strictEqual(lgtm.pinned, true);
    assert.strictEqual(lgtm.autoSubmit, true);
    assert.strictEqual(lgtm.insert, 'overwrite');
    assert.strictEqual(lgtm.permissionMode, null, 'LGTM never moved the mode selector');
    assert.ok(lgtm.hint, 'the button keeps the sentence it used to carry as a title');
    assert.ok(lgtm.body.includes('take it from here'));

    // Written at once rather than on the debounce: the record of having offered a
    // seed is the only thing standing between a deleted one and its return.
    assert.deepStrictEqual(read().seeded, ['seed-lgtm']);
    ok('a missing file is seeded, and the record of it reaches disk immediately');
}
{
    // Constructed again over the file we just wrote.
    const s = new Snippets();
    assert.strictEqual(s.list().filter(r => r.id === 'seed-lgtm').length, 1);
    ok('a second bridge over a seeded file adds nothing');
}
{
    // The assertion this whole file is for.
    const s = new Snippets();
    s.remove('seed-lgtm');
    s.flush();
    assert.strictEqual(new Snippets().get('seed-lgtm'), null,
        'a deleted LGTM came back — which reads as the delete having failed');
    assert.strictEqual(new Snippets().list().length, 0);
    ok('deleting a shipped snippet is permanent, across restarts');
}
{
    put({ version: VERSION, seeded: ['seed-lgtm'], groups: [], snippets: [] });
    assert.strictEqual(new Snippets().list().length, 0);
    ok('an emptied store stays empty — the record is what decides, not the list');
}
{
    // A file written before seeding existed has no record, so it is owed one.
    put({ version: VERSION, groups: [], snippets: [{ id: 'mine', title: 'T', body: 'B' }] });
    const s = new Snippets();
    assert.ok(s.get('seed-lgtm'), 'a pre-seed file gets the shipped snippets');
    assert.ok(s.get('mine'), 'and keeps what was already there');
    assert.deepStrictEqual(read().seeded, ['seed-lgtm']);
    ok('a file written before seeding existed is seeded once, and keeps its own rows');
}
{
    // The trap the generation-counter version of this walked into: seeding a file
    // this build cannot parse, then flushing a version 1 document over the top of
    // one the next build owns.
    const doc = { version: VERSION + 1, snippets: [{ id: 'theirs' }] };
    put(doc);
    const s = new Snippets();
    assert.strictEqual(s.get('seed-lgtm'), null, 'a future-version file must not be seeded');
    assert.deepStrictEqual(read(), doc, 'and must not be written over');
    ok('a file from a newer build is left completely alone');
}
{
    // Bridge A seeds; the user deletes it; bridge B must not put it back, and must
    // not erase A's record of having offered it.
    try { fs.unlinkSync(STATE_FILE); } catch { /* first run */ }
    const a = new Snippets();
    a.remove('seed-lgtm');
    a.flush();

    const b = new Snippets();
    b.flush();
    assert.strictEqual(new Snippets().get('seed-lgtm'), null);
    assert.deepStrictEqual(read().seeded, ['seed-lgtm'], 'the record is unioned, never replaced');
    ok('a second bridge neither reseeds nor erases the record the first one wrote');
}
{
    // Every shipped id is stable rather than a UUID, which is what makes two
    // bridges seeding at once idempotent and what lets `seeded` name them at all.
    for (const seed of SEEDS) {
        assert.ok(/^seed-[a-z0-9-]+$/.test(seed.id), `${seed.id} is not a stable id`);
    }
    ok('every shipped snippet has a stable id');
}

console.log('\n--- the caps ---');
{
    const s = fresh();
    for (let i = 0; i < MAX_SNIPPETS; i++) {
        assert.ok(s.create({ title: `s${i}`, body: 'B' }), `create ${i} should have worked`);
    }
    assert.strictEqual(s.create({ title: 'one too many', body: 'B' }), null);
    // A ceiling, not a lifetime budget.
    s.remove(s.list()[0].id);
    assert.ok(s.create({ title: 'room again', body: 'B' }));
    ok(`snippets are capped at ${MAX_SNIPPETS}, and deleting one makes room`);
}
{
    const s = fresh();
    for (let i = 0; i < MAX_GROUPS; i++) {
        assert.ok(s.createGroup({ name: `g${i}` }), `group ${i} should have worked`);
    }
    assert.strictEqual(s.createGroup({ name: 'one too many' }), null);
    ok(`groups are capped at ${MAX_GROUPS}`);
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} groups passed`);
