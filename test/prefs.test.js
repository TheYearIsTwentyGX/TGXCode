'use strict';

// Settings — bridge/prefs.js and bridge/keymap.js.
//
// No bridge needed. What matters here is a chain of four files somebody edits
// by hand and a page now writes, and the interesting cases are all about
// disagreement: a project file setting something only the user may set, a
// binding spelled three different ways, a `null` that means "remove this" and
// not "write the default", and a save that must not touch a key it was not
// asked about.
//
// **`HOME` is set before anything is required**, and that is load-bearing:
// `bridge/config.js` computes `USER_PREFS_FILE` at load, and `new Prefs()`
// writes the defaults there on first run. Requiring this file with the real
// home directory in place would have the suite rewrite the settings of whoever
// ran it — which is why test/usage.test.js avoids constructing `Prefs` at all.
// This is the version that can, because it owns the directory.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-test-'));
process.env.HOME = home;
process.env.CLAUDE_SESSIONS_ROOTS = home;

const keymap = require('../bridge/keymap.js');
const { Prefs, DEFAULTS, SHAPE, USER_ONLY, VERSION } = require('../bridge/prefs.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const userFile = path.join(home, '.tgxcode', 'settings.json');
const project = path.join(home, 'proj');
const projFile = path.join(project, '.tgxcode', 'settings.json');
const projLocal = path.join(project, '.tgxcode', 'settings.local.json');
fs.mkdirSync(path.join(project, '.tgxcode'), { recursive: true });

const write = (file, body) => fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const clear = () => {
    for (const f of [projFile, projLocal]) fs.rmSync(f, { force: true });
    prefs.cache.clear();
};

// --- the combo grammar ---------------------------------------------------
// A binding is text in a file people edit, so the aliases have to be accepted
// and the canonical spelling has to be the only thing written back.

for (const [input, want] of [
    ['Ctrl+1', 'Ctrl+1'],
    ['ctrl+k', 'Ctrl+K'],          // case is not meaning
    ['Cmd+F', 'Ctrl+F'],           // there is one modifier and it is spelled Ctrl
    ['meta+shift+3', 'Ctrl+Shift+3'],
    ['ALT+up', 'Alt+Up'],
    ['F3', 'F3'],
    ['Shift+F3', 'Shift+F3'],
    ['shift+ctrl+alt+slash', 'Ctrl+Alt+Shift+Slash'],   // one order out
]) {
    assert.strictEqual(keymap.normalize(input), want, `${input} → ${want}`);
}
ok('a combo is read in any spelling and written in one');

for (const bad of [
    'K', 'k', '3',                 // no modifier, and not a function key
    'Shift+K',                     // Shift alone is not a modifier for this
    'Ctrl+Ctrl+K', 'Ctrl+', '+', '', 'Ctrl+F13', 'Ctrl+Nope',
    null, 42, {},
]) {
    assert.strictEqual(keymap.normalize(bad), null, `${JSON.stringify(bad)} must not be a binding`);
}
ok('a combo without Ctrl or Alt is refused, and so is a key that does not exist');

// The reason the rule exists: the composer is a textarea, and a bare letter
// binding would make that letter untypeable with no way back but this file.
assert.ok(!keymap.allowed(keymap.parseCombo('K')));
assert.ok(keymap.allowed(keymap.parseCombo('F1')));
assert.ok(keymap.allowed(keymap.parseCombo('Shift+F12')));
ok('function keys are the only modifier-free bindings allowed');

for (const c of keymap.COMMANDS) {
    assert.strictEqual(keymap.normalize(c.default), c.default,
        `${c.id} default ${c.default} is not canonical`);
}
assert.strictEqual(new Set(keymap.COMMANDS.map(c => c.default)).size, keymap.COMMANDS.length,
    'two commands ship with the same default');
ok('every shipped default is canonical, allowed and unique');

// --- the defaults file ---------------------------------------------------
const prefs = new Prefs();
assert.ok(fs.existsSync(userFile), 'the defaults were not written out');
assert.deepStrictEqual(read(userFile), DEFAULTS, 'the seeded file is not the defaults');
ok('a first run writes the defaults where they can be found and edited');

// --- keyboard: what the shape allows ------------------------------------
const kb = SHAPE.keyboard;
assert.ok(kb.contextualTerminalCopy(true) && kb.contextualTerminalCopy(false));
assert.ok(!kb.contextualTerminalCopy('yes') && !kb.contextualTerminalCopy(1));
assert.ok(kb.composerSend('enter') && kb.composerSend('ctrl-enter'));
assert.ok(!kb.composerSend('Enter') && !kb.composerSend(true) && !kb.composerSend(''));
assert.ok(kb.bindings({}) && kb.bindings({ 'view.live': 'Ctrl+9' }) && kb.bindings({ 'find.next': null }));
assert.ok(!kb.bindings({ 'view.nope': 'Ctrl+9' }), 'an unknown command id must not pass');
assert.ok(!kb.bindings({ 'view.live': 'k' }), 'a bare letter must not pass');
assert.ok(!kb.bindings({ 'view.live': 'cmd+9' }), 'only the canonical spelling is stored');
assert.ok(!kb.bindings([]) && !kb.bindings(null) && !kb.bindings('Ctrl+9'));
ok('the keyboard block accepts what it should and nothing else');

// --- bindings are cleaned entry by entry --------------------------------
// Every other setting is one value, so a bad one costs that value. A map is
// different: one typo'd id must not throw away the bindings beside it.
write(userFile, {
    version: VERSION,
    keyboard: {
        bindings: {
            'view.live': 'cmd+shift+3',   // an alias, to be canonicalised
            'view.nope': 'Ctrl+9',        // not a command
            'rail.filter': 'k',           // not an allowed combo
            'find.next': null,            // deliberately unbound
        },
    },
});
prefs.cache.clear();
let got = prefs.forCwd();
assert.deepStrictEqual(got.keyboard.bindings,
    { 'view.live': 'Ctrl+Shift+3', 'find.next': null });
assert.strictEqual(got.problems.length, 2, `expected two problems, got ${got.problems.length}`);
assert.ok(got.problems.some(p => /view\.nope.*not a command/.test(p.message)));
assert.ok(got.problems.some(p => /"k".*not a usable combo for rail\.filter/.test(p.message)));
assert.ok(got.problems.every(p => p.file === userFile), 'a problem has to name its file');
ok('one bad binding costs that entry and says so, and the rest survive');

// A value that is not a map at all falls back whole, the way every other
// setting does.
write(userFile, { version: VERSION, keyboard: { bindings: ['Ctrl+9'] } });
prefs.cache.clear();
got = prefs.forCwd();
assert.deepStrictEqual(got.keyboard.bindings, {});
assert.ok(got.problems.some(p => /keyboard\.bindings/.test(p.message)));
ok('bindings that are not a map are dropped and reported');

// --- user-only sections --------------------------------------------------
// Documented for `quota` long before anything enforced it, which held only
// because the call sites passed no cwd. A page that prints which file wins for
// each key cannot rely on that.
assert.deepStrictEqual([...USER_ONLY].sort(), ['keyboard', 'quota']);

write(userFile, { version: VERSION });
write(projFile, {
    transcript: { groupMinCalls: 5 },
    quota: { beacon: true, beaconDir: '/tmp/somewhere' },
    keyboard: { composerSend: 'ctrl-enter', contextualTerminalCopy: true },
});
prefs.cache.clear();
got = prefs.forCwd(project);
assert.strictEqual(got.transcript.groupMinCalls, 5, 'a project may still set transcript');
assert.strictEqual(got.quota.beacon, DEFAULTS.quota.beacon, 'a project set quota.beacon');
assert.strictEqual(got.keyboard.composerSend, DEFAULTS.keyboard.composerSend,
    'a project set keyboard.composerSend');
for (const section of ['quota', 'keyboard']) {
    assert.ok(got.problems.some(p => p.file === projFile
        && p.message.includes(`"${section}" may only be set in`)),
    `no problem reported for a project's "${section}"`);
}
ok('a repository cannot set what directory Claude starts in, or which keys you use');

// The user file still may, obviously — that is the whole point of the split.
write(userFile, { version: VERSION, keyboard: { composerSend: 'ctrl-enter' } });
prefs.cache.clear();
assert.strictEqual(prefs.forCwd(project).keyboard.composerSend, 'ctrl-enter');
ok('the user file sets the sections a project may not');

// --- precedence ----------------------------------------------------------
write(userFile, { version: VERSION, transcript: { groupMinCalls: 3 } });
write(projFile, { transcript: { groupMinCalls: 5 } });
write(projLocal, { transcript: { groupMinCalls: 9 } });
prefs.cache.clear();
assert.strictEqual(prefs.forCwd(project).transcript.groupMinCalls, 9);
fs.rmSync(projLocal);
prefs.cache.clear();
assert.strictEqual(prefs.forCwd(project).transcript.groupMinCalls, 5);
fs.rmSync(projFile);
prefs.cache.clear();
assert.strictEqual(prefs.forCwd(project).transcript.groupMinCalls, 3);
ok('local beats shared beats user, and each falls back when it goes');

// --- raw(): what each file says on its own -------------------------------
// forCwd answers "what is in force", which cannot tell a value you set from one
// you inherited — and a control that cannot tell those apart offers to clear
// things that were never set.
write(projFile, { transcript: { groupMinCalls: 5 } });
prefs.cache.clear();
let rows = prefs.raw(project);
assert.deepStrictEqual(rows.map(r => r.scope), ['user', 'project', 'project-local']);
assert.deepStrictEqual(rows[0].values.transcript, { groupMinCalls: 3 });
assert.deepStrictEqual(rows[1].values.transcript, { groupMinCalls: 5 });
assert.deepStrictEqual(rows[2].values, {}, 'a file that is not there says nothing');
assert.ok(rows[0].exists && rows[1].exists && !rows[2].exists);
assert.ok(rows.every(r => r.parsed), 'every file here parses');
assert.ok(rows.every(r => r.writable), 'every file here is writable');
assert.ok(rows.every(r => r.target), 'each of the three is its scope\'s target here');
ok('raw() reports what each file sets, whether it exists and whether it can be written');

// Without a directory there is only one file to report, and no project scope to
// write — which is what the panel reads to disable them.
assert.deepStrictEqual(prefs.raw().map(r => r.scope), ['user']);
assert.strictEqual(prefs.targetFile('project'), null);
assert.strictEqual(prefs.targetFile('project', '/etc'), null, 'outside the roots');
assert.strictEqual(prefs.targetFile('user'), userFile);
ok('a project scope has no file without a directory this bridge will read');

// A file that does not parse is reported as such rather than as empty, because
// the difference decides whether saving to it is allowed.
fs.writeFileSync(projLocal, '{ not json');
prefs.cache.clear();
rows = prefs.raw(project);
assert.strictEqual(rows[2].exists, true);
assert.strictEqual(rows[2].parsed, false);
assert.ok(rows[2].problems.length, 'an unparseable file has to say something');
ok('a file that does not parse is exists-but-not-parsed, not absent');

// --- save() --------------------------------------------------------------
clear();
write(userFile, { version: VERSION, futureThing: { x: 1 }, live: { compact: true } });
prefs.cache.clear();

let out = prefs.save({ scope: 'user', patch: { transcript: { groupToolCalls: false } } });
assert.strictEqual(out.file, userFile);
assert.strictEqual(out.prefs.transcript.groupToolCalls, false, 'the answer has to be the new one');
let doc = read(userFile);
assert.deepStrictEqual(doc.futureThing, { x: 1 },
    'a key this bridge has never heard of must survive a save');
assert.deepStrictEqual(doc.live, { compact: true }, 'an unrelated section must survive');
assert.strictEqual(doc.version, VERSION);
ok('a save writes the key it was given and leaves the rest of the file alone');

// `null` removes, which is not the same as writing the default: it is the only
// way to say "I do not care about this one" once you have said otherwise.
prefs.save({ scope: 'user', patch: { live: { compact: null } } });
doc = read(userFile);
assert.ok(!('live' in doc), 'an emptied section should go rather than sit there as {}');
assert.strictEqual(prefs.forCwd().live.compact, DEFAULTS.live.compact);
ok('null removes a key, and an emptied section goes with it');

// A patch is per key, and `keyboard.bindings` is one key whose value is a map —
// so it goes over wholesale. The page holds the resolved map and sends all of it.
prefs.save({ scope: 'user', patch: { keyboard: { bindings: { 'view.live': 'Alt+L' } } } });
assert.deepStrictEqual(read(userFile).keyboard.bindings, { 'view.live': 'Alt+L' });
prefs.save({ scope: 'user', patch: { keyboard: { bindings: { 'view.tasks': 'Alt+T' } } } });
assert.deepStrictEqual(read(userFile).keyboard.bindings, { 'view.tasks': 'Alt+T' },
    'a map-valued key is replaced, not merged into');
ok('a map-valued setting is replaced whole');

// Aliases are canonicalised on the way to disk, so nothing downstream has to
// know them.
prefs.save({ scope: 'user', patch: { keyboard: { bindings: { 'view.live': 'cmd+shift+9' } } } });
assert.deepStrictEqual(read(userFile).keyboard.bindings, { 'view.live': 'Ctrl+Shift+9' });
ok('a save spells a binding the way this app spells it');

// Each scope writes its own file, and the chain still decides what wins.
prefs.save({ scope: 'project', dir: project, patch: { transcript: { groupMinCalls: 5 } } });
prefs.save({ scope: 'project-local', dir: project, patch: { transcript: { groupMinCalls: 9 } } });
assert.strictEqual(read(projFile).transcript.groupMinCalls, 5);
assert.strictEqual(read(projLocal).transcript.groupMinCalls, 9);
assert.strictEqual(prefs.forCwd(project).transcript.groupMinCalls, 9);
ok('each scope writes its own file and the strongest still wins');

// Nothing left behind. An interrupted write would otherwise leave a `.tmp`
// beside a settings file, which is the kind of thing somebody opens by mistake.
assert.ok(!fs.existsSync(`${userFile}.tmp`) && !fs.existsSync(`${projFile}.tmp`));
ok('the atomic write leaves no .tmp behind');

// --- save() refuses, with a code -----------------------------------------
// A page sending a value the bridge will not keep is a bug in the page, so the
// whole call is refused rather than the value quietly dropped — the opposite of
// what a hand-edited *file* gets, and deliberately.
const refuses = (req, code, why) => {
    assert.throws(() => prefs.save(req), (err) => {
        assert.strictEqual(err.code, code, `${why}: expected code ${code}, got ${err.code}`);
        return true;
    }, why);
};

refuses({ scope: 'project', dir: project, patch: { keyboard: { composerSend: 'enter' } } },
    'readonly', 'a user-only section at a project scope');
refuses({ scope: 'project', dir: project, patch: { quota: { beacon: true } } },
    'readonly', 'quota at a project scope');
refuses({ scope: 'user', patch: { transcript: { groupMinCalls: 1 } } },
    'value', 'below the floor');
refuses({ scope: 'user', patch: { transcript: { groupMinCalls: '3' } } },
    'value', 'the right number as a string');
refuses({ scope: 'user', patch: { keyboard: { bindings: { 'view.live': 'k' } } } },
    'value', 'a combo with no modifier');
refuses({ scope: 'user', patch: { keyboard: { bindings: { 'view.nope': 'Ctrl+9' } } } },
    'value', 'a command that does not exist');
refuses({ scope: 'user', patch: { nope: { a: 1 } } }, 'section', 'a section that does not exist');
refuses({ scope: 'user', patch: { live: { nope: true } } }, 'section', 'a key that does not exist');
refuses({ scope: 'user', patch: { live: true } }, 'section', 'a section that is not an object');
refuses({ scope: 'user', patch: null }, 'section', 'no patch at all');
refuses({ scope: 'project', patch: { live: { compact: true } } }, 'dir', 'a project scope with no directory');
refuses({ scope: 'project', dir: '/etc', patch: { live: { compact: true } } },
    'dir', 'a directory outside the roots');
refuses({ scope: 'sideways', patch: { live: { compact: true } } }, 'scope', 'a scope that does not exist');
ok('every refusal carries the code a route needs to classify it');

// A refused save must not have written anything on its way to the refusal —
// the validation pass is deliberately whole-patch and up front.
const before = fs.readFileSync(userFile, 'utf8');
try {
    prefs.save({ scope: 'user', patch: { live: { compact: false }, transcript: { groupMinCalls: 1 } } });
    assert.fail('a patch with one bad value was accepted');
} catch (err) { assert.strictEqual(err.code, 'value'); }
assert.strictEqual(fs.readFileSync(userFile, 'utf8'), before,
    'the good half of a refused patch was written anyway');
ok('a refused patch writes none of itself, not even the valid keys');

// Whatever is in an unparseable file is somebody's work, and a settings page is
// not a good enough reason to throw it away.
fs.writeFileSync(projLocal, '{ half a file');
prefs.cache.clear();
refuses({ scope: 'project-local', dir: project, patch: { live: { compact: true } } },
    'unparseable', 'a target that does not parse');
assert.strictEqual(fs.readFileSync(projLocal, 'utf8'), '{ half a file');
ok('a file that does not parse is refused rather than replaced');

// --- the cache cannot outlive a save ------------------------------------
// forCwd caches on mtime *and* on two seconds of clock, which is long enough
// that a save followed straight away by a read could answer with the old value.
clear();
write(userFile, { version: VERSION, live: { compact: false } });
prefs.cache.clear();
assert.strictEqual(prefs.forCwd().live.compact, false);
prefs.save({ scope: 'user', patch: { live: { compact: true } } });
assert.strictEqual(prefs.forCwd().live.compact, true, 'a stale cache survived a save');
ok('a save invalidates the cache it would otherwise be read through');

// --- the page copy -------------------------------------------------------
// `sources` names files in somebody's home directory and nothing in the page
// reads it, so the <meta> copy leaves it out along with the diagnostics.
const page = prefs.page('');
assert.ok(!('sources' in page) && !('problems' in page));
for (const section of Object.keys(SHAPE)) {
    assert.ok(page[section], `the page copy is missing "${section}"`);
}
assert.strictEqual(page.version, VERSION);
ok('the page copy carries every section and none of the diagnostics');

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} prefs checks passed`);
