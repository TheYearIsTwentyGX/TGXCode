'use strict';

// Interactive shells for the terminal pane.
//
// Node has no pty of its own and this project ships no native modules, so the
// pty comes from util-linux's script(1): it allocates one, runs a shell on it,
// and copies bytes between that pty and its own stdio — which is the whole job.
//
// The one thing script(1) will not do is resize. It takes the window size from
// its own stdin, and ours is a pipe, so the pty starts at 0×0 and every full
// screen program draws into nothing. The fix is to talk to the pty directly:
// the shell writes its tty path to a file on the way in, and a resize is
// `stty -F` on that path. The kernel raises SIGWINCH from there, so bash
// updates COLUMNS and LINES exactly as it would under a real terminal.
//
// The shell is interactive but *not* a login shell, and that is deliberate:
// ~/.bashrc is where nvm and ~/.local/bin land on this machine, and a login
// shell never reads it. See the note in launch.sh — the bridge itself may well
// have been started without node on PATH for that reason.
//
// A Terminal is also what a *run* is made of — a command a project declared,
// started from a button rather than typed. See bridge/runs.js. Everything that
// differs is an option here, and every option defaults to the shell's behaviour,
// so nothing in this file changed shape for it: a run is a terminal whose first
// command is not a prompt, which stays alive with nobody watching, and which
// keeps a copy of its output on disk.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { randomUUID } = require('crypto');

// Enough to redraw what was on screen when a pane is reopened or the window is
// reloaded, without holding the output of a `find /` forever.
const SCROLLBACK_BYTES = 512 * 1024;

// A shell nobody has looked at for this long is closed. Terminals otherwise
// live as long as the bridge does, so that a long build keeps running while the
// pane is shut — but a shell sitting at a prompt in a session from last week is
// just two processes nobody will ever type into again.
const IDLE_MS = 30 * 60_000;

const MAX_TERMINALS = 24;

// A dead terminal is kept this long so an attached pane still hears why it
// ended, then dropped.
const REAP_MS = 60_000;

// How much of a run's output is kept on disk, and how many generations. A dev
// server that has been up for a week is mostly request logs; the recent end is
// the part anyone reads.
const LOG_BYTES = 8 * 1024 * 1024;

/** Only ever used unquoted inside the pty command line, so keep it boring. */
function safeShell(candidate) {
    if (candidate && /^\/[\w.+/-]+$/.test(candidate)) {
        try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* fall through */ }
    }
    return '/bin/bash';
}

/**
 * Quote a string for the one place this file puts somebody else's text on a
 * command line.
 *
 * The comment on the boot string below says the only shell metacharacters in it
 * are ones written here. A declared command breaks that on purpose, so it goes
 * through this: single quotes stop everything, and the `'\''` dance is how you
 * get a single quote inside them. A NUL would truncate the line at the exec, so
 * commands.js rejects one before it reaches here — belt and braces, refuse it
 * again rather than quote something that cannot be quoted.
 */
function shq(s) {
    const str = String(s);
    if (str.includes('\0')) throw new Error('command contains a NUL byte');
    return `'${str.replace(/'/g, `'\\''`)}'`;
}

function clampDim(n, fallback, max) {
    const v = Math.floor(Number(n));
    return Number.isFinite(v) && v > 0 ? Math.min(v, max) : fallback;
}

class Terminal {
    /**
     * @param {object}   opt
     * @param {string}  [opt.command]   run this instead of an interactive prompt
     * @param {object}  [opt.env]       extra environment, applied over the defaults
     * @param {string}  [opt.logFile]   keep a copy of the output here
     * @param {Function}[opt.onExit]    called once, with {code, signal}
     */
    constructor({ sessionId, cwd, rows, cols, command, env: extraEnv, logFile, onExit }) {
        this.id = randomUUID();
        this.sessionId = sessionId;
        this.cwd = cwd;
        this.rows = clampDim(rows, 24, 500);
        this.cols = clampDim(cols, 80, 1000);
        this.command = command || null;
        this.onExit = typeof onExit === 'function' ? onExit : null;
        // A declared command assumes bash — it was written in a config file, not
        // typed by whoever's $SHELL this is. A prompt somebody is going to type
        // into should be the shell they chose.
        this.shell = this.command ? '/bin/bash' : safeShell(process.env.SHELL);

        this.chunks = [];        // scrollback, whole writes only
        this.bytes = 0;
        this.listeners = new Set();
        this.exited = null;      // {code, signal} once the shell is gone
        this.exitedAt = 0;
        this.lastSeen = Date.now();

        this.logFile = logFile || null;
        this.log = null;         // opened on the first write, not before
        this.logBytes = 0;
        this.closed = false;

        // Where the shell reports its pty. Read lazily on the first resize —
        // by then it has certainly been written, and nothing needs it before.
        this.ttyFile = path.join(os.tmpdir(), `${TTY_PREFIX}${this.id}`);
        this.tty = null;

        // `script` copies our stdin to the pty and the pty to our stdout, so
        // the only shell metacharacters in this line are ones written here —
        // except a declared command, which goes through shq() for that reason.
        // Setting the size from inside means the very first draw is correct;
        // afterwards it is stty -F from the outside.
        //
        // `-i` is load-bearing in both forms, not decoration: nvm and
        // ~/.local/bin come from ~/.bashrc and only an interactive shell reads
        // it, so `npm run dev` without it fails with `node: not found`.
        const tail = this.command
            ? `exec ${this.shell} -i -c ${shq(this.command)}`
            : `exec ${this.shell} -i`;
        const boot = `printf %s "$(tty)" > ${this.ttyFile}; `
            + `stty rows ${this.rows} cols ${this.cols} 2>/dev/null; `
            + tail;

        const env = {
            ...process.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            LANG: process.env.LANG || 'C.UTF-8',
            ...(extraEnv || {}),
        };
        // Both deletions are after the caller's env on purpose: they are not
        // defaults to be overridden.
        //
        // A shell opened from here is a place to run commands by hand. If the
        // bridge was itself started from inside a session, nothing downstream
        // should go on believing it is the agent's own environment.
        delete env.CLAUDE_CODE_ENTRYPOINT;
        // And this pane is the likeliest place of all for someone to type
        // `bash bridge/launch.sh`. Inheriting the port would aim that at the
        // everyday instance without saying so — see sessionEnv in runner.js.
        // A declared `npm run dev` in *this* repo is the same accident with
        // nobody typing anything, which is why it is unconditional.
        delete env.CLAUDE_SESSIONS_PORT;
        // Nothing to delete for the API token: auth.js reads it from TOKEN_FILE
        // and never puts it in the environment, so a child cannot inherit it.

        this.proc = spawn('script', ['-qfec', boot, '/dev/null'], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            // Its own process group, so closing the pane takes the shell and
            // whatever it is running down with it rather than orphaning them.
            detached: true,
            env,
        });

        this.proc.stdout.on('data', (buf) => this.push(buf));
        // script(1) says nothing on stderr in normal use, so anything here is
        // worth seeing in the pane rather than swallowing.
        this.proc.stderr.on('data', (buf) => this.push(buf));
        // The same asynchronous EPIPE `bridge/runner.js` guards against, in the
        // one other place this bridge writes to a child's stdin. `write()` below
        // has a try/catch, but a broken pipe on a socket does not throw there — it
        // arrives as an 'error' on the stream, and unhandled that is thrown and
        // takes the whole bridge down. A keystroke in flight as the shell exits is
        // all it needs.
        this.proc.stdin.on('error', () => { /* the shell is going away */ });
        this.proc.stdout.on('error', () => { /* ditto */ });
        this.proc.stderr.on('error', () => { /* ditto */ });

        this.proc.on('error', (err) => {
            this.push(Buffer.from(`\r\n[claude-sessions] could not start a shell: ${err.message}\r\n`));
            this.finish(null, null);
        });
        this.proc.on('exit', (code, signal) => this.finish(code, signal));
    }

    push(buf) {
        this.chunks.push(buf);
        this.bytes += buf.length;
        while (this.bytes > SCROLLBACK_BYTES && this.chunks.length > 1) {
            this.bytes -= this.chunks.shift().length;
        }
        this.tee(buf);
        for (const send of this.listeners) send('data', { b64: buf.toString('base64') });
    }

    /**
     * Keep a copy on disk, for runs.
     *
     * Scrollback is half a megabyte and lives in this process, which is the
     * right size for redrawing a pane and the wrong one for "why did the build
     * fail an hour ago". The file is 0600 because a dev server's output
     * routinely contains tokens and connection strings.
     *
     * Opened on the first byte rather than at construction, so a run that never
     * says anything leaves nothing behind.
     */
    tee(buf) {
        if (!this.logFile || this.closed) return;
        try {
            if (!this.log) {
                this.log = fs.createWriteStream(this.logFile, { flags: 'a', mode: 0o600 });
                this.log.on('error', () => { this.log = null; this.logFile = null; });
            }
            this.log.write(buf);
            this.logBytes += buf.length;
            if (this.logBytes > LOG_BYTES) this.rotate();
        } catch { this.log = null; this.logFile = null; }
    }

    /** One generation kept: the current file, and the one before it. */
    rotate() {
        const file = this.logFile;
        const stream = this.log;
        this.log = null;
        this.logBytes = 0;
        try { stream.end(); } catch { /* already closed */ }
        try { fs.renameSync(file, `${file}.1`); } catch { this.logFile = null; }
    }

    finish(code, signal) {
        if (this.exited) return;
        this.exited = { code, signal };
        this.exitedAt = Date.now();
        this.cleanup();
        for (const send of this.listeners) send('exit', { code, signal });
        // Last, and outside the listener loop: a run releases its port and
        // clears its DevBrowser title here, and neither should depend on whether
        // anyone happened to be watching.
        if (this.onExit) {
            const fn = this.onExit;
            this.onExit = null;
            try { fn({ code, signal }); } catch (err) {
                console.error(`[claude-sessions] terminal onExit failed: ${err.message}`);
            }
        }
    }

    /**
     * Drop the file the shell reported its pty in, and close the log.
     *
     * Called from kill() as well as from finish(), because a shell killed as the
     * bridge exits never gets as far as its own exit event — the process is gone
     * before the event loop turns again, and the file would outlive us.
     */
    cleanup() {
        this.closed = true;
        try { fs.unlinkSync(this.ttyFile); } catch { /* already gone */ }
        if (this.log) { try { this.log.end(); } catch { /* already closed */ } this.log = null; }
    }

    /** Replay what is on screen, then follow. Returns a detach function. */
    attach(send) {
        this.lastSeen = Date.now();
        this.listeners.add(send);
        if (this.bytes) send('data', { b64: Buffer.concat(this.chunks).toString('base64') });
        if (this.exited) send('exit', this.exited);
        return () => {
            this.listeners.delete(send);
            this.lastSeen = Date.now();
        };
    }

    write(data) {
        if (this.exited) return false;
        this.lastSeen = Date.now();
        try { this.proc.stdin.write(data); return true; } catch { return false; }
    }

    resize(rows, cols) {
        this.rows = clampDim(rows, this.rows, 500);
        this.cols = clampDim(cols, this.cols, 1000);
        this.lastSeen = Date.now();
        if (this.exited) return;

        if (!this.tty) {
            try { this.tty = fs.readFileSync(this.ttyFile, 'utf8').trim() || null; }
            catch { return; /* the shell has not reported it yet; the next one will */ }
            if (!/^\/dev\/pts\/\d+$/.test(this.tty)) { this.tty = null; return; }
        }
        execFile('stty', ['-F', this.tty, 'rows', String(this.rows), 'cols', String(this.cols)],
            { timeout: 5000 }, () => { /* the shell may have just exited; nothing to do */ });
    }

    /**
     * Signal the shell's whole process group.
     *
     * Guarded on a real pid because the negative form of kill(2) means "this
     * process group" for 0 — a spawn that never got off the ground would
     * otherwise take the bridge down with it.
     */
    signal(sig) {
        const pid = this.proc && this.proc.pid;
        if (!pid || pid <= 1) return;
        try { process.kill(-pid, sig); }
        catch { try { this.proc.kill(sig); } catch { /* already gone */ } }
    }

    /**
     * End the shell.
     *
     * `now` is for the bridge shutting down. The polite version escalates on a
     * timer, and a process on its way out does not get another two seconds of
     * event loop to run it in — a shell that shrugged off the SIGHUP would be
     * orphaned for good, still holding its pty, with nothing left to reattach
     * it to.
     */
    kill({ now = false } = {}) {
        if (this.exited) return;
        this.cleanup();
        if (now) { this.signal('SIGKILL'); return; }
        // SIGHUP is what closing a terminal window sends, so a shell with jobs
        // tears them down the usual way. Insist if it does not take the hint.
        this.signal('SIGHUP');
        setTimeout(() => {
            if (this.exited) return;
            this.signal('SIGKILL');
        }, 2000).unref();
    }

    info() {
        return {
            id: this.id,
            sessionId: this.sessionId,
            cwd: this.cwd,
            shell: this.shell,
            rows: this.rows,
            cols: this.cols,
            exited: this.exited,
        };
    }

    get pid() { return (this.proc && this.proc.pid) || null; }
}

const TTY_PREFIX = 'claude-sessions-tty-';

/**
 * Clear out pty-path files left by a bridge that was killed outright.
 *
 * Only old ones: the everyday instance and a development one run side by side,
 * and a file belonging to the other bridge's live shell must survive this.
 */
function sweepStaleTtyFiles() {
    const dir = os.tmpdir();
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
        if (!name.startsWith(TTY_PREFIX)) continue;
        const file = path.join(dir, name);
        try {
            if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
        } catch { /* gone, or not ours to remove */ }
    }
}

class TerminalPool {
    constructor() {
        /** @type {Map<string, Terminal>} */
        this.byId = new Map();
        /** @type {Map<string, string>} sessionId -> terminal id */
        this.bySession = new Map();

        const sweep = setInterval(() => this.reap(), 60_000);
        sweep.unref();
        this.sweep = sweep;
        sweepStaleTtyFiles();
    }

    /**
     * The terminal for a session, started if it is not already running.
     *
     * One shell per session, reused: reopening the pane should come back to the
     * directory you cd'd into and the command you left half-typed, not to a
     * fresh prompt.
     */
    open({ sessionId, cwd, rows, cols }) {
        const existing = this.get(this.bySession.get(sessionId));
        if (existing && !existing.exited) {
            existing.resize(rows, cols);
            return existing;
        }
        if (this.live().length >= MAX_TERMINALS) {
            throw new Error(`too many terminals open (${MAX_TERMINALS}) — close one first`);
        }
        const term = new Terminal({ sessionId, cwd, rows, cols });
        this.byId.set(term.id, term);
        this.bySession.set(sessionId, term.id);
        return term;
    }

    get(id) { return (id && this.byId.get(id)) || null; }

    live() { return [...this.byId.values()].filter(t => !t.exited); }

    close(id) {
        const term = this.get(id);
        if (!term) return false;
        term.kill();
        this.forget(term);
        return true;
    }

    /** Used when a session is deleted: its shell has nothing left to belong to. */
    closeSession(sessionId) {
        const id = this.bySession.get(sessionId);
        return id ? this.close(id) : false;
    }

    forget(term) {
        if (this.bySession.get(term.sessionId) === term.id) this.bySession.delete(term.sessionId);
    }

    /**
     * Only ever the shells this pool opened.
     *
     * Worth saying because a run (bridge/runs.js) is a Terminal too, and both
     * rules here would be wrong for one: the idle rule assumes a shell nobody
     * has typed into is dead weight, which is exactly backwards for a dev
     * server, and REAP_MS would drop the record the button needs to go on saying
     * "stopped, exit 1" tomorrow morning. RunPool holds its terminals itself and
     * reaps on its own terms, which is why they never reach this loop — an
     * opt-out flag here would only be a second place to get it wrong.
     */
    reap() {
        const now = Date.now();
        for (const term of [...this.byId.values()]) {
            if (term.exited) {
                if (now - term.exitedAt > REAP_MS && !term.listeners.size) {
                    this.byId.delete(term.id);
                    this.forget(term);
                }
                continue;
            }
            if (!term.listeners.size && now - term.lastSeen > IDLE_MS) {
                term.kill();
                this.forget(term);
            }
        }
    }

    shutdown() {
        clearInterval(this.sweep);
        for (const term of this.byId.values()) term.kill({ now: true });
    }
}

module.exports = { Terminal, TerminalPool, MAX_TERMINALS, shq };
