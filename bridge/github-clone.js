'use strict';

// Cloning a repository that already exists: the other direction from
// bridge/github.js, which turns a directory into one. Three things live here —
// reading what someone typed into a repository reference, listing the repos the
// logged-in gh account can reach, and `gh repo clone` into a folder the caller
// chose.
//
// Decided here, and worth knowing before changing any of it:
//
//   * **gh does the cloning, so gh's login is used.** A private repository works
//     because `gh repo clone` hands git gh's credential helper. Nothing here
//     reads or stores a token.
//   * **The reference is parsed, then asked about, then cloned.** `owner/repo`,
//     `owner\repo` (a backslash is what a person on Windows types; it is only
//     ever a separator here), `https://github.com/owner/repo(.git)` with an
//     optional `/tree/<branch>`, `git@github.com:owner/repo.git` and
//     `ssh://git@github.com/...` all become `{owner, repo, branch?}`. Then
//     `gh repo view` says whether it exists and whether this account can see it,
//     which is a sentence ("not found, or you cannot see it") rather than a git
//     failure two layers down.
//   * **Other hosts get a plain `git clone`, narrowly.** https and ssh only
//     (`GIT_ALLOW_PROTOCOL`), never a local path, `file:` or git's `ext::`
//     transports, which run commands. A URL or host that starts with `-` is
//     refused, because git would read it as an option. gh's login does not apply
//     there; git's own credentials do.
//   * **The destination is a parent directory and a folder name.** Not one joined
//     path, for /api/fs/mkdir's reason: a separate name can be refused outright
//     for containing a separator, rather than sanitised and hoped about. Both
//     are inside the allowed roots, the folder is new or empty, and the parent
//     is not inside another repository's working tree unless the caller said so
//     with `allowNested`. A clone into a subfolder of a checkout is occasionally
//     deliberate (vendoring, a scratch repo) and usually a mistake, so it is a
//     question the UI asks rather than a thing the bridge decides.
//   * **Every step is reported,** as in publish: `{step, ok, skipped?, detail}`.
//     A refusal decided before a command runs is a `Refusal` (the same class
//     github.js throws); past that the answer is always `{ok, ...steps}`.
//   * **No prompt can reach a terminal.** The same `GIT_TERMINAL_PROMPT=0` and
//     `GH_PROMPT_DISABLED=1` as publish.
//
// A project is only the set of directories sessions have run in, so there is
// nothing to register: starting a session in the new folder is what makes it one.

const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('./config');
const git = require('./git');
const pulls = require('./pulls');
const github = require('./github');
const { cached } = require('./memo');

const { run, ghError } = pulls;
const { Refusal, QUIET_ENV, ghJson } = github;

const CLONE_TIMEOUT_MS = 10 * 60_000;
const VIEW_TIMEOUT_MS = 30_000;
const REPOS_TTL_MS = 5 * 60_000;
const PAGE_SIZE = 100;
// A page is 100 repos, so this reaches 3000. A search past that says it was
// cut short rather than quietly missing the repository.
const MAX_PAGES = 30;

const cache = { pages: new Map() };

// ---------------------------------------------------------------------------
// Reading a reference
// ---------------------------------------------------------------------------

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/+@-]+$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

/** Why a branch name cannot be passed to git, or null. */
function branchProblem(b) {
    if (!b) return null;
    if (b.length > 250 || !BRANCH_RE.test(b)) return `"${b}" is not a branch name`;
    if (b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.lock')
        || b.includes('..') || b.includes('//') || b.includes('@{')) return `"${b}" is not a branch name`;
    return null;
}

function githubRef(owner, repo, branch) {
    const name = String(repo || '').replace(/\.git$/i, '');
    if (!OWNER_RE.test(owner || '')) return { error: `"${owner}" is not a GitHub user or organisation name` };
    if (!REPO_RE.test(name) || name === '.' || name === '..') return { error: `"${repo}" is not a repository name` };
    const bad = branchProblem(branch);
    if (bad) return { error: bad };
    return { kind: 'github', owner, repo: name, fullName: `${owner}/${name}`, branch: branch || null, name };
}

/**
 * Turn whatever was typed into `{kind: 'github', owner, repo, fullName, branch,
 * name}` or `{kind: 'other', url, host, name, branch}`, or `{error}`.
 *
 * `branch` comes from a `/tree/<branch>` suffix and is everything after `tree/`,
 * so `feature/x` survives. A URL like `/tree/main/src` therefore reads as the
 * branch `main/src`; resolve() shortens it until a branch of that name exists.
 */
function parseRepoInput(input) {
    let s = String(input == null ? '' : input).trim();
    if (!s) return { error: 'enter a repository, like owner/repo or a GitHub URL' };
    if (/[\0\s]/.test(s)) return { error: 'a repository reference has no spaces in it' };
    if (s.startsWith('-')) return { error: 'that is not a repository' };

    // A backslash is never part of a reference. Mapped before anything else so
    // `owner\repo` and `https:\\github.com\o\r` are read as what was meant.
    s = s.replace(/\\/g, '/');

    // scp-style: git@host:owner/repo(.git)
    let m = /^[A-Za-z0-9._-]+@([^:/]+):(?!\/)(.+)$/.exec(s);
    if (m) return fromHostPath(m[1], m[2], s, 'ssh');

    // scheme://[user@]host[:port]/path
    m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:([^@/]*)@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(s);
    if (m) {
        const scheme = m[1].toLowerCase();
        if (!['https', 'ssh', 'http', 'git'].includes(scheme)) {
            return { error: `${m[1]}:// repositories are not supported — use https or ssh` };
        }
        // A user name is passed to ssh as part of `user@host`, so one that starts
        // with "-" would be read as an ssh option.
        if (m[2] && !/^[A-Za-z0-9._~%:-]+$/.test(m[2])) return { error: 'that user name is not allowed in a URL' };
        if (m[2] && m[2].startsWith('-')) return { error: 'that user name is not allowed in a URL' };
        // Cleartext transports are fine for reading github.com's own pages
        // (the clone goes through gh, over its own protocol), not for other hosts.
        if ((scheme === 'http' || scheme === 'git') && !GITHUB_HOSTS.has(m[3].toLowerCase())) {
            return { error: 'use an https:// or ssh URL' };
        }
        return fromHostPath(m[3], m[4], s, scheme);
    }
    // `file:/x`, `C:/x/y`, `ext::cmd`: a scheme without the slashes of a URL.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) {
        return { error: 'that is not a repository reference — use owner/repo, or an https or ssh URL' };
    }
    if (s.startsWith('.') || s.startsWith('/') || s.startsWith('~')) {
        return { error: 'a local path is not a repository — use owner/repo, or an https or ssh URL' };
    }

    // github.com/owner/repo with no scheme.
    m = /^((?:www\.)?github\.com)\/(.+)$/i.exec(s);
    if (m) return fromHostPath(m[1], m[2], s, 'https');

    // owner/repo
    const parts = s.split('/').filter(Boolean);
    if (parts.length === 2) return githubRef(parts[0], parts[1], null);
    if (parts.length > 2) return { error: 'expected owner/repo, or a full URL — "a/b/c" is neither' };
    return { error: 'expected owner/repo or a GitHub URL' };
}

function fromHostPath(hostRaw, pathRaw, original, scheme) {
    const host = hostRaw.toLowerCase();
    if (!HOST_RE.test(host)) return { error: `"${hostRaw}" is not a host name` };
    const segs = pathRaw.replace(/[?#].*$/, '').split('/').filter(Boolean);

    if (GITHUB_HOSTS.has(host)) {
        if (segs.length < 2) return { error: 'a GitHub URL needs both an owner and a repository' };
        // Past owner/repo only `tree/<branch>` means anything to a clone. Any other
        // page of the repository (a PR, a file, the releases) still names it.
        let branch = null;
        if (segs[2] === 'tree' && segs.length > 3) branch = segs.slice(3).map(decodeURIComponentSafe).join('/');
        return githubRef(segs[0], segs[1], branch);
    }

    // Another host: a plain git clone. https or ssh only, and the URL is rebuilt
    // from the parts that were validated rather than passed through.
    if (segs.length < 2) return { error: `"${original}" does not name a repository` };
    if (segs.some(p => p === '..' || p === '.' || p.startsWith('-'))) return { error: `"${original}" is not a repository URL` };
    const repoSeg = segs[segs.length - 1].replace(/\.git$/i, '');
    if (!REPO_RE.test(repoSeg)) return { error: `"${repoSeg}" is not a repository name` };
    const slug = segs.join('/');
    const url = original.replace(/\\/g, '/');
    if (/^[^:/]+@[^:/]+:/.test(url) || /^(https|ssh):\/\//i.test(url)) {
        return { kind: 'other', url, host, name: repoSeg, fullName: `${host}/${slug.replace(/\.git$/i, '')}`, branch: null };
    }
    return { error: 'use an https:// or ssh URL for a repository outside GitHub' };
}

function decodeURIComponentSafe(s) {
    try { return decodeURIComponent(s); } catch { return s; }
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/** argv for `gh repo clone`: everything after `--` goes to `git clone`. */
function cloneArgs({ fullName, dir, branch }) {
    const args = ['repo', 'clone', fullName, dir];
    if (branch) args.push('--', '--branch', branch);
    return args;
}

/** argv for a plain `git clone` from another host. */
function gitCloneArgs({ url, dir, branch }) {
    return ['clone', ...(branch ? ['--branch', branch] : []), '--', url, dir];
}

/** argv for `gh repo view`. */
function viewArgs(fullName) {
    return ['repo', 'view', fullName, '--json',
        'nameWithOwner,description,visibility,isPrivate,isFork,isArchived,isEmpty,url,defaultBranchRef,viewerPermission,diskUsage'];
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

/** gh's complaint turned into the reason the dialog shows. */
function viewProblem(fullName, r) {
    const err = String(r.stderr || '');
    if (r.code === 'ENOENT') return { reason: 'no-gh', error: 'The gh CLI is not installed on this machine.' };
    if (/Could not resolve to a Repository|HTTP 404|Not Found/i.test(err)) {
        return { reason: 'not-found', error: `${fullName} was not found, or this GitHub account cannot see it.` };
    }
    if (/auth login|not logged in|HTTP 401|Bad credentials|authentication/i.test(err)) {
        return { reason: 'auth', error: 'gh is not logged in — run `gh auth login`.' };
    }
    if (/SAML|SSO/i.test(err)) return { reason: 'access', error: `${fullName} needs SSO authorisation for this token.` };
    if (/HTTP 403|forbidden/i.test(err)) return { reason: 'access', error: `This account has no access to ${fullName}.` };
    return { reason: 'error', error: ghError(r) };
}

/**
 * Is this branch on the repository? `gh api` answers with the branch name, or a
 * 404. `null` means GitHub could not be asked, which is not a "no".
 */
async function branchExists(fullName, branch) {
    const r = await run('gh', ['api', `repos/${fullName}/branches/${branch.split('/').map(encodeURIComponent).join('/')}`,
        '--jq', '.name'], { env: QUIET_ENV(), timeout: VIEW_TIMEOUT_MS });
    if (r.ok) return true;
    if (/HTTP 404|Not Found|Branch not found/i.test(r.stderr)) return false;
    return null;
}

/**
 * Parse `input` and ask the host about it.
 *
 * Resolves with `{ok: true, kind, fullName, name, branch, url, private, visibility,
 * description, defaultBranch, archived, empty, fork, permission, sizeKb}` or
 * `{ok: false, reason, error}`. Never throws for an unknown repository: that is
 * an answer, and the dialog shows it under the box.
 */
async function resolve(input, { branch: wanted } = {}) {
    const ref = parseRepoInput(input);
    if (ref.error) return { ok: false, reason: 'invalid', error: ref.error };
    let branch = ref.branch;
    if (wanted != null && String(wanted).trim()) branch = String(wanted).trim();
    const bad = branchProblem(branch);
    if (bad) return { ok: false, reason: 'invalid', error: bad };

    if (ref.kind === 'other') {
        const r = await run('git', ['ls-remote', '--heads', '--', ref.url], {
            env: { ...QUIET_ENV(), GIT_ALLOW_PROTOCOL: 'https:ssh' }, timeout: VIEW_TIMEOUT_MS,
        });
        if (!r.ok) return { ok: false, reason: 'not-found', error: `Could not reach ${ref.url}: ${git.firstLine(r.stderr) || 'git ls-remote failed'}` };
        const heads = r.stdout.split('\n').map(l => /refs\/heads\/(.+)$/.exec(l)).filter(Boolean).map(m => m[1]);
        if (branch && heads.length && !heads.includes(branch)) {
            return { ok: false, reason: 'no-branch', error: `${ref.fullName} has no branch called ${branch}.` };
        }
        return {
            ok: true, kind: 'other', fullName: ref.fullName, name: ref.name, branch: branch || null, url: ref.url,
            private: null, visibility: null, description: null, defaultBranch: null, archived: false,
            empty: r.stdout.trim() === '', fork: false, permission: null, sizeKb: null,
        };
    }

    const v = await ghJson(viewArgs(ref.fullName), { timeout: VIEW_TIMEOUT_MS });
    if (!v.ok) return { ok: false, ...viewProblem(ref.fullName, v.r) };
    const info = v.value;
    const out = {
        ok: true, kind: 'github',
        // GitHub's own capitalisation, so `OWNER/REPO` typed in lower case clones into the right name.
        fullName: info.nameWithOwner || ref.fullName,
        name: String(info.nameWithOwner || ref.fullName).split('/')[1] || ref.name,
        branch: branch || null,
        url: info.url || `https://github.com/${ref.fullName}`,
        private: !!info.isPrivate,
        visibility: String(info.visibility || (info.isPrivate ? 'PRIVATE' : 'PUBLIC')).toLowerCase(),
        description: info.description || null,
        defaultBranch: info.defaultBranchRef ? info.defaultBranchRef.name : null,
        archived: !!info.isArchived, empty: !!info.isEmpty, fork: !!info.isFork,
        permission: info.viewerPermission || null,
        sizeKb: Number.isFinite(info.diskUsage) ? info.diskUsage : null,
    };

    if (branch) {
        let ok = await branchExists(out.fullName, branch);
        // A `/tree/main/src/lib` URL: shorten from the right until a branch exists.
        if (ok === false && branch.includes('/') && ref.branch === branch) {
            const parts = branch.split('/');
            for (let n = parts.length - 1; n >= 1 && ok === false; n--) {
                const cand = parts.slice(0, n).join('/');
                if (await branchExists(out.fullName, cand)) { out.branch = cand; ok = true; }
            }
        }
        if (ok === false) return { ok: false, reason: 'no-branch', error: `${out.fullName} has no branch called ${branch}.` };
    }
    return out;
}

// ---------------------------------------------------------------------------
// The account's repositories
// ---------------------------------------------------------------------------

function pageOf(n) {
    // affiliation is spelt out although it is the default: it is the answer to
    // "including orgs it belongs to, and private ones".
    return ['api', `user/repos?per_page=${PAGE_SIZE}&page=${n}&sort=pushed&direction=desc`
        + '&affiliation=owner,collaborator,organization_member'];
}

function shape(r) {
    return {
        fullName: r.full_name, owner: r.owner && r.owner.login, name: r.name,
        description: r.description || null,
        visibility: r.visibility || (r.private ? 'private' : 'public'),
        private: !!r.private, fork: !!r.fork, archived: !!r.archived,
        pushedAt: r.pushed_at || r.updated_at || null,
        updatedAt: r.updated_at || null,
        defaultBranch: r.default_branch || null,
        language: r.language || null,
    };
}

/** One page of the account's repositories, newest push first. Cached per account. */
async function repoPage(login, n) {
    return cached(cache.pages, `${login}:${n}`, REPOS_TTL_MS, async () => {
        const r = await ghJson(pageOf(n), { timeout: 60_000 });
        if (!r.ok) throw Object.assign(new Error(ghError(r.r)), { gh: true });
        return { repos: r.value.map(shape), last: r.value.length < PAGE_SIZE };
    });
}

/** Every term appears in the name or the description, in any order. */
function matchesRepo(repo, query) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const hay = `${repo.fullName}\n${repo.description || ''}`.toLowerCase();
    return terms.every(t => hay.includes(t));
}

/**
 * A slice of the account's repositories.
 *
 * Without a query only as many GitHub pages are fetched as the slice reaches
 * into, so a first open of a large account is one request. With a query every
 * page has to be read, because the match could be anywhere; those pages are
 * memoised, so typing more is not another round of requests. `more` is whether
 * a further slice exists, and `truncated` is true when a search stopped at
 * MAX_PAGES without reaching the end.
 */
async function repos({ q = '', offset = 0, limit = 50, refresh = false } = {}) {
    const who = await github.account({ refresh });
    if (!who.authed) {
        return { repos: [], more: false, truncated: false, authed: false, installed: who.installed, error: who.error };
    }
    if (refresh) for (const k of [...cache.pages.keys()]) if (k.startsWith(`${who.login}:`)) cache.pages.delete(k);
    offset = Math.max(0, Number(offset) || 0);
    limit = Math.min(100, Math.max(1, Number(limit) || 50));
    const searching = String(q || '').trim() !== '';

    const loaded = [];
    let done = false;
    let truncated = false;
    try {
        for (let n = 1; n <= MAX_PAGES; n++) {
            const page = await repoPage(who.login, n);
            loaded.push(...page.repos);
            if (page.last) { done = true; break; }
            if (!searching && loaded.length >= offset + limit + 1) break;
            if (n === MAX_PAGES) truncated = true;
        }
    } catch (err) {
        return { repos: [], more: false, truncated: false, authed: true, installed: true, error: err.message };
    }
    const hits = searching ? loaded.filter(r => matchesRepo(r, q)) : loaded;
    const slice = hits.slice(offset, offset + limit);
    return {
        repos: slice,
        more: offset + limit < hits.length || (!searching && !done),
        truncated: searching && truncated,
        authed: true, installed: true, error: null,
    };
}

// ---------------------------------------------------------------------------
// The destination
// ---------------------------------------------------------------------------

/** Folder names that exist on every platform this app runs on. */
function folderProblem(name) {
    if (!name) return 'a folder name is required';
    if (name === '.' || name === '..') return `"${name}" is not a name`;
    if (/[\\/]/.test(name)) return 'a folder name cannot contain a slash — pick the parent directory separately';
    if (name.includes('\0')) return 'that name contains a null byte';
    if (name.startsWith('-')) return 'a folder name cannot start with "-"';
    if (name.startsWith('.')) return 'names starting with "." are hidden, and the picker would not show it';
    if (/[<>:"|?*]/.test(name)) return 'a folder name cannot contain < > : " | ? *';
    if (Buffer.byteLength(name) > 255) return 'that name is too long';
    return null;
}

/**
 * Where "the usual projects folder" is: the first of a few conventional
 * names that exists under the home directory, else the home directory.
 * Both are inside the default allowed roots; if the roots are narrower the
 * first one that is inside them wins, and `null` means none is.
 */
function defaultParent() {
    const home = cfg.HOME || os.homedir();
    const names = ['Projects', 'projects', 'Code', 'code', 'dev', 'src', 'repos', 'Repos', 'workspace'];
    const found = names.map(n => path.join(home, n)).filter(p => {
        try { return fs.statSync(p).isDirectory(); } catch { return false; }
    });
    for (const c of [...found, home, ...cfg.ALLOWED_ROOTS]) if (cfg.withinRoots(c)) return c;
    return null;
}

function isEmptyDir(p) {
    try { return fs.readdirSync(p).length === 0; } catch { return false; }
}

/** The root of the working tree `dir` is inside, or null. `dir` must exist. */
async function enclosingRepo(dir) {
    const top = await git.run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
    return top.ok ? top.stdout.trim() : null;
}

/**
 * Check a destination without touching it.
 *
 * Resolves with `{parent, name, path, problem, status, nested, exists}`, where
 * `problem` is the sentence to show (null when the clone may go ahead) and
 * `status` is the HTTP status the POST uses for it. `nested` is the root of the
 * repository the parent is inside, set even when `allowNested` lets it through,
 * so a dialog can ask the question before the user presses Clone.
 */
async function checkDestination({ parent, name, allowNested = false }) {
    const out = { parent: null, name: String(name == null ? '' : name).trim(), path: null,
        problem: null, status: 400, nested: null, exists: false };
    const rawParent = String(parent == null ? '' : parent).trim();
    if (!rawParent) return { ...out, problem: 'choose the folder to clone into' };
    const p = path.resolve(cfg.expandHome(rawParent));
    out.parent = p;
    if (!cfg.withinRoots(p)) return { ...out, status: 403, problem: 'that directory is outside the allowed roots' };

    const bad = folderProblem(out.name);
    if (bad) return { ...out, problem: bad };
    const target = path.join(p, out.name);
    out.path = target;
    if (!cfg.withinRoots(target)) return { ...out, status: 403, problem: 'that directory is outside the allowed roots' };

    let st = null;
    try { st = fs.statSync(p); } catch { /* reported below */ }
    if (!st || !st.isDirectory()) return { ...out, problem: `${p} is not a directory — create it first` };

    // The resolved parent too: a symlink inside the roots must not lead out of them.
    const real = cfg.realResolve(p);
    if (!real || !cfg.withinRoots(real)) {
        return { ...out, status: 403, problem: 'that directory is outside the allowed roots' };
    }

    try {
        const t = fs.lstatSync(target);
        out.exists = true;
        if (!t.isDirectory()) return { ...out, status: 409, problem: `${target} already exists and is not a folder` };
        if (!isEmptyDir(target)) return { ...out, status: 409, problem: `${target} already exists and is not empty` };
    } catch (err) {
        if (err.code !== 'ENOENT') return { ...out, problem: err.message };
    }

    out.nested = await enclosingRepo(p);
    if (out.nested && !allowNested) {
        return { ...out, status: 409,
            problem: `${p} is inside the repository at ${out.nested}. Pick a folder outside it, or confirm that you want the clone nested there.` };
    }
    return out;
}

// ---------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------

/** One clone per destination at a time. A double click must not run git twice. */
const inFlight = new Set();

function normalise(b) {
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    return {
        input: str(b.repo) || str(b.input),
        parent: str(b.parent),
        name: str(b.name),
        branch: str(b.branch),
        allowNested: b.allowNested === true,
    };
}

/**
 * Clone a repository into `parent/name`.
 *
 * Throws a `Refusal` for anything decided before a command runs (400 a bad
 * reference or folder, 403 outside the roots, 404 a repository that is not there
 * or not visible, 409 a folder that is taken, a nested clone, or one already
 * running). After that it resolves with `{ok, path, fullName, url, branch,
 * steps}`; the steps stop at the first failure.
 */
async function clone(body = {}) {
    const o = normalise(body);
    const ref = parseRepoInput(o.input);
    if (ref.error) throw new Refusal(400, ref.error);
    if (!o.name) o.name = ref.name;

    const dest = await checkDestination(o);
    if (dest.problem) throw new Refusal(dest.status, dest.problem);

    if (ref.kind === 'github') {
        const who = await github.account();
        if (!who.authed) throw new Refusal(400, who.error || 'gh is not logged in — run `gh auth login`');
    }
    const info = await resolve(o.input, { branch: o.branch });
    if (!info.ok) throw new Refusal(info.reason === 'not-found' || info.reason === 'no-branch' ? 404 : 400, info.error);

    const key = dest.path;
    if (inFlight.has(key)) throw new Refusal(409, `${key} is already being cloned into`);
    inFlight.add(key);
    try {
        return await runSteps(info, dest);
    } finally {
        inFlight.delete(key);
        git.clearCache(dest.path);
        pulls.forgetRepo(dest.path);
    }
}

async function runSteps(info, dest) {
    const steps = [];
    const out = (ok, extra = {}) => ({ ok, fullName: info.fullName, url: info.url, path: dest.path, steps, ...extra });
    const branch = info.branch || null;

    const bits = [info.fullName];
    if (info.visibility) bits.push(info.visibility);
    if (info.defaultBranch) bits.push(`default branch ${info.defaultBranch}`);
    steps.push({ step: 'find repository', ok: true, detail: bits.join(' · ') });
    if (info.archived) steps.push({ step: 'note', ok: true, skipped: true, detail: 'the repository is archived (read-only on GitHub)' });

    const existed = dest.exists;
    const common = { cwd: dest.parent, timeout: CLONE_TIMEOUT_MS };
    const r = info.kind === 'other'
        ? await run('git', gitCloneArgs({ url: info.url, dir: dest.path, branch }),
            { ...common, env: { ...QUIET_ENV(), GIT_ALLOW_PROTOCOL: 'https:ssh' } })
        : await run('gh', cloneArgs({ fullName: info.fullName, dir: dest.path, branch }),
            { ...common, env: QUIET_ENV() });
    if (!r.ok) {
        steps.push({ step: 'clone', ok: false, detail: git.firstLine(r.stderr.replace(/^.*(?:error|fatal):\s*/im, '')) || ghError(r) });
        // git removes a folder it created when a clone fails. A folder that was
        // already there (empty) is left as it was.
        if (!existed) { try { fs.rmdirSync(dest.path); } catch { /* git cleaned up, or it is not empty */ } }
        return out(false, { url: info.url });
    }
    steps.push({ step: 'clone', ok: true, detail: dest.path });

    const head = await git.run('git', ['-C', dest.path, 'branch', '--show-current']);
    const current = head.ok ? head.stdout.trim() : '';
    steps.push(branch
        ? { step: 'check out', ok: true, detail: current || branch }
        : { step: 'check out', ok: true, detail: current || 'no commits yet (the repository is empty)' });
    return out(true, { branch: current || null, empty: !current });
}

module.exports = {
    parseRepoInput, branchProblem, cloneArgs, gitCloneArgs, viewArgs,
    resolve, repos, matchesRepo, folderProblem, defaultParent, checkDestination, clone,
};
