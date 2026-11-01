// The Secrets group: the values agents use as `$NAME` without being shown them —
// bridge/secrets.js has the design. Listed by name for the project Settings is
// looking at (every worktree of a repository shares one set), with Reveal,
// Update and Delete, and a row to add one.
//
// **A value is on this page only while you are looking at it.** The list never
// carries one. Reveal asks the bridge for that one value, shows it, and drops it
// from component state after thirty seconds or when the group goes away; Update
// and Add read the field into the request body and empty it. Nothing here puts
// a value in `state`, in storage, or in a toast.
//
// From a phone the list is still drawn — the names are not secret — but every
// control is the desk's, as the routes are (see docs/remote.md).
//
// Imports from app.js's world only through modules that do not read an app.js
// binding at load, for the reason web/settings/general.js gives.

import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { del, get, post, put } from '../api.js';
import { toast } from '../dom.js';
import { shortPath } from '../format.js';
import { state } from '../state.js';
import { DeleteButton } from '../snippets/settings.js';
import { settingsProject } from './index.js';

const REVEAL_MS = 30_000;
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

// The mounted group's reload, so a secret saved from a card elsewhere shows up
// here without a refresh.
let reloadSecrets = null;

/** Called when a secret ask is answered: the list may have grown. */
export function secretsChanged() {
    if (reloadSecrets) reloadSecrets();
}

/** The group, for SETTINGS' `card`. */
export function secretsCard() {
    return html`<${SecretsGroup} key="secrets" />`;
}

const when = (t) => (t ? new Date(t).toLocaleString() : '');

function SecretsGroup() {
    const dir = settingsProject();
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [shown, setShown] = useState({});       // name → value, while revealed
    const [editing, setEditing] = useState(null); // the name being updated
    const timers = useRef({});
    const desk = !state.remote;

    const load = () => {
        if (!dir) { setData(null); return; }
        get(`/api/secrets?cwd=${encodeURIComponent(dir)}`)
            .then((d) => { setData(d); setError(null); })
            .catch((err) => setError(err.message));
    };
    useEffect(() => { setShown({}); setEditing(null); load(); }, [dir]);
    useEffect(() => {
        reloadSecrets = load;
        return () => {
            reloadSecrets = null;
            for (const t of Object.values(timers.current)) clearTimeout(t);
        };
    }, [dir]);

    const hide = (name) => {
        clearTimeout(timers.current[name]);
        delete timers.current[name];
        setShown((s) => { const n = { ...s }; delete n[name]; return n; });
    };
    const reveal = async (name) => {
        if (shown[name] !== undefined) { hide(name); return; }
        try {
            const r = await post(`/api/secrets/${name}/reveal`, { cwd: dir });
            setShown((s) => ({ ...s, [name]: r.value }));
            clearTimeout(timers.current[name]);
            timers.current[name] = setTimeout(() => hide(name), REVEAL_MS);
        } catch (err) { toast(`Could not reveal ${name}: ${err.message}`, 'error'); }
    };
    const save = async (name, input) => {
        const value = input.value;
        input.value = '';
        if (!value) { input.focus(); return false; }
        try {
            await put(`/api/secrets/${name}`, { cwd: dir, value });
            hide(name);
            load();
            return true;
        } catch (err) { toast(`Could not save ${name}: ${err.message}`, 'error'); return false; }
    };
    const remove = async (name) => {
        try {
            await del(`/api/secrets/${name}?cwd=${encodeURIComponent(dir)}`);
            hide(name);
            load();
        } catch (err) { toast(`Could not delete ${name}: ${err.message}`, 'error'); }
    };

    let body;
    if (!dir) body = html`<div class="settings-empty">No project selected — pick one above.</div>`;
    else if (error) body = html`<div class="settings-error">Could not read this project’s secrets: ${error}</div>`;
    else if (!data) body = html`<div class="settings-empty">Reading…</div>`;
    else {
        body = [
            data.secrets.length ? null
                : html`<div key="none" class="settings-empty">No secrets yet. An agent asks for one with
                    request_secret, or add one below.</div>`,
            ...data.secrets.map(s => html`<div key=${s.name} class="settings-row secret-row">
                <div class="settings-row-text">
                    <div class="settings-row-label"><code>${s.name}</code></div>
                    <div class="settings-row-note">Updated ${when(s.updatedAt)}</div>
                    ${shown[s.name] !== undefined ? html`<code class="secret-value">${shown[s.name]}</code>` : null}
                    ${editing === s.name ? html`<${ValueForm} label=${`New value for ${s.name}`} submit="Save"
                        onSubmit=${async (input) => { if (await save(s.name, input)) setEditing(null); }}
                        onCancel=${() => setEditing(null)} />` : null}
                </div>
                ${desk ? html`<div class="secret-actions">
                    <button class="btn small" type="button" onClick=${() => reveal(s.name)}
                        >${shown[s.name] !== undefined ? 'Hide' : 'Reveal'}</button>
                    <button class="btn small" type="button" disabled=${editing === s.name}
                        onClick=${() => setEditing(s.name)}>Update</button>
                    <${DeleteButton} label=${`Delete ${s.name}`} go=${() => remove(s.name)} />
                </div>` : null}
            </div>`),
            desk ? html`<${AddSecret} key="add" taken=${data.secrets.map(s => s.name)} save=${save} />` : null,
            desk ? null : html`<p key="remote" class="settings-row-note">Secrets can only be added, changed or
                revealed at the computer they are stored on.</p>`,
        ];
    }

    return html`<section key="secrets" class="settings-group" id="set-g-secrets">
        <h2 class="settings-group-title">Secrets</h2>
        <p class="settings-group-note">${'Values agents use as '}<code>$NAME</code>${
            ' in a Bash command without being shown them. The value is put into that command’s '
            + 'environment and replaced with '}<code>[secret:NAME]</code>${' in what it prints. '
            + 'Stored outside the repository, readable only by you, and shared by every worktree of '}${
            data && data.project ? html`<code>${shortPath(data.project)}</code>` : 'the project'}${
            '. This stops a secret ending up in a transcript by accident; it does not stop an agent '
            + 'that sets out to read it.'}</p>
        ${body}
    </section>`;
}

/** A masked field with a submit and an optional cancel. The value lives only in the DOM. */
function ValueForm({ label, submit, onSubmit, onCancel }) {
    const ref = useRef(null);
    useEffect(() => { if (ref.current) ref.current.focus(); }, []);
    return html`<form class="secret-form" autocomplete="off" onSubmit=${(e) => { e.preventDefault(); onSubmit(ref.current); }}>
        <input ref=${ref} class="settings-text" type="password" autocomplete="off" spellcheck="false"
            aria-label=${label} placeholder="Value"
            onKeyDown=${(e) => { if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); } }} />
        <button class="btn small primary" type="submit">${submit}</button>
        ${onCancel ? html`<button class="btn small" type="button" onClick=${onCancel}>Cancel</button>` : null}
    </form>`;
}

function AddSecret({ taken, save }) {
    const [name, setName] = useState('');
    const valueRef = useRef(null);
    const problem = !name ? null
        : !NAME_RE.test(name) ? 'Upper-case letters, digits and _, starting with a letter.'
            : taken.includes(name) ? `${name} is already set — use Update.` : null;
    const submit = async (e) => {
        e.preventDefault();
        if (!name || problem) return;
        if (await save(name, valueRef.current)) setName('');
    };
    return html`<form class="settings-row secret-add" autocomplete="off" onSubmit=${submit}>
        <div class="settings-row-text">
            <div class="settings-row-label">Add a secret</div>
            <div class="secret-form">
                <input class="settings-text secret-name" type="text" spellcheck="false" autocomplete="off"
                    aria-label="Name" placeholder="NAME" value=${name}
                    onInput=${(e) => setName(e.currentTarget.value.toUpperCase())} />
                <input ref=${valueRef} class="settings-text" type="password" autocomplete="off"
                    spellcheck="false" aria-label="Value" placeholder="Value" />
                <button class="btn small primary" type="submit" disabled=${!name || !!problem}>Add</button>
            </div>
            ${problem ? html`<div class="settings-row-warn">${problem}</div>` : null}
        </div>
    </form>`;
}
