'use strict';

// app/update-feed.js: the formats and the rules an update is decided by. No
// Electron, no network. The refusals are the point — a path out of the folder, a
// feed with no sha512, a version that is not one.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const feed = require('../app/update-feed');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const SHA = crypto.createHash('sha512').update('x').digest('base64');
// The shape electron-builder 24 writes for an NSIS target.
const YML = `version: 1.0.300
files:
  - url: TGXCode-Setup-1.0.300.exe
    sha512: ${SHA}
    size: 81234567
path: TGXCode-Setup-1.0.300.exe
sha512: ${SHA}
releaseDate: '2026-11-01T12:00:00.000Z'
`;

(async () => {
    // ── versions ──
    assert.strictEqual(feed.compareVersions('1.0.9', '1.0.10'), -1);
    assert.strictEqual(feed.compareVersions('1.1.0', '1.0.99'), 1);
    assert.strictEqual(feed.compareVersions('v1.0.0', '1.0.0'), 0);
    ok('versions compare as numbers, not strings');

    assert.strictEqual(feed.compareVersions('1.0.301-dev.202611011200', '1.0.301'), -1);
    assert.strictEqual(feed.compareVersions('1.0.301-dev.202611011200', '1.0.300'), 1);
    assert.strictEqual(feed.compareVersions('1.0.301-dev.202611011200', '1.0.301-dev.202611011201'), -1);
    assert.strictEqual(feed.compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
    assert.strictEqual(feed.compareVersions('1.0.0-1', '1.0.0-a'), -1);
    ok('a dev build sorts above the commit it sits on and below the next real one');

    assert.throws(() => feed.compareVersions('banana', '1.0.0'));
    assert.strictEqual(feed.relation('1.0.5', '1.0.6'), 'newer');
    assert.strictEqual(feed.relation('1.0.5', '1.0.5'), 'same');
    assert.strictEqual(feed.relation('1.0.5', '1.0.4'), 'older');
    ok('garbage throws rather than comparing, and relation names all three');

    // ── latest.yml ──
    const pick = feed.pickInstaller(feed.parseLatestYml(YML));
    assert.deepStrictEqual(pick, { version: '1.0.300', file: 'TGXCode-Setup-1.0.300.exe', sha512: SHA,
        size: 81234567, releaseDate: '2026-11-01T12:00:00.000Z' });
    assert.strictEqual(feed.pickInstaller(feed.parseLatestYml(`\uFEFF${YML.replace(/\n/g, '\r\n')}`)).file, pick.file);
    ok('electron-builder’s latest.yml parses, CRLF and BOM included');

    const legacy = feed.pickInstaller(feed.parseLatestYml(`version: 1.0.1\npath: a.exe\nsha512: ${SHA}\n`));
    assert.strictEqual(legacy.file, 'a.exe');
    ok('the top-level path/sha512 pair is the fallback');

    const refuse = (text, re) => {
        const r = feed.pickInstaller(feed.parseLatestYml(text));
        assert.ok(r.error && re.test(r.error), `${text} → ${JSON.stringify(r)}`);
    };
    for (const name of ['../evil.exe', '..\\evil.exe', 'C:\\Windows\\evil.exe', '/tmp/evil.exe', 'sub/evil.exe', 'http://x/evil.exe']) {
        refuse(YML.replace(/TGXCode-Setup-1\.0\.300\.exe/g, name), /plain \.exe/);
    }
    refuse(YML.replace(/TGXCode-Setup-1\.0\.300\.exe/g, 'notes.txt'), /plain \.exe/);
    ok('an installer name that leaves the folder, or is not an .exe, is refused');

    refuse(YML.replaceAll(SHA, ''), /sha512/);
    refuse(YML.replaceAll(SHA, 'abcd'), /sha512/);
    refuse(YML.replace('version: 1.0.300', 'version: soon'), /not a version/);
    refuse('', /not a version/);
    refuse('version: 1.0.1\n', /no installer/);
    ok('no sha512, a short one, a bad version or an empty feed is refused with a sentence');

    // ── settings ──
    assert.deepStrictEqual(feed.normalizeSettings(undefined), { ...feed.DEFAULT_SETTINGS, github: { ...feed.DEFAULT_GITHUB } });
    const odd = feed.normalizeSettings({ source: 'ftp', intervalHours: 9000, checkOnStartup: 'yes', github: { owner: 'a b' } });
    assert.strictEqual(odd.source, 'folder');
    assert.strictEqual(odd.intervalHours, 168);
    assert.strictEqual(odd.checkOnStartup, true);
    assert.strictEqual(odd.github.owner, feed.DEFAULT_GITHUB.owner);
    ok('a hand-edited file degrades to defaults and clamps');

    const set = (patch, platform = 'win32') => feed.applySettingsPatch({}, patch, platform);
    assert.strictEqual(set({ folder: 'D:\\TGX' }).settings.folder, 'D:\\TGX');
    assert.strictEqual(set({ folder: '\\\\wsl.localhost\\Ubuntu\\home\\x' }).settings.folder, '\\\\wsl.localhost\\Ubuntu\\home\\x');
    assert.strictEqual(set({ folder: '' }).settings.folder, '');
    assert.ok(set({ folder: 'updates' }).error);
    assert.ok(set({ folder: '/home/x' }).error);
    assert.strictEqual(set({ folder: '/home/x' }, 'linux').settings.folder, '/home/x');
    ok('a folder must be a full path for the platform; empty means the default');

    assert.ok(set({ source: 'ftp' }).error);
    assert.ok(set({ github: { owner: 'a/b', repo: 'c' } }).error);
    assert.ok(set({ github: { owner: 'a', repo: 'c d' } }).error);
    assert.ok(set({ intervalHours: -1 }).error);
    assert.ok(set({ intervalHours: 169 }).error);
    assert.ok(set({ intervalHours: 1.5 }).error);
    assert.ok(set({ autoDownload: 'yes' }).error);
    assert.ok(set(null).error);
    assert.strictEqual(set({ intervalHours: 0 }).settings.intervalHours, 0);
    ok('a bad change from the page is an error, not a quiet replacement');

    // ── where the feed is ──
    const folderLoc = feed.feedLocation({ source: 'folder' }, { platform: 'win32', defaultFolder: 'C:\\Users\\d\\TGX' });
    assert.strictEqual(folderLoc.manifest, 'C:\\Users\\d\\TGX\\latest.yml');
    assert.strictEqual(folderLoc.filePath('a.exe'), 'C:\\Users\\d\\TGX\\a.exe');
    const gh = feed.feedLocation({ source: 'github', github: { owner: 'o', repo: 'r' } }, { platform: 'win32' });
    assert.strictEqual(gh.manifest, 'https://github.com/o/r/releases/latest/download/latest.yml');
    assert.strictEqual(gh.fileUrl('a b.exe'), 'https://github.com/o/r/releases/latest/download/a%20b.exe');
    assert.strictEqual(feed.feedLocation({ source: 'off' }, { platform: 'win32' }), null);
    ok('a source resolves to a Windows path or a release URL, and off to nothing');

    // ── timing and arguments ──
    const H = 3600 * 1000;
    assert.strictEqual(feed.nextCheckDelay({ intervalHours: 0 }, 0, 0), null);
    assert.strictEqual(feed.nextCheckDelay({ source: 'off' }, 0, 0), null);
    assert.strictEqual(feed.nextCheckDelay({ intervalHours: 6 }, null, 0), 6 * H);
    assert.strictEqual(feed.nextCheckDelay({ intervalHours: 6 }, 1000, 1000 + 2 * H), 4 * H);
    assert.strictEqual(feed.nextCheckDelay({ intervalHours: 6 }, 1000, 1000 + 99 * H), 60 * 1000);
    ok('the next check counts from the last one, and never spins');

    assert.deepStrictEqual(feed.installerArgs({ restart: false }), ['--updated', '/S']);
    assert.deepStrictEqual(feed.installerArgs({ restart: true }), ['--updated', '/S', '--force-run']);
    ok('only a restart asks the installer to start the app again');

    // ── the hash ──
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-feed-'));
    const f = path.join(dir, 'a.bin');
    fs.writeFileSync(f, 'x');
    assert.strictEqual(await feed.verifySha512(f, SHA), true);
    fs.writeFileSync(f, 'y');
    assert.strictEqual(await feed.verifySha512(f, SHA), false);
    assert.strictEqual(await feed.verifySha512(path.join(dir, 'gone'), SHA), false);
    fs.rmSync(dir, { recursive: true, force: true });
    ok('sha512 is the base64 latest.yml carries; a changed or missing file fails it');

    console.log(`\n  ${pass} passed\n`);
})().catch((err) => { console.error(err); process.exit(1); });
