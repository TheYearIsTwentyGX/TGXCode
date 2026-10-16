'use strict';

// bridge/worker-read.js's digest, over a fixture transcript: the `fields` the
// orchestrator page lays out must be the same reading as the `text` the
// orchestrator's model reads, not a second count that could drift from it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-wread-'));
process.env.XDG_DATA_HOME = home;

const { digest } = require('../bridge/worker-read');

const file = path.join(home, 'w.jsonl');
const at = (n) => new Date(1_700_000_000_000 + n * 1000).toISOString();
const lines = [
    { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'Build the panel' } },
    { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [
            { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
            { content: 'Write the panel', status: 'in_progress', activeForm: 'Writing the panel' },
            { content: 'Test it', status: 'pending', activeForm: 'Testing it' },
        ] } },
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/x/panel.js', old_string: 'a', new_string: 'b' } },
        { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/x/panel.css', old_string: 'a', new_string: 'b' } },
        { type: 'text', text: 'The panel is drawn; testing next.' },
    ] } },
];
fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

(async () => {
    const d = await digest(file, { cwd: null, status: { state: 'busy', pendingPermission: { kind: 'plan' } } });
    assert.match(d.text, /^state: busy — waiting on a plan approval/);
    assert.deepStrictEqual(d.fields, {
        state: 'busy',
        pending: 'plan',
        turns: 1,
        todo: { done: 1, total: 3, now: 'Write the panel' },
        tools: [{ name: 'Edit', n: 2 }, { name: 'TodoWrite', n: 1 }],
        files: ['/x/panel.js', '/x/panel.css'],
        diffStat: null,
        lastMessage: 'The panel is drawn; testing next.',
    });

    const none = await digest(file, { cwd: null, status: null, lastResult: 'Final words.' });
    assert.strictEqual(none.fields.state, null, 'no process is null, not a sentence');
    assert.strictEqual(none.fields.lastMessage, 'Final words.', 'the runner\'s last result wins over the file');
    console.log('  ok  the digest\'s fields are the same reading as its text');
    fs.rmSync(home, { recursive: true, force: true });
    console.log('\n1 worker-read check passed');
})().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
