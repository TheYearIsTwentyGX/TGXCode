'use strict';

// Codex's quota, sign-in, context use and version — bridge/codex/quota.js and
// version.js, and the two readings the adapter takes off a live process.
//
// No bridge and no real Codex. The app-server is the replay stub walking a
// fixture written here; the pushes and token counts are the recorded ones.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-codex-quota-'));
const FIXTURES = path.join(__dirname, 'fixtures', 'codex');

// A `codex` for the app-server to be, set before client.js reads CODEX_BIN.
const bin = path.join(tmp, 'codex');
fs.writeFileSync(bin, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(FIXTURES, 'stub.js'))});\n`);
fs.chmodSync(bin, 0o755);
process.env.TGXCODE_CODEX_BIN = bin;

const { CodexQuota, windowLabel, windowsOf, merge, askAppServer } = require('../bridge/codex/quota');
const { CodexVersion, summarizeCodex, outsideTested, REGISTRY_URL } = require('../bridge/codex/version');
const { TESTED } = require('../bridge/codex/protocol');
const { CodexAdapter } = require('../bridge/runtimes/codex/process');
const { scanMeta } = require('../bridge/runtimes/codex/transcript');
const { Runner } = require('../bridge/runner');

let pass = 0;
const ok = (what) => { pass++; console.log(`  ok  ${what}`); };

const NOW = 1_800_000_000_000;
const SOON = NOW / 1000 + 3600;
// A Free account, as measured on 0.172.0: one 30-day window and no second one.
const FREE = { limitId: 'codex', planType: 'free', secondary: null,
    primary: { usedPercent: 12, windowDurationMins: 43200, resetsAt: SOON },
    credits: { hasCredits: false, unlimited: false, balance: null }, rateLimitReachedType: null };

const lines = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l));

/** Write a stub fixture: the handshake, then each [method, result|error] pair. */
function fixture(name, pairs) {
    const out = [{ dir: 'send', msg: { id: 1, method: 'initialize' } },
        { dir: 'recv', msg: { id: 1, result: { userAgent: 'tgxcode/0.172.0' } } },
        { dir: 'send', msg: { method: 'initialized' } }];
    let id = 1;
    for (const [method, reply] of pairs) {
        id++;
        out.push({ dir: 'send', msg: { id, method } });
        out.push({ dir: 'recv', msg: { id, ...reply } });
    }
    const file = path.join(tmp, `${name}.ndjson`);
    fs.writeFileSync(file, out.map(e => JSON.stringify(e)).join('\n') + '\n');
    process.env.FAKE_CODEX_FIXTURE = file;
}

(async () => {
    // --- windows are named from their length ------------------------------------------------------
    assert.deepStrictEqual(windowLabel(43200), { label: '30-day', shortLabel: '30d' });
    assert.deepStrictEqual(windowLabel(300), { label: '5-hour', shortLabel: '5h' });
    assert.deepStrictEqual(windowLabel(10080), { label: '7-day', shortLabel: '7d' });
    assert.deepStrictEqual(windowLabel(45), { label: '45-minute', shortLabel: '45m' });
    assert.deepStrictEqual(windowLabel(null), { label: 'Usage limit', shortLabel: 'Limit' });
    const free = windowsOf(FREE, 5, NOW / 1000);
    assert.strictEqual(free.length, 1, 'secondary: null is one window, not an empty second');
    assert.deepStrictEqual(free[0], { type: 'primary', label: '30-day', shortLabel: '30d',
        windowDurationMins: 43200, usedPercent: 12, usedPercentAt: 5, resetsAt: SOON, status: null });
    assert.deepStrictEqual(windowsOf(FREE, 5, SOON + 1), [], 'a window that has reset says nothing');
    assert.strictEqual(windowsOf({ primary: { usedPercent: 100 } }, 5, 0)[0].status, 'rejected');
    ok('a window is labelled by windowDurationMins, and a plan with one window has one');

    // --- a pushed update is sparse ----------------------------------------------------------------
    const merged = merge(FREE, { limitId: 'codex', planType: null, primary: { usedPercent: 30,
        windowDurationMins: null, resetsAt: null }, secondary: null });
    assert.strictEqual(merged.primary.usedPercent, 30);
    assert.strictEqual(merged.primary.windowDurationMins, 43200, 'null does not clear the length');
    assert.strictEqual(merged.planType, 'free');
    ok('a null in an update keeps what was known');

    // --- the store --------------------------------------------------------------------------------
    {
        let installed = false;
        let answer = { account: null, limits: null, error: null };
        let asks = 0;
        let clock = NOW;
        const q = new CodexQuota({ installed: async () => installed, now: () => clock,
            ask: async () => { asks++; if (answer instanceof Error) throw answer; return answer; } });
        let changes = 0;
        q.on('changed', () => changes++);

        await q.refresh();
        assert.strictEqual(q.snapshot(), null, 'no Codex, no meter');
        assert.strictEqual(asks, 0, 'and nothing is spawned to find out');

        installed = true;
        await q.refresh();
        assert.strictEqual(q.snapshot().signedIn, false);
        assert.deepStrictEqual(q.snapshot().windows, []);

        answer = { account: { type: 'chatgpt', planType: 'free', email: 'someone@example.com' },
            limits: FREE, error: null };
        await q.refresh();
        let s = q.snapshot();
        assert.strictEqual(s.signedIn, true);
        assert.strictEqual(s.planType, 'free');
        assert.strictEqual(s.windows[0].usedPercent, 12);
        assert.strictEqual(s.at, NOW / 1000);
        assert.ok(!JSON.stringify(s).includes('example.com'), 'the address stays out of the payload');

        const before = changes;
        clock += 1000;
        q.notePush({ limitId: 'codex', primary: { usedPercent: 40 } });
        assert.strictEqual(q.snapshot().windows[0].usedPercent, 40);
        assert.strictEqual(q.snapshot().windows[0].label, '30-day');
        assert.strictEqual(changes, before + 1);
        q.notePush({ limitId: 'some-model', primary: { usedPercent: 99 } });
        assert.strictEqual(q.snapshot().windows[0].usedPercent, 40, 'another meter is not the account\'s');

        const asked = asks;
        await q.refreshIfStale();
        assert.strictEqual(asks, asked, 'a push is a reading: nothing to ask yet');
        clock += 11 * 60_000;
        answer = new Error('boom');
        await q.refreshIfStale();
        assert.strictEqual(asks, asked + 1);
        s = q.snapshot();
        assert.strictEqual(s.windows[0].usedPercent, 40, 'a failed ask keeps the last reading');
        assert.match(s.error, /boom/);
        ok('not installed, signed out, signed in, pushed and failing each read as themselves');
    }

    // --- asking a real app-server's shape ---------------------------------------------------------
    fixture('signed-out', [['account/read', { result: { account: null, requiresOpenaiAuth: true } }]]);
    assert.deepStrictEqual(await askAppServer(), { account: null, limits: null, error: null });
    fixture('signed-in', [
        ['account/read', { result: { account: { type: 'chatgpt', planType: 'free' }, requiresOpenaiAuth: true } }],
        ['account/rateLimits/read', { result: { rateLimits: FREE } }]]);
    const got = await askAppServer();
    assert.strictEqual(got.account.planType, 'free');
    assert.deepStrictEqual(got.limits, FREE);
    fixture('api-key', [
        ['account/read', { result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } }],
        ['account/rateLimits/read', { error: { code: -32600, message: 'chatgpt auth required' } }]]);
    const key = await askAppServer();
    assert.strictEqual(key.account.type, 'apiKey');
    assert.match(key.error, /chatgpt auth required/);
    ok('account: null is signed out (requiresOpenaiAuth is true either way)');

    // --- a live process ---------------------------------------------------------------------------
    {
        const recv = lines('plain.ndjson').filter(e => e.dir === 'recv').map(e => e.msg);
        const usage = recv.find(m => m.method === 'thread/tokenUsage/updated');
        const limits = recv.find(m => m.method === 'account/rateLimits/updated');
        const a = new CodexAdapter({ rpc: async () => ({}) });
        a.threadId = usage.params.threadId;
        assert.deepStrictEqual(a.read(usage),
            [{ type: 'context', context: { usedTokens: 14950, windowTokens: 258400 } }]);
        assert.deepStrictEqual(a.read({ ...usage, params: { ...usage.params, threadId: 'a-subagent' } }), [],
            'a child thread\'s window is not this conversation\'s');
        assert.deepStrictEqual(a.read(limits), [{ type: 'limits', limits: limits.params.rateLimits }]);

        const r = new Runner({ sessionId: 's1', cwd: '/tmp', runtime: 'codex' });
        let heard = null;
        let quota = 0;
        r.on('limits', (l) => { heard = l; });
        r.on('quota', () => { quota++; });
        r._onEvent({ type: 'context', context: { usedTokens: 1, windowTokens: 2 } });
        r._onEvent({ type: 'limits', limits: FREE });
        assert.deepStrictEqual(r.status().context, { usedTokens: 1, windowTokens: 2 });
        assert.strictEqual(heard, FREE);
        assert.strictEqual(quota, 0, 'never Claude\'s quota event');
        ok('a live process says its context use and the account\'s windows');
    }

    // --- context use from the rollout -------------------------------------------------------------
    assert.deepStrictEqual(scanMeta(path.join(FIXTURES, 'plain.rollout.jsonl')).context,
        { usedTokens: 14950, windowTokens: 258400 });
    ok('a session with no process reads it from the transcript');

    // --- the version ------------------------------------------------------------------------------
    assert.match(REGISTRY_URL, /@openai\/codex\/dist-tags$/);
    assert.strictEqual(outsideTested(TESTED.min), null);
    assert.strictEqual(outsideTested('0.171.9'), 'older');
    assert.strictEqual(outsideTested(TESTED.below), 'newer');
    const sum = summarizeCodex({ installed: '0.172.0', tags: { latest: '0.175.0' }, runners: {
        a: { runtime: 'codex', claudeVersion: '0.171.0' },
        b: { runtime: 'claude', claudeVersion: '2.1.0' },
        c: { runtime: 'codex', claudeVersion: '0.172.0' },
    } });
    assert.strictEqual(sum.behind, true);
    assert.strictEqual(sum.latest, '0.175.0');
    assert.deepStrictEqual(sum.staleSessions, [{ id: 'a', version: '0.171.0' }]);
    assert.strictEqual(sum.outsideTested, null);
    assert.match(sum.howToUpdate, /npm i -g @openai\/codex/);

    const v = new CodexVersion({ runners: () => ({}), tagsOf: async () => ({ latest: '0.172.0' }) });
    const now = await v.summary({ fresh: true });
    assert.strictEqual(now.installed, '0.172.0', '`codex-cli 0.172.0` from the stub\'s --version');
    assert.strictEqual(now.behind, false);
    const offline = new CodexVersion({ runners: () => ({}),
        tagsOf: async () => { throw new Error('offline'); } });
    const unsure = await offline.summary();
    assert.strictEqual(unsure.error, 'offline');
    assert.strictEqual(unsure.behind, false);

    let asked = 0;
    const gone = new CodexVersion({ runners: () => ({}), bin: path.join(tmp, 'nothing'),
        tagsOf: async () => { asked++; return { latest: '9.9.9' }; } });
    const none = await gone.summary();
    assert.strictEqual(none.installed, null);
    assert.strictEqual(none.outsideTested, null);
    assert.strictEqual(asked, 0, 'the registry is not asked about a CLI that is not here');
    ok('Codex is compared with its own releases and the tested range');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${pass} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
