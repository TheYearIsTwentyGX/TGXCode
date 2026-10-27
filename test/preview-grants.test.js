'use strict';

// Which sites an agent may drive in the preview, and the user's answers
// (app/preview-grants.js).
//
// The rules here are the user's consent, so each is pinned: loopback needs no
// asking; Allow once lasts the run and Always lasts until it is removed from the
// setting; a Deny is not asked again for a while; an ask never answers itself,
// however long it waits, and ends only on an answer or when everybody who asked
// has gone; two asks for one site are one prompt; a link or redirect is gated
// only while an agent is driving. And the refusal texts, word for word, because
// an agent reads them and the orchestrating session forwards them.

const assert = require('assert');
const { PreviewGrants, TEXT, cleanOrigin, MAX_SESSION, MAX_ALWAYS, DENY_MS, RENOTIFY_MS } = require('../app/preview-grants');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

/** A grant store on a clock and timers this test moves by hand. */
function store() {
    let now = 1_000_000;
    const timers = new Set();
    const g = new PreviewGrants({
        now: () => now,
        setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.add(t); return t; },
        clearTimer: (t) => timers.delete(t),
    });
    g.advance = (ms) => {
        now += ms;
        for (const t of [...timers].sort((x, y) => x.at - y.at)) {
            if (t.at <= now && timers.delete(t)) t.fn();
        }
    };
    return g;
}

const flush = () => new Promise(r => setImmediate(r));

(async () => {
    // ── grants ────────────────────────────────────────────────────────────
    {
        const g = store();
        for (const u of ['http://localhost:5173/', 'http://127.0.0.1:3000/x', 'https://[::1]:8443/']) {
            assert.ok(g.isGranted(u), u);
        }
        assert.ok(!g.isGranted('https://pcpartpicker.com/'));
        assert.ok(!g.isGranted('file:///etc/passwd'));
        assert.ok(g.grantSession('https://pcpartpicker.com'));
        assert.ok(g.isGranted('https://pcpartpicker.com/list/abc'), 'once covers the whole origin');
        assert.ok(!g.isGranted('http://pcpartpicker.com/'), 'but not the other scheme');
        assert.ok(!g.isGranted('https://www.pcpartpicker.com/'), 'nor a subdomain');
        assert.ok(!g.grantSession('https://pcpartpicker.com/path'), 'an origin, exactly');
        ok('loopback is free; a grant is for one origin exactly');

        g.setAlways(['https://amazon.com', 'not a url', 'https://x.example/path']);
        assert.ok(g.isGranted('https://amazon.com/dp/1'));
        assert.deepStrictEqual([...g.always], ['https://amazon.com'], 'bad entries in the setting are dropped');
        g.setAlways([]);
        assert.ok(!g.isGranted('https://amazon.com/'), 'removed from the setting, removed here');
        assert.ok(g.isGranted('https://pcpartpicker.com/'), 'and a grant for this run is untouched');
        ok('always comes from the setting, and removing it there takes it back');

        const full = store();
        for (let i = 0; i < MAX_SESSION; i++) assert.ok(full.grantSession(`https://s${i}.example`));
        assert.ok(!full.grantSession('https://one-more.example'), 'the run\'s grants are capped');
        full.setAlways(Array.from({ length: MAX_ALWAYS + 5 }, (_, i) => `https://a${i}.example`));
        assert.strictEqual(full.always.size, MAX_ALWAYS, 'and so is the always list');
        assert.strictEqual(cleanOrigin('https://ok.example'), 'https://ok.example');
        assert.strictEqual(cleanOrigin('https://ok.example/'), null);
        ok('both lists are capped');
    }

    // ── the texts ────────────────────────────────────────────────────────
    {
        const g = store();
        const url = 'https://example.com/';
        assert.strictEqual(g.navigationRefusal(url),
            'Navigation to https://example.com/ blocked: example.com is not approved for agent control in the TGXCode preview. '
            + 'The user has been asked to approve it, and the prompt stays open until they answer — wait for their answer and '
            + 'retry, or call open_in_preview with the URL, which waits for the decision.');
        assert.strictEqual(g.list().length, 1, 'the refusal raised the prompt');
        g.answer('https://example.com', 'deny');
        assert.strictEqual(g.navigationRefusal(url),
            'Navigation to https://example.com/ blocked: the user denied example.com for agent control.');
        assert.strictEqual(g.list().length, 0, 'a denied site is not asked about again');
        assert.strictEqual(g.navigationRefusal('http://localhost:5173/'), null);
        assert.strictEqual(g.navigationRefusal('about:blank'), null);
        assert.strictEqual(TEXT.notWeb('file:///c:/x'), g.navigationRefusal('file:///c:/x'));
        assert.match(g.navigationRefusal('http://shop.example:8080/a'), /blocked: shop\.example:8080 is not approved/);
        ok('the refusal texts are exactly as specified, and a refusal raises the prompt');

        g.advance(DENY_MS + 1);
        assert.match(g.navigationRefusal(url), /is not approved/, 'a deny expires, and the site may be asked about again');
        ok('a Deny holds for a while, then the agent may ask again');
    }

    // ── asks ─────────────────────────────────────────────────────────────
    {
        const g = store();
        const notes = [];
        g.on('notify', a => notes.push(a));
        const first = g.ask('https://pcpartpicker.com/list', { requester: 'session:A', open: 'https://pcpartpicker.com/list' });
        assert.deepStrictEqual([first.state, first.origin, first.existed, first.repeat],
            ['asking', 'https://pcpartpicker.com', false, false]);
        const second = g.ask('https://pcpartpicker.com/other', { requester: 'cdp' });
        assert.ok(second.existed && !second.repeat);
        assert.strictEqual(g.list().length, 1, 'two requests for one origin are one prompt');
        assert.strictEqual(g.list()[0].open, 'https://pcpartpicker.com/list', 'the first page asked for is the one opened');
        assert.strictEqual(notes.length, 1, 'and one notification');
        const again = g.ask('https://pcpartpicker.com/list', { requester: 'session:A', open: 'https://pcpartpicker.com/list' });
        assert.ok(again.repeat, 'the same open_in_preview again is told where things stand');
        ok('requests for one origin merge into one ask');

        // A wait times out; the ask does not.
        const waited = g.wait('https://pcpartpicker.com', 60_000);
        g.advance(60_001);
        assert.strictEqual(await waited, 'waiting');
        g.advance(5 * 60 * 60_000);
        assert.strictEqual(g.list().length, 1, 'five hours later the prompt is still open');
        assert.strictEqual(notes.length, 2, 'it was announced once more after ten minutes');
        assert.strictEqual(notes[1].notified, 2);
        ok('an ask never answers itself; a caller\'s wait does, and the reminder comes once');

        const pending = g.wait('https://pcpartpicker.com', 60_000);
        const r = g.answer('https://pcpartpicker.com', 'once');
        assert.deepStrictEqual(r, { ok: true, open: 'https://pcpartpicker.com/list' }, 'the yes hands back the page to open');
        assert.strictEqual(await pending, 'once');
        assert.ok(g.isGranted('https://pcpartpicker.com/x'));
        assert.strictEqual(g.list().length, 0);
        assert.strictEqual(g.ask('https://pcpartpicker.com/y').state, 'granted');
        ok('Allow once opens the page asked for and grants the origin for the run');

        g.ask('https://amazon.com/dp/1', { requester: 'session:B', open: 'https://amazon.com/dp/1' });
        const w2 = g.wait('https://amazon.com', 60_000);
        g.answer('https://amazon.com', 'always');
        assert.strictEqual(await w2, 'always');
        assert.ok(g.always.has('https://amazon.com'));
        g.ask('https://ebay.com/', { requester: 'session:B', open: 'https://ebay.com/' });
        const w3 = g.wait('https://ebay.com', 60_000);
        assert.deepStrictEqual(g.answer('https://ebay.com', 'deny'), { ok: true, open: null });
        assert.strictEqual(await w3, 'deny');
        assert.strictEqual(g.ask('https://ebay.com/', { requester: 'session:B' }).state, 'denied');
        assert.strictEqual(g.answer('https://ebay.com', 'maybe').ok, false);
        ok('Always allow and Deny resolve the wait and are remembered');
    }

    // ── an ask ends when everybody who asked has gone ────────────────────
    {
        const g = store();
        g.ask('https://a.example/', { requester: 'session:A', open: 'https://a.example/' });
        g.ask('https://a.example/', { requester: 'cdp' });
        const w = g.wait('https://a.example', 60_000);
        g.dropRequester('session:A');
        assert.strictEqual(g.list().length, 1, 'still wanted by the connected agent');
        g.dropRequester('cdp');
        assert.strictEqual(g.list().length, 0);
        assert.strictEqual(await w, 'gone');
        g.ask('https://b.example/', { requester: 'session:Z' });
        g.dropRequester('session:other');
        assert.strictEqual(g.list().length, 1, 'somebody else going changes nothing');
        ok('an ask ends when the sessions that asked have all gone away');
    }

    // ── links and redirects: gated only while an agent drives ────────────
    {
        const g = store();
        assert.strictEqual(g.linkDecision('https://example.com/', false), 'external', 'nobody driving: the browser, as always');
        assert.strictEqual(g.linkDecision('mailto:x@example.com', false), 'blocked');
        assert.strictEqual(g.linkDecision('http://localhost:5173/a', false), 'allow');
        assert.strictEqual(g.list().length, 0, 'and nobody was asked');
        assert.strictEqual(g.redirectDecision('https://example.com/', false, true), 'allow', 'a redirect is left alone');
        assert.strictEqual(g.popupDecision('https://example.com/', false), 'external');

        assert.strictEqual(g.linkDecision('https://example.com/', true), 'blocked', 'driving: stopped');
        assert.strictEqual(g.list().length, 1, 'and asked about');
        assert.strictEqual(g.redirectDecision('https://other.example/', true, true), 'blocked');
        assert.strictEqual(g.redirectDecision('https://frame.example/', true, false), 'allow', 'only the top level');
        assert.strictEqual(g.popupDecision('https://popup.example/', true), 'blocked');
        assert.deepStrictEqual(g.list().map(a => a.host), ['example.com', 'other.example', 'popup.example']);
        g.answer('https://example.com', 'once');
        assert.strictEqual(g.linkDecision('https://example.com/next', true), 'allow');
        assert.strictEqual(g.popupDecision('https://example.com/new', true), 'load', 'an approved popup loads in place');
        ok('a link, redirect or popup is gated only while an agent is driving the page');
    }

    await flush();
    console.log(`\n${pass} preview-grants checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
