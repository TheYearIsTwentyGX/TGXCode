'use strict';

// An image a tool result carried — a Read of a PNG, a browser screenshot — and
// how it reaches the dropdown.
//
// It used to reach it as the text `[image]`: resultPayload flattened every
// non-text block to its type, so a Read of a screenshot showed the path and a
// word. Now the event *describes* each image (`result.images`) and the client
// fetches the bytes from `/tool-image` when the dropdown is opened. Two things
// here are worth a test rather than a look:
//
// - **No base64 rides along on the event.** A screenshot is ~400 KB of it, and
//   an event is re-sent on every load and every live tail. Inlining it is the
//   obvious way to "fix" a missing picture, and it would make every
//   screenshot-heavy session slow to open without anything failing.
// - **The lookup skips a false hit.** It is a byte search for the id, and the
//   same text can turn up quoted in an earlier entry; a search that stopped at
//   the first hit would find no image at all.
//
// File-based, in a temp dir, with no bridge — SessionIndex is constructed but
// never scans.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildEvents, toolResultImage } = require('../bridge/transcript.js');
const { SessionIndex } = require('../bridge/sessions.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TS = '2026-10-14T12:00:00.000Z';
// Distinct bytes per image, so a wrong index is a wrong answer and not a lucky one.
const PNG_A = Buffer.from('\x89PNG\r\n\x1a\n-first-image', 'binary');
const PNG_B = Buffer.from('\x89PNG\r\n\x1a\n-second-image', 'binary');

function call(id, input = { file_path: '/tmp/shot.png' }) {
    return {
        type: 'assistant', timestamp: TS, uuid: `u-${id}`,
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input }] },
    };
}

function imageBlock(buf, mediaType = 'image/png') {
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } };
}

function result(id, content, structured) {
    return {
        type: 'user', timestamp: TS, uuid: `r-${id}`,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
        toolUseResult: structured,
    };
}

// The shape Claude Code writes for a Read of an image, trimmed.
const READ_STRUCT = {
    type: 'image',
    file: { base64: PNG_A.toString('base64'), type: 'image/png', originalSize: PNG_A.length,
        dimensions: { originalWidth: 1600, originalHeight: 950, displayWidth: 1600, displayHeight: 950 } },
};

const toolOf = (out, id) => out.events.find(e => e.kind === 'tool' && e.id === id);

// ── 1. the event describes the image and does not carry it ──────────────────

{
    const out = buildEvents([call('toolu_read1'), result('toolu_read1', [imageBlock(PNG_A)], READ_STRUCT)]);
    const ev = toolOf(out, 'toolu_read1');
    assert.deepStrictEqual(ev.result.images, [{ mediaType: 'image/png', width: 1600, height: 950 }]);
    ok('a Read of a PNG is described with its size');

    assert.strictEqual(ev.result.text, '');
    ok('the image is not flattened into the text as [image]');

    const json = JSON.stringify(out.events);
    assert.ok(!json.includes(PNG_A.toString('base64')), 'base64 leaked into an event');
    ok('no base64 travels on the event');
}

{
    // Two images and text, no structured file: sizes are unknown, order is kept.
    const out = buildEvents([call('toolu_shot'),
        result('toolu_shot', [{ type: 'text', text: 'Took a screenshot' },
            imageBlock(PNG_A), imageBlock(PNG_B, 'image/jpeg')])]);
    const ev = toolOf(out, 'toolu_shot');
    assert.deepStrictEqual(ev.result.images, [
        { mediaType: 'image/png', width: null, height: null },
        { mediaType: 'image/jpeg', width: null, height: null },
    ]);
    assert.strictEqual(ev.result.text, 'Took a screenshot');
    ok('several images keep their order, the text keeps its words');
}

{
    const out = buildEvents([call('toolu_txt'), result('toolu_txt', 'plain output')]);
    assert.deepStrictEqual(toolOf(out, 'toolu_txt').result.images, []);
    ok('a text result has images: [], not a missing field');
}

{
    // A live tail whose chunk has the result but not the call.
    const out = buildEvents([result('toolu_tail', [imageBlock(PNG_A)], READ_STRUCT)]);
    const patch = out.events.find(e => e.kind === 'tool-result');
    assert.strictEqual(patch.result.images.length, 1);
    ok('a tool-result patch carries images too');
}

// ── 2. reading the bytes back ────────────────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-image-'));
const SID = '11111111-2222-3333-4444-555555555555';
const main = path.join(root, `${SID}.jsonl`);
const lines = (entries) => entries.map(e => JSON.stringify(e)).join('\n') + '\n';

fs.writeFileSync(main, lines([
    // An earlier turn quoting the needle verbatim, before the real result.
    { type: 'user', timestamp: TS, uuid: 'q-1',
        message: { role: 'user', content: 'see "tool_use_id":"toolu_read1" in the log' } },
    call('toolu_read1'),
    result('toolu_read1', [imageBlock(PNG_A), imageBlock(PNG_B)], READ_STRUCT),
    call('toolu_txt'),
    result('toolu_txt', 'plain output'),
]));

{
    const a = toolResultImage(main, 'toolu_read1', 0);
    assert.strictEqual(a.mediaType, 'image/png');
    assert.ok(a.data.equals(PNG_A));
    assert.ok(toolResultImage(main, 'toolu_read1', 1).data.equals(PNG_B));
    ok('the nth image comes back byte for byte, past an entry quoting its id');

    assert.strictEqual(toolResultImage(main, 'toolu_read1', 2), null);
    assert.strictEqual(toolResultImage(main, 'toolu_txt', 0), null);
    assert.strictEqual(toolResultImage(main, 'toolu_nope', 0), null);
    assert.strictEqual(toolResultImage(main, 'toolu_read1', -1), null);
    assert.strictEqual(toolResultImage(main, 'toolu_read1', 0.5), null);
    ok('an index past the end, a text result and an unknown id are null');

    // An id is spliced into the search needle, so anything that could close the
    // JSON string is refused before it gets there.
    for (const bad of ['', null, 'toolu_read1"', 'a"b', '../x', 'x'.repeat(200)]) {
        assert.strictEqual(toolResultImage(main, bad, 0), null);
    }
    assert.strictEqual(toolResultImage(path.join(root, 'missing.jsonl'), 'toolu_read1', 0), null);
    ok('a malformed id or missing file is null, not a throw');
}

// ── 3. the index looks in subagents too ──────────────────────────────────

{
    const subDir = path.join(root, SID, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-abc.meta.json'),
        JSON.stringify({ toolUseId: 'toolu_task', agentType: 'Explore' }));
    fs.writeFileSync(path.join(subDir, 'agent-abc.jsonl'), lines([
        call('toolu_subread'),
        result('toolu_subread', [imageBlock(PNG_B)], READ_STRUCT),
    ]));

    const index = new SessionIndex();
    index.sessions.set(SID, { dir: root, file: main });

    assert.ok(index.toolImage(SID, 'toolu_read1', 0).data.equals(PNG_A));
    ok('the index finds an image in the session transcript');

    assert.ok(index.toolImage(SID, 'toolu_subread', 0).data.equals(PNG_B));
    ok('and in a subagent transcript, with the parent session id');

    assert.strictEqual(index.toolImage(SID, 'toolu_nope', 0), null);
    assert.strictEqual(index.toolImage('no-such-session', 'toolu_read1', 0), null);
    ok('an unknown id or session is null');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\ntool-image: ${pass} passed`);
