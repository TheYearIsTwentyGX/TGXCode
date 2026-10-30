'use strict';

// Wake-ups — bridge/wakes.js, riding on the scheduled-message store and its
// delivery — with stubs for the pool, the index and the orchestrator store. No
// bridge, no `claude`.
//
// What it guards is later.test.js's list one layer up: things that only go wrong
// at the hour nobody is watching. A wake that is lost on a restart, one that kills
// the turn it was meant to follow, a limit wake that fires on top of an
// orchestrator's own resume, or one that comes back after the session already
// carried on. None of those show up as an error anywhere.
//
// XDG_DATA_HOME before the require, for later.test.js's reason: STATE_DIR is read
// once, and this test deletes the file it points at.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-wakes-'));
process.env.XDG_DATA_HOME = home;

const { Later, STATE_FILE } = require('../bridge/later');
assert.ok(STATE_FILE.startsWith(home), `refusing to run: STATE_FILE is ${STATE_FILE}`);
const cfg = require('../bridge/config');
const wakes = require('../bridge/wakes');
const delivery = require('../bridge/later-delivery');
const { Runner, LIMIT_TEXT } = require('../bridge/runner');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const MIN = 60_000;
const TEST = cfg.IS_DEV;   // rows this bridge would deliver

// --- stubs -----------------------------------------------------------------------

/** A runner as the delivery path sees it: a state, settings, a queue. */
function stubRunner(state, settings = {}) {
    const r = new EventEmitter();
    Object.assign(r, { state, permissionMode: 'acceptEdits', model: 'opus', effort: null, ...settings });
    r.sent = [];
    r.queue = [];
    r.send = (text) => {
        const entry = { id: `q${r.sent.length}`, text };
        r.sent.push(text);
        if (r.state === 'busy') r.queue.push(entry);
        return entry;
    };
    r.status = () => ({ state: r.state, permissionMode: r.permissionMode, model: r.model,
        effort: r.effort, queue: r.queue });
    return r;
}

const world = {
    runners: new Map(),
    ensured: [],
    sessions: new Map([['s1', { sessionId: 's1', cwd: '/tmp/p', permissionMode: 'plan' }],
        ['s2', { sessionId: 's2', cwd: '/tmp/p', permissionMode: 'auto' }],
        ['orch', { sessionId: 'orch', cwd: '/tmp/p' }], ['wk', { sessionId: 'wk', cwd: '/tmp/p' }]]),
    orchs: new Map(),
    prefs: { quota: {} },
    windows: [],
    changes: 0,
};

const pool = {
    statuses() {
        const out = {};
        for (const [id, r] of world.runners) out[id] = { ...r.status(), queued: r.queue.length };
        return out;
    },
    get: (id) => world.runners.get(id) || null,
    ensure(id, opts) {
        world.ensured.push({ id, opts });
        let r = world.runners.get(id);
        if (!r) { r = stubRunner('idle', { permissionMode: opts.permissionMode, model: opts.model }); world.runners.set(id, r); }
        return r;
    },
};
const index = {
    summary: (id) => (world.sessions.has(id) ? { ...world.sessions.get(id), test: TEST } : null),
};
const orchestrators = {
    get: (id) => world.orchs.get(id) || null,
    orchestratorOf: (id) => [...world.orchs.values()].find(o => o.workers.some(w => w.id === id)) || null,
};

let later = null;
function boot() {
    later = new Later();
    wakes.init({
        later, pool, index, orchestrators,
        prefs: { forCwd: () => world.prefs },
        usage: { snapshot: () => ({ windows: world.windows }) },
        sessionCwd: (s) => s.cwd,
        changed: () => { world.changes++; },
        limitGraceMs: 60_000,
    });
    delivery.init({
        later, index, pool,
        notifications: { record: () => null }, filed: () => {}, laterPayload: () => ({}),
        normalizeMode: (m) => m || 'auto', sessionCwd: (s) => s.cwd, resolveAttachments: () => [],
    });
}

function fresh() {
    try { fs.unlinkSync(STATE_FILE); } catch { /* first */ }
    world.runners.clear();
    world.ensured.length = 0;
    world.orchs.clear();
    world.prefs = { quota: {} };
    world.windows = [];
    boot();
}

// Keep the loop alive across the unref'd timers the code under test sets.
const keepAlive = setInterval(() => {}, 1000);

(async () => {
    // --- when --------------------------------------------------------------------
    {
        const now = new Date(2026, 9, 30, 10, 0, 0).getTime();
        assert.strictEqual(wakes.parseIn('45m', now), now + 45 * MIN);
        assert.strictEqual(wakes.parseIn('1h30m', now), now + 90 * MIN);
        assert.strictEqual(wakes.parseIn('2 hours', now), now + 120 * MIN);
        assert.strictEqual(wakes.parseIn('30', now), now + 30 * MIN, 'a bare number is minutes');
        assert.strictEqual(wakes.parseIn('3 fortnights', now), null);
        assert.strictEqual(wakes.parseIn('soon', now), null);
        assert.strictEqual(wakes.parseAt('17:30', now), new Date(2026, 9, 30, 17, 30).getTime());
        assert.strictEqual(wakes.parseAt('9am', now), new Date(2026, 9, 31, 9, 0).getTime(), 'past today is tomorrow');
        assert.strictEqual(wakes.parseAt('2026-11-02T08:15', now), new Date(2026, 10, 2, 8, 15).getTime());
        assert.strictEqual(wakes.parseAt('2026-11-02', now), null, 'a date alone is refused');
        assert.match(wakes.resolveWhen({ in: '10s' }, now).error, /less than a minute/);
        assert.match(wakes.resolveWhen({ in: '40d' }, now).error, /30 days/);
        assert.match(wakes.resolveWhen({ in: '5m', at: '17:00' }, now).error, /not both/);
        assert.match(wakes.resolveWhen({}, now).error, /give at/);
        ok('in and at are read as durations and local times, and nonsense is refused');
    }

    // --- persist, and survive a restart --------------------------------------------
    {
        fresh();
        world.runners.set('s1', stubRunner('busy', { permissionMode: 'acceptEdits', model: 'opus' }));
        const out = wakes.setWake('s1', { in: '45m', prompt: 'check the CI run', reason: 'CI is slow' });
        assert.ok(out.wake, out.error);
        assert.strictEqual(out.wake.kind, 'wake');
        assert.strictEqual(out.wake.permissionMode, 'acceptEdits', 'the mode it runs in now, not a default');
        assert.strictEqual(out.wake.model, 'opus');
        later.flush();
        boot();   // a new bridge reading the same file
        const back = wakes.listWakes('s1');
        assert.strictEqual(back.length, 1);
        assert.strictEqual(back[0].kind, 'wake');
        assert.strictEqual(back[0].reason, 'CI is slow');
        assert.strictEqual(back[0].text, 'check the CI run');
        ok('a wake-up is written to disk with its kind and reason, and read back after a restart');
    }

    // --- the cap, and cancelling only your own ---------------------------------------
    {
        fresh();
        for (let i = 0; i < wakes.MAX_SELF_WAKES; i++) {
            assert.ok(wakes.setWake('s1', { in: `${10 + i}m`, prompt: `p${i}` }).wake);
        }
        const over = wakes.setWake('s1', { in: '50m', prompt: 'one too many' });
        assert.strictEqual(over.status, 409);
        const other = wakes.setWake('s2', { in: '20m', prompt: 'mine' }).wake;
        assert.strictEqual(wakes.cancelWakes('s1', other.id), 0, 's1 cannot cancel s2\'s');
        assert.strictEqual(wakes.listWakes('s2').length, 1);
        const first = wakes.listWakes('s1')[0];
        assert.strictEqual(wakes.cancelWakes('s1', first.id), 1);
        assert.strictEqual(wakes.listWakes('s1').length, wakes.MAX_SELF_WAKES - 1);
        assert.strictEqual(wakes.cancelWakes('s1'), wakes.MAX_SELF_WAKES - 1, 'no id cancels all of them');
        assert.strictEqual(wakes.listWakes('s1').length, 0);
        assert.strictEqual(wakes.setWake('nope', { in: '5m', prompt: 'x' }).status, 404);
        assert.strictEqual(wakes.setWake('s1', { in: '5m', prompt: '  ' }).status, 400);
        ok('three self wake-ups per session, and a session cancels only its own');
    }

    // --- fire while busy: queued behind the turn, settings untouched ------------------
    {
        fresh();
        const r = stubRunner('busy', { permissionMode: 'acceptEdits', model: 'opus' });
        world.runners.set('s1', r);
        // Written with another mode, as if the session had changed since: a message
        // would wait for idle here; a wake goes to the process as it is.
        const row = later.create({ sessionId: 's1', cwd: '/tmp/p', text: 'carry on', permissionMode: 'plan',
            at: Date.now() - 1000, test: TEST, kind: 'wake', reason: 'check' });
        await delivery.tickLater();
        assert.strictEqual(r.sent.length, 1, 'delivered, not put back');
        assert.match(r.sent[0], /^\(TGXCode wake-up you set at .* — check\)\n\ncarry on$/);
        assert.strictEqual(r.queue.length, 1, 'queued behind the running turn');
        assert.deepStrictEqual(world.ensured[0].opts, { cwd: '/tmp/p' }, 'no mode or model asked for');
        assert.strictEqual(later.get(row.id), null, 'gone once delivered');

        // The same for a plain message would wait: the old rule is intact.
        const msg = later.create({ sessionId: 's1', cwd: '/tmp/p', text: 'hi', permissionMode: 'plan',
            at: Date.now() - 1000, test: TEST });
        await delivery.tickLater();
        assert.strictEqual(r.sent.length, 1);
        assert.strictEqual(later.get(msg.id).state, 'pending', 'a message that would change the mode waits');
        ok('a wake-up that fires mid-turn is queued behind it, without changing the session\'s settings');
    }

    // --- late is not missed ------------------------------------------------------------
    {
        fresh();
        world.runners.set('s1', stubRunner('idle'));
        later.create({ sessionId: 's1', cwd: '/tmp/p', text: wakes.LIMIT_TEXT, permissionMode: 'auto',
            at: Date.now() - 5 * 60 * MIN, test: TEST, kind: 'limit' });
        await delivery.tickLater();
        assert.deepStrictEqual(world.runners.get('s1').sent, [wakes.LIMIT_TEXT]);
        ok('a wake-up five hours late is still delivered, where a message would be missed');
    }

    // --- the timer, re-armed from disk ---------------------------------------------------
    {
        fresh();
        const r = stubRunner('idle');
        world.runners.set('s1', r);
        later.create({ sessionId: 's1', cwd: '/tmp/p', text: 'on time', permissionMode: 'auto',
            at: Date.now() + 300, test: TEST, kind: 'wake' });
        later.flush();
        boot();                 // a restart: only the file knows about it
        delivery.armNext();     // what the boot tick's finally does
        await new Promise(res => setTimeout(res, 900));
        assert.strictEqual(r.sent.length, 1, 'the timeout fired without waiting for the 30s tick');
        ok('after a restart the soonest wake-up is armed as a timeout and fires on time');
    }

    // --- the usage limit ------------------------------------------------------------------
    {
        fresh();
        world.runners.set('s1', stubRunner('idle', { permissionMode: 'acceptEdits' }));
        const resetsAt = Date.now() + 2 * 60 * MIN;
        const row = wakes.onTurnComplete({ sessionId: 's1', isError: true,
            usageLimit: { resetsAt, window: 'five_hour' } });
        assert.ok(row);
        assert.strictEqual(row.kind, 'limit');
        assert.strictEqual(row.at, resetsAt + MIN, 'a minute after the reset');
        assert.strictEqual(row.text, wakes.LIMIT_TEXT);
        assert.strictEqual(row.permissionMode, 'acceptEdits');

        // A second hit moves it rather than adding one.
        const later2 = wakes.onTurnComplete({ sessionId: 's1', isError: true,
            usageLimit: { resetsAt: resetsAt + 60 * MIN, window: 'seven_day' } });
        const pending = wakes.listWakes('s1');
        assert.strictEqual(pending.length, 1);
        assert.strictEqual(pending[0].id, later2.id);

        // No reset time on the turn: the windows bridge/usage.js has seen refused.
        world.windows = [{ type: 'five_hour', status: 'rejected', resetsAt: Math.round((Date.now() + 30 * MIN) / 1000) }];
        const fromUsage = wakes.onTurnComplete({ sessionId: 's2', isError: true, usageLimit: { resetsAt: null } });
        assert.ok(fromUsage && Math.abs(fromUsage.at - (Date.now() + 31 * MIN)) < 2000);

        // A turn that got through: the limit is not what stopped it any more.
        wakes.onTurnComplete({ sessionId: 's1', isError: false, usageLimit: null });
        assert.strictEqual(wakes.listWakes('s1').length, 0);
        // A self wake is left alone by that.
        wakes.setWake('s2', { in: '10m', prompt: 'keep me' });
        wakes.onTurnComplete({ sessionId: 's2', isError: false, usageLimit: null });
        assert.deepStrictEqual(wakes.listWakes('s2').map(w => w.kind), ['wake']);

        // The setting off: nothing armed.
        world.prefs = { quota: { resumeAfterLimit: false } };
        assert.strictEqual(wakes.onTurnComplete({ sessionId: 's1', isError: true,
            usageLimit: { resetsAt, window: 'five_hour' } }), null);
        ok('a turn ended on the limit arms one wake for after the reset, moved by a second hit and cleared by a turn that got through');
    }

    // --- orchestrators: theirs to resume -------------------------------------------------------
    {
        fresh();
        const hit = (id) => wakes.onTurnComplete({ sessionId: id, isError: true,
            usageLimit: { resetsAt: Date.now() + 60 * MIN, window: 'five_hour' } });
        const orch = { id: 'orch', paused: { reason: 'x', resumeAt: Date.now() + 61 * MIN },
            settings: { usageStop: { enabled: true, autoResume: false } }, workers: [{ id: 'wk' }] };
        world.orchs.set('orch', orch);
        assert.strictEqual(hit('orch'), null, 'a paused orchestrator');
        assert.strictEqual(hit('wk'), null, 'a worker of a paused orchestrator');

        orch.paused = null;
        orch.settings.usageStop.autoResume = true;
        assert.strictEqual(hit('orch'), null, 'not paused, but it will resume itself');

        orch.settings.usageStop.autoResume = false;
        const row = hit('wk');
        assert.ok(row, 'an orchestrator that will not resume itself leaves its worker to us');

        // Paused after the wake was set: dropped at fire time, not delivered.
        world.runners.set('wk', stubRunner('idle'));
        later.update(row.id, { at: Date.now() - 1000 });
        orch.paused = { reason: 'cutoff' };
        await delivery.tickLater();
        assert.deepStrictEqual(world.runners.get('wk').sent, []);
        assert.strictEqual(later.get(row.id), null);
        ok('no limit wake for an orchestrator or its workers while the orchestrator resumes them');
    }

    // --- the runner's half: which turns ended on the limit -----------------------------------------
    {
        const read = (limitInfo, failed, detail) => Runner.prototype._usageLimit.call({ _limitInfo: limitInfo }, failed, detail);
        assert.deepStrictEqual(read({ status: 'rejected', resetsAt: 1793305200, rateLimitType: 'five_hour' }, true, ''),
            { resetsAt: 1793305200000, window: 'five_hour' });
        assert.deepStrictEqual(read(null, true, "You've hit your session limit · resets 3:20pm (America/Chicago)"),
            { resetsAt: null, window: null });
        assert.strictEqual(read({ status: 'rejected', resetsAt: 1 }, false, ''), null, 'a turn that finished is not a limit stop');
        assert.strictEqual(read(null, true, 'API Error: overloaded'), null);
        assert.ok(LIMIT_TEXT.test("You've hit your 5-hour limit · resets 8:20pm"));
        assert.ok(LIMIT_TEXT.test('Claude AI usage limit reached|1793305200'));
        ok('a failed turn with a rejected rate-limit event, or the CLI\'s limit text, is a usage-limit stop');
    }

    clearInterval(keepAlive);
    console.log(`\n${pass} groups passed`);
    fs.rmSync(home, { recursive: true, force: true });
})().catch((err) => { console.error(err); process.exit(1); });
