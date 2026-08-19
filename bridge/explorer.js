'use strict';

// Opening a WSL directory in Windows File Explorer, and a WSL file in whatever
// Windows opens that kind of file with.
//
// Explorer can browse the distro through the \\wsl.localhost share, so the job
// is just translating the Linux path and handing it over. `wslpath -w` does the
// translation; explorer.exe does the rest — and given a *file* rather than a
// directory it launches the default handler, which is the whole of openFile.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function toWindowsPath(dir) {
    return new Promise((resolve) => {
        execFile('wslpath', ['-w', dir], { timeout: 5000 },
            (err, stdout) => resolve(err ? null : stdout.trim()));
    });
}

/**
 * Reveal a directory in File Explorer.
 * Returns {ok, path} or {ok:false, error}.
 */
async function openInExplorer(dir) {
    if (!dir) return { ok: false, error: 'no directory given' };

    const resolved = path.resolve(dir);
    let st;
    try { st = fs.statSync(resolved); } catch {
        return { ok: false, error: `${resolved} does not exist` };
    }
    const target = st.isDirectory() ? resolved : path.dirname(resolved);

    const winPath = await toWindowsPath(target);
    if (!winPath) return { ok: false, error: 'could not translate the path for Windows' };

    return new Promise((resolve) => {
        // explorer.exe reports exit code 1 even when it opens the window
        // perfectly well, so its status tells us nothing. Treat a spawn failure
        // as the only real error.
        execFile('explorer.exe', [winPath], { timeout: 10000 }, (err) => {
            if (err && err.code === 'ENOENT') {
                return resolve({ ok: false, error: 'explorer.exe not found on PATH' });
            }
            resolve({ ok: true, path: winPath });
        });
    });
}

/**
 * Open a file in whatever program Windows opens that kind of file with.
 *
 * The counterpart to openInExplorer rather than a flag on it, because the two do
 * genuinely different things to the same path: that one shows you the file's
 * folder, this one launches the file. Sharing a function and branching inside it
 * would mean a caller could not ask for either one specifically, and "reveal a
 * PDF" and "open a PDF" are both things people want.
 *
 * Returns {ok, path} or {ok:false, error}.
 */
async function openFile(file) {
    if (!file) return { ok: false, error: 'no file given' };

    const resolved = path.resolve(file);
    let st;
    try { st = fs.statSync(resolved); } catch {
        return { ok: false, error: `${resolved} does not exist` };
    }
    // A directory handed to this would open Explorer, which is the other function's
    // job. Saying so beats quietly doing something adjacent to what was asked.
    if (st.isDirectory()) return { ok: false, error: `${resolved} is a directory` };

    const winPath = await toWindowsPath(resolved);
    if (!winPath) return { ok: false, error: 'could not translate the path for Windows' };

    return new Promise((resolve) => {
        // Same reasoning as openInExplorer: explorer.exe's exit code says nothing
        // about whether the window opened, so only a spawn failure is an error. The
        // consequence is worth naming — a file type with no handler registered
        // reports ok, and Windows shows its own "how do you want to open this"
        // dialog. That is the right outcome to report as success.
        execFile('explorer.exe', [winPath], { timeout: 10000 }, (err) => {
            if (err && err.code === 'ENOENT') {
                return resolve({ ok: false, error: 'explorer.exe not found on PATH' });
            }
            resolve({ ok: true, path: winPath });
        });
    });
}

module.exports = { openInExplorer, openFile, toWindowsPath };
