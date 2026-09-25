// One snippet, in the editor dialog.
//
// The dialog's frame — `#snip-edit-scrim` and its `.modal` — is web/index.html's,
// so the stacking order the markup comments there argue for is unchanged. What is
// inside the `.modal` is this component, mounted on open and unmounted on close.
//
// **The form is the component's state.** The hand-built dialog kept its fields in
// the markup and the two lists it drew itself in module-level `let`s —
// `snipDraftParams` and `snipDraftProjects` — with each input's handler writing
// back into them by index, and two paint functions to call by hand whenever
// something they depended on changed: the permission row after the Send box, the
// placeholder note after the body or any parameter name. Here the note and the
// row are computed from state on every render, so there is nothing to forget to
// repaint, and removing a parameter cannot leave the next row's handler writing
// into the wrong slot. Each parameter row carries a key of its own (`_k`),
// stripped before saving, so removing one keeps the others' nodes and focus.
//
// Nothing outside re-renders it. A `snippets-changed` push while it is open
// redraws the list behind it and leaves this alone, which is what the dialog
// always did: the group list is the one it opened with.
//
// See index.js for the rule every module here follows about app.js bindings.

import { html, useState } from '../vendor/preact.js';
import { patch, post } from '../api.js';
import { state } from '../state.js';
import { dom, toast } from '../dom.js';
import { shortPath } from '../format.js';
import { icon, paint } from '../boards/parts.js';
import { SNIP_PLACEHOLDER } from './index.js';

const PARAM_TYPES = ['text', 'integer', 'decimal', 'date', 'time', 'datetime'];

let paramKey = 0;
const withKey = (p) => ({ ...p, _k: ++paramKey });

/** The `.modal` inside the scrim: the frame is the markup's, the contents ours. */
const modal = () => dom.snipEditScrim.querySelector('.modal');

// Bumped on every open, so a reopen mounts a fresh form rather than diffing the
// last one's state into the next snippet.
let opened = 0;

export function openSnipEditor(s, groupId = null) {
    state.snippets.editing = s ? s.id : null;
    opened += 1;
    paint(modal(), html`<${SnipEditor} key=${opened} snippet=${s} groupId=${groupId}
        groups=${state.snippets.groups} projects=${state.settings.projects} />`);
    dom.snipEditScrim.hidden = false;
    const first = dom.snipEditScrim.querySelector('#snip-title');
    if (first) first.focus();
}

export function closeSnipEditor() {
    dom.snipEditScrim.hidden = true;
    state.snippets.editing = null;
    paint(modal(), null);
}

/**
 * What the body and the parameters say about each other.
 *
 * A note in both directions and a refusal in neither, which is the bridge's rule
 * restated where somebody can act on it: an undeclared `{{x}}` reaches the session
 * as itself, and a parameter nothing references is a field you have not wired up
 * yet. Saying so is the difference between a bug you can see and one you meet
 * three sessions later.
 */
function placeholderNote(body, params) {
    const declared = new Set(params.map(p => p.name.trim()).filter(Boolean));
    const used = new Set();
    for (const m of body.matchAll(SNIP_PLACEHOLDER)) used.add(m[1]);
    const undeclared = [...used].filter(n => !declared.has(n));
    const unused = [...declared].filter(n => !used.has(n));

    const said = [];
    if (undeclared.length) {
        said.push(`${undeclared.map(n => `{{${n}}}`).join(', ')} `
            + `${undeclared.length > 1 ? 'are' : 'is'} in the message but not asked for — `
            + `${undeclared.length > 1 ? 'they' : 'it'} will be sent as written.`);
    }
    if (unused.length) {
        said.push(`${unused.join(', ')} ${unused.length > 1 ? 'are' : 'is'} asked for but `
            + 'never used in the message.');
    }
    return said.join(' ');
}

/**
 * The form.
 *
 * The permission row only means anything on a send, so it appears with one. Its
 * first option, inherit, is the default: the button this feature replaced never
 * moved the selector, and a snippet that silently changed the permission mode of
 * the next thing you send would be the one surprise here worth avoiding.
 */
function SnipEditor({ snippet: s, groupId, groups, projects }) {
    const [f, setF] = useState(() => ({
        title: s ? s.title : '',
        body: s ? s.body : '',
        groupId: s ? (s.groupId || '') : (groupId || ''),
        insert: s ? s.insert : 'overwrite',
        autoSubmit: s ? s.autoSubmit : false,
        permissionMode: s ? (s.permissionMode || '') : '',
        pinned: s ? s.pinned : false,
        params: s ? s.params.map(withKey) : [],
        projects: s ? [...s.projects] : [],
    }));
    const [dir, setDir] = useState('');
    const [saving, setSaving] = useState(false);

    const set = (fields) => setF(prev => ({ ...prev, ...fields }));
    const setParam = (k, fields) => setF(prev => ({
        ...prev, params: prev.params.map(p => (p._k === k ? { ...p, ...fields } : p)),
    }));

    const addParam = () => {
        const p = withKey({ name: '', label: '', type: 'text', required: false, default: '' });
        set({ params: [...f.params, p] });
        // Focus the new row's name once it is on screen, which is after this
        // render; the dialog is the one place that focuses it.
        requestAnimationFrame(() => {
            const last = modal().querySelector('.snip-param:last-child .snip-param-name');
            if (last) last.focus();
        });
    };

    const addProject = () => {
        const d = dir.trim();
        if (!d) return;
        if (!f.projects.includes(d)) set({ projects: [...f.projects, d] });
        setDir('');
    };

    /**
     * @returns {object|null} the body to send, or null having said what is wrong.
     *   The bridge refuses all of this too — this is so the answer arrives beside
     *   the box rather than as a toast about a request.
     */
    const read = () => {
        const title = f.title.trim();
        const body = f.body;
        if (!title) { toast('Give it a title.', 'warn'); modal().querySelector('#snip-title').focus(); return null; }
        if (!body.trim()) { toast('Give it a message.', 'warn'); modal().querySelector('#snip-body').focus(); return null; }

        const params = f.params.map(({ _k, ...p }) => ({ ...p, name: p.name.trim() }));
        const seen = new Set();
        for (const p of params) {
            if (!/^[A-Za-z_]\w*$/.test(p.name || '')) {
                toast(`"${p.name || ''}" is not a usable parameter name — letters, digits `
                    + 'and underscores, not starting with a digit.', 'warn');
                return null;
            }
            if (seen.has(p.name)) {
                toast(`Two parameters are both called "${p.name}".`, 'warn');
                return null;
            }
            seen.add(p.name);
        }

        return {
            title,
            body,
            groupId: f.groupId || null,
            params,
            insert: f.insert,
            autoSubmit: f.autoSubmit,
            // Only meaningful with a send, but kept either way, so unticking Send
            // and ticking it again does not lose the mode you picked.
            permissionMode: f.permissionMode || null,
            pinned: f.pinned,
            projects: f.projects,
        };
    };

    const save = async () => {
        const body = read();
        if (!body) return;
        const id = state.snippets.editing;
        setSaving(true);
        try {
            if (id) await patch(`/api/snippets/${id}`, body);
            else await post('/api/snippets', body);
            closeSnipEditor();
        } catch (err) {
            toast(`Could not save the snippet: ${err.message}`, 'error');
            setSaving(false);
        }
    };

    const note = placeholderNote(f.body, f.params);

    return html`
        <div class="modal-head">
            <span id="snip-edit-title">${s ? 'Edit snippet' : 'New snippet'}</span>
            <button class="modal-close" data-close-snip="" type="button" aria-label="Close"
                onClick=${closeSnipEditor}>✕</button>
        </div>
        <div class="modal-body">
            <div class="field">
                <label for="snip-title">Title</label>
                <input id="snip-title" type="text" autocomplete="off"
                    placeholder="What this says, in a few words"
                    value=${f.title} onInput=${(e) => set({ title: e.target.value })} />
            </div>
            <div class="field">
                <label for="snip-group">Group</label>
                <select id="snip-group" value=${f.groupId}
                    onChange=${(e) => set({ groupId: e.target.value })}>
                    <option value="">Ungrouped</option>
                    ${groups.map(g => html`<option key=${g.id} value=${g.id}>${g.name}</option>`)}
                </select>
            </div>
            <div class="field">
                <label for="snip-body">Message</label>
                <textarea id="snip-body" class="grow" rows="6"
                    placeholder="What to send. Write {{name}} where a parameter goes."
                    value=${f.body} onInput=${(e) => set({ body: e.target.value })}></textarea>
                <div id="snip-placeholders" class="note" hidden=${!note}>${note}</div>
            </div>
            <div class="field">
                <label>Parameters</label>
                <div id="snip-params" class="snip-params">${f.params.map(p => html`
                    <div key=${p._k} class="snip-param">
                        <input class="snip-param-name" type="text" placeholder="name"
                            aria-label="Parameter name" spellcheck=${false}
                            value=${p.name} onInput=${(e) => setParam(p._k, { name: e.target.value })} />
                        <input class="snip-param-label" type="text" placeholder="Label"
                            aria-label="Parameter label"
                            value=${p.label || ''} onInput=${(e) => setParam(p._k, { label: e.target.value })} />
                        <select class="snip-param-type" aria-label="Parameter type" value=${p.type}
                            onChange=${(e) => setParam(p._k, { type: e.target.value })}>
                            ${PARAM_TYPES.map(t => html`<option value=${t}>${t}</option>`)}
                        </select>
                        <input class="snip-param-default" type="text" placeholder="Default"
                            aria-label="Default value"
                            value=${p.default || ''} onInput=${(e) => setParam(p._k, { default: e.target.value })} />
                        <label class="snip-check" title="Must not be left empty">
                            <input type="checkbox" checked=${Boolean(p.required)}
                                onChange=${(e) => setParam(p._k, { required: e.target.checked })} />
                            <span class="settings-box"></span>
                            <span class="snip-param-req">needed</span>
                        </label>
                        <button class="snip-del" type="button" aria-label="Remove this parameter"
                            onClick=${() => set({ params: f.params.filter(x => x._k !== p._k) })}
                            >${icon('trash', 13)}</button>
                    </div>`)}</div>
                <div>
                    <button id="snip-param-add" class="btn small" type="button"
                        onClick=${addParam}>Add a parameter</button>
                </div>
            </div>
            <div class="field">
                <label for="snip-insert">Where it goes</label>
                <select id="snip-insert" value=${f.insert}
                    onChange=${(e) => set({ insert: e.target.value })}>
                    <option value="overwrite">Replace what is in the box</option>
                    <option value="append">Add it to the end</option>
                    <option value="cursor">Insert at the cursor</option>
                </select>
            </div>
            <div class="field">
                <label class="snip-check">
                    <input id="snip-auto" type="checkbox" checked=${f.autoSubmit}
                        onChange=${(e) => set({ autoSubmit: e.target.checked })} />
                    <span class="settings-box"></span>
                    <span>Send it straight away</span>
                </label>
                <div id="snip-perm-row" class="snip-sub" hidden=${!f.autoSubmit}>
                    <label for="snip-perm">Permissions</label>
                    <select id="snip-perm" value=${f.permissionMode}
                        onChange=${(e) => set({ permissionMode: e.target.value })}>
                        <option value="">inherit — leave it where it is</option>
                        <option value="acceptEdits">acceptEdits</option>
                        <option value="auto">auto</option>
                        <option value="manual">manual</option>
                        <option value="plan">plan</option>
                        <option value="dontAsk">dontAsk</option>
                        <option value="bypassPermissions">bypassPermissions</option>
                    </select>
                </div>
            </div>
            <div class="field">
                <label class="snip-check">
                    <input id="snip-pinned" type="checkbox" checked=${f.pinned}
                        onChange=${(e) => set({ pinned: e.target.checked })} />
                    <span class="settings-box"></span>
                    <span>Give it a button on the composer</span>
                </label>
            </div>
            <div class="field">
                <label>Only in these projects</label>
                <div id="snip-projects" class="snip-projects">${f.projects.map(p => html`
                    <span key=${p} class="snip-chip">
                        <span>${shortPath(p)}</span>
                        <button class="snip-chip-x" type="button" aria-label=${`Remove ${p}`}
                            onClick=${() => set({ projects: f.projects.filter(x => x !== p) })}>✕</button>
                    </span>`)}</div>
                <div class="snip-project-add">
                    <input id="snip-project" type="text" spellcheck=${false} autocomplete="off"
                        list="snip-project-list" placeholder="A directory, or leave empty for everywhere"
                        value=${dir} onInput=${(e) => setDir(e.target.value)}
                        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); addProject(); } }} />
                    <datalist id="snip-project-list">${
                        projects.map(p => html`<option key=${p.cwd} value=${p.cwd}></option>`)}</datalist>
                    <button id="snip-project-go" class="btn small" type="button"
                        onClick=${addProject}>Add</button>
                </div>
                <div class="note">A snippet with none of these shows everywhere. With one,
                    it shows in that directory and anything under it.</div>
            </div>
        </div>
        <div class="modal-foot">
            <span class="spacer"></span>
            <button class="btn" data-close-snip="" type="button" onClick=${closeSnipEditor}>Cancel</button>
            <button id="snip-save" class="btn primary" type="button" disabled=${saving}
                onClick=${save}>Save</button>
        </div>`;
}
