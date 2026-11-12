'use strict';

// GET /api/file-search — the composer's `@` file menu, over HTTP.
//
//   node test/file-search-route.test.js [port]
//
// Wants a live bridge (npm test starts one). What is pinned that the unit test
// cannot see: the roots rule, which holds for a path *and* for a session, that a
// remote caller may read it (it is a read, like GET /api/fs), the 400/404 shapes,
// and that the limit is capped.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.argv[2] || 45901);
const TOKEN = fs.readFileSync(path.join(os.homedir(), '.local/share/tgxcode/token'), 'utf8').trim();
const LOCAL = { authorization: `Bearer ${TOKEN}`, 'X-Claude-Sessions-Client': '1' };
const PHONE = {
    ...LOCAL,
    'x-forwarded-for': '100.88.1.2',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'tgdylanh.tail1234.ts.net',
};

function get(p, headers = LOCAL) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path: p, headers }, (res) => {
            const c = [];
            res.on('data', (x) => c.push(x));
            res.on('end', () => {
                let body = null;
                try { body = JSON.parse(Buffer.concat(c).toString('utf8')); } catch { /* not json */ }
                resolve({ status: res.statusCode, body });
            });
        }).on('error', reject);
    });
}

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// Under $HOME, because that is where the default roots are; the scratch directory in
// /tmp is exactly the sort of place the roots rule is meant to refuse.
const repo = fs.mkdtempSync(path.join(os.homedir(), '.tgx-file-search-route-'));
const put = (rel) => {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
};

(async () => {
    try {
        execFileSync('git', ['-C', repo, 'init', '-q']);
        fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
        put('src/mentions.js');
        put('src/other/mentions-test.js');
        put('dist/mentions.js');
        put('README.md');
        const q = (extra) => `/api/file-search?cwd=${encodeURIComponent(repo)}&${extra}`;

        let r = await get(q('q=mentions'));
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.results.map(x => x.path), ['src/mentions.js', 'src/other/mentions-test.js'],
            'ranked, and .gitignore respected');
        assert.strictEqual(r.body.git, true);
        assert.strictEqual(r.body.truncated, false);
        assert.strictEqual(r.body.cwd, repo);
        assert.deepStrictEqual(r.body.results[0],
            { path: 'src/mentions.js', name: 'mentions.js', parent: 'src', isDirectory: false });
        ok('ranks, respects .gitignore, and returns the documented row shape');

        r = await get(q('q='));
        assert.deepStrictEqual(r.body.results.map(x => x.path), ['src', '.gitignore', 'README.md'], 'a bare query is the top of the tree');
        r = await get(q('q=src%2F'));
        assert.deepStrictEqual(r.body.results.map(x => x.path), ['src/other', 'src/mentions.js']);
        ok('bare and trailing-slash queries browse');

        r = await get(q('q=s&limit=1'));
        assert.strictEqual(r.body.results.length, 1);
        r = await get(q('q=s&limit=100000'));
        assert.ok(r.status === 200 && r.body.results.length <= 100, 'limit is capped at 100');
        r = await get(q('q=s&limit=-3'));
        assert.ok(r.body.results.length > 1, 'a bad limit falls back to the default');
        ok('limit is bounded');

        r = await get(`/api/file-search?cwd=${encodeURIComponent('~/' + path.basename(repo))}&q=readme`);
        assert.deepStrictEqual(r.body.results.map(x => x.path), ['README.md'], 'a leading ~ means $HOME');
        ok('~ is expanded');

        r = await get(q('q=mentions'), PHONE);
        assert.strictEqual(r.status, 200, 'a remote caller may read it, like GET /api/fs');
        ok('readable remotely');

        r = await get('/api/file-search?cwd=%2Fetc&q=passwd');
        assert.strictEqual(r.status, 403);
        assert.ok(Array.isArray(r.body.roots), 'the refusal names the roots');
        r = await get('/api/file-search?cwd=%2F&q=etc', PHONE);
        assert.strictEqual(r.status, 403);
        r = await get(`/api/file-search?cwd=${encodeURIComponent(path.join(repo, '..', '..', '..', 'etc'))}&q=x`);
        assert.strictEqual(r.status, 403, '.. does not climb out of the roots');
        ok('outside the allowed roots is refused, for local and remote callers');

        r = await get('/api/file-search?q=x');
        assert.strictEqual(r.status, 400);
        r = await get('/api/file-search?session=00000000-0000-0000-0000-000000000000&q=x');
        assert.strictEqual(r.status, 404);
        r = await get(`/api/file-search?cwd=${encodeURIComponent(path.join(repo, 'nope'))}&q=x`);
        assert.strictEqual(r.status, 404);
        r = await get(`/api/file-search?cwd=${encodeURIComponent(path.join(repo, 'README.md'))}&q=x`);
        assert.strictEqual(r.status, 404, 'a file is not a directory');
        ok('400 with no target, 404 for an unknown session, a missing directory or a file');
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
    console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
