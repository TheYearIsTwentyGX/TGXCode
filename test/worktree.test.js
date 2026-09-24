'use strict';

// Whether a session is in a worktree, and which.
//
// Here rather than against a live bridge for the reason titles.test.js gives: it
// is a property of `scanMeta` reading a transcript, and the cases that matter are
// shapes of transcript that no request can provoke.
//
// **The bug this is made of.** The only thing that used to say "in a worktree"
// was a `worktree-state` entry, and only `EnterWorktree` writes one. An agent that
// made its own — `git worktree add .claude/worktrees/x` and a `cd` in Bash, which
// the LTCDataPlus instructions recommended because `EnterWorktree` branched from
// the wrong base — left no such entry. The fallback read the *first* checkout on
// the trail of cwds, which was the main checkout it launched in, so a session that
// did a thousand entries of work in a worktree sat in the rail as the main checkout
// on its launch branch. 24 of 180 transcripts on the machine it was found on.
//
// The fix is that the trail's latest evidence wins, and each case below is one of
// the ways "latest" could be misread: a mid-turn wander home that is not leaving,
// a prompt at home that is, an explicit record that is later contradicted, and a
// worktree of some other repository that must not be worn at all.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanMeta } = require('../bridge/transcript.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-worktree-'));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});

// A checkout with a real `.git` directory, and worktrees under it with `.git`
// files pointing into it — the two shapes `isCheckout` and the HEAD reader walk.
function checkout(name, branch = 'main') {
    const dir = path.join(TMP, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
    return dir;
}

function worktree(proj, name, branch) {
    const dir = path.join(proj, '.claude', 'worktrees', name);
    const gitDir = path.join(proj, '.git', 'worktrees', name.replace(/\//g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);
    fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
    return dir;
}

let seq = 0;
function transcript(lines) {
    const file = path.join(TMP, `s${++seq}.jsonl`);
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    return file;
}

// Entries in the key order Claude Code writes them: `message` first, `cwd` and
// `gitBranch` near the end — which is the order the scan depends on.
let ts = 0;
const stamp = () => new Date(Date.UTC(2026, 8, 24, 12, 0, ts++)).toISOString();
const prompt = (cwd, text, branch = 'main') => ({
    type: 'user', message: { role: 'user', content: text },
    timestamp: stamp(), cwd, gitBranch: branch,
});
const toolResult = (cwd, branch = 'main') => ({
    type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    timestamp: stamp(), cwd, gitBranch: branch,
});
const reply = (cwd, branch = 'main') => ({
    type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }] },
    timestamp: stamp(), cwd, gitBranch: branch,
});
const enter = (proj, wt, name) => ({
    type: 'worktree-state', worktreeSession: {
        worktreeName: name, worktreeBranch: `worktree-${name}`, worktreePath: wt, originalCwd: proj,
    },
});
const exit = () => ({ type: 'worktree-state', worktreeSession: null });

const PROJ = checkout('proj', 'replit-dev');
const X = worktree(PROJ, 'x', 'feature-x');
const A = worktree(PROJ, 'a', 'worktree-a');
const B = worktree(PROJ, 'b', 'feature-b');
const NESTED = worktree(PROJ, 'team/deep', 'feature-deep');
const OTHER = checkout('other');
const OTHER_WT = worktree(OTHER, 'theirs', 'their-branch');

// ---------------------------------------------------------------------------

{
    // The motivating case: launched in the checkout, then Bash moved it. Claude
    // Code's own gitBranch still says the launch branch — it lags — so the branch
    // has to come off disk.
    const m = scanMeta(transcript([
        prompt(PROJ, 'make a page', 'replit-dev'),
        reply(PROJ, 'replit-dev'),
        toolResult(X, 'replit-dev'),
        reply(X, 'replit-dev'),
        reply(X, 'replit-dev'),
    ]));
    assert.strictEqual(m.inWorktree, true);
    assert.strictEqual(m.worktree.name, 'x');
    assert.strictEqual(m.worktree.path, X);
    assert.strictEqual(m.worktree.branch, 'feature-x');
    assert.strictEqual(m.worktree.originalCwd, PROJ);
    assert.strictEqual(m.cwd, X);
    assert.strictEqual(m.projectCwd, PROJ);
    ok('a worktree entered by `cd` alone is found, with its branch read off disk');
}

{
    // A subdirectory of the worktree is still the worktree, not a worktree named
    // after the subdirectory.
    const m = scanMeta(transcript([
        prompt(PROJ, 'go'), toolResult(path.join(X, 'src', 'lib')), reply(path.join(X, 'src', 'lib')),
    ]));
    assert.strictEqual(m.worktree.name, 'x');
    assert.strictEqual(m.cwd, X);
    ok('a cwd deep inside the worktree resolves to its root');
}

{
    const m = scanMeta(transcript([
        prompt(PROJ, 'go'), toolResult(NESTED), reply(path.join(NESTED, 'web')),
    ]));
    assert.strictEqual(m.worktree.name, 'team/deep');
    assert.strictEqual(m.worktree.path, NESTED);
    assert.strictEqual(m.worktree.branch, 'feature-deep');
    ok('a worktree whose name holds a slash is named in full, not by its first segment');
}

{
    // Mid-turn wander home and back, and a transcript that *ends* on the wander:
    // tool results and replies in the checkout are not leaving.
    const m = scanMeta(transcript([
        prompt(PROJ, 'go'), toolResult(X), reply(X),
        prompt(X, 'keep going'), toolResult(path.join(PROJ, '.playwright-mcp')),
        reply(path.join(PROJ, '.playwright-mcp')),
    ]));
    assert.strictEqual(m.inWorktree, true);
    assert.strictEqual(m.worktree.name, 'x');
    ok('a mid-turn `cd` back into the checkout does not count as leaving');
}

{
    const m = scanMeta(transcript([
        prompt(PROJ, 'go'), toolResult(X), reply(X),
        prompt(PROJ, 'now something in main'), reply(PROJ),
    ]));
    assert.strictEqual(m.inWorktree, false);
    assert.strictEqual(m.worktree.name, 'x', 'where it was is kept, as an explicit exit keeps it');
    assert.strictEqual(m.cwd, PROJ);
    ok('a prompt given back in the checkout does count as leaving');
}

{
    // EnterWorktree then ExitWorktree, the path that always worked. The explicit
    // exit is the latest evidence, and entries after it are in the checkout.
    const m = scanMeta(transcript([
        prompt(PROJ, 'go'),
        enter(PROJ, A, 'a'), reply(A), toolResult(A),
        exit(), reply(PROJ),
    ]));
    assert.strictEqual(m.inWorktree, false);
    assert.strictEqual(m.worktree.name, 'a');
    assert.strictEqual(m.cwd, PROJ);
    ok('EnterWorktree then ExitWorktree reads as it did before');
}

{
    const m = scanMeta(transcript([
        prompt(PROJ, 'go'),
        enter(PROJ, A, 'a'), reply(A),
    ]));
    assert.strictEqual(m.inWorktree, true);
    assert.strictEqual(m.worktree.name, 'a');
    assert.strictEqual(m.cwd, A);
    ok('EnterWorktree alone reads as it did before');
}

{
    // Explicitly in `a`, then Bash walked it into `b`. The record is older than
    // the trail, so the trail wins.
    const m = scanMeta(transcript([
        prompt(PROJ, 'go'),
        enter(PROJ, A, 'a'), reply(A),
        toolResult(B), reply(B),
    ]));
    assert.strictEqual(m.inWorktree, true);
    assert.strictEqual(m.worktree.name, 'b');
    assert.strictEqual(m.worktree.branch, 'feature-b');
    assert.strictEqual(m.cwd, B);
    ok('a later `cd` into another worktree beats an older worktree-state record');
}

{
    // A reviewer in this project that looks inside another repository's worktree.
    const m = scanMeta(transcript([
        prompt(PROJ, 'review theirs'), toolResult(OTHER_WT), reply(OTHER_WT),
    ]));
    assert.strictEqual(m.inWorktree, false);
    assert.strictEqual(m.worktree, null);
    assert.strictEqual(m.projectCwd, PROJ);
    assert.strictEqual(m.cwd, PROJ);
    ok("another project's worktree on the trail is not worn");
}

{
    // Launched inside the worktree: the fallback that already worked, now with
    // the branch from disk rather than the lagging field.
    const m = scanMeta(transcript([
        prompt(X, 'go', 'stale'), reply(X, 'stale'),
    ]));
    assert.strictEqual(m.inWorktree, true);
    assert.strictEqual(m.worktree.name, 'x');
    assert.strictEqual(m.worktree.branch, 'feature-x');
    assert.strictEqual(m.projectCwd, PROJ);
    ok('a session launched in a worktree is still found');
}

{
    const m = scanMeta(transcript([
        prompt(PROJ, 'go', 'one'), reply(PROJ, 'one'), reply(PROJ, 'two'),
    ]));
    assert.strictEqual(m.gitBranch, 'two');
    ok('gitBranch is the latest recorded, not the first');
}

{
    // A prompt that quotes a cwd, ahead of the real one on the line. The scan must
    // read the entry's own field, not the quotation.
    const m = scanMeta(transcript([
        prompt(PROJ, `look at {"cwd":"${X}"} for me`),
        reply(PROJ),
    ]));
    assert.strictEqual(m.inWorktree, false);
    assert.strictEqual(m.worktree, null);
    ok('a cwd quoted inside a message is not mistaken for the entry\'s own');
}

{
    // A worktree that has since been removed: no `.git` to walk to and no HEAD to
    // read, so the name comes from the path and the branch from the transcript.
    const gone = path.join(PROJ, '.claude', 'worktrees', 'gone');
    const m = scanMeta(transcript([
        prompt(PROJ, 'go'), toolResult(path.join(gone, 'src'), 'gone-branch'),
    ]));
    assert.strictEqual(m.worktree.name, 'gone');
    assert.strictEqual(m.worktree.path, gone);
    assert.strictEqual(m.worktree.branch, 'gone-branch');
    ok('a removed worktree falls back to its path and the recorded branch');
}

console.log(`worktree: ${pass} passed`);
