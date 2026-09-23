'use strict';

// The session host — bridge/host.js and bridge/host-client.js.
//
// No bridge needed and no `claude`: a stub child that echoes and sleeps is enough,
// because the host is not supposed to know what it is relaying. What is worth
// asserting is the one promise it makes — **a process outlives the connection that
// started it, and whoever connects next hears what it said in the meantime** — and
// the edges of that promise: the note comes back with the seq it was left at, an
// exit that happened while nobody was listening is still reported, and a host with
// nothing to hold goes away on its own.
//
// Plus the other half of the contract, which is easier to break by accident: when
// there is no host to be had, spawnClaude hands back an ordinary child process and
// nothing else changes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const hostClient = require('../bridge/host-client.js');
const { HostConnection } = hostClient;

// Short on purpose: a Unix socket path has a 108-byte ceiling.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hst-'));
const socketPath = path.join(root, 'h.sock');
const logFile = path.join(root, 'host.log');
const stub = path.join(root, 'stub.js');

fs.writeFileSync(stub, `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
    const [cmd, arg] = l.split(' ');
    if (cmd === 'echo') process.stdout.write(arg + '\\n');
    if (cmd === 'slow') setTimeout(() => process.stdout.write('done ' + arg + '\\n'), Number(arg));
    if (cmd === 'err') process.stderr.write('oops\\n');
    if (cmd === 'exit') process.exit(Number(arg));
});
rl.on('close', () => process.exit(0));
`);

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hostPids = new Set();

async function until(fn, ms, what) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await fn()) return;
        await sleep(25);
    }
    assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}

function collect(stream) {
    const box = { text: '' };
    stream.setEncoding('utf8');
    stream.on('data', (d) => { box.text += d; });
    return box;
}

/** A second bridge: a fresh connection, nothing shared with the first. */
async function secondBridge() {
    const c = new HostConnection(socketPath);
    assert.ok(await c.connect(), 'a later connection is accepted');
    return c;
}

async function main() {
    console.log('host');

    // -- no host to be had: spawn directly ----------------------------------

    {
        const tooLong = path.join(root, 'x'.repeat(120), 'h.sock');
        assert.strictEqual(await hostClient.ensureHost({ socketPath: tooLong, logFile }), false);
        const p = hostClient.spawnClaude(process.execPath, [stub], { stdio: ['pipe', 'pipe', 'pipe'] }, 's0');
        assert.ok(!p.hosted, 'falls back to a real child process');
        const out = collect(p.stdout);
        p.stdin.write('echo direct\n');
        await until(() => out.text.includes('direct'), 3000, 'direct echo');
        p.stdin.end();
        await new Promise(r => p.on('close', r));
        ok('with no usable socket, spawnClaude is child_process.spawn');
    }

    // -- a host, started on demand ------------------------------------------

    assert.strictEqual(await hostClient.ensureHost({ socketPath, logFile }), true, 'host starts');
    const st = hostClient.status();
    assert.ok(st && st.pid, 'status names the host');
    assert.strictEqual(st.protocol, hostClient.PROTOCOL);
    hostPids.add(st.pid);
    assert.strictEqual((fs.statSync(socketPath).mode & 0o777), 0o600, 'socket is 0600');
    ok('ensureHost starts a host and the socket is private');

    const child = hostClient.spawnClaude(process.execPath, [stub], { cwd: root }, 'sess1');
    assert.ok(child.hosted, 'spawned in the host');
    const out = collect(child.stdout);
    const err = collect(child.stderr);
    child.stdin.write('echo hello\n');
    child.stdin.write('err x\n');
    await until(() => out.text.includes('hello') && err.text.includes('oops'), 3000, 'relay');
    await until(() => child.pid, 3000, 'pid');
    ok('stdin, stdout and stderr are relayed');

    // -- the bridge goes away mid-turn --------------------------------------

    child.note({ turn: 'in flight' });
    child.stdin.write('slow 400\n');
    await sleep(50);
    const pid = child.pid;
    // What a bridge exiting looks like from the host: it stops listening. The
    // process on the far end must not notice.
    child.release();
    await sleep(700);
    assert.doesNotThrow(() => process.kill(pid, 0), 'the process is still alive');

    const b2 = await secondBridge();
    const { children } = await b2.request('list');
    const entry = children.find(c => c.key.startsWith('sess1.'));
    assert.ok(entry && !entry.exited, 'the second bridge sees it running');
    assert.deepStrictEqual(entry.note, { turn: 'in flight' }, 'with the note left for it');
    const attached = await b2.request('attach', { key: entry.key, from: 0 });
    const said = attached.records.filter(r => r.dir === 'out').map(r => r.data).join('');
    assert.ok(said.includes('done 400'), 'output from while nobody was listening is replayed');
    assert.ok(attached.noteSeq > 0 && attached.noteSeq < attached.lastSeq,
        'the note is stamped with where the output had got to');
    assert.ok(attached.records.every(r => r.dir !== 'out' || r.data.endsWith('\n')),
        'every stdout record is a whole line');
    ok('a process outlives its bridge, and the next one hears what it said');

    // -- live events after adopting, and an exit ----------------------------

    const live = [];
    const exits = [];
    b2.children.set(entry.key, {
        _data: (m) => live.push(m.data), _exit: (m) => exits.push(m),
    });
    b2.post({ op: 'write', key: entry.key, data: 'echo again\n' });
    await until(() => live.join('').includes('again'), 3000, 'live after adopt');
    b2.post({ op: 'write', key: entry.key, data: 'exit 3\n' });
    await until(() => exits.length, 3000, 'exit event');
    assert.strictEqual(exits[0].code, 3);
    ok('an adopted process keeps talking, and its exit is reported');

    // -- an exit nobody was there for ---------------------------------------

    const quiet = hostClient.spawnClaude(process.execPath, [stub], { cwd: root }, 'sess2');
    await until(() => quiet.pid, 3000, 'pid');
    quiet.release();
    b2.post({ op: 'write', key: quiet.key, data: 'exit 7\n' });
    await sleep(300);
    const later = (await b2.request('list')).children.find(c => c.key === quiet.key);
    assert.ok(later && later.exited && later.exited.code === 7,
        'the exit is kept for whoever comes next');
    await b2.request('forget', { key: quiet.key });
    assert.ok(!(await b2.request('list')).children.find(c => c.key === quiet.key),
        'and dropped when forgotten');
    ok('an exit that happened with nobody attached is still reported');

    // -- signal ----------------------------------------------------------------

    const victim = hostClient.spawnClaude(process.execPath, [stub], { cwd: root }, 'sess3');
    const closed = new Promise(r => victim.on('close', (code, sig) => r({ code, sig })));
    await until(() => victim.pid, 3000, 'pid');
    victim.kill('SIGTERM');
    const how = await closed;
    assert.strictEqual(how.sig, 'SIGTERM');
    assert.strictEqual(victim.stdin.writable, false, 'stdin is closed after exit');
    ok('kill() reaches the process, and close carries the signal');

    // -- one host per socket ----------------------------------------------------

    const dup = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'host.js'),
        '--socket', socketPath], { stdio: 'ignore' });
    const dupCode = await new Promise(r => dup.on('close', r));
    assert.strictEqual(dupCode, 0, 'a second host on a live socket steps aside');
    assert.ok(await (await secondBridge()).request('hello'), 'the first is still answering');
    ok('a second host leaves a live one alone');

    // -- an orphan nobody comes back for ---------------------------------------

    {
        const sock = path.join(root, 'o.sock');
        const h = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'host.js'),
            '--socket', sock], { stdio: 'ignore',
            env: { ...process.env, TGXCODE_HOST_ORPHAN_MS: '400' } });
        hostPids.add(h.pid);
        const c = new HostConnection(sock);
        await until(() => c.connect(300), 3000, 'orphan host');
        await c.request('spawn', { key: 'o1', cmd: process.execPath, args: [stub], cwd: root });
        await sleep(600);
        let row = (await c.request('list')).children.find(x => x.key === 'o1');
        assert.ok(row && !row.exited, 'a watched child is left alone past the orphan time');
        c.post({ op: 'detach', key: 'o1' });
        await until(async () => {
            row = (await c.request('list')).children.find(x => x.key === 'o1');
            return row && row.exited;
        }, 3000, 'orphan to be ended');
        assert.strictEqual(row.exited.code, 0, 'ended by closing its input, not killed');
        ok('a child nobody attaches to is eventually asked to exit');
    }

    // -- idle exit -------------------------------------------------------------

    {
        const sock = path.join(root, 'i.sock');
        const h = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'host.js'),
            '--socket', sock], { stdio: 'ignore',
            env: { ...process.env, TGXCODE_HOST_IDLE_MS: '600' } });
        hostPids.add(h.pid);
        const code = await new Promise(r => h.on('close', r));
        assert.strictEqual(code, 0);
        assert.ok(!fs.existsSync(sock), 'and takes its socket with it');
        ok('a host holding nothing exits on its own');
    }

    console.log(`host: ${pass} passed`);
}

main().then(() => cleanup(0), (err) => {
    console.error(err);
    cleanup(1);
});

function cleanup(code) {
    for (const pid of hostPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(code);
}

