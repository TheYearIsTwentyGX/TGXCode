'use strict';

// What "free" and "unclaimed" mean when a port is being handed out.
//
// Here rather than against a live bridge because it needs to *hold* ports in
// ways no framework on this machine does on its own — a listener on `::1` and
// nothing else, most of all. That case is the reason this file exists: a bind
// test on 0.0.0.0 succeeds while it is answering, and a probe of 127.0.0.1 gets
// nothing, so the port used to read as free and get handed out from under a
// running server.
//
// It also covers runs.js's claimsFor(), which is the other half of the same
// decision: ports.js knows free from occupied, and that knows free from
// *unclaimed*. Splitting them across two files would put the incident that
// caused both — one worktree's dev server taking the port and the tab of
// another's — in neither.
//
// The state and cache directories are redirected before bridge/config is
// required, so nothing here touches the user's own.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ports-'));
process.env.XDG_DATA_HOME = home;
process.env.XDG_CACHE_HOME = home;

const ports = require('../bridge/ports.js');
const { RunPool } = require('../bridge/runs.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// --- scratch ports ---------------------------------------------------------

/** A port the kernel is willing to give out right now. */
function ephemeral() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

/** A run of `n` consecutive ports with nothing on any of them. */
async function scratchRange(n) {
    for (let tries = 0; tries < 25; tries++) {
        const base = await ephemeral();
        const all = [];
        for (let i = 0; i < n; i++) all.push(base + i);
        const free = await Promise.all(all.map(p => ports.isFree(p)));
        if (free.every(Boolean)) return base;
    }
    throw new Error('no run of free ports to test with');
}

function hold(port, host) {
    return new Promise((resolve, reject) => {
        const s = net.createServer(c => c.end());
        s.on('error', reject);
        s.listen(port, host, () => resolve(() => new Promise(r => s.close(r))));
    });
}

/** Take a port and hand it straight back, so the next allocate() can have it. */
async function allocated(opts, owner = 'test') {
    const port = await ports.allocate(opts, owner);
    if (port != null) ports.release(port, owner);
    return port;
}

(async () => {
    const base = await scratchRange(5);
    const range = { lo: base, hi: base + 4, denylist: null };

    // --- an occupied port is never handed out -------------------------------
    {
        const drop = await hold(base, '127.0.0.1');
        assert.strictEqual(await ports.isFree(base), false, 'held on 127.0.0.1');
        assert.strictEqual(await allocated(range), base + 1, 'skips the held one');
        await drop();
        ok('a port held on 127.0.0.1 is not free');
    }

    // The regression test. Before the listen table was consulted this returned
    // the held port: bindable() on the wildcard succeeds and 127.0.0.1 answers
    // nothing, so both of the old tests said free.
    {
        const drop = await hold(base, '::1');
        assert.strictEqual(await ports.bindable(base), true,
            'binding the wildcard alongside a ::1 listener still succeeds — the premise');
        assert.strictEqual(await ports.isFree(base), false, 'held on ::1');
        assert.strictEqual(await allocated(range), base + 1, 'skips the ::1 holder');
        await drop();
        ok('a port held on ::1 alone is not free either');
    }

    // --- prefer ------------------------------------------------------------
    assert.strictEqual(await allocated({ ...range, prefer: [base + 3] }), base + 3);
    ok('a preferred port wins over the bottom of the range');

    {
        const drop = await hold(base + 3, '127.0.0.1');
        assert.strictEqual(await allocated({ ...range, prefer: [base + 3] }), base,
            'an occupied preference is skipped, not waited for');
        await drop();
        ok('a preferred port that is taken falls back to the range');
    }

    assert.strictEqual(await allocated({ ...range, prefer: [base + 40] }), base,
        'outside [lo, hi]');
    assert.strictEqual(
        await allocated({ ...range, prefer: [base + 2], skip: [base + 2] }), base,
        'skip outranks prefer');
    ok('a preference outside the range, or skipped, is ignored');

    // --- avoid -------------------------------------------------------------
    assert.strictEqual(await allocated({ ...range, avoid: new Set([base, base + 1]) }),
        base + 2);
    ok("somebody else's ports are left alone while others are free");

    // A claim on a port nothing is listening on must not stop a server starting.
    assert.strictEqual(
        await allocated({ lo: base, hi: base + 1, denylist: null,
            avoid: new Set([base, base + 1]) }),
        base, 'the whole range claimed: take the first anyway');
    ok('a claimed port is a last resort, not a refusal');

    // --- nothing left ------------------------------------------------------
    {
        const drops = [await hold(base, '127.0.0.1'), await hold(base + 1, '127.0.0.1')];
        assert.strictEqual(await allocated({ lo: base, hi: base + 1, denylist: null }), null);
        for (const drop of drops) await drop();
        ok('a range with nothing free returns null');
    }

    // --- the reservation ---------------------------------------------------
    {
        const first = await ports.allocate(range, 'run-a');
        const second = await ports.allocate(range, 'run-b');
        assert.strictEqual(first, base);
        assert.strictEqual(second, base + 1, 'a reserved port is not handed out twice');
        ports.release(first, 'run-b');
        assert.strictEqual(await ports.allocate(range, 'run-c'), base + 2,
            'releasing somebody else\'s reservation does nothing');
        ports.release(first, 'run-a');
        ports.release(second, 'run-b');
        ports.release(base + 2, 'run-c');
        ok('a reservation survives until its owner releases it');
    }

    // --- the memory --------------------------------------------------------
    assert.strictEqual(ports.rememberedPort('nobody'), null);
    ports.remember('a b', base);
    ports.remember('c d', base + 1);
    assert.strictEqual(ports.rememberedPort('a b'), base);
    assert.deepStrictEqual([...ports.claims().entries()].sort(),
        [['a b', base], ['c d', base + 1]]);
    ports.forgetKey('c d');
    assert.strictEqual(ports.rememberedPort('c d'), null);
    ok('a port is remembered, read back and forgotten');

    // Written down for real, and read by a process that was not there when it
    // happened — which is the only version of this that matters, because the
    // point is surviving a bridge restart. The save is debounced.
    await new Promise(r => setTimeout(r, 700));
    const read = (code) => spawnSync(process.execPath, ['-e', code], {
        env: { ...process.env, XDG_DATA_HOME: home },
        encoding: 'utf8',
    });

    const reader = `const p = require(${JSON.stringify(path.join(__dirname, '..', 'bridge', 'ports.js'))});`
        + 'process.stdout.write(String(p.rememberedPort("a b")));';
    let out = read(reader);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(out.stdout, String(base), 'a fresh process reads the memory back');
    ok('the memory survives the process that wrote it');

    // Forgetting has to reach the disk too. The save merges over whatever is
    // there — that is how the two bridges keep each other's keys — so a delete
    // that only happened in memory would be read straight back.
    ports.remember('run:/gone:x', base + 4);
    await new Promise(r => setTimeout(r, 700));
    ports.forgetKey('run:/gone:x');
    await new Promise(r => setTimeout(r, 700));
    out = read(reader.replace('"a b"', '"run:/gone:x"'));
    assert.strictEqual(out.stdout, 'null', 'a forgotten key does not come back');
    ok('forgetting a key survives the merge');

    // A key naming a directory that no longer exists is dropped on load — dead
    // worktrees must not go on claiming ports.
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-gone-'));
    ports.remember(`run:${gone}:x`, base + 4);
    ports.remember('dev:/definitely/not/here', base + 3);
    await new Promise(r => setTimeout(r, 700));
    fs.rmSync(gone, { recursive: true, force: true });
    out = read(reader.replace('"a b"', JSON.stringify(`run:${gone}:x`))
        .replace('process.stdout.write', 'p.claims(); process.stdout.write'));
    assert.strictEqual(out.stdout, 'null', 'the deleted worktree is forgotten');
    out = read(reader.replace('"a b"', '"dev:/definitely/not/here"'));
    assert.strictEqual(out.stdout, 'null', 'and so is a path that never existed');
    const live = `run:${path.join(__dirname, '..')}:x`;
    ports.remember(live, base + 3);
    await new Promise(r => setTimeout(r, 700));
    out = read(reader.replace('"a b"', JSON.stringify(live)));
    assert.strictEqual(out.stdout, String(base + 3), 'while a directory still there is kept');
    ok('a key for a directory that is gone stops claiming its port');

    fs.writeFileSync(ports.MEMORY_FILE, '{not json at all');
    out = read(reader);
    assert.strictEqual(out.status, 0, 'an unreadable memory file is not fatal');
    assert.strictEqual(out.stdout, 'null');
    assert.match(out.stderr, /ignoring unreadable/, 'and it says so');
    fs.rmSync(ports.MEMORY_FILE);
    ok('an unreadable memory file is ignored, loudly');

    // --- whose port is it — the incident this all came from -----------------
    // A dev server for one worktree came up on the port another worktree's was
    // using, and took its DevBrowser tab with it. Same shape here: `bank` asks
    // for a port while `training` has one, and a tab is named for each.
    {
        const pool = new RunPool();
        const key = 'run:/w/bank:prod';
        const prepared = { workspace: '/w/bank', id: 'prod', devbrowser: 'PROD bank' };
        // Exited, like the run in the incident was: a port another worktree
        // was on a minute ago is still not this one's to take.
        pool.byId.set('r1', { id: 'r1', workspace: '/w/training', commandId: 'prod',
            port: base, exitedAt: Date.now() - 60_000 });
        ports.remember('run:/w/training:prod', base);

        let claim = pool.claimsFor(key, prepared, { [base]: 'PROD training' });
        assert.ok(claim.avoid.has(base), "the other worktree's port is avoided");
        assert.deepStrictEqual(claim.prefer, [], 'and nothing is preferred yet');

        // Its own port from last time, which is the whole point.
        ports.remember(key, base + 1);
        claim = pool.claimsFor(key, prepared, { [base]: 'PROD training' });
        assert.deepStrictEqual(claim.prefer, [base + 1], 'the port it had last time');

        // With the memory lost, a tab already carrying this command's name is
        // enough to find its way home.
        ports.forgetKey(key);
        claim = pool.claimsFor(key, prepared,
            { [base]: 'PROD training', [base + 2]: 'PROD bank' });
        assert.deepStrictEqual(claim.prefer, [base + 2], 'the tab wearing its own name');
        assert.ok(claim.avoid.has(base) && !claim.avoid.has(base + 2));

        // …but a title is softer than a record of allocation. If somebody else's
        // memory holds that port, the title does not get to hand it over.
        ports.remember('run:/w/other:prod', base + 2);
        claim = pool.claimsFor(key, prepared,
            { [base]: 'PROD training', [base + 2]: 'PROD bank' });
        assert.deepStrictEqual(claim.prefer, [], 'a hard claim outranks a tab name');

        pool.shutdown();
        ok('a command prefers its own port and leaves other worktrees theirs');
    }

    fs.rmSync(home, { recursive: true, force: true });
    console.log(`\n  ${pass} checks passed`);
})().catch((err) => {
    fs.rmSync(home, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
});
