'use strict';

// `#151` in a message, end to end minus the DOM: the bridge's reverse map
// (bridge/pr-owners.js `buildOwners`), the rule that decides which of it a
// conversation may use (web/pr-resolve.js), and the markdown mark both hang on
// (web/markdown.js).
//
// The rules worth pinning are the ones that fail by claiming too much, because
// that failure looks like a feature working: another project's #151 offered in a
// chat that never touched that project, a chat's own PR turned into a link to
// itself, the same chat listed twice, a URL fragment or an HTML entity turned
// into a mention. None of those throw.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// pr-owners requires pr-store, which reads its cache from here.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pr-owners-'));
process.removeAllListeners('warning');

const { buildOwners } = require('../bridge/pr-owners.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const S = (sessionId, prs, extra = {}) => ({
    sessionId, prs, title: `chat ${sessionId}`, projectName: 'claude-sessions',
    projectCwd: '/p/claude-sessions', cwd: '/p/claude-sessions', mtimeMs: 0, ...extra,
});
const pr = (number, repo = 'me/app') => ({ number, url: `https://github.com/${repo}/pull/${number}`, repo });

(async () => {
    // --- buildOwners -----------------------------------------------------------
    {
        const asked = [];
        const repoOf = async (dir) => { asked.push(dir); return dir === '/p/other' ? 'me/other' : null; };
        const owners = await buildOwners([
            S('a', [pr(151), pr(151)], { mtimeMs: 10 }),
            S('b', [pr(151)], { mtimeMs: 30 }),
            S('c', [pr(151, null)], { cwd: '/p/other', projectCwd: '/p/other', projectName: 'other' }),
            S('d', [pr(7, null)], { cwd: '/p/nowhere' }),
            S('e', [pr(151, 'you/lib')]),
            S('f', []),
        ], repoOf);

        assert.deepStrictEqual(owners['me/app#151'].map(o => o.sessionId), ['b', 'a']);
        ok('most recently active first, each session once however often it linked');

        assert.deepStrictEqual(owners['me/other#151'].map(o => o.sessionId), ['c']);
        assert.deepStrictEqual(owners['you/lib#151'].map(o => o.sessionId), ['e']);
        ok('the same number in two repositories stays two keys');

        assert.ok(!Object.keys(owners).some(k => k.includes('null') || k.endsWith('#7')));
        assert.deepStrictEqual(asked.sort(), ['/p/nowhere', '/p/other']);
        ok('a pr-link with no repository is filed under its checkout, or left out');

        const o = owners['me/app#151'][0];
        assert.deepStrictEqual(Object.keys(o).sort(),
            ['archived', 'mtimeMs', 'projectCwd', 'projectName', 'sessionId', 'title']);
        ok('owner rows carry exactly the documented fields');
    }

    const { resolvePrRef, reposOf, targetsOf, targetLabel } = await import('../web/pr-resolve.js');
    const { renderMarkdown } = await import('../web/markdown.js');

    // --- resolvePrRef ----------------------------------------------------------
    {
        const owners = {
            'me/app#153': [{ sessionId: 'self', title: 'reuse-message', projectName: 'claude-sessions' }],
            'me/app#151': [{ sessionId: 'x', title: 'standing-live', projectName: 'claude-sessions' }],
            'me/mobile#151': [
                { sessionId: 'm1', title: 'pairing-qr', projectName: 'tgxcode-mobile' },
                { sessionId: 'm2', title: 'pairing-qr-retry', projectName: 'tgxcode-mobile' },
                { sessionId: 'm1', title: 'pairing-qr', projectName: 'tgxcode-mobile' },
            ],
            'me/unrelated#151': [{ sessionId: 'u', title: 'nope', projectName: 'unrelated' }],
        };
        const single = { repos: reposOf('me/app', [pr(153)]), owners, selfId: 'self' };

        assert.deepStrictEqual(targetsOf(resolvePrRef(153, single)), []);
        ok("this chat's own PR goes nowhere — it stays plain text");

        const one = resolvePrRef(151, single);
        assert.strictEqual(one.length, 1);
        assert.deepStrictEqual(targetsOf(one).map(t => t.sessionId), ['x']);
        assert.strictEqual(targetLabel(targetsOf(one)[0]), 'claude-sessions – (standing-live)');
        ok("another chat's PR in the same repository resolves to that chat, labelled Project – (Chat)");

        assert.ok(!JSON.stringify(one).includes('unrelated') && !JSON.stringify(one).includes('pairing'));
        ok('a single-repository chat never consults any other repository');

        const multi = { repos: reposOf('me/app', [pr(153), pr(4, 'me/mobile')]), owners, selfId: 'self' };
        const stacked = resolvePrRef(151, multi);
        assert.deepStrictEqual(stacked.map(s => s.projectName), ['claude-sessions', 'tgxcode-mobile']);
        assert.deepStrictEqual(stacked[1].entries.map(e => e.sessionId), ['m1', 'm2']);
        assert.ok(!JSON.stringify(stacked).includes('unrelated'));
        ok('a chat spanning two repositories gets a section each, deduplicated, and no third');

        assert.deepStrictEqual(reposOf(null, [pr(1, null), pr(2, 'a/b'), pr(3, 'a/b')]), ['a/b']);
        assert.deepStrictEqual(resolvePrRef(151, { repos: [], owners, selfId: 'self' }), []);
        ok('no known repository means no resolution at all');
    }

    // --- the markdown mark -----------------------------------------------------
    {
        const marks = (src) => [...renderMarkdown(src).matchAll(/<a class="pr-ref" data-pr="(\d+)">#\1<\/a>/g)]
            .map(m => m[1]);
        assert.deepStrictEqual(
            marks("I haven't merged #153, because it can't reach main without #151 (#12) **#9** [#8]"),
            ['153', '151', '12', '9', '8']);
        ok('#N is marked after a space, at the start, in brackets and in emphasis');

        assert.deepStrictEqual(marks('#151 first'), ['151']);
        assert.deepStrictEqual(marks('see `#151` and https://github.com/a/b/pull/7#151 and abc#12 and #12abc'), []);
        assert.deepStrictEqual(marks('[see #4](https://example.com/x)'), []);
        assert.deepStrictEqual(marks('![shot #5](https://example.com/x.png)'), []);
        assert.ok(!renderMarkdown('# 151 heading').includes('pr-ref'));
        assert.ok(!renderMarkdown("it's").includes('pr-ref'));
        ok('code spans, URL fragments, words, link text, alt text, headings and entities are left alone');
    }

    console.log(`\npr-owners: ${pass} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
