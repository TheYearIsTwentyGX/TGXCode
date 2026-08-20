'use strict';

// Client for DevBrowser's agent control channel.
//
// DevBrowser is an Electron app on the Windows host that shows each localhost dev
// server in its own tab. Its main process binds an HTTP control server to the
// Windows 127.0.0.1; because this machine runs WSL with networkingMode=mirrored,
// that address is reachable straight from Linux.
//
// Protocol requirements (from the app's own docs): every request must send
// `X-DevBrowser-Client: 1` and must not carry an `Origin` header — webviews run
// with webSecurity disabled, and those two guards stop a page in a tab scripting
// the app.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const { DEVBROWSER_DEFAULT_PORT } = require('./config');

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

/** Resolve %APPDATA% to a WSL path. Spawning cmd.exe costs ~200ms, so cache it. */
function appDataDir() {
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

async function dataDir() {
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

/** Start DevBrowser and wait for its control server to answer. */
async function launch({ waitMs = 20000 } = {}) {
    const exe = await exePath();
    if (!exe) return { ok: false, error: 'DevBrowser.exe not found' };

    const winPath = await new Promise((resolve) => {
        execFile('wslpath', ['-w', exe], { timeout: 5000 },
            (e, out) => resolve(e ? null : out.trim()));
    });
    if (!winPath) return { ok: false, error: 'could not translate path for Windows' };

    // `start` returns immediately and detaches the app from our process tree.
    execFile('cmd.exe', ['/c', 'start', '', winPath], { cwd: '/mnt/c' }, () => {});

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
 * the control port, because it lives on the Windows filesystem.
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
 */
async function openTab(port, pagePath) {
    let h = await health();
    let launched = false;

    if (!h.running) {
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

module.exports = { health, titles, ports, setTitle, openTab, launch, controlPort, exePath };
