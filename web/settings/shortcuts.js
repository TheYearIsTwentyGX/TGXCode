// The Shortcuts group: remapping a command's key, and putting the bindings into
// every bit of chrome that names one. The list of shortcuts is drawn with
// Preact, as part of the Keyboard group — see general.js for how Settings is.
//
// Imports from app.js, which imports this — safe because nothing here reads an
// app.js binding while the module evaluates, only when a function is called.
// Keep it that way: a module-level `const` built from an app.js `const` throws,
// because every module under web/settings/ evaluates before app.js's body runs.

import { BOOT_PREFS } from '../boot.js';
import { html } from '../vendor/preact.js';
import { dom, toast } from '../dom.js';
import * as keys from '../keys.js';
import { state } from '../state.js';
import {
    paintDashBadge, paintLiveBadge, paintNotesBadge, paintTaskboardBadge,
} from '../app.js';
import { paintDraftsBadge } from '../drafts.js';
import { paintSchedBadge } from '../schedules.js';
import { renderHeaderActions } from '../transcript/conversation.js';
import { renderSettings, saveSetting } from './index.js';

// ── remapping a shortcut ─────────────────────────────────────────────────
//
// One row per command in bridge/keymap.js. Recording rather than typing: a
// binding is a chord, and asking somebody to spell `Ctrl+Shift+3` into a text
// field is asking them to know how this app spells things.
//
// The recorder swallows the keystroke it is listening for, which is why it is a
// capture-phase listener on the document and not a keydown on the button: the
// global handler below would otherwise act on the very chord being recorded, and
// pressing Ctrl+4 to bind something would open the dashboard on the way past.

export function renderKeymap(locked) {
    const s = state.settings;
    const clashes = keys.clashes();
    const clashed = new Set(clashes.map(c => c.combo));

    const groups = [];
    for (const c of keys.COMMANDS) {
        if (!groups.length || groups[groups.length - 1].name !== c.group) {
            groups.push({ name: c.group, rows: [] });
        }
        groups[groups.length - 1].rows.push(c);
    }

    // The clash line is only reachable from a hand-edited file — the recorder
    // refuses a chord that is already taken — so it says which and leaves the
    // fixing to you.
    return html`<div key="keymap" class="settings-keys">
        <div class="settings-keys-head">
            <span>Shortcuts</span>
            <span class="settings-keys-note">${
                'Every one needs Ctrl or Alt, or a function key — the composer is a '
                + 'text box and these have to work while you are typing in it.'}</span>
        </div>
        ${clashes.length ? html`<div class="settings-row-warn">${
            clashes.map(c => `${c.combo} is asked for by both ${c.labels.join(' and ')}; `
                + `${c.labels[0]} wins.`).join(' ')}</div>` : null}
        ${groups.map(g => html`<div key=${g.name} class="settings-keys-group">
            <div class="settings-keys-group-name">${g.name}</div>
            ${g.rows.map(c => keymapRow(c, locked, s.recording === c.id,
                clashed.has(keys.binding(c.id))))}
        </div>`)}
    </div>`;
}

function keymapRow(cmd, locked, recording, clashed) {
    const combo = keys.binding(cmd.id);
    const isDefault = keys.isDefault(cmd.id);
    return html`<div key=${cmd.id} class="settings-key-row"
        data-recording=${recording ? '' : undefined} data-clash=${clashed ? '' : undefined}>
        <span class="settings-key-label">${cmd.label}</span>
        ${recording
            ? html`<span class="settings-key-recording">Press a chord — Esc to cancel</span>`
            : html`<kbd class="settings-key-combo">${combo || 'unbound'}</kbd>`}
        <div class="settings-key-acts">
            <button class="linkish" type="button" disabled=${locked}
                onClick=${() => startRecording(recording ? null : cmd.id)}
                >${recording ? 'Cancel' : 'Change'}</button>
            ${combo ? html`<button class="linkish" type="button" disabled=${locked}
                title="Leave this command with no shortcut"
                onClick=${() => saveBinding(cmd.id, null)}>Unbind</button>` : null}
            ${isDefault ? null : html`<button class="linkish" type="button" disabled=${locked}
                title=${`Back to ${cmd.default}`}
                onClick=${() => saveBinding(cmd.id, undefined)}>Reset</button>`}
        </div>
    </div>`;
}

function startRecording(id) {
    state.settings.recording = id;
    renderSettings();
}

/**
 * Write one binding.
 *
 * `undefined` means "back to the default", which is spelled by *removing* the
 * id from the map rather than by writing the default into it — otherwise a
 * command whose default changes later would be pinned to the old one by a Reset
 * somebody clicked once. `null` means deliberately unbound, which is a value.
 *
 * The whole map goes over, because `keyboard.bindings` is one key as far as the
 * bridge is concerned; see the note on `put`.
 */
function saveBinding(id, combo) {
    const current = { ...(BOOT_PREFS.keyboard.bindings || {}) };
    if (combo === undefined) delete current[id];
    else current[id] = combo;
    state.settings.recording = null;
    // An empty map means every command is at its default, which is what absent
    // means too — so send the removal and leave no `"bindings": {}` behind in a
    // file somebody reads. Not a rule the bridge could apply to every map:
    // `spinner.groups: []` is a real answer, and dropping it would fall back to
    // the four groups the defaults name.
    saveSetting('keyboard', 'bindings', Object.keys(current).length ? current : null);
}

// Called from app.js where this listener used to be registered, so it keeps
// its place among the document's other keydown listeners.
export function wireShortcuts() {
    // Capture phase, and before the global handler: the chord being recorded must
    // not also do what it is currently bound to.
    document.addEventListener('keydown', (e) => {
        const id = state.settings.recording;
        if (!id) return;
        if (e.key === 'Escape') {
            e.preventDefault(); e.stopPropagation();
            startRecording(null);
            return;
        }
        const combo = keys.comboFromEvent(e);
        // A modifier held on its own is not a chord yet; keep listening rather than
        // treating the first frame of Ctrl+3 as a binding of its own.
        if (!combo) return;
        e.preventDefault();
        e.stopPropagation();
        if (!keys.allowed(combo)) {
            toast(`${combo} needs Ctrl or Alt, or has to be a function key.`, 'warn');
            return;
        }
        // Refused rather than saved-and-flagged. A conflict makes one of the two
        // commands unreachable, and the recorder is the one moment where saying so
        // costs nothing: it stays armed, so the answer is to press something else.
        const taken = keys.takenBy(combo);
        if (taken && taken !== id) {
            toast(`${combo} is already ${keys.labelOf(taken)}. Unbind that first, or pick another.`, 'warn');
            return;
        }
        saveBinding(id, combo);
    }, true);
}

/**
 * Put the current binding into every bit of chrome that names one.
 *
 * The bar buttons and their dynamic titles all used to have "(Ctrl+3)" written
 * into them, which a remap would have left lying. They go through keys.hint
 * instead, and this is what re-runs after a save.
 */
export function paintShortcutHints() {
    // Each of these builds its button's title from a count, so the shortcut has
    // to be re-inserted by the same function that writes the sentence.
    paintDashBadge();
    paintNotesBadge();
    paintTaskboardBadge();
    paintDraftsBadge();
    paintSchedBadge();
    paintLiveBadge();
    dom.btnSettings.title = keys.hint('Settings', 'view.settings');
    // Builds the terminal button's title from the session's cwd, and returns on
    // its own when there is no session to build one from.
    renderHeaderActions();
}
