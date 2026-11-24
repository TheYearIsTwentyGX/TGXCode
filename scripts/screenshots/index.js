#!/usr/bin/env node
'use strict';

// `npm run screenshots` — the pictures in the README, from a made-up world.
//
//   npm run screenshots                  every shot, written to docs/screenshots/
//   npm run screenshots -- --only hero,orchestrator
//   npm run screenshots -- --out /tmp/shots      write elsewhere (nothing in the repo changes)
//   npm run screenshots -- --keep        leave the demo bridge running and the temp
//                                        directory in place, and print the URL
//   npm run screenshots -- --setup       install what capturing needs (see below)
//
// **It never touches anything of yours.** The bridge it starts runs on a free
// port with a temporary HOME, its own state and cache directories and its own
// token, so nothing from ~/.claude, ~/.local/share/tgxcode or ~/.tgxcode can reach
// a picture and nothing it does can reach your sessions. Port 45888 is never
// bound. And no `claude` is ever started: `TGXCODE_CLAUDE_BIN` points at
// scripts/screenshots/stub-claude.js, which can do no more than put a session
// into the state a picture needs (see that file for what is faked).
//
// What a picture shows was written by seed.js — two small made-up projects, the
// conversations that would have produced their git history, an orchestrator with
// four workers. See that file's header for what is real (the git repositories
// and their files) and what is not (every conversation).
//
// Capturing wants Playwright, which this repository does not depend on and will
// not (`dependencies` is empty on purpose). It is looked for, in order, at
// $PLAYWRIGHT_PATH, as an installed package, and under ~/.cache/tgxcode/screenshots;
// `--setup` puts it in the last of those with `npm install --prefix`, which writes
// nothing into the checkout. On a machine without a browser's shared libraries
// (WSL, a container) Chromium will say which are missing; `apt-get download` them
// into a scratch directory, unpack with `dpkg -x`, and point LD_LIBRARY_PATH at
// the result — that needs no root. docs/manual.md §Screenshots has the details.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const { seed, forbidden } = require('./seed');
const { shots } = require('./shots');
const { encode } = require('./png');

const REPO = path.join(__dirname, '..', '..');
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'tgxcode', 'screenshots');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

// -- Playwright ------------------------------------------------------------

function findPlaywright() {
    const tries = [
        process.env.PLAYWRIGHT_PATH,
        'playwright-core', 'playwright',
        path.join(CACHE, 'node_modules', 'playwright-core'),
        path.join(CACHE, 'node_modules', 'playwright'),
    ].filter(Boolean);
    for (const t of tries) {
        try { return require(require.resolve(t, { paths: [REPO, CACHE] })); } catch { /* next */ }
    }
    return null;
}

/**
 * Chromium, by the library's own idea of which one it wants — and failing that,
 * any Playwright browser already on this machine. A library and a browser are
 * installed separately, and one found in somebody's other project is rarely the
 * revision the browser cache holds; the protocol is stable enough across a few
 * revisions that using the newest headless shell there is better than stopping.
 * TGXCODE_SHOTS_CHROME names an executable outright.
 */
async function launchBrowser(pw) {
    const named = process.env.TGXCODE_SHOTS_CHROME;
    if (named) return pw.chromium.launch({ headless: true, executablePath: named });
    try {
        return await pw.chromium.launch({ headless: true });
    } catch (err) {
        if (!/Executable doesn't exist/.test(String(err.message))) throw explainLaunch(err);
        const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
        let found = null;
        try {
            found = fs.readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-'))
                .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
                .map(d => path.join(cache, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'))
                .find(p => fs.existsSync(p)) || null;
        } catch { /* no cache */ }
        if (!found) throw new Error('No Chromium for Playwright was found. Run `npm run screenshots -- --setup`.');
        console.log(`(using ${found})`);
        try {
            return await pw.chromium.launch({ headless: true, executablePath: found });
        } catch (err2) { throw explainLaunch(err2); }
    }
}

function explainLaunch(err) {
    const msg = String(err.message || err);
    const lib = /error while loading shared libraries: (\S+)/.exec(msg);
    if (!lib) return err;
    return new Error(`Chromium needs a shared library this machine lacks (${lib[1]}).\n`
        + 'Without root: `apt-get download` the missing packages (libnspr4, libnss3, libasound2 are the usual\n'
        + 'ones) into a scratch directory, unpack each with `dpkg -x`, and run again with LD_LIBRARY_PATH\n'
        + 'pointing at the unpacked usr/lib/x86_64-linux-gnu. See docs/manual.md §Screenshots.\n\n' + msg);
}

function setup() {
    fs.mkdirSync(CACHE, { recursive: true });
    console.log(`Installing playwright-core into ${CACHE} (nothing is written to the checkout)…`);
    execFileSync('npm', ['install', '--prefix', CACHE, '--no-audit', '--no-fund', 'playwright-core'], { stdio: 'inherit' });
    const cli = path.join(CACHE, 'node_modules', 'playwright-core', 'cli.js');
    console.log('Downloading Chromium (headless shell)…');
    execFileSync(process.execPath, [cli, 'install', 'chromium-headless-shell'], { stdio: 'inherit' });
    console.log('\nDone. If Chromium later complains about a missing shared library, see the header of this file.');
}

// -- small helpers ---------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/**
 * A free port in a range, tried in order. The demo app's must not be one the
 * kernel hands out to ordinary connections (32768 and up on Linux): the bridge
 * skips those when deciding which listening ports are a session's dev servers,
 * because a client socket and a server look the same to `ss`.
 */
async function freePortIn(lo, hi) {
    for (let p = lo; p <= hi; p++) {
        const ok = await new Promise((resolve) => {
            const srv = net.createServer();
            srv.once('error', () => resolve(false));
            srv.listen(p, () => srv.close(() => resolve(true)));
        });
        if (ok) return p;
    }
    throw new Error(`No free port between ${lo} and ${hi}.`);
}

function request(port, pathname, { method = 'GET', body, token } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            'x-tgxcode-client': '1',
            ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        } }, (res) => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(raw); } catch { /* not JSON */ }
                resolve({ status: res.statusCode, json, raw });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function until(fn, what, ms = 20_000, why = null) {
    const end = Date.now() + ms;
    for (;;) {
        try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
        if (Date.now() > end) {
            const more = why ? `\n${await Promise.resolve(why()).catch(e => e.message)}` : '';
            throw new Error(`Timed out waiting for ${what}${more}`);
        }
        await sleep(200);
    }
}

// -- main ------------------------------------------------------------------

async function main() {
    if (flag('setup')) return setup();

    const pw = findPlaywright();
    if (!pw) {
        console.error('Playwright was not found. Run `npm run screenshots -- --setup`, or set PLAYWRIGHT_PATH to a\n'
            + 'playwright or playwright-core package. (This repository deliberately depends on neither.)');
        process.exit(2);
    }

    const only = (option('only') || '').split(',').map(s => s.trim()).filter(Boolean);
    const outDir = path.resolve(option('out') || path.join(REPO, 'docs', 'screenshots'));
    const wanted = shots.filter(s => !only.length || only.includes(s.name));
    if (!wanted.length) {
        console.error(`No shot named ${only.join(', ')}. Known: ${shots.map(s => s.name).join(', ')}`);
        process.exit(2);
    }

    // The demo user's whole world lives here and is removed at the end.
    //
    // Not under /tmp: the session list hides any session that ran there (bridge/
    // sessions.js `isTemp` — agents' scratch work), so the whole demo would be
    // filtered out. Not under your home either, because a path that shows in a
    // picture would then carry your username.
    const base = ['/var/tmp', '/dev/shm'].find(d => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } });
    if (!base) throw new Error('Need a writable /var/tmp or /dev/shm for the demo home.');
    const root = fs.mkdtempSync(path.join(base, 'tgxcode-shots-'));
    const home = path.join(root, 'demo');
    const stateBase = path.join(root, 'data');
    const cacheBase = path.join(root, 'cache');
    for (const d of [home, stateBase, cacheBase, path.join(root, 'bin'), path.join(root, 'prefs')]) {
        fs.mkdirSync(d, { recursive: true });
    }

    const children = [];
    let browser = null;
    let cleaned = false;
    const cleanup = async (keep) => {
        if (cleaned) return;
        cleaned = true;
        if (browser) { try { await browser.close(); } catch { /* gone */ } }
        for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
        await sleep(300);
        if (keep) return;
        fs.rmSync(root, { recursive: true, force: true });
    };
    process.on('SIGINT', () => cleanup(false).then(() => process.exit(130)));
    process.on('SIGTERM', () => cleanup(false).then(() => process.exit(143)));

    try {
        browser = await launchBrowser(pw);

        // The seed asks for two things the browser is for: a picture of the demo
        // app (the conversation shows it), and the demo app running somewhere.
        const render = async (url, file, { width = 800, height = 600, click = null } = {}) => {
            const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
            await page.goto(url);
            await page.waitForSelector('#list li');
            if (click) { await page.click(click); await sleep(150); }
            const buf = await page.screenshot();
            await page.close();
            void file;
            return buf;
        };
        const serve = async (cwd, sessionId) => {
            const port = await freePortIn(5173, 5199);
            const child = spawn(process.execPath, ['src/server.js'], { cwd, env: { PATH: process.env.PATH, PORT: String(port), CLAUDE_CODE_SESSION_ID: sessionId }, stdio: 'ignore' });
            children.push(child);
            await until(() => request(port, '/').then(r => r.status === 200), 'the demo app');
            return { port, stop: () => child.kill('SIGTERM') };
        };

        console.log('Seeding the demo world…');
        const world = await seed({
            home, now: Date.now(), stateDir: stateBase, cacheDir: path.join(cacheBase, 'tgxcode'),
            render, serve,
        });
        fs.writeFileSync(path.join(root, 'stub.json'), JSON.stringify(world.stubPlan));
        // `claude`, as a script that runs the stub with the node that is running us.
        const bin = path.join(root, 'bin', 'claude');
        fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'stub-claude.js')}" "$@"\n`, { mode: 0o755 });

        // -- the bridge ----------------------------------------------------
        // Settings for the demo user. DevBrowser is a second app this machine may
        // not have, so it is not mentioned and a port chip opens the window's own
        // preview; and a rail card's one-line "where this stands" is taken from
        // the reply rather than asked of a model, which would need a real `claude`.
        fs.writeFileSync(path.join(root, 'prefs', 'settings.json'), JSON.stringify({
            devbrowser: { show: false },
            standing: { mode: 'extract' },
        }, null, 2));
        const port = await freePort();
        if (port === 45888) throw new Error('Refusing to use the everyday port.');
        const env = {
            PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TERM: 'xterm-256color',
            XDG_DATA_HOME: stateBase, XDG_CACHE_HOME: cacheBase, XDG_CONFIG_HOME: path.join(root, 'config'),
            TMPDIR: os.tmpdir(),
            TGXCODE_PORT: String(port),
            TGXCODE_ROOTS: home,
            TGXCODE_PREFS_DIR: path.join(root, 'prefs'),
            TGXCODE_CLAUDE_BIN: bin,
            TGXCODE_STUB_SCRIPT: path.join(root, 'stub.json'),
            TGXCODE_NO_HOST: '1',
            TGXCODE_HOST_KIND: 'linux',
            TGXCODE_MANAGED_SETTINGS: path.join(root, 'no-managed-settings.json'),
            GIT_CONFIG_NOSYSTEM: '1',
        };
        const bridge = spawn(process.execPath, [path.join(REPO, 'bridge', 'server.js')], {
            cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(bridge);
        let bridgeLog = '';
        bridge.stdout.on('data', d => { bridgeLog += d; });
        bridge.stderr.on('data', d => { bridgeLog += d; });
        bridge.on('exit', (code) => { if (!cleaned) console.error(`The demo bridge exited (${code}):\n${bridgeLog}`); });

        await until(() => request(port, '/api/health').then(r => r.status === 200 && r.json), 'the demo bridge');
        const token = fs.readFileSync(path.join(stateBase, 'tgxcode', 'token'), 'utf8').trim();
        const api = (p, o) => request(port, p, { token, ...o });
        const health = (await api('/api/health')).json;
        if (health.remote || String(health.root) !== REPO) console.log(`(bridge root: ${health.root})`);
        console.log(`Demo bridge on http://127.0.0.1:${port} (home ${home})`);

        await until(async () => ((await api('/api/sessions')).json || {}).sessions?.length >= 9,
            'the seeded sessions to be indexed', 20_000, async () => {
                const r = await api('/api/sessions');
                return `GET /api/sessions → ${r.status} ${r.raw.slice(0, 600)}\nbridge log:\n${bridgeLog.slice(-1500)}`;
            });

        // The three sessions that are meant to be mid-turn: one message each, to
        // the stub, which answers by getting into the state the plan says.
        for (const key of ['flaky', 'offline', 'shortcuts']) {
            const r = await api(`/api/sessions/${world.id[key]}/send`, { method: 'POST', body: {
                text: 'Carry on.', permissionMode: key === 'offline' ? 'plan' : 'default' } });
            if (r.status !== 200) throw new Error(`could not start ${key}: ${r.status} ${r.raw}`);
        }
        await until(async () => {
            const o = (await api(`/api/sessions/${world.id.orch}/orchestrator`)).json;
            const row = (id) => (o.workers || []).find(w => w.id === id);
            return row(world.id.offline)?.pending === 'plan' && row(world.id.shortcuts)?.pending === 'tool'
                && row(world.id.flaky)?.state === 'busy';
        }, 'the stub sessions to reach their states');

        const ctx = { browser, port, api, world, token, root, home, outDir, request };

        if (flag('keep')) {
            console.log(`\nLeft running. Open http://127.0.0.1:${port}/ — Ctrl-C stops it and removes ${root}`);
            await new Promise(() => {});
        }

        // -- capture -------------------------------------------------------
        fs.mkdirSync(outDir, { recursive: true });
        const report = [];
        const failed = [];
        for (const shot of wanted) {
            process.stdout.write(`  ${shot.name} … `);
            const page = await browser.newPage({
                viewport: shot.viewport || { width: 1440, height: 900 }, deviceScaleFactor: 2,
                colorScheme: 'dark', reducedMotion: 'reduce',
            });
            page.setDefaultTimeout(15_000);
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            try {
                const png = await shot.run(page, ctx);
                await assertClean(page, ctx);
                const out = await finish(browser, png, shot);
                fs.writeFileSync(path.join(outDir, `${shot.name}.png`), out.png);
                report.push({ name: shot.name, bytes: out.png.length, width: out.width, height: out.height });
                console.log(`${(out.png.length / 1024).toFixed(0)} KB  ${out.width}×${out.height}${out.lossy ? '  (256 colours)' : ''}`);
            } catch (err) {
                failed.push(shot.name);
                console.log(`FAILED — ${String(err.message || err).split('\n')[0]}`);
            } finally {
                if (errors.length) console.log(`    page errors: ${errors.slice(0, 3).join(' | ')}`);
                await page.close();
            }
        }
        console.log(`\nWrote ${report.length} image(s) to ${outDir}`);
        if (failed.length) {
            console.error(`Failed: ${failed.join(', ')}`);
            process.exitCode = 1;
        }
    } finally {
        await cleanup(flag('keep'));
    }
}

/**
 * What is on the page at the moment of capture must not contain anything that
 * does not belong in a public picture. seed.js scans what was *written*; this
 * scans what is *drawn* — the text of the page and the text behind its tooltips
 * and links — for the same patterns, plus anything that would name the person
 * running this: their username, their home directory, the temp directory the
 * demo really lives in. A hit throws, so the picture is not written.
 */
async function assertClean(page, ctx) {
    // What a picture can show is what is inside the viewport: the text nodes whose
    // box intersects it, and what is typed into a field. (A long Settings page has
    // text far off-screen that no picture will carry; tooltips are not drawn in a
    // static capture.)
    const text = await page.evaluate(() => {
        const out = [];
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.nodeValue.trim()) continue;
            range.selectNodeContents(n);
            const r = range.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
            const el = n.parentElement;
            if (el && getComputedStyle(el).visibility === 'hidden') continue;
            out.push(n.nodeValue);
        }
        for (const e of document.querySelectorAll('input, textarea')) if (e.value) out.push(e.value);
        return out.join('\n');
    });
    const own = [os.userInfo().username, os.homedir(), ctx.root, '/var/tmp/tgxcode']
        .filter(s => s && s.length > 3);
    for (const needle of own) {
        if (text.includes(needle)) throw new Error(`the page shows ${JSON.stringify(needle)}`);
    }
    for (const [re, why] of forbidden()) {
        const m = re.exec(text);
        if (m) throw new Error(`the page shows ${why}: ${JSON.stringify(m[0].slice(0, 40))}`);
    }
}

/**
 * Scale a 2× capture down to its published width and re-encode it. The browser
 * does the scaling — a canvas draw is a good-quality filter and needs no library —
 * and hands back raw pixels for png.js.
 */
async function finish(browser, png, shot) {
    const targetWidth = shot.width || 1440;
    // A blank page of its own: the app's CSP would refuse the data: image.
    const worker = await browser.newPage();
    const result = await worker.evaluate(async ({ b64, targetWidth }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const scale = Math.min(1, targetWidth / img.naturalWidth);
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const c = canvas.getContext('2d');
        c.imageSmoothingQuality = 'high';
        c.drawImage(img, 0, 0, w, h);
        const data = c.getImageData(0, 0, w, h).data;
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < data.length; i += chunk) bin += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
        return { w, h, rgba: btoa(bin) };
    }, { b64: png.toString('base64'), targetWidth });
    await worker.close();
    const rgba = Buffer.from(result.rgba, 'base64');
    const enc = encode(rgba, result.w, result.h, 380 * 1024);
    return { png: enc.png, width: result.w, height: result.h, lossy: enc.lossy };
}

main().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
