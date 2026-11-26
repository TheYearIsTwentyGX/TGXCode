#!/usr/bin/env node
'use strict';

// A `codex` that replays a recorded app-server conversation. Point
// TGXCODE_CODEX_BIN at it (through a shebanged copy — see test/codex-rpc.test.js)
// and set:
//
//   FAKE_CODEX_FIXTURE  path to a `<scenario>.ndjson` written by record.js
//   FAKE_CODEX_LOG      optional; every client message and every mismatch is
//                       appended here as a JSON line, which is how a test tells
//                       "replayed faithfully" from "replayed something"
//
// It accepts the argv the real one does (`app-server -c … --listen stdio://`) and
// ignores it. The replay is a walk down the fixture: every `recv` line is written
// at once; at a `send` line it waits for the client's next message and checks it
// is the same kind of thing — the same method, or an answer to the same
// server-request id. Request ids are remapped, because a client numbers its own
// requests and need not start where the recorder did; server-request ids are
// written verbatim and must come back verbatim.
//
// Timing is not replayed. Order is, and order is what a client depends on; a
// test that needed the gaps would be testing the network.
//
// A mismatch is logged and the walk carries on, so a test sees every divergence
// rather than the first. When the fixture runs out the stub stays up until stdin
// ends, as the real server does, and logs anything else it is sent as `extra`.

const fs = require('fs');
const readline = require('readline');

const FIXTURE = process.env.FAKE_CODEX_FIXTURE;
const LOG = process.env.FAKE_CODEX_LOG;

if (process.argv[2] === '--version') {
    process.stdout.write('codex-cli 0.172.0\n');
    process.exit(0);
}
if (!FIXTURE) {
    process.stderr.write('stub: FAKE_CODEX_FIXTURE is not set\n');
    process.exit(2);
}

const entries = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const log = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify(o) + '\n');

const idMap = new Map();   // recorded client id → live client id
let at = 0;
let waiting = null;        // the `send` entry we are waiting to see

function out(msg) {
    // A response to one of the client's own requests carries its live id.
    if (msg.method === undefined && idMap.has(msg.id)) msg = { ...msg, id: idMap.get(msg.id) };
    process.stdout.write(JSON.stringify(msg) + '\n');
}

function advance() {
    while (at < entries.length && entries[at].dir === 'recv') out(entries[at++].msg);
    waiting = at < entries.length ? entries[at] : null;
}

function kind(m) {
    if (typeof m.method === 'string') return (m.id === undefined ? 'notify:' : 'request:') + m.method;
    return 'response:' + (m.error ? 'error' : 'result');
}

function onClient(m) {
    log({ got: m });
    if (!waiting) { log({ extra: m }); return; }
    const want = waiting.msg;
    const ok = kind(m) === kind(want)
        && (typeof want.method === 'string' || m.id === want.id);
    if (!ok) log({ mismatch: { at, want: kind(want), wantId: want.id, got: kind(m), gotId: m.id } });
    if (typeof want.method === 'string' && want.id !== undefined && m.id !== undefined) {
        idMap.set(want.id, m.id);
    }
    at++;
    advance();
}

advance();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { log({ unparsable: line }); return; }
    onClient(m);
}).on('close', () => {
    if (waiting) log({ unfinished: { at, want: kind(waiting.msg) } });
    process.exit(0);
});
