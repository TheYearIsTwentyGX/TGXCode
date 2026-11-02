'use strict';

// Secrets an agent can use without being shown them.
//
// An agent that needs an API key used to get it the only way it could: somebody
// pasted it into the conversation, and from then on it lived in the transcript,
// in every tool call that echoed it, and in whatever the agent printed while
// debugging. This module is the other way round. An agent asks for a secret *by
// name* (the `request_secret` tool, bridge/mcp.js); you type the value into a
// card; the agent writes `$TEST_KEY` in a Bash command; and the value is put
// into that command's environment by a wrapper the agent never sees the inside
// of. The pieces:
//
//   - **The store** (here). One JSON file per project, under
//     `~/.local/share/tgxcode/secrets/`, mode 0600 in a 0700 directory. Keyed by
//     the *main* repository's root, so every worktree of a repo shares one set.
//     Outside the repo on purpose: a file inside it, however well excluded, is
//     one `git add -f`, one `git clean -fdx`, one zip of the checkout or one
//     Read call away from being somewhere it should not be. Read and Edit of the
//     directory are denied to the agent by the settings below, which catches the
//     accident and nothing more.
//   - **The ask** (SecretAsks, here; routes in bridge/routes/secrets.js). Shaped
//     like a sudo ask (bridge/sudo.js): held open with no timeout of its own,
//     answered from a card, and every payload that leaves is built field by
//     field by `publicAsk`, which has no field a value could ride in.
//   - **The hook** (bridge/secret-hook.js). A PreToolUse hook on Bash that
//     rewrites a command mentioning `$NAME`, for a NAME this project has, into
//     `'<node>' '<bridge>/secret-exec.js' NAME -- '<the command>'`. Measured on
//     CLI 2.1.312, not assumed: `updatedInput` with no `permissionDecision` is
//     applied *and* still goes through the permission flow, evaluated against
//     the rewritten command — so the hook rewrites and never approves. The
//     transcript keeps the model's own `tool_use` (the original, `$NAME` and
//     all) and the hook's stdout (the rewritten one). Neither has a value in it,
//     which is the property everything here is arranged around.
//   - **The wrapper** (bridge/secret-exec.js). Fetches the values over loopback
//     with the token, runs the command in `bash -c` with them in its
//     environment, and redacts every value — and its URL, base64 and hex forms —
//     out of what comes back.
//
// **What this does not do.** It keeps a secret out of the transcript *by
// accident*. An agent runs as you, can read the bridge token, can call the
// routes, and can print a value in a form the redaction does not know
// (`rev`, a single byte at a time). Nothing here pretends otherwise, and
// docs/manual.md §Secrets says so where a person will read it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');

const cfg = require('./config');

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
// Names that would change how the command itself runs, or that the session and
// this app already use. A secret called PATH would not be a secret; it would be
// a broken shell.
const RESERVED = new Set(['PATH', 'HOME', 'SHELL', 'IFS', 'PWD', 'OLDPWD', 'USER', 'LOGNAME',
    'TERM', 'LANG', 'TMPDIR', 'NODE_OPTIONS', 'NODE_PATH', 'ENV', 'BASH_ENV', 'CDPATH', 'PS4']);
const RESERVED_PREFIX = ['LD_', 'BASH_', 'CLAUDE_', 'TGXCODE_', 'CLAUDE_SESSIONS_', 'SUDO_', 'LC_'];
const MAX_VALUE = 16 * 1024;
const MAX_WHY = 500;

/** Why `name` cannot be a secret's name, or null if it can. */
function nameProblem(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
        return 'a secret name is upper-case letters, digits and _, starting with a letter '
            + '(at most 64), e.g. TEST_KEY';
    }
    if (RESERVED.has(name) || RESERVED_PREFIX.some(p => name.startsWith(p))) {
        return `${name} is reserved: it would change how the command itself runs`;
    }
    return null;
}

/** Why `value` cannot be stored, or null. Never echoes the value. */
function valueProblem(value) {
    if (typeof value !== 'string' || !value.length) return 'the value must be a non-empty string';
    if (Buffer.byteLength(value) > MAX_VALUE) return 'the value is larger than 16 KB';
    if (value.includes('\0')) return 'the value cannot contain a NUL byte';
    return null;
}

// ── where ─────────────────────────────────────────────────────────────────

function storeDir() {
    return process.env.TGXCODE_SECRETS_DIR || path.join(cfg.STATE_DIR, 'secrets');
}

const roots = new Map();
const ROOT_TTL = 30_000;

/**
 * The directory a project's secrets are keyed by: the main repository's top
 * level for anything inside a git checkout or one of its worktrees, the
 * directory itself otherwise. The same rule as `mainTop()` in bridge/worktree.js,
 * synchronous because the hook has a few milliseconds and no event loop to
 * spare.
 */
function projectRoot(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path');
    const hit = roots.get(cwd);
    if (hit && Date.now() - hit.at < ROOT_TTL) return hit.root;
    let root;
    try {
        const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel', '--git-common-dir'],
            { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
        const top = out[0];
        const common = path.resolve(cwd, out[1] || '');
        root = path.basename(common) === '.git' ? path.dirname(common) : top;
    } catch {
        root = cwd;
    }
    try { root = fs.realpathSync(root); } catch { /* a directory that has gone keeps its name */ }
    roots.set(cwd, { root, at: Date.now() });
    return root;
}

function fileFor(root) {
    const slug = path.basename(root).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'root';
    const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
    return path.join(storeDir(), `${slug}-${hash}.json`);
}

// ── the store ─────────────────────────────────────────────────────────────

function ensureDir() {
    const dir = storeDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the umask, and an existing directory keeps
    // whatever it had. Either way, it ends up 0700.
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
    if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
    return dir;
}

function blank(root) { return { version: 1, root, secrets: {} }; }

/** The whole document for a project. A file that is missing or unreadable is empty. */
function readDoc(root) {
    const file = fileFor(root);
    let st;
    try { st = fs.lstatSync(file); } catch { return blank(root); }
    // A link could point anywhere, and following it would write a value there.
    if (!st.isFile()) throw new Error('the secrets file is not a regular file');
    if (st.mode & 0o077) { try { fs.chmodSync(file, 0o600); } catch { /* read it anyway */ } }
    try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!doc || typeof doc.secrets !== 'object' || Array.isArray(doc.secrets)) return blank(root);
        return { version: 1, root, secrets: doc.secrets };
    } catch {
        return blank(root);
    }
}

/**
 * Written the way bridge/jsonfile.js writes, with one difference: the temporary
 * file is *created* 0600, rather than written and then chmodded, so there is no
 * moment at which a value sits in a file the umask made readable.
 */
function writeDoc(root, doc) {
    ensureDir();
    const file = fileFor(root);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
        fs.writeSync(fd, `${JSON.stringify({ version: 1, root, secrets: doc.secrets }, null, 2)}\n`);
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try {
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* never made */ }
        throw err;
    }
}

/** Names and dates, never values. */
function list(root) {
    const { secrets } = readDoc(root);
    return Object.keys(secrets).sort().map(name => ({
        name, createdAt: secrets[name].createdAt || null, updatedAt: secrets[name].updatedAt || null,
    }));
}

function has(root, name) {
    return Object.prototype.hasOwnProperty.call(readDoc(root).secrets, name);
}

function get(root, name) {
    const s = readDoc(root).secrets[name];
    return s && typeof s.value === 'string' ? s.value : null;
}

function set(root, name, value) {
    const p = nameProblem(name) || valueProblem(value);
    if (p) throw Object.assign(new Error(p), { status: 400 });
    const doc = readDoc(root);
    const now = Date.now();
    const old = doc.secrets[name];
    doc.secrets[name] = { value, createdAt: (old && old.createdAt) || now, updatedAt: now };
    writeDoc(root, doc);
    return { name, createdAt: doc.secrets[name].createdAt, updatedAt: now };
}

function remove(root, name) {
    const doc = readDoc(root);
    if (!Object.prototype.hasOwnProperty.call(doc.secrets, name)) return false;
    delete doc.secrets[name];
    writeDoc(root, doc);
    return true;
}

/** `{values}` for every name, or `{missing}` naming those that are not set. */
function resolve(root, names) {
    const { secrets } = readDoc(root);
    const values = {};
    const missing = [];
    for (const n of names) {
        if (secrets[n] && typeof secrets[n].value === 'string') values[n] = secrets[n].value;
        else missing.push(n);
    }
    return missing.length ? { missing } : { values };
}

// ── the command, rewritten ────────────────────────────────────────────────

const EXEC = path.join(__dirname, 'secret-exec.js');
const HOOK = path.join(__dirname, 'secret-hook');

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Every variable name a command mentions, the way bash would read it: `$NAME`,
 * `${NAME}`, `${NAME:-x}`, `${#NAME}`. Over-reads on purpose — a mention inside
 * single quotes or a comment counts — because wrapping a command that did not
 * need it costs a child shell, and not wrapping one that did runs it with an
 * empty `$KEY`. That is also how an agent passes a secret to a script: mention it
 * anywhere in the command.
 */
function referencedNames(command) {
    const out = new Set();
    const re = /\$\{?[#!]?([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = re.exec(String(command)))) out.add(m[1]);
    return out;
}

function wrapCommand(command, names, { node = process.execPath, exec = EXEC } = {}) {
    return `${shQuote(node)} ${shQuote(exec)} ${names.join(' ')} -- ${shQuote(command)}`;
}

const WRAPPED = /^'([^']*)' '([^']*\/secret-exec\.js)'((?: [A-Z][A-Z0-9_]*)+) -- '((?:[^']|'\\'')*)'$/;

/**
 * The command a wrapped one runs, and the names it is given — or null when this
 * is not *exactly* a wrapped command. Anchored at both ends, so a wrapper
 * followed by `; anything` is not one: what a card shows as the command has to
 * be everything that runs.
 *
 * **And only this bridge's own wrapper, run by this node.** The paths are part
 * of the command, so an agent could write `'/bin/sh' '/tmp/x/secret-exec.js' K
 * -- 'ls'` itself; matching on the shape alone would draw `ls` on the card and
 * run something else. A command wrapped by a bridge in another checkout is
 * therefore not unwrapped either — it is shown as it is, which is the safe way
 * to be wrong.
 */
function unwrapCommand(command, { node = process.execPath, exec = EXEC } = {}) {
    const m = typeof command === 'string' && command.match(WRAPPED);
    if (!m || m[1] !== node || m[2] !== exec) return null;
    return { names: m[3].trim().split(' '), command: m[4].replace(/'\\''/g, "'"), node: m[1], exec: m[2] };
}

/**
 * The `--settings` a session is started with: the hook, and deny rules that keep
 * the agent's own Read and Edit tools out of the store. `//` is how a permission
 * rule spells an absolute path.
 */
function sessionSettings({ node = process.execPath } = {}) {
    const dir = storeDir();
    return {
        hooks: {
            PreToolUse: [{
                matcher: 'Bash',
                hooks: [{ type: 'command', command: `${shQuote(HOOK)} ${shQuote(node)}` }],
            }],
        },
        permissions: { deny: [`Read(/${dir}/**)`, `Edit(/${dir}/**)`] },
    };
}

// ── the asks ──────────────────────────────────────────────────────────────

/**
 * Secrets asked for and not yet answered, keyed by id. Emits `ask` (public form)
 * and `resolved` `{id, requestId, sessionId, name, outcome, reason?}`, `outcome`
 * being `saved`, `denied` or `cancelled`. The value goes from the answer straight
 * to the store; the waiting tool is told only that it was saved.
 */
class SecretAsks extends EventEmitter {
    /** @param {{now?: () => number, allowRemote?: () => boolean}} [opts] */
    constructor({ now = Date.now, allowRemote = () => false } = {}) {
        super();
        this.now = now;
        this.allowRemote = allowRemote;
        this.asks = new Map();
    }

    /** @param {{sessionId: string, name: string, why: string, cwd: string, root: string}} info */
    open(info, reply) {
        const id = crypto.randomBytes(9).toString('base64url');
        const ask = { id, ...info, why: String(info.why || '').slice(0, MAX_WHY), askedAt: this.now(), reply };
        this.asks.set(id, ask);
        this.emit('ask', this.publicAsk(ask));
        return ask;
    }

    /** What every client sees. Built field by field: there is no value to carry. */
    publicAsk(ask) {
        return {
            id: ask.id,
            requestId: ask.id,
            kind: 'secret',
            tool: 'secret',
            displayName: 'Secret',
            sessionId: ask.sessionId,
            name: ask.name,
            why: ask.why,
            cwd: ask.cwd,
            project: ask.root,
            exists: has(ask.root, ask.name),
            askedAt: ask.askedAt,
            remoteAnswer: !!this.allowRemote(),
        };
    }

    get(id) { return this.asks.get(id) || null; }

    forSession(sessionId) {
        for (const a of this.asks.values()) if (a.sessionId === sessionId) return this.publicAsk(a);
        return null;
    }

    list() { return [...this.asks.values()].map(a => this.publicAsk(a)); }

    _settle(id, outcome, result, reason) {
        const ask = this.asks.get(id);
        if (!ask) return false;
        this.asks.delete(id);
        try { ask.reply(result); } catch { /* the tool hung up */ }
        this.emit('resolved', { id, requestId: id, sessionId: ask.sessionId, name: ask.name, outcome,
            ...(reason ? { reason } : {}) });
        return true;
    }

    /** Store the value and tell the tool it is there. Throws, settling nothing, if it cannot be stored. */
    save(id, value) {
        const ask = this.asks.get(id);
        if (!ask) return false;
        set(ask.root, ask.name, value);
        return this._settle(id, 'saved', { saved: true, name: ask.name });
    }

    deny(id, reason = 'denied') { return this._settle(id, 'denied', { denied: true, reason }, reason); }

    cancel(id, reason) { return this._settle(id, 'cancelled', { denied: true, reason }, reason); }

    cancelSession(sessionId, reason) {
        for (const a of [...this.asks.values()]) if (a.sessionId === sessionId) this.cancel(a.id, reason);
    }

    /** The bridge is going. The tool's connection closes with it, and it asks the next bridge. */
    close() { this.asks.clear(); }
}

module.exports = {
    NAME_RE, MAX_VALUE, MAX_WHY, EXEC, HOOK,
    nameProblem, valueProblem, storeDir, projectRoot, fileFor,
    list, has, get, set, remove, resolve,
    shQuote, referencedNames, wrapCommand, unwrapCommand, sessionSettings,
    SecretAsks,
};
