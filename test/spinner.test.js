'use strict';

// The words a turn in progress calls itself — bridge/spinner.js.
//
// No bridge needed: what matters here is a directory of files somebody edits by
// hand, and the interesting cases are the ones where they edited it wrongly. A
// group named three different ways has to find one file; a group named with a
// `../` in it has to find nothing at all; a file with a blank in its list has to
// lose the blank and keep the group.
//
// Everything runs against a temporary directory. `Spinner` takes `userDir` for
// exactly this reason: seeding is part of what is under test, and seeding into
// somebody's real `~/.tgxcode/verbs/` is not a thing a test suite may do.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Spinner, slugFor, norm, readGroup } = require('../bridge/spinner.js');
const { RunnerPool } = require('../bridge/runner.js');
const { SHAPE, DEFAULTS } = require('../bridge/prefs.js');
const { parse, cell, DEFAULTS_GROUP } = require('../scripts/import-spinner-verbs.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spinner-test-'));
const verbs = path.join(root, 'verbs');
fs.mkdirSync(verbs);

/** A group on disk, in whichever shape the case is about. */
const write = (name, body) => fs.writeFileSync(path.join(verbs, name), JSON.stringify(body, null, 2));

/** A Spinner reading our directory, with the settings a case wants. */
const spinnerWith = (settings, opts) => new Spinner(
    { forCwd: () => ({ spinner: { randomize: true, groups: [], weights: {}, rerollMs: 8000, ...settings } }) },
    { userDir: verbs, seed: false, ...opts },
);

/** How often each verb came up over `n` draws. */
const tally = (spinner, n) => {
    const counts = new Map();
    for (let i = 0; i < n; i++) {
        const verb = spinner.pick('');
        counts.set(verb, (counts.get(verb) || 0) + 1);
    }
    return counts;
};

/** The share of `n` draws that went to any of `verbs`, as a percentage. */
const shareOf = (counts, verbs, n) =>
    (verbs.reduce((sum, v) => sum + (counts.get(v) || 0), 0) / n) * 100;

// --- a category as a filename, and back ----------------------------------
// The slug has to survive the punctuation real category names carry, and it is
// also the only thing standing between a settings file and the filesystem.
assert.strictEqual(slugFor('Tech / Programming'), 'Tech_Programming');
assert.strictEqual(slugFor('Absurd / Nonsense'), 'Absurd_Nonsense');
assert.strictEqual(slugFor('Claude Code Defaults'), 'Claude_Code_Defaults');
assert.strictEqual(slugFor('Gen-Z'), 'Gen-Z');
assert.strictEqual(slugFor('1960s Hippie'), '1960s_Hippie');
ok('a category becomes the filename it was seeded as');

for (const hostile of ['../../etc/passwd', '..', '/etc/passwd', './../x']) {
    const slug = slugFor(hostile);
    assert.ok(!slug.includes('/') && !slug.includes('\\') && !slug.includes('..'),
        `${hostile} slugged to ${slug}`);
}
ok('a name cannot slug its way out of the directory');

// Case and punctuation carry no meaning in a category name, so neither may
// decide a match.
assert.strictEqual(norm('Tech / Programming'), norm('Tech_Programming'));
assert.strictEqual(norm('Tech / Programming'), norm('tech-programming'));
assert.notStrictEqual(norm('Gen-Z'), norm('Gen-X'));
ok('two spellings of one category compare equal');

// --- the shapes a group file may take -------------------------------------
write('Monty_Python.json', { Category: 'Monty Python', Verbs: ['Ni-ing', 'Silly-walking'] });
write('Lowercase.json', { category: 'Lower Case', verbs: ['Shouting'] });
write('Bare.json', ['Bare-arraying']);

assert.deepStrictEqual(readGroup(path.join(verbs, 'Monty_Python.json')).verbs, ['Ni-ing', 'Silly-walking']);
assert.strictEqual(readGroup(path.join(verbs, 'Monty_Python.json')).category, 'Monty Python');
assert.strictEqual(readGroup(path.join(verbs, 'Lowercase.json')).category, 'Lower Case');
assert.deepStrictEqual(readGroup(path.join(verbs, 'Bare.json')).verbs, ['Bare-arraying']);
assert.strictEqual(readGroup(path.join(verbs, 'Bare.json')).category, null);
ok('{Category, Verbs}, {category, verbs} and a bare array all parse');

// A file people edit by hand collects mistakes. Each costs its own entry and
// nothing else.
write('Messy.json', { Category: 'Messy', Verbs: ['Good', '', '  ', 42, null, 'Good', 'Fine'] });
const messy = readGroup(path.join(verbs, 'Messy.json'));
assert.deepStrictEqual(messy.verbs, ['Good', 'Fine'], 'blanks, non-strings and the repeat are gone');
assert.strictEqual(messy.problems.length, 1);
assert.match(messy.problems[0].message, /4 entries are not a verb/);
ok('a group keeps its verbs and reports what was not one');

// A category that is not a name costs the file its title, not its contents.
write('Untitled.json', { Category: 7, Verbs: ['Still-working'] });
const untitled = readGroup(path.join(verbs, 'Untitled.json'));
assert.deepStrictEqual(untitled.verbs, ['Still-working']);
assert.strictEqual(untitled.category, null);
assert.match(untitled.problems[0].message, /not a name/);
ok('a bad Category falls back to the filename rather than losing the group');

fs.writeFileSync(path.join(verbs, 'Broken.json'), '{ this is not json');
const broken = readGroup(path.join(verbs, 'Broken.json'));
assert.deepStrictEqual(broken.verbs, []);
assert.strictEqual(broken.problems.length, 1);
write('NoList.json', { Category: 'No List' });
assert.match(readGroup(path.join(verbs, 'NoList.json')).problems[0].message, /no "Verbs" array/);
ok('unparseable and listless files are reported, not thrown');

// A BOM is what a Windows editor leaves behind, and prefs.js and commands.js
// both tolerate it. So does this.
fs.writeFileSync(path.join(verbs, 'Bommed.json'), '﻿' + JSON.stringify(['Byte-ordering']));
assert.deepStrictEqual(readGroup(path.join(verbs, 'Bommed.json')).verbs, ['Byte-ordering']);
ok('a leading BOM does not break a group');

// --- finding a group by the name in a settings file -----------------------
const sp = spinnerWith({ groups: [] });
for (const spelling of ['Monty Python', 'Monty_Python', 'monty-python', 'MONTYPYTHON']) {
    assert.strictEqual(path.basename(sp.resolve('', spelling) || ''), 'Monty_Python.json', spelling);
}
ok('one group answers to every reasonable spelling of its name');

for (const hostile of ['../../etc/passwd', '..', '/etc/passwd', '']) {
    assert.strictEqual(sp.resolve('', hostile), null, hostile);
}
assert.strictEqual(sp.resolve('', 'No Such Group'), null);
ok('a name matching no group resolves to nothing');

// The slow path: `Category` is inside the file, so a file whose name does not
// match it still has to be findable — that is the whole reason the category is
// written down twice.
write('zzz-renamed.json', { Category: 'Deploy Chants', Verbs: ['Rolling-out', 'Draining'] });
const renamed = spinnerWith({ groups: [] });
assert.strictEqual(path.basename(renamed.resolve('', 'Deploy Chants') || ''), 'zzz-renamed.json');
assert.strictEqual(path.basename(renamed.resolve('', 'deploychants') || ''), 'zzz-renamed.json');
ok('a renamed file is still found by the Category inside it');

const listing = renamed.groups('');
const chants = listing.groups.find(g => g.name === 'Deploy Chants');
assert.ok(chants, 'the listing names it by its Category, not its filename');
assert.strictEqual(chants.count, 2);
assert.ok(listing.problems.some(p => /does not match the filename/.test(p.message)),
    'and says the two disagree rather than leaving it a mystery');
ok('a filename/Category mismatch works and is reported');

// --- the pool the spinner draws from --------------------------------------
write('Overlap.json', { Category: 'Overlap', Verbs: ['Ni-ing', 'Overlapping'] });
const pooled = spinnerWith({ groups: ['Monty Python', 'Overlap'] }).pool('');
assert.deepStrictEqual(pooled.verbs, ['Ni-ing', 'Silly-walking', 'Overlapping'],
    'the same verb in two groups is one verb');
assert.strictEqual(pooled.problems.length, 0);
ok('a pool is the enabled groups, deduped');

const missing = spinnerWith({ groups: ['Monty Python', 'Not A Group'] }).pool('');
assert.deepStrictEqual(missing.verbs, ['Ni-ing', 'Silly-walking'], 'the group that exists still counts');
assert.ok(missing.problems.some(p => /no group named "Not A Group"/.test(p.message)));
ok('an enabled group with no file is skipped and named');

// --- what the runner actually asks for ------------------------------------
// Null, not a fallback string: the verb is a prefix now, so the runner has to be
// able to tell "no verb" from "a verb that happens to read like the old label".
// That is what makes randomize:false compose to exactly what came before.
assert.strictEqual(spinnerWith({ randomize: false, groups: ['Monty Python'] }).pick(''), null);
assert.strictEqual(spinnerWith({ groups: [] }).pick(''), null);
assert.strictEqual(spinnerWith({ groups: ['Not A Group'] }).pick(''), null);
ok('with randomizing off, or nothing to say, there is no verb at all');

assert.strictEqual(spinnerWith({ groups: ['Bare'] }).pick('', 'Bare-arraying'), 'Bare-arraying',
    'a group of one has no alternative and must not stall on that');
ok('a single-verb group returns that verb even when it is the last one');

// A re-roll landing on the word already on screen reads as a stuck label, so it
// must not happen while there is anything else to say.
const rolling = spinnerWith({ groups: ['Monty Python', 'Overlap'] });
for (let i = 0; i < 200; i++) {
    for (const last of ['Ni-ing', 'Silly-walking', 'Overlapping']) {
        assert.notStrictEqual(rolling.pick('', last), last);
    }
}
ok('a re-roll never repeats the verb already on screen');

const drawn = new Set();
for (let i = 0; i < 400; i++) drawn.add(rolling.pick(''));
assert.deepStrictEqual([...drawn].sort(), ['Ni-ing', 'Overlapping', 'Silly-walking'],
    'every verb in the pool comes up, and nothing outside it does');
ok('picks are drawn from the whole pool and only the pool');

assert.strictEqual(spinnerWith({ groups: ['Monty Python'], rerollMs: 4000 }).rerollMs(''), 4000);
assert.strictEqual(spinnerWith({ groups: ['Monty Python'], rerollMs: 0 }).rerollMs(''), 0);
assert.strictEqual(
    spinnerWith({ randomize: false, groups: ['Monty Python'], rerollMs: 8000 }).rerollMs(''), 0,
    'nothing to drift towards when there is one thing to say');
ok('the drift interval follows the setting, and stops when randomizing is off');

// --- weights: how often each group gets to speak ---------------------------
// A draw is two steps — a group by weight, then a verb inside it — and the whole
// point of the first step is that a group's share stops being decided by how
// long its list happens to be. The bands below are wide because these are real
// `Math.random` draws, but they are nowhere near each other: at 4,000 draws the
// standard error is under a point, and the flat pool this replaced would have
// put the one-verb group at 25% rather than 50%.
write('Solo.json', { Category: 'Solo', Verbs: ['Soloing'] });
write('Trio.json', { Category: 'Trio', Verbs: ['Firsting', 'Seconding', 'Thirding'] });
const TRIO = ['Firsting', 'Seconding', 'Thirding'];

const even = tally(spinnerWith({ groups: ['Solo', 'Trio'] }), 4000);
const evenSolo = shareOf(even, ['Soloing'], 4000);
assert.ok(evenSolo > 40 && evenSolo < 60,
    `an unweighed group is one share: expected Solo near 50%, got ${evenSolo.toFixed(1)}%`);
ok('with no weights every enabled group is equally likely, whatever its size');

const tilted = tally(spinnerWith({ groups: ['Solo', 'Trio'], weights: { Trio: 3 } }), 4000);
const tiltedTrio = shareOf(tilted, TRIO, 4000);
assert.ok(tiltedTrio > 65 && tiltedTrio < 85,
    `weight 3 against weight 1: expected Trio near 75%, got ${tiltedTrio.toFixed(1)}%`);
ok('a weight is a share of the draws, not a nudge scaled by the group size');

// Muting rather than unchecking: the group stays in `groups`, so the number is
// still there when it is wanted back, but nothing it holds can be drawn.
const muted = spinnerWith({ groups: ['Solo', 'Trio'], weights: { Solo: 0 } });
assert.deepStrictEqual(muted.pool('').verbs, TRIO, 'a muted group is not in the pool at all');
assert.deepStrictEqual(muted.pool('').buckets.map(b => b.name), ['Trio']);
const mutedDraws = tally(muted, 400);
assert.strictEqual(mutedDraws.get('Soloing'), undefined, 'a muted verb must never be drawn');
ok('a weight of 0 mutes a group without unchecking it');

assert.strictEqual(spinnerWith({ groups: ['Solo'], weights: { Solo: 0 } }).pick(''), null,
    'nothing left to say composes to the old label, the same as no groups at all');
ok('muting everything is the same answer as enabling nothing');

// A muted group must not be the one that claims a verb a live group also has,
// or turning a group off would quietly take a word away from the group left on.
write('Shadow.json', { Category: 'Shadow', Verbs: ['Firsting'] });
const shadowed = spinnerWith({ groups: ['Shadow', 'Trio'], weights: { Shadow: 0 } }).pool('');
assert.deepStrictEqual(shadowed.verbs, TRIO, 'dedup must skip a group that can never be drawn');
ok('a muted group does not swallow a verb from a group that is still on');

// Keys are names out of a settings file, so they are matched the way every
// other group name here is.
write('Two_Words.json', { Category: 'Two / Words', Verbs: ['Twoing'] });
for (const spelling of ['Two / Words', 'Two_Words', 'two-words']) {
    const got = spinnerWith({ groups: ['Two / Words', 'Trio'], weights: { [spelling]: 9 } }).pool('');
    assert.strictEqual(got.buckets.find(b => b.name === 'Two / Words').weight, 9,
        `a weight spelled ${spelling} has to find the group`);
}
ok('a weight finds its group however the name is spelled');

const strayWeight = spinnerWith({ groups: ['Trio'], weights: { 'Not A Group': 4 } }).pool('');
assert.deepStrictEqual(strayWeight.verbs, TRIO, 'a weight nothing matches costs nothing else');
assert.ok(strayWeight.problems.some(p => /no group named "Not A Group" to weigh/.test(p.message)));
ok('a weight naming no group at all is reported');

// Unchecking is how a group is turned off, so the number it was given is kept
// and says nothing — the alternative makes the checkbox destructive.
const remembered = spinnerWith({ groups: ['Trio'], weights: { Solo: 4 } }).pool('');
assert.deepStrictEqual(remembered.verbs, TRIO);
assert.strictEqual(remembered.problems.length, 0,
    'a weight on a group that exists but is unchecked is not a problem');
ok('a weight on an unchecked group is remembered quietly');

// The one way a two-step draw can repeat itself: a group of one verb, drawn
// again, holding the word already on screen. It has to reach past that group.
const heavy = spinnerWith({ groups: ['Solo', 'Trio'], weights: { Solo: 50 } });
for (let i = 0; i < 300; i++) {
    assert.notStrictEqual(heavy.pick('', 'Soloing'), 'Soloing');
}
ok('a heavily weighted single-verb group still cannot repeat itself');

// Changing a number has to be seen, and no file moved for it to be seen by.
const before = spinnerWith({ groups: ['Solo', 'Trio'] });
assert.strictEqual(before.pool('').weight, 2);
assert.strictEqual(spinnerWith({ groups: ['Solo', 'Trio'], weights: { Trio: 7 } }).pool('').weight, 8);
ok('the pool cache keys on the weights as well as the files');

// --- seeding --------------------------------------------------------------
// The catalogue is written out on first run because a collection with no UI in
// front of it has to be on disk to be editable at all.
const seeded = path.join(root, 'seeded');
const seeder = new Spinner({ forCwd: () => ({ spinner: DEFAULTS.spinner }) }, { userDir: seeded });
const files = fs.readdirSync(seeded);
assert.ok(files.length > 100, `seeded ${files.length} groups`);
assert.ok(files.includes('Monty_Python.json'));
assert.ok(!files.some(f => f.endsWith('.tmp')), 'nothing half-written left behind');
const shipped = JSON.parse(fs.readFileSync(path.join(seeded, 'Tech_Programming.json'), 'utf8'));
assert.strictEqual(shipped.Category, 'Tech / Programming',
    'the category a filename cannot spell is written inside the file');
assert.ok(Array.isArray(shipped.Verbs) && shipped.Verbs.length > 0);
ok('first run writes the catalogue out, one file per group');

// The defaults have to name groups that are actually there, or a fresh install
// says Thinking… and looks broken.
for (const name of DEFAULTS.spinner.groups) {
    assert.ok(seeder.resolve('', name), `default group "${name}" is not in the catalogue`);
}
assert.ok(seeder.pool('').verbs.length > 100);
ok('every group enabled by default exists in what was seeded');

// Deleting a group you dislike has to stick. If a missing file were treated as
// one to restore, the directory would undo your edits on the next run.
fs.unlinkSync(path.join(seeded, 'Monty_Python.json'));
new Spinner({ forCwd: () => ({ spinner: DEFAULTS.spinner }) }, { userDir: seeded });
assert.ok(!fs.existsSync(path.join(seeded, 'Monty_Python.json')), 'a deleted group came back');
ok('a group you deleted stays deleted');

// --- what a settings file is allowed to say -------------------------------
const shape = SHAPE.spinner;
assert.strictEqual(shape.randomize(true), true);
assert.strictEqual(shape.randomize('yes'), false);
assert.strictEqual(shape.randomize(1), false);

assert.strictEqual(shape.groups(['Monty Python']), true);
assert.strictEqual(shape.groups([]), true);
assert.strictEqual(shape.groups('Monty Python'), false, 'one name is still a list of one');
assert.strictEqual(shape.groups(['Monty Python', 7]), false);
assert.strictEqual(shape.groups(['']), false);
assert.strictEqual(shape.groups(new Array(201).fill('x')), false);
assert.strictEqual(shape.groups(['x'.repeat(81)]), false);

assert.strictEqual(shape.weights({}), true, 'no weights at all is the default');
assert.strictEqual(shape.weights({ Trio: 3 }), true);
assert.strictEqual(shape.weights([]), false, 'a list of weights names nothing');
assert.strictEqual(shape.weights(null), false);
assert.strictEqual(shape.weights('Trio'), false);

assert.strictEqual(shape.rerollMs(8000), true);
assert.strictEqual(shape.rerollMs(0), true, '0 is how you turn the drift off');
assert.strictEqual(shape.rerollMs(10), false, 'faster than anyone can read');
assert.strictEqual(shape.rerollMs('8000'), false);
assert.strictEqual(shape.rerollMs(8000.5), false);
assert.strictEqual(shape.rerollMs(-1), false);
ok('the settings shape refuses what would quietly break the spinner');

// The defaults must themselves pass the check that guards the file.
for (const [key, check] of Object.entries(shape)) {
    assert.strictEqual(check(DEFAULTS.spinner[key]), true, `default spinner.${key} fails its own shape`);
}
ok('the defaults satisfy their own validation');

// --- the importer ---------------------------------------------------------
// Upstream is a README, so the parse is part of the contract. The fixture
// carries the two things that actually caught us: backticked cells, and a
// heading whose count disagrees with its table.
const README = [
    '# Fixture',
    '',
    '## Built-in Default Verbs (3)',
    '',
    'These ship with Claude Code.',
    '',
    'Thinking, Percolating, Reticulating',
    '',
    '## Additional Verbs by Category',
    '',
    '### Spinner Verbs',
    '',
    '- [Faces (2)](#faces-2)',
    '',
    '### Manual Setup',
    '',
    'Not a group.',
    '',
    '### Faces (2)',
    '',
    '| Verb |',
    '|------|',
    '| `(o^▽^o)` |',
    '| `` ( ´ ▽ ` ) `` |',
    '',
    '### Miscounted (1)',
    '',
    'A group whose heading lies.',
    '',
    '| Verb |',
    '|------|',
    '| One |',
    '| Two |',
    '',
].join('\n');

const { groups, warnings } = parse(README);
assert.deepStrictEqual(Object.keys(groups).sort(), ['Claude Code Defaults', 'Faces', 'Miscounted']);
assert.deepStrictEqual(groups[DEFAULTS_GROUP], ['Thinking', 'Percolating', 'Reticulating']);
assert.deepStrictEqual(groups.Faces, ['(o^▽^o)', '( ´ ▽ ` )'], 'backticks come off, doubled ones too');
assert.deepStrictEqual(groups.Miscounted, ['One', 'Two']);
assert.ok(!('Manual Setup' in groups) && !('Spinner Verbs' in groups), 'prose headings are not groups');
assert.ok(warnings.some(w => /Miscounted.*says 1, parsed 2/.test(w)),
    'a count that disagrees is a note, not a silent truncation');
ok('the importer reads a README the way upstream writes one');

assert.strictEqual(cell('| Plain |'), 'Plain');
assert.strictEqual(cell('| `Fenced` |'), 'Fenced');
assert.strictEqual(cell('|  |'), null);
ok('a table cell becomes the verb it holds, or nothing');


// --- the label the two halves make together -------------------------------
// Runner's half of this feature (bridge/runner.js `_work` / `_say`), tested here
// because it is the same feature: what a turn in progress says.

/** A runner whose verbs are a known rotation, so the label is what is on test. */
function runnerSaying(words, rerollMs = 0) {
    const pool = new RunnerPool();
    let n = 0;
    pool.thinking = () => (words.length ? words[n++ % words.length] : null);
    pool.rerollAfter = () => rerollMs;
    return pool.ensure(`probe-${words.length}-${rerollMs}`, { cwd: root });
}

const composed = runnerSaying(['Percolating']);
composed._work();
assert.strictEqual(composed.activity, 'Percolating…');
composed._work('Reading runner.js');
assert.strictEqual(composed.activity, 'Percolating… Reading runner.js',
    'the verb keeps its place and the tool name follows it');
composed._work('Writing…');
assert.strictEqual(composed.activity, 'Percolating… Writing',
    'one ellipsis to a label, not "Percolating… Writing…"');
composed._work();
assert.strictEqual(composed.activity, 'Percolating…', 'a finished call gives its name back');
ok('a verb and a detail compose into one label');

// The wire carries the halves as well as the whole, because the rail has room
// for about twenty characters and has to pick the informative one.
composed._work('Reading runner.js');
assert.strictEqual(composed.status().verb, 'Percolating');
assert.strictEqual(composed.status().detail, 'Reading runner.js');
assert.strictEqual(composed.status().activity, 'Percolating… Reading runner.js');
composed._work();
assert.strictEqual(composed.status().detail, null,
    'null exactly when the verb is all there is to say, so the rail falls back to it');
ok('status carries the verb and the detail as well as the label');

// With no verb the label has to be byte-identical to what this app showed before
// any of this existed. This is the regression that would matter most.
const plain = runnerSaying([]);
plain._work();
assert.strictEqual(plain.activity, 'Thinking…');
plain._work('Reading runner.js');
assert.strictEqual(plain.activity, 'Reading runner.js');
plain._work('Writing…');
assert.strictEqual(plain.activity, 'Writing…');
assert.strictEqual(plain.status().verb, null);
ok('with no verb the label is exactly what it always was');

// Anything that is not work clears both halves, so a question waiting on a
// person never wears a verb and nothing is left armed behind it.
const cleared = runnerSaying(['Percolating'], 50);
cleared._work('Reading runner.js');
assert.ok(cleared._reroll, 'a verb with an interval arms a drift');
cleared._setState('busy', 'Waiting for you: a plan to approve');
assert.strictEqual(cleared.activity, 'Waiting for you: a plan to approve');
assert.strictEqual(cleared.status().verb, null);
assert.strictEqual(cleared.status().detail, null);
assert.strictEqual(cleared._reroll, null, 'and the drift is cancelled with it');
ok('a state that is not work wears no verb and leaves no timer');

// The point of the change: the verb keeps moving through a tool call that never
// re-announces itself, and the call keeps its name the whole time.
const drifting = runnerSaying(['Alpha', 'Beta', 'Gamma'], 20);
const labels = [];
drifting.on('status', (s) => labels.push(s.activity));
drifting._work('Running: sleep 20');
setTimeout(() => {
    assert.ok(labels.length >= 3, `only ${labels.length} labels — the drift did not run`);
    assert.ok(labels.every(a => a.endsWith(' Running: sleep 20')),
        'the tool name has to survive every re-roll');
    assert.ok(new Set(labels).size > 1, 'and the verb has to actually change');
    ok('the verb drifts through a long tool call without displacing its name');

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${pass} spinner checks passed`);
    process.exit(0);
}, 140);
