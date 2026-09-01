'use strict';

// A short-lived `claude`, started for no reason except to ask how much quota
// is left.
//
// The percentages live in the status line, and the status line is an Ink
// component — it renders only in an interactive TUI, and nothing this bridge
// spawns is one. Two other routes were tried and written up in
// docs/plans/05-usage-and-quota.md: reproducing the CLI's own quota probe from
// outside is refused by the API, and there is no on-disk cache to read, because
// the CLI holds its rate-limit state in memory and drops it on exit.
//
// What is left is to *be* a TUI for a few seconds. Start `claude`, let its
// startup prefetch run the quota probe, let the status line render once, and
// take what scripts/quota-statusline.py wrote on the way past.
//
// ## Why this leaves nothing behind
//
// Measured, not hoped: **a session that is never sent a message writes no
// transcript.** So a beacon run creates no `<id>.jsonl`, which means no row in
// the rail, no cleanup timer deleting files that look like ours, and no
// pinned conversation to resume. That was not obvious — the design before this
// one kept a single conversation and reopened it precisely to avoid littering,
// and it turned out there was nothing to litter with.
//
// ## What it costs, and the things that stop it
//
// A CLI start and one `max_tokens: 1` request per run. Against a five-hour
// window that is a rounding error, but it is quota spent to measure quota, so
// the interval has a floor and the whole feature is off by default.
//
// Three things make a run fail, and all three fail the same safe way — no new
// reading, the pill goes on ageing visibly, nothing breaks:
//
//   - **A modal.** Trust prompts, feature announcements, a settings warning.
//     The beacon sends no keystrokes and will not: the trust prompt grants
//     read, edit and execute on a directory, and a background process
//     confirming dialogs it cannot read is not worth a percentage. This is why
//     the directory is yours to name in `~/.tgxcode/settings.json` and why the
//     instruction is to open Claude there yourself first.
//   - **`--bare`, which we must never pass.** It is the flag that would make
//     startup cheap and it explicitly skips background prefetches — which is
//     the probe. Same for `CLAUDE_CODE_SIMPLE`, so the environment is scrubbed.
//   - **`tengu_cicada_nap_ms`.** A remote config value gating the prefetch. It
//     is 0 today, meaning always prefetch; raised, runs inside the nap window
//     would skip the probe and the beacon would quietly stop refreshing.
//
// The pty comes from script(1) for the same reason bridge/terminal.js uses it:
// no native modules here. And the same gotcha applies — script(1) takes its
// window size from its own stdin, which is a pipe, so the pty starts 0×0 and
// Ink draws into nothing. Hence the `stty` on the way in.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const cfg = require('./config');
const { STATUSLINE_FILE } = require('./usage');

// The harvester. Passed by absolute path because `--settings` is read by a
// process whose cwd is the beacon directory, not ours.
const HARVESTER = path.join(__dirname, '..', 'scripts', 'quota-statusline.py');

// Long enough for a cold CLI start on a slow morning, short enough that a run
// blocked on a modal gives up well inside any sane interval.
const TIMEOUT_MS = 90_000;

// How often to look for a new reading while it runs.
const POLL_MS = 400;

// Big enough that the status line is not wrapped into uselessness.
const ROWS = 45;
const COLS = 120;

function shq(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** What the harvester last wrote, or null. Only `capturedAt` is used here. */
function capturedAt() {
    try {
        const d = JSON.parse(fs.readFileSync(STATUSLINE_FILE, 'utf8'));
        return typeof d.capturedAt === 'number' ? d.capturedAt : null;
    } catch {
        return null;
    }
}

class Beacon {
    constructor() {
        this.running = null;      // the child, while one is up
        this.last = null;         // {at, ok, reason, ms} of the most recent run
    }

    get busy() { return this.running !== null; }

    /**
     * One run. Resolves with the outcome; never rejects, because a failed
     * quota refresh is not an error anything upstream should handle — the
     * reading simply stays as old as it was.
     *
     * @param {string} dir a directory the user has already trusted Claude in
     */
    async run(dir) {
        if (this.running) return { ok: false, reason: 'already running' };

        // Tidy up after bridges that are no longer here before adding one of
        // our own. Carried on the outcome rather than logged: a count that
        // stays non-zero is a leak still happening, which is worth seeing in
        // the panel, and one that goes to zero and stays there is the fix
        // working.
        let reaped = 0;
        try { reaped = this.reap(); } catch { /* ps(1) is best-effort */ }

        const cwd = cfg.expandHome(dir || '');
        if (!cwd || !fs.existsSync(cwd)) {
            return this._done({ ok: false, reaped, reason: `no such directory: ${dir}` });
        }
        if (!fs.existsSync(HARVESTER)) {
            return this._done({ ok: false, reaped, reason: `harvester missing: ${HARVESTER}` });
        }

        const before = capturedAt();
        const started = Date.now();

        // Inline JSON rather than a temp file — `--settings` takes either, and
        // a file would be one more thing to write, clean up and get wrong.
        const settings = JSON.stringify({
            statusLine: {
                type: 'command',
                command: `python3 ${JSON.stringify(HARVESTER)}`,
                // The status line renders once on startup, which is usually
                // before the quota probe has answered. This is what gets a
                // second render after it has.
                refreshInterval: 3,
            },
        });

        const argv = [
            cfg.CLAUDE_BIN,
            '--settings', shq(settings),
            // Not our MCP servers — one of which is this app's own, so without
            // this the bridge would be starting clients of itself twice an hour.
            '--mcp-config', shq('{"mcpServers":{}}'),
            '--strict-mcp-config',
        ].join(' ');

        const boot = `stty rows ${ROWS} cols ${COLS} 2>/dev/null; exec ${argv}`;

        const env = { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8' };
        // Both of these would disable the startup prefetch, which is the entire
        // point of starting this process. Deleted rather than trusted to be
        // unset: the bridge may itself have been started from inside a session.
        delete env.CLAUDE_CODE_SIMPLE;
        delete env.CLAUDE_CODE_ENTRYPOINT;
        // Same reasoning as bridge/terminal.js — never hand a child the port.
        delete env.CLAUDE_SESSIONS_PORT;

        const proc = spawn('script', ['-qfec', boot, '/dev/null'], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            // Its own process group, so killing it takes the CLI with it rather
            // than orphaning a TUI nobody can see.
            detached: true,
            env,
        });
        this.running = proc;

        // Read and discard. The pipe has to be drained or the child blocks on a
        // full buffer once it has drawn enough; we keep only the tail, for the
        // panel to show when a run keeps timing out on a modal.
        let tail = '';
        const eat = (buf) => { tail = (tail + buf.toString('utf8')).slice(-4000); };
        proc.stdout.on('data', eat);
        proc.stderr.on('data', eat);

        let spawnError = null;
        proc.on('error', (err) => { spawnError = err.message; });

        const outcome = await new Promise((resolve) => {
            let settled = false;
            const finish = (o) => {
                if (settled) return;
                settled = true;
                clearInterval(poll);
                clearTimeout(cap);
                resolve(o);
            };

            const poll = setInterval(() => {
                if (spawnError) return finish({ ok: false, reason: spawnError });
                const now = capturedAt();
                if (now !== null && now !== before) {
                    finish({ ok: true, capturedAt: now });
                }
            }, POLL_MS);

            const cap = setTimeout(() => finish({
                ok: false,
                reason: 'timed out with no new reading — a dialog is probably waiting',
                screen: plain(tail),
            }), TIMEOUT_MS);

            proc.on('exit', () => {
                // It ended on its own. Give the harvester's last write a moment
                // to land before calling it a failure.
                setTimeout(() => {
                    const now = capturedAt();
                    finish(now !== null && now !== before
                        ? { ok: true, capturedAt: now }
                        : { ok: false, reason: 'claude exited without producing a reading', screen: plain(tail) });
                }, 300);
            });
        });

        this._kill(proc);
        this.running = null;
        return this._done({ ...outcome, reaped, ms: Date.now() - started });
    }

    _kill(proc) {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        // `kill(-0, …)` is "my own process group", which would be this bridge.
        // bridge/terminal.js `signal()` carries the same guard for the same
        // reason; a spawn that failed leaves `pid` undefined.
        if (!proc.pid || proc.pid <= 1) return;
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ }
        // A TUI that ignores SIGTERM is not left behind.
        setTimeout(() => {
            try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ }
        }, 3000).unref();
    }

    /**
     * The bridge is going down and this child must not outlive it.
     *
     * SIGKILL rather than the polite escalation `_kill` does, because the
     * caller is `shutdown()` in bridge/server.js and that exits 200ms later —
     * a SIGTERM grace timer would never fire, and the TUI would be orphaned for
     * good. Which is not hypothetical: five of them were, for 28 hours, each
     * re-rendering its status line every three seconds and writing a frozen
     * quota reading over everybody else's. There is nothing here to flush; a
     * half-finished reading is worth exactly nothing.
     */
    shutdown() {
        const proc = this.running;
        this.running = null;
        if (!proc || !proc.pid || proc.pid <= 1) return;
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }

    /**
     * Kill beacons left behind by bridges that are no longer here.
     *
     * `shutdown()` covers SIGINT and SIGTERM. It does not cover `kill -9`, a
     * crash, or an OOM, and the orphans that prompted all this came in a run of
     * four inside thirteen minutes — so the graceful path is demonstrably not
     * the only one taken. Every beacon run therefore tidies up after its
     * predecessors, and so does a bridge coming up.
     *
     * @returns {number} how many process groups were killed
     */
    reap() {
        let out;
        try {
            // `pgid` rather than `ppid`: the beacon spawns detached, so the
            // group is the unit to kill and ps(1) will simply tell us it.
            out = spawnSync('ps', ['-eo', 'pid=,pgid=,etimes=,args='],
                { encoding: 'utf8', maxBuffer: 8 << 20 });
        } catch {
            return 0;   // no ps(1). Nothing to do but leave them.
        }
        if (!out || out.error || typeof out.stdout !== 'string') return 0;

        const rows = [];
        let ownGroup = null;
        for (const line of out.stdout.split('\n')) {
            const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
            if (!m) continue;
            const row = { pid: Number(m[1]), pgid: Number(m[2]), etimes: Number(m[3]), args: m[4] };
            if (row.pid === process.pid) ownGroup = row.pgid;
            rows.push(row);
        }

        // Both rows of a beacon — the `script` leader and its `claude` child —
        // carry the same argv and the same group, so collecting groups rather
        // than pids means one kill each and no dependence on which of the two
        // ps happened to render legibly.
        const groups = new Set();
        for (const row of rows) {
            if (!isBeaconArgv(row.args)) continue;
            const owner = ownerPidOf(row.args);
            if (!shouldReap({
                etimes: row.etimes,
                ownerAlive: owner === null ? null : pidAlive(owner),
            })) continue;
            if (!row.pgid || row.pgid <= 1) continue;
            if (ownGroup !== null && row.pgid === ownGroup) continue;
            groups.add(row.pgid);
        }

        let killed = 0;
        for (const pgid of groups) {
            try {
                process.kill(-pgid, 'SIGKILL');
                killed++;
            } catch { /* already gone, or not ours to signal */ }
        }
        return killed;
    }

    _done(outcome) {
        this.last = { at: Math.floor(Date.now() / 1000), ...outcome };
        return this.last;
    }

    /** What the quota panel shows about the beacon itself. */
    status() {
        return this.last ? { ...this.last, running: this.busy } : { running: this.busy };
    }
}

// ---------------------------------------------------------------------------
// The reaper's decision, as pure functions.
//
// Split out from `Beacon.reap()` so the part that decides whether to send a
// SIGKILL can be tested against real `ps` lines without a process table. The
// positive case in test/usage.test.js is one of the five orphans, pasted
// verbatim.
// ---------------------------------------------------------------------------

/**
 * Is this argv one of our beacons?
 *
 * Three markers together, because each alone has innocent matches. A user's own
 * terminal runs the harvester — that is the whole point of installing it — so
 * that string by itself would have the reaper killing the sessions this app
 * exists to serve. An empty MCP server map under `--strict-mcp-config` is the
 * combination only this module produces.
 *
 * Deliberately matches the legacy shape too, which carries no receipt token: an
 * orphan predating that change is exactly the thing most in need of reaping.
 */
function isBeaconArgv(args) {
    const s = String(args || '');
    return s.includes('quota-statusline.py')
        && s.includes('--strict-mcp-config')
        && /--mcp-config\s+'?\{"mcpServers":\{\}\}'?/.test(s);
}

/** The bridge pid that spawned this beacon, read off the receipt path, or null. */
function ownerPidOf(args) {
    const m = String(args || '').match(/quota-beacon\.(\d+)\.[0-9a-f]+\.json/);
    if (!m) return null;
    const pid = Number(m[1]);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
}

/** Is that pid still around? Signal 0 tests for existence and delivers nothing. */
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means it exists and belongs to somebody else, which for our
        // purposes is alive. Only ESRCH means gone.
        return !!err && err.code === 'EPERM';
    }
}

/**
 * Should this beacon be killed?
 *
 * @param {number} etimes            seconds since it started, from `ps -o etimes=`
 * @param {boolean|null} ownerAlive  is the bridge that spawned it still up?
 *                                   null when the argv carries no receipt token
 */
function shouldReap({ etimes, ownerAlive }) {
    // Its bridge is gone. Nothing will ever kill it but us.
    if (ownerAlive === false) return true;
    // No owner to ask, or an owner that is alive but may have leaked this one
    // anyway. Ten minutes against a TIMEOUT_MS of ninety seconds, so a healthy
    // run belonging to a live bridge can never be caught by this.
    return Number.isFinite(etimes) && etimes > 600;
}

/** Readable tail of a TUI, for saying *which* dialog is in the way. */
function plain(s) {
    let out = String(s || '').replace(/\x1b\[[0-9;<>?]*[a-zA-Z]/g, '');
    out = out.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '');
    out = [...out].map(c => (c >= ' ' && c !== '\x7f') || c === '\n' ? c : ' ').join('');
    return out.split('\n').map(l => l.trim()).filter(Boolean).slice(-6).join(' · ').slice(0, 400);
}

module.exports = {
    Beacon, HARVESTER, TIMEOUT_MS, plain,
    isBeaconArgv, ownerPidOf, pidAlive, shouldReap,
};
