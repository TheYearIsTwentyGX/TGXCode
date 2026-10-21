'use strict';

// APKs waiting to be installed on the user's phone, and what the phone said
// about each one.
//
// The problem this replaces: an agent that has built an Android app installs it
// with `adb install` over wireless debugging, and wireless debugging switches
// itself off — after a reboot, after a while on another network, whenever
// Android feels like it. The TGXCode app on the phone already holds an
// authenticated connection to this bridge from anywhere, so the bridge can hand
// it the APK instead and the phone installs it itself with PackageInstaller.
// Nothing on the phone has to be in developer mode.
//
// **A record is a queue entry, not a command.** The bridge never reaches the
// phone; it files a `pending` record, broadcasts it, and waits. Whichever
// phone client is connected — now, or the next time one connects — downloads
// the APK and reports back through the status route. So "nobody picked it up"
// is a normal outcome rather than an error, and the record outlives the agent
// that asked for it.
//
// Six decisions in here that are easy to get backwards:
//
//   * **The APK is copied, not referenced.** The path the agent names is a
//     Gradle output that the next build overwrites, possibly while a phone is
//     half-way through downloading it — and the sha256 the phone checks would
//     then describe a file that no longer exists. A copy under STATE_DIR is the
//     bytes that were asked for, for as long as anyone could want them.
//   * **The first `downloading` claims it.** Every connected phone hears the
//     same broadcast, and two phones installing the same build is at best
//     wasted bandwidth. The claim is keyed on the `X-TGXCode-Viewer` id a
//     client already sends; a client that sends none can neither claim nor be
//     refused, because there is nothing to tell it apart by. A `failed` record
//     releases its claim, so another phone may retry.
//   * **`installed` and `cancelled` are final to the phone — except that
//     `installed` is always accepted.** A desktop cancel can cross a phone that
//     had already put the package on; refusing the phone's report would leave
//     the record saying something false about the phone. `failed` is not final:
//     a retry moves it on again, as long as the APK is still here to download.
//     And the desk's Retry moves any of them but `installed` back to `pending`,
//     which is why a cancel keeps the APK (the download route still answers 410
//     for a cancelled record) until the 24h sweep takes it.
//   * **A claim that goes quiet is taken back.** A phone that claimed a record
//     and then lost its network, its process or its battery never says so, and
//     nothing else would ever move the record: it sat `downloading` until the
//     24h expiry. So a `downloading` or `installing` record reads `stalled`
//     after 90s without a report, and after 3 minutes the bridge releases it to
//     `pending`, where the next phone to connect picks it up. `attempts` counts
//     the claims, and the third claim to go quiet fails the record instead of
//     releasing it again — a phone that dies on this APK every time should say
//     so to a person rather than loop all day.
//   * **A progress report is a heartbeat, and heartbeats are throttled.** Every
//     report refreshes `updatedAt`, which is what keeps the claim alive, but a
//     phone reporting every chunk would otherwise rewrite the file and wake every
//     window many times a second. A `downloading` that repeats `downloading` is
//     written and broadcast at most once a second per record; the rest only
//     move the clock in memory.
//   * **The records file is per port.** STATE_DIR is shared by every bridge on
//     this machine, and a dev bridge has no business showing the phone's
//     installs or rewriting them. The APK files share one directory because
//     their ids never collide, and the sweep only removes an unowned file once
//     it is past the same 24 hours every owner would have removed it at.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { STATE_DIR, PORT } = require('./config');
const { writeAtomic } = require('./jsonfile');

const DIR = path.join(STATE_DIR, 'phone-installs');
const VERSION = 1;

/** An APK is gone 24h after it was filed, whatever state it reached. */
const KEEP_APK_MS = 24 * 60 * 60 * 1000;

/** How many records the file holds; the oldest go first. */
const MAX_RECORDS = 50;

/** How many `GET /api/phone-installs` returns. */
const LIST_LIMIT = 20;

/** Far past any real APK, and short of filling a disk by accident. */
const MAX_APK_BYTES = 1024 * 1024 * 1024;

const SWEEP_MS = 60 * 60 * 1000;

/** A claimed record with no report for this long reads `stalled`. */
const STALL_MS = 90 * 1000;

/** And for this long is released back to `pending`. */
const RELEASE_MS = 3 * 60 * 1000;

/** The claim that goes quiet on this attempt fails the record instead. */
const MAX_ATTEMPTS = 3;

/** How often a progress heartbeat is written and broadcast, per record. */
const HEARTBEAT_MS = 1000;

/** How often the stall check runs; well inside STALL_MS so a pill turns on time. */
const STALL_CHECK_MS = 15 * 1000;

const RELEASED_MESSAGE = 'Phone stopped responding; queued again';
const GAVE_UP_MESSAGE = `Phone stopped responding ${MAX_ATTEMPTS} times; giving up. Retry it from TGXCode`;

/**
 * pending      — filed, nobody has claimed it
 * downloading  — a phone is fetching the APK
 * installing   — the phone handed it to PackageInstaller
 * needs_action — Android is waiting on the person holding the phone
 * installed    — done
 * failed       — the phone gave up; `message` says why. A retry may follow
 * cancelled    — taken back at the desk, or expired before anyone installed it
 */
const STATES = ['pending', 'downloading', 'installing', 'needs_action', 'installed', 'failed', 'cancelled'];

/** What a client may report. `pending` is the bridge's to set. */
const CLIENT_STATES = new Set(STATES.filter(s => s !== 'pending'));

/** A phone is holding these, so silence from it means something. */
const CLAIMED = new Set(['downloading', 'installing']);

/** What the desk's Retry moves back to `pending`. */
const RETRYABLE = new Set(['downloading', 'installing', 'failed', 'needs_action', 'cancelled']);

/** States a phone is still working through, for the expiry sweep. */
const OPEN = new Set(['pending', 'downloading', 'installing', 'needs_action']);

/** A trimmed string of at most `max` characters, or null. */
function text(v, max) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s ? s.slice(0, max) : null;
}

/** `{bytes, total}` from a status body, or undefined when it is not one. */
function progressOf(v, size) {
    if (!v || typeof v !== 'object') return undefined;
    const bytes = Number(v.bytes);
    if (!Number.isFinite(bytes) || bytes < 0) return undefined;
    const given = v.total == null ? size : Number(v.total);
    const total = Number.isFinite(given) && given > 0 ? Math.round(given) : null;
    return { bytes: Math.round(total ? Math.min(bytes, total) : bytes), total };
}

/** A whole number from disk, or the fallback. */
function count(v, fallback) {
    return Number.isInteger(v) && v >= 0 ? v : fallback;
}

/** An error a route can answer with as it stands. */
function refuse(status, error) {
    return Object.assign(new Error(error), { status });
}

/**
 * The record as it goes on the wire.
 *
 * Spelled out rather than spread, so a status body cannot put a key into the
 * store, and so the claim stays off the wire — which phone holds a record is
 * the bridge's business, and the 409 is how a phone learns it is not this one.
 * `stalled` is worked out against `now` every time it is served and never
 * stored: it is a fact about the clock, not about the record.
 */
function publicRecord(r, now = Date.now()) {
    return {
        ...storedFields(r),
        stalled: CLAIMED.has(r.state) && now - r.updatedAt > STALL_MS,
    };
}

/** What goes to disk, beside the claim. */
function storedFields(r) {
    return {
        id: r.id,
        fileName: r.fileName,
        size: r.size,
        sha256: r.sha256,
        label: r.label,
        sessionId: r.sessionId,
        createdAt: r.createdAt,
        state: r.state,
        message: r.message,
        packageName: r.packageName,
        versionName: r.versionName,
        updatedAt: r.updatedAt,
        progress: r.progress || null,
        attempts: r.attempts || 0,
    };
}

function sha256Of(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file)
            .on('data', (c) => h.update(c))
            .on('end', () => resolve(h.digest('hex')))
            .on('error', reject);
    });
}

/** The first four bytes of a zip's first local file header. */
function isZip(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const head = Buffer.alloc(4);
        const n = fs.readSync(fd, head, 0, 4, 0);
        return n === 4 && head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    } finally { fs.closeSync(fd); }
}

class PhoneInstalls {
    /**
     * @param {{dir?: string, port?: number, now?: () => number,
     *   onChange?: (record: object) => void}} [opts]
     */
    constructor({ dir = DIR, port = PORT, now = Date.now, onChange = () => {} } = {}) {
        this.dir = dir;
        this.file = path.join(dir, `installs-${port}.json`);
        this.now = now;
        this.onChange = onChange;
        this.timer = null;
        this.stallTimer = null;
        /** id → when its last heartbeat was written and broadcast */
        this.beats = new Map();
        /** ids whose `stalled: true` has been broadcast since their last change */
        this.announced = new Set();
        /** @type {Array<object>} oldest first, as filed */
        this.rows = this._read();
    }

    _read() {
        let raw;
        try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
        try {
            const data = JSON.parse(raw.replace(/^﻿/, ''));
            if (data.version !== VERSION || !Array.isArray(data.installs)) return [];
            return data.installs
                .filter(r => r && typeof r.id === 'string' && STATES.includes(r.state))
                .map(r => ({
                    ...storedFields(r),
                    progress: r.state === 'downloading' ? progressOf(r.progress, r.size) || null : null,
                    // Records from before attempts were counted: one claim if it is claimed now.
                    attempts: count(r.attempts, CLAIMED.has(r.state) ? 1 : 0),
                    claimedBy: text(r.claimedBy, 128),
                }));
        } catch { return []; }
    }

    _write() {
        // Capped here rather than at create, so the sweep's own changes count too.
        // Oldest first: a record still pending is in the newest few by construction.
        if (this.rows.length > MAX_RECORDS) {
            for (const r of this.rows.splice(0, this.rows.length - MAX_RECORDS)) this._dropApk(r);
        }
        const installs = this.rows.map(r => ({ ...storedFields(r), claimedBy: r.claimedBy }));
        writeAtomic(this.file, `${JSON.stringify({ version: VERSION, installs }, null, 2)}\n`);
    }

    _pub(r) {
        return publicRecord(r, this.now());
    }

    _changed(r) {
        r.updatedAt = this.now();
        this.beats.set(r.id, r.updatedAt);
        this.announced.delete(r.id);
        this._write();
        this.onChange(this._pub(r));
    }

    apkPath(id) {
        return path.join(this.dir, `${id}.apk`);
    }

    _dropApk(r) {
        try { fs.unlinkSync(this.apkPath(r.id)); } catch { /* already gone */ }
    }

    /** Is the APK for this record still on disk to be downloaded? */
    hasApk(id) {
        try { return fs.statSync(this.apkPath(id)).isFile(); } catch { return false; }
    }

    get(id) {
        const r = this.rows.find(x => x.id === id);
        return r ? this._pub(r) : null;
    }

    /** Newest first. */
    list(limit = LIST_LIMIT) {
        return this.rows.slice(-limit).reverse().map(r => this._pub(r));
    }

    /**
     * File an APK for the phone. Throws an error carrying `status` when the file
     * is not one a phone could install.
     *
     * @param {{path: string, label?: string, sessionId?: string}} body
     */
    async create(body) {
        body = body && typeof body === 'object' ? body : {};
        const src = typeof body.path === 'string' ? body.path : '';
        if (!src || !path.isAbsolute(src)) {
            throw refuse(400, 'path is required, as an absolute path to an .apk on this machine');
        }
        if (!/\.apk$/i.test(src)) throw refuse(400, `${src} does not end in .apk`);
        let st;
        try { st = fs.statSync(src); } catch { throw refuse(404, `no file at ${src}`); }
        if (!st.isFile()) throw refuse(400, `${src} is not a file`);
        if (st.size > MAX_APK_BYTES) throw refuse(413, `${src} is larger than 1GB`);
        if (!isZip(src)) {
            throw refuse(400, `${src} is not a zip, so it is not an APK — was the build interrupted?`);
        }

        const id = crypto.randomUUID();
        const dest = this.apkPath(id);
        fs.mkdirSync(this.dir, { recursive: true });
        // Copied before it is hashed, and the copy is what is hashed: the source
        // can be rewritten by the next build at any moment, and the sha256 has to
        // describe the bytes the phone will actually be served.
        await fs.promises.copyFile(src, dest);
        let sha256;
        try { sha256 = await sha256Of(dest); } catch (err) {
            try { fs.unlinkSync(dest); } catch { /* nothing to undo */ }
            throw err;
        }

        const t = this.now();
        const r = {
            id,
            fileName: path.basename(src),
            size: fs.statSync(dest).size,
            sha256,
            label: text(body.label, 200) || path.basename(src),
            sessionId: text(body.sessionId, 128),
            createdAt: t,
            state: 'pending',
            message: null,
            packageName: null,
            versionName: null,
            updatedAt: t,
            progress: null,
            attempts: 0,
            claimedBy: null,
        };
        this.rows.push(r);
        this._changed(r);
        return this._pub(r);
    }

    /**
     * What a phone reports. Returns `{record}`, or `{status, error}` for a
     * refusal a route answers as it stands.
     *
     * A `downloading` onto a record already `downloading` is a heartbeat: it
     * always refreshes `updatedAt`, but is written and broadcast at most once
     * per HEARTBEAT_MS.
     *
     * @param {string} id
     * @param {{state: string, message?: string, packageName?: string,
     *   versionName?: string, progress?: {bytes: number, total?: number}}} body
     * @param {string|null} viewer the caller's `X-TGXCode-Viewer`, if it sent one
     */
    setStatus(id, body, viewer = null) {
        const r = this.rows.find(x => x.id === id);
        if (!r) return { status: 404, error: 'no such install' };
        const state = body && body.state;
        if (!CLIENT_STATES.has(state)) {
            return { status: 400, error: `state must be one of ${[...CLIENT_STATES].join(', ')}` };
        }
        const who = text(viewer, 128);

        if (r.state === 'installed' && state !== 'installed') {
            return { status: 409, error: 'this install already finished' };
        }
        if (r.state === 'cancelled' && state !== 'installed' && state !== 'cancelled') {
            return { status: 409, error: 'this install was cancelled' };
        }
        let progress = null;
        if (state === 'downloading') {
            if (!this.hasApk(id)) return { status: 409, error: 'the APK is no longer stored here' };
            if (r.claimedBy && who && r.claimedBy !== who) {
                return { status: 409, error: 'another phone is already installing this' };
            }
            if (body.progress != null) {
                progress = progressOf(body.progress, r.size);
                if (!progress) return { status: 400, error: 'progress must be {bytes: number, total?: number}' };
            }
            // A viewer-less heartbeat must not drop the claim it cannot make.
            if (who) r.claimedBy = who;
        }
        // A failure lets the next phone that tries have it.
        if (state === 'failed') r.claimedBy = null;

        const beat = state === 'downloading' && r.state === 'downloading';
        if (state === 'downloading' && !beat) r.attempts = (r.attempts || 0) + 1;
        const message = text(body.message, 1000);
        if (beat) {
            // A bare heartbeat keeps what the last report said, and the bar where
            // it was: neither has been contradicted.
            if (progress) r.progress = progress;
            if (message) r.message = message;
            r.updatedAt = this.now();
            if (r.updatedAt - (this.beats.get(id) || 0) < HEARTBEAT_MS) return { record: this._pub(r) };
            this._changed(r);
            return { record: this._pub(r) };
        }

        r.state = state;
        r.message = message;
        r.progress = progress;
        // Kept when a later report leaves them out: the phone learns the package
        // name once it has the APK, and has no reason to repeat it.
        const pkg = text(body.packageName, 256);
        const ver = text(body.versionName, 128);
        if (pkg) r.packageName = pkg;
        if (ver) r.versionName = ver;
        // Nothing will happen to an installed record again, so the APK can go.
        // A cancelled one keeps it until the sweep, for the desk's Retry.
        if (state === 'installed') this._dropApk(r);
        this._changed(r);
        return { record: this._pub(r) };
    }

    /**
     * Taken back at the desk. A finished install cannot be. The APK stays until
     * the sweep, so Retry can undo this; the download route refuses it meanwhile.
     */
    cancel(id, message = null) {
        const r = this.rows.find(x => x.id === id);
        if (!r) return { status: 404, error: 'no such install' };
        if (r.state === 'installed') return { status: 409, error: 'this install already finished' };
        if (r.state === 'cancelled') return { record: this._pub(r) };
        r.state = 'cancelled';
        r.message = message;
        r.progress = null;
        r.claimedBy = null;
        this._changed(r);
        return { record: this._pub(r) };
    }

    /**
     * Put it back in the queue, from the desk or the phone: `pending`, no claim,
     * no progress, and a fresh budget of attempts. A pending record is a no-op.
     */
    retry(id) {
        const r = this.rows.find(x => x.id === id);
        if (!r) return { status: 404, error: 'no such install' };
        if (r.state === 'installed') return { status: 409, error: 'this install already finished' };
        if (!this.hasApk(id)) {
            return { status: 410, error: 'the APK is no longer stored here; build it and install it again' };
        }
        if (r.state === 'pending') return { record: this._pub(r) };
        if (!RETRYABLE.has(r.state)) return { status: 409, error: `cannot retry a ${r.state} install` };
        this._release(r, null);
        r.attempts = 0;
        this._changed(r);
        return { record: this._pub(r) };
    }

    _release(r, message) {
        r.state = 'pending';
        r.claimedBy = null;
        r.progress = null;
        r.message = message;
    }

    /**
     * The claims that went quiet. Past STALL_MS a record is broadcast once with
     * `stalled: true`, so a client that draws it need not run its own clock;
     * past RELEASE_MS it goes back to `pending`, or to `failed` on its last
     * attempt.
     */
    checkStalls() {
        const t = this.now();
        for (const r of this.rows) {
            if (!CLAIMED.has(r.state)) continue;
            const quiet = t - r.updatedAt;
            if (quiet >= RELEASE_MS) {
                if ((r.attempts || 0) >= MAX_ATTEMPTS) {
                    r.state = 'failed';
                    r.claimedBy = null;
                    r.progress = null;
                    r.message = GAVE_UP_MESSAGE;
                } else {
                    this._release(r, RELEASED_MESSAGE);
                }
                this._changed(r);
            } else if (quiet > STALL_MS && !this.announced.has(r.id)) {
                this.announced.add(r.id);
                this.onChange(this._pub(r));
            }
        }
    }

    /**
     * Retention: an APK goes 24h after it was filed, and a record nobody
     * finished by then is cancelled, since there is nothing left to download.
     * Then any file in the directory past the same age that no record here owns
     * — another bridge's, or a crash's.
     */
    sweep() {
        const t = this.now();
        for (const r of this.rows) {
            if (t - r.createdAt < KEEP_APK_MS) continue;
            // `needs_action` keeps its state: the phone has the APK already and
            // can still report `installed` once somebody taps the button.
            if (OPEN.has(r.state) && r.state !== 'needs_action') {
                this.cancel(r.id, 'Expired: no phone installed it within 24 hours');
            }
            this._dropApk(r);
        }
        let names = [];
        try { names = fs.readdirSync(this.dir); } catch { return; }
        const mine = new Set(this.rows.map(r => `${r.id}.apk`));
        for (const name of names) {
            // A record's own file goes by its createdAt, above.
            if (!name.endsWith('.apk') || mine.has(name)) continue;
            const file = path.join(this.dir, name);
            try {
                if (t - fs.statSync(file).mtimeMs >= KEEP_APK_MS) fs.unlinkSync(file);
            } catch { /* raced another bridge's sweep */ }
        }
    }

    start() {
        if (this.timer) return;
        this.sweep();
        this.timer = setInterval(() => {
            try { this.sweep(); } catch (err) {
                console.error(`[tgxcode] phone install sweep failed: ${err.message}`);
            }
        }, SWEEP_MS);
        this.timer.unref();
        this.stallTimer = setInterval(() => {
            try { this.checkStalls(); } catch (err) {
                console.error(`[tgxcode] phone install stall check failed: ${err.message}`);
            }
        }, STALL_CHECK_MS);
        this.stallTimer.unref();
    }
}

module.exports = {
    PhoneInstalls, publicRecord, STATES, KEEP_APK_MS, MAX_RECORDS, LIST_LIMIT, DIR,
    STALL_MS, RELEASE_MS, MAX_ATTEMPTS, HEARTBEAT_MS,
};
