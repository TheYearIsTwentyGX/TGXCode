'use strict';

// The command palette's fuzzy scorer — web/palette/score.js.
//
// No bridge needed. What is pinned here is the ordering, because that is the
// whole of what the scorer is for and it fails quietly: a palette that finds the
// right row but lists it ninth looks like a palette that does not work. So the
// cases are pairs — word starts over the middle of a word, a run over the same
// letters scattered, a title over a status line — plus the edges that would
// otherwise throw (an empty query, a query longer than the text) and the one
// rule the session list leans on: ties keep the order they came in, which is
// how "most recent first" survives a query that matches several equally.

const assert = require('assert');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

process.removeAllListeners('warning');

(async () => {
    const { score, best, rank } = await import('../web/palette/score.js');

    assert.deepStrictEqual(score('', 'anything'), { score: 0, hits: [] });
    assert.deepStrictEqual(score('   ', 'anything'), { score: 0, hits: [] });
    ok('an empty query matches everything, with no score and no hits');

    assert.strictEqual(score('xyz', 'Settings'), null);
    assert.strictEqual(score('gs', 'S'), null, 'longer than the text');
    assert.strictEqual(score('ts', 'Search'), null, 'out of order is no match');
    ok('a query that is not a subsequence is no match');

    assert.deepStrictEqual(score('DASH', 'dashboard').hits, [0, 1, 2, 3]);
    assert.strictEqual(score('Dash', 'dashboard').score, score('dash', 'DASHBOARD').score);
    ok('case does not matter');

    assert.deepStrictEqual(score('dash', 'Live board · dashboard').hits, [13, 14, 15, 16],
        'the run inside one word, not letters strewn across the first two');
    ok('the best placement is found, not the leftmost');

    assert.ok(score('nt', 'New Task').score > score('nt', 'into').score);
    assert.ok(score('rn', 'startRename').score > score('rn', 'turnover').score, 'a camelCase hump is a word start');
    ok('a word start beats the middle of a word');

    assert.ok(score('land', 'Landing').score > score('land', 'Lazy android').score);
    assert.ok(score('set', 'Settings').score > score('set', 'Search every transcript').score);
    ok('consecutive letters beat the same letters scattered');

    assert.ok(score('term', 'Terminal').score > score('term', 'The terminal').score);
    ok('a match at the very start beats one further in');

    assert.ok(score('land', 'Land').score > score('land', 'Lander').score);
    ok('the whole text beats a longer one it is the start of');

    const both = score('set key', 'Settings · Keyboard');
    assert.ok(both);
    assert.deepStrictEqual(both.hits, [0, 1, 2, 11, 12, 13]);
    assert.strictEqual(score('set zzz', 'Settings · Keyboard'), null);
    ok('each word of the query is matched on its own, and every word has to match');

    const fields = (title, project) => [{ text: title, weight: 1 }, { text: project, weight: 0.5 }];
    const inTitle = best('land', fields('Land the PR', 'tgxcode'));
    const inProject = best('land', fields('Fix the tests', 'landing-site'));
    assert.ok(inTitle.score > inProject.score);
    assert.deepStrictEqual(inProject.hits, [[], [0, 1, 2, 3]]);
    const split = best('fix land', fields('Fix the tests', 'landing-site'));
    assert.deepStrictEqual(split.hits, [[0, 1, 2], [0, 1, 2, 3]], 'words may land in different fields');
    assert.strictEqual(best('zzz', fields('a', 'b')), null);
    assert.ok(best('a', [{ text: '' }, null, { text: 'a' }]), 'empty and missing fields are skipped');
    ok('best weights fields and gives each word the field it fits best');

    const items = [{ id: 1, t: 'Docs' }, { id: 2, t: 'Docs' }, { id: 3, t: 'Dashboard docs' }, { id: 4, t: 'Nothing' }];
    const r = rank(items, 'docs', { fields: x => [{ text: x.t }] });
    assert.deepStrictEqual(r.map(x => x.item.id), [1, 2, 3], 'equal scores stay in the order given; misses are dropped');
    assert.deepStrictEqual(rank(items, 'docs', { fields: x => [{ text: x.t }], limit: 1 }).map(x => x.item.id), [1]);
    assert.deepStrictEqual(rank(items, '', { fields: x => [{ text: x.t }] }).map(x => x.item.id), [1, 2, 3, 4],
        'an empty query keeps every item, in order');
    ok('rank sorts by score, keeps ties stable, and honours the limit');

    const lines = [{ t: 'Settings' }, { t: 'user pressed it' }];
    assert.deepStrictEqual(rank(lines, 'set', { fields: x => [{ text: x.t }] }).length, 2);
    assert.deepStrictEqual(rank(lines, 'set', { fields: x => [{ text: x.t }], perChar: 3 }).map(x => x.item.t),
        ['Settings'], 'letters strewn mid-word fall under the floor');
    ok('perChar drops matches too weak to be what was meant');

    console.log(`\n${pass} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
