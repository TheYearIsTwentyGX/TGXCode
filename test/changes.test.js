'use strict';

// What "this session changed these files" is derived from — bridge/changes.js
// over transcript events, and bridge/git.js over git's own output.
//
// Both are worth a test for the same reason: the inputs are shapes Claude Code
// and git decide, the failures are quiet, and a wrong number here looks exactly
// like a right one. The cases that earn their place are the ones that were wrong
// or nearly wrong while this was being written:
//
//   * `ExitPlanMode` results carry a `filePath` — the plan file — so keying on
//     that field instead of on the tool's name lists plans as edited code.
//   * a call and its result land in the same read or in different ones, and only
//     the second shape emits the `tool-result` patch event.
//   * a transcript's last line has no newline yet, so the next read offers the
//     same call again. Counting it twice doubles a file's line counts.
//   * `git status --porcelain=v2` fields are positional, and a rename line has
//     one more of them than a modify line.
//   * `git diff --no-index` exits 1 on success, and a user's own git config can
//     change the shape of a diff out from under a parser.
//
// The git half runs against a throwaway repository with none of this machine's
// config, in a temp directory that is removed at the end.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const changes = require('../bridge/changes.js');
const git = require('../bridge/git.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// ---------------------------------------------------------------------------
// Event fixtures
// ---------------------------------------------------------------------------

let nextId = 0;
const id = () => `toolu_${++nextId}`;

/** A finished tool call, the shape buildEvents emits when the result was in the same read. */
function call(name, input, result, { status = 'ok', ts = '2026-08-21T10:00:00.000Z' } = {}) {
    return {
        id: id(), kind: 'tool', name, ts, resultTs: ts, status,
        input, result: result || null,
    };
}

/** `+n/-m` as a structured patch, the way Claude Code writes one. */
const patch = (added, deleted) => [{
    oldStart: 1, oldLines: deleted, newStart: 1, newLines: added,
    lines: [
        ...Array.from({ length: deleted }, (_, i) => `-old ${i}`),
        ...Array.from({ length: added }, (_, i) => `+new ${i}`),
    ],
}];

const files = (events) => changes.summarize(changes.fromEvents(events), { root: '/repo' });
const only = (events) => {
    const out = files(events);
    assert.strictEqual(out.length, 1, `expected one file, got ${out.length}`);
    return out[0];
};

// --- which calls count ------------------------------------------------------

{
    // The bug this whole predicate exists for. An approved plan's result names
    // the plan file, and nothing about it is a code change.
    const out = files([
        call('ExitPlanMode', { plan: 'do the thing' },
            { filePath: '/home/someone/.claude/plans/a-plan.md' }),
    ]);
    assert.deepStrictEqual(out, [], 'a plan is not an edited file');
    ok('ExitPlanMode contributes no file, though its result has a filePath');
}

{
    const out = files([
        call('Read', { file_path: '/repo/src/a.ts' }, { filePath: '/repo/src/a.ts' }),
        call('Bash', { command: "sed -i s/a/b/ /repo/src/a.ts" }, { stdout: '' }),
        call('Grep', { pattern: 'x' }, { text: 'x' }),
    ]);
    assert.deepStrictEqual(out, [], 'reading and grepping change nothing');
    ok('only the file-changing tools count');
}

{
    const failed = call('Edit', { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' },
        { text: 'String to replace not found' }, { status: 'error' });
    assert.deepStrictEqual(files([failed]), [], 'a failed edit changed nothing');
    ok('an edit that errored is not a changed file');
}

{
    const running = call('Edit', { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' },
        null, { status: 'pending' });
    assert.deepStrictEqual(files([running]), [], 'a call still running has changed nothing yet');
    ok('an edit still in flight is not a changed file');
}

// --- counting ---------------------------------------------------------------

{
    const f = only([call('Edit', { file_path: '/repo/src/a.ts' },
        { filePath: '/repo/src/a.ts', patch: patch(84, 12) })]);
    assert.strictEqual(f.added, 84);
    assert.strictEqual(f.deleted, 12);
    assert.strictEqual(f.relPath, 'src/a.ts', 'the row reads as a repo-relative path');
    assert.strictEqual(f.path, '/repo/src/a.ts', 'and keeps the absolute one to be identified by');
    ok('an edit is counted from its structured patch');
}

{
    // No patch: interrupted before the result, or an older transcript. The call's
    // own strings are the fallback, as they are in the UI.
    const f = only([call('Edit',
        { file_path: '/repo/src/a.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree' },
        { filePath: '/repo/src/a.ts' })]);
    assert.strictEqual(f.added, 3);
    assert.strictEqual(f.deleted, 2);
    ok('an edit with no patch falls back to the strings it was called with');
}

{
    const f = only([call('Write', { file_path: '/repo/new.md', content: 'a\nb\nc' },
        { filePath: '/repo/new.md', type: 'create' })]);
    assert.strictEqual(f.added, 3);
    assert.strictEqual(f.deleted, 0);
    ok('a Write with no patch counts every line as added');
}

{
    const f = only([call('MultiEdit', {
        file_path: '/repo/src/a.ts',
        edits: [{ old_string: 'a', new_string: 'b\nc' }, { old_string: 'd', new_string: 'e' }],
    }, { filePath: '/repo/src/a.ts' })]);
    assert.strictEqual(f.added, 3);
    assert.strictEqual(f.deleted, 2);
    ok('a MultiEdit with no patch sums its edits');
}

{
    // A path outside the repository — a plan, a scratch file, a memory note —
    // has no relative form, and inventing one with `../..` in it would be worse
    // than the absolute path it already is.
    const f = only([call('Write', { file_path: '/tmp/scratch.md' },
        { filePath: '/tmp/scratch.md', patch: patch(2, 0) })]);
    assert.strictEqual(f.relPath, '/tmp/scratch.md');
    ok('a file outside the checkout keeps its absolute path');
}

{
    const a = call('Edit', { file_path: '/repo/src/a.ts' },
        { filePath: '/repo/src/a.ts', patch: patch(10, 1) }, { ts: '2026-08-21T10:00:00.000Z' });
    const b = call('Edit', { file_path: '/repo/src/a.ts' },
        { filePath: '/repo/src/a.ts', patch: patch(5, 2) }, { ts: '2026-08-21T10:05:00.000Z' });
    const f = only([a, b]);
    assert.strictEqual(f.edits, 2);
    assert.strictEqual(f.added, 15);
    assert.strictEqual(f.deleted, 3);
    assert.strictEqual(f.toolId, a.id, 'clicking the row goes to the first edit, not the last');
    assert.strictEqual(f.lastTs, b.ts);
    ok('two edits to one file are one row, summed, anchored at the first');
}

// --- results that arrive in a later read ------------------------------------

{
    // The shape every incremental read produces: the call was before the offset,
    // so its result comes as a patch aimed at it rather than merged into it.
    const pending = new Map();
    const into = new Map();
    const c = call('Edit', { file_path: '/repo/src/a.ts' }, null, { status: 'pending' });

    changes.fromEvents([c], { into, pending });
    assert.strictEqual(into.size, 0, 'nothing to count until the result lands');

    changes.fromEvents([{
        id: `${c.id}:result`, kind: 'tool-result', toolId: c.id, status: 'ok',
        resultTs: '2026-08-21T10:00:01.000Z',
        result: { filePath: '/repo/src/a.ts', patch: patch(7, 3) },
    }], { into, pending });

    const [f] = changes.summarize(into, { root: '/repo' });
    assert.strictEqual(f.added, 7);
    assert.strictEqual(f.deleted, 3);
    assert.strictEqual(f.toolId, c.id, 'the row still anchors on the call, not on the patch');
    ok('a result arriving in a later read is counted against its call');
}

{
    // The trailing line with no newline yet: the same call is offered again on
    // the next read, and must not be counted a second time.
    const into = new Map();
    const done = new Set();
    const c = call('Write', { file_path: '/repo/src/a.ts' },
        { filePath: '/repo/src/a.ts', patch: patch(9, 0) });

    changes.fromEvents([c], { into, done });
    changes.fromEvents([c], { into, done });

    const [f] = changes.summarize(into, { root: '/repo' });
    assert.strictEqual(f.added, 9, 'the second sighting of one call is not a second edit');
    assert.strictEqual(f.edits, 1);
    ok('a call re-read from a partial line is counted once');
}

// --- whose edit it was ------------------------------------------------------

{
    const agent = { toolUseId: 'toolu_task_1', agentType: 'general-purpose', description: 'do it' };
    const into = changes.fromEvents([call('Edit', { file_path: '/repo/src/a.ts' },
        { filePath: '/repo/src/a.ts', patch: patch(4, 0) })], { agent });
    const [f] = changes.summarize(into, { root: '/repo' });
    assert.strictEqual(f.toolId, null, 'there is no call in this transcript to jump to');
    assert.deepStrictEqual(f.agent, agent, 'so the row carries the agent whose pane has it');
    ok('a file only a subagent touched points at that subagent');
}

{
    // Both: the conversation's own call wins the anchor, because jumping into the
    // transcript beats opening a pane when the transcript has it.
    const mine = call('Edit', { file_path: '/repo/src/a.ts' },
        { filePath: '/repo/src/a.ts', patch: patch(1, 0) }, { ts: '2026-08-21T11:00:00.000Z' });
    const into = new Map();
    changes.fromEvents([call('Edit', { file_path: '/repo/src/a.ts' },
        { filePath: '/repo/src/a.ts', patch: patch(2, 0) }, { ts: '2026-08-21T10:00:00.000Z' })],
        { into, agent: { toolUseId: 'toolu_task_1', agentType: 'Explore' } });
    changes.fromEvents([mine], { into });

    const [f] = changes.summarize(into, { root: '/repo' });
    assert.strictEqual(f.toolId, mine.id);
    assert.strictEqual(f.agent, null);
    assert.strictEqual(f.edits, 2);
    ok('a file both touched anchors in the transcript rather than in the agent');
}

// --- ordering ---------------------------------------------------------------

{
    const old = call('Edit', { file_path: '/repo/old.ts' },
        { filePath: '/repo/old.ts', patch: patch(1, 0) }, { ts: '2026-08-21T09:00:00.000Z' });
    const recent = call('Edit', { file_path: '/repo/recent.ts' },
        { filePath: '/repo/recent.ts', patch: patch(1, 0) }, { ts: '2026-08-21T12:00:00.000Z' });
    const out = files([old, recent]);
    assert.deepStrictEqual(out.map(f => f.relPath), ['recent.ts', 'old.ts']);
    ok('the file touched most recently is at the top');
}

// ---------------------------------------------------------------------------
// git status
// ---------------------------------------------------------------------------

{
    const st = git.parseStatus([
        '# branch.oid abc123',
        '# branch.head worktree-changes-panel',
        '# branch.upstream origin/worktree-changes-panel',
        '# branch.ab +3 -1',
        '1 .M N... 100644 100644 100644 aaa bbb bridge/git.js',
        '1 M. N... 100644 100644 100644 aaa bbb web/app.js',
        '2 R. N... 100644 100644 100644 aaa bbb R100 docs/new.md\tdocs/old.md',
        'u UU N... 100644 100644 100644 100644 aaa bbb ccc web/styles.css',
        '? .playwright-mcp/',
        '? a file with spaces.md',
    ].join('\n'));

    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.branch, 'worktree-changes-panel');
    assert.strictEqual(st.upstream, 'origin/worktree-changes-panel');
    assert.strictEqual(st.ahead, 3);
    assert.strictEqual(st.behind, 1);
    assert.strictEqual(st.staged, 2, 'the staged modify and the rename');
    assert.strictEqual(st.unstaged, 1);
    assert.strictEqual(st.untracked, 2);
    assert.strictEqual(st.conflicts, 1);
    assert.strictEqual(st.files, 6);
    assert.strictEqual(st.dirty, true);
    assert.deepStrictEqual(st.entries.map(e => e.path), [
        'bridge/git.js', 'web/app.js', 'docs/new.md', 'web/styles.css',
        '.playwright-mcp/', 'a file with spaces.md',
    ], 'a rename reports its new path, and a space in a name is part of it');
    ok('git status --porcelain=v2 parses to counts and a file list');
}

{
    const clean = git.parseStatus('# branch.head main\n');
    assert.strictEqual(clean.dirty, false);
    assert.strictEqual(clean.files, 0);
    assert.deepStrictEqual(clean.entries, []);
    ok('a clean checkout is not dirty and lists nothing');
}

{
    const detached = git.parseStatus('# branch.head (detached)\n');
    assert.strictEqual(detached.detached, true);
    assert.strictEqual(detached.branch, null);
    ok('a detached HEAD is reported as detached rather than as a branch');
}

// ---------------------------------------------------------------------------
// git, for real
// ---------------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-changes-'));
const REPO = path.join(TMP, 'repo');

/** git with none of this machine's config, signing, hooks or identity. */
function run(...args) {
    const out = spawnSync('git', ['-C', REPO, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
            GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
        },
    });
    assert.strictEqual(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
    return out.stdout;
}

const write = (rel, text) => fs.writeFileSync(path.join(REPO, rel), text);

(async () => {
    fs.mkdirSync(REPO, { recursive: true });
    run('init', '-q', '-b', 'main');

    // A repository with no commit at all: the panel is opened on brand-new
    // checkouts, and `git diff HEAD` in one is an error rather than an answer.
    write('first.txt', 'a\nb\n');
    run('add', 'first.txt');
    const before = await git.numstat(REPO);
    assert.deepStrictEqual(before.get('first.txt'), { added: 2, deleted: 0, binary: false });
    ok('a repository with no commit yet is counted against the index');

    run('commit', '-qm', 'first');

    write('first.txt', 'a\nb\nc\nd\n');
    write('untracked.txt', 'nobody has staged this\n');
    // A NUL byte is how git decides something is binary, whatever it is called.
    fs.writeFileSync(path.join(REPO, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
    run('add', 'blob.bin');

    const counts = await git.numstat(REPO);
    assert.deepStrictEqual(counts.get('first.txt'), { added: 2, deleted: 0, binary: false });
    assert.deepStrictEqual(counts.get('blob.bin'), { added: 0, deleted: 0, binary: true },
        'git prints - for both columns of a binary file');
    assert.strictEqual(counts.has('untracked.txt'), false,
        'an untracked file is not in git diff and so has no counts');
    ok('numstat reads line counts, binaries and the gap where untracked files are');

    const state = await git.statusOf(REPO, { limit: 2 });
    assert.strictEqual(state.ok, true);
    assert.strictEqual(state.root, fs.realpathSync(REPO));
    assert.strictEqual(state.files, 3, 'the modify, the staged binary and the untracked file');
    assert.strictEqual(state.sample.length, 2, 'capped where the caller asked');
    assert.strictEqual(state.truncated, 1, 'and says how much it left out');

    // The same directory, uncapped, out of the same cached `git status` — this is
    // the whole reason the cap is per call rather than per cache entry.
    const full = await git.statusOf(REPO);
    assert.strictEqual(full.sample.length, 3);
    assert.strictEqual(full.truncated, 0);
    ok('one cached status serves both a capped and an uncapped caller');

    // Not a repository, and a directory that is not its own checkout: both are
    // answers the panel draws, not errors.
    const outside = await git.statusOf(TMP);
    assert.strictEqual(outside.ok, false);
    assert.strictEqual(outside.reason, 'not-a-repo');

    const inner = path.join(REPO, 'sub');
    fs.mkdirSync(inner);
    const left = await git.statusOf(inner);
    assert.strictEqual(left.ok, false);
    assert.strictEqual(left.reason, 'left-behind',
        'a directory inside a repo is not a checkout of its own');
    ok('a missing repository and a left-behind directory are answers, not failures');

    // ── diffText ───────────────────────────────────────────────────────────
    //
    // Three of these are here because they were wrong, or would have been:
    //
    //   * `git diff --no-index` exits **1** whenever the files differ, which for
    //     an untracked file is every successful run. Reading `run`'s `ok` flag
    //     instead of the exit code makes every new file look like it has no
    //     diff — a failure with no error anywhere.
    //   * a user's own git config can change the *shape* of the output.
    //     `diff.noprefix` is the dangerous one: it drops the `a/`…`b/` prefixes,
    //     and a unified-diff parser then keeps the first path segment as part of
    //     the filename. The fixture sets it locally so the override is pinned.
    //   * an absent `context` must not become zero. `Number(null)` is 0 and 0 is
    //     a legitimate request, so the fallback cannot be `context || 3`.

    // Set in the repository's own config, which `-c` on the command line beats.
    run('config', 'diff.noprefix', 'true');

    write('first.txt', 'a\nB\n');
    const modified = await git.diffText(REPO, 'first.txt');
    assert.strictEqual(modified.ok, true);
    assert.match(modified.diff, /^diff --git a\/first\.txt b\/first\.txt$/m,
        'the a/ and b/ prefixes survive diff.noprefix=true in the repo config');
    assert.match(modified.diff, /^\+B$/m);
    assert.match(modified.diff, /^-b$/m);
    assert.strictEqual(modified.truncated, 0);
    ok('diffText diffs a modified file, and forces the config that would break the parse');

    write('fresh.txt', 'one\ntwo\n');
    const untracked = await git.diffText(REPO, 'fresh.txt', { untracked: true });
    assert.strictEqual(untracked.ok, true,
        'git diff --no-index exits 1 on every file that differs, which is success here');
    assert.match(untracked.diff, /^\+one$/m);
    assert.match(untracked.diff, /^\+two$/m);
    ok('an untracked file is a whole-file addition, and its exit code 1 is not a failure');

    // Context: absent means git's own 3, an explicit 0 means none, and both are
    // distinguishable from each other.
    write('wide.txt', `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}\n`);
    run('add', 'wide.txt');
    run('commit', '-qm', 'wide');
    write('wide.txt', `${Array.from({ length: 30 },
        (_, i) => (i === 15 ? 'CHANGED' : `line ${i}`)).join('\n')}\n`);

    const ctxDefault = await git.diffText(REPO, 'wide.txt');
    const ctxNone = await git.diffText(REPO, 'wide.txt', { context: 0 });
    const ctxWide = await git.diffText(REPO, 'wide.txt', { context: 10 });
    const ctxLines = (d) => d.diff.split('\n').filter(l => /^ /.test(l)).length;
    assert.strictEqual(ctxLines(ctxDefault), 6, 'three either side, git\'s default');
    assert.strictEqual(ctxLines(ctxNone), 0, 'zero is a request, not a missing value');
    assert.strictEqual(ctxLines(ctxWide), 20);
    // Out of range is clamped rather than refused — the caller is a query string.
    const ctxSilly = await git.diffText(REPO, 'wide.txt', { context: 9999 });
    assert.strictEqual(ctxLines(ctxSilly), ctxLines(await git.diffText(REPO, 'wide.txt', { context: 25 })));
    ok('context defaults to 3, honours 0, and clamps');

    // Staged and unstaged are different questions about the same file, which is
    // the whole reason `mode` exists.
    write('split.txt', 'base\n');
    run('add', 'split.txt');
    run('commit', '-qm', 'split');
    write('split.txt', 'staged\n');
    run('add', 'split.txt');
    write('split.txt', 'working\n');
    const staged = await git.diffText(REPO, 'split.txt', { mode: 'staged' });
    const unstaged = await git.diffText(REPO, 'split.txt', { mode: 'unstaged' });
    const worktree = await git.diffText(REPO, 'split.txt', { mode: 'worktree' });
    assert.match(staged.diff, /^\+staged$/m);
    assert.doesNotMatch(staged.diff, /^\+working$/m);
    assert.match(unstaged.diff, /^\+working$/m);
    assert.match(unstaged.diff, /^-staged$/m);
    assert.match(worktree.diff, /^\+working$/m, 'worktree is against HEAD, so it is the whole change');
    assert.doesNotMatch(worktree.diff, /^\+staged$/m);
    ok('staged, unstaged and worktree are three different answers');

    // A filename beginning with a dash. `--` is what stops git reading it as an
    // option, and `execFile` is what stops a shell reading it at all.
    write('-weird.txt', 'x\n');
    run('add', '--', '-weird.txt');
    run('commit', '-qm', 'weird');
    write('-weird.txt', 'y\n');
    const weird = await git.diffText(REPO, '-weird.txt');
    assert.strictEqual(weird.ok, true);
    assert.match(weird.diff, /^\+y$/m);
    ok('a filename beginning with a dash is a path, not an option');

    // Truncation: cut on a line boundary, and `truncated` counts the bytes left
    // out rather than being a flag.
    const big = `${Array.from({ length: 90_000 }, (_, i) => `row ${i} ${'x'.repeat(20)}`).join('\n')}\n`;
    write('big.txt', big);
    const huge = await git.diffText(REPO, 'big.txt', { untracked: true });
    assert.strictEqual(huge.ok, true);
    assert.ok(huge.bytes <= git.DIFF_BYTE_CAP, `sent ${huge.bytes}, cap ${git.DIFF_BYTE_CAP}`);
    assert.ok(huge.truncated > 0, 'and says how many bytes it left out');
    assert.ok(huge.diff.endsWith('\n'),
        'cut on a line boundary — half a line reaching a diff parser is worse than a short diff');
    ok('a diff past the cap is truncated on a line boundary and says by how much');

    // A clean file is an empty diff rather than a failure, which is what lets the
    // client fall back to the transcript's answer.
    const clean = await git.diffText(REPO, 'first.txt');
    run('add', 'first.txt');
    run('commit', '-qm', 'clean');
    const nowClean = await git.diffText(REPO, 'first.txt');
    assert.strictEqual(clean.ok, true);
    assert.strictEqual(nowClean.ok, true);
    assert.strictEqual(nowClean.diff, '', 'nothing uncommitted is an empty answer, not an error');
    ok('a file with nothing uncommitted answers with an empty diff');

    console.log(`\n${pass} groups passed`);
})().then(
    () => fs.rmSync(TMP, { recursive: true, force: true }),
    (e) => {
        console.error(e);
        fs.rmSync(TMP, { recursive: true, force: true });
        process.exit(1);
    },
);
