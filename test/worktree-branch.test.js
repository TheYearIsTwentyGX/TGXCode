'use strict';

// A worktree on a branch that already exists (bridge/worktree.js
// `worktreeForBranch` / `checkoutWorktree`), for "Fix this" on a review finding.
//
// Against real git: a bare "origin", a clone of it, and a PR branch that exists
// only on origin, only locally, or already checked out in a worktree. What has to
// hold is that the session ends up *on the PR's branch* — never a `worktree-`
// branch of its own, which would push nowhere useful — and that a worktree
// already holding the branch is found rather than duplicated.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-wt-branch-')));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});

Object.assign(process.env, {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
});

const { parseWorktreeList, branchProblem, worktreeForBranch, checkoutWorktree } = require('../bridge/worktree.js');

const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

async function refused(promise, code) {
    try { await promise; } catch (err) { assert.strictEqual(err.code, code, err.message); return err; }
    throw new Error(`expected a ${code} refusal`);
}

// --- parsing, without git ------------------------------------------------------

assert.deepStrictEqual(parseWorktreeList([
    'worktree /r', 'HEAD abc', 'branch refs/heads/main', '',
    'worktree /r/.claude/worktrees/x', 'HEAD def', 'branch refs/heads/feature/x', '',
    'worktree /r/.claude/worktrees/d', 'HEAD 123', 'detached', '',
].join('\n')), [
    { path: '/r', head: 'abc', branch: 'main' },
    { path: '/r/.claude/worktrees/x', head: 'def', branch: 'feature/x' },
    { path: '/r/.claude/worktrees/d', head: '123', branch: null },
]);
assert.deepStrictEqual(parseWorktreeList(''), []);
ok('`worktree list --porcelain` as path, head and short branch; detached is null');

for (const bad of ['', '-x', 'a b', 'a..b', 'a:b', 'a~1', null, 'x'.repeat(201)]) {
    assert.ok(branchProblem(bad), `${JSON.stringify(bad)} should be refused`);
}
for (const good of ['main', 'feature/x', 'worktree-pr-review_1.2']) assert.strictEqual(branchProblem(good), null);
ok('a branch name that git could read as an option or a range is refused');

(async () => {
    const origin = path.join(TMP, 'origin.git');
    gitIn(TMP, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = path.join(TMP, 'seed');
    gitIn(TMP, 'clone', '-q', origin, seed);
    fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
    gitIn(seed, 'add', '.');
    gitIn(seed, 'commit', '-q', '-m', 'first');
    gitIn(seed, 'push', '-q', 'origin', 'main');
    gitIn(seed, 'checkout', '-q', '-b', 'pr-remote-only');
    fs.writeFileSync(path.join(seed, 'a.txt'), 'two\n');
    gitIn(seed, 'commit', '-q', '-am', 'on the pr');
    gitIn(seed, 'push', '-q', 'origin', 'pr-remote-only');
    const prHead = gitIn(seed, 'rev-parse', 'HEAD');

    const repo = path.join(TMP, 'repo');
    gitIn(TMP, 'clone', '-q', origin, repo);

    // --- nothing holds it yet: checked out from origin, tracking it -------------
    assert.strictEqual(await worktreeForBranch(repo, 'pr-remote-only'), null);
    const made = await checkoutWorktree(repo, 'pr-7', 'pr-remote-only');
    assert.deepStrictEqual(made, { path: path.join(repo, '.claude', 'worktrees', 'pr-7'), branch: 'pr-remote-only' });
    assert.strictEqual(gitIn(made.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pr-remote-only');
    assert.strictEqual(gitIn(made.path, 'rev-parse', 'HEAD'), prHead);
    assert.strictEqual(gitIn(made.path, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/pr-remote-only');
    assert.throws(() => gitIn(repo, 'rev-parse', '--verify', '-q', 'refs/heads/worktree-pr-7'));
    ok('a branch only origin has is checked out on its own name, tracking origin');

    // --- and is then found, from the main checkout or from inside a worktree ---
    const found = await worktreeForBranch(repo, 'pr-remote-only');
    assert.deepStrictEqual(found, { path: made.path, main: false });
    assert.deepStrictEqual(await worktreeForBranch(made.path, 'pr-remote-only'), found);
    assert.deepStrictEqual(await worktreeForBranch(repo, 'main'), { path: repo, main: true });
    ok('a worktree holding the branch is found, and the main checkout is told apart');

    // --- a local branch nobody has checked out --------------------------------
    gitIn(repo, 'branch', 'local-only', 'main');
    gitIn(repo, 'push', '-q', 'origin', 'local-only');
    const second = await checkoutWorktree(repo, 'pr-7', 'local-only');
    assert.strictEqual(second.path, path.join(repo, '.claude', 'worktrees', 'pr-7-2'));
    assert.strictEqual(gitIn(second.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'local-only');
    ok('an existing local branch is used as it is, and a taken name becomes name-2');

    // --- refusals ------------------------------------------------------------------
    const before = fs.readdirSync(path.join(repo, '.claude', 'worktrees')).sort();
    const err = await refused(checkoutWorktree(repo, 'pr-9', 'not-on-origin'), 'fetch-failed');
    assert.ok(/not-on-origin/.test(err.message));
    await refused(checkoutWorktree(repo, 'pr-9', '-rf'), 'bad-branch');
    await refused(checkoutWorktree(repo, '../out', 'local-only'), 'bad-name');
    await refused(checkoutWorktree(repo, 'pr-9', 'local-only', { allow: () => false }), 'outside-roots');
    assert.deepStrictEqual(fs.readdirSync(path.join(repo, '.claude', 'worktrees')).sort(), before);
    ok('a branch origin lacks, a bad name or branch, and outside the roots: nothing made');

    console.log(`\n${pass} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
