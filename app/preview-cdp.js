'use strict';

// An agent driving the browser preview: a Chrome DevTools Protocol endpoint
// with nothing in it but the preview's pages.
//
// Playwright reaches a browser by CDP, and the obvious way to give it one is
// Chromium's own `--remote-debugging-port`. That was rejected, for three reasons:
//
//  - **It is the whole app.** The port lists the shell's own window as a page
//    beside the preview's guests, and an agent attached to it can read the
//    bridge token out of its `<meta>` tag and click Approve on its own cards. A
//    filtering proxy in front only helps if nothing can go round it, and the raw
//    port is still sitting on loopback with no token of its own.
//  - **It is fixed at launch.** The switch has to be on the command line before
//    `ready`, so a Settings toggle would mean restarting the window.
//  - **It cannot be taken back.** Stop would have to be a promise that every
//    client honours, not something the shell does.
//
// So nothing here is Chromium's endpoint. Each preview guest is reached through
// Electron's in-process `webContents.debugger`, one guest at a time, and this
// file *pretends to be a browser* in front of them: it answers the handful of
// browser-level commands Playwright's `connectOverCDP` sends (Browser.getVersion,
// Target.setAutoAttach, Target.getTargets, …) out of a list that only ever holds
// preview guests, and relays everything addressed to a page to that guest's
// debugger. A target that is not a preview guest is not filtered out; it was
// never in the list. The shell's own window cannot be attached to because no
// path here reaches its webContents.
//
// Two things are rewritten on the way through, and both are load-bearing:
//
//  - **A guest is reported as `type: 'page'`.** Chromium calls it `webview`, and
//    Playwright detaches from any type it does not handle — an Electron webview
//    arrives, is dropped, and the agent sees an empty browser.
//  - **Its targetId is its real one**, read from the guest with
//    Target.getTargetInfo. Playwright finds the session for a frame by walking
//    up to a frame whose id is a session's targetId; a made-up id would leave
//    the main frame with no session and every action failing as "detached".
//
// What is refused even on a page's own session: anything in the Target domain
// that reaches past the page (createTarget, attachToTarget, attachToBrowserTarget
// — a guest's debugger is a client of the whole DevTools host), the Browser and
// Tethering domains, Page.close, and a top-level Page.navigate to a site the user
// has not approved. That last one is asked of `navigationRefusal`, which is
// app/preview-grants.js: loopback is free, any other origin needs the user's yes,
// and asking for one raises the prompt. It has to be checked here because
// will-navigate fires for a page's own navigations and not for one CDP asks for.

// One client at a time. The newest connection wins and the older one is closed:
// the session that is asking now is the one the user just asked, and a session
// that used the preview an hour ago keeps its Playwright connection open for as
// long as its process lives. When the last client goes, every guest's debugger is
// detached, which is what clears whatever Playwright left set on the page —
// injected scripts, emulation, request interception — rather than leaving the
// user a page that behaves strangely after the agent has gone.
//
// The URL carries a random token, minted when the endpoint starts, and only
// loopback is listened on. Requests that carry an `Origin` header are refused:
// Playwright does not send one and a web page cannot avoid it.
//
// Nothing in here requires electron, so test/preview-cdp.test.js drives it with
// fake guests. app/main.js supplies the real ones.

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONTEXT_ID = 'TGXCODEPREVIEWCONTEXT';
const MAX_FRAME = 64 * 1024 * 1024;   // a full-page screenshot comes back as one message
const PING_MS = 20_000;

// Keystrokes go to whichever page has the keyboard focus, and Chromium routes
// them there whatever the agent focused with script: an `Input.insertText` into a
// guest that does not have focus is dropped without an error, so Playwright's
// fill() appears to work and the field stays empty. Measured, and two things that
// look as though they should help do not: the guest's `isFocused()` says yes
// throughout, and `webContents.focus()` on it changes nothing. What works is the
// `<webview>` element having focus in the window around it — which is also how
// the picker in web/preview.js gives a guest the keys. So before a keystroke the
// endpoint asks for that (`o.focusGuest`, app/main.js). It takes the keyboard from
// wherever the user was typing, which is the honest consequence of an agent
// typing into the page they are watching.
const KEYBOARD = new Set(['Input.insertText', 'Input.dispatchKeyEvent', 'Input.imeSetComposition']);

// ── websocket, server side ───────────────────────────────────────────────
// Enough of RFC 6455 for one JSON-speaking client: text frames in either
// direction, fragmentation, ping, close. Client frames are masked; ours are not.

function encodeFrame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) {
        head = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
    } else {
        head = Buffer.alloc(10);
        head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([head, payload]);
}

/** Feeds bytes in, calls back with whole messages. Throws on a protocol error. */
class FrameReader {
    constructor(onMessage) {
        this.buf = Buffer.alloc(0);
        this.parts = [];
        this.partOp = 0;
        this.onMessage = onMessage;
    }

    push(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        for (;;) {
            const b = this.buf;
            if (b.length < 2) return;
            const fin = (b[0] & 0x80) !== 0;
            const opcode = b[0] & 0x0f;
            const masked = (b[1] & 0x80) !== 0;
            let len = b[1] & 0x7f;
            let off = 2;
            if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
            else if (len === 127) {
                if (b.length < 10) return;
                const big = b.readBigUInt64BE(2);
                if (big > BigInt(MAX_FRAME)) throw new Error('frame too large');
                len = Number(big); off = 10;
            }
            if (!masked) throw new Error('unmasked client frame');
            if (b.length < off + 4 + len) return;
            const mask = b.subarray(off, off + 4);
            const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            this.buf = b.subarray(off + 4 + len);

            if (opcode >= 0x8) { this.onMessage(opcode, payload); continue; }
            if (opcode !== 0) { this.partOp = opcode; this.parts = []; }
            this.parts.push(payload);
            if (this.parts.reduce((n, p) => n + p.length, 0) > MAX_FRAME) throw new Error('message too large');
            if (fin) {
                const whole = Buffer.concat(this.parts);
                this.parts = [];
                this.onMessage(this.partOp, whole);
            }
        }
    }
}

// ── what a page session may not do ───────────────────────────────────────

// The Target domain on a page's session is how a debugger client reaches *other*
// targets. These are the parts that only ever concern the page and its own
// frames and workers, which Playwright needs; everything else is refused.
const PAGE_TARGET_OK = new Set([
    'Target.setAutoAttach', 'Target.detachFromTarget', 'Target.getTargetInfo',
    'Target.setDiscoverTargets',
]);

/**
 * Why a command on a page's session is refused, or null if it may go through.
 * `topLevel` is whether it addresses the page's main frame, which is the only
 * navigation that is gated.
 */
function refusal(method, params, navigationRefusal, topLevel = true) {
    const domain = method.split('.')[0];
    if (domain === 'Target' && !PAGE_TARGET_OK.has(method)) return `TGXCode: ${method} is not available on the preview`;
    if (domain === 'Browser' && method !== 'Browser.getVersion') return `TGXCode: ${method} is not available on the preview`;
    if (domain === 'Tethering') return `TGXCode: ${method} is not available on the preview`;
    if (method === 'Page.close' || method === 'Page.crash') {
        return 'TGXCode: the preview page belongs to the user; it cannot be closed from here';
    }
    if (method === 'Page.navigate' && topLevel) {
        const url = params && params.url;
        if (typeof url !== 'string') return 'TGXCode: Page.navigate needs a url';
        return navigationRefusal(url);
    }
    return null;
}

// ── the endpoint ─────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {() => object[]} o.guests  the preview's guest webContents, active one first
 * @param {(url: string) => string|null} o.navigationRefusal  why a top-level
 *   navigation is refused (the whole text an agent reads), or null to allow it
 * @param {(wc: object) => Promise<void>} [o.focusGuest]  give a guest the keyboard;
 *   see KEYBOARD
 * @param {string} [o.product]   e.g. `Chrome/126.0.6478.234`
 * @param {string} [o.userAgent]
 *
 * Emits `state` with {connected, active, pages} when that changes, and at most
 * once a second while commands are flowing; `disconnect` when a client goes.
 */
class PreviewCdp extends EventEmitter {
    constructor(o) {
        super();
        this.o = o;
        this.server = null;
        this.port = 0;
        this.token = null;
        this.client = null;           // the one connected socket's state, or null
        this.targetIds = new Map();   // webContents id -> real targetId
        this.lastCommandAt = 0;
        this._activityTimer = null;
    }

    get endpoint() {
        return this.server ? `http://127.0.0.1:${this.port}/${this.token}` : null;
    }

    /** Listen on loopback. Resolves with the endpoint; idempotent. */
    start({ port = 0 } = {}) {
        if (this.server) return Promise.resolve(this.endpoint);
        this.token = crypto.randomBytes(24).toString('hex');
        const server = http.createServer((req, res) => this._http(req, res));
        server.on('upgrade', (req, socket) => this._upgrade(req, socket));
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => {
                server.off('error', reject);
                this.server = server;
                this.port = server.address().port;
                resolve(this.endpoint);
            });
        });
    }

    /** Close the client and the listener, and forget the token. */
    async stop() {
        this.kick('preview control was turned off');
        const s = this.server;
        this.server = null;
        this.token = null;
        if (s) await new Promise(r => s.close(() => r()));
    }

    /** Disconnect whoever is connected. The page stays as it is. */
    kick(reason = 'stopped by the user') {
        const c = this.client;
        if (!c) return false;
        this._closeClient(c, 1000, reason);
        return true;
    }

    /** Whether an agent is attached to this guest right now. */
    isControlled(wc) {
        return Boolean(this.client && this._sessionFor(this.client, wc));
    }

    state() {
        const c = this.client;
        const pages = c ? [...c.sessions.values()].map(s => ({
            url: safe(() => s.wc.getURL(), ''),
            webContentsId: s.wc.id,
        })) : [];
        return {
            connected: Boolean(c),
            active: Boolean(c) && Date.now() - this.lastCommandAt < 3000,
            pages,
        };
    }

    // ── guests coming and going (called by app/main.js) ─────────────────

    /** A preview guest appeared, or navigated. */
    async guestChanged(wc) {
        const c = this.client;
        if (!c) return;
        let sess = this._sessionFor(c, wc);
        if (sess) {
            if (c.discover) {
                this._send(c, { method: 'Target.targetInfoChanged', params: { targetInfo: await this._info(wc, true) } });
            }
            return;
        }
        if (c.discover) {
            this._send(c, { method: 'Target.targetCreated', params: { targetInfo: await this._info(wc, false) } });
        }
        if (c.autoAttach && this.client === c && !this._sessionFor(c, wc)) {
            sess = await this._attach(c, wc).catch(() => null);
            if (sess) this._announce(c, sess);
        }
    }

    /** A preview guest is going away. */
    guestGone(wc) {
        const targetId = this.targetIds.get(wc.id);
        this.targetIds.delete(wc.id);
        const c = this.client;
        if (!c) return;
        const sess = this._sessionFor(c, wc);
        if (sess) this._dropSession(c, sess, true);
        if (c.discover && targetId) this._send(c, { method: 'Target.targetDestroyed', params: { targetId } });
    }

    // ── http ─────────────────────────────────────────────────────────────

    _authorised(req) {
        if (req.headers.origin) return false;
        const host = String(req.headers.host || '').replace(/:\d+$/, '');
        if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return false;
        const seg = String(req.url || '').split('?')[0].split('/')[1] || '';
        const a = Buffer.from(seg);
        const b = Buffer.from(this.token || '');
        return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
    }

    _rest(req) {
        return '/' + String(req.url || '').split('?')[0].split('/').slice(2).join('/');
    }

    async _http(req, res) {
        const reply = (code, body) => {
            res.writeHead(code, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body));
        };
        if (!this._authorised(req)) return reply(403, { error: 'forbidden' });
        const rest = this._rest(req).replace(/\/+$/, '');
        if (req.method !== 'GET' && req.method !== 'PUT') return reply(405, { error: 'method not allowed' });
        if (rest === '/json/version') {
            return reply(200, {
                Browser: this.o.product || 'Chrome',
                'Protocol-Version': '1.3',
                'User-Agent': this.o.userAgent || '',
                webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/${this.token}/devtools/browser/tgxcode-preview`,
            });
        }
        if (rest === '/json' || rest === '/json/list') {
            const list = [];
            for (const wc of this._guests()) {
                const info = await this._info(wc, false).catch(() => null);
                if (info) list.push({ id: info.targetId, type: 'page', title: info.title, url: info.url, description: '' });
            }
            return reply(200, list);
        }
        if (rest === '/json/protocol') return reply(404, { error: 'not available' });
        return reply(404, { error: 'not found' });
    }

    _upgrade(req, socket) {
        const refuse = (code, text) => {
            socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        };
        if (!this._authorised(req)) return refuse(403, 'Forbidden');
        if (!/^\/devtools\/browser(\/|$)/.test(this._rest(req))) return refuse(404, 'Not Found');
        const key = req.headers['sec-websocket-key'];
        if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return refuse(400, 'Bad Request');
        const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.setNoDelay(true);

        // The newest connection wins; see the header.
        if (this.client) this._closeClient(this.client, 1000, 'another agent connected to the preview');

        const c = {
            socket,
            sessions: new Map(),     // our sessionId -> {id, wc, dbg, onMessage, onDetach, children:Set}
            children: new Map(),     // a child session id Chromium minted -> our session
            autoAttach: false,
            discover: false,
            closed: false,
        };
        this.client = c;
        const reader = new FrameReader((op, payload) => this._frame(c, op, payload));
        socket.on('data', (chunk) => {
            try { reader.push(chunk); } catch { this._closeClient(c, 1002, 'protocol error'); }
        });
        // `end` as well as `close`: an upgraded socket from http.Server is
        // half-open, so a client that goes away sends a FIN that never becomes a
        // `close` until we end our side — and the banner would say an agent is
        // connected long after its process has exited.
        socket.on('end', () => this._closeClient(c));
        socket.on('close', () => this._closeClient(c));
        socket.on('error', () => this._closeClient(c));
        // And a client that vanished without a FIN — a WSL network hiccup, a
        // machine asleep — is found by not answering a ping.
        c.lastPong = Date.now();
        c.pinger = setInterval(() => {
            if (Date.now() - c.lastPong > PING_MS * 2.5) { this._closeClient(c, 1001, 'no answer to ping'); return; }
            try { socket.write(encodeFrame(0x9, Buffer.alloc(0))); } catch { /* closing */ }
        }, PING_MS);
        c.pinger.unref?.();
        this._emitState();
    }

    _frame(c, op, payload) {
        if (op === 0x8) return this._closeClient(c, 1000, '');
        if (op === 0x9) { if (!c.closed) c.socket.write(encodeFrame(0xA, payload)); return; }
        if (op === 0xA) { c.lastPong = Date.now(); return; }
        if (op !== 0x1 && op !== 0x2) return;
        let msg;
        try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
        if (!msg || typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
        this.lastCommandAt = Date.now();
        this._activity();
        this._command(c, msg).catch((err) => {
            this._send(c, { id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message: String(err && err.message || err) } });
        });
    }

    _send(c, obj) {
        if (c.closed) return;
        if (obj.sessionId === undefined) delete obj.sessionId;
        try { c.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj)))); } catch { /* closing */ }
    }

    _closeClient(c, code, reason) {
        if (c.closed) return;
        c.closed = true;
        clearInterval(c.pinger);
        if (code) {
            const r = Buffer.from(String(reason || '').slice(0, 120));
            const body = Buffer.alloc(2 + r.length);
            body.writeUInt16BE(code, 0); r.copy(body, 2);
            try { c.socket.write(encodeFrame(0x8, body)); } catch { /* gone */ }
        }
        try { c.socket.end(); } catch { /* gone */ }
        setTimeout(() => { try { c.socket.destroy(); } catch { /* gone */ } }, 500).unref?.();
        for (const sess of [...c.sessions.values()]) this._dropSession(c, sess, false);
        if (this.client === c) this.client = null;
        this._emitState();
        this.emit('disconnect');
    }

    // ── commands ─────────────────────────────────────────────────────────

    async _command(c, msg) {
        const { id, method, sessionId } = msg;
        const params = msg.params || {};
        if (sessionId) return this._pageCommand(c, msg);

        const ok = (result) => this._send(c, { id, result: result || {} });
        const fail = (message) => this._send(c, { id, error: { code: -32000, message } });

        switch (method) {
            case 'Browser.getVersion':
                return ok({
                    protocolVersion: '1.3',
                    product: this.o.product || 'Chrome',
                    revision: '',
                    userAgent: this.o.userAgent || '',
                    jsVersion: '',
                });
            case 'Target.setAutoAttach': {
                c.autoAttach = Boolean(params.autoAttach);
                if (c.autoAttach) {
                    for (const wc of this._guests()) {
                        if (this._sessionFor(c, wc)) continue;
                        const sess = await this._attach(c, wc).catch(() => null);
                        if (sess) this._announce(c, sess);
                    }
                }
                return ok({});
            }
            case 'Target.setDiscoverTargets': {
                c.discover = Boolean(params.discover);
                ok({});
                if (c.discover) {
                    for (const wc of this._guests()) {
                        const info = await this._info(wc, Boolean(this._sessionFor(c, wc))).catch(() => null);
                        if (info) this._send(c, { method: 'Target.targetCreated', params: { targetInfo: info } });
                    }
                }
                return;
            }
            case 'Target.getTargets': {
                const targetInfos = [];
                for (const wc of this._guests()) {
                    const info = await this._info(wc, Boolean(this._sessionFor(c, wc))).catch(() => null);
                    if (info) targetInfos.push(info);
                }
                return ok({ targetInfos });
            }
            case 'Target.getTargetInfo': {
                if (!params.targetId) {
                    return ok({ targetInfo: { targetId: 'tgxcode-preview', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } });
                }
                const wc = await this._byTargetId(params.targetId);
                if (!wc) return fail('No target with given id found');
                return ok({ targetInfo: await this._info(wc, Boolean(this._sessionFor(c, wc))) });
            }
            case 'Target.attachToTarget': {
                const wc = await this._byTargetId(params.targetId);
                if (!wc) return fail('No target with given id found');
                const sess = this._sessionFor(c, wc) || await this._attach(c, wc);
                ok({ sessionId: sess.id });
                return this._announce(c, sess);
            }
            case 'Target.detachFromTarget': {
                const sess = c.sessions.get(params.sessionId);
                if (sess) this._dropSession(c, sess, true);
                return ok({});
            }
            case 'Target.activateTarget':
                return ok({});
            case 'Target.getBrowserContexts':
                return ok({ browserContextIds: [] });
            case 'Target.createTarget':
                return fail('TGXCode: an agent cannot open a page here. Ask the tgxcode server to open_in_preview, then use the page that appears.');
            case 'Target.closeTarget':
                return fail('TGXCode: the preview page belongs to the user; it cannot be closed from here');
            // Playwright sets these up on its default context; there is nothing to set.
            case 'Browser.setDownloadBehavior':
            case 'Target.autoAttachRelated':
                return ok({});
            default:
                return fail(`${method} is not available on the preview`);
        }
    }

    async _pageCommand(c, msg) {
        const { id, method, sessionId } = msg;
        const params = msg.params || {};
        const own = c.sessions.get(sessionId);
        const sess = own || c.children.get(sessionId);
        if (!sess) {
            return this._send(c, { id, sessionId, error: { code: -32001, message: `Session with given id not found.` } });
        }
        const topLevel = Boolean(own) && (!params.frameId || params.frameId === sess.targetId);
        const why = refusal(method, params, this.o.navigationRefusal || (() => 'TGXCode: navigation is not available'), topLevel);
        if (why) return this._send(c, { id, sessionId, error: { code: -32000, message: why } });
        if (KEYBOARD.has(method) && this.o.focusGuest) await Promise.resolve(this.o.focusGuest(sess.wc)).catch(() => {});
        // Page.reload on a guest's debugger reloads the *outer* WebContents —
        // this app's own window — in Electron 31, measured: the shell reloaded and
        // every preview page with it. So it never reaches the debugger; the guest
        // is reloaded by its own webContents, and Playwright sees the navigation
        // it was waiting for through the debugger as usual.
        if (method === 'Page.reload' && own) {
            safe(() => (params.ignoreCache ? sess.wc.reloadIgnoringCache() : sess.wc.reload()));
            return this._send(c, { id, sessionId, result: {} });
        }
        try {
            const result = own
                ? await sess.dbg.sendCommand(method, params)
                : await sess.dbg.sendCommand(method, params, sessionId);
            this._send(c, { id, sessionId, result: result || {} });
        } catch (err) {
            this._send(c, { id, sessionId, error: { code: -32000, message: String(err && err.message || err) } });
        }
    }

    // ── sessions ─────────────────────────────────────────────────────────

    _guests() {
        try { return (this.o.guests() || []).filter(wc => wc && !safe(() => wc.isDestroyed(), true)); }
        catch { return []; }
    }

    // By id: the webContents app/main.js hands to an event handler and the one
    // getAllWebContents() lists need not be the same JS object.
    _sessionFor(c, wc) {
        for (const s of c.sessions.values()) if (s.wc === wc || (wc && s.wc.id === wc.id)) return s;
        return null;
    }

    async _byTargetId(targetId) {
        for (const wc of this._guests()) {
            if (await this._targetId(wc).catch(() => null) === targetId) return wc;
        }
        return null;
    }

    /** The guest's own targetId, which is its main frame's id. See the header. */
    async _targetId(wc) {
        const known = this.targetIds.get(wc.id);
        if (known) return known;
        const dbg = wc.debugger;
        const mine = !dbg.isAttached();
        if (mine) dbg.attach('1.3');
        try {
            const r = await dbg.sendCommand('Target.getTargetInfo');
            const id = r && r.targetInfo && r.targetInfo.targetId;
            if (!id) throw new Error('no targetId');
            this.targetIds.set(wc.id, id);
            return id;
        } finally {
            // Only let go if nobody is using it: a client may have attached
            // while we were asking.
            if (mine && !this._attachedAnywhere(wc)) safe(() => dbg.detach());
        }
    }

    _attachedAnywhere(wc) {
        return Boolean(this.client && this._sessionFor(this.client, wc));
    }

    async _info(wc, attached) {
        return {
            targetId: await this._targetId(wc),
            type: 'page',
            title: safe(() => wc.getTitle(), ''),
            url: safe(() => wc.getURL(), ''),
            attached,
            canAccessOpener: false,
            browserContextId: CONTEXT_ID,
        };
    }

    async _attach(c, wc) {
        const targetId = await this._targetId(wc);
        if (c.closed) throw new Error('closed');
        const existing = this._sessionFor(c, wc);
        if (existing) return existing;
        const dbg = wc.debugger;
        if (!dbg.isAttached()) dbg.attach('1.3');
        const sess = {
            id: crypto.randomBytes(16).toString('hex').toUpperCase(),
            wc, dbg, targetId,
            children: new Set(),
            announced: false,
        };
        sess.onMessage = (_e, method, params, childId) => {
            if (c.closed) return;
            if (method === 'Target.attachedToTarget' && params && params.sessionId) {
                sess.children.add(params.sessionId);
                c.children.set(params.sessionId, sess);
            } else if (method === 'Target.detachedFromTarget' && params && params.sessionId) {
                sess.children.delete(params.sessionId);
                c.children.delete(params.sessionId);
            }
            if (childId) this._send(c, { method, params, sessionId: childId });
            else this._fromPage(c, sess, method, params || {});
        };
        sess.onDetach = () => {
            if (c.sessions.get(sess.id) === sess) this._dropSession(c, sess, true, true);
        };
        dbg.on('message', sess.onMessage);
        dbg.on('detach', sess.onDetach);
        c.sessions.set(sess.id, sess);
        this._emitState();
        return sess;
    }

    // ── the navigation a guest forgets to report ─────────────────────────
    //
    // A cross-site navigation swaps a guest's renderer process, and after the swap
    // its debugger reports everything about the new document — the lifecycle
    // events, the execution contexts — except Page.frameNavigated. Measured on
    // Electron 31 going from a local page to example.com. Playwright commits a
    // navigation on that event, so without it page.goto() waits out its timeout
    // and every later action waits on a navigation that "has not finished".
    //
    // So: when the main frame starts a document (`init`) whose frameNavigated has
    // not been seen, its events are held. If frameNavigated turns up, it and the
    // held events go out as they came. If instead the new document's default
    // execution context appears — which in an ordinary navigation comes after
    // frameNavigated — or a second passes, the frame is read with
    // Page.getFrameTree and a frameNavigated made from it goes out first, then
    // what was held. Same-site navigations report it themselves and pass through
    // with nothing held for longer than it takes the event to arrive.

    _fromPage(c, sess, method, params) {
        const out = { method, params, sessionId: sess.id };
        const nav = sess.nav || (sess.nav = { pending: null, held: null, seen: new Set(), timer: null, asking: false });
        if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
            if (nav.seen.size > 50) nav.seen.clear();
            nav.seen.add(params.frame.loaderId);
            if (nav.held) { nav.held.push(out); this._release(c, sess); } else this._send(c, out);
            return;
        }
        if (nav.held) {
            nav.held.push(out);
            const ctx = method === 'Runtime.executionContextCreated' && params.context && params.context.auxData;
            if (ctx && ctx.isDefault && ctx.frameId === sess.targetId) this._recover(c, sess);
            return;
        }
        this._send(c, out);
        if (method === 'Page.lifecycleEvent' && params.name === 'init' && params.frameId === sess.targetId
            && params.loaderId && !nav.seen.has(params.loaderId)) {
            nav.pending = params.loaderId;
            nav.held = [];
            nav.timer = setTimeout(() => this._recover(c, sess), 1000);
            nav.timer.unref?.();
        }
    }

    _recover(c, sess) {
        const nav = sess.nav;
        if (!nav.held || nav.asking) return;
        nav.asking = true;
        const mine = nav.held;
        sess.dbg.sendCommand('Page.getFrameTree').then((r) => {
            const frame = r && r.frameTree && r.frameTree.frame;
            if (frame && nav.held === mine && !nav.seen.has(frame.loaderId)) {
                nav.seen.add(frame.loaderId);
                this._send(c, { method: 'Page.frameNavigated', params: { frame, type: 'Navigation' }, sessionId: sess.id });
            }
        }).catch(() => { /* the page went; what was held still goes */ })
            // Unless the real one came meanwhile and released them already.
            .finally(() => { if (nav.held === mine) this._release(c, sess); });
    }

    _release(c, sess) {
        const nav = sess.nav;
        clearTimeout(nav.timer);
        const held = nav.held || [];
        nav.held = null;
        nav.pending = null;
        nav.asking = false;
        for (const out of held) this._send(c, out);
    }

    _announce(c, sess) {
        if (sess.announced) return;
        sess.announced = true;
        this._send(c, {
            method: 'Target.attachedToTarget',
            params: {
                sessionId: sess.id,
                targetInfo: {
                    targetId: sess.targetId, type: 'page',
                    title: safe(() => sess.wc.getTitle(), ''), url: safe(() => sess.wc.getURL(), ''),
                    attached: true, canAccessOpener: false, browserContextId: CONTEXT_ID,
                },
                waitingForDebugger: false,
            },
        });
    }

    _dropSession(c, sess, tell, alreadyDetached = false) {
        c.sessions.delete(sess.id);
        for (const child of sess.children) c.children.delete(child);
        safe(() => sess.dbg.removeListener('message', sess.onMessage));
        safe(() => sess.dbg.removeListener('detach', sess.onDetach));
        // Detaching is what clears what the agent set on the page. See the header.
        if (!alreadyDetached && !this._attachedAnywhere(sess.wc)) {
            safe(() => { if (sess.dbg.isAttached()) sess.dbg.detach(); });
        }
        if (tell && sess.announced) {
            this._send(c, { method: 'Target.detachedFromTarget', params: { sessionId: sess.id, targetId: sess.targetId } });
        }
        this._emitState();
    }

    // ── telling the window ───────────────────────────────────────────────

    _emitState() {
        this.emit('state', this.state());
    }

    // While commands flow, say so at most once a second, and again once they
    // have stopped long enough for `active` to have gone false.
    _activity() {
        if (this._activityTimer) return;
        this._emitState();
        const tick = () => {
            this._emitState();
            const quiet = Date.now() - this.lastCommandAt;
            this._activityTimer = this.client && quiet < 3000
                ? setTimeout(tick, Math.max(1000, 3050 - quiet))
                : null;
            this._activityTimer?.unref?.();
        };
        this._activityTimer = setTimeout(tick, 1000);
        this._activityTimer.unref?.();
    }
}

function safe(fn, fallback) {
    try { return fn(); } catch { return fallback; }
}

module.exports = { PreviewCdp, FrameReader, encodeFrame, refusal, CONTEXT_ID };
