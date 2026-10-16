'use strict';

// The composer's snippet triggers — web/snippets/trigger.js.
//
// No bridge needed. What is pinned is which word counts as "the word before the
// caret", because the failure is quiet in both directions: a matcher that is too
// eager splices a paragraph into the middle of something you were typing, and one
// that is too shy makes Tab move the focus away when you expected a snippet, which
// looks like the feature not existing.

const assert = require('assert');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

process.removeAllListeners('warning');

(async () => {
    const { tokenBefore, triggerAt } = await import('../web/snippets/trigger.js');

    assert.deepStrictEqual(tokenBefore('LGTM', 4), { token: 'LGTM', start: 0, end: 4 });
    assert.deepStrictEqual(tokenBefore('ok then LGTM', 12), { token: 'LGTM', start: 8, end: 12 });
    assert.deepStrictEqual(tokenBefore('a\nLGTM', 6), { token: 'LGTM', start: 2, end: 6 });
    assert.deepStrictEqual(tokenBefore('a\tLGTM', 6), { token: 'LGTM', start: 2, end: 6 });
    assert.deepStrictEqual(tokenBefore('fooLGTM', 7), { token: 'fooLGTM', start: 0, end: 7 });
    ok('the token runs back to whitespace or the start of the text');

    assert.strictEqual(tokenBefore('', 0), null);
    assert.strictEqual(tokenBefore('LGTM ', 5), null, 'just after a space there is no word');
    assert.strictEqual(tokenBefore('LGTM', 0), null, 'at the start there is no word');
    assert.strictEqual(tokenBefore('LGTMfoo', 4), null, 'the caret inside a word is not its end');
    assert.deepStrictEqual(tokenBefore('LGTM more', 4), { token: 'LGTM', start: 0, end: 4 },
        'whitespace after the caret is fine');
    assert.deepStrictEqual(tokenBefore('x LGTM', 99), { token: 'LGTM', start: 2, end: 6 },
        'a caret past the end is clamped');
    ok('no token at a space, at the start, or with the caret mid-word');

    const rows = [
        { id: 'a', trigger: null },
        { id: 'b', trigger: 'LGTM' },
        { id: 'c', trigger: 'lgtm' },
        { id: 'd', trigger: ';sig' },
        { id: 'e' },
    ];
    assert.strictEqual(triggerAt('LGTM', 4, rows).snippet.id, 'b');
    assert.strictEqual(triggerAt('lgtm', 4, rows).snippet.id, 'b', 'case-insensitive, first wins');
    assert.deepStrictEqual(
        (({ start, end }) => ({ start, end }))(triggerAt('ship it lgTM', 12, rows)),
        { start: 8, end: 12 }, 'the range is exactly the token');
    assert.strictEqual(triggerAt('thanks ;sig', 11, rows).snippet.id, 'd', 'punctuation is fine');
    ok('a token equal to a trigger matches, case-insensitively, first in order');

    assert.strictEqual(triggerAt('fooLGTM', 7, rows), null, 'a trigger glued to a word is not one');
    assert.strictEqual(triggerAt('LGTMs', 5, rows), null);
    assert.strictEqual(triggerAt('LGT', 3, rows), null, 'a prefix is not a match');
    assert.strictEqual(triggerAt('LGTM ', 5, rows), null);
    assert.strictEqual(triggerAt('LGTMfoo', 4, rows), null);
    assert.strictEqual(triggerAt('null', 4, rows), null, 'a null trigger matches nothing');
    assert.strictEqual(triggerAt('LGTM', 4, []), null);
    assert.strictEqual(triggerAt('LGTM', 4, undefined), null);
    ok('no match for a glued, partial or absent trigger');

    console.log(`\n${pass} groups passed`);
})().catch((err) => { console.error(err); process.exit(1); });
