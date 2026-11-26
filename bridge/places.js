'use strict';

// Where a directory is: which checkout it belongs to, which worktree it sits in,
// and what branch that has out.
//
// Lifted out of bridge/transcript.js, where it grew up beside the Claude
// transcript reader because scanMeta was its first caller. None of it reads a
// transcript: every function here takes a path and looks at the disk, so a
// session of any runtime is placed in the rail by the same rules. The rail's
// project groups, the dev-server attribution in bridge/devservers.js and the
// worktree card all depend on these answers agreeing with each other, which is
// the reason they are one module rather than a copy per reader.
//
// bridge/transcript.js still re-exports every name here, so nothing that
// imported them from there had to change.

const fs = require('fs');
const path = require('path');

// `<project>/.claude/worktrees/<name>`, where the name may itself hold slashes —
// EnterWorktree allows a path of segments, and it becomes a path on disk.
const WORKTREE_DIR_RE = /^(.*)\/\.claude\/worktrees\/(.+)$/;

/** Whether `dir` is `root` or somewhere below it. */
function isUnder(dir, root) {
    return Boolean(dir && root) && (dir === root || dir.startsWith(root + '/'));
}

/**
 * The root of the worktree a directory sits in, or null if it is in none.
 *
 * Walks up to the nearest `.git` without leaving `.claude/worktrees/`, because a
 * worktree's name may hold slashes — `.claude/worktrees/a/b` is one worktree, and
 * taking the first segment would call it `a`. A worktree that has since been
 * removed has no `.git` to find, and falls back to the first segment, which is
 * right for every name without a slash.
 */
function worktreeRootOf(dir) {
    const m = WORKTREE_DIR_RE.exec(dir || '');
    if (!m || !dir.startsWith('/')) return null;
    const base = path.join(m[1], '.claude', 'worktrees');
    let at = path.resolve(dir);
    for (let i = 0; i < 16 && at.startsWith(base + '/'); i++) {
        if (isCheckout(at)) return at;
        at = path.dirname(at);
    }
    return path.join(base, m[2].split('/')[0]);
}

/**
 * The branch a checkout has out, read from its HEAD file rather than by running
 * git: a worktree's `.git` is a file naming its git directory, a clone's is the
 * directory itself. Null for a detached HEAD, or a checkout that is gone.
 */
function branchOf(dir) {
    try {
        const dotGit = path.join(dir, '.git');
        let gitDir = dotGit;
        if (fs.statSync(dotGit).isFile()) {
            const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
            if (!m) return null;
            gitDir = path.resolve(dir, m[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8');
        const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
        return ref ? ref[1].trim() : null;
    } catch {
        return null;
    }
}

/**
 * Where a session moved to `dir` is, in the summary's terms: `{cwd, projectCwd,
 * worktree, gitBranch}`. For an orchestrator the bridge moved (Orchestrators#
 * cwdOverride), which the transcript's trail knows nothing about — so this is
 * read off the directory alone, never off the trail.
 *
 * A worktree only when the directory is inside one: moved to a main checkout,
 * or to a plain directory holding several repositories, it is in none, however
 * many worktrees the trail visited. The project is the checkout that owns that
 * worktree, or the directory itself — what Claude Code would file a session
 * launched there under.
 */
function placeOf(dir) {
    const root = worktreeRootOf(dir);
    const projectCwd = projectRootOf(root || dir);
    return {
        cwd: dir,
        projectCwd,
        worktree: root ? {
            name: worktreeNameOf(root), branch: branchOf(root), path: root, originalCwd: projectCwd,
        } : null,
        gitBranch: branchOf(root || workspaceOf(dir) || dir),
    };
}

/** The checkout a worktree directory belongs to, or null if it is not one. */
function worktreeBaseOf(dir) {
    const m = WORKTREE_DIR_RE.exec(dir || '');
    return m ? m[1] : null;
}

/** A worktree directory's name, the part below `.claude/worktrees/`. */
function worktreeNameOf(dir) {
    const m = WORKTREE_DIR_RE.exec(dir || '');
    return m ? m[2] : null;
}

/**
 * The checkout underneath a directory, out through any nesting of worktrees.
 *
 * Worktrees nest: enter one from inside another and the session it belongs to is
 * recorded against the outer *worktree*, not the project. Taking that at face
 * value grew a rail group called "build-app" — a worktree filed as a project of
 * its own, which is the thing worktrees are mapped to their owners to avoid.
 */
function projectRootOf(dir) {
    let at = dir;
    // Bounded rather than `while`: this walks a path from a transcript, and a
    // malformed one should not be able to spin here.
    for (let i = 0; i < 8 && at; i++) {
        const base = worktreeBaseOf(at);
        if (!base) return at;
        at = base;
    }
    return at;
}

/**
 * The workspace a directory belongs to: the worktree it sits inside, or the
 * checkout above it.
 *
 * The mirror of projectRootOf, which walks *out* of worktrees to the owning
 * checkout. This one answers "whose desk is this on" where that answers "which
 * repository is this", and the difference matters for anything attributing a
 * process to a session. A dev server running in
 * `<proj>/.claude/worktrees/askui/web` belongs to the askui worktree — not to
 * the project, and emphatically not to the main checkout, which contains every
 * worktree by path and would otherwise claim all of their ports.
 *
 * WORKTREE_DIR_RE is greedy, so a worktree nested inside another resolves to
 * the inner one: the desk the work is actually happening on.
 */
function workspaceOf(dir) {
    if (!dir || !dir.startsWith('/')) return null;
    const here = path.resolve(dir);
    const m = WORKTREE_DIR_RE.exec(here);
    if (m) return path.join(m[1], '.claude', 'worktrees', m[2].split('/')[0]);
    // Not in a worktree, so the nearest checkout above. Bounded for the reason
    // projectRootOf is bounded: this walks a path that came from outside.
    let at = here;
    for (let i = 0; i < 40; i++) {
        if (isCheckout(at)) return at;
        const up = path.dirname(at);
        if (up === at) return null;
        at = up;
    }
    return null;
}

// A checkout root carries `.git` — a directory in a clone, a file in a worktree,
// so existence is the whole test. A directory that has since been deleted simply
// is not one, which leaves the launch cwd standing; that is the right answer for
// a path nobody can look at any more.
function isCheckout(dir) {
    if (!dir || !dir.startsWith('/')) return false;
    try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

module.exports = {
    isUnder, worktreeRootOf, branchOf, placeOf, worktreeBaseOf, worktreeNameOf,
    projectRootOf, workspaceOf, isCheckout,
};
