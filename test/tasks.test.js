'use strict';

// A session's own task list: the items, and the two formats they arrive in.
//
// Here rather than against a live bridge because it is all `bridge/tasks.js` and
// `todoList`/`todoInput` reading files, and because the cases that matter cannot
// be provoked through a request — they need a task directory with particular
// filenames in it, and a transcript with a particular malformed tool input.
//
// **Two traps, both measured rather than guessed.**
//
// `TASKS_DIR` is resolved when `bridge/tasks.js` is *required* (the module
// destructures it at load), so `CLAUDE_SESSIONS_TASKS_DIR` has to be in the
// environment before the require below — the same trap `runner.test.js`
// documents about `CLAUDE_SESSIONS_CLAUDE_BIN`.
//
// And `items()` memoises for a second, so asking twice about one session gives
// the first answer back. Every case below uses a **fresh session id** rather
// than sleeping: no timers in the suite, and it exercises the cache key on the
// way past.
//
// **The bugs this file is made of.**
//
// `readdirSync` returns whatever order the filesystem gives. `read()` only ever
// counted the files, so nothing noticed — but a list of ten tasks came back
// 1, 10, 2, 3, which is invisible in a count and glaring in a rendered list.
//
// And `todoProgress` tested `Array.isArray(input.todos)` and gave up on
// anything else. There is a real transcript on this machine whose `input.todos`
// is a JSON *string* holding the array, so that whole session reported no
// progress at all. The repair has to survive a string that parses into
// something that is still not a list — `"nope"` and `{}` are what a naive
// `JSON.parse` turns into a crash or a silently empty list.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TASKS = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tasks-dir-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tasks-'));
process.env.CLAUDE_SESSIONS_TASKS_DIR = TASKS;   // before the require, on purpose

const tasks = require('../bridge/tasks.js');
const { todoProgress, todoInput } = require('../bridge/transcript.js');

process.on('exit', () => {
    for (const d of [TASKS, TMP]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* going away anyway */ }
    }
});

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

/** A task directory for one session. `files` is name -> contents (string or object). */
function taskDir(sessionId, files) {
    const dir = path.join(TASKS, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name),
            typeof body === 'string' ? body : JSON.stringify(body));
    }
    return sessionId;
}

/** A transcript holding one TodoWrite call per entry. */
function transcript(name, calls) {
    const file = path.join(TMP, `${name}.jsonl`);
    const lines = calls.map(({ todos, ts, key = 'todos' }) => JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_x', name: 'TodoWrite', input: { [key]: todos } }],
        },
    }));
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
}

const TODOS = [
    { content: 'Alpha', status: 'completed', activeForm: 'Doing alpha' },
    { content: 'Beta', status: 'in_progress', activeForm: 'Doing beta' },
    { content: 'Gamma', status: 'pending', activeForm: 'Doing gamma' },
];

// ── the directory format ───────────────────────────────────────────────────

{
    const id = taskDir('dir-shape', {
        '1.json': { id: '1', subject: 'First', description: 'Does a thing.',
            activeForm: 'Doing the first', status: 'completed', blocks: [], blockedBy: [] },
        '2.json': { id: '2', subject: 'Second', activeForm: 'Doing the second',
            status: 'in_progress' },
        '3.json': { id: '3', subject: 'Third', status: 'pending', blockedBy: ['2'] },
    });
    const d = tasks.items(id);

    assert.strictEqual(d.source, 'directory');
    assert.deepStrictEqual(d.items[0], {
        id: '1', subject: 'First', description: 'Does a thing.',
        activeForm: 'Doing the first', status: 'completed', blocks: [], blockedBy: [],
    });
    // Absent fields are null and [], not undefined — a client should not have to
    // tell "no description" from "the field is missing".
    assert.strictEqual(d.items[1].description, null);
    assert.strictEqual(d.items[2].activeForm, null);
    assert.deepStrictEqual(d.items[2].blockedBy, ['2']);
    assert.deepStrictEqual(d.items[2].blocks, []);

    assert.strictEqual(d.done, 1);
    assert.strictEqual(d.total, 3);
    assert.strictEqual(d.current, 'Doing the second');
    assert.strictEqual(d.idle, false);
    assert.strictEqual(d.ts, null, 'the directory format records no times');
    assert.strictEqual(d.truncated, 0);

    // The five keys the boards read, and the same five `todoProgress` returns.
    const p = tasks.progress(id);
    assert.deepStrictEqual(Object.keys(p).sort(),
        ['current', 'done', 'idle', 'total', 'ts']);

    ok('a task directory normalises to one item shape, and the aggregate agrees');
}

{
    // The bug: readdir order. Ten tasks must not come back 1, 10, 2.
    const files = {};
    for (const n of [1, 2, 3, 10, 11]) files[`${n}.json`] = { id: String(n), subject: `T${n}` };
    const id = taskDir('dir-order', files);
    assert.deepStrictEqual(tasks.items(id).items.map(i => i.id),
        ['1', '2', '3', '10', '11']);

    ok('task files are ordered numerically, not by readdir');
}

{
    const id = taskDir('dir-junk', {
        '.lock': '',
        'notes.txt': 'not a task',
        '4.json': '{"id":',                       // half-written
        '1.json': { id: '1', subject: 'Real one' },
    });
    const d = tasks.items(id);
    assert.strictEqual(d.total, 1);
    assert.strictEqual(d.items[0].subject, 'Real one');

    ok('the lock file, a stray file and a half-written task are all skipped');
}

{
    const id = taskDir('dir-status', {
        '1.json': { id: '1', subject: 'Cancelled somehow', status: 'cancelled' },
        '2.json': { id: '2', subject: 'No status at all' },
    });
    const d = tasks.items(id);
    // Closed set: a client's switch never falls through to nothing.
    assert.strictEqual(d.items[0].status, 'pending');
    assert.strictEqual(d.items[1].status, 'pending');
    assert.strictEqual(d.done, 0);
    assert.strictEqual(d.idle, true, 'work left and nothing in progress');

    ok('an unknown status reads as pending, and a stalled list says so');
}

{
    const files = {};
    for (let n = 1; n <= tasks.MAX_TASKS + 50; n++) {
        files[`${n}.json`] = { id: String(n), subject: `T${n}` };
    }
    const id = taskDir('dir-cap', files);
    const d = tasks.items(id);
    assert.strictEqual(d.items.length, tasks.MAX_TASKS);
    // Reported rather than dropped silently: a short list shown as the whole one
    // is a lie, and the panel can say "and 50 more" instead.
    assert.strictEqual(d.truncated, 50);

    ok('a runaway list is capped, and says how much it dropped');
}

// ── the empty case ─────────────────────────────────────────────────────────

{
    const d = tasks.items('nobody-at-all', null);
    // An envelope, never null: an empty answer and a missing session are
    // different things, and the route only 404s the second.
    assert.deepStrictEqual(d, {
        source: null, items: [], done: 0, total: 0,
        current: null, idle: false, ts: null, truncated: 0,
    });
    // But `progress` still returns null, which is what both boards read as
    // "draw no progress bar". Changing that would put a 0/0 bar on every card.
    assert.strictEqual(tasks.progress('nobody-either', null), null);

    ok('a session with no list is an empty envelope, while progress stays null');
}

// ── the TodoWrite format ───────────────────────────────────────────────────

{
    const file = transcript('todo-newest', [
        { todos: [{ content: 'Stale', status: 'pending' }], ts: '2026-09-01T10:00:00Z' },
        { todos: TODOS, ts: '2026-09-01T11:00:00Z' },
    ]);
    const d = tasks.items('todo-newest', file);

    assert.strictEqual(d.source, 'todo');
    assert.strictEqual(d.total, 3, 'the newest call is the whole list');
    assert.strictEqual(d.items[0].subject, 'Alpha', 'content arrives as subject');
    // Null rather than a position: TodoWrite rewrites the list every call and
    // carries no ids, so any id here would be unstable across pushes.
    assert.strictEqual(d.items[0].id, null);
    assert.strictEqual(d.items[0].description, null, 'this format has no descriptions');
    assert.strictEqual(d.current, 'Doing beta');
    assert.strictEqual(d.ts, '2026-09-01T11:00:00Z');

    ok('the newest TodoWrite is the whole list, with content as subject and no ids');
}

{
    // The bug, from both ends: a JSON string where an array belongs.
    const file = transcript('todo-string', [
        { todos: JSON.stringify(TODOS), ts: '2026-09-01T12:00:00Z' },
    ]);
    const d = tasks.items('todo-string', file);
    assert.strictEqual(d.source, 'todo');
    assert.strictEqual(d.total, 3);
    assert.strictEqual(d.items[1].subject, 'Beta');
    // And the boards' count, which returned null for this session before.
    const p = todoProgress(file);
    assert.ok(p, 'todoProgress must not give up on a stringified list');
    assert.strictEqual(p.total, 3);
    assert.strictEqual(p.done, 1);

    ok('a stringified todos array is repaired, for the panel and for the boards');
}

{
    // A string that parses into something that is still not a list. This is the
    // failure a naive JSON.parse introduces, so it is asserted rather than
    // assumed.
    assert.deepStrictEqual(todoInput({ todos: '"nope"' }), []);
    assert.deepStrictEqual(todoInput({ todos: '{}' }), []);
    assert.deepStrictEqual(todoInput({ todos: 'not json at all' }), []);
    assert.deepStrictEqual(todoInput({}), []);

    const file = transcript('todo-junk', [{ todos: '"nope"', ts: '2026-09-01T12:00:00Z' }]);
    assert.strictEqual(tasks.items('todo-junk', file).source, null,
        'unparseable falls through to the empty envelope rather than throwing');

    ok('a string that is not a list is discarded, not half-trusted');
}

{
    // `web/app.js` has read `i.tasks || i.todos` for as long as it has drawn
    // this block, so both keys are accepted and the client stops guessing.
    const file = transcript('todo-alias', [
        { todos: TODOS, ts: '2026-09-01T13:00:00Z', key: 'tasks' },
    ]);
    const d = tasks.items('todo-alias', file);
    assert.strictEqual(d.source, 'todo');
    assert.strictEqual(d.total, 3);

    ok('`tasks` is accepted as an alias for `todos`');
}

// ── precedence ─────────────────────────────────────────────────────────────

{
    const id = taskDir('both-sources', {
        '1.json': { id: '1', subject: 'From the directory', status: 'pending' },
    });
    const file = transcript('both-sources', [{ todos: TODOS, ts: '2026-09-01T14:00:00Z' }]);
    const d = tasks.items(id, file);
    // The directory is current state; a transcript tail is a record of edits.
    // Same precedence `progress()` has always had, now pinned.
    assert.strictEqual(d.source, 'directory');
    assert.strictEqual(d.items[0].subject, 'From the directory');

    ok('the directory wins over the transcript when both have something to say');
}

// ── the same repair, on the client's side of the wire ──────────────────────

{
    // `web/app.js` renders a TodoWrite block in the transcript from `ev.input`
    // as the tool wrote it — the bridge's normaliser is not in that path — so
    // `todoItemsOf` there has to do what `todoInput` does here. It is asserted
    // by reading the source rather than by running a DOM: there is no browser in
    // this suite, and the failure mode is silent.
    //
    // This is not hypothetical. Three call sites read `i.tasks || i.todos` and
    // trusted the result. On the session whose `todos` is a JSON string, the
    // collapsed summary counted the *characters* of that string and offered
    // "1041 items", and iterating it walked the list one character at a time.
    const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

    assert.ok(app.includes('function todoItemsOf('),
        'web/app.js must have the client-side half of the repair');
    // No call site may go back to reading the raw keys, which is what made the
    // string shape a bug in three places at once.
    const raw = app.match(/i\.tasks \|\| i\.todos/g) || [];
    assert.strictEqual(raw.length, 1,
        'only the comment explaining the trap may still name the raw keys');

    ok('the transcript renderer repairs a stringified list too, not just the bridge');
}

// ── the tools this all depends on being switched on ────────────────────────

{
    // The whole feature reads a list that current models are not offered the
    // tools to keep, so `cfg.TODO_TOOLS` is what decides whether any of the
    // above ever has anything to show. Read at require time, so both branches
    // need the module cache cleared.
    //
    // `sessionEnv()` is not asserted here: it is not exported, and exporting it
    // to test one `if` would be worse than checking the thing it reads. That it
    // reaches the CLI is only really provable by spawning one, which the
    // dev-bridge pass does.
    const configPath = require.resolve('../bridge/config.js');
    const before = process.env.CLAUDE_SESSIONS_TODO_TOOLS;
    const reload = (value) => {
        if (value === undefined) delete process.env.CLAUDE_SESSIONS_TODO_TOOLS;
        else process.env.CLAUDE_SESSIONS_TODO_TOOLS = value;
        delete require.cache[configPath];
        return require('../bridge/config.js').TODO_TOOLS;
    };

    assert.strictEqual(reload(undefined), true, 'on unless turned off');
    assert.strictEqual(reload('0'), false, 'the opt-out');
    // Only an exact '0'. A stray value should not quietly disable the panel.
    assert.strictEqual(reload('1'), true);
    assert.strictEqual(reload(''), true);

    reload(before);
    ok('the task tools are on by default, and `=0` is the only way off');
}

console.log(`\n${pass} groups passed`);
