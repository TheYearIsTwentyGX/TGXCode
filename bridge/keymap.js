'use strict';

// The shortcuts the window's own keyboard answers to, and the grammar for
// writing one down.
//
// This exists because `keyboard.bindings` in `~/.tgxcode/settings.json` is a map
// keyed by command id, and a map whose valid keys live only in `web/app.js` is
// the exact shape of gap docs/api.md warns about: a client — or a person
// hand-editing the file — has no way to discover what may go in it, and a typo
// is indistinguishable from a setting that does not work. So the catalogue is
// here, where bridge/prefs.js can validate against it, `GET /api/keymap` can
// serve it, and every page gets it in a `cs-keymap` <meta> tag beside
// `cs-prefs`.
//
// **What is in the catalogue is deliberately narrow.** The window has around
// forty key handlers and only these thirteen are shortcuts in the sense worth
// remapping — a name for a place to go, or for an action, that happens to have a
// chord attached. The rest are widget semantics: arrows moving through a menu,
// Enter committing a text field, Escape dismissing what is on top, the Y/A/N
// letters on a card that already has the focus. Remapping those means breaking
// keyboard navigation, and the way back would be hand-editing this file, so they
// are not offered. Two things that *are* preferences about keys — what Enter
// does in the composer, and whether Ctrl+C copies in the terminal — are settings
// of their own in bridge/prefs.js rather than bindings, because each switches a
// pair of keys at once and a binding cannot say that.
//
// **Physical keys, not characters.** A combo names `e.code` and not `e.key`,
// which is the convention web/terminal.js already set with `e.code === 'KeyC'`.
// The reason is Shift: on a US layout `Shift+3` arrives as `e.key === '#'` and
// on a UK one as `£`, so a binding written against `e.key` works on one
// keyboard and silently fails on the next. `e.code` is the same everywhere.
// The cost is that a Dvorak layout binds where QWERTY's key sits, which is the
// trade every terminal makes and the lesser of the two.
//
// **Ctrl and Cmd are one modifier.** Every handler in the window has always
// tested `e.ctrlKey || e.metaKey`, and there is no Mac build to tell apart, so
// the canonical spelling is `Ctrl` and `Cmd+` is accepted as an alias when
// reading.

// Canonical key name -> the `e.code` it means. Letters, digits and arrows get a
// spelling somebody would type into a settings file; everything else is already
// its own code and is listed so the set is closed rather than open.
const CODE_BY_NAME = (() => {
    const out = {};
    for (let c = 65; c <= 90; c++) out[String.fromCharCode(c)] = `Key${String.fromCharCode(c)}`;
    for (let d = 0; d <= 9; d++) out[String(d)] = `Digit${d}`;
    for (let f = 1; f <= 12; f++) out[`F${f}`] = `F${f}`;
    Object.assign(out, {
        Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
        Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Space: 'Space',
        Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
        Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
        Minus: 'Minus', Equal: 'Equal', BracketLeft: 'BracketLeft',
        BracketRight: 'BracketRight', Backslash: 'Backslash', Semicolon: 'Semicolon',
        Quote: 'Quote', Backquote: 'Backquote', Comma: 'Comma', Period: 'Period',
        Slash: 'Slash',
    });
    return out;
})();

/** The reverse, for turning a keystroke somebody just pressed into a name. */
const NAME_BY_CODE = Object.fromEntries(
    Object.entries(CODE_BY_NAME).map(([name, code]) => [code, name]));

/** Every name a combo may end in — what `GET /api/keymap` publishes as `keys`. */
const KEY_NAMES = Object.keys(CODE_BY_NAME);

// Accepted on the way in, so a file written by hand is not rejected over a
// spelling. Only the values on the right are ever written back out.
const MOD_ALIASES = {
    ctrl: 'ctrl', control: 'ctrl', cmd: 'ctrl', command: 'ctrl', meta: 'ctrl', super: 'ctrl',
    alt: 'alt', option: 'alt', opt: 'alt',
    shift: 'shift',
};

// The window's shortcuts, in the order the settings page lists them — which is
// the order the bar reads in, because that ladder is itself an argument about
// how wide a question each view answers (see web/app.js, the Ctrl digit block).
const COMMANDS = [
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
];

const COMMAND_IDS = new Set(COMMANDS.map(c => c.id));

// A settings file naming more bindings than there are commands is either a
// mistake or an attempt to make the bridge do unbounded work, so the cap is the
// catalogue with room to grow rather than a round number.
const MAX_BINDINGS = 100;

/**
 * Read a combo written down as text.
 *
 * @returns {{ctrl: boolean, alt: boolean, shift: boolean, key: string}|null}
 *   null for anything this grammar does not accept, which the caller reports
 *   rather than guessing at.
 */
function parseCombo(str) {
    if (typeof str !== 'string') return null;
    // Split on the separator, but let a trailing one be the key rather than an
    // empty token: "Ctrl++" is then rejected for naming a key that is not in
    // the set — which is what it is — instead of for a stray separator.
    const parts = str.trim().split('+');
    if (parts.length > 1 && parts[parts.length - 1] === '') {
        parts.pop();
        parts[parts.length - 1] = '+';
    }
    if (parts.length < 1 || parts.some(p => p === '')) return null;

    const combo = { ctrl: false, alt: false, shift: false, key: '' };
    const raw = parts.pop();
    for (const part of parts) {
        const mod = MOD_ALIASES[part.trim().toLowerCase()];
        // A modifier twice over is a mistake worth reporting, not something to
        // quietly accept: "Ctrl+Ctrl+K" means the writer thinks it does
        // something.
        if (!mod || combo[mod]) return null;
        combo[mod] = true;
    }

    // Case-insensitive for names, because `ctrl+k` is what a hand writes.
    const name = KEY_NAMES.find(n => n.toLowerCase() === raw.trim().toLowerCase());
    if (!name) return null;
    combo.key = name;
    return combo;
}

/** Write one back out, modifiers always in this order. */
function formatCombo(combo) {
    if (!combo || !CODE_BY_NAME[combo.key]) return null;
    return [combo.ctrl && 'Ctrl', combo.alt && 'Alt', combo.shift && 'Shift', combo.key]
        .filter(Boolean).join('+');
}

/**
 * Is this a combo a global shortcut may have?
 *
 * The composer is a textarea and these fire while it has the focus, so a combo
 * with neither Ctrl nor Alt would swallow an ordinary keystroke — bind `K` and
 * the letter k stops being typeable, with hand-editing the settings file as the
 * only way back. Function keys are the exception because nothing types them,
 * which is what lets F3 be the default for the find repeat.
 */
function allowed(combo) {
    if (!combo) return false;
    if (combo.ctrl || combo.alt) return true;
    return /^F([1-9]|1[0-2])$/.test(combo.key);
}

/**
 * Text in, canonical text out — the one function bridge/prefs.js validates
 * with, so what is stored is always spelled the way this file spells it.
 *
 * @returns {string|null} null if it does not parse or is not allowed.
 */
function normalize(str) {
    const combo = parseCombo(str);
    if (!combo || !allowed(combo)) return null;
    return formatCombo(combo);
}

/** What the bridge publishes: the catalogue, and the closed set of key names. */
function payload() {
    return { commands: COMMANDS.map(c => ({ ...c })), keys: KEY_NAMES };
}

module.exports = {
    COMMANDS, COMMAND_IDS, KEY_NAMES, CODE_BY_NAME, NAME_BY_CODE, MAX_BINDINGS,
    parseCombo, formatCombo, allowed, normalize, payload,
};
