// Which chord means which command, and the one function that decides it.
//
// Every shortcut in this window used to be an `if` in the global keydown
// handler, with the combo written into the condition — thirteen of them, all
// spelled slightly differently. That was fine while none of them could change.
// Once they can, the condition has to come from somewhere, so it comes from
// here: the catalogue arrives from the bridge (bridge/keymap.js, via the
// `cs-keymap` <meta> tag), `keyboard.bindings` from settings folds over the
// defaults, and `match()` turns a KeyboardEvent into a command id or null.
//
// **The matcher is strict, which is a change of behaviour.** The old
// conditions tested `e.ctrlKey || e.metaKey` and the key, and mostly forgot
// Shift — so Ctrl+Shift+K opened the filter and Ctrl+Shift+3 opened the live
// board, neither of which was meant. A combo now has to agree about all three
// modifiers, so those stop firing and Ctrl+Shift+3 is free to be bound to
// something.
//
// **Physical keys.** A binding names `e.code`, for the reason bridge/keymap.js
// gives: Shift+3 is `#` on one layout and `£` on another, and `e.code` is
// `Digit3` on both. The only translation this file does is the handful of names
// that read better than their code — `Up` for `ArrowUp`, `K` for `KeyK`.

const FALLBACK = {
    commands: [
        { id: 'view.conversation', group: 'Views', label: 'The conversation', default: 'Ctrl+1' },
        { id: 'view.tasks', group: 'Views', label: 'Tasks', default: 'Ctrl+2' },
        { id: 'view.live', group: 'Views', label: 'Live', default: 'Ctrl+3' },
        { id: 'view.dashboard', group: 'Views', label: 'Dashboard', default: 'Ctrl+4' },
        { id: 'view.history', group: 'Views', label: 'History', default: 'Ctrl+5' },
        { id: 'view.drafts', group: 'Views', label: 'Drafts', default: 'Ctrl+6' },
        { id: 'view.schedules', group: 'Views', label: 'Schedules', default: 'Ctrl+7' },
        { id: 'view.settings', group: 'Views', label: 'Settings', default: 'Ctrl+8' },
        { id: 'session.new', group: 'Sessions', label: 'Start a session', default: 'Ctrl+N' },
        { id: 'rail.filter', group: 'Sessions', label: 'Filter sessions', default: 'Ctrl+K' },
        { id: 'find.open', group: 'Find', label: 'Find in conversation', default: 'Ctrl+F' },
        { id: 'find.next', group: 'Find', label: 'Next match', default: 'F3' },
        { id: 'find.prev', group: 'Find', label: 'Previous match', default: 'Shift+F3' },
    ],
    keys: [],
};

// The catalogue, read once. A window that somehow got no tag still has working
// shortcuts on the defaults above — the same bargain BOOT_PREFS strikes, and for
// the same reason: a keystroke can land before any fetch could answer.
const KEYMAP = (() => {
    try {
        const m = document.querySelector('meta[name="cs-keymap"]');
        if (!m) return FALLBACK;
        const d = JSON.parse(decodeURIComponent(m.content));
        if (!d || !Array.isArray(d.commands) || !d.commands.length) return FALLBACK;
        return { commands: d.commands, keys: Array.isArray(d.keys) ? d.keys : [] };
    } catch { return FALLBACK; }
})();

export const COMMANDS = KEYMAP.commands;

/** Command id -> its entry, for the label and the default. */
const BY_ID = new Map(COMMANDS.map(c => [c.id, c]));

// `e.code` -> the name a binding spells it with. Only the codes that do not
// spell themselves; anything else is its own name, which is why this is five
// entries and not seventy.
const NAME_BY_CODE = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

/**
 * The canonical spelling of a keystroke, or null for one no binding can name.
 *
 * Modifier keys pressed on their own are the null case and the reason this is
 * not just string concatenation: holding Ctrl fires a keydown whose own code is
 * `ControlLeft`, and every frame of a held chord would otherwise be a candidate.
 */
export function comboFromEvent(e) {
    const code = e.code || '';
    if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code)) return null;
    let key = NAME_BY_CODE[code] || code;
    if (/^Key[A-Z]$/.test(key)) key = key.slice(3);
    else if (/^Digit[0-9]$/.test(key)) key = key.slice(5);
    if (KEYMAP.keys.length && !KEYMAP.keys.includes(key)) return null;
    // Ctrl and Cmd are one modifier, as every handler in this window has always
    // treated them.
    return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key]
        .filter(Boolean).join('+');
}

/**
 * Is this a combo a global shortcut may have?
 *
 * The same rule bridge/prefs.js enforces on the way in — see `allowed()` in
 * bridge/keymap.js for why. Repeated here so the settings page can say no
 * before it sends rather than showing a 400.
 */
export function allowed(combo) {
    if (typeof combo !== 'string' || !combo) return false;
    const parts = combo.split('+');
    const key = parts.pop();
    if (parts.includes('Ctrl') || parts.includes('Alt')) return true;
    return /^F([1-9]|1[0-2])$/.test(key);
}

// combo -> command id, rebuilt whenever settings change. A map rather than a
// scan because this is consulted on every keydown in the window, including
// every keystroke typed into the composer.
let byCombo = new Map();

// What each command is bound to right now, including the ones left at their
// default and the ones deliberately unbound (null).
let bound = new Map();

// Combos two commands both asked for. The settings page reports these; the
// matcher gives the first one the catalogue lists, so the window stays
// predictable rather than depending on object key order.
let conflicts = [];

/**
 * Fold `keyboard.bindings` over the defaults.
 *
 * Called at boot and after every save. Idempotent, and safe to call with
 * nothing: a missing block means every command is at its default, which is also
 * the state a fresh install is in.
 *
 * @param {object} [keyboard] the `keyboard` block from settings
 */
export function apply(keyboard) {
    const overrides = (keyboard && keyboard.bindings) || {};
    bound = new Map();
    byCombo = new Map();
    conflicts = [];
    for (const c of COMMANDS) {
        // `null` is an override too — deliberately unbound is a thing you can
        // ask for, and is not the same as absent.
        const combo = Object.prototype.hasOwnProperty.call(overrides, c.id)
            ? overrides[c.id] : c.default;
        bound.set(c.id, combo || null);
        if (!combo) continue;
        if (byCombo.has(combo)) conflicts.push({ combo, ids: [byCombo.get(combo), c.id] });
        else byCombo.set(combo, c.id);
    }
}

apply(null);

/** The command a keystroke means, or null. */
export function match(e) {
    const combo = comboFromEvent(e);
    return (combo && byCombo.get(combo)) || null;
}

/** What a command is bound to, or null if it is unbound. */
export const binding = (id) => bound.get(id) ?? null;

/** Whether a command is at its default. */
export const isDefault = (id) => {
    const c = BY_ID.get(id);
    return !!c && bound.get(id) === c.default;
};

/** The combo for a tooltip — a plain string, or '' when nothing is bound. */
export const label = (id) => bound.get(id) || '';

/**
 * Combos more than one command asked for, by label. Empty is the normal case.
 *
 * The recorder refuses a chord that is already taken, so the only way to get
 * here is a hand-edited settings file — which is exactly why it is still
 * reported rather than trusted away.
 */
export const clashes = () => conflicts.map(c => ({
    combo: c.combo,
    labels: c.ids.map(id => (BY_ID.get(id) || {}).label || id),
}));

/** Which command already holds this combo, or null. */
export const takenBy = (combo) => byCombo.get(combo) || null;

/** A command's display name. */
export const labelOf = (id) => (BY_ID.get(id) || {}).label || id;

/**
 * A tooltip with the shortcut on the end, or without it when there is none.
 *
 * Every bar button says "(Ctrl+3)" in its title, and a remapped binding that
 * left the chrome saying the old one would be worse than a button with no hint
 * at all — so the parenthesis is built here rather than written into the markup.
 */
export function hint(text, id) {
    const combo = label(id);
    return combo ? `${text} (${combo})` : text;
}
