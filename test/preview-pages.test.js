'use strict';

// The preview's pages (web/preview-pages.js): what the address bar shows, what
// typing in it means, the list of pages, and which pages keep-alive must leave
// alone. Then the keep-alive itself, in a real PreviewPane (web/preview.js) over
// a stub DOM — the pin is only worth anything if the clock actually honours it,
// and a page dropped under an agent fails nowhere you are looking.

const assert = require('assert');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Enough of a page for web/preview.js to load and hold iframes in node.
function fakeNode(tag = 'div') {
    const classes = new Set();
    return {
        tag, hidden: false, disabled: false, title: '', textContent: '', value: '', src: '',
        style: {}, dataset: {}, removed: false,
        classList: {
            add: (c) => classes.add(c), remove: (c) => classes.delete(c),
            toggle: (c, on) => (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c),
            contains: (c) => classes.has(c),
        },
        setAttribute() {}, addEventListener() {}, append() {}, remove() { this.removed = true; },
        select() {}, blur() {}, focus() {},
    };
}
function installDom() {
    globalThis.window = {};
    // The bridge on 127.0.0.1, so the pane's own loopback name is localhost.
    globalThis.location = { hostname: '127.0.0.1' };
    globalThis.HTMLUnknownElement = class {};
    globalThis.document = { createElement: (t) => fakeNode(t), activeElement: null };
    globalThis.ResizeObserver = class { observe() {} };
}
function paneRoot() {
    const nodes = new Map();
    return {
        querySelector: (sel) => { if (!nodes.has(sel)) nodes.set(sel, fakeNode()); return nodes.get(sel); },
        querySelectorAll: () => [],
        addEventListener() {},
    };
}

(async () => {
    const {
        displayAddress, parseAddress, pinnedPage, pageRows, agentAway,
    } = await import('../web/preview-pages.js');

    // ── the address bar's rule ──
    const shows = {
        'https://pcpartpicker.com/': 'pcpartpicker.com',
        'https://pcpartpicker.com/list/?q=gpu#top': 'pcpartpicker.com/list/?q=gpu#top',
        'https://example.com:8443/a': 'example.com:8443/a',
        'http://example.com/': 'http://example.com',
        'http://example.com/a?b=1': 'http://example.com/a?b=1',
        'http://localhost:5173/': 'localhost:5173',
        'http://localhost:5173/admin?tab=2': 'localhost:5173/admin?tab=2',
        'http://127.0.0.1:3000/x': '127.0.0.1:3000/x',
        'http://[::1]:8080/': '[::1]:8080',
        'https://localhost:5173/': 'localhost:5173',
    };
    for (const [url, want] of Object.entries(shows)) assert.strictEqual(displayAddress(url), want, url);
    ok('https is left off, http is shown only off loopback, a bare / is dropped');
    assert.strictEqual(displayAddress('about:blank'), 'about:blank');
    assert.strictEqual(displayAddress('not a url'), 'not a url');
    ok('anything that is not http(s) is shown as it is');

    // ── what typing means ──
    const here = 'https://pcpartpicker.com/builds/1';
    const t = (text, cur = here) => parseAddress(text, cur, '127.0.0.1');
    assert.deepStrictEqual(t(':5173'), { url: 'http://127.0.0.1:5173/', port: 5173 });
    assert.deepStrictEqual(t('5173/admin?x=1'), { url: 'http://127.0.0.1:5173/admin?x=1', port: 5173 });
    assert.deepStrictEqual(t('localhost:3000/x'), { url: 'http://localhost:3000/x', port: 3000 });
    assert.strictEqual(t('99999'), null);
    ok('a port, typed bare or with a colon, is a local page on the pane\'s loopback name');
    assert.deepStrictEqual(t('example.com/docs'), { url: 'https://example.com/docs', port: null });
    assert.deepStrictEqual(t('http://example.com'), { url: 'http://example.com/', port: null });
    assert.deepStrictEqual(t('HTTPS://Example.com/A'), { url: 'https://example.com/A', port: null });
    ok('a site is https unless http is typed');
    assert.deepStrictEqual(t('/list?q=1'), { url: 'https://pcpartpicker.com/list?q=1', port: null });
    assert.deepStrictEqual(t('docs/v1.2'), { url: 'https://pcpartpicker.com/docs/v1.2', port: null });
    assert.deepStrictEqual(t('index.html', 'http://127.0.0.1:5173/a/b'), { url: 'http://127.0.0.1:5173/index.html', port: 5173 });
    assert.strictEqual(t('/list', null), null);
    ok('a path is on the page you are on, a file name included, and nothing without one');
    assert.strictEqual(t('javascript:alert(1)'), null);
    assert.strictEqual(t('file:///etc/passwd'), null);
    assert.strictEqual(t('hello world'), null);
    assert.strictEqual(t('   '), null);
    ok('other schemes, spaces and nothing are refused');

    // ── the list of pages ──
    const entries = [
        { key: 5173, port: 5173, url: 'http://127.0.0.1:5173/admin', title: 'vite', sessionId: 's1', wcId: 11 },
        { key: 'https://pcpartpicker.com', base: 'https://pcpartpicker.com', url: 'https://pcpartpicker.com/list',
            pageTitle: 'Part List', sessionId: 's2', wcId: 12 },
        { key: 'https://example.com', base: 'https://example.com', url: 'https://example.com/', wcId: null },
    ];
    const names = { s1: 'Fix the login', s2: 'Pick a GPU' };
    const agent = { connected: true, pages: [{ webContentsId: 12, url: 'https://pcpartpicker.com/list' }],
        asks: [{ origin: 'https://example.com' }] };
    const rows = pageRows(entries, { agent, activeKey: 5173, sessionName: (id) => names[id] || null });
    assert.deepStrictEqual(rows.map(r => r.kind), ['port', 'site', 'site']);
    assert.deepStrictEqual(rows.map(r => r.label), ['vite', 'Part List', 'example.com']);
    assert.deepStrictEqual(rows.map(r => r.address), ['127.0.0.1:5173/admin', 'pcpartpicker.com/list', 'example.com']);
    assert.deepStrictEqual(rows.map(r => r.session), ['Fix the login', 'Pick a GPU', null]);
    assert.deepStrictEqual(rows.map(r => r.agent), [false, true, false]);
    assert.deepStrictEqual(rows.map(r => r.asking), [false, false, true]);
    assert.deepStrictEqual(rows.map(r => r.active), [true, false, false]);
    ok('dev-server and site pages, in order, with title, address, opener, agent and ask');
    const off = pageRows(entries, { agent: { ...agent, connected: false } });
    assert.ok(off.every(r => !r.agent));
    ok('no agent marker once the agent has disconnected');

    const mine = agentAway(rows, { sessionId: 's2', onScreenKey: null });
    assert.deepStrictEqual(mine.map(r => r.key), ['https://pcpartpicker.com']);
    assert.deepStrictEqual(agentAway(rows, { sessionId: 's1', onScreenKey: null }), []);
    assert.deepStrictEqual(agentAway(rows, { sessionId: 's2', onScreenKey: 'https://pcpartpicker.com' }), []);
    const unowned = pageRows([{ ...entries[1], sessionId: null }], { agent });
    assert.strictEqual(agentAway(unowned, { sessionId: 's1' }).length, 1);
    ok('the agent chip: in the session that opened the page, or in every one when nobody did; never while it is on screen');

    // ── which pages keep-alive leaves alone ──
    assert.strictEqual(pinnedPage(entries[1], agent), true);
    assert.strictEqual(pinnedPage(entries[2], agent), true);
    assert.strictEqual(pinnedPage(entries[0], agent), false);
    assert.strictEqual(pinnedPage(entries[1], { ...agent, connected: false }), false);
    assert.strictEqual(pinnedPage(entries[1], null), false);
    assert.strictEqual(pinnedPage({ url: 'https://example.com/deep/page', wcId: null }, { connected: false, pages: [], asks: [{ origin: 'https://example.com' }] }), true);
    ok('pinned while an agent is attached, or while its site waits on an answer');

    // ── the keep-alive clock, in the pane ──
    installDom();
    const { PreviewPane } = await import('../web/preview.js');
    const toasts = [];
    const pane = new PreviewPane({
        root: paneRoot(),
        keepAliveMinutes: () => 0.03 / 60,   // 30ms
        toast: (text) => toasts.push(text),
        onHome() {},
    });
    pane.setVisible(true);
    pane.open({ port: 5173, sessionId: 's1' });
    const site = pane.entries.get(5173);
    site.wcId = 21;
    pane.setAgentState({ connected: true, pages: [{ webContentsId: 21 }], asks: [] });
    pane.setVisible(false);
    assert.strictEqual(site.timer, null);
    assert.strictEqual(site.parked, true);
    await sleep(80);
    assert.ok(pane.entries.has(5173), 'a page an agent is on outlives its keep-alive');
    ok('a page an agent is connected to is not dropped when you leave it');

    pane.setAgentState({ connected: false, pages: [], asks: [] });
    assert.ok(site.timer, 'its clock starts again once the agent lets go');
    await sleep(80);
    assert.ok(!pane.entries.has(5173));
    ok('and is dropped on the normal clock once the agent disconnects');

    // An ask pending for a page's site pins it too — and an agent that arrives
    // while the clock is running stops it from dropping the page.
    pane.open({ port: 3000 });
    const local = pane.entries.get(3000);
    pane.setVisible(true);
    pane.setVisible(false);
    assert.ok(local.timer);
    pane.setAgentState({ connected: false, pages: [], asks: [{ origin: 'http://localhost:3000' }] });
    assert.strictEqual(local.timer, null);
    await sleep(80);
    assert.ok(pane.entries.has(3000));
    ok('a page whose site has a pending ask is kept, even with its clock already running');
    pane.setAgentState({ connected: false, pages: [], asks: [] });
    await sleep(80);
    assert.ok(!pane.entries.has(3000));
    ok('and released when the ask is answered');

    // The clock running out re-checks: an agent attached since the last state.
    pane.open({ port: 4000 });
    const late = pane.entries.get(4000);
    late.wcId = 40;
    pane.setVisible(true);
    pane.setVisible(false);
    pane.agent = { connected: true, pages: [{ webContentsId: 40 }], asks: [] };   // no setAgentState yet
    await sleep(80);
    assert.ok(pane.entries.has(4000));
    assert.strictEqual(late.parked, true);
    ok('a clock that runs out on a page an agent has since taken parks it instead');

    // Rows the pane hands the menu carry who opened each page.
    pane.open({ port: 4001, sessionId: 's9' });
    assert.strictEqual(pane.rows().find(r => r.key === 4001).sessionId, 's9');
    ok('the pane\'s own rows say which session opened a page');

    console.log(`\npreview-pages: ${pass} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
