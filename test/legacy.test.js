'use strict';
// The pieces that keep pre-rename names working: bridge/legacy-env.js and
// bridge/legacy-dirs.js. No bridge needed.
//
// The directory move is the one worth the cases. It runs against the user's
// real ~/.local/share the first time any new-code module loads config.js, and
// what it moves is the token and every live session host socket — so the
// outcomes that never happen while you are looking (someone got there first,
// both directories exist, it already ran) are the ones asserted here.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { applyLegacyEnv, deleteBoth } = require('../bridge/legacy-env');
const { migrateDir, resolveDir } = require('../bridge/legacy-dirs');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgxcode-legacy-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const fresh = (name) => {
    const base = path.join(tmp, name);
    fs.mkdirSync(base);
    return { base, old: path.join(base, 'claude-sessions'), now: path.join(base, 'tgxcode') };
};

// --- env ------------------------------------------------------------------
{
    const env = { CLAUDE_SESSIONS_PORT: '45922', CLAUDE_SESSIONS_ROOTS: '/a',
        TGXCODE_ROOTS: '/b', UNRELATED: 'x' };
    applyLegacyEnv(env);
    assert.strictEqual(env.TGXCODE_PORT, '45922', 'an old name fills in for an unset new one');
    assert.strictEqual(env.TGXCODE_ROOTS, '/b', 'the new name wins when both are set');
    assert.strictEqual(env.TGXCODE_UNRELATED, undefined);
    deleteBoth(env, 'PORT');
    assert.ok(!('TGXCODE_PORT' in env) && !('CLAUDE_SESSIONS_PORT' in env),
        'stripping the port strips both spellings');
    ok('old variables fill in for new ones, and are stripped with them');
}

// --- dirs -----------------------------------------------------------------
{
    const d = fresh('move');
    fs.mkdirSync(d.old);
    fs.writeFileSync(path.join(d.old, 'token'), 'SECRET', { mode: 0o600 });
    assert.strictEqual(migrateDir(d.old, d.now), 'moved');
    assert.strictEqual(fs.readFileSync(path.join(d.now, 'token'), 'utf8'), 'SECRET');
    assert.ok(fs.lstatSync(d.old).isSymbolicLink(), 'the old path is left as a symlink');
    assert.strictEqual(fs.readFileSync(path.join(d.old, 'token'), 'utf8'), 'SECRET',
        'and something still reading the old path reads the same file');
    assert.strictEqual(migrateDir(d.old, d.now), 'linked', 'a second run is a no-op');
    ok('the old directory is moved and a symlink left where it was');
}

{
    const d = fresh('none');
    assert.strictEqual(migrateDir(d.old, d.now), 'none');
    assert.ok(!fs.existsSync(d.now), 'nothing to move creates nothing');
    ok('with no old directory there is nothing to do');
}

{
    // Both real: something made the new one, or an old-code process recreated
    // the old one between the rename and the symlink.
    const d = fresh('merge');
    fs.mkdirSync(d.old); fs.mkdirSync(d.now);
    fs.writeFileSync(path.join(d.old, 'flags.json'), '{}');
    fs.writeFileSync(path.join(d.now, 'token'), 'NEW');
    assert.strictEqual(migrateDir(d.old, d.now), 'merged');
    assert.ok(fs.existsSync(path.join(d.now, 'flags.json')));
    assert.ok(fs.lstatSync(d.old).isSymbolicLink());
    ok('two real directories are merged when nothing collides');
}

{
    const d = fresh('collide');
    fs.mkdirSync(d.old); fs.mkdirSync(d.now);
    fs.writeFileSync(path.join(d.old, 'token'), 'OLD');
    fs.writeFileSync(path.join(d.now, 'token'), 'NEW');
    assert.strictEqual(migrateDir(d.old, d.now), 'kept');
    assert.strictEqual(fs.readFileSync(path.join(d.old, 'token'), 'utf8'), 'OLD',
        'a collision overwrites nothing');
    assert.strictEqual(fs.readFileSync(path.join(d.now, 'token'), 'utf8'), 'NEW');
    ok('a collision leaves both files where they are');
}

// --- a live socket survives the move -------------------------------------
(async () => {
    const d = fresh('socket');
    fs.mkdirSync(d.old);
    const sock = path.join(d.old, 'host-45888.sock');
    const server = net.createServer(c => c.end('hi'));
    await new Promise(r => server.listen(sock, r));
    migrateDir(d.old, d.now);
    for (const p of [path.join(d.now, 'host-45888.sock'), sock]) {
        const got = await new Promise((resolve, reject) => {
            const c = net.connect(p);
            let buf = '';
            c.on('data', b => { buf += b; });
            c.on('end', () => resolve(buf));
            c.on('error', reject);
        });
        assert.strictEqual(got, 'hi', `a listening host is reachable at ${path.basename(path.dirname(p))}`);
    }
    server.close();
    ok('a session host listening in the old directory is reachable at both paths');

    {
        const d2 = fresh('resolve');
        assert.strictEqual(resolveDir(d2.old, d2.now), d2.now, 'neither: the new name');
        fs.mkdirSync(d2.old);
        assert.strictEqual(resolveDir(d2.old, d2.now), d2.old, 'only the old: the old');
        fs.mkdirSync(d2.now);
        assert.strictEqual(resolveDir(d2.old, d2.now), d2.now, 'both: the new');
        ok('resolveDir prefers the new directory and never invents it over the old');
    }

    // The same rule in shell, as scripts/restart-bridge.sh spells it.
    {
        const { spawnSync } = require('child_process');
        const d3 = fresh('shell');
        fs.mkdirSync(d3.old);
        const script = 'LOG_DIR="$XDG_CACHE_HOME/tgxcode"; '
            + 'if [ ! -e "$LOG_DIR" ] && [ -e "$XDG_CACHE_HOME/claude-sessions" ]; then '
            + 'LOG_DIR="$XDG_CACHE_HOME/claude-sessions"; fi; echo "$LOG_DIR"';
        const run = () => spawnSync('bash', ['-c', script],
            { env: { ...process.env, XDG_CACHE_HOME: d3.base }, encoding: 'utf8' }).stdout.trim();
        assert.strictEqual(run(), d3.old);
        migrateDir(d3.old, d3.now);
        assert.strictEqual(run(), d3.now);
        ok('the scripts follow the old directory until it has been moved');
    }

    console.log(`\n${pass} groups passed`);
})().catch((err) => { console.error(err); process.exit(1); });
