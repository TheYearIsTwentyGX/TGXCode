'use strict';

// The `preview` MCP server: Playwright MCP, pointed at the browser preview in
// the user's window instead of at a browser of its own.
//
// bridge/runner.js lists this file in a session's `--mcp-config` when
// `preview.agentControl` is on. It does two things and then gets out of the way:
//
//  1. **Starts Playwright MCP** — `npx -y @playwright/mcp@latest`, which is what
//     the user's own Playwright plugin runs — with its stdio passed straight
//     through, so the session speaks MCP to Playwright and not to us. The package
//     can be overridden with TGXCODE_PLAYWRIGHT_MCP (a package spec, or a path to
//     a cli.js) for a pinned or offline copy.
//
//  2. **Relays its CDP connection** to the shell's endpoint (app/preview-cdp.js),
//     through a listener of our own on loopback. Playwright MCP reads its CDP
//     endpoint once, at start, and the shell's endpoint changes every time the
//     app starts or the setting is switched back on; a session that outlives
//     either would otherwise be holding a dead URL. The relay looks the endpoint
//     up again on every connection, in the file bridge/preview-agent.js keeps.
//
// **No token is on a command line.** The relay's URL carries a token minted
// here, and it reaches Playwright MCP in its environment
// (PLAYWRIGHT_MCP_CDP_ENDPOINT), which only this user can read; the shell's token
// stays in the 0600 file. Neither is in the `--mcp-config` blob that `ps` shows.
// Nor is the endpoint set in the *session's* environment: the user's own
// Playwright server reads the same variable and would follow it into the preview.
//
// **When there is no preview to drive** — the setting is on but no desktop window
// has registered, or the window has closed — the relay still answers, as a
// browser that refuses every command with a sentence saying why. Playwright then
// fails with that sentence ("Protocol error (Browser.getVersion): …") rather than
// with "Unexpected status 503", which an agent can do nothing with.

require('./legacy-env');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const previewAgent = require('./preview-agent');
const { FrameReader, encodeFrame } = require('../app/preview-cdp');

function flag(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? null : (process.argv[i + 1] || null);
}

const BRIDGE_PORT = Number(flag('port')) || 0;
const TOKEN = crypto.randomBytes(24).toString('hex');

const UNAVAILABLE = 'TGXCode: there is no browser preview to drive. Agent control is on, but no '
    + 'TGXCode desktop window has it running — the app may be closed, or built before this '
    + 'existed. Tell the user; do not retry in a loop.';

/** The shell's endpoint, or null. */
function shellEndpoint() {
    return BRIDGE_PORT ? previewAgent.read({ port: BRIDGE_PORT }) : null;
}

function authorised(req) {
    if (req.headers.origin) return false;
    const seg = String(req.url || '').split('?')[0].split('/')[1] || '';
    const a = Buffer.from(seg);
    const b = Buffer.from(TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function rest(req) {
    return '/' + String(req.url || '').split('?')[0].split('/').slice(2).join('/');
}

/** GET a path on the shell's endpoint. Resolves with the parsed body, or null. */
function shellGet(ep, p) {
    return new Promise((resolve) => {
        const req = http.get({ host: ep.host, port: ep.port, path: `/${ep.token}${p}`, timeout: 3000 }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode !== 200) return resolve(null);
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

// ── the relay ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    const reply = (code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify(body));
    };
    if (!authorised(req)) return reply(403, { error: 'forbidden' });
    const p = rest(req).replace(/\/+$/, '');
    const ws = `ws://127.0.0.1:${server.address().port}/${TOKEN}/devtools/browser/tgxcode-preview`;
    if (p === '/json/version') {
        const ep = shellEndpoint();
        const v = ep && await shellGet(ep, '/json/version');
        // Either way the WebSocket comes back through here, so the endpoint is
        // looked up again at the moment Playwright connects.
        return reply(200, { ...(v || { Browser: 'TGXCode preview (unavailable)', 'Protocol-Version': '1.3' }), webSocketDebuggerUrl: ws });
    }
    if (p === '/json' || p === '/json/list') {
        const ep = shellEndpoint();
        return reply(200, (ep && await shellGet(ep, '/json/list')) || []);
    }
    return reply(404, { error: 'not found' });
});

server.on('upgrade', (req, socket, head) => {
    if (!authorised(req) || !/^\/devtools\/browser(\/|$)/.test(rest(req))) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
    }
    const ep = shellEndpoint();
    if (!ep) return refuseAsBrowser(req, socket);
    const upstream = net.connect({ host: ep.host, port: ep.port });
    let linked = false;
    upstream.once('connect', () => {
        linked = true;
        // The request line and Host are the shell's; the rest of the handshake —
        // the key, the version — is Playwright's own, passed through untouched.
        const lines = [`GET /${ep.token}/devtools/browser/tgxcode-preview HTTP/1.1`, `Host: 127.0.0.1:${ep.port}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const k = req.rawHeaders[i];
            if (/^(host|origin)$/i.test(k)) continue;
            lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
        }
        upstream.write(lines.join('\r\n') + '\r\n\r\n');
        if (head && head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.on('close', () => upstream.destroy());
        upstream.on('close', () => socket.destroy());
    });
    // Never connected: the file names a window that is not there any more.
    upstream.once('error', () => {
        if (linked) socket.destroy();
        else if (!socket.destroyed) refuseAsBrowser(req, socket);
    });
    socket.on('error', () => upstream.destroy());
});

/** Accept the WebSocket and answer every command with UNAVAILABLE. See the header. */
function refuseAsBrowser(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const reader = new FrameReader((op, payload) => {
        if (op === 0x8) { socket.end(); return; }
        if (op !== 0x1) return;
        let msg;
        try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
        if (typeof msg.id !== 'number') return;
        const out = { id: msg.id, error: { code: -32000, message: UNAVAILABLE } };
        if (msg.sessionId) out.sessionId = msg.sessionId;
        socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(out))));
    });
    socket.on('data', (c) => { try { reader.push(c); } catch { socket.destroy(); } });
    socket.on('error', () => socket.destroy());
}

// ── Playwright MCP ───────────────────────────────────────────────────────

/** [command, args] for Playwright MCP. */
function playwrightCommand(env = process.env) {
    const spec = env.TGXCODE_PLAYWRIGHT_MCP || '@playwright/mcp@latest';
    if (/\.(c|m)?js$/.test(spec)) return [process.execPath, [spec]];
    // npx beside the node running us: a login shell has none on PATH (bridge/launch.sh).
    const beside = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npx.cmd' : 'npx');
    return [fs.existsSync(beside) ? beside : 'npx', ['-y', spec]];
}

/** The environment Playwright MCP gets: ours, minus its own settings, plus the relay. */
function playwrightEnv(endpoint, env = process.env) {
    const out = {};
    for (const [k, v] of Object.entries(env)) {
        // Headless, a user data dir, an extension: all about a browser of its own,
        // and some of them would make it launch one instead of connecting.
        if (!k.startsWith('PLAYWRIGHT_MCP_')) out[k] = v;
    }
    out.PLAYWRIGHT_MCP_CDP_ENDPOINT = endpoint;
    return out;
}

function main() {
    server.listen(0, '127.0.0.1', () => {
        const endpoint = `http://127.0.0.1:${server.address().port}/${TOKEN}`;
        const [cmd, args] = playwrightCommand();
        const child = spawn(cmd, args, { stdio: 'inherit', env: playwrightEnv(endpoint) });
        child.on('error', (err) => {
            process.stderr.write(`[preview] could not start Playwright MCP (${cmd}): ${err.message}\n`);
            process.exit(1);
        });
        child.on('exit', (code, signal) => process.exit(code == null ? (signal ? 1 : 0) : code));
        for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
            process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
        }
    });
}

if (require.main === module) main();

module.exports = { playwrightCommand, playwrightEnv, server, TOKEN, UNAVAILABLE };
