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
// - **Each skill has a Safety section**: the bridge's 0–100 score
//   (bridge/skill-safety.js) as a marker on a green→yellow→red bar, and the
//   factors it is made of, each row tinted by its own share. A declared hook is
//   its own row with the command it runs, because that is the one thing in a
//   skill that runs with no model deciding to.
// - **A red skill opens a full-screen warning on Install**, listing why, and
//   only its confirm button sends `confirmedRisk: true`. The bridge refuses a
//   red install without it, so this screen is the way through, not a courtesy.
// - **Large file lists are grouped by top-level folder**, collapsed, and a
//   file not sent inline is fetched from the staging when it is opened.

import { html, useEffect, useRef } from '../vendor/preact.js';
import { del, get, post } from '../api.js';
import { toast } from '../dom.js';
import { shortPath } from '../format.js';
import { bytes, loadSkills, renderSkills, skDir, skState, targetPicker } from './page.js';

const fresh = () => ({
    q: '', searching: false, results: null, searchError: null, searchVia: null,
    source: '', skill: null, staging: false, staged: null, stageError: null,
    ticked: {}, open: null, target: { runtime: 'claude', scope: 'user' }, overwrite: false, installing: false,
    groups: {}, showAll: {}, texts: {}, confirming: false,
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
    Object.assign(i, { source, skill, staging: true, staged: null, stageError: null, ticked: {}, open: null,
        groups: {}, showAll: {}, texts: {}, confirming: false });
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

const tickedRows = (i) => (i.staged ? i.staged.skills.filter(k => i.ticked[k.folder]) : []);
const needsConfirm = (k) => Boolean(k.safety && k.safety.requiresConfirm);

/** Install pressed: a red skill among the ticked ones gets the full-screen warning first. */
function pressInstall() {
    const i = imp();
    if (tickedRows(i).some(needsConfirm)) { i.confirming = true; renderSkills(); return; }
    install(false);
}

async function install(confirmedRisk) {
    const s = skState();
    const i = imp();
    const chosen = Object.keys(i.ticked).filter(k => i.ticked[k]);
    if (!i.staged || !chosen.length) return;
    i.installing = true;
    i.confirming = false;
    renderSkills();
    try {
        const got = await post('/api/skills/import/install', {
            id: i.staged.id, digest: i.staged.digest, skills: chosen, target: i.target, project: skDir(), overwrite: i.overwrite,
            ...(confirmedRisk ? { confirmedRisk: true } : {}),
        });
        toast(`Installed ${got.installed.map(x => x.name).join(', ')} into ${got.root.label}.`, 'ok');
        s.imp = null;
        s.mode = 'browse';
        s.sel = got.installed[0].dir;
        await loadSkills();
        return;
    } catch (err) {
        i.installing = false;
        // The bridge rated something red that this page did not: show the warning rather than the refusal.
        if (err.data && err.data.code === 'unconfirmed') { i.confirming = true; renderSkills(); return; }
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
                    onInput=${(e) => { i.source = e.target.value; renderSkills(); }} />
                <button class="btn small tonal" type="submit" disabled=${i.staging || !i.source.trim()}>${i.staging ? 'Fetching…' : 'Fetch and preview'}</button>
            </form>
            ${i.stageError ? html`<div class="dash-note error">${i.stageError}</div>` : null}
        </section>

        ${i.staged ? preview(i) : null}
        ${i.staged && i.confirming ? html`<${RiskScreen} i=${i} />` : null}
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
            ${chosen.some(needsConfirm) ? html`<div class="dash-note error">${chosen.filter(needsConfirm).map(k => k.name).join(', ')} ${chosen.filter(needsConfirm).length === 1 ? 'is' : 'are'} rated red. Install will ask you to confirm first.</div>` : null}
            ${chosen.map(k => html`<code key=${k.folder}>${targetDir(i.target, k.installAs)}/ — ${k.files.length} file${k.files.length === 1 ? '' : 's'}, ${bytes(k.bytes)}</code>`)}
        </div>` : null}
        <div class="skp-save">
            <span class="cmd-field-note">Preview expires ${new Date(st.expiresAt).toLocaleTimeString()}.</span>
            <div class="cmd-card-spacer"></div>
            <button class="btn small primary" type="button" disabled=${!chosen.length || i.installing} onClick=${pressInstall}>
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
        ${k.safety ? safetySection(k)
            : k.warnings.length ? html`<div class="skp-warns">${k.warnings.map(w => html`<span key=${w.kind} class="skp-chip warn">${w.text}</span>`)}</div>` : null}
        <details class="skp-card-files">
            <summary>${k.files.length} file${k.files.length === 1 ? '' : 's'}, ${bytes(k.bytes)}</summary>
            ${fileList(i, k)}
        </details>
    </div>`;
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const LEVEL_LABEL = { green: 'Low', yellow: 'Look before you install', red: 'High — asks you to confirm' };

/**
 * A point on the green→yellow→red scale as a CSS colour, from the theme's own
 * tokens: 0 is --green, 0.5 --yellow, 1 --red, mixed in between.
 */
function scaleColour(t) {
    const x = Math.max(0, Math.min(1, t));
    if (x <= 0.5) return `color-mix(in oklab, var(--yellow) ${Math.round(x * 200)}%, var(--green))`;
    return `color-mix(in oklab, var(--red) ${Math.round((x - 0.5) * 200)}%, var(--yellow))`;
}

/**
 * A factor's tint. A row is coloured by its own contribution, on a scale where
 * 30 points is fully red: a hook (60) is red, 54 scripts (20) orange, a
 * 40 MB asset library (15) yellow, and a factor that adds nothing is green.
 */
const factorColour = (c) => scaleColour(c / 30);

/** The score's place on the bar: the bar's stops sit where the levels change. */
const scoreColour = (score) => scaleColour(score < 25 ? (score / 25) * 0.4 : score < 60 ? 0.4 + ((score - 25) / 35) * 0.45 : 0.85 + ((score - 60) / 40) * 0.15);

function safetySection(k) {
    const sf = k.safety;
    const rows = sf.factors.filter(f => f.factor !== 'hooks');
    const live = rows.filter(f => f.contribution > 0);
    const quiet = rows.filter(f => f.contribution === 0);
    return html`<div class=${`skp-safety ${sf.level}`}>
        <div class="skp-safety-head">
            <span class="skp-safety-h">Safety</span>
            <span class="skp-safety-level" style=${`color: ${scoreColour(sf.score)}`}>${sf.score} / 100 · ${LEVEL_LABEL[sf.level]}</span>
        </div>
        <div class="skp-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${sf.score}
            aria-label=${`Safety score ${sf.score} of 100, ${sf.level}`}>
            <div class="skp-meter-bar"></div>
            <span class="skp-meter-tick" style="left: 25%"></span>
            <span class="skp-meter-tick" style="left: 60%"></span>
            <span class="skp-meter-mark" style=${`left: ${sf.score}%; --c: ${scoreColour(sf.score)}`}></span>
        </div>
        ${sf.hooks.length ? hookRows(sf) : null}
        <div class="skp-factors">
            ${live.map(f => factorRow(f))}
        </div>
        ${quiet.length ? html`<div class="skp-factors-quiet">Nothing from: ${quiet.map(f => f.label.toLowerCase()).join(', ')}.</div>` : null}
    </div>`;
}

function factorRow(f) {
    return html`<div key=${f.factor} class="skp-factor" style=${`--c: ${factorColour(f.contribution)}`}>
        <span class="skp-factor-dot"></span>
        <span class="skp-factor-label">${f.label}</span>
        <span class="skp-factor-note">${f.note}</span>
        <span class="skp-factor-pts">+${f.contribution}</span>
    </div>`;
}

function hookRows(sf) {
    const f = sf.factors.find(x => x.factor === 'hooks');
    return html`<div class="skp-hook" style=${`--c: ${factorColour(f.contribution)}`}>
        <div class="skp-hook-head">
            <span class="skp-factor-dot"></span>
            <span class="skp-hook-h">${sf.hooks.length === 1 ? 'Declares a hook' : `Declares ${sf.hooks.length} hooks`}</span>
            <span class="skp-hook-why">runs on its own, in every session that loads this skill</span>
            <span class="skp-factor-pts">+${f.contribution}</span>
        </div>
        ${sf.hooks.map((h, n) => html`<div key=${n} class="skp-hook-one">
            <div class="skp-hook-meta">
                <code>${h.event || 'event not read'}</code>
                ${h.matcher ? html`<span>matching <code>${h.matcher}</code></span>` : null}
                ${h.timeout != null ? html`<span>timeout ${h.timeout} s</span>` : null}
                ${h.type && h.type !== 'command' ? html`<span>type <code>${h.type}</code></span>` : null}
            </div>
            <pre class="skp-pre skp-hook-cmd">${h.command || 'No command could be read from this hook; the frontmatter is below.'}</pre>
        </div>`)}
        ${sf.hooksText && sf.hooks.some(h => !h.event || !h.type) ? html`<pre class="skp-pre skp-hook-cmd">${sf.hooksText}</pre>` : null}
    </div>`;
}

/** The full-screen warning a red skill gets between Install and the install. */
function RiskScreen({ i }) {
    // Focus starts on the way back, so Enter is never the install.
    const back = useRef(null);
    useEffect(() => { if (back.current) back.current.focus(); }, []);
    const red = tickedRows(i).filter(needsConfirm);
    const others = tickedRows(i).length - red.length;
    const cancel = () => { i.confirming = false; renderSkills(); };
    return html`<div class="skp-risk" role="alertdialog" aria-modal="true" aria-labelledby="skp-risk-h"
        onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
        <div class="skp-risk-inner">
            <div class="skp-risk-badge">High risk</div>
            <h2 id="skp-risk-h" class="skp-risk-h">${red.length === 1 ? `${red[0].name} is rated red` : `${red.length} skills are rated red`}</h2>
            <p class="skp-risk-lede">Installing puts these files where every ${i.target.runtime === 'codex' ? 'Codex' : 'Claude Code'} session reads them.
                Read what each one will run before you go on.${others ? ` ${others} other ticked skill${others === 1 ? ' is' : 's are'} not red and will install with ${others === 1 ? 'it' : 'them'}.` : ''}</p>
            ${red.map(k => html`<section key=${k.folder} class="skp-risk-skill">
                <div class="skp-risk-skill-head">
                    <span class="skp-card-name">${k.name}</span>
                    <span class="skp-card-path skp-mono">${targetDir(i.target, k.installAs)}/</span>
                    <span class="skp-safety-level" style=${`color: ${scoreColour(k.safety.score)}`}>${k.safety.score} / 100</span>
                </div>
                <ul class="skp-risk-list">
                    ${k.safety.hooks.map((h, n) => html`<li key=${`h${n}`} class="skp-risk-hook">
                        <div><strong>Runs a command on ${h.event ? html`<code>${h.event}</code>` : 'an event'}${h.matcher ? html` for <code>${h.matcher}</code>` : null}</strong>${h.timeout != null ? `, for up to ${h.timeout} s` : ''}, every time, without asking:</div>
                        <pre class="skp-pre skp-hook-cmd">${h.command || k.safety.hooksText || '(unreadable)'}</pre>
                    </li>`)}
                    ${k.safety.factors.filter(f => f.factor !== 'hooks' && f.contribution > 0).map(f => html`<li key=${f.factor} style=${`--c: ${factorColour(f.contribution)}`}>
                        <span class="skp-factor-dot"></span> <strong>${f.label}:</strong> ${f.note}
                    </li>`)}
                </ul>
            </section>`)}
            <div class="skp-risk-acts">
                <button class="btn tonal" type="button" ref=${back} onClick=${cancel}>Go back</button>
                <button class="btn destructive" type="button" disabled=${i.installing} onClick=${() => install(true)}>
                    I have read this — install ${red.length === 1 ? red[0].name : `${red.length} red skills`}</button>
            </div>
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Files, grouped by top-level folder
// ---------------------------------------------------------------------------

const GROUP_PAGE = 200;

function groupsOf(files) {
    const by = new Map();
    for (const f of files) {
        const slash = f.path.indexOf('/');
        const dir = slash < 0 ? '' : f.path.slice(0, slash);
        if (!by.has(dir)) by.set(dir, { dir, files: [], bytes: 0, scripts: 0, binaries: 0, executables: 0 });
        const g = by.get(dir);
        g.files.push(f);
        g.bytes += f.bytes;
        if (f.script) g.scripts += 1;
        if (f.binary) g.binaries += 1;
        if (f.executable) g.executables += 1;
    }
    // Loose files at the top, then folders by name.
    return [...by.values()].sort((a, b) => (a.dir === '' ? -1 : b.dir === '' ? 1 : a.dir.localeCompare(b.dir)));
}

function fileList(i, k) {
    const groups = groupsOf(k.files);
    // A small skill is just its files; folders appear once there is something to fold.
    if (k.files.length <= 30) return k.files.map(f => fileRow(i, k, f, f.path));
    return groups.map((g) => {
        const key = `${k.folder}\n${g.dir}`;
        const open = Boolean(i.groups[key]);
        const all = Boolean(i.showAll[key]);
        const shown = all ? g.files : g.files.slice(0, GROUP_PAGE);
        const meta = [`${g.files.length} file${g.files.length === 1 ? '' : 's'}`, bytes(g.bytes),
            g.scripts ? `${g.scripts} script${g.scripts === 1 ? '' : 's'}` : null,
            g.executables ? `${g.executables} exec` : null,
            g.binaries ? `${g.binaries} binary` : null].filter(Boolean).join(' · ');
        return html`<div key=${g.dir || '(top)'} class="skp-fg">
            <button type="button" class=${`skp-fg-row${open ? ' on' : ''}`} aria-expanded=${open}
                onClick=${() => { i.groups[key] = !open; renderSkills(); }}>
                <span class="skp-fg-caret">${open ? '▾' : '▸'}</span>
                <span class="skp-file-name">${g.dir ? `${g.dir}/` : 'Top level'}</span>
                <span class="skp-file-meta">${meta}</span>
            </button>
            ${open ? html`<div class="skp-fg-body">
                ${shown.map(f => fileRow(i, k, f, g.dir ? f.path.slice(g.dir.length + 1) : f.path))}
                ${shown.length < g.files.length ? html`<button type="button" class="skp-file-more skp-link"
                    onClick=${() => { i.showAll[key] = true; renderSkills(); }}>Show all ${g.files.length}</button>` : null}
            </div>` : null}
        </div>`;
    });
}

async function fetchText(i, k, f, key) {
    i.texts[key] = { loading: true };
    renderSkills();
    try {
        const got = await get(`/api/skills/import/${encodeURIComponent(i.staged.id)}/file?skill=${encodeURIComponent(k.folder)}&path=${encodeURIComponent(f.path)}`);
        i.texts[key] = { text: got.text, truncated: got.truncated };
    } catch (err) {
        i.texts[key] = { error: err.message };
    }
    renderSkills();
}

function fileRow(i, k, f, label) {
    const key = `${k.folder}/${f.path}`;
    const open = i.open === key;
    const toggle = () => {
        i.open = open ? null : key;
        if (!open && f.text == null && f.viewable && !i.texts[key]) { fetchText(i, k, f, key); return; }
        renderSkills();
    };
    const fetched = i.texts[key];
    let body = null;
    if (open) {
        let content;
        if (f.text != null) content = html`<pre class="skp-pre">${f.text}</pre>`;
        else if (fetched && fetched.text != null) content = html`<pre class="skp-pre">${fetched.text}</pre>`;
        else if (fetched && fetched.loading) content = html`<div class="dash-note">Reading…</div>`;
        else if (fetched && fetched.error) content = html`<div class="dash-note error">${fetched.error}</div>`;
        else content = html`<div class="dash-note">${f.binary ? 'Binary — not shown.' : 'Over 256 KB — too large to show here.'}</div>`;
        body = html`<div class="skp-pf-body">
            <div class="cmd-field-note skp-mono">sha256 ${f.sha256}</div>
            ${content}
        </div>`;
    }
    return html`<div key=${f.path} class="skp-pf">
        <button type="button" class=${`skp-pf-row${open ? ' on' : ''}`} onClick=${toggle}>
            <span class="skp-file-name">${label}</span>
            <span class="skp-file-meta">${bytes(f.bytes)}${f.executable ? ' · exec' : ''}${f.script ? ' · script' : ''}${f.binary ? ' · binary' : ''}</span>
        </button>
        ${body}
    </div>`;
}
