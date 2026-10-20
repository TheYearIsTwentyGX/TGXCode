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
// Four decisions in here that are easy to get backwards:
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
//   * **`installed` and `cancelled` are final — except that `installed` is
//     always accepted.** A desktop cancel can cross a phone that had already
//     put the package on; refusing the phone's report would leave the record
//     saying something false about the phone. `failed` is not final: a retry
//     moves it on again, as long as the APK is still here to download.
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

/** Nothing will happen to these again, so the APK can go. */
const FINAL = new Set(['installed', 'cancelled']);

/** States a phone is still working through, for the expiry sweep. */
const OPEN = new Set(['pending', 'downloading', 'installing', 'needs_action']);

/** A trimmed string of at most `max` characters, or null. */
function text(v, max) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s ? s.slice(0, max) : null;
}

/** An error a route can answer with as it stands. */
function refuse(status, error) {
    return Object.assign(new Error(error), { status });
}

/**
 * The record as it goes on the wire and to disk.
 *
 * Spelled out rather than spread, so a status body cannot put a key into the
 * store, and so the claim stays off the wire — which phone holds a record is
 * the bridge's business, and the 409 is how a phone learns it is not this one.
 */
function publicRecord(r) {
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
                .map(r => ({ ...publicRecord(r), claimedBy: text(r.claimedBy, 128) }));
        } catch { return []; }
    }

    _write() {
        // Capped here rather than at create, so the sweep's own changes count too.
        // Oldest first: a record still pending is in the newest few by construction.
        if (this.rows.length > MAX_RECORDS) {
            for (const r of this.rows.splice(0, this.rows.length - MAX_RECORDS)) this._dropApk(r);
        }
        const installs = this.rows.map(r => ({ ...publicRecord(r), claimedBy: r.claimedBy }));
        writeAtomic(this.file, `${JSON.stringify({ version: VERSION, installs }, null, 2)}\n`);
    }

    _changed(r) {
        r.updatedAt = this.now();
        this._write();
        this.onChange(publicRecord(r));
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
        return r ? publicRecord(r) : null;
    }

    /** Newest first. */
    list(limit = LIST_LIMIT) {
        return this.rows.slice(-limit).reverse().map(publicRecord);
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
            claimedBy: null,
        };
        this.rows.push(r);
        this._changed(r);
        return publicRecord(r);
    }

    /**
     * What a phone reports. Returns `{record}`, or `{status, error}` for a
     * refusal a route answers as it stands.
     *
     * @param {string} id
     * @param {{state: string, message?: string, packageName?: string, versionName?: string}} body
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
        if (state === 'downloading') {
            if (!this.hasApk(id)) return { status: 409, error: 'the APK is no longer stored here' };
            if (r.claimedBy && who && r.claimedBy !== who) {
                return { status: 409, error: 'another phone is already installing this' };
            }
            r.claimedBy = who;
        }
        // A failure lets the next phone that tries have it.
        if (state === 'failed') r.claimedBy = null;

        r.state = state;
        r.message = text(body.message, 1000);
        // Kept when a later report leaves them out: the phone learns the package
        // name once it has the APK, and has no reason to repeat it.
        const pkg = text(body.packageName, 256);
        const ver = text(body.versionName, 128);
        if (pkg) r.packageName = pkg;
        if (ver) r.versionName = ver;
        if (FINAL.has(state)) this._dropApk(r);
        this._changed(r);
        return { record: publicRecord(r) };
    }

    /** Taken back at the desk. A finished install cannot be. */
    cancel(id, message = null) {
        const r = this.rows.find(x => x.id === id);
        if (!r) return { status: 404, error: 'no such install' };
        if (r.state === 'installed') return { status: 409, error: 'this install already finished' };
        if (r.state === 'cancelled') return { record: publicRecord(r) };
        r.state = 'cancelled';
        r.message = message;
        this._dropApk(r);
        this._changed(r);
        return { record: publicRecord(r) };
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
            if (OPEN.has(r.state) && r.state !== 'needs_action') {
                this.cancel(r.id, 'Expired: no phone installed it within 24 hours');
            } else {
                // `needs_action` keeps its state: the phone has the APK already and
                // can still report `installed` once somebody taps the button.
                this._dropApk(r);
            }
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
    }
}

module.exports = {
    PhoneInstalls, publicRecord, STATES, KEEP_APK_MS, MAX_RECORDS, LIST_LIMIT, DIR,
};
