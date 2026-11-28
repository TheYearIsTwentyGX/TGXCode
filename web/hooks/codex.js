// The Codex side of the Hooks page: what `hooks/list` says would run in a
// project (bridge/codex-config.js). Read-only, on purpose.
//
// Codex's hooks live in `hooks.json` or `config.toml`, and one only runs once
// Codex trusts it — a hash of the hook, recorded when you accept it in Codex's
// own `/hooks`. This page says which are trusted and which will not run, and
// leaves both the editing and the trusting where they are: accepting a command
// to run on every tool call is not a thing to do with a button over somebody
// else's file format.
//
// State is `state.hooks.codex`; the project is the page's own `state.hooks.dir`.

import { html } from '../vendor/preact.js';
import { get } from '../api.js';
import { toast } from '../dom.js';
import { shortPath } from '../format.js';
import { state } from '../state.js';
import { renderHooks } from './page.js';

let seq = 0;

export async function loadCodexHooks() {
    const c = state.hooks.codex;
    const dir = state.hooks.dir || '';
    const mine = ++seq;
    c.loading = true;
    c.error = null;
    if (c.dir !== dir) c.data = null;
    c.dir = dir;
    renderHooks();
    try {
        const data = await get(`/api/codex-config/hooks${dir ? `?cwd=${encodeURIComponent(dir)}` : ''}`);
        if (mine !== seq) return;
        c.data = data;
    } catch (err) {
        if (mine !== seq) return;
        c.data = null;
        c.error = err.message;
    }
    c.loading = false;
    renderHooks();
}

// What each trust state means for whether it runs.
const TRUST = {
    trusted: ['trusted', false],
    managed: ['managed', false],
    untrusted: ['not trusted — will not run', true],
    modified: ['changed since you trusted it — will not run', true],
};

const SOURCES = {
    user: 'yours', project: 'project', plugin: 'plugin', system: 'system', sessionFlags: 'command line',
    mdm: 'managed', cloudRequirements: 'managed', cloudManagedConfig: 'managed',
    legacyManagedConfigFile: 'managed', legacyManagedConfigMdm: 'managed', unknown: 'unknown',
};

function hook(h) {
    const [trust, bad] = TRUST[h.trust] || [h.trust || 'unknown', false];
    return html`<div key=${h.key} class=${`hkp-cx-hook${h.enabled && !bad ? '' : ' is-off'}`}>
        <div class="hkp-cx-line">
            <span class="hk-inherit-scope">${SOURCES[h.source] || h.source}</span>
            ${h.matcher ? html`<span class="hkp-cx-match">matcher <code>${h.matcher}</code></span>` : null}
            <span class=${bad ? 'cfg-script bad' : 'cfg-tab-tag'}>${trust}</span>
            ${h.enabled ? null : html`<span class="cfg-tab-tag">disabled</span>`}
            ${h.timeoutSec ? html`<span class="hkp-cx-match">${`${h.timeoutSec}s timeout`}</span>` : null}
        </div>
        <pre class="hkp-fm-yaml">${h.command || `(${h.handler} hook)`}</pre>
        ${h.statusMessage ? html`<p class="cmd-field-note">${h.statusMessage}</p>` : null}
        ${h.file ? html`<button class="hkp-fm-path" type="button" title="Copy this path"
            onClick=${() => navigator.clipboard.writeText(h.file).then(() => toast('Path copied.'))}
            >${shortPath(h.file)}</button>` : null}
    </div>`;
}

export function CodexHooks() {
    const c = state.hooks.codex;
    if (c.error) return html`<div class="dash-note error">${`Could not ask Codex for its hooks: ${c.error}`}</div>`;
    if (!c.data) return html`<div class="dash-note">Asking Codex…</div>`;
    if (c.data.installed === false) return html`<div class="dash-note">Codex is not installed.</div>`;
    const { hooks, warnings, errors } = c.data;
    const events = [...new Set(hooks.map(h => h.event))];
    return html`<div class="hkp-cx">
        <p class="cmd-field-note">${'Read-only. Hooks are written in '}<code>hooks.json</code>${' or '}
            <code>config.toml</code>${', in your Codex home or a project’s '}<code>.codex</code>${
            ' directory, and a new or changed one runs only after you trust it with '}<code>/hooks</code>${
            ' in Codex. One that fails or blocks shows as a row in the conversation.'}</p>
        ${errors.map(e => html`<p key=${`${e.file}${e.message}`} class="cmd-field-bad"
            >${e.file ? `${shortPath(e.file)}: ` : ''}${e.message}</p>`)}
        ${warnings.map(w => html`<p key=${w} class="settings-row-warn">${w}</p>`)}
        ${events.length ? events.map(ev => html`<section key=${ev} class="hkp-cx-event">
            <h2 class="hkp-h"><code>${ev}</code></h2>
            ${hooks.filter(h => h.event === ev).map(hook)}
        </section>`) : html`<div class="dash-note">No hooks would run here.</div>`}
    </div>`;
}
