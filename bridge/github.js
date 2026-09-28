'use strict';

// Turning a directory into a GitHub repository: `git init`, a first commit, and
// `gh repo create --source --push`, with the choices `gh repo create` and
// `gh repo edit` allow in between.
//
// It is the account-and-repository half of gh, and bridge/pulls.js stays the
// pull-request half. This file uses `run` and `ghError` from pulls.js rather
// than keeping a copy of them. The rule pulls.js's header gives is *one runner
// per external tool*, and a second file with its own ENOENT special case is what
// that rule is there to prevent.
//
// Decided here, and worth knowing before changing any of it:
//
//   * **Starter files are written locally, not by GitHub.** `gh repo create
//     --gitignore/--license/--add-readme` makes a commit on the *remote*, and
//     the directory being published already has history (or is about to have
//     some) that does not include it. Reconciling the two is a merge, which is
//     not a step a dialog can take on someone's behalf. So the templates are
//     fetched from the same API and written into the directory before the first
//     commit, and a file that already exists is never overwritten.
//   * **`--template` is left out.** gh refuses it together with `--source`, and
//     creating a repository from a template is a clone, not a publish.
//   * **Every step is reported, including the ones after a failure.** Once the
//     repository exists on GitHub, a push that fails does not un-create it, so
//     the answer carries the `url` of what now exists together with the step that
//     failed. A client that saw only "error" would invite a retry, and the retry
//     would stop at "already exists".
//   * **No prompt can reach a terminal.** `GIT_TERMINAL_PROMPT=0` and
//     `GH_PROMPT_DISABLED=1` go on every command, as in bridge/restart.js. A push
//     that wants a password should fail and say so. It should not wait forever
//     on a tty that belongs to nobody.
//   * **A directory inside another repository is refused.** `git init` there
//     would make a nested repository, which the outer one then sees as an
//     untracked folder. That is almost never what someone who opened a
//     subfolder meant, and the right action is to publish the outer one.

const fs = require('fs');
const path = require('path');

const git = require('./git');
const pulls = require('./pulls');
const { cached } = require('./memo');

const { run, ghError } = pulls;

const ACCOUNT_TTL_MS = 5 * 60_000;
const TEMPLATES_TTL_MS = 24 * 60 * 60_000;
const TEAMS_TTL_MS = 10 * 60_000;
const PUSH_TIMEOUT_MS = 120_000;

const QUIET_ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' });

const cache = {
    account: new Map(),
    templates: new Map(),
    teams: new Map(),
};

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

/** Why GitHub would refuse this repository name, or null if it would not. */
function repoNameProblem(name) {
    const n = String(name ?? '');
    if (!n) return 'a name is required';
    if (n === '.' || n === '..') return `"${n}" is not a name`;
    if (n.length > 100) return 'a repository name is at most 100 characters';
    if (!/^[A-Za-z0-9._-]+$/.test(n)) return 'use only letters, digits, ".", "-" and "_"';
    if (/\.git$/i.test(n)) return 'a name cannot end in ".git"';
    return null;
}

/**
 * A folder name turned into one GitHub will accept. GitHub makes the same
 * substitution itself, so the name the dialog suggests is the one the site would
 * have picked.
 */
function suggestName(basename) {
    return String(basename || '')
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/\.git$/i, '')
        .slice(0, 100);
}

const VISIBILITIES = ['private', 'public', 'internal'];

/** argv for `gh repo create`, from options already validated. */
function createArgs({ owner, name, visibility = 'private', cwd, remote = 'origin', push = false,
    description, homepage, team, disableIssues, disableWiki }) {
    const args = ['repo', 'create', `${owner}/${name}`, `--${visibility}`,
        '--source', cwd, '--remote', remote];
    if (push) args.push('--push');
    if (description) args.push('--description', description);
    if (homepage) args.push('--homepage', homepage);
    if (team) args.push('--team', team);
    if (disableIssues) args.push('--disable-issues');
    if (disableWiki) args.push('--disable-wiki');
    return args;
}

// The settings `gh repo edit` can change that `gh repo create` cannot. Each one
// is a flag to pass when the value differs from what GitHub gives a new
// repository, so an untouched dialog means no edit call at all.
const EDIT_BOOLS = [
    // [field, flag, GitHub's default for a new repository]
    ['mergeCommit', '--enable-merge-commit', true],
    ['squashMerge', '--enable-squash-merge', true],
    ['rebaseMerge', '--enable-rebase-merge', true],
    ['autoMerge', '--enable-auto-merge', false],
    ['deleteBranchOnMerge', '--delete-branch-on-merge', false],
    ['allowUpdateBranch', '--allow-update-branch', false],
    ['discussions', '--enable-discussions', false],
    ['projects', '--enable-projects', true],
    ['template', '--template', false],
];
const SQUASH_MESSAGES = ['default', 'pr-title', 'pr-title-commits', 'pr-title-description'];

/**
 * argv for `gh repo edit`, or null when nothing differs from GitHub's defaults.
 * gh's boolean flags take `=false` to switch something off.
 */
function editArgs(fullName, settings = {}) {
    const args = [];
    for (const [field, flag, dflt] of EDIT_BOOLS) {
        if (typeof settings[field] !== 'boolean' || settings[field] === dflt) continue;
        args.push(settings[field] ? flag : `${flag}=false`);
    }
    const msg = settings.squashMessage;
    if (msg && msg !== 'default' && SQUASH_MESSAGES.includes(msg)) {
        args.push('--squash-merge-commit-message', msg);
    }
    for (const t of topicsOf(settings.topics)) args.push('--add-topic', t);
    return args.length ? ['repo', 'edit', fullName, ...args] : null;
}

/**
 * Topics as GitHub accepts them: lowercase, letters, digits and hyphens, not
 * starting with a hyphen, at most 50 characters, and at most 20 of them.
 */
function topicsOf(input) {
    const list = Array.isArray(input) ? input : String(input || '').split(',');
    const out = [];
    for (const raw of list) {
        const t = String(raw).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
        if (t && t.length <= 50 && !out.includes(t)) out.push(t);
    }
    return out.slice(0, 20);
}

/** GitHub's license text, with the placeholders a person would otherwise edit by hand. */
function fillLicense(body, { year, fullname }) {
    return String(body || '')
        .replace(/\[year\]|\[yyyy\]|<year>/g, String(year))
        .replace(/\[fullname\]|\[name of copyright owner\]|<name of author>/g, fullname);
}

// ---------------------------------------------------------------------------
// Asking GitHub
// ---------------------------------------------------------------------------

async function ghJson(args, opts) {
    const r = await run('gh', args, { env: QUIET_ENV(), ...opts });
    if (!r.ok) return { ok: false, r };
    try { return { ok: true, value: JSON.parse(r.stdout) }; } catch {
        return { ok: false, r: { ...r, stderr: 'gh returned something that is not JSON' } };
    }
}

/**
 * Who gh is logged in as, and the organisations that account can create
 * repositories in. `authed: false` covers both a missing login and an expired
 * one. What the dialog does in either case is tell you to run `gh auth login`.
 */
function account({ refresh = false } = {}) {
    if (refresh) cache.account.clear();
    return cached(cache.account, 'me', ACCOUNT_TTL_MS, async () => {
        const me = await ghJson(['api', 'user']);
        if (!me.ok) {
            const installed = me.r.code !== 'ENOENT';
            return { installed, authed: false, login: null, name: null, orgs: [], error: ghError(me.r) };
        }
        // `user/orgs` needs `read:org`. A token without that scope still has an
        // account, and the dialog can offer personal repositories and nothing
        // else. That is better than no dialog.
        const orgs = await ghJson(['api', 'user/orgs', '--paginate']);
        return {
            installed: true, authed: true,
            login: me.value.login, name: me.value.name || null,
            orgs: orgs.ok ? orgs.value.map(o => o.login).filter(Boolean) : [],
            error: orgs.ok ? null : `could not list organisations: ${ghError(orgs.r)}`,
        };
    });
}

/** The `.gitignore` templates and licenses GitHub offers. */
function templates() {
    return cached(cache.templates, 'all', TEMPLATES_TTL_MS, async () => {
        const [gi, lic] = await Promise.all([
            ghJson(['api', 'gitignore/templates']),
            ghJson(['api', 'licenses']),
        ]);
        return {
            gitignore: gi.ok ? gi.value : [],
            licenses: lic.ok ? lic.value.map(l => ({ key: l.key, name: l.name })) : [],
            error: gi.ok && lic.ok ? null : ghError((gi.ok ? lic : gi).r),
        };
    });
}

/** The slugs of an organisation's teams you can see. An empty list is an answer. */
function teams(org) {
    return cached(cache.teams, org, TEAMS_TTL_MS, async () => {
        const r = await ghJson(['api', `orgs/${org}/teams`, '--paginate']);
        return r.ok ? r.value.map(t => t.slug).filter(Boolean) : [];
    });
}

/** Is `owner/name` taken? `null` when GitHub could not be asked. */
async function nameTaken(owner, name) {
    const r = await run('gh', ['api', `repos/${owner}/${name}`, '--jq', '.full_name'], { env: QUIET_ENV() });
    if (r.ok) return true;
    if (/HTTP 404|Not Found/i.test(r.stderr)) return false;
    return null;
}

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

/**
 * What the directory is now, which decides which steps a publish will take.
 * Not cached. The dialog asks once when it opens, and the answer has to be
 * current, because a commit made a moment ago changes it.
 */
async function repoState(cwd) {
    const suggestedName = suggestName(path.basename(cwd));
    const base = {
        cwd, suggestedName, isGit: false, insideOther: null, hasCommits: false,
        branch: null, uncommitted: 0, remotes: [], github: null,
        existing: existingFiles(cwd),
    };
    const top = await git.run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    if (!top.ok) return base;
    const root = top.stdout.trim();
    if (!git.samePath(root, cwd)) return { ...base, insideOther: root };

    const [head, st, rem] = await Promise.all([
        git.run('git', ['-C', cwd, 'rev-parse', '--verify', '-q', 'HEAD']),
        git.run('git', ['-C', cwd, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal']),
        git.run('git', ['-C', cwd, 'remote', '-v']),
    ]);
    const status = st.ok ? git.parseStatus(st.stdout) : null;
    const remotes = parseRemotes(rem.stdout);
    const origin = remotes.find(r => r.name === 'origin');
    return {
        ...base,
        isGit: true,
        hasCommits: head.ok,
        branch: status ? status.branch : null,
        uncommitted: status ? status.files : 0,
        remotes,
        github: origin ? pulls.githubRepo(origin.url) : null,
    };
}

/** `git remote -v` as one entry per remote, using its fetch URL. */
function parseRemotes(text) {
    const out = [];
    for (const line of String(text || '').split('\n')) {
        const m = /^(\S+)\t(\S+) \(fetch\)$/.exec(line.trim());
        if (m) out.push({ name: m[1], url: m[2] });
    }
    return out;
}

const STARTERS = { gitignore: '.gitignore', license: 'LICENSE', readme: 'README.md' };

/** Which starter files are already there. The dialog labels those "kept". */
function existingFiles(cwd) {
    const out = {};
    for (const [k, file] of Object.entries(STARTERS)) out[k] = fs.existsSync(path.join(cwd, file));
    // A licence is often LICENSE.md or LICENCE. Any of them means one exists.
    if (!out.license) {
        try {
            out.license = fs.readdirSync(cwd).some(f => /^licen[cs]e(\.|$)/i.test(f));
        } catch { /* an unreadable directory has nothing to keep */ }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/** One publish per directory at a time. A double click must not make two repos. */
const inFlight = new Set();

class Refusal extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

/**
 * Publish `cwd` to GitHub.
 *
 * Throws a `Refusal` (400/409) for anything decided before a command runs.
 * Past that point it always resolves with `{ok, url, fullName, steps}`, where
 * each step is `{step, ok, skipped?, detail}`. The steps run in order and stop at
 * the first that fails, except `settings`, whose failure is reported without
 * making the whole result a failure, because the repository exists by then.
 */
async function publish(cwd, opts = {}) {
    const o = normalise(opts);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Refusal(400, `${cwd} is not a directory`);

    const bad = repoNameProblem(o.name);
    if (bad) throw new Refusal(400, bad);
    if (!VISIBILITIES.includes(o.visibility)) throw new Refusal(400, `visibility must be one of ${VISIBILITIES.join(', ')}`);

    const who = await account();
    if (!who.authed) throw new Refusal(400, who.error || 'gh is not logged in — run `gh auth login`');
    const isOrg = who.orgs.includes(o.owner);
    if (o.owner !== who.login && !isOrg) {
        throw new Refusal(400, `${o.owner} is not your account or one of your organisations`);
    }
    if (o.visibility === 'internal' && !isOrg) throw new Refusal(400, 'internal visibility is only for organisation repositories');
    if (o.team && !isOrg) throw new Refusal(400, 'a team can only be given access to an organisation repository');
    if (o.branch && !/^[A-Za-z0-9._/-]+$/.test(o.branch)) throw new Refusal(400, 'that is not a branch name');

    const before = await repoState(cwd);
    if (before.insideOther) {
        throw new Refusal(409, `${cwd} is inside the repository at ${before.insideOther} — publish that instead`);
    }
    if (before.remotes.some(r => r.name === o.remote)) {
        throw new Refusal(409, `${cwd} already has a remote called "${o.remote}"`);
    }

    const key = fs.realpathSync(cwd);
    if (inFlight.has(key)) throw new Refusal(409, 'that directory is already being published');
    inFlight.add(key);
    try {
        return await runSteps(cwd, o, before, who);
    } finally {
        inFlight.delete(key);
        git.clearCache(cwd);
        pulls.forgetRepo(cwd);
    }
}

function normalise(b) {
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    return {
        owner: str(b.owner),
        name: str(b.name),
        visibility: str(b.visibility) || 'private',
        description: str(b.description).replace(/\s+/g, ' '),
        homepage: str(b.homepage),
        team: str(b.team),
        disableIssues: b.disableIssues === true,
        disableWiki: b.disableWiki === true,
        remote: str(b.remote) || 'origin',
        branch: str(b.branch) || 'main',
        gitignore: str(b.gitignore),
        license: str(b.license),
        readme: b.readme === true,
        commit: b.commit !== false,
        commitMessage: str(b.commitMessage) || 'Initial commit',
        push: b.push !== false,
        // Topics are set by `gh repo edit`, so they belong with the settings, but
        // they read as a field of the repository and are accepted beside the
        // name as well as inside `settings`.
        settings: {
            ...(b.settings && typeof b.settings === 'object' ? b.settings : {}),
            ...(b.topics != null ? { topics: b.topics } : {}),
        },
    };
}

async function runSteps(cwd, o, before, who) {
    const steps = [];
    const fullName = `${o.owner}/${o.name}`;
    const out = (ok, extra = {}) => ({ ok, fullName, url: extra.url ?? null, steps, ...extra });
    const env = QUIET_ENV();
    const g = (args, timeout) => git.run('git', ['-C', cwd, ...args], { env, timeout });

    // 1. Starter files: only those asked for, and never over one that exists.
    const starters = [];
    if (o.gitignore) starters.push(['gitignore', async () => {
        const r = await ghJson(['api', `gitignore/templates/${encodeURIComponent(o.gitignore)}`]);
        if (!r.ok) throw new Error(ghError(r.r));
        return r.value.source;
    }]);
    if (o.license) starters.push(['license', async () => {
        const r = await ghJson(['api', `licenses/${encodeURIComponent(o.license)}`]);
        if (!r.ok) throw new Error(ghError(r.r));
        return fillLicense(r.value.body, { year: new Date().getFullYear(), fullname: who.name || who.login });
    }]);
    if (o.readme) starters.push(['readme', async () =>
        `# ${o.name}\n${o.description ? `\n${o.description}\n` : ''}`]);

    for (const [kind, produce] of starters) {
        const file = STARTERS[kind];
        const step = `write ${file}`;
        if (before.existing[kind]) {
            steps.push({ step, ok: true, skipped: true, detail: 'already there, left as it was' });
            continue;
        }
        try {
            const text = await produce();
            // `wx` so a file that appeared since repoState is still not overwritten.
            fs.writeFileSync(path.join(cwd, file), text.endsWith('\n') ? text : `${text}\n`, { flag: 'wx' });
            steps.push({ step, ok: true, detail: kind === 'readme' ? null : (o[kind] || null) });
        } catch (err) {
            steps.push({ step, ok: false, detail: err.code === 'EEXIST' ? 'appeared while publishing' : err.message });
            return out(false);
        }
    }

    // 2. A repository to publish.
    if (!before.isGit) {
        const r = await g(['init', '-b', o.branch]);
        steps.push({ step: 'git init', ok: r.ok, detail: r.ok ? `on ${o.branch}` : git.firstLine(r.stderr) });
        if (!r.ok) return out(false);
    }

    // 3. The first commit, when asked for and when there is anything to put in it.
    if (o.commit) {
        const add = await g(['add', '-A'], 60_000);
        if (!add.ok) {
            steps.push({ step: 'commit', ok: false, detail: git.firstLine(add.stderr) });
            return out(false);
        }
        const staged = await g(['diff', '--cached', '--quiet']);
        if (staged.code === 0) {
            steps.push({ step: 'commit', ok: true, skipped: true, detail: 'nothing to commit' });
        } else {
            const c = await g(['commit', '-q', '-m', o.commitMessage], 60_000);
            steps.push({ step: 'commit', ok: c.ok, detail: c.ok ? o.commitMessage : git.firstLine(c.stderr) });
            if (!c.ok) return out(false);
        }
    }

    // 4. The repository itself. `--push` needs something to push.
    const hasHead = (await g(['rev-parse', '--verify', '-q', 'HEAD'])).ok;
    const push = o.push && hasHead;
    const created = await run('gh', createArgs({ ...o, cwd, push }), {
        cwd, env, timeout: push ? PUSH_TIMEOUT_MS : 30_000,
    });
    // gh prints the new repository's URL on stdout. If it does not, the
    // repository may exist anyway (a push failure comes after the create), so
    // the URL is inferred and the next step checks it.
    const url = (/https:\/\/\S+/.exec(created.stdout) || [])[0] || `https://github.com/${fullName}`;
    if (!created.ok) {
        const exists = await nameTaken(o.owner, o.name);
        steps.push({ step: 'create repository', ok: false, detail: ghError(created) });
        return out(false, { url: exists ? url : null });
    }
    steps.push({ step: 'create repository', ok: true, detail: `${o.visibility} · ${fullName}` });
    steps.push(push
        ? { step: 'push', ok: true, detail: `${o.remote}/${(await g(['branch', '--show-current'])).stdout.trim() || o.branch}` }
        : { step: 'push', ok: true, skipped: true, detail: hasHead ? 'not requested' : 'no commits yet' });

    // 5. Settings create cannot make.
    const edit = editArgs(fullName, o.settings);
    if (edit) {
        const r = await run('gh', edit, { cwd, env });
        steps.push({ step: 'settings', ok: r.ok, detail: r.ok ? null : ghError(r) });
    }

    return out(true, { url });
}

module.exports = {
    repoNameProblem, suggestName, createArgs, editArgs, topicsOf, fillLicense, parseRemotes,
    account, templates, teams, nameTaken, repoState, publish, Refusal,
    VISIBILITIES, SQUASH_MESSAGES,
};
