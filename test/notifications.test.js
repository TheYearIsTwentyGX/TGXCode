'use strict';

// The read watermarks, on their own — no bridge.
//
// A unit test rather than a live one for the reason drafts.test.js gives: every
// question worth asking here is about one file. Does a watermark ever move
// backwards, does marking one conversation read leave the others alone, does the
// `all` floor cover a session that has no mark of its own, and does the merge on
// save actually save the other bridge's marks rather than talking about it. The
// routes on top are thin enough that testing them would be testing http.
//
// **XDG_DATA_HOME is set before the require, and that order is load-bearing.**
// bridge/config.js reads the variable once, at require time, to build STATE_DIR —
// so setting it afterwards would point the module at the real
// ~/.local/share/claude-sessions and this test would eat the user's read state.
// test/drafts.test.js and test/ports.test.js do the same thing for the same
// reason.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-notes-'));
process.env.XDG_DATA_HOME = home;

const { NotificationLog, ReadState, READ_FILE, MAX_AGE_MS } = require('../bridge/notifications');

// Where the module will actually write, now that the env var is in place.
// Asserted rather than assumed: if this ever pointed at the real directory the
// rest of the file would be destructive, so it is worth failing loudly on.
assert.ok(READ_FILE.startsWith(home),
    `refusing to run: READ_FILE is ${READ_FILE}, outside the throwaway ${home}`);

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

/**
 * Force the debounced write out now.
 *
 * save() coalesces on a timer, which is right for a bridge and useless in a
 * test. Cancelling the timer and calling the body is not possible from outside,
 * so this waits it out — the debounce is 250ms and there are only a few of them.
 */
const flush = () => new Promise(r => setTimeout(r, 400));

/**
 * A fresh store over a wiped file, so groups cannot leak into each other.
 *
 * Flushed *before* the unlink, not after. A group that marked something and then
 * ended left a save on the timer, and that write lands whenever it lands — which
 * without this is a few milliseconds after the next group has wiped the file, so
 * the previous group's state reappears underneath it. That is a test bug rather
 * than a store bug, but it is exactly the kind that reads as a store bug.
 */
async function fresh() {
    await flush();
    try { fs.unlinkSync(READ_FILE); } catch { /* first run */ }
    return new ReadState();
}

const row = (at, sessionId, loud = true) => ({ at, sessionId, loud });

async function main() {
    console.log('read watermarks');

    // -- the predicate ----------------------------------------------------
    {
        const reads = await fresh();
        const a = row(1000, 'sess-a');
        assert.strictEqual(reads.isRead(a), false);
        reads.markSession('sess-a', 1000);
        assert.strictEqual(reads.isRead(a), true,
            'a row filed exactly at the watermark counts as seen');
        assert.strictEqual(reads.isRead(row(1001, 'sess-a')), false,
            'a row filed after it does not');
        ok('a session mark covers that session up to its timestamp');

        assert.strictEqual(reads.isRead(row(1000, 'sess-b')), false,
            'marking one conversation must not touch another');
        ok('marks do not leak between sessions');

        reads.markAll(2000);
        assert.strictEqual(reads.isRead(row(1500, 'sess-b')), true);
        assert.strictEqual(reads.isRead(row(2500, 'sess-b')), false);
        ok('the all floor covers a session with no mark of its own');
    }

    // -- monotonic --------------------------------------------------------
    {
        const reads = await fresh();
        assert.strictEqual(reads.markSession('sess-a', 5000), true);
        assert.strictEqual(reads.markSession('sess-a', 4000), false,
            'an earlier mark is refused, and says so');
        assert.strictEqual(reads.get().sessions['sess-a'], 5000);
        assert.strictEqual(reads.markSession('sess-a', 5000), false,
            're-opening a chat with nothing new to clear moves nothing');
        ok('a session watermark never moves backwards');

        assert.strictEqual(reads.markAll(9000), true);
        assert.strictEqual(reads.markAll(8000), false);
        assert.strictEqual(reads.get().all, 9000);
        ok('the floor never moves backwards either');

        assert.strictEqual(reads.markSession(null, 9999), false,
            'no session id is not an error, it is nothing to do');
        ok('a missing session id is refused quietly');
    }

    // -- counting ---------------------------------------------------------
    {
        const reads = await fresh();
        const log = new NotificationLog({ describe: () => ({ title: 'x' }) });
        log.rows = [
            row(100, 'sess-a'), row(200, 'sess-a'),
            row(300, 'sess-b'), row(400, 'sess-b', false),
        ];
        assert.strictEqual(log.countUnread(r => reads.isRead(r)), 3,
            'the quiet row is not news and never was');
        reads.markSession('sess-a', 250);
        assert.strictEqual(log.countUnread(r => reads.isRead(r)), 1);
        reads.markAll(400);
        assert.strictEqual(log.countUnread(r => reads.isRead(r)), 0);
        ok('countUnread counts loud unread rows, over the whole log');

        const withTest = new NotificationLog({
            describe: () => ({ title: 'x' }),
            isTest: (id) => id === 'sess-b',
        });
        withTest.rows = [row(100, 'sess-a'), row(300, 'sess-b')];
        const none = () => false;
        assert.strictEqual(withTest.countUnread(none), 1,
            'a scratch session belongs to the bridge that started it');
        assert.strictEqual(withTest.countUnread(none, { includeTest: true }), 2);
        ok('test sessions follow the same rule as everywhere else');
    }

    // -- storage ----------------------------------------------------------
    {
        // Real timestamps here, unlike the groups above, because this one goes
        // through load() and load() prunes: a toy `5000` is thirty-odd years
        // before the retention cutoff and would be dropped on the way back in.
        // Which is the store behaving correctly and the test asking the wrong
        // question.
        const reads = await fresh();
        const now = Date.now();
        reads.markSession('sess-a', now);
        reads.markAll(now - 1000);
        await flush();
        const again = new ReadState();
        assert.strictEqual(again.get().all, now - 1000);
        assert.strictEqual(again.get().sessions['sess-a'], now);
        ok('a mark survives a reload');
    }

    // -- the merge that makes two bridges safe ----------------------------
    {
        const reads = await fresh();
        reads.markSession('mine', 5000);
        await flush();

        // The other bridge, writing behind this one's back: it has a mark this
        // process has never seen, and an older one for a session they share.
        fs.writeFileSync(READ_FILE, JSON.stringify({
            version: 1, all: 7000,
            sessions: { mine: 3000, theirs: 6000 },
        }));

        reads.markSession('mine', 5500);
        await flush();

        const merged = JSON.parse(fs.readFileSync(READ_FILE, 'utf8'));
        assert.strictEqual(merged.sessions.mine, 5500, 'the later mark wins');
        assert.strictEqual(merged.sessions.theirs, 6000,
            "the other bridge's mark was not discarded");
        assert.strictEqual(merged.all, 7000, 'nor was its floor');
        assert.strictEqual(reads.get().sessions.theirs, 6000,
            'and this process adopted it rather than merely preserving it');
        ok('a concurrent write from the other bridge loses nothing');
    }

    // -- pruning ----------------------------------------------------------
    {
        await flush();
        fs.writeFileSync(READ_FILE, JSON.stringify({
            version: 1, all: 0,
            sessions: {
                stale: Date.now() - MAX_AGE_MS - 1000,
                fresh: Date.now() - 1000,
            },
        }));
        const reads = new ReadState();
        assert.strictEqual(reads.get().sessions.stale, undefined,
            'a watermark older than the log itself cannot affect any surviving row');
        assert.strictEqual(typeof reads.get().sessions.fresh, 'number');
        ok('watermarks past the log’s own retention are dropped on load');
    }

    // -- the bad days -----------------------------------------------------
    {
        await flush();
        fs.writeFileSync(READ_FILE, '{ not json');
        const reads = new ReadState();
        assert.deepStrictEqual(reads.get(), { all: 0, sessions: {} });
        ok('an unreadable file loads as empty rather than throwing');

        fs.writeFileSync(READ_FILE, JSON.stringify({ version: 99, all: 5000 }));
        const future = new ReadState();
        assert.strictEqual(future.get().all, 0,
            'a version we do not understand is ignored, not guessed at');
        ok('a file from a future version is ignored');

        fs.writeFileSync(READ_FILE, '﻿' + JSON.stringify({
            version: 1, all: 4200, sessions: {},
        }));
        assert.strictEqual(new ReadState().get().all, 4200);
        ok('a BOM does not stop it loading');
    }

    console.log(`\n${pass} assertions passed.`);
}

main().then(() => {
    fs.rmSync(home, { recursive: true, force: true });
}).catch((err) => {
    fs.rmSync(home, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
});
