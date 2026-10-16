'use strict';

// How soon the session index learns a transcript exists — bridge/sessions.js.
//
// None of this throws when it is wrong. A transcript the index has not noticed
// is a session that 404s, a page that gives up opening it, and a DELETE that
// answers "not found" and leaves the file and its process behind — all of which
// fix themselves at the next 30-second poll, so nothing looks broken for long
// enough to be caught by eye. Every case therefore waits well under that poll and
// asserts the answer arrived inside it.
//
// The index gets a projects directory, cache and state of its own, set before
// the require because bridge/config.js reads them at load. Nothing else writes
// there, which is the point: on a real machine any write to a watched directory
// rescans everything, and that is what hid the bug.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-session-index-'));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});
const PROJECTS = path.join(TMP, 'projects');
fs.mkdirSync(path.join(PROJECTS, 'existing'), { recursive: true });
process.env.TGXCODE_PROJECTS_DIR = PROJECTS;
process.env.XDG_CACHE_HOME = path.join(TMP, 'cache');
process.env.XDG_DATA_HOME = path.join(TMP, 'data');

const { SessionIndex } = require('../bridge/sessions.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const transcript = (id) => JSON.stringify({
    type: 'user', uuid: `u-${id}`, sessionId: id, cwd: '/tmp/x',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
}) + '\n';

/** As `claude` does it: the project directory, then the first line a moment later. */
async function write(dir, id, { gap = 700 } = {}) {
    fs.mkdirSync(path.join(PROJECTS, dir), { recursive: true });
    await sleep(gap);
    const file = path.join(PROJECTS, dir, `${id}.jsonl`);
    fs.writeFileSync(file, transcript(id));
    return file;
}

/** Ms until the index has `id`, or Infinity past `limit`. */
async function until(idx, id, limit = 3000) {
    const t0 = Date.now();
    while (!idx.sessions.has(id)) {
        if (Date.now() - t0 > limit) return Infinity;
        await sleep(20);
    }
    return Date.now() - t0;
}

(async () => {
    const idx = new SessionIndex();
    await idx.start();

    // --- a directory that appears after start is watched -----------------------
    //
    // The case that took 30 seconds: the directory's creation rescans, finds it
    // empty, and the transcript written after that is seen by nothing but the poll.
    {
        const pending = write('new-a', 'watch-1');
        await pending;
        const ms = await until(idx, 'watch-1');
        assert.ok(ms < 2000, `a transcript in a directory made after start is indexed (${ms}ms)`);
        ok('a project directory created after start is watched');

        // And the second session there, which nothing announces: the directory
        // already exists, so its parent's watch stays quiet.
        await sleep(800);
        fs.writeFileSync(path.join(PROJECTS, 'new-a', 'watch-2.jsonl'), transcript('watch-2'));
        const again = await until(idx, 'watch-2');
        assert.ok(again < 2000, `a second transcript there is indexed too (${again}ms)`);
        ok('and a later transcript in it is noticed without a poll');
    }

    // --- a session this bridge started is found by name ------------------------
    //
    // With every watch closed, so this is the probe and nothing else.
    {
        idx._watching = false;
        for (const w of idx.watchers.values()) w.close();
        idx.watchers.clear();

        idx.note('probe-1');
        assert.ok(idx._probe, 'note() starts the probe');
        await write('new-b', 'probe-1', { gap: 1200 });
        const ms = await until(idx, 'probe-1');
        assert.ok(ms < 1000, `a noted session is indexed without any watch (${ms}ms)`);
        ok('note() finds the transcript of a session it was told about');

        await sleep(400);
        assert.strictEqual(idx._probe, null, 'the probe stops once nothing is waiting');
        ok('the probe stops when it has found everything');
    }

    // --- DELETE straight after the transcript appears --------------------------
    //
    // remove() before any pass has run: it used to return null, which the route
    // answers with 404 while the file stays on disk.
    {
        idx.pending.set('gone-1', Date.now());
        const file = path.join(PROJECTS, 'new-b', 'gone-1.jsonl');
        fs.writeFileSync(file, transcript('gone-1'));
        assert.ok(!idx.sessions.has('gone-1'), 'not indexed yet');
        assert.ok(idx.summary('gone-1'), 'summary() adopts a pending session that has a transcript');
        const out = idx.remove('gone-1');
        assert.ok(out && out.file === file, 'remove() deletes it');
        assert.ok(!fs.existsSync(file), 'and the file is gone');

        // Only pending ids are looked for: anything else is still unknown.
        fs.writeFileSync(path.join(PROJECTS, 'new-b', 'stranger.jsonl'), transcript('stranger'));
        assert.strictEqual(idx.summary('stranger'), null, 'an id nobody started is not adopted');
        ok('a session started moments ago can be deleted before the index catches up');
    }

    // --- stop() leaves nothing running -----------------------------------------
    {
        idx.note('never-writes');
        assert.ok(idx._probe, 'a probe is running');
        idx.stop();
        assert.strictEqual(idx._probe, null, 'stop() clears the probe');
        assert.strictEqual(idx.watchers.size, 0, 'and closes the watches');
        ok('stop() clears the probe, the poll and the watches');
    }

    // --- and never keeps the process alive -------------------------------------
    //
    // The bridge exits when told to. A session that never wrote a line must not
    // hold it up for the minute the probe is allowed.
    {
        const child = spawnSync(process.execPath, ['-e', `
            const { SessionIndex } = require(${JSON.stringify(path.resolve(__dirname, '../bridge/sessions.js'))});
            const idx = new SessionIndex();
            idx.start().then(() => idx.note('never-writes-either'));
        `], { env: process.env, timeout: 5000 });
        assert.strictEqual(child.error, undefined, 'the child exited on its own');
        assert.strictEqual(child.status, 0, String(child.stderr));
        ok('a pending probe does not keep the process alive');
    }

    console.log(`session-index: ${pass} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
