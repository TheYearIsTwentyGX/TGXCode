// The work-in-flight board, drawn with Preact.
//
// The rail answers "what have I been talking to". This answers "what have I
// left behind" — changes nobody committed, pull requests nobody merged — which
// is the thing a screen full of finished conversations hides.
//
// Opening and closing the panel is app.js's (`showDash`, in `// ── dashboard ──`,
// beside the other whole-screen panels it has to stay exclusive with). This file
// is the fetch, the badge and the drawing.
//
// Keyed like web/rail.js: a project by its directory, a workspace row by the
// same id its file list is remembered under, a session chip by session id. A
// Refresh or a colour change used to empty #dash-body and build it again, which
// dropped a click in flight and closed nothing but lost hover and scroll; now
// what did not change keeps its node. Markup and class names are what the
// imperative version built, so web/styles.css did not change.
//
// This imports from app.js, which imports this — safe because nothing here reads
// an app.js binding at module top level, only when a function is called.

import * as keys from '../keys.js';
import { html } from '../vendor/preact.js';
import { get } from '../api.js';
import { state } from '../state.js';
import { dom } from '../dom.js';
import { ago, clip } from '../format.js';
import { PR_ICON } from '../icons.js';
import { projectColor, prWords, showDash } from '../app.js';
import { openSession } from '../transcript/conversation.js';
import { icon, paint } from './parts.js';

export async function loadDash({ refresh = false } = {}) {
    if (state.dash.loading) return;
    state.dash.loading = true;
    state.dash.error = null;
    renderDash();
    try {
        const data = await get('/api/dashboard' + (refresh ? '?refresh=1' : ''));
        state.dash.data = data;
        state.dash.at = Date.now();
    } catch (err) {
        state.dash.error = err.message;
    } finally {
        state.dash.loading = false;
        renderDash();
        paintDashBadge();
    }
}

/**
 * How much is outstanding, on the button that opens the board. Counted in
 * places rather than in files or PRs: "eleven" meaning eleven modified files in
 * one worktree and "eleven" meaning eleven worktrees are different news.
 */
export function paintDashBadge() {
    const d = state.dash.data;
    const rows = d ? d.projects.reduce((n, p) => n + p.workspaces.length, 0) : 0;
    dom.dashBadge.hidden = !rows;
    dom.dashBadge.textContent = String(rows);
    dom.btnDash.title = keys.hint(rows
        ? `${rows} ${rows === 1 ? 'place has' : 'places have'} uncommitted changes or an open pull request`
        : 'Uncommitted changes and open pull requests, by project', 'view.dashboard');
}

export function renderDash() {
    const d = state.dash.data;
    dom.dashRefresh.disabled = state.dash.loading;
    dom.dashRefresh.textContent = state.dash.loading ? 'Checking…' : 'Refresh';

    if (d) {
        const when = ago(d.checkedAt);
        dom.dashSub.textContent = [
            `${d.dirty} ${d.dirty === 1 ? 'directory' : 'directories'} with uncommitted changes`,
            `${d.open} pull ${d.open === 1 ? 'request' : 'requests'} still open`,
            when === 'now' ? 'checked just now' : `checked ${when} ago`,
        ].join(' · ');
    } else {
        dom.dashSub.textContent = 'Uncommitted changes, and pull requests that are '
            + 'open but not merged.';
    }

    paint(dom.dashBody, dashTree(d));
}

function dashTree(d) {
    if (state.dash.error) {
        return html`<div key="error" class="dash-note error">
            <p>${`Could not read the working trees: ${state.dash.error}`}</p>
            <button class="more-btn" type="button" onClick=${() => loadDash()}>Try again</button>
        </div>`;
    }
    if (!d) {
        return html`<div key="wait" class="dash-note"><p>Reading working trees and asking GitHub…</p></div>`;
    }

    const nodes = [];
    // gh failing is worth saying outright rather than quietly listing no PRs:
    // an empty board would otherwise read as "nothing open".
    if (!d.gh.ok) {
        nodes.push(html`<div key="gh" class="dash-note warn"><p>${
            `Pull requests could not be listed — ${d.gh.error}. `
            + 'Uncommitted changes below are unaffected.'}</p></div>`);
    }
    if (!d.projects.length) {
        nodes.push(html`<div key="clean" class="dash-note"><p>${
            'Nothing uncommitted, and no pull request left open. '
            + 'Every worktree on this machine is clean.'}</p></div>`);
    }
    for (const p of d.projects) nodes.push(dashProject(p));
    return nodes;
}

function dashProject(p) {
    const counts = [];
    if (p.dirty) counts.push(`${p.dirty} dirty`);
    if (p.open) counts.push(`${p.open} open PR${p.open === 1 ? '' : 's'}`);

    const accent = projectColor(p.cwd);

    return html`
        <section key=${`p:${p.cwd || p.name}`} class="dproj"
            data-tinted=${accent ? '1' : null}
            style=${accent ? `--proj-accent: ${accent}` : null}>
            <header class="dproj-head">
                <span class="dproj-name">${p.name}</span>
                ${p.repo ? html`<span class="dproj-repo">${p.repo}</span>` : null}
                <span class="dproj-counts">${counts.join(' · ')}</span>
            </header>
            <div class="dproj-body">${p.workspaces.map(w => dashRow(p, w))}</div>
        </section>`;
}

function dashRow(project, w) {
    const g = w.git || {};
    const filesId = `${project.cwd}::${w.dir || (w.prs[0] && w.prs[0].url) || w.name}`;
    const showFiles = state.dash.files.has(filesId);

    const signals = [];
    if (g.dirty) {
        signals.push(html`<button key="dirty" class=${'sig dirty' + (showFiles ? ' on' : '')}
            type="button" aria-expanded=${String(showFiles)} title=${dirtyTitle(g)}
            onClick=${() => {
                state.dash.files[showFiles ? 'delete' : 'add'](filesId);
                renderDash();
            }}>${`${g.files} uncommitted`}</button>`);
    }
    // Only where there is an upstream to be ahead of; a worktree branch that was
    // never pushed has nothing to compare against and says nothing here.
    if (g.ahead) signals.push(html`<span key="ahead" class="sig quiet">${`${g.ahead} unpushed`}</span>`);
    if (g.conflicts) signals.push(html`<span key="conflicts" class="sig bad">${`${g.conflicts} conflicted`}</span>`);

    // The same one word, glyph and colour the header and the rail use. This used
    // to read `draft` and `reviewDecision` off the raw record and draw its own
    // conclusions, which meant a merged PR, one conflicting with its base and one
    // with a failing build were three identical blue chips here while the other
    // two surfaces showed three different glyphs. The bridge resolves `status`
    // now, so there is one PR vocabulary in the app rather than two.
    for (const pr of w.prs) {
        const status = pr.status || 'unknown';
        signals.push(html`<a key=${pr.url} class="sig pr" data-status=${status}
            href=${pr.url} target="_blank" rel="noreferrer"
            title=${[
                pr.label || prWords(status),
                pr.title,
                `${pr.url}\nopened by ${pr.author || 'someone'}, `
                    + `updated ${ago(pr.updatedAt)} ago`,
            ].filter(Boolean).join('\n')}
            >${icon(PR_ICON[status] || 'pr', 12)}<span class="pr-num">${`#${pr.number}`}</span><span
                class="pr-title">${clip(pr.title, 46)}</span></a>`);
    }

    return html`
        <article key=${filesId} class="wsrow" data-kind=${w.kind}>
            <div class="wsrow-head">
                <span class="ws-name">${w.name}</span>
                ${w.kind === 'gone'
                    ? html`<span class="ws-note">no working directory left</span>`
                    : html`<span class="ws-branch" title=${w.dir || ''}>${
                        g.branch || (g.detached ? 'detached HEAD' : '—')}</span>`}
                <span class="wsrow-signals">${signals}</span>
            </div>
            ${showFiles && g.sample ? html`
                <ul class="ws-files">
                    ${g.sample.map(f => html`<li key=${f.path}><span class="fstat" data-s=${f.status}>${
                        statusWord(f.status)}</span><span class="fpath">${f.path}</span></li>`)}
                    ${g.files > g.sample.length
                        ? html`<li key="more" class="more">${`and ${g.files - g.sample.length} more`}</li>`
                        : null}
                </ul>` : null}
            <div class="ws-sessions">
                ${w.sessions.map(s => dashSession(s))}
                ${w.moreSessions ? html`<span key="more" class="ws-more">${`+${w.moreSessions} older`}</span>` : null}
            </div>
        </article>`;
}

function dashSession(s) {
    const running = s.runner && (s.runner.state === 'busy' || s.runner.state === 'starting');
    return html`<button key=${s.sessionId} class="schip" type="button"
        data-state=${running ? 'running' : (s.active ? 'active' : 'idle')}
        title=${`${s.title}\n${s.userMessages} turns · last message ${ago(s.lastTs)} ago`}
        onClick=${() => { showDash(false); openSession(s.sessionId); }}
        ><span class="schip-dot"></span><span class="schip-title">${clip(s.title, 40)}</span><span
            class="schip-ago">${ago(s.lastTs)}</span></button>`;
}

function dirtyTitle(g) {
    const bits = [];
    if (g.staged) bits.push(`${g.staged} staged`);
    if (g.unstaged) bits.push(`${g.unstaged} modified`);
    if (g.untracked) bits.push(`${g.untracked} untracked`);
    if (g.conflicts) bits.push(`${g.conflicts} conflicted`);
    return bits.join(' · ') + ' — click to list them';
}

export function statusWord(xy) {
    if (xy === '??') return 'new';
    if (xy === 'UU') return 'conflict';
    if (xy[0] === 'D' || xy[1] === 'D') return 'deleted';
    if (xy[0] === 'A') return 'added';
    if (xy[0] === 'R' || xy[1] === 'R') return 'renamed';
    return xy[0] !== '.' ? 'staged' : 'modified';
}
