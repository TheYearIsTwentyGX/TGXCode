// Clone from GitHub: the dialog that turns a repository into a folder.
//
// Opened from Start-a-session, beside Publish to GitHub, which is the same
// trip in the other direction. The work is bridge/github-clone.js's. This file
// takes a repository two ways — typed (owner/repo, owner\repo, a URL) or picked
// from the repos the logged-in gh account can reach — asks the bridge whether it
// exists, asks where to put it, and then reports each step the bridge took.
//
// The form's values live in `form`. Typing writes `form` and redraws nothing
// outside the small status notes, so a caret is never lost halfway through a
// word; the repository list is the one region that is rebuilt (on a search, or a
// page arriving), and it is rebuilt on its own, not the inputs around it.

import { get, post } from '../api.js';
import { dom, closeModal, closeOnClickOutside, el, openModal, toast } from '../dom.js';
import { ago } from '../format.js';

/** The open dialog, or null. */
let cur = null;

const PAGE = 50;
const LAST_PARENT = 'cloneParent';

export async function openClone({ browseDir, onDone } = {}) {
    cur = {
        onDone, browseDir: browseDir || null, mode: 'wait', busy: false,
        who: null, defaultParent: null,
        form: { input: '', parent: '', name: '', branch: '', allowNested: false },
        nameEdited: false,
        info: null,        // the resolve answer for form.input, or null
        dest: null,        // the clone-target answer, or null
        list: { q: '', repos: [], more: false, loading: false, error: null, truncated: false, seq: 0 },
    };
    const mine = cur;
    openModal(dom.gcScrim);
    dom.gcFootNote.textContent = '';
    setGo('Clone', true);
    dom.gcBody.replaceChildren(el('div', { class: 'gh-wait' }, 'Asking GitHub…'));

    try {
        const [who, target] = await Promise.all([
            get('/api/github/account'),
            get('/api/github/clone-target'),
        ]);
        if (cur !== mine) return;
        mine.who = who;
        mine.defaultParent = target.defaultParent;
        let last = '';
        try { last = localStorage.getItem(LAST_PARENT) || ''; } catch { /* private mode */ }
        mine.form.parent = last || target.defaultParent || '';
        paint();
        if (who.authed) { loadRepos(true); checkDest(); }
    } catch (err) {
        if (cur !== mine) return;
        dom.gcBody.replaceChildren(el('div', { class: 'gh-problem' }, `Could not ask the bridge: ${err.message}`));
    }
}

export function closeClone() {
    if (cur?.busy) return;   // git is running; closing would hide its answer
    cur = null;
    closeModal(dom.gcScrim);
}

export function wireClone() {
    for (const n of dom.gcScrim.querySelectorAll('[data-close-gc]')) n.addEventListener('click', closeClone);
    closeOnClickOutside(dom.gcScrim, closeClone);
    // One listener; what the button means is `cur.mode`, as in the publish dialog.
    dom.gcGo.addEventListener('click', () => {
        if (!cur || cur.busy) return;
        if (cur.mode === 'result') finish();
        else if (cur.mode === 'retry') retry();
        else if (cur.mode === 'form') submit();
    });
}

function setGo(label, disabled) {
    dom.gcGo.textContent = label;
    dom.gcGo.disabled = !!disabled;
}

// ── drawing ─────────────────────────────────────────────────────────────

function paint() {
    const { who, form } = cur;

    if (!who.authed) {
        dom.gcBody.replaceChildren(
            el('div', { class: 'gh-problem' }, who.installed
                ? `gh is not logged in: ${who.error || 'no account'}`
                : 'The gh CLI is not installed on this machine.'),
            el('div', { class: 'field' }, el('div', { class: 'note' },
                who.installed ? 'Run ' : 'Install it from cli.github.com, then run ',
                el('code', {}, 'gh auth login'), ' in a terminal, then press Retry. ',
                'A repository outside GitHub can still be cloned with git, but needs gh to be set up first for this dialog.')),
        );
        cur.mode = 'retry';
        setGo('Retry', false);
        return;
    }

    dom.gcBody.replaceChildren(...el('div', {},
        el('div', { class: 'field' },
            el('label', { for: 'gc-input' }, 'Repository'),
            el('input', {
                id: 'gc-input', type: 'text', spellcheck: 'false', autocomplete: 'off', value: form.input,
                placeholder: 'owner/repo or https://github.com/owner/repo',
                oninput: (e) => { form.input = e.target.value; onInput(); },
            }),
            el('div', { id: 'gc-input-note', class: 'note' },
                'Also accepts ', el('code', {}, 'owner\\repo'), ', ', el('code', {}, 'git@github.com:owner/repo.git'),
                ' and a ', el('code', {}, '/tree/<branch>'), ' link.')),

        el('div', { class: 'field' },
            el('label', { for: 'gc-filter' }, `Or pick one of your repositories${who.login ? ` (${who.login} and your organisations)` : ''}`),
            el('input', {
                id: 'gc-filter', type: 'text', class: 'picker-filter prose', spellcheck: 'false', autocomplete: 'off',
                placeholder: 'Search by name or description…',
                oninput: (e) => searchRepos(e.target.value),
            }),
            el('div', { id: 'gc-list', class: 'gc-list', role: 'listbox', 'aria-label': 'Your repositories',
                onscroll: onListScroll })),

        el('div', { class: 'field' },
            el('label', { for: 'gc-parent' }, 'Clone into'),
            el('div', { class: 'gh-row' },
                el('input', {
                    id: 'gc-parent', type: 'text', spellcheck: 'false', value: form.parent,
                    'aria-label': 'Parent folder',
                    oninput: (e) => { form.parent = e.target.value; form.allowNested = false; checkDest(); },
                }),
                el('span', { class: 'gh-slash gc-slash' }, '/'),
                el('input', {
                    id: 'gc-name', type: 'text', class: 'gc-name', spellcheck: 'false', value: form.name,
                    placeholder: 'folder name', 'aria-label': 'Folder name',
                    oninput: (e) => { form.name = e.target.value.trim(); cur.nameEdited = true; checkDest(); },
                })),
            cur.browseDir && cur.browseDir !== form.parent ? el('div', { class: 'note' },
                el('button', { class: 'link-btn gc-use', type: 'button', onclick: () => {
                    form.parent = cur.browseDir; form.allowNested = false;
                    document.getElementById('gc-parent').value = form.parent;
                    checkDest();
                } }, `Use the folder Start is browsing`), el('code', {}, cur.browseDir)) : null,
            el('div', { id: 'gc-dest-note', class: 'note' }),
            el('label', { id: 'gc-nested', class: 'check', hidden: true },
                el('input', { type: 'checkbox', onchange: (e) => { form.allowNested = e.target.checked; checkDest(); } }),
                el('span', { id: 'gc-nested-text' }))),

        el('div', { class: 'field' },
            el('label', { for: 'gc-branch' }, 'Branch (optional)'),
            el('input', {
                id: 'gc-branch', type: 'text', class: 'gh-short', spellcheck: 'false', value: form.branch,
                placeholder: 'default branch',
                oninput: (e) => { form.branch = e.target.value.trim(); onInput(); },
            })),
    ).childNodes);

    cur.mode = 'form';
    setGo('Clone', true);
    paintList();
    paintInfo();
    paintDest();
    updateGo();
}

// ── the repository list ─────────────────────────────────────────────────

let searchTimer = null;

function searchRepos(q) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        if (!cur) return;
        cur.list.q = q.trim();
        loadRepos(true);
    }, 250);
}

/** Fetch a page (or the first one again, for a new search) and redraw the list. */
async function loadRepos(fresh) {
    const mine = cur;
    const l = mine.list;
    if (l.loading && !fresh) return;
    const seq = ++l.seq;
    if (fresh) { l.repos = []; l.more = false; l.error = null; l.truncated = false; }
    l.loading = true;
    paintList();
    try {
        const d = await get(`/api/github/repos?q=${encodeURIComponent(l.q)}&offset=${l.repos.length}&limit=${PAGE}`);
        if (cur !== mine || seq !== l.seq) return;
        l.repos.push(...d.repos);
        l.more = d.more;
        l.truncated = d.truncated;
        l.error = d.error;
    } catch (err) {
        if (cur !== mine || seq !== l.seq) return;
        l.error = err.message;
    }
    l.loading = false;
    paintList();
}

function onListScroll(e) {
    const n = e.target;
    const l = cur?.list;
    if (l?.more && !l.loading && n.scrollTop + n.clientHeight >= n.scrollHeight - 40) loadRepos(false);
}

function paintList() {
    const host = document.getElementById('gc-list');
    if (!host || !cur) return;
    const l = cur.list;
    const rows = l.repos.map(r => {
        const picked = cur.form.input.trim().toLowerCase() === r.fullName.toLowerCase();
        return el('button', {
            class: 'gc-repo', type: 'button', role: 'option', 'aria-selected': picked ? 'true' : 'false',
            onclick: () => pickRepo(r),
        },
        el('span', { class: 'gc-repo-top' },
            el('span', { class: 'gc-repo-name' }, r.fullName),
            el('span', { class: 'gc-vis', 'data-vis': r.visibility }, r.visibility),
            r.fork ? el('span', { class: 'gc-vis' }, 'fork') : null,
            r.archived ? el('span', { class: 'gc-vis' }, 'archived') : null,
            el('span', { class: 'gc-when', title: r.pushedAt || '' }, ago(r.pushedAt))),
        r.description ? el('span', { class: 'gc-repo-desc' }, r.description) : null);
    });
    const tail = [];
    if (l.error) tail.push(el('div', { class: 'gc-msg bad' }, l.error));
    else if (l.loading) tail.push(el('div', { class: 'gc-msg' }, l.repos.length ? 'Loading more…' : 'Loading repositories…'));
    else if (!l.repos.length) tail.push(el('div', { class: 'gc-msg' }, l.q ? 'No repository matches.' : 'No repositories on this account.'));
    else if (l.more) tail.push(el('button', { class: 'link-btn gc-more', type: 'button', onclick: () => loadRepos(false) }, 'Load more'));
    else if (l.truncated) tail.push(el('div', { class: 'gc-msg' }, 'Only the most recently updated repositories were searched — type the full owner/repo to clone any other.'));
    host.replaceChildren(...rows, ...tail);
}

function pickRepo(r) {
    const f = cur.form;
    f.input = r.fullName;
    f.branch = '';
    const input = document.getElementById('gc-input');
    input.value = r.fullName;
    const br = document.getElementById('gc-branch');
    if (br) br.value = '';
    onInput({ immediate: true });
    paintList();
}

// ── resolving what was typed ────────────────────────────────────────────

let inputTimer = null;
let asked = 0;

/** Look up the repository a moment after the typing stops. */
function onInput({ immediate } = {}) {
    clearTimeout(inputTimer);
    cur.info = null;
    paintInfo('wait');
    updateGo();
    if (!cur.form.input.trim()) { paintInfo(); return; }
    inputTimer = setTimeout(resolveNow, immediate ? 0 : 450);
}

async function resolveNow() {
    const mine = cur;
    if (!mine) return;
    const { input, branch } = mine.form;
    const n = ++asked;
    let r;
    try {
        r = await get(`/api/github/resolve?input=${encodeURIComponent(input)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`);
    } catch (err) {
        r = { ok: false, reason: 'error', error: err.message };
    }
    if (cur !== mine || n !== asked) return;
    mine.info = r;
    if (r.ok) {
        // A branch read from a /tree/ link lands in its own box, where it can be changed.
        if (r.branch && !mine.form.branch) {
            mine.form.branch = r.branch;
            const br = document.getElementById('gc-branch');
            if (br) br.value = r.branch;
        }
        // The folder follows the repository's name until somebody types their own.
        if (!mine.nameEdited || !mine.form.name) {
            mine.form.name = r.name;
            mine.nameEdited = false;
            const nm = document.getElementById('gc-name');
            if (nm) nm.value = r.name;
        }
        checkDest();
    }
    paintInfo();
    updateGo();
}

function paintInfo(state) {
    const note = document.getElementById('gc-input-note');
    if (!note || !cur) return;
    const info = cur.info;
    note.removeAttribute('data-kind');
    if (state === 'wait') { note.textContent = 'Checking…'; return; }
    if (!info) {
        note.replaceChildren('Also accepts ', el('code', {}, 'owner\\repo'), ', ', el('code', {}, 'git@github.com:owner/repo.git'),
            ' and a ', el('code', {}, '/tree/<branch>'), ' link.');
        return;
    }
    if (!info.ok) { note.textContent = info.error; note.dataset.kind = 'bad'; return; }
    const bits = [info.fullName];
    if (info.visibility) bits.push(info.visibility);
    if (info.defaultBranch) bits.push(`default branch ${info.defaultBranch}`);
    if (info.kind === 'other') bits.push('plain git clone — git\'s own credentials, not gh\'s');
    if (info.archived) bits.push('archived');
    if (info.empty) bits.push('empty');
    if (info.sizeKb) bits.push(info.sizeKb >= 1024 ? `${(info.sizeKb / 1024).toFixed(0)} MB` : `${info.sizeKb} KB`);
    note.textContent = `✓ ${bits.join(' · ')}${info.description ? ` — ${info.description}` : ''}`;
    note.dataset.kind = 'ok';
}

// ── the destination ─────────────────────────────────────────────────────

let destTimer = null;
let destAsked = 0;

function checkDest() {
    clearTimeout(destTimer);
    cur.dest = null;
    paintDest();
    updateGo();
    const mine = cur;
    destTimer = setTimeout(async () => {
        const n = ++destAsked;
        const f = mine.form;
        let d;
        try {
            d = await get(`/api/github/clone-target?parent=${encodeURIComponent(f.parent)}`
                + `&name=${encodeURIComponent(f.name || 'x')}${f.allowNested ? '&allowNested=1' : ''}`);
        } catch (err) {
            d = { problem: err.message };
        }
        if (cur !== mine || n !== destAsked) return;
        // No repository yet means no folder name to judge; the parent is what is checked.
        mine.dest = f.name ? d : { ...d, problem: d.problem && !/name/.test(d.problem) ? d.problem : null, path: null, unnamed: true };
        paintDest();
        updateGo();
    }, 250);
}

function paintDest() {
    const note = document.getElementById('gc-dest-note');
    const box = document.getElementById('gc-nested');
    if (!note || !cur) return;
    const d = cur.dest;
    note.removeAttribute('data-kind');
    if (box) box.hidden = !(d && d.nested);
    if (d && d.nested) {
        document.getElementById('gc-nested-text').textContent = `Clone inside the repository at ${d.nested} anyway`;
        box.querySelector('input').checked = cur.form.allowNested;
    }
    if (!d) { note.textContent = ''; return; }
    if (d.problem) { note.textContent = d.problem; note.dataset.kind = 'bad'; return; }
    if (d.path) { note.textContent = `Will clone to ${d.path}`; note.dataset.kind = 'ok'; }
    else note.textContent = '';
}

function updateGo() {
    if (!cur || cur.mode !== 'form') return;
    const ready = cur.info?.ok && cur.dest && !cur.dest.problem && cur.form.name;
    setGo('Clone', !ready);
}

// ── submitting ──────────────────────────────────────────────────────────

async function retry() {
    const { onDone, browseDir } = cur;
    await get('/api/github/account?refresh=1').catch(() => {});
    openClone({ onDone, browseDir });
}

async function submit() {
    const mine = cur;
    const { form, info } = cur;
    const body = {
        repo: form.input, parent: form.parent, name: form.name,
        branch: form.branch || undefined, allowNested: form.allowNested || undefined,
    };
    mine.busy = true;
    setGo('Cloning…', true);
    dom.gcFootNote.textContent = `Cloning ${info.fullName} — this can take a while for a large repository`;
    for (const n of dom.gcBody.querySelectorAll('input, select, button')) n.disabled = true;

    let r;
    try {
        r = await post('/api/github/clone', body);
    } catch (err) {
        mine.busy = false;
        if (cur !== mine) return;
        // A refusal is decided before anything runs, so the form comes back as it was.
        paint();
        dom.gcFootNote.textContent = '';
        toast(`Could not clone: ${err.message}`, 'error');
        return;
    }
    mine.busy = false;
    if (cur !== mine) return;
    try { localStorage.setItem(LAST_PARENT, form.parent); } catch { /* private mode */ }
    mine.mode = 'result';
    mine.result = r;
    showResult(r);
}

function showResult(r) {
    dom.gcBody.replaceChildren(
        el('div', { class: r.ok ? 'gh-status ok' : 'gh-problem' },
            r.ok ? 'Cloned ' : 'The clone did not finish: ',
            r.url ? el('a', { href: r.url, target: '_blank', rel: 'noreferrer' }, r.fullName) : r.fullName,
            r.ok ? [' into ', el('code', {}, r.path)] : null),
        el('ol', { class: 'gh-steps' }, r.steps.map(s => el('li', {
            'data-state': s.skipped ? 'skipped' : (s.ok ? 'ok' : 'failed'),
        },
        el('span', { class: 'gh-mark' }, s.skipped ? '–' : (s.ok ? '✓' : '✗')),
        el('span', { class: 'gh-step' }, s.step),
        s.detail ? el('span', { class: 'gh-detail' }, s.detail) : null))),
    );
    dom.gcFootNote.textContent = '';
    setGo(r.ok ? 'Use this folder' : 'Close', false);
}

/** The result's button: take the folder into Start-a-session, or just close. */
function finish() {
    const { result, onDone } = cur;
    const ok = result?.ok;
    cur = null;
    closeModal(dom.gcScrim);
    if (ok && onDone) onDone(result.path, result);
}
