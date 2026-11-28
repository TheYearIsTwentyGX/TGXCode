'use strict';

// The bridge's own envelopes in a Codex rollout: a handoff, an orchestrator's
// nudge and an orchestrator's message to a worker reach Codex as the text of a
// user turn, and the Codex reader has to read them back the way the Claude reader
// does — as their own cards, never as words the person typed, and never as a turn
// that moves the session up the rail.
//
//   node test/codex-envelopes.test.js
//
// No bridge and no Codex. The rollout is plain.rollout.jsonl with three user
// messages appended in the shape 0.172.0 writes a typed one, each carrying an
// envelope written by bridge/envelopes.js itself.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const codex = require('../bridge/runtimes/codex/transcript');
const {
    handoffEnvelope, orchestratorInboxEnvelope, orchestratorMessageEnvelope,
} = require('../bridge/envelopes');

const FIX = path.join(__dirname, 'fixtures', 'codex');
let n = 0;
function test(name, fn) {
    try { fn(); n++; console.log(`ok - ${name}`); } catch (err) {
        console.error(`not ok - ${name}\n${err.stack}`);
        process.exitCode = 1;
    }
}

/** A user message line as Codex writes one the person typed. */
function userLine(text, ordinal, ts) {
    return JSON.stringify({ timestamp: ts, ordinal, type: 'response_item', payload: {
        type: 'message', id: `msg_01a218f8-0000-7000-8000-00000000000${ordinal % 10}`, role: 'user',
        content: [{ type: 'input_text', text }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-x', content_item_kinds: ['user.text'] },
    } });
}

const base = fs.readFileSync(path.join(FIX, 'plain.rollout.jsonl'), 'utf8').trimEnd().split('\n');
const last = base.reduce((m, l) => Math.max(m, JSON.parse(l).ordinal || 0), 0);
const inbox = orchestratorInboxEnvelope({ count: 2, counts: { turn: 1, question: 1 }, summary: '1 question, 1 turn report' });
const message = orchestratorMessageEnvelope({ from: 'orch-1', fromTitle: 'Planner', text: 'Carry on with step two.' });
const handoff = handoffEnvelope({ text: 'The port is 45901.', fromId: 'peer-1', fromTitle: 'Other', title: 'Port' });
const lines = [
    ...base,
    userLine(inbox, last + 1, '2026-11-27T10:00:00.000Z'),
    userLine(message, last + 2, '2026-11-27T10:01:00.000Z'),
    userLine(handoff, last + 3, '2026-11-27T10:02:00.000Z'),
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-codex-env-'));
const file = path.join(dir, 'rollout-2026-11-26T17-48-20-01a218f8-f9d4-7f61-9e9b-5d4b8d5e3a11.jsonl');
fs.writeFileSync(file, lines.join('\n') + '\n');

test('envelopeOf names each envelope and leaves a person\'s words alone', () => {
    assert.strictEqual(codex.envelopeOf(inbox).kind, 'orchestrator-inbox');
    assert.strictEqual(codex.envelopeOf(message).kind, 'orchestrator-message');
    assert.strictEqual(codex.envelopeOf(handoff).kind, 'handoff');
    assert.strictEqual(codex.envelopeOf('Reply with the single word: pong.'), null);
    // Quoting a tag in prose is not sending one.
    assert.strictEqual(codex.envelopeOf('What does <orchestrator-message> mean?'), null);
});

test('each envelope is its own event, with the Claude reader\'s fields', () => {
    const { entries } = codex.parseLines(codex.readFile(file));
    const out = codex.buildEvents(entries, {});
    const events = out.events || out;
    const kinds = events.map(e => e.kind);
    assert.ok(kinds.includes('orchestrator-inbox'), kinds.join(','));
    assert.ok(kinds.includes('orchestrator-message'));
    assert.ok(kinds.includes('handoff'));
    const users = events.filter(e => e.kind === 'user');
    assert.strictEqual(users.length, 1, 'only the person\'s own message is a user event');
    assert.ok(!users.some(u => /orchestrator-|session-handoff/.test(u.text)), 'no raw markup in a user event');
    const msg = events.find(e => e.kind === 'orchestrator-message');
    assert.strictEqual(msg.from, 'orch-1');
    assert.strictEqual(msg.fromTitle, 'Planner');
    assert.match(msg.text, /Carry on with step two/);
    const nudge = events.find(e => e.kind === 'orchestrator-inbox');
    assert.strictEqual(nudge.count, 2);
});

test('the scan does not count them as turns, so the rail does not move for a nudge', () => {
    const meta = codex.scanMeta(file);
    const plain = codex.scanMeta(path.join(FIX, 'plain.rollout.jsonl'));
    assert.strictEqual(meta.userMessages, plain.userMessages);
    assert.strictEqual(meta.lastUserTs, plain.lastUserTs);
    assert.strictEqual(meta.lastPrompt, plain.lastPrompt);
    assert.strictEqual(meta.handoffs, 1);
    assert.strictEqual(meta.lastHandoffFrom, 'Other');
    assert.strictEqual(meta.lastHandoffTs, '2026-11-27T10:02:00.000Z');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`${n} passed`);
