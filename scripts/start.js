'use strict';

// `npm start` — launch the Windows app from WSL.
//
// The obvious `electron .` does not work here and never could: the repo has no
// node_modules, because the Electron shell is packaged from a staging directory
// on the Windows side (see install.ps1). Even with Electron installed in WSL it
// would be the *Linux* build, which is not the app you want.
//
// So this finds the real executable and starts it. If it has not been built yet,
// it says exactly what to run instead of failing with "electron not found".

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { winEnvAsWslPath, toWindowsPath, isWsl } = require('./win');

function findExe() {
    const local = winEnvAsWslPath('LOCALAPPDATA');
    if (!local) return null;
    const candidates = [
        // Installed via the NSIS installer.
        path.join(local, 'Programs', 'ClaudeSessions', 'ClaudeSessions.exe'),
        // Built but not installed.
        path.join(local, 'ClaudeSessions-build', 'dist', 'win-unpacked', 'ClaudeSessions.exe'),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

function main() {
    if (!isWsl()) {
        console.error('This script expects to run inside WSL. On Windows, launch '
            + 'ClaudeSessions from the Start menu.');
        process.exit(1);
    }

    const exe = findExe();
    if (!exe) {
        console.error([
            'Claude Sessions has not been built yet.',
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

main();
