'use strict';

// What the desktop shell would be if it were built from this checkout: a hash
// of everything that gets packaged, and the version a build of it would carry.
//
// **Why a hash and not the version.** `web/` and `bridge/` are live off disk,
// but `app/` is packaged — so the window you are looking at can be running a
// shell from weeks ago under a UI from this morning, and nothing says so. The
// version cannot answer that: it is worked out per build and is never committed,
// and a commit that touches only `web/` moves it without changing the shell. The
// hash is of what install.ps1 actually copies — every file under `app/` and the
// three package.json fields that change what electron-builder produces — so it
// moves exactly when a rebuild would produce a different shell. scripts/release.js
// bakes it into `app/build-info.json`, and the page compares the two.
//
// **The version scheme.** `<major>.<minor>` from package.json, which stays the
// manual knob, and the commit count as the patch, so a build on `main` is
// `1.0.<count>` and always newer than the one before it. A dirty tree or a branch
// other than `main` builds `1.0.<count+1>-dev.<UTC stamp>`: semver puts a
// prerelease *below* the same version without one, so that sorts above the commit
// it sits on and below the next real build, which is the order you would expect
// them installed in. The bridge's own `cfg.VERSION` is a different number and is
// left alone.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Written into the staged app/ by install.ps1, so never part of what was built
// *from* the checkout.
const EXCLUDE = new Set(['config.json', 'build-info.json']);
const PACKAGE_FIELDS = ['main', 'build', 'devDependencies'];

function listFiles(dir, rel = '') {
    let out = [];
    let entries;
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) out = out.concat(listFiles(dir, r));
        else if (e.isFile() && !(rel === '' && EXCLUDE.has(e.name))) out.push(r);
    }
    return out;
}

/** The hash of the shell a build of `root` would package, as hex. */
function shellHash(root) {
    const h = crypto.createHash('sha256');
    const app = path.join(root, 'app');
    for (const rel of listFiles(app).sort()) {
        h.update(`file\0${rel}\0`);
        // Line endings are normalised: a checkout with autocrlf must not read as a
        // different shell from the same commit.
        h.update(fs.readFileSync(path.join(app, rel)).toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
        h.update('\0');
    }
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* none */ }
    for (const k of PACKAGE_FIELDS) h.update(`pkg\0${k}\0${JSON.stringify(pkg[k] === undefined ? null : pkg[k])}\0`);
    return h.digest('hex');
}

/** `YYYYMMDDHHMM` in UTC, the dev builds' tiebreak. */
function stamp(date) {
    const d = new Date(date);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/**
 * The version for a build, from its inputs. Pure, so the scheme is tested
 * without git.
 */
function versionFor({ base, count, dirty, branch, now }) {
    const m = /^(\d+)\.(\d+)/.exec(String(base || ''));
    const [major, minor] = m ? [m[1], m[2]] : ['1', '0'];
    const n = Math.max(0, Number(count) || 0);
    if (!dirty && branch === 'main') return `${major}.${minor}.${n}`;
    return `${major}.${minor}.${n + 1}-dev.${stamp(now || Date.now())}`;
}

function git(root, args) {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * What a build of `root` would be: version, hash, commit, and whether the
 * packaged files differ from the commit. Only `app/` and package.json count as
 * dirty — an edit under `web/` does not change the shell.
 */
function buildInfo(root, { now = Date.now() } = {}) {
    let base = '1.0.0';
    try { base = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || base; } catch { /* default */ }
    let count = 0, commit = null, branch = null, dirty = true;
    try {
        count = Number(git(root, ['rev-list', '--count', 'HEAD'])) || 0;
        commit = git(root, ['rev-parse', '--short', 'HEAD']);
        branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        dirty = git(root, ['status', '--porcelain', '--', 'app', 'package.json']) !== '';
    } catch { /* not a git checkout: a dev build */ }
    return {
        version: versionFor({ base, count, dirty, branch, now }),
        shellHash: shellHash(root),
        commit, branch, dirty,
    };
}

// ── building one, from the page ──────────────────────────────────────────
//
// "Shell out of date — Build update" runs scripts/release.js, which packages on
// the Windows side and publishes to the feed; the shell's updater takes it from
// there. One at a time, its output to a log the page tails while it runs. It is a
// child of this bridge, so a bridge restart ends it — the log says how far it got.

const TAIL_LINES = 40;
let release = null;   // { pid, startedAt, finishedAt, exitCode, log }

function tail(file, lines = TAIL_LINES) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        return text.split(/\r?\n/).filter(l => l.trim()).slice(-lines).join('\n');
    } catch {
        return '';
    }
}

function releaseState() {
    if (!release) return null;
    return {
        running: release.exitCode === null,
        startedAt: release.startedAt,
        finishedAt: release.finishedAt,
        exitCode: release.exitCode,
        tail: tail(release.log),
    };
}

/** Start scripts/release.js in `root`. `{ error }` when one is already running. */
function startRelease({ root, logFile, execPath = process.execPath, spawnImpl }) {
    if (release && release.exitCode === null) return { error: 'a build is already running' };
    const { spawn } = require('child_process');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'w');
    const child = (spawnImpl || spawn)(execPath, [path.join(root, 'scripts', 'release.js')],
        { cwd: root, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    const rec = { pid: child.pid || null, startedAt: Date.now(), finishedAt: null, exitCode: null, log: logFile };
    release = rec;
    const done = (code) => {
        if (rec.exitCode !== null) return;
        rec.exitCode = typeof code === 'number' ? code : 1;
        rec.finishedAt = Date.now();
    };
    child.on('error', (err) => {
        try { fs.appendFileSync(logFile, `\nCould not start the build: ${err.message}\n`); } catch { /* best effort */ }
        done(1);
    });
    child.on('close', done);
    return { release: releaseState() };
}

module.exports = { shellHash, versionFor, buildInfo, stamp, startRelease, releaseState };
