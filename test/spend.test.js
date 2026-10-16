'use strict';

// The spend index and its rollup — bridge/spend-index.js and bridge/pricing.js.
//
// None of what this gets wrong throws. A message counted once per content
// block is a bill twice the size; a message split across two reads and
// counted twice is the same bug arriving only on live sessions; a rewritten
// file read from its old offset is garbage that still sums. Each case below is
// one of those, checked against numbers worked out by hand.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { priceFor, costOf, normalizeModel } = require('../bridge/pricing.js');
const { SpendIndex, rollup, absorb, freshState, updateFile, dayRange }
    = require('../bridge/spend-index.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-spend-'));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});

// Noon local time, so the day a message lands in does not depend on the zone
// the test runs in.
const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).toISOString();
const usage = (input, output, cacheRead = 0, cacheWrite = 0, extra = {}) => ({
    input_tokens: input, output_tokens: output,
    cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, ...extra,
});
const msg = (id, u, { model = 'claude-opus-5-5', ts = at(2026, 10, 12), block = 'text' } = {}) => ({
    type: 'assistant', timestamp: ts,
    message: { id, model, role: 'assistant', usage: u, content: [{ type: block, text: 'x' }] },
});
const user = () => ({ type: 'user', timestamp: at(2026, 10, 12),
    message: { role: 'user', content: 'hi "usage"' } });
const jsonl = (entries) => entries.map(e => JSON.stringify(e)).join('\n') + '\n';
const totalOf = (state) => Object.values(state.buckets)
    .reduce((t, b) => ({ out: t.out + b.output, n: t.n + b.messages }), { out: 0, n: 0 });

(async () => {
    // -- pricing ---------------------------------------------------------

    {
        assert.strictEqual(priceFor('claude-opus-5-5').input, 4);
        assert.strictEqual(priceFor('claude-opus-5').input, 5, 'opus-5 is not opus-5-5');
        assert.strictEqual(priceFor('claude-haiku-4-5-20251001').input, 1, 'date suffix');
        assert.strictEqual(priceFor('claude-opus-5-5[1m]').input, 4, 'context marker');
        assert.strictEqual(normalizeModel('opus'), 'claude-opus-5-5', 'bare alias');
        assert.strictEqual(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5',
            'a snapshot date is one model with its undated id');
        assert.strictEqual(priceFor('gpt-9'), null);
        assert.strictEqual(priceFor('claude-opus-55'), null, 'a prefix must end at a separator');
        ok('models are priced by the most specific stem, and unknown ones are not');
    }

    {
        // Opus 5.5: $4 in, $20 out, $0.20 read, 5m write 1.25x, 1h write 2x.
        near(costOf(usage(1e6, 0), 'claude-opus-5-5'), 4, 'input');
        near(costOf(usage(0, 1e6), 'claude-opus-5-5'), 20, 'output');
        near(costOf(usage(0, 0, 1e6), 'claude-opus-5-5'), 0.2, 'cache read');
        near(costOf(usage(0, 0, 0, 1e6), 'claude-opus-5-5'), 5, 'unsplit write is 5m');
        near(costOf(usage(0, 0, 0, 1e6, { cache_creation: {
            ephemeral_5m_input_tokens: 4e5, ephemeral_1h_input_tokens: 6e5 } }), 'claude-opus-5-5'),
        0.4 * 5 + 0.6 * 8, 'split write');
        assert.strictEqual(costOf(usage(10, 10), 'mystery'), null);
        ok('cost covers all four meters and bills cache writes by TTL');
    }

    // -- dedupe ----------------------------------------------------------

    {
        // Three blocks of one message, each line repeating the same usage, then
        // a second message of two blocks.
        const s = absorb(freshState('h'), [
            msg('m1', usage(1, 100)), msg('m1', usage(1, 100), { block: 'tool_use' }),
            msg('m1', usage(1, 100)), user(),
            msg('m2', usage(1, 50)), msg('m2', usage(1, 50)),
        ]);
        assert.deepStrictEqual(totalOf(s), { out: 150, n: 2 });
        ok('a message written as several lines counts once');
    }

    {
        // The last line of a message wins, and a message whose lines straddle two
        // reads is still one message.
        const s = absorb(freshState('h'), [msg('m1', usage(1, 10)), msg('m1', usage(1, 40))]);
        assert.deepStrictEqual(totalOf(s), { out: 40, n: 1 });
        absorb(s, [msg('m1', usage(1, 70)), msg('m2', usage(1, 5))]);
        assert.deepStrictEqual(totalOf(s), { out: 75, n: 2 });
        // An id seen a moment ago that reappears out of order is not re-added.
        absorb(s, [msg('m1', usage(1, 999))]);
        assert.deepStrictEqual(totalOf(s), { out: 75, n: 2 });
        ok('the last line of a message wins, across reads and out of order');
    }

    {
        const s = absorb(freshState('h'), [
            msg('syn', usage(0, 0), { model: '<synthetic>' }),
            msg('u1', usage(10, 10), { model: 'claude-future-9' }),
        ]);
        const b = Object.values(s.buckets);
        assert.strictEqual(b.length, 1, 'zero-usage entries leave no bucket');
        assert.strictEqual(b[0].unpricedTokens, 20);
        assert.strictEqual(b[0].costUsd, 0);
        ok('zero usage is skipped and an unknown model is counted but unpriced');
    }

    // -- reading files ---------------------------------------------------

    {
        const file = path.join(TMP, 'grow.jsonl');
        fs.writeFileSync(file, jsonl([user(), msg('a', usage(1, 10)), msg('a', usage(1, 10))]));
        let s = await updateFile(file, null);
        assert.deepStrictEqual(totalOf(s), { out: 10, n: 1 });
        const at1 = s.consumed;

        // Append the rest of message `a` and a new one; then half a line.
        fs.appendFileSync(file, jsonl([msg('a', usage(1, 10)), msg('b', usage(1, 20))]));
        fs.appendFileSync(file, JSON.stringify(msg('c', usage(1, 30))).slice(0, 40));
        s = await updateFile(file, s);
        assert.deepStrictEqual(totalOf(s), { out: 30, n: 2 });
        assert.ok(s.consumed > at1 && s.consumed < fs.statSync(file).size,
            'the partial line is left for the next read');

        // A stat alone when nothing changed: the same object back.
        const again = await updateFile(file, s);
        assert.strictEqual(again, s);
        ok('a grown file is read from where it stopped, never a partial line');

        // Rewritten in place with a different first line: read from zero.
        fs.writeFileSync(file, jsonl([msg('z', usage(1, 7)), user(), user(), user(), user()]));
        s = await updateFile(file, s);
        assert.deepStrictEqual(totalOf(s), { out: 7, n: 1 });
        ok('a rewritten file is read again from the start');
    }

    // -- the index over several files ------------------------------------

    {
        const projA = path.join(TMP, 'proj-a');
        const projWt = path.join(TMP, 'proj-a-wt');
        fs.mkdirSync(path.join(projA, 's1', 'subagents'), { recursive: true });
        fs.mkdirSync(projWt, { recursive: true });
        // A session that walked into a worktree: half its messages in each copy,
        // plus a subagent.
        const a1 = path.join(projA, 's1.jsonl');
        const a2 = path.join(projWt, 's1.jsonl');
        const sub = path.join(projA, 's1', 'subagents', 'agent-x.jsonl');
        const b1 = path.join(projA, 's2.jsonl');
        fs.writeFileSync(a1, jsonl([user(), msg('m1', usage(0, 1e6)), msg('m1', usage(0, 1e6))]));
        fs.writeFileSync(a2, jsonl([msg('m2', usage(0, 1e6), { ts: at(2026, 10, 11) })]));
        fs.writeFileSync(sub, jsonl([msg('m3', usage(0, 1e6), { model: 'claude-haiku-5-5' })]));
        fs.writeFileSync(b1, jsonl([msg('n1', usage(0, 5e5), { model: 'claude-sonnet-5-5',
            ts: at(2026, 9, 1) })]));

        const meta = (id, cwd) => ({ meta: { sessionId: id, projectCwd: cwd, cwd } });
        const index = {
            byFile: new Map([a1, a2, b1].map(f => [f, { file: f }])),
            sessions: new Map([['s1', meta('s1', '/home/u/app')], ['s2', meta('s2', '/home/u/lib')]]),
            flags: null,
            summary: () => null,
        };
        const spend = new SpendIndex({ cacheFile: path.join(TMP, 'spend.json') });
        await spend.refresh(index);

        const one = spend.forSession(index, 's1');
        // 2M Opus 5.5 output at $20 + 1M Haiku 5.5 output at $0.50.
        assert.strictEqual(one.totals.messages, 3);
        assert.strictEqual(one.totals.output, 3e6);
        near(one.totals.costUsd, 40.5, 'session cost');
        assert.deepStrictEqual([one.firstDay, one.lastDay], ['2026-10-11', '2026-10-12']);
        ok('a session sums both worktree copies and its subagents');

        const now = new Date(2026, 9, 13, 9).getTime();
        const r = rollup(spend.entries(index), { days: 7, now });
        assert.deepStrictEqual(r.daily.map(d => d.date), dayRange(7, now));
        assert.strictEqual(r.daily.length, 7);
        assert.strictEqual(r.daily[6].date, '2026-10-13');
        assert.strictEqual(r.daily[6].messages, 0, 'a quiet day is zero, not missing');
        assert.strictEqual(r.daily[5].output, 2e6, 'Oct 12: the main copy and the subagent');
        assert.strictEqual(r.daily[4].output, 1e6, 'Oct 11: the worktree copy');
        assert.strictEqual(r.projects.length, 1, 'September is outside the range');
        assert.strictEqual(r.projects[0].name, 'app');
        assert.strictEqual(r.sessions[0].sessionId, 's1');
        assert.deepStrictEqual(r.models.map(m => m.model), ['claude-opus-5-5', 'claude-haiku-5-5']);
        assert.strictEqual(r.allTime.messages, 4, 'allTime ignores the range');
        ok('the rollup windows by day, zero-fills, and groups by project and model');

        const wide = rollup(spend.entries(index), { days: 60, now, top: 1 });
        assert.strictEqual(wide.projects.length, 2);
        assert.deepStrictEqual(wide.projects.map(p => p.name), ['app', 'lib'], 'by cost');
        assert.strictEqual(wide.sessions.length, 1, 'top-N');
        ok('projects and sessions are ordered by cost and capped');

        // A temp session is not counted; a test session only when asked.
        index.sessions.set('s2', meta('s2', '/tmp/probe'));
        assert.strictEqual(rollup(spend.entries(index), { days: 60, now }).projects.length, 1);
        index.sessions.set('s2', meta('s2', '/home/u/lib'));
        index.flags = { test: new Set(['s2']) };
        assert.strictEqual(rollup(spend.entries(index), { days: 60, now }).projects.length, 1);
        assert.strictEqual(rollup(spend.entries(index, { includeTest: true }),
            { days: 60, now }).projects.length, 2);
        ok('scratch and test sessions are left out as the lists leave them out');

        // Live: the next turn lands, and one session is re-read.
        fs.appendFileSync(a2, jsonl([msg('m4', usage(0, 1e6), { ts: at(2026, 10, 13) })]));
        const after = await spend.refreshSession(index, 's1');
        assert.strictEqual(after.totals.messages, 4);
        assert.strictEqual(after.lastDay, '2026-10-13');
        ok('refreshSession picks up an append to one session');
    }

    console.log(`spend: ${pass} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
