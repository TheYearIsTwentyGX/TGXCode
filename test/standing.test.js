'use strict';

// The session standing line, on its own — no bridge, and no `claude`.
//
// What is worth guarding here is quota, and the bugs that spend it do not show:
// a line re-summarised on every bridge restart, a call made while the session is
// already on its next turn, a failed turn paid for. Each looks exactly like the
// feature working. So the class is driven with a fake clock and a counting stub
// in place of the model, and most of what follows asserts *how many calls*.
//
// **XDG_DATA_HOME is set before the require**, for later.test.js's reason:
// bridge/config.js builds STATE_DIR at require time, and without it this test
// would write into the user's real standing.json.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-standing-'));
process.env.XDG_DATA_HOME = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));

const {
    Standing, StandingStore, Debouncer, STATE_FILE,
    lastAssistant, extractLine, buildPrompt, cleanModelLine, shouldSummarise, normalizeMode,
} = require('../bridge/standing');

assert.ok(STATE_FILE.startsWith(home), 'refusing to run: STATE_FILE is not under the temp dir');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const line = (o) => JSON.stringify(o);
const assistant = (uuid, content, extra = {}) =>
    line({ type: 'assistant', uuid, message: { role: 'assistant', content }, ...extra });

// --- lastAssistant ---------------------------------------------------------

{
    const tail = [
        '{"half a line from the middle of the file',
        assistant('a1', [{ type: 'text', text: 'First reply.' }]),
        line({ type: 'user', uuid: 'u2', message: { content: 'go on' } }),
        assistant('a2', [{ type: 'text', text: 'Opened PR #150.' }]),
        assistant('a3', [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]),
        assistant('a4', [{ type: 'text', text: 'subagent chatter' }], { isSidechain: true }),
        '',
    ].join('\n');
    assert.deepStrictEqual(lastAssistant(tail), { uuid: 'a2', text: 'Opened PR #150.' });
    ok('lastAssistant skips tool-only and sidechain entries and a torn first line');
}
{
    assert.strictEqual(lastAssistant(''), null);
    assert.strictEqual(lastAssistant(null), null);
    assert.strictEqual(lastAssistant(line({ type: 'user', uuid: 'u' })), null);
    assert.deepStrictEqual(lastAssistant(assistant('s', 'plain string')), { uuid: 's', text: 'plain string' });
    ok('lastAssistant: nothing to find, and string content');
}

// --- extractLine -----------------------------------------------------------

{
    const reply = [
        'I fixed the race in **login.spec.ts**.',
        '',
        '```js',
        'await page.waitFor()',
        '```',
        '- All 214 tests pass; see [the PR](https://x/150).',
        '',
        'Let me know if you want anything else!',
    ].join('\n');
    assert.strictEqual(extractLine(reply), 'All 214 tests pass; see the PR.');
    ok('extractLine: last prose line, markdown off, sign-off and code skipped');
}
{
    const long = 'word '.repeat(40).trim();
    const out = extractLine(long);
    assert.ok(out.length <= 80, `too long: ${out.length}`);
    assert.ok(out.endsWith('…'));
    assert.ok(!/\s…$/.test(out), 'cut on a word, not before the ellipsis');
    assert.strictEqual(extractLine(''), '');
    assert.strictEqual(extractLine('```\nonly code\n```'), '');
    assert.strictEqual(extractLine('Let me know!'), 'Let me know!', 'a sign-off alone is still a line');
    ok('extractLine: truncation and empty input');
}

// --- prompt and model output -----------------------------------------------

{
    const p = buildPrompt('fix the test', 'x'.repeat(5000));
    assert.ok(p.startsWith('Last request:\nfix the test\n'));
    assert.ok(p.length < 3700, 'reply is tail-capped');
    assert.ok(buildPrompt(null, 'r').includes('(unknown)'));
    ok('buildPrompt caps the reply and survives a missing prompt');
}
{
    assert.strictEqual(cleanModelLine('"PR #150 opened, awaiting review"\n'), 'PR #150 opened, awaiting review');
    assert.strictEqual(cleanModelLine('\n\nStatus: **blocked** on DB password\nmore'), 'blocked on DB password');
    assert.strictEqual(cleanModelLine('   '), '');
    assert.ok(cleanModelLine('y'.repeat(200)).length <= 80);
    ok('cleanModelLine: quotes, labels, extra lines, length');
}

// --- caching ---------------------------------------------------------------

{
    assert.strictEqual(shouldSummarise(null, 'a'), true);
    assert.strictEqual(shouldSummarise({ uuid: 'a' }, 'a'), false);
    assert.strictEqual(shouldSummarise({ uuid: 'a' }, 'b'), true);
    assert.strictEqual(shouldSummarise(null, null), false);
    assert.strictEqual(normalizeMode('nonsense'), 'model');
    assert.strictEqual(normalizeMode('off'), 'off');
    ok('shouldSummarise is keyed on the last assistant uuid');
}

// --- Debouncer -------------------------------------------------------------

function fakeClock() {
    let now = 0;
    let seq = 0;
    const timers = new Map();
    return {
        setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimer: (id) => { timers.delete(id); },
        advance(ms) {
            now += ms;
            for (const [id, t] of [...timers]) {
                if (t.at <= now) { timers.delete(id); t.fn(); }
            }
        },
        get pending() { return timers.size; },
    };
}

{
    const clock = fakeClock();
    const d = new Debouncer(1000, clock);
    let fired = 0;
    d.arm('s', () => fired++);
    clock.advance(600);
    d.arm('s', () => fired++);            // re-armed: the clock starts again
    clock.advance(600);
    assert.strictEqual(fired, 0);
    clock.advance(400);
    assert.strictEqual(fired, 1);
    d.arm('t', () => fired++);
    assert.strictEqual(d.cancel('t'), true);
    clock.advance(5000);
    assert.strictEqual(fired, 1);
    assert.strictEqual(d.size, 0);
    ok('Debouncer re-arms and cancels');
}

// --- StandingStore ---------------------------------------------------------

{
    const file = path.join(home, 'store-a.json');
    const a = new StandingStore(file);
    a.set('s1', { uuid: 'u1', text: 'one', source: 'model', at: 1 });
    const b = new StandingStore(file);       // a second bridge on the same file
    b.set('s2', { uuid: 'u2', text: 'two', source: 'extract', at: 2 });
    a.set('s3', { uuid: 'u3', text: 'three', source: 'model', at: 3 });
    const c = new StandingStore(file);
    assert.deepStrictEqual([...c.rows.keys()].sort(), ['s1', 's2', 's3'], 'neither write lost the other');
    c.delete('s2');
    a.set('s1', { uuid: 'u1b', text: 'one again', source: 'model', at: 4 });
    const d = new StandingStore(file);
    assert.strictEqual(d.get('s2'), null, 'a delete is not undone by a stale copy');
    assert.strictEqual(d.get('s1').text, 'one again');
    assert.strictEqual(d.prune(new Set(['s1'])), 1);
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).sessions), ['s1']);
    ok('StandingStore merges on write, deletes and prunes');
}
{
    const file = path.join(home, 'store-new.json');
    const body = JSON.stringify({ version: 99, sessions: { x: { text: 'future', at: 1 } } });
    fs.writeFileSync(file, body);
    const s = new StandingStore(file);
    s.set('y', { uuid: 'u', text: 'mine', source: 'model', at: 2 });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), body, 'a newer build’s file is left alone');
    ok('StandingStore never rewrites a newer version');
}

// --- Standing, end to end with a stub model --------------------------------

function harness({ mode = 'model', answer = 'PR #150 opened, waiting on review', fail = false } = {}) {
    const dir = fs.mkdtempSync(path.join(home, 'sess-'));
    const file = path.join(dir, 's.jsonl');
    const clock = fakeClock();
    const busy = new Set();
    const calls = [];
    const st = new Standing({
        mode: () => h.mode,
        record: () => ({ file, meta: { lastPrompt: 'open a PR' } }),
        busy: (id) => busy.has(id),
        store: new StandingStore(path.join(dir, 'standing.json')),
        debounceMs: 1000,
        timers: clock,
        summarise: async (prompt) => {
            calls.push(prompt);
            if (h.fail) throw new Error('nope');
            return h.answer;
        },
    });
    const changes = [];
    st.on('changed', (p) => changes.push(p));
    const h = {
        st, clock, busy, calls, changes, mode, answer, fail,
        reply(uuid, text) { fs.appendFileSync(file, assistant(uuid, [{ type: 'text', text }]) + '\n'); },
        async settle() { await st.queue; await new Promise(r => setImmediate(r)); await st.queue; },
    };
    return h;
}

(async () => {
    {
        const h = harness();
        h.reply('a1', 'I opened PR #150 and it needs review.');
        h.st.noteTurn({ sessionId: 's' });
        h.st.noteTurn({ sessionId: 's' });      // a second turn-complete before the debounce
        await h.settle();
        assert.strictEqual(h.calls.length, 0, 'nothing before the debounce');
        h.clock.advance(1000);
        await h.settle();
        assert.strictEqual(h.calls.length, 1);
        assert.ok(h.calls[0].includes('open a PR') && h.calls[0].includes('PR #150'));
        assert.deepStrictEqual(h.st.forSession('s').text, 'PR #150 opened, waiting on review');
        assert.strictEqual(h.st.forSession('s').source, 'model');
        assert.strictEqual(h.changes.length, 1);
        assert.strictEqual(h.changes[0].sessionId, 's');

        // The turn-complete an adopted turn re-emits after a restart: same reply.
        h.st.noteTurn({ sessionId: 's' });
        h.clock.advance(1000);
        await h.settle();
        assert.strictEqual(h.calls.length, 1, 'cached by uuid — no second call');
        assert.strictEqual(h.changes.length, 1);

        h.reply('a2', 'Tests passing now.');
        h.answer = 'tests passing, ready to land';
        h.st.noteTurn({ sessionId: 's' });
        h.clock.advance(1000);
        await h.settle();
        assert.strictEqual(h.calls.length, 2, 'a new reply is a new call');
        assert.strictEqual(h.st.forSession('s').text, 'tests passing, ready to land');
        ok('Standing: debounced, one call per reply, cached across re-emits');
    }
    {
        const h = harness();
        h.reply('a1', 'Working on it.');
        h.st.noteTurn({ sessionId: 's' });
        h.busy.add('s');                       // a follow-up started inside the window
        h.clock.advance(1000);
        await h.settle();
        assert.strictEqual(h.calls.length, 0, 'dropped while busy');
        assert.strictEqual(h.st.forSession('s'), null);
        ok('Standing: a session busy again when the debounce fires is not summarised');
    }
    {
        const h = harness();
        h.reply('a1', 'The API returned 500.\nI could not finish: needs the DB password.');
        h.st.noteTurn({ sessionId: 's', isError: true });
        h.clock.advance(1000);
        await h.settle();
        assert.strictEqual(h.calls.length, 0, 'a failed turn is never paid for');
        assert.deepStrictEqual(
            { text: h.st.forSession('s').text, source: h.st.forSession('s').source },
            { text: 'I could not finish: needs the DB password.', source: 'extract' });
        ok('Standing: a failed turn gets the extracted line');
    }
    {
        const h = harness();
        h.fail = true;
        h.reply('a1', 'Blocked on review.');
        h.st.noteTurn({ sessionId: 's' });
        h.clock.advance(1000);
        await h.settle();
        assert.strictEqual(h.calls.length, 1);
        assert.strictEqual(h.st.forSession('s').source, 'extract', 'falls back when the call fails');
        assert.strictEqual(h.st.forSession('s').text, 'Blocked on review.');
        ok('Standing: a failed model call falls back to extraction');
    }
    {
        const h = harness();
        h.mode = 'extract';
        h.reply('a1', 'Done; PR #9 merged.');
        h.st.noteTurn({ sessionId: 's' });
        h.clock.advance(1000);
        await h.settle();
        assert.strictEqual(h.calls.length, 0);
        assert.strictEqual(h.st.forSession('s').text, 'Done; PR #9 merged.');

        h.mode = 'off';
        assert.strictEqual(h.st.forSession('s'), null, 'off hides the line');
        h.reply('a2', 'Something new.');
        h.st.noteTurn({ sessionId: 's' });
        assert.strictEqual(h.clock.pending, 0, 'off arms nothing');
        h.mode = 'extract';
        assert.strictEqual(h.st.forSession('s').text, 'Done; PR #9 merged.', 'and keeps what it had');

        assert.strictEqual(h.st.forget('s'), true);
        assert.strictEqual(h.st.forSession('s'), null);
        ok('Standing: extract mode spends nothing; off does nothing; forget drops the row');
    }
    console.log(`\n${pass} groups passed`);
})().catch((err) => { console.error(err); process.exit(1); });
