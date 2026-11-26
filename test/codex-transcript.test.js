'use strict';

// Reading Codex sessions — docs/plans/23-codex.md, Phase 2.
//
//   bridge/codex/items.js               the item kinds, disk form → wire form → event
//   bridge/runtimes/codex/transcript.js the rollout reader behind the Phase 1 seam
//   bridge/turn-index.js                turn boundaries from `turn_context`
//   bridge/changes.js                   line counts from a patch's unified diffs
//   bridge/sessions.js                  rollouts indexed beside Claude's transcripts
//
// No bridge needed, and no Codex: every case reads the rollouts recorded against a
// real `codex app-server` 0.172.0 in Phase 0 (test/fixtures/codex/). What is pinned
// is what would otherwise go wrong quietly. A command whose output vanished, a
// diff counted twice, the harness's `<environment_context>` drawn as something you
// said, a fork that opens with half its conversation missing, a read-only session
// that offers to send — none of those throws. Each one is a transcript that reads
// slightly wrong, which is a bug nobody reports until they rely on it.
//
// The index gets its own projects, Codex and cache directories, set before the
// require because bridge/config.js reads them at load, so nothing here can see
// or touch the real ~/.claude or ~/.codex.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-codex-transcript-'));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});
const PROJECTS = path.join(TMP, 'projects');
const CODEX_SESSIONS = path.join(TMP, 'codex', 'sessions');
fs.mkdirSync(PROJECTS, { recursive: true });
process.env.TGXCODE_PROJECTS_DIR = PROJECTS;
process.env.TGXCODE_CODEX_SESSIONS_DIR = CODEX_SESSIONS;
process.env.XDG_CACHE_HOME = path.join(TMP, 'cache');
process.env.XDG_DATA_HOME = path.join(TMP, 'data');

const items = require('../bridge/codex/items');
const reader = require('../bridge/runtimes/codex/transcript');
const runtimes = require('../bridge/runtimes');
const transcript = require('../bridge/transcript');
const changes = require('../bridge/changes');
const { TurnIndex } = require('../bridge/turn-index');
const { SessionIndex } = require('../bridge/sessions');

const FIX = path.join(__dirname, 'fixtures', 'codex');
const fixture = (name) => path.join(FIX, `${name}.rollout.jsonl`);
const linesOf = (name) => fs.readFileSync(fixture(name), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const eventsOf = (name) => reader.buildEvents(linesOf(name)).events;
/** The `item/completed` items a recording received, by item id. */
function wireItems(name) {
    const out = new Map();
    for (const line of fs.readFileSync(path.join(FIX, `${name}.ndjson`), 'utf8').split('\n')) {
        if (!line) continue;
        const o = JSON.parse(line);
        if (o.dir === 'recv' && o.msg.method === 'item/completed') out.set(o.msg.params.item.id, o.msg.params.item);
    }
    return out;
}
/** The rollout's own `item_completed` items, by id. */
function diskItems(name) {
    const out = new Map();
    for (const e of linesOf(name)) {
        if (e.type === 'event_msg' && e.payload.type === 'item_completed') out.set(e.payload.item.id, e.payload.item);
    }
    return out;
}

let pass = 0;
const ok = (what) => { pass++; console.log(`  ok  ${what}`); };

// --- the item table -------------------------------------------------------------------------------
{
    const disk = diskItems('file-change-approval');
    const cmd = items.fromRollout([...disk.values()].find(i => i.type === 'CommandExecution'));
    assert.strictEqual(cmd.type, 'commandExecution');
    assert.strictEqual(cmd.command, '/bin/bash -lc \'cat notes.txt\'', 'argv joined the way the wire writes it');
    assert.strictEqual(cmd.cwd, '/tmp/codex-fixture-file-change-approval-AFdPme', 'file:// URL read as a path');
    assert.strictEqual(cmd.aggregatedOutput, 'first line\n');
    assert.strictEqual(cmd.exitCode, 0);
    assert.strictEqual(typeof cmd.durationMs, 'number');
    assert.deepStrictEqual(cmd.commandActions[0], { type: 'read', command: 'cat notes.txt', name: 'notes.txt', path: 'notes.txt' });

    const fc = items.fromRollout([...disk.values()].find(i => i.type === 'FileChange'));
    assert.deepStrictEqual(fc.changes, [{
        path: '/tmp/codex-fixture-file-change-approval-AFdPme/notes.txt',
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1,2 @@\n first line\n+second line\n',
    }], 'an object keyed by path on disk, the wire\'s array after');

    const sleep = items.fromRollout({ type: 'Extension', kind: 'clock.sleep', id: 's1', durationMs: 30000 });
    assert.deepStrictEqual(sleep, { type: 'sleep', id: 's1', durationMs: 30000 }, 'the extension the wire calls sleep');

    assert.strictEqual(items.scriptOf("/bin/bash -lc 'echo it'\\''s'"), "echo it's", 'single quotes undone');
    assert.strictEqual(items.scriptOf('ls -la'), 'ls -la', 'a command with no shell wrapper is left alone');
    ok('fromRollout turns each disk quirk into the wire form: argv, file:// cwd, changes map, durations');
}

{
    // The point of the table: one item, read off disk or off the wire, is one row.
    for (const name of ['command-approval', 'file-change-approval', 'interrupt', 'plan', 'steer']) {
        const wire = wireItems(name);
        for (const [id, d] of diskItems(name)) {
            const w = wire.get(id);
            if (!w) continue;
            const a = items.toolEvent(items.fromRollout(d));
            const b = items.toolEvent(w);
            if (!a && !b) continue;
            assert.ok(a && b, `${name} ${id}: both are tools or neither`);
            assert.strictEqual(a.name, b.name, `${name} ${id}: name`);
            assert.strictEqual(a.status, b.status, `${name} ${id}: status`);
            if (a.name === items.TOOL.command) {
                assert.strictEqual(a.input.command, b.input.command, `${name}: the script, from either side`);
                assert.strictEqual(a.input.cwd, b.input.cwd, `${name}: cwd`);
            }
            if (a.name === items.TOOL.patch) {
                assert.deepStrictEqual(a.input.changes, b.input.changes, `${name}: changes`);
            }
            if (a.name === items.TOOL.plan) assert.deepStrictEqual(a.input, b.input);
        }
    }
    const odd = items.toolEvent({ type: 'somethingNew', id: 'x', detail: 'y' });
    assert.deepStrictEqual(odd, { name: 'somethingNew', input: { detail: 'y' }, status: 'ok', result: { text: '' } },
        'an unknown kind is a generic row, not an exception');
    assert.strictEqual(items.fromRollout(null), null);
    assert.strictEqual(items.toolEvent({ type: 'userMessage', id: 'u' }), null, 'a message is not a tool');
    ok('the same item read off disk and off the wire becomes the same tool row');
}

{
    assert.deepStrictEqual(items.countDiff('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n+d\n'), { added: 2, deleted: 1 },
        'headers are not lines');
    ok('countDiff counts a unified diff\'s lines and not its headers');
}

// --- the runtime ----------------------------------------------------------------------------------
{
    const caps = runtimes.capabilitiesOf('codex');
    for (const [flag, v] of Object.entries(caps)) assert.strictEqual(v, false, `${flag} is false for codex`);
    assert.strictEqual(caps.send, false);
    assert.strictEqual(caps.delete, false);
    assert.ok(Object.isFrozen(caps));
    assert.ok(runtimes.readable('codex') && !runtimes.known('codex'), 'read, never run');
    assert.throws(() => runtimes.get('codex'), /unknown runtime: codex/, 'nothing that starts a process can get one');
    assert.strictEqual(transcript.readerFor('codex'), reader, 'the reader seam answers for it');
    assert.ok(runtimes.toolsOf('codex').edits.has('apply_patch'));
    assert.ok(!runtimes.toolsOf('codex').edits.has('exec_command'), 'as with Bash, a command says no file');
    ok('codex is a read-only runtime: every capability false, no process adapter');
}

// --- the metadata scan ----------------------------------------------------------------------------
{
    const m = reader.scanMeta(fixture('steer'));
    assert.strictEqual(m.runtime, 'codex');
    assert.strictEqual(m.sessionId, '01a218ff-efe6-7420-bd48-302e090a92e7', 'from session_meta');
    assert.strictEqual(m.cwd, '/tmp/codex-fixture-steer-ZsU1WR');
    assert.strictEqual(m.projectCwd, m.cwd);
    assert.strictEqual(m.userMessages, 2, 'the prompt and the steer; not <environment_context>');
    assert.strictEqual(m.firstPrompt, 'Use the shell to run exactly: sleep 8 — then reply with just the word done.');
    assert.ok(m.lastPrompt.startsWith('Change of plan'));
    assert.strictEqual(m.model, 'gpt-6-luna');
    assert.strictEqual(m.version, '0.172.0');
    assert.strictEqual(m.originator, 'tgxcode');
    assert.strictEqual(m.permissionMode, 'dontAsk', 'never + workspace-write, D5 read backwards');
    assert.strictEqual(m.toolCalls, 1);
    assert.strictEqual(m.titleSource, 'prompt');

    assert.strictEqual(reader.scanMeta(fixture('plan')).permissionMode, 'plan');
    assert.strictEqual(reader.scanMeta(fixture('plain')).permissionMode, 'manual', 'untrusted');
    assert.strictEqual(reader.scanMeta(fixture('fork.1')).forkedFrom, '01a218f9-8893-7253-a2ab-8922b522cc48');
    assert.strictEqual(reader.scanMeta(path.join(TMP, 'missing.jsonl')), null);
    ok('scanMeta reads the row off session_meta, turn_context and the person\'s own messages');
}

// --- the conversation -----------------------------------------------------------------------------
{
    const ev = eventsOf('plain');
    assert.deepStrictEqual(ev.map(e => e.kind), ['user', 'assistant']);
    assert.strictEqual(ev[0].text, 'Reply with the single word: pong. Do not run any commands.');
    assert.strictEqual(ev[1].text, 'pong');
    assert.strictEqual(ev[1].model, 'gpt-6-luna');
    for (const name of fs.readdirSync(FIX).filter(f => f.endsWith('.rollout.jsonl'))) {
        for (const e of reader.buildEvents(linesOf(name.replace('.rollout.jsonl', ''))).events) {
            const t = JSON.stringify(e);
            assert.ok(!t.includes('<environment_context>'), `${name}: no environment_context in ${e.kind}`);
            assert.ok(!t.includes('<skills_instructions>') && !t.includes('You are Codex'), `${name}: no developer text`);
            assert.ok(e.id && e.kind && 'ts' in e, `${name}: every event has id, kind, ts`);
        }
    }
    ok('a plain turn is one user and one assistant event, and the harness\'s messages are stripped');
}

{
    const ev = eventsOf('command-approval');
    const tool = ev.find(e => e.kind === 'tool');
    assert.strictEqual(tool.name, 'exec_command');
    assert.strictEqual(tool.input.command, 'touch made-by-codex.txt');
    assert.strictEqual(tool.status, 'ok');
    assert.deepStrictEqual(tool.result, { text: '', exitCode: 0, interrupted: false });
    assert.ok(!ev.some(e => e.kind === 'tool' && e.name === 'exec'), 'the code-mode script is not a row');

    const failed = eventsOf('plan').find(e => e.name === 'exec_command');
    assert.strictEqual(failed.status, 'error', 'a non-zero exit is an error, as a failing Bash is');
    assert.strictEqual(failed.result.exitCode, 1);
    assert.strictEqual(failed.result.text, '/tmp/codex-fixture-plan-fENXk0\n', 'the output survives the failure');
    ok('a command row: the script, its output and its exit code, from item_completed');
}

{
    const ev = eventsOf('file-change-approval');
    const patch = ev.find(e => e.name === 'apply_patch');
    assert.deepStrictEqual(patch.input.changes, [{
        path: '/tmp/codex-fixture-file-change-approval-AFdPme/notes.txt', kind: 'update', movePath: null,
        diff: '@@ -1 +1,2 @@\n first line\n+second line\n',
    }]);
    assert.strictEqual(patch.status, 'ok');
    assert.ok(patch.result.text.includes('Updated the following files'), 'what apply_patch printed');

    const rows = changes.summarize(changes.fromEvents(ev, { runtime: 'codex' }),
        { root: '/tmp/codex-fixture-file-change-approval-AFdPme' });
    assert.deepStrictEqual(rows.map(r => [r.relPath, r.added, r.deleted, r.toolId]),
        [['notes.txt', 1, 0, patch.id]], 'one file, counted off its diff; the cat is not an edit');
    const twice = changes.fromEvents(ev, { runtime: 'codex' });
    changes.fromEvents(ev, { runtime: 'codex', into: twice, done: new Set([patch.id]) });
    assert.strictEqual(twice.get(patch.input.changes[0].path).added, 1, 'a patch already counted is not counted again');
    assert.strictEqual(changes.fromEvents(ev).size, 0, 'claude\'s table does not know apply_patch');

    const multi = changes.summarize(changes.fromEvents([{ kind: 'tool', id: 'p', name: 'apply_patch', status: 'ok',
        input: { changes: [
            { path: '/r/a.txt', kind: 'add', diff: '+one\n+two\n' },
            { path: '/r/b.txt', kind: 'update', movePath: '/r/c.txt', diff: '@@ -1 +1 @@\n-x\n+y\n' },
        ] } }], { runtime: 'codex' }), { root: '/r' });
    assert.deepStrictEqual(multi.map(r => [r.relPath, r.added, r.deleted]).sort(),
        [['a.txt', 2, 0], ['c.txt', 1, 1]], 'one row per file, a move filed under where it went');
    ok('a patch row carries each file\'s diff, and the changes drawer counts it off those diffs');
}

{
    const ev = eventsOf('interrupt');
    const stop = ev.find(e => e.kind === 'system');
    assert.deepStrictEqual([stop.subtype, stop.isError, stop.text], ['interrupted', false, 'Interrupted.']);
    const cmd = ev.find(e => e.name === 'exec_command');
    assert.strictEqual(cmd.status, 'error');
    assert.strictEqual(cmd.result.interrupted, true, 'killed by the interrupt, exit -1');
    ok('turn_aborted is an interrupted marker, and the command it killed says so');
}

{
    const ev = eventsOf('plan');
    const plan = ev.find(e => e.name === 'plan');
    assert.ok(plan.input.plan.startsWith('## Add a scratch-space README'));
    assert.ok(!ev.some(e => e.kind === 'assistant' && e.text.includes('<proposed_plan>')),
        'the plan is not repeated as a message');
    ok('a plan item is a plan row, and the copy in the last message is dropped');
}

{
    const ev = eventsOf('request-user-input');
    const q = ev.find(e => e.name === 'request_user_input');
    assert.strictEqual(q.status, 'ok');
    assert.deepStrictEqual(q.input.questions.map(x => [x.header, x.question, x.options.map(o => o.label)]),
        [['Colour', 'Which colour do you prefer?', ['Red', 'Blue']]], 'AskUserQuestion\'s shape');
    assert.deepStrictEqual(q.result.answers, { 'Which colour do you prefer?': 'Red' }, 'keyed by question, as Claude\'s are');

    // The call in one read and its answer in the next: the answer is a patch.
    const lines = linesOf('request-user-input');
    const at = lines.findIndex(e => e.payload && e.payload.type === 'function_call_output');
    const first = reader.buildEvents(lines.slice(0, at)).events.find(e => e.name === 'request_user_input');
    assert.strictEqual(first.status, 'pending');
    const later = reader.buildEvents(lines.slice(at), { pendingAsks: new Map([[first.id, first]]) }).events;
    const patch = later.find(e => e.kind === 'tool-result');
    assert.strictEqual(patch.toolId, first.id);
    assert.deepStrictEqual(patch.result.answers, { 'Which colour do you prefer?': 'Red' });

    const async = eventsOf('request-user-input-default').filter(e => e.kind === 'assistant');
    assert.ok(async.some(e => e.text === 'Colour preference\n- Red\n- Blue'), 'the async question is drawn from its item');
    ok('the blocking question is a question row with its answer; the async one is a message');
}

{
    const ev = eventsOf('steer');
    assert.deepStrictEqual(ev.filter(e => e.kind === 'user').map(e => e.text), [
        'Use the shell to run exactly: sleep 8 — then reply with just the word done.',
        'Change of plan: when the command finishes, reply with just the word heron instead.',
    ]);
    assert.strictEqual(ev[ev.length - 1].text, 'heron');
    ok('a steered message is a user event in the turn it joined');
}

// --- forks ----------------------------------------------------------------------------------------
{
    const parent = fixture('fork.0');
    const child = linesOf('fork.1');
    const parentId = reader.scanMeta(parent).sessionId;
    const asked = [];
    const before = reader.inherited(child, { locate: (id) => { asked.push(id); return id === parentId ? parent : null; } });
    assert.deepStrictEqual(asked, [parentId]);
    assert.strictEqual(before.length, 18, 'the parent up to end_ordinal_exclusive');
    assert.ok(before.every(e => e.ordinal < 18));
    const ev = reader.buildEvents([...before, ...child]).events.filter(e => e.kind === 'user' || e.kind === 'assistant');
    assert.deepStrictEqual(ev.map(e => e.text), ['Remember the word "heron". Reply with just: ok', 'ok',
        'What word did I ask you to remember? One word.', 'heron'], 'the whole conversation, in order');
    assert.deepStrictEqual(reader.inherited(child, { locate: () => null }), [], 'a missing parent is an empty prefix');
    assert.deepStrictEqual(reader.inherited(linesOf('plain'), { locate: () => parent }), [], 'not a fork');
    ok('a fork reads its parent up to the cut, by ordinal');
}

// --- compressed rollouts --------------------------------------------------------------------------
if (reader.CAN_ZSTD) {
    const dir = fs.mkdtempSync(path.join(TMP, 'zst-'));
    const file = path.join(dir, 'rollout-2026-11-26T17-55-56-01a218ff-efe6-7420-bd48-302e090a92e7.jsonl.zst');
    fs.writeFileSync(file, zlib.zstdCompressSync(fs.readFileSync(fixture('steer'))));
    const m = reader.scanMeta(file);
    assert.strictEqual(m.userMessages, 2);
    assert.deepStrictEqual(reader.buildEvents(reader.parseLines(reader.readFile(file)).entries).events.map(e => e.kind),
        eventsOf('steer').map(e => e.kind));
    ok('a .jsonl.zst rollout reads the same as the plain one');
} else {
    const dir = fs.mkdtempSync(path.join(TMP, 'zst-'));
    const file = path.join(dir, 'rollout-x-01a218ff-efe6-7420-bd48-302e090a92e7.jsonl.zst');
    fs.writeFileSync(file, 'not really zstd');
    assert.strictEqual(reader.readFile(file), null);
    ok(`no zstd in Node ${process.versions.node}: a .zst rollout reads as nothing rather than throwing`);
}

// --- the turn index -------------------------------------------------------------------------------
{
    const ti = new TurnIndex(path.join(TMP, 'turns'));
    const at = (name, off) => fs.readFileSync(fixture(name)).subarray(off, off + 120).toString();

    const ask = ti.update('ask', fixture('ask-unprompted'), { runtime: 'codex' });
    assert.deepStrictEqual(ask.marks.map(m => m.kind), ['turn', 'turn']);
    assert.ok(ask.marks[0].text.startsWith('Ask me whether I prefer red or blue'));
    assert.strictEqual(ask.marks[1].text, 'blue');
    assert.deepStrictEqual(ask.marks.map(m => m.id), eventsOf('ask-unprompted').filter(e => e.kind === 'user').map(e => e.id),
        'a mark\'s id is its message\'s event id');
    for (const m of ask.marks) assert.ok(at('ask-unprompted', m.offset).includes('"type":"turn_context"'),
        'every turn begins at its turn_context line');
    assert.strictEqual(ask.runtime, 'codex');

    const steer = ti.update('steer', fixture('steer'), { runtime: 'codex' });
    assert.strictEqual(steer.marks.length, 2, 'the steer is a mark, as a folded message is');
    assert.strictEqual(steer.marks[0].offset, steer.marks[1].offset, 'at the offset of the turn it joined');

    const q = ti.update('q', fixture('request-user-input'), { runtime: 'codex' });
    const qm = q.marks.find(m => m.kind === 'question');
    assert.ok(qm, 'the question is marked');
    assert.strictEqual(qm.status, 'ok');
    assert.strictEqual(qm.offset, q.marks.find(m => m.kind === 'turn').offset, 'at its turn');
    assert.strictEqual(qm.result.text, 'Red');
    const plan = ti.update('p', fixture('plan'), { runtime: 'codex' });
    assert.ok(plan.marks.some(m => m.kind === 'plan' && m.name === 'plan'));

    // Grown a line at a time, it says what it says read whole.
    const grow = path.join(TMP, 'grow.jsonl');
    const bytes = fs.readFileSync(fixture('ask-unprompted'));
    fs.writeFileSync(grow, '');
    let from = 0;
    while (from < bytes.length) {
        const nl = bytes.indexOf(0x0a, from);
        const to = nl === -1 ? bytes.length : nl + 1;
        fs.appendFileSync(grow, bytes.subarray(from, to));
        ti.update('grow', grow, { runtime: 'codex' });
        from = to;
    }
    assert.deepStrictEqual(ti.update('grow', grow, { runtime: 'codex' }).marks.map(m => [m.kind, m.offset, m.id]),
        ask.marks.map(m => [m.kind, m.offset, m.id]), 'incremental reads agree with a whole read');
    ok('the turn index takes Codex turns from turn_context lines, incrementally');
}

// --- the session index ----------------------------------------------------------------------------
(async () => {
    // Filed the way Codex files them, with the cwd moved out of /tmp for the ones
    // the list should show: scratch space is filtered out of every list, by design.
    const day = path.join(CODEX_SESSIONS, '2026', '11', '26');
    fs.mkdirSync(day, { recursive: true });
    // Not under the temp directory, which is the one place a list never shows. It
    // need not exist: a session is placed by the path it recorded.
    const PROJ = '/home/user/work/proj';
    const place = (name, { cwd = null } = {}) => {
        const id = reader.scanMeta(fixture(name)).sessionId;
        let text = fs.readFileSync(fixture(name), 'utf8');
        if (cwd) {
            const was = reader.scanMeta(fixture(name)).cwd;
            text = text.split(was).join(cwd);
        }
        const file = path.join(day, `rollout-2026-11-26T17-00-00-${id}.jsonl`);
        fs.writeFileSync(file, text);
        return { id, file };
    };
    const fc = place('file-change-approval', { cwd: PROJ });
    const parent = place('fork.0');
    const child = place('fork.1');
    const plan = place('plan', { cwd: PROJ });
    fs.writeFileSync(path.join(CODEX_SESSIONS, '..', 'session_index.jsonl'), [
        { id: fc.id, thread_name: 'First name', updated_at: '2026-11-26T18:00:00Z' },
        { id: fc.id, thread_name: 'Notes edit', updated_at: '2026-11-26T18:01:00Z' },
    ].map(o => JSON.stringify(o)).join('\n') + '\n');

    const index = new SessionIndex();
    await index.rescan();

    const s = index.summary(fc.id);
    assert.ok(s, 'indexed beside the (empty) Claude projects');
    assert.strictEqual(s.runtime, 'codex');
    assert.strictEqual(s.capabilities, runtimes.capabilitiesOf('codex'));
    assert.strictEqual(s.capabilities.send, false);
    assert.strictEqual(s.title, 'Notes edit', 'the thread\'s name, last line wins');
    assert.strictEqual(s.titleSource, 'thread-name');
    assert.strictEqual(s.cwd, PROJ);
    assert.strictEqual(s.projectCwd, PROJ, 'placed by session_meta.cwd');
    assert.ok(index.list().some(x => x.sessionId === fc.id && x.projectName === 'proj'), 'listed');
    assert.ok(index.projects().some(p => p.cwd === PROJ && p.sessions === 2), 'one project, two sessions');
    assert.strictEqual(index.summary(plan.id).title.startsWith('Plan how to add a README.md'), true, 'no name: the prompt');

    const read = index.read(fc.id);
    assert.deepStrictEqual(read.events.map(e => e.name || e.kind),
        ['user', 'assistant', 'exec_command', 'apply_patch', 'assistant']);
    assert.strictEqual(read.offset, fs.statSync(fc.file).size, 'offset is the file\'s length, to tail from');
    assert.deepStrictEqual(index.readSince(fc.id, read.offset).events, []);
    fs.appendFileSync(fc.file, JSON.stringify({ timestamp: '2026-11-26T18:05:00.000Z', type: 'event_msg',
        payload: { type: 'turn_aborted', reason: 'interrupted', turn_id: 't9' } }) + '\n');
    const since = index.readSince(fc.id, read.offset);
    assert.deepStrictEqual(since.events.map(e => e.subtype), ['interrupted'], 'the live tail reads what was appended');

    const forked = index.read(child.id).events.filter(e => e.kind === 'user').map(e => e.text);
    assert.deepStrictEqual(forked, ['Remember the word "heron". Reply with just: ok',
        'What word did I ask you to remember? One word.'], 'a fork opens with its parent\'s history');
    assert.ok(!index.list().some(x => x.sessionId === parent.id), 'a /tmp thread is indexed but not listed');
    assert.ok(index.summary(parent.id), 'and still reachable by id');

    const turns = index.turns(plan.id);
    assert.ok(turns.marks.some(m => m.kind === 'turn') && turns.marks.some(m => m.kind === 'plan'));
    const win = index.readWindow(plan.id, turns.marks[0].offset);
    assert.ok(win.events.some(e => e.kind === 'user'), 'a window from a turn offset holds the turn');

    const drawn = changes.forSession(index, fc.id, { sessionDir: null, root: PROJ });
    assert.deepStrictEqual(drawn.files.map(f => [f.relPath, f.added, f.deleted]), [['notes.txt', 1, 0]],
        'the changes route\'s own path counts a Codex patch');

    assert.strictEqual(index.remove(fc.id), null, 'never deleted from Codex\'s store');
    assert.ok(fs.existsSync(fc.file));
    index.stop();
    ok('sessions.js indexes rollouts: runtime, capabilities, thread names, reads, tails, forks, turns');

    // --- the write routes refuse a session that cannot take a message --------------------------
    // Driven through the route module itself with a stub index and pool, because
    // the bug this guards was in the shape of the call: a refusal that answered
    // 409 and then let the route carry on into `pool.ensure`, which wrote a second
    // reply and took the bridge down. So each case asserts one reply, the right
    // one, and a pool nobody asked for a process.
    {
        const { Readable } = require('stream');
        const routes = require('../bridge/routes/session');
        const CODEX = { sessionId: 'cx', runtime: 'codex', capabilities: runtimes.capabilitiesOf('codex'),
            cwd: '/home/user/work/proj', title: 't', projectName: 'proj', userMessages: 1 };
        const asked = [];
        // `later` validates its body in its own module, which takes the same two.
        require('../bridge/routes/later').init({ later: null, modeRefusal: () => null,
            normalizeMode: (m) => m || 'auto' });
        routes.init({
            index: { summary: (id) => (id === 'cx' ? CODEX : null), get: () => null },
            pool: {
                ensure: () => { asked.push('ensure'); throw new Error('must not be reached'); },
                get: () => null, statuses: () => ({}),
            },
            later: { forSession: () => [], create: () => { asked.push('later'); return null; } },
            flags: null, prefs: { forCwd: () => ({}) }, suggestions: { forSession: () => ({}) },
            modeRefusal: () => null, normalizeMode: (m) => m || 'auto',
            sessionCwd: (sum) => sum.cwd, terminals: null, standing: null,
        });
        const call = async (method, tail, body) => {
            const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
            req.method = method;
            req.headers = { 'content-type': 'application/json', 'content-length': '10' };
            const replies = [];
            let out = '';
            const res = {
                writeHead: (status) => { replies.push(status); },
                end: (b) => { out += b ? b.toString() : ''; },
                setHeader() {}, on() {}, once() {}, emit() {},
            };
            const seg = ['api', 'sessions', 'cx', ...(tail ? tail.split('/') : [])];
            const url = new URL(`http://x/${seg.join('/')}?name=a.png`);
            await routes.handle(req, res, url, url.pathname, seg, { remote: false });
            return { replies, body: out ? JSON.parse(out) : null };
        };
        const at = Date.now() + 3600e3;
        for (const [method, tail, body, flag] of [
            ['POST', 'send', { text: 'hi' }, 'send'],
            ['POST', 'later', { text: 'hi', at, permissionMode: 'manual' }, 'send'],
            ['POST', 'wake', { in: '10m', prompt: 'x' }, 'send'],
            ['POST', 'handoff', { text: 'hi', from: 'other' }, 'send'],
            ['POST', 'attachments', null, 'send'],
            ['DELETE', '', null, 'delete'],
        ]) {
            const r = await call(method, tail, body);
            assert.deepStrictEqual(r.replies, [409], `${method} ${tail || ':id'}: one reply, a 409`);
            assert.deepStrictEqual([r.body.capability, r.body.runtime], [flag, 'codex'], `${method} ${tail}: names the flag`);
        }
        assert.deepStrictEqual(asked, [], 'no process was asked for, and nothing was scheduled');
        ok('every write a read-only session cannot take is one 409 naming the capability');
    }

    console.log(`\ncodex-transcript: ${pass} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
