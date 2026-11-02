'use strict';

// The pure half of the shell's updater: what a feed says, whether it is newer,
// and whether the settings that point at it make sense. No Electron, no network,
// so test/update-feed.test.js can drive every case from plain Node.
//
// **The feed is electron-builder's own.** `latest.yml`, the NSIS installer it
// names and that installer's sha512 are exactly what `electron-builder` writes
// into dist/ once `build.publish` is set, and exactly what electron-updater reads.
// We read them ourselves rather than take electron-updater because
// `"dependencies": {}` is load-bearing here (CLAUDE.md) and the folder source —
// the one in use — is a `file://` feed electron-updater cannot read without a
// loopback server in front of it. Keeping the format means switching to it later,
// for differential downloads off GitHub, is a dependency and a config change.
//
// The parser below is for the shape electron-builder writes and nothing wider. A
// field it does not know is ignored; a field it needs and cannot find is a refusal
// with a sentence, never a guess.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const SOURCES = ['folder', 'github', 'off'];
const DEFAULT_GITHUB = Object.freeze({ owner: 'TheYearIsTwentyGX', repo: 'TGXCode' });
const MAX_INTERVAL_HOURS = 168;
const DEFAULT_SETTINGS = Object.freeze({
    source: 'folder',
    folder: '',               // empty = the default folder the shell works out
    github: DEFAULT_GITHUB,
    checkOnStartup: true,
    intervalHours: 6,         // 0 = only on startup
    autoDownload: true,
    installOnQuit: true,
});

// ── versions ─────────────────────────────────────────────────────────────

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(v) {
    const m = SEMVER.exec(String(v || '').trim());
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/**
 * -1, 0 or 1, by semver precedence — which is what makes a `-dev.<stamp>` build
 * sort below the release it precedes. Throws on something that is not a version,
 * because "is this newer" has no safe answer for garbage.
 */
function compareVersions(a, b) {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
    for (let i = 0; i < 3; i++) {
        if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
    }
    // A prerelease sorts below the same version without one.
    if (!x.pre.length || !y.pre.length) {
        if (x.pre.length === y.pre.length) return 0;
        return x.pre.length ? -1 : 1;
    }
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const p = x.pre[i];
        const q = y.pre[i];
        if (p === undefined) return -1;
        if (q === undefined) return 1;
        const pn = /^\d+$/.test(p);
        const qn = /^\d+$/.test(q);
        if (pn && qn) {
            if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
        } else if (pn !== qn) {
            return pn ? -1 : 1;
        } else if (p !== q) {
            return p < q ? -1 : 1;
        }
    }
    return 0;
}

/** `newer`, `same` or `older`: what the feed's version is to the installed one. */
function relation(installed, available) {
    const c = compareVersions(available, installed);
    return c > 0 ? 'newer' : c < 0 ? 'older' : 'same';
}

// ── latest.yml ───────────────────────────────────────────────────────────

function scalar(raw) {
    const s = raw.trim();
    if (s.length >= 2 && ((s[0] === "'" && s.endsWith("'")) || (s[0] === '"' && s.endsWith('"')))) {
        const body = s.slice(1, -1);
        return s[0] === "'" ? body.replace(/''/g, "'") : body.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return s;
}

/**
 * electron-builder's latest.yml into a plain object: top-level `key: value`, and
 * `files:` as a list of `- key: value` maps. Anything else is skipped.
 */
function parseLatestYml(text) {
    const out = { files: [] };
    let inFiles = false;
    let cur = null;
    for (const rawLine of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
        if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
        const indented = /^\s/.test(rawLine);
        const line = rawLine.trim();
        if (!indented) {
            inFiles = false;
            cur = null;
            const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
            if (!m) continue;
            if (m[1] === 'files' && m[2] === '') { inFiles = true; continue; }
            out[m[1]] = scalar(m[2]);
            continue;
        }
        if (!inFiles) continue;
        let body = line;
        if (body.startsWith('- ')) {
            cur = {};
            out.files.push(cur);
            body = body.slice(2);
        }
        if (!cur) continue;
        const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(body);
        if (m) cur[m[1]] = scalar(m[2]);
    }
    return out;
}

/** A name that stays inside the folder it was found in: no separators, no `..`. */
function isBareFileName(name) {
    const s = String(name || '');
    return s.length > 0 && s.length <= 255 && s !== '.' && s !== '..'
        && !/[\\/:*?"<>|\x00-\x1f]/.test(s);
}

function isSha512(b64) {
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false;
    return Buffer.from(b64, 'base64').length === 64;
}

/**
 * What to download, from a parsed latest.yml, or an `error` sentence. The
 * installer is the first `.exe` in `files` (where electron-builder puts it),
 * falling back to the legacy top-level `path`/`sha512` pair.
 */
function pickInstaller(feed) {
    if (!feed || typeof feed !== 'object') return { error: 'the feed is empty' };
    if (!parseVersion(feed.version)) return { error: `the feed's version (${feed.version || 'missing'}) is not a version` };
    const entry = (feed.files || []).find(f => /\.exe$/i.test(f.url || ''))
        || (feed.path ? { url: feed.path, sha512: feed.sha512, size: feed.size } : null);
    if (!entry) return { error: 'the feed names no installer' };
    if (!isBareFileName(entry.url) || !/\.exe$/i.test(entry.url)) {
        return { error: `the feed's installer name (${entry.url}) is not a plain .exe file name` };
    }
    if (!isSha512(entry.sha512)) return { error: 'the feed has no valid sha512 for the installer' };
    const size = Number(entry.size);
    return {
        version: String(feed.version).replace(/^v/, ''),
        file: entry.url,
        sha512: entry.sha512,
        size: Number.isFinite(size) && size > 0 ? size : null,
        releaseDate: feed.releaseDate || null,
    };
}

// ── settings ─────────────────────────────────────────────────────────────

const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** Absolute for the platform the shell runs on. Windows takes a drive or UNC path. */
function isAbsoluteFolder(p, platform) {
    const s = String(p || '');
    if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]+\\[^\\]+/.test(s);
    return s.startsWith('/');
}

/**
 * Settings as stored, made whole: anything missing takes its default, numbers are
 * clamped. Never throws — a hand-edited file should degrade, not brick the card.
 */
function normalizeSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const gh = s.github && typeof s.github === 'object' ? s.github : {};
    const hours = Number(s.intervalHours);
    return {
        source: SOURCES.includes(s.source) ? s.source : DEFAULT_SETTINGS.source,
        folder: typeof s.folder === 'string' ? s.folder.trim() : '',
        github: {
            owner: GH_OWNER.test(gh.owner || '') ? gh.owner : DEFAULT_GITHUB.owner,
            repo: GH_REPO.test(gh.repo || '') ? gh.repo : DEFAULT_GITHUB.repo,
        },
        checkOnStartup: typeof s.checkOnStartup === 'boolean' ? s.checkOnStartup : DEFAULT_SETTINGS.checkOnStartup,
        intervalHours: Number.isFinite(hours)
            ? Math.max(0, Math.min(MAX_INTERVAL_HOURS, Math.round(hours))) : DEFAULT_SETTINGS.intervalHours,
        autoDownload: typeof s.autoDownload === 'boolean' ? s.autoDownload : DEFAULT_SETTINGS.autoDownload,
        installOnQuit: typeof s.installOnQuit === 'boolean' ? s.installOnQuit : DEFAULT_SETTINGS.installOnQuit,
    };
}

/**
 * A change from the page, checked strictly — unlike normalizeSettings, a bad value
 * here is the user typing something wrong, and they should be told rather than
 * have it quietly replaced. Returns `{ settings }` merged over `current`, or
 * `{ error }`.
 */
function applySettingsPatch(current, patch, platform) {
    if (!patch || typeof patch !== 'object') return { error: 'not a settings object' };
    const next = { ...normalizeSettings(current) };
    if ('source' in patch) {
        if (!SOURCES.includes(patch.source)) return { error: `source must be one of ${SOURCES.join(', ')}` };
        next.source = patch.source;
    }
    if ('folder' in patch) {
        const f = typeof patch.folder === 'string' ? patch.folder.trim() : null;
        if (f === null) return { error: 'folder must be a string' };
        if (f && !isAbsoluteFolder(f, platform)) {
            return { error: platform === 'win32'
                ? 'the folder must be a full path, like C:\\Users\\you\\TGXCode-updates or \\\\server\\share'
                : 'the folder must be an absolute path' };
        }
        next.folder = f;
    }
    if ('github' in patch) {
        const g = patch.github || {};
        if (!GH_OWNER.test(g.owner || '')) return { error: 'that is not a GitHub owner name' };
        if (!GH_REPO.test(g.repo || '')) return { error: 'that is not a GitHub repository name' };
        next.github = { owner: g.owner, repo: g.repo };
    }
    for (const key of ['checkOnStartup', 'autoDownload', 'installOnQuit']) {
        if (!(key in patch)) continue;
        if (typeof patch[key] !== 'boolean') return { error: `${key} must be true or false` };
        next[key] = patch[key];
    }
    if ('intervalHours' in patch) {
        const h = Number(patch.intervalHours);
        if (!Number.isInteger(h) || h < 0 || h > MAX_INTERVAL_HOURS) {
            return { error: `check every N hours: a whole number from 0 to ${MAX_INTERVAL_HOURS}` };
        }
        next.intervalHours = h;
    }
    return { settings: next };
}

/**
 * Where the feed is. A folder is joined with the shell's own path flavour, so a
 * Windows path stays one when this runs under test on Linux.
 */
function feedLocation(settings, { platform, defaultFolder }) {
    const s = normalizeSettings(settings);
    if (s.source === 'off') return null;
    if (s.source === 'github') {
        const base = `https://github.com/${s.github.owner}/${s.github.repo}/releases/latest/download/`;
        return { kind: 'github', manifest: `${base}latest.yml`, fileUrl: (f) => base + encodeURIComponent(f),
            label: `${s.github.owner}/${s.github.repo}` };
    }
    const p = platform === 'win32' ? path.win32 : path.posix;
    const dir = s.folder || defaultFolder;
    if (!dir) return null;
    return { kind: 'folder', dir, manifest: p.join(dir, 'latest.yml'), filePath: (f) => p.join(dir, f), label: dir };
}

/** Milliseconds until the next periodic check, or null when only startup checks. */
function nextCheckDelay(settings, lastCheckedAt, now) {
    const s = normalizeSettings(settings);
    if (s.source === 'off' || !s.intervalHours) return null;
    const every = s.intervalHours * 3600 * 1000;
    if (!lastCheckedAt) return every;
    return Math.max(60 * 1000, lastCheckedAt + every - now);
}

/**
 * The NSIS installer's arguments, as electron-updater passes them. `--updated`
 * tells electron-builder's script this is an update (it closes the running app
 * instead of asking, and keeps the install location); `/S` is silent;
 * `--force-run` starts the app again when it is done.
 */
function installerArgs({ restart }) {
    return restart ? ['--updated', '/S', '--force-run'] : ['--updated', '/S'];
}

/** sha512 of a file, base64 — the form latest.yml carries. */
function sha512File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha512');
        fs.createReadStream(file).on('error', reject).on('data', c => h.update(c)).on('end', () => resolve(h.digest('base64')));
    });
}

async function verifySha512(file, expected) {
    try { return (await sha512File(file)) === expected; } catch { return false; }
}

module.exports = {
    SOURCES, DEFAULT_SETTINGS, DEFAULT_GITHUB, MAX_INTERVAL_HOURS,
    parseVersion, compareVersions, relation,
    parseLatestYml, pickInstaller, isBareFileName, isSha512,
    isAbsoluteFolder, normalizeSettings, applySettingsPatch, feedLocation, nextCheckDelay,
    installerArgs, sha512File, verifySha512,
};
