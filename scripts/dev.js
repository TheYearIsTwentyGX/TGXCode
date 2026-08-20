'use strict';

// `npm run dev` — a development instance that cannot disturb the everyday one.
//
// The everyday app owns port 45888 and usually has live sessions in it. Anyone
// working *on* this codebase needs to restart the bridge constantly, so doing
// that on 45888 means killing someone's running work. This starts the bridge
// from the current checkout on 45899 instead, and points a window at it.
//
// Both instances read the same transcripts — they are just two views of
// ~/.claude/projects — so a session started in one shows up in the other. What
// is separate is the process: restarting this one leaves the other alone.

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { toWindowsPath, winEnvAsWslPath } = require('./win');

const { DEFAULT_PORT, DEV_PORT } = require('../bridge/config');
const ports = require('../bridge/ports');

const repo = path.join(__dirname, '..');
const wantsWindow = !process.argv.includes('--no-window');

// What this checkout's dev bridge is remembered as. One key per worktree, so
// each agent's instance comes back to its own port — the DevBrowser tab named
// for a worktree then keeps pointing at that worktree's bridge instead of at
// whichever one restarted last.
const memoryKey = `dev:${repo}`;

/**
 * A port for this checkout's bridge: the one it had last time if it is still
 * free, otherwise the first free port at or above `from` that no other checkout
 * has a claim on.
 *
 * `sticky` is off when a port was actually asked for. `npm run dev --
 * --port=45905` names a port, and honouring a remembered one over it would make
 * the flag mean nothing.
 *
 * `denylist: null` because this is picking a port for a *bridge*, not for a
 * project's dev server: the config denylist contains the bridge port, and
 * `CLAUDE_SESSIONS_PORT=45899 npm run dev` is a request for that exact one.
 */
function pickPort(from, sticky) {
    const remembered = sticky ? ports.rememberedPort(memoryKey) : null;
    const avoid = new Set();
    for (const [key, port] of ports.claims()) {
        if (key !== memoryKey) avoid.add(port);
    }
    return ports.allocate({
        lo: from,
        hi: from + 19,
        skip: [DEFAULT_PORT],
        denylist: null,
        prefer: remembered == null ? [] : [remembered],
        avoid,
    }, 'npm run dev');
}

function findExe() {
    const local = winEnvAsWslPath('LOCALAPPDATA');
    if (!local) return null;
    return [
        path.join(local, 'Programs', 'ClaudeSessions', 'ClaudeSessions.exe'),
        path.join(local, 'ClaudeSessions-build', 'dist', 'win-unpacked', 'ClaudeSessions.exe'),
    ].find(p => fs.existsSync(p)) || null;
}

/**
 * A port asked for on the command line, ahead of the environment.
 *
 * The flag exists because the environment is not a channel that reaches here
 * from everywhere: a run started from the app's own buttons has
 * CLAUDE_SESSIONS_PORT deleted before the process starts — deliberately, see
 * bridge/terminal.js — so `.tgxcode/commands.json` has no way to hand a port
 * over except this. It is worth having by itself, too: `npm run dev --
 * --port=45905` says what it means where `CLAUDE_SESSIONS_PORT=45905 npm run
 * dev` reads like it is aiming at the everyday instance.
 */
function askedPort() {
    const arg = process.argv.find(a => a.startsWith('--port='));
    const n = arg ? Number(arg.slice('--port='.length)) : NaN;
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0;
}

(async () => {
    // Named, as against defaulted: a port somebody typed outranks a remembered
    // one, even when it happens to be the development default.
    const named = askedPort() || Number(process.env.CLAUDE_SESSIONS_PORT) || 0;
    const requested = named || DEV_PORT;
    if (requested === DEFAULT_PORT) {
        console.error(`Refusing to run development on ${DEFAULT_PORT} — that is the `
            + 'everyday instance. Leave CLAUDE_SESSIONS_PORT unset and --port off.');
        process.exit(1);
    }

    const port = await pickPort(requested, !named);
    if (!port) {
        console.error(`No free port near ${requested}.`);
        process.exit(1);
    }

    const bridge = spawn(process.execPath, [path.join(repo, 'bridge', 'server.js')], {
        cwd: repo,
        stdio: 'inherit',
        env: { ...process.env, CLAUDE_SESSIONS_PORT: String(port) },
    });

    // Remembered only once it has stayed up — a bridge that lost a race for the
    // port exits at once, and `close` takes this process with it before the
    // timer fires, so nothing wrong gets written down.
    setTimeout(() => ports.remember(memoryKey, port), 3000).unref();

    const origin = `http://127.0.0.1:${port}`;
    console.log('');
    console.log(`  Development instance on ${origin}`);
    console.log(`  Your everyday app on ${DEFAULT_PORT} is untouched.`);
    console.log('  Edit web/ and refresh; edit bridge/ and restart this.');
    console.log('');

    // Ctrl-C should take the bridge with it, but nothing else.
    const stop = () => { try { bridge.kill('SIGTERM'); } catch { /* gone */ } };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    bridge.on('close', (code) => process.exit(code ?? 0));

    if (!wantsWindow) return;

    const exe = findExe();
    if (!exe) {
        console.log('  No built app found, so no window. The UI works in a browser at');
        console.log(`  ${origin} — or run \`npm run build\` for the desktop shell.`);
        console.log('');
        return;
    }

    // Give the bridge a moment so the window does not open on a splash.
    setTimeout(() => {
        const winPath = toWindowsPath(exe);
        if (!winPath) return;
        // The port travels in the environment; the shell prefers it over config.json.
        execFile('cmd.exe',
            ['/c', 'set', `CLAUDE_SESSIONS_PORT=${port}`, '&&', 'start', '', winPath],
            { cwd: '/mnt/c' }, () => {});
        console.log(`  Opening a window against ${origin}…`);
    }, 2500);
})();
