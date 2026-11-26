'use strict';

// How much of the Codex quota is gone, and whether Codex is signed in at all.
//
// Claude's reading (bridge/usage.js) is assembled out of a status line and a
// stream event because the CLI will not simply be asked. Codex will: the
// app-server answers `account/read` and `account/rateLimits/read`, and a live
// conversation pushes `account/rateLimits/updated` after its turns. So this has
// two sources and no harvesting:
//
//   - **A short-lived app-server** (bridge/codex/client.js), at bridge start, on
//     the Refresh button, and on a timer when the last reading is old — which is
//     what "no Codex process is running" amounts to. Reading it costs no quota
//     and opens no thread, so nothing appears in the rail.
//   - **Pushes from live processes**, merged over the last read. The schema calls
//     them sparse: a null field means "not said", never "cleared".
//
// **The windows are Codex's, not Claude's.** A snapshot has `primary` and
// `secondary`, each `{usedPercent, windowDurationMins, resetsAt}`, and either may
// be null: a Free account had one 30-day window and `secondary: null` (measured
// on 0.172.0). Labels are made from `windowDurationMins` and nothing assumes five
// hours or a week.
//
// **Signed out is `account: null`.** `requiresOpenaiAuth` is true signed in too
// (docs/plans/23-codex.md, *Measured on 0.172.0*), so it is not looked at.
//
// Nothing here throws. A Codex that cannot be asked leaves the last reading in
// place with `error` set.

const { EventEmitter } = require('events');

const { spawnAppServer, initialize } = require('./client');

const TIMEOUT_MS = 20_000;
const STALE_MS = 10 * 60_000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `{label, shortLabel}` for a window of this many minutes — "30-day"/"30d". */
function windowLabel(mins) {
    if (!num(mins) || mins <= 0) return { label: 'Usage limit', shortLabel: 'Limit' };
    if (mins < 60) return { label: `${Math.round(mins)}-minute`, shortLabel: `${Math.round(mins)}m` };
    if (mins < 1440) {
        const h = Math.round(mins / 60);
        return { label: `${h}-hour`, shortLabel: `${h}h` };
    }
    const d = Math.round(mins / 1440);
    return { label: `${d}-day`, shortLabel: `${d}d` };
}

/**
 * A sparse update laid over what is known. A null (or missing) field keeps the
 * old value, inside a window too, so an update carrying only a new percentage
 * does not lose the window's length.
 */
function merge(prev, next) {
    if (!prev) return next || null;
    if (!next) return prev;
    const out = { ...prev };
    for (const [k, v] of Object.entries(next)) {
        if (v === null || v === undefined) continue;
        out[k] = (k === 'primary' || k === 'secondary' || k === 'credits') && prev[k]
            ? merge(prev[k], v) : v;
    }
    return out;
}

/**
 * The windows a client draws, in Codex's own order. One whose reset has passed is
 * left out, as Claude's are: its percentage describes a period that is over.
 */
function windowsOf(limits, at, now) {
    const out = [];
    for (const type of ['primary', 'secondary']) {
        const w = limits && limits[type];
        if (!w || num(w.usedPercent) === null) continue;
        const resetsAt = num(w.resetsAt);
        if (resetsAt !== null && resetsAt <= now) continue;
        const mins = num(w.windowDurationMins);
        out.push({
            type,
            ...windowLabel(mins),
            windowDurationMins: mins,
            usedPercent: w.usedPercent,
            usedPercentAt: at,
            resetsAt,
            status: w.usedPercent >= 100 ? 'rejected' : null,
        });
    }
    return out;
}

/** Ask a short-lived app-server who is signed in and what is left. */
async function askAppServer() {
    const { child, rpc } = spawnAppServer({ timeoutMs: TIMEOUT_MS });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, TIMEOUT_MS + 2000);
    killer.unref();
    try {
        await initialize(rpc);
        const { account } = await rpc.request('account/read', { refreshToken: false });
        if (account === null) return { account: null, limits: null, error: null };
        // An account with no usage windows (an API key) answers this with an
        // error. It is still signed in, so keep the two apart.
        try {
            const r = await rpc.request('account/rateLimits/read', {});
            return { account, limits: r.rateLimits || null, error: null };
        } catch (err) {
            return { account, limits: null, error: `Codex could not report its usage: ${err.message}` };
        }
    } finally {
        clearTimeout(killer);
        try { child.stdin.end(); } catch { /* closed */ }
        setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, 500).unref();
    }
}

class CodexQuota extends EventEmitter {
    /**
     * @param {object} [o]
     * @param {() => Promise<boolean>} o.installed  whether there is a `codex` to ask
     * @param {() => Promise<{account, limits, error}>} [o.ask]
     * @param {() => number} [o.now]  epoch ms
     */
    constructor({ installed, ask = askAppServer, now = Date.now } = {}) {
        super();
        this.installedOf = installed || (async () => true);
        this.ask = ask;
        this.now = now;
        this.installed = false;
        this.signedIn = null;      // null until Codex has answered once
        this.account = null;       // {type, planType}; never the email
        this.limits = null;        // the merged RateLimitSnapshot
        this.limitsAt = 0;         // epoch ms of the last read or push
        this.askedAt = 0;          // epoch ms of the last attempt
        this.error = null;
        this._inflight = null;
        this._said = '';
    }

    /** Ask Codex now. Resolves true when it answered. Never rejects. */
    refresh() {
        if (this._inflight) return this._inflight;
        this._inflight = (async () => {
            let ok = false;
            try {
                this.installed = !!(await this.installedOf());
                this.askedAt = this.now();
                if (!this.installed) return false;
                const r = await this.ask();
                this.error = r.error || null;
                this.signedIn = r.account !== null;
                this.account = r.account
                    ? { type: r.account.type || null, planType: r.account.planType || null } : null;
                if (!this.signedIn) {
                    this.limits = null;
                    this.limitsAt = 0;
                } else if (r.limits) {
                    // A read is the whole picture, so it replaces rather than merges.
                    this.limits = r.limits;
                    this.limitsAt = this.now();
                }
                ok = true;
            } catch (err) {
                this.error = `Codex could not be asked: ${err.message}`;
            } finally {
                this._changed();
            }
            return ok;
        })().finally(() => { this._inflight = null; });
        return this._inflight;
    }

    /** Ask only if neither a read nor a push has landed lately. */
    refreshIfStale(maxMs = STALE_MS) {
        const last = Math.max(this.askedAt, this.limitsAt);
        if (last && this.now() - last < maxMs && !this._windowEnded()) return Promise.resolve(false);
        return this.refresh();
    }

    /** `account/rateLimits/updated` from a live process. */
    notePush(update) {
        if (!update || typeof update !== 'object') return;
        // Other meters (a per-model alias) are not the account's windows.
        const base = (this.limits && this.limits.limitId) || 'codex';
        if (update.limitId && update.limitId !== base) return;
        this.installed = true;
        this.signedIn = true;
        this.limits = merge(this.limits, update);
        this.limitsAt = this.now();
        this._changed();
    }

    /** A window we are holding has reset since it was read. */
    _windowEnded() {
        const now = this.now() / 1000;
        return ['primary', 'secondary'].some((k) => {
            const w = this.limits && this.limits[k];
            return w && num(w.resetsAt) !== null && w.resetsAt <= now && this.limitsAt / 1000 < w.resetsAt;
        });
    }

    /**
     * What `GET /api/quota` carries as `runtimes.codex`, or null when there is no
     * Codex to speak of: not installed, or not heard from yet.
     */
    snapshot() {
        if (!this.installed || (this.signedIn === null && !this.error)) return null;
        const at = this.limitsAt ? Math.floor(this.limitsAt / 1000) : null;
        const l = this.limits;
        return {
            signedIn: this.signedIn,
            accountType: this.account ? this.account.type : null,
            planType: (l && l.planType) || (this.account && this.account.planType) || null,
            windows: windowsOf(l, at, this.now() / 1000),
            credits: l && l.credits ? {
                hasCredits: !!l.credits.hasCredits,
                unlimited: !!l.credits.unlimited,
                balance: l.credits.balance ?? null,
            } : null,
            limitReached: (l && l.rateLimitReachedType) || null,
            at,
            error: this.error,
        };
    }

    /** Emit `changed` when what a client would see moved, timestamps included. */
    _changed() {
        const text = JSON.stringify(this.snapshot());
        if (text === this._said) return;
        this._said = text;
        this.emit('changed');
    }
}

module.exports = { CodexQuota, windowLabel, windowsOf, merge, askAppServer, STALE_MS };
