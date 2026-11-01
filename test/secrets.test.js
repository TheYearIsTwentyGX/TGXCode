'use strict';

// Secrets — bridge/secrets.js, the hook, the wrapper and the routes.
//
// What is worth pinning is what fails without a sound: a name that slips past
// validation and shadows PATH, a store file the umask made readable, a worktree
// that gets a store of its own and so "loses" every secret, a hook that wraps a
// command it should not (or misses one it should, and the command runs with
// `$KEY` empty), a quoting slip that runs something other than what the card
// showed, and a value that reaches stdout in a form the redaction did not know.
// Nothing here touches the user's store: it lives under a directory of the
// test's own, and the last check searches that whole tree for the values.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-secrets-')));
process.env.XDG_DATA_HOME = path.join(TMP, 'data');
process.env.TGXCODE_SECRETS_DIR = path.join(TMP, 'store');

const secrets = require('../bridge/secrets');
const { decide } = require('../bridge/secret-hook.js');
const { Redactor, formsOf } = require('../bridge/secret-exec.js');
const routes = require('../bridge/routes/secrets');
const cfg = require('../bridge/config');

assert.ok(secrets.storeDir().startsWith(TMP), `refusing to run: ${secrets.storeDir()} is not under ${TMP}`);
assert.ok(cfg.TOKEN_FILE.startsWith(TMP), `refusing to run: ${cfg.TOKEN_FILE} is not under ${TMP}`);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };
const modeOf = (p) => fs.statSync(p).mode & 0o777;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t',
    ...args], { stdio: 'pipe' }).toString();

const VALUE = 'sk_test_51HxYzQwErTy';
const OTHER = 'hunter2-but-longer!';

(async () => {
    // --- names -----------------------------------------------------------
    for (const n of ['TEST_KEY', 'A', 'STRIPE_SK_2', 'X'.repeat(64)]) assert.strictEqual(secrets.nameProblem(n), null, n);
    for (const n of ['test_key', '1KEY', '_KEY', 'KEY-1', 'KEY 1', '', 'X'.repeat(65), null, 'KÉY', 'K$']) {
        assert.ok(secrets.nameProblem(n), `${n} should be refused`);
    }
    for (const n of ['PATH', 'HOME', 'IFS', 'LD_PRELOAD', 'BASH_ENV', 'NODE_OPTIONS', 'CLAUDE_CODE_X',
        'TGXCODE_SECRETS_PORT', 'SUDO_ASKPASS', 'LC_ALL']) {
        assert.ok(/reserved/.test(secrets.nameProblem(n)), `${n} should be reserved`);
    }
    assert.ok(secrets.valueProblem(''));
    assert.ok(secrets.valueProblem('a\0b'));
    assert.ok(secrets.valueProblem('x'.repeat(16 * 1024 + 1)));
    assert.strictEqual(secrets.valueProblem('multi\nline'), null);
    ok('names are SHOUTING_CASE, and the ones that would change how a command runs are refused');

    // --- where the store is, and who shares it ---------------------------
    const repo = path.join(TMP, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'a'), 'a');
    git(repo, 'add', 'a');
    git(repo, 'commit', '-qm', 'a');
    const wt = path.join(TMP, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-w', wt);
    const sub = path.join(wt, 'deep', 'er');
    fs.mkdirSync(sub, { recursive: true });
    const root = secrets.projectRoot(repo);
    assert.strictEqual(root, repo);
    assert.strictEqual(secrets.projectRoot(wt), repo, 'a worktree shares the main repository\'s store');
    assert.strictEqual(secrets.projectRoot(sub), repo);
    const loose = path.join(TMP, 'not-a-repo');
    fs.mkdirSync(loose);
    assert.strictEqual(secrets.projectRoot(loose), loose);
    ok('the store is keyed by the main repository, so every worktree shares it');

    secrets.set(root, 'TEST_KEY', VALUE);
    const file = secrets.fileFor(root);
    assert.ok(file.startsWith(secrets.storeDir()) && !file.startsWith(repo), 'outside the repository');
    assert.strictEqual(modeOf(file), 0o600);
    assert.strictEqual(modeOf(secrets.storeDir()), 0o700);
    assert.strictEqual(git(repo, 'status', '--porcelain', '--ignored'), '', 'nothing written in the checkout');
    assert.strictEqual(secrets.get(root, 'TEST_KEY'), VALUE);
    assert.strictEqual(secrets.get(secrets.projectRoot(wt), 'TEST_KEY'), VALUE);
    const listed = secrets.list(root);
    assert.deepStrictEqual(listed.map(s => s.name), ['TEST_KEY']);
    assert.ok(!JSON.stringify(listed).includes(VALUE), 'a list never carries a value');
    // A directory somebody loosened is tightened on the next write.
    fs.chmodSync(secrets.storeDir(), 0o755);
    secrets.set(root, 'OTHER_KEY', OTHER);
    assert.strictEqual(modeOf(secrets.storeDir()), 0o700);
    assert.strictEqual(modeOf(file), 0o600);
    assert.deepStrictEqual(secrets.resolve(root, ['TEST_KEY', 'NOPE']), { missing: ['NOPE'] });
    assert.deepStrictEqual(secrets.resolve(root, ['TEST_KEY']), { values: { TEST_KEY: VALUE } });
    assert.strictEqual(secrets.remove(root, 'OTHER_KEY'), true);
    assert.strictEqual(secrets.remove(root, 'OTHER_KEY'), false);
    ok('a value is stored 0600 in a 0700 directory, outside the checkout, and listed by name only');

    {
        const elsewhere = path.join(TMP, 'elsewhere.json');
        fs.writeFileSync(elsewhere, '{}');
        const lroot = path.join(TMP, 'linked');
        fs.mkdirSync(lroot);
        fs.symlinkSync(elsewhere, secrets.fileFor(secrets.projectRoot(lroot)));
        assert.throws(() => secrets.set(secrets.projectRoot(lroot), 'K', 'value-value'), /not a regular file/);
        assert.strictEqual(fs.readFileSync(elsewhere, 'utf8'), '{}');
        ok('a store file that is a symlink is refused, not followed');
    }

    // --- the hook --------------------------------------------------------
    const bash = (command, extra = {}) => decide({ tool_name: 'Bash', cwd: wt,
        tool_input: { command, description: 'd', timeout: 1234, ...extra } });
    const wrappedNames = (out) => out && secrets.unwrapCommand(out.hookSpecificOutput.updatedInput.command).names;
    for (const c of ['curl -H "Authorization: Bearer $TEST_KEY" x', 'echo ${TEST_KEY}', "echo '$TEST_KEY'",
        'echo ${TEST_KEY:-none}', 'echo ${#TEST_KEY}', './deploy.sh  # uses $TEST_KEY',
        'TEST_KEY="$TEST_KEY" npm test', 'a=$TEST_KEY;b=$HOME']) {
        assert.deepStrictEqual(wrappedNames(bash(c)), ['TEST_KEY'], c);
    }
    for (const c of ['echo hi', 'echo $TEST_KEYS', 'echo $TEST_KEY_2', 'echo $test_key', 'echo $HOME',
        'echo $UNKNOWN', 'echo TEST_KEY', 'echo $TEST_KEYabc']) {
        assert.strictEqual(bash(c), null, c);
    }
    assert.strictEqual(decide({ tool_name: 'Read', cwd: wt, tool_input: { file_path: '$TEST_KEY' } }), null);
    {
        const out = bash('echo $TEST_KEY', { run_in_background: true });
        const input = out.hookSpecificOutput.updatedInput;
        assert.strictEqual(input.timeout, 1234);
        assert.strictEqual(input.description, 'd');
        assert.strictEqual(input.run_in_background, true);
        assert.ok(!('permissionDecision' in out.hookSpecificOutput), 'the hook rewrites; it never approves');
        assert.ok(!JSON.stringify(out).includes(VALUE), 'and what it prints carries no value');
        // Already wrapped, so not wrapped again.
        assert.strictEqual(bash(input.command), null);
    }
    {
        const loose2 = decide({ tool_name: 'Bash', cwd: loose, tool_input: { command: 'echo $TEST_KEY' } });
        assert.strictEqual(loose2, null, 'another project\'s secret is not this one\'s');
    }
    for (const c of [`cat ${secrets.fileFor(root)}`, 'ls ~/.local/share/tgxcode/secrets/',
        'grep -r sk_ ~/.local/share/claude-sessions/secrets']) {
        const out = bash(c);
        assert.strictEqual(out && out.hookSpecificOutput.permissionDecision, 'deny', c);
    }
    ok('the hook wraps a command that mentions a known secret, leaves the rest alone, and keeps Bash out of the store');

    {
        // The hook as the CLI runs it: the shell filter, then node only when the
        // command could need it.
        const hookRun = (command) => spawnSync('sh', ['-c', secrets.sessionSettings().hooks.PreToolUse[0].hooks[0].command], {
            input: JSON.stringify({ tool_name: 'Bash', cwd: wt, tool_input: { command } }), encoding: 'utf8',
        });
        const plain = hookRun('ls -la');
        assert.strictEqual(plain.status, 0);
        assert.strictEqual(plain.stdout, '');
        const wrapped = hookRun('echo "$TEST_KEY"');
        assert.strictEqual(wrapped.status, 0, wrapped.stderr);
        const out = JSON.parse(wrapped.stdout).hookSpecificOutput;
        assert.strictEqual(secrets.unwrapCommand(out.updatedInput.command).command, 'echo "$TEST_KEY"');
        assert.strictEqual(hookRun('echo $NOT_A_SECRET').stdout, '');
        ok('the hook command from the session settings filters in sh and decides in node');
    }

    {
        // What the wrapper is handed has to be exactly what the agent wrote,
        // whatever the quoting: run the wrapped command through bash with a
        // stand-in for secret-exec.js that prints its argv.
        const fakeDir = path.join(TMP, 'fake');
        fs.mkdirSync(fakeDir);
        const fake = path.join(fakeDir, 'secret-exec.js');
        fs.writeFileSync(fake, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
        for (const c of ["echo 'it'\\''s' \"$TEST_KEY\"", 'printf "%s\\n" a\nb\n', "a='\\''; b=\"'\"",
            'echo $TEST_KEY | tr a-z A-Z && echo `date` $(pwd)', "'''", 'x\\']) {
            const w = secrets.wrapCommand(c, ['TEST_KEY'], { exec: fake });
            const argv = JSON.parse(spawnSync('bash', ['-c', w], { encoding: 'utf8' }).stdout);
            assert.deepStrictEqual(argv, ['TEST_KEY', '--', c], c);
            assert.strictEqual(secrets.unwrapCommand(w, { exec: fake }).command, c, c);
            assert.strictEqual(secrets.unwrapCommand(secrets.wrapCommand(c, ['TEST_KEY'])).command, c, c);
            // Anything after the wrapper is not the wrapper: a card must show
            // everything that runs.
            assert.strictEqual(secrets.unwrapCommand(`${w}; rm -rf ~`, { exec: fake }), null);
            assert.strictEqual(secrets.unwrapCommand(`${w} && x`, { exec: fake }), null);
        }
        // A wrapper the agent wrote itself, pointing somewhere else, is not ours:
        // unwrapping it would draw `ls` on the card and run the other script.
        for (const spoof of [
            secrets.wrapCommand('ls', ['TEST_KEY'], { exec: fake }),
            secrets.wrapCommand('ls', ['TEST_KEY'], { node: '/bin/sh' }),
        ]) {
            assert.strictEqual(secrets.unwrapCommand(spoof), null, spoof);
            // And the hook wraps it in the real one, so the card shows it whole.
            const out = bash(`${spoof} # $TEST_KEY`);
            assert.strictEqual(secrets.unwrapCommand(out.hookSpecificOutput.updatedInput.command).command,
                `${spoof} # $TEST_KEY`);
        }
        ok('the wrapped command hands the wrapper exactly what was written, and only our own wrapper unwraps');
    }

    // --- redaction -------------------------------------------------------
    const redact = (values, chunks) => {
        const r = new Redactor(values);
        return Buffer.concat([...chunks.map(c => r.push(Buffer.from(c))), r.end()]).toString();
    };
    {
        const V = { TEST_KEY: VALUE };
        assert.strictEqual(redact(V, [`key=${VALUE}\n`]), 'key=[secret:TEST_KEY]\n');
        // One byte at a time: a value split across reads is still caught.
        const text = `a${VALUE}b${VALUE}`;
        assert.strictEqual(redact(V, [...text]), 'a[secret:TEST_KEY]b[secret:TEST_KEY]');
        assert.strictEqual(redact(V, [encodeURIComponent(`x=${VALUE}`)]).includes(VALUE), false);
        for (const prefix of ['', 'u', 'us', 'user:', 'Basic ']) {
            for (const alpha of ['base64', 'base64url']) {
                const enc = Buffer.from(`${prefix}${VALUE}`).toString(alpha);
                const out = redact(V, [enc]);
                assert.ok(out.includes('[secret:TEST_KEY]'), `${alpha} after ${JSON.stringify(prefix)}: ${out}`);
                // At most a few edge characters of a 4-char group are left.
                assert.ok(out.replace('[secret:TEST_KEY]', '').length <= enc.length - 20, out);
            }
        }
        assert.strictEqual(redact(V, [Buffer.from(VALUE).toString('hex')]), '[secret:TEST_KEY]');
        assert.strictEqual(redact(V, ['nothing to see']), 'nothing to see');
        // Longest first: a secret that contains another is replaced whole.
        assert.strictEqual(redact({ A: 'abcdefghij', B: 'abcdefghij-longer' }, ['abcdefghij-longer abcdefghij']),
            '[secret:B] [secret:A]');
        // Short values: only the raw form, which is all that is safe to match.
        assert.deepStrictEqual(formsOf('abc').map(String), ['abc']);
        ok('redaction catches the value raw, split, URL-encoded, base64 at any offset, and hex');
    }

    // --- the wrapper, end to end, against a stub bridge -------------------
    {
        const TOKEN = 'test-token-0123';
        fs.mkdirSync(path.dirname(cfg.TOKEN_FILE), { recursive: true });
        fs.writeFileSync(cfg.TOKEN_FILE, TOKEN, { mode: 0o600 });
        let seen = null;
        let reply = { status: 200, body: { values: { TEST_KEY: VALUE } } };
        const stub = http.createServer((req, res) => {
            let raw = '';
            req.on('data', c => { raw += c; });
            req.on('end', () => {
                seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
                res.writeHead(reply.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(reply.body));
            });
        });
        await new Promise(r => stub.listen(0, '127.0.0.1', r));
        const run = (command, names = ['TEST_KEY']) => new Promise((resolve) => {
            const p = spawn(process.execPath, [secrets.EXEC, ...names, '--', command], {
                cwd: wt,
                env: { ...process.env, TGXCODE_SECRETS_PORT: String(stub.address().port),
                    CLAUDE_CODE_SESSION_ID: 'sess-1234' },
            });
            let out = '';
            let err = '';
            p.stdout.on('data', c => { out += c; });
            p.stderr.on('data', c => { err += c; });
            p.on('close', code => resolve({ code, out, err }));
        });

        const r1 = await run('echo "$TEST_KEY"; printf %s "u:$TEST_KEY" | base64; echo "$TEST_KEY" >&2; exit 3');
        assert.strictEqual(r1.code, 3, 'the exit code is the command\'s');
        assert.ok(!r1.out.includes(VALUE) && !r1.err.includes(VALUE), r1.out + r1.err);
        assert.ok(!r1.out.includes(Buffer.from(`u:${VALUE}`).toString('base64')));
        assert.strictEqual(r1.out.split('\n')[0], '[secret:TEST_KEY]');
        assert.strictEqual(r1.err.trim(), '[secret:TEST_KEY]');
        assert.strictEqual(seen.path, '/api/secrets/resolve');
        assert.strictEqual(seen.auth, `Bearer ${TOKEN}`, 'fetched with the token off disk');
        assert.deepStrictEqual(seen.body, { cwd: wt, names: ['TEST_KEY'], sessionId: 'sess-1234' });
        // Quoting is the shell's job, not ours: the value is in the environment.
        const r2 = await run('[ "$TEST_KEY" = \'' + VALUE + '\' ] && echo same');
        assert.strictEqual(r2.out.trim(), 'same');
        ok('the wrapper fetches with the token, runs the command with the value in its environment, and redacts');

        const marker = path.join(TMP, 'ran');
        reply = { status: 404, body: { error: 'not set', missing: ['NOPE'] } };
        const r3 = await run(`touch ${marker}`, ['NOPE']);
        assert.strictEqual(r3.code, 1);
        assert.ok(/NOPE is not set/.test(r3.err), r3.err);
        reply = { status: 401, body: { error: 'unauthorized' } };
        const r4 = await run(`touch ${marker}`);
        assert.strictEqual(r4.code, 1);
        assert.ok(/refused/.test(r4.err), r4.err);
        assert.ok(!fs.existsSync(marker), 'a command whose secrets could not be had is not run');
        const r5 = await new Promise((resolve) => {
            const p = spawn(process.execPath, [secrets.EXEC, 'TEST_KEY', '--', `touch ${marker}`],
                { env: { ...process.env, TGXCODE_SECRETS_PORT: '' } });
            p.on('close', code => resolve(code));
        });
        assert.strictEqual(r5, 1);
        assert.ok(!fs.existsSync(marker));
        ok('a name that is not set, a refusal, or no bridge at all: the command is not run');
        stub.close();
    }

    // --- the routes ------------------------------------------------------
    {
        const asks = new secrets.SecretAsks();
        const events = [];
        asks.on('ask', p => events.push(['ask', p]));
        asks.on('resolved', p => events.push(['resolved', p]));
        let viewer = true;
        routes.init({ pool: { hasViewer: () => viewer }, secretAsks: asks });
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, 'http://x');
            const seg = url.pathname.split('/').filter(Boolean);
            const who = { remote: req.headers['x-remote'] === '1' };
            const r = await routes.handle(req, res, url, url.pathname, seg, who);
            if (typeof r === 'symbol') { res.writeHead(404); res.end('{}'); }
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const call = (method, p, body, headers = {}) => new Promise((resolve) => {
            const payload = body ? Buffer.from(JSON.stringify(body)) : null;
            const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p,
                headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
                let raw = '';
                res.on('data', c => { raw += c; });
                res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null, raw }));
            });
            if (payload) req.write(payload);
            req.end();
        });

        // Already set: answered at once, no card.
        const pre = await call('POST', '/api/secrets/ask', { sessionId: 's1', name: 'TEST_KEY', why: 'w', cwd: wt });
        assert.deepStrictEqual(pre.body, { saved: true, existed: true, name: 'TEST_KEY' });
        assert.strictEqual(events.length, 0);

        // Not set: held until answered, and the answer the tool gets is "saved".
        const pending = call('POST', '/api/secrets/ask', { sessionId: 's1', name: 'NEW_KEY', why: 'for the API', cwd: wt });
        await new Promise(r => setTimeout(r, 100));
        assert.strictEqual(asks.list().length, 1);
        const pub = asks.list()[0];
        assert.strictEqual(pub.kind, 'secret');
        assert.strictEqual(pub.name, 'NEW_KEY');
        assert.strictEqual(pub.project, repo);
        assert.strictEqual(asks.forSession('s1').id, pub.id);
        const listing = await call('GET', `/api/secrets?cwd=${encodeURIComponent(sub)}`);
        assert.strictEqual(listing.body.asks.length, 1);
        assert.strictEqual((await call('POST', `/api/secrets/asks/${pub.id}/answer`, { value: OTHER },
            { 'x-remote': '1' })).status, 403, 'not from a phone');
        assert.strictEqual((await call('POST', `/api/secrets/asks/${pub.id}/answer`, { value: '' })).status, 400);
        assert.strictEqual((await call('POST', `/api/secrets/asks/${pub.id}/answer`, { value: OTHER })).status, 200);
        const answered = await pending;
        assert.deepStrictEqual(answered.body, { saved: true, name: 'NEW_KEY' });
        assert.ok(!answered.raw.includes(OTHER), 'the tool is told it is set, never what it is');
        assert.strictEqual(secrets.get(root, 'NEW_KEY'), OTHER);
        assert.strictEqual((await call('POST', `/api/secrets/asks/${pub.id}/answer`, { value: OTHER })).status, 409);
        assert.deepStrictEqual(events.map(e => [e[0], e[1].outcome || null]), [['ask', null], ['resolved', 'saved']]);
        assert.ok(!JSON.stringify(events).includes(OTHER), 'no event carries a value');
        ok('an ask is held until answered, the value goes to the store, and the tool hears only "saved"');

        // Denied, from anywhere.
        const pending2 = call('POST', '/api/secrets/ask', { sessionId: 's2', name: 'DENY_ME', why: '', cwd: wt });
        await new Promise(r => setTimeout(r, 100));
        const id2 = asks.list()[0].id;
        assert.strictEqual((await call('POST', `/api/secrets/asks/${id2}/deny`, {}, { 'x-remote': '1' })).status, 200);
        assert.strictEqual((await pending2).body.denied, true);
        // Nobody watching: denied at once rather than waiting forever.
        viewer = false;
        const nobody = await call('POST', '/api/secrets/ask', { sessionId: 's3', name: 'LATER', why: '', cwd: wt });
        assert.strictEqual(nobody.body.denied, true);
        viewer = true;
        // The tool hanging up takes the card down.
        await new Promise((resolve) => {
            const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST',
                path: '/api/secrets/ask', headers: { 'Content-Type': 'application/json' } });
            req.on('error', () => {});
            req.end(JSON.stringify({ sessionId: 's4', name: 'GONE', why: '', cwd: wt }));
            setTimeout(() => { req.destroy(); setTimeout(resolve, 100); }, 100);
        });
        assert.strictEqual(asks.list().length, 0);
        assert.strictEqual(events[events.length - 1][1].outcome, 'cancelled');
        ok('an ask can be denied from anywhere, is denied with nobody watching, and goes when the tool does');

        const q = `cwd=${encodeURIComponent(wt)}`;
        assert.strictEqual((await call('PUT', '/api/secrets/PUT_KEY', { cwd: wt, value: 'put-value-123' })).status, 200);
        assert.strictEqual((await call('PUT', '/api/secrets/PUT_KEY', { cwd: wt, value: 'x' }, { 'x-remote': '1' })).status, 403);
        assert.strictEqual((await call('PUT', '/api/secrets/path', { cwd: wt, value: 'x' })).status, 400);
        assert.strictEqual((await call('PUT', '/api/secrets/PATH', { cwd: wt, value: 'x' })).status, 400);
        const rev = await call('POST', '/api/secrets/PUT_KEY/reveal', { cwd: wt });
        assert.deepStrictEqual(rev.body, { name: 'PUT_KEY', value: 'put-value-123' });
        assert.strictEqual((await call('POST', '/api/secrets/PUT_KEY/reveal', { cwd: wt }, { 'x-remote': '1' })).status, 403);
        assert.strictEqual((await call('POST', '/api/secrets/resolve', { cwd: wt, names: ['PUT_KEY'] },
            { 'x-remote': '1' })).status, 403);
        const res = await call('POST', '/api/secrets/resolve', { cwd: sub, names: ['PUT_KEY', 'TEST_KEY'] });
        assert.deepStrictEqual(res.body, { values: { PUT_KEY: 'put-value-123', TEST_KEY: VALUE } });
        assert.strictEqual((await call('POST', '/api/secrets/resolve', { cwd: wt, names: ['NOPE'] })).status, 404);
        const all = await call('GET', `/api/secrets?${q}`);
        assert.deepStrictEqual(all.body.secrets.map(s => s.name), ['NEW_KEY', 'PUT_KEY', 'TEST_KEY']);
        assert.ok(![VALUE, OTHER, 'put-value-123'].some(v => all.raw.includes(v)), 'the list carries no value');
        assert.strictEqual((await call('DELETE', `/api/secrets/PUT_KEY?${q}`, null, { 'x-remote': '1' })).status, 403);
        assert.strictEqual((await call('DELETE', `/api/secrets/PUT_KEY?${q}`)).status, 200);
        assert.strictEqual((await call('DELETE', `/api/secrets/PUT_KEY?${q}`)).status, 404);
        ok('set, reveal, resolve and delete are this machine\'s; the list is names only');
        server.close();
    }

    // --- nothing leaked -------------------------------------------------
    {
        // Every file this test wrote, bar the store itself: no value in any of them.
        const leaks = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (p === secrets.storeDir() || e.name === '.git') continue;
                if (e.isDirectory()) walk(p);
                else if (e.isFile()) {
                    const text = fs.readFileSync(p, 'latin1');
                    if ([VALUE, OTHER].some(v => text.includes(v))) leaks.push(p);
                }
            }
        };
        walk(TMP);
        assert.deepStrictEqual(leaks, []);
        ok('no value was written anywhere but the store');
    }

    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${passed} secrets checks passed`);
})().catch((err) => {
    console.error(err);
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
});
