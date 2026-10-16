// The Hooks page: every hook that can run in a project, in one place, and the
// editor for the ones in a settings file.
//
// A whole-screen panel like Analytics (see PANELS in app.js), opened from the
// top bar, the palette, `?view=hooks`, and the link Settings › Claude Code
// leaves where the editor used to be. What it adds to that editor, and why it
// needed a page to do it:
//
// - **A rail of events.** Thirty-odd events, most of them empty, is a list the
//   Settings row could only offer as a select. Here every event is a row with a
//   count of what runs on it from *every* source, so "what fires on
//   SessionStart?" is one click, not a hunt through four files and a plugin.
// - **Every source.** The settings chain (claude-config), and the hooks
//   Settings never showed — enabled plugins, skills and agents
//   (/api/claude-config/hook-sources). Read-only: those belong to the plugin or
//   to the skill's author.
// - **The script a hook runs**, opened under the hook (script.js), and
//   **recipes** that add a hook and its script together (recipes.js).
//
// State is `state.hooks`, and it is the only place a hooks draft lives. It
// keeps the field names the editor had under `state.claudeCfg` (`hooksDraft`,
// `hooksSeed`, …) so the move was a change of owner, not of shape. The draft
// survives the panel closing — closing is covering, as every panel here is —
// and is only asked about when the file it belongs to changes: another
// project, or another scope.

import { html, render } from '../vendor/preact.js';
import { get, put } from '../api.js';
import { dom, toast } from '../dom.js';
import { shortPath } from '../format.js';
import { state } from '../state.js';
import { showHooks } from '../app.js';
import { CLAUDE_SCOPES } from '../settings/claude-config.js';
import { openSettingsAt, renderSettings, settingsProject } from '../settings/index.js';
import { HooksEditor, hkClearDraft, hkDraft, hkEditable } from './editor.js';
import { RecipePicker } from './recipes.js';
import { scriptMayLeave } from './script.js';

export const hkState = () => state.hooks;

/** The file the current scope writes, out of what the bridge reported. */
export function hkTargetRow() {
    const s = hkState();
    if (!s.data) return null;
    return s.data.files.find(f => f.scope === s.scope && f.target) || null;
}

/** The directory the page is about, settling on Settings' answer the first time. */
function hkDir() {
    const s = hkState();
    if (s.dir === null) s.dir = settingsProject() || '';
    return s.dir;
}

/**
 * Read the chain and the other sources, together.
 *
 * A clean draft reseeds from what was just read; a dirty one is kept, and the
 * editor draws its own banner if the file moved under it — the rule
 * loadClaudeConfig() has always had, for the same bug.
 */
export async function loadHooks() {
    const s = hkState();
    if (s.loading) return;
    s.loading = true;
    s.error = null;
    renderHooks();
    const dir = hkDir();
    const q = dir ? `?cwd=${encodeURIComponent(dir)}` : '';
    const [cfg, sources] = await Promise.allSettled([
        get(`/api/claude-config${q}`),
        get(`/api/claude-config/hook-sources${q}`),
    ]);
    if (cfg.status === 'fulfilled') {
        s.data = cfg.value;
        if (!s.hooksDirty) hkClearDraft(s);
        if (!hkTargetRow() && !s.data.files.some(f => f.scope === s.scope)) s.scope = 'user';
        // A reseeded draft mints new keys, and the open script hangs off one:
        // find the hook that runs it again, or the pane would vanish the
        // moment its own save was broadcast back.
        if (s.script) {
            const want = s.script.path;
            const hit = hkDraft().flatMap(ev => ev.groups.flatMap(g => g.hooks))
                .find(h => h._script && (h._script.path === want || h._script.file === want));
            if (hit) s.script.k = hit._k;
        }
    } else {
        s.data = null;
        s.error = cfg.reason.message;
    }
    // The other sources are a convenience: if they fail, the editor still works.
    s.sources = sources.status === 'fulfilled' ? sources.value : null;
    s.sourcesError = sources.status === 'rejected' ? sources.reason.message : null;
    if (!state.settings.projects.length) {
        try { state.settings.projects = (await get('/api/projects')).projects || []; } catch { /* the picker shows the one dir */ }
    }
    s.loading = false;
    renderHooks();
}

/** Anything typed on this page that a change of file would lose, or the reader said to drop it. */
export function hooksMayLeave() {
    const s = hkState();
    if (s.hooksDirty) {
        // eslint-disable-next-line no-alert
        if (!window.confirm('Discard the hooks you have edited?')) return false;
        hkClearDraft(s);
    }
    if (!scriptMayLeave()) return false;
    s.script = null;
    return true;
}

/**
 * Open the page on a particular file — what Settings' link does, so the page
 * opens on the project and scope Settings was showing. Asks first when that
 * means leaving a draft for another file.
 */
export function openHooksAt({ dir, scope } = {}) {
    const s = hkState();
    const moving = (dir !== undefined && dir !== s.dir) || (scope && scope !== s.scope);
    if (!moving || !s.data || hooksMayLeave()) {
        if (dir !== undefined && dir !== s.dir) { s.dir = dir; s.data = null; }
        if (scope) s.scope = scope;
    }
    showHooks(true);
}

/** Leave for the JSON tab in Settings, on the same file. */
export function hkJsonLink(label) {
    return html`<button class="linkish" type="button" onClick=${() => {
        const s = hkState();
        const c = state.claudeCfg;
        // Only when Settings has nothing typed of its own: its JSON draft is
        // somebody's work, and the JSON tab would otherwise open on it.
        if (!c.dirty) {
            state.settings.project = s.dir || state.settings.project;
            c.scope = s.scope;
            c.tab = 'raw';
            c.data = null;
        }
        openSettingsAt('claude');
        renderSettings();
    }}>${label}</button>`;
}

export function renderHooks() {
    const s = hkState();
    if (!s.open) return;
    const file = hkTargetRow() || (s.data && s.data.files.find(f => f.scope === s.scope));
    dom.hkpSub.textContent = file
        ? `${CLAUDE_SCOPES[s.scope] || s.scope} — ${shortPath(file.file)}${file.exists ? '' : ' (not created yet)'}`
        : 'What runs when Claude Code does something, from every file and plugin that can add one.';
    render(html`<${HooksPage} />`, dom.hkpBody);
}

// ── the page ─────────────────────────────────────────────────────────────

function HooksPage() {
    const s = hkState();
    if (!s.data) {
        return html`<div class="dash-note${s.error ? ' error' : ''}">${s.error
            ? `Could not read the settings: ${s.error}` : 'Reading…'}</div>`;
    }
    const counts = hkCounts();
    return html`
        ${hkBar()}
        <div class="hkp-split">
            ${hkRail(counts)}
            <div class="hkp-main">
                ${s.recipes ? html`<${RecipePicker} />` : null}
                ${hkEventHead(s.event)}
                <${HooksEditor} event=${s.event} />
                ${hkSources(s.event)}
            </div>
        </div>`;
}

/** Project, scope, and the page's two actions. */
function hkBar() {
    const s = hkState();
    const here = s.dir || '';
    const dirs = [...new Set([here, ...state.settings.projects.map(p => p.cwd)].filter(Boolean))];
    const off = s.data.effective.disableAllHooks;
    const target = hkTargetRow();
    const ownOff = target && target.values && target.values.disableAllHooks === true;
    return html`<div class="hkp-bar">
        <label class="settings-pick hkp-project">
            <span>Project</span>
            <select class="settings-select" value=${here} onChange=${(e) => {
                const next = e.target.value;
                if (next === s.dir) return;
                if (!hooksMayLeave()) { e.target.value = s.dir; return; }
                s.dir = next;
                loadHooks();
            }}>
                ${dirs.length
                    ? dirs.map(d => html`<option key=${d} value=${d}>${shortPath(d)}</option>`)
                    : html`<option value="">No projects yet</option>`}
            </select>
        </label>
        <div class="cfg-tabs hkp-scopes" role="tablist">
            ${s.data.files.map(f => html`<button key=${f.scope} class=${`cfg-tab${f.scope === s.scope ? ' on' : ''}`}
                type="button" role="tab" aria-selected=${f.scope === s.scope ? 'true' : 'false'}
                title=${f.readonly ? 'An administrator’s file — read-only' : f.file}
                onClick=${() => {
                    if (f.scope === s.scope || !hooksMayLeave()) return;
                    s.scope = f.scope;
                    // A clean draft too: it was seeded from the other file.
                    hkClearDraft(s);
                    renderHooks();
                }}>${CLAUDE_SCOPES[f.scope]}${
                    !f.exists ? html`<span class="cfg-tab-tag">none</span>` : null}${
                    f.readonly ? html`<span class="cfg-tab-tag">read-only</span>` : null}</button>`)}
        </div>
        <div class="cmd-card-spacer"></div>
        ${hkEditable() ? html`<label class="hk-check hkp-off" title=${off && off.value === true && !ownOff
            ? `Already off — set in ${CLAUDE_SCOPES[off.scope] || 'another file'}` : 'disableAllHooks in this file'}>
            <span class="settings-check">
                <input type="checkbox" checked=${!!ownOff} disabled=${!!s.saving}
                    onChange=${(e) => saveDisableAll(e.target.checked)} />
                <span class="settings-box"></span>
            </span>
            <span class="cmd-field-label">Turn every hook off</span>
        </label>` : null}
        <button class=${`btn small${s.recipes ? ' on' : ''}`} type="button" aria-pressed=${s.recipes ? 'true' : 'false'}
            onClick=${() => { s.recipes = !s.recipes; renderHooks(); }}>Recipes</button>
    </div>`;
}

/**
 * `disableAllHooks` in this file — a scalar, so no stamp and no review: it
 * turns things off, never on something new. Cleared rather than written
 * `false`, so the file is left as it would be had nobody touched it.
 */
async function saveDisableAll(on) {
    const s = hkState();
    s.saving = true;
    renderHooks();
    try {
        const answer = await put('/api/claude-config', {
            scope: s.scope, cwd: s.dir || '', patch: { disableAllHooks: on ? true : null },
        });
        s.data = answer.config;
        if (!s.hooksDirty) hkClearDraft(s);
        toast(on ? 'Every hook is off for new sessions.' : 'Hooks are back on for new sessions.', 'ok');
    } catch (err) {
        toast(`Could not save that: ${err.message}`, 'error');
    }
    s.saving = false;
    renderHooks();
}

/**
 * How many hooks each event has, and from where.
 *
 * `here` is this file's draft, which is what the editor shows; `other` is
 * everything else that would run — the other settings files, enabled plugins,
 * and skills and agents (which count once per event they name, since their
 * matchers are not parsed). A disabled plugin's hooks are not counted: they do
 * not run, and a rail that counted them would answer the question wrongly.
 */
function hkCounts() {
    const s = hkState();
    const out = new Map();
    const at = (e) => {
        if (!out.has(e)) out.set(e, { here: 0, other: 0 });
        return out.get(e);
    };
    const target = hkTargetRow() || s.data.files.find(f => f.scope === s.scope);
    if (target && target.parsed) {
        for (const ev of hkDraft()) at(ev.event).here += ev.groups.reduce((n, g) => n + g.hooks.length, 0);
    }
    for (const h of (s.data.hooks || [])) if (h.scope !== s.scope) at(h.event).other += 1;
    const src = s.sources;
    if (src) {
        for (const p of src.plugins) if (p.enabled) for (const h of p.hooks) at(h.event).other += 1;
        for (const x of [...src.skills, ...src.agents]) {
            if (x.enabled === false) continue;
            for (const e of x.events) at(e).other += 1;
        }
    }
    return out;
}

function hkRail(counts) {
    const s = hkState();
    const catalogue = s.data.hookEvents || [];
    const known = new Set(catalogue.map(e => e.name));
    const names = [...catalogue.map(e => e.name), ...[...counts.keys()].filter(e => !known.has(e))];
    const total = (e) => { const c = counts.get(e); return c ? c.here + c.other : 0; };
    const used = names.filter(e => total(e));
    const quiet = names.filter(e => !total(e));
    const all = [...counts.values()].reduce((n, c) => n + c.here + c.other, 0);
    const row = (name, label, n, here) => html`<button key=${name || '*'} type="button"
        class=${`hkp-ev${s.event === name ? ' on' : ''}${here ? ' has-here' : ''}${name && !known.has(name) ? ' unknown' : ''}`}
        aria-current=${s.event === name ? 'true' : null}
        title=${name ? ((catalogue.find(e => e.name === name) || {}).blurb || 'An event this page does not know') : null}
        onClick=${() => { s.event = name; renderHooks(); }}>
        <span class="hkp-ev-name">${label}</span>
        ${n ? html`<span class="hkp-ev-n">${n}</span>` : null}
    </button>`;
    return html`<nav class="hkp-rail" aria-label="Events">
        ${row(null, 'All events', all, false)}
        ${used.length ? html`<div class="hkp-rail-lede">With hooks</div>` : null}
        ${used.map(e => row(e, e, total(e), (counts.get(e) || {}).here))}
        <div class="hkp-rail-lede">${used.length ? 'Nothing yet' : 'Events'}</div>
        ${quiet.map(e => row(e, e, 0, false))}
    </nav>`;
}

/** What the selected event is, in a sentence, and what its matcher matches. */
function hkEventHead(event) {
    const s = hkState();
    if (!event) {
        return html`<div class="hkp-head">
            <h2 class="hkp-h">All events</h2>
            <p class="cmd-field-note">${'Each event holds groups; a group’s matcher picks what it fires for, and its '
                + 'hooks run together. Hooks from every file below run too — they add up, nothing overrides.'}</p>
        </div>`;
    }
    const info = (s.data.hookEvents || []).find(e => e.name === event);
    const matcher = !info ? null
        : info.matcher === 'tool' ? 'The matcher is a tool name, a list like Edit|Write, or a regular expression.'
            : info.matcher === 'values' ? html`${'The matcher picks among: '}${(info.values || [])
                .flatMap((v, i) => [i ? ', ' : '', html`<code key=${v}>${v}</code>`])}${'.'}`
                : info.matcher === 'free' ? 'The matcher is matched against a name — see the docs for this event.'
                    : 'This event takes no matcher: its hooks run every time.';
    return html`<div class="hkp-head">
        <h2 class="hkp-h"><code>${event}</code></h2>
        <p class="hkp-blurb">${info ? info.blurb.replace(/`/g, '') : 'An event this page does not know. Claude Code may still.'}</p>
        ${matcher ? html`<p class="cmd-field-note">${matcher}</p>` : null}
    </div>`;
}

/**
 * The hooks no settings file holds: plugins, skills and agents. Read-only, and
 * said so — editing a plugin's copy is an edit its next update throws away.
 */
function hkSources(event) {
    const s = hkState();
    const src = s.sources;
    if (!src) {
        return s.sourcesError
            ? html`<p class="cmd-field-note">${`Plugins, skills and agents could not be read: ${s.sourcesError}`}</p>`
            : null;
    }
    const plugins = src.plugins.flatMap(p => p.hooks
        .filter(h => !event || h.event === event)
        .map(h => ({ ...h, plugin: p })));
    const broken = src.plugins.filter(p => p.problem);
    const fm = [...src.skills.map(x => ({ ...x, kind: 'skill' })), ...src.agents.map(x => ({ ...x, kind: 'agent' }))]
        .filter(x => !event || x.events.includes(event));
    if (!plugins.length && !fm.length && !broken.length) return null;

    return html`<div class="hkp-sources">
        ${plugins.length ? html`<div class="cfg-inherit">
            <div class="cfg-inherit-head">From plugins — read-only, and they add to yours</div>
            ${plugins.map((h, n) => html`<div key=${n} class=${`cfg-inherit-row hk-inherit-row${h.plugin.enabled ? '' : ' is-off'}`}
                title=${h.plugin.file}>
                <span class="hk-inherit-scope">${h.plugin.name}</span>${
                    ` ${event ? '' : `${h.event} `}${h.matcher ? `· ${h.matcher} ` : ''}→ ${h.target || h.type || '—'}`}${
                    h.plugin.enabled ? null : html` <span class="cfg-tab-tag">plugin off — does not run</span>`}${
                    h.script && !h.script.exists ? html`<span class="cfg-script bad"> script missing</span>` : null}
            </div>`)}
        </div>` : null}
        ${broken.map(p => html`<p key=${p.id} class="cmd-field-bad">${`${p.name}: hooks.json ${p.problem}`}</p>`)}
        ${fm.length ? html`<div class="cfg-inherit">
            <div class="cfg-inherit-head">From skills and agents — while one is in use</div>
            <p class="cmd-field-note hkp-fm-note">${'A skill’s hooks run once it is invoked, for the rest of the '
                + 'session; an agent’s while it runs (its Stop is a SubagentStop). Shown as written: the page reads '
                + 'which events they name, not their matchers.'}</p>
            ${fm.map(x => html`<details key=${x.file} class=${`hkp-fm${x.enabled === false ? ' is-off' : ''}`}>
                <summary>
                    <span class="hk-inherit-scope">${x.kind}</span>
                    <strong>${x.name}</strong>
                    <span class="hkp-fm-origin">${x.origin.startsWith('plugin:') ? x.origin.slice(7) : x.origin}</span>
                    ${event ? null : html`<code class="hkp-fm-events">${x.events.join(', ')}</code>`}
                    ${x.enabled === false ? html`<span class="cfg-tab-tag">plugin off</span>` : null}
                </summary>
                <button class="hkp-fm-path" type="button" title="Copy this path"
                    onClick=${() => navigator.clipboard.writeText(x.file).then(() => toast('Path copied.'))}
                    >${shortPath(x.file)}</button>
                <pre class="hkp-fm-yaml">${x.yaml}</pre>
            </details>`)}
        </div>` : null}
    </div>`;
}
