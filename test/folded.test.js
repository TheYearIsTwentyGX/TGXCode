'use strict';

// A message folded into a running turn — bridge/transcript.js, foldedUserEntry.
//
// Sent while a tool runs, a message is read by that turn at its next step, and
// what reaches disk is a `queued_command` attachment and **no `user` entry**. The
// failure this guards is silent: the conversation simply leaves out the message
// most likely to explain what the agent did next. The shapes below are copied
// from real transcripts — one this app's runner wrote through 2.1.280, one typed
// in a terminal, and one from an older build that wrote the attachment *and* a
// `user` entry for the same message, which must not be drawn twice.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildEvents, scanMeta } = require('../bridge/transcript.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-folded-'));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});

const user = (uuid, text, timestamp) => ({
    type: 'user', uuid, timestamp, cwd: '/tmp/x',
    message: { role: 'user', content: [{ type: 'text', text }] },
});
const toolUse = (uuid, id, timestamp) => ({
    type: 'assistant', uuid, timestamp,
    message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 4' } }] },
});
const toolResult = (uuid, id, timestamp) => ({
    type: 'user', uuid, timestamp,
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: '' }] },
});
const queued = (uuid, prompt, extra = {}, timestamp = '2026-09-23T14:26:09.596Z') => ({
    type: 'attachment', uuid, timestamp, isSidechain: false,
    attachment: { type: 'queued_command', prompt, commandMode: 'prompt', timestamp, ...extra },
});

const kinds = (events) => events.map(e => e.kind + (e.kind === 'user' ? `:${e.text}` : ''));

// --- the runner's shape: a block list, named by the uuid we sent ------------
{
    const entries = [
        user('u1', 'Run sleep three times', '2026-09-23T14:26:04.000Z'),
        toolUse('a1', 't1', '2026-09-23T14:26:09.484Z'),
        toolResult('r1', 't1', '2026-09-23T14:26:13.800Z'),
        queued('q1', [{ type: 'text', text: 'Also echo PINEAPPLE' }], { source_uuid: 'sent-1' }),
        toolUse('a2', 't2', '2026-09-23T14:26:16.349Z'),
    ];
    const { events } = buildEvents(entries);
    assert.deepStrictEqual(kinds(events),
        ['user:Run sleep three times', 'tool', 'user:Also echo PINEAPPLE', 'tool']);
    ok('a message folded into the running turn is drawn as a user message, where it landed');

    const file = path.join(TMP, 'runner.jsonl');
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    const meta = scanMeta(file);
    assert.strictEqual(meta.userMessages, 2, 'and it counts as a turn you took');
    assert.strictEqual(meta.lastUserTs, '2026-09-23T14:26:09.596Z', 'which moves the rail');
    ok('and the index counts it, so the rail sorts on it');
}

// --- a terminal's shape: a string prompt with a human origin ----------------
{
    const { events } = buildEvents([
        user('u1', 'Make a theme'),
        queued('q1', 'Can you go with a less harsh theme?', { origin: { kind: 'human' } }),
    ]);
    assert.deepStrictEqual(kinds(events), ['user:Make a theme', 'user:Can you go with a less harsh theme?']);
    ok('a message folded in from a terminal is drawn too');
}

// --- an older build: attachment at queue time, then a user entry as well ----
{
    const { events } = buildEvents([
        user('u1', 'first'),
        queued('q1', [{ type: 'text', text: 'second' }]),
        user('u2', 'second'),
    ]);
    assert.deepStrictEqual(kinds(events), ['user:first', 'user:second'],
        'the same message twice would read as having been sent twice');

    const { events: byId } = buildEvents([
        queued('q1', [{ type: 'text', text: 'again' }], { source_uuid: 'sent-2' }),
        user('sent-2', 'again'),
    ]);
    assert.deepStrictEqual(kinds(byId), ['user:again']);
    ok('a message that also reached disk as a user entry is drawn once');
}

// --- what is not a person talking stays as it was ----------------------------
{
    const { events } = buildEvents([
        queued('q1', '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n'
            + '<summary>Agent finished</summary>\n</task-notification>'),
        queued('q2', 'from a script', { origin: { kind: 'channel' } }),
        { ...queued('q3', 'meta'), isMeta: true },
        queued('q4', 'ls', { commandMode: 'bash' }),
    ]);
    assert.deepStrictEqual(kinds(events), [],
        'a task notification, another origin, a meta entry or a bash command is not a message you sent');
    ok('queued machine traffic is not mistaken for something you said');
}

console.log(`\n${pass} folded-message checks passed`);
