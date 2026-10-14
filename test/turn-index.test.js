'use strict';

// The turn index — bridge/turn-index.js.
//
// A long session is opened from its end, with the rail drawn from this index and
// earlier stretches read from its offsets. So what it gets wrong does not throw:
// a turn missing from it is a tick missing from the rail, a stale plan status is
// a tick that says "still waiting" about a plan approved yesterday, and an offset
// that is not a line start is a window that parses as garbage. Each case below
// is one of those, checked against what a full read of the same file says.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildEvents, parseLines } = require('../bridge/transcript.js');
const { TurnIndex, boundaries } = require('../bridge/turn-index.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-turns-'));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});

let clock = Date.parse('2026-09-26T10:00:00Z');
const ts = () => new Date(clock += 1000).toISOString();
const user = (uuid, text) => ({
    type: 'user', uuid, timestamp: ts(), cwd: '/tmp/x',
    message: { role: 'user', content: [{ type: 'text', text }] },
});
const said = (uuid, text) => ({
    type: 'assistant', uuid, timestamp: ts(),
    message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] },
});
const call = (uuid, id, name, input = {}) => ({
    type: 'assistant', uuid, timestamp: ts(),
    message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (uuid, id, content = 'done', isError = false) => ({
    type: 'user', uuid, timestamp: ts(),
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: isError }] },
});
// Big, the way tool output is — and saying things a naive filter would trip on.
const noise = 'x'.repeat(20_000) + ' "type":"user" ExitPlanMode ';

const file = path.join(TMP, 's.jsonl');
const write = (entries) => fs.writeFileSync(file, entries.map(e => JSON.stringify(e) + '\n').join(''));
const append = (entries) => fs.appendFileSync(file, entries.map(e => JSON.stringify(e) + '\n').join(''));
const full = () => buildEvents(parseLines(fs.readFileSync(file)).entries).events;
const marksOf = (events) => events
    .filter(e => e.kind === 'user' || (e.kind === 'tool' && (e.name === 'ExitPlanMode' || e.name === 'AskUserQuestion')))
    .map(e => `${e.id}:${e.status || ''}`);
const indexed = (idx) => idx.marks.map(m => `${m.id}:${m.kind === 'turn' ? '' : m.status}`);

const first = [
    user('u1', 'Plan the thing'),
    call('a1', 'plan1', 'ExitPlanMode', { plan: '# Do it\n\nsteps' }),
    result('r1', 'plan1', 'User has approved your plan.'),
    said('a2', 'Doing it'),
    call('a3', 'b1', 'Bash', { command: 'ls' }),
    result('r2', 'b1', noise),
    user('u2', '<command-name>/review</command-name>\n<command-args>now</command-args>'),
    call('a4', 'q1', 'AskUserQuestion', { questions: [{ header: 'Scope', question: 'Which?' }] }),
];

// --- built from scratch, it says what a full read says --------------------
{
    write(first);
    const ti = new TurnIndex(path.join(TMP, 'idx1'));
    const idx = ti.update('s', file);
    assert.deepStrictEqual(indexed(idx), marksOf(full()));
    assert.deepStrictEqual(idx.marks.map(m => m.kind), ['turn', 'plan', 'turn', 'question']);
    assert.strictEqual(idx.marks[1].status, 'ok', 'a plan answered in the same read is answered');
    assert.strictEqual(idx.marks[3].status, 'pending');
    assert.deepStrictEqual(idx.marks[2].command, { name: 'review', args: 'now' });
    // A plan's offset is its turn's, so a window never starts inside a turn.
    assert.strictEqual(idx.marks[1].offset, idx.marks[0].offset);
    ok('marks, statuses and commands match a full read, and plans sit on their turn');
}

// --- appending reads only what was added, and settles what was waiting -----
{
    const ti = new TurnIndex(path.join(TMP, 'idx1'));
    const before = ti.update('s', file);
    const consumed = before.consumed;
    append([result('r3', 'q1', 'answered'), user('u3', 'Thanks')]);
    const idx = ti.update('s', file);
    assert.ok(idx.consumed > consumed);
    assert.deepStrictEqual(indexed(idx), marksOf(full()));
    assert.strictEqual(idx.marks[3].status, 'ok', 'the question answered after the fact says so');
    assert.deepStrictEqual(idx.pending, []);
    ok('an append is read incrementally and settles a pending question');

    // From disk, in a fresh process's shoes.
    const again = new TurnIndex(path.join(TMP, 'idx1')).update('s', file);
    assert.deepStrictEqual(indexed(again), indexed(idx));
    ok('the index survives a restart');
}

// --- a replaced file is rebuilt rather than extended ------------------------
{
    const ti = new TurnIndex(path.join(TMP, 'idx1'));
    ti.update('s', file);
    // Longer than before, so only the head can tell.
    write([user('z1', 'A different conversation'), said('z2', 'y'.repeat(60_000)), user('z3', 'Two')]);
    assert.deepStrictEqual(indexed(ti.update('s', file)), ['z1:', 'z3:']);
    write([user('w1', 'Short')]);
    assert.deepStrictEqual(indexed(ti.update('s', file)), ['w1:']);
    ok('a replaced or shrunk transcript is rebuilt from scratch');
}

// --- windows between offsets add up to the whole thing ----------------------
{
    write(first);
    append([result('r3', 'q1', 'answered'), user('u3', 'Thanks'), said('a9', 'Welcome')]);
    const idx = new TurnIndex(path.join(TMP, 'idx2')).update('s', file);
    const buf = fs.readFileSync(file);
    const cuts = [...boundaries(idx)].sort((a, b) => a - b);
    cuts.push(buf.length);
    const pieces = [];
    for (let i = 0; i < cuts.length - 1; i++) {
        const { entries } = parseLines(buf.subarray(cuts[i], cuts[i + 1]));
        pieces.push(...buildEvents(entries).events);
    }
    // A result whose call is in the previous window arrives as a patch — which is
    // what the client keeps for later. Apply them and it is the full read.
    const byId = new Map();
    for (const ev of pieces) {
        if (ev.kind === 'tool-result') {
            const { id, kind, toolId, ts: _ts, ...fields } = ev;
            Object.assign(byId.get(toolId), fields);
        } else byId.set(ev.id, ev);
    }
    const whole = full();
    assert.deepStrictEqual([...byId.keys()], whole.map(e => e.id));
    assert.deepStrictEqual([...byId.values()].map(e => e.status || null), whole.map(e => e.status || null));
    for (const off of cuts.slice(0, -1)) {
        assert.ok(off === 0 || buf[off - 1] === 0x0a, `offset ${off} is a line start`);
    }
    ok('windows cut at the index offsets add up to the full read');
}

// --- forget ---------------------------------------------------------------
{
    const dir = path.join(TMP, 'idx3');
    const ti = new TurnIndex(dir);
    ti.update('s', file);
    assert.ok(fs.existsSync(path.join(dir, 's.json')));
    ti.forget('s');
    assert.ok(!fs.existsSync(path.join(dir, 's.json')));
    ok('a deleted session takes its index with it');
}

console.log(`turn-index: ${pass} passed`);
