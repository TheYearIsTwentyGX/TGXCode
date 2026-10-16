// Publish to GitHub: the dialog that turns a directory into a repository.
//
// Opened from two places: the project ⋮ menu, for a project whose checkout has
// no origin, and Start-a-session, beside the directory box and after New folder.
// The work is bridge/github.js's. This file asks what the directory is and who
// gh is logged in as, draws the form those answers allow, and then reports each
// step the bridge took.
//
// The form's values live in `form`, and the body is rebuilt from it only when a
// change alters what is drawn: the owner (internal visibility and teams are for
// organisations only) and the commit box (Push depends on it). Typing in a text
// box writes `form` and redraws nothing, so a caret is never lost halfway
// through a word.

import { get, post } from '../api.js';
import { dom, closeModal, closeOnClickOutside, el, openModal, toast } from '../dom.js';

/** The open dialog, or null. */
let cur = null;

// The fields, with what an untouched dialog sends. `settings` holds the values
// `gh repo edit` sets after the create. Anything left at GitHub's own default is
// not passed at all — see editArgs in bridge/github.js.
function freshForm(st, who) {
    return {
        owner: who.login,
        name: st.suggestedName,
        description: '',
        homepage: '',
        topics: '',
        visibility: 'private',
        gitignore: '',
        license: '',
        readme: !st.existing.readme,
        branch: 'main',
        // A new folder, or a repository with no commits, gets its first commit
        // by default. A repository that already has history does not: sweeping
        // somebody's uncommitted work into a commit is theirs to decide.
        commit: !st.hasCommits,
        commitMessage: 'Initial commit',
        push: true,
        team: '',
        disableIssues: false,
        disableWiki: false,
        settings: {
            mergeCommit: true, squashMerge: true, rebaseMerge: true,
            autoMerge: false, deleteBranchOnMerge: false, allowUpdateBranch: false,
            discussions: false, projects: true, template: false,
            squashMessage: 'default',
        },
    };
}

export async function openPublish(cwd, { onDone } = {}) {
    cur = { cwd, onDone, st: null, who: null, tpl: null, teams: {}, form: null, busy: false, mode: 'wait' };
    const mine = cur;
    openModal(dom.ghScrim);
    dom.ghFootNote.textContent = '';
    setGo('Create repository', true);
    dom.ghBody.replaceChildren(el('div', { class: 'gh-wait' }, 'Asking GitHub…'));

    try {
        const q = encodeURIComponent(cwd);
        const [st, who, tpl] = await Promise.all([
            get(`/api/github/repo-state?cwd=${q}`),
            get('/api/github/account'),
            get('/api/github/templates').catch(() => ({ gitignore: [], licenses: [] })),
        ]);
        if (cur !== mine) return;
        Object.assign(cur, { st, who, tpl });
        if (who.authed) cur.form = freshForm(st, who);
        paint();
    } catch (err) {
        if (cur !== mine) return;
        dom.ghBody.replaceChildren(el('div', { class: 'gh-problem' }, `Could not ask the bridge: ${err.message}`));
    }
}

export function closePublish() {
    if (cur?.busy) return;   // the steps are running; closing would hide their answer
    cur = null;
    closeModal(dom.ghScrim);
}

export function wirePublish() {
    for (const n of dom.ghScrim.querySelectorAll('[data-close-gh]')) n.addEventListener('click', closePublish);
    closeOnClickOutside(dom.ghScrim, closePublish);
    // One listener, and what the button means is `cur.mode`: the same button is
    // Retry when gh is not logged in and Done once the steps have run.
    dom.ghGo.addEventListener('click', () => {
        if (!cur || cur.busy) return;
        if (cur.mode === 'result') closePublish();
        else if (cur.mode === 'retry') retry();
        else if (cur.mode === 'form') submit();
    });
}

function setGo(label, disabled) {
    dom.ghGo.textContent = label;
    dom.ghGo.disabled = !!disabled;
}

// ── drawing ─────────────────────────────────────────────────────────────

function paint() {
    const { st, who, form } = cur;

    if (!who.authed) {
        dom.ghBody.replaceChildren(
            el('div', { class: 'gh-problem' }, who.installed
                ? `gh is not logged in: ${who.error || 'no account'}`
                : 'The gh CLI is not installed on this machine.'),
            el('div', { class: 'field' }, el('div', { class: 'note' },
                who.installed ? 'Run ' : 'Install it from cli.github.com, then run ',
                el('code', {}, 'gh auth login'), ' in a terminal, then press Retry.')),
        );
        cur.mode = 'retry';
        setGo('Retry', false);
        return;
    }

    cur.mode = 'blocked';
    if (st.insideOther) {
        dom.ghBody.replaceChildren(el('div', { class: 'gh-problem' },
            'This folder is inside the repository at ', el('code', {}, st.insideOther),
            '. Publish that one instead. A repository of its own here would be nested inside it.'));
        setGo('Create repository', true);
        return;
    }
    if (st.remotes.some(r => r.name === 'origin')) {
        const url = st.remotes.find(r => r.name === 'origin').url;
        dom.ghBody.replaceChildren(el('div', { class: 'gh-problem' },
            'This repository already has an origin: ', el('code', {}, url)));
        setGo('Create repository', true);
        return;
    }

    const isOrg = form.owner !== who.login;
    if (!isOrg && form.visibility === 'internal') form.visibility = 'private';
    if (!isOrg) form.team = '';
    const canPush = st.hasCommits || form.commit;

    // A repaint happens under the reader — the teams arriving, the owner
    // changing — so it keeps their place: the scroll, and whether More settings
    // is open.
    const scroll = dom.ghBody.scrollTop;

    // Through el() rather than straight into replaceChildren, which would write
    // a skipped field's `null` onto the page as the word "null".
    dom.ghBody.replaceChildren(...el('div', {},
        el('div', { class: 'gh-status' }, statusLine(st)),

        el('div', { class: 'gh-row top' },
            el('div', { class: 'field gh-owner' },
                el('label', { for: 'gh-owner' }, 'Owner'),
                el('select', {
                    id: 'gh-owner', class: 'gh-select',
                    onchange: (e) => { form.owner = e.target.value; paint(); checkName(); },
                }, [who.login, ...who.orgs].map(o => el('option', { value: o, selected: o === form.owner }, o)))),
            el('span', { class: 'gh-slash' }, '/'),
            el('div', { class: 'field gh-name' },
                el('label', { for: 'gh-name' }, 'Repository name'),
                el('input', {
                    id: 'gh-name', type: 'text', spellcheck: 'false', value: form.name,
                    oninput: (e) => { form.name = e.target.value.trim(); checkName(); },
                }),
                el('div', { id: 'gh-name-note', class: 'note' }))),
        who.error ? el('div', { class: 'field' }, el('div', { class: 'note' }, `Only your own account is listed. ${who.error}`)) : null,

        text('Description', 'description', { prose: true }),

        el('div', { class: 'field' },
            el('label', {}, 'Visibility'),
            el('div', { class: 'gh-radios', role: 'radiogroup' },
                radio('private', 'Private', 'Only you and people you add'),
                radio('public', 'Public', 'Anyone on the internet can see it'),
                radio('internal', 'Internal', isOrg ? `Everyone in ${form.owner}` : 'Organisations only', !isOrg))),

        el('div', { class: 'field' },
            el('label', {}, 'Starter files'),
            el('div', { class: 'gh-row wrap' },
                select('gh-gitignore', '.gitignore', form.gitignore, [['', 'No .gitignore'],
                    ...cur.tpl.gitignore.map(t => [t, t])], v => { form.gitignore = v; }, st.existing.gitignore),
                select('gh-license', 'License', form.license, [['', 'No license'],
                    ...cur.tpl.licenses.map(l => [l.key, l.name])], v => { form.license = v; }, st.existing.license),
                check('Add a README', form.readme, v => { form.readme = v; }, st.existing.readme ? 'already has one' : null)),
            el('div', { class: 'note' }, 'Written into the folder before the first commit. A file that is already there is kept as it is.')),

        el('div', { class: 'field' },
            el('label', {}, 'This folder'),
            st.isGit ? null : el('div', { class: 'gh-row' },
                el('span', { class: 'gh-inline-label' }, 'git init on branch'),
                el('input', {
                    type: 'text', class: 'gh-short', spellcheck: 'false', value: form.branch,
                    oninput: (e) => { form.branch = e.target.value.trim(); },
                })),
            check(commitLabel(st), form.commit, v => { form.commit = v; paint(); }),
            form.commit ? el('input', {
                type: 'text', class: 'gh-indent', spellcheck: 'false', value: form.commitMessage,
                'aria-label': 'Commit message',
                oninput: (e) => { form.commitMessage = e.target.value; },
            }) : null,
            check('Push to GitHub', form.push && canPush, v => { form.push = v; }, canPush ? null : 'nothing to push yet', !canPush)),

        el('details', {
            class: 'gh-more', open: cur.moreOpen,
            ontoggle: (e) => { cur.moreOpen = e.target.open; },
        },
            el('summary', {}, 'More settings'),
            text('Homepage', 'homepage', { placeholder: 'https://…' }),
            text('Topics', 'topics', { placeholder: 'comma, separated', prose: true }),
            isOrg ? teamField() : null,
            el('div', { class: 'field' },
                el('label', {}, 'Features'),
                el('div', { class: 'gh-grid' },
                    check('Issues', !form.disableIssues, v => { form.disableIssues = !v; }),
                    check('Wiki', !form.disableWiki, v => { form.disableWiki = !v; }),
                    setting('Discussions', 'discussions'),
                    setting('Projects', 'projects'),
                    setting('Template repository', 'template'))),
            el('div', { class: 'field' },
                el('label', {}, 'Pull requests'),
                el('div', { class: 'gh-grid' },
                    setting('Allow merge commits', 'mergeCommit'),
                    setting('Allow squash merging', 'squashMerge'),
                    setting('Allow rebase merging', 'rebaseMerge'),
                    setting('Allow auto-merge', 'autoMerge'),
                    setting('Delete head branch on merge', 'deleteBranchOnMerge'),
                    setting('Suggest updating PR branches', 'allowUpdateBranch')),
                el('div', { class: 'gh-row' },
                    select('gh-squash', 'Squash commit message', form.settings.squashMessage, [
                        ['default', 'GitHub default'], ['pr-title', 'PR title'],
                        ['pr-title-commits', 'PR title and commits'],
                        ['pr-title-description', 'PR title and description'],
                    ], v => { form.settings.squashMessage = v; })))),
    ).childNodes);

    dom.ghBody.scrollTop = scroll;
    cur.mode = 'form';
    setGo('Create repository', false);
    dom.ghFootNote.textContent = '';
    checkName();
}

function statusLine(st) {
    const where = el('code', {}, st.cwd);
    if (!st.isGit) return [where, ' is not a git repository yet. It will be initialised.'];
    const bits = [st.hasCommits ? `on ${st.branch || 'a detached HEAD'}` : 'no commits yet'];
    if (st.uncommitted) bits.push(`${st.uncommitted} uncommitted file${st.uncommitted === 1 ? '' : 's'}`);
    if (st.remotes.length) bits.push(`remotes: ${st.remotes.map(r => r.name).join(', ')}`);
    return [where, ` is a git repository, ${bits.join(', ')}.`];
}

function commitLabel(st) {
    if (!st.isGit || !st.hasCommits) return 'Commit everything here as the first commit';
    return st.uncommitted
        ? `Commit the ${st.uncommitted} uncommitted file${st.uncommitted === 1 ? '' : 's'} first`
        : 'Commit uncommitted changes first (there are none)';
}

function text(label, key, { placeholder, prose } = {}) {
    const id = `gh-${key}`;
    return el('div', { class: 'field' },
        el('label', { for: id }, label),
        el('input', {
            id, type: 'text', spellcheck: prose ? 'true' : 'false', placeholder,
            class: prose ? 'prose' : null, value: cur.form[key],
            oninput: (e) => { cur.form[key] = e.target.value; },
        }));
}

function radio(value, label, hint, disabled) {
    return el('label', { class: 'gh-radio', 'data-disabled': disabled ? 'true' : null },
        el('input', {
            type: 'radio', name: 'gh-vis', value, disabled, checked: cur.form.visibility === value,
            onchange: () => { cur.form.visibility = value; },
        }),
        el('span', {}, el('b', {}, label), el('span', { class: 'gh-hint' }, hint)));
}

function check(label, on, set, hint, disabled) {
    return el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: on, disabled, onchange: (e) => set(e.target.checked) }),
        el('span', {}, label, hint ? el('span', { class: 'gh-hint' }, ` — ${hint}`) : null));
}

const setting = (label, key) => check(label, cur.form.settings[key], v => { cur.form.settings[key] = v; });

function select(id, label, value, options, set, kept) {
    return el('span', { class: 'gh-pick' },
        el('label', { for: id, class: 'gh-inline-label' }, label),
        el('select', { id, class: 'gh-select', disabled: kept, onchange: (e) => set(e.target.value) },
            options.map(([v, t]) => el('option', { value: v, selected: v === value }, t))),
        kept ? el('span', { class: 'gh-hint' }, 'already there') : null);
}

function teamField() {
    const org = cur.form.owner;
    const known = cur.teams[org];
    if (!known) {
        const mine = cur;
        get(`/api/github/teams?org=${encodeURIComponent(org)}`)
            .then(d => { if (cur === mine) { cur.teams[org] = d.teams; paint(); } })
            .catch(() => { if (cur === mine) { cur.teams[org] = []; paint(); } });
    }
    return el('div', { class: 'field' },
        select('gh-team', 'Give a team access', cur.form.team,
            [['', known ? (known.length ? 'No team' : 'No teams you can see') : 'Loading teams…'],
                ...(known || []).map(t => [t, t])],
            v => { cur.form.team = v; }, false));
}

// ── the name check ──────────────────────────────────────────────────────

let nameTimer = null;
let nameAsked = 0;

/** Say whether owner/name is free, a moment after the typing stops. */
function checkName() {
    clearTimeout(nameTimer);
    const note = document.getElementById('gh-name-note');
    if (!note || !cur?.form) return;
    const { owner, name } = cur.form;
    note.textContent = '';
    note.removeAttribute('data-kind');
    nameTimer = setTimeout(async () => {
        const asked = ++nameAsked;
        let r;
        try {
            r = await get(`/api/github/name?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}`);
        } catch { return; }
        if (asked !== nameAsked || !note.isConnected) return;
        const bad = r.problem || (r.taken ? `${owner}/${name} already exists` : null);
        note.textContent = bad || (r.taken === false ? `${owner}/${name} is free` : '');
        note.dataset.kind = bad ? 'bad' : 'ok';
    }, 350);
}

// ── submitting ──────────────────────────────────────────────────────────

async function retry() {
    const { cwd, onDone } = cur;
    await get('/api/github/account?refresh=1').catch(() => {});
    openPublish(cwd, { onDone });
}

async function submit() {
    const mine = cur;
    const { form, st } = cur;
    const body = {
        cwd: cur.cwd, ...form,
        branch: st.isGit ? undefined : form.branch,
        push: form.push && (st.hasCommits || form.commit),
    };
    cur.busy = true;
    setGo('Creating…', true);
    dom.ghFootNote.textContent = form.push ? 'Creating the repository and pushing' : 'Creating the repository';
    for (const n of dom.ghBody.querySelectorAll('input, select, button')) n.disabled = true;

    let r;
    try {
        r = await post('/api/github/publish', body);
    } catch (err) {
        mine.busy = false;
        if (cur !== mine) return;
        // A refusal is decided before anything runs, so the form comes back as it was.
        paint();
        dom.ghFootNote.textContent = '';
        toast(`Could not publish: ${err.message}`, 'error');
        return;
    }
    mine.busy = false;
    if (cur !== mine) return;
    cur.mode = 'result';
    showResult(r);
    if (r.url && cur.onDone) cur.onDone(r.url, r);
}

function showResult(r) {
    dom.ghBody.replaceChildren(
        el('div', { class: r.ok ? 'gh-status ok' : 'gh-problem' },
            r.ok ? 'Published ' : (r.url ? 'The repository exists, but not every step finished: ' : 'Nothing was created on GitHub. '),
            r.url ? el('a', { href: r.url, target: '_blank', rel: 'noreferrer' }, r.fullName) : null),
        el('ol', { class: 'gh-steps' }, r.steps.map(s => el('li', {
            'data-state': s.skipped ? 'skipped' : (s.ok ? 'ok' : 'failed'),
        },
        el('span', { class: 'gh-mark' }, s.skipped ? '–' : (s.ok ? '✓' : '✗')),
        el('span', { class: 'gh-step' }, s.step),
        s.detail ? el('span', { class: 'gh-detail' }, s.detail) : null))),
    );
    dom.ghFootNote.textContent = '';
    setGo('Done', false);
}
