'use strict';

// `npm start` — launch the desktop app.
//
// **From WSL**, `electron .` does not work and never could: the repo has no
// node_modules, because the Electron shell is packaged from a staging directory
// on the Windows side (see install.ps1). Even with Electron installed in WSL it
// would be the *Linux* build, which is not the app you want. So this finds the
// real executable and starts it.
//
// **On Linux** that objection disappears, because the Linux build *is* the app
// you want. A built AppImage is preferred when there is one — it is what an
// installed copy looks like — and `electron .` is the fallback, which makes the
// edit-and-restart loop for app/main.js as short here as the one for bridge/ and
// web/ has always been.
//
// Either way, if there is nothing to launch it says what to run rather than
// failing with "electron not found".

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { winEnvAsWslPath, toWindowsPath, isWsl } = require('./win');

const repo = path.join(__dirname, '..');

function findExe() {
    const local = winEnvAsWslPath('LOCALAPPDATA');
    if (!local) return null;
    const candidates = [
        // Installed via the NSIS installer.
        path.join(local, 'Programs', 'TGXCode', 'TGXCode.exe'),
        // Built but not installed.
        path.join(local, 'TGXCode-build', 'dist', 'win-unpacked', 'TGXCode.exe'),
        // The same two from before the rename, until nobody has that build.
        path.join(local, 'Programs', 'ClaudeSessions', 'ClaudeSessions.exe'),
        path.join(local, 'ClaudeSessions-build', 'dist', 'win-unpacked', 'ClaudeSessions.exe'),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

/** A built Linux app, in the order a person would expect it to be found. */
function findLinuxApp() {
    const dist = path.join(repo, 'dist');
    // An AppImage carries its version in the filename, so it is matched rather
    // than named. Newest first, so a stale build is not preferred over a fresh.
    try {
        const images = fs.readdirSync(dist)
            .filter(f => f.endsWith('.AppImage'))
            .map(f => path.join(dist, f))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (images.length) return images[0];
    } catch { /* never built */ }

    // `--dir` builds leave an unpacked tree instead.
    const unpacked = ['TGXCode', 'tgxcode', 'ClaudeSessions']
        .map(name => path.join(dist, 'linux-unpacked', name))
        .find(p => fs.existsSync(p));
    if (unpacked) return unpacked;

    return null;
}

function startOnWindows() {
    const exe = findExe();
    if (!exe) {
        console.error([
            'TGXCode has not been built yet.',
            '',
            'Build it from PowerShell, in this directory:',
            '',
            '    .\\install.ps1',
            '',
            'Or skip the desktop app entirely and use the UI in a browser:',
            '',
            '    npm run bridge      then open http://127.0.0.1:45888',
            '',
        ].join('\n'));
        process.exit(1);
    }

    const winPath = toWindowsPath(exe);
    if (!winPath) {
        console.error(`Found ${exe} but could not translate it for Windows.`);
        process.exit(1);
    }

    // `start` detaches, so npm returns instead of babysitting the window.
    execFile('cmd.exe', ['/c', 'start', '', winPath], { cwd: '/mnt/c' }, (err) => {
        if (err) {
            console.error(`Could not launch the app: ${err.message}`);
            process.exit(1);
        }
    });
    console.log(`Launching ${path.basename(exe)}…`);
    console.log('It starts its own bridge; nothing else to run.');
}

function startOnLinux() {
    const app = findLinuxApp();
    const electron = path.join(repo, 'node_modules', '.bin', 'electron');

    let cmd;
    let args;
    if (app) {
        cmd = app;
        args = [];
    } else if (fs.existsSync(electron)) {
        // Running from source: the same shell, without the packaging round trip.
        cmd = electron;
        args = [repo];
    } else {
        console.error([
            'TGXCode has not been built yet, and electron is not installed.',
            '',
            'Build it:',
            '',
            '    npm run build',
            '',
            'Or install the devDependencies and run from source:',
            '',
            '    npm install && npm start',
            '',
            'Or skip the desktop app entirely and use the UI in a browser:',
            '',
            '    npm run bridge      then open http://127.0.0.1:45888',
            '',
        ].join('\n'));
        process.exit(1);
    }

    // Detached, so npm returns rather than babysitting the window — the same
    // behaviour `cmd.exe /c start` gives on the other host.
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
        console.error(`Could not launch the app: ${err.message}`);
        process.exit(1);
    });
    child.unref();

    console.log(`Launching ${path.basename(cmd)}…`);
    console.log('It starts its own bridge; nothing else to run.');
}

if (isWsl()) startOnWindows();
else startOnLinux();
