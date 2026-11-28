'use strict';

// Starting a `codex app-server` and getting it to the point where it will take a
// thread: spawn, wrap its stdio in a Connection, do the handshake.
//
// This is Phase 0 of docs/plans/23-codex.md, so nothing in the bridge calls it
// yet. A conversation's process will not be spawned here: the runner spawns it
// from the adapter's `bin` and `argv`, through the session host. This is for an
// app-server outside any conversation (the recorder, the replay test, and the
// account and model queries Phases 4 and 5 need), and the `-c` / `--listen`
// argv it builds is what the adapter's `argv()` should return.
//
//   - **CODEX_BIN** is `TGXCODE_CODEX_BIN` or `codex`, read once at load the way
//     CLAUDE_BIN is in bridge/config.js. A test sets it before the require and
//     gets the replay stub in test/fixtures/codex/stub.js.
//   - **The handshake is two messages**, `initialize` and then the `initialized`
//     notification. Measured on 0.172.0, as on 0.160.1: anything sent before
//     `initialize` is refused "Not initialized", and a second `initialize` is
//     -32600 "Already initialized".
//   - **`experimentalApi: true` is always sent.** Without it Codex rejects every
//     method and field marked experimental, which includes the blocking
//     `requestUserInput`, `collaborationMode/list` and `thread/fork.beforeTurnId`
//     — three of the things the plan builds on.
//   - **stderr is kept, not shown.** The last few KiB are on `stderrTail()`, for a
//     classifyError that wants context. Codex logs through `RUST_LOG`, and its
//     stderr is quiet by default.

const { spawn } = require('child_process');
const path = require('path');

const { Connection } = require('./rpc');
const { KNOWN_NOTIFICATIONS, OPT_OUT } = require('./protocol');

const CODEX_BIN = process.env.TGXCODE_CODEX_BIN || 'codex';
const STDERR_KEEP = 8 * 1024;

let bridgeVersion = '0.0.0';
try { bridgeVersion = require(path.join(__dirname, '..', '..', 'package.json')).version; } catch { /* packaged */ }

/**
 * Spawn `codex app-server` over stdio.
 *
 * @param {object} [o]
 * @param {string} [o.cwd]   the process's cwd; a thread's cwd is set separately on thread/start
 * @param {object} [o.env]   full environment for the child (defaults to process.env)
 * @param {string[]} [o.config]  `-c key=value` overrides, already formatted
 * @param {string} [o.bin]
 * @param {(line: string) => void} [o.log]
 * @param {number} [o.timeoutMs]  default request timeout
 * @returns {{ child, rpc: Connection, stderrTail: () => string }}
 */
function spawnAppServer({ cwd, env, config = [], bin = CODEX_BIN, log, timeoutMs = 0 } = {}) {
    const args = ['app-server'];
    for (const c of config) args.push('-c', c);
    args.push('--listen', 'stdio://');
    const child = spawn(bin, args, {
        cwd, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rpc = new Connection({
        input: child.stdout, output: child.stdin, known: KNOWN_NOTIFICATIONS, log, timeoutMs,
    });
    let tail = '';
    child.stderr.on('data', (b) => {
        tail = (tail + b.toString('utf8')).slice(-STDERR_KEEP);
    });
    child.on('error', (e) => rpc.close('spawn failed: ' + e.message));
    child.on('exit', (code, signal) => rpc.close(`exited ${signal || code}`));
    return { child, rpc, stderrTail: () => tail };
}

/**
 * The handshake. Resolves with the InitializeResponse
 * ({userAgent, codexHome, platformFamily, platformOs}).
 */
async function initialize(rpc, {
    name = 'tgxcode', title = 'TGXCode', version = bridgeVersion, optOut = OPT_OUT,
} = {}) {
    const result = await rpc.request('initialize', {
        clientInfo: { name, title, version },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [...optOut] },
    });
    rpc.notify('initialized');
    return result;
}

/**
 * One short-lived app-server outside any conversation: spawn, handshake, run
 * `fn(rpc)`, and let it go. The process is killed after the timeout whatever
 * `fn` is doing, so a Codex that stops answering cannot be left behind.
 */
async function withAppServer(fn, { timeoutMs = 20_000, cwd } = {}) {
    const { child, rpc } = spawnAppServer({ timeoutMs, cwd });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs + 2000);
    killer.unref();
    try {
        await initialize(rpc);
        return await fn(rpc);
    } finally {
        clearTimeout(killer);
        try { child.stdin.end(); } catch { /* closed */ }
        setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, 500).unref();
    }
}

module.exports = { CODEX_BIN, spawnAppServer, initialize, withAppServer };
