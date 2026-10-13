'use strict';

// The full-text index — bridge/search-index.js.
//
// What it gets wrong does not throw. A message missing from it is a search that
// finds nothing and looks like a clean answer; a turn id that is not the turn
// index's is a hit that opens the session and lands nowhere; an append read
// twice is every hit shown twice. So each case checks against something that
// knows the right answer — a full read, or the turn index itself.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TurnIndex } = require('../bridge/turn-index.js');
const { SearchIndex, Warmer, search, parseQuery, snippet } = require('../bridge/search-index.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-search-'));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});

let clock = Date.parse('2026-10-13T10:00:00Z');
const ts = () => new Date(clock += 1000).toISOString();
const user = (uuid, text) => ({
    type: 'user', uuid, timestamp: ts(), cwd: '/tmp/x',
    message: { role: 'user', content: [{ type: 'text', text }] },
});
const said = (uuid, text) => ({
    type: 'assistant', uuid, timestamp: ts(),
    message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] },
});
const call = (uuid, id, name, input = {}) => ({
    type: 'assistant', uuid, timestamp: ts(),
    message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (uuid, id, content = 'done') => ({
    type: 'user', uuid, timestamp: ts(),
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content }] },
});

const lines = (entries) => entries.map(e => JSON.stringify(e) + '\n').join('');
const fileFor = (name) => path.join(TMP, `${name}.jsonl`);
const write = (name, entries) => fs.writeFileSync(fileFor(name), lines(entries));
const append = (name, entries) => fs.appendFileSync(fileFor(name), lines(entries));
let dirs = 0;
const freshIndex = (opts) => new SearchIndex(path.join(TMP, `idx${++dirs}`), opts);
const cand = (name, summary = {}) => ({ sessionId: name, file: fileFor(name), summary: { title: name, ...summary } });
const text = (segs) => segs.map(s => s.text).join('');
const marked = (segs) => segs.filter(s => s.hit).map(s => s.text);

const convo = [
    said('pre', 'Summary of earlier work about the gizmo'),
    user('u1', 'Why is the mirrored networking flaky?'),
    said('a1', 'Because WSL rewrites the resolver on every boot.'),
    call('c1', 'bash1', 'Bash', { command: 'cat /etc/resolv.conf' }),
    result('r1', 'bash1', 'nameserver 10.255.255.254'),
    user('u2', 'Fix the build please'),
    said('a2', 'The build is green now; the flaky test was a timeout.'),
];

// --- what is indexed, and where it says it is ------------------------------
{
    write('s1', convo);
    const sidx = freshIndex();
    const idx = sidx.update('s1', fileFor('s1'));
    assert.ok(idx.done);
    assert.deepStrictEqual(idx.turns.map(t => t[0]), ['u1', 'u2']);
    const kinds = idx.docs.map(d => d[1]).join('');
    assert.strictEqual(kinds, 'auat' + 'ua', 'thinking is not kept; your words, Claude\'s and tools are');

    // Turns are the turn index's turns — the same ids at the same offsets.
    const marks = new TurnIndex(path.join(TMP, 'turns')).update('s1', fileFor('s1')).marks;
    assert.deepStrictEqual(idx.turns.map(t => [t[0], t[1]]),
        marks.filter(m => m.kind === 'turn').map(m => [m.id, m.offset]));
    ok('user, assistant and tool text indexed; turns match the turn index exactly');

    const r = search(sidx, [cand('s1')], { q: 'flaky' });
    assert.strictEqual(r.sessions.length, 1);
    const hits = r.sessions[0].hits;
    assert.deepStrictEqual(hits.map(h => [h.kind, h.turnId, h.turnNo]),
        [['user', 'u1', 1], ['assistant', 'u2', 2]]);
    assert.strictEqual(hits[0].turnOffset, idx.turns[0][1]);
    assert.deepStrictEqual(marked(hits[0].segments), ['flaky']);
    ok('a hit names its turn, its offset and its kind');

    const pre = search(sidx, [cand('s1')], { q: 'gizmo' }).sessions[0].hits[0];
    assert.strictEqual(pre.turnId, null, 'said before the first message: no turn');
    assert.strictEqual(pre.turnOffset, 0);
    ok('text before the first message points at the top of the file');
}

// --- tools only when asked --------------------------------------------------
{
    const sidx = freshIndex();
    assert.strictEqual(search(sidx, [cand('s1')], { q: 'nameserver' }).sessions.length, 0);
    const r = search(sidx, [cand('s1')], { q: 'nameserver', kinds: ['tool'] });
    assert.strictEqual(r.sessions[0].hits[0].kind, 'tool');
    assert.strictEqual(r.sessions[0].hits[0].eventId, 'bash1');
    const cmd = search(sidx, [cand('s1')], { q: 'resolv.conf', kinds: ['user', 'assistant', 'tool'] });
    assert.strictEqual(cmd.sessions[0].hits.length, 1, 'the command is searchable too');
    ok('tool calls and their output are searched only when asked for');
}

// --- appends resume; a partial last line waits ------------------------------
{
    write('s2', convo);
    const sidx = freshIndex();
    const before = sidx.update('s2', fileFor('s2'));
    const consumed = before.consumed;
    const docs = before.docs.length;
    // A line still being written: no newline yet.
    fs.appendFileSync(fileFor('s2'), JSON.stringify(user('u3', 'half a line')).slice(0, 30));
    const mid = sidx.update('s2', fileFor('s2'));
    assert.strictEqual(mid.consumed, consumed, 'a line without its newline is not read');
    assert.ok(mid.done, 'and it does not count as being behind');

    write('s2', convo);
    append('s2', [user('u3', 'Another question about tarball'), result('r9', 'bash1', 'late')]);
    const idx = sidx.update('s2', fileFor('s2'));
    assert.ok(idx.consumed > consumed);
    assert.strictEqual(idx.docs.length, docs + 1, 'only what was added, nothing read twice');
    assert.deepStrictEqual(idx.turns.map(t => t[0]), ['u1', 'u2', 'u3']);
    ok('an append is read incrementally and a half-written line waits');

    // From disk, as a restarted bridge would.
    sidx.flushManifest();
    const again = new SearchIndex(sidx.dir);
    assert.strictEqual(again.stale('s2', fileFor('s2')), false, 'the manifest answers without a parse');
    assert.strictEqual(again.mem.size, 0);
    const r = search(again, [cand('s2')], { q: 'tarball' });
    assert.strictEqual(r.sessions[0].hits[0].turnId, 'u3');
    ok('the index and its manifest survive a restart');
}

// --- a late tool result is attached to its call ----------------------------
{
    write('s3', [user('u1', 'go'), call('c1', 't1', 'Bash', { command: 'make' })]);
    const sidx = freshIndex();
    sidx.update('s3', fileFor('s3'));
    append('s3', [result('r1', 't1', 'error: undefined reference to frobnicate')]);
    const r = search(sidx, [cand('s3')], { q: 'frobnicate', kinds: ['tool'] });
    assert.strictEqual(r.sessions[0].hits[0].eventId, 't1');
    ok('a result read after its call is still searchable under that call');
}

// --- replaced and shrunk files are rebuilt ---------------------------------
{
    write('s4', convo);
    const sidx = freshIndex();
    sidx.update('s4', fileFor('s4'));
    // Longer than before, so only the first line can tell.
    write('s4', [user('z1', 'A different conversation'), said('z2', 'y'.repeat(9000)), user('z3', 'Two')]);
    assert.deepStrictEqual(sidx.update('s4', fileFor('s4')).turns.map(t => t[0]), ['z1', 'z3']);
    write('s4', [user('w1', 'Short')]);
    assert.deepStrictEqual(sidx.update('s4', fileFor('s4')).turns.map(t => t[0]), ['w1']);
    assert.strictEqual(search(sidx, [cand('s4')], { q: 'flaky' }).sessions.length, 0);
    ok('a replaced or shrunk transcript is rebuilt from scratch');
}

// --- slices add up to the whole --------------------------------------------
{
    const many = [];
    for (let i = 0; i < 40; i++) many.push(user(`m${i}`, `question ${i} ${'pad '.repeat(50)}`), said(`n${i}`, `answer ${i}`));
    write('s5', many);
    const whole = freshIndex().update('s5', fileFor('s5'));
    const sliced = freshIndex();
    let idx;
    let n = 0;
    do { idx = sliced.update('s5', fileFor('s5'), { maxBytes: 700 }); n++; } while (!idx.done);
    assert.ok(n > 5, 'it really did take several slices');
    assert.deepStrictEqual(idx.turns, whole.turns);
    assert.deepStrictEqual(idx.docs, whole.docs);
    // A slice smaller than one line still makes progress.
    const tiny = freshIndex().update('s5', fileFor('s5'), { maxBytes: 10 });
    assert.ok(tiny.consumed > 0);
    ok('an index built in slices is the index built at once');
}

// --- the query --------------------------------------------------------------
{
    assert.deepStrictEqual(parseQuery('  Flaky   build '), ['flaky', 'build']);
    assert.deepStrictEqual(parseQuery('"green now" build'), ['green now', 'build']);
    assert.deepStrictEqual(parseQuery('a a'), ['a']);

    const sidx = freshIndex();
    const all = search(sidx, [cand('s1')], { q: 'flaky build' }).sessions[0].hits;
    assert.deepStrictEqual(all.map(h => h.eventId), ['a2:text:1'],
        'every word has to be in the same message');
    assert.strictEqual(search(sidx, [cand('s1')], { q: '"build flaky"' }).sessions.length, 0);
    assert.strictEqual(search(sidx, [cand('s1')], { q: '"GREEN now"' }).sessions.length, 1);
    ok('words are ANDed within one message; a quoted phrase is kept whole; case is ignored');

    const segs = snippet('The Quick brown fox', 'the quick brown fox', ['quick', 'fox']);
    assert.strictEqual(text(segs), 'The Quick brown fox');
    assert.deepStrictEqual(marked(segs), ['Quick', 'fox'], 'marks keep the original case');
    const long = `${'lorem '.repeat(100)}needle${' ipsum'.repeat(100)}`;
    const cut = snippet(long, long.toLowerCase(), ['needle']);
    assert.strictEqual(cut[0].text, '…');
    assert.strictEqual(cut[cut.length - 1].text, '…');
    assert.ok(text(cut).length < 260);
    ok('a snippet is cut around the match and marks every needle in it');
}

// --- caps, filters and the budget -------------------------------------------
{
    const many = [];
    for (let i = 0; i < 30; i++) many.push(user(`k${i}`, `kiwi number ${i}`));
    write('s6', many);
    for (const n of ['a', 'b', 'c']) write(`t${n}`, [user(`${n}1`, 'kiwi here too')]);
    const sidx = freshIndex();
    const cands = [cand('s6'), cand('ta'), cand('tb'), cand('tc')];

    const r = search(sidx, cands, { q: 'kiwi', limit: 2, perSession: 3 });
    assert.strictEqual(r.sessions.length, 2);
    assert.strictEqual(r.matched, 4);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.sessions[0].hits.length, 3);
    assert.strictEqual(r.sessions[0].hitCount, 30);
    assert.strictEqual(r.sessions[0].more, 27);
    const capped = search(sidx, cands, { q: 'kiwi', limit: 10_000, perSession: 10_000 });
    assert.strictEqual(capped.sessions[0].hits.length, 20, 'perSession is capped at 20');
    ok('session and hit counts are capped, and the cap is reported');

    // A clock that has already run out: nothing is read, and what was not read
    // is counted rather than left out silently.
    let t = 0;
    const cold = freshIndex();
    const late = search(cold, cands, { q: 'kiwi', budgetMs: 5, now: () => (t += 10) });
    assert.strictEqual(late.pending, 4);
    assert.strictEqual(late.sessions.length, 0);
    ok('a search out of time says how many sessions it has not read yet');
}

// --- the warmer, a slice at a time -------------------------------------------
{
    const sidx = freshIndex();
    const cands = [cand('s5'), cand('s1')];
    const w = new Warmer(sidx, () => cands, { sliceBytes: 2000 });
    w.stopped = false;
    let ticks = 0;
    // Driven by hand rather than by its timer, so the test does not sleep.
    w._schedule = () => {};
    do { w._tick(); ticks++; } while (w.queue.length && ticks < 500);
    assert.ok(ticks > 3, 'big transcripts take several ticks');
    assert.strictEqual(sidx.stale('s5', fileFor('s5')), false);
    assert.strictEqual(sidx.stale('s1', fileFor('s1')), false);
    ok('the warmer catches every session up, a bounded slice per tick');
}

// --- forgetting -------------------------------------------------------------
{
    const sidx = freshIndex();
    sidx.update('s1', fileFor('s1'));
    sidx.forget('s1');
    assert.strictEqual(fs.existsSync(path.join(sidx.dir, 's1.json')), false);
    assert.strictEqual(sidx.stale('s1', fileFor('s1')), true);
    ok('a deleted session leaves nothing behind');
}

// --- memory is bounded, and what is let go is written first -----------------
{
    const sidx = freshIndex({ memMax: 1 });
    // Mid-build, so its progress exists only in memory until it is let go.
    sidx.update('s5', fileFor('s5'), { maxBytes: 700 });
    sidx.update('s1', fileFor('s1'));
    assert.strictEqual(sidx.mem.has('s5'), false, 'the older one was let go');
    const back = new SearchIndex(sidx.dir).peek('s5');
    assert.ok(back && back.consumed > 0, 'and its partial progress was written first');
    ok('the in-memory set is capped and eviction keeps partial work');
}

console.log(`search-index: ${pass} passed`);
