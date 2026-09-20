'use strict';

// `npm run build` — package the desktop app.
//
// Two hosts, two completely different jobs, and the difference is not cosmetic:
//
//   - **From WSL**, the thing being built is a *Windows* executable, so it
//     cannot be built here. Running electron-builder in this directory would
//     fail the same way `electron .` does — there are no node_modules, on
//     purpose. install.ps1 stages the shell into a Windows-local directory,
//     installs there, and packages; this just calls it with the right paths so
//     you do not have to open PowerShell yourself.
//   - **On Linux**, the thing being built is for the machine it is being built
//     on, so it is an ordinary in-tree electron-builder run. Every reason
//     install.ps1 has a staging directory — UNC-path slowness, a file lock on a
//     running .exe, PowerShell's BOM — is a property of the WSL/Windows boundary
//     and none of them exist here.
//
// The Linux arm needs devDependencies installed, so it runs `npm install` first
// if node_modules is missing. That is the one place in this repo where npm
// install is correct: `dependencies` stays empty (see CLAUDE.md), nothing under
// bridge/ or web/ gains a dependency, and node_modules is gitignored. It is also
// why `electron .` becomes a sensible thing to type on Linux and never was here.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { toWindowsPath, isWsl } = require('./win');

const repo = path.join(__dirname, '..');

/** Run a command to completion, inheriting stdio, and resolve its exit code. */
function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: 'inherit', cwd: repo, ...opts });
        child.on('error', (err) => {
            console.error(`Could not run ${cmd}: ${err.message}`);
            resolve(1);
        });
        child.on('close', (code) => resolve(code ?? 1));
    });
}

// Anything after `--` goes through to the packager (e.g. -NoInstall on Windows,
// or --dir on Linux to skip building an AppImage).
const passthrough = process.argv.slice(2);

async function buildOnLinux() {
    if (!fs.existsSync(path.join(repo, 'node_modules'))) {
        console.log('Installing devDependencies (electron, electron-builder)…\n');
        const code = await run('npm', ['install', '--no-audit', '--no-fund']);
        if (code !== 0) return code;
        console.log('');
    }

    const bin = path.join(repo, 'node_modules', '.bin', 'electron-builder');
    if (!fs.existsSync(bin)) {
        console.error('electron-builder is not installed. Try: npm install');
        return 1;
    }

    const code = await run(bin, ['--linux', ...passthrough]);
    if (code === 0) {
        console.log('\nBuilt into dist/. Nothing needs installing to run it:');
        console.log('    npm start');
    }
    return code;
}

async function buildViaPowerShell() {
    const script = path.join(repo, 'install.ps1');
    const winScript = toWindowsPath(script);
    if (!winScript) {
        console.error(`Could not translate ${script} for Windows.`);
        return 1;
    }
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winScript, ...passthrough];
    return run('powershell.exe', args, { cwd: '/mnt/c' });
}

(async () => {
    const code = isWsl() ? await buildViaPowerShell() : await buildOnLinux();
    process.exit(code);
})();
