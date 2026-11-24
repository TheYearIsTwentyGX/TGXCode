'use strict';

// The screenshot tool's parts that need no browser and no bridge — scripts/screenshots/.
//
// What is worth testing here is what would go wrong *quietly*. A picture with a
// real person's session in it, or a path that names their home directory, is a
// failure nothing throws on: it is found by a stranger looking at a public README.
// So most of this file is the guards — the scan of everything seeded, and the proof
// that the scan actually fires — and the rest is the seed being internally
// consistent, because a transcript that edits a file that is not there, or an
// orchestrator naming a worker with no transcript, makes a picture that is wrong
// rather than one that fails.
//
//   node test/screenshots.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { encode } = require('../scripts/screenshots/png');
const { Conversation, patchFor, numbered } = require('../scripts/screenshots/transcript');
const { seed, guard, uid } = require('../scripts/screenshots/seed');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshots-test-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// png.js
// ---------------------------------------------------------------------------

/** A PNG back into rows of RGB, for the two kinds this encoder writes (RGB and indexed). */
function decodePng(buf) {
    assert.deepStrictEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let at = 8;
    let head = null;
    let palette = null;
    const idat = [];
    while (at < buf.length) {
        const len = buf.readUInt32BE(at);
        const type = buf.toString('ascii', at + 4, at + 8);
        const data = buf.subarray(at + 8, at + 8 + len);
        const crc = buf.readUInt32BE(at + 8 + len);
        assert.strictEqual(crc, zlib.crc32(buf.subarray(at + 4, at + 8 + len)) >>> 0, `bad CRC on ${type}`);
        if (type === 'IHDR') head = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), type: data[9] };
        if (type === 'PLTE') palette = data;
        if (type === 'IDAT') idat.push(data);
        at += 12 + len;
    }
    const bpp = head.type === 2 ? 3 : 1;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = head.w * bpp;
    const px = Buffer.alloc(stride * head.h);
    for (let y = 0; y < head.h; y++) {
        const f = raw[y * (stride + 1)];
        for (let i = 0; i < stride; i++) {
            const x = raw[y * (stride + 1) + 1 + i];
            const a = i >= bpp ? px[y * stride + i - bpp] : 0;
            const b = y ? px[(y - 1) * stride + i] : 0;
            const c = y && i >= bpp ? px[(y - 1) * stride + i - bpp] : 0;
            let p = 0;
            if (f === 1) p = a;
            else if (f === 2) p = b;
            else if (f === 3) p = (a + b) >> 1;
            else if (f === 4) {
                const q = a + b - c;
                const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
                p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            px[y * stride + i] = (x + p) & 255;
        }
    }
    const rgb = Buffer.alloc(head.w * head.h * 3);
    for (let i = 0; i < head.w * head.h; i++) {
        if (bpp === 3) px.copy(rgb, i * 3, i * 3, i * 3 + 3);
        else palette.copy(rgb, i * 3, px[i] * 3, px[i] * 3 + 3);
    }
    return { ...head, rgb };
}

function rgbaOf(w, h, fn) {
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const [r, g, b] = fn(x, y);
        out.set([r, g, b, 255], (y * w + x) * 4);
    }
    return out;
}

{
    // Few colours: stored exactly, as an indexed image.
    const flat = rgbaOf(40, 30, (x, y) => (x < 20 ? [10, 20, 30] : y < 15 ? [200, 100, 50] : [250, 250, 250]));
    const { png, lossy } = encode(flat, 40, 30);
    assert.strictEqual(lossy, false);
    const back = decodePng(png);
    assert.strictEqual(back.type, 3, 'indexed');
    assert.deepStrictEqual([back.w, back.h], [40, 30]);
    for (let i = 0; i < 40 * 30; i++) {
        assert.deepStrictEqual([...back.rgb.subarray(i * 3, i * 3 + 3)], [...flat.subarray(i * 4, i * 4 + 3)]);
    }
    ok('a picture of a few colours round-trips exactly, as an indexed image');
}
{
    // Many colours that fit the budget: lossless, true colour.
    const grad = rgbaOf(64, 64, (x, y) => [x * 4, y * 4, (x + y) * 2]);
    const { png, lossy } = encode(grad, 64, 64, 10 * 1024 * 1024);
    assert.strictEqual(lossy, false);
    const back = decodePng(png);
    assert.strictEqual(back.type, 2);
    for (let i = 0; i < 64 * 64; i++) {
        assert.deepStrictEqual([...back.rgb.subarray(i * 3, i * 3 + 3)], [...grad.subarray(i * 4, i * 4 + 3)]);
    }
    ok('a picture inside its budget stays lossless');
}
{
    // Over budget: 256 colours, and close to the original.
    const grad = rgbaOf(96, 96, (x, y) => [x * 2 + (y % 3), y * 2, (x * y) % 251]);
    const { png, lossy } = encode(grad, 96, 96, 1024);
    assert.strictEqual(lossy, true);
    const back = decodePng(png);
    assert.strictEqual(back.type, 3, 'indexed');
    let worst = 0;
    for (let i = 0; i < 96 * 96; i++) {
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(back.rgb[i * 3 + k] - grad[i * 4 + k]));
    }
    assert.ok(worst < 48, `colours stay close to the original (worst channel error ${worst})`);
    ok('over budget it quantises to 256 colours and keeps them close');
}

// ---------------------------------------------------------------------------
// transcript.js
// ---------------------------------------------------------------------------

{
    const dir = path.join(root, 'proj');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n');
    const c = new Conversation({ sessionId: uid('t'), cwd: dir, title: 'A test', startedAt: 0 });
    c.user('hello');
    c.edit('src/a.js', 'four\n', 'four\nfour-and-a-half\n');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'src', 'a.js'), 'utf8').includes('four-and-a-half'), true,
        'an edit changes the file as well as the record');
    assert.throws(() => c.edit('src/a.js', 'not there', 'x'), /does not apply/);
    assert.throws(() => c.edit('src/a.js', 'e', 'x'), /ambiguous/);

    const lines = c.toJsonl().trim().split('\n').map(l => JSON.parse(l));
    assert.strictEqual(lines[0].type, 'ai-title');
    const edit = lines.find(l => l.toolUseResult && l.toolUseResult.structuredPatch);
    const hunk = edit.toolUseResult.structuredPatch[0];
    assert.ok(hunk.lines.some(l => l === '+four-and-a-half'));
    assert.ok(hunk.lines.some(l => l === ' three'), 'three lines of context before');
    // Each entry points at the one before it: that is how the CLI chains them, and
    // how the app tells a conversation from a pile of lines.
    const body = lines.filter(l => l.uuid);
    for (let i = 1; i < body.length; i++) assert.strictEqual(body[i].parentUuid, body[i - 1].uuid);
    ok('a scripted edit changes the file, refuses what does not apply, and chains its entries');

    const file = c.save(path.join(root, 'projects'), { endAt: Date.now() - 5 * 60_000 });
    assert.ok(file.includes(dir.replace(/[/.]/g, '-')), 'filed under the escaped cwd');
    const age = Date.now() - fs.statSync(file).mtimeMs;
    assert.ok(age > 4.9 * 60_000 && age < 5.1 * 60_000, `mtime follows the last entry (${age}ms ago)`);
    const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop());
    assert.ok(Math.abs(Date.parse(last.timestamp) - (Date.now() - 5 * 60_000)) < 1000);
    ok('save files it under the escaped cwd and dates the file by its last entry');

    assert.deepStrictEqual(patchFor('a\nb\nc\n', 'a\nB\nc\n')[0].lines, [' a', '-b', '+B', ' c']);
    assert.strictEqual(numbered('x\ny\n'), '     1→x\n     2→y');
    ok('the diff and the numbered listing read as the CLI writes them');
}

// ---------------------------------------------------------------------------
// the guard
// ---------------------------------------------------------------------------

{
    const dir = path.join(root, 'guard');
    fs.mkdirSync(dir, { recursive: true });
    const plant = (text) => { fs.writeFileSync(path.join(dir, 'x.jsonl'), text); };
    const refuses = (text, why) => {
        plant(text);
        assert.throws(() => guard([dir]), new RegExp(why), `refuses ${why}: ${text}`);
    };

    plant('{"text":"a perfectly ordinary demo sentence about taskly"}');
    guard([dir]);

    // What is specific to whoever runs this comes from the environment, not from
    // the source: this repository is public.
    process.env.TGXCODE_SHOTS_EXCLUDE = 'secret-project, private.example';
    refuses('worked in the SECRET-PROJECT repo', 'excluded term');
    refuses('https://private.example/pair', 'excluded term');
    delete process.env.TGXCODE_SHOTS_EXCLUDE;
    plant('secret-project is fine when nothing excludes it');
    guard([dir]);
    refuses('/home/someoneelse/Projects/x', 'home directory');
    refuses('mail me at person@example.org', 'email');
    refuses('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'API key');
    refuses('ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'GitHub token');
    refuses('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', 'bearer');
    refuses('token ' + 'a'.repeat(64), 'hex');
    refuses('-----BEGIN OPENSSH PRIVATE KEY-----', 'private key');
    // The demo's own address and home are allowed.
    plant('demo@example.invalid and /home/demo/Projects/taskly');
    guard([dir]);
    // A picture's base64 is not a token.
    plant(JSON.stringify({ data: 'A'.repeat(300) + '0123456789abcdef'.repeat(4) }).replace('{"data"', '{"data"'));
    guard([dir]);
    ok('the guard refuses excluded terms, the homes of other users, addresses and secrets — and nothing ordinary');
}

// ---------------------------------------------------------------------------
// the seed
// ---------------------------------------------------------------------------

(async () => {
    const home = path.join(root, 'seeded', 'demo');
    const stateDir = path.join(root, 'seeded', 'data');
    const cacheDir = path.join(root, 'seeded', 'cache', 'tgxcode');
    fs.mkdirSync(home, { recursive: true });

    // A 1×1 PNG stands in for the browser's picture of the demo app.
    const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const served = [];
    const world = await seed({
        home, stateDir, cacheDir, now: Date.now(),
        render: async () => tiny,
        serve: async (cwd, sessionId) => { served.push({ cwd, sessionId }); return { port: 5173, stop() {} }; },
    });

    // 1. Nothing real, by the guard — which seed() already ran, and this runs again
    //    over the same roots so a future change to what seed() hands it is caught.
    guard([path.join(home, '.claude', 'projects'), path.join(stateDir, 'tgxcode'), cacheDir, path.join(home, 'Projects')]);
    ok('the seeded world passes the guard');

    // 2. Every transcript parses, and is a conversation the app can open.
    const projects = path.join(home, '.claude', 'projects');
    const files = fs.readdirSync(projects).flatMap(d => fs.readdirSync(path.join(projects, d))
        .filter(f => f.endsWith('.jsonl')).map(f => path.join(projects, d, f)));
    assert.strictEqual(files.length, 9, 'nine conversations');
    for (const f of files) {
        const entries = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
        assert.ok(entries.some(e => e.type === 'ai-title'), `${path.basename(f)} has a title`);
        assert.ok(entries.some(e => e.type === 'user'), `${path.basename(f)} has a prompt`);
        const sid = path.basename(f, '.jsonl');
        for (const e of entries) assert.strictEqual(e.sessionId, sid);
        for (const e of entries.filter(x => x.cwd)) assert.ok(fs.existsSync(e.cwd), `${e.cwd} exists`);
    }
    ok('nine conversations, each parsing, titled, and in a directory that exists');

    // 3. The orchestrator names workers that have transcripts and worktrees.
    const orch = JSON.parse(fs.readFileSync(path.join(stateDir, 'tgxcode', 'orchestrators.json'), 'utf8'));
    const [o] = Object.values(orch.orchestrators);
    assert.strictEqual(o.workers.length, 4);
    const ids = new Set(files.map(f => path.basename(f, '.jsonl')));
    assert.ok(ids.has(Object.keys(orch.orchestrators)[0]), 'the orchestrator has a conversation');
    for (const w of o.workers) {
        assert.ok(ids.has(w.id), `worker ${w.title} has a conversation`);
        assert.ok(fs.existsSync(w.cwd), `worker ${w.title} has a worktree`);
    }
    for (const i of o.inbox) assert.ok(o.workers.some(w => w.id === i.workerId), 'inbox items are from workers');
    ok('the orchestrator\'s workers and inbox match conversations and worktrees on disk');

    // 4. The stub is told about exactly the sessions that are meant to be live.
    assert.deepStrictEqual(Object.keys(world.stubPlan).sort(),
        [world.id.flaky, world.id.offline, world.id.shortcuts].sort());
    assert.deepStrictEqual(Object.values(world.stubPlan).map(p => p.kind).sort(), ['permission', 'plan', 'working']);
    ok('only the three sessions meant to be mid-turn are scripted into the stub');

    // 5. The demo app runs from the conversation that shows it, as that session's server.
    assert.deepStrictEqual(served, [{ cwd: world.wt.dueDates.dir, sessionId: world.id.dueDates }]);
    ok('the demo app is run from the due-dates worktree as that session\'s own server');

    // 6. The files a worktree holds are what the transcript says was done to them.
    const tasks = fs.readFileSync(path.join(world.wt.dueDates.dir, 'src', 'tasks.js'), 'utf8');
    assert.ok(tasks.includes('isOverdue') && tasks.includes('sortByDue'));
    assert.ok(fs.existsSync(path.join(world.wt.dueDates.dir, 'test', 'due.test.js')));
    ok('the edits a transcript records are in the worktree');

    // 7. Ids are stable between runs, so a rerun reads the same.
    assert.strictEqual(uid('x'), uid('x'));
    assert.notStrictEqual(uid('x'), uid('y'));
    assert.match(uid('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    ok('session ids are deterministic uuids');

    console.log(`\n${pass} passed`);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
