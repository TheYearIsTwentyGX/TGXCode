'use strict';

// Exercises bridge/auth.js against the caller shapes that actually reach the
// bridge: the Electron shell, a WSL-side curl, a page on another origin, a phone
// behind `tailscale serve`, and a LAN client.

const assert = require('assert');
const auth = require('../bridge/auth.js');

const token = auth.ensureToken();
assert.ok(token && token.length === 43, `expected a 43-char base64url token, got ${token && token.length}`);

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

/** Build a fake request. `addr` is the peer address; `headers` are lowercase. */
function req(addr, headers = {}) {
    return { socket: { remoteAddress: addr }, headers };
}
const u = (q = '') => new URL(`http://127.0.0.1/api/sessions${q}`);

// --- token matching -------------------------------------------------------
assert.strictEqual(auth.tokenMatches(token), true);
assert.strictEqual(auth.tokenMatches(token + 'x'), false);
assert.strictEqual(auth.tokenMatches(token.slice(0, -1)), false);
assert.strictEqual(auth.tokenMatches(''), false);
assert.strictEqual(auth.tokenMatches(null), false);
assert.strictEqual(auth.tokenMatches(undefined), false);
// Same length, different content — the case timingSafeEqual actually exists for.
assert.strictEqual(auth.tokenMatches('A'.repeat(token.length)), false);
ok('tokenMatches accepts only the exact token');

// --- credential extraction ------------------------------------------------
const creds = (headers, q = '') => auth.credentials(req('127.0.0.1', headers), u(q));
assert.deepStrictEqual(creds({ authorization: `Bearer ${token}` }), [token]);
assert.deepStrictEqual(creds({ authorization: `bearer   ${token}` }), [token]);
assert.deepStrictEqual(creds({}, `?token=${token}`), [token]);
assert.deepStrictEqual(creds({ cookie: `cs_token=${token}` }), [token]);
assert.deepStrictEqual(creds({ cookie: `other=1; cs_token=${token}; x=2` }), [token]);
assert.deepStrictEqual(creds({}), []);
assert.deepStrictEqual(
    creds({ authorization: 'Bearer HEADER', cookie: 'cs_token=COOKIE' }, '?token=QUERY'),
    ['HEADER', 'QUERY', 'COOKIE'], 'all three are collected, in header/query/cookie order');
ok('credentials collects the header, the query and the cookie');

// Any one being valid is enough. The case that matters: a paired phone opening a
// pairing link from before the token rotated — stale query, good cookie.
const authed = (headers, q = '') => auth.authenticate(req('127.0.0.1', headers), u(q));
assert.strictEqual(authed({ cookie: `cs_token=${token}` }, '?token=stale'), true,
    'a stale ?token= must not shadow a valid cookie');
assert.strictEqual(authed({ cookie: 'cs_token=stale' }, `?token=${token}`), true,
    'a fresh ?token= must re-pair past a stale cookie');
assert.strictEqual(authed({ authorization: 'Bearer wrong', cookie: `cs_token=${token}` }), true);
assert.strictEqual(authed({ cookie: 'cs_token=stale' }, '?token=alsostale'), false);
assert.strictEqual(authed({}), false);
ok('authenticate accepts any one valid credential');

// --- loopback -------------------------------------------------------------
for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
    assert.strictEqual(auth.isLoopback(req(addr)), true, addr);
}
for (const addr of ['10.11.64.99', '192.168.1.5', '100.101.102.103', undefined]) {
    assert.strictEqual(auth.isLoopback(req(addr)), false, String(addr));
}
ok('isLoopback covers 127.0.0.0/8 and both v6 spellings');

// --- classification: the real callers ------------------------------------

// The Electron shell, and a WSL-side curl. Must be local, or the desk loses
// powers it has always had.
let c = auth.classify(req('127.0.0.1', { host: '127.0.0.1:45888' }), u());
assert.strictEqual(c.remote, false, 'Electron shell must classify local');
c = auth.classify(req('::ffff:127.0.0.1', { host: 'localhost:45899' }), u());
assert.strictEqual(c.remote, false, 'localhost dev bridge must classify local');
ok('the Electron shell and a local curl classify as local');

// A phone behind `tailscale serve`: loopback socket, forwarding headers, ts.net Host.
c = auth.classify(req('127.0.0.1', {
    host: '127.0.0.1:45888',
    'x-forwarded-for': '100.88.1.2',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'tgdylanh.tail1234.ts.net',
}), u());
assert.strictEqual(c.remote, true, 'tailscale serve must classify remote');
assert.strictEqual(c.secure, true);
assert.strictEqual(c.host, 'tgdylanh.tail1234.ts.net');
assert.strictEqual(c.peer, '100.88.1.2', 'peer should be the phone, not 127.0.0.1');
ok('a phone behind tailscale serve classifies remote, secure, with its own address');

// Same, but the proxy has stopped setting every x-forwarded-* header. The Host
// signal alone must still say remote — this is the fail-safe that matters.
c = auth.classify(req('127.0.0.1', { host: 'tgdylanh.tail1234.ts.net' }), u());
assert.strictEqual(c.remote, true, 'a ts.net Host alone must classify remote');
assert.strictEqual(c.secure, true, 'a ts.net name implies HTTPS');
ok('a ts.net Host alone is enough to classify remote');

// And the converse: forwarding headers alone, with a local Host.
c = auth.classify(req('127.0.0.1', { host: '127.0.0.1:45888', 'x-forwarded-for': '203.0.113.9' }), u());
assert.strictEqual(c.remote, true, 'forwarding headers alone must classify remote');
ok('forwarding headers alone are enough to classify remote');

// A LAN client against a 0.0.0.0 bind.
c = auth.classify(req('10.11.64.99', { host: '10.11.64.43:45888' }), u());
assert.strictEqual(c.remote, true);
assert.strictEqual(c.secure, false, 'plain HTTP on the LAN must not get a Secure cookie');
assert.strictEqual(c.peer, '10.11.64.99');
ok('a LAN client classifies remote and insecure');

// Forgery attempt: an off-machine caller sets its own x-forwarded-for to look
// like it is the proxy. It must not gain anything — still remote either way.
c = auth.classify(req('10.11.64.99', { host: '10.11.64.43', 'x-forwarded-for': '127.0.0.1' }), u());
assert.strictEqual(c.remote, true, 'a spoofed x-forwarded-for must not buy local status');
assert.strictEqual(auth.forwarded(req('10.11.64.99', { 'x-forwarded-for': '127.0.0.1' })), false,
    'forwarding headers are only trusted from loopback');
ok('spoofed forwarding headers from off-machine buy nothing');

// --- localPageRequest: the condition for handing over the token -----------
assert.strictEqual(auth.localPageRequest(req('127.0.0.1', { host: '127.0.0.1:45888' })), true);
// A fetch from a page on another origin arrives on loopback but carries Origin.
assert.strictEqual(
    auth.localPageRequest(req('127.0.0.1', { host: '127.0.0.1:45888', origin: 'http://evil.example' })),
    false, 'a cross-origin fetch must never be handed the token');
// A phone must never be handed the token in the page.
assert.strictEqual(
    auth.localPageRequest(req('127.0.0.1', { host: 'x.ts.net', 'x-forwarded-for': '100.1.1.1' })),
    false, 'a proxied request must never be handed the token');
assert.strictEqual(auth.localPageRequest(req('10.11.64.99', { host: '10.11.64.43' })), false);
ok('localPageRequest is true only for a local navigation to our own page');

// --- injectToken ----------------------------------------------------------
const html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n</head>\n<body></body>\n</html>';
const injected = auth.injectToken(html);
assert.ok(injected.includes(`<meta name="cs-token" content="${token}">`));
assert.ok(injected.indexOf('cs-token') < injected.indexOf('<meta charset'),
    'the token tag must precede other head content so early scripts can read it');
assert.strictEqual(auth.injectToken(injected), injected, 'injectToken must be idempotent');
ok('injectToken inserts once, at the top of head');

// --- pairCookie -----------------------------------------------------------
const setCookie = auth.pairCookie(token, { secure: true });
assert.ok(setCookie.includes('HttpOnly'));
assert.ok(setCookie.includes('SameSite=Lax'));
assert.ok(setCookie.includes('Secure'));
assert.ok(setCookie.includes('Max-Age=31536000'));
assert.ok(!auth.pairCookie(token, { secure: false }).includes('Secure'));
assert.ok(auth.pairCookie('', { secure: false }).includes('Max-Age=0'), 'clearing must expire the cookie');
ok('pairCookie sets HttpOnly/Lax, and Secure only over HTTPS');

console.log(`\n${pass} groups passed`);
