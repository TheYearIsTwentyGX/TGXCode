'use strict';

// bridge/shell-build.js: the hash that says a shell is out of date, and the
// version a build carries. Git runs in a throwaway repository.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sb = require('../bridge/shell-build');
const { compareVersions } = require('../app/update-feed');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-shellbuild-'));
const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
};
const pkg = (over = {}) => JSON.stringify({ version: '1.0.0', main: 'app/main.js', build: { appId: 'x' }, devDependencies: { electron: '1' }, ...over });
const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

write('package.json', pkg());
write('app/main.js', 'one\n');
write('app/sub/x.js', 'two\n');
write('web/app.js', 'ui\n');

// ── the hash ──
const h0 = sb.shellHash(root);
assert.strictEqual(sb.shellHash(root), h0);
assert.match(h0, /^[0-9a-f]{64}$/);
ok('the hash is stable');

write('app/config.json', '{"bridgeDir":"~/x"}');
write('app/build-info.json', '{"version":"1"}');
write('web/app.js', 'ui changed\n');
write('package.json', pkg({ version: '9.9.9', description: 'other' }));
assert.strictEqual(sb.shellHash(root), h0);
ok('what the build bakes in, the UI and the version do not move it');

write('app/main.js', 'one\r\n');
assert.strictEqual(sb.shellHash(root), h0);
write('app/main.js', 'one\n');
ok('nor do line endings');

write('app/main.js', 'changed\n');
assert.notStrictEqual(sb.shellHash(root), h0);
write('app/main.js', 'one\n');
write('app/sub/x.js', 'changed\n');
assert.notStrictEqual(sb.shellHash(root), h0);
write('app/sub/x.js', 'two\n');
write('app/sub/config.json', 'nested is not the baked one');
assert.notStrictEqual(sb.shellHash(root), h0);
fs.unlinkSync(path.join(root, 'app/sub/config.json'));
for (const over of [{ main: 'other.js' }, { build: { appId: 'y' } }, { devDependencies: { electron: '2' } }]) {
    write('package.json', pkg(over));
    assert.notStrictEqual(sb.shellHash(root), h0, JSON.stringify(over));
}
write('package.json', pkg());
assert.strictEqual(sb.shellHash(root), h0);
ok('a file under app/ and the fields that shape the build do');

// ── the version ──
const now = Date.UTC(2026, 10, 1, 12, 5);
assert.strictEqual(sb.versionFor({ base: '1.0.0', count: 300, dirty: false, branch: 'main', now }), '1.0.300');
assert.strictEqual(sb.versionFor({ base: '2.3.9', count: 300, dirty: false, branch: 'main', now }), '2.3.300');
const dirty = sb.versionFor({ base: '1.0.0', count: 300, dirty: true, branch: 'main', now });
assert.strictEqual(dirty, '1.0.301-dev.202611011205');
assert.strictEqual(sb.versionFor({ base: '1.0.0', count: 300, dirty: false, branch: 'worktree-x', now }), dirty);
assert.strictEqual(compareVersions(dirty, '1.0.300'), 1);
assert.strictEqual(compareVersions(dirty, '1.0.301'), -1);
assert.strictEqual(compareVersions('1.0.300', '1.0.0'), 1);
ok('main is the commit count; anything else sorts between it and the next');

git('init', '-q', '-b', 'main');
fs.rmSync(path.join(root, 'app/config.json'));
fs.rmSync(path.join(root, 'app/build-info.json'));
git('add', '-A');
git('commit', '-qm', 'one');
git('commit', '-qm', 'two', '--allow-empty');
let info = sb.buildInfo(root, { now });
assert.strictEqual(info.version, '1.0.2');
assert.strictEqual(info.dirty, false);
assert.strictEqual(info.branch, 'main');
assert.match(info.commit, /^[0-9a-f]+$/);
assert.strictEqual(info.shellHash, sb.shellHash(root));
ok('a clean main checkout builds 1.0.<count>');

write('web/app.js', 'an edit elsewhere\n');
assert.strictEqual(sb.buildInfo(root, { now }).dirty, false);
ok('an edit outside the shell does not make it dirty');

write('app/main.js', 'edit\n');
info = sb.buildInfo(root, { now });
assert.strictEqual(info.dirty, true);
assert.strictEqual(info.version, '1.0.3-dev.202611011205');
git('checkout', '-q', '--', 'app/main.js');
git('checkout', '-qb', 'worktree-x');
assert.strictEqual(sb.buildInfo(root, { now }).version, '1.0.3-dev.202611011205');
ok('an edit under app/, or another branch, is a dev build');

const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-nogit-'));
fs.mkdirSync(path.join(notGit, 'app'));
assert.match(sb.buildInfo(notGit, { now }).version, /^1\.0\.1-dev\./);
fs.rmSync(notGit, { recursive: true, force: true });
ok('outside git it is still a version, and a dev one');

// ── a build from the page ──
const { EventEmitter } = require('events');
(async () => {
    const log = path.join(root, 'logs', 'release.log');
    let child = new EventEmitter();
    let started = 0;
    const spawnImpl = () => { started++; child.pid = 42; return child; };
    const a = sb.startRelease({ root, logFile: log, spawnImpl });
    assert.strictEqual(a.release.running, true);
    assert.ok(fs.existsSync(log));
    assert.match(sb.startRelease({ root, logFile: log, spawnImpl }).error, /already running/);
    assert.strictEqual(started, 1);
    ok('one build at a time');

    fs.writeFileSync(log, 'line one\nline two\n');
    child.emit('close', 0);
    const st = sb.releaseState();
    assert.strictEqual(st.running, false);
    assert.strictEqual(st.exitCode, 0);
    assert.strictEqual(st.tail, 'line one\nline two');
    ok('its end and its output are readable afterwards');

    child = new EventEmitter();
    sb.startRelease({ root, logFile: log, spawnImpl });
    child.emit('error', new Error('no node'));
    assert.strictEqual(sb.releaseState().exitCode, 1);
    assert.match(sb.releaseState().tail, /no node/);
    ok('one that would not start is a failure with a reason');

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n  ${pass} passed\n`);
})().catch((err) => { console.error(err); process.exit(1); });
