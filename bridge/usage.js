'use strict';

// How much of the quota is gone, and when it comes back.
//
// On a subscription plan dollars are the wrong unit — `costUsd` in the
// transcripts is literally 0. The question is how much of the 5-hour window is
// left and how much of the week. Two sources answer it, and neither answers it
// alone:
//
//   **The stream.** Every turn the bridge runs emits `rate_limit_event`, and
//   bridge/runner.js forwards the whole `rate_limit_info` here. It carries
//   `status`, `resetsAt`, `rateLimitType` and the overage fields on every
//   event — but `utilization` only on the `allowed_warning` path. While you are
//   comfortably inside a window the CLI sends no percentage at all, so the
//   stream can say *whether* you are limited and never how close you are.
//
//   **The status line.** scripts/quota-statusline.py harvests
//   `rate_limits.{five_hour,seven_day}.used_percentage` out of the status line
//   payload and drops it in STATE_DIR. That is an exact number for both
//   windows — but the status line is an Ink component, so it renders only in an
//   interactive TUI. Nothing the bridge spawns produces one.
//
// So: the status line gives the number, the stream keeps status and reset times
// live when no terminal is open. **The number goes stale by design** — if all
// the work goes through this app, no TUI runs and the percentage freezes while
// the stream carries on reporting status correctly. Every reading therefore
// carries the moment it was taken, and the UI is expected to show the age
// rather than present an old number as current. A confidently stale percentage
// is worse than no percentage.
//
// ## Units
//
// This is the one place that knows the scale, because it is the one thing most
// likely to be got wrong. The `anthropic-ratelimit-unified-*` headers carry a
// **0–1 fraction**. The status line multiplies by 100 before publishing, so
// `used_percentage` is **0–100**. The stream's `utilization` is the raw
// fraction and is **not** multiplied. Everything leaving this module is 0–100.
//
// ## Window ids
//
// Keyed by whatever `rateLimitType` arrives, never by a hardcoded `five_hour`.
// The CLI's enum today is five_hour, seven_day, seven_day_opus,
// seven_day_sonnet, seven_day_overage_included and overage; a window added
// later shows up on its own, labelled with its raw id, with no change here.

const fs = require('fs');
const path = require('path');

const { STATE_DIR } = require('./config');

// Written by scripts/quota-statusline.py. We only ever read it — see the note
// on concurrent bridges below, and note that this one has a writer outside the
// app entirely.
const STATUSLINE_FILE = path.join(STATE_DIR, 'quota-statusline.json');

// Our own view, persisted so a bridge restart does not blank the pill.
const STATE_FILE = path.join(STATE_DIR, 'quota.json');

const VERSION = 1;

// How many status changes to keep for the panel. A change, not an event: the
// stream re-sends the same `allowed` on every turn, and a list of those is not
// a history of anything.
const MAX_EVENTS = 50;

const LABELS = {
    five_hour: { label: '5-hour', short: '5h' },
    seven_day: { label: '7-day', short: '7d' },
    seven_day_opus: { label: '7-day (Opus)', short: '7d opus' },
    seven_day_sonnet: { label: '7-day (Sonnet)', short: '7d sonnet' },
    seven_day_overage_included: { label: '7-day (incl. overage)', short: '7d+' },
    overage: { label: 'Overage', short: 'over' },
};

// The order the UI lists windows in. Anything unknown sorts after these, by id,
// so a new window is visible rather than lost.
const ORDER = Object.keys(LABELS);

function labelFor(type) {
    return (LABELS[type] && LABELS[type].label) || type;
}

function shortLabelFor(type) {
    return (LABELS[type] && LABELS[type].short) || type;
}

function orderOf(type) {
    const i = ORDER.indexOf(type);
    return i === -1 ? ORDER.length : i;
}

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

function isNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

/** A percentage we are willing to show: a real number, clamped to 0–100. */
function clampPercent(v) {
    if (!isNumber(v)) return null;
    return Math.min(100, Math.max(0, v));
}

/**
 * The stream's `utilization` is the raw header fraction, 0–1. The status line
 * has already multiplied. Both arrive here; only one needs scaling, and this is
 * the only place either is touched.
 */
function fractionToPercent(v) {
    if (!isNumber(v)) return null;
    return clampPercent(v * 100);
}

function unixOrNull(v) {
    return isNumber(v) ? Math.round(v) : null;
}


class Usage {
    constructor() {
        // rateLimitType -> what the stream last said about it
        this.stream = Object.create(null);
        // Status changes, newest last.
        this.events = [];
        // Cached parse of STATUSLINE_FILE, keyed by (size, mtime).
        this._slCache = { key: null, value: null };
        // When a beacon last ran on this machine, unix seconds, or null. Here
        // rather than in bridge/server.js because it has to survive a restart
        // and be shared between bridges — see `beaconRanAt()`.
        this.beaconAt = null;
        this._saveTimer = null;
        this.load();
    }

    // -- the beacon's clock -----------------------------------------------

    /**
     * When a beacon last ran, according to any bridge on this machine.
     *
     * The interval lived in a module-level `beaconLastRunAt = 0`, which meant
     * every bridge start fired a run immediately. That is a wasted API call per
     * restart, and — while the beacon could still orphan itself — a fresh
     * chance to leak one on every restart. An agent restarting a dev bridge six
     * times in thirteen minutes is how four orphans happened at once.
     */
    beaconRanAt() { return this.beaconAt; }

    noteBeaconRun(at) {
        if (!isNumber(at)) return;
        if (isNumber(this.beaconAt) && at <= this.beaconAt) return;
        this.beaconAt = at;
        this.save();
    }

    // -- the stream -------------------------------------------------------

    /**
     * One `rate_limit_info` off the wire. Returns true when this changed
     * anything worth telling a client about, so the caller can skip a
     * broadcast for the identical event that arrives every turn.
     */
    noteRateLimitEvent(info) {
        if (!info || typeof info !== 'object') return false;
        if (typeof info.status !== 'string') return false;

        // `rateLimitType` is optional on the wire — the CLI omits it when the
        // response carried no representative claim. An event we cannot file
        // under a window is still worth keeping as a status signal, so it goes
        // under a name of its own rather than being dropped or, worse, guessed
        // to be the 5-hour one.
        const type = typeof info.rateLimitType === 'string' && info.rateLimitType
            ? info.rateLimitType
            : 'unspecified';

        const seenAt = nowSeconds();
        const next = {
            status: info.status,
            resetsAt: unixOrNull(info.resetsAt),
            // 0–1 on the wire. Present only when the CLI decided you are near a
            // limit; null the rest of the time, which is most of the time.
            usedPercent: fractionToPercent(info.utilization),
            isUsingOverage: info.isUsingOverage === true,
            overageStatus: typeof info.overageStatus === 'string' ? info.overageStatus : null,
            overageResetsAt: unixOrNull(info.overageResetsAt),
            overageDisabledReason: typeof info.overageDisabledReason === 'string'
                ? info.overageDisabledReason : null,
            surpassedThreshold: isNumber(info.surpassedThreshold) ? info.surpassedThreshold : null,
            seenAt,
        };

        const prev = this.stream[type];
        this.stream[type] = next;

        // A change, or a first sighting that is already bad. Without the second
        // half, a bridge that starts up mid-warning records nothing and the
        // panel claims a clean history for a window that is nearly spent.
        if (prev ? prev.status !== next.status : next.status !== 'allowed') {
            this.events.push({
                type, label: labelFor(type),
                from: prev ? prev.status : null, to: next.status,
                usedPercent: next.usedPercent,
                at: seenAt,
            });
            if (this.events.length > MAX_EVENTS) {
                this.events.splice(0, this.events.length - MAX_EVENTS);
            }
        }

        const changed = !prev
            || prev.status !== next.status
            || prev.resetsAt !== next.resetsAt
            || prev.usedPercent !== next.usedPercent
            || prev.isUsingOverage !== next.isUsingOverage
            || prev.overageStatus !== next.overageStatus;

        if (changed) this.save();
        return changed;
    }

    // -- the status line --------------------------------------------------

    /**
     * What scripts/quota-statusline.py last harvested, or null.
     *
     * Cached by (size, mtime) in the same style as scanMeta in transcript.js:
     * the pill re-renders often and this file changes rarely.
     */
    readStatusLine() {
        let st;
        try {
            st = fs.statSync(STATUSLINE_FILE);
        } catch {
            this._slCache = { key: null, value: null };
            return null;
        }

        const key = `${st.size}:${st.mtimeMs}`;
        if (this._slCache.key === key) return this._slCache.value;

        let value = null;
        try {
            const data = JSON.parse(fs.readFileSync(STATUSLINE_FILE, 'utf8'));
            if (data && data.version === VERSION && data.windows && typeof data.windows === 'object') {
                const windows = Object.create(null);
                for (const [type, win] of Object.entries(data.windows)) {
                    if (!win || typeof win !== 'object') continue;
                    // Already 0–100 — the harvester publishes what the status
                    // line publishes, and the status line has multiplied.
                    const pct = clampPercent(win.used_percentage);
                    if (pct === null) continue;
                    windows[type] = { usedPercent: pct, resetsAt: unixOrNull(win.resets_at) };
                }
                value = {
                    windows,
                    capturedAt: unixOrNull(data.capturedAt),
                };
            }
        } catch {
            // A torn or hand-edited file. The harvester writes via rename so a
            // tear should be impossible, but a bad file must not take the pill
            // down with it.
            value = null;
        }

        this._slCache = { key, value };
        return value;
    }

    // -- the merged view --------------------------------------------------

    /**
     * Everything a client needs to draw the pill and the panel.
     *
     * The two sources are merged field by field rather than one winning
     * outright, because they carry different things: only the status line has a
     * percentage while you are comfortably inside a window, and only the stream
     * has `status` and the overage fields at all. Where both have a reading —
     * the percentage near a limit, and `resetsAt` always — the newer one wins.
     */
    snapshot() {
        const sl = this.readStatusLine();
        const now = nowSeconds();

        const types = new Set([
            ...Object.keys(this.stream),
            ...(sl ? Object.keys(sl.windows) : []),
        ]);

        const windows = [];
        for (const type of types) {
            const s = this.stream[type] || null;
            const l = (sl && sl.windows[type]) || null;
            const lAt = sl ? sl.capturedAt : null;

            let usedPercent = null;
            let usedPercentAt = null;
            let usedPercentSource = null;

            if (l && s && s.usedPercent !== null) {
                // Both have a number. Near a limit the stream is the fresher of
                // the two — it arrives on the turn, where the status line only
                // updates while a terminal happens to be open.
                const streamNewer = !isNumber(lAt) || s.seenAt >= lAt;
                usedPercent = streamNewer ? s.usedPercent : l.usedPercent;
                usedPercentAt = streamNewer ? s.seenAt : lAt;
                usedPercentSource = streamNewer ? 'stream' : 'statusline';
            } else if (l) {
                usedPercent = l.usedPercent;
                usedPercentAt = lAt;
                usedPercentSource = 'statusline';
            } else if (s && s.usedPercent !== null) {
                usedPercent = s.usedPercent;
                usedPercentAt = s.seenAt;
                usedPercentSource = 'stream';
            }

            // `resetsAt` is the same clock from either source, so the newer
            // observation wins outright.
            let resetsAt = null;
            if (s && s.resetsAt !== null && l && l.resetsAt !== null) {
                resetsAt = (!isNumber(lAt) || s.seenAt >= lAt) ? s.resetsAt : l.resetsAt;
            } else if (s && s.resetsAt !== null) {
                resetsAt = s.resetsAt;
            } else if (l) {
                resetsAt = l.resetsAt;
            }

            windows.push({
                type,
                label: labelFor(type),
                shortLabel: shortLabelFor(type),
                usedPercent,
                usedPercentAt,
                usedPercentSource,
                resetsAt,
                // Stream-only, all of it. Null means "never observed", which is
                // not the same as "allowed" and must not be rendered as it.
                status: s ? s.status : null,
                statusAt: s ? s.seenAt : null,
                isUsingOverage: s ? s.isUsingOverage : false,
                overageStatus: s ? s.overageStatus : null,
                overageResetsAt: s ? s.overageResetsAt : null,
                overageDisabledReason: s ? s.overageDisabledReason : null,
                surpassedThreshold: s ? s.surpassedThreshold : null,
            });
        }

        windows.sort((a, b) => orderOf(a.type) - orderOf(b.type) || a.type.localeCompare(b.type));

        return {
            version: VERSION,
            // Server time, so a client on another device can work out the age of
            // a reading without trusting its own clock.
            now,
            windows,
            events: this.events.slice().reverse(),
            // Whether the harvester is installed and running, which is what the
            // panel needs to tell the difference between "no quota data yet"
            // and "you never set this up".
            statusLine: {
                present: !!sl,
                capturedAt: sl ? sl.capturedAt : null,
                path: STATUSLINE_FILE,
            },
        };
    }

    // -- persistence ------------------------------------------------------

    load() {
        let raw;
        try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch { return; }
        try {
            const data = JSON.parse(raw.replace(/^﻿/, ''));
            if (data.version !== VERSION) return;
            if (data.stream && typeof data.stream === 'object') {
                for (const [type, win] of Object.entries(data.stream)) {
                    if (win && typeof win === 'object' && typeof win.status === 'string') {
                        this.stream[type] = win;
                    }
                }
            }
            if (Array.isArray(data.events)) this.events = data.events.slice(-MAX_EVENTS);
            // Added after the first version of this file shipped. Absent is
            // null, which is why it did not need a version bump — bumping
            // would have thrown away everybody's stream state to gain nothing.
            if (isNumber(data.beaconAt)) this.beaconAt = data.beaconAt;
        } catch {
            // Corrupt state costs us the pill until the next turn, and nothing
            // else. Not worth failing a bridge start over.
        }
    }

    save() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._writeNow();
        }, 1000);
        if (this._saveTimer.unref) this._saveTimer.unref();
    }

    /**
     * Merge with whatever is on disk before writing.
     *
     * STATE_DIR is shared by every bridge on the machine — the everyday one and
     * however many dev ones are up — and they are all watching the same
     * account. Last-writer-wins would have them stamping on each other's
     * observations and flapping the pill. Taking the newer reading per window
     * instead makes concurrent bridges cooperative, and costs one small read.
     */
    _writeNow() {
        let onDisk = null;
        try {
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (data && data.version === VERSION) onDisk = data;
        } catch { /* no file, or one we cannot use */ }

        const stream = Object.create(null);
        if (onDisk && onDisk.stream && typeof onDisk.stream === 'object') {
            for (const [type, win] of Object.entries(onDisk.stream)) {
                if (win && typeof win === 'object' && isNumber(win.seenAt)) stream[type] = win;
            }
        }
        for (const [type, win] of Object.entries(this.stream)) {
            const other = stream[type];
            if (!other || !isNumber(other.seenAt) || win.seenAt >= other.seenAt) stream[type] = win;
        }

        const events = (onDisk && Array.isArray(onDisk.events) ? onDisk.events : [])
            .concat(this.events)
            .filter((e, i, all) => all.findIndex(o => o.at === e.at && o.type === e.type) === i)
            .sort((a, b) => a.at - b.at)
            .slice(-MAX_EVENTS);

        // Max-wins, for the same reason the stream merge above is newest-wins:
        // the point of persisting it is that a bridge restart does not re-fire
        // a beacon the interval says is not due, and the *latest* run on this
        // machine is what the interval is measured from — whichever bridge did
        // it.
        let beaconAt = this.beaconAt;
        if (onDisk && isNumber(onDisk.beaconAt)
            && (!isNumber(beaconAt) || onDisk.beaconAt > beaconAt)) {
            beaconAt = onDisk.beaconAt;
        }

        const body = JSON.stringify({ version: VERSION, stream, events, beaconAt });
        try {
            fs.mkdirSync(STATE_DIR, { recursive: true });
            const tmp = `${STATE_FILE}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, body);
            fs.renameSync(tmp, STATE_FILE);
        } catch (err) {
            // Losing this costs the pill its head start after a restart. The
            // stream refills it on the next turn.
        }
    }
}

module.exports = {
    Usage,
    // Exported for test/usage.test.js — the unit conversion is the part of this
    // module worth pinning down, and it is worth pinning down in isolation.
    fractionToPercent, clampPercent, labelFor, shortLabelFor,
    STATUSLINE_FILE, STATE_FILE, VERSION,
};
