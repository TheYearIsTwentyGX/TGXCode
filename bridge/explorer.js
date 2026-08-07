'use strict';

// Opening a WSL directory in Windows File Explorer.
//
// Explorer can browse the distro through the \\wsl.localhost share, so the job
// is just translating the Linux path and handing it over. `wslpath -w` does the
// translation; explorer.exe does the rest.

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

module.exports = { openInExplorer, toWindowsPath };
