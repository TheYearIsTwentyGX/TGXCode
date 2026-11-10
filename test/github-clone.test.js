'use strict';

// Cloning an existing repository (bridge/github-clone.js).
//
// Parsing and argv are pure and checked as such. The rest runs against a stub
// `gh` first on PATH, which logs every argv it is given and answers `api user`,
// `api user/repos`, `repo view` and `repo clone` (the last by making a real
// repository in the destination, so the post-clone steps see something). Nothing
// reaches GitHub. TGXCODE_ROOTS is set before the require because the allowed
// roots are read when config.js loads.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-clone-')));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});
const ROOT = path.join(TMP, 'roots');
fs.mkdirSync(ROOT);
process.env.TGXCODE_ROOTS = ROOT;

// --- the stub gh -----------------------------------------------------------

const BIN = path.join(TMP, 'bin');
const LOG = path.join(TMP, 'gh.log');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(LOG)}
case "$1 $2" in
  "api user") echo '{"login":"me","name":"Me Person"}' ;;
  "api user/orgs") echo '[{"login":"acme"}]' ;;
  "api user/repos"*)
    # 130 repos over two pages; page 2 is the short one.
    page=$(printf '%s' "$2" | sed -n 's/.*page=\\([0-9]*\\).*/\\1/p')
    if [ "$page" = "1" ]; then
      node -e 'const a=[];for(let i=1;i<=100;i++)a.push({full_name:"me/r"+i,name:"r"+i,owner:{login:"me"},private:i%2===0,visibility:i%2?"public":"private",description:i===7?"the widget factory":null,pushed_at:"2026-01-01T00:00:00Z"});console.log(JSON.stringify(a))'
    elif [ "$page" = "2" ]; then
      node -e 'const a=[];for(let i=101;i<=130;i++)a.push({full_name:"acme/r"+i,name:"r"+i,owner:{login:"acme"},private:true,visibility:"private",pushed_at:"2025-01-01T00:00:00Z"});console.log(JSON.stringify(a))'
    else echo '[]'; fi ;;
  "api repos/me/branchy/branches/"*)
    case "$2" in
      */branches/feature/x) echo 'feature/x' ;;
      */branches/main) echo 'main' ;;
      *) echo 'HTTP 404: Branch not found' >&2; exit 1 ;;
    esac ;;
  "repo view")
    case "$3" in
      me/private|me/Private) echo '{"nameWithOwner":"me/private","visibility":"PRIVATE","isPrivate":true,"url":"https://github.com/me/private","defaultBranchRef":{"name":"main"},"diskUsage":42}' ;;
      me/branchy) echo '{"nameWithOwner":"me/branchy","visibility":"PUBLIC","isPrivate":false,"url":"https://github.com/me/branchy","defaultBranchRef":{"name":"main"}}' ;;
      me/cap) echo '{"nameWithOwner":"me/Cap","visibility":"PUBLIC","isPrivate":false,"url":"https://github.com/me/Cap","defaultBranchRef":{"name":"main"}}' ;;
      me/denied) echo 'HTTP 403: Resource protected by organization SAML enforcement' >&2; exit 1 ;;
      *) echo 'GraphQL: Could not resolve to a Repository with the name '"'$3'"'. (repository)' >&2; exit 1 ;;
    esac ;;
  "repo clone")
    [ -n "$STUB_FAIL_CLONE" ] && { echo 'fatal: unable to access: boom' >&2; exit 1; }
    git init -q -b main "$4" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
Object.assign(process.env, {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
});

const clone = require('../bridge/github-clone.js');
const { Refusal } = require('../bridge/github.js');

const logLines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : []);
const resetLog = () => { try { fs.unlinkSync(LOG); } catch { /* first time */ } };
const dir = (name) => { const d = path.join(ROOT, name); fs.mkdirSync(d, { recursive: true }); return d; };
const refused = async (fn, status, re) => {
    try { await fn(); } catch (err) {
        assert.ok(err instanceof Refusal, `expected a Refusal, got ${err}`);
        assert.strictEqual(err.status, status, err.message);
        if (re) assert.match(err.message, re);
        return;
    }
    assert.fail('expected a Refusal');
};

(async () => {
    // --- parsing ------------------------------------------------------------
    const gh = (input, want) => {
        const r = clone.parseRepoInput(input);
        assert.strictEqual(r.error, undefined, `${input}: ${r.error}`);
        assert.strictEqual(r.kind, 'github', input);
        assert.deepStrictEqual([r.owner, r.repo, r.branch], want, input);
    };
    gh('octo/hello', ['octo', 'hello', null]);
    gh('  octo/hello  ', ['octo', 'hello', null]);
    gh('octo\\hello', ['octo', 'hello', null]);            // the backslash the user typed
    gh('octo/hello.git', ['octo', 'hello', null]);
    gh('https://github.com/octo/hello', ['octo', 'hello', null]);
    gh('https://github.com/octo/hello.git', ['octo', 'hello', null]);
    gh('https://github.com/octo/hello/', ['octo', 'hello', null]);
    gh('https://www.github.com/octo/hello', ['octo', 'hello', null]);
    gh('http://github.com/octo/hello', ['octo', 'hello', null]);
    gh('github.com/octo/hello', ['octo', 'hello', null]);
    gh('https:\\\\github.com\\octo\\hello', ['octo', 'hello', null]);
    gh('git@github.com:octo/hello.git', ['octo', 'hello', null]);
    gh('ssh://git@github.com/octo/hello.git', ['octo', 'hello', null]);
    gh('https://github.com/octo/hello/tree/main', ['octo', 'hello', 'main']);
    gh('https://github.com/octo/hello/tree/feature/x', ['octo', 'hello', 'feature/x']);
    gh('https://github.com/octo/hello/pull/12', ['octo', 'hello', null]);
    gh('https://github.com/octo/hello/blob/main/README.md', ['octo', 'hello', null]);
    gh('https://github.com/octo/hello?tab=readme#top', ['octo', 'hello', null]);
    assert.strictEqual(clone.parseRepoInput('octo/hello').name, 'hello');
    ok('owner/repo, owner\\repo and GitHub URLs all parse');

    const other = clone.parseRepoInput('https://gitlab.com/group/sub/proj.git');
    assert.deepStrictEqual([other.kind, other.host, other.name, other.url],
        ['other', 'gitlab.com', 'proj', 'https://gitlab.com/group/sub/proj.git']);
    const scp = clone.parseRepoInput('git@bitbucket.org:team/proj.git');
    assert.deepStrictEqual([scp.kind, scp.host, scp.name], ['other', 'bitbucket.org', 'proj']);
    assert.strictEqual(clone.parseRepoInput('ssh://git@git.example.com:2222/a/b.git').kind, 'other');
    ok('other hosts parse as a plain git clone');

    for (const bad of ['', '   ', 'octo', 'a/b/c', 'octo/', '/octo/hello', 'octo hello/x', '-oProxyCommand=x/y',
        'file:///etc/passwd', 'ext::sh -c id', 'C:\\Users\\me\\proj', './rel/path', '~/proj/x', 'ftp://h/a/b',
        'ssh://-oProxyCommand=x@host/a/b', 'http://example.com/a/b', 'git://example.com/a/b',
        'https://-evil.com/a/b', 'https://github.com/octo', '-x/y', 'octo/..', 'octo/.', 'bad_owner/x',
        'octo/hello/tree/-bad', 'https://github.com/octo/hello/tree/a..b']) {
        const r = clone.parseRepoInput(bad);
        assert.ok(r.error, `expected "${bad}" to be refused, got ${JSON.stringify(r)}`);
    }
    ok('malformed, local, option-looking and non-https/ssh references are refused');

    // --- argv ---------------------------------------------------------------
    assert.deepStrictEqual(clone.cloneArgs({ fullName: 'o/r', dir: '/d/r' }), ['repo', 'clone', 'o/r', '/d/r']);
    assert.deepStrictEqual(clone.cloneArgs({ fullName: 'o/r', dir: '/d/r', branch: 'dev' }),
        ['repo', 'clone', 'o/r', '/d/r', '--', '--branch', 'dev']);
    assert.deepStrictEqual(clone.gitCloneArgs({ url: 'https://h/a/b.git', dir: '/d/b', branch: 'x' }),
        ['clone', '--branch', 'x', '--', 'https://h/a/b.git', '/d/b']);
    assert.deepStrictEqual(clone.gitCloneArgs({ url: 'u', dir: 'd' }), ['clone', '--', 'u', 'd']);
    assert.strictEqual(clone.branchProblem('feature/x'), null);
    assert.ok(clone.branchProblem('-x'));
    assert.ok(clone.branchProblem('a b'));
    ok('argv for gh repo clone and git clone');

    // --- resolving ----------------------------------------------------------
    resetLog();
    let r = await clone.resolve('me\\private');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual([r.fullName, r.visibility, r.private, r.defaultBranch, r.name],
        ['me/private', 'private', true, 'main', 'private']);
    assert.ok(logLines().some(l => l.startsWith('repo view me/private --json ')));
    r = await clone.resolve('me/cap');
    assert.strictEqual(r.name, 'Cap', "uses GitHub's own capitalisation for the folder");
    r = await clone.resolve('me/nope');
    assert.deepStrictEqual([r.ok, r.reason], [false, 'not-found']);
    assert.match(r.error, /not found, or this GitHub account cannot see it/);
    r = await clone.resolve('me/denied');
    assert.deepStrictEqual([r.ok, r.reason], [false, 'access']);
    r = await clone.resolve('nonsense');
    assert.deepStrictEqual([r.ok, r.reason], [false, 'invalid']);
    r = await clone.resolve('https://github.com/me/branchy/tree/feature/x');
    assert.deepStrictEqual([r.ok, r.branch], [true, 'feature/x']);
    r = await clone.resolve('https://github.com/me/branchy/tree/main/src/lib');
    assert.deepStrictEqual([r.ok, r.branch], [true, 'main'], 'a path after the branch is shortened away');
    r = await clone.resolve('me/branchy', { branch: 'ghost' });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'no-branch']);
    ok('resolve: found, not found, no access, bad input, branches');

    // --- the repo list ------------------------------------------------------
    resetLog();
    let list = await clone.repos({ limit: 20 });
    assert.strictEqual(list.repos.length, 20);
    assert.strictEqual(list.more, true);
    assert.deepStrictEqual(list.repos[0].fullName, 'me/r1');
    assert.strictEqual(list.repos[1].visibility, 'private');
    assert.ok(logLines().filter(l => l.startsWith('api user/repos')).length === 1, 'a first page is one request');
    assert.match(logLines().find(l => l.startsWith('api user/repos')), /affiliation=owner,collaborator,organization_member/);
    list = await clone.repos({ offset: 100, limit: 50 });
    assert.deepStrictEqual([list.repos.length, list.more], [30, false], 'the end of the list says there is no more');
    assert.strictEqual(list.repos[0].fullName, 'acme/r101');
    list = await clone.repos({ q: 'widget' });
    assert.deepStrictEqual(list.repos.map(x => x.fullName), ['me/r7'], 'search reads descriptions and reaches page 2');
    list = await clone.repos({ q: 'ACME r12' });
    assert.ok(list.repos.length >= 1 && list.repos.every(x => x.owner === 'acme'));
    list = await clone.repos({ q: 'zzz-nothing' });
    assert.deepStrictEqual([list.repos.length, list.more], [0, false]);
    assert.ok(clone.matchesRepo({ fullName: 'a/B', description: null }, 'b a'));
    ok('repo list pages lazily, searches across pages, and says when it ends');

    // --- destinations -------------------------------------------------------
    const parent = dir('p1');
    let t = await clone.checkDestination({ parent, name: 'proj' });
    assert.strictEqual(t.problem, null);
    assert.strictEqual(t.path, path.join(parent, 'proj'));
    for (const name of ['', '..', 'a/b', 'a\\b', '.hidden', '-x', 'a:b']) {
        assert.ok((await clone.checkDestination({ parent, name })).problem, `name "${name}"`);
    }
    t = await clone.checkDestination({ parent: os.tmpdir() === ROOT ? '/' : TMP, name: 'x' });
    assert.deepStrictEqual([t.status, !!t.problem], [403, true], 'outside the roots');
    t = await clone.checkDestination({ parent: path.join(ROOT, 'missing'), name: 'x' });
    assert.match(t.problem, /not a directory/);
    ok('destination: names, roots, missing parent');

    fs.mkdirSync(path.join(parent, 'full'));
    fs.writeFileSync(path.join(parent, 'full', 'f.txt'), 'x');
    t = await clone.checkDestination({ parent, name: 'full' });
    assert.deepStrictEqual([t.status, /not empty/.test(t.problem)], [409, true]);
    fs.mkdirSync(path.join(parent, 'empty'));
    t = await clone.checkDestination({ parent, name: 'empty' });
    assert.strictEqual(t.problem, null, 'an empty folder is fine');
    fs.writeFileSync(path.join(parent, 'afile'), 'x');
    assert.match((await clone.checkDestination({ parent, name: 'afile' })).problem, /not a folder/);
    ok('destination: refuses a non-empty folder, allows an empty one');

    const outer = dir('outer');
    execFileSync('git', ['init', '-q', outer]);
    const inner = path.join(outer, 'sub');
    fs.mkdirSync(inner);
    t = await clone.checkDestination({ parent: inner, name: 'x' });
    assert.deepStrictEqual([t.status, t.nested, /inside the repository/.test(t.problem)], [409, outer, true]);
    t = await clone.checkDestination({ parent: inner, name: 'x', allowNested: true });
    assert.deepStrictEqual([t.problem, t.nested], [null, outer], 'allowNested lets it through and still says why');
    ok('destination: inside another repository is refused unless confirmed');

    const esc = path.join(ROOT, 'escape');
    fs.symlinkSync(os.tmpdir(), esc);
    t = await clone.checkDestination({ parent: esc, name: 'x' });
    assert.strictEqual(t.status, 403, 'a symlink leading out of the roots is refused');
    ok('destination: symlink out of the roots is refused');

    // --- cloning ------------------------------------------------------------
    resetLog();
    const p2 = dir('p2');
    let res = await clone.clone({ repo: 'me\\private', parent: p2 });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.path, path.join(p2, 'private'));
    assert.strictEqual(res.fullName, 'me/private');
    assert.deepStrictEqual(res.steps.map(s => s.step), ['find repository', 'clone', 'check out']);
    assert.ok(fs.existsSync(path.join(res.path, '.git')), 'gh actually cloned');
    assert.ok(logLines().includes(`repo clone me/private ${res.path}`), logLines().join('|'));
    ok('clone: gh repo clone with the chosen folder, steps reported');

    resetLog();
    res = await clone.clone({ input: 'https://github.com/me/branchy/tree/feature/x', parent: p2, name: 'mine' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.path, path.join(p2, 'mine'));
    assert.ok(logLines().includes(`repo clone me/branchy ${res.path} -- --branch feature/x`), logLines().join('|'));
    ok('clone: custom folder name and branch from a /tree/ URL');

    resetLog();
    await refused(() => clone.clone({ repo: 'me/private', parent: p2 }), 409, /already exists/);
    await refused(() => clone.clone({ repo: 'me/nope', parent: p2 }), 404, /not found/);
    await refused(() => clone.clone({ repo: 'me/branchy', parent: p2, name: 'b2', branch: 'ghost' }), 404, /no branch/);
    await refused(() => clone.clone({ repo: 'nonsense', parent: p2 }), 400);
    await refused(() => clone.clone({ repo: 'me/private', parent: os.tmpdir(), name: 'x' }), 403, /allowed roots/);
    await refused(() => clone.clone({ repo: 'me/private', parent: inner }), 409, /inside the repository/);
    assert.ok(!logLines().some(l => l.startsWith('repo clone')), 'no refusal ran a clone');
    ok('clone: every refusal happens before gh repo clone runs');

    res = await clone.clone({ repo: 'me/private', parent: inner, allowNested: true });
    assert.strictEqual(res.ok, true);
    ok('clone: allowNested clones inside another repository');

    process.env.STUB_FAIL_CLONE = '1';
    resetLog();
    res = await clone.clone({ repo: 'me/branchy', parent: p2, name: 'failing' });
    delete process.env.STUB_FAIL_CLONE;
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.steps[res.steps.length - 1].step, 'clone');
    assert.strictEqual(res.steps[res.steps.length - 1].ok, false);
    assert.match(res.steps[res.steps.length - 1].detail, /boom/);
    assert.ok(!fs.existsSync(path.join(p2, 'failing')), 'nothing is left behind by a failed clone');
    ok('clone: a failed clone is reported as a step and leaves no folder');

    // An empty folder the user made is kept after a failure, and cloned into on success.
    fs.mkdirSync(path.join(p2, 'preexisting'));
    process.env.STUB_FAIL_CLONE = '1';
    res = await clone.clone({ repo: 'me/branchy', parent: p2, name: 'preexisting' });
    delete process.env.STUB_FAIL_CLONE;
    assert.strictEqual(res.ok, false);
    assert.ok(fs.existsSync(path.join(p2, 'preexisting')), 'a pre-existing empty folder is not removed');
    ok('clone: a pre-existing empty folder survives a failed clone');

    // Another host goes through plain git, never gh. Only the refusal is checked
    // here: reaching a real remote would need the network.
    resetLog();
    await refused(() => clone.clone({ repo: 'https://127.0.0.1:1/a/b.git', parent: p2 }), 404, /Could not reach/);
    assert.ok(!logLines().some(l => l.startsWith('repo clone')), 'gh is not used for other hosts');
    ok('clone: other hosts use git, and an unreachable one is a clear 404');

    console.log(`\n${pass} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
