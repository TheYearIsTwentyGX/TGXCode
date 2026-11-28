'use strict';

// Phase 4's conversation features on Codex (docs/plans/23-codex.md): fork,
// branch from a turn, the checklist, spawned agents and the skill palette —
// each against a recording in test/fixtures/codex/, recorded on 0.172.0 with
// record.js (`branch`, `plan-update`, `skill`, `subagent`; `fork` is Phase 0's).
//
// What each recording settled, and so what each block pins:
//
//   - **The checklist is only a script on disk.** 0.172.0 writes no
//     `plan_update` line: `update_plan` is a call inside a code-mode `exec`
//     script, and `turn/plan/updated` exists only on the wire. So the list is
//     read out of a JavaScript literal (bridge/codex/plan.js), and the wire's and
//     the disk's spellings of a status have to come out the same.
//   - **A spawned agent shares its parent's connection.** Its `turn/started` and
//     `turn/completed` arrive with its own `threadId` before the parent's turn is
//     over; read as the parent's, the parent's turn ended early. The adapter
//     test counts turn-ends over the whole recording.
//   - **A branch is a fork cut before a turn**, and the cut is named by the turn
//     the edited message was in, read from the rollout without context so the
//     live tail and the turn index agree with a whole read.
//   - **A skill is a command**, whether it arrived as `$name` text or as a
//     `{type:"skill"}` input.
//
// No bridge, no network and no Codex: the Runner cases drive the replay walker
// through TGXCODE_CODEX_BIN, as codex-runner.test.js does.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-codex-features-'));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});
const FIX = path.join(__dirname, 'fixtures', 'codex');
const PROJECTS = path.join(TMP, 'projects');
const CODEX_SESSIONS = path.join(TMP, 'codex', 'sessions');
fs.mkdirSync(PROJECTS, { recursive: true });
process.env.TGXCODE_PROJECTS_DIR = PROJECTS;
process.env.TGXCODE_CODEX_SESSIONS_DIR = CODEX_SESSIONS;
process.env.TGXCODE_TASKS_DIR = path.join(TMP, 'tasks');
process.env.XDG_CACHE_HOME = path.join(TMP, 'cache');
process.env.XDG_DATA_HOME = path.join(TMP, 'data');
// Not 45888, and never reached: nothing here starts a bridge.
process.env.TGXCODE_PORT = '45944';
const walker = path.join(TMP, 'codex-walker.js');
const logFile = path.join(TMP, 'wire.ndjson');
fs.writeFileSync(walker, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(FIX, 'walker.js'))});\n`,
    { mode: 0o755 });
process.env.TGXCODE_CODEX_BIN = walker;
process.env.FAKE_CODEX_LOG = logFile;

const plans = require('../bridge/codex/plan');
const skills = require('../bridge/codex/skills');
const reader = require('../bridge/runtimes/codex/transcript');
const codex = require('../bridge/runtimes/codex/process');
const runtimes = require('../bridge/runtimes');
const tasks = require('../bridge/tasks');
const { TurnIndex } = require('../bridge/turn-index');
const { SessionIndex } = require('../bridge/sessions');
const { Runner } = require('../bridge/runner');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fixture = (name) => path.join(FIX, `${name}.rollout.jsonl`);
const linesOf = (name) => fs.readFileSync(fixture(name), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const eventsOf = (name, ctx) => reader.buildEvents(linesOf(name), ctx).events;
const recording = (name) => fs.readFileSync(path.join(FIX, `${name}.ndjson`), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
const recv = (name) => recording(name).filter(l => l.dir === 'recv').map(l => l.msg);
const sentIn = (name, method) => recording(name).filter(l => l.dir === 'send' && l.msg.method === method).map(l => l.msg);

function wire() {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}
const sent = (method) => wire().filter(l => l.got && l.got.method === method).map(l => l.got);
async function until(fn, ms, what) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (fn()) return;
        await sleep(20);
    }
    assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}

(async () => {

// --- the capabilities ------------------------------------------------------------------------------
{
    const caps = runtimes.capabilitiesOf('codex');
    for (const f of ['fork', 'branchFromTurn', 'tasks', 'slashCommands']) assert.strictEqual(caps[f], true, f);
    ok('fork, branchFromTurn, tasks and slashCommands are on for Codex');
}

// --- the checklist: a JavaScript literal, read ------------------------------------------------------
{
    const { value } = plans.literal(`{plan:[{step:"a \\"q\\"",status:'in_progress',},{ step: \`b\`, status: "pending" }], explanation: null, n: -1.5e2}`, 0);
    assert.deepStrictEqual(value, { plan: [{ step: 'a "q"', status: 'in_progress' }, { step: 'b', status: 'pending' }],
        explanation: null, n: -150 });
    assert.deepStrictEqual(plans.plansInScript('const r = await tools.update_plan(steps); text(r);'), [],
        'an argument that is not a literal is skipped, not guessed');
    assert.deepStrictEqual(plans.plansInScript('await tools.update_plan({plan:[{step:`x ${y}`,status:"pending"}]})'), [],
        'nor is a template with a substitution');
    assert.deepStrictEqual(plans.plansInScript('x.update_planner({plan:[]})'), [], 'only update_plan itself');
    // What a live 0.172.0 turn wrote: six lists bound to consts, passed by name.
    const bound = ['ipp', 'cpp', 'cip'].map((code, n) => `const plan${n + 1} = [`
        + [...code].map((c, i) => `{step:"s${i}",status:"${{ i: 'in_progress', p: 'pending', c: 'completed' }[c]}"}`).join(',')
        + `];\nawait tools.update_plan({plan:plan${n + 1}});`).join('\n') + '\ntext("done");';
    assert.deepStrictEqual(plans.plansInScript(bound).map(p => p.plan.map(x => x.status[0]).join('')),
        ['ipp', 'cpp', 'cip'], 'a list bound to a name earlier in the script is read');
    assert.deepStrictEqual(plans.plansInScript('let plan = [{step:"a",status:"pending"}]; await tools.update_plan({plan}); '
        + 'plan = build(); await tools.update_plan({plan});').length, 1,
        'shorthand reads the binding; a rebinding this cannot read forgets it');
    const two = plans.plansInScript('await tools.update_plan({plan:[{step:"a",status:"pending"}]});\n'
        + '/* then */ await tools.update_plan({ plan: [ { step: "a", status: "completed" } ] });');
    assert.deepStrictEqual(two.map(p => p.plan[0].status), ['pending', 'completed'], 'every call in a script, in order');

    // The wire's spelling and the script's come out as TodoWrite's.
    const wirePlans = recv('plan-update').filter(m => m.method === 'turn/plan/updated').map(m => m.params);
    const diskPlans = linesOf('plan-update').map(plans.planOfLine).filter(Boolean);
    assert.strictEqual(diskPlans.length, 4, 'four update_plan calls, each in its own exec script');
    assert.deepStrictEqual(diskPlans.slice(0, wirePlans.length).map(p => p.plan),
        wirePlans.map(p => plans.normalise(p).plan), 'the rollout says what the wire said');
    assert.ok(wirePlans.some(p => p.plan.some(s => s.status === 'inProgress')), 'the wire says inProgress');
    assert.ok(!linesOf('plan-update').some(e => e.payload && e.payload.type === 'plan_update'),
        '0.172.0 writes no plan_update line');
    assert.deepStrictEqual(plans.normalise({ plan: [{ step: 's', status: 'weird' }] }).plan[0].status, 'pending');
    ok('update_plan is read out of the exec script, in TodoWrite\'s statuses');
}

// --- the checklist: rows, the list, the count ---------------------------------------------------------
{
    const rows = eventsOf('plan-update').filter(e => e.kind === 'tool' && e.name === 'update_plan');
    assert.strictEqual(rows.length, 4);
    assert.deepStrictEqual(rows[1].input.plan.map(s => s.status), ['completed', 'in_progress', 'pending']);
    assert.ok(eventsOf('plan-update').every(e => e.name !== 'exec'), 'the script itself is not a row');

    const list = reader.todoList(fixture('plan-update'));
    assert.deepStrictEqual(list.items, ['Think of a colour', 'Think of an animal', 'Reply']
        .map(s => ({ content: s, status: 'completed', activeForm: s })), 'the newest call is the list');
    assert.deepStrictEqual(reader.todoProgress(fixture('plan-update')),
        { done: 3, total: 3, current: null, idle: false, ts: list.ts });
    assert.strictEqual(reader.todoList(fixture('plain')), null, 'a thread that kept no list has none');

    // Halfway through, as a board sees a working session.
    const half = path.join(TMP, 'rollout-2026-11-26T17-00-00-01a2197a-6bec-7b73-a161-0664085ea9ec.jsonl');
    const lines = fs.readFileSync(fixture('plan-update'), 'utf8').split('\n');
    fs.writeFileSync(half, lines.slice(0, lines.findIndex(l => l.includes('"ordinal":17,')) + 1).join('\n') + '\n');
    const p = tasks.progress('half', half);
    assert.deepStrictEqual([p.done, p.total, p.current, p.idle], [1, 3, 'Think of an animal', false]);
    const env = tasks.items('half', half);
    assert.strictEqual(env.source, 'todo', 'a flat list: no ids, no dependencies');
    assert.deepStrictEqual(env.items.map(t => [t.id, t.subject, t.status, t.blocks.length]), [
        [null, 'Think of a colour', 'completed', 0], [null, 'Think of an animal', 'in_progress', 0],
        [null, 'Reply', 'pending', 0]]);
    ok('the checklist panel and the boards read a rollout as a TodoWrite list');
}

// --- the checklist, live: thread config and the activity line -----------------------------------------
{
    const calls = [];
    const a = new codex.Adapter({ rpc: async (verb, params) => { calls.push([verb, params]); return verb === 'account/read' ? { account: {} } : {}; } });
    await a.handshake({ isNew: true, cwd: '/w', permissionMode: 'auto' });
    const start = calls.find(c => c[0] === 'thread/start')[1];
    assert.strictEqual(start.config['tools.update_plan.enabled'], true, 'every thread opts in to update_plan');
    calls.length = 0;
    await a.handshake({ isNew: false, sessionId: 'T', cwd: '/w', permissionMode: 'auto' });
    assert.strictEqual(calls.find(c => c[0] === 'thread/resume')[1].config['tools.update_plan.enabled'], true,
        'and so does a resumed one');

    const b = new codex.Adapter({ rpc: async () => ({}) });
    const labels = [];
    for (const m of recv('plan-update')) {
        for (const ev of b.read(m)) if (ev.type === 'tool-start' && ev.name === 'update_plan') labels.push(ev.label);
    }
    assert.deepStrictEqual(labels, ['Think of a colour (1 of 3)', 'Think of an animal (2 of 3)', 'Reply (3 of 3)'],
        'turn/plan/updated is what the turn is on now; a finished list says nothing');
    ok('threads opt in to update_plan, and turn/plan/updated drives the activity line');
}

// --- fork ------------------------------------------------------------------------------------------
{
    const parentId = sentIn('fork', 'thread/fork')[0].params.threadId;
    const reply = recv('fork').find(m => m.result && m.result.thread && m.result.thread.forkedFromId);
    const childId = reply.result.thread.id;

    const calls = [];
    const a = new codex.Adapter({ rpc: async (verb, params) => { calls.push([verb, params]); return verb === 'account/read' ? { account: {} } : {}; } });
    await a.handshake({ isNew: false, fork: true, sessionId: parentId, cwd: '/w', permissionMode: 'manual' });
    assert.deepStrictEqual(calls.map(c => c[0]), ['initialize', 'account/read', 'thread/fork'], 'a fork, not a resume');
    const fork = calls[2][1];
    assert.strictEqual(fork.threadId, parentId);
    assert.strictEqual(fork.excludeTurns, true, 'excludeTurns, so no deprecationNotice');
    assert.strictEqual(fork.approvalPolicy, 'untrusted', 'in the mode it was asked for');
    assert.strictEqual(fork.config['tools.update_plan.enabled'], true);
    assert.ok(!('beforeTurnId' in fork), 'a whole copy is not cut');

    // The reply is the fork's init: a new id that is not minted.
    a.verbs.set('req_x_1', 'thread/fork');
    const init = a.read({ ...reply, id: 'req_x_1' }).find(e => e.type === 'init');
    assert.deepStrictEqual([init.sessionId, init.minted], [childId, false]);
    const replayed = new codex.Adapter({ rpc: async () => ({}) }).read(reply).find(e => e.type === 'init');
    assert.deepStrictEqual([replayed.sessionId, replayed.minted], [childId, false], 'and on a replay, by its shape');

    // A real Runner: `forked` from the parent to the copy, and the message goes to the copy.
    fs.rmSync(logFile, { force: true });
    process.env.FAKE_CODEX_FIXTURE = path.join(FIX, 'fork.ndjson');
    const r = new Runner({ sessionId: parentId, cwd: TMP, isNew: false, fork: true, runtime: 'codex',
        permissionMode: 'acceptEdits' });
    r.hasViewer = () => true;
    const forked = [];
    r.on('forked', (e) => forked.push(e));
    r.send('What word did I ask you to remember? One word.');
    await until(() => r.state === 'idle' && r.lastResultText, 8000, 'the forked turn to finish');
    assert.deepStrictEqual(forked, [{ from: parentId, to: childId }]);
    assert.strictEqual(r.sessionId, childId);
    assert.strictEqual(sent('turn/start')[0].params.threadId, childId, 'the turn went to the copy');
    assert.strictEqual(sent('thread/resume').length, 0);
    assert.strictEqual(r.inFlight.length, 0);
    r.stop && r.stop();
    ok('a fork is thread/fork {excludeTurns}, announced as forked, and the turn goes to the copy');
}

// --- branch from a turn ------------------------------------------------------------------------------
{
    const users = eventsOf('branch.0').filter(e => e.kind === 'user');
    const turns = linesOf('branch.0').filter(e => e.type === 'turn_context').map(e => e.payload.turn_id);
    assert.strictEqual(users.length, 3);
    assert.ok(users.every(u => /^[0-9a-f-]{36}$/.test(u.id)), 'a person\'s message is keyed by a uuid');
    assert.deepStrictEqual(users.map(u => u.parent), [null, turns[1], turns[2]],
        'parent is the turn the message is in; null on the first input');

    // Context-free: one line at a time (the turn index, the live tail) says the same.
    const one = linesOf('branch.0').flatMap(e => reader.buildEvents([e]).events).filter(e => e.kind === 'user');
    assert.deepStrictEqual(one.map(u => [u.id, u.parent]), users.map(u => [u.id, u.parent]));
    const ti = new TurnIndex(path.join(TMP, 'turns'));
    assert.deepStrictEqual(ti.update('b0', fixture('branch.0'), { runtime: 'codex' }).marks
        .filter(m => m.kind === 'turn').map(m => m.id), users.map(u => u.id), 'the turn index keys turns the same way');

    assert.deepStrictEqual(reader.branchPoint(linesOf('branch.0'), users[1].id), { parent: turns[1], last: false });
    assert.deepStrictEqual(reader.branchPoint(linesOf('branch.0'), users[0].id), { parent: null, last: false });
    assert.strictEqual(reader.branchPoint(linesOf('branch.0'), randomUUID()), null);

    // The recording's own cut: beforeTurnId the second turn keeps only the first.
    const before = sentIn('branch', 'thread/fork').find(m => m.params.beforeTurnId);
    assert.strictEqual(before.params.beforeTurnId, turns[1]);
    const after = linesOf('branch.2').filter(e => e.type === 'response_item' && e.payload.role === 'assistant')
        .map(e => e.payload.content[0].text);
    assert.deepStrictEqual(after, ['heron'], 'the copy remembers the first word only');

    // The adapter sends that cut for a branch.
    const calls = [];
    const a = new codex.Adapter({ rpc: async (verb, params) => { calls.push([verb, params]); return verb === 'account/read' ? { account: {} } : {}; } });
    await a.handshake({ isNew: false, fork: true, sessionId: 'P', cwd: '/w', permissionMode: 'auto',
        branch: { fromUuid: users[1].id, parent: turns[1], guard: false } });
    assert.deepStrictEqual(calls[2], ['thread/fork', { ...calls[2][1], threadId: 'P', excludeTurns: true,
        beforeTurnId: turns[1] }]);
    // And a branch Codex refuses is a branch-refused send failure, not a resume.
    const refusing = new codex.Adapter({ rpc: async (verb) => {
        if (verb === 'thread/fork') throw Object.assign(new Error('turn is in progress'), { reason: 'refused' });
        return verb === 'account/read' ? { account: {} } : {};
    } });
    await assert.rejects(refusing.handshake({ isNew: false, fork: true, sessionId: 'P', cwd: '/w',
        branch: { fromUuid: users[1].id, parent: turns[1], guard: false } }), (e) => e.kind === 'branch-refused');
    ok('branching from a turn forks before the turn the message was in, keyed the same everywhere');
}

// --- the index: forks branch over inherited history; agents are subagents ----------------------------
{
    const day = path.join(CODEX_SESSIONS, '2026', '11', '26');
    fs.mkdirSync(day, { recursive: true });
    const PROJ = '/home/user/work/proj';
    const place = (name) => {
        const id = reader.scanMeta(fixture(name)).sessionId;
        const was = reader.scanMeta(fixture(name)).cwd;
        const file = path.join(day, `rollout-2026-11-26T17-00-00-${id}.jsonl`);
        fs.writeFileSync(file, fs.readFileSync(fixture(name), 'utf8').split(was).join(PROJ));
        return id;
    };
    const b0 = place('branch.0');
    const b1 = place('branch.1');
    const parent = place('subagent.0');
    const child = place('subagent.1');
    const index = new SessionIndex();
    await index.rescan();

    // A branch of a fork names a turn that is in the parent's rollout.
    const inherited = index.read(b1).events.filter(e => e.kind === 'user');
    assert.strictEqual(inherited.length, 3, 'two inherited turns and its own');
    assert.deepStrictEqual(index.codexBranchPoint(b1, inherited[1].id), { parent: inherited[1].parent, last: false });
    assert.strictEqual(index.codexBranchPoint(b0, randomUUID()), null);

    // The spawned agent's thread is the parent's subagent, never a row of its own.
    assert.ok(index.summary(parent), 'the parent is listed');
    assert.strictEqual(index.summary(child), null, 'the agent\'s thread is not a session');
    assert.ok(!index.list().some(s => s.sessionId === child));
    const row = index.read(parent).events.find(e => e.kind === 'tool' && e.name === 'Agent');
    assert.strictEqual(row.id, child, 'the row is keyed by the agent\'s thread');
    assert.strictEqual(row.status, 'ok', 'finished by its completed item');
    assert.deepStrictEqual([row.agent.agentId, row.agent.description, row.agent.hasTranscript, row.agent.spawnDepth],
        [child, 'heron_reply', true, 1]);
    assert.strictEqual(row.agent.agentType, reader.scanMeta(fixture('subagent.1')).agentNickname);
    const listed = index.subagents(parent);
    assert.deepStrictEqual(listed.map(a => [a.toolUseId, a.description]), [[child, 'heron_reply']]);
    const own = index.subagent(parent, child, 0);
    assert.deepStrictEqual(own.events.filter(e => e.kind === 'assistant').map(e => e.text), ['heron'],
        'the agent\'s own lines, not the parent history it opens with');
    assert.ok(!own.events.some(e => e.kind === 'user'), 'its copy of the parent\'s prompt is not shown again');
    assert.deepStrictEqual(index.subagent(parent, child, own.offset).events, [], 'and it tails from there');
    assert.strictEqual(index.subagent(b0, child, 0), null, 'only under the thread that spawned it');
    index.stop();
    ok('a fork branches over its inherited history, and a spawned agent is its parent\'s subagent');
}

// --- spawned agents on the wire -----------------------------------------------------------------------
{
    const a = new codex.Adapter({ rpc: async () => ({}) });
    const parentId = recv('subagent').find(m => m.result && m.result.thread).result.thread.id;
    a.threadId = parentId;
    const evs = recv('subagent').flatMap(m => a.read(m));
    assert.strictEqual(evs.filter(e => e.type === 'turn-end').length, 1,
        'the agent\'s turn/completed is not the parent\'s: one turn-end, the parent\'s');
    assert.strictEqual(evs.find(e => e.type === 'turn-end').result.text, 'heron', 'and it is the parent\'s answer');
    const child = reader.scanMeta(fixture('subagent.1')).sessionId;
    assert.deepStrictEqual(evs.filter(e => e.type === 'task').map(e => [e.id, e.state, e.taskType]),
        [[child, 'started', 'agent'], [child, 'done', 'agent']], 'background work while it runs');
    assert.deepStrictEqual(evs.filter(e => e.type === 'agent-done').map(e => [e.taskId, e.toolUseId, e.status]),
        [[child, child, 'completed']]);
    assert.ok(evs.some(e => e.type === 'tool-start' && /heron_reply/.test(e.label)), 'the activity line names it');
    assert.strictEqual(a.turnId, null, 'the agent\'s turn never became the one an interrupt would name');
    ok('a spawned agent\'s turn is never the parent\'s, and it runs as background work');
}

// --- skills: the palette, the input, the command ------------------------------------------------------
{
    const cwd = '/tmp/codex-fixture-skill';
    const data = [{ cwd, errors: [], skills: [
        { name: 'say-heron', description: 'Replies with the word heron and nothing else.', scope: 'repo',
            enabled: true, path: `${cwd}/.agents/skills/say-heron/SKILL.md` },
        { name: 'off', description: 'Disabled.', scope: 'user', enabled: false, path: '/x/SKILL.md' },
        { name: 'imagegen', description: 'Long.\nMore.', scope: 'system', enabled: true, path: '/s/SKILL.md',
            interface: { shortDescription: 'Generate or edit images' } },
    ] }];
    skills.prime(cwd, data);
    const palette = await skills.list(cwd);
    assert.deepStrictEqual(palette.commands, [
        { name: 'say-heron', description: 'Replies with the word heron and nothing else.', scope: 'repo' },
        { name: 'imagegen', description: 'Generate or edit images', scope: 'system' },
    ], 'enabled skills, with their short descriptions');
    assert.deepStrictEqual([palette.exact, palette.source], [true, 'codex']);

    const a = new codex.Adapter({ rpc: async () => ({}) });
    a.threadId = 't'; a.cwd = cwd;
    const line = a.turn({ uuid: 'u', text: '/say-heron then add the word twice' }, { handOver: false });
    assert.deepStrictEqual(line.params.input, [
        { type: 'skill', name: 'say-heron', path: `${cwd}/.agents/skills/say-heron/SKILL.md` },
        { type: 'text', text: '$say-heron then add the word twice' },
    ], 'a skill input beside the text, as the recording sent it');
    assert.deepStrictEqual(line.params.input, sentIn('skill', 'turn/start')[1].params.input
        .map(i => (i.type === 'skill' ? { ...i, path: `${cwd}/.agents/skills/say-heron/SKILL.md` } : i)));
    assert.deepStrictEqual(a.turn({ uuid: 'v', text: '/tmp/x is broken' }, { handOver: false }).params.input,
        [{ type: 'text', text: '/tmp/x is broken' }], 'a name no skill has is sent as typed');

    const users = eventsOf('skill').filter(e => e.kind === 'user');
    assert.deepStrictEqual(users.map(u => [u.text, u.command]), [
        ['', { name: 'say-heron', args: '' }],
        ['', { name: 'say-heron', args: 'then add the word twice' }],
    ], 'a `$name` mention and a skill input both read back as the command');
    assert.ok(!eventsOf('skill').some(e => e.kind === 'user' && /<skill>/.test(e.text)), 'the injected skill is noise');
    const plainUsers = eventsOf('branch.0').filter(e => e.kind === 'user');
    assert.ok(plainUsers.every(u => u.command === null), 'a message without a skill is not a command');
    ok('the palette is Codex\'s skills, a chosen one goes as a skill input, and it reads back as a command');
}

console.log(`\ncodex-features: ${pass} passed`);
process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
