'use strict';
// Moving the app's own directories from their Claude Sessions names to their
// TGXCode ones — `~/.local/share/claude-sessions` → `~/.local/share/tgxcode`,
// and the same under `~/.cache`.
//
// **Moved, and then a symlink left where they were.** The move is what keeps
// the token, the flags and the schedules — a fresh empty directory would mean a
// new token, which logs out every paired phone, and would forget every decision
// in there. The symlink is what keeps everything that has not been updated yet
// working: a bridge still running the old code, the session host it started
// (whose socket is in the state directory and must stay reachable, or its turns
// are orphaned), a packaged shell that logs to the old cache path, and the
// statusline script a user's `~/.claude/settings.json` runs. All of those open
// the old path and land in the new directory.
//
// The move is a rename, so it is atomic and the files keep their inodes — a
// Unix socket stays connectable at its new path, which is what makes moving a
// live host's directory safe at all.
//
// Idempotent and quiet. Nothing to move, already moved, or another bridge
// moving it at the same instant all come out the same: the new directory is
// there, and this returns.
//
// Everything outside bridge/ that finds these directories on its own —
// scripts/restart-bridge.sh, scripts/quota-statusline.py, app/main.js — uses
// the rule "the new one if it exists, otherwise the old one if it exists,
// otherwise the new one", so none of them ever creates the new directory while
// the old one holds the data. That is what stops a cron run from making an
// empty `~/.cache/tgxcode` a moment before the bridge would have moved the real
// one there.

const fs = require('fs');
const path = require('path');

function isRealDir(p) {
    try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

function exists(p) {
    try { fs.lstatSync(p); return true; } catch { return false; }
}

/** Move whatever is in `from` and not yet in `to` across, entry by entry. */
function mergeInto(from, to) {
    let left = 0;
    for (const name of fs.readdirSync(from)) {
        const src = path.join(from, name);
        const dst = path.join(to, name);
        if (exists(dst)) { left += 1; continue; }
        try { fs.renameSync(src, dst); } catch { left += 1; }
    }
    return left;
}

/**
 * Put `oldDir`'s contents at `newDir` and leave `oldDir` as a symlink to it.
 * Returns what happened, for the tests and the log: 'none' (no old directory),
 * 'moved', 'merged', 'linked' (already done), or 'kept' when entries in both
 * collided and the old directory was left in place rather than overwrite one.
 */
function migrateDir(oldDir, newDir) {
    if (!isRealDir(oldDir)) {
        // Nothing to move, or a symlink from an earlier run. Either way done.
        return exists(oldDir) ? 'linked' : 'none';
    }

    let how = 'moved';
    if (!exists(newDir)) {
        fs.mkdirSync(path.dirname(newDir), { recursive: true });
        try {
            fs.renameSync(oldDir, newDir);
        } catch (err) {
            // Another bridge got there first, or the new one appeared in
            // between. Fall through to the merge.
            if (!isRealDir(newDir)) throw err;
            how = 'merged';
        }
    } else {
        how = 'merged';
    }

    // Both exist as real directories: either something created the new one by
    // hand, or an old-code process recreated the old one in the instant between
    // the rename and the symlink. Move across what does not collide.
    if (isRealDir(oldDir)) {
        if (mergeInto(oldDir, newDir) > 0) return 'kept';
        try { fs.rmdirSync(oldDir); } catch { return 'kept'; }
    }

    try {
        fs.symlinkSync(newDir, oldDir, 'dir');
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
    return how;
}

/**
 * Which of the two to use without moving anything — for code that must not be
 * the one to create the new directory. The same rule as the scripts.
 */
function resolveDir(oldDir, newDir) {
    if (exists(newDir)) return newDir;
    if (exists(oldDir)) return oldDir;
    return newDir;
}

module.exports = { migrateDir, resolveDir };
