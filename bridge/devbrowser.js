'use strict';

// Client for DevBrowser's agent control channel.
//
// DevBrowser is an Electron app that shows each localhost dev server in its own
// tab. Its main process binds an HTTP control server to 127.0.0.1, and *that
// part is the same wherever it runs* — under WSL the app is on the Windows host
// and mirrored networking makes Windows' loopback reachable from Linux; on a
// Linux host it is simply the same machine. So everything under "HTTP" below is
// host-independent and always has been.
//
// What is not host-independent is finding the app and starting it, and that is
// the whole of what bridge/platform.js decides here:
//
//   - **Under WSL**: %APPDATA% via cmd.exe, and DevBrowser.exe under
//     %LOCALAPPDATA%\Programs, launched through `cmd.exe /c start`.
//   - **On a Linux host**: $XDG_CONFIG_HOME/dev-browser-desktop, and a binary
//     off PATH.
//
// Until DevBrowser itself has a Linux build, the Linux branch finds nothing and
// every caller reports not-running — which is the same answer the Windows branch
// gives when the app is not installed, and the same one it gave on Linux before
// this branch existed. The difference is that it now says so without spawning a
// cmd.exe that cannot exist.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { DEVBROWSER_DEFAULT_PORT } = require('./config');
const { isWsl } = require('./platform');

const CLIENT_HEADER = { 'X-DevBrowser-Client': '1' };
const APP_DIR_NAME = 'dev-browser-desktop';
const TIMEOUT_MS = 2500;

let appDataCache = null;      // WSL path to %APPDATA%
let portCache = null;         // {port, at}
let titlesCache = null;       // {titles, at} — only the file fallback below
const PORT_CACHE_MS = 5000;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Resolve %APPDATA% to a WSL path. Spawning cmd.exe costs ~200ms, so cache it.
 *
 * Null on a Linux host rather than an attempted spawn: there is no %APPDATA% to
 * resolve, and the callers that want a directory ask dataDir() instead.
 */
function appDataDir() {
    if (!isWsl()) return Promise.resolve(null);
    if (appDataCache && fs.existsSync(appDataCache)) return Promise.resolve(appDataCache);
    return new Promise((resolve) => {
        // cmd.exe warns and bails if cwd is a UNC path, so run it from a
        // Windows-backed directory.
        execFile('cmd.exe', ['/c', 'echo %APPDATA%'], { cwd: '/mnt/c', timeout: 5000 },
            (err, stdout) => {
                if (err || !stdout) return resolve(null);
                const win = stdout.trim();
                execFile('wslpath', ['-u', win], { timeout: 5000 }, (e2, out2) => {
                    if (e2 || !out2) return resolve(null);
                    const p = out2.trim();
                    appDataCache = fs.existsSync(p) ? p : null;
                    resolve(appDataCache);
                });
            });
    });
}

/**
 * Where DevBrowser keeps control-server.json.
 *
 * Electron's app.getPath('userData') resolves to %APPDATA%\<name> on Windows and
 * to $XDG_CONFIG_HOME/<name> on Linux, so both arms below are the same directory
 * as far as the app is concerned — this is just the two ways of naming it from
 * outside. `<name>` is the package name, not productName, which is why it is
 * `dev-browser-desktop` and not `DevBrowser`.
 */
async function dataDir() {
    if (!isWsl()) {
        const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
        return path.join(base, APP_DIR_NAME);
    }
    const base = await appDataDir();
    return base ? path.join(base, APP_DIR_NAME) : null;
}

/**
 * The control port. DevBrowser advertises the real one in control-server.json
 * when the default is taken; a stale file left by a crash is harmless because
 * callers probe the port anyway.
 */
async function controlPort() {
    if (portCache && Date.now() - portCache.at < PORT_CACHE_MS) return portCache.port;
    let port = DEVBROWSER_DEFAULT_PORT;
    const dir = await dataDir();
    if (dir) {
        try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, 'control-server.json'), 'utf8'));
            if (Number.isInteger(j.port) && j.port > 0 && j.port < 65536) port = j.port;
        } catch { /* no advertisement; the default is the best guess */ }
    }
    portCache = { port, at: Date.now() };
    return port;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function request(method, pathname, body) {
    return controlPort().then((port) => new Promise((resolve) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const headers = { ...CLIENT_HEADER };
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = String(payload.length);
        }
        const req = http.request(
            { host: '127.0.0.1', port, path: pathname, method, headers, timeout: TIMEOUT_MS },
            (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode, json, text });
                });
            });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
        req.on('error', (e) => resolve({ ok: false, status: 0, error: e.code || e.message }));
        if (payload) req.write(payload);
        req.end();
    }));
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/** Locate DevBrowser.exe under %LOCALAPPDATA%\Programs. */
async function exePath() {
    const appData = await appDataDir();
    if (!appData) return null;
    // %APPDATA% is …/AppData/Roaming; the installer targets …/AppData/Local.
    const local = path.join(path.dirname(appData), 'Local');
    const candidates = [
        path.join(local, 'Programs', 'DevBrowser', 'DevBrowser.exe'),
        path.join(local, 'Programs', 'dev-browser-desktop', 'DevBrowser.exe'),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
}

/**
 * Locate a Linux DevBrowser binary.
 *
 * **`devbrowser` in lower case is deliberately not a candidate.** That name is
 * already taken on this machine by the shell CLI in ~/.local/bin — the thing a
 * person types to title a tab — and spawning it here would start no app at all,
 * wait twenty seconds for a control server that never appears, and report a
 * timeout rather than "not installed". The app's electron-builder productName is
 * `DevBrowser` and its package name is `dev-browser-desktop`; those are the two
 * names a build can plausibly install, and neither collides with the CLI.
 */
function linuxBinary() {
    const home = os.homedir();
    const names = ['DevBrowser', 'dev-browser-desktop'];

    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        for (const name of names) {
            const p = path.join(dir, name);
            try {
                fs.accessSync(p, fs.constants.X_OK);
                return p;
            } catch { /* not here, or not executable */ }
        }
    }

    // An AppImage is the likeliest shape for a personally-built Electron app and
    // is usually not on PATH, so look where one normally lands.
    for (const dir of [path.join(home, '.local', 'bin'), path.join(home, 'Applications')]) {
        for (const name of names) {
            const p = path.join(dir, `${name}.AppImage`);
            try {
                fs.accessSync(p, fs.constants.X_OK);
                return p;
            } catch { /* not here */ }
        }
    }
    return null;
}

/** Start DevBrowser and wait for its control server to answer. */
async function launch({ waitMs = 20000 } = {}) {
    if (!isWsl()) {
        const bin = linuxBinary();
        if (!bin) {
            return { ok: false, error: 'no DevBrowser binary found on PATH or in ~/.local/bin' };
        }
        // Detached with its stdio closed, so the app outlives this bridge the way
        // `cmd.exe /c start` leaves it outliving the relay on the Windows side.
        try {
            const child = require('child_process')
                .spawn(bin, [], { detached: true, stdio: 'ignore' });
            child.on('error', () => {});
            child.unref();
        } catch (err) {
            return { ok: false, error: `could not start ${bin}: ${err.message}` };
        }
        return waitForControlServer(waitMs);
    }

    const exe = await exePath();
    if (!exe) return { ok: false, error: 'DevBrowser.exe not found' };

    const winPath = await new Promise((resolve) => {
        execFile('wslpath', ['-w', exe], { timeout: 5000 },
            (e, out) => resolve(e ? null : out.trim()));
    });
    if (!winPath) return { ok: false, error: 'could not translate path for Windows' };

    // `start` returns immediately and detaches the app from our process tree.
    execFile('cmd.exe', ['/c', 'start', '', winPath], { cwd: '/mnt/c' }, () => {});

    return waitForControlServer(waitMs);
}

/** Poll until the app answers, however it was started. */
async function waitForControlServer(waitMs) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
        portCache = null; // the app may have picked a different port this run
        const h = await health();
        if (h.running) return { ok: true, launched: true, port: h.port };
    }
    return { ok: false, error: 'DevBrowser did not answer in time' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function health() {
    const res = await request('GET', '/health');
    if (!res.ok || !res.json) {
        return { running: false, port: await controlPort(), error: res.error || res.status };
    }
    return { running: true, port: res.json.port || await controlPort(), version: res.json.version };
}

/**
 * DevBrowser's saved names, read from its own store.
 *
 * The fallback for titles() when the control server is not answering — which is
 * also when the answer matters most: a port named by an agent hours ago, with
 * DevBrowser since closed, is exactly the claim runs.js must not walk over. Only
 * read, never written; the file belongs to the other app. Cached as briefly as
 * the control port — under WSL because it is a read across the Windows
 * filesystem, and on a Linux host simply because the other app owns it and may
 * rewrite it at any moment.
 */
async function savedTitles() {
    if (titlesCache && Date.now() - titlesCache.at < PORT_CACHE_MS) return titlesCache.titles;
    const titles = {};
    const dir = await dataDir();
    if (dir) {
        try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, 'titles.json'), 'utf8'));
            for (const [port, name] of Object.entries((j && j.titles) || {})) {
                if (typeof name === 'string' && name) titles[port] = name;
            }
        } catch { /* never written, or not readable from here */ }
    }
    titlesCache = { titles, at: Date.now() };
    return titles;
}

async function titles() {
    const res = await request('GET', '/titles');
    if (res.ok && res.json) return res.json.titles || {};
    return savedTitles();
}

async function ports() {
    const res = await request('GET', '/ports');
    if (!res.ok || !res.json) return { detected: [], open: [], selected: null, titles: {} };
    return {
        detected: res.json.detected || [],
        open: res.json.open || [],
        selected: res.json.selected ?? null,
        titles: res.json.titles || {},
    };
}

async function setTitle(port, title) {
    if (title === null) return request('DELETE', `/titles/${port}`);
    return request('PUT', `/titles/${port}`, { title });
}

/**
 * Focus (or create) the tab for `port`, starting DevBrowser first if it isn't
 * running. The app restores and raises its window when it handles this, which is
 * the whole point of the button in the conversation view.
 *
 * `launch: false` is the Settings choice "when DevBrowser is closed, don't open
 * it": nothing is spawned, and `{running: false}` tells the caller to fall back
 * (to the in-app preview, or to nothing) rather than read it as a failure.
 */
async function openTab(port, pagePath, { launch: mayLaunch = true } = {}) {
    let h = await health();
    let launched = false;

    if (!h.running) {
        if (!mayLaunch) return { ok: false, running: false, launched: false };
        const l = await launch();
        if (!l.ok) return { ok: false, error: l.error, launched: false };
        launched = true;
    }

    const body = { port: Number(port), select: true };
    if (pagePath) body.path = pagePath;
    let res = await request('POST', '/tabs/open', body);

    // A freshly launched window can miss the very first command while its
    // renderer boots; one retry covers that.
    if (!res.ok && launched) {
        await new Promise(r => setTimeout(r, 1200));
        res = await request('POST', '/tabs/open', body);
    }

    return { ok: res.ok, launched, status: res.status, error: res.error || (res.ok ? null : res.text) };
}

/**
 * Where the app is installed, or null. Host-neutral, which `exePath` was not —
 * nothing outside this module ever wanted the Windows-only answer.
 */
async function installedPath() {
    return isWsl() ? exePath() : linuxBinary();
}

module.exports = {
    health, titles, ports, setTitle, openTab, launch, controlPort, installedPath,
};
