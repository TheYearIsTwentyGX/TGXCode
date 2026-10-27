// Settings → Agent brief: the pre-prompt every session is given and the sections
// behind its `tgxcode_guide` tool (bridge/brief.js, keys `brief.*`).
//
// The switches are ordinary rows (settingRow from general.js), so they get the
// same set-here / inherited / Clear handling as every other row. The texts are
// not: each is a draft with Save and a Reset, because a brief half-typed and
// saved on blur would be appended to the next session that started. A text is
// stored only once edited — Reset writes null, which removes the key, so the
// shipped default (and whatever an upgrade does to it) applies again.
//
// The preview is the bridge's composition for the project selected at the top
// of the panel, as a session of the chosen role would be told it — what a
// condition or a switched-off feature left out is struck through rather than
// hidden, so a missing line can be traced to the setting that removed it. It is
// asked again whenever the settings it depends on change.
//
// Not user-only: a project may switch a section off or reword it, for the reason
// bridge/prefs.js gives beside the `brief` defaults.

import { get } from '../api.js';
import { html, useEffect, useState } from '../vendor/preact.js';
import { state } from '../state.js';
import { settingRow } from './general.js';
import { saveSetting, settingsProject, settingsTargetRow } from './index.js';

const GROUP = { section: 'brief' };
const ROLES = [['', 'Ordinary session'], ['worker', 'Worker'], ['orchestrator', 'Orchestrator']];

export function briefCard() {
    return html`<${BriefGroup} key="brief" />`;
}

function BriefGroup() {
    const s = state.settings;
    const dir = settingsProject();
    const [role, setRole] = useState('');
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [struck, setStruck] = useState(true);
    // What the composition depends on that a save can move: the brief's own
    // keys, and the three browser settings that are features.
    const d = s.data || {};
    const deps = JSON.stringify([d.brief, d.devbrowser, d.agentBrowser,
        d.preview && d.preview.agentControl]);

    useEffect(() => {
        let gone = false;
        const q = new URLSearchParams();
        if (dir) q.set('cwd', dir);
        if (role) q.set('role', role);
        get(`/api/brief?${q}`)
            .then((r) => { if (!gone) { setData(r); setError(null); } })
            .catch((err) => { if (!gone) setError(err.message); });
        return () => { gone = true; };
    }, [dir, role, deps]);

    const target = settingsTargetRow();
    const disabled = !target || (target.exists && !target.parsed) || !target.writable || s.saving;
    const setHere = (key) => Boolean(target && target.values && target.values.brief
        && target.values.brief[key] !== undefined);

    return html`<section id="set-g-brief" class="settings-group">
        <h2 class="settings-group-title">Agent brief</h2>
        <p class="settings-group-note">A short pre-prompt every session started here is given: what
            TGXCode is, what its tools do, and a list of longer sections the agent reads on demand
            with <code>tgxcode_guide</code>. Parts about a feature that is off for the session are
            left out. Changes reach each session the next time its process starts.</p>
        ${settingRow(GROUP, { key: 'enabled', type: 'bool', label: 'Give every session the brief',
            note: 'Off sends nothing, and tgxcode_guide answers that the guide is off. An '
                + 'orchestrator’s own brief is sent either way.' }, false)}
        ${error ? html`<p class="settings-row-warn">Could not compose the brief: ${error}</p>` : null}
        ${data ? html`
            <div class="settings-subhead"><h3 class="settings-subhead-title">Main brief</h3>
                <p class="settings-group-note">Sent in full to every session. <code>{{sections}}</code>${' '}becomes
                    the list of available sections, and <code>{{#if name}}…{{else}}…{{/if}}</code>${' '}keeps
                    text only when a feature or section (the chips under Preview) is on.</p></div>
            <${BriefText} key=${`main:${data.main.source}`} name="mainText" label="Main brief"
                source=${data.main.source} edited=${data.main.edited} setHere=${setHere('mainText')}
                disabled=${disabled} />
            <div class="settings-subhead"><h3 class="settings-subhead-title">Sections</h3>
                <p class="settings-group-note">Read on demand, so they cost nothing until asked for. A
                    section also needs the features it names; one that is off for this project is
                    neither listed nor readable.</p></div>
            ${data.sections.map(sec => html`<div key=${sec.id} class="brief-sec">
                ${settingRow(GROUP, { key: `${sec.id}Enabled`, type: 'bool',
                    label: html`${sec.title} <code class="brief-id">${sec.id}</code>${sec.enabled && !sec.available && data.enabled
                        ? html` <span class="brief-tag">not available here</span>` : null}`,
                    note: `${sec.summary}.${sec.requires.length
                        ? ` Needs ${sec.requires.map(f => data.featureNames[f] || f).join(' and ')}.` : ''}` }, false)}
                <details class="brief-edit">
                    <summary>${sec.edited ? 'Edit text (edited)' : 'Edit text'}</summary>
                    <${BriefText} key=${`${sec.id}:${sec.source}`} name=${`${sec.id}Text`} label=${sec.title}
                        source=${sec.source} edited=${sec.edited} setHere=${setHere(`${sec.id}Text`)}
                        disabled=${disabled} />
                </details>
            </div>`)}
            <div class="settings-subhead"><h3 class="settings-subhead-title">Preview</h3>
                <p class="settings-group-note">What a session in this project is sent. ${data.enabled
                    ? `${data.words} words.` : 'The brief is off, so nothing is sent.'}</p></div>
            <div class="brief-preview-bar">
                <select class="settings-select" aria-label="Preview as" value=${role}
                    onChange=${(e) => setRole(e.target.value)}>
                    ${ROLES.map(([v, t]) => html`<option key=${v} value=${v}>${t}</option>`)}
                </select>
                <label class="brief-struck"><input type="checkbox" checked=${struck}
                    onChange=${(e) => setStruck(e.target.checked)} /> Show what is left out</label>
                <span class="brief-features">${Object.keys(data.featureNames).map(f => html`<span key=${f}
                    class=${data.features[f] ? 'brief-feature on' : 'brief-feature'}
                    title=${data.featureNames[f]}>${f}</span>`)}</span>
            </div>
            ${data.problems.length ? html`<ul class="brief-problems">${data.problems.map((p, i) =>
                html`<li key=${i}>${p}</li>`)}</ul>` : null}
            <pre class="brief-preview">${previewParts(data.main.parts, struck, data.enabled)}</pre>
        ` : html`<p class="settings-group-note">Composing…</p>`}
    </section>`;
}

/** The kept text as is, and what was left out struck through, or not at all. */
function previewParts(parts, struck, enabled) {
    return parts.map((p, i) => {
        if (p.on && enabled) return html`<span key=${i}>${p.text}</span>`;
        if (!struck) return null;
        return html`<del key=${i} title=${p.why ? `left out: ${p.why}` : 'the brief is off'}>${p.text}</del>`;
    });
}

/**
 * One text, as a draft. Keyed on what is stored by its caller, so a save that
 * changes it remounts this with the new text and no draft.
 */
function BriefText({ name, label, source, edited, setHere, disabled }) {
    const [draft, setDraft] = useState(null);
    const value = draft ?? source;
    const dirty = draft !== null && draft !== source;
    const atUser = state.settings.scope === 'user';
    // At User scope a reset goes back to the shipped text; at a project scope it
    // removes this file's copy, so whatever the chain below says applies.
    const reset = atUser
        ? { show: edited && setHere, text: 'Reset to default', title: 'Use the text TGXCode ships with' }
        : { show: setHere, text: 'Use inherited', title: 'Remove this file’s copy so the one below it applies' };
    return html`<div class="brief-text">
        <textarea class="settings-text settings-list" spellcheck=${false} aria-label=${label}
            rows=${Math.min(18, Math.max(5, value.split('\n').length + 1))}
            value=${value} disabled=${disabled}
            onInput=${(e) => setDraft(e.target.value)}></textarea>
        <div class="crt-foot">
            ${reset.show ? html`<button type="button" class="btn small" disabled=${disabled}
                title=${reset.title} onClick=${() => saveSetting('brief', name, null)}>${reset.text}</button>` : null}
            <span class="crt-spacer"></span>
            <button type="button" class="btn small" disabled=${!dirty || disabled}
                onClick=${() => setDraft(null)}>Revert</button>
            <button type="button" class="btn small primary" disabled=${!dirty || disabled}
                onClick=${() => saveSetting('brief', name, value.trim() ? value : null)}>Save</button>
        </div>
    </div>`;
}
