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
assert.ok(kb.cycleOrder('default') && kb.cycleOrder('alphabetical'));
assert.ok(!kb.cycleOrder('Alphabetical') && !kb.cycleOrder(true) && !kb.cycleOrder(''));
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

// --- spinner weights are cleaned the same way -----------------------------
// The second map-valued setting, so it gets the same treatment for the same
// reason: one number somebody fat-fingered must not throw away the weights
// beside it.
write(userFile, {
    version: VERSION,
    spinner: {
        weights: {
            'Monty Python': 4,
            'Absurd / Nonsense': 0,       // muted on purpose, not a mistake
            'Tech / Programming': '3',    // a string is not a weight
            'Whimsical': -1,              // nor is a negative one
            'Kaomoji': 2000,              // nor one past the cap
        },
    },
});
prefs.cache.clear();
got = prefs.forCwd();
assert.deepStrictEqual(got.spinner.weights, { 'Monty Python': 4, 'Absurd / Nonsense': 0 });
assert.strictEqual(got.problems.length, 3, `expected three problems, got ${got.problems.length}`);
assert.ok(got.problems.every(p => /spinner\.weights/.test(p.message)));
assert.ok(got.problems.some(p => /"3".*Tech \/ Programming/.test(p.message)));
ok('one bad weight costs that entry and says so, and the rest survive');

write(userFile, { version: VERSION, spinner: { weights: [4] } });
prefs.cache.clear();
got = prefs.forCwd();
assert.deepStrictEqual(got.spinner.weights, {});
assert.ok(got.problems.some(p => /spinner\.weights/.test(p.message)));
ok('weights that are not a map are dropped and reported');

// A project may set the spinner — `spinner` is not user-only, because which
// voice a repo's sessions speak in is a reasonable thing for the repo to say.
write(userFile, { version: VERSION, spinner: { weights: { 'Monty Python': 4 } } });
write(projFile, { version: VERSION, spinner: { weights: { Whimsical: 9 } } });
prefs.cache.clear();
got = prefs.forCwd(project);
assert.deepStrictEqual(got.spinner.weights, { Whimsical: 9 },
    'a map-valued key is answered by the strongest file, not folded together');
ok('a project may weigh its own groups, and does so wholesale');
fs.unlinkSync(projFile);

// --- project colours are cleaned the same way -----------------------------
// The third map-valued key, and the only one whose *keys* carry meaning: a
// directory that is not an absolute path colours nothing, so it is rejected on
// its own account rather than left to fail silently.
clear();
write(userFile, {
    version: VERSION,
    projects: {
        colors: {
            [project]: '#a8c7fa',
            [`${home}/other`]: '#6DD58C',
            'proj': '#fff',
            [`${home}/third`]: 'green',
            [`${home}/fourth`]: '#fff;}',
            [`${home}/fifth`]: 42,
        },
    },
});
prefs.cache.clear();
got = prefs.forCwd();
assert.deepStrictEqual(got.projects.colors, {
    [project]: '#a8c7fa',
    [`${home}/other`]: '#6DD58C',
}, 'the good entries did not survive the bad ones beside them');
assert.ok(got.problems.some(p => /"proj" is not an absolute directory/.test(p.message)));
for (const bad of ['"green"', '"#fff;}"', '42']) {
    assert.ok(got.problems.some(p => p.message.startsWith(`projects.colors: ${bad} is not a colour`)),
        `no problem reported for ${bad}`);
}
ok('one colour that is not a colour does not take the projects beside it');

// `#fff;}` is the case the strictness is *for*: the client sets this value as a
// CSS custom property, so anything that gets through closes a declaration and
// opens whatever follows it.
assert.strictEqual(SHAPE.projects.colors({ [project]: '#fff;}' }), false);
assert.strictEqual(SHAPE.projects.colors({ [project]: 'var(--blue)' }), false);
assert.strictEqual(SHAPE.projects.colors({ [project]: '#abc' }), true);
assert.strictEqual(SHAPE.projects.colors({ [project]: '#AABBCC' }), true);
assert.strictEqual(SHAPE.projects.colors([]), false, 'an array is not a map');
assert.strictEqual(SHAPE.projects.colors({ 'proj': '#abc' }), false, 'a relative key');
assert.strictEqual(SHAPE.projects.colors({ [`${project}/`]: '#abc' }), false,
    'an unresolved key — cleanColors resolves, SHAPE only checks');
ok('the shape gate refuses what would become a CSS declaration');

// Two spellings of one directory must not become two entries, or the rail and
// the dialog would disagree about which one won.
clear();
write(userFile, { version: VERSION,
    projects: { colors: { [`${project}/`]: '#a8c7fa', [`${project}/sub/..`]: '#6dd58c' } } });
prefs.cache.clear();
assert.deepStrictEqual(prefs.forCwd().projects.colors, { [project]: '#6dd58c' },
    'a trailing slash made a second entry for one project');
ok('paths are resolved, so one project cannot hold two colours');

// Bounded like the other two maps: a file naming ten thousand directories is a
// mistake rather than a preference.
clear();
const many = {};
for (let i = 0; i < 260; i++) many[`${home}/p${i}`] = '#a8c7fa';
write(userFile, { version: VERSION, projects: { colors: many } });
prefs.cache.clear();
got = prefs.forCwd();
assert.strictEqual(Object.keys(got.projects.colors).length, 200);
assert.ok(got.problems.some(p => /more than 200 project colours/.test(p.message)));
ok('the colour map is bounded, and says so when it truncates');

// The backdrop wash: two plain keys beside the map. The default is the 13% the
// dialog drew before it was a setting, and a bad value falls back to it rather
// than turning the wash off or into a coloured sheet.
clear();
write(userFile, { version: VERSION });
prefs.cache.clear();
got = prefs.forCwd();
assert.strictEqual(got.projects.backdropTint, true);
assert.strictEqual(got.projects.backdropStrength, 13);
for (const bad of ['20', 41, -1, 12.5]) {
    clear();
    write(userFile, { version: VERSION,
        projects: { backdropTint: 'no', backdropStrength: bad } });
    prefs.cache.clear();
    got = prefs.forCwd();
    assert.strictEqual(got.projects.backdropStrength, 13, `${JSON.stringify(bad)} was taken`);
    assert.strictEqual(got.projects.backdropTint, true, 'a string was taken as a boolean');
}
clear();
write(userFile, { version: VERSION,
    projects: { backdropTint: false, backdropStrength: 0, colors: { [project]: '#abc' } } });
prefs.cache.clear();
got = prefs.forCwd();
assert.strictEqual(got.projects.backdropTint, false);
assert.strictEqual(got.projects.backdropStrength, 0, '0 is a strength, not a missing one');
assert.deepStrictEqual(got.projects.colors, { [project]: '#abc' });
ok('the backdrop tint defaults to what it was, and refuses what is not a strength');

// --- the rail's project order -----------------------------------------------
// `sort` and `newAt` are closed sets; the bumpOn* switches are booleans; and
// `order` is the list twin of `colors`: absolute, resolved, one entry per
// directory, and one bad entry costs only itself.
assert.strictEqual(DEFAULTS.projects.sort, 'recent', 'the default order is the one the rail always had');
for (const v of ['recent', 'dynamic', 'alpha', 'custom']) assert.ok(SHAPE.projects.sort(v), v);
for (const v of ['Recent', 'az', '', null, 1]) assert.ok(!SHAPE.projects.sort(v), JSON.stringify(v));
assert.ok(SHAPE.projects.newAt('top') && SHAPE.projects.newAt('bottom'));
assert.ok(!SHAPE.projects.newAt('middle') && !SHAPE.projects.newAt(true));
for (const k of ['bumpOnCreate', 'bumpOnUser', 'bumpOnAny', 'bumpOnTurn', 'bumpOnPr']) {
    assert.ok(SHAPE.projects[k](true) && SHAPE.projects[k](false), k);
    assert.ok(!SHAPE.projects[k]('true'), `${k} took a string`);
}
assert.strictEqual(DEFAULTS.projects.bumpOnAny, false, 'the noisy one is off by default');
assert.ok(SHAPE.projects.order([]));
assert.ok(SHAPE.projects.order([project, `${home}/other`]));
assert.ok(!SHAPE.projects.order(['proj']), 'a relative entry');
assert.ok(!SHAPE.projects.order([`${project}/`]), 'an unresolved entry — cleanOrder resolves');
assert.ok(!SHAPE.projects.order([project, project]), 'a duplicate');
assert.ok(!SHAPE.projects.order({ [project]: 1 }), 'a map is not a list');
ok('the order keys take their closed sets and nothing else');

clear();
write(userFile, { version: VERSION, projects: { sort: 'custom', newAt: 'bottom',
    order: [`${project}/`, 'proj', `${home}/other`, `${project}/sub/..`, 42] } });
prefs.cache.clear();
got = prefs.forCwd();
assert.strictEqual(got.projects.sort, 'custom');
assert.strictEqual(got.projects.newAt, 'bottom');
assert.deepStrictEqual(got.projects.order, [project, `${home}/other`],
    'the good entries did not survive the bad ones beside them');
assert.ok(got.problems.some(p => /"proj" is not an absolute directory/.test(p.message)));
assert.ok(got.problems.some(p => /listed twice/.test(p.message)));
ok('a custom order is cleaned entry by entry, resolved, and first place wins');

clear();
const orderSaved = prefs.save({ scope: 'user', patch: { projects: { order: [`${project}/`, `${home}/other`] } } });
assert.deepStrictEqual(read(userFile).projects.order, [project, `${home}/other`],
    'the order was written as typed rather than resolved');
assert.deepStrictEqual(orderSaved.prefs.projects.order, [project, `${home}/other`]);
assert.throws(() => prefs.save({ scope: 'user', patch: { projects: { order: ['proj'] } } }),
    (e) => e.code === 'value');
assert.throws(() => prefs.save({ scope: 'project', dir: project, patch: { projects: { sort: 'alpha' } } }),
    (e) => e.code === 'readonly');
ok('an order saves resolved, refuses a bad entry, and is user-only');

// --- user-only sections --------------------------------------------------
// Documented for `quota` long before anything enforced it, which held only
// because the call sites passed no cwd. A page that prints which file wins for
// each key cannot rely on that.
assert.deepStrictEqual([...USER_ONLY].sort(), ['keyboard', 'projects', 'quota', 'toolbar', 'wispr']);

clear();
write(userFile, { version: VERSION });
write(projFile, {
    transcript: { groupMinCalls: 5 },
    quota: { beacon: true, beaconDir: '/tmp/somewhere' },
    keyboard: { composerSend: 'ctrl-enter', contextualTerminalCopy: true },
    projects: { colors: { [project]: '#f28b82' } },
    wispr: { transforms: [{ id: 'lock', title: 'Lock', combo: 'Win+L' }] },
});
prefs.cache.clear();
got = prefs.forCwd(project);
assert.strictEqual(got.transcript.groupMinCalls, 5, 'a project may still set transcript');
assert.strictEqual(got.quota.beacon, DEFAULTS.quota.beacon, 'a project set quota.beacon');
assert.strictEqual(got.keyboard.composerSend, DEFAULTS.keyboard.composerSend,
    'a project set keyboard.composerSend');
// The map names *other* projects' paths, so a repository setting one would be a
// repository colouring its neighbours.
assert.deepStrictEqual(got.projects.colors, {}, 'a project coloured itself');
// The bridge presses these chords on the desktop, so a repository listing one
// would be a repository pressing keys on your machine.
assert.deepStrictEqual(got.wispr.transforms, [], 'a project added a Wispr transform');
for (const section of ['quota', 'keyboard', 'projects', 'wispr']) {
    assert.ok(got.problems.some(p => p.file === projFile
        && p.message.includes(`"${section}" may only be set in`)),
    `no problem reported for a project's "${section}"`);
}
ok('a repository cannot set the beacon directory, your keys, anybody’s colour, or a chord to press');

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
prefs.save({ scope: 'user', patch: { spinner: { weights: { 'Monty Python': 4 } } } });
prefs.save({ scope: 'user', patch: { spinner: { weights: { Whimsical: 2 } } } });
assert.deepStrictEqual(read(userFile).spinner.weights, { Whimsical: 2 },
    'spinner.weights is the other map, and goes over the same way');
ok('a map-valued setting is replaced whole');

// The path the colour UI actually takes: it holds the resolved map, sends all
// of it, and clears one project by leaving that key out. Worth its own case
// because the *key* is data here — a save has to spell a directory the way a
// read of the file will spell it back, or clearing a colour would miss.
clear();
prefs.save({ scope: 'user', patch: { projects: { colors: {
    [`${project}/`]: '#a8c7fa', [`${home}/other`]: '#6dd58c',
} } } });
assert.deepStrictEqual(read(userFile).projects.colors,
    { [project]: '#a8c7fa', [`${home}/other`]: '#6dd58c' },
    'the trailing slash was written to the file as typed');
const cleared = prefs.save({ scope: 'user',
    patch: { projects: { colors: { [`${home}/other`]: '#6dd58c' } } } });
assert.deepStrictEqual(cleared.prefs.projects.colors, { [`${home}/other`]: '#6dd58c' });
prefs.save({ scope: 'user', patch: { projects: { colors: null } } });
assert.ok(!('projects' in read(userFile)), 'an emptied colour map stayed in the file');
ok('colours are saved resolved, cleared by omission, and the section goes when it empties');

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
refuses({ scope: 'project', dir: project, patch: { projects: { colors: {} } } },
    'readonly', 'project colours at a project scope');
refuses({ scope: 'user', patch: { projects: { colors: { [project]: 'red' } } } },
    'value', 'a colour that is a name rather than a hex');
refuses({ scope: 'user', patch: { projects: { colors: { 'proj': '#abc' } } } },
    'value', 'a colour against a relative directory');
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

// --- the toolbar -------------------------------------------------------
// A list somebody edits by hand, cleaned entry by entry like the bindings — and
// the one setting with rules about what may not be done at all: Settings is
// never hidden, and the quota pill never leaves the bar.
clear();
write(userFile, {
    version: VERSION,
    toolbar: {
        items: [
            { id: 'dashboard', place: 'more', label: false },
            { id: 'nope', place: 'bar' },                 // not a button
            { id: 'dashboard', place: 'hidden' },         // listed twice
            { id: 'drafts', place: 'somewhere' },         // not a place
            { id: 'history', place: 'bar', label: 'no' }, // not a bool
            { id: 'settings', place: 'hidden' },          // may not be hidden
            { id: 'quota', place: 'more' },               // stays on the bar
            { id: 'live', place: 'hidden' },              // label defaults on
        ],
    },
});
prefs.cache.clear();
got = prefs.forCwd();
assert.deepStrictEqual(got.toolbar.items, [
    { id: 'dashboard', place: 'more', label: false },
    { id: 'settings', place: 'bar', label: true },
    { id: 'quota', place: 'bar', label: true },
    { id: 'live', place: 'hidden', label: true },
]);
assert.strictEqual(got.problems.length, 6, JSON.stringify(got.problems));
assert.ok(got.problems.some(p => /"nope" is not a toolbar button/.test(p.message)));
assert.ok(got.problems.some(p => /listed twice/.test(p.message)));
assert.ok(got.problems.some(p => /settings cannot be hidden/.test(p.message)));
assert.ok(got.problems.some(p => /quota cannot be put in "more"/.test(p.message)));
ok('toolbar entries are cleaned one by one, and Settings and Quota cannot be put away');

write(userFile, { version: VERSION, toolbar: { items: { live: 'more' } } });
prefs.cache.clear();
got = prefs.forCwd();
assert.deepStrictEqual(got.toolbar.items, []);
assert.ok(got.problems.some(p => /toolbar\.items/.test(p.message)));
ok('a toolbar that is not a list falls back to the built-in layout');

// A page sending a pinned button somewhere it may not go is a bug in the page,
// so the save refuses rather than quietly moving it.
write(userFile, { version: VERSION });
prefs.cache.clear();
refuses({ scope: 'user', patch: { toolbar: { items: [{ id: 'settings', place: 'hidden', label: false }] } } },
    'value', 'hiding Settings');
const saved = prefs.save({ scope: 'user', patch: { toolbar: { items: [
    { id: 'schedules', place: 'bar', label: false }, { id: 'tasks', place: 'more', label: true },
] } } });
assert.deepStrictEqual(saved.prefs.toolbar.items.map(e => e.id), ['schedules', 'tasks']);
prefs.save({ scope: 'user', patch: { toolbar: { items: null } } });
assert.deepStrictEqual(prefs.forCwd().toolbar.items, [], 'null did not put the default back');
assert.ok(!('toolbar' in read(userFile)), 'an emptied section should leave the file');
ok('a toolbar save refuses what the file would coerce, and null resets it');

// A repository does not get to rearrange your window.
write(projFile, { toolbar: { items: [{ id: 'live', place: 'hidden', label: true }] } });
prefs.cache.clear();
got = prefs.forCwd(project);
assert.deepStrictEqual(got.toolbar.items, []);
assert.ok(got.problems.some(p => p.file === projFile && /"toolbar" may only be set/.test(p.message)));
assert.ok(USER_ONLY.has('toolbar'));
refuses({ scope: 'project', dir: project, patch: { toolbar: { items: [] } } },
    'readonly', 'a project toolbar');
clear();
ok('a project file cannot set the toolbar');

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

// --- CLAUDE_SESSIONS_PREFS_DIR -------------------------------------------
// What lets a dev bridge press Save without touching the user's file. The path
// is computed when config.js loads, so it takes a process of its own. Unset
// gives the old location, and this process is the proof of that.
const cfg = require('../bridge/config.js');
assert.strictEqual(cfg.USER_TGX_DIR, path.join(home, '.tgxcode'));
assert.strictEqual(cfg.USER_PREFS_FILE, userFile);

{
    const childHome = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-home-'));
    const override = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-dir-'));
    const script = `
        const cfg = require(${JSON.stringify(path.join(__dirname, '../bridge/config.js'))});
        const { Prefs } = require(${JSON.stringify(path.join(__dirname, '../bridge/prefs.js'))});
        const prefs = new Prefs();
        prefs.save({ scope: 'user', patch: { transcript: { groupToolCalls: false } } });
        prefs.cache.clear();
        console.log(JSON.stringify({
            file: cfg.USER_PREFS_FILE, verbs: cfg.USER_VERBS_DIR,
            target: prefs.targetFile('user'), sources: prefs.forCwd('').sources,
        }));`;
    const env = { ...process.env, HOME: childHome, CLAUDE_SESSIONS_ROOTS: childHome,
        CLAUDE_SESSIONS_PREFS_DIR: override };
    const out = JSON.parse(require('child_process')
        .execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }).trim().split('\n').pop());

    const want = path.join(override, 'settings.json');
    assert.strictEqual(out.file, want);
    assert.strictEqual(out.target, want);
    assert.strictEqual(out.sources[0], want);
    assert.strictEqual(out.verbs, path.join(override, 'verbs'));
    assert.strictEqual(read(want).transcript.groupToolCalls, false);
    assert.ok(!fs.existsSync(path.join(childHome, '.tgxcode')),
        'a bridge with CLAUDE_SESSIONS_PREFS_DIR wrote to ~/.tgxcode anyway');

    fs.rmSync(childHome, { recursive: true, force: true });
    fs.rmSync(override, { recursive: true, force: true });
}
ok('CLAUDE_SESSIONS_PREFS_DIR takes the user file and its saves somewhere else');

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} prefs checks passed`);
