// The Skills page: every skill on this machine, Claude's and Codex's, as
// files — listed, read, edited, created, thrown away, and imported.
//
// A whole-screen panel like Hooks (PANELS in app.js), opened from the top bar's
// More menu, the palette and `?view=skills`. The bridge side is
// /api/skills (bridge/skills.js, bridge/skill-import.js); docs/plans/24-skills.md
// is the design note.
//
// - **One rail, grouped by runtime and where the skill lives.** Read-only rows
//   (a plugin's, claude.ai's synced ones, Codex's own) say why on the page and
//   offer a copy into your own skills instead of an editor that could not save.
// - **The editor writes one file whole**, with the stamp it was read at; a 409
//   keeps your text and shows what is on disk, the Memory page's rule.
// - **Import is its own view** (web/skills/import.js), because the preview is
//   the point of it and needs the room.
//
// State is `state.skills`. Drawn with Preact the way web/rail.js settled.

import { html, render } from '../vendor/preact.js';
import { del, get, post, put } from '../api.js';
import { dom, toast } from '../dom.js';
import { shortPath } from '../format.js';
import { state } from '../state.js';
import { settingsProject } from '../settings/index.js';
import { ImportView, openImport } from './import.js';

export const skState = () => state.skills;

const RUNTIME_LABEL = { claude: 'Claude Code', codex: 'Codex' };
const SCOPE_LABEL = { user: 'Yours', project: 'This project', plugin: 'Plugins', synced: 'claude.ai', system: 'Codex built-in' };
const SCOPE_ORDER = ['user', 'project', 'plugin', 'synced', 'system'];

function skDir() {
    const s = skState();
    if (s.dir === null) s.dir = settingsProject() || '';
    return s.dir;
}

const projQ = () => (skDir() ? `project=${encodeURIComponent(skDir())}` : '');

/** Read the list. Keeps the selection when it still exists. */
export async function loadSkills() {
    const s = skState();
    if (s.loading) return;
    s.loading = true;
    s.error = null;
    renderSkills();
    try {
        s.data = await get(`/api/skills?${projQ()}`);
        if (s.sel && !s.data.skills.some(k => k.dir === s.sel)) { s.sel = null; s.file = null; }
    } catch (err) {
        s.error = err.message;
    }
    if (!state.settings.projects.length) {
        try { state.settings.projects = (await get('/api/projects')).projects || []; } catch { /* the picker shows the one dir */ }
    }
    s.loading = false;
    renderSkills();
}

/** Anything typed here that leaving would lose. */
export function skillsMayLeave() {
    const s = skState();
    if (s.file && s.file.dirty) {
        // eslint-disable-next-line no-alert
        if (!window.confirm('Discard the changes to this skill file?')) return false;
        s.file = null;
    }
    return true;
}

export function renderSkills() {
    const s = skState();
    if (!s.open) return;
    const n = s.data ? s.data.skills.length : 0;
    dom.skpSub.textContent = s.data
        ? `${n} skill${n === 1 ? '' : 's'} for Claude Code and Codex${skDir() ? ` — ${shortPath(skDir())}` : ''}`
        : 'Every skill Claude Code and Codex can load, as files.';
    render(html`<${SkillsPage} />`, dom.skpBody);
}

function selected() {
    const s = skState();
    return s.data && s.sel ? s.data.skills.find(k => k.dir === s.sel) : null;
}

function SkillsPage() {
    const s = skState();
    if (!s.data) {
        return html`<div class="dash-note${s.error ? ' error' : ''}">${s.error ? `Could not read the skills: ${s.error}` : 'Reading…'}</div>`;
    }
    return html`
        ${skBar()}
        <div class="skp-split">
            ${skRail()}
            <div class="skp-main">
                ${s.mode === 'import' ? html`<${ImportView} />`
                    : s.creating ? createForm()
                        : selected() ? skillDetail(selected())
                            : html`<div class="dash-note">Pick a skill, make a new one, or import one.</div>`}
            </div>
        </div>`;
}

function skBar() {
    const s = skState();
    const here = s.dir || '';
    const dirs = [...new Set([here, ...state.settings.projects.map(p => p.cwd)].filter(Boolean))];
    return html`<div class="skp-bar">
        <label class="settings-pick skp-project">
            <span>Project</span>
            <select class="settings-select" value=${here} onChange=${(e) => {
                if (e.target.value === s.dir) return;
                if (!skillsMayLeave()) { e.target.value = s.dir; return; }
                s.dir = e.target.value;
                s.sel = null; s.file = null;
                loadSkills();
            }}>
                <option value="">No project</option>
                ${dirs.map(d => html`<option key=${d} value=${d}>${shortPath(d)}</option>`)}
            </select>
        </label>
        <label class="settings-pick skp-filter">
            <span>Filter</span>
            <input class="skp-input" type="search" value=${s.filter} placeholder="name or description"
                onInput=${(e) => { s.filter = e.target.value; renderSkills(); }} />
        </label>
        <div class="cmd-card-spacer"></div>
        <button class="btn small tonal" type="button" onClick=${() => {
            if (!skillsMayLeave()) return;
            s.mode = 'browse'; s.creating = { runtime: 'claude', scope: 'user', name: '', description: '' }; renderSkills();
        }}>New skill</button>
        <button class=${`btn small${s.mode === 'import' ? ' primary' : ''}`} type="button" onClick=${() => {
            if (!skillsMayLeave()) return;
            openImport();
        }}>Import…</button>
        <button class="btn small quiet" type="button" onClick=${() => loadSkills()} title="Read the directories again">Refresh</button>
    </div>`;
}

function skRail() {
    const s = skState();
    const f = s.filter.trim().toLowerCase();
    const rows = s.data.skills.filter(k => !f || k.name.toLowerCase().includes(f)
        || (k.description || '').toLowerCase().includes(f) || k.folder.toLowerCase().includes(f));
    const groups = [];
    for (const runtime of ['claude', 'codex']) {
        for (const scope of SCOPE_ORDER) {
            const here = rows.filter(k => k.runtime === runtime && k.scope === scope)
                .sort((a, b) => a.name.localeCompare(b.name));
            if (here.length) groups.push({ key: `${runtime}:${scope}`, runtime, scope, here });
        }
    }
    return html`<nav class="skp-rail" aria-label="Skills">
        ${groups.length ? null : html`<div class="skp-rail-empty">${f ? 'Nothing matches.' : 'No skills yet.'}</div>`}
        ${groups.map(g => html`<div key=${g.key} class="skp-group">
            <div class="skp-rail-lede">${RUNTIME_LABEL[g.runtime]} · ${SCOPE_LABEL[g.scope]}</div>
            ${g.here.map(k => html`<button key=${k.dir} type="button"
                class=${`skp-row${k.dir === s.sel && s.mode !== 'import' && !s.creating ? ' on' : ''}${k.editable ? '' : ' ro'}`}
                title=${k.description || k.name}
                onClick=${() => selectSkill(k.dir)}>
                <span class="skp-row-name">${k.name}</span>
                ${k.plugin ? html`<span class="skp-row-tag">${k.plugin}</span>` : null}
                ${k.editable ? null : html`<svg class="skp-row-lock" width="11" height="11" viewBox="0 0 24 24" fill="none" role="img" aria-label="read-only">
                    <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="2"/>
                    <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="2"/></svg>`}
            </button>`)}
        </div>`)}
    </nav>`;
}

function selectSkill(dir) {
    const s = skState();
    if (dir === s.sel && s.mode !== 'import' && !s.creating) return;
    if (!skillsMayLeave()) return;
    s.mode = 'browse';
    s.creating = null;
    s.sel = dir;
    s.file = null;
    openFile(dir, 'SKILL.md');
}

async function openFile(dir, file) {
    const s = skState();
    if (s.file && s.file.dirty && !skillsMayLeave()) return;
    s.file = { dir, file, loading: true };
    renderSkills();
    try {
        const got = await get(`/api/skills/file?dir=${encodeURIComponent(dir)}&file=${encodeURIComponent(file)}&${projQ()}`);
        if (!s.file || s.file.dir !== dir || s.file.file !== file) return;
        s.file = { ...got, draft: got.text, dirty: false };
    } catch (err) {
        s.file = { dir, file, error: err.message };
    }
    renderSkills();
}

function skillDetail(k) {
    const s = skState();
    const f = s.file;
    return html`<div class="skp-detail">
        <div class="skp-head">
            <h2 class="skp-h">${k.name}</h2>
            <span class="skp-chip">${RUNTIME_LABEL[k.runtime]}</span>
            <span class="skp-chip">${SCOPE_LABEL[k.scope]}${k.plugin ? ` · ${k.plugin}` : ''}</span>
            ${k.hooks ? html`<span class="skp-chip warn" title="Its frontmatter declares hooks, which run while the skill is active">hooks</span>` : null}
            ${k.allowedTools ? html`<span class="skp-chip warn" title="Tools this skill pre-approves">allowed-tools: ${k.allowedTools}</span>` : null}
        </div>
        ${k.description ? html`<p class="skp-desc">${k.description}</p>` : null}
        <button class="skp-path" type="button" title="Show in the file manager"
            onClick=${() => post('/api/fs/open', { path: k.dir, reveal: true }).catch(err => toast(err.message, 'error'))}>${shortPath(k.dir)}</button>
        ${k.editable ? null : html`<div class="dash-note warn skp-ro">
            <p>${k.reason || 'Read-only.'} Copy it into your own skills to change it.</p>
            <div class="skp-ro-acts">
                <button class="btn small" type="button" onClick=${() => copySkill(k, 'claude')}>Copy to my Claude skills</button>
                <button class="btn small" type="button" onClick=${() => copySkill(k, 'codex')}>Copy to my Codex skills</button>
            </div>
        </div>`}
        <div class="skp-files">
            <div class="skp-files-list" role="list">
                ${k.files.map(x => html`<button key=${x.path} type="button" role="listitem"
                    class=${`skp-file${f && f.file === x.path ? ' on' : ''}`}
                    disabled=${!!x.symlink}
                    onClick=${() => openFile(k.dir, x.path)}>
                    <span class="skp-file-name">${x.path}</span>
                    <span class="skp-file-meta">${x.symlink ? 'symlink' : bytes(x.bytes)}${x.executable ? ' · exec' : ''}</span>
                </button>`)}
                ${k.filesTruncated ? html`<div class="skp-file-more">…and more</div>` : null}
            </div>
            <div class="skp-editor">${editor(k, f)}</div>
        </div>
        ${k.editable ? html`<div class="skp-danger">
            <button class="btn small quiet" type="button" onClick=${() => newFile(k)}>New file…</button>
            <div class="cmd-card-spacer"></div>
            <button class="btn small destructive" type="button" onClick=${() => removeSkill(k)}>Delete skill</button>
        </div>` : null}
    </div>`;
}

function editor(k, f) {
    if (!f || f.loading) return html`<div class="dash-note">Reading…</div>`;
    if (f.error) return html`<div class="dash-note error">${f.error}</div>`;
    if (f.binary) return html`<div class="dash-note">${f.file} is a binary file (${bytes(f.size)}) and is not shown.</div>`;
    if (f.truncated) return html`<div class="dash-note">${f.file} is larger than ${bytes(f.maxBytes)} and is not opened here.</div>`;
    const editable = k.editable && f.editable;
    return html`
        ${f.conflict ? html`<div class="dash-note warn skp-conflict">
            <p>${f.conflict.message} Your text is still here; saving again replaces what is on disk.</p>
            ${f.conflict.current && f.conflict.current.text != null ? html`<details><summary>What is on disk now</summary>
                <pre class="skp-pre">${f.conflict.current.text}</pre></details>` : null}
        </div>` : null}
        <textarea class="cmd-area skp-text" spellcheck="false" readonly=${!editable}
            value=${f.draft}
            onInput=${(e) => {
                const was = f.dirty;
                f.draft = e.target.value;
                f.dirty = f.draft !== f.text;
                if (was !== f.dirty) renderSkills();
            }}
            onKeyDown=${(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 's' && editable) { e.preventDefault(); saveFile(); }
            }}></textarea>
        ${editable ? html`<div class="skp-save">
            <span class="cmd-field-note">${f.file} · ${bytes(new Blob([f.draft || '']).size)} of ${bytes(f.maxBytes)}</span>
            <div class="cmd-card-spacer"></div>
            <button class="btn small quiet" type="button" disabled=${!f.dirty || f.saving}
                onClick=${() => { f.draft = f.text; f.dirty = false; f.conflict = null; renderSkills(); }}>Revert</button>
            <button class="btn small primary" type="button" disabled=${!f.dirty || f.saving} onClick=${saveFile}>${f.saving ? 'Saving…' : 'Save'}</button>
        </div>` : null}`;
}

async function saveFile() {
    const s = skState();
    const f = s.file;
    if (!f || !f.dirty || f.saving) return;
    f.saving = true;
    renderSkills();
    try {
        // After a conflict the stamp is the one on disk now: saving again is
        // the person choosing to replace it, having been shown it.
        const stamp = f.conflict ? (f.conflict.current ? f.conflict.current.stamp : null) : f.stamp;
        const got = await put('/api/skills/file', { dir: f.dir, file: f.file, project: skDir(), text: f.draft, stamp });
        s.file = { ...got, draft: got.text, dirty: false };
        toast(`Saved ${f.file}.`, 'ok');
        if (f.file === 'SKILL.md') loadSkills();
    } catch (err) {
        f.saving = false;
        if (err.status === 409) f.conflict = { message: err.message, current: err.data.current || null };
        else toast(`Could not save: ${err.message}`, 'error');
    }
    renderSkills();
}

async function newFile(k) {
    // eslint-disable-next-line no-alert
    const name = window.prompt('New file, relative to the skill (for example references/notes.md):');
    if (!name) return;
    try {
        await put('/api/skills/file', { dir: k.dir, file: name.trim(), project: skDir(), text: '', stamp: null });
        await loadSkills();
        openFile(k.dir, name.trim());
    } catch (err) { toast(`Could not create it: ${err.message}`, 'error'); }
}

async function removeSkill(k) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete ${k.name}? It moves to the skills trash under the bridge's cache, not straight off the disk.`)) return;
    const s = skState();
    try {
        const got = await del(`/api/skills?dir=${encodeURIComponent(k.dir)}&${projQ()}`);
        s.sel = null; s.file = null;
        toast(`Deleted ${k.name}. It is in ${shortPath(got.trashed)}.`, 'ok');
        loadSkills();
    } catch (err) { toast(`Could not delete it: ${err.message}`, 'error'); }
}

async function copySkill(k, runtime) {
    const s = skState();
    try {
        const got = await post('/api/skills/copy', { dir: k.dir, project: skDir(), target: { runtime, scope: 'user' } });
        toast(`Copied to ${shortPath(got.skill.dir)}.`, 'ok');
        s.sel = got.skill.dir; s.file = null;
        await loadSkills();
        openFile(got.skill.dir, 'SKILL.md');
    } catch (err) { toast(`Could not copy it: ${err.message}`, 'error'); }
}

/** Target pickers shared by New skill and Import. */
export function targetPicker(t, onChange) {
    const hasProject = Boolean(skDir());
    const opt = (runtime, scope, label) => html`<label key=${`${runtime}:${scope}`} class="skp-target">
        <input type="radio" name="skp-target" checked=${t.runtime === runtime && t.scope === scope}
            disabled=${scope === 'project' && !hasProject}
            onChange=${() => onChange({ runtime, scope })} />
        <span>${label}</span>
    </label>`;
    return html`<div class="skp-targets" role="radiogroup">
        ${opt('claude', 'user', 'Claude Code — ~/.claude/skills')}
        ${opt('claude', 'project', 'Claude Code — this project’s .claude/skills')}
        ${opt('codex', 'user', 'Codex — $CODEX_HOME/skills')}
        ${opt('codex', 'project', 'Codex — this project’s .agents/skills')}
    </div>`;
}

function createForm() {
    const s = skState();
    const c = s.creating;
    const valid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(c.name);
    return html`<div class="skp-detail skp-create">
        <h2 class="skp-h">New skill</h2>
        <label class="cmd-field"><span class="cmd-field-label">Name</span>
            <input class="skp-input" value=${c.name} placeholder="my-skill" autofocus
                onInput=${(e) => { c.name = e.target.value.trim(); renderSkills(); }} />
            <span class="cmd-field-note">Lower-case letters, digits and hyphens. It is the folder name and the slash name.</span>
        </label>
        <label class="cmd-field"><span class="cmd-field-label">Description</span>
            <input class="skp-input" value=${c.description} placeholder="What it does, and when to use it"
                onInput=${(e) => { c.description = e.target.value; }} />
        </label>
        <div class="cmd-field"><span class="cmd-field-label">Where</span>
            ${targetPicker(c, (t) => { Object.assign(c, t); renderSkills(); })}
        </div>
        <div class="skp-save">
            <div class="cmd-card-spacer"></div>
            <button class="btn small quiet" type="button" onClick=${() => { s.creating = null; renderSkills(); }}>Cancel</button>
            <button class="btn small primary" type="button" disabled=${!valid} onClick=${async () => {
                try {
                    const got = await post('/api/skills', { ...c, project: skDir() });
                    s.creating = null;
                    s.sel = got.skill.dir;
                    await loadSkills();
                    openFile(got.skill.dir, 'SKILL.md');
                } catch (err) { toast(`Could not create it: ${err.message}`, 'error'); }
            }}>Create</button>
        </div>
    </div>`;
}

export function bytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export { skDir };
