'use strict';

// The askpass helper's body — see bridge/sudo-askpass for how it is started and
// bridge/sudo.js for the whole design.
//
// It sends the bridge one thing, its own pid, and the bridge reads everything it
// shows you about the command out of /proc for itself. It then waits — with no
// timeout of its own, because sudo-rs has none either — and either prints the
// password on stdout, once, for sudo to read, or says on stderr why not and exits
// non-zero, which sudo reports as a failed authentication.
//
// Three things end the wait besides an answer:
//   - sudo going away (the Bash call was stopped or timed out): our parent pid
//     changes, and we exit, which closes the connection, which takes the card down;
//   - the bridge going away before answering: a restart, usually. We ask again,
//     for up to RETRY_MS, so an ask survives `npm run land` restarting it;
//   - the bridge refusing outright — switched off, or not a session of its.
//
// Nothing here writes the password anywhere but stdout, and nothing here logs a
// response body.

const http = require('http');

const KEY = process.env.TGXCODE_SUDO_KEY;
const PORT = Number(process.env.TGXCODE_SUDO_PORT);
const RETRY_MS = 90_000;

const say = (line) => process.stderr.write(`TGXCode: ${line}\n`);

if (!KEY || !Number.isInteger(PORT) || PORT <= 0) {
    say('this session was not started with sudo approval. Turn it on in Settings › Sudo '
        + 'and restart the session.');
    process.exit(1);
}

// sudo is our parent. If it goes, so do we: an orphaned helper would hold a
// card open for a command that can no longer run.
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(1); }, 1000).unref();

const started = Date.now();

function ask() {
    const body = JSON.stringify({ pid: process.pid });
    const req = http.request({
        host: '127.0.0.1', port: PORT, method: 'POST', path: '/api/sudo/ask',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'X-TGXCode-Client': '1',
            'X-TGXCode-Sudo-Key': KEY,
        },
    }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => answer(res.statusCode, Buffer.concat(chunks)));
        res.on('error', retry);
    });
    req.on('error', retry);
    req.end(body);
}

function retry() {
    if (Date.now() - started > RETRY_MS) {
        say('could not reach the TGXCode bridge to ask for approval.');
        process.exit(1);
    }
    setTimeout(ask, 2000);
}

function answer(status, raw) {
    let out = {};
    try { out = JSON.parse(raw.toString('utf8')); } catch { /* said below */ }
    if (status === 200 && typeof out.password === 'string') {
        process.stdout.write(`${out.password}\n`, () => process.exit(0));
        return;
    }
    if (status === 200 && out.denied) {
        say(`sudo was not approved (${out.reason || 'denied'}). Do not run it again; `
            + 'tell the user what needed root, or ask them how to proceed.');
    } else {
        say(`sudo approval refused: ${out.error || `HTTP ${status}`}.`);
    }
    process.exit(1);
}

ask();
