'use strict';

// The chord grammar Wispr Flow shortcuts are written in, the list that holds
// them, and what pressing one spawns on each host.
//
// No bridge needed. The press is driven against a PATH containing a fake
// `powershell.exe`, the way test/platform.test.js drives Explorer, because what
// matters on a Linux host is a negative that no return value shows: **nothing
// Windows is spawned.** And on the Windows host, a SendInput that injected fewer
// events than it was given has to come back as a failure rather than as a press
// that "worked" while nothing happened.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wispr = require('../bridge/wispr.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// --- the grammar ---------------------------------------------------------

assert.strictEqual(wispr.normalize('Win+Alt+2'), 'Win+Alt+2');
assert.strictEqual(wispr.normalize('win+alt+2'), 'Win+Alt+2');
assert.strictEqual(wispr.normalize(' alt + WIN + 2 '), 'Win+Alt+2', 'modifiers are reordered');
assert.strictEqual(wispr.normalize('super+ctrl+shift+k'), 'Win+Ctrl+Shift+K');
assert.strictEqual(wispr.normalize('F9'), 'F9', 'a bare function key is a shortcut');
ok('chords are read forgivingly and written back one way');

// Win is its own modifier here, which is the one place this grammar departs
// from bridge/keymap.js: Win+Alt+2 and Ctrl+Alt+2 are different chords.
assert.notStrictEqual(wispr.normalize('Meta+Alt+2'), wispr.normalize('Ctrl+Alt+2'));
ok('Win is not folded into Ctrl');

for (const bad of ['2', 'k', 'Win+Win+2', 'Win+Alt+', 'Win+Alt+Nope', 'Hyper+2', '', null, 42]) {
    assert.strictEqual(wispr.normalize(bad), null, `${JSON.stringify(bad)} was accepted`);
}
ok('a bare letter, a doubled modifier and an unknown key are refused');

assert.deepStrictEqual(wispr.toVk(wispr.parseCombo('Win+Alt+2')), [0x5B, 0x12, 0x32]);
assert.deepStrictEqual(wispr.toVk(wispr.parseCombo('Ctrl+Shift+K')), [0x11, 0x10, 0x4B]);
assert.deepStrictEqual(wispr.toVk(wispr.parseCombo('F12')), [0x7B]);
assert.deepStrictEqual(wispr.toVk(wispr.parseCombo('Alt+Slash')), [0x12, 0xBF]);
assert.deepStrictEqual(wispr.toVk(wispr.parseCombo('Win+Up')), [0x5B, 0x26]);
ok('every chord becomes the virtual keys Windows expects, modifiers first');

// Every key name the grammar accepts has a virtual key. A name without one
// would save perfectly well and then fail at the moment somebody used it.
const { KEY_NAMES } = require('../bridge/keymap.js');
for (const name of KEY_NAMES) {
    const vks = wispr.toVk(wispr.parseCombo(`Alt+${name}`));
    assert.ok(vks && vks.every(n => Number.isInteger(n) && n > 0), `no virtual key for ${name}`);
}
ok('no key name is accepted that cannot be pressed');

// --- the list ------------------------------------------------------------

const notes = [];
const note = (m) => notes.push(m);
const cleaned = wispr.cleanTransforms([
    { id: 'prompt-engineer', title: ' Prompt engineer ', combo: 'win+alt+2' },
    { id: 'prompt-engineer', title: 'Again', combo: 'Win+Alt+3' },
    { id: 'Bad Id', title: 'x', combo: 'Win+Alt+4' },
    { id: 'no-title', title: '   ', combo: 'Win+Alt+5' },
    { id: 'no-combo', title: 'Nothing', combo: 'k' },
    'not an object',
    { id: 'shorter', title: 'Shorter', combo: 'Ctrl+Alt+S' },
], note);
assert.deepStrictEqual(cleaned, [
    { id: 'prompt-engineer', title: 'Prompt engineer', combo: 'Win+Alt+2' },
    { id: 'shorter', title: 'Shorter', combo: 'Ctrl+Alt+S' },
]);
assert.strictEqual(notes.length, 5, 'each dropped entry says why');
assert.ok(wispr.validTransforms(cleaned));
ok('one bad entry is dropped on its own, and what survives is spelled canonically');

assert.strictEqual(wispr.cleanTransforms({ not: 'a list' }, note), undefined);
const many = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, combo: `Alt+F${(i % 12) + 1}` }));
assert.strictEqual(wispr.cleanTransforms(many, note).length, wispr.MAX_TRANSFORMS);
assert.ok(!wispr.validTransforms(many), 'the last gate lets an over-long list through');
ok('the list is bounded');

// --- pressing ------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-wispr-'));
const binDir = path.join(tmp, 'bin');
const marker = path.join(tmp, 'called.log');
fs.mkdirSync(binDir);
// Answers with however many events FAKE_SENT says SendInput injected.
fs.writeFileSync(path.join(binDir, 'powershell.exe'),
    `#!/bin/sh\necho powershell.exe >> "${marker}"\necho "$FAKE_SENT"\nexit 0\n`);
fs.chmodSync(path.join(binDir, 'powershell.exe'), 0o755);

const called = () => {
    try { return fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean); }
    catch { return []; }
};
const reset = () => { try { fs.unlinkSync(marker); } catch { /* never written */ } };

const saved = {
    PATH: process.env.PATH,
    CLAUDE_SESSIONS_HOST_KIND: process.env.CLAUDE_SESSIONS_HOST_KIND,
    FAKE_SENT: process.env.FAKE_SENT,
};
const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
};

(async () => {
    process.env.PATH = binDir;

    process.env.CLAUDE_SESSIONS_HOST_KIND = 'linux';
    reset();
    assert.strictEqual(wispr.available(), false);
    let out = await wispr.press('Win+Alt+2');
    assert.strictEqual(out.ok, false);
    assert.deepStrictEqual(called(), [], 'a Linux host spawned powershell.exe');
    ok('on a Linux host nothing is available and nothing is spawned');

    process.env.CLAUDE_SESSIONS_HOST_KIND = 'wsl';
    assert.strictEqual(wispr.available(), true);

    reset();
    process.env.FAKE_SENT = '6';
    out = await wispr.press('Win+Alt+2');
    assert.deepStrictEqual(out, { ok: true });
    assert.deepStrictEqual(called(), ['powershell.exe']);
    ok('on the Windows host a chord is one PowerShell run');

    reset();
    process.env.FAKE_SENT = '0';
    out = await wispr.press('Win+Alt+2');
    assert.strictEqual(out.ok, false, 'a press Windows blocked was reported as working');
    assert.match(out.error, /refused/);
    ok('keystrokes Windows would not inject are a failure, not a success');

    reset();
    out = await wispr.press('k');
    assert.strictEqual(out.ok, false);
    assert.deepStrictEqual(called(), [], 'an unusable chord still reached PowerShell');
    ok('a chord that does not parse never reaches PowerShell');

    restore();
    console.log(`\n${pass} wispr checks passed`);
})().catch((err) => {
    restore();
    console.error(err);
    process.exit(1);
});
