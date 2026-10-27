'use strict';

// Moving an orchestrator to another directory — orchestration.moveTo, and the
// move queued for the end of a turn (settleMove). The `move_session` tool asks
// for it from inside a turn, so the deferred half is the one that matters.
//
// What can go wrong is quiet. A queued message written to the old process
// starts one more turn in the directory being left, and the move then waits
// for that one too; a move made inside the runner's own handler leaves the rest
// of the handler running on a retired runner; a cancelled move that forgets to
// let the queue go leaves a session that accepts a message and never sends it.
// So the cases drive a real RunnerPool against a stub `claude` (runner.test.js's
// approach, smaller) and assert on which process, in which directory, read what.
//
// And the trap itself: a session started in a plain directory holding two
// repositories that `cd`-ed into one repository's worktree. The transcript's
// trail files it in that worktree for good; the move has to win over every line
// written after it.
//
// **XDG_DATA_HOME and the stub before the require**, as in restart-process: the
// constants are read at load, and a fresh STATE_DIR has no session host to find.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'move-session-')));
const stub = path.join(root, 'fake-claude.js');
const logFile = path.join(root, 'log.ndjson');

// `system/init` on start, a `control_response` to anything asked, and per turn a
// `result` — or, for SLOW<n>, one after n ms. Every start is logged with its
// cwd, and every turn with the pid that read it.
const STUB = `#!${process.execPath}
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i < 0 ? null : argv[i + 1]; };
const sessionId = at('--session-id') || at('--resume') || 'stub';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const log = (o) => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...o }) + '\\n');
const result = (text) => out({ type: 'result', subtype: 'success', is_error: false, result: text,
    duration_ms: 1, num_turns: 1, total_cost_usd: 0, session_id: sessionId });
log({ start: true, argv });
out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(),
      model: 'stub', tools: [], slash_commands: [] });
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'control_request') {
        return out({ type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response: {} } });
    }
    if (m.type !== 'user') return;
    const text = (m.message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\\n');
    log({ text });
    const slow = /\\bSLOW(\\d+)\\b/.exec(text);
    if (slow) return setTimeout(() => result(text), Number(slow[1]));
    result(text);
}).on('close', () => process.exit(0));
`;
fs.writeFileSync(stub, STUB, { mode: 0o755 });

process.env.XDG_DATA_HOME = path.join(root, 'data');
process.env.TGXCODE_CLAUDE_BIN = stub;
process.env.FAKE_CLAUDE_LOG = logFile;
process.env.TGXCODE_ROOTS = root;
process.env.TGXCODE_PROJECTS_DIR = path.join(root, 'projects');
// Never reached: it only lands in the --mcp-config string the stub ignores.
process.env.TGXCODE_PORT = '45943';

const { RunnerPool } = require('../bridge/runner');
const { Orchestrators } = require('../bridge/orchestrators');
const orchestration = require('../bridge/orchestration');
const { scanMeta } = require('../bridge/transcript');
const { SessionIndex } = require('../bridge/sessions');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function until(fn, ms, what) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (fn()) return;
        await sleep(25);
    }
    assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}

const reset = () => fs.rmSync(logFile, { force: true });
const lines = () => (fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const starts = () => lines().filter(l => l.start);
const turns = () => lines().filter(l => l.text !== undefined);

// The shape this was built for: a plain directory holding two repositories, one
// of them with a worktree. `.git` written by hand, as the transcript code reads it.
const parent = path.join(root, 'Combined');
const repo = path.join(parent, 'mobile');
const other = path.join(parent, 'desktop');
const wt = path.join(repo, '.claude', 'worktrees', 'orch-view');
function checkout(dir, branch) {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
}
checkout(repo, 'main');
checkout(other, 'main');
const wtGit = path.join(repo, '.git', 'worktrees', 'orch-view');
fs.mkdirSync(wt, { recursive: true });
fs.mkdirSync(wtGit, { recursive: true });
fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/orch-view\n');

// The transcript `claude --resume` would find: under the projects directory, in
// the directory for where the session started — which is not where it is moved.
const projects = path.join(root, 'projects', '-Combined');
fs.mkdirSync(projects, { recursive: true });
const transcript = (id) => fs.writeFileSync(path.join(projects, `${id}.jsonl`), '');

const pool = new RunnerPool();
pool.hasViewer = () => true;
const store = new Orchestrators({ file: path.join(root, 'orch.json') });
// Where the transcript's trail puts each session; the override wins, as in
// SessionIndex#_summary.
const trail = new Map();
const index = {
    summary: (id) => {
        if (!trail.has(id)) return null;
        const moved = store.cwdOverride(id, {});
        return { sessionId: id, title: id, permissionMode: 'auto',
            cwd: moved ? moved.cwd : trail.get(id), projectCwd: repo };
    },
    get: () => null,
    note: () => {},
};
const deps = {
    store, pool, index,
    flags: { get: () => ({ test: false }), set: () => {} },
    prefs: { forCwd: () => ({ orchestrator: {} }) },
    usage: { snapshot: () => ({ windows: [] }) },
    normalizeMode: (m) => m || 'auto',
    sessionCwd: (s) => (fs.existsSync(s.cwd) ? s.cwd : root),
    tooManyCreates: () => false,
};
orchestration.init(deps);
// What server.js wires: a status is how a turn ending reaches settleMove.
pool.on('status', (s) => orchestration.onStatus(s));
const notices = [];
pool.on('notice', (n) => notices.push(n));

const refusal = (fn) => {
    try { fn(); } catch (e) { return { status: e.status, message: e.message, extra: e.extra }; }
    assert.fail('expected a refusal');
};

/** A new orchestrator, stuck in the worktree, with a process that has had one turn. */
async function stuckOrchestrator() {
    const id = randomUUID();
    trail.set(id, wt);
    transcript(id);
    orchestration.enable(id, null);
    const r = pool.ensure(id, { cwd: wt, isNew: true });
    r.send('hello');
    await until(() => r.state === 'idle' && turns().some(t => t.text === 'hello'), 5000, 'the first turn');
    return { id, r };
}

(async () => {
    // --- the target, and whether it could be resumed there -----------------
    {
        reset();
        assert.strictEqual(refusal(() => orchestration.moveTo('nobody', { cwd: parent })).status, 404);
        const id = randomUUID();
        trail.set(id, wt);
        orchestration.enable(id, null);
        assert.strictEqual(refusal(() => orchestration.moveTo(id, { cwd: 'Combined' })).status, 400,
            'a relative path');
        assert.match(refusal(() => orchestration.moveTo(id, { cwd: path.join(root, 'nope') })).message,
            /does not exist/);
        fs.writeFileSync(path.join(root, 'a-file'), '');
        assert.match(refusal(() => orchestration.moveTo(id, { cwd: path.join(root, 'a-file') })).message,
            /Not a directory/);
        assert.match(refusal(() => orchestration.moveTo(id, { cwd: os.tmpdir() })).message,
            /outside the allowed roots/);
        const gone = refusal(() => orchestration.moveTo(id, { cwd: parent }));
        assert.strictEqual(gone.status, 409, 'no transcript where --resume looks');
        assert.match(gone.message, /claude --resume/);
        assert.strictEqual(store.get(id).cwdOverride, null, 'every refusal changes nothing');
        assert.strictEqual(store.get(id).pendingMove, null);

        // With its transcript in place, anywhere in the roots will do: --resume
        // finds a transcript from any directory, so where it started does not matter.
        transcript(id);
        const out = orchestration.moveTo(id, { cwd: `${other}/` });
        assert.deepStrictEqual(out.moved, { from: wt, to: other, restarted: false },
            'no process: the override alone is the move');
        assert.strictEqual(out.location.cwd, other);
        assert.match(refusal(() => orchestration.moveTo(id, { cwd: other })).message, /already runs in/);
        ok('a move is refused for a relative, missing, non-directory or out-of-roots path, or a transcript --resume would not find');
    }

    // --- mid-turn: queued, made at the turn's end, the queue carried --------
    {
        const { id, r } = await stuckOrchestrator();
        const firstPid = turns().find(t => t.text === 'hello').pid;
        r.send('SLOW700 working');
        await until(() => r.state === 'busy', 3000, 'the slow turn to start');
        const out = orchestration.moveTo(id, { cwd: parent });
        assert.strictEqual(out.queued.cwd, parent);
        assert.strictEqual(out.queued.from, wt);
        assert.strictEqual(out.location.pending.cwd, parent, 'the payload says a move is waiting');
        assert.strictEqual(store.get(id).cwdOverride, null, 'not moved mid-turn');
        assert.strictEqual(pool.get(id), r, 'the process is not touched mid-turn');
        // Sent while it works: held for the new process rather than written to this one.
        r.send('after the move');
        await until(() => pool.get(id) !== r, 5000, 'the move at the end of the turn');
        const fresh = pool.get(id);
        assert.strictEqual(fresh.cwd, parent);
        await until(() => turns().some(t => t.text === 'after the move'), 5000, 'the carried message');
        const carried = turns().filter(t => t.text === 'after the move');
        assert.strictEqual(carried.length, 1, 'delivered once');
        assert.notStrictEqual(carried[0].pid, firstPid, 'by the new process, not the old one');
        assert.strictEqual(carried[0].cwd, parent, 'in the directory it was moved to');
        const started = starts().filter(s => s.pid === carried[0].pid)[0];
        assert.ok(started.argv.includes('--resume'), 'resuming the conversation, not starting a new one');
        assert.strictEqual(store.get(id).pendingMove, null);
        assert.deepStrictEqual({ cwd: store.get(id).cwdOverride.cwd, from: store.get(id).cwdOverride.from },
            { cwd: parent, from: wt });
        assert.ok(notices.some(n => n.sessionId === id && n.kind === 'session_moved'));
        ok('mid-turn the move is queued, made when the turn ends, and what was sent meanwhile runs in the new directory');
    }

    // --- replaced, cancelled ------------------------------------------------
    {
        const { id, r } = await stuckOrchestrator();
        r.send('SLOW700 working');
        await until(() => r.state === 'busy', 3000, 'the slow turn to start');
        orchestration.moveTo(id, { cwd: other });
        assert.strictEqual(orchestration.moveTo(id, { cwd: parent }).queued.cwd, parent,
            'a second request replaces the first');
        assert.strictEqual(store.pendingMove(id).cwd, parent);
        r.send('stays');
        const out = orchestration.cancelMove(id);
        assert.strictEqual(out.cancelled.cwd, parent);
        assert.strictEqual(out.location.pending, null);
        await until(() => turns().some(t => t.text === 'stays'), 5000, 'the message the move was holding');
        assert.strictEqual(pool.get(id), r, 'cancelled: the process stays');
        assert.strictEqual(turns().find(t => t.text === 'stays').cwd, wt);
        assert.strictEqual(store.get(id).cwdOverride, null);

        // Asking for where it already is, with a move queued, is a cancel too.
        r.send('SLOW500 again');
        await until(() => r.state === 'busy', 3000, 'another turn');
        orchestration.moveTo(id, { cwd: parent });
        const back = orchestration.moveTo(id, { cwd: wt });
        assert.strictEqual(back.cancelled.cwd, parent);
        assert.strictEqual(store.pendingMove(id), null);
        await until(() => r.state === 'idle', 3000, 'the turn to end');
        await sleep(50);
        assert.strictEqual(pool.get(id), r, 'nothing moved');
        ok('a second request replaces a queued move; Cancel, or asking for where it is, drops it and lets the queue go');
    }

    // --- background work ----------------------------------------------------
    {
        const { id, r } = await stuckOrchestrator();
        r.background.set('bg1', {});
        const bg = refusal(() => orchestration.moveTo(id, { cwd: parent }));
        assert.strictEqual(bg.status, 409);
        assert.deepStrictEqual(bg.extra, { background: 1 });
        // Work that starts after the move was queued: the move waits for it, and
        // the queue is not held meanwhile — that could be hours.
        r.background.clear();
        r.send('SLOW500 working');
        await until(() => r.state === 'busy', 3000, 'the turn');
        orchestration.moveTo(id, { cwd: parent });
        r.background.set('bg2', {});
        r.send('meanwhile');
        await until(() => turns().some(t => t.text === 'meanwhile'), 5000, 'the message, not held');
        assert.strictEqual(pool.get(id), r, 'not moved while background work runs');
        assert.ok(store.pendingMove(id), 'still waiting');
        await until(() => r.state === 'idle', 3000, 'the turn after');
        r.background.clear();
        r.emit('status', r.status());
        r.emit('background-drained');
        await until(() => pool.get(id) !== r, 3000, 'the move once the work drained');
        assert.strictEqual(pool.get(id).cwd, parent);

        // Forced: made at the turn's end whatever is running.
        const b = await stuckOrchestrator();
        b.r.send('SLOW400 working');
        await until(() => b.r.state === 'busy', 3000, 'the turn');
        b.r.background.set('bg3', {});
        assert.strictEqual(orchestration.moveTo(b.id, { cwd: parent, force: true }).queued.force, true);
        await until(() => pool.get(b.id) !== b.r, 5000, 'the forced move');
        ok('background work refuses a move unless forced, and a queued one waits for work started after it');
    }

    // --- the directory goes away before the turn ends ------------------------
    {
        const { id, r } = await stuckOrchestrator();
        const doomed = fs.mkdtempSync(path.join(root, 'doomed-'));
        r.send('SLOW500 working');
        await until(() => r.state === 'busy', 3000, 'the turn');
        orchestration.moveTo(id, { cwd: doomed });
        r.send('still delivered');
        fs.rmSync(doomed, { recursive: true });
        await until(() => turns().some(t => t.text === 'still delivered'), 5000, 'the held message, let go');
        assert.strictEqual(pool.get(id), r);
        assert.strictEqual(store.pendingMove(id), null);
        assert.strictEqual(store.get(id).cwdOverride, null);
        assert.ok(notices.some(n => n.sessionId === id && n.kind === 'move_failed'), 'and it is told why');
        ok('a target gone by the end of the turn drops the move and lets the queue go');
    }

    // --- across a restart -----------------------------------------------------
    {
        const id = randomUUID();
        trail.set(id, wt);
        transcript(id);
        orchestration.enable(id, null);
        store.setPendingMove(id, { cwd: parent, from: wt });
        store.flush();
        const again = new Orchestrators({ file: path.join(root, 'orch.json') });
        assert.strictEqual(again.pendingMove(id).cwd, parent, 'kept on disk');
        // No process, as after a restart that found none: made at once.
        assert.deepStrictEqual(orchestration.settleMove(id), { from: wt, to: parent, restarted: false });
        assert.strictEqual(store.get(id).cwdOverride.cwd, parent);
        ok('a queued move survives a restart and is made by the first settle');
    }

    // --- the trail: a plain parent directory, and a nested repository's worktree
    {
        const at = (s) => new Date(Date.UTC(2026, 9, 27, 12, 0, s)).toISOString();
        const line = (type, cwd, s) => ({ type, cwd, timestamp: at(s), sessionId: 'B',
            message: { role: type, content: type === 'user' ? 'go' : [{ type: 'text', text: 'ok' }] } });
        const scan = (ls) => {
            const f = path.join(root, `b-${Math.random()}.jsonl`);
            fs.writeFileSync(f, ls.map(l => JSON.stringify(l)).join('\n') + '\n');
            return { ...scanMeta(f), sessionId: 'B' };
        };
        // Started in the parent, wandered into the repository, back out, and then
        // `cd`-ed into its worktree — b18b6a15's trail, in miniature.
        const stuck = [line('user', parent, 0), line('assistant', parent, 1),
            line('user', repo, 2), line('user', parent, 3), line('user', wt, 4), line('assistant', wt, 5)];
        const meta = scan(stuck);
        assert.strictEqual(meta.cwd, wt, 'the trail pins it in the worktree');
        assert.strictEqual(meta.projectCwd, repo, 'and files it under the nested repository');

        const s = new Orchestrators({ file: path.join(root, 'trail.json') });
        const summary = (m) => SessionIndex.prototype._summary.call({
            flags: null, registry: null, later: null, schedules: null, standing: null, orchestrators: s,
        }, { meta: m, size: 0, mtimeMs: 0 });
        s.enable('B');
        s.setCwdOverride('B', { cwd: parent, from: wt, at: Date.parse(at(10)) });
        // Every line the moved process writes is recorded in the parent; the ones
        // after a later `cd` back into the worktree must not take it back.
        const after = scan([...stuck, line('user', parent, 11), line('assistant', parent, 12),
            line('user', wt, 13), line('assistant', wt, 14)]);
        for (const m of [meta, after]) {
            const sum = summary(m);
            assert.strictEqual(sum.cwd, parent, 'the move wins over the trail');
            assert.strictEqual(sum.projectCwd, parent, 'filed under the directory it was moved to');
            assert.strictEqual(sum.projectName, 'Combined');
            assert.strictEqual(sum.worktree, null, 'a plain directory is in no worktree');
            assert.strictEqual(sum.gitBranch, null, 'and on no branch');
        }
        assert.strictEqual(after.cwd, wt, 'the transcript alone would still say the worktree');

        // Moved into a worktree, the worktree is shown — it is where it is.
        s.setCwdOverride('B', { cwd: path.join(wt, 'app'), from: parent, at: Date.parse(at(20)) });
        fs.mkdirSync(path.join(wt, 'app'), { recursive: true });
        const inWt = summary(after);
        assert.strictEqual(inWt.worktree.name, 'orch-view');
        assert.strictEqual(inWt.worktree.path, wt);
        assert.strictEqual(inWt.worktree.branch, 'orch-view');
        assert.strictEqual(inWt.projectCwd, repo, 'filed under the checkout that owns the worktree');
        assert.strictEqual(inWt.gitBranch, 'orch-view');
        // And to the other repository's main checkout: no worktree, its branch.
        s.setCwdOverride('B', { cwd: other, from: wt, at: Date.parse(at(30)) });
        assert.strictEqual(summary(after).worktree, null);
        assert.strictEqual(summary(after).gitBranch, 'main');
        assert.strictEqual(summary(after).projectCwd, other);
        ok('a session that cd-ed from a plain parent into a nested repository\'s worktree stays where it was moved');
    }

    pool.shutdown({ force: true });
    console.log(`\n${pass} move-session checks passed`);
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(0);
})().catch((err) => {
    console.error(err);
    try { pool.shutdown({ force: true }); } catch { /* best effort */ }
    process.exit(1);
});
