// Settings → Code reviews: which skills count as code reviews (`reviews.types`).
//
// A list of rows — a label, the skill or command it runs, a colour — edited as a
// draft and saved whole, the way the Wispr transforms are: one row half-typed
// must not be sent as a type with no skill, and the bridge replaces the list
// whole anyway (bridge/prefs.js, cleanReviewTypes). The skill box offers what
// this project's `claude` reported it has (GET /api/slash-commands) plus the two
// built-in reviewers, and takes any name typed into it.
//
// Not user-only: a repository can declare its own reviewer, so the scope switch
// at the top of the panel decides which file a save goes to, as it does for
// every group that is not locked.

import { get } from '../api.js';
import { html, useEffect, useMemo, useState } from '../vendor/preact.js';
import { state } from '../state.js';
import { saveSettings, settingsProject, settingsTargetRow } from './index.js';

const COLOURS = [['blue', 'Blue'], ['red', 'Red'], ['yellow', 'Yellow'], ['green', 'Green'],
    ['purple', 'Purple'], ['peach', 'Peach']];
// Claude Code's own reviewers, which a project's command list may not name.
const BUILT_IN = ['code-review', 'security-review', 'review'];
const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,79}$/;

export function reviewTypesCard() {
    return html`<${ReviewTypesGroup} key="reviews" />`;
}

const stored = () => ((state.settings.data && state.settings.data.reviews
    && state.settings.data.reviews.types) || []);

let nextKey = 0;
const withKeys = (types) => types.map(t => ({ ...t, _k: `k${nextKey++}` }));

function idFor(skill, taken) {
    const base = skill.toLowerCase().replace(/^\/+/, '').replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 36) || 'review';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
}

function ReviewTypesGroup() {
    const saved = stored();
    const savedKey = JSON.stringify(saved);
    const [draft, setDraft] = useState(null);
    const [names, setNames] = useState([]);
    const dir = settingsProject();

    // A draft is against one stored list. A save, or a scope switch, moves what
    // is stored, and the draft is then dropped in favour of it.
    const fromStore = useMemo(() => withKeys(saved), [savedKey]);
    const rows = draft && draft.from === savedKey ? draft.rows : fromStore;

    useEffect(() => {
        let gone = false;
        get(`/api/slash-commands${dir ? `?cwd=${encodeURIComponent(dir)}` : ''}`)
            .then(r => { if (!gone) setNames((r.commands || []).map(c => c.name)); })
            .catch(() => { /* typing a name still works */ });
        return () => { gone = true; };
    }, [dir]);

    const options = [...new Set([...BUILT_IN, ...names])].sort();
    const set = (next) => setDraft({ from: savedKey, rows: next });
    const change = (k, patch) => set(rows.map(r => (r._k === k ? { ...r, ...patch } : r)));
    const clean = (r) => r.skill.trim().replace(/^\/+/, '');
    const bad = rows.filter(r => !SKILL_RE.test(clean(r)));
    const dirty = JSON.stringify(rows.map(({ _k, ...t }) => t)) !== savedKey;
    const busy = state.settings.saving;

    const save = () => {
        const taken = new Set();
        const types = rows.map((r) => {
            const skill = clean(r);
            const id = r.id && !taken.has(r.id) ? r.id : idFor(skill, taken);
            taken.add(id);
            return { id, label: (r.label || '').trim() || skill, skill, colour: r.colour || 'blue' };
        });
        saveSettings('reviews', { types });
    };
    const target = settingsTargetRow();
    const setHere = Boolean(target && target.values && target.values.reviews
        && target.values.reviews.types !== undefined);
    const inherit = () => saveSettings('reviews', { types: null });

    return html`<section id="set-g-reviews" class="settings-group">
        <h2 class="settings-group-title">Code reviews</h2>
        <p class="settings-group-note">The skills and commands that count as a code review. Every
            run of one appears in a session's <strong>Reviews</strong> pane, with its findings —
            whether you typed <code>/name</code>, Claude ran it as a skill, or a subagent did. A
            project's list replaces yours rather than adding to it.</p>
        <ul class="crt-list">
            ${rows.map(r => html`<li key=${r._k} class="crt-row">
                <label class="crt-field">
                    <span class="cmd-field-label">Label</span>
                    <input class="settings-text crt-label" type="text" maxlength="40" value=${r.label}
                        placeholder=${clean(r) || 'Review'} disabled=${busy}
                        onInput=${(e) => change(r._k, { label: e.target.value })} />
                </label>
                <label class="crt-field">
                    <span class="cmd-field-label">Skill or command</span>
                    <input class="settings-text crt-skill" type="text" spellcheck=${false} list="crt-skills"
                        value=${r.skill} placeholder="code-review" disabled=${busy}
                        aria-invalid=${SKILL_RE.test(clean(r)) ? undefined : 'true'}
                        onInput=${(e) => change(r._k, { skill: e.target.value })} />
                </label>
                <label class="crt-field">
                    <span class="cmd-field-label">Colour</span>
                    <select class="settings-select crt-colour" value=${r.colour || 'blue'} disabled=${busy}
                        data-colour=${r.colour || 'blue'}
                        onChange=${(e) => change(r._k, { colour: e.target.value })}>
                        ${COLOURS.map(([v, t]) => html`<option key=${v} value=${v}>${t}</option>`)}
                    </select>
                </label>
                <button type="button" class="crt-del" aria-label=${`Remove ${r.label || clean(r) || 'this type'}`}
                    title="Remove" disabled=${busy}
                    onClick=${() => set(rows.filter(x => x._k !== r._k))}>✕</button>
            </li>`)}
        </ul>
        <datalist id="crt-skills">${options.map(v => html`<option key=${v} value=${v} />`)}</datalist>
        ${!rows.length ? html`<p class="settings-group-note">No review types — the Reviews pane will stay empty.</p>` : null}
        <div class="crt-foot">
            <button type="button" class="btn small" disabled=${busy || rows.length >= 20}
                onClick=${() => set([...rows, ...withKeys([{ id: '', label: '', skill: '', colour: 'blue' }])])}>Add a type</button>
            ${setHere && state.settings.scope !== 'user'
                ? html`<button type="button" class="btn small" disabled=${busy}
                    title="Remove the list from this file, so the one below it applies" onClick=${inherit}>Use the inherited list</button>`
                : null}
            <span class="crt-spacer"></span>
            ${bad.length && rows.length ? html`<span class="crt-bad">${
                bad.length === 1 ? 'One row has no usable skill name.' : `${bad.length} rows have no usable skill name.`}</span>` : null}
            <button type="button" class="btn small" disabled=${!dirty || busy}
                onClick=${() => setDraft(null)}>Revert</button>
            <button type="button" class="btn small primary" disabled=${!dirty || busy || bad.length > 0}
                onClick=${save}>${busy ? 'Saving…' : 'Save'}</button>
        </div>
    </section>`;
}
