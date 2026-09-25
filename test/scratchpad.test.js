'use strict';

// bridge/scratchpad.js: finding a session's scratchpads and reading one file out
// of them. Needs no bridge — every case runs against a fake `claude-<uid>` tree
// in a temp directory.
//
// The cases that earn their place:
//
//   * a session that entered worktrees has a scratchpad under each slug, and
//     finding only the transcript's one hides most of the work.
//   * the sibling `tasks/` is background-agent output, not the scratchpad.
//   * the client names a file by key and relative path, so `../` and a symlink
//     out are the two ways to turn this into a reader for the rest of the disk.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sp = require('../bridge/scratchpad.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-scratch-'));
const ROOT = path.join(TMP, 'claude-1000');
const ID = '7cf38b41-c3a6-42ae-ad80-863b1a5adf6f';
const MAIN = '-home-me-proj';
const WT = '-home-me-proj--claude-worktrees-punch-columns';

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

function put(slug, rel, content) {
    const file = path.join(ROOT, slug, ID, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

try {
    put(MAIN, 'scratchpad/probe.ts', 'console.log(1)\n');
    put(MAIN, 'scratchpad/nested/q.sql', 'select 1;\n');
    put(MAIN, 'tasks/agent.output', '{"type":"x"}\n');
    put(WT, 'scratchpad/msg.txt', 'hello\n');
    // Another session's scratchpad in the same slug is not ours.
    fs.mkdirSync(path.join(ROOT, MAIN, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'scratchpad'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, MAIN, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'scratchpad', 'other.txt'), 'x');

    const dirs = sp.dirsFor(ID, ROOT);
    assert.deepStrictEqual(dirs.map(d => [d.key, d.where]), [[MAIN, null], [WT, 'punch-columns']]);
    ok('finds a scratchpad under every slug, main checkout first');

    const got = sp.list(ID, ROOT);
    const names = got.files.map(f => `${f.dir}:${f.path}`).sort();
    assert.deepStrictEqual(names, [`${MAIN}:nested/q.sql`, `${MAIN}:probe.ts`, `${WT}:msg.txt`].sort());
    assert.strictEqual(got.truncated, false);
    ok('lists nested files, and neither tasks/ nor another session\'s');

    assert.deepStrictEqual(sp.dirsFor('../../etc', ROOT), []);
    assert.deepStrictEqual(sp.list(ID, path.join(TMP, 'nowhere')), { dirs: [], files: [], truncated: false });
    ok('a malformed id or a cleared /tmp is an empty answer, not an error');

    const r = sp.read(ID, MAIN, 'nested/q.sql', ROOT);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, 'select 1;\n');
    assert.strictEqual(r.binary, false);
    assert.strictEqual(r.truncated, false);
    ok('reads a file by key and relative path');

    assert.strictEqual(sp.read(ID, MAIN, '../tasks/agent.output', ROOT).reason, 'outside');
    assert.strictEqual(sp.read(ID, MAIN, '/etc/passwd', ROOT).reason, 'outside');
    assert.strictEqual(sp.read(ID, 'not-a-slug', 'probe.ts', ROOT).reason, 'no-such-file');
    assert.strictEqual(sp.read(ID, MAIN, 'gone.txt', ROOT).reason, 'no-such-file');
    assert.strictEqual(sp.read(ID, MAIN, 'nested', ROOT).reason, 'no-such-file');
    ok('refuses ../, an absolute path, an unknown key, a missing file and a directory');

    const secret = path.join(TMP, 'secret.txt');
    fs.writeFileSync(secret, 'nope');
    fs.symlinkSync(secret, path.join(ROOT, MAIN, ID, 'scratchpad', 'link.txt'));
    fs.symlinkSync(TMP, path.join(ROOT, MAIN, ID, 'scratchpad', 'linkdir'));
    assert.strictEqual(sp.read(ID, MAIN, 'link.txt', ROOT).reason, 'outside');
    assert.strictEqual(sp.read(ID, MAIN, 'linkdir/secret.txt', ROOT).reason, 'outside');
    assert.ok(!sp.list(ID, ROOT).files.some(f => f.path.startsWith('link')), 'symlinks are not listed');
    ok('refuses a symlink out, whether it is the file or a directory above it');

    put(MAIN, 'scratchpad/shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
    const bin = sp.read(ID, MAIN, 'shot.png', ROOT);
    assert.strictEqual(bin.ok, true);
    assert.strictEqual(bin.binary, true);
    assert.strictEqual(bin.text, '');
    ok('a binary file is reported as binary, with no text');

    put(MAIN, 'scratchpad/big.log', 'a'.repeat(sp.READ_CAP + 10));
    const big = sp.read(ID, MAIN, 'big.log', ROOT);
    assert.strictEqual(big.truncated, true);
    assert.strictEqual(big.text.length, sp.READ_CAP);
    assert.strictEqual(big.size, sp.READ_CAP + 10);
    ok('a file past the cap is cut at the cap and says so');

    console.log(`\n${pass} groups passed`);
} catch (e) {
    console.error(e);
    process.exitCode = 1;
} finally {
    fs.rmSync(TMP, { recursive: true, force: true });
}
