'use strict';

// Is the `claude` we run the newest one, and are the sessions on it?
//
// Two questions, and they come apart more often than you would think. Claude
// Code's native installer updates itself: `~/.local/bin/claude` is a symlink
// into `~/.local/share/claude/versions/`, and an auto-update moves it. A session
// whose process started before that keeps the binary it started with, for as
// long as the process lives — which on this app is hours, because the host
// keeps processes across bridge restarts. So "installed" and "running" are
// separate facts, and the one that explains a missing feature is usually the
// second.
//
//   - **Installed** is `claude --version`, through CLAUDE_BIN like every other
//     spawn. Not the symlink: that is one install method's layout, and the
//     binary's own answer holds for all of them.
//   - **Newest** is the npm registry's dist-tags for @anthropic-ai/claude-code.
//     One unauthenticated GET, no package needed. It is compared against the tag
//     for the configured `autoUpdatesChannel`, because on `stable` the `latest`
//     tag is always ahead and a badge that is always lit is a badge nobody reads.
//   - **Running** is each runner's `claudeVersion`, from the process's own init
//     line (bridge/runner.js). Not the transcript's `version`, which records the
//     first binary that ever wrote to the file.
//
// Updating runs `claude update` and nothing cleverer. It replaces the binary new
// processes start from; it does not touch a running one, and this module does
// not restart anything — which sessions to restart, and when, is the user's.
//
// Nothing here throws. A registry that cannot be reached is `error` on the
// summary with the last good answer kept, because "cannot tell" should not read
// as "up to date" and should not blank what was known a minute ago either.

const https = require('https');
const { execFile } = require('child_process');

const cfg = require('./config');
const { cached } = require('./memo');

const REGISTRY_URL = 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags';
const INSTALLED_TTL_MS = 5 * 60 * 1000;
const LATEST_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const VERSION_TIMEOUT_MS = 15000;
const UPDATE_TIMEOUT_MS = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure parts — test/claude-version.test.js
// ---------------------------------------------------------------------------

/** The dotted number at the front of a version string, or null. */
function parseVersion(text) {
    const m = /(\d+(?:\.\d+)+)/.exec(String(text || ''));
    return m ? m[1] : null;
}

/** Negative, zero or positive, numerically per segment. A missing segment is 0. */
function compareVersions(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
}

/**
 * The dist-tag a channel installs from. Unset is `latest`, which is Claude
 * Code's own default. `rc` → `next` is our reading of the registry, not
 * something the CLI told us: the registry has no `rc` tag, and `next` is the
 * one that runs ahead of `latest`.
 */
function tagForChannel(channel) {
    if (channel === 'stable') return 'stable';
    if (channel === 'rc') return 'next';
    return 'latest';
}

/**
 * What the routes and the event carry.
 *
 * @param {object} o
 * @param {string|null} o.installed
 * @param {object|null} o.tags        the registry's dist-tags
 * @param {string|null} o.channel     autoUpdatesChannel as set, or null
 * @param {object} o.runners          pool.statuses()
 */
function summarize({ installed = null, tags = null, channel = null, runners = {},
    checkedAt = null, error = null, updating = false, lastUpdate = null } = {}) {
    const tag = tagForChannel(channel);
    const latest = (tags && (tags[tag] || tags.latest)) || null;
    const behind = !!(installed && latest && compareVersions(installed, latest) < 0);
    const staleSessions = [];
    if (installed) {
        for (const [id, st] of Object.entries(runners || {})) {
            const v = st && st.claudeVersion;
            if (v && compareVersions(v, installed) < 0) staleSessions.push({ id, version: v });
        }
    }
    return {
        installed, latest, channel: channel || 'latest', tag, behind,
        staleSessions, checkedAt, error, updating, lastUpdate,
    };
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

function run(cmd, args, timeout) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => resolve({
            ok: !err,
            stdout: String(stdout || ''),
            stderr: String(stderr || (err && err.message) || ''),
            code: err ? (err.code ?? 1) : 0,
        }));
    });
}

function fetchTags() {
    return new Promise((resolve, reject) => {
        const req = https.get(REGISTRY_URL, { timeout: FETCH_TIMEOUT_MS,
            headers: { accept: 'application/json' } }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { if (body.length < 65536) body += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`the registry answered ${res.statusCode}`));
                try { resolve(JSON.parse(body)); } catch { reject(new Error('the registry sent something that is not JSON')); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('the registry did not answer in time')));
        req.on('error', reject);
    });
}

class ClaudeVersion {
    /**
     * @param {object} o
     * @param {() => (string|null)} o.channel   the configured autoUpdatesChannel
     * @param {() => object} o.runners          pool.statuses()
     */
    constructor({ channel = () => null, runners = () => ({}) } = {}) {
        this.channelOf = channel;
        this.runnersOf = runners;
        this.store = new Map();
        this.tags = null;          // the last good answer, kept through a failure
        this.error = null;
        this.checkedAt = null;
        this.updating = false;
        this.lastUpdate = null;    // {ok, at, output}
    }

    installed({ fresh = false } = {}) {
        if (fresh) this.store.delete('installed');
        return cached(this.store, 'installed', INSTALLED_TTL_MS, async () => {
            const r = await run(cfg.CLAUDE_BIN, ['--version'], VERSION_TIMEOUT_MS);
            return r.ok ? parseVersion(r.stdout) : null;
        });
    }

    latest({ fresh = false } = {}) {
        if (fresh) this.store.delete('tags');
        return cached(this.store, 'tags', LATEST_TTL_MS, async () => {
            try {
                this.tags = await fetchTags();
                this.error = null;
            } catch (err) {
                this.error = err.message;
            }
            this.checkedAt = Date.now();
            return this.tags;
        });
    }

    /** The summary, asking whatever is stale. */
    async summary({ fresh = false } = {}) {
        const [installed, tags] = await Promise.all([
            this.installed({ fresh }), this.latest({ fresh })]);
        return this.summaryNow(installed, tags);
    }

    /** The summary from what is already known, without asking anything. */
    summaryNow(installed = this._known('installed'), tags = this.tags) {
        let channel = null;
        try { channel = this.channelOf() || null; } catch { /* unreadable settings: default */ }
        return summarize({
            installed, tags, channel, runners: this.runnersOf(),
            checkedAt: this.checkedAt, error: this.error,
            updating: this.updating, lastUpdate: this.lastUpdate,
        });
    }

    _known(key) {
        const hit = this.store.get(key);
        return hit && !hit.pending ? hit.value : null;
    }

    /**
     * Run `claude update`. Resolves `{ok, output}`, or `{busy: true}` when one is
     * already running — the route turns that into a 409.
     */
    async update() {
        if (this.updating) return { busy: true };
        this.updating = true;
        try {
            const r = await run(cfg.CLAUDE_BIN, ['update'], UPDATE_TIMEOUT_MS);
            const output = (r.stdout + (r.stderr && !r.ok ? `\n${r.stderr}` : '')).trim().slice(-4000);
            this.lastUpdate = { ok: r.ok, at: Date.now(), output };
            return { ok: r.ok, output };
        } finally {
            this.updating = false;
            this.store.delete('installed');
        }
    }
}

module.exports = { ClaudeVersion, summarize, compareVersions, tagForChannel, parseVersion, REGISTRY_URL };
