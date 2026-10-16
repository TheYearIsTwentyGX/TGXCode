// The worktree janitor: every git worktree of one project, what is in each, and
// a Remove button on the ones nothing would be lost from.
//
// Opened from the project ⋮ menu and from a project's heading on the
// work-in-flight board. The deciding is bridge/worktrees.js's. Its header has the
// rules, and it applies them again when a removal arrives, so a row drawn as
// safe a minute ago is not a promise. This file draws the answer and says why
// each unsafe row is unsafe. A greyed-out button with no reason is the thing
// people end up deleting by hand in a terminal.
//
// **One click for one row, a confirming step for many.** Removing a single safe
// worktree loses nothing by definition, so it does not ask. "Remove all safe"
// does ask, and in the dialog itself rather than through confirm(). The step
// lists what is about to go, which is the same reason Delete-a-session is its
// own dialog. A native confirm() box also looks foreign in the Electron shell.
//
// Preact, the way web/rail.js settled: rows keyed by path, so a reload after a
// removal moves rows rather than rebuilding the list under the cursor. The
// dialog's state is `cur` here rather than in `state`, because, like Publish to
// GitHub, nothing outside the dialog reads it.

import { html } from './vendor/preact.js';
import { get, post } from './api.js';
import { state } from './state.js';
import { dom, closeModal, closeOnClickOutside, openModal, toast } from './dom.js';
import { ago } from './format.js';
import { paint } from './boards/parts.js';
import { openSession } from './transcript/conversation.js';

/** The open dialog, or null. */
let cur = null;

// Paths per removal request. See remove().
const BATCH = 10;

const WHY = {
    main: () => 'the main checkout',
    self: () => 'this app is running from it',
    locked: () => 'locked',
    dirty: (r) => `${r.files || 'some'} uncommitted file${r.files === 1 ? '' : 's'}`,
    unreadable: () => 'git status could not be read',
    unpushed: () => 'has commits that are on no remote',
    'pr-open': () => 'pull request still open',
    'pr-none': () => 'no pull request',
    'pr-unknown': () => 'pull request state unknown',
    'live-session': () => 'a session is running in it',
};

export async function openWorktrees(project) {
    cur = { cwd: project.cwd, name: project.name, data: null, error: null, loading: true, busy: new Set(), confirm: false };
    dom.wtTitle.textContent = `Worktrees · ${project.name || project.cwd}`;
    openModal(dom.wtScrim);
    draw();
    await load();
}

export function closeWorktrees() {
    if (cur && cur.busy.size) return;   // a removal is running; its answer is coming here
    cur = null;
    closeModal(dom.wtScrim);
}

export function wireWorktrees() {
    for (const n of dom.wtScrim.querySelectorAll('[data-close-wt]')) n.addEventListener('click', closeWorktrees);
    closeOnClickOutside(dom.wtScrim, closeWorktrees);
}

async function load(refresh = false) {
    const mine = cur;
    if (!mine) return;
    mine.loading = true;
    draw();
    try {
        const data = await get(`/api/worktrees?cwd=${encodeURIComponent(mine.cwd)}${refresh ? '&refresh=1' : ''}`);
        if (cur !== mine) return;
        mine.data = data;
        mine.error = null;
    } catch (err) {
        if (cur !== mine) return;
        mine.error = err.message;
    }
    mine.loading = false;
    draw();
}

async function remove(paths) {
    const mine = cur;
    if (!mine || !paths.length) return;
    for (const p of paths) mine.busy.add(p);
    mine.confirm = false;
    draw();
    // In batches, so a hundred-row "remove all" is not one request that takes a
    // minute and says nothing until it ends. Each batch lets go of its rows.
    const results = [];
    for (let i = 0; i < paths.length; i += BATCH) {
        const part = paths.slice(i, i + BATCH);
        try {
            results.push(...(await post('/api/worktrees/remove', { cwd: mine.cwd, paths: part })).results);
        } catch (err) {
            toast(`Could not remove: ${err.message}`, 'error');
            break;
        } finally {
            for (const p of part) mine.busy.delete(p);
            if (cur === mine) draw();
        }
    }
    for (const p of paths) mine.busy.delete(p);   // any a failed batch left behind
    const done = results.filter(r => r.removed);
    const failed = results.filter(r => !r.removed);
    if (done.length) {
        const kept = done.filter(r => r.branchKept).length;
        toast(`Removed ${done.length === 1 ? baseName(done[0].path) : `${done.length} worktrees`}`
            + (kept ? ` · ${kept === 1 && done.length === 1 ? 'branch' : `${kept} branch${kept === 1 ? '' : 'es'}`} kept` : ''), 'ok');
    }
    for (const r of failed) toast(`${baseName(r.path)} was not removed: ${r.error}`, 'error');
    if (cur === mine) await load();
}

const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;

// ── drawing ─────────────────────────────────────────────────────────────

function sorted(rows) {
    const rank = (r) => (r.main ? 0 : r.safe ? 1 : 2);
    return rows.slice().sort((a, b) => rank(a) - rank(b)
        || String(b.lastCommit || '').localeCompare(String(a.lastCommit || '')));
}

function draw() {
    if (!cur) return;
    paint(dom.wtBody, body());
    paint(dom.wtFoot, foot());
}

function body() {
    const { data, error, loading, confirm } = cur;
    if (error) return html`<div key="err" class="wt-note warn">${`Could not list worktrees: ${error}`}</div>`;
    if (!data) return html`<div key="wait" class="wt-note">Reading worktrees…</div>`;

    const safe = data.worktrees.filter(r => r.safe);
    if (confirm) {
        return html`<div key="confirm" class="wt-confirm">
            <p class="wt-confirm-lead">${`Remove ${safe.length} worktree${safe.length === 1 ? '' : 's'}?`}</p>
            <ul class="wt-confirm-list">${safe.map(r => html`<li key=${r.path}>
                <span class="wt-name">${r.name}</span>
                <span class="wt-branch">${r.branch || 'detached'}</span>
                ${r.pr && r.pr.state === 'merged' && r.pr.head === r.head
                    ? html`<span class="wt-small">branch deleted</span>`
                    : html`<span class="wt-small">branch kept</span>`}
            </li>`)}</ul>
            <p class="wt-small">Each is clean, on a remote, and its pull request is merged or closed. The
                bridge checks each one again as it goes, and skips any that changed.</p>
        </div>`;
    }

    return html`<div key="list" class=${`wt-list${loading ? ' loading' : ''}`}>
        <div class="wt-summary">
            <span>${`${data.worktrees.length} worktree${data.worktrees.length === 1 ? '' : 's'}`}</span>
            <span class="sep">·</span>
            <span>${`${safe.length} safe to remove`}</span>
            ${data.repo ? html`<span class="sep">·</span><span class="wt-small">${data.repo}</span>` : null}
        </div>
        ${data.prError ? html`<div class="wt-note warn">${`Pull requests could not be listed (${data.prError}), so nothing is safe to remove.`}</div>` : null}
        ${state.remote ? html`<div class="wt-note">Worktrees can only be removed at the machine they live on.</div>` : null}
        ${sorted(data.worktrees).map(row)}
    </div>`;
}

function prChip(r) {
    if (r.prState === 'unknown') return html`<span class="wt-chip">PR ?</span>`;
    if (!r.pr) return html`<span class="wt-chip">no PR</span>`;
    return html`<a class=${`wt-chip pr-${r.pr.state}`} href=${r.pr.url} target="_blank" rel="noopener"
        title=${r.pr.title || ''}>${`#${r.pr.number} ${r.pr.state}`}</a>`;
}

function sessionChip(r) {
    const s = r.sessions || {};
    if (!s.count && !s.live) return null;
    const top = (s.recent || [])[0];
    const label = s.live ? 'session live' : `${s.count} session${s.count === 1 ? '' : 's'}`;
    const title = (s.recent || []).map(x => `${x.live ? '● ' : ''}${x.title || x.id}`).join('\n');
    return html`<button type="button" class=${`wt-chip session${s.live ? ' live' : ''}`} title=${title}
        onClick=${() => { if (!top) return; closeWorktrees(); openSession(top.id); }}>${label}</button>`;
}

function row(r) {
    const busy = cur.busy.has(r.path);
    return html`<div key=${r.path} class=${`wt-row${r.safe ? ' safe' : ''}`} title=${r.path}>
        <div class="wt-main">
            <div class="wt-line">
                <span class="wt-name">${r.main ? `${r.name} (main)` : r.name}</span>
                <span class="wt-branch">${r.branch || 'detached'}</span>
                ${r.lastCommit ? html`<span class="wt-small" title=${r.lastCommit}>${ago(r.lastCommit)}</span>` : null}
            </div>
            <div class="wt-line">
                ${prChip(r)}
                ${r.missing ? html`<span class="wt-chip warn">directory gone</span>` : null}
                ${r.dirty ? html`<span class="wt-chip warn">${`${r.files} dirty`}</span>` : null}
                ${!r.pushed ? html`<span class="wt-chip warn">unpushed</span>` : null}
                ${r.locked ? html`<span class="wt-chip">locked</span>` : null}
                ${sessionChip(r)}
            </div>
            ${r.safe || r.main ? null : html`<div class="wt-why">${r.reasons.map(c => (WHY[c] ? WHY[c](r) : c)).join(' · ')}</div>`}
        </div>
        ${r.safe && !state.remote ? html`<button type="button" class="btn quiet wt-remove" disabled=${busy || cur.loading}
            onClick=${() => remove([r.path])}>${busy ? 'Removing…' : 'Remove'}</button>` : null}
    </div>`;
}

function foot() {
    const { data, confirm, busy, loading } = cur;
    const safe = data ? data.worktrees.filter(r => r.safe) : [];
    if (confirm) {
        return html`<span key="sp" class="spacer"></span>
            <button key="no" class="btn quiet" type="button" onClick=${() => { cur.confirm = false; draw(); }}>Back</button>
            <button key="go" class="btn destructive" type="button"
                onClick=${() => remove(safe.map(r => r.path))}>${`Remove ${safe.length}`}</button>`;
    }
    return html`<button key="refresh" class="btn quiet" type="button" disabled=${loading || busy.size > 0}
            onClick=${() => load(true)}>${loading ? 'Reading…' : 'Refresh'}</button>
        <span key="sp" class="spacer"></span>
        ${state.remote ? null : html`<button key="all" class="btn destructive" type="button"
            disabled=${!safe.length || loading || busy.size > 0}
            onClick=${() => { cur.confirm = true; draw(); }}>${busy.size ? 'Removing…' : `Remove all safe (${safe.length})`}</button>`}
        <button key="close" class="btn" type="button" onClick=${closeWorktrees}>Close</button>`;
}
