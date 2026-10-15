// The script under a command hook — opened in place, edited, created.
//
// One at a time, in `state.hooks.script`, drawn under the hook it belongs to
// (`k` is that hook's `_k`). Saved on its own, apart from the hooks draft,
// because it is a different file with a different precondition: the hooks
// block is one key in a settings file, and this is a whole file the bridge
// writes through GET/PUT /api/claude-config/hook-script. A recipe can create
// its script before the hook that runs it has been saved, and that is fine —
// the bridge allows a new file anywhere under a `.claude/hooks` directory.
//
// A draft like the JSON tab: never replaced from under somebody typing. A save
// refused with 409 keeps the text, shows what is on disk, and asks.

import { html, useState } from '../vendor/preact.js';
import { get, put } from '../api.js';
import { toast } from '../dom.js';
import { shortPath } from '../format.js';
import { grow } from '../composer/send.js';
import { hkDraft } from './editor.js';
import { hkState, renderHooks } from './page.js';

/** What a brand new script starts as, when nothing better was offered. */
const SHEBANG = '#!/usr/bin/env bash\n# The event arrives as JSON on stdin. Exit 2 to block, where the event allows it.\nset -euo pipefail\n\ninput=$(cat)\n';

let redrawPane = () => renderHooks();

/** Nothing typed into the open script, or the reader said to drop it. */
export function scriptMayLeave() {
    const sc = hkState().script;
    if (!sc || !sc.dirty) return true;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Discard the changes to ${shortPath(sc.path)}?`)) return false;
    hkState().script = null;
    return true;
}

/** The tag's click: open this hook's script, or close it if it is the one open. */
export function scriptToggle(k, path) {
    const s = hkState();
    if (s.script && s.script.k === k) {
        if (!scriptMayLeave()) return;
        s.script = null;
        renderHooks();
        return;
    }
    if (!scriptMayLeave()) return;
    openScript(k, path);
}

/**
 * Open a script under hook `k`.
 *
 * @param {{seed?: string}} [opts] the text a new file starts with — a recipe's
 *   script. Ignored when the file already exists: a recipe never overwrites
 *   somebody's script, it opens it.
 */
export async function openScript(k, path, { seed } = {}) {
    const s = hkState();
    const sc = { k, path, loading: true, data: null, text: '', dirty: false, saving: false,
        error: null, stale: null, exec: true, rev: 0 };
    s.script = sc;
    renderHooks();
    try {
        sc.data = await get(`/api/claude-config/hook-script?cwd=${encodeURIComponent(s.dir || '')}`
            + `&path=${encodeURIComponent(path)}`);
        sc.path = sc.data.file;
        if (sc.data.exists) {
            sc.text = sc.data.text || '';
            sc.exec = !sc.data.executable;
        } else {
            sc.text = seed || SHEBANG;
            // A new file is a draft from the first moment: nothing is on disk,
            // and closing the pane should ask rather than drop the recipe's text.
            sc.dirty = true;
        }
    } catch (err) {
        sc.error = err.message;
    }
    sc.loading = false;
    if (hkState().script === sc) renderHooks();
}

/** The pane. Redraws itself on a keystroke; anything bigger goes through renderHooks. */
export function ScriptPane() {
    const [, redraw] = useState(0);
    redrawPane = () => redraw(n => n + 1);
    const sc = hkState().script;
    if (!sc) return null;

    const close = () => { if (scriptMayLeave()) { hkState().script = null; renderHooks(); } };
    const head = html`<div class="hk-sc-head">
        <code class="hk-sc-path" title=${sc.path}>${shortPath(sc.path)}</code>
        ${sc.data && !sc.data.exists ? html`<span class="cfg-tab-tag">new file</span>` : null}
        ${sc.data && sc.data.exists && !sc.data.executable
            ? html`<span class="cfg-tab-tag bad">not executable</span>` : null}
        <div class="cmd-card-spacer"></div>
        <button class="cfg-list-x hk-mini" type="button" title="Close the script" aria-label="Close the script"
            onClick=${close}>×</button>
    </div>`;

    if (sc.loading) return html`<div class="hk-sc">${head}<p class="cmd-field-note">Reading…</p></div>`;
    if (sc.error) {
        return html`<div class="hk-sc">${head}<p class="cmd-field-bad">${sc.error}</p></div>`;
    }
    const d = sc.data;
    const locked = d.symlink || !d.writable || d.binary || d.truncated;
    const why = d.symlink ? 'A symlink — the page will not write through it.'
        : d.binary ? 'Not a text file, so it cannot be edited here.'
            : d.truncated ? `Larger than ${Math.round(d.maxBytes / 1024)}KB, so it is not opened here.`
                : !d.writable ? 'This file cannot be written.' : null;

    return html`<div class="hk-sc">
        ${head}
        ${why ? html`<p class="cmd-field-note">${why}</p>` : null}
        ${sc.stale ? html`<div class="cfg-stale">
            <div class="cfg-stale-head">This script changed on disk since you opened it.</div>
            <p>Nothing was overwritten, and your text is kept.</p>
            <details><summary>What is on disk</summary><pre class="cfg-stale-text">${sc.stale.text ?? '(deleted)'}</pre></details>
            <div class="hk-actions">
                <button class="btn small" type="button" onClick=${() => {
                    // Overwrite on the next save: take the stamp of what is
                    // there now as the one this draft was read from.
                    sc.data = { ...d, stamp: sc.stale.stamp, exists: sc.stale.stamp !== null };
                    sc.stale = null;
                    redrawPane();
                }}>Keep mine</button>
                <button class="btn quiet small" type="button" onClick=${() => openScript(sc.k, sc.path)}
                    >Take what is on disk</button>
            </div>
        </div>` : null}
        ${d.binary || d.truncated ? null : html`<textarea key=${`${sc.path}:${sc.rev}`} class="cmd-area hk-sc-text"
            spellcheck=${false} rows="8" disabled=${locked} defaultValue=${sc.text}
            ref=${(n) => { if (n && !n.dataset.grown) { n.dataset.grown = '1'; grow(n, 120, 560); } }}
            onInput=${(e) => {
                sc.text = e.target.value;
                sc.dirty = true;
                grow(e.target, 120, 560);
                redrawPane();
            }}></textarea>`}
        ${locked ? null : html`<div class="cmd-foot hk-sc-foot">
            ${!d.exists || !d.executable ? html`<label class="hk-check">
                <span class="settings-check">
                    <input type="checkbox" checked=${sc.exec}
                        onChange=${(e) => { sc.exec = e.target.checked; redrawPane(); }} />
                    <span class="settings-box"></span>
                </span>
                <span class="cmd-field-label">${d.exists ? 'Make it executable' : 'Executable'}</span>
            </label>` : null}
            <span class="cmd-foot-note">${sc.dirty ? (d.exists ? 'Edited — not saved.' : 'Not created yet.')
                : 'Matches the file on disk.'}</span>
            <div class="cmd-card-spacer"></div>
            <button class="btn quiet small" type="button" disabled=${!sc.dirty || !d.exists}
                onClick=${() => { sc.text = d.text || ''; sc.dirty = false; sc.rev += 1; redrawPane(); }}>Discard</button>
            <button class="btn primary small" type="button" disabled=${!!sc.saving || (!sc.dirty && !(sc.exec && !d.executable))}
                onClick=${() => saveScript()}>${d.exists ? 'Save the script' : 'Create the script'}</button>
        </div>`}
    </div>`;
}

/** Write it, and carry the answer to the hook's tag so it stops saying "missing". */
async function saveScript() {
    const s = hkState();
    const sc = s.script;
    if (!sc || !sc.data) return;
    sc.saving = true;
    redrawPane();
    try {
        const answer = await put('/api/claude-config/hook-script', {
            cwd: s.dir || '', path: sc.path,
            stamp: sc.data.exists ? sc.data.stamp : null,
            text: sc.text,
            executable: !!sc.exec,
        });
        const created = !sc.data.exists;
        sc.data = answer;
        sc.text = answer.text || '';
        sc.dirty = false;
        sc.exec = !answer.executable;
        sc.stale = null;
        // The draft's copy of the tag, so the hook says "present" now rather
        // than after the next reload — which keeps a dirty draft's tags as they
        // were seeded.
        for (const ev of hkDraft()) {
            for (const g of ev.groups) {
                for (const h of g.hooks) {
                    if (h._k === sc.k && h._script) {
                        h._script = { ...h._script, exists: true, executable: answer.executable };
                    }
                }
            }
        }
        toast(created ? `Created ${shortPath(answer.file)}.` : `Saved ${shortPath(answer.file)}.`, 'ok');
    } catch (err) {
        if (err.status === 409) {
            sc.stale = { text: err.data.text ?? null, stamp: err.data.stamp ?? null };
            toast('That script changed on disk. Your text is kept — look, then save again.', 'warn');
        } else {
            toast(`Could not save the script: ${err.message}`, 'error');
        }
    }
    sc.saving = false;
    renderHooks();
}
