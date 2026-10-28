'use strict';

// Approving `sudo` from the app.
//
// An agent's Bash tool has no terminal, so `sudo` cannot prompt and fails. sudo's
// own answer to that is SUDO_ASKPASS: a program it runs to get the password,
// which prints it on stdout. Each session this bridge starts is given one —
// bridge/sudo-askpass — and that helper asks the bridge, which raises a card in
// the app, waits for the user to type the password or deny, and hands the answer
// back to the helper and nowhere else.
//
// What was measured on the machine this was built on (Ubuntu, sudo-rs 0.2.13,
// with sudo.ws 1.9.17p2 also installed) rather than assumed:
//
//   - **sudo-rs uses askpass only with `-A`.** Without it and with no tty it says
//     "A terminal is required to authenticate" and never runs the helper. Classic
//     sudo (sudo.ws) runs the helper without `-A` when there is no tty and
//     SUDO_ASKPASS is set. `sudo -A` works under both, so that is what the agent
//     brief tells agents to type (bridge/brief.js). Nothing aliases or wraps sudo.
//   - **The helper's parent is sudo itself**, running setuid: real uid the user,
//     effective uid 0. Its /proc/<pid>/cmdline is world-readable, NUL-separated
//     (so `ls "a b"` stays two words), and is exactly the argv sudo will run. Its
//     exe and cwd links are not readable — the process is not dumpable — but the
//     helper inherited sudo's cwd, and the helper is ours to read.
//   - **The credential cache is per parent process.** With no tty, sudo-rs keys
//     the record on sudo's parent pid and that process's start time; classic sudo
//     falls back to the same `ppid` scope. Claude Code runs every Bash call as a
//     fresh `bash -c`, so one approval covers the rest of *that Bash call* for
//     `timestamp_timeout` (15 minutes by default) and the next call asks again.
//     That is why the card shows the whole Bash command as well as the sudo one:
//     `sudo -A true && sudo rm -rf /x` is approved by approving `true`.
//   - **sudo-rs has no `passwd_timeout`.** It waits on the helper for as long as
//     the helper waits. So does this: an ask stays open until it is answered, the
//     helper goes away, or the session stops. What bounds it in practice is the
//     Bash tool's own timeout, which kills the command — and with it the ask.
//
// **Who may raise an ask.** The helper presents a per-session key,
// `<sessionId>.<HMAC(token, sessionId)>`, from its environment. Derived rather
// than random so a bridge restarted under a live turn (bridge/host.js keeps those
// alive) can still check the key of a session it adopted. The key is not the
// bridge token and cannot be turned back into it.
//
// The key alone is not enough, because the agent can read its own environment
// and call the route with it. So the bridge does not take the request's word for
// anything: the helper sends its pid, and the bridge reads /proc itself —
//
//   1. that pid belongs to this user and its environment carries the very key
//      the request presented (so the claim is about a process of that session);
//   2. its parent is a sudo binary running with effective uid 0 (a process the
//      agent cannot fake without being sudo); and
//   3. the command shown is that parent's argv, read here, never sent.
//
// docs/manual.md §Approving sudo has the threat model in full, including what
// this does not protect against: a process running as you can read a password
// you type into anything.
//
// **The password** goes from the answering client's request body to the waiting
// helper's response body and nowhere else: never into an event, a log line, the
// notification log, prefs or disk. Every payload that leaves this module is built
// by `publicAsk`, which has no field that could carry it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const HELPER = path.join(__dirname, 'sudo-askpass');
const ENV = { key: 'TGXCODE_SUDO_KEY', port: 'TGXCODE_SUDO_PORT', node: 'TGXCODE_SUDO_NODE' };
const KEY_HEADER = 'x-tgxcode-sudo-key';

// `comm` of a sudo process. comm is the executable's file name, not argv[0], so
// `exec -a sudo` does not produce one — see the threat model for what a symlink
// can and cannot do with that.
const SUDO_NAMES = new Set(['sudo', 'sudo-rs', 'sudo.ws', 'sudoedit']);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'busybox']);

// sudo's options, both implementations. Those taking a value, and those that are
// a mode rather than a modifier.
const SHORT_WITH_ARG = new Set(['u', 'g', 'p', 'D', 'U', 'C', 'h', 'r', 't', 'T', 'R']);
const LONG_WITH_ARG = new Set(['user', 'group', 'prompt', 'chdir', 'other-user', 'close-from',
    'host', 'role', 'type', 'command-timeout', 'chroot']);
const MODE_OF = { s: 'shell', i: 'login', e: 'edit', l: 'list', v: 'validate', shell: 'shell',
    login: 'login', edit: 'edit', list: 'list', validate: 'validate' };

// ── the key ───────────────────────────────────────────────────────────────

function mac(secret, sessionId) {
    return crypto.createHmac('sha256', String(secret)).update(`sudo:${sessionId}`).digest('base64url');
}

/** The key a session's helper presents. */
function sessionKey(secret, sessionId) {
    return `${sessionId}.${mac(secret, sessionId)}`;
}

/** The session a key belongs to, or null if it is not one this secret made. */
function keySession(secret, key) {
    if (!secret || typeof key !== 'string' || key.length > 300) return null;
    const dot = key.lastIndexOf('.');
    if (dot <= 0) return null;
    const sessionId = key.slice(0, dot);
    const want = Buffer.from(mac(secret, sessionId));
    const got = Buffer.from(key.slice(dot + 1));
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    return sessionId;
}

/**
 * Add or strip the askpass variables on a session's environment.
 *
 * Stripped even when off: a bridge started from inside a session would otherwise
 * hand that session's key and helper on to every session it starts. A
 * SUDO_ASKPASS that is the user's own is left alone when off.
 */
function applyEnv(env, access) {
    for (const k of Object.values(ENV)) delete env[k];
    if (env.SUDO_ASKPASS === HELPER) delete env.SUDO_ASKPASS;
    if (!access) return env;
    env.SUDO_ASKPASS = HELPER;
    env[ENV.key] = access.key;
    env[ENV.port] = String(access.port);
    // The node that is running us: a login shell has none on PATH, and sudo runs
    // the helper with whatever PATH the agent's shell had.
    env[ENV.node] = process.execPath;
    return env;
}

// ── reading the command off /proc ─────────────────────────────────────────

function readStatus(procRoot, pid) {
    const text = fs.readFileSync(path.join(procRoot, String(pid), 'status'), 'utf8');
    const field = (name) => {
        const m = text.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'));
        return m ? m[1].trim() : null;
    };
    const uids = (field('Uid') || '').split(/\s+/).map(Number);
    return { name: field('Name'), ppid: Number(field('PPid')), uid: uids[0], euid: uids[1] };
}

function readArgv(procRoot, pid) {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8');
    const parts = raw.split('\0');
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts;
}

function readEnviron(procRoot, pid) {
    const out = {};
    const raw = fs.readFileSync(path.join(procRoot, String(pid), 'environ'), 'utf8');
    for (const pair of raw.split('\0')) {
        const eq = pair.indexOf('=');
        if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return out;
}

/** Field 22 of /proc/<pid>/stat: when it started, in clock ticks since boot. */
function readStart(procRoot, pid) {
    try {
        const raw = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
        // comm is in parentheses and may itself contain spaces or parentheses.
        const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        return rest[19] || null;
    } catch { return null; }
}

/**
 * What sudo was asked to do, from its argv.
 *
 * @param {string[]} argv the sudo process's argv, argv[0] included
 * @returns {{user: string, group: string|null, chdir: string|null,
 *   mode: 'run'|'shell'|'login'|'edit'|'list'|'validate', command: string[],
 *   runsShell: boolean}}
 */
function parseSudoArgv(argv) {
    const out = { user: 'root', group: null, chdir: null, mode: 'run', command: [], runsShell: false };
    const base = path.basename(String(argv[0] || 'sudo'));
    if (base.startsWith('sudoedit')) out.mode = 'edit';
    let i = 1;
    const take = (name, value) => {
        if (name === 'u' || name === 'user') out.user = value;
        else if (name === 'g' || name === 'group') out.group = value;
        else if (name === 'D' || name === 'chdir') out.chdir = value;
    };
    for (; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') { i++; break; }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
            if (eq > 0) take(name, a.slice(eq + 1));
            else if (LONG_WITH_ARG.has(name)) take(name, argv[++i] ?? '');
            if (MODE_OF[name]) out.mode = MODE_OF[name];
            continue;
        }
        if (a.startsWith('-') && a.length > 1) {
            for (let j = 1; j < a.length; j++) {
                const c = a[j];
                if (SHORT_WITH_ARG.has(c)) {
                    take(c, j + 1 < a.length ? a.slice(j + 1) : (argv[++i] ?? ''));
                    break;
                }
                if (MODE_OF[c]) out.mode = MODE_OF[c];
            }
            continue;
        }
        break;
    }
    out.command = argv.slice(i);
    out.runsShell = out.mode === 'shell' || out.mode === 'login' || runsShell(out.command);
    return out;
}

/** Does this command start a shell (or a `su`), whatever comes after it? */
function runsShell(command) {
    let i = 0;
    // `VAR=x cmd` and `env [-i] [VAR=x] cmd` both run cmd.
    while (i < command.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command[i])) i++;
    if (path.basename(command[i] || '') === 'env') {
        i++;
        while (i < command.length && (command[i].startsWith('-') || command[i].includes('='))) i++;
    }
    const exe = path.basename(command[i] || '');
    return SHELLS.has(exe) || exe === 'su';
}

/** argv as a person would type it, quoting only where the shell would need it. */
function shellQuote(argv) {
    return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
        .join(' ');
}

/**
 * The Bash command a sudo is part of, when its parent is a `sh -c` — which is
 * what every Bash tool call is. Claude Code wraps the command it was given in
 * `source <snapshot> && … && eval '<command>' < /dev/null && pwd -P >| …`; the
 * eval'd part is what the agent wrote, so that is what is shown. Anything else is
 * shown as it is.
 */
function bashContext(argv) {
    if (!argv || argv.length < 3) return null;
    if (!SHELLS.has(path.basename(argv[0]))) return null;
    const c = argv.indexOf('-c');
    if (c < 0 || c + 1 >= argv.length) return null;
    const script = argv[c + 1];
    const m = script.match(/(?:^|&& )eval '((?:[^']|'\\'')*)'/);
    return (m ? m[1].replace(/'\\''/g, "'") : script).slice(0, 4000);
}

/**
 * Verify a helper's claim and read what it is asking for, all from /proc.
 *
 * Throws an Error with a `status` and a sentence for the helper to print when
 * the claim does not hold; the sentence never echoes anything from the request.
 *
 * @param {number} pid the helper's pid, as it reported it
 * @param {string} key the key the request presented
 * @param {{procRoot?: string, uid?: number}} [opts]
 */
function readAsk(pid, key, { procRoot = '/proc', uid = process.getuid() } = {}) {
    const refuse = (status, message) => Object.assign(new Error(message), { status });
    if (!Number.isInteger(pid) || pid <= 1) throw refuse(400, 'no helper pid');
    let helper;
    try { helper = readStatus(procRoot, pid); } catch { throw refuse(403, 'that process is not there'); }
    if (helper.uid !== uid) throw refuse(403, 'that process is not yours');
    let env;
    try { env = readEnviron(procRoot, pid); } catch { throw refuse(403, 'cannot read that process'); }
    // Proves the pid is a process of the session the key names, not one the
    // caller pointed at.
    const theirs = Buffer.from(String(env[ENV.key] || ''));
    const given = Buffer.from(String(key));
    if (theirs.length !== given.length || !crypto.timingSafeEqual(theirs, given)) {
        throw refuse(403, 'that process is not this session\'s');
    }
    let sudo;
    try { sudo = readStatus(procRoot, helper.ppid); } catch { throw refuse(403, 'sudo is gone'); }
    if (sudo.euid !== 0 || sudo.uid !== uid || !SUDO_NAMES.has(sudo.name)) {
        throw refuse(403, 'the askpass helper was not started by sudo');
    }
    const argv = readArgv(procRoot, helper.ppid);
    if (!argv.length) throw refuse(403, 'sudo is gone');
    let cwd = null;
    try { cwd = fs.readlinkSync(path.join(procRoot, String(pid), 'cwd')); } catch { /* shown as unknown */ }
    let context = null;
    try { context = bashContext(readArgv(procRoot, sudo.ppid)); } catch { /* not a shell, or gone */ }
    const parsed = parseSudoArgv(argv);
    return {
        helperPid: pid,
        sudoPid: helper.ppid,
        sudoStart: readStart(procRoot, helper.ppid),
        argv,
        command: shellQuote(parsed.command),
        sudoLine: shellQuote(argv),
        cwd,
        user: parsed.user,
        group: parsed.group,
        chdir: parsed.chdir,
        mode: parsed.mode,
        runsShell: parsed.runsShell,
        context,
    };
}

// ── the asks ──────────────────────────────────────────────────────────────

/**
 * The asks waiting on a person, keyed by id.
 *
 * Emits `ask` with the public form when one opens and `resolved`
 * `{id, sessionId, outcome, reason?}` when it closes, `outcome` being
 * `approved`, `denied` or `cancelled`.
 */
class SudoAsks extends EventEmitter {
    /**
     * @param {{procRoot?: string, allowRemote?: () => boolean, sweepMs?: number,
     *          now?: () => number}} [opts]
     */
    constructor({ procRoot = '/proc', allowRemote = () => false, sweepMs = 2000, now = Date.now } = {}) {
        super();
        this.procRoot = procRoot;
        this.allowRemote = allowRemote;
        this.now = now;
        /** @type {Map<string, object>} */
        this.asks = new Map();
        // One sudo process asks again after a wrong password. Keyed on its pid and
        // start time, so a recycled pid is a new sudo.
        /** @type {Map<string, {tries: number, sudoPid: number}>} */
        this.tries = new Map();
        this.timer = sweepMs ? setInterval(() => this.sweep(), sweepMs) : null;
        if (this.timer && this.timer.unref) this.timer.unref();
    }

    /**
     * Open an ask and hold it until it is settled.
     *
     * @param {string} sessionId
     * @param {object} info what readAsk() returned
     * @param {(result: {password?: string, denied?: boolean, reason?: string}) => void} reply
     *   called exactly once, with the password or a refusal
     */
    open(sessionId, info, reply) {
        const id = crypto.randomBytes(9).toString('base64url');
        const sudoKey = `${info.sudoPid}:${info.sudoStart || ''}`;
        const t = this.tries.get(sudoKey) || { tries: 0, sudoPid: info.sudoPid };
        t.tries++;
        this.tries.set(sudoKey, t);
        const ask = { id, sessionId, info, attempt: t.tries, askedAt: this.now(), reply };
        this.asks.set(id, ask);
        this.emit('ask', this.publicAsk(ask));
        return ask;
    }

    /** The form every client sees. Built field by field: nothing secret can ride along. */
    publicAsk(ask) {
        const i = ask.info;
        return {
            id: ask.id,
            requestId: ask.id,
            kind: 'sudo',
            tool: 'sudo',
            displayName: 'sudo',
            sessionId: ask.sessionId,
            command: i.command,
            sudoLine: i.sudoLine,
            argv: i.argv,
            cwd: i.cwd,
            user: i.user,
            group: i.group,
            chdir: i.chdir,
            mode: i.mode,
            runsShell: i.runsShell,
            context: i.context,
            attempt: ask.attempt,
            askedAt: ask.askedAt,
            remoteAnswer: !!this.allowRemote(),
        };
    }

    get(id) { return this.asks.get(id) || null; }

    /** The open ask for a session, public form, or null. */
    forSession(sessionId) {
        for (const a of this.asks.values()) if (a.sessionId === sessionId) return this.publicAsk(a);
        return null;
    }

    list() { return [...this.asks.values()].map(a => this.publicAsk(a)); }

    _settle(id, outcome, result, reason) {
        const ask = this.asks.get(id);
        if (!ask) return false;
        this.asks.delete(id);
        try { ask.reply(result); } catch { /* the helper hung up; nothing to tell it */ }
        this.emit('resolved', { id, requestId: id, sessionId: ask.sessionId, outcome,
            ...(reason ? { reason } : {}) });
        return true;
    }

    /** Hand the password to the helper. The string is not kept. */
    approve(id, password) {
        return this._settle(id, 'approved', { password });
    }

    deny(id, reason = 'denied') {
        return this._settle(id, 'denied', { denied: true, reason }, reason);
    }

    cancel(id, reason) {
        return this._settle(id, 'cancelled', { denied: true, reason }, reason);
    }

    cancelSession(sessionId, reason) {
        for (const a of [...this.asks.values()]) if (a.sessionId === sessionId) this.cancel(a.id, reason);
    }

    cancelAll(reason) {
        for (const id of [...this.asks.keys()]) this.cancel(id, reason);
    }

    /** Drop asks whose sudo or helper has gone, and the retry count of a sudo that has. */
    sweep() {
        const alive = (pid) => fs.existsSync(path.join(this.procRoot, String(pid)));
        for (const a of [...this.asks.values()]) {
            if (!alive(a.info.sudoPid) || !alive(a.info.helperPid)) this.cancel(a.id, 'sudo exited');
        }
        for (const [k, t] of this.tries) if (!alive(t.sudoPid)) this.tries.delete(k);
    }

    /**
     * The bridge is going. The asks are dropped without an answer: their sockets
     * close with the process, and a helper whose connection drops before it was
     * answered asks the next bridge on the same port (bridge/sudo-askpass.js).
     */
    close() {
        if (this.timer) clearInterval(this.timer);
        this.asks.clear();
    }
}

module.exports = {
    HELPER, ENV, KEY_HEADER, SudoAsks, sessionKey, keySession, applyEnv, readAsk,
    parseSudoArgv, runsShell, shellQuote, bashContext,
};
