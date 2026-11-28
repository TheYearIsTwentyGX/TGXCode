'use strict';

// The pull-request gate on Codex (docs/plans/23-codex.md, Phase 4): a
// `runtime: "codex"` schedule's review of a pull request goes to Codex's own
// reviewer, `review/start` with a `custom` target naming the gate's range, and its
// priority-tagged findings come back as the `VERDICT:` line the gate reads.
//
//   node test/codex-review.test.js
//
// No bridge, no network and no Codex. The real Runner is driven over
// test/fixtures/codex/review.ndjson (recorded on 0.172.0 against a scratch repo)
// through the replay walker. **Its own XDG_DATA_HOME, set before any require**:
// schedules.json lives in STATE_DIR, shared with every bridge on the machine. And
// **nothing here can reach GitHub**: `pulls` is replaced by a stub that fails the
// test if it is called at all, which is the point of the `test` row case.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-codex-review-')));
process.env.XDG_DATA_HOME = home;
process.env.XDG_CACHE_HOME = path.join(home, 'cache');
process.env.TGXCODE_PORT = '45944';
const REPO = path.join(__dirname, '..');

const FIX = path.join(__dirname, 'fixtures', 'codex');
const walker = path.join(home, 'codex-walker.js');
const logFile = path.join(home, 'wire.ndjson');
fs.writeFileSync(walker, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(FIX, 'walker.js'))});\n`, { mode: 0o755 });
process.env.TGXCODE_CODEX_BIN = walker;
process.env.FAKE_CODEX_LOG = logFile;

// Before anything requires pr-gate: every write to GitHub goes through `pulls`.
const pulls = require('../bridge/pulls');
const ghCalls = [];
for (const k of ['comment', 'setVerdictLabel', 'run']) {
    pulls[k] = async (...a) => { ghCalls.push([k, a]); throw new Error(`pulls.${k} must not be called here`); };
}

const review = require('../bridge/codex/review');
const { Runner } = require('../bridge/runner');
const { CodexAdapter } = require('../bridge/runtimes/codex/process');
const { verdictOf, reviewKey, Schedules, STATE_FILE } = require('../bridge/schedule');
const scheduler = require('../bridge/scheduler');
const gate = require('../bridge/pr-gate');
const prReviews = require('../bridge/pr-reviews');
const codexReader = require('../bridge/runtimes/codex/transcript');

assert.ok(STATE_FILE.startsWith(home), 'the schedule store is this test\'s own');

let pass = 0;
const ok = (what) => { pass++; console.log(`  ok  ${what}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (fn()) return; await sleep(20); }
    assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}
const wire = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);

const RECORDED = 'The sole change replaces addition with subtraction, breaking the function\'s expected behavior.\n\n'
    + 'Review comment:\n\n- [P1] Preserve addition in `add()` — /tmp/codex-fixture-review-M7wzGW/math.js:2-2\n'
    + '  For any inputs, this changes `add(a, b)` to subtract `b` from `a`.';

(async () => {
    // --- the mapping ---------------------------------------------------------------

    {
        assert.deepStrictEqual(review.findingsOf(RECORDED).map(f => f.priority), [1]);
        assert.strictEqual(review.reviewVerdict(RECORDED), 'BLOCK', 'P1 blocks');
        assert.strictEqual(review.reviewVerdict('- [P0] Data loss — a.js:1'), 'BLOCK', 'P0 blocks');
        assert.strictEqual(review.reviewVerdict('- [P2] Racy — a.js:1\n- [P3] Nit — b.js:2'), 'CONCERNS');
        assert.strictEqual(review.reviewVerdict('* [P3] Rename — a.js:1'), 'CLEAN', 'nits alone are clean');
        assert.strictEqual(review.reviewVerdict('I did not find any problems with this change.'), 'CLEAN');
        assert.strictEqual(review.reviewVerdict(''), null, 'no text is not a clean review');
        assert.strictEqual(review.reviewVerdict('We discussed [P1] tags.'), 'CLEAN', 'a tag mid-sentence is not a finding');

        const posted = review.withVerdict(RECORDED);
        assert.strictEqual(verdictOf(posted), 'BLOCK', 'the gate\'s own reader finds the verdict');
        assert.ok(posted.startsWith(RECORDED), 'Codex\'s text first, unchanged');
        assert.match(posted, /\n\nVERDICT: BLOCK — mapped by TGXCode from Codex's priorities \(1 × P1;/);
        assert.strictEqual(review.withVerdict(`${RECORDED}\n\nVERDICT: CONCERNS`), `${RECORDED}\n\nVERDICT: CONCERNS`,
            'a review that already says one is left alone');
        const output = { findings: [{ priority: 2, title: '[P2] x' }, { priority: 3, title: '[P3] y' }] };
        assert.strictEqual(review.verdictOfOutput(output), 'CONCERNS');
        assert.strictEqual(review.verdictOfOutput({ findings: [] }), 'CLEAN');
        assert.strictEqual(review.verdictOfOutput(null), null);
        assert.match(review.withVerdict('All good overall.', output), /VERDICT: CONCERNS .*1 × P2, 1 × P3/,
            'the rollout\'s integers win over the text when there are any');

        const ins = review.reviewInstructions({ head: 'b'.repeat(40), since: 'a'.repeat(40), count: 2,
            pr: { number: 12, title: 'Tidy "add"', branch: 'feature', base: 'main' } }, 'Look hard at error paths.');
        assert.match(ins, /^Review pull request #12 \("Tidy 'add'"\), branch feature into main: the commits a{40}\.\.b{40} \(2 commits\)\./);
        assert.match(ins, new RegExp(`git diff a{40} b{40}`));
        assert.match(ins, new RegExp(`git show b{40}:<path>`), 'how to read the head without a checkout');
        assert.match(ins, /Do not edit files, commit, push or post anything/);
        assert.match(ins, /also says:\n\nLook hard at error paths\.$/, 'the schedule\'s prompt rides along');
        ok('Codex\'s priorities map to the gate\'s verdict, and the instructions name the exact range');
    }

    // --- the adapter -----------------------------------------------------------------

    {
        const a = new CodexAdapter({ rpc: async () => ({}) });
        assert.strictEqual(a.reviews, true);
        a.threadId = 'thread-1';
        const target = { type: 'custom', instructions: 'Review it.' };
        const msg = a.turn({ uuid: 'u1', text: 'Review #12', review: target }, { handOver: false });
        assert.deepStrictEqual(msg, { id: msg.id, method: 'review/start', params: { threadId: 'thread-1', target } });
        assert.match(msg.id, /^cx_/);
        const [started] = a.read({ id: msg.id, result: { turn: { id: 'turn-r' }, reviewThreadId: 'thread-1' } });
        assert.deepStrictEqual(started, { type: 'lifecycle', uuid: 'u1', state: 'started' }, 'its reply starts the turn');
        a.read({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-r' } } });
        a.read({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'exitedReviewMode', id: 'x', review: RECORDED } } });
        const [end] = a.read({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-r',
            status: 'completed', items: [{ type: 'agentMessage', id: 'm', text: RECORDED }] } } });
        assert.strictEqual(end.type, 'turn-end');
        assert.strictEqual(verdictOf(end.result.text), 'BLOCK', 'the result carries the verdict');
        // An ordinary turn's text is untouched.
        a.read({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-2' } } });
        const [plain] = a.read({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2',
            status: 'completed', items: [{ type: 'agentMessage', id: 'm2', text: 'pong' }] } } });
        assert.strictEqual(plain.result.text, 'pong');

        const claude = new Runner({ sessionId: randomUUID(), cwd: home, isNew: true });
        assert.throws(() => claude.send('Review #1', [], { review: target }), /cannot run a native review/,
            'a Claude session is never handed one');
        assert.strictEqual(claude.queue.length, 0);
        ok('a review entry goes as review/start, and its turn ends with the verdict line');
    }

    // --- a real Runner over the recording ------------------------------------------

    {
        process.env.FAKE_CODEX_FIXTURE = path.join(FIX, 'review.ndjson');
        fs.rmSync(logFile, { force: true });
        const r = new Runner({ sessionId: randomUUID(), cwd: home, isNew: true, runtime: 'codex', permissionMode: 'dontAsk' });
        r.hasViewer = () => false;
        const target = { type: 'custom', instructions: 'Review pull request #7.' };
        const ends = [];
        r.on('turn-complete', (res) => ends.push(res));
        r.send('Review #7 with Codex\'s reviewer', [], { review: target });
        await until(() => ends.length === 1 && r.state === 'idle', 10_000, 'the review turn to end');
        const got = wire().filter(l => l.got && l.got.method).map(l => l.got.method);
        assert.deepStrictEqual(got.filter(m => m === 'review/start' || m === 'turn/start'), ['review/start'],
            'the review was sent as review/start, once, and no turn/start');
        assert.deepStrictEqual(wire().filter(l => l.mismatch), [], 'the conversation was the recorded one');
        assert.strictEqual(verdictOf(r.lastResultText), 'BLOCK');
        assert.strictEqual(verdictOf(r.lastResultBody), 'BLOCK', 'the body the gate posts carries it too');
        assert.match(r.lastResultBody, /\[P1\] Preserve addition/);
        assert.strictEqual(r.inFlight.length, 0, 'nothing left in flight');
        assert.strictEqual(ends[0].isError, false);

        // A message queued behind a review waits for it rather than being steered in.
        const q = new Runner({ sessionId: randomUUID(), cwd: home, runtime: 'codex' });
        q.queue.push({ id: 'a', uuid: 'ua', text: 'review', review: target }, { id: 'b', uuid: 'ub', text: 'after' });
        q._lifecycle = true;
        q._pendingTools = new Set(['t']);
        q.proc = { stdin: { writable: true } };
        const written = [];
        q._write = (m) => { written.push(m); return true; };
        q._handOver();
        assert.deepStrictEqual(written, [], 'nothing is handed over past a waiting review');
        r.retire && r.retire();
        ok('a real Runner sends the recorded review and ends on its verdict');
    }

    // --- the schedule ------------------------------------------------------------------

    {
        const created = [];
        const pool = new EventEmitter();
        pool.runners = new Map();
        pool.get = (id) => pool.runners.get(id) || null;
        pool.create = (o) => {
            const r = new EventEmitter();
            r.sessionId = o.sessionId || randomUUID();
            r.adapter = { product: 'Codex' };
            r.status = () => ({ state: 'starting' });
            pool.runners.set(r.sessionId, r);
            created.push(o);
            if (o.runtime === 'codex') {
                setImmediate(() => {
                    const to = `codex-${created.length}`;
                    const from = r.sessionId;
                    r.sessionId = to;
                    pool.runners.delete(from);
                    pool.runners.set(to, r);
                    r.emit('minted', { from, to });
                });
            }
            return { sessionId: r.sessionId, status: r.status() };
        };
        const s = new Schedules();
        scheduler.init({
            schedules: s, pool, flags: { set: () => {}, get: () => ({}) }, index: { note: () => {} },
            notifications: { record: (e) => e }, filed: () => {},
            normalizeMode: (m) => m || 'auto', modeRefusal: () => null,
            tooManyCreates: () => false, CREATE_LIMIT: { max: 10 },
        });
        const facts = { at: Date.now(), head: 'b'.repeat(40), since: 'a'.repeat(40), count: 1, ref: 'feature',
            pr: { number: 7, url: 'https://github.com/o/r/pull/7', title: 'Tidy add()', branch: 'feature', base: 'main',
                author: 'x', repo: 'o/r' } };
        const target = { repo: 'o/r', number: 7, headSha: 'b'.repeat(40), facts };
        const codexRow = s.create({ cwd: REPO, prompt: 'Mind the error paths of {{prBranch}}.', cron: '0 2 * * *',
            runtime: 'codex', test: true, permissionMode: 'dontAsk',
            gate: { kind: 'open-prs', includeDrafts: false, post: true } });
        const out = await scheduler.runSchedule(codexRow, { force: true, target });
        assert.ok(out.ok, out.error);
        const c = created[0];
        assert.strictEqual(c.runtime, 'codex');
        assert.strictEqual(c.review.type, 'custom', 'Codex\'s reviewer, with the custom target');
        assert.match(c.review.instructions, new RegExp(`the commits a{40}\\.\\.b{40}`), 'the range the gate resolved');
        assert.match(c.review.instructions, /Mind the error paths of feature\./, 'the schedule\'s prompt, filled, rides along');
        assert.strictEqual(c.prompt, 'Review #7 — Tidy add() with Codex\'s reviewer', 'the chip says which PR');
        assert.strictEqual(out.sessionId, 'codex-1', 'remembered under the minted id');

        const claudeRow = s.create({ cwd: REPO, prompt: '/adversarial-reviewer --diff {{range}}', cron: '0 2 * * *',
            test: true, permissionMode: 'dontAsk', gate: { kind: 'open-prs', includeDrafts: false, post: true } });
        const out2 = await scheduler.runSchedule(claudeRow, { force: true, target });
        assert.ok(out2.ok, out2.error);
        assert.strictEqual(created[1].review, undefined, 'a Claude gate is an ordinary turn, as before');
        assert.match(created[1].prompt, new RegExp(`^/adversarial-reviewer --diff a{12}\\.\\.b{12}`));

        // An ungated Codex schedule is an ordinary turn too.
        const plainRow = s.create({ cwd: REPO, prompt: 'Summarise the week.', cron: '0 2 * * *', runtime: 'codex', test: true });
        await scheduler.runSchedule(plainRow, { force: true });
        assert.strictEqual(created[2].review, undefined);
        ok('a Codex PR gate\'s run is a custom-target review of the resolved range; other runs are unchanged');

        // **A test row never writes to GitHub**, whatever the review said.
        const body = review.withVerdict(RECORDED);
        // The entry the sweep writes at session start, as fireSchedule does.
        s.noteReview(codexRow.id, reviewKey('o/r', 7), { sha: 'b'.repeat(40), sessionId: 'codex-1' });
        await gate.postReviewToPr(codexRow, target, { sessionId: 'codex-1', verdict: verdictOf(body), outcome: 'BLOCK', body });
        assert.deepStrictEqual(ghCalls, [], 'no comment and no label');
        assert.strictEqual(s.get(codexRow.id).reviewed[reviewKey('o/r', 7)].posted, 'skipped-test');
        ok('a test schedule\'s Codex review posts nothing to GitHub');
    }

    // --- reading it back --------------------------------------------------------------

    {
        const buf = fs.readFileSync(path.join(FIX, 'review.rollout.jsonl'));
        const name = '/x/rollout-2026-11-28T11-21-19-01a2232c-f9f6-70f2-a971-88bc5ab26a34.jsonl';
        const text = prReviews.lastAssistantText(buf, name);
        assert.strictEqual(verdictOf(text), 'BLOCK', 'from the rollout\'s structured review_output');
        const parsed = prReviews.parseReview(text);
        assert.strictEqual(parsed.verdict, 'BLOCK');
        assert.deepStrictEqual(parsed.findings.map(f => [f.severity, f.title, f.line]),
            [['critical', 'Preserve addition in add()', 2]]);
        assert.match(parsed.findings[0].file, /math\.js$/);
        assert.match(parsed.summary, /replaces addition with subtraction/);
        const mixed = prReviews.parseReview('Two things.\n\n- [P2] Racy cache — a.js:4-6\n  why\n- [P3] Name — b.js:1\n  nit');
        assert.deepStrictEqual(mixed.findings.map(f => f.severity), ['warning', 'note']);
        assert.strictEqual(mixed.verdict, 'CONCERNS', 'no VERDICT line: read off the priorities');

        const { entries } = codexReader.parseLines(buf);
        const events = codexReader.buildEvents(entries, {});
        const first = (events.events || events).find(e => e.kind === 'user');
        assert.strictEqual(first.origin, 'review');
        assert.match(first.text, /^Review pull request #7/, 'the review\'s instructions are its opening message');
        assert.ok(!(events.events || events).some(e => e.kind === 'tool' && /ReviewMode/.test(e.name)),
            'and the review-mode items are not drawn as tools');
        assert.match(codexReader.scanMeta(path.join(FIX, 'review.rollout.jsonl')).title, /^Review pull request #7/);
        ok('a Codex review reads back from its rollout with its verdict, findings and title');
    }

    fs.rmSync(home, { recursive: true, force: true });
    console.log(`${pass} codex-review checks passed`);
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
