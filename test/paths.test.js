'use strict';

// Filesystem paths in a transcript — web/markdown.js and the half of
// bridge/explorer.js that decides what must not be launched.
//
// No bridge needed. Almost all of this is one regex, and a regex over prose is
// the kind of code where the interesting cases are the ones it must *not* match:
// `/api/sessions/:id/reveal` is absolute and full of slashes, `and/or` has a
// slash in the middle of a word, and `https://example.com/home/foo.md` contains
// a perfectly good-looking path. Each of those became a link at some point while
// this was being written, which is why they are all here.
//
// The other half is ordering. inline() escapes once, applies a list of regexes
// and then restores parked code spans, so a path pass in the wrong place either
// shows its own anchor as text or has `/home/d/my_file_name.py` chewed into
// emphasis. Both are pinned below.

const assert = require('assert');
const { isLaunchable } = require('../bridge/explorer.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// The module warns about being loaded from a package.json with no "type", which
// is noise in a test run and says nothing about the code.
process.removeAllListeners('warning');

(async () => {
    const md = await import('../web/markdown.js');
    const { renderMarkdown, configurePaths } = md;

    /** Every path anchor in some rendered markdown, as {path, text, href, title}. */
    const links = (src) => [...renderMarkdown(src).matchAll(
        /<a class="fs-path" href="([^"]*)" title="([^"]*)" data-path="([^"]*)">([^<]*)<\/a>/g,
    )].map(m => ({ href: m[1], title: m[2], path: m[3], text: m[4] }));

    const one = (src) => {
        const found = links(src);
        assert.strictEqual(found.length, 1, `expected one link in ${JSON.stringify(src)}`);
        return found[0];
    };

    // --- off until the page says otherwise -------------------------------
    // This is the remote contract, not a default worth being casual about: a
    // browser off this machine is served no tgx-host meta, and a path it cannot
    // reach must render as text rather than as a link that fails.
    assert.ok(!renderMarkdown('see /home/x/y.md').includes('fs-path'));
    assert.ok(!renderMarkdown('see `/home/x/y.md`').includes('fs-path'));
    assert.ok(!renderMarkdown('see C:\\x\\y.md').includes('fs-path'));
    ok('paths stay plain text until configurePaths is called');

    configurePaths({ distro: 'Ubuntu', home: '/home/tester' });

    // --- what is a path --------------------------------------------------
    assert.strictEqual(one('see /home/dylan/.claude/plans/foo.md for it.').path,
        '/home/dylan/.claude/plans/foo.md');
    assert.strictEqual(one('at /var/log/syslog now').path, '/var/log/syslog');
    assert.strictEqual(one('and /etc; also').path, '/etc');
    ok('an absolute path under a real root is a link');

    // An extension is the other way in, so a path under a root this list has
    // never heard of still works.
    assert.strictEqual(one('the file /data/exports/report.csv arrived').path,
        '/data/exports/report.csv');
    ok('an absolute path with a file extension is a link wherever it lives');

    // --- what is not -----------------------------------------------------
    for (const src of [
        'POST /api/sessions/:id/reveal is refused',
        'and/or, TODO/FIXME, 50/50',
        'https://example.com/home/foo.md',
        'see http://127.0.0.1:45899/api/fs for the listing',
    ]) {
        assert.strictEqual(links(src).length, 0, `linked something in ${JSON.stringify(src)}`);
    }
    ok('routes, prose slashes and URLs are left alone');

    // --- relative paths --------------------------------------------------
    // The case this exists for: "Run `migrations/…sql`" from an agent working in
    // a worktree you would otherwise have to go and find.
    const mig = one('Run `migrations/some-ddl-change.sql`, then restart.');
    assert.strictEqual(mig.path, 'migrations/some-ddl-change.sql', 'sent as written');
    assert.strictEqual(mig.href, '#', 'a relative path has no URL of its own');
    assert.strictEqual(mig.title, 'In this session&#39;s working directory');
    ok('a relative path in a code span is a link, sent as written');

    const rel = links('see web/app.js:14744 and docs/api.md.');
    assert.deepStrictEqual(rel.map(l => [l.path, l.text]),
        [['web/app.js', 'web/app.js:14744'], ['docs/api.md', 'docs/api.md']]);
    assert.deepStrictEqual(links('`./scripts/land.sh` or ../x/y.md').map(l => l.path),
        ['./scripts/land.sh', '../x/y.md']);
    assert.deepStrictEqual(links('`.claude/settings.json` in `bridge/`').map(l => l.path),
        ['.claude/settings.json', 'bridge/']);
    assert.strictEqual(one('my_dir/my_file_name.py').path, 'my_dir/my_file_name.py');
    ok('bare, dotted, ./ and ../ relative paths are links, with line numbers and full stops handled');

    // Prose is full of slashes. Each of these would be a link under a looser rule.
    for (const src of [
        'and/or, TODO/FIXME, 50/50, origin/main, 1/2.5, km/h',
        'text/html and image/png', 'e.g./i.e. text', 'the feat/v2.0 branch',
        'state.current and package.json',
        'www.example.com/foo.html', '127.0.0.1:45899/api/x.json', 'localhost:3000/a/b.html',
        '[docs](docs/api.md)', '[docs/api.md](https://example.com)',
    ]) {
        assert.strictEqual(links(src).length, 0, `linked something in ${JSON.stringify(src)}`);
    }
    ok('slashes in prose, bare hosts and markdown links do not become relative paths');

    // The later passes must not take a bite out of what an earlier one linked.
    assert.deepStrictEqual(links('/home/x/a/b.md and \\\\wsl$\\Ubuntu\\a\\b.md').map(l => l.path),
        ['/home/x/a/b.md', '\\\\wsl$\\Ubuntu\\a\\b.md']);
    ok('an absolute or Windows path is one link, not a relative one inside it');

    // The guard that keeps `Files/thing.pdf` out of `/mnt/c/Program Files/…` must
    // not also swallow a relative path that just follows a code span.
    assert.strictEqual(one('run `npm test` web/app.js').path, 'web/app.js');
    ok('a relative path right after a code span is still a link');

    // --- punctuation and line numbers ------------------------------------
    const lc = one('at /home/d/x/my_file.py:123:5, ok');
    assert.strictEqual(lc.path, '/home/d/x/my_file.py', 'the line number stayed on the path');
    assert.strictEqual(lc.text, '/home/d/x/my_file.py:123:5', 'the line number left the text');
    ok('a trailing :line:col shows in the link and comes off the path');

    assert.strictEqual(one('(/tmp/a.log) and').path, '/tmp/a.log');
    assert.strictEqual(one('ends the sentence at /tmp/a.log.').path, '/tmp/a.log');
    assert.ok(renderMarkdown('ends at /tmp/a.log.').includes('</a>.'),
        'the full stop was swallowed into the path');
    ok('brackets, commas and a closing full stop stay outside the link');

    // A path with a space in it is deliberately not matched — see PATH_RE.
    assert.strictEqual(one('/mnt/c/Program Files/thing.pdf').path, '/mnt/c/Program');
    ok('a path with a space matches only as far as the space, on purpose');

    // --- ordering inside inline() ----------------------------------------
    // The regression the parking exists for: two underscores in a file name are
    // exactly what the emphasis rules would turn into <em>.
    const under = renderMarkdown('/home/d/my_file_name.py');
    assert.ok(!under.includes('<em>'), under);
    assert.strictEqual(one('/home/d/my_file_name.py').path, '/home/d/my_file_name.py');
    ok('underscores in a file name do not become emphasis');

    assert.ok(renderMarkdown('**/home/x/y.md**').includes('<strong><a class="fs-path"'));
    ok('a path inside emphasis is still linked, and still emphasised');

    // Escaped exactly once, by pathAnchor and nothing else.
    const esc = renderMarkdown('a < b and /home/x/y.md');
    assert.ok(esc.includes('&lt; b'), esc);
    assert.ok(!esc.includes('&amp;'), esc);
    ok('the surrounding text is escaped once and the anchor is not escaped at all');

    // --- markdown links, both directions ---------------------------------
    for (const src of ['[docs](/home/x/y.md)', '[/home/x/y.md](https://example.com)']) {
        assert.strictEqual(links(src).length, 0, `nested an anchor in ${src}`);
    }
    ok('neither half of a markdown link grows a path anchor inside it');

    // --- code spans and fences -------------------------------------------
    const span = renderMarkdown('a span `/tmp/claude-1000/x.log` here');
    assert.ok(span.includes('<code><a class="fs-path"'), span);
    assert.ok(span.includes('</a></code>'), span);
    ok('a path inside a code span is linked, and the code span survives');

    // Escaping inside a span still happens for everything that is not an anchor.
    const spanEsc = renderMarkdown('`a < b and /home/x/y.md`');
    assert.ok(spanEsc.includes('a &lt; b'), spanEsc);
    assert.strictEqual(links('`a < b and /home/x/y.md`').length, 1);
    ok('a code span with a path in it is still escaped around the path');

    assert.strictEqual(links('```\n/home/x/y.md\n```').length, 0);
    ok('a fenced code block is left alone');

    // --- the Windows forms -----------------------------------------------
    const wsl = one('/home/dylan/a.md');
    assert.strictEqual(wsl.href, 'file://wsl.localhost/Ubuntu/home/dylan/a.md');
    assert.strictEqual(wsl.title, '\\\\wsl.localhost\\Ubuntu\\home\\dylan\\a.md');
    ok('a distro path gets the \\\\wsl.localhost form');

    // /mnt/<letter> is a Windows drive rather than a share — cosmetically. The
    // translation that gets acted on is wslpath -w on the bridge.
    const drive = one('/mnt/c/Users/x/a.pdf');
    assert.strictEqual(drive.href, 'file:///C:/Users/x/a.pdf');
    assert.strictEqual(drive.title, 'C:\\Users\\x\\a.pdf');
    ok('a /mnt path gets a drive letter');

    // `~` reaches the bridge unexpanded: there is one expander and it is
    // cfg.expandHome. HOST.home is for the tooltip only.
    const tilde = one('~/Other/x/README.md');
    assert.strictEqual(tilde.path, '~/Other/x/README.md');
    assert.strictEqual(tilde.text, '~/Other/x/README.md');
    assert.strictEqual(tilde.href, 'file://wsl.localhost/Ubuntu/home/tester/Other/x/README.md');
    ok('a ~ path is displayed expanded and sent unexpanded');

    // --- paths written the Windows way -----------------------------------
    // The case this exists for, verbatim from a transcript: an agent telling you
    // where to find a build from the Windows side.
    const exe = '\\\\wsl.localhost\\Ubuntu\\home\\dylan_hays\\Other\\Paycom-Agency-Hours-Import'
        + '\\AgencyHours\\bin\\Release\\net10.0\\win-x64\\publish\\AgencyHours.exe';
    const share = one(`run "${exe}" from Windows`);
    assert.strictEqual(share.path, exe, 'the path was not sent as written');
    assert.strictEqual(share.text, exe);
    assert.strictEqual(share.title, '/home/dylan_hays/Other/Paycom-Agency-Hours-Import'
        + '/AgencyHours/bin/Release/net10.0/win-x64/publish/AgencyHours.exe');
    assert.ok(share.href.startsWith('file://wsl.localhost/Ubuntu/home/dylan_hays/'), share.href);
    ok('a \\\\wsl.localhost path is a link, sent verbatim, with its Linux form on hover');

    const old = one('see `\\\\wsl$\\Ubuntu\\tmp\\a.log`.');
    assert.strictEqual(old.path, '\\\\wsl$\\Ubuntu\\tmp\\a.log');
    assert.strictEqual(old.title, '/tmp/a.log');
    ok('the older \\\\wsl$ share is a link too, inside a code span');

    const win = one('at C:\\Users\\x\\a.txt:12, then.');
    assert.strictEqual(win.path, 'C:\\Users\\x\\a.txt');
    assert.strictEqual(win.text, 'C:\\Users\\x\\a.txt:12');
    assert.strictEqual(win.title, '/mnt/c/Users/x/a.txt');
    assert.strictEqual(win.href, 'file:///C:/Users/x/a.txt');
    assert.ok(renderMarkdown('ends at D:\\a.log.').includes('</a>.'),
        'the full stop was swallowed into the path');
    ok('a drive path is a link, with its line number and full stop handled like a POSIX one');

    // Some other distro's share has no Linux path here, so it hovers as written.
    const other = one('\\\\wsl.localhost\\Debian\\home\\x.md');
    assert.strictEqual(other.title, '\\\\wsl.localhost\\Debian\\home\\x.md');
    ok('a share for another distribution is linked but not translated');

    const mixed = links('both /home/x/a.md and D:\\stuff\\ here');
    assert.deepStrictEqual(mixed.map(l => l.path), ['/home/x/a.md', 'D:\\stuff\\']);
    ok('a POSIX and a Windows path in one line are two links');

    for (const src of ['foo\\\\wsl.localhost\\Ubuntu\\x', 'ABC:\\x', '[x](C:\\a.txt)',
        '[C:\\a.txt](https://example.com)']) {
        assert.strictEqual(links(src).length, 0, `linked something in ${JSON.stringify(src)}`);
    }
    ok('a Windows path mid-word or in a markdown link is left alone');

    // --- what the host must not be asked to launch -------------------------
    for (const f of ['/home/x/a.exe', '/home/x/a.EXE', '/home/x/a.lnk', '/home/x/a.url',
        '/home/x/a.ps1', '/home/x/a.bat', '/home/x/a.msi', '/home/x/a.appref-ms']) {
        assert.strictEqual(isLaunchable(f), true, f);
    }
    // A Linux desktop runs these, and a `.desktop` is the Linux `.lnk`: a
    // pointer to a command that nothing on this side can see the far end of.
    for (const f of ['/home/x/a.desktop', '/home/x/a.AppImage', '/home/x/a.appimage',
        '/home/x/a.run', '/home/x/a.bin']) {
        assert.strictEqual(isLaunchable(f), true, f);
    }
    // Deliberately openable, and pinned so a later tidy-up does not "fix" it:
    // .js is what this repository is made of.
    for (const f of ['/home/x/app.js', '/home/x/plan.md', '/home/x/run.sh', '/home/x/a.py',
        '/home/x/noext', '', null]) {
        assert.strictEqual(isLaunchable(f), false, String(f));
    }
    ok('isLaunchable names the file types either host would run, and only those');

    // The list is one set rather than a pair chosen by platform, so that it
    // stays a pure function and cannot be wrong about which host it is on. That
    // is a decision, not an accident, and this is what pins it: the answer must
    // not move when the host does.
    const wasKind = process.env.TGXCODE_HOST_KIND;
    for (const kind of ['wsl', 'linux']) {
        process.env.TGXCODE_HOST_KIND = kind;
        assert.strictEqual(isLaunchable('/home/x/a.ps1'), true, `${kind}: .ps1`);
        assert.strictEqual(isLaunchable('/home/x/a.desktop'), true, `${kind}: .desktop`);
        assert.strictEqual(isLaunchable('/home/x/app.js'), false, `${kind}: .js`);
    }
    if (wasKind === undefined) delete process.env.TGXCODE_HOST_KIND;
    else process.env.TGXCODE_HOST_KIND = wasKind;
    ok('isLaunchable gives the same answer on either host');

    console.log(`\n${pass} path checks passed`);
})();
