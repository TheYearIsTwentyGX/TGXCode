'use strict';

// The Claude Code version check, on its own — no bridge, no network.
//
// What is worth pinning is the comparison and the channel, because both fail
// quietly: a string compare puts 2.1.99 after 2.1.280 and lights a badge that
// is wrong, and comparing a `stable` machine against `latest` lights one that
// never goes out. Neither throws.
//
// `update()` is driven against a stub `claude`, through TGXCODE_CLAUDE_BIN
// set before the require — bridge/config.js reads it once, at load. The stub is
// the only thing that makes this file safe to run: the real `claude update`
// replaces the binary every session on this machine starts from.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-claude-version-'));
const stub = path.join(dir, 'claude');
const versionFile = path.join(dir, 'version');
fs.writeFileSync(versionFile, '2.1.200');
fs.writeFileSync(stub, `#!/bin/sh
case "$1" in
  --version) echo "$(cat '${versionFile}') (Claude Code)" ;;
  update) sleep 0.3; echo 2.1.300 > '${versionFile}'; echo "Updated to 2.1.300" ;;
esac
`, { mode: 0o755 });
process.env.TGXCODE_CLAUDE_BIN = stub;
process.env.XDG_DATA_HOME = dir;

const { ClaudeVersion, summarize, compareVersions, tagForChannel, parseVersion }
    = require('../bridge/claude-version');

let pass = 0;
const ok = (name) => { pass++; console.log(`ok - ${name}`); };

// compareVersions -----------------------------------------------------------
assert.ok(compareVersions('2.1.99', '2.1.280') < 0);
assert.ok(compareVersions('2.1.280', '2.1.99') > 0);
assert.strictEqual(compareVersions('2.1.280', '2.1.280'), 0);
assert.strictEqual(compareVersions('2.1', '2.1.0'), 0);
assert.ok(compareVersions('2.1', '2.1.1') < 0);
assert.ok(compareVersions('3.0.0', '2.99.99') > 0);
ok('versions compare numerically, per segment, missing segments as zero');

assert.strictEqual(parseVersion('2.1.280 (Claude Code)'), '2.1.280');
assert.strictEqual(parseVersion(''), null);
assert.strictEqual(parseVersion('command not found'), null);
ok('the version is read off the front of `claude --version`');

// tagForChannel -------------------------------------------------------------
assert.strictEqual(tagForChannel('stable'), 'stable');
assert.strictEqual(tagForChannel('latest'), 'latest');
assert.strictEqual(tagForChannel('rc'), 'next');
assert.strictEqual(tagForChannel(null), 'latest');
assert.strictEqual(tagForChannel(undefined), 'latest');
ok('each channel compares against its own dist-tag; unset is latest');

// summarize -----------------------------------------------------------------
const tags = { stable: '2.1.267', latest: '2.1.280', next: '2.1.281' };

let s = summarize({ installed: '2.1.278', tags, channel: 'latest' });
assert.strictEqual(s.latest, '2.1.280');
assert.strictEqual(s.behind, true);
ok('behind when the installed binary is older than the channel’s tag');

s = summarize({ installed: '2.1.280', tags, channel: 'stable' });
assert.strictEqual(s.latest, '2.1.267');
assert.strictEqual(s.behind, false);
ok('a stable machine ahead of stable is not behind, though latest is newer');

s = summarize({ installed: '2.1.280', tags, channel: 'latest', runners: {
    a: { claudeVersion: '2.1.276' },
    b: { claudeVersion: '2.1.280' },
    c: { claudeVersion: null },
    d: {},
} });
assert.strictEqual(s.behind, false);
assert.deepStrictEqual(s.staleSessions, [{ id: 'a', version: '2.1.276' }]);
ok('only a live process older than the installed binary is stale; no process is not');

s = summarize({ installed: '2.1.280', tags: null, error: 'the registry did not answer in time' });
assert.strictEqual(s.latest, null);
assert.strictEqual(s.behind, false);
assert.strictEqual(s.error, 'the registry did not answer in time');
ok('an unreachable registry is an error, not "up to date" and not "behind"');

s = summarize({ installed: null, tags, runners: { a: { claudeVersion: '2.1.1' } } });
assert.strictEqual(s.behind, false);
assert.deepStrictEqual(s.staleSessions, []);
ok('with no installed version known, nothing is claimed about anything');

s = summarize({ installed: '2.1.200', tags: { latest: '2.1.280' }, channel: 'rc' });
assert.strictEqual(s.latest, '2.1.280');
ok('a channel whose tag the registry lacks falls back to latest');

// update() against the stub -------------------------------------------------
(async () => {
    const cv = new ClaudeVersion({ channel: () => 'latest', runners: () => ({}) });
    assert.strictEqual(await cv.installed(), '2.1.200');
    ok('installed() asks the configured binary');

    const first = cv.update();
    const second = await cv.update();
    assert.deepStrictEqual(second, { busy: true });
    const out = await first;
    assert.strictEqual(out.ok, true);
    assert.match(out.output, /Updated to 2\.1\.300/);
    assert.strictEqual(cv.updating, false);
    ok('one update at a time, and the second is told so rather than queued');

    assert.strictEqual(await cv.installed(), '2.1.300');
    ok('an update forgets the cached installed version');

    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n${pass} groups passed`);
})().catch((err) => { console.error(err); process.exit(1); });
