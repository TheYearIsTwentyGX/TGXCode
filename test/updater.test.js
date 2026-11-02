'use strict';

// app/updater.js, with everything outside it stubbed and a temp directory for a
// feed. The cases are the promises its header makes: nothing runs without a
// matching sha512, no downgrade without asking, and an installer that will not
// start leaves the app open and able to try again.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Updater } = require('../app/updater');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const sha = (b) => crypto.createHash('sha512').update(b).digest('base64');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-updater-'));
let n = 0;

/** A feed folder with `version` in it, and an updater looking at that folder. */
function rig({ installed = '1.0.5', version = '1.0.6', settings = {}, enabled = true, ...over } = {}) {
    const dir = path.join(root, `r${++n}`);
    const folder = path.join(dir, 'feed');
    const cacheDir = path.join(dir, 'cache');
    fs.mkdirSync(folder, { recursive: true });
    const publish = (v, bytes = `installer ${v}`, declared = null) => {
        const file = `TGXCode-Setup-${v}.exe`;
        fs.writeFileSync(path.join(folder, file), bytes);
        fs.writeFileSync(path.join(folder, 'latest.yml'),
            `version: ${v}\nfiles:\n  - url: ${file}\n    sha512: ${declared || sha(bytes)}\n    size: ${bytes.length}\n`);
        return file;
    };
    if (version) publish(version);
    let stored = { source: 'folder', folder, autoDownload: false, ...settings };
    const launched = [];
    let quits = 0;
    const timers = [];
    const u = new Updater({
        installedVersion: installed, platform: process.platform, enabled,
        disabledReason: enabled ? null : 'dev window', defaultFolder: folder, cacheDir,
        getSettings: () => stored, saveSettings: (s) => { stored = s; },
        fetchText: async () => { throw new Error('no network here'); },
        download: async () => { throw new Error('no network here'); },
        launchInstaller: async (file, args) => { launched.push({ file, args }); },
        quit: () => { quits++; },
        setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
        clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
        ...over,
    });
    return { u, dir, folder, cacheDir, publish, launched, timers, quitCount: () => quits, stored: () => stored };
}

(async () => {
    // ── check → download → ready ──
    {
        const r = rig();
        const st = await r.u.check();
        assert.strictEqual(st.phase, 'available');
        assert.strictEqual(st.available.version, '1.0.6');
        assert.strictEqual(st.ready, false);
        assert.strictEqual(fs.existsSync(r.cacheDir), false);
        const after = await r.u.download();
        assert.strictEqual(after.phase, 'ready');
        assert.strictEqual(after.ready, true);
        assert.strictEqual(fs.readFileSync(path.join(r.cacheDir, 'TGXCode-Setup-1.0.6.exe'), 'utf8'), 'installer 1.0.6');
        assert.strictEqual(fs.existsSync(path.join(r.cacheDir, 'TGXCode-Setup-1.0.6.exe.partial')), false);
        ok('a newer version is offered; a download copies it into the cache');
    }
    {
        const r = rig({ settings: { autoDownload: true } });
        assert.strictEqual((await r.u.check()).phase, 'ready');
        ok('with autoDownload the check goes straight through to ready');
    }
    {
        const r = rig({ version: '1.0.5' });
        assert.strictEqual((await r.u.check()).phase, 'up-to-date');
        ok('the same version is up to date');
    }

    // ── sha512 ──
    {
        const r = rig({ version: null });
        r.publish('1.0.6', 'tampered', sha('the real one'));
        const st = await r.u.check();
        assert.strictEqual(st.phase, 'available');
        const after = await r.u.download();
        assert.strictEqual(after.phase, 'error');
        assert.match(after.error, /sha512/);
        assert.strictEqual(after.ready, false);
        assert.deepStrictEqual(fs.readdirSync(r.cacheDir), []);
        assert.strictEqual((await r.u.install({ restart: true })).ok, false);
        assert.strictEqual(r.launched.length, 0);
        ok('a download that fails its sha512 is thrown away and cannot be installed');
    }
    {
        const r = rig();
        await r.u.check();
        await r.u.download();
        fs.writeFileSync(path.join(r.cacheDir, 'TGXCode-Setup-1.0.6.exe'), 'changed since');
        const res = await r.u.install({ restart: true });
        assert.strictEqual(res.ok, false);
        assert.match(res.error, /sha512/);
        assert.strictEqual(r.launched.length, 0);
        assert.strictEqual(r.quitCount(), 0);
        assert.strictEqual(fs.existsSync(path.join(r.cacheDir, 'TGXCode-Setup-1.0.6.exe')), false);
        assert.strictEqual(r.u.wantsInstallOnQuit(), false);
        ok('a file changed after the download is caught right before it would run');
    }

    // ── downgrades ──
    {
        const r = rig({ installed: '1.0.9', version: '1.0.6', settings: { autoDownload: true, installOnQuit: true } });
        const st = await r.u.check();
        assert.strictEqual(st.phase, 'older');
        assert.strictEqual(st.ready, false);
        assert.strictEqual(fs.existsSync(r.cacheDir), false);
        const refused = await r.u.download();
        assert.strictEqual(refused.phase, 'older');
        assert.match(refused.error, /older/);
        assert.strictEqual(r.u.wantsInstallOnQuit(), false);
        ok('an older feed is reported, not fetched, even with autoDownload on');

        const chosen = await r.u.download({ allowDowngrade: true });
        assert.strictEqual(chosen.phase, 'ready');
        assert.strictEqual((await r.u.install({ restart: true })).ok, true);
        assert.strictEqual(r.launched.length, 1);
        ok('choosing it in so many words installs it');
    }
    {
        const r = rig({ installed: '1.0.9', version: '1.0.6' });
        await r.u.check();
        await r.u.download({ allowDowngrade: true });
        // A new check of a different release takes the choice back.
        r.publish('1.0.7');
        const st = await r.u.check();
        assert.strictEqual(st.phase, 'older');
        assert.strictEqual(st.ready, false);
        assert.strictEqual((await r.u.install({ restart: true })).ok, false);
        assert.strictEqual(r.launched.length, 0);
        ok('a choice to go back covers that version, not whatever the feed says next');
    }
    {
        const r = rig({ version: '1.0.6-dev.202611011200', installed: '1.0.6' });
        assert.strictEqual((await r.u.check()).phase, 'older');
        ok('a dev build of the installed version counts as older');
    }

    // ── installing ──
    {
        const r = rig();
        await r.u.check();
        await r.u.download();
        const res = await r.u.install({ restart: true });
        assert.strictEqual(res.ok, true);
        assert.deepStrictEqual(r.launched[0].args, ['--updated', '/S', '--force-run']);
        assert.strictEqual(r.launched[0].file, path.join(r.cacheDir, 'TGXCode-Setup-1.0.6.exe'));
        assert.strictEqual(r.quitCount(), 1);
        assert.strictEqual(r.u.wantsInstallOnQuit(), false);
        ok('restart to update runs it silently, asks for the app back, then quits');
    }
    {
        const r = rig({ settings: { installOnQuit: true } });
        await r.u.check();
        await r.u.download();
        assert.strictEqual(r.u.wantsInstallOnQuit(), true);
        assert.strictEqual((await r.u.install({ restart: false })).ok, true);
        assert.deepStrictEqual(r.launched[0].args, ['--updated', '/S']);
        assert.strictEqual(r.quitCount(), 0);
        assert.strictEqual(r.u.wantsInstallOnQuit(), false);
        ok('install on quit does not bring the app back, and does not run twice');
    }
    {
        const r = rig({ settings: { installOnQuit: false } });
        await r.u.check();
        await r.u.download();
        assert.strictEqual(r.u.wantsInstallOnQuit(), false);
        ok('with install on quit off, quitting leaves it alone');
    }
    {
        const r = rig({ launchInstaller: async () => { throw new Error('elevation was declined or failed'); } });
        await r.u.check();
        await r.u.download();
        const res = await r.u.install({ restart: true });
        assert.strictEqual(res.ok, false);
        assert.match(res.error, /still installed and running/);
        assert.strictEqual(r.quitCount(), 0);
        const st = r.u.snapshot();
        assert.strictEqual(st.phase, 'ready');
        assert.strictEqual(st.ready, true);
        assert.strictEqual(fs.existsSync(path.join(r.cacheDir, 'pending.json')), false);
        ok('an installer that will not start, or a declined prompt: the app stays open and can retry');
    }

    // ── the next launch ──
    {
        const r = rig();
        await r.u.check();
        await r.u.download();
        await r.u.install({ restart: true });
        const mk = (installedVersion) => new Updater({ ...r.u.o, installedVersion });
        const again = mk('1.0.5');
        assert.deepStrictEqual(again.snapshot().notice, { kind: 'failed', from: '1.0.5', to: '1.0.6' });
        assert.strictEqual(mk('1.0.5').snapshot().notice, null);
        ok('a launch still on the old version says the update did not finish, once');
    }
    {
        const r = rig();
        await r.u.check();
        await r.u.download();
        await r.u.install({ restart: true });
        const up = new Updater({ ...r.u.o, installedVersion: '1.0.6' });
        assert.deepStrictEqual(up.snapshot().notice, { kind: 'updated', from: '1.0.5', to: '1.0.6' });
        up.dismissNotice();
        assert.strictEqual(up.snapshot().notice, null);
        ok('a launch on the new version says so');
    }

    // ── what a check can run into ──
    {
        const r = rig({ version: null });
        const empty = await r.u.check();
        assert.strictEqual(empty.phase, 'error');
        assert.match(empty.error, /release:local/);
        const gone = rig({ version: null, settings: { folder: path.join(root, 'nowhere') } });
        assert.match((await gone.u.check()).error, /does not exist yet/);
        ok('an empty or missing folder says what fills it');
    }
    {
        const r = rig();
        await r.u.check();
        await r.u.download();
        fs.rmSync(r.folder, { recursive: true, force: true });
        const st = await r.u.check();
        assert.match(st.error, /does not exist/);
        assert.strictEqual(st.phase, 'ready');
        assert.strictEqual(r.u.wantsInstallOnQuit(), true);
        ok('a feed that goes away does not undo an installer already checked');
    }
    {
        const r = rig({ version: null });
        fs.writeFileSync(path.join(r.folder, 'latest.yml'), `version: 1.0.6\nfiles:\n  - url: ../evil.exe\n    sha512: ${sha('x')}\n`);
        const st = await r.u.check();
        assert.strictEqual(st.phase, 'error');
        assert.match(st.error, /plain \.exe/);
        ok('a feed naming a path outside its folder is refused at the check');
    }
    {
        const r = rig({ version: null });
        fs.writeFileSync(path.join(r.folder, 'latest.yml'), `version: 1.0.6\nfiles:\n  - url: a.exe\n    sha512: ${sha('x')}\n`);
        await r.u.check();
        const st = await r.u.download();
        assert.strictEqual(st.phase, 'error');
        assert.match(st.error, /not in/);
        ok('a feed naming an installer that is not there says so');
    }

    // ── GitHub ──
    {
        const bytes = 'from github';
        const seen = [];
        const r = rig({ version: null, settings: { source: 'github', github: { owner: 'o', repo: 'r' } },
            fetchText: async (url) => { seen.push(url); return `version: 1.0.6\nfiles:\n  - url: a.exe\n    sha512: ${sha(bytes)}\n    size: ${bytes.length}\n`; },
            download: async (url, dest, onProgress) => { seen.push(url); onProgress(bytes.length / 2, null); fs.writeFileSync(dest, bytes); onProgress(bytes.length, bytes.length); },
        });
        const progress = [];
        r.u.on('state', (s) => { if (s.phase === 'downloading') progress.push(s.progress); });
        await r.u.check();
        const st = await r.u.download();
        assert.strictEqual(st.phase, 'ready');
        assert.deepStrictEqual(seen, ['https://github.com/o/r/releases/latest/download/latest.yml',
            'https://github.com/o/r/releases/latest/download/a.exe']);
        assert.ok(progress.includes(0.5));
        ok('GitHub: the release’s latest.yml, then its installer, with progress');
    }
    {
        const r = rig({ version: null, settings: { source: 'github' },
            fetchText: async () => { const e = new Error('HTTP 404'); e.status = 404; throw e; } });
        assert.match((await r.u.check()).error, /no release/);
        ok('a repository with no release says that, not "HTTP 404"');
    }

    // ── a dev window ──
    {
        const r = rig({ enabled: false, settings: { autoDownload: true, installOnQuit: true } });
        fs.mkdirSync(r.cacheDir, { recursive: true });
        fs.writeFileSync(path.join(r.cacheDir, 'pending.json'), JSON.stringify({ from: '1.0.4', to: '1.0.5', at: Date.now() }));
        const d = new Updater({ ...r.u.o });
        assert.strictEqual(d.snapshot().phase, 'disabled');
        assert.strictEqual(d.snapshot().disabledReason, 'dev window');
        assert.ok(fs.existsSync(path.join(r.cacheDir, 'pending.json')), 'the marker belongs to the everyday window');
        d.start();
        assert.strictEqual(r.timers.length, 0);
        assert.strictEqual((await d.check()).phase, 'disabled');
        assert.strictEqual((await d.download()).phase, 'disabled');
        assert.strictEqual((await d.install({ restart: true })).ok, false);
        assert.strictEqual(d.wantsInstallOnQuit(), false);
        assert.strictEqual(r.launched.length, 0);
        assert.strictEqual(d.setSettings({ source: 'off' }).phase, 'disabled');
        ok('a dev window checks nothing, installs nothing and leaves the marker alone');
    }

    // ── settings and scheduling ──
    {
        const r = rig();
        r.u.start();
        assert.strictEqual(r.timers.length, 1);
        assert.strictEqual(r.timers[0].ms, r.u.o.startupDelay);
        assert.ok(r.u.setSettings({ source: 'off' }).phase === 'off');
        assert.strictEqual(r.timers.length, 0);
        assert.strictEqual(r.u.setSettings({ source: 'folder', intervalHours: 2 }).phase, 'idle');
        assert.strictEqual(r.timers[0].ms, 2 * 3600 * 1000);
        assert.ok(r.u.setSettings({ folder: 'relative' }).error);
        assert.strictEqual(r.stored().intervalHours, 2);
        r.u.stop();
        ok('off stops the clock, on starts it, and a bad setting is not saved');
    }
    {
        const r = rig({ settings: { checkOnStartup: false, intervalHours: 0 } });
        r.u.start();
        assert.strictEqual(r.timers.length, 0);
        ok('no startup check and no interval means no timer');
    }
    {
        const r = rig();
        await r.u.check();
        await r.u.download();
        const other = path.join(r.dir, 'other');
        fs.mkdirSync(other);
        const st = r.u.setSettings({ folder: other });
        assert.strictEqual(st.ready, false);
        assert.strictEqual(st.available, null);
        ok('pointing at another feed forgets what the old one offered');
    }

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n  ${pass} passed\n`);
})().catch((err) => { console.error(err); process.exit(1); });
