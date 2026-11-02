'use strict';

// `npm run release:local` — build the Windows shell and publish it to the
// updates folder, where the installed app's updater picks it up.
//
// This is install.ps1 with the two things that made it an uninstall/reinstall
// taken out: it does **not** close the running TGXCode and does **not** run the
// installer. It stages in its own directory (`TGXCode-release`, not
// `TGXCode-build`, which `npm start` may be running a copy out of), builds a
// versioned installer, and copies it into the feed with electron-builder's
// latest.yml. The app does the rest: Settings → Updates, or the pill.
//
//   npm run release:local                     # build and publish to the feed
//   npm run release:local -- --feed 'D:\TGX'  # to another folder (Windows or WSL path)
//   npm run release:local -- --dry-run        # say what would happen
//   npm run release:local -- --allow-dev      # publish a branch or dirty build to the real feed
//   node scripts/release.js --info            # the version and hash a build would get, as JSON
//
// The feed folder, first that is set: --feed, TGXCODE_UPDATE_FEED, the folder
// chosen in the installed app's Settings (read from its profile across /mnt/c),
// and %LOCALAPPDATA%\TGXCode-updates.
//
// latest.yml is written last, through a rename, so an app checking while the
// copy is in flight sees the previous release or this one, never half of one.
// The last KEEP installers stay in the folder, each with a copy of its own
// latest.yml as `<installer>.yml`: copy one over latest.yml to go back to it.

require('../bridge/legacy-env');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { toWindowsPath, winEnvAsWslPath, isWsl } = require('./win');
const { buildInfo } = require('../bridge/shell-build');
const { compareVersions, parseLatestYml, pickInstaller } = require('../app/update-feed');

const repo = path.join(__dirname, '..');
const KEEP = 3;
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
    const i = args.findIndex(a => a === name || a.startsWith(`${name}=`));
    if (i < 0) return null;
    return args[i].includes('=') ? args[i].slice(name.length + 1) : (args[i + 1] || null);
};

const isWindowsPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);

/** A path as both sides see it: `{ wsl, win }`. */
function bothForms(p) {
    if (isWindowsPath(p)) {
        const wsl = execFileSync('wslpath', ['-u', p], { encoding: 'utf8' }).trim();
        return { wsl, win: p };
    }
    const abs = path.resolve(p);
    return { wsl: abs, win: toWindowsPath(abs) };
}

/** The folder the installed app was told to look in, if it was told one. */
function folderFromShellPrefs() {
    const appData = winEnvAsWslPath('APPDATA');
    if (!appData) return null;
    for (const name of ['tgxcode', 'TGXCode']) {
        try {
            const raw = fs.readFileSync(path.join(appData, name, 'shell-prefs.json'), 'utf8');
            const folder = JSON.parse(raw.replace(/^\uFEFF/, '')).updates?.folder;
            if (typeof folder === 'string' && folder.trim()) return folder.trim();
        } catch { /* not set */ }
    }
    return null;
}

function resolveFeed() {
    const chosen = option('--feed') || process.env.TGXCODE_UPDATE_FEED || folderFromShellPrefs();
    if (chosen) return bothForms(chosen);
    const local = winEnvAsWslPath('LOCALAPPDATA');
    if (!local) throw new Error('Could not find %LOCALAPPDATA%; pass --feed.');
    return bothForms(path.join(local, 'TGXCode-updates'));
}

/**
 * The checkout the installed app should start its bridge from. A build run from
 * a worktree must not bake the worktree in — that is the stale-checkout accident
 * CLAUDE.md is about — so it is the main checkout, found through git.
 */
function mainCheckout() {
    try {
        const common = execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
            { encoding: 'utf8' }).trim();
        return path.dirname(common);
    } catch {
        return repo;
    }
}

function run(cmd, argv, opts = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, argv, { stdio: 'inherit', ...opts });
        child.on('error', (err) => { console.error(`Could not run ${cmd}: ${err.message}`); resolve(1); });
        child.on('close', (code) => resolve(code ?? 1));
    });
}

/** Older installers out of the feed, newest KEEP kept. */
function prune(dir, keepFile) {
    const builds = fs.readdirSync(dir)
        .map(n => ({ n, m: /^TGXCode-Setup-(.+)\.exe$/.exec(n) }))
        .filter(x => x.m)
        .map(x => ({ name: x.n, version: x.m[1] }))
        .filter(x => { try { compareVersions(x.version, '0.0.0'); return true; } catch { return false; } })
        .sort((a, b) => compareVersions(b.version, a.version));
    for (const b of builds.slice(KEEP)) {
        if (b.name === keepFile) continue;
        for (const n of [b.name, `${b.name}.blockmap`, `${b.name}.yml`]) {
            try { fs.unlinkSync(path.join(dir, n)); console.log(`  pruned ${n}`); } catch { /* not there */ }
        }
    }
}

(async () => {
    const info = buildInfo(repo);
    if (flag('--info')) {
        process.stdout.write(JSON.stringify(info) + '\n');
        return;
    }
    if (!isWsl()) {
        console.error('release:local builds the Windows installer, so it runs from WSL. On Linux, npm run build rebuilds in place.');
        process.exit(2);
    }

    // The everyday window installs whatever turns up in its feed, and a `-dev`
    // build sorts above the commit it sits on — so a branch or an uncommitted edit
    // published there is offered to it, and auto-downloaded. Naming a feed is the
    // way to try one somewhere nothing is watching.
    const isDevBuild = info.dirty || info.branch !== 'main';
    if (isDevBuild && !option('--feed') && !flag('--allow-dev')) {
        console.error(`${info.version} is a dev build (${info.dirty ? 'app/ has uncommitted changes' : `branch ${info.branch}`}), `
            + 'and the updates folder is what the everyday app installs from.\n'
            + 'Commit and land it, or try it elsewhere with --feed <folder>. --allow-dev publishes it anyway.');
        process.exit(3);
    }

    const feed = resolveFeed();
    const bridgeDir = mainCheckout();
    const local = winEnvAsWslPath('LOCALAPPDATA');
    const dist = path.join(local, 'TGXCode-release', 'dist');

    console.log('');
    console.log(`  TGXCode ${info.version}${info.dirty ? '  (app/ has uncommitted changes)' : ''}`);
    console.log(`  shell     ${info.shellHash.slice(0, 12)}  from ${info.commit || '?'} on ${info.branch || '?'}`);
    console.log(`  bridge    ${bridgeDir}`);
    console.log(`  feed      ${feed.win}`);
    console.log('');
    if (flag('--dry-run')) {
        console.log('Dry run: nothing built.');
        return;
    }

    const script = toWindowsPath(path.join(repo, 'install.ps1'));
    if (!script) throw new Error('Could not translate install.ps1 for Windows.');
    const code = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-Release', '-BridgeDir', bridgeDir, '-Version', info.version,
        '-ShellHash', info.shellHash, '-Commit', info.commit || ''], { cwd: '/mnt/c' });
    if (code !== 0) process.exit(code);

    // What electron-builder said it built, checked before anything is published.
    const ymlPath = path.join(dist, 'latest.yml');
    const yml = fs.readFileSync(ymlPath, 'utf8');
    const pick = pickInstaller(parseLatestYml(yml));
    if (pick.error) throw new Error(`electron-builder's latest.yml is unusable: ${pick.error}`);
    if (pick.version !== info.version) throw new Error(`built ${pick.version}, expected ${info.version}`);

    fs.mkdirSync(feed.wsl, { recursive: true });
    for (const n of [pick.file, `${pick.file}.blockmap`]) {
        const src = path.join(dist, n);
        if (!fs.existsSync(src)) { if (n === pick.file) throw new Error(`${src} is missing`); continue; }
        fs.copyFileSync(src, path.join(feed.wsl, n));
        console.log(`  copied ${n}`);
    }
    fs.writeFileSync(path.join(feed.wsl, `${pick.file}.yml`), yml);
    const tmp = path.join(feed.wsl, 'latest.yml.tmp');
    fs.writeFileSync(tmp, yml);
    fs.renameSync(tmp, path.join(feed.wsl, 'latest.yml'));
    console.log('  wrote latest.yml');
    prune(feed.wsl, pick.file);

    console.log('');
    console.log(`Published ${info.version} to ${feed.win}.`);
    console.log('The installed app picks it up on its next check — or Settings → Updates → Check now.');
})().catch((err) => {
    console.error(`release:local failed: ${err.message}`);
    process.exit(1);
});
