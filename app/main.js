'use strict';

// The desktop shell.
//
// Everything that matters — reading transcripts, running `claude`, talking to
// DevBrowser — happens in the bridge, a plain Node process. This shell only
// makes sure the bridge is up and points a window at it. That split means the UI
// can be edited and reloaded with no rebuild here, and it keeps all filesystem
// work on the Linux side where the files actually live.
//
// It runs on two hosts, and the difference is one function:
//
//   - **On Windows**, the bridge lives inside WSL and is started through
//     `wsl.exe bash -lc`. WSL runs with networkingMode=mirrored here, so the
//     bridge binding 127.0.0.1 inside Linux is reachable from Windows at the
//     same address — which is the whole reason this arrangement works.
//   - **On Linux**, the bridge is on this machine and the relay is just `bash`.
//
// See bridgeShell(). Everything else in this file — the health ping, the
// port-reclaim logic, the window, the single-instance lock — is the same on
// both and does not know which it is on.

const { app, BrowserWindow, shell, Menu, screen, ipcMain, clipboard, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFile } = require('child_process');

// ── the rename ───────────────────────────────────────────────────────────
//
// This app was called ClaudeSessions before it was TGXCode, and two things
// that carry the old name have to be carried across before anything else runs.
//
// **The variables.** Every TGXCODE_<X> used to be CLAUDE_SESSIONS_<X>, and a
// shortcut or a script may still set the old one. The shell is packaged on its
// own and cannot require bridge/legacy-env.js, so this is that module's loop
// again: the old name fills in for a new one that is not set.
for (const key of Object.keys(process.env)) {
    if (!key.startsWith('CLAUDE_SESSIONS_')) continue;
    const renamed = `TGXCODE_${key.slice('CLAUDE_SESSIONS_'.length)}`;
    if (process.env[renamed] === undefined) process.env[renamed] = process.env[key];
}

// **The profile.** Electron names its userData directory after the app, so the
// rename moves it from `<appData>/claude-sessions` to `<appData>/tgxcode` — and
// that directory is the window's localStorage (the rail's sort and folds,
// half-written drafts), its config.json, and the single-instance lock. Copied
// rather than moved, because the old install may be open while the new one
// starts for the first time. Before `ready` and before the lock, which is when
// Chromium opens it.
(function carryProfileAcross() {
    try {
        const now = app.getPath('userData');
        // Electron names it after package.json's top-level `name` unless a
        // top-level productName is set, and ours lives under `build` — so the old
        // directory is `claude-sessions`. `ClaudeSessions` too, in case a build
        // ever wrote one; on Windows the two are the same folder anyway.
        const before = ['claude-sessions', 'ClaudeSessions']
            .map(name => path.join(app.getPath('appData'), name))
            .find(p => fs.existsSync(p));
        if (fs.existsSync(now) || !before) return;
        fs.cpSync(before, now, {
            recursive: true,
            // Chromium's lock files belong to the process that holds them.
            filter: (src) => !/[\\/](Singleton\w*|lockfile)$/.test(src),
        });
    } catch (err) {
        console.error(`[tgxcode] could not copy the old profile: ${err.message}`);
    }
})();

// 45888 is the everyday instance. `npm run dev` starts a separate one on
// another port and passes it in here, so working on this app cannot disturb a
// window that has live sessions in it.
const DEFAULT_PORT = 45888;
let PORT = DEFAULT_PORT;
let ORIGIN = `http://127.0.0.1:${PORT}`;

function usePort(port) {
    PORT = Number(port) || DEFAULT_PORT;
    ORIGIN = `http://127.0.0.1:${PORT}`;
}

// Where the bridge lives. Override in config.json next to this file or with
// TGXCODE_DIR, which is what you want when running from a worktree
// rather than the checkout.
const DEFAULTS = {
    distro: '',                              // Windows only; empty = WSL's default distro
    bridgeDir: '~/Other/claude-sessions',
    port: DEFAULT_PORT,
};

// Windows means "the bridge is across a WSL boundary"; anything else means it is
// on this machine. Checked here rather than in each caller so the two spawns
// below read the same way.
const VIA_WSL = process.platform === 'win32';

let mainWindow = null;
let bridgeStartedByUs = false;
let bridgePid = null;   // the pid this app started, so we only shut that one down

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
            console.error(`[tgxcode] ignoring ${p}: ${err.message}`);
        }
    }
    if (process.env.TGXCODE_DIR) cfg.bridgeDir = process.env.TGXCODE_DIR;
    if (process.env.TGXCODE_DISTRO) cfg.distro = process.env.TGXCODE_DISTRO;
    // The environment wins: it is how `npm run dev` hands this window its own
    // instance without editing the installed config.
    if (process.env.TGXCODE_PORT) cfg.port = Number(process.env.TGXCODE_PORT);
    usePort(cfg.port);
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

// Where the bridge's own output goes, as a shell expression evaluated in WSL.
// `tgxcode`, or `claude-sessions` if the bridge has not moved it across yet —
// never create the new one while the old holds the logs (bridge/legacy-dirs.js).
const LOG_DIR = '"$(c="${XDG_CACHE_HOME:-$HOME/.cache}"; '
    + 'if [ ! -e "$c/tgxcode" ] && [ -e "$c/claude-sessions" ]; '
    + 'then echo "$c/claude-sessions"; else echo "$c/tgxcode"; fi)"';
// Per-port, so a development bridge does not overwrite the everyday one's log.
const logFile = () => `${LOG_DIR}/bridge-${PORT}.log`;

/**
 * How to run a bash script where the bridge lives.
 *
 * On Windows that is across the WSL boundary, and `-d` picks the distro when
 * config names one. On Linux the bridge is on this machine, so the relay
 * disappears and bash is spawned directly.
 *
 * The *script* is identical either way, and deliberately so: it is plain POSIX
 * and it is the thing that knows how to start a bridge. Only the two words in
 * front of it differ.
 */
function bridgeShell(cfg, script) {
    if (!VIA_WSL) return { cmd: 'bash', args: ['-lc', script] };
    const args = [];
    if (cfg.distro) args.push('-d', cfg.distro);
    args.push('bash', '-lc', script);
    return { cmd: 'wsl.exe', args };
}

/**
 * Start the bridge without leaving a console window on screen.
 *
 * The obvious approach — spawning the relay with `detached: true` so the bridge
 * outlives this app — is exactly what puts a console on a Windows desktop:
 * Windows always gives a detached child its own console, and `windowsHide` is
 * ignored in that case.
 *
 * So detach on the Linux side instead. `setsid` reparents the bridge away from
 * the relay, the relay exits immediately, and this stays an ordinary hidden
 * child process. The bridge still survives closing the window, and anything it
 * prints goes to a log we can read back if it fails to come up.
 *
 * That `setsid` is why this needs no `detached: true` on Linux either: the
 * script has already done the detaching by the time bash returns. The Windows
 * rationale above is the *reason* the script is shaped this way, but the shape
 * is correct on both hosts, so there is one script and not two.
 */
function startBridge(cfg) {
    // launch.sh finds a node first: a login shell does not read ~/.bashrc, which
    // is where nvm puts itself, so plain `node` is not on PATH here.
    const script = [
        `cd ${shellQuote(cfg.bridgeDir)} || exit 1`,
        `mkdir -p ${LOG_DIR}`,
        // Both names: the checkout it launches may predate the rename.
        `export TGXCODE_PORT=${PORT} CLAUDE_SESSIONS_PORT=${PORT}`,
        `setsid nohup bash bridge/launch.sh >${logFile()} 2>&1 </dev/null &`,
        'exit 0',
    ].join('\n');

    const { cmd, args } = bridgeShell(cfg, script);
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => console.error(`[tgxcode] ${err.message}`));

    bridgeStartedByUs = true;
}

/** The bridge's own output, for when it never answers. */
function readBridgeLog(cfg) {
    return new Promise((resolve) => {
        const { cmd, args } = bridgeShell(cfg, `tail -n 40 ${logFile()} 2>/dev/null`);
        execFile(cmd, args, { windowsHide: true, timeout: 8000 },
            (err, stdout) => resolve(String(stdout || '').trim()));
    });
}

/** Quote a path for bash, keeping a leading ~ expandable. */
function shellQuote(p) {
    const s = String(p);
    const q = (t) => `'${t.replace(/'/g, `'\\''`)}'`;
    if (s === '~') return '"$HOME"';
    if (s.startsWith('~/')) return `"$HOME"/${q(s.slice(2))}`;
    return q(s);
}

// ── the right checkout ───────────────────────────────────────────────────
//
// A port answering is not proof it is answering for the right tree.
//
// The bridge hands its environment to every session it starts, so an agent
// working on this codebase inherits TGXCODE_PORT pointing at the
// everyday instance; a bridge started from a worktree then binds 45888 without
// anyone choosing that port, reports `dev: false`, and gets adopted here. The
// window looks exactly like the everyday one and serves a branch's UI out of a
// stale worktree — which is how a merged change went missing from a window that
// had been refreshed a dozen times.
//
// The bridge now refuses that bind (server.js) and no longer passes the port
// down (runner.js, terminal.js), so the accident cannot recur. This is the other
// half: what the shell does about a bridge that is on its port anyway — a second
// clone, something started by hand, or a version predating those guards. It is
// checked only for the everyday port. A development instance is deliberately
// pointed at a port by `npm run dev` and serves whatever checkout started it,
// which is the whole point of having one.

/** A WSL path with a leading `~` expanded against the bridge's own $HOME. */
function expandHome(p, home) {
    const s = String(p || '').replace(/\/+$/, '');
    if (!home) return s;
    if (s === '~') return home;
    if (s.startsWith('~/')) return `${home}/${s.slice(2)}`;
    return s;
}

/**
 * Is this bridge serving the checkout we are configured for?
 *
 * A bridge too old to report `root` cannot answer the question, and on the
 * everyday port an unverifiable bridge is treated as the wrong one: it is
 * restarted from the configured directory, which is where it should have been
 * running in the first place. Nothing is lost by that — a restart from the right
 * tree is the correct outcome either way, and turns in flight are protected by
 * the shutdown endpoint refusing while any is running.
 */
function servesConfigured(health, cfg) {
    if (!health || !health.root) return false;
    return health.root.replace(/\/+$/, '') === expandHome(cfg.bridgeDir, health.home);
}

/** Ask a bridge to stand down. 409 means it is mid-turn and will not. */
function askShutdown(pid) {
    return new Promise((resolve) => {
        const req = http.request(`${ORIGIN}/api/shutdown?pid=${pid}`, {
            method: 'POST',
            headers: { 'X-TGXCode-Client': '1', 'X-Claude-Sessions-Client': '1', 'Content-Length': '0' },
            timeout: 4000,
        }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('timeout', () => { req.destroy(); resolve(0); });
        req.on('error', () => resolve(0));
        req.end();
    });
}

/**
 * Take the everyday port back from a bridge serving the wrong checkout.
 *
 * Only ever through /api/shutdown, never a kill: that endpoint answers 409 while
 * a turn is in flight. A turn running in the session host would survive the
 * bridge going (bridge/host.js), but the shutdown gate is deliberately the
 * stricter `busy` rather than `atRisk` — a window closing means nobody is left to
 * answer an approval — and a turn started with no host still dies with its bridge.
 * So a squatter with work running is waited for rather than shot, with the reason
 * on screen. Three minutes
 * is long enough for an ordinary turn to land and short enough that a stuck one
 * does not leave a window saying nothing.
 */
async function reclaimPort(cfg, health, onStatus) {
    const where = health.root || 'an unknown checkout';
    const deadline = Date.now() + 180_000;

    for (;;) {
        const code = await askShutdown(health.pid);
        if (code === 200 || code === 0) break;   // stood down, or already gone

        if (code !== 409 || Date.now() > deadline) {
            return {
                ok: false,
                error: `The bridge on ${PORT} is serving ${where}, not `
                    + `${cfg.bridgeDir}, and would not stand down`
                    + `${code === 409 ? ' — it still has a turn running' : ''}.\n\n`
                    + `Finish or stop that work, or end it by hand inside WSL:\n`
                    + `  kill ${health.pid}\n\n`
                    + `then reopen TGXCode.`,
            };
        }

        const fresh = await ping();
        if (!fresh) break;                       // it went away on its own
        if (servesConfigured(fresh, cfg)) return { ok: true, adopted: fresh };
        onStatus(`Waiting for the bridge on ${PORT} to finish.`,
            `It is serving ${where}, not the checkout this app is configured for `
            + `(${cfg.bridgeDir}), so it cannot be used — but it has `
            + `${fresh.busy || 1} turn${fresh.busy === 1 ? '' : 's'} in flight and `
            + `stopping it would end them.\n\n`
            + `This window takes the port over as soon as that work finishes.`);
        await new Promise(r => setTimeout(r, 3000));
    }

    // Standing down is asynchronous; the socket has to be free before we bind it.
    const gone = Date.now() + 15_000;
    while (Date.now() < gone) {
        if (!await ping(600)) return { ok: true };
        await new Promise(r => setTimeout(r, 400));
    }
    return {
        ok: false,
        error: `The bridge on ${PORT} agreed to stop but is still answering.\n\n`
            + `Inside WSL:\n  kill ${health.pid}\n\nthen reopen TGXCode.`,
    };
}

/** Ensure a bridge is answering *for the configured checkout*, starting one if needed. */
async function ensureBridge(cfg, onStatus) {
    let health = await ping();

    // Adopting whatever is on the port is right for a development instance and
    // wrong for the everyday one — see the note above.
    if (health && (PORT !== DEFAULT_PORT || servesConfigured(health, cfg))) {
        return { ok: true, health, started: false };
    }

    if (health) {
        onStatus(`Another checkout is on ${PORT} — taking it back…`);
        const reclaimed = await reclaimPort(cfg, health, onStatus);
        if (!reclaimed.ok) return { ok: false, error: reclaimed.error, portHeld: true };
        // It may have been replaced by the right one while we waited.
        if (reclaimed.adopted) {
            return { ok: true, health: reclaimed.adopted, started: false };
        }
    }

    onStatus('Starting the bridge inside WSL…');
    startBridge(cfg);

    // A cold index of a few hundred transcripts takes about a second; allow more.
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 600));
        health = await ping();
        if (!health) continue;
        // Ours, or did something else win the race for the port?
        if (PORT === DEFAULT_PORT && !servesConfigured(health, cfg)) {
            return {
                ok: false,
                portHeld: true,
                error: `Started a bridge in ${cfg.bridgeDir}, but ${PORT} is being `
                    + `answered by one serving ${health.root || 'an unknown checkout'}.\n\n`
                    + `Something else claimed the port first. Inside WSL:\n`
                    + `  kill ${health.pid}\n\nthen reopen TGXCode.`,
            };
        }
        bridgePid = health.pid || null;
        return { ok: true, health, started: true };
    }
    return { ok: false, error: await readBridgeLog(cfg) || 'The bridge did not start in time.' };
}

async function stopBridgeIfIdle() {
    if (!bridgeStartedByUs || !bridgePid) return;
    await new Promise((resolve) => {
        const req = http.request(`${ORIGIN}/api/shutdown?pid=${bridgePid}`, {
            method: 'POST',
            headers: { 'X-TGXCode-Client': '1', 'X-Claude-Sessions-Client': '1', 'Content-Length': '0' },
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
        // Name the instance in the title bar: two identical windows, one of them
        // holding real work, is a mistake waiting to happen.
        title: PORT === DEFAULT_PORT ? 'TGXCode' : `TGXCode — dev :${PORT}`,
        // .ico is a Windows format and Linux wants a PNG. Both are generated by
        // app/make-icon.js from the same source, so this is a filename choice
        // and not two pictures to keep in step.
        icon: path.join(__dirname, VIA_WSL ? 'icon.ico' : 'icon.png'),
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            spellcheck: true,
            // One channel, so a clicked notification can raise this window —
            // the only thing the page cannot do for itself. See preload.js.
            preload: path.join(__dirname, 'preload.js'),
            // The in-app browser preview (web/preview.js). A <webview> rather
            // than an iframe because an iframe of another origin cannot be sent
            // back, screenshotted or inspected — which is most of the toolbar.
            // What a guest may be is decided in will-attach-webview below.
            webviewTag: true,
        },
    });

    // Every guest is a loopback page, or a site the shell's page asked for
    // (preview-allow-origin), in its own partition, with no preload and no Node. The page asks for this already; this is where it is enforced,
    // because a page that can create a <webview> can also set its attributes.
    mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
        delete webPreferences.preload;
        webPreferences.nodeIntegration = false;
        webPreferences.nodeIntegrationInSubFrames = false;
        webPreferences.contextIsolation = true;
        webPreferences.webSecurity = true;
        params.partition = PREVIEW_PARTITION;
        if (!isPreviewable(params.src) && params.src !== 'about:blank') event.preventDefault();
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

// Which installed application a toast belongs to. **It has to match the
// AppUserModelID on the Start Menu shortcut, and that is the whole story here.**
//
// Every notification this app raises is a Chromium notification from the
// renderer, so Windows owns the activation and resolves it through this ID. When
// the ID resolves to nothing there is nothing to activate, and the shell falls
// through to its last resort: searching the web for the string. This used to say
// `TGXCode`, chosen deliberately because an unresolvable ID gets printed verbatim
// as the toast header and that was a cheap way to get a readable one — so for
// months every notification click opened a Bing search for the word TGXCode, and
// none of the click handling in web/sw.js or web/app.js ever ran.
//
// The header is not lost by fixing this. Windows takes the display name from the
// shortcut, so `nsis.shortcutName` in package.json is set to `TGXCode` and the
// toast still says TGXCode — it just now names something that exists.
// electron-builder writes `build.appId` onto both shortcuts it creates
// (`WinShell::SetLnkAUMI` in its NSIS template), which is where this value comes
// from and why the two must be changed together.
//
// On Linux this call is a no-op, and the same job — telling the desktop which
// installed application a notification belongs to — is done by the .desktop file
// instead. The name matters there in the same way and for the same reason: the
// notification daemon matches on the desktop entry's basename, so
// `build.linux.desktop.StartupWMClass` and `app.getName()` have to agree with
// what electron-builder installs, or clicks land nowhere. That is the Linux
// spelling of the bug this comment records, and it is worth checking on the
// first real Linux build rather than assuming.
app.setAppUserModelId('com.tgxcode.desktop');

// One window, however it was asked for.
//
// Needed *because* of the fix above rather than as tidying. A toast that has
// fallen into the Action Center no longer has a live notification object behind
// it, so clicking it is an ordinary shell activation of the shortcut — which,
// unguarded, starts a second copy of the app next to the first. The bridge is
// already up by then, so both windows would work, which is the bad kind of bug.
//
// Nothing is passed along by that activation: without a registered COM toast
// activator Windows has no way to tell us *which* notification was clicked, so
// the most this can do is raise what is already open. A click on a toast still on
// screen goes to the renderer instead and does land on the right conversation.
const isOnlyInstance = app.requestSingleInstanceLock();
if (!isOnlyInstance) app.quit();
else app.on('second-instance', () => raise(mainWindow));

// Raise the window a clicked notification belongs to.
//
// Windows will not let a background process take the foreground on its own —
// that is the foreground lock, and it is why `window.focus()` from the page
// does nothing useful. Marking the window always-on-top for the length of the
// call is the way through it: the flag bypasses the lock, and clearing it
// immediately afterwards means the window does not actually stay on top of
// everything else. It ends up raised and focused, and behaves normally after.
//
// Sent by preload.js, which is the page's only way to ask — and by
// `second-instance` above, which has no page to ask on behalf of.
//
// **The always-on-top trick is a Windows answer and does not travel.** X11
// window managers vary in whether they honour it; Wayland compositors mostly
// refuse focus-stealing outright by design, and GNOME in particular turns any
// such request into a "Window is ready" hint in the tray rather than a raise.
// There is no API that overrides that — it is the compositor's policy and the
// point of it is that applications cannot.
//
// So on Linux: ask properly, then fall back to `flashFrame`, which is what the
// compositor's own convention for "this window wants you" maps onto (an urgency
// hint on X11, a needs-attention state on Wayland). A window that raises gets
// raised; one that does not at least lights up in the dock instead of the click
// doing nothing visible at all. Worth confirming on the actual desktop — which
// of these two happens is a property of the machine, not of this file.
function raise(win) {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();

    if (VIA_WSL) {
        // The foreground lock: Windows will not let a background process take
        // the foreground on its own, which is why `window.focus()` from the page
        // does nothing useful. Marking the window always-on-top for the length
        // of the call is the way through it — the flag bypasses the lock, and
        // clearing it immediately afterwards means the window does not actually
        // stay on top of everything else.
        win.setAlwaysOnTop(true);
        win.show();
        win.setAlwaysOnTop(false);
        win.focus();
        return;
    }

    win.show();
    win.focus();
    if (!win.isFocused()) win.flashFrame(true);
    // Clear the hint once the window is actually looked at, so it does not sit
    // demanding attention it has already had.
    win.once('focus', () => { if (!win.isDestroyed()) win.flashFrame(false); });
}

ipcMain.on('reveal-window', (event) => {
    raise(BrowserWindow.fromWebContents(event.sender) || mainWindow);
});

// ---------------------------------------------------------------------------
// The browser preview's guests
// ---------------------------------------------------------------------------
// Borrowed from DevBrowser (~/Other/dev-browser/main.js), which has shipped
// the same three things: DevTools on a key, a screenshot to the clipboard, and
// text from the element picker to the clipboard.

// Its own cookie jar. A guest sharing the shell's session would be handed the
// bridge's HttpOnly token cookie by any request to the bridge's origin.
const PREVIEW_PARTITION = 'persist:preview';
const MAX_COPY_TEXT = 8 * 1024;

function isLoopbackUrl(url) {
    try {
        const u = new URL(url);
        return (u.protocol === 'http:' || u.protocol === 'https:')
            && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
    } catch {
        return false;
    }
}

// Sites the shell's page has opened in the preview from a chat link
// (web/link-policy.js decides which). Held for the life of the process: an
// origin granted once may be navigated within, and a link from it to anywhere
// else still goes to the browser. Capped so a page gone wrong cannot grow it.
const previewOrigins = new Set();
const MAX_PREVIEW_ORIGINS = 200;

function isPreviewable(url) {
    if (isLoopbackUrl(url)) return true;
    try { return previewOrigins.has(new URL(url).origin); } catch { return false; }
}

app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;

    // A link that leaves loopback, or the site a chat link opened, is somewhere
    // else on the internet, and that belongs in the real browser, exactly as it
    // does for the shell itself.
    contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
        if (isPreviewable(url)) return;
        event.preventDefault();
        if (/^https?:/.test(url)) shell.openExternal(url);
    });

    // F12 / Ctrl+Shift+I inspect the page being previewed, not the app around
    // it. The shell's own F12 is handled on its webContents above and does not
    // see keys typed into a guest.
    contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        const key = typeof input.key === 'string' ? input.key : '';
        const inspect = key === 'F12' || (input.control && input.shift && key.toLowerCase() === 'i');
        if (!inspect) return;
        if (contents.isDevToolsOpened()) contents.closeDevTools();
        else contents.openDevTools();
        event.preventDefault();
    });
});

// Only the shell's own page may ask, and only about a guest: webContents ids are
// small integers, and without the type check this would screenshot anything.
const fromShell = (event) => mainWindow && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents;

ipcMain.handle('preview-capture', async (event, id) => {
    if (!fromShell(event) || !Number.isInteger(id)) return { ok: false, error: 'refused' };
    const target = webContents.fromId(id);
    if (!target || target.isDestroyed() || target.getType() !== 'webview') {
        return { ok: false, error: 'no-preview' };
    }
    try {
        const image = await target.capturePage();
        if (image.isEmpty()) return { ok: false, error: 'empty' };
        clipboard.writeImage(image);
        const { width, height } = image.getSize();
        return { ok: true, width, height };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('preview-allow-origin', (event, origin) => {
    if (!fromShell(event) || typeof origin !== 'string') return { ok: false, error: 'refused' };
    let u;
    try { u = new URL(origin); } catch { return { ok: false, error: 'refused' }; }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== origin) {
        return { ok: false, error: 'refused' };
    }
    if (!previewOrigins.has(origin)) {
        if (previewOrigins.size >= MAX_PREVIEW_ORIGINS) return { ok: false, error: 'full' };
        previewOrigins.add(origin);
    }
    return { ok: true };
});

ipcMain.handle('preview-copy-text', (event, text) => {
    if (!fromShell(event) || typeof text !== 'string' || !text) return { ok: false, error: 'refused' };
    clipboard.writeText(text.slice(0, MAX_COPY_TEXT));
    return { ok: true };
});

app.whenReady().then(async () => {
    // Quitting before `ready` normally stops it firing at all, but not
    // dependably enough to hang a second window off — and this is the copy that
    // must not start one, having just handed the click to the copy that already
    // has one.
    if (!isOnlyInstance) return;
    const cfg = loadConfig();
    const win = createWindow();

    const setStatus = (msg, detail) => {
        if (win && !win.isDestroyed()) win.loadURL(splash(msg, detail));
    };
    setStatus('Connecting to TGXCode…');

    const result = await ensureBridge(cfg, setStatus);
    if (!win || win.isDestroyed()) return;

    if (!result.ok) {
        // A port held by the wrong checkout is a different failure from a bridge
        // that would not come up, and the advice for it is already in the error.
        if (result.portHeld) {
            setStatus(`Nothing is being served on ${PORT}.`, result.error);
            return;
        }
        setStatus('The bridge would not start.',
            `Tried to run bridge/launch.sh in ${cfg.bridgeDir}`
            + `${cfg.distro ? ` on WSL distro ${cfg.distro}` : ''}.\n\n`
            + `Output from ~/.cache/tgxcode/bridge-${PORT}.log:\n${result.error}\n\n`
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
