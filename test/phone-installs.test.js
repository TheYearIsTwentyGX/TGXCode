'use strict';

// Phone installs (bridge/phone-installs.js and its routes), with no bridge.
//
// The routes are driven over real HTTP, but through a server this file builds
// around the route module alone — the gate in server.js is what refusals.test.js
// covers, and what is worth pinning here is the contract a phone codes against:
// the record's shape, the state machine, the claim, the download's headers, and
// when the APK goes.
//
// **XDG_DATA_HOME is set before the require**, for the reason later.test.js
// gives: config.js reads it once, at load, and the store would otherwise write
// into the user's real ~/.local/share/tgxcode.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-phone-'));
process.env.XDG_DATA_HOME = home;

const {
    PhoneInstalls, DIR, KEEP_APK_MS, MAX_RECORDS, LIST_LIMIT, STALL_MS, RELEASE_MS, MAX_ATTEMPTS,
    HEARTBEAT_MS,
} = require('../bridge/phone-installs');
const routes = require('../bridge/routes/phone-installs');
const { NEXT } = require('../bridge/http');

assert.ok(DIR.startsWith(home), `refusing to run: DIR is ${DIR}, outside the throwaway ${home}`);

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const FIELDS = ['attempts', 'createdAt', 'fileName', 'id', 'label', 'message', 'packageName',
    'progress', 'sessionId', 'sha256', 'size', 'stalled', 'state', 'updatedAt', 'versionName'].sort();

// An APK is a zip; the store checks the local-file-header magic and nothing more.
const src = path.join(home, 'build', 'app-debug.apk');
fs.mkdirSync(path.dirname(src), { recursive: true });
const BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(5000)]);
fs.writeFileSync(src, BYTES);
const SHA = crypto.createHash('sha256').update(BYTES).digest('hex');

// Real-looking epoch ms, because the sweep compares it with files' mtimes.
let clock = Date.now();
const events = [];
function fresh(port = 1) {
    fs.rmSync(DIR, { recursive: true, force: true });
    events.length = 0;
    return new PhoneInstalls({ port, now: () => clock, onChange: (r) => events.push(r) });
}

function call(port, method, p, { body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = http.request({
            host: '127.0.0.1', port, path: p, method,
            headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        }, (res) => {
            const c = [];
            res.on('data', (x) => c.push(x));
            res.on('end', () => {
                const buf = Buffer.concat(c);
                let json = null;
                try { json = JSON.parse(buf.toString('utf8')); } catch { /* the APK */ }
                resolve({ status: res.statusCode, headers: res.headers, buf, body: json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

(async () => {
    // --- create ------------------------------------------------------------

    {
        const s = fresh();
        const refusals = [
            [{}, 400], [{ path: 'build/app.apk' }, 400], [{ path: path.join(home, 'x.txt') }, 400],
            [{ path: path.join(home, 'missing.apk') }, 404], [{ path: home + '/build/' }, 400],
        ];
        const notZip = path.join(home, 'half.apk');
        fs.writeFileSync(notZip, 'not a zip');
        refusals.push([{ path: notZip }, 400]);
        for (const [body, status] of refusals) {
            await assert.rejects(s.create(body), (e) => e.status === status, JSON.stringify(body));
        }
        assert.strictEqual(s.list().length, 0, 'nothing filed for a refusal');
        ok('create refuses a relative path, a non-.apk, a missing file and a non-zip');

        const r = await s.create({ path: src, label: '  Notes — debug  ', sessionId: 'sess-1', evil: 1 });
        assert.deepStrictEqual(Object.keys(r).sort(), FIELDS, 'the record is the contract, no more');
        assert.strictEqual(r.state, 'pending');
        assert.strictEqual(r.fileName, 'app-debug.apk');
        assert.strictEqual(r.label, 'Notes — debug');
        assert.strictEqual(r.sessionId, 'sess-1');
        assert.strictEqual(r.size, BYTES.length);
        assert.strictEqual(r.sha256, SHA);
        assert.strictEqual(r.createdAt, clock);
        assert.strictEqual(r.progress, null);
        assert.strictEqual(r.stalled, false);
        assert.strictEqual(r.attempts, 0);
        assert.deepStrictEqual(events, [r], 'create is broadcast with the whole record');
        assert.ok(s.hasApk(r.id));
        // The copy is what is served: a rebuild that rewrites the source must not
        // change what the phone downloads, or the sha256 it checks.
        fs.writeFileSync(src + '.tmp', 'x');
        assert.deepStrictEqual(fs.readFileSync(s.apkPath(r.id)), BYTES);
        const bare = await s.create({ path: src });
        assert.strictEqual(bare.label, 'app-debug.apk', 'the label defaults to the file name');
        assert.strictEqual(bare.sessionId, null);
        ok('create copies the APK, hashes the copy, and broadcasts the record');
    }

    // --- the state machine --------------------------------------------------

    {
        const s = fresh();
        const r = await s.create({ path: src });
        clock += 1000;

        assert.strictEqual(s.setStatus(r.id, { state: 'pending' }).status, 400, 'pending is the bridge\'s');
        assert.strictEqual(s.setStatus(r.id, { state: 'bogus' }).status, 400);
        assert.strictEqual(s.setStatus('nope', { state: 'downloading' }).status, 404);

        let out = s.setStatus(r.id, { state: 'downloading' }, 'phone-a');
        assert.strictEqual(out.record.state, 'downloading');
        assert.strictEqual(out.record.updatedAt, clock);
        // The claim: a second phone is refused, the same phone is not, and a
        // client with no viewer id can neither claim nor be refused.
        assert.strictEqual(s.setStatus(r.id, { state: 'downloading' }, 'phone-b').status, 409);
        assert.ok(s.setStatus(r.id, { state: 'downloading' }, 'phone-a').record);
        assert.ok(s.setStatus(r.id, { state: 'downloading' }, null).record);
        ok('the first downloading claims it, and another phone gets 409');

        out = s.setStatus(r.id, { state: 'installing', packageName: 'com.example.notes',
            versionName: '1.2', message: 'handed to PackageInstaller' });
        assert.strictEqual(out.record.packageName, 'com.example.notes');
        out = s.setStatus(r.id, { state: 'needs_action', message: 'Tap Install' });
        assert.strictEqual(out.record.packageName, 'com.example.notes', 'kept when not repeated');
        assert.strictEqual(out.record.message, 'Tap Install');
        out = s.setStatus(r.id, { state: 'failed', message: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' });
        assert.strictEqual(out.record.state, 'failed');
        assert.ok(s.hasApk(r.id), 'failed keeps the APK for a retry');
        // A failure releases the claim, so the other phone may try.
        assert.ok(s.setStatus(r.id, { state: 'downloading' }, 'phone-b').record);
        assert.ok(s.setStatus(r.id, { state: 'installed' }).record);
        assert.ok(!s.hasApk(r.id), 'installed drops the APK');
        assert.strictEqual(s.setStatus(r.id, { state: 'failed' }).status, 409, 'installed is final');
        assert.ok(s.setStatus(r.id, { state: 'installed' }).record, 'but repeating it is fine');
        assert.strictEqual(s.cancel(r.id).status, 409, 'and it cannot be cancelled');
        ok('installing, needs_action, failed and a retry, then installed is final and drops the APK');

        const c = await s.create({ path: src });
        assert.strictEqual(s.cancel(c.id).record.state, 'cancelled');
        assert.ok(s.hasApk(c.id), 'cancel keeps the APK, for Retry, until the sweep');
        assert.strictEqual(s.setStatus(c.id, { state: 'downloading' }).status, 409);
        assert.strictEqual(s.setStatus(c.id, { state: 'installing' }).status, 409);
        // The phone had already installed it when the desk cancelled: the record
        // should say what is true of the phone.
        assert.strictEqual(s.setStatus(c.id, { state: 'installed' }).record.state, 'installed');
        ok('cancelled is final, except that a crossing installed is accepted');

        const before = events.length;
        s.setStatus((await s.create({ path: src })).id, { state: 'downloading' });
        assert.strictEqual(events.length, before + 2, 'every update is broadcast');
        ok('every update is broadcast');
    }

    // --- progress heartbeats ---------------------------------------------------

    {
        const s = fresh();
        const r = await s.create({ path: src });
        clock += 1000;
        let out = s.setStatus(r.id, { state: 'downloading', progress: { bytes: 0 } }, 'phone-a');
        assert.deepStrictEqual(out.record.progress, { bytes: 0, total: BYTES.length },
            'total defaults to the record\'s size');
        assert.strictEqual(out.record.attempts, 1, 'the claim is an attempt');
        assert.strictEqual(events.length, 2);

        // Inside the second: the clock moves, the store does not tell anybody.
        clock += 300;
        out = s.setStatus(r.id, { state: 'downloading', progress: { bytes: 1000, total: 5004 } }, 'phone-a');
        assert.deepStrictEqual(out.record.progress, { bytes: 1000, total: 5004 }, 'the caller sees it at once');
        assert.strictEqual(out.record.updatedAt, clock, 'a heartbeat always refreshes updatedAt');
        assert.strictEqual(out.record.attempts, 1, 'a heartbeat is not another claim');
        assert.strictEqual(events.length, 2, 'throttled: not broadcast');
        const onDisk = () => JSON.parse(fs.readFileSync(s.file, 'utf8')).installs[0];
        assert.deepStrictEqual(onDisk().progress, { bytes: 0, total: BYTES.length }, 'nor written');

        clock += HEARTBEAT_MS - 300;
        out = s.setStatus(r.id, { state: 'downloading', progress: { bytes: 2000, total: 5004 } }, 'phone-a');
        assert.strictEqual(events.length, 3, 'a second on: broadcast');
        assert.deepStrictEqual(events[2].progress, { bytes: 2000, total: 5004 });
        assert.deepStrictEqual(onDisk().progress, { bytes: 2000, total: 5004 });

        // A bare heartbeat keeps the bar where it was, and cannot be from another phone.
        clock += HEARTBEAT_MS;
        out = s.setStatus(r.id, { state: 'downloading' }, null);
        assert.deepStrictEqual(out.record.progress, { bytes: 2000, total: 5004 });
        assert.strictEqual(s.setStatus(r.id, { state: 'downloading', progress: { bytes: 1 } }, 'phone-b').status,
            409, 'a viewer-less heartbeat did not drop the claim');
        assert.strictEqual(s.setStatus(r.id, { state: 'downloading', progress: { bytes: 'lots' } }, 'phone-a').status,
            400);
        assert.deepStrictEqual(s.setStatus(r.id, { state: 'downloading', progress: { bytes: 9e9, total: 10 } },
            'phone-a').record.progress, { bytes: 10, total: 10 }, 'bytes is clamped to total');

        // A real change is never throttled, and leaves the bar behind.
        out = s.setStatus(r.id, { state: 'installing', progress: { bytes: 5, total: 10 } });
        assert.strictEqual(out.record.progress, null, 'progress belongs to downloading');
        assert.strictEqual(events[events.length - 1].state, 'installing');
        ok('a progress heartbeat refreshes updatedAt, and is written and broadcast once a second');
    }

    // --- stalls ------------------------------------------------------------------

    {
        const s = fresh();
        const r = await s.create({ path: src });
        clock += STALL_MS + 1;
        assert.strictEqual(s.get(r.id).stalled, false, 'a pending record never stalls: nobody has it');
        s.setStatus(r.id, { state: 'downloading' }, 'phone-a');
        clock += STALL_MS;
        assert.strictEqual(s.get(r.id).stalled, false, 'not at 90s exactly');
        clock += 1;
        assert.strictEqual(s.get(r.id).stalled, true, 'past 90s with no report');
        assert.strictEqual(s.list()[0].stalled, true, 'the list computes it too');

        const before = events.length;
        s.checkStalls();
        assert.strictEqual(events.length, before + 1, 'turning stalled is broadcast');
        assert.strictEqual(events[before].stalled, true);
        assert.strictEqual(events[before].updatedAt, s.get(r.id).updatedAt, 'without touching updatedAt');
        s.checkStalls();
        assert.strictEqual(events.length, before + 1, 'once');

        s.setStatus(r.id, { state: 'downloading' }, 'phone-a');
        assert.strictEqual(s.get(r.id).stalled, false, 'a heartbeat clears it');
        s.setStatus(r.id, { state: 'needs_action' });
        clock += RELEASE_MS * 2;
        assert.strictEqual(s.get(r.id).stalled, false, 'needs_action waits on a person, not the phone');
        s.checkStalls();
        assert.strictEqual(s.get(r.id).state, 'needs_action', 'and is never released');
        ok('stalled is true only for a claimed record past 90s, and is broadcast once');
    }

    {
        const s = fresh();
        const r = await s.create({ path: src });
        for (let n = 1; n <= MAX_ATTEMPTS; n++) {
            clock += 1000;
            const claimed = s.setStatus(r.id, { state: 'downloading', progress: { bytes: 100 } }, `phone-${n}`);
            assert.strictEqual(claimed.record.attempts, n);
            clock += RELEASE_MS - 1;
            s.checkStalls();
            assert.strictEqual(s.get(r.id).state, 'downloading', 'not before 3 minutes');
            clock += 1;
            s.checkStalls();
            const now = s.get(r.id);
            if (n < MAX_ATTEMPTS) {
                assert.strictEqual(now.state, 'pending', `attempt ${n} is released`);
                assert.strictEqual(now.message, 'Phone stopped responding; queued again');
                assert.strictEqual(now.progress, null);
                assert.strictEqual(now.stalled, false);
                assert.strictEqual(events[events.length - 1].state, 'pending', 'and broadcast');
            } else {
                assert.strictEqual(now.state, 'failed', `attempt ${n} gives up`);
                assert.match(now.message, /stopped responding 3 times/);
                assert.strictEqual(now.attempts, MAX_ATTEMPTS);
            }
        }
        // Released means unclaimed: a different phone may take attempt 2, which is
        // what the loop above did with phone-2 and phone-3.
        const raw = JSON.parse(fs.readFileSync(s.file, 'utf8')).installs[0];
        assert.strictEqual(raw.claimedBy, null, 'failed releases the claim');
        assert.ok(!('stalled' in raw), 'stalled is computed, never stored');
        assert.ok(s.hasApk(r.id), 'and keeps the APK for a retry');

        // installing goes quiet the same way.
        const i = await s.create({ path: src });
        s.setStatus(i.id, { state: 'downloading' }, 'phone-a');
        s.setStatus(i.id, { state: 'installing' });
        clock += RELEASE_MS;
        s.checkStalls();
        assert.strictEqual(s.get(i.id).state, 'pending');
        ok('a claim quiet for 3 minutes is released, and the third one fails it');
    }

    // --- retry -------------------------------------------------------------------

    {
        const s = fresh();
        assert.strictEqual(s.retry('nope').status, 404);
        for (const state of ['downloading', 'installing', 'failed', 'needs_action', 'cancelled']) {
            const r = await s.create({ path: src });
            s.setStatus(r.id, { state: 'downloading', progress: { bytes: 10 } }, 'phone-a');
            if (state === 'cancelled') s.cancel(r.id);
            else if (state !== 'downloading') s.setStatus(r.id, { state, message: 'x' });
            const before = events.length;
            const out = s.retry(r.id);
            assert.ok(out.record, `${state}: ${out.error}`);
            assert.strictEqual(out.record.state, 'pending', `${state} goes back to pending`);
            assert.strictEqual(out.record.progress, null);
            assert.strictEqual(out.record.message, null);
            assert.strictEqual(out.record.attempts, 0, 'with a fresh budget of attempts');
            assert.strictEqual(events.length, before + 1, 'broadcast');
            assert.ok(s.setStatus(r.id, { state: 'downloading' }, 'phone-b').record, `${state}: the claim is gone`);
        }
        const p = await s.create({ path: src });
        const before = events.length;
        assert.strictEqual(s.retry(p.id).record.state, 'pending', 'pending is a no-op');
        assert.strictEqual(events.length, before);

        s.setStatus(p.id, { state: 'installed' });
        assert.strictEqual(s.retry(p.id).status, 409, 'installed is final');
        const gone = await s.create({ path: src });
        s.setStatus(gone.id, { state: 'failed' });
        fs.unlinkSync(s.apkPath(gone.id));
        assert.strictEqual(s.retry(gone.id).status, 410, 'no APK, nothing to retry');
        assert.strictEqual(s.get(gone.id).state, 'failed', 'and the record is left alone');
        ok('retry puts any unfinished record back to pending, but not installed (409) or a lost APK (410)');
    }

    // --- persistence, the cap, the port ------------------------------------

    {
        let s = fresh(7);
        const a = await s.create({ path: src, label: 'a' });
        s.setStatus(a.id, { state: 'downloading' }, 'phone-a');
        s = new PhoneInstalls({ port: 7, now: () => clock });
        assert.deepStrictEqual(s.get(a.id).state, 'downloading', 'records survive a restart');
        assert.strictEqual(s.setStatus(a.id, { state: 'downloading' }, 'phone-b').status, 409,
            'and so does the claim');
        assert.strictEqual(new PhoneInstalls({ port: 8 }).list().length, 0,
            'another port\'s bridge has its own file');
        ok('records and claims survive a restart, and each port has its own file');

        for (let i = 0; i < MAX_RECORDS + 5; i++) { clock += 1; await s.create({ path: src, label: `n${i}` }); }
        const all = JSON.parse(fs.readFileSync(s.file, 'utf8')).installs;
        assert.strictEqual(all.length, MAX_RECORDS);
        assert.ok(!s.hasApk(a.id), 'an evicted record takes its APK with it');
        const listed = s.list();
        assert.strictEqual(listed.length, LIST_LIMIT);
        assert.strictEqual(listed[0].label, `n${MAX_RECORDS + 4}`, 'newest first');
        ok(`capped at ${MAX_RECORDS} on disk, and the list is the newest ${LIST_LIMIT}`);
    }

    // --- retention -----------------------------------------------------------

    {
        const s = fresh();
        const pending = await s.create({ path: src });
        const waiting = await s.create({ path: src });
        s.setStatus(waiting.id, { state: 'needs_action' });
        const failed = await s.create({ path: src });
        s.setStatus(failed.id, { state: 'failed' });
        const orphan = path.join(DIR, 'someone-elses.apk');
        fs.writeFileSync(orphan, 'x');
        const young = path.join(DIR, 'another-bridges.apk');
        fs.writeFileSync(young, 'x');
        // Stamped against the store's clock, which is the one the sweep reads.
        const stamp = (f, ms) => fs.utimesSync(f, ms / 1000, ms / 1000);
        stamp(orphan, clock - 60_000);
        stamp(young, clock);

        clock += KEEP_APK_MS - 1;
        s.sweep();
        assert.ok(s.hasApk(pending.id), 'not yet');
        assert.ok(!fs.existsSync(orphan), 'an unowned file past 24h goes');
        assert.ok(fs.existsSync(young), 'an unowned file inside 24h stays');

        clock += 1;
        s.sweep();
        assert.strictEqual(s.get(pending.id).state, 'cancelled', 'a pending record expires');
        assert.match(s.get(pending.id).message, /24 hours/);
        assert.strictEqual(s.get(waiting.id).state, 'needs_action',
            'needs_action keeps its state: the phone has the APK already');
        assert.strictEqual(s.get(failed.id).state, 'failed');
        for (const r of [pending, waiting, failed]) assert.ok(!s.hasApk(r.id), 'every APK is gone');
        assert.strictEqual(s.setStatus(waiting.id, { state: 'installed' }).record.state, 'installed',
            'and can still be reported installed');
        assert.strictEqual(s.setStatus(failed.id, { state: 'downloading' }).status, 409,
            'but nothing can download an APK that is gone');
        ok('the APK goes after 24h, open records expire, needs_action can still finish');
    }

    // --- the routes ------------------------------------------------------------

    const s = fresh();
    routes.init({ phoneInstalls: s });
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const seg = url.pathname.split('/').filter(Boolean);
        if (await routes.handle(req, res, url, url.pathname, seg, {}) === NEXT) {
            res.writeHead(599);
            res.end();
        }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    try {
        let r = await call(port, 'POST', '/api/phone-installs', { body: { path: src, label: 'Notes' } });
        assert.strictEqual(r.status, 201);
        const rec = r.body;
        assert.deepStrictEqual(Object.keys(rec).sort(), FIELDS);
        r = await call(port, 'POST', '/api/phone-installs', { body: { path: 'rel.apk' } });
        assert.strictEqual(r.status, 400);
        assert.match(r.body.error, /absolute/);

        r = await call(port, 'GET', '/api/phone-installs');
        assert.deepStrictEqual(r.body.installs.map(x => x.id), [rec.id]);
        r = await call(port, 'GET', `/api/phone-installs/${rec.id}`);
        assert.strictEqual(r.body.id, rec.id);
        assert.strictEqual((await call(port, 'GET', '/api/phone-installs/nope')).status, 404);
        ok('POST files one (201), GET lists them and reads one');

        r = await call(port, 'GET', `/api/phone-installs/${rec.id}/apk`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers['content-type'], 'application/vnd.android.package-archive');
        assert.strictEqual(Number(r.headers['content-length']), BYTES.length);
        assert.strictEqual(r.headers.etag, `"${SHA}"`);
        assert.strictEqual(r.headers['x-sha256'], SHA);
        assert.strictEqual(r.headers['accept-ranges'], 'bytes');
        assert.deepStrictEqual(r.buf, BYTES);

        r = await call(port, 'GET', `/api/phone-installs/${rec.id}/apk`, { headers: { range: 'bytes=100-199' } });
        assert.strictEqual(r.status, 206);
        assert.strictEqual(r.headers['content-range'], `bytes 100-199/${BYTES.length}`);
        assert.deepStrictEqual(r.buf, BYTES.subarray(100, 200));
        r = await call(port, 'GET', `/api/phone-installs/${rec.id}/apk`, { headers: { range: 'bytes=4000-' } });
        assert.deepStrictEqual(r.buf, BYTES.subarray(4000));
        r = await call(port, 'GET', `/api/phone-installs/${rec.id}/apk`, { headers: { range: 'bytes=-10' } });
        assert.deepStrictEqual(r.buf, BYTES.subarray(BYTES.length - 10));
        r = await call(port, 'GET', `/api/phone-installs/${rec.id}/apk`,
            { headers: { range: `bytes=${BYTES.length}-` } });
        assert.strictEqual(r.status, 416);
        r = await call(port, 'GET', `/api/phone-installs/${rec.id}/apk`,
            { headers: { range: 'bytes=0-9', 'if-range': '"stale"' } });
        assert.strictEqual(r.status, 200, 'a stale If-Range gets the whole file');
        r = await call(port, 'GET', `/api/phone-installs/${rec.id}/apk`, { headers: { 'if-none-match': `"${SHA}"` } });
        assert.strictEqual(r.status, 304);
        ok('the APK: type, length, ETag and X-SHA256, ranges, 416, If-Range and 304');

        r = await call(port, 'POST', `/api/phone-installs/${rec.id}/status`,
            { body: { state: 'downloading' }, headers: { 'x-tgxcode-viewer': 'phone-a' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.state, 'downloading');
        r = await call(port, 'POST', `/api/phone-installs/${rec.id}/status`,
            { body: { state: 'downloading' }, headers: { 'x-tgxcode-viewer': 'phone-b' } });
        assert.strictEqual(r.status, 409);
        r = await call(port, 'POST', `/api/phone-installs/${rec.id}/status`, { body: { state: 'nah' } });
        assert.strictEqual(r.status, 400);
        ok('status takes the viewer header for the claim');

        r = await call(port, 'POST', `/api/phone-installs/${rec.id}/status`, {
            body: { state: 'downloading', progress: { bytes: 10, total: 100 } },
            headers: { 'x-tgxcode-viewer': 'phone-a' },
        });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.progress, { bytes: 10, total: 100 });
        r = await call(port, 'POST', `/api/phone-installs/${rec.id}/status`,
            { body: { state: 'downloading', progress: [] }, headers: { 'x-tgxcode-viewer': 'phone-a' } });
        assert.strictEqual(r.status, 400, 'a malformed progress is refused');
        ok('status takes a progress heartbeat');

        r = await call(port, 'POST', `/api/phone-installs/${rec.id}/cancel`);
        assert.strictEqual(r.body.state, 'cancelled');
        r = await call(port, 'GET', `/api/phone-installs/${rec.id}/apk`);
        assert.strictEqual(r.status, 410, 'a cancelled APK is Gone, though it is kept for Retry');
        r = await call(port, 'POST', `/api/phone-installs/${rec.id}/retry`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.state, 'pending');
        assert.strictEqual(r.body.attempts, 0);
        r = await call(port, 'GET', `/api/phone-installs/${rec.id}/apk`);
        assert.strictEqual(r.status, 200, 'retried, it downloads again');
        assert.strictEqual((await call(port, 'POST', '/api/phone-installs/nope/retry')).status, 404);
        s.setStatus(rec.id, { state: 'installed' });
        r = await call(port, 'POST', `/api/phone-installs/${rec.id}/retry`);
        assert.strictEqual(r.status, 409);
        r = await call(port, 'GET', `/api/phone-installs/${rec.id}/apk`);
        assert.strictEqual(r.status, 410, 'installed drops the APK');
        const lost = await s.create({ path: src });
        s.cancel(lost.id);
        fs.unlinkSync(s.apkPath(lost.id));
        r = await call(port, 'POST', `/api/phone-installs/${lost.id}/retry`);
        assert.strictEqual(r.status, 410);
        assert.match(r.body.error, /no longer stored/);
        ok('retry: 200 back to pending, 404 unknown, 409 installed, 410 when the APK is gone');
        assert.strictEqual((await call(port, 'GET', '/api/phone-installs/nope/apk')).status, 404);
        assert.strictEqual((await call(port, 'POST', '/api/phone-installs/nope/cancel')).status, 404);
        assert.strictEqual((await call(port, 'GET', '/api/other')).status, 599, 'not ours is NEXT');
        ok('unknown ids 404; other paths fall through');
    } finally {
        server.close();
        fs.rmSync(home, { recursive: true, force: true });
    }

    console.log(`\n${pass} groups passed`);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
