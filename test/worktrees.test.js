'use strict';

// The worktree janitor (bridge/worktrees.js): which worktrees it calls safe, and
// that removal does nothing to the ones it does not.
//
// Against real git in a throwaway repository with a bare "origin", and no bridge
// and no gh. The PR list, the sessions and the pool's runners are handed in, the
// same way the route hands them in. Each unsafe case is one condition failing
// on its own, so a reason that went missing fails by name. Every refused
// removal is then checked on disk, because a refusal that had already deleted
// the directory would still read as a refusal.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-wt-janitor-')));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});

Object.assign(process.env, {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
});

const wt = require('../bridge/worktrees.js');

const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

(async () => {
    // --- pure parts --------------------------------------------------------
    const parsed = wt.parsePorcelain([
        'worktree /r', 'HEAD aaa', 'branch refs/heads/main', '',
        'worktree /r/.claude/worktrees/x', 'HEAD bbb', 'branch refs/heads/worktree-x', 'locked', '',
        'worktree /r/.claude/worktrees/y', 'HEAD ccc', 'detached', 'prunable gitdir file points to non-existent location', '',
    ].join('\n'));
    assert.deepStrictEqual(parsed.map(w => [w.path, w.branch, w.main, w.locked, w.missing]), [
        ['/r', 'main', true, false, false],
        ['/r/.claude/worktrees/x', 'worktree-x', false, true, false],
        ['/r/.claude/worktrees/y', null, false, false, true],
    ]);
    ok('parsePorcelain reads branch, locked, prunable and marks the first as main');

    const safeRow = { main: false, self: false, locked: false, dirty: false, pushed: true, prState: 'merged', sessions: { live: false } };
    assert.deepStrictEqual(wt.classify(safeRow), { safe: true, reasons: [] });
    assert.deepStrictEqual(wt.classify({ ...safeRow, prState: 'closed' }).safe, true);
    for (const [change, reason] of [
        [{ main: true }, 'main'], [{ self: true }, 'self'], [{ locked: true }, 'locked'],
        [{ dirty: true }, 'dirty'], [{ unreadable: true }, 'unreadable'], [{ pushed: false }, 'unpushed'],
        [{ prState: 'open' }, 'pr-open'], [{ prState: 'none' }, 'pr-none'],
        [{ prState: 'unknown' }, 'pr-unknown'], [{ prState: undefined }, 'pr-unknown'],
        [{ sessions: { live: true } }, 'live-session'],
    ]) {
        assert.deepStrictEqual(wt.classify({ ...safeRow, ...change }), { safe: false, reasons: [reason] }, reason);
    }
    ok('classify: each condition alone refuses, with its own reason');

    const now = Date.now();
    const use = wt.sessionUse('/r/w', [
        { sessionId: 'a', cwd: '/r/w', lastTs: '2026-01-01', live: { running: false }, mtimeMs: now - 3600_000 },
        { sessionId: 'b', cwd: '/r/w/sub', lastTs: '2026-02-01', live: { running: true } },
        { sessionId: 'c', cwd: '/r/w2', lastTs: '2026-03-01', live: { running: true } },
        { sessionId: 'd', cwd: '/r', worktree: { path: '/r/w' }, lastTs: '2025-12-01', mtimeMs: now - 1000 },
    ], { e: { state: 'idle', cwd: '/r/w' }, f: { state: 'stopped', cwd: '/r/w' }, g: { state: 'busy', cwd: '/r/w2' } }, now);
    assert.strictEqual(use.live, true);
    assert.strictEqual(use.count, 3, '/r/w2 is a sibling, not inside /r/w');
    assert.deepStrictEqual(use.recent.map(s => [s.id, s.live]), [['b', true], ['a', false], ['d', true]]);
    assert.strictEqual(wt.sessionUse('/r/w', [{ sessionId: 'a', cwd: '/r/w', live: { running: false } }], { f: { state: 'stopped', cwd: '/r/w' } }).live, false);
    ok('sessionUse: registry, recent transcript and live runners count; stopped and siblings do not');

    // --- a real repository -------------------------------------------------
    const origin = path.join(TMP, 'origin.git');
    const repo = path.join(TMP, 'repo');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    fs.mkdirSync(repo);
    gitIn(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-q', '-m', 'first');
    gitIn(repo, 'remote', 'add', 'origin', origin);
    gitIn(repo, 'push', '-q', '-u', 'origin', 'main');

    const W = (name) => path.join(repo, '.claude', 'worktrees', name);
    const pulls = [];
    let number = 0;
    // A worktree with one commit of its own, optionally pushed, optionally with a PR.
    function make(name, { push = true, pr = null } = {}) {
        const dir = W(name);
        gitIn(repo, 'worktree', 'add', '-q', '-b', `worktree-${name}`, dir);
        fs.writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
        gitIn(dir, 'add', '.');
        gitIn(dir, 'commit', '-q', '-m', name);
        if (push) gitIn(dir, 'push', '-q', '-u', 'origin', `worktree-${name}`);
        const head = gitIn(dir, 'rev-parse', 'HEAD');
        if (pr) pulls.unshift({ number: ++number, state: pr, headRefName: `worktree-${name}`, headRefOid: head, url: `https://x/${number}`, title: name });
        return { dir, head };
    }

    make('merged', { pr: 'MERGED' });
    make('closed', { pr: 'CLOSED' });
    const moved = make('moved', { pr: 'MERGED' });
    fs.writeFileSync(path.join(moved.dir, 'later.txt'), 'after the merge\n');
    gitIn(moved.dir, 'add', '.'); gitIn(moved.dir, 'commit', '-q', '-m', 'after');
    gitIn(moved.dir, 'push', '-q');
    const dirty = make('dirty', { pr: 'MERGED' });
    fs.writeFileSync(path.join(dirty.dir, 'dirty.txt'), 'changed\n');
    const untracked = make('untracked', { pr: 'MERGED' });
    fs.writeFileSync(path.join(untracked.dir, 'new.txt'), 'new\n');
    const unpushed = make('unpushed', { pr: 'MERGED' });
    fs.writeFileSync(path.join(unpushed.dir, 'more.txt'), 'more\n');
    gitIn(unpushed.dir, 'add', '.'); gitIn(unpushed.dir, 'commit', '-q', '-m', 'local only');
    make('local', { push: false, pr: null });
    make('open', { pr: 'OPEN' });
    make('nopr');
    make('locked', { pr: 'MERGED' });
    gitIn(repo, 'worktree', 'lock', W('locked'));
    make('live', { pr: 'MERGED' });
    make('runner', { pr: 'MERGED' });
    make('self', { pr: 'MERGED' });
    make('missing', { pr: 'MERGED' });
    fs.rmSync(W('missing'), { recursive: true, force: true });

    const ctx = {
        repo: 'o/r',
        pullsFor: async () => ({ ok: true, pulls }),
        sessions: [{ sessionId: 's1', cwd: W('live'), live: { running: true }, lastTs: '2026-10-01' }],
        runners: { r1: { state: 'idle', cwd: W('runner') } },
        selfRoot: W('self'),
    };

    const got = await wt.survey(W('open'), ctx);
    assert.strictEqual(got.top, repo, 'asked from inside a worktree, the survey is of the main repository');
    const by = Object.fromEntries(got.worktrees.map(r => [r.name, r]));
    const expect = {
        // The fixture leaves `.claude/worktrees` untracked in the main checkout,
        // so it is dirty too; a session in a worktree must not count against it.
        repo: ['main', 'dirty', 'pr-none'],
        merged: [], closed: [], moved: [], missing: [],
        dirty: ['dirty'], untracked: ['dirty'],
        unpushed: ['unpushed'],
        local: ['unpushed', 'pr-none'],
        open: ['pr-open'], nopr: ['pr-none'],
        locked: ['locked'], live: ['live-session'], runner: ['live-session'], self: ['self'],
    };
    for (const [name, reasons] of Object.entries(expect)) {
        assert.ok(by[name], `${name} listed`);
        assert.deepStrictEqual(by[name].reasons, reasons, name);
        assert.strictEqual(by[name].safe, reasons.length === 0, name);
    }
    assert.strictEqual(got.worktrees.length, Object.keys(expect).length);
    assert.strictEqual(by.merged.prState, 'merged');
    assert.strictEqual(by.merged.pr.number, pulls.find(p => p.title === 'merged').number);
    assert.strictEqual(by.missing.missing, true);
    assert.ok(/^\d{4}-\d\d-\d\dT/.test(by.merged.lastCommit), by.merged.lastCommit);
    assert.strictEqual(by.live.sessions.recent[0].id, 's1');
    ok('survey: every worktree classified, each unsafe one for exactly its own reason');

    const failing = await wt.survey(repo, { ...ctx, pullsFor: async () => ({ ok: false, pulls: [], error: 'gh is down' }) });
    assert.strictEqual(failing.prError, 'gh is down');
    assert.ok(failing.worktrees.every(r => !r.safe));
    assert.deepStrictEqual(failing.worktrees.find(r => r.name === 'merged').reasons, ['pr-unknown']);
    ok('a gh that cannot answer makes nothing safe');

    // --- removal -----------------------------------------------------------
    const branchExists = (b) => {
        try { gitIn(repo, 'rev-parse', '--verify', '-q', `refs/heads/${b}`); return true; } catch { return false; }
    };

    for (const name of Object.keys(expect).filter(n => expect[n].length)) {
        const target = name === 'repo' ? repo : W(name);
        const existed = fs.existsSync(target);
        await assert.rejects(wt.removeWorktree(repo, target, ctx), (err) => {
            assert.strictEqual(err.code, 'not-safe', `${name}: ${err.message}`);
            assert.deepStrictEqual(err.reasons, expect[name]);
            return true;
        });
        assert.strictEqual(fs.existsSync(target), existed, `${name} untouched on disk`);
        if (name !== 'repo') assert.ok(branchExists(`worktree-${name}`), `${name} branch kept`);
    }
    assert.ok(fs.existsSync(path.join(W('dirty'), 'dirty.txt')));
    ok('every unsafe worktree is refused by name, and left exactly as it was');

    await assert.rejects(wt.removeWorktree(repo, path.join(TMP, 'elsewhere'), ctx), { code: 'not-a-worktree' });
    await assert.rejects(wt.removeWorktree(repo, W('merged'), { ...ctx, allow: () => false }), { code: 'outside-roots' });
    assert.ok(fs.existsSync(W('merged')));
    ok('a path that is not one of its worktrees, or outside the roots, is refused');

    let r = await wt.removeWorktree(repo, W('merged'), ctx);
    assert.deepStrictEqual(r, { path: W('merged'), branch: 'worktree-merged', removed: true, branchDeleted: true, branchKept: false });
    assert.ok(!fs.existsSync(W('merged')));
    assert.ok(!branchExists('worktree-merged'));
    ok('merged at its tip: worktree removed and branch deleted');

    r = await wt.removeWorktree(repo, W('closed'), ctx);
    assert.strictEqual(r.removed, true);
    assert.strictEqual(r.branchDeleted, false);
    assert.strictEqual(r.branchKept, true);
    assert.ok(branchExists('worktree-closed'));
    ok('closed without merging: worktree removed, branch kept');

    r = await wt.removeWorktree(repo, W('moved'), ctx);
    assert.strictEqual(r.removed, true);
    assert.strictEqual(r.branchDeleted, false, 'commits after the merge keep the branch');
    assert.ok(branchExists('worktree-moved'));
    ok('merged, then moved on: worktree removed, branch kept');

    r = await wt.removeWorktree(repo, W('missing'), ctx);
    assert.strictEqual(r.removed, true);
    assert.ok(!gitIn(repo, 'worktree', 'list', '--porcelain').includes(W('missing')));
    ok('a worktree whose directory is gone is pruned');

    // The decision is taken again at removal: a session that arrives after the
    // survey stops it.
    make('late', { pr: 'MERGED' });
    const later = { ...ctx, sessions: [...ctx.sessions, { sessionId: 's2', cwd: W('late'), live: { running: true } }] };
    await assert.rejects(wt.removeWorktree(repo, W('late'), later), { code: 'not-safe' });
    assert.ok(fs.existsSync(W('late')));
    ok('a session that started after the survey still stops the removal');

    console.log(`\n${pass} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
