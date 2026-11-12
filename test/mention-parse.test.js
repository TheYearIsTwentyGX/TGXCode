'use strict';

// What the `@` menu reads under the caret, and what a chosen file inserts —
// web/composer/mention-parse.js.
//
// No bridge needed. The failure here is quiet in both directions: a parser that is
// too eager opens a file menu in the middle of an email address, and one that is
// too shy makes `@[` stop being the way to say "a session" or leaves a finished
// `@path ` holding the menu open.

const assert = require('assert');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

process.removeAllListeners('warning');

(async () => {
    const { parseMention, fileMentionText } = await import('../web/composer/mention-parse.js');
    const p = parseMention;

    // A bare fragment asks for both groups.
    assert.deepStrictEqual(p('@'), { text: '', start: 0, files: true, sessions: true, quoted: false });
    assert.deepStrictEqual(p('look at @src/ap'), { text: 'src/ap', start: 8, files: true, sessions: true, quoted: false });
    assert.deepStrictEqual(p('(see @READ'), { text: 'READ', start: 5, files: true, sessions: true, quoted: false });
    assert.strictEqual(p('line one\n@x').start, 9, 'after a newline');
    assert.strictEqual(p('a\t@x').start, 2, 'after a tab');
    ok('a bare @ at a word boundary asks for files and sessions, and start is the @');

    // `@[` is sessions only, and may contain spaces.
    assert.deepStrictEqual(p('@['), { text: '', start: 0, files: false, sessions: true, quoted: false });
    assert.deepStrictEqual(p('ask @[my sess'), { text: 'my sess', start: 4, files: false, sessions: true, quoted: false });
    assert.strictEqual(p('ask @[done] and then'), null, 'a closed bracket is not a fragment');
    ok('@[ is sessions only');

    // `@"` is files only, spaces allowed.
    assert.deepStrictEqual(p('@"my d'), { text: 'my d', start: 0, files: true, sessions: false, quoted: true });
    assert.deepStrictEqual(p('x @"'), { text: '', start: 2, files: true, sessions: false, quoted: true });
    assert.strictEqual(p('@"a b.txt" and'), null, 'a closed quote ends the fragment');
    ok('@" is files only and may contain spaces');

    // An email address, and other mid-word @s, never open anything.
    assert.strictEqual(p('me@example'), null);
    assert.strictEqual(p('mail dylan@'), null);
    assert.strictEqual(p('a@b.c'), null);
    assert.strictEqual(p('path/to@x'), null);
    assert.strictEqual(p('"@x'), null, 'a quote is not a word boundary');
    ok('an @ in the middle of a word is not a mention');

    // A finished mention is done.
    assert.strictEqual(p('@src/app.js '), null, 'the space after a file ends the fragment');
    assert.strictEqual(p('@[name] '), null);
    assert.strictEqual(p('@[name]'), null);
    assert.strictEqual(p('@"a b" '), null);
    assert.strictEqual(p('no at sign'), null);
    assert.strictEqual(p(''), null);
    ok('a completed mention does not reopen the menu');

    // Brackets inside a path are fine, as in a Next.js route.
    assert.deepStrictEqual(p('@app/[id]/pa'), { text: 'app/[id]/pa', start: 0, files: true, sessions: true, quoted: false });
    ok('a path may contain brackets after its first character');

    // Insertion text.
    assert.strictEqual(fileMentionText('src/app.js', false), '@src/app.js ');
    assert.strictEqual(fileMentionText('src', true), '@src/');
    assert.strictEqual(fileMentionText('src/', true), '@src/', 'no doubled slash');
    assert.strictEqual(fileMentionText('src/my file.js', false), '@"src/my file.js" ');
    assert.strictEqual(fileMentionText('my dir', true), '@"my dir/');
    assert.strictEqual(fileMentionText('my dir/sub', true), '@"my dir/sub/');
    assert.strictEqual(fileMentionText('a "b" c.txt', false), '@a "b" c.txt ', 'a path with a quote cannot be quoted');
    assert.strictEqual(fileMentionText('.github/ci.yml', false), '@.github/ci.yml ');
    ok('insertion: bare path, quoted when it has whitespace, directories end in / and stay open');

    // Round trip: what a directory inserts is a fragment that browses it; what a file inserts is not a fragment.
    for (const [rel, dir] of [['src', true], ['my dir', true], ['src/app.js', false], ['a b/c d.txt', false]]) {
        const text = `see ${fileMentionText(rel, dir)}`;
        const frag = parseMention(text);
        if (dir) {
            assert.ok(frag, `${rel}/ reopens the menu`);
            assert.strictEqual(text.slice(frag.start), fileMentionText(rel, true), 'the fragment spans the whole insertion');
            assert.strictEqual(frag.text, `${rel}/`);
        } else {
            assert.strictEqual(frag, null, `${rel} closes the menu`);
        }
    }
    ok('a directory insertion re-opens the menu on its children; a file closes it');

    console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
