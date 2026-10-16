'use strict';

// scripts/setup.sh's one edit to a file the user already owns: %USERPROFILE%\.wslconfig.
//
// No bridge needed. Everything else the script does is install something or
// skip it, and a rerun is the test of that. The .wslconfig merge is different:
// it rewrites a file that may hold memory limits, a kernel path or a swap size
// the user set by hand, on a machine that is not this one, so a merge that
// drops a section does not fail — it quietly changes how their WSL boots.
//
// So this drives `setup.sh --merge-wslconfig FILE`, the real function, against
// the shapes that file comes in, and asserts on the bytes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'setup.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgxcode-setup-'));

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

let n = 0;
/** Merge `before` (or a missing file, for null); return {verdict, after, backup}. */
function merge(before) {
    const file = path.join(tmp, `wslconfig-${n++}`);
    if (before !== null) fs.writeFileSync(file, before);
    const r = spawnSync('bash', [SCRIPT, '--merge-wslconfig', file], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return {
        verdict: r.stdout.trim(),
        after: fs.readFileSync(file, 'utf8'),
        backup: fs.existsSync(`${file}.bak`) ? fs.readFileSync(`${file}.bak`, 'utf8') : null,
    };
}

{
    const r = merge(null);
    assert.strictEqual(r.verdict, 'created');
    assert.match(r.after, /^\[wsl2\]\r\nnetworkingMode=mirrored\r\n/);
    assert.strictEqual(r.backup, null);
    ok('a missing file is created, CRLF, mirrored');
}

{
    const before = '[wsl2]\nmemory=8GB\nswap=0\n';
    const r = merge(before);
    assert.strictEqual(r.verdict, 'changed');
    assert.strictEqual(r.after, '[wsl2]\nmemory=8GB\nswap=0\nnetworkingMode=mirrored\n');
    assert.strictEqual(r.backup, before);
    ok('[wsl2] without the key gains it, and keeps everything else');
}

{
    const r = merge('[wsl2]\nnetworkingMode=NAT\nmemory=8GB\n');
    assert.strictEqual(r.verdict, 'changed');
    assert.strictEqual(r.after, '[wsl2]\nnetworkingMode=mirrored\nmemory=8GB\n');
    ok('another networking mode is replaced in place');
}

{
    const before = '[experimental]\nautoMemoryReclaim=gradual\n';
    const r = merge(before);
    assert.strictEqual(r.verdict, 'changed');
    assert.strictEqual(r.after, `${before}\n[wsl2]\nnetworkingMode=mirrored\n`);
    ok('no [wsl2] section: one is appended, the other section untouched');
}

{
    const r = merge('[wsl2]\nmemory=8GB\n[experimental]\nnetworkingMode=nat\n');
    assert.strictEqual(r.after,
        '[wsl2]\nmemory=8GB\nnetworkingMode=mirrored\n[experimental]\nnetworkingMode=nat\n');
    ok('the key is only ever read and written inside [wsl2]');
}

for (const already of ['[wsl2]\nnetworkingMode=mirrored\n',
    '[WSL2]\n  NetworkingMode = Mirrored  # set by hand\n']) {
    const r = merge(already);
    assert.strictEqual(r.verdict, 'unchanged');
    assert.strictEqual(r.after, already);
    assert.strictEqual(r.backup, null);
}
ok('already mirrored, however it is spelled: left byte-for-byte, no backup');

{
    const r = merge('[wsl2]\r\nmemory=8GB\r\n');
    assert.strictEqual(r.after, '[wsl2]\r\nmemory=8GB\r\nnetworkingMode=mirrored\r\n');
    ok('CRLF in, CRLF out');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nsetup: ${pass} passed`);
