'use strict';

// The Windows-side shell.
//
// Everything that matters — reading transcripts, running `claude`, talking to
// DevBrowser — happens in the bridge, a plain Node process inside WSL. This
// shell only makes sure the bridge is up and points a window at it. That split
// means the UI can be edited and reloaded from WSL with no rebuild here, and it
// keeps all filesystem work on the Linux side where the files actually live.
//
// WSL on this machine runs with networkingMode=mirrored, so the bridge binding
// 127.0.0.1 inside Linux is reachable from Windows at the same address.

const { app, BrowserWindow, shell, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.CLAUDE_SESSIONS_PORT || 45888);
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Where the bridge lives inside WSL. Override in config.json next to this file
// or with CLAUDE_SESSIONS_DIR, which is what you want when running from a
// worktree rather than the checkout.
const DEFAULTS = {
    distro: '',                              // empty = WSL's default distro
    bridgeDir: '~/Other/claude-sessions',
};

let mainWindow = null;
let bridgeStartedByUs = false;

// ── config ───────────────────────────────────────────────────────────────

function loadConfig() {
    const cfg = { ...DEFAULTS };
    for (const p of [path.join(__dirname, 'config.json'),
        path.join(app.getPath('userData'), 'config.json')]) {
        let raw;
        try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; } // optional file
        try {
            // Windows editors and PowerShell's -Encoding UTF8 leave a BOM, which
            // JSON.parse rejects. Silently dropping the config over one invisible
            // byte is a miserable way to fail, so strip it.
            Object.assign(cfg, JSON.parse(raw.replace(/^﻿/, '')));
        } catch (err) {
            console.error(`[claude-sessions] ignoring ${p}: ${err.message}`);
        }
    }
    if (process.env.CLAUDE_SESSIONS_DIR) cfg.bridgeDir = process.env.CLAUDE_SESSIONS_DIR;
    if (process.env.CLAUDE_SESSIONS_DISTRO) cfg.distro = process.env.CLAUDE_SESSIONS_DISTRO;
    return cfg;
}

// ── bridge ───────────────────────────────────────────────────────────────

function ping(timeout = 1200) {
    return new Promise((resolve) => {
        const req = http.get(`${ORIGIN}/api/health`, { timeout }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch { resolve(null); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

function startBridge(cfg) {
    const args = [];
    if (cfg.distro) args.push('-d', cfg.distro);
    // launch.sh finds a node first: a login shell does not read ~/.bashrc, which
    // is where nvm puts itself, so plain `node` is not on PATH here.
    args.push('bash', '-lc',
        `cd ${shellQuote(cfg.bridgeDir)} && exec bash bridge/launch.sh`);

    // Detached so a long agent turn survives closing this window.
    const child = spawn('wsl.exe', args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    let stderr = '';
    child.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-3000);
        process.stderr.write(`[bridge] ${d}`);
    });
    child.stdout.on('data', (d) => process.stdout.write(`[bridge] ${d}`));
    child.on('error', (err) => { stderr += `\n${err.message}`; });
    child.unref();

    bridgeStartedByUs = true;
    return () => stderr;
}

/** Quote a path for bash, keeping a leading ~ expandable. */
function shellQuote(p) {
    const s = String(p);
    const q = (t) => `'${t.replace(/'/g, `'\\''`)}'`;
    if (s === '~') return '"$HOME"';
    if (s.startsWith('~/')) return `"$HOME"/${q(s.slice(2))}`;
    return q(s);
}

/** Ensure a bridge is answering, starting one if needed. */
async function ensureBridge(cfg, onStatus) {
    let health = await ping();
    if (health) return { ok: true, health, started: false };

    onStatus('Starting the bridge inside WSL…');
    const readStderr = startBridge(cfg);

    // A cold index of a few hundred transcripts takes about a second; allow more.
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 600));
        health = await ping();
        if (health) return { ok: true, health, started: true };
    }
    return { ok: false, error: readStderr() || 'The bridge did not start in time.' };
}

async function stopBridgeIfIdle() {
    if (!bridgeStartedByUs) return;
    await new Promise((resolve) => {
        const req = http.request(`${ORIGIN}/api/shutdown`, {
            method: 'POST',
            headers: { 'X-Claude-Sessions-Client': '1', 'Content-Length': '0' },
            timeout: 1500,
        }, (res) => {
            // 409 means a turn is still running; leaving it up is the right call.
            res.resume();
            res.on('end', resolve);
        });
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.on('error', () => resolve());
        req.end();
    });
}

// ── window ───────────────────────────────────────────────────────────────

function splash(message, detail) {
    const body = `
        <style>
          html,body{height:100%;margin:0}
          body{background:#131314;color:#c4c7c5;display:flex;align-items:center;
               justify-content:center;font:400 14px/1.6 "Google Sans Text","Segoe UI",system-ui,sans-serif}
          .box{max-width:520px;padding:32px;text-align:center}
          h1{font:400 19px/1.3 inherit;color:#e3e3e3;margin:0 0 10px}
          pre{text-align:left;background:#1b1c1d;border-radius:12px;padding:14px 16px;
              font:400 12px/1.6 "Cascadia Code",Consolas,monospace;color:#9aa0a6;
              white-space:pre-wrap;margin:18px 0 0;max-height:280px;overflow:auto}
          .dot{display:inline-block;width:8px;height:8px;border-radius:50%;
               background:#a8c7fa;margin-right:9px;animation:b 1.6s ease-in-out infinite}
          @keyframes b{0%,100%{opacity:1}50%{opacity:.3}}
        </style>
        <div class="box">
          <h1><span class="dot"></span>${message}</h1>
          ${detail ? `<pre>${detail.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>` : ''}
        </div>`;
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(body);
}

function createWindow() {
    // Size against the actual work area rather than a fixed number: on a
    // high-DPI display a hard-coded 1440x920 leaves far too little CSS space and
    // the layout collapses to its narrow form.
    const { workAreaSize } = screen.getPrimaryDisplay();
    const width = Math.max(900, Math.min(1600, Math.round(workAreaSize.width * 0.86)));
    const height = Math.max(620, Math.min(1040, Math.round(workAreaSize.height * 0.88)));

    mainWindow = new BrowserWindow({
        width,
        height,
        minWidth: 720,
        minHeight: 520,
        backgroundColor: '#131314',
        title: 'Claude Sessions',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            spellcheck: true,
        },
    });

    Menu.setApplicationMenu(null);

    // Three panes and a transcript want room, and display scaling makes a fixed
    // size unpredictable. Start maximised; the computed size above is what the
    // window restores to.
    mainWindow.maximize();

    // Reload, devtools and zoom without a menu bar in the way. Zoom matters on a
    // scaled display, where the whole UI can otherwise feel oversized.
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        const wc = mainWindow.webContents;
        const mod = input.control || input.meta;
        const key = input.key.toLowerCase();

        if (input.key === 'F12') {
            wc.toggleDevTools();
        } else if (mod && key === 'r') {
            wc.reloadIgnoringCache();
        } else if (mod && (key === '=' || key === '+')) {
            wc.setZoomLevel(Math.min(4, wc.getZoomLevel() + 0.5));
        } else if (mod && key === '-') {
            wc.setZoomLevel(Math.max(-4, wc.getZoomLevel() - 0.5));
        } else if (mod && key === '0') {
            wc.setZoomLevel(0);
        } else {
            return;
        }
        event.preventDefault();
    });

    // Links to PRs and docs belong in the real browser, not in this window.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(ORIGIN)) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
    return mainWindow;
}

// ── boot ─────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    const cfg = loadConfig();
    const win = createWindow();

    const setStatus = (msg, detail) => {
        if (win && !win.isDestroyed()) win.loadURL(splash(msg, detail));
    };
    setStatus('Connecting to Claude Sessions…');

    const result = await ensureBridge(cfg, setStatus);
    if (!win || win.isDestroyed()) return;

    if (!result.ok) {
        setStatus('The bridge would not start.',
            `Tried: wsl.exe ${cfg.distro ? `-d ${cfg.distro} ` : ''}bash -lc `
            + `"cd ${cfg.bridgeDir} && exec node bridge/server.js"\n\n`
            + `${result.error}\n\n`
            + `Check that the path exists inside WSL and that node is on PATH there. `
            + `Set a different location in config.json next to this app, or in `
            + `${path.join(app.getPath('userData'), 'config.json')}:\n`
            + `  { "bridgeDir": "~/Other/claude-sessions", "distro": "Ubuntu" }`);
        return;
    }

    win.loadURL(ORIGIN);
});

app.on('window-all-closed', async () => {
    await stopBridgeIfIdle();
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().loadURL(ORIGIN);
});
