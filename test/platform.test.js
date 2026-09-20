'use strict';

// Which host the bridge thinks it is on, and what that changes.
//
// No bridge needed. The interesting assertion here is a negative one and it is
// the whole reason bridge/platform.js exists: **on a Linux host nothing spawns a
// Windows binary.** That is not something a return value can show — every arm of
// bridge/explorer.js returns the same {ok, path} shape — so this drives the real
// functions against a PATH containing nothing but fakes, each of which records
// that it ran. What the test reads afterwards is which programs were called.
//
// Written that way because the failure it guards is silent in exactly this
// shape: a `wslpath` left in a code path that a Linux machine reaches returns
// null, the caller reports "could not translate the path for Windows", and the
// route answers 502 about a Windows that is not there. Asserting on the error
// string would pass for the wrong reason the day somebody reworded it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const platform = require('../bridge/platform.js');
const explorer = require('../bridge/explorer.js');
const devbrowser = require('../bridge/devbrowser.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// ---------------------------------------------------------------------------
// A PATH made entirely of fakes
// ---------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-platform-'));
const binDir = path.join(tmp, 'bin');
const marker = path.join(tmp, 'called.log');
fs.mkdirSync(binDir);

/**
 * `wslpath` has to answer plausibly rather than just record itself: explorer.js
 * treats an empty translation as a failure and would never reach explorer.exe,
 * which would make the Windows half of this test pass without proving anything.
 */
function fake(name, body) {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, `#!/bin/sh\necho "${name}" >> "${marker}"\n${body || ''}\nexit 0\n`);
    fs.chmodSync(p, 0o755);
}

fake('explorer.exe');
fake('cmd.exe');
fake('xdg-open');
fake('dbus-send');
fake('wslpath', 'echo "\\\\\\\\wsl.localhost\\\\Ubuntu\\\\tmp\\\\x"');

const called = () => {
    try { return fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean); }
    catch { return []; }
};
const reset = () => { try { fs.unlinkSync(marker); } catch { /* never written */ } };

const realPath = process.env.PATH;
const realKind = process.env.CLAUDE_SESSIONS_HOST_KIND;
const restore = () => {
    process.env.PATH = realPath;
    if (realKind === undefined) delete process.env.CLAUDE_SESSIONS_HOST_KIND;
    else process.env.CLAUDE_SESSIONS_HOST_KIND = realKind;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
};

// A real file and a real directory to act on, so nothing fails on the stat that
// happens before any of this matters.
const aFile = path.join(tmp, 'note.md');
const aDir = path.join(tmp, 'folder');
fs.writeFileSync(aFile, 'hello');
fs.mkdirSync(aDir);

(async () => {
    // --- the switch itself ------------------------------------------------

    process.env.CLAUDE_SESSIONS_HOST_KIND = 'linux';
    assert.strictEqual(platform.hostKind(), 'linux');
    assert.strictEqual(platform.isWsl(), false);

    process.env.CLAUDE_SESSIONS_HOST_KIND = 'wsl';
    assert.strictEqual(platform.hostKind(), 'wsl');
    assert.strictEqual(platform.isWsl(), true);

    // Case-insensitively, because an env var typed by a person is not a
    // constant in a file.
    process.env.CLAUDE_SESSIONS_HOST_KIND = 'LINUX';
    assert.strictEqual(platform.hostKind(), 'linux');
    ok('CLAUDE_SESSIONS_HOST_KIND forces the answer, either way');

    // A typo must not stop the bridge starting, and must not answer "linux" on a
    // machine that has an Explorer — the detected answer is the safe fallback.
    process.env.CLAUDE_SESSIONS_HOST_KIND = 'windows-ish';
    delete process.env.CLAUDE_SESSIONS_HOST_KIND;
    const detected = platform.hostKind();
    process.env.CLAUDE_SESSIONS_HOST_KIND = 'nonsense';
    assert.strictEqual(platform.hostKind(), detected);
    ok('an unrecognised value falls back to detection rather than throwing');

    // The env var is read per call, not captured at require time. Without this
    // the suite could not drive both branches, which is the reason it exists.
    process.env.CLAUDE_SESSIONS_HOST_KIND = 'wsl';
    const a = platform.isWsl();
    process.env.CLAUDE_SESSIONS_HOST_KIND = 'linux';
    const b = platform.isWsl();
    assert.strictEqual(a, true);
    assert.strictEqual(b, false);
    ok('the override is read per call, so one process can test both hosts');

    // --- what each host actually spawns -----------------------------------

    process.env.PATH = binDir;

    process.env.CLAUDE_SESSIONS_HOST_KIND = 'linux';

    reset();
    let out = await explorer.openFile(aFile);
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.path, aFile, 'the Linux path is what was handed over');
    assert.deepStrictEqual(called(), ['xdg-open']);
    ok('openFile on a Linux host calls xdg-open and nothing else');

    reset();
    out = await explorer.openInExplorer(aDir);
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.deepStrictEqual(called(), ['xdg-open'], 'a directory has nothing to select');
    ok('revealing a directory on a Linux host calls xdg-open');

    reset();
    out = await explorer.openInExplorer(aFile);
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.deepStrictEqual(called(), ['dbus-send'],
        'a file is shown selected, so xdg-open is not needed');
    ok('revealing a file on a Linux host asks FileManager1 to select it');

    reset();
    assert.strictEqual(await explorer.toWindowsPath(aDir), null);
    assert.deepStrictEqual(called(), [], 'wslpath is not a thing on a Linux host');
    ok('toWindowsPath is null on a Linux host, without spawning anything');

    process.env.CLAUDE_SESSIONS_HOST_KIND = 'wsl';

    reset();
    out = await explorer.openFile(aFile);
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.deepStrictEqual(called(), ['wslpath', 'explorer.exe']);
    ok('openFile under WSL still translates the path and calls explorer.exe');

    reset();
    out = await explorer.openInExplorer(aDir);
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.deepStrictEqual(called(), ['wslpath', 'explorer.exe']);
    ok('revealing under WSL still goes through Explorer');

    // --- DevBrowser discovery ---------------------------------------------

    process.env.CLAUDE_SESSIONS_HOST_KIND = 'linux';
    process.env.XDG_CONFIG_HOME = tmp;

    reset();
    const bin = await devbrowser.installedPath();
    assert.strictEqual(bin, null, 'nothing named DevBrowser is on this fake PATH');
    assert.deepStrictEqual(called(), [], 'finding it is a filesystem question, not a spawn');
    ok('DevBrowser discovery on a Linux host spawns nothing');

    reset();
    const launched = await devbrowser.launch({ waitMs: 1 });
    assert.strictEqual(launched.ok, false);
    assert.match(launched.error, /no DevBrowser binary/);
    assert.ok(!called().includes('cmd.exe'), 'cmd.exe must not be reached on Linux');
    ok('launching on a Linux host reports "not installed" without touching cmd.exe');

    // The control port comes out of the app's own file, at the Linux location.
    // Nothing above this has asked for the port, so the module's few-second
    // cache is still empty and this is a genuine read rather than a hit.
    const cfgDir = path.join(tmp, 'dev-browser-desktop');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'control-server.json'), JSON.stringify({ port: 45999 }));
    assert.strictEqual(await devbrowser.controlPort(), 45999);
    ok('the control port is read from $XDG_CONFIG_HOME on a Linux host');

    restore();
    console.log(`\n${pass} platform checks passed`);
})().catch((err) => {
    restore();
    console.error(err);
    process.exit(1);
});
