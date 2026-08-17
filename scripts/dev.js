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

/**
 * First free port at or above `from`, so two agents can each have their own.
 *
 * `denylist: null` because this is picking a port for a *bridge*, not for a
 * project's dev server: the config denylist contains the bridge port, and
 * `CLAUDE_SESSIONS_PORT=45899 npm run dev` is a request for that exact one.
 */
function pickPort(from) {
    return ports.allocate(
        { lo: from, hi: from + 19, skip: [DEFAULT_PORT], denylist: null }, 'npm run dev');
}

function findExe() {
    const local = winEnvAsWslPath('LOCALAPPDATA');
    if (!local) return null;
    return [
        path.join(local, 'Programs', 'ClaudeSessions', 'ClaudeSessions.exe'),
        path.join(local, 'ClaudeSessions-build', 'dist', 'win-unpacked', 'ClaudeSessions.exe'),
    ].find(p => fs.existsSync(p)) || null;
}

(async () => {
    const requested = Number(process.env.CLAUDE_SESSIONS_PORT) || DEV_PORT;
    if (requested === DEFAULT_PORT) {
        console.error(`Refusing to run development on ${DEFAULT_PORT} — that is the `
            + 'everyday instance. Leave CLAUDE_SESSIONS_PORT unset.');
        process.exit(1);
    }

    const port = await pickPort(requested);
    if (!port) {
        console.error(`No free port near ${requested}.`);
        process.exit(1);
    }

    const bridge = spawn(process.execPath, [path.join(repo, 'bridge', 'server.js')], {
        cwd: repo,
        stdio: 'inherit',
        env: { ...process.env, CLAUDE_SESSIONS_PORT: String(port) },
    });

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
