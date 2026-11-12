'use strict';

// File search for the composer's `@` menu — bridge/file-search.js.
//
// No bridge needed. Pinned here: the ranking (basename before path segments before
// fuzzy), that a git work tree is listed through git so .gitignore is respected,
// that the non-git walk skips the heavy directories, and that the caps hold — a
// huge tree must come back bounded and say so, not stall.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const fsearch = require('../bridge/file-search');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-fsearch-'));
const put = (root, rel, body = 'x') => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
};
const paths = (r) => r.results.map(x => x.path);

(async () => {
    // ── ranking, on a hand-made list ─────────────────────────────────────────
    const E = (list) => list.map(p => ({ path: p, isDirectory: p.endsWith('/') ? true : false }))
        .map(e => ({ ...e, path: e.path.replace(/\/$/, '') }));
    const entries = E([
        'web/', 'web/composer/', 'web/composer/mentions.js', 'web/composer/slash.js', 'web/app.js',
        'docs/', 'docs/mentions-plan.md', 'src/', 'src/utils/', 'src/utils/index.js', 'index.js',
        'notes/', 'notes/composer-notes.txt', 'a/b/c/deep-mention-thing.txt',
    ]);
    const top = (q, n = 50) => fsearch.rank(entries, q, n).map(e => e.path);

    assert.deepStrictEqual(top('index.js').slice(0, 2), ['index.js', 'src/utils/index.js'],
        'an exact basename wins, and the shallower of two ties wins');
    // Both are basename prefixes for `mentions`; the shallower wins the tie.
    assert.deepStrictEqual(top('mentions').slice(0, 2), ['docs/mentions-plan.md', 'web/composer/mentions.js']);
    // basename prefix (900) > basename contains (800)
    const q = top('mention');
    assert.ok(q.indexOf('web/composer/mentions.js') < q.indexOf('a/b/c/deep-mention-thing.txt'),
        'prefix of the basename ranks above a match in the middle of it');
    ok('basename matches rank first');

    // A directory whose own name matches outranks the files inside it, which only match by segment.
    assert.strictEqual(top('composer')[0], 'web/composer', 'the directory is the better answer than its files');
    assert.ok(top('composer').indexOf('web/composer/slash.js') > top('composer').indexOf('notes/composer-notes.txt'),
        'a basename containing the query beats a file that is only under a matching directory');
    ok('a directory outranks the files it holds; basename beats segment');

    assert.ok(top('utils').includes('src/utils/index.js'), 'a path segment match finds files below it');
    assert.ok(top('utils').indexOf('src/utils') < top('utils').indexOf('src/utils/index.js'));
    ok('path segments match');

    assert.ok(top('mnts').includes('web/composer/mentions.js'), 'fuzzy subsequence on the basename');
    assert.ok(!top('zzzq').length, 'no match is no rows');
    assert.ok(top('wcs').includes('web/composer/slash.js'), 'fuzzy subsequence on the whole path');
    ok('fuzzy subsequence is the last resort');

    assert.deepStrictEqual(top('web/comp').slice(0, 1), ['web/composer'], 'a typed path prefix');
    assert.ok(top('w/c/sl').includes('web/composer/slash.js'), 'segment-wise prefixes');
    ok('a query with a slash matches the path');

    assert.deepStrictEqual(top(''), ['web', 'docs', 'src', 'notes', 'index.js'].sort((a, b) =>
        (Number(!b.includes('.')) - Number(!a.includes('.'))) || a.localeCompare(b)),
    'a bare query lists the top of the tree, directories first');
    assert.deepStrictEqual(top('web/'), ['web/composer', 'web/app.js'], 'a trailing slash lists the children');
    assert.deepStrictEqual(top('WEB/composer/'), ['web/composer/mentions.js', 'web/composer/slash.js']);
    ok('empty and trailing-slash queries browse');

    assert.strictEqual(fsearch.rank(entries, 'e', 3).length, 3, 'limit is honoured');
    assert.deepStrictEqual(top('MENTIONS.JS'), top('mentions.js'), 'case is ignored');
    ok('limit and case');

    // Recency only breaks ties between equal scores.
    const tie = [{ path: 'a/x.js', isDirectory: false }, { path: 'b/x.js', isDirectory: false }];
    assert.deepStrictEqual(fsearch.rank(tie, 'x.js', 5, new Map([['b/x.js', 20], ['a/x.js', 10]])).map(e => e.path),
        ['b/x.js', 'a/x.js']);
    assert.deepStrictEqual(fsearch.rank(tie, 'x.js', 5).map(e => e.path), ['a/x.js', 'b/x.js']);
    ok('recency breaks ties and nothing else');

    // ── git: .gitignore is respected, deleted files are not offered ──────────
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a],
        { stdio: 'pipe' });
    git('init', '-q');
    put(repo, '.gitignore', 'build/\n*.log\nnode_modules/\n');
    put(repo, 'src/app.js');
    put(repo, 'src/my file.js');
    put(repo, 'src/gone.js');
    put(repo, 'build/out.js');
    put(repo, 'debug.log');
    put(repo, 'node_modules/pkg/index.js');
    put(repo, 'untracked.txt');
    git('add', '.gitignore', 'src');
    git('commit', '-q', '-m', 'init');
    fs.unlinkSync(path.join(repo, 'src/gone.js'));

    fsearch.forget();
    let r = await fsearch.search(repo, 'js');
    assert.ok(r.git, 'a work tree is listed through git');
    assert.ok(paths(r).includes('src/app.js'));
    assert.ok(!paths(r).some(p => p.startsWith('build') || p.startsWith('node_modules')), 'ignored directories are absent');
    assert.ok(!paths(r).includes('debug.log'), 'ignored files are absent');
    assert.ok(!paths(r).includes('src/gone.js'), 'a tracked file deleted from disk is not offered');
    r = await fsearch.search(repo, 'untracked');
    assert.deepStrictEqual(paths(r), ['untracked.txt'], 'untracked, not ignored, files are offered');
    r = await fsearch.search(repo, 'src/');
    assert.deepStrictEqual(paths(r).sort(), ['src/app.js', 'src/my file.js']);
    assert.ok(paths(await fsearch.search(repo, 'src')).includes('src'), 'directories are offered');
    const dirRow = (await fsearch.search(repo, 'src')).results.find(x => x.path === 'src');
    assert.deepStrictEqual(dirRow, { path: 'src', name: 'src', parent: '', isDirectory: true });
    const fileRow = (await fsearch.search(repo, 'my file')).results[0];
    assert.deepStrictEqual(fileRow, { path: 'src/my file.js', name: 'my file.js', parent: 'src', isDirectory: false });
    ok('git listing respects .gitignore, deletions, untracked files and spaces');

    // A subdirectory of a repo is listed relative to itself.
    r = await fsearch.search(path.join(repo, 'src'), '');
    assert.deepStrictEqual(paths(r).sort(), ['app.js', 'my file.js']);
    ok('a subdirectory of a repo lists relative to itself');

    // ── cache: a short TTL, and forget() ─────────────────────────────────────
    put(repo, 'fresh.txt');
    assert.ok(!paths(await fsearch.search(repo, 'fresh')).length, 'inside the TTL the listing is cached');
    fsearch.forget(repo);
    assert.deepStrictEqual(paths(await fsearch.search(repo, 'fresh')), ['fresh.txt'], 'forget() drops it');
    const stale = await fsearch.listEntries(repo, Date.now() + fsearch.TTL_MS + 1000);
    assert.ok(stale.entries.length, 'listEntries after the TTL is still an answer');
    ok('listings are cached per directory');

    // ── not git: a bounded walk that skips the heavy directories ─────────────
    const plain = path.join(tmp, 'plain');
    put(plain, 'notes.md');
    put(plain, 'docs/guide.md');
    put(plain, 'node_modules/x/index.js');
    put(plain, 'Library/Cache/big.bin');
    put(plain, '.git/config');
    put(plain, '.github/workflows/ci.yml');
    fs.symlinkSync(path.join(repo), path.join(plain, 'linked'));
    fsearch.forget();
    r = await fsearch.search(plain, '');
    assert.ok(!r.git && !r.truncated);
    assert.deepStrictEqual(paths(r).sort(), ['.github', 'docs', 'linked', 'notes.md']);
    const deep = paths(await fsearch.search(plain, 'ci.yml'));
    assert.deepStrictEqual(deep, ['.github/workflows/ci.yml'], 'dot-directories other than .git are walked');
    assert.ok(!paths(await fsearch.search(plain, 'index')).length, 'node_modules is skipped');
    assert.ok(!paths(await fsearch.search(plain, 'big')).length, 'Library is skipped');
    assert.ok(!paths(await fsearch.search(plain, 'config')).length, '.git is skipped');
    assert.deepStrictEqual(paths(await fsearch.search(plain, 'linked/')), ['linked'], 'a symlinked directory is listed but not entered');
    ok('the walk skips node_modules, .git and Library, and does not follow symlinks');

    // ── caps ─────────────────────────────────────────────────────────────────
    const big = path.join(tmp, 'big');
    fs.mkdirSync(big);
    for (let i = 0; i < 30; i++) {
        const d = path.join(big, `d${i}`);
        fs.mkdirSync(d);
        for (let j = 0; j < 40; j++) fs.writeFileSync(path.join(d, `file${j}.txt`), '');
    }
    fsearch.forget();
    r = await fsearch.search(big, 'file', 50);
    assert.strictEqual(r.results.length, 50, 'results are capped at the limit');
    assert.ok(!r.truncated, '1,230 entries is under the walk cap');
    assert.ok((await fsearch.search(big, 'file', 5)).results.length === 5);
    ok('results are capped');

    // Past the walk cap for real: more entries than MAX_WALK, kept cheap as empty files.
    const huge = path.join(tmp, 'huge');
    fs.mkdirSync(huge);
    const per = 500;
    const dirs = Math.ceil((fsearch.MAX_WALK + 2000) / per);
    for (let i = 0; i < dirs; i++) {
        const d = path.join(huge, `g${String(i).padStart(3, '0')}`);
        fs.mkdirSync(d);
        for (let j = 0; j < per; j++) fs.writeFileSync(path.join(d, `f${j}`), '');
    }
    fsearch.forget();
    const t1 = Date.now();
    r = await fsearch.search(huge, 'f1', 50);
    assert.ok(r.truncated, 'a tree past the walk cap is reported as truncated');
    assert.ok(r.results.length <= 50);
    assert.ok(Date.now() - t1 < 5000, 'and it returns promptly');
    const listing = await fsearch.listEntries(huge);
    assert.ok(listing.entries.length <= fsearch.MAX_WALK + 1, 'the walk stops at its cap');
    // Breadth-first: the top level is all there even though the depth was cut.
    assert.strictEqual(listing.entries.filter(e => !e.path.includes('/')).length, dirs);
    ok('a huge tree is cut at the walk cap, reported truncated, top level intact');

    // ── errors ───────────────────────────────────────────────────────────────
    await assert.rejects(fsearch.search(path.join(tmp, 'nope'), 'x'));
    await assert.rejects(fsearch.search(path.join(plain, 'notes.md'), 'x'));
    ok('a missing path or a file is an error, not an empty answer');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${pass} passed`);
})().catch((e) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.error(e);
    process.exit(1);
});
