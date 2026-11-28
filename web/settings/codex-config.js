// The Codex group: the keys of `~/.codex/config.toml` worth a control, read and
// written through Codex itself (bridge/codex-config.js — this app never touches
// the TOML). Drawn only when Codex is installed.
//
// Preact, saving one key on change, like the groups built from rows. Three
// things differ from them and from the Claude Code group:
//
// - **There is one file to write**, the user's. A project's `.codex/config.toml`
//   can override it; the row then says which file wins, and still edits yours.
// - **"Not set" is a choice.** Picking it removes the key, so Codex's own
//   default applies again. The control says what is in force meanwhile.
// - **Every read and write starts a Codex process**, about a second, so the
//   group draws what it last read while it asks again.
//
// The model list is `GET /api/models?runtime=codex`: what the account can use,
// never a list written down here.
//
// Imports from app.js's side the way every module in web/settings/ does: nothing
// here reads another module's binding while evaluating.

import { html } from '../vendor/preact.js';
import { get, put } from '../api.js';
import { toast } from '../dom.js';
import { state } from '../state.js';
import { openHooksAt } from '../hooks/page.js';
import { copyPath } from './claude-config.js';
import { renderSettings, settingsProject } from './index.js';

/** Is there a Codex on this machine? What every Codex surface here waits on. */
export const codexInstalled = () => !!(state.codexVersion && state.codexVersion.installed);

const cc = () => state.codexCfg;

// Only the newest read may land: the project selector can move while one runs.
let seq = 0;

export async function loadCodexConfig() {
    if (!codexInstalled()) return;
    const s = cc();
    const mine = ++seq;
    const dir = settingsProject();
    s.loading = true;
    s.error = null;
    renderSettings();
    const [config, models] = await Promise.allSettled([
        get(`/api/codex-config${dir ? `?cwd=${encodeURIComponent(dir)}` : ''}`),
        get('/api/models?runtime=codex'),
    ]);
    if (mine !== seq) return;
    if (config.status === 'fulfilled') s.data = config.value;
    else { s.data = null; s.error = config.reason.message; }
    s.models = models.status === 'fulfilled' ? models.value : null;
    s.loading = false;
    renderSettings();
}

async function save(key, value) {
    const s = cc();
    if (s.saving) return;
    s.saving = key;
    renderSettings();
    try {
        const answer = await put('/api/codex-config', { key, value, cwd: settingsProject() });
        seq++;          // a read still running was made before this write
        s.data = answer;
        s.loading = false;
        if (answer.overridden) toast(answer.overridden, 'warn', 7000);
    } catch (err) {
        toast(`Could not save that: ${err.message}`, 'error');
    }
    s.saving = null;
    renderSettings();
}

export function renderCodexConfig() {
    return html`<${Cards} key="codex">${cards()}</${Cards}>`;
}

// The vendored Preact has no Fragment export, and the group is several sections.
function Cards({ children }) {
    return children;
}

function cards() {
    const s = cc();
    const data = s.data && s.data.installed !== false ? s.data : null;
    let tail = null;
    if (s.error) tail = html`<div class="settings-error">${`Could not read Codex’s settings: ${s.error}`}</div>`;
    else if (!data) tail = html`<div class="settings-empty">Asking Codex…</div>`;

    const head = html`<section key="codex" class="settings-group" id="set-g-codex">
        <h2 class="settings-group-title">Codex</h2>
        <p class="settings-group-note">${'The settings '}<code>codex</code>${' itself reads. Codex does the '
            + 'reading and the writing, so the file keeps your comments and layout.'}</p>
        ${data ? html`<div class="settings-file">
            <span class="settings-file-lede">Writing to</span>
            <button class="settings-file-path" type="button" title="Copy this path"
                onClick=${() => copyPath(data.file)}>${data.file}</button>
            ${s.saving ? html`<span class="settings-file-tag">saving…</span>` : null}
            ${s.loading ? html`<span class="settings-file-tag">reading…</span>` : null}
        </div>` : null}
        <p class="cfg-reach"><strong>A running session keeps what it started with.</strong>${
            ' A change here reaches Codex sessions started or woken after it.'}</p>
        ${data ? projectNote(data) : null}
        ${tail}
    </section>`;
    if (!data) return [head];

    return [
        head,
        ...data.groups.map(g => html`<section key=${`codex-${g.title}`} class="settings-group cfg-sub"
            id=${`set-g-codex-${g.title.toLowerCase()}`}>
            <h3 class="settings-group-title">${g.title}</h3>
            ${g.keys.map(row)}
        </section>`),
        restCard(data),
    ];
}

/** A project's own config.toml, which this page reads and never writes. */
function projectNote(data) {
    const layers = data.projectLayers || [];
    if (!layers.length) return null;
    return layers.map(l => html`<p key=${l.file} class="settings-group-note">${'This project has its own '}
        <code>${l.file}</code>${l.disabled
            ? `, which Codex is ignoring: ${l.disabled}`
            : '. Where it sets a key, it wins in this project; it is edited by hand.'}</p>`);
}

const shown = (v) => (v === null || v === undefined ? null
    : typeof v === 'object' ? JSON.stringify(v) : String(v));

function row(r) {
    const s = cc();
    const set = r.user !== null && r.user !== undefined;
    // Something other than your file decides it: a project's, or an administrator's.
    const over = r.origin && r.origin.type !== 'user' && r.origin.type !== 'packagedDefaults';
    return html`<div key=${r.key} class="settings-row">
        <div class="settings-row-text">
            <div class="settings-row-label">${r.label}<code class="cfg-path">${r.key}</code></div>
            ${r.note ? html`<div class="settings-row-note">${r.note}</div>` : null}
            ${over ? html`<div class="settings-row-warn">${'Overridden here by '}<code
                >${r.origin.file || r.origin.type}</code>${`, which says ${shown(r.effective)}.`}</div>` : null}
        </div>
        <div class="settings-row-ctl">
            ${control(r, set, !!s.saving)}
            <div class="settings-row-side">
                ${set
                    ? html`<button class="linkish" type="button" disabled=${!!s.saving}
                        title="Remove it from your config.toml" onClick=${() => save(r.key, null)}>Unset</button>`
                    : html`<span class="settings-row-from">not set</span>`}
            </div>
        </div>
    </div>`;
}

function control(r, set, busy) {
    if (r.kind === 'bool') {
        const on = set ? r.user === true : r.effective === true;
        return html`<label class="settings-check">
            <input type="checkbox" aria-label=${r.label} data-key=${r.key} checked=${on} disabled=${busy}
                onChange=${(e) => save(r.key, e.target.checked)} />
            <span class="settings-box"></span>
        </label>`;
    }
    const choices = choicesFor(r);
    const value = set ? shown(r.user) : '';
    // A value the list does not have — a newer effort, a granular approval
    // table — is offered as itself rather than shown as something else.
    const odd = set && !choices.some(c => c.value === value);
    const inForce = !set && shown(r.effective);
    return html`<select class="settings-select" aria-label=${r.label} data-key=${r.key} value=${value}
        disabled=${busy}
        onChange=${(e) => {
            const next = e.target.value;
            if (next !== value) save(r.key, next || null);
        }}>
        <option value="">${inForce ? `Not set — ${inForce}` : 'Not set — Codex’s default'}</option>
        ${odd ? html`<option key=${value} value=${value}>${value}</option>` : null}
        ${choices.map(c => html`<option key=${c.value} value=${c.value}>${c.label}</option>`)}
    </select>`;
}

function choicesFor(r) {
    if (r.options) return r.options.map(o => ({ value: o.value, label: o.label }));
    const list = cc().models;
    if (!list) return [];
    if (r.kind === 'model') {
        return (list.models || []).map(m => ({ value: m.id, label: m.default ? `${m.label} (default)` : m.label }));
    }
    // The levels the chosen model takes, or every level any model does.
    const model = (list.models || []).find(m => m.id === modelInForce())
        || (list.models || []).find(m => m.default);
    const efforts = (model && model.efforts.length ? model.efforts : list.efforts) || [];
    return efforts.map(e => ({ value: e, label: e }));
}

function modelInForce() {
    const all = (cc().data.groups || []).flatMap(g => g.keys);
    const r = all.find(k => k.key === 'model');
    return r ? r.user || r.effective : null;
}

/** Hooks, and what else the file holds that has no control here. */
function restCard(data) {
    const other = data.otherKeys || [];
    return html`<section key="codex-rest" class="settings-group cfg-sub" id="set-g-codex-rest">
        <h3 class="settings-group-title">The rest</h3>
        <div class="settings-row">
            <div class="settings-row-text">
                <div class="settings-row-label">Hooks</div>
                <div class="settings-row-note">What Codex would run in this project, and whether it trusts it.</div>
            </div>
            <div class="settings-row-ctl">
                <button class="btn small" type="button"
                    onClick=${() => openHooksAt({ dir: settingsProject(), agent: 'codex' })}>Show Codex hooks</button>
            </div>
        </div>
        ${other.length ? html`<p class="settings-group-note">${'Also in your file, with no control here: '}
            ${other.map((k, i) => [i ? ', ' : '', html`<code key=${k}>${k}</code>`])}</p>` : null}
        <p class="cmd-field-note">${`Controls were written for Codex ${data.againstVersion}.`}</p>
    </section>`;
}
