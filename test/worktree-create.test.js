'use strict';

// Making a worktree to start a session in (bridge/worktree.js).
//
// Against real git in a throwaway repository, with no bridge: what the route does
// with the answer is a status code, and what matters is the answer. The cases are
// the ones the design turned on — the layout `EnterWorktree` uses, a refusal that
// touches nothing, a name that could be read as a path or an option, and a start
// from inside a worktree, which must land beside it under the main repository
// rather than nested inside it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-wt-create-')));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});

Object.assign(process.env, {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
});

const { createWorktree, planWorktree } = require('../bridge/worktree.js');

const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

async function refused(promise, code) {
    try { await promise; } catch (err) { assert.strictEqual(err.code, code, err.message); return err; }
    throw new Error(`expected a ${code} refusal`);
}

(async () => {
    const repo = path.join(TMP, 'repo');
    fs.mkdirSync(repo);
    gitIn(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-q', '-m', 'first');
    const first = gitIn(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    gitIn(repo, 'commit', '-q', '-am', 'second');
    const second = gitIn(repo, 'rev-parse', 'HEAD');
    gitIn(repo, 'tag', 'v1', first);

    // --- the happy path ---------------------------------------------------
    const made = await createWorktree(repo, 'alpha');
    assert.deepStrictEqual(made, {
        path: path.join(repo, '.claude', 'worktrees', 'alpha'),
        branch: 'worktree-alpha',
    });
    assert.ok(fs.statSync(made.path).isDirectory());
    assert.strictEqual(gitIn(made.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'worktree-alpha');
    assert.strictEqual(gitIn(made.path, 'rev-parse', 'HEAD'), second);
    ok('makes .claude/worktrees/<name> on worktree-<name> from HEAD');

    const fromTag = await createWorktree(repo, 'from-tag', 'v1');
    assert.strictEqual(gitIn(fromTag.path, 'rev-parse', 'HEAD'), first);
    assert.strictEqual(fs.readFileSync(path.join(fromTag.path, 'a.txt'), 'utf8'), 'one\n');
    ok('checks out the base it is given');

    // --- already there ----------------------------------------------------
    const exists = await refused(createWorktree(repo, 'alpha'), 'worktree-exists');
    assert.strictEqual(exists.path, made.path);
    ok('refuses a worktree that exists, naming its path');

    // A branch with no directory: somebody removed the worktree and kept the
    // branch. Re-using it would check out their work under a new session.
    gitIn(repo, 'branch', 'worktree-orphan');
    const orphan = await refused(createWorktree(repo, 'orphan'), 'worktree-exists');
    assert.strictEqual(orphan.branch, 'worktree-orphan');
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'worktrees', 'orphan')));
    ok('refuses a branch that exists without its directory, and creates nothing');

    // --- names and bases that are not ------------------------------------
    for (const bad of ['', 'a/b', '../up', '..', '.hidden', 'x.lock', '-rf', 'sp ace',
        'x'.repeat(61), null, 42]) {
        await refused(createWorktree(repo, bad), 'bad-name');
    }
    ok('refuses names that are paths, options, refs git rejects, or too long');

    await refused(createWorktree(repo, 'opt', '--orphan'), 'bad-base');
    const noRef = await refused(createWorktree(repo, 'noref', 'no-such-ref'), 'git-failed');
    assert.match(noRef.message, /^(fatal|error):/);
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'worktrees', 'noref')));
    assert.throws(() => gitIn(repo, 'rev-parse', '--verify', '-q', 'refs/heads/worktree-noref'));
    ok("a base git cannot resolve is git's first error line, with nothing left behind");

    // --- asked from inside a worktree ---------------------------------------
    const nested = await createWorktree(made.path, 'beta');
    assert.strictEqual(nested.path, path.join(repo, '.claude', 'worktrees', 'beta'));
    assert.ok(!fs.existsSync(path.join(made.path, '.claude')));
    // And from a subdirectory of one, which is the same question once removed.
    fs.mkdirSync(path.join(made.path, 'sub'));
    const plan = await planWorktree(path.join(made.path, 'sub'), 'gamma');
    assert.strictEqual(plan.top, repo);
    ok('from inside a worktree, the new one goes under the main repository');

    // --- the roots and a non-repository ------------------------------------
    await refused(createWorktree(repo, 'fenced', null, { allow: () => false }), 'outside-roots');
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'worktrees', 'fenced')));
    const plain = path.join(TMP, 'plain');
    fs.mkdirSync(plain);
    await refused(createWorktree(plain, 'x'), 'not-a-repo');
    ok('refuses outside the allowed roots, and outside a repository');

    console.log(`\n${pass} passed`);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
