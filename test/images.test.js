'use strict';

// Every image in a conversation, once each — the Images pane's list, and the
// index behind it (bridge/image-index.js).
//
// Four things here are worth a test rather than a look:
//
// - **Dedup is by the decoded bytes, across kinds.** A picture you attached and
//   the same picture a tool handed back are one entry with two occurrences, and
//   so are two copies of it in different blocks of one message.
// - **A tool result can hold several images**, and each keeps its own `n` — the
//   index `/tool-image` takes — rather than all of them answering to the first.
// - **The cache is incremental.** An append is read from where the last read
//   stopped, not from the top: the test proves it by scribbling over bytes the
//   index has already read and checking nothing it found goes away. A rewrite
//   from the start, on the other hand, must throw the index away.
// - **No base64 on the list.** Each entry is a key and a URL; the bytes come
//   back through `bytes()`, which re-hashes what it reads.
//
// File-based, in a temp dir, with no bridge. Remote gating is the live half, in
// refusals.test.js.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ImageIndex, imageSize } = require('../bridge/image-index.js');
const { SessionIndex } = require('../bridge/sessions.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'images-test-'));
const cacheDir = path.join(root, 'cache');
const SID = '11111111-2222-3333-4444-555555555555';
const main = path.join(root, `${SID}.jsonl`);
const lines = (entries) => entries.map(e => JSON.stringify(e)).join('\n') + '\n';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// A real PNG header (IHDR 1600×950) so the size is read off the bytes, then a
// tail that makes each picture distinct.
function png(w, h, tag) {
    const head = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
    head.writeUInt32BE(13, 8);
    head.write('IHDR', 12, 'ascii');
    head.writeUInt32BE(w, 16);
    head.writeUInt32BE(h, 20);
    return Buffer.concat([head, Buffer.from(tag)]);
}
const A = png(1600, 950, 'image-a');
const B = png(800, 600, 'image-b');
const C = png(64, 64, 'image-c');

const img = (buf, mediaType = 'image/png') => ({
    type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') },
});
let clock = 0;
const ts = () => new Date(Date.UTC(2026, 9, 21, 12, 0, clock++)).toISOString();
const you = (uuid, blocks) => ({
    type: 'user', uuid, timestamp: ts(), message: { role: 'user', content: blocks },
});
const callOf = (uuid, id, name, input) => ({
    type: 'assistant', uuid, timestamp: ts(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const resultOf = (uuid, id, content) => ({
    type: 'user', uuid, timestamp: ts(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    toolUseResult: { type: 'image', file: { base64: content[0] && content[0].source ? content[0].source.data : '' } },
});

fs.writeFileSync(main, lines([
    you('u-1', [{ type: 'text', text: 'look at this' }, img(A)]),
    callOf('a-1', 'toolu_read', 'Read', { file_path: '/work/shots/home.png' }),
    resultOf('r-1', 'toolu_read', [img(A)]),
    callOf('a-2', 'toolu_shot', 'mcp__playwright__browser_take_screenshot', {}),
    // Several images in one result: B, then A again.
    resultOf('r-2', 'toolu_shot', [{ type: 'text', text: 'two shots' }, img(B), img(A)]),
    // The same bytes twice in one message, in different blocks.
    you('u-2', [img(C), { type: 'text', text: 'and again' }, img(C)]),
    // Not counted: the same request echoed as a blob.
    { type: 'api-request-blob', uuid: 'x-1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: [img(B)] }] } },
    callOf('a-3', 'toolu_agent', 'Agent', { description: 'look around' }),
]));

const url = (k) => `/x/${k}`;

// ── 1. dedup across user and tool images ─────────────────────────────────

const ii = new ImageIndex(cacheDir);
let idx = ii.update(SID, main);
let list = ii.list(idx, url);
{
    assert.strictEqual(list.length, 3, 'A, B and C, once each');
    const a = list.find(e => e.key === sha(A));
    assert.strictEqual(a.count, 3);
    assert.deepStrictEqual(a.occurrences.map(o => o.source), ['user', 'tool', 'tool']);
    assert.strictEqual(a.source, 'user');
    assert.strictEqual(a.uuid, 'u-1');
    assert.strictEqual(a.label, 'Your message');
    assert.deepStrictEqual(a.occurrences.map(o => o.label), ['Your message', 'home.png', 'Playwright: Browser Take Screenshot']);
    ok('one picture attached and returned by two tools is one entry, count 3');

    assert.deepStrictEqual([a.width, a.height, a.bytes, a.mediaType], [1600, 950, A.length, 'image/png']);
    assert.strictEqual(a.url, `/x/${sha(A)}`);
    ok('it carries its size from the header, its length and a URL by key');

    const c = list.find(e => e.key === sha(C));
    assert.strictEqual(c.count, 2);
    assert.deepStrictEqual(c.occurrences.map(o => o.uuid), ['u-2', 'u-2']);
    ok('identical bytes in two blocks of one message are one entry, count 2');

    assert.strictEqual(list.find(e => e.key === sha(B)).count, 1);
    ok('an api-request-blob echo is not counted');

    const json = JSON.stringify(list);
    for (const b of [A, B, C]) assert.ok(!json.includes(b.toString('base64')), 'base64 leaked into the list');
    ok('no base64 on the list');

    // Newest first, by first occurrence: C (u-2) was first seen last.
    assert.deepStrictEqual(list.map(e => e.key), [sha(C), sha(B), sha(A)]);
    ok('ordered newest first by first occurrence');

    assert.deepStrictEqual(a.occurrences[0].anchor, { kind: 'user', id: 'u-1', offset: 0 });
    assert.strictEqual(a.occurrences[1].anchor.kind, 'tool');
    assert.strictEqual(a.occurrences[1].anchor.id, 'toolu_read');
    ok('each occurrence says where in the log it is');
}

// ── 2. a tool result holding several images ──────────────────────────────

{
    const b = list.find(e => e.key === sha(B));
    assert.deepStrictEqual([b.source, b.toolUseId, b.n], ['tool', 'toolu_shot', 0]);
    const a = list.find(e => e.key === sha(A));
    const fromShot = a.occurrences.find(o => o.toolUseId === 'toolu_shot');
    assert.strictEqual(fromShot.n, 1);
    ok('each image in a multi-image result keeps its own n');

    assert.ok(ii.bytes(idx, sha(B)).data.equals(B));
    assert.ok(ii.bytes(idx, sha(A)).data.equals(A));
    assert.ok(ii.bytes(idx, sha(C)).data.equals(C));
    assert.strictEqual(ii.bytes(idx, sha(Buffer.from('nope'))), null);
    assert.strictEqual(ii.bytes(idx, '__proto__'), null);
    ok('the bytes come back by key, and an unknown key is null');
}

// ── 3. the incremental cache picks up appended images ────────────────────

{
    const before = idx.sources.main.consumed;
    assert.strictEqual(before, fs.statSync(main).size);

    // Scribble over everything after the first line, at the same length. An
    // index that re-read from the top would now find none of A, B or C.
    const buf = fs.readFileSync(main);
    const nl = buf.indexOf(0x0a);
    for (let i = nl + 1; i < buf.length; i++) if (buf[i] !== 0x0a) buf[i] = 0x20;
    fs.writeFileSync(main, buf);

    const D = png(10, 20, 'image-d');
    fs.appendFileSync(main, lines([
        callOf('a-4', 'toolu_read2', 'Read', { file_path: '/work/d.png' }),
        resultOf('r-4', 'toolu_read2', [img(D)]),
        you('u-3', [img(A)]),
    ]));
    idx = ii.update(SID, main);
    list = ii.list(idx, url);
    assert.strictEqual(list.length, 4);
    assert.strictEqual(list[0].key, sha(D));
    assert.strictEqual(list[0].label, 'd.png');
    assert.strictEqual(list.find(e => e.key === sha(A)).count, 4);
    assert.ok(idx.sources.main.consumed > before);
    ok('an append is read from where the last read stopped');

    // And from disk, by a fresh instance: the same answer without a re-read.
    const again = new ImageIndex(cacheDir);
    const idx2 = again.update(SID, main);
    assert.deepStrictEqual(again.list(idx2, url), list);
    ok('the index persists and a new instance picks it up');

    // A rewrite from the start (a different first line) is a rebuild.
    fs.writeFileSync(main, lines([you('u-new', [img(B)])]));
    idx = ii.update(SID, main);
    list = ii.list(idx, url);
    assert.deepStrictEqual(list.map(e => [e.key, e.count]), [[sha(B), 1]]);
    ok('a transcript rewritten from the top is rebuilt, not appended to');
}

// ── 4. subagents, through the session index ──────────────────────────────

{
    fs.writeFileSync(main, lines([
        you('u-1', [img(A)]),
        callOf('a-3', 'toolu_agent', 'Agent', { description: 'look around' }),
    ]));
    const subDir = path.join(root, SID, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-abc.meta.json'),
        JSON.stringify({ toolUseId: 'toolu_agent', agentType: 'Explore' }));
    fs.writeFileSync(path.join(subDir, 'agent-abc.jsonl'), lines([
        { ...callOf('s-1', 'toolu_subread', 'Read', { file_path: '/work/sub.png' }), isSidechain: true },
        { ...resultOf('s-2', 'toolu_subread', [img(A), img(B)]), isSidechain: true },
    ]));

    const index = new SessionIndex();
    index.imageIndex = new ImageIndex(path.join(root, 'cache2'));
    index.sessions.set(SID, { dir: root, file: main });
    const got = index.images(SID, url);
    assert.deepStrictEqual(got.map(e => [e.key, e.count]), [[sha(B), 1], [sha(A), 2]]);
    const sub = got[0].occurrences[0];
    assert.strictEqual(sub.agent, 'toolu_agent');
    assert.strictEqual(sub.label, 'sub.png');
    assert.deepStrictEqual([sub.anchor.kind, sub.anchor.id], ['tool', 'toolu_agent']);
    ok('a subagent’s images are included, and jump to the call that spawned it');

    assert.ok(index.imageBytes(SID, sha(B)).data.equals(B));
    assert.strictEqual(index.images('no-such-session', url), null);
    assert.strictEqual(index.imageBytes('no-such-session', sha(B)), null);
    ok('the bytes are served from the subagent file; an unknown session is null');
}

// ── 5. sizes off the header ──────────────────────────────────────────────

{
    assert.deepStrictEqual(imageSize(png(3, 4, 'x')), { width: 3, height: 4 });
    const gif = Buffer.from('GIF89a\x05\x00\x07\x00rest', 'binary');
    assert.deepStrictEqual(imageSize(gif), { width: 5, height: 7 });
    // SOI, an APP0 of length 4, then SOF0 with height 9 and width 12.
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
        0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x09, 0x00, 0x0c, 0x03, 0, 0, 0, 0, 0, 0]);
    assert.deepStrictEqual(imageSize(jpg), { width: 12, height: 9 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii'); webp.write('WEBP', 8, 'ascii'); webp.write('VP8X', 12, 'ascii');
    webp.writeUIntLE(99, 24, 3); webp.writeUIntLE(49, 27, 3);
    assert.deepStrictEqual(imageSize(webp), { width: 100, height: 50 });
    assert.strictEqual(imageSize(Buffer.from('not an image')), null);
    assert.strictEqual(imageSize(Buffer.from([0x89, 0x50])), null);
    ok('PNG, GIF, JPEG and WebP sizes come off the header; junk is null');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nimages: ${pass} passed`);
