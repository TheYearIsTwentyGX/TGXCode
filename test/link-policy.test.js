'use strict';

// Which chat links open in the browser preview — web/link-policy.js.
//
// No bridge needed. The cases worth pinning are the near misses: `github.com`
// must match `api.github.com` but not `notgithub.com`, `*.` must leave the bare
// domain out, a path prefix must not reach across hosts, and an empty allowlist
// must mean nothing rather than everything — the one reading of it where a
// wrong guess sends every link somewhere the user did not ask for.

const assert = require('assert');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

process.removeAllListeners('warning');

(async () => {
    const { cleanPattern, matches, opensInPreview } = await import('../web/link-policy.js');

    assert.strictEqual(cleanPattern(''), null);
    assert.strictEqual(cleanPattern('   '), null);
    assert.strictEqual(cleanPattern('# a note'), null);
    assert.strictEqual(cleanPattern('two words'), null);
    assert.strictEqual(cleanPattern('.example.com'), null);
    assert.strictEqual(cleanPattern(42), null);
    assert.deepStrictEqual(cleanPattern('HTTPS://*.Example.com/Docs'),
        { scheme: 'https', host: 'example.com', wild: true, path: '/Docs' });
    ok('cleanPattern skips blanks, comments and nonsense, and normalises the host');

    assert.ok(matches('https://github.com/x', 'github.com'));
    assert.ok(matches('https://api.github.com/x', 'github.com'), 'a subdomain is part of the site');
    assert.ok(matches('http://GitHub.COM/', 'github.com'), 'hosts compare without case');
    assert.ok(!matches('https://notgithub.com/', 'github.com'), 'a suffix is not a subdomain');
    assert.ok(!matches('https://github.com.evil.test/', 'github.com'));
    ok('a bare domain matches the host and its subdomains, and nothing that merely ends in it');

    assert.ok(matches('https://a.corp.test/', '*.corp.test'));
    assert.ok(!matches('https://corp.test/', '*.corp.test'), '*. is subdomains only');
    ok('*. leaves the bare domain out');

    assert.ok(matches('https://github.com/org/repo', 'github.com/org/'));
    assert.ok(!matches('https://github.com/other/repo', 'github.com/org/'));
    assert.ok(!matches('https://gitlab.com/org/repo', 'github.com/org/'), 'the host still has to match');
    assert.ok(matches('https://github.com/org/x', 'https://github.com/org'));
    assert.ok(!matches('http://github.com/org/x', 'https://github.com/org'), 'a scheme, given, is kept to');
    assert.ok(matches('https://x.test/a?b=1', 'x.test/a?b'), 'the query is part of the prefix');
    ok('anything with a / is a URL prefix, with an optional scheme');

    assert.ok(matches('http://localhost:5173/admin', 'localhost:5173'));
    assert.ok(!matches('http://localhost:3000/', 'localhost:5173'), 'a port given is a port kept to');
    assert.ok(matches('http://localhost:3000/', 'localhost'), 'no port matches any');
    ok('a port in a pattern is part of the host');

    assert.ok(!matches('not a url', 'github.com'));
    assert.ok(!matches('mailto:a@github.com', 'github.com'));
    assert.ok(!matches('https://github.com/', '# github.com'));
    ok('a malformed URL, another scheme or a comment matches nothing');

    const url = 'https://github.com/x';
    assert.strictEqual(opensInPreview(url, {}), false, 'off by default');
    assert.strictEqual(opensInPreview(url, { links: false, list: [] }), false);
    assert.strictEqual(opensInPreview(url, { links: true }), true, 'block mode with nothing blocked');
    assert.strictEqual(opensInPreview(url, { links: true, listMode: 'block', list: ['github.com'] }), false);
    assert.strictEqual(opensInPreview(url, { links: true, listMode: 'block', list: ['example.com'] }), true);
    assert.strictEqual(opensInPreview(url, { links: true, listMode: 'allow', list: [] }), false,
        'an empty allowlist previews nothing');
    assert.strictEqual(opensInPreview(url, { links: true, listMode: 'allow', list: ['github.com'] }), true);
    assert.strictEqual(opensInPreview('ftp://github.com/', { links: true }), false);
    assert.strictEqual(opensInPreview('javascript:alert(1)', { links: true }), false);
    ok('opensInPreview: off, block and allow, and only http(s)');

    console.log(`${pass} link-policy checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
