'use strict';

// Picking up new code from inside the window, rather than from a terminal.
//
// `scripts/restart-bridge.sh` has done this since before there was a UI for it,
// and it stays the thing that does the killing and relaunching: it owns the
// worktree refusal, the journal, the log truncation, the `setsid nohup` and the
// come-back poll, and reimplementing any of that here would mean re-deriving all
// of it. `scripts/land.sh` delegates to it for the same reason and says so.
//
// What this module adds is the two things a script invoked from a route cannot
// do for itself:
//
//   * **The pull happens here, not via `--pull`.** The script reports a failed
//     pull by exiting 1 and writing `failed-pull` to its journal, with git's
//     actual words on a stdout nobody is reading. From a route that is a 200
//     followed by nothing happening — the silent-skip failure the script's own
//     header is about. Run in this process, git's stderr becomes the body of a
//     409 and the dialog can show it. The script keeps `--pull` because cron has
//     no HTTP caller to show anything to.
//   * **The blockers are checked before anything moves.** A refusal that came
//     after the pull would have fast-forwarded the user's checkout as a side
//     effect of a request that did nothing, leaving the running bridge on old
//     code with new code on disk. So: check, pull, check again.
//
// The one thing nothing here can do is report the outcome. The script's first
// act is to SIGTERM the process that started it, so its exit code, its stdout
// and `die()`'s stderr all land in a process whose parent is gone. That is why
// `launch` returns only where to look, why the route's 200 means "started" and
// not "restarted", and why the journal — served by the *next* bridge — is the
// only durable record of a run that decided not to.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const cfg = require('./config');
const git = require('./git');

// A pull talks to the network, so git.js's 10s default is a LAN answer to a
// wide-area question. commitRange's fetch picks 60s for the same reason.
const PULL_TIMEOUT_MS = 60_000;

// How much of the journal a client gets. It is one line per run that could have
// changed something, so twenty is a couple of weeks of nightly restarts plus
// whatever happened today.
const JOURNAL_LINES = 20;

const SCRIPT = path.join(cfg.ROOT, 'scripts', 'restart-bridge.sh');

/** The script's own narration, and the journal it appends its verdict to. */
const outLog = () => path.join(cfg.CACHE_DIR, `restart-${cfg.PORT}.out`);
const journalLog = () => path.join(cfg.CACHE_DIR, `restart-${cfg.PORT}.log`);

// ---------------------------------------------------------------------------
// What is in the way
// ---------------------------------------------------------------------------

/**
 * Reasons not to restart right now, as things a person can read.
 *
 * `force` drops the turn-in-flight objection and nothing else — it is the answer
 * to a question the dialog asked, not a blanket override.
 *
 * Uncommitted `bridge/` files are on this list because the script would
 * otherwise refuse over them and the route could not tell anyone why: its
 * `Continue? [y/N]` reads /dev/tty, a spawned child has no controlling terminal
 * on purpose (see `launch`), and a failed read there is taken for a no. The
 * dialog this feeds is that prompt, moved somewhere it can actually be answered.
 * Only `bridge/` counts: the bridge require()s it once at startup, while `web/`
 * is read per request and is already live.
 */
async function blockers(dir, { busy = 0, force = false } = {}) {
    const out = [];

    if (busy > 0 && !force) {
        out.push({
            kind: 'busy',
            text: `${busy} turn${busy === 1 ? '' : 's'} still running. A restart ends `
                + 'them — Claude stops when its input pipe closes.',
        });
    }

    // workingState rather than statusOf: statusOf caps its file list into a
    // `sample` and drops `entries`, so a dirty bridge/ file at position 21 would
    // be a blocker that vanished behind a display cap. It is also the uncached
    // half of the pair, which is what we want when the question is "right now".
    const st = await git.workingState(dir);
    if (!st || !st.ok) {
        out.push({
            kind: 'not-a-repo',
            text: st && st.reason === 'left-behind'
                ? `${dir} is no longer the top of its checkout.`
                : `Cannot read ${dir} as a git checkout${st && st.error ? `: ${st.error}` : '.'}`,
        });
        return out;
    }

    // status !== '??' drops untracked files, which the bridge does not load and
    // which are most of what is lying around this repo mid-session. Paths are
    // root-relative because workingState asks for them that way, so the prefix
    // test is safe. One difference from the script worth knowing about: it reads
    // porcelain v1, where a rename is `old -> new` and matches on the old path,
    // and this is v2, which gives the new one. The same answer nearly always.
    const dirty = st.entries
        .filter((e) => e.status !== '??' && e.path.startsWith('bridge/'))
        .map((e) => e.path);
    if (dirty.length) {
        out.push({
            kind: 'dirty-bridge',
            text: `${dirty.length} uncommitted file${dirty.length === 1 ? '' : 's'} under `
                + 'bridge/. Restarting loads them, committed or not.',
            files: dirty,
        });
    }

    return out;
}

// ---------------------------------------------------------------------------
// Catching up with the remote
// ---------------------------------------------------------------------------

/**
 * `git pull --ff-only`, and what it brought in.
 *
 * --ff-only so this can never leave a merge or a conflict behind; a diverged
 * branch is a decision for a person. Same choice, same reason, as the script's
 * own `--pull`.
 */
async function pull(dir) {
    const before = await head(dir);
    const r = await git.run('git', ['-C', dir, 'pull', '--ff-only'], {
        timeout: PULL_TIMEOUT_MS,
        // A bridge started from a terminal still has a controlling terminal, and
        // `origin` here is HTTPS behind a credential helper. A helper that fails
        // must fail rather than sit on /dev/tty asking for a username until the
        // timeout kills it — which would look from the outside like a network
        // that hung, and would leave .git/index.lock behind when it did.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const after = r.ok ? await head(dir) : before;

    // The dashboard keeps a 15s answer about this very directory warm, so after
    // moving HEAD its copy is a lie. Nothing here reads it — workingState is
    // uncached — this is for the board and the changes panel.
    if (after !== before) git.clearCache(dir);

    return {
        ok: r.ok,
        skipped: false,
        out: r.stdout.trim(),
        error: r.ok ? null : (r.stderr.trim() || `git pull exited ${r.code}`),
        before,
        after,
        changed: after && before && after !== before ? await changedBetween(dir, before, after) : [],
    };
}

async function head(dir) {
    const r = await git.run('git', ['-C', dir, 'rev-parse', 'HEAD']);
    return r.ok ? r.stdout.trim() : null;
}

async function changedBetween(dir, from, to) {
    const r = await git.run('git', ['-C', dir, 'diff', '--name-only', from, to]);
    if (!r.ok) return [];
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * What a caller should be told about what arrived — the classification
 * scripts/land.sh makes at the end of a merge, for the same reason.
 *
 * `bridge/` is the only one that needs a restart at all; `web/` is read per
 * request, so a refresh has already picked it up; `app/` and package.json need a
 * rebuild, which is never something to do without asking.
 */
function reach(changed) {
    const files = changed || [];
    return {
        bridge: files.some((f) => f.startsWith('bridge/')),
        web: files.some((f) => f.startsWith('web/')),
        shell: files.some((f) => f.startsWith('app/') || f === 'package.json'),
    };
}

// ---------------------------------------------------------------------------
// Handing over
// ---------------------------------------------------------------------------

/** Whether the script survived the pull that may just have replaced it. */
const scriptPresent = () => fs.existsSync(SCRIPT);

/**
 * Start the restart and return where to watch it, having no way to wait for it.
 *
 * `detached` is not about surviving the kill — the script sends SIGTERM to one
 * pid, not to a process group, and nothing in the bridge's shutdown touches
 * children it did not itself start, so a plain child would live either way. What
 * it buys is *no controlling terminal*: `can_ask()` in the script opens /dev/tty
 * rather than testing stdin, and a bridge run from `npm run dev` has a live one
 * that a non-detached child would inherit — at which point the dirty-bridge
 * prompt would read the developer's keystrokes out from under them. The same
 * reasoning is why test/restart.test.js spawns it detached.
 */
function launch({ force = false } = {}) {
    fs.mkdirSync(cfg.CACHE_DIR, { recursive: true });

    // Append, and deliberately not the bridge's own log: the script truncates
    // that one when it relaunches, so an inherited fd would keep the old offset
    // and write past a NUL hole into a fresh file, interleaved with the new
    // bridge's output. 'a' rather than 'w' for the same reason from the other
    // side — a concurrent truncate cannot hole this one either.
    const fd = fs.openSync(outLog(), 'a');
    try {
        const child = spawn('bash', [SCRIPT, force ? '--force' : '--yes'], {
            // $REPO comes from BASH_SOURCE, not from cwd, so the script path is
            // what decides which checkout comes back up. cwd is kept in
            // agreement rather than relied on.
            cwd: cfg.ROOT,
            detached: true,
            stdio: ['ignore', fd, fd],
            // Told, not inherited. The script reads CLAUDE_SESSIONS_PORT to
            // decide *which bridge to replace* and defaults to 45888 — the
            // everyday instance — when it is unset. Inheritance happens to agree
            // today because everything that starts a bridge exports it, which
            // leaves the whole guarantee one missing variable away from a dev
            // bridge in a worktree killing the user's instance and then being
            // refused the bind. Note this is the deliberate opposite of
            // runner.js and terminal.js, which *delete* it from their children:
            // a session must not learn a port, and this child must be told the
            // one it is standing in for.
            env: { ...process.env, CLAUDE_SESSIONS_PORT: String(cfg.PORT) },
        });
        child.unref();
        return { pid: child.pid, log: outLog(), journal: journalLog() };
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * The tail of the journal — the only place a run that decided not to restart
 * leaves a trace.
 *
 * `--yes` does not imply `--force`, so the script's own turn-in-flight guard is
 * still armed on every invocation: a turn starting between the route's check and
 * the script's own means `skipped-busy` and no restart, after a 200 has already
 * gone out. The bridge never dies, so no client sees anything happen. This is
 * how it finds out what did.
 */
function journal(lines = JOURNAL_LINES) {
    let text;
    try { text = fs.readFileSync(journalLog(), 'utf8'); }
    catch { return []; }
    return text.split('\n').filter((l) => l.trim()).slice(-lines);
}

module.exports = { blockers, pull, reach, launch, scriptPresent, journal, SCRIPT };
