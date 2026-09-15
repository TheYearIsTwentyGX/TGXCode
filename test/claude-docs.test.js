'use strict';

// Claude Code's memory files — bridge/claude-docs.js.
//
// **HOME is redirected before anything is required, and here that is not a
// tidiness measure.** bridge/config.js resolves `~/.claude/CLAUDE.md` at load,
// and this module writes it. Requiring the module with the real home in place
// would leave the suite one bug away from rewriting the user's own instructions
// to Claude — the file every session on this machine reads before its first
// message, and the one thing here that is somebody's writing rather than a
// setting they can set again. So the redirect comes first, and the assertion
// below re-checks that the path under test really is inside the temporary
// directory before a single write happens.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-docs-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_SESSIONS_ROOTS = home;

const cfg = require('../bridge/config.js');
const { ClaudeDocs, MAX_DOC_BYTES, specFor, readText } = require('../bridge/claude-docs.js');

// The guard the header promises. If HOME did not take, stop before writing.
assert.ok(cfg.USER_CLAUDE_MEMORY.startsWith(home),
    `refusing to run: ${cfg.USER_CLAUDE_MEMORY} is not inside ${home}`);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };

const project = path.join(home, 'proj');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(cfg.USER_CLAUDE_DIR, { recursive: true });

const userFile = cfg.USER_CLAUDE_MEMORY;
const projFile = path.join(project, 'CLAUDE.md');

const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
};
const read = (file) => fs.readFileSync(file, 'utf8');
const gone = (file) => { try { fs.unlinkSync(file); } catch { /* not there */ } };
const reset = () => { for (const f of [userFile, projFile]) gone(f); };

/** The refusal code a call throws, or null when it did not throw. */
function codeOf(fn) {
    try { fn(); return null; }
    catch (err) { return err.code || 'no-code'; }
}

const docs = new ClaudeDocs();
const rowFor = (scope, dir) => docs.read(dir).docs.find(d => d.scope === scope) || null;
const stampFor = (scope, dir) => {
    const row = rowFor(scope, dir);
    return row ? row.stamp : null;
};

// ── which file a scope means ───────────────────────────────────────────────

reset();

{
    write(userFile, '# mine\n');
    write(projFile, '# theirs\n');
    const rows = docs.read(project).docs;
    assert.deepStrictEqual(rows.map(r => r.scope), ['user', 'project'],
        'user first, the order Claude Code reads them in');
    assert.deepStrictEqual(rows.map(r => r.kind), ['claude-md', 'claude-md']);
    assert.strictEqual(rows[0].file, path.join(home, '.claude', 'CLAUDE.md'));
    // The one place this family does not mirror the settings files: the project
    // file is at the root of the workspace, not inside `.claude`.
    assert.strictEqual(rows[1].file, path.join(project, 'CLAUDE.md'));
    assert.strictEqual(rows[0].text, '# mine\n');
    assert.strictEqual(rows[1].text, '# theirs\n');
    ok('both scopes are reported, user first, and the project file is not under .claude');
}

{
    // The case the plan calls out by name: a scope with no project must resolve
    // to no file rather than to something surprising. A row naming
    // `undefined/CLAUDE.md` would be a lie, and one naming a path outside the
    // roots would be a control every write then refuses.
    assert.deepStrictEqual(docs.read('').docs.map(r => r.scope), ['user'],
        'no directory means no project row');
    assert.deepStrictEqual(docs.read('/etc').docs.map(r => r.scope), ['user'],
        'a directory outside the roots means no project row either');
    assert.strictEqual(specFor('project', ''), null);
    assert.strictEqual(specFor('project', '/etc'), null);
    assert.strictEqual(specFor('nonsense', project), null);
    ok('a scope with no project resolves to no file at all');
}

{
    // A worktree is a project directory of its own, and Claude Code reads the
    // CLAUDE.md of the directory it runs in — so this must not resolve to the
    // parent checkout the way Prefs.files() would.
    const worktree = path.join(project, '.claude', 'worktrees', 'thing');
    fs.mkdirSync(worktree, { recursive: true });
    write(path.join(worktree, 'CLAUDE.md'), '# the worktree own\n');
    assert.strictEqual(rowFor('project', worktree).text, '# the worktree own\n');
    ok('a worktree gets its own file rather than its main checkout’s');
}

// ── the stamp precondition ─────────────────────────────────────────────────

reset();
write(userFile, '# one rule\n');

{
    const stale = stampFor('user', '');
    // Something else writes while the page holds the old answer. `claude` does
    // this itself through a memory edit, and so does a second window.
    write(userFile, '# one rule\n# a rule added since\n');

    let thrown;
    try { docs.save({ scope: 'user', dir: '', stamp: stale, text: '# one rule\n' }); }
    catch (err) { thrown = err; }
    assert.ok(thrown, 'a write against a moved file must be refused');
    assert.strictEqual(thrown.code, 'stale');
    assert.ok(thrown.detail && thrown.detail.text.includes('added since'),
        'the refusal carries the file as it is now, so the page can show it');
    assert.strictEqual(thrown.detail.stamp, stampFor('user', ''),
        'and the stamp to save with next');
    assert.strictEqual(read(userFile), '# one rule\n# a rule added since\n',
        'the paragraph written since is still there');
    ok('a stale write is refused and drops nothing');
}

{
    const now = stampFor('user', '');
    docs.save({ scope: 'user', dir: '', stamp: now, text: '# kept\n' });
    assert.strictEqual(read(userFile), '# kept\n');
    ok('the same write with the current stamp goes through');
}

{
    // The difference from claude-config.js, which lets a single scalar patch do
    // without one. Every write here replaces the whole document, so there is no
    // write that can.
    assert.strictEqual(
        codeOf(() => docs.save({ scope: 'user', dir: '', text: '# no stamp\n' })),
        'stamp', 'an absent stamp is a refusal, not a permitted shortcut');
    assert.strictEqual(read(userFile), '# kept\n', 'and it wrote nothing');
    ok('a write with no stamp at all is refused');
}

{
    gone(userFile);
    assert.strictEqual(
        codeOf(() => docs.save({ scope: 'user', dir: '', stamp: 'nope', text: '' })),
        'stale', 'a stamp for a file that is gone is stale');
    docs.save({ scope: 'user', dir: '', stamp: null, text: '# created\n' });
    assert.strictEqual(read(userFile), '# created\n');
    let thrown;
    try { docs.save({ scope: 'user', dir: '', stamp: null, text: '# again\n' }); }
    catch (err) { thrown = err; }
    assert.strictEqual(thrown.code, 'exists', 'stamp null means the file should not be there');
    assert.ok(thrown.detail && thrown.detail.stamp, 'and it carries the stamp to retry with');
    assert.strictEqual(read(userFile), '# created\n', 'the create that lost changed nothing');
    ok('stamp null creates the file, and refuses once something else has');
}

// ── refusing to write through a symlink ────────────────────────────────────

{
    reset();
    const elsewhere = path.join(home, 'elsewhere.md');
    write(elsewhere, '# not mine\n');
    const linked = path.join(home, 'linked');
    fs.mkdirSync(linked, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(linked, 'CLAUDE.md'));

    assert.strictEqual(
        codeOf(() => docs.save({
            scope: 'project', dir: linked, stamp: null, text: '# through the link\n',
        })),
        'readonly');
    assert.strictEqual(read(elsewhere), '# not mine\n', 'the link target is untouched');
    const row = rowFor('project', linked);
    assert.strictEqual(row.symlink, true);
    assert.strictEqual(row.writable, false);
    // It still reads, so the page can say what is there and why it will not
    // write it, rather than showing an empty box with no explanation.
    assert.strictEqual(row.text, '# not mine\n');
    ok('a symlinked memory file is reported and never written through');
}

// ── the size cap, in both directions ───────────────────────────────────────

{
    reset();
    assert.strictEqual(
        codeOf(() => docs.save({
            scope: 'project', dir: project, stamp: null, text: 'x'.repeat(MAX_DOC_BYTES + 1),
        })),
        'size');
    assert.ok(!fs.existsSync(projFile), 'and it created nothing');

    // The boundary is inclusive: exactly the cap is allowed, so the number in
    // the message is the largest file that works rather than the smallest that
    // does not.
    docs.save({
        scope: 'project', dir: project, stamp: null, text: 'x'.repeat(MAX_DOC_BYTES),
    });
    assert.strictEqual(fs.statSync(projFile).size, MAX_DOC_BYTES);
    ok('a write past the cap is refused, and one exactly at it is allowed');
}

{
    // A read past the cap reports the size and **no text**, rather than the
    // first 256KB. Index#persistedOutput in bridge/sessions.js does clip,
    // because it feeds a viewer; a half file behind a Save button would delete
    // the rest of it on the first save.
    write(projFile, 'y'.repeat(MAX_DOC_BYTES + 10));
    const row = rowFor('project', project);
    assert.strictEqual(row.truncated, true);
    assert.strictEqual(row.text, null, 'never half a file');
    assert.strictEqual(row.size, MAX_DOC_BYTES + 10);
    assert.ok(row.stamp, 'the stamp is still reported, so the row is not simply absent');
    assert.strictEqual(row.exists, true);
    ok('a file past the cap is exists-but-not-loaded, with its real size');
}

{
    // The cap is bytes, not characters — every heading in this repo's own
    // CLAUDE.md contains an em-dash, and it is a hundred bytes longer than it
    // is characters.
    const em = '—'.repeat(1000);
    assert.strictEqual(Buffer.byteLength(em, 'utf8'), 3000);
    assert.strictEqual(em.length, 1000);
    docs.save({ scope: 'project', dir: project, stamp: stampFor('project', project), text: em });
    assert.strictEqual(rowFor('project', project).size, 3000,
        'the size reported is bytes, which is what the cap is measured in');
    ok('the cap and the reported size are bytes rather than characters');
}

// ── a body that is not text ────────────────────────────────────────────────

{
    reset();
    write(projFile, '# before\n');
    const stamp = stampFor('project', project);
    // Built from its code point so this file cannot itself contain the byte.
    const nul = String.fromCharCode(0);
    assert.strictEqual(
        codeOf(() => docs.save({
            scope: 'project', dir: project, stamp, text: `before${nul}after`,
        })),
        'body');
    assert.strictEqual(read(projFile), '# before\n', 'and it wrote nothing');
    assert.strictEqual(
        codeOf(() => docs.save({ scope: 'project', dir: project, stamp, text: 42 })),
        'body', 'nor is a number a document');
    assert.strictEqual(
        codeOf(() => docs.save({ scope: 'project', dir: project, stamp })),
        'body', 'nor is nothing at all');
    ok('a NUL byte, and anything that is not a string, is refused');
}

// ── the bytes on disk ──────────────────────────────────────────────────────

{
    reset();
    // Written through verbatim: no re-indenting, no trailing newline added, no
    // BOM stripped. The JSON tab next door re-serialises because it owns a
    // format with a house style; this is somebody's prose, and reformatting it
    // would corrupt a diff nobody asked for.
    const odd = '﻿#  Two  spaces\r\n\tand a tab, and no final newline';
    docs.save({ scope: 'project', dir: project, stamp: null, text: odd });
    assert.strictEqual(read(projFile), odd, 'byte for byte, BOM and CRLF and all');
    assert.deepStrictEqual(
        fs.readdirSync(project).filter(f => f.includes('.tmp')), [],
        'and the atomic write left no temporary file behind');
    ok('a save is the bytes it was given, and nothing else');
}

{
    // Empty is a legitimate document — "I want this file to say nothing" is a
    // thing somebody can mean, and it is not the same as deleting the file.
    docs.save({
        scope: 'project', dir: project, stamp: stampFor('project', project), text: '',
    });
    const row = rowFor('project', project);
    assert.strictEqual(row.exists, true);
    assert.strictEqual(row.size, 0);
    assert.strictEqual(row.text, '');
    ok('an empty document is written rather than treated as a deletion');
}

// ── the scope and directory refusals ───────────────────────────────────────

{
    reset();
    assert.strictEqual(
        codeOf(() => docs.save({ scope: 'nonsense', dir: project, stamp: null, text: 'x' })),
        'scope');
    // The four scopes the settings group next door has, three of which mean
    // nothing here. Named rather than assumed, because "project-local" is a
    // plausible thing for a client to send after reading /api/claude-config.
    for (const scope of ['project-local', 'managed', '']) {
        assert.strictEqual(
            codeOf(() => docs.save({ scope, dir: project, stamp: null, text: 'x' })),
            'scope', `${JSON.stringify(scope)} is not a memory scope`);
    }
    assert.strictEqual(
        codeOf(() => docs.save({ scope: 'project', dir: '', stamp: null, text: 'x' })),
        'dir');
    assert.strictEqual(
        codeOf(() => docs.save({ scope: 'project', dir: '/etc', stamp: null, text: 'x' })),
        'dir');
    assert.ok(!fs.existsSync('/etc/CLAUDE.md'), 'and nothing was written outside the roots');
    ok('every scope and directory refusal carries the code a route classifies on');
}

// ── readText on its own ────────────────────────────────────────────────────

{
    reset();
    const missing = readText(path.join(home, 'no-such-file.md'));
    assert.deepStrictEqual(missing,
        { text: null, stamp: null, size: 0, exists: false, truncated: false },
        'a missing file is all-nulls rather than an error');
    // A directory passes existsSync perfectly happily, and reading one throws
    // EISDIR — so it is asked about properly rather than found out about later.
    assert.strictEqual(readText(project).exists, false,
        'a directory where a file should be is not a file we have');
    ok('readText answers for a missing file and a directory without throwing');
}

// ── clean up ───────────────────────────────────────────────────────────────

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${passed} claude-docs checks passed`);
