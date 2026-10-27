'use strict';

// The preview's CDP endpoint (app/preview-cdp.js), driven over a real socket
// with fake guests in place of Electron's webContents.
//
// What it pins down is the security half of the feature: the endpoint lists the
// preview's guests and nothing else, refuses to attach to any other target,
// refuses the commands that reach past a page, and does not answer without its
// token — or to anything that sends an Origin, which is what a web page cannot
// avoid doing. And the half Playwright depends on: a guest arrives as a `page`
// with its own targetId, commands reach the guest's debugger, and its events
// come back on the session it was attached as.

const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');

const { PreviewCdp, refusal, FrameReader, encodeFrame } = require('../app/preview-cdp');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

/** A webContents with just the surface the endpoint uses. */
function fakeGuest(id, url, title) {
    const dbg = new EventEmitter();
    dbg.attached = false;
    dbg.sent = [];
    dbg.attach = () => { if (dbg.attached) throw new Error('already'); dbg.attached = true; };
    dbg.detach = () => { dbg.attached = false; };
    dbg.isAttached = () => dbg.attached;
    dbg.sendCommand = async (method, params, sessionId) => {
        if (!dbg.attached) throw new Error('not attached');
        dbg.sent.push({ method, params, sessionId });
        if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: `REAL-${id}`, type: 'webview' } };
        if (method === 'Runtime.evaluate') return { result: { type: 'number', value: 2 } };
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `REAL-${id}`, loaderId: dbg.loader, url: 'https://example.com/' } } };
        return {};
    };
    return { id, debugger: dbg, getURL: () => url, getTitle: () => title, isDestroyed: () => false, focusCalls: 0 };
}

function get(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
        }).on('error', reject);
    });
}

/** A CDP client over Node's WebSocket. */
function connect(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const events = [];
        const waiting = new Map();
        let n = 0;
        ws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else events.push(m);
        };
        ws.onopen = () => resolve({
            ws, events,
            send: (method, params = {}, sessionId) => new Promise((res) => {
                const id = ++n;
                waiting.set(id, res);
                ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
            }),
            closed: new Promise(r => { ws.onclose = r; }),
        });
        ws.onerror = () => reject(new Error('could not connect'));
    });
}

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

(async () => {
    const a = fakeGuest(7, 'http://127.0.0.1:5173/', 'App');
    const b = fakeGuest(9, 'https://example.com/', 'Example');
    let guests = [a, b];
    const asked = [];
    const cdp = new PreviewCdp({
        guests: () => guests,
        navigationRefusal: (url) => { asked.push(url); return /example\.org/.test(url) ? `blocked ${url}` : null; },
        focusGuest: async (wc) => { wc.focusCalls++; },
        product: 'Chrome/126.0.0.0',
    });
    const states = [];
    cdp.on('state', s => states.push(s));
    const endpoint = await cdp.start();
    const { port, pathname } = new URL(endpoint);
    const token = pathname.slice(1);
    assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}$/);

    // ── the token, the Origin and the Host ────────────────────────────────
    assert.strictEqual((await get(port, `/${token}/json/version`)).status, 200);
    assert.strictEqual((await get(port, `/${'0'.repeat(48)}/json/version`)).status, 403, 'wrong token');
    assert.strictEqual((await get(port, '/json/version')).status, 403, 'no token');
    assert.strictEqual((await get(port, `/${token}/json/version`, { Origin: 'http://evil.example' })).status, 403,
        'a request from a web page carries an Origin');
    assert.strictEqual((await get(port, `/${token}/json/version`, { Host: 'evil.example' })).status, 403,
        'a rebinding host name');
    await assert.rejects(connect(`ws://127.0.0.1:${port}/${'f'.repeat(48)}/devtools/browser/x`), 'ws with a wrong token');
    ok('nothing answers without the token, and nothing answers a web page');

    // ── the lists hold the guests and nothing else ───────────────────────
    const version = (await get(port, `/${token}/json/version`)).body;
    assert.strictEqual(version.webSocketDebuggerUrl, `ws://127.0.0.1:${port}/${token}/devtools/browser/tgxcode-preview`);
    const list = (await get(port, `/${token}/json/list`)).body;
    assert.deepStrictEqual(list.map(t => [t.id, t.type, t.url]),
        [['REAL-7', 'page', 'http://127.0.0.1:5173/'], ['REAL-9', 'page', 'https://example.com/']]);
    assert.ok(!a.debugger.attached && !b.debugger.attached, 'listing let go of the debuggers it borrowed');

    const c = await connect(version.webSocketDebuggerUrl);
    const targets = (await c.send('Target.getTargets')).result.targetInfos;
    assert.deepStrictEqual(targets.map(t => [t.targetId, t.type, t.browserContextId]),
        [['REAL-7', 'page', 'TGXCODEPREVIEWCONTEXT'], ['REAL-9', 'page', 'TGXCODEPREVIEWCONTEXT']],
        'a webview is reported as a page, with its real targetId and a context');
    ok('the target lists hold the preview guests, as pages, and nothing else');

    // ── attaching ─────────────────────────────────────────────────────────
    const shellPage = await c.send('Target.attachToTarget', { targetId: 'SHELL-WINDOW', flatten: true });
    assert.match(shellPage.error.message, /No target with given id/);
    for (const m of ['Target.createTarget', 'Target.closeTarget', 'Target.attachToBrowserTarget',
        'Target.exposeDevToolsProtocol', 'Browser.close', 'Tethering.bind']) {
        assert.ok((await c.send(m, { url: 'about:blank', targetId: 'REAL-7', port: 9 })).error, `${m} was answered`);
    }
    ok('attaching to anything but a guest is refused, as are the browser-level escapes');

    await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const attached = c.events.filter(e => e.method === 'Target.attachedToTarget');
    assert.deepStrictEqual(attached.map(e => e.params.targetInfo.targetId), ['REAL-7', 'REAL-9']);
    assert.ok(attached.every(e => e.params.waitingForDebugger === false && e.params.targetInfo.type === 'page'));
    assert.ok(a.debugger.attached && b.debugger.attached);
    const sa = attached[0].params.sessionId;
    assert.ok(cdp.isControlled(a) && cdp.state().connected);

    const r = await c.send('Runtime.evaluate', { expression: '1+1' }, sa);
    assert.strictEqual(r.sessionId, sa);
    assert.strictEqual(r.result.result.value, 2);
    assert.deepStrictEqual(a.debugger.sent.at(-1), { method: 'Runtime.evaluate', params: { expression: '1+1' }, sessionId: undefined });
    a.debugger.emit('message', {}, 'Page.loadEventFired', { timestamp: 1 }, '');
    a.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'CHILD', targetInfo: { type: 'iframe' } }, '');
    await tick();
    assert.ok(c.events.some(e => e.method === 'Page.loadEventFired' && e.sessionId === sa), 'events come back on the page session');
    await c.send('DOM.enable', {}, 'CHILD');
    assert.deepStrictEqual(a.debugger.sent.at(-1), { method: 'DOM.enable', params: {}, sessionId: 'CHILD' },
        'a child session the guest minted is routed to it');
    ok('auto-attach announces each guest, and commands and events flow through its debugger');

    // ── the frameNavigated a cross-site navigation loses ─────────────────
    {
        const emit = (method, params) => a.debugger.emit('message', {}, method, params, '');
        const seq = () => c.events.filter(e => e.sessionId === sa && /^(Page\.(lifecycleEvent|frameNavigated)|Runtime\.executionContext)/.test(e.method))
            .map(e => (e.method === 'Page.lifecycleEvent' ? `init:${e.params.loaderId}`
                : e.method === 'Page.frameNavigated' ? `nav:${e.params.frame.loaderId}` : e.method.split('.')[1]));
        c.events.length = 0;
        // An ordinary navigation reports itself, and nothing is added.
        emit('Page.lifecycleEvent', { name: 'init', frameId: 'REAL-7', loaderId: 'L1' });
        emit('Runtime.executionContextsCleared', {});
        emit('Page.frameNavigated', { frame: { id: 'REAL-7', loaderId: 'L1', url: 'http://127.0.0.1:5173/b' }, type: 'Navigation' });
        emit('Runtime.executionContextCreated', { context: { id: 1, auxData: { frameId: 'REAL-7', isDefault: true } } });
        await tick();
        assert.deepStrictEqual(seq(), ['init:L1', 'executionContextsCleared', 'nav:L1', 'executionContextCreated']);
        // A process swap: no frameNavigated. One is made, ahead of the new context.
        c.events.length = 0;
        a.debugger.loader = 'L2';
        emit('Page.lifecycleEvent', { name: 'init', frameId: 'REAL-7', loaderId: 'L2' });
        emit('Runtime.executionContextsCleared', {});
        emit('Runtime.executionContextCreated', { context: { id: 2, auxData: { frameId: 'REAL-7', isDefault: true } } });
        await tick(50);
        assert.deepStrictEqual(seq(), ['init:L2', 'nav:L2', 'executionContextsCleared', 'executionContextCreated']);
        assert.strictEqual(c.events.find(e => e.method === 'Page.frameNavigated').params.frame.url, 'https://example.com/');
        // And if nothing at all follows the init, a second is long enough to wait.
        c.events.length = 0;
        a.debugger.loader = 'L3';
        emit('Page.lifecycleEvent', { name: 'init', frameId: 'REAL-7', loaderId: 'L3' });
        await tick(1200);
        assert.deepStrictEqual(seq(), ['init:L3', 'nav:L3']);
    }
    ok('a navigation whose frameNavigated the guest never sends gets one, in the right place');

    // ── what a page's own session may not do ─────────────────────────────
    for (const m of ['Target.attachToBrowserTarget', 'Target.createTarget', 'Target.getTargets',
        'Target.attachToTarget', 'Browser.close', 'Browser.setDownloadBehavior', 'Page.close', 'Page.crash']) {
        const res = await c.send(m, { targetId: 'X', url: 'about:blank' }, sa);
        assert.ok(res.error && /^TGXCode: /.test(res.error.message), `${m} reached the guest`);
    }
    assert.ok(!a.debugger.sent.some(x => x.method === 'Target.attachToBrowserTarget' || x.method === 'Browser.close'));
    const nav = await c.send('Page.navigate', { url: 'https://example.org/' }, sa);
    assert.strictEqual(nav.error.message, 'blocked https://example.org/', 'the navigation check\'s text, verbatim');
    const local = await c.send('Page.navigate', { url: 'http://127.0.0.1:5173/two' }, sa);
    assert.ok(!local.error);
    const frame = await c.send('Page.navigate', { url: 'https://example.org/', frameId: 'SUBFRAME' }, sa);
    assert.ok(!frame.error, 'only the top-level navigation is gated');
    assert.deepStrictEqual(asked, ['https://example.org/', 'http://127.0.0.1:5173/two']);
    assert.strictEqual(refusal('Page.navigate', { url: 'x' }, () => 'no', false), null);
    ok('a page session cannot reach past its page, and its navigations are put to the grant check');

    // Keystrokes into a guest without focus are dropped by Chromium; see KEYBOARD.
    await c.send('Runtime.evaluate', { expression: 'x' }, sa);
    assert.strictEqual(a.focusCalls, 0, 'nothing but typing takes the focus');
    await c.send('Input.insertText', { text: 'hi' }, sa);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown' }, sa);
    assert.strictEqual(a.focusCalls, 2, 'each keystroke asks for the guest to have the keyboard');
    a.reloads = 0;
    a.reload = () => { a.reloads++; };
    const before = a.debugger.sent.length;
    assert.ok(!(await c.send('Page.reload', {}, sa)).error);
    assert.strictEqual(a.reloads, 1, 'the guest reloads itself');
    assert.ok(!a.debugger.sent.slice(before).some(x => x.method === 'Page.reload'),
        'Page.reload never reaches a guest\'s debugger: there it reloads the whole window');
    ok('typing gives the guest the keyboard first, and a reload is the guest\'s own');

    // ── guests coming and going ──────────────────────────────────────────
    const g = fakeGuest(11, 'http://localhost:3000/', 'New');
    guests = [a, b, g];
    await cdp.guestChanged(g);
    await tick();
    assert.ok(c.events.some(e => e.method === 'Target.attachedToTarget' && e.params.targetInfo.targetId === 'REAL-11'));
    guests = [a, b];
    cdp.guestGone(g);
    await tick();
    assert.ok(c.events.some(e => e.method === 'Target.detachedFromTarget' && e.params.targetId === 'REAL-11'));
    ok('a guest appearing is attached, and one going is detached');

    // ── one client at a time, Stop, and cleaning up ──────────────────────
    const c2 = await connect(version.webSocketDebuggerUrl);
    await c.closed;
    assert.ok(!a.debugger.attached, 'the old client\'s debuggers were let go');
    await c2.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    assert.ok(a.debugger.attached && cdp.isControlled(a));
    let gone = 0;
    cdp.on('disconnect', () => gone++);
    assert.strictEqual(cdp.kick(), true);
    await c2.closed;
    await tick();
    assert.ok(!a.debugger.attached && !b.debugger.attached, 'Stop detaches, which clears what the agent set');
    assert.ok(!cdp.isControlled(a) && !cdp.state().connected && gone === 1);
    assert.ok(states.some(s => s.connected) && !states.at(-1).connected);
    ok('the newest client wins, and Stop disconnects it and detaches every guest');

    // A client whose process exits sends a FIN and nothing more.
    {
        const net = require('net');
        const raw = net.connect(port, '127.0.0.1');
        await new Promise(r => raw.once('connect', r));
        raw.write(`GET /${token}/devtools/browser/x HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n`
            + 'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
        await tick(50);
        assert.ok(cdp.state().connected);
        raw.end();
        await tick(50);
        assert.ok(!cdp.state().connected, 'a half-closed client is gone, not connected forever');
        raw.destroy();
    }
    ok('a client that half-closes is counted as gone');

    // ── off means off ─────────────────────────────────────────────────────
    await cdp.stop();
    await assert.rejects(get(port, `/${token}/json/version`));
    const again = await cdp.start();
    assert.notStrictEqual(again, endpoint, 'a new token each time it is turned on');
    await cdp.stop();
    ok('turning it off closes the port, and turning it on mints a new token');

    // ── the framing ──────────────────────────────────────────────────────
    const got = [];
    const reader = new FrameReader((op, p) => got.push([op, p.toString()]));
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = (op, text, fin = true) => {
        const p = Buffer.from(text);
        const m = Buffer.from(p.map((x, i) => x ^ mask[i & 3]));
        return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | p.length]), mask, m]);
    };
    const both = Buffer.concat([masked(1, '{"a"', false), masked(0, ':1}')]);
    reader.push(both.subarray(0, 5));
    reader.push(both.subarray(5));
    assert.deepStrictEqual(got, [[1, '{"a":1}']], 'fragments and split reads join up');
    assert.throws(() => new FrameReader(() => {}).push(encodeFrame(1, Buffer.from('x'))), /unmasked/);
    assert.strictEqual(encodeFrame(1, Buffer.alloc(70000)).readUInt16BE(0) & 0x7f, 127);
    ok('the WebSocket framing joins fragments and refuses unmasked client frames');

    console.log(`\n${pass} preview-cdp checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
