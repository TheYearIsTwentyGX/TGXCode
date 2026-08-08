'use strict';

// Small helpers for reaching the Windows side from WSL.
//
// The npm scripts in this repo run inside WSL, but the app itself is a Windows
// executable and the build runs with Windows node. These bridge the gap.

const { execFileSync } = require('child_process');

/** Expand a Windows environment variable (e.g. LOCALAPPDATA) to a WSL path. */
function winEnvAsWslPath(name) {
    try {
        // cmd.exe warns and bails when its cwd is a UNC path, so run it from /mnt/c.
        const raw = execFileSync('cmd.exe', ['/c', `echo %${name}%`],
            { cwd: '/mnt/c', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (!raw || raw.startsWith('%')) return null;
        return execFileSync('wslpath', ['-u', raw], { encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

/** Translate a WSL path to the Windows form Explorer and PowerShell understand. */
function toWindowsPath(p) {
    try {
        return execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

function isWsl() {
    return Boolean(process.env.WSL_DISTRO_NAME)
        || require('fs').existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
}

module.exports = { winEnvAsWslPath, toWindowsPath, isWsl };
