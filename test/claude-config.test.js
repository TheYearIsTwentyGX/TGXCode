'use strict';

// Claude Code's own settings — bridge/claude-config.js, bridge/claude-schema.js
// and bridge/jsonfile.js.
//
// **HOME is redirected before anything is required, and here that is not a
// tidiness measure.** bridge/config.js resolves `~/.claude/settings.json` at
// load, and this module writes it. Requiring the module with the real home in
// place would leave the suite one bug away from rewriting the user's live
// Claude Code configuration — the permission rules and hooks that decide what
// every session on this machine may do. So the redirect comes first, and the
// assertions below re-check that the paths under test really are inside the
// temporary directory before a single write happens.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-test-'));
const managed = path.join(home, 'managed-settings.json');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_SESSIONS_ROOTS = home;
process.env.CLAUDE_SESSIONS_MANAGED_SETTINGS = managed;

const cfg = require('../bridge/config.js');
const jsonfile = require('../bridge/jsonfile.js');
const schema = require('../bridge/claude-schema.js');
const { ClaudeConfig, setPath, hookSummary, ourStatusLine } = require('../bridge/claude-config.js');

// The guard the header promises. If HOME did not take, stop before writing.
assert.ok(cfg.USER_CLAUDE_SETTINGS.startsWith(home),
    `refusing to run: ${cfg.USER_CLAUDE_SETTINGS} is not inside ${home}`);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };

const project = path.join(home, 'proj');
fs.mkdirSync(path.join(project, '.claude'), { recursive: true });

const userFile = cfg.USER_CLAUDE_SETTINGS;
const projFile = path.join(project, '.claude', 'settings.json');
const localFile = path.join(project, '.claude', 'settings.local.json');

const write = (file, doc) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`);
};
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const gone = (file) => { try { fs.unlinkSync(file); } catch { /* not there */ } };
const reset = () => { for (const f of [userFile, projFile, localFile, managed]) gone(f); };

/** The refusal code a call throws, or null when it did not throw. */
function codeOf(fn) {
    try { fn(); return null; }
    catch (err) { return err.code || 'no-code'; }
}

const cc = new ClaudeConfig();
const fresh = () => { cc.cache.clear(); return cc; };

// ── the file is the truth ───────────────────────────────────────────────────

reset();
write(userFile, {
    theme: 'dark-ansi',
    wibble: { deep: [1, 2, 3] },
    switchModelsOnFlag: false,
    permissions: { allow: ['Bash(a)'], defaultMode: 'auto' },
});

{
    const before = fs.readFileSync(userFile, 'utf8');
    fresh().save({ scope: 'user', patch: { theme: 'light' } });
    const after = read(userFile);
    assert.deepStrictEqual(after.wibble, { deep: [1, 2, 3] },
        'a key the catalogue has never heard of must survive a save');
    assert.strictEqual(after.theme, 'light');
    assert.notStrictEqual(before, fs.readFileSync(userFile, 'utf8'));
    ok('an uncatalogued key round-trips a form write untouched');
}

{
    assert.strictEqual(read(userFile).version, undefined,
        'this module must never stamp a version into somebody else’s file');
    ok('no version key is ever written');
}

{
    const got = fresh().read(project);
    const paths = got.unknown.map(u => u.path);
    assert.ok(paths.includes('wibble.deep'), `expected wibble.deep in ${paths.join(', ')}`);
    assert.ok(paths.includes('switchModelsOnFlag'));
    const scalar = got.unknown.find(u => u.path === 'switchModelsOnFlag');
    assert.strictEqual(scalar.kind, 'scalar');
    const coll = got.unknown.find(u => u.path === 'wibble.deep');
    assert.strictEqual(coll.kind, 'array');
    ok('uncatalogued keys are reported, and scalars are told from collections');
}

{
    // The generic tier: a key nothing models, editable because it already
    // holds a bool.
    fresh().save({ scope: 'user', patch: { switchModelsOnFlag: true } });
    assert.strictEqual(read(userFile).switchModelsOnFlag, true);
    assert.strictEqual(
        codeOf(() => fresh().save({ scope: 'user', patch: { switchModelsOnFlag: 'yes' } })),
        'value', 'a generic path may not change JSON type');
    assert.strictEqual(read(userFile).switchModelsOnFlag, true, 'the refusal wrote nothing');
    ok('a generic scalar is editable, and only as the type it already holds');
}

{
    assert.strictEqual(
        codeOf(() => fresh().save({ scope: 'user', patch: { neverHeardOfIt: 1 } })),
        'path', 'a key nothing in the chain has is not invented by a form');
    // An uncatalogued path holding a collection is refused for the *shape*
    // rather than for the missing stamp, which is the more useful of the two
    // sentences: the answer is "use Edit as JSON", not "send a stamp".
    assert.strictEqual(
        codeOf(() => fresh().save({ scope: 'user', patch: { 'wibble.deep': [9] } })),
        'path', 'an uncatalogued collection has no control to produce it');
    ok('an unknown key is refused, and an unknown collection says to use JSON');
}

{
    // A value the catalogue does not recognise is kept, not corrected.
    write(userFile, { askUserQuestionTimeout: 'never', theme: 'something-custom' });
    const got = fresh().read('');
    assert.strictEqual(got.effective.askUserQuestionTimeout.value, 'never');
    assert.strictEqual(got.effective.theme.value, 'something-custom');
    assert.ok(schema.check('askUserQuestionTimeout', 'never'),
        'an open choice must accept the value that is actually on disk');
    ok('a catalogued key keeps a value the catalogue does not list');
}

// ── precedence, and the one place it is a union ─────────────────────────────

reset();
write(userFile, { theme: 'dark', permissions: { allow: ['Bash(user)'], defaultMode: 'default' } });
write(projFile, { permissions: { allow: ['Bash(proj)'] } });
write(localFile, { theme: 'light', permissions: { allow: ['Bash(local)', 'Bash(user)'] } });

{
    const got = fresh().read(project);
    assert.deepStrictEqual(got.files.map(f => f.scope),
        ['user', 'project', 'project-local', 'managed']);
    assert.strictEqual(got.effective.theme.value, 'light');
    assert.strictEqual(got.effective.theme.scope, 'project-local');
    assert.strictEqual(got.effective['permissions.defaultMode'].scope, 'user');
    ok('a scalar takes the strongest file that sets it');
}

{
    const rules = fresh().read(project).effective['permissions.allow'];
    assert.strictEqual(rules.merged, true,
        'permission lists add up across scopes; the page must not call them overridden');
    assert.deepStrictEqual(rules.value, ['Bash(user)', 'Bash(proj)', 'Bash(local)'],
        'the union, weakest first, with a rule named twice appearing once');
    assert.deepStrictEqual(rules.from.map(f => [f.scope, f.count]),
        [['user', 1], ['project', 1], ['project-local', 2]]);
    ok('permission lists union rather than override, and say which file gave what');
}

{
    write(managed, { theme: 'managed-wins' });
    const got = fresh().read(project);
    const row = got.files.find(f => f.scope === 'managed');
    assert.strictEqual(row.readonly, true);
    assert.strictEqual(row.writable, false);
    assert.strictEqual(row.target, false);
    assert.strictEqual(got.effective.theme.scope, 'managed');
    assert.strictEqual(codeOf(() => fresh().save({ scope: 'managed', patch: { theme: 'x' } })),
        'readonly');
    ok('managed settings are the strongest row and refuse every write');
    gone(managed);
}

// ── the stamp precondition ─────────────────────────────────────────────────

reset();
write(userFile, { permissions: { allow: ['Bash(one)'] } });

{
    const stale = fresh().read('').files[0].stamp;
    // Something else writes while the page holds the old answer. A settings
    // file's mtime has millisecond resolution, so a write in the same
    // millisecond would collide — the size differs here, which is the other
    // half of the stamp and why it is not mtime alone.
    write(userFile, { permissions: { allow: ['Bash(one)', 'Bash(approved-since)'] } });

    let thrown;
    try {
        fresh().save({ scope: 'user', stamp: stale, patch: { 'permissions.allow': ['Bash(one)'] } });
    } catch (err) { thrown = err; }
    assert.ok(thrown, 'a whole-collection write against a moved file must be refused');
    assert.strictEqual(thrown.code, 'stale');
    assert.ok(thrown.detail && thrown.detail.text.includes('approved-since'),
        'the refusal carries the file as it is now, so the page can show it');
    assert.deepStrictEqual(read(userFile).permissions.allow,
        ['Bash(one)', 'Bash(approved-since)'], 'the rule approved since is still there');
    ok('a stale whole-collection write is refused and drops nothing');
}

{
    const now = fresh().read('').files[0].stamp;
    fresh().save({ scope: 'user', stamp: now, patch: { 'permissions.allow': ['Bash(kept)'] } });
    assert.deepStrictEqual(read(userFile).permissions.allow, ['Bash(kept)']);
    ok('the same write with the current stamp goes through');
}

{
    // The case the stamp does *not* guard, and must not need to: one scalar.
    write(userFile, { theme: 'dark', editorMode: 'normal' });
    const before = fresh().read('').files[0].stamp;
    write(userFile, { theme: 'dark', editorMode: 'vim' });   // somebody ran /config
    fresh().save({ scope: 'user', patch: { theme: 'light' } });
    const after = read(userFile);
    assert.strictEqual(after.theme, 'light');
    assert.strictEqual(after.editorMode, 'vim',
        'a scalar patch reads immediately before writing, so it cannot revert a sibling');
    assert.ok(before, 'the stamp was available and deliberately not required');
    ok('a scalar patch needs no stamp and still cannot clobber a concurrent change');
}

{
    gone(userFile);
    assert.strictEqual(
        codeOf(() => fresh().saveText({ scope: 'user', stamp: 'nope', text: '{}' })),
        'stale', 'a stamp for a file that is gone is stale');
    fresh().saveText({ scope: 'user', stamp: null, text: '{"theme":"created"}' });
    assert.strictEqual(read(userFile).theme, 'created');
    assert.strictEqual(
        codeOf(() => fresh().saveText({ scope: 'user', stamp: null, text: '{}' })),
        'exists', 'stamp null means the file should not be there');
    ok('stamp null creates the file, and refuses once something else has');
}

// ── the raw tab is the repair path ─────────────────────────────────────────

{
    write(userFile, '{ this is not json');
    assert.strictEqual(codeOf(() => fresh().save({ scope: 'user', patch: { theme: 'x' } })),
        'unparseable', 'there is nothing for a patch to merge into');
    const stamp = fresh().read('').files[0].stamp;
    fresh().saveText({ scope: 'user', stamp, text: '{"theme":"repaired"}' });
    assert.strictEqual(read(userFile).theme, 'repaired');
    ok('a file that does not parse refuses a patch and accepts a replacement');
}

{
    const stamp = fresh().read('').files[0].stamp;
    assert.strictEqual(codeOf(() => fresh().saveText({ scope: 'user', stamp, text: '[1,2]' })),
        'json', 'a settings file is an object, not an array');
    assert.strictEqual(codeOf(() => fresh().saveText({ scope: 'user', stamp, text: '{oops' })),
        'json');
    assert.strictEqual(read(userFile).theme, 'repaired', 'neither refusal wrote anything');
    ok('a raw save refuses anything that is not a JSON object');
}

// ── paths a client must not be able to write ───────────────────────────────

{
    write(userFile, { theme: 'dark' });
    for (const bad of ['__proto__.polluted', 'constructor.prototype.x', 'a.__proto__.b',
        'permissions.prototype']) {
        assert.strictEqual(codeOf(() => fresh().save({ scope: 'user', patch: { [bad]: 1 } })),
            'path', `${bad} must be refused by name`);
    }
    assert.strictEqual({}.polluted, undefined, 'nothing reached Object.prototype');
    assert.strictEqual(codeOf(() => fresh().save({ scope: 'user', patch: { 'a.b.c.d.e': 1 } })),
        'path', 'a path deeper than the schema goes is refused');
    assert.strictEqual(codeOf(() => fresh().save({ scope: 'user', patch: { 'a..b': 1 } })),
        'path', 'an empty segment is refused');
    ok('reserved property names and over-deep paths are refused');
}

{
    assert.strictEqual(codeOf(() => fresh().save({ scope: 'nonsense', patch: { theme: 'x' } })),
        'scope');
    assert.strictEqual(codeOf(() => fresh().save({ scope: 'project', patch: { theme: 'x' } })),
        'dir', 'a project scope with no directory');
    assert.strictEqual(
        codeOf(() => fresh().save({ scope: 'project', dir: '/etc', patch: { theme: 'x' } })),
        'dir', 'a directory outside the roots this bridge will read');
    assert.strictEqual(codeOf(() => fresh().save({ scope: 'user', patch: {} })), 'body');
    ok('every scope and directory refusal carries the code a route classifies on');
}

// ── refusing to write through a symlink ────────────────────────────────────

{
    const elsewhere = path.join(home, 'elsewhere.json');
    write(elsewhere, { theme: 'not-mine' });
    const linkProject = path.join(home, 'linked');
    fs.mkdirSync(path.join(linkProject, '.claude'), { recursive: true });
    const link = path.join(linkProject, '.claude', 'settings.json');
    fs.symlinkSync(elsewhere, link);

    assert.strictEqual(
        codeOf(() => fresh().save({ scope: 'project', dir: linkProject, patch: { theme: 'x' } })),
        'readonly');
    assert.strictEqual(read(elsewhere).theme, 'not-mine', 'the link target is untouched');
    const row = fresh().read(linkProject).files.find(f => f.scope === 'project');
    assert.strictEqual(row.symlink, true);
    assert.strictEqual(row.writable, false);
    ok('a symlinked settings file is reported and never written through');
}

// ── the catalogue validates only what the form produces ────────────────────

{
    write(userFile, { theme: 'dark' });
    assert.strictEqual(
        codeOf(() => fresh().save({ scope: 'user', patch: { editorMode: 'emacs' } })),
        'value', 'a closed choice refuses a value the form should never have sent');
    assert.strictEqual(
        codeOf(() => fresh().save({ scope: 'user', patch: { cleanupPeriodDays: 0 } })),
        'value');
    const stamp = fresh().read('').files[0].stamp;
    assert.strictEqual(codeOf(() => fresh().save({
        scope: 'user', stamp, patch: { 'permissions.allow': ['Bash(a)', 'Bash(a)'] },
    })), 'value', 'a duplicate rule is always a mistake');
    assert.strictEqual(codeOf(() => fresh().save({ scope: 'user', stamp, patch: { hooks: {} } })),
        'value', 'the form has no control that produces a hooks block');
    ok('the form’s own bad values are refused loudly');
}

{
    // The refusal-writes-nothing invariant, with a good key beside a bad one.
    write(userFile, { theme: 'dark' });
    assert.strictEqual(codeOf(() => fresh().save({
        scope: 'user', patch: { editorMode: 'vim', cleanupPeriodDays: -1 },
    })), 'value');
    assert.strictEqual(read(userFile).editorMode, undefined,
        'the valid key beside the bad one was not written either');
    ok('a refused patch writes none of itself');
}

// ── removal ────────────────────────────────────────────────────────────────

{
    write(userFile, { theme: 'dark', permissions: { defaultMode: 'auto' } });
    fresh().save({ scope: 'user', patch: { 'permissions.defaultMode': null } });
    const after = read(userFile);
    assert.strictEqual(after.permissions, undefined,
        'a section emptied by a removal goes rather than sitting there as {}');
    assert.strictEqual(after.theme, 'dark');
    ok('null removes a key, and prunes the section it emptied');
}

{
    write(userFile, { theme: 'dark', permissions: { allow: ['Bash(x)'], defaultMode: 'auto' } });
    const stamp = fresh().read('').files[0].stamp;
    assert.strictEqual(
        codeOf(() => fresh().save({ scope: 'user', patch: { 'permissions.allow': null } })),
        'stamp', 'removing a whole collection needs the stamp too');
    fresh().save({ scope: 'user', stamp, patch: { 'permissions.allow': null } });
    assert.deepStrictEqual(read(userFile).permissions, { defaultMode: 'auto' });
    ok('removing a collection needs the stamp and leaves its siblings alone');
}

// ── the bytes on disk ──────────────────────────────────────────────────────

{
    write(userFile, { theme: 'dark', zzz: 'last' });
    fresh().save({ scope: 'user', patch: { editorMode: 'vim' } });
    const text = fs.readFileSync(userFile, 'utf8');
    assert.strictEqual(text, '{\n  "theme": "dark",\n  "zzz": "last",\n  "editorMode": "vim"\n}\n',
        'two spaces, a trailing newline, existing order kept and the new key appended');
    const leftovers = fs.readdirSync(path.dirname(userFile)).filter(f => f.includes('.tmp'));
    assert.deepStrictEqual(leftovers, [], 'the atomic write leaves no .tmp behind');
    ok('a save is two spaces, a trailing newline, and one line of diff');
}

{
    // The bug this change fixed on the way past: two bridges saving at once
    // used to race on `<file>.tmp`. The pid is what stops that.
    const file = path.join(home, 'tmpname.json');
    jsonfile.writeAtomic(file, '{}\n');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{}\n');
    assert.ok(!fs.existsSync(`${file}.tmp`) && !fs.existsSync(`${file}.${process.pid}.tmp`));
    ok('writeAtomic names its temporary file after the process that made it');
}

// ── a BOM, and a file too large ────────────────────────────────────────────

{
    write(userFile, `﻿${JSON.stringify({ theme: 'bommed' })}`);
    assert.strictEqual(fresh().read('').effective.theme.value, 'bommed');
    ok('a BOM is tolerated, the way every other config reader here tolerates one');
}

{
    write(userFile, `{"pad":"${'x'.repeat(jsonfile.MAX_FILE_BYTES)}"}`);
    const row = fresh().read('').files[0];
    assert.strictEqual(row.parsed, false);
    assert.ok(row.problems[0].includes('larger than'));
    ok('a file past the size cap is exists-but-not-parsed, with a reason');
}

// ── the hooks summary, and the check a text editor cannot do ───────────────

{
    const present = path.join(home, 'hook-present.py');
    fs.writeFileSync(present, '# hook\n');
    const summary = hookSummary({
        PostToolUse: [{
            matcher: 'Edit',
            hooks: [{ type: 'command', command: `python3 "${present}"` }],
        }],
        Stop: [{
            hooks: [{ type: 'command', command: `python3 "${path.join(home, 'gone.py')}"` }],
        }],
        Notification: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
    });
    assert.strictEqual(summary.length, 3);
    assert.strictEqual(summary[0].event, 'PostToolUse');
    assert.strictEqual(summary[0].matcher, 'Edit');
    assert.strictEqual(summary[0].script.exists, true);
    assert.strictEqual(summary[1].matcher, null, 'no matcher means every tool');
    assert.strictEqual(summary[1].script.exists, false,
        'a hook pointing at a deleted script is the thing worth reporting');
    assert.strictEqual(summary[2].script, null,
        'a command that names no script is not reported as missing');
    assert.ok(!summary[0].command.includes(home), 'the home directory is shortened away');
    ok('the hooks summary names each hook and whether its script is still there');
}

// ── the status line this app installed ─────────────────────────────────────

{
    assert.strictEqual(ourStatusLine({ command: 'python3 /x/scripts/quota-statusline.py' }), true);
    assert.strictEqual(ourStatusLine({ command: 'starship prompt' }), false);
    assert.strictEqual(ourStatusLine(null), false);
    write(userFile, {
        statusLine: { type: 'command', command: 'python3 /x/scripts/quota-statusline.py' },
    });
    const line = fresh().read('').statusLine;
    assert.strictEqual(line.ours, true);
    assert.strictEqual(line.scope, 'user');
    ok('the status line reports whether this app is the one that set it');
}

// ── setPath on its own ─────────────────────────────────────────────────────

{
    const doc = { a: { b: 1, c: 2 } };
    setPath(doc, 'a.b', 9);
    assert.deepStrictEqual(doc, { a: { b: 9, c: 2 } });
    setPath(doc, 'a.b', null);
    setPath(doc, 'a.c', null);
    assert.deepStrictEqual(doc, {}, 'the emptied object goes with its last key');
    setPath(doc, 'x.y.z', true);
    assert.deepStrictEqual(doc, { x: { y: { z: true } } }, 'missing objects are created');
    setPath(doc, 'nope.gone', null);
    assert.deepStrictEqual(doc, { x: { y: { z: true } } }, 'removing what is absent adds nothing');
    ok('setPath creates, replaces, removes and prunes');
}

// ── clean up ───────────────────────────────────────────────────────────────

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${passed} claude-config checks passed`);
