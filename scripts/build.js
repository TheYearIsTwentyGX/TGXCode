'use strict';

// `npm run build` — package the Windows app from WSL.
//
// Running electron-builder here directly would fail the same way `electron .`
// does: there are no node_modules in this repo, on purpose. install.ps1 stages
// the shell into a Windows-local directory, installs there, and packages. This
// just calls it with the right paths so you do not have to open PowerShell
// yourself.

const path = require('path');
const { spawn } = require('child_process');
const { toWindowsPath, isWsl } = require('./win');

const repo = path.join(__dirname, '..');
const script = path.join(repo, 'install.ps1');

if (!isWsl()) {
    console.error('Run this from WSL, or call .\\install.ps1 directly in PowerShell.');
    process.exit(1);
}

const winScript = toWindowsPath(script);
if (!winScript) {
    console.error(`Could not translate ${script} for Windows.`);
    process.exit(1);
}

// Anything after `--` goes through to install.ps1 (e.g. -NoInstall).
const passthrough = process.argv.slice(2);

const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winScript, ...passthrough];
const child = spawn('powershell.exe', args, { stdio: 'inherit', cwd: '/mnt/c' });

child.on('error', (err) => {
    console.error(`Could not run PowerShell: ${err.message}`);
    process.exit(1);
});
child.on('close', (code) => process.exit(code ?? 1));
