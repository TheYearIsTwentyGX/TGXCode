// Importing a skill: search with `npx skills find`, or paste a source, then a
// preview of every file that would be written, then a target, then Install.
//
// Nothing is written until Install, and Install sends back the `digest` of the
// preview drawn here — the bridge refuses unless the staged files are still
// exactly that (bridge/skill-import.js). So the preview is not a courtesy: it
// is the thing being agreed to.
//
// - **Every skill starts unticked**, including the one a search result named.
//   That one is marked and listed first; ticking is still a decision.
// - **Every file can be opened** before ticking. Executables, scripts, binaries,
//   frontmatter hooks and pre-approved tools are flagged on the skill's card.
// - **Install shows the exact directories it will create.**

import { html } from '../vendor/preact.js';
import { del, get, post } from '../api.js';
import { toast } from '../dom.js';
import { shortPath } from '../format.js';
import { bytes, loadSkills, renderSkills, skDir, skState, targetPicker } from './page.js';

const fresh = () => ({
    q: '', searching: false, results: null, searchError: null, searchVia: null,
    source: '', skill: null, staging: false, staged: null, stageError: null,
    ticked: {}, open: null, target: { runtime: 'claude', scope: 'user' }, overwrite: false, installing: false,
});

const imp = () => skState().imp;

export function openImport(source) {
    const s = skState();
    s.creating = null;
    s.mode = 'import';
    if (!s.imp) s.imp = fresh();
    if (source) { s.imp.source = source; stage(source); }
    renderSkills();
}

async function closeImport() {
    const s = skState();
    const st = s.imp && s.imp.staged;
    if (st) del(`/api/skills/import/${encodeURIComponent(st.id)}`).catch(() => {});
    s.imp = null;
    s.mode = 'browse';
    renderSkills();
}

async function search() {
    const i = imp();
    const q = i.q.trim();
    if (!q) return;
    i.searching = true; i.searchError = null;
    renderSkills();
    try {
        const got = await get(`/api/skills/search?q=${encodeURIComponent(q)}`);
        if (imp() !== i) return;
        i.results = got.results;
        i.searchVia = got.via;
    } catch (err) {
        i.searchError = err.message;
    }
    i.searching = false;
    renderSkills();
}

async function stage(source, skill = null) {
    const i = imp();
    if (i.staged) del(`/api/skills/import/${encodeURIComponent(i.staged.id)}`).catch(() => {});
    Object.assign(i, { source, skill, staging: true, staged: null, stageError: null, ticked: {}, open: null });
    renderSkills();
    try {
        const got = await post('/api/skills/import/stage', { source, ...(skill ? { skill } : {}) });
        if (imp() !== i) return;
        // The one a search result named goes first; the order is otherwise the repository's.
        got.skills.sort((a, b) => Number(Boolean(b.match)) - Number(Boolean(a.match)));
        i.staged = got;
    } catch (err) {
        i.stageError = err.message;
    }
    i.staging = false;
    renderSkills();
}

function targetDir(t, name) {
    const proj = skDir();
    if (t.runtime === 'claude') return t.scope === 'user' ? `~/.claude/skills/${name}` : `${shortPath(proj)}/.claude/skills/${name}`;
    return t.scope === 'user' ? `$CODEX_HOME/skills/${name}` : `${shortPath(proj)}/.agents/skills/${name}`;
}

async function install() {
    const s = skState();
    const i = imp();
    const chosen = Object.keys(i.ticked).filter(k => i.ticked[k]);
    if (!i.staged || !chosen.length) return;
    i.installing = true;
    renderSkills();
    try {
        const got = await post('/api/skills/import/install', {
            id: i.staged.id, digest: i.staged.digest, skills: chosen, target: i.target, project: skDir(), overwrite: i.overwrite,
        });
        toast(`Installed ${got.installed.map(x => x.name).join(', ')} into ${got.root.label}.`, 'ok');
        s.imp = null;
        s.mode = 'browse';
        s.sel = got.installed[0].dir;
        await loadSkills();
        return;
    } catch (err) {
        i.installing = false;
        toast(`Could not install: ${err.message}`, 'error');
        if (err.status === 404) { i.staged = null; i.stageError = err.message; }
    }
    renderSkills();
}

export function ImportView() {
    const i = imp();
    if (!i) return null;
    return html`<div class="skp-import">
        <div class="skp-head">
            <h2 class="skp-h">Import a skill</h2>
            <div class="cmd-card-spacer"></div>
            <button class="btn small quiet" type="button" onClick=${closeImport}>Close</button>
        </div>
        <p class="skp-desc">Nothing is written until you press Install, and Install writes exactly the files shown here.</p>

        <section class="skp-step">
            <h3 class="skp-step-h">Find one</h3>
            <form class="skp-row-form" onSubmit=${(e) => { e.preventDefault(); search(); }}>
                <input class="skp-input" type="search" placeholder="Search skills.sh — pdf, testing, react…" value=${i.q}
                    onInput=${(e) => { i.q = e.target.value; }} />
                <button class="btn small tonal" type="submit" disabled=${i.searching}>${i.searching ? 'Searching…' : 'Search'}</button>
            </form>
            ${i.searchError ? html`<div class="dash-note error">${i.searchError}</div>` : null}
            ${i.results ? results(i) : null}
        </section>

        <section class="skp-step">
            <h3 class="skp-step-h">Or name its source</h3>
            <form class="skp-row-form" onSubmit=${(e) => { e.preventDefault(); if (i.source.trim()) stage(i.source.trim()); }}>
                <input class="skp-input skp-mono" placeholder="owner/repo, owner/repo@skill, a GitHub URL, or a SKILL.md URL" value=${i.source}
                    onInput=${(e) => { i.source = e.target.value; }} />
                <button class="btn small tonal" type="submit" disabled=${i.staging || !i.source.trim()}>${i.staging ? 'Fetching…' : 'Fetch and preview'}</button>
            </form>
            ${i.stageError ? html`<div class="dash-note error">${i.stageError}</div>` : null}
        </section>

        ${i.staged ? preview(i) : null}
    </div>`;
}

function results(i) {
    if (!i.results.length) return html`<div class="dash-note">Nothing found.</div>`;
    return html`<div class="skp-results">
        ${i.results.map(r => html`<div key=${`${r.source}@${r.skill}`} class="skp-result">
            <div class="skp-result-main">
                <span class="skp-result-name">${r.skill}</span>
                <span class="skp-result-src skp-mono">${r.source}</span>
                ${r.installs ? html`<span class="skp-result-n">${r.installs} installs</span>` : null}
            </div>
            <div class="skp-result-acts">
                ${r.url ? html`<a class="skp-link" href=${r.url} target="_blank" rel="noopener noreferrer">skills.sh</a>` : null}
                <a class="skp-link" href=${r.repoUrl} target="_blank" rel="noopener noreferrer">GitHub</a>
                <button class="btn small" type="button" disabled=${i.staging}
                    onClick=${() => stage(r.source, r.skill)}>Install…</button>
            </div>
        </div>`)}
        ${i.searchVia ? html`<div class="cmd-field-note">From <code>${i.searchVia}</code>.</div>` : null}
    </div>`;
}

function preview(i) {
    const st = i.staged;
    const chosen = st.skills.filter(k => i.ticked[k.folder]);
    return html`<section class="skp-step">
        <h3 class="skp-step-h">Preview — ${st.fullName || st.source}${st.ref ? html` <code>@${st.ref}</code>` : null}${st.sub ? html` <code>/${st.sub}</code>` : null}</h3>
        <p class="cmd-field-note">${st.skills.length} skill${st.skills.length === 1 ? '' : 's'} found. Open any file to read it before you tick it.</p>
        <div class="skp-cards">
            ${st.skills.map(k => card(i, k))}
        </div>

        <h3 class="skp-step-h">Install into</h3>
        ${targetPicker(i.target, (t) => { i.target = t; renderSkills(); })}
        <label class="skp-target skp-overwrite">
            <input type="checkbox" checked=${i.overwrite} onChange=${(e) => { i.overwrite = e.target.checked; renderSkills(); }} />
            <span>Replace a skill of the same name (the old one goes to the trash)</span>
        </label>
        ${chosen.length ? html`<div class="skp-will">
            <div class="cmd-field-label">Will create</div>
            ${chosen.map(k => html`<code key=${k.folder}>${targetDir(i.target, k.installAs)}/ — ${k.files.length} file${k.files.length === 1 ? '' : 's'}, ${bytes(k.bytes)}</code>`)}
        </div>` : null}
        <div class="skp-save">
            <span class="cmd-field-note">Preview expires ${new Date(st.expiresAt).toLocaleTimeString()}.</span>
            <div class="cmd-card-spacer"></div>
            <button class="btn small primary" type="button" disabled=${!chosen.length || i.installing} onClick=${install}>
                ${i.installing ? 'Installing…' : chosen.length ? `Install ${chosen.length}` : 'Tick a skill to install'}</button>
        </div>
    </section>`;
}

function card(i, k) {
    const ticked = Boolean(i.ticked[k.folder]);
    return html`<div key=${k.folder} class=${`skp-card${k.match ? ' match' : ''}${k.problem ? ' bad' : ''}`}>
        <label class="skp-card-head">
            <input type="checkbox" checked=${ticked} disabled=${Boolean(k.problem)}
                onChange=${(e) => { i.ticked[k.folder] = e.target.checked; renderSkills(); }} />
            <span class="skp-card-name">${k.name}</span>
            ${k.match ? html`<span class="skp-chip">the one you searched for</span>` : null}
            <span class="skp-card-path skp-mono">${k.path}</span>
        </label>
        ${k.description ? html`<p class="skp-card-desc">${k.description}</p>` : null}
        ${k.problem ? html`<div class="dash-note error">Cannot be installed: ${k.problem}</div>` : null}
        ${k.installAs !== k.folder && !k.problem ? html`<p class="cmd-field-note">Installs as <code>${k.installAs}</code>.</p>` : null}
        ${k.warnings.length ? html`<div class="skp-warns">${k.warnings.map(w => html`<span key=${w.kind} class="skp-chip warn">${w.text}</span>`)}</div>` : null}
        <details class="skp-card-files">
            <summary>${k.files.length} file${k.files.length === 1 ? '' : 's'}, ${bytes(k.bytes)}</summary>
            ${k.files.map(f => {
                const key = `${k.folder}/${f.path}`;
                const open = i.open === key;
                return html`<div key=${f.path} class="skp-pf">
                    <button type="button" class=${`skp-pf-row${open ? ' on' : ''}`} onClick=${() => { i.open = open ? null : key; renderSkills(); }}>
                        <span class="skp-file-name">${f.path}</span>
                        <span class="skp-file-meta">${bytes(f.bytes)}${f.executable ? ' · exec' : ''}${f.script ? ' · script' : ''}${f.binary ? ' · binary' : ''}</span>
                    </button>
                    ${open ? html`<div class="skp-pf-body">
                        <div class="cmd-field-note skp-mono">sha256 ${f.sha256}</div>
                        ${f.text != null ? html`<pre class="skp-pre">${f.text}</pre>`
                            : html`<div class="dash-note">${f.binary ? 'Binary — not shown.' : 'Too large to show here.'}</div>`}
                    </div>` : null}
                </div>`;
            })}
        </details>
    </div>`;
}
