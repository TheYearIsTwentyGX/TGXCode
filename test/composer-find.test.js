'use strict';

// Find and replace in the composer — web/composer/find-match.js.
//
// No bridge needed. The bar and the overlay need a browser; what is pinned here
// is everything they are a view of: which matches there are, what each becomes,
// and that the two odd inputs — a pattern that matches nothing at every position,
// and one that does not compile — neither hang nor throw.
//
// The substitution is checked against String.prototype.replace on the same
// inputs rather than against strings written out by hand, because "behaves like
// replace" is the promise, and a hand-written expectation is only one person's
// reading of the spec.

const assert = require('assert');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

process.removeAllListeners('warning');

(async () => {
    const F = await import('../web/composer/find-match.js');
    const spans = (text, q, opts = {}) => {
        const c = F.compile(q, opts);
        return F.findMatches(text, c.re, opts).matches.map(m => text.slice(m.start, m.end));
    };
    const all = (text, q, rep, opts = {}) => {
        const c = F.compile(q, opts);
        const { matches } = F.findMatches(text, c.re, { ...opts, cap: Infinity });
        const r = F.replaceAll(text, matches, rep, !!opts.regex);
        return r ? r.text : text;
    };

    assert.strictEqual(F.compile(''), null);
    assert.ok(F.compile('a.b').re.test('a.b'));
    assert.ok(!F.compile('a.b').re.test('axb'), 'a plain query is literal');
    assert.ok(F.compile('a.b', { regex: true }).re.test('axb'));
    assert.deepStrictEqual(spans('a+b (c) [d] $e ^f', '(c) [d] $e'), ['(c) [d] $e']);
    assert.deepStrictEqual(spans('x-y/z', 'x-y/z'), ['x-y/z'], 'a hyphen and a slash survive escaping under u');
    ok('a plain query is escaped, a regex is not');

    assert.deepStrictEqual(spans('Foo foo FOO', 'foo'), ['Foo', 'foo', 'FOO']);
    assert.deepStrictEqual(spans('Foo foo FOO', 'foo', { matchCase: true }), ['foo']);
    assert.deepStrictEqual(spans('Foo foo FOO', 'f[a-z]+', { regex: true, matchCase: true }), ['foo']);
    ok('Match case off adds i, on leaves it out');

    assert.deepStrictEqual(spans('cat concat cat_x cat.', 'cat', { wholeWord: true }), ['cat', 'cat']);
    assert.deepStrictEqual(spans('concat cat', 'cat', { wholeWord: true }), ['cat'],
        'a rejected match restarts one character on, not past it');
    assert.deepStrictEqual(spans('call foo(x) and foo(', 'foo(', { wholeWord: true }), ['foo(', 'foo('],
        'an edge that is not a word character needs no boundary');
    assert.deepStrictEqual(spans('café cafés', 'café', { wholeWord: true }), ['café'], 'letters are Unicode letters');
    assert.deepStrictEqual(spans('a1 b22 c', '\\w\\d+', { regex: true, wholeWord: true }), ['a1', 'b22']);
    ok('Whole word checks each edge');

    const bad = F.compile('a(b', { regex: true });
    assert.ok(bad.error && !bad.re, 'an unclosed group is an error, not a throw');
    assert.ok(!/^Invalid regular expression: \//.test(bad.error), 'the pattern is not echoed back');
    assert.ok(F.compile('[', { regex: true }).error);
    assert.ok(F.compile('a{2', { regex: true }).re, 'legal without u, so it compiles without u');
    assert.ok(F.compile('\\-', { regex: true }).re, 'likewise an escaped hyphen');
    assert.ok(F.compile('\\p{L}+', { regex: true }).re.unicode, 'u where it compiles');
    assert.deepStrictEqual(spans('ab 😀 c', '.', { regex: true }).length, 6,
        'under u a dot takes an emoji whole');
    ok('an invalid pattern is reported; u is used only where it is safe');

    const start = Date.now();
    assert.strictEqual(F.findMatches('abc', null).matches.length, 0, 'no regex, no matches');
    assert.deepStrictEqual(F.findMatches('abc', F.compile('x*', { regex: true }).re).matches.map(m => m.start),
        [0, 1, 2, 3], 'a zero-length match at every position, the end included');
    assert.deepStrictEqual(F.findMatches('a\nb\n', F.compile('^', { regex: true }).re).matches.map(m => m.start),
        [0, 2, 4], '^ is per line');
    assert.deepStrictEqual(F.findMatches('😀😀', F.compile('(?:)', { regex: true }).re)
        .matches.map(m => m.start), [0, 2, 4], 'stepping past a zero-length match does not split a surrogate pair');
    assert.deepStrictEqual(spans('ab ab', '\\b', { regex: true, wholeWord: true }).length, 4);
    assert.ok(Date.now() - start < 1000, 'and none of that spun');
    ok('zero-length matches advance');

    const big = 'a'.repeat(50000);
    const capped = F.findMatches(big, F.compile('a').re);
    assert.strictEqual(capped.matches.length, F.MATCH_CAP);
    assert.strictEqual(capped.capped, true);
    assert.strictEqual(F.findMatches('aaa', F.compile('a').re).capped, false);
    assert.strictEqual(F.findMatches(big, F.compile('a').re, { cap: Infinity }).matches.length, 50000);
    assert.strictEqual(F.countLabel({ query: 'a', matches: capped.matches, capped: true, at: 0 }), '1 of 10000+');
    ok('the count stops at the cap and says so');

    // Against the real thing. Every case here has no Whole word and no cap, which
    // is when replaceAll and String.prototype.replace must agree exactly.
    const cases = [
        ['John Smith, Jane Doe', '(\\w+) (\\w+)', '$2, $1'],
        ['2026-10-22', '(?<y>\\d+)-(?<m>\\d+)-(?<d>\\d+)', '$<d>/$<m>/$<y>'],
        ['price 5', '\\d', '$$$&'],
        ['abc', 'b', "[$`|$']"],
        ['abc', '(a)', '$1$2$01$10$00$0'],
        ['abcdefghijk', '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)', '$11-$10-$1'],
        ['ab', '(a)|(b)', '[$1$2]'],
        ['ab', '(?<x>a)', '$<x>$<nope>$<x'],
        ['ab', 'a', '$<x>'],
        ['a.b.c', '\\.', '$'],
        ['abc', 'x*', '-'],
        ['line one\nline two', '^', '> '],
        ['😀a😀', '', '|'],
    ];
    for (const [text, q, rep] of cases) {
        const re = F.compile(q || '(?:)', { regex: true, matchCase: true }).re;
        assert.strictEqual(all(text, q || '(?:)', rep, { regex: true, matchCase: true }),
            text.replace(re, rep), `${JSON.stringify(text)} / ${q} / ${rep}`);
    }
    ok('$1, $<name>, $&, $$ and the rest expand as String.prototype.replace does');

    assert.strictEqual(all('a.b', '.', '$&$1'), 'a$&$1b', 'a plain search takes the replacement literally');
    assert.strictEqual(all('cat concat cat', 'cat', 'dog', { wholeWord: true }), 'dog concat dog');
    assert.strictEqual(all('aXa', 'x', '', {}), 'aa', 'replacing with nothing deletes');
    const r = F.replaceAll('keep foo and foo keep', F.findMatches('keep foo and foo keep', F.compile('foo').re).matches, 'bar');
    assert.deepStrictEqual([r.from, r.to, r.insert, r.count], [5, 16, 'bar and bar', 2],
        'Replace all is the smallest splice that covers every match');
    assert.strictEqual(F.replaceAll('x', [], 'y'), null);
    ok('Replace all, plain and whole-word, as one splice');

    const ms = F.findMatches('a.a.a.a', F.compile('a').re).matches;
    assert.strictEqual(F.matchFrom(ms, 0), 0);
    assert.strictEqual(F.matchFrom(ms, 1), 1);
    assert.strictEqual(F.matchFrom(ms, 2), 1, 'a caret on a match makes it current');
    assert.strictEqual(F.matchFrom(ms, 7), 0, 'past the last, wraps');
    assert.strictEqual(F.matchFrom([], 3), -1);
    assert.strictEqual(F.countLabel({ query: '', matches: [] }), '');
    assert.strictEqual(F.countLabel({ query: 'q', error: 'x', matches: [] }), 'Invalid regex');
    assert.strictEqual(F.countLabel({ query: 'q', matches: [] }), 'No results');
    assert.strictEqual(F.countLabel({ query: 'q', matches: ms, at: 2 }), '3 of 4');
    ok('the current match follows the caret, and the counter says where it is');

    console.log(`\n${pass} groups passed`);
})().catch((err) => { console.error(err); process.exit(1); });
