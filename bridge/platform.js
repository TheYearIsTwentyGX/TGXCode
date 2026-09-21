'use strict';

// Which kind of host is this bridge running on.
//
// For a long time the answer was always "WSL, with Windows on the other side of
// it", and so nothing asked: bridge/explorer.js shells out to explorer.exe and
// bridge/devbrowser.js to cmd.exe with no check at all. That is fine until the
// bridge runs on a Linux machine with no Windows anywhere, where those calls do
// not degrade — they ENOENT, and the route returns a 502 for a button the UI
// still draws.
//
// So: one place that knows, rather than a process.platform check scattered
// through the modules that care. There are exactly two answers and they are
// about the *host*, not the platform Node reports — the bridge is a Linux
// process either way, and `process.platform === 'linux'` is true in both.
//
// Two signals, because neither is sufficient on its own:
//
//   - WSL_DISTRO_NAME is set for an interactive shell and is what tells us the
//     distro's *name* (config.js reads it for that). But a bridge started from
//     cron, from systemd, or by `setsid` out of scripts/restart-bridge.sh may
//     not have it, and answering "Linux" there would silently disable Explorer
//     on a machine that has one.
//   - /proc/sys/fs/binfmt_misc/WSLInterop is a property of the kernel rather
//     than of the environment, so it survives all of those. It is also exactly
//     what says whether calling a .exe can work at all: it is the binfmt handler
//     that makes `explorer.exe` executable from Linux. If interop is switched
//     off in /etc/wsl.conf, "Windows" is the wrong answer even under WSL.
//
// CLAUDE_SESSIONS_HOST_KIND overrides both. That is not a debugging knob left in
// by accident — it is how the test suite drives both branches from whichever
// machine is running it. Without it the Linux path ships untested from the
// Windows box and the Windows path ships untested from the Linux one, which is
// the failure this module exists to prevent.

const fs = require('fs');

const WSL_INTEROP = '/proc/sys/fs/binfmt_misc/WSLInterop';

// The kernel probe cannot change while the process runs, so it is worth caching;
// the environment variable is read every time so a test can flip it between
// cases without reloading the module.
let probed = null;

function probe() {
    if (probed === null) {
        probed = Boolean(process.env.WSL_DISTRO_NAME) || fs.existsSync(WSL_INTEROP);
    }
    return probed;
}

/**
 * 'wsl' or 'linux'. Anything else in CLAUDE_SESSIONS_HOST_KIND is ignored rather
 * than thrown on: a typo in an env var should not stop the bridge from starting,
 * and the detected answer is the safe one to fall back to.
 */
function hostKind() {
    const forced = String(process.env.CLAUDE_SESSIONS_HOST_KIND || '').toLowerCase();
    if (forced === 'wsl' || forced === 'linux') return forced;
    return probe() ? 'wsl' : 'linux';
}

/** Can this bridge reach a Windows host — Explorer, cmd.exe, wslpath? */
function isWsl() {
    return hostKind() === 'wsl';
}

/** Only for the tests that flip CLAUDE_SESSIONS_HOST_KIND. */
function _resetProbe() {
    probed = null;
}

module.exports = { hostKind, isWsl, _resetProbe };
