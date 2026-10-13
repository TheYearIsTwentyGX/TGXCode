'use strict';

// Making a git worktree for a session that is about to start in it.
//
// `POST /api/sessions` with `worktree: {name, base?}` comes here first, and the
// session is then spawned with the new worktree as its cwd. What it decided:
//
//   * **The bridge runs git, not `claude --worktree`.** Letting Claude Code make
//     the worktree means the session starts in the main checkout and moves, and a
//     session that crosses into a worktree leaves two transcripts behind (see
//     `conversationRecord` in bridge/sessions.js). Starting in the worktree from
//     the first message leaves one, with the cwd the rail already knows how to
//     nest — `.claude/worktrees/<name>` is what transcript.js's WORKTREE_DIR_RE
//     reads.
//   * **The same layout `EnterWorktree` uses.** `<top>/.claude/worktrees/<name>`
//     on branch `worktree-<name>`, so a worktree made here and one an agent made
//     look the same to everything downstream, and to the person reading
//     `git worktree list`.
//   * **Never nested.** Asked from inside a worktree, the new one goes under the
//     *main* repository, found through `--git-common-dir`. A worktree of a
//     worktree under `.claude/worktrees/a/.claude/worktrees/b` is legal git and
//     nothing anyone meant.
//   * **Refuses rather than reuses.** A path or a branch that already exists is
//     `worktree-exists`, with the path, and nothing is touched: re-using one would
//     silently start a second session in somebody's work in progress, and the
//     caller is in a better position to offer "open the one that is there".
//   * **No removal.** Deleting a worktree throws away whatever is uncommitted in
//     it, and that is a decision for a person looking at it, not a side effect of
//     anything this module is asked to do.
//
// Every git call goes through `run()` from bridge/git.js — execFile, never a
// shell, always with a cwd and a timeout — and the name and base are validated
// before either reaches an argv, so neither can be read as an option.

const fs = require('fs');
const path = require('path');

const git = require('./git');

const NAME_RE = /^[A-Za-z0-9._-]{1,60}$/;
// `worktree add` checks out a whole tree, which on a large repository is the one
// git call here that is not instant.
const ADD_TIMEOUT_MS = 60_000;

/** An Error with a machine-readable `code`, and whatever else the caller needs. */
function refusal(code, message, extra = {}) {
    return Object.assign(new Error(message), { code }, extra);
}

/** Why `name` cannot be a worktree name, or null. */
function nameProblem(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
        return 'worktree name must be 1–60 letters, digits, ".", "_" or "-"';
    }
    // Each of these passes the pattern and is still not a directory or a branch
    // anyone could have meant: `.` and `..` are paths, git refuses a ref
    // component that starts with a dot or ends with `.lock`, and a directory
    // called `-rf` is one every shell command near it will read as an option.
    if (/^[.-]/.test(name) || name.endsWith('.lock') || name.includes('..')) {
        return `"${name}" cannot be a worktree name`;
    }
    return null;
}

/**
 * The repository a worktree for `cwd` belongs under: the main checkout's top
 * level, even when `cwd` is itself a worktree or a directory inside one.
 */
async function mainTop(cwd) {
    const top = await git.run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    if (!top.ok) throw refusal('not-a-repo', `${cwd} is not inside a git repository`);
    const own = top.stdout.trim();

    // Relative to `cwd` when git feels like it, absolute otherwise; resolving
    // against the directory it was asked in handles both.
    const common = await git.run('git', ['-C', cwd, 'rev-parse', '--git-common-dir']);
    if (!common.ok) return own;
    const dir = path.resolve(cwd, common.stdout.trim());
    // A normal repository's common dir is `<top>/.git`. Anything else — a
    // submodule's `.git/modules/x`, a separate git dir — has no top level to
    // derive from it, and the worktree's own top level is the honest answer.
    return path.basename(dir) === '.git' ? path.dirname(dir) : own;
}

/**
 * Where a worktree called `name` would go for `repoCwd`, without making it.
 * Throws the same refusals createWorktree does for a bad name or a non-repo.
 */
async function planWorktree(repoCwd, name) {
    const problem = nameProblem(name);
    if (problem) throw refusal('bad-name', problem);
    const top = await mainTop(repoCwd);
    return {
        top,
        path: path.join(top, '.claude', 'worktrees', name),
        branch: `worktree-${name}`,
    };
}

/**
 * Make `<top>/.claude/worktrees/<name>` on a new branch `worktree-<name>`, from
 * `base` (HEAD when not given). Resolves `{path, branch}`.
 *
 * Refusals are Errors with a `code`: `bad-name`, `bad-base`, `not-a-repo`,
 * `outside-roots`, `worktree-exists` (with `path`), and `git-failed` (with git's
 * first line as the message). Nothing is created on any of them.
 *
 * `allow(path)` is asked of the new path before anything is written — the bridge
 * passes its allowed-roots test, so a repository whose top level sits above the
 * roots cannot be used to create a directory outside them.
 */
async function createWorktree(repoCwd, name, base, { allow = null } = {}) {
    const ref = base == null || base === '' ? 'HEAD' : base;
    if (typeof ref !== 'string' || ref.length > 200 || ref.startsWith('-') || /[\s\0]/.test(ref)) {
        throw refusal('bad-base', 'worktree base must be a branch, tag or commit');
    }

    const plan = await planWorktree(repoCwd, name);
    if (allow && !allow(plan.path)) {
        throw refusal('outside-roots', `${plan.path} is outside the allowed roots`, { path: plan.path });
    }

    if (fs.existsSync(plan.path)) {
        throw refusal('worktree-exists', `${plan.path} already exists`, { path: plan.path, branch: plan.branch });
    }
    const branch = await git.run('git',
        ['-C', plan.top, 'rev-parse', '--verify', '-q', `refs/heads/${plan.branch}`]);
    if (branch.ok) {
        throw refusal('worktree-exists', `branch ${plan.branch} already exists`,
            { path: plan.path, branch: plan.branch });
    }

    const add = await git.run('git',
        ['-C', plan.top, 'worktree', 'add', '-b', plan.branch, plan.path, ref],
        { timeout: ADD_TIMEOUT_MS });
    if (!add.ok) {
        // `fatal: invalid reference: nope` is the useful line; the "Preparing
        // worktree" chatter git prints first on stderr is not.
        const lines = add.stderr.split('\n').map(s => s.trim()).filter(Boolean);
        const said = lines.find(l => /^(fatal|error):/.test(l)) || git.firstLine(add.stderr) || 'git worktree add failed';
        throw refusal('git-failed', said);
    }
    // So the next status read of the main checkout does not answer from before.
    git.clearCache(plan.top);
    return { path: plan.path, branch: plan.branch };
}

// ---------------------------------------------------------------------------
// A worktree on a branch that already exists
// ---------------------------------------------------------------------------
//
// `createWorktree` always makes a new `worktree-<name>` branch, which is right
// for starting new work and wrong for fixing a pull request: a session asked to
// push to the PR has to be *on* the PR's branch. So "Fix this" on a review
// finding (bridge/routes/pr-reviews.js) asks two things of this module instead —
// is that branch already checked out somewhere, and if not, check it out under
// `.claude/worktrees/` the same way. Neither ever makes a branch of its own name.

/**
 * `git worktree list --porcelain` as `[{path, head, branch}]`. `branch` is the
 * short name, or null for a detached HEAD. Pure, so the test can feed it text.
 */
function parseWorktreeList(text) {
    const out = [];
    let cur = null;
    for (const line of String(text || '').split('\n')) {
        if (line.startsWith('worktree ')) {
            cur = { path: line.slice(9), head: null, branch: null };
            out.push(cur);
        } else if (cur && line.startsWith('HEAD ')) {
            cur.head = line.slice(5);
        } else if (cur && line.startsWith('branch ')) {
            cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
        }
    }
    return out;
}

/** Why `branch` cannot be handed to git as a branch name, or null. */
function branchProblem(branch) {
    if (typeof branch !== 'string' || !branch || branch.length > 200
        || branch.startsWith('-') || /[\s\0~^:?*[\\]/.test(branch) || branch.includes('..')) {
        return 'not a usable branch name';
    }
    return null;
}

/**
 * Where `branch` is checked out for the repository `repoCwd` belongs to:
 * `{path, main}` — `main` true when it is the main checkout rather than a
 * worktree — or null when no worktree has it.
 */
async function worktreeForBranch(repoCwd, branch) {
    if (branchProblem(branch)) return null;
    const top = await mainTop(repoCwd);
    const list = await git.run('git', ['-C', top, 'worktree', 'list', '--porcelain']);
    if (!list.ok) return null;
    const hit = parseWorktreeList(list.stdout).find(w => w.branch === branch);
    if (!hit) return null;
    return { path: hit.path, main: git.samePath(hit.path, top) };
}

/**
 * Check `branch` out at `<top>/.claude/worktrees/<name>`, fetching it from
 * `origin` first. `name` taken already is tried as `<name>-2`, `-3` … — the
 * caller asked for "a worktree for this branch", not for a particular directory.
 *
 * A local branch of that name is used as it stands (the session is told to pull);
 * otherwise one is made tracking `origin/<branch>`. Resolves `{path, branch}`.
 * Refusals: `bad-name`, `bad-branch`, `not-a-repo`, `outside-roots`,
 * `fetch-failed` (the branch is not on origin — a fork's, usually), `git-failed`.
 */
async function checkoutWorktree(repoCwd, name, branch, { allow = null } = {}) {
    if (branchProblem(branch)) throw refusal('bad-branch', `"${branch}" is ${branchProblem(branch)}`);
    let plan = null;
    for (let i = 1; i <= 9 && !plan; i++) {
        const candidate = await planWorktree(repoCwd, i === 1 ? name : `${name}-${i}`);
        if (!fs.existsSync(candidate.path)) plan = candidate;
    }
    if (!plan) throw refusal('worktree-exists', `every ${name}-N under .claude/worktrees is taken`);
    if (allow && !allow(plan.path)) {
        throw refusal('outside-roots', `${plan.path} is outside the allowed roots`, { path: plan.path });
    }

    const fetch = await git.run('git',
        ['-C', plan.top, 'fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        { timeout: ADD_TIMEOUT_MS });
    if (!fetch.ok) {
        throw refusal('fetch-failed',
            `could not fetch ${branch} from origin: ${git.firstLine(fetch.stderr) || 'git fetch failed'}`);
    }

    const local = await git.run('git',
        ['-C', plan.top, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
    const args = local.ok
        ? ['-C', plan.top, 'worktree', 'add', plan.path, branch]
        : ['-C', plan.top, 'worktree', 'add', '--track', '-b', branch, plan.path, `origin/${branch}`];
    const add = await git.run('git', args, { timeout: ADD_TIMEOUT_MS });
    if (!add.ok) {
        const lines = add.stderr.split('\n').map(s => s.trim()).filter(Boolean);
        const said = lines.find(l => /^(fatal|error):/.test(l)) || git.firstLine(add.stderr) || 'git worktree add failed';
        throw refusal('git-failed', said);
    }
    git.clearCache(plan.top);
    return { path: plan.path, branch };
}

module.exports = {
    createWorktree, planWorktree, nameProblem, NAME_RE,
    parseWorktreeList, branchProblem, worktreeForBranch, checkoutWorktree,
};
