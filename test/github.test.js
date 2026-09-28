'use strict';

// Publishing a directory to GitHub (bridge/github.js).
//
// The argv builders are pure and checked as such. `publish` is checked end to end
// against real git in a temp directory, with a stub `gh` first on PATH. The stub
// logs every argv it is given and answers the few API calls a publish makes, so
// nothing here reaches GitHub. What the cases are about is the order and the
// refusals: a starter file that already exists is kept, `--push` is not passed
// with nothing to push, a directory inside another repository is refused rather
// than given a nested `.git`, and a settings failure after the repository exists
// still comes back with its URL.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-github-'));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});

// --- the stub gh -----------------------------------------------------------

const BIN = path.join(TMP, 'bin');
const LOG = path.join(TMP, 'gh.log');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(LOG)}
case "$1 $2" in
  "api user") echo '{"login":"me","name":"Me Person"}' ;;
  "api user/orgs") echo '[{"login":"acme"}]' ;;
  "api gitignore/templates/Node") echo '{"source":"node_modules/"}' ;;
  "api licenses/mit") echo '{"body":"Copyright (c) [year] [fullname]"}' ;;
  "api repos/"*) echo 'HTTP 404: Not Found' >&2; exit 1 ;;
  "repo create") [ -n "$STUB_FAIL_CREATE" ] && { echo 'boom' >&2; exit 1; }; echo "https://github.com/$3" ;;
  "repo edit") [ -n "$STUB_FAIL_EDIT" ] && { echo 'edit refused' >&2; exit 1; }; true ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
Object.assign(process.env, {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
});

const gh = require('../bridge/github.js');

const logLines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : []);
const resetLog = () => { try { fs.unlinkSync(LOG); } catch { /* first time */ } };
const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const dir = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };

(async () => {
    // --- pure -------------------------------------------------------------

    assert.strictEqual(gh.repoNameProblem('my-app_2.0'), null);
    assert.ok(gh.repoNameProblem(''));
    assert.ok(gh.repoNameProblem('..'));
    assert.ok(gh.repoNameProblem('has space'));
    assert.ok(gh.repoNameProblem('x.git'));
    assert.ok(gh.repoNameProblem('a'.repeat(101)));
    ok('repoNameProblem accepts what GitHub accepts and names the rest');

    assert.strictEqual(gh.suggestName('My Project (old)'), 'My-Project-old');
    assert.strictEqual(gh.suggestName('thing.git'), 'thing');
    ok('suggestName makes a folder name GitHub-legal');

    assert.deepStrictEqual(
        gh.createArgs({ owner: 'o', name: 'n', visibility: 'public', cwd: '/x', push: true,
            description: 'd', team: 't', disableWiki: true }),
        ['repo', 'create', 'o/n', '--public', '--source', '/x', '--remote', 'origin', '--push',
            '--description', 'd', '--team', 't', '--disable-wiki']);
    ok('createArgs builds the argv in order');

    assert.strictEqual(gh.editArgs('o/n', {}), null);
    assert.strictEqual(gh.editArgs('o/n', { squashMerge: true, autoMerge: false, squashMessage: 'default' }), null);
    assert.deepStrictEqual(
        gh.editArgs('o/n', { mergeCommit: false, deleteBranchOnMerge: true, squashMessage: 'pr-title',
            topics: 'Web App, cli ,cli' }),
        ['repo', 'edit', 'o/n', '--enable-merge-commit=false', '--delete-branch-on-merge',
            '--squash-merge-commit-message', 'pr-title', '--add-topic', 'web-app', '--add-topic', 'cli']);
    ok('editArgs passes only what differs from GitHub\'s defaults');

    assert.strictEqual(gh.fillLicense('(c) [year] [fullname]', { year: 2026, fullname: 'A B' }), '(c) 2026 A B');
    ok('fillLicense fills the placeholders');

    // --- publish: a fresh folder ------------------------------------------

    resetLog();
    const fresh = dir('fresh');
    fs.writeFileSync(path.join(fresh, 'index.js'), 'console.log(1)\n');
    let r = await gh.publish(fresh, {
        owner: 'me', name: 'fresh', gitignore: 'Node', license: 'mit', readme: true,
        description: 'A thing', settings: { deleteBranchOnMerge: true },
        // Beside the name rather than inside settings, which is how the dialog
        // sends it.
        topics: 'cli',
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.url, 'https://github.com/me/fresh');
    assert.strictEqual(gitIn(fresh, 'branch', '--show-current'), 'main');
    const tracked = gitIn(fresh, 'ls-files').split('\n').sort();
    assert.deepStrictEqual(tracked, ['.gitignore', 'LICENSE', 'README.md', 'index.js']);
    assert.match(fs.readFileSync(path.join(fresh, 'LICENSE'), 'utf8'), /Copyright \(c\) \d{4} Me Person/);
    const create = logLines().find(l => l.startsWith('repo create'));
    assert.match(create, /^repo create me\/fresh --private --source \S+fresh --remote origin --push --description A thing$/);
    assert.ok(logLines().some(l => l === 'repo edit me/fresh --delete-branch-on-merge --add-topic cli'));
    assert.deepStrictEqual(r.steps.map(s => s.step),
        ['write .gitignore', 'write LICENSE', 'write README.md', 'git init', 'commit',
            'create repository', 'push', 'settings']);
    ok('a fresh folder gets starter files, git init, a commit, a pushed repo and its settings');

    // --- publish: an existing repo with its own .gitignore, no commits ----

    resetLog();
    const bare = dir('bare');
    gitIn(bare, 'init', '-q', '-b', 'trunk');
    fs.writeFileSync(path.join(bare, '.gitignore'), 'mine\n');
    r = await gh.publish(bare, { owner: 'acme', name: 'bare', visibility: 'internal', gitignore: 'Node', commit: false });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(path.join(bare, '.gitignore'), 'utf8'), 'mine\n');
    assert.strictEqual(r.steps[0].skipped, true);
    assert.ok(!r.steps.some(s => s.step === 'git init'), 'an existing repo is not re-initialised');
    assert.ok(!logLines().find(l => l.startsWith('repo create')).includes('--push'));
    assert.strictEqual(r.steps.find(s => s.step === 'push').detail, 'no commits yet');
    ok('an existing .gitignore is kept, and --push is left out with nothing to push');

    // --- refusals ---------------------------------------------------------

    // The real gh adds the remote; the stub does not, so stand in for it.
    gitIn(bare, 'remote', 'add', 'origin', 'https://github.com/acme/bare.git');
    await assert.rejects(gh.publish(bare, { owner: 'me', name: 'again' }),
        e => e.status === 409 && /already has a remote/.test(e.message));
    ok('a directory that already has the remote is refused');

    const outer = dir('outer');
    gitIn(outer, 'init', '-q');
    const inner = dir('outer/inner');
    await assert.rejects(gh.publish(inner, { owner: 'me', name: 'inner' }),
        e => e.status === 409 && /inside the repository/.test(e.message));
    assert.ok(!fs.existsSync(path.join(inner, '.git')));
    ok('a folder inside another repository is refused, not given a nested .git');

    await assert.rejects(gh.publish(dir('x1'), { owner: 'someone-else', name: 'x' }), e => e.status === 400);
    await assert.rejects(gh.publish(dir('x2'), { owner: 'me', name: 'x', visibility: 'internal' }), e => e.status === 400);
    await assert.rejects(gh.publish(dir('x3'), { owner: 'me', name: 'bad name' }), e => e.status === 400);
    ok('an unknown owner, internal on a personal account, and a bad name are refused');

    // --- partial success --------------------------------------------------

    process.env.STUB_FAIL_EDIT = '1';
    r = await gh.publish(dir('edited'), { owner: 'me', name: 'edited', commit: false, settings: { autoMerge: true } });
    delete process.env.STUB_FAIL_EDIT;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.url, 'https://github.com/me/edited');
    assert.deepStrictEqual(r.steps.at(-1), { step: 'settings', ok: false, detail: 'edit refused' });
    ok('a settings failure after the repo exists still returns ok and the url');

    process.env.STUB_FAIL_CREATE = '1';
    r = await gh.publish(dir('failed'), { owner: 'me', name: 'failed', commit: false });
    delete process.env.STUB_FAIL_CREATE;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.url, null, 'the stub says the name is free, so there is no repo to link to');
    assert.strictEqual(r.steps.at(-1).detail, 'boom');
    ok('a failed create reports its error and no url for a repo that does not exist');

    // --- repoState --------------------------------------------------------

    const st = await gh.repoState(fresh);
    assert.strictEqual(st.isGit, true);
    assert.strictEqual(st.hasCommits, true);
    assert.deepStrictEqual(st.existing, { gitignore: true, license: true, readme: true });
    const plain = await gh.repoState(dir('Plain Folder'));
    assert.strictEqual(plain.isGit, false);
    assert.strictEqual(plain.suggestedName, 'Plain-Folder');
    assert.strictEqual((await gh.repoState(inner)).insideOther, fs.realpathSync(outer));
    ok('repoState tells a fresh folder, a repo, and a folder inside a repo apart');

    console.log(`\n  ${pass} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
