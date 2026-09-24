'use strict';

// What decides whether a port gets a browser preview, and what "don't launch
// DevBrowser" does when it is closed.
//
// No bridge needed. isHttp() is the line between a chip that opens a page and
// one that opens nothing useful: a TCP connect says only that *something* is
// there, and a database or a language server accepts connections as happily as
// vite does. So the interesting case is the middle one — a listener that
// accepts and then never speaks HTTP — which a connect-based check calls a
// server and this must not.

// Before any require: devbrowser.js reads the host kind and the config dir at
// call time, and this points both somewhere with no DevBrowser in it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-preview-'));
process.env.TGXCODE_HOST_KIND = 'linux';
process.env.XDG_CONFIG_HOME = tmp;
process.env.XDG_DATA_HOME = tmp;
process.env.XDG_CACHE_HOME = tmp;

const assert = require('assert');
const http = require('http');
const net = require('net');

const { isHttp } = require('../bridge/devservers.js');
const devbrowser = require('../bridge/devbrowser.js');
const { Run } = require('../bridge/runs.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise(r => server.close(() => r()));

(async () => {
    // A server that answers — 404 included, because a dev server with no route
    // at `/` is still something to point a browser at.
    const web = http.createServer((req, res) => { res.statusCode = 404; res.end('nope'); });
    const webPort = await listen(web);
    assert.strictEqual(await isHttp(webPort), true, 'a 404 was not taken as HTTP');
    ok('anything with a status line is previewable, 404 included');

    // Accepts, reads, says nothing. A connect would call this a server.
    const mute = net.createServer((sock) => { sock.on('data', () => {}); });
    const mutePort = await listen(mute);
    const t0 = Date.now();
    assert.strictEqual(await isHttp(mutePort, 300), false, 'a silent listener was taken as HTTP');
    assert.ok(Date.now() - t0 < 2000, 'the timeout did not bound the probe');
    // Speaks, but not HTTP — a Redis-shaped greeting.
    const chatty = net.createServer((sock) => { sock.end('-ERR unknown command\r\n'); });
    const chattyPort = await listen(chatty);
    assert.strictEqual(await isHttp(chattyPort, 300), false, 'a non-HTTP reply was taken as HTTP');
    ok('a listener that is not HTTP is not previewable, silent or talkative');

    // Nothing there at all.
    await close(web);
    assert.strictEqual(await isHttp(webPort, 300, { fresh: true }), false, 'a closed port was taken as HTTP');
    ok('a closed port is not previewable, once the cache is bypassed');

    // Not awaited: a raw net server's close callback waits on sockets the probe
    // already abandoned, and nothing else then holds the loop open.
    mute.close();
    chatty.close();

    // DevBrowser advertised on a port nothing holds, so it reads as closed.
    // A port the kernel just handed out and took back is as dead as one gets.
    const holder = net.createServer();
    const deadPort = await listen(holder);
    await close(holder);
    const dir = path.join(tmp, 'dev-browser-desktop');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'control-server.json'), JSON.stringify({ port: deadPort }));
    const t1 = Date.now();
    const out = await devbrowser.openTab(5173, null, { launch: false });
    assert.deepStrictEqual(out, { ok: false, running: false, launched: false });
    assert.ok(Date.now() - t1 < 4000, 'launch: false still waited for a launch');
    ok('openTab with launch: false reports DevBrowser closed and starts nothing');

    // A task's probe, against a server whose first page takes longer than the
    // 1.5 s one try used to allow. The LTCDataPlus dev server takes about 4 s,
    // and the old probe gave up on it for good, so its button never opened the
    // preview. Driven through a Run-shaped stub: a real Run spawns a pty.
    let served = 0;
    const slow = http.createServer((req, res) => {
        served++;
        setTimeout(() => { res.statusCode = 200; res.end('late'); }, served === 1 ? 2500 : 0);
    });
    const slowPort = await listen(slow);
    let changes = 0;
    const run = { port: slowPort, state: 'listening', exitedAt: 0, http: undefined,
        changed() { changes++; } };
    Run.prototype.probeHttp.call(run);
    const t2 = Date.now();
    while (!run.http && Date.now() - t2 < 8000) await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(run.http, true, 'a slow first page was never taken as HTTP');
    assert.strictEqual(changes, 1, 'the yes was announced other than once');
    assert.strictEqual(run.timer, null, 'the probe left a timer behind after its yes');
    await close(slow);
    ok('a task whose first page is slow is still found to answer HTTP');

    // A listener that never speaks: the probe keeps its timer while the run is
    // up, and lets go of it once the run ends.
    const held = [];
    const mute2 = net.createServer((sock) => { sock.on('error', () => {}); held.push(sock); });
    const mute2Port = await listen(mute2);
    const quiet = { port: mute2Port, state: 'listening', exitedAt: 0, http: undefined,
        changed() { throw new Error('a silent listener was announced'); } };
    Run.prototype.probeHttp.call(quiet);
    // Let the first try connect and sit there.
    await new Promise(r => setTimeout(r, 300));
    assert.ok(held.length >= 1, 'the probe never connected');
    // End the run, then drop the connection the try is sitting on so it
    // returns now rather than after its 10 s.
    quiet.exitedAt = Date.now();
    for (const sock of held) sock.destroy();
    mute2.close();
    await new Promise(r => setTimeout(r, 300));
    assert.notStrictEqual(quiet.http, true, 'a silent listener was taken as HTTP');
    assert.strictEqual(quiet.timer, null, 'the probe kept going after the run ended');
    ok('a silent task stays unpreviewable, and its probe stops when the run ends');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${pass} preview checks passed`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
