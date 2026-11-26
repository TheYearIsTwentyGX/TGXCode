#!/usr/bin/env node
// A `codex app-server` that replays a recording and then keeps going — for the
// tests that drive a real Runner (test/codex-runner.test.js, test/codex-host.test.js).
//
// It walks FAKE_CODEX_FIXTURE the way stub.js does: every `recv` line is written
// at once, and at a `send` it waits for the client's next message and checks it is
// the same kind of thing. Two differences, both so a runner test can go past the
// end of a recording:
//
//   - A request the recorder made and the adapter does not (plain.ndjson asks
//     `model/list` first) is skipped forward over, and logged as `skipped`.
//   - A `turn/start` the recording has no place for is answered with the turn
//     from plain.ndjson, which ends "pong". That is what lets "the next message is
//     delivered" be asserted after any scenario.
//
// Every client message is logged to FAKE_CODEX_LOG with the walker's pid, and
// anything it could not place as `mismatch`.
'use strict';
const fs = require('fs');
const readline = require('readline');
const LOG = process.env.FAKE_CODEX_LOG;
const log = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...o }) + '\n');
const load = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
let entries = load(process.env.FAKE_CODEX_FIXTURE);
const plain = load(require('path').join(__dirname, 'plain.ndjson'));
const tail = plain.slice(plain.findIndex(e => e.dir === 'send' && e.msg.method === 'turn/start'));
const idMap = new Map();
let at = 0, waiting = null;
const kind = (m) => typeof m.method === 'string'
    ? (m.id === undefined ? 'notify:' : 'request:') + m.method : 'response:' + (m.error ? 'error' : 'result');
function out(msg) {
    if (msg.method === undefined && idMap.has(msg.id)) msg = { ...msg, id: idMap.get(msg.id) };
    process.stdout.write(JSON.stringify(msg) + '\n');
}
function advance() {
    while (at < entries.length && entries[at].dir === 'recv') out(entries[at++].msg);
    waiting = at < entries.length ? entries[at] : null;
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    log({ got: m });
    const want = waiting && waiting.msg;
    if (want && kind(m) === kind(want) && (typeof want.method === 'string' || m.id === want.id)) {
        if (typeof want.method === 'string' && want.id !== undefined) idMap.set(want.id, m.id);
        at++;
        return advance();
    }
    // A request the recorder made and the adapter does not (plain.ndjson asks
    // model/list first): skip forward to the next line of this kind, with the
    // replies to whatever was skipped.
    const j = entries.findIndex((e, i) => i > at && e.dir === 'send' && kind(e.msg) === kind(m)
        && (typeof e.msg.method === 'string' || e.msg.id === m.id));
    if (want && j > 0 && m.method !== 'turn/start') {
        log({ skipped: entries.slice(at, j).filter(e => e.dir === 'send').map(e => kind(e.msg)) });
        if (typeof m.method === 'string' && m.id !== undefined) idMap.set(entries[j].msg.id, m.id);
        at = j + 1;
        return advance();
    }
    // Past the recording, or a turn the recording did not make: play plain's.
    if (m.method === 'turn/start') {
        entries = tail; at = 0; idMap.set(tail[0].msg.id, m.id); at = 1;
        log({ tail: true });
        return advance();
    }
    log({ mismatch: { want: want ? kind(want) : null, wantId: want && want.id, got: kind(m), gotId: m.id } });
}).on('close', () => process.exit(0));
advance();
