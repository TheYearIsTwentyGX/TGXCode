'use strict';

// What a project declares in `.tgxcode/`, and the editor that writes it —
// bridge/commands.js.
//
// **HOME and the allowed roots are redirected before anything is required.**
// bridge/config.js resolves both at load and `withinRoots` gates every call
// here, so requiring the module with the real values in place would leave the
// suite one bug away from rewriting this repository's own commands.json — the
// file that puts the Dev instance button in the header. The assertion below
// re-checks that the directory under test really is inside the temporary one
// before a single write happens.
//
// There was no test for this module at all until the editor needed one: not the
// schema, not the merge, not the placeholder rule, not the malformed-file path.
// Those come first below, because the writer is built on them — a save is a
// validate() away from letting through whatever the reader would then drop.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_SESSIONS_ROOTS = home;

const cfg = require('../bridge/config.js');
const commands = require('../bridge/commands.js');

const project = path.join(home, 'proj');
fs.mkdirSync(project, { recursive: true });

// The guard the header promises. If the redirect did not take, stop.
assert.ok(cfg.withinRoots(project) && project.startsWith(home),
    `refusing to run: ${project} is not inside ${home}`);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };

const SHARED = path.join(project, cfg.TGX_DIR, cfg.COMMANDS_FILE);
const LOCAL = path.join(project, cfg.TGX_DIR, cfg.COMMANDS_LOCAL_FILE);

const write = (file, body) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
};
const read = (file) => fs.readFileSync(file, 'utf8');
const gone = (file) => { try { fs.unlinkSync(file); } catch { /* not there */ } };

/**
 * Between cases, and it clears the caches as well as the files.
 *
 * `load()` recomputes its stamp every call, but `ignoreCache` holds an answer
 * for ten seconds — longer than this whole suite takes — so a case that did not
 * reset it would be reading the previous case's world.
 */
const reset = () => {
    gone(SHARED);
    gone(LOCAL);
    commands.clearCaches(project);
};

/** The refusal code a call throws, or null when it did not throw. */
function codeOf(fn) {
    try { fn(); return null; }
    catch (err) { return err.code || 'no-code'; }
}
/** The error a call throws, for the cases that inspect `detail`. */
function errOf(fn) {
    try { fn(); return null; }
    catch (err) { return err; }
}

const rowFor = (scope) => commands.raw(project).files.find(f => f.scope === scope);
const stampFor = (scope) => rowFor(scope).stamp;
const mergedIds = () => commands.raw(project).merged.map(c => c.id);

const DEV = { id: 'dev', label: 'Dev instance', run: 'npm run dev' };

// ── reading ────────────────────────────────────────────────────────────────

reset();
{
    const got = commands.raw(project);
    assert.strictEqual(got.project, project);
    assert.strictEqual(got.files.length, 2);
    for (const f of got.files) {
        assert.strictEqual(f.exists, false);
        assert.strictEqual(f.parsed, false);
        assert.strictEqual(f.stamp, null);
        assert.deepStrictEqual(f.commands, []);
        assert.strictEqual(f.writable, true, `${f.scope} should be creatable`);
    }
    // Only the local row is asked whether it is excluded; the shared file is
    // meant to be committed, so the question is not about it.
    assert.strictEqual(got.files[0].ignored, null);
    assert.strictEqual(typeof got.files[1].ignored, 'boolean');
    ok('an empty project reports both scopes, creatable and empty');
}

reset();
{
    // The anti-regression for the whole editor. validate() builds a fresh object
    // and drops every key it has not heard of, so a raw() that returned its
    // output would make the form delete a hand-added field on the first
    // round trip — silently, and with the file looking like it saved fine.
    write(SHARED, { version: 1, commands: [{ ...DEV, nonsense: 1, note: 'keep me' }] });
    const entry = rowFor('project').commands[0];
    assert.strictEqual(entry.nonsense, 1);
    assert.strictEqual(entry.note, 'keep me');
    ok('raw() hands back entries verbatim, unknown keys and all');
}

reset();
{
    write(SHARED, '{\n "version": 1,\n "commands": [\n  {"id":"dev"},\n ]\n}\n');
    const row = rowFor('project');
    assert.strictEqual(row.exists, true);
    assert.strictEqual(row.parsed, false);
    assert.deepStrictEqual(row.commands, []);
    assert.ok(row.problem && /JSON/i.test(row.problem.message), row.problem);
    // The bytes survive a failed parse, which is the whole reason the JSON tab
    // can repair a file. readConfig() used to read them and throw them away.
    assert.ok(row.text && row.text.includes('"dev"'));
    ok('a file that will not parse keeps its text, so it can be repaired');
}

reset();
{
    write(SHARED, { version: 1, commands: [DEV] });
    write(LOCAL, { version: 1, commands: [{ id: 'dev', run: 'npm run dev -- --verbose' }] });
    const merged = commands.raw(project).merged.find(c => c.id === 'dev');
    assert.strictEqual(merged.label, 'Dev instance', 'the shared label survives');
    assert.strictEqual(merged.run, 'npm run dev -- --verbose');
    assert.strictEqual(merged.from, LOCAL);
    // And the local file still says only what it says.
    assert.deepStrictEqual(rowFor('project-local').commands[0], { id: 'dev', run: 'npm run dev -- --verbose' });
    ok('a local file overrides one field without restating the command');
}

reset();
{
    write(SHARED, { version: 1, commands: [{ ...DEV, env: { A: '1', B: '2' }, port: { range: [3000, 3009] } }] });
    write(LOCAL, { version: 1, commands: [{ id: 'dev', env: { B: 'two', C: '3' }, port: { range: [4000, 4001] } }] });
    const merged = commands.raw(project).merged.find(c => c.id === 'dev');
    // env merges key by key, so a local file can add one without restating.
    assert.deepStrictEqual(merged.env, { A: '1', B: 'two', C: '3' });
    // port replaces wholesale, because half a port block is not a thing.
    assert.deepStrictEqual(merged.port, { range: [4000, 4001] });
    ok('env merges key by key and port replaces wholesale');
}

reset();
{
    // A local entry whose id the shared file does not declare is a *first*
    // definition, so it needs a label and a run. The merged read drops it and
    // says so — which is the state the editor tags "orphaned".
    write(SHARED, { version: 1, commands: [DEV] });
    write(LOCAL, { version: 1, commands: [{ id: 'ghost', run: 'echo hi' }] });
    const got = commands.raw(project);
    assert.deepStrictEqual(got.merged.map(c => c.id), ['dev']);
    assert.ok(got.problems.some(p => p.id === 'ghost' && /label/.test(p.message)), got.problems);
    ok('a local fragment with no shared command is dropped and reported');
}

reset();
{
    write(SHARED, { version: 1, commands: [{ ...DEV, run: 'vite --port ${port}' }] });
    let got = commands.raw(project);
    assert.ok(got.problems.some(p => /declares no port range/.test(p.message)), got.problems);
    assert.deepStrictEqual(got.merged.map(c => c.id), []);

    // The range may come from the other file — the check is on the merge, not
    // on either half, and a writer that forgot that would refuse a legal file.
    write(LOCAL, { version: 1, commands: [{ id: 'dev', port: { range: [5000, 5009] } }] });
    commands.clearCaches(project);
    got = commands.raw(project);
    assert.deepStrictEqual(got.merged.map(c => c.id), ['dev']);
    ok('${port} is checked against the merged command, not one file');
}

{
    const err = commands.checkPlaceholders({ run: 'x ${wrogn}' });
    assert.strictEqual(err.field, 'run');
    assert.ok(/unknown placeholder/.test(err.message) && /worktree/.test(err.message), err.message);
    ok('an unknown placeholder names the field and lists the five that work');
}

{
    // The step that moved readConfig onto jsonfile.js and added `field` must not
    // have moved a single sentence: these strings are what a hand-editor reads
    // in a tooltip today.
    const at = (raw) => commands.validate(raw, SHARED).problem;
    assert.strictEqual(at({ id: 'A' }).message,
        'id must be lower-case letters, digits, dot, dash or underscore');
    assert.strictEqual(at({ id: 'A' }).field, 'id');
    assert.strictEqual(at({ id: 'a', label: 'x' }).message, 'run must be a non-empty string');
    assert.strictEqual(at({ id: 'a', label: 'x' }).field, 'run');
    assert.strictEqual(at({ id: 'a', label: 'x', run: 'y', port: { range: [1, 2] } }).message,
        'port.range must be two integers between 1024 and 65535, low first');
    assert.strictEqual(at({ id: 'a', label: 'x', run: 'y', port: { range: [1, 2] } }).field, 'port');
    ok('validate() carries a field and its messages are unchanged');
}

// ── writing ────────────────────────────────────────────────────────────────

reset();
{
    const out = commands.saveDoc({ scope: 'project', dir: project, stamp: null, commands: [DEV] });
    assert.strictEqual(out.file, SHARED);
    // Two spaces and a trailing newline, and `version` stamped by the writer —
    // the client never sends it, because a client that could send `version: 7`
    // is a client that can write a file this reader refuses wholesale.
    assert.strictEqual(read(SHARED), `${JSON.stringify({ version: 1, commands: [DEV] }, null, 2)}\n`);
    assert.deepStrictEqual(mergedIds(), ['dev']);
    ok('a save writes version 1, two-space JSON and a trailing newline');
}

reset();
{
    // Written as given, not as validate() cleans them: an unknown key the user
    // added by hand must survive a round trip through the editor.
    commands.saveDoc({ scope: 'project', dir: project, stamp: null,
        commands: [{ ...DEV, mine: { keep: true } }] });
    assert.deepStrictEqual(JSON.parse(read(SHARED)).commands[0].mine, { keep: true });
    ok('a save preserves keys the schema does not know about');
}

reset();
{
    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'project', dir: project, commands: [DEV],
    })), 'stamp', 'an absent stamp is a refusal, not a permission');

    commands.saveDoc({ scope: 'project', dir: project, stamp: null, commands: [DEV] });
    const now = stampFor('project');

    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'project', dir: project, stamp: null, commands: [DEV],
    })), 'exists', 'null means "this should not exist yet"');

    const stale = errOf(() => commands.saveDoc({
        scope: 'project', dir: project, stamp: '1:1', commands: [DEV],
    }));
    assert.strictEqual(stale.code, 'stale');
    assert.strictEqual(stale.detail.stamp, now);
    // A conflict carries the file as it is now, both ways, so the page can show
    // what it declined to overwrite instead of only that it declined.
    assert.ok(stale.detail.text.includes('Dev instance'));
    assert.deepStrictEqual(stale.detail.commands, [DEV]);

    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'project', dir: project, stamp: now, commands: [{ ...DEV, label: 'Dev' }],
    })), null, 'the right stamp goes through');
    ok('the stamp precondition: absent, null-but-present, wrong, and right');
}

reset();
{
    // The contract, and the one worth a test of its own: a document with one bad
    // entry writes *none* of itself. A writer that half-applied would leave the
    // file in a state nobody typed.
    write(SHARED, { version: 1, commands: [DEV] });
    const before = read(SHARED);
    const err = errOf(() => commands.saveDoc({
        scope: 'project', dir: project, stamp: stampFor('project'),
        commands: [{ ...DEV, label: 'Fine' }, { id: 'bad', label: 'Bad' }],
    }));
    assert.strictEqual(err.code, 'invalid');
    assert.strictEqual(read(SHARED), before, 'the good entry must not have landed either');
    assert.strictEqual(err.detail.problems.length, 1);
    assert.deepStrictEqual(
        { index: err.detail.problems[0].index, field: err.detail.problems[0].field },
        { index: 1, field: 'run' });
    ok('a refused save writes nothing, and points at the row and the field');
}

reset();
{
    // And the case that is easy to get wrong the other way: refusing a create
    // must not leave a file behind.
    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'project', dir: project, stamp: null, commands: [{ id: 'x' }],
    })), 'invalid');
    assert.strictEqual(fs.existsSync(SHARED), false);
    ok('a refused create leaves no file at all');
}

reset();
{
    const err = errOf(() => commands.saveDoc({
        scope: 'project', dir: project, stamp: null,
        commands: [{ id: 'a', label: 'A', run: 'x' }, { id: 'a', label: 'B', run: 'y' }],
    }));
    assert.strictEqual(err.code, 'invalid');
    assert.strictEqual(err.detail.problems[0].message, 'declared twice in this file');
    assert.strictEqual(err.detail.problems[0].index, 1);
    ok('two entries with one id are refused, naming the second');
}

reset();
{
    // Every problem, not the first: a form that shows one error per round trip
    // turns one paste into six saves.
    const err = errOf(() => commands.saveDoc({
        scope: 'project', dir: project, stamp: null,
        commands: [{ id: 'a' }, { id: 'b' }, { ...DEV }],
    }));
    assert.strictEqual(err.detail.problems.length, 2);
    assert.deepStrictEqual(err.detail.problems.map(p => p.index), [0, 1]);
    ok('a refusal reports every bad row, not just the first');
}

reset();
{
    // The local file is the only one that may leave label and run out, and only
    // for an id the shared file declares.
    write(SHARED, { version: 1, commands: [DEV] });
    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'project-local', dir: project, stamp: null,
        commands: [{ id: 'dev', run: 'other' }],
    })), null, 'an override needs only what it changes');

    gone(LOCAL);
    commands.clearCaches(project);
    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'project-local', dir: project, stamp: null,
        commands: [{ id: 'nope', run: 'other' }],
    })), 'invalid', 'a first definition has to be whole, even locally');

    gone(SHARED);
    commands.clearCaches(project);
    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'project', dir: project, stamp: null, commands: [{ id: 'dev', run: 'x' }],
    })), 'invalid', 'and the shared file may never leave a label out');
    ok('override-versus-first-definition follows the file, not the caller');
}

reset();
{
    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'nonsense', dir: project, stamp: null, commands: [],
    })), 'scope');
    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'project', dir: '', stamp: null, commands: [],
    })), 'dir');
    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'project', dir: '/etc', stamp: null, commands: [],
    })), 'dir', 'outside the allowed roots');
    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'project', dir: project, stamp: null, commands: 'nope',
    })), 'body');
    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'project', dir: project, stamp: null,
        commands: Array.from({ length: commands.MAX_COMMANDS + 1 },
            (_, i) => ({ id: `c${i}`, label: `C${i}`, run: 'x' })),
    })), 'invalid', 'more commands than one file may declare');
    // Every field is capped, but validate() ignores keys it has not heard of —
    // so a megabyte parked under one of them would pass the schema.
    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'project', dir: project, stamp: null,
        commands: [{ ...DEV, blob: 'x'.repeat(commands.MAX_FILE_BYTES + 1) }],
    })), 'size');
    ok('scope, directory, body, count and size each refuse with their own code');
}

reset();
{
    write(SHARED, '{ not json');
    const stamp = stampFor('project');
    // The whole point of the raw tab: a file the form cannot read is a file the
    // text box can still repair.
    assert.strictEqual(codeOf(() => commands.saveText({
        scope: 'project', dir: project, stamp,
        text: `${JSON.stringify({ version: 1, commands: [DEV] }, null, 2)}\n`,
    })), null);
    assert.deepStrictEqual(mergedIds(), ['dev']);
    ok('saveText repairs a file that no longer parses');
}

reset();
{
    const bad = (text) => codeOf(() => commands.saveText({
        scope: 'project', dir: project, stamp: null, text }));
    assert.strictEqual(bad('{ nope'), 'json');
    assert.strictEqual(bad('[]'), 'json', 'an array is not a document');
    assert.strictEqual(bad('{"version":7,"commands":[]}'), 'version');
    assert.strictEqual(bad('{"version":1,"commands":{}}'), 'json');
    assert.strictEqual(bad('{"version":1,"commands":[{"id":"x"}]}'), 'invalid');
    assert.strictEqual(fs.existsSync(SHARED), false, 'none of those wrote anything');
    ok('saveText still refuses a document this reader would not open');
}

reset();
{
    // Written through byte for byte: no re-indenting and no trailing-newline
    // fixing, so what somebody typed is what the diff shows.
    const text = '{"version":1,\n\t"commands":[{"id":"dev","label":"D","run":"x"}]}';
    commands.saveText({ scope: 'project', dir: project, stamp: null, text });
    assert.strictEqual(read(SHARED), text);
    ok('saveText writes the bytes it was given, unchanged');
}

reset();
{
    // Containment is against the **project root**, not `<project>/.tgxcode`. If
    // the directory itself is a symlink then commands.json inside it is an
    // ordinary file whose realpath sits inside the realpath of the link target —
    // so a check rooted one level down passes it, and the write lands outside
    // the project entirely.
    const evil = path.join(home, 'evil');
    fs.mkdirSync(evil, { recursive: true });
    fs.rmSync(path.join(project, cfg.TGX_DIR), { recursive: true, force: true });
    fs.symlinkSync(evil, path.join(project, cfg.TGX_DIR));

    assert.strictEqual(codeOf(() => commands.saveDoc({
        scope: 'project', dir: project, stamp: null, commands: [DEV],
    })), 'readonly');
    assert.strictEqual(fs.existsSync(path.join(evil, cfg.COMMANDS_FILE)), false,
        'nothing may appear at the symlink target');
    assert.strictEqual(rowFor('project').symlink, true, 'and the read says so too');

    fs.unlinkSync(path.join(project, cfg.TGX_DIR));
    ok('a symlinked .tgxcode is refused, and the read flags it');
}

reset();
{
    // mkdirSync on a .tgxcode that is a regular file throws ENOTDIR with a
    // message naming neither the directory nor what to do about it.
    fs.writeFileSync(path.join(project, cfg.TGX_DIR), 'not a directory');
    const err = errOf(() => commands.saveDoc({
        scope: 'project', dir: project, stamp: null, commands: [DEV],
    }));
    assert.strictEqual(err.code, 'write');
    assert.ok(err.message.includes(cfg.TGX_DIR) && /is a file, not a directory/.test(err.message), err.message);
    fs.unlinkSync(path.join(project, cfg.TGX_DIR));
    ok('a .tgxcode that is a file refuses with a sentence that names it');
}

reset();
{
    // The failure this one guards is invisible: load() caches for two seconds,
    // so a save followed immediately by a read can hand back the value from
    // before the write — which reads as the save not having worked.
    commands.saveDoc({ scope: 'project', dir: project, stamp: null, commands: [DEV] });
    assert.strictEqual(commands.load(project).commands[0].label, 'Dev instance');
    commands.saveDoc({ scope: 'project', dir: project, stamp: stampFor('project'),
        commands: [{ ...DEV, label: 'Renamed' }] });
    assert.strictEqual(commands.load(project).commands[0].label, 'Renamed',
        'a save must invalidate the read cache it would be read back through');
    ok('a save is visible to the very next read');
}

reset();
console.log(`\n${passed} checks passed`);
fs.rmSync(home, { recursive: true, force: true });
