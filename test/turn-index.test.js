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
const { TurnIndex, boundaries, INDEX_VERSION } = require('../bridge/turn-index.js');

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

// --- the minimap's kinds: edits, subagents, failures and pull requests -------
const prLink = (n) => ({
    type: 'pr-link', sessionId: 's', timestamp: ts(), prNumber: n,
    prUrl: `https://github.com/o/r/pull/${n}`, prRepository: 'o/r',
});
const work = [
    user('m1', 'Change the file'),
    call('ma1', 'e1', 'Edit', { file_path: '/repo/a.js', old_string: 'x', new_string: 'y' }),
    result('mr1', 'e1', 'ok'),
    call('ma2', 'e2', 'Write', { file_path: '/repo/b.js', content: 'z' }),
    result('mr2', 'e2', 'File has not been read yet', true),
    call('ma3', 'b9', 'Bash', { command: 'false' }),
    // Big and failed: parsed for the failure, not for its size.
    result('mr3', 'b9', 'Exit code 1\n' + noise, true),
    call('ma4', 'b8', 'Bash', { command: 'rm -rf /' }),
    result('mr4', 'b8', "The user doesn't want to proceed with this tool use.", true),
    call('ma5', 'p2', 'ExitPlanMode', { plan: '# Again' }),
    result('mr5', 'p2', 'User rejected the plan; keep planning', true),
    prLink(7),
    user('m2', 'And a helper'),
    call('ma6', 't1', 'Task', { description: 'Survey the tests', prompt: 'look' }),
    prLink(7),
];
const kindsOf = (idx) => idx.marks.map(m => `${m.kind}:${m.id}`);
{
    write(work);
    const idx = new TurnIndex(path.join(TMP, 'idx4')).update('s', file);
    assert.deepStrictEqual(kindsOf(idx), [
        'turn:m1', 'edit:e1', 'edit:e2', 'error:e2:error', 'error:b9:error', 'plan:p2',
        'pr:pr:https://github.com/o/r/pull/7', 'turn:m2', 'subagent:t1',
    ]);
    const m = Object.fromEntries(idx.marks.map(x => [x.id, x]));
    assert.strictEqual(m.e1.path, '/repo/a.js');
    assert.strictEqual(m['e2:error'].name, 'Write');
    assert.strictEqual(m['e2:error'].text, 'File has not been read yet');
    // A Bash call is never parsed — it is most of a transcript — so its failure
    // is marked by what it said rather than by name.
    assert.strictEqual(m['b9:error'].name, null);
    assert.strictEqual(m['b9:error'].text, 'Exit code 1');
    assert.strictEqual(m.p2.status, 'error', 'a plan sent back is an outcome, not an error mark');
    assert.strictEqual(m.t1.text, 'Survey the tests');
    assert.strictEqual(m['pr:https://github.com/o/r/pull/7'].number, 7);
    // Turn offsets are untouched: the same as a v1 index would have said.
    const buf = fs.readFileSync(file);
    const cuts = boundaries(idx);
    assert.deepStrictEqual([...cuts].sort((a, b) => a - b),
        [0, ...idx.marks.filter(x => x.kind === 'turn').map(x => x.offset)].filter((v, i, a) => a.indexOf(v) === i));
    for (const x of idx.marks) {
        const turn = [...idx.marks].reverse().find(t => t.kind === 'turn' && t.offset <= x.at);
        assert.strictEqual(x.offset, turn.offset, `${x.id} sits on its turn`);
        assert.ok(x.at >= x.offset, `${x.id}: at is inside its turn`);
        assert.ok(x.at === 0 || buf[x.at - 1] === 0x0a, `${x.id}: at is a line start`);
    }
    ok('edits, subagents, failures and PRs are marked, each on its own line and in its turn');
}

// --- a failure whose call is in an earlier read ----------------------------
{
    write(work.slice(0, 6));
    const ti = new TurnIndex(path.join(TMP, 'idx5'));
    ti.update('s', file);
    append(work.slice(6));
    const idx = ti.update('s', file);
    const whole = new TurnIndex(path.join(TMP, 'idx6')).update('s', file);
    assert.deepStrictEqual(idx.marks, whole.marks);
    assert.strictEqual(idx.marks.find(x => x.id === 'e2:error').name, 'Write',
        'named from the edit mark the earlier read left');
    ok('an incremental read marks a failure whose call it never saw, and agrees with a rebuild');
}

// --- an index from before the minimap is rebuilt, not served ----------------
{
    const dir = path.join(TMP, 'idx7');
    write(work);
    fs.mkdirSync(dir, { recursive: true });
    const stat = fs.statSync(file);
    fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({
        version: 1, file, head: null, consumed: stat.size, marks: [], pending: [],
    }));
    const idx = new TurnIndex(dir).update('s', file);
    assert.strictEqual(idx.version, INDEX_VERSION);
    assert.ok(idx.marks.some(m => m.kind === 'edit'));
    ok('a version 1 index is rebuilt with the new kinds');
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
