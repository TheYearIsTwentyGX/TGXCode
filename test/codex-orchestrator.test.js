'use strict';

// An orchestrator session running on Codex (docs/plans/23-codex.md, Phase 4):
// marked under the create route's placeholder and moved to the id Codex mints,
// briefed without claiming an id it does not have yet, its workers on Codex by
// default, its cutoff judged against the account it actually spends, and moved
// with `thread/resume {cwd}`.
//
//   node test/codex-orchestrator.test.js
//
// No bridge and no Codex. The store and bridge/orchestration.js are the real
// ones, against a fake pool that mints ids the way a Codex start does. **Its own
// XDG_DATA_HOME, set before any require**: orchestrators.json lives in STATE_DIR,
// which every bridge on the machine shares.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-codex-orch-')));
process.env.XDG_DATA_HOME = home;
process.env.TGXCODE_ROOTS = home;
process.env.TGXCODE_PROJECTS_DIR = path.join(home, 'projects');

const { Orchestrators, usageTrips, cleanSettings, DEFAULT_SETTINGS } = require('../bridge/orchestrators');
const orchestration = require('../bridge/orchestration');
const codexModels = require('../bridge/codex/models');
const { threadConfig } = require('../bridge/runtimes/codex/process');
const codexReader = require('../bridge/runtimes/codex/transcript');
const cfg = require('../bridge/config');

let pass = 0;
const ok = (what) => { pass++; console.log(`  ok  ${what}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fileOf = (name) => path.join(home, `orch-${name}.json`);

// Codex's model list, as `model/list` would give it. Patched on the module object
// orchestration.js holds, so no app-server is spawned.
const CODEX_LIST = { models: [{ id: 'gpt-6-luna', default: true, efforts: ['low', 'medium', 'high'] },
    { id: 'gpt-6.2-sol', default: false, efforts: ['low', 'medium', 'high'] }], efforts: ['low', 'medium', 'high'] };
codexModels.list = async () => CODEX_LIST;

class FakeRunner extends EventEmitter {
    constructor(id, runtime = 'claude') {
        super();
        this.sessionId = id;
        this.runtime = runtime;
        this.adapter = { product: runtime === 'codex' ? 'Codex' : 'Claude Code' };
        this.state = 'idle';
        this.cwd = home;
        this.sent = [];
        this.queue = [];
        this.pendingPermission = null;
        this.lastResultText = null;
        this.stopped = 0;
        this.background = new Map();
        this.hasBackground = false;
    }
    status() {
        return { sessionId: this.sessionId, state: this.state, queued: this.queue.length,
            queue: this.queue, pendingPermission: this.pendingPermission };
    }
    send(text) { this.sent.push(text); return { id: `q${this.sent.length}` }; }
    async stop() { this.stopped++; this.state = 'idle'; return { how: 'soft' }; }
    handOverQueue() { this.queue = []; }
}

/**
 * A pool whose `create` answers with the placeholder and, for Codex, says
 * `minted` on the next tick — on the runner, then on the pool, as RunnerPool does.
 */
function harness(name, { codexWindows = [], claudeWindows = [] } = {}) {
    const pool = new EventEmitter();
    pool.runners = new Map();
    pool._runtimeOf = new Map();
    pool.created = [];
    pool.relocated = [];
    pool.get = (id) => pool.runners.get(id) || null;
    pool.ensure = (id, o = {}) => {
        if (!pool.runners.has(id)) pool.runners.set(id, new FakeRunner(id, pool._runtimeOf.get(id) || 'claude'));
        return pool.runners.get(id);
    };
    pool.recycle = () => true;
    pool.release = () => {};
    pool.relocate = (id, cwd) => { pool.relocated.push({ id, cwd }); return true; };
    pool.create = (o) => {
        const rt = o.runtime || 'claude';
        const r = new FakeRunner(o.sessionId, rt);
        r.state = 'busy';
        pool.runners.set(o.sessionId, r);
        if (rt !== 'claude') pool._runtimeOf.set(o.sessionId, rt);
        pool.created.push(o);
        if (rt === 'codex') {
            setImmediate(() => {
                const to = `thread-${pool.created.length}`;
                pool.mint(o.sessionId, to);
            });
        }
        return { sessionId: o.sessionId, status: r.status() };
    };
    pool.mint = (from, to) => {
        const r = pool.runners.get(from);
        if (r) {
            r.sessionId = to;
            r.emit('minted', { from, to });
            pool.runners.delete(from);
            pool.runners.set(to, r);
        }
        if (pool._runtimeOf.has(from)) { pool._runtimeOf.set(to, pool._runtimeOf.get(from)); pool._runtimeOf.delete(from); }
        pool.emit('minted', { from, to });
    };

    const known = new Map();   // the index: id -> summary
    const files = new Map();   // the index: id -> {file}
    const flagRows = new Map();
    const store = new Orchestrators({ file: fileOf(name) });
    const win = { claude: claudeWindows, codex: codexWindows };
    const deps = {
        store, pool,
        index: { summary: (id) => known.get(id) || null, get: (id) => files.get(id) || null, note: () => {} },
        flags: { get: (id) => flagRows.get(id) || { test: false }, set: (id, v) => flagRows.set(id, v) },
        prefs: { forCwd: () => ({ orchestrator: {} }) },
        usage: { snapshot: () => ({ windows: win.claude }) },
        codexQuota: { snapshot: () => ({ signedIn: true, windows: win.codex }) },
        normalizeMode: (m) => m || 'auto',
        sessionCwd: (s) => s.cwd,
        tooManyCreates: () => false,
        resumeGraceMs: 0,
    };
    orchestration.init(deps);
    const know = (id, extra = {}) => known.set(id, { sessionId: id, cwd: home, projectCwd: home, title: id,
        permissionMode: 'auto', ...extra });
    return { pool, store, known, files, flagRows, know, win };
}

(async () => {
    // --- the store's re-key ----------------------------------------------------

    {
        const file = fileOf('rekey');
        const s = new Orchestrators({ file });
        s.enable('placeholder');
        s.setSummary('placeholder', 'first brief', {});
        s.flush();
        // Another bridge read the file while the placeholder was in it.
        const other = new Orchestrators({ file });
        assert.ok(other.get('placeholder'));
        assert.strictEqual(s.rekeyOrchestrator('placeholder', 'thread-1'), true);
        assert.strictEqual(s.get('placeholder'), null);
        assert.strictEqual(s.get('thread-1').id, 'thread-1');
        assert.strictEqual(s.get('thread-1').summary.text, 'first brief', 'the record moves whole');
        s.flush();
        let disk = JSON.parse(fs.readFileSync(file, 'utf8')).orchestrators;
        assert.deepStrictEqual(Object.keys(disk), ['thread-1'], 'the placeholder is gone from the file');
        // The other bridge writes something of its own; the placeholder it still
        // holds in memory is not dirty there, so it is not written back.
        other.enable('unrelated');
        other.flush();
        disk = JSON.parse(fs.readFileSync(file, 'utf8')).orchestrators;
        assert.ok(!('placeholder' in disk), 'another bridge\'s write does not resurrect it');
        assert.ok('thread-1' in disk && 'unrelated' in disk);
        assert.strictEqual(s.rekeyOrchestrator('nobody', 'x'), false);
        ok('a re-keyed orchestrator moves under its minted id and the placeholder never comes back');
    }

    // --- roles and the brief ---------------------------------------------------

    {
        const h = harness('brief');
        h.pool._runtimeOf.set('ph-1', 'codex');
        orchestration.enable('ph-1', null);
        let role = orchestration.roleOf('ph-1');
        assert.strictEqual(role.role, 'orchestrator');
        assert.ok(!role.brief.includes('ph-1'), 'the placeholder is never offered as its id');
        assert.match(role.brief, /thread id Codex gave you/);
        assert.match(role.brief, /runtime: "claude" \(Claude Code\) or "codex"/);
        assert.match(role.brief, /Left out, a worker runs on\n {2}Codex/, 'its workers default to Codex');
        assert.ok(!/A\n {2}`cd` there is what strands you/.test(role.brief), 'the Claude-only stranding line is left out');

        h.pool.mint('ph-1', 'thread-9');
        assert.strictEqual(h.store.get('ph-1'), null);
        assert.ok(h.store.get('thread-9'), 'the minted event moved it');
        assert.strictEqual(orchestration.resolveId('ph-1'), 'thread-9', 'the placeholder still answers for a while');
        assert.strictEqual(orchestration.resolveId('thread-9'), 'thread-9');
        assert.strictEqual(orchestration.resolveId('never-was'), 'never-was');
        h.know('thread-9', { runtime: 'codex' });
        role = orchestration.roleOf('thread-9');
        assert.match(role.brief, /session id thread-9/, 'once the id is real, it is said');
        const p = orchestration.payload('thread-9');
        assert.strictEqual(p.runtime, 'codex');
        assert.deepStrictEqual(p.runtimes, ['codex']);

        // A Claude orchestrator's brief is what it was.
        h.know('claude-o');
        orchestration.enable('claude-o', null);
        const c = orchestration.roleOf('claude-o').brief;
        assert.match(c, /session id claude-o/);
        assert.match(c, /`cd` there is what strands you/);
        assert.match(c, /Left out, a worker runs on\n {2}Claude Code/);
        ok('a Codex orchestrator is briefed without the placeholder, re-keyed on mint, and Claude\'s brief keeps its lines');
    }

    {
        // Its MCP server is the orchestrator's, and the placeholder rides along for tools/list only.
        const fresh = threadConfig({ sessionId: 'ph-2', isNew: true, role: 'orchestrator' });
        const args = fresh['mcp_servers.tgxcode'].args;
        assert.strictEqual(args[args.indexOf('--role') + 1], 'orchestrator');
        assert.strictEqual(args[args.indexOf('--provisional') + 1], 'ph-2');
        assert.ok(!args.includes('--session'), 'never as the session id');
        assert.ok(args.includes('--session-from-call'));
        const worker = threadConfig({ sessionId: 'ph-3', isNew: true, role: 'worker' });
        assert.ok(!worker['mcp_servers.tgxcode'].args.includes('--provisional'), 'a worker reads nothing at listing time');
        const resumed = threadConfig({ sessionId: 'thread-9', isNew: false, role: 'orchestrator' });
        assert.ok(!resumed['mcp_servers.tgxcode'].args.includes('--provisional'));
        ok('a new Codex orchestrator\'s server is told its role, and its placeholder only as provisional');
    }

    {
        // mcp.js, run for real: tools/list reads the settings by the placeholder,
        // and a Codex orchestrator's spawn_worker takes Codex ids and a runtime.
        fs.mkdirSync(path.dirname(cfg.TOKEN_FILE), { recursive: true });
        fs.writeFileSync(cfg.TOKEN_FILE, 'codex-orch-token', { mode: 0o600 });
        const seen = [];
        const bridge = http.createServer((req, res) => {
            seen.push(req.url);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ enabled: true, runtime: 'codex', settings: DEFAULT_SETTINGS }));
        });
        await new Promise(r => bridge.listen(0, '127.0.0.1', r));
        const list = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'mcp.js'),
                '--port', String(bridge.address().port), '--provisional', 'ph-4', '--session-from-call',
                '--role', 'orchestrator'], { env: { ...process.env, XDG_DATA_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
            let buf = '';
            child.stdout.on('data', (b) => {
                buf += b;
                const line = buf.split('\n').find(l => l.includes('"id":2'));
                if (line) { child.kill(); resolve(JSON.parse(line)); }
            });
            child.on('error', reject);
            const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
            send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            // What Codex sends, measured: no thread id at listing time.
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { progressToken: 0 } } });
            setTimeout(() => { child.kill(); reject(new Error('mcp.js did not answer')); }, 10_000);
        });
        bridge.close();
        assert.deepStrictEqual(seen, ['/api/sessions/ph-4/orchestrator'], 'read by the placeholder');
        const sw = list.result.tools.find(t => t.name === 'spawn_worker');
        assert.ok(sw, 'the orchestrator tools are listed');
        assert.ok(!sw.inputSchema.properties.model.enum, 'no Claude enum to refuse a Codex id');
        assert.deepStrictEqual(sw.inputSchema.properties.runtime.enum, ['claude', 'codex']);
        assert.match(sw.description, /You run on Codex/);
        ok('mcp.js lists a Codex orchestrator\'s tools from its placeholder, with Codex models allowed');
    }

    // --- its own model ---------------------------------------------------------

    {
        const h = harness('own-model');
        h.know('cx', { runtime: 'codex' });
        h.know('cl');
        orchestration.enable('cx', { orchestratorModel: 'opus', orchestratorEffort: 'high' });
        orchestration.enable('cl', { orchestratorModel: 'opus', orchestratorEffort: 'high' });
        assert.strictEqual(orchestration.ownModel('cx'), null, 'a Claude alias is never forced onto Codex');
        assert.deepStrictEqual(orchestration.ownModel('cl'), { model: 'opus', effort: 'high' });
        ok('the own-model setting applies to a Claude orchestrator only');
    }

    // --- workers -----------------------------------------------------------------

    {
        const h = harness('spawn');
        h.know('cx', { runtime: 'codex' });
        orchestration.enable('cx', { workerModel: 'opus', worktree: false });
        let res = await orchestration.spawn('cx', { prompt: 'do a', worktree: false });
        assert.strictEqual(h.pool.created[0].runtime, 'codex', 'a Codex orchestrator\'s worker runs on Codex');
        assert.strictEqual(h.pool.created[0].model, null, 'Settings\' Claude worker model does not apply to it');
        assert.strictEqual(res.runtime, 'codex');
        assert.ok(res.sessionId.startsWith('thread-'), 'answered with the minted id');
        const w = h.store.worker('cx', res.sessionId);
        assert.strictEqual(w.runtime, 'codex', 'the row keeps its runtime');

        res = await orchestration.spawn('cx', { prompt: 'do b', worktree: false, model: 'gpt-6.2-sol', effort: 'high' });
        assert.strictEqual(h.pool.created[1].model, 'gpt-6.2-sol');
        assert.strictEqual(h.pool.created[1].effort, 'high');

        await assert.rejects(orchestration.spawn('cx', { prompt: 'x', worktree: false, model: 'opus' }),
            (e) => e.status === 400 && /unknown Codex model "opus"/.test(e.message) && /gpt-6-luna/.test(e.message));
        await assert.rejects(orchestration.spawn('cx', { prompt: 'x', worktree: false, effort: 'max' }),
            (e) => e.status === 400 && /unknown Codex effort/.test(e.message));
        await assert.rejects(orchestration.spawn('cx', { prompt: 'x', worktree: false, runtime: 'nope' }),
            (e) => e.status === 400 && /unknown runtime/.test(e.message));

        res = await orchestration.spawn('cx', { prompt: 'do c', worktree: false, runtime: 'claude', model: 'haiku' });
        const third = h.pool.created[2];
        assert.strictEqual(third.runtime, 'claude', 'it can still start a Claude worker');
        assert.strictEqual(third.model, 'opus', 'and Settings\' worker model is fixed for that one');
        assert.strictEqual(res.overridden.model, 'haiku');
        assert.deepStrictEqual(orchestration.payload('cx').runtimes.sort(), ['claude', 'codex']);
        ok('spawn_worker defaults to the orchestrator\'s runtime and checks a Codex model against Codex\'s list');
    }

    // --- the cutoff ----------------------------------------------------------------

    {
        const s = cleanSettings({});
        assert.strictEqual(s.usageStop.codexPercent, 90, 'on by default, at 90');
        assert.strictEqual(cleanSettings({ usageStop: { codexPercent: null } }).usageStop.codexPercent, null);
        assert.strictEqual(cleanSettings({ usageStop: { codexPercent: 400 } }, cleanSettings({ usageStop: { codexPercent: 70 } }))
            .usageStop.codexPercent, 70, 'a bad value keeps the old one');
        const old = cleanSettings({ usageStop: { enabled: true } }, { usageStop: { enabled: true, percent: 80, window: 'five_hour' } });
        assert.strictEqual(old.usageStop.codexPercent, 90, 'a store from before the field reads the default');

        const now = Date.now();
        const future = Math.floor(now / 1000) + 3600;
        const ws = [{ type: 'five_hour', usedPercent: 50, resetsAt: future },
            { type: 'codex:primary', label: 'Codex 30-day', usedPercent: 93, resetsAt: future }];
        let trips = usageTrips(s, ws, now);
        assert.deepStrictEqual(trips.map(t => [t.window, t.percent, t.label]), [['codex:primary', 90, 'Codex 30-day']]);
        trips = usageTrips(cleanSettings({ usageStop: { codexPercent: null } }), ws, now);
        assert.deepStrictEqual(trips, [], 'null leaves Codex out');
        trips = usageTrips(cleanSettings({ usageStop: { window: 'all' } }), ws, now);
        assert.strictEqual(trips.length, 1, 'whatever `window` says');
        const passed = [{ type: 'codex:primary', usedPercent: 99, resetsAt: Math.floor(now / 1000) - 5 }];
        assert.deepStrictEqual(usageTrips(s, passed, now), [], 'a reading from before its reset is not a trip');
        ok('usageTrips judges Codex windows against codexPercent');
    }

    {
        const future = Math.floor(Date.now() / 1000) + 3600;
        const codexHigh = [{ type: 'primary', label: '30-day', usedPercent: 97, resetsAt: future }];
        const claudeHigh = [{ type: 'five_hour', usedPercent: 99, resetsAt: future }];

        // A Codex reading past its line never pauses an orchestration that runs nothing on Codex.
        let h = harness('claude-only', { codexWindows: codexHigh });
        h.know('cl');
        orchestration.enable('cl', null);
        h.pool.ensure('cl');
        orchestration.checkUsage();
        assert.strictEqual(h.store.get('cl').paused, null, 'Codex past 90% does not pause Claude');
        assert.deepStrictEqual(orchestration.windowsFor(h.store.get('cl')).map(w => w.type), []);

        // And a Claude reading past its line never pauses one that runs nothing on Claude.
        h = harness('codex-only', { claudeWindows: claudeHigh });
        h.know('cx', { runtime: 'codex' });
        orchestration.enable('cx', null);
        h.pool._runtimeOf.set('cx', 'codex');
        h.pool.ensure('cx');
        orchestration.checkUsage();
        assert.strictEqual(h.store.get('cx').paused, null, 'Claude past 90% does not pause Codex');

        // Its own account past the line does.
        h.win.codex = codexHigh;
        h.pool.get('cx').state = 'busy';
        orchestration.checkUsage();
        const paused = h.store.get('cx').paused;
        assert.ok(paused, 'Codex past 90% pauses a Codex orchestrator');
        assert.match(paused.reason, /^Codex 30-day usage at 97%, past the 90% cutoff/);
        assert.deepStrictEqual(paused.interrupted, ['cx'], 'and stops its turn');
        assert.strictEqual(h.pool.get('cx').stopped, 1);
        const u = orchestration.usageFor('cx');
        assert.deepStrictEqual(u.windows.map(w => [w.type, w.label]), [['codex:primary', 'Codex 30-day']],
            'get_usage reports the window it is judged by, labelled');

        // A Claude worker brings Claude's windows in.
        h = harness('mixed', { claudeWindows: claudeHigh });
        h.know('cx', { runtime: 'codex' });
        orchestration.enable('cx', { worktree: false });
        h.pool._runtimeOf.set('cx', 'codex');
        h.pool.ensure('cx');
        await orchestration.spawn('cx', { prompt: 'claude work', worktree: false, runtime: 'claude' });
        orchestration.checkUsage();
        assert.ok(h.store.get('cx').paused, 'with a Claude worker, Claude\'s line counts');
        ok('each account\'s cutoff pauses only what spends it, in both directions');
    }

    {
        // Auto-resume on a Codex reset: the pause lifts once the window has reset.
        const soon = Math.floor(Date.now() / 1000) + 1;
        const h = harness('wake', { codexWindows: [{ type: 'primary', label: '30-day', usedPercent: 95, resetsAt: soon }] });
        h.know('cx', { runtime: 'codex' });
        orchestration.enable('cx', { usageStop: { autoResume: true } });
        h.pool._runtimeOf.set('cx', 'codex');
        h.pool.ensure('cx');
        orchestration.checkUsage();
        const p = h.store.get('cx').paused;
        assert.ok(p && p.resumeAt === soon * 1000, 'it waits for the Codex window\'s reset');
        await sleep(soon * 1000 - Date.now() + 400);
        assert.strictEqual(h.store.get('cx').paused, null, 'and lifts itself when it comes');
        const note = h.store.get('cx').inbox.find(i => i.kind === 'note');
        assert.match(note.text, /The window has reset/);
        ok('a Codex orchestrator wakes by itself after its Codex window resets');
    }

    // --- moving it ---------------------------------------------------------------

    {
        const h = harness('move');
        const rollout = path.join(home, 'rollout-x.jsonl');
        fs.writeFileSync(rollout, '{}\n');
        const sub = path.join(home, 'moved');
        fs.mkdirSync(sub, { recursive: true });
        h.know('cx', { runtime: 'codex' });
        orchestration.enable('cx', null);
        h.pool._runtimeOf.set('cx', 'codex');
        h.pool.ensure('cx');
        assert.strictEqual(orchestration.resumeFinds('cx'), false, 'no rollout on record: nothing to resume');
        await assert.rejects(async () => orchestration.moveTo('cx', { cwd: sub }),
            (e) => e.status === 409 && /Codex rollout is not on disk/.test(e.message));
        h.files.set('cx', { file: rollout });
        assert.strictEqual(orchestration.resumeFinds('cx'), true, 'its rollout is what thread/resume needs');
        const out = orchestration.moveTo('cx', { cwd: sub });
        assert.deepStrictEqual(out.moved && [out.moved.from, out.moved.to], [home, sub]);
        assert.deepStrictEqual(h.pool.relocated, [{ id: 'cx', cwd: sub }], 'the process is replaced to resume there');
        assert.strictEqual(h.store.cwdOverride('cx', null).cwd, sub);
        ok('move_session moves a Codex orchestrator by resuming its thread in the new directory');
    }

    // --- the nudge ---------------------------------------------------------------

    {
        const h = harness('nudge');
        h.know('cx', { runtime: 'codex' });
        orchestration.enable('cx', { worktree: false });
        h.pool._runtimeOf.set('cx', 'codex');
        const res = await orchestration.spawn('cx', { prompt: 'w', worktree: false });
        orchestration.report(res.sessionId, 'update', 'halfway there');
        assert.strictEqual(orchestration.nudge('cx'), true, 'an idle Codex orchestrator is nudged');
        const r = h.pool.get('cx');
        assert.strictEqual(r.runtime, 'codex', 'on its Codex runner');
        const env = codexReader.envelopeOf(r.sent[0]);
        assert.strictEqual(env && env.kind, 'orchestrator-inbox', 'and the Codex reader reads the nudge back as one');
        assert.strictEqual(env.fields.count, 1);
        ok('the inbox nudge reaches a Codex orchestrator and reads back as a nudge, not raw markup');
    }

    fs.rmSync(home, { recursive: true, force: true });
    console.log(`${pass} codex-orchestrator checks passed`);
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
