'use strict';

// Opening a directory in the desktop's file manager, and a file in whatever the
// desktop opens that kind of file with.
//
// There are two hosts this can run on and they are not the same job:
//
//   - **Under WSL**, the file manager is Windows Explorer. It can browse the
//     distro through the \\wsl.localhost share, so the work is translating the
//     Linux path and handing it over: `wslpath -w` does the translation,
//     explorer.exe does the rest — and given a *file* rather than a directory it
//     launches the default handler, which is the whole of openFile.
//   - **On a Linux host** there is no Windows anywhere, and the same calls do
//     not degrade: `explorer.exe` is simply not on PATH and every route that
//     reaches this module answers 502 for a button the UI still draws. So the
//     desktop's own openers do the job — `xdg-open` for a file, and for a reveal
//     the FileManager1 D-Bus interface, which can *select* the file rather than
//     only opening its folder.
//
// bridge/platform.js decides which, and the exported shape is identical either
// way so that the routes that call it do not branch.
//
// One thing genuinely differs and is worth knowing before reading the code: on
// Windows an exit code tells us nothing (see handToExplorer), while xdg-open has
// documented exit codes that are worth believing. So the Linux branch reports a
// failure the Windows branch has to swallow.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { isWsl } = require('./platform');

/**
 * Extensions the host *runs* rather than opens.
 *
 * Handed one of these, a file manager launches the default handler, and for
 * these the default handler is the file itself. That is fine for the two callers
 * that name a path this app computed, and not fine for POST /api/fs/open, whose
 * path is text a model wrote into a transcript: a helpful-looking link would be
 * one click from arbitrary code holding the user's session. `.lnk` and `.url`
 * are on the list although they are not code - they are a pointer to some, and
 * one nothing on this side can see the far end of.
 *
 * Deliberately absent: `.js`, `.ts`, `.py`, `.sh`, `.md`. A `.js` associated with
 * Windows Script Host would run, and that is the residual risk this rule does not
 * close - but `.js` is what this repository is made of, and a rule that refuses
 * to open the files the feature exists for is a rule nobody keeps. What keeps the
 * risk small is that the link text is the path: you see what you are opening.
 *
 * The list is the *union* of both hosts' dangerous extensions rather than a pair
 * chosen by platform, and that is deliberate on two counts. It keeps this a pure
 * function, which is why it can be tested without a shell. And the cost of an
 * entry that is inert on the running host is one extra click on a file nobody
 * clicks from a transcript anyway - whereas the cost of getting the switch wrong
 * is the one thing this list exists to prevent. A `.desktop` is the Linux
 * `.lnk`: a pointer to a command, executed by the file manager, and nothing on
 * this side can see what it points at.
 */
const LAUNCHABLE = new Set([
    // Windows runs these.
    '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.msi',
    '.msp', '.lnk', '.url', '.scr', '.pif', '.vbs', '.vbe', '.wsf', '.wsh', '.hta',
    '.reg', '.jar', '.cpl', '.msc', '.scf', '.appref-ms',
    // A Linux desktop runs these.
    '.desktop', '.appimage', '.run', '.bin',
]);

/** Would the host run this rather than open it? Exported so it tests without a shell. */
function isLaunchable(file) {
    return LAUNCHABLE.has(path.extname(String(file || '')).toLowerCase());
}

/**
 * Translate a Linux path to the Windows form Explorer understands.
 *
 * Null on a Linux host, where the question does not arise. Callers must treat
 * that as "there is no Windows path", not as a failure - it is the difference
 * between this module's two branches, not an error in either.
 */
function toWindowsPath(dir) {
    return new Promise((resolve) => {
        if (!isWsl()) return resolve(null);
        execFile('wslpath', ['-w', dir], { timeout: 5000 },
            (err, stdout) => resolve(err ? null : stdout.trim()));
    });
}

/**
 * The other direction: a path written the way Windows reaches it -
 * `\\wsl.localhost\Ubuntu\...`, `C:\...` - as the Linux one, for
 * POST /api/fs/open, whose paths are copied out of transcripts.
 *
 * Null on a Linux host, and null when wslpath refuses it (a share for a distro
 * that is not this one, say). Either way there is no Linux path to act on.
 */
function toLinuxPath(win) {
    return new Promise((resolve) => {
        if (!isWsl()) return resolve(null);
        execFile('wslpath', ['-u', win], { timeout: 5000 },
            (err, stdout) => resolve(err ? null : stdout.trim() || null));
    });
}

/**
 * Hand a path to explorer.exe.
 *
 * explorer.exe reports exit code 1 even when it opens the window perfectly well,
 * so its status tells us nothing. Treat a spawn failure as the only real error.
 * The consequence is worth naming - a file type with no handler registered
 * reports ok, and Windows shows its own "how do you want to open this" dialog.
 * That is the right outcome to report as success.
 */
function handToExplorer(target) {
    return new Promise((resolve) => {
        execFile('explorer.exe', [target], { timeout: 10000 }, (err) => {
            if (err && err.code === 'ENOENT') {
                return resolve({ ok: false, error: 'explorer.exe not found on PATH' });
            }
            resolve({ ok: true, path: target });
        });
    });
}

/**
 * Hand a path to xdg-open.
 *
 * Unlike explorer.exe, xdg-open's exit codes are specified and worth believing:
 * 1 syntax, 2 no such file, 3 no application found, 4 the application failed.
 * So this reports a failure where the Windows branch has to assume success - a
 * file type with no handler is a 502 here and a dialog there. That asymmetry is
 * the honest one: on Windows something did appear on screen, and on Linux
 * nothing did.
 */
function handToXdgOpen(target) {
    return new Promise((resolve) => {
        execFile('xdg-open', [target], { timeout: 10000 }, (err) => {
            if (!err) return resolve({ ok: true, path: target });
            if (err.code === 'ENOENT') {
                return resolve({
                    ok: false,
                    error: 'xdg-open not found on PATH (install xdg-utils)',
                });
            }
            if (err.code === 3) {
                return resolve({ ok: false, error: `nothing on this desktop opens ${target}` });
            }
            resolve({ ok: false, error: `xdg-open failed for ${target}` });
        });
    });
}

/**
 * Ask the desktop's file manager to show a file *selected* in its folder.
 *
 * org.freedesktop.FileManager1 is implemented by Nautilus, Dolphin, Thunar, Nemo
 * and PCManFM, which covers most desktops - but not all of them, and not a
 * headless session. So this is an attempt rather than the answer: the caller
 * falls back to opening the containing folder, which is what the Windows branch
 * does in every case anyway.
 */
function showItemViaDbus(file) {
    return new Promise((resolve) => {
        const uri = pathToFileURL(file).href;
        execFile('dbus-send', [
            '--session', '--print-reply', '--reply-timeout=5000',
            '--dest=org.freedesktop.FileManager1',
            '--type=method_call',
            '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1.ShowItems',
            `array:string:${uri}`,
            'string:',
        ], { timeout: 8000 }, (err) => resolve(!err));
    });
}

/**
 * Reveal a directory in the host's file manager.
 *
 * Given a file rather than a directory this shows the folder holding it - and on
 * a Linux desktop that implements FileManager1, shows it with the file selected,
 * which is the thing Explorer has never done here.
 *
 * Returns {ok, path} or {ok:false, error}. `path` is the path as it was handed
 * to the file manager: the \\wsl.localhost form under WSL, and the same Linux
 * path on a Linux host.
 */
async function openInExplorer(dir) {
    if (!dir) return { ok: false, error: 'no directory given' };

    const resolved = path.resolve(dir);
    let st;
    try { st = fs.statSync(resolved); } catch {
        return { ok: false, error: `${resolved} does not exist` };
    }
    const folder = st.isDirectory() ? resolved : path.dirname(resolved);

    if (isWsl()) {
        const winPath = await toWindowsPath(folder);
        if (!winPath) return { ok: false, error: 'could not translate the path for Windows' };
        return handToExplorer(winPath);
    }

    // A file: try to select it where the desktop can, and only fall back to
    // opening its folder. A directory has nothing to select, so it goes straight
    // to the opener.
    if (!st.isDirectory() && await showItemViaDbus(resolved)) {
        return { ok: true, path: resolved };
    }
    return handToXdgOpen(folder);
}

/**
 * Open a file in whatever program the host opens that kind of file with.
 *
 * The counterpart to openInExplorer rather than a flag on it, because the two do
 * genuinely different things to the same path: that one shows you the file's
 * folder, this one launches the file. Sharing a function and branching inside it
 * would mean a caller could not ask for either one specifically, and "reveal a
 * PDF" and "open a PDF" are both things people want.
 *
 * Returns {ok, path} or {ok:false, error}, with `path` as described above.
 */
async function openFile(file) {
    if (!file) return { ok: false, error: 'no file given' };

    const resolved = path.resolve(file);
    let st;
    try { st = fs.statSync(resolved); } catch {
        return { ok: false, error: `${resolved} does not exist` };
    }
    // A directory handed to this would open a file manager, which is the other
    // function's job. Saying so beats quietly doing something adjacent to what
    // was asked.
    if (st.isDirectory()) return { ok: false, error: `${resolved} is a directory` };

    if (isWsl()) {
        const winPath = await toWindowsPath(resolved);
        if (!winPath) return { ok: false, error: 'could not translate the path for Windows' };
        return handToExplorer(winPath);
    }

    return handToXdgOpen(resolved);
}

module.exports = { openInExplorer, openFile, toWindowsPath, toLinuxPath, isLaunchable };
