'use strict';

// Pressing a Wispr Flow shortcut on the user's behalf.
//
// Wispr Flow is a dictation app on the Windows host, and its *transforms* —
// "prompt engineer", "make it shorter" — rewrite whatever text is selected in
// the focused window when you press the chord you gave them. The composer
// buttons exist so that you do not have to remember which chord is which: pick
// a transform from a list, and the page selects the text and this module
// presses the chord.
//
// **Why the bridge and not the page.** A page cannot press a key anywhere but in
// itself — a synthetic KeyboardEvent never leaves the renderer, and Wispr is
// listening at the OS. The Electron shell could do it, but app/preload.js is
// deliberately one door wide, and a change there needs a rebuild of the shell
// the user is looking at. The bridge can already run Windows programs (see
// bridge/explorer.js), so it runs `powershell.exe` and has it call
// user32!SendInput. Windows PowerShell 5.1 is on every Windows machine, and
// `Add-Type` compiles the few lines of C# that call SendInput.
//
// **One process per press.** A warm PowerShell reading chords off stdin was the
// first design, because `Add-Type` compiles C# on every start. Measured, a cold
// start is about 0.6 s end to end, and that is less than the time Wispr itself
// takes to answer. A long-lived process would have needed an idle timer, a
// restart when it died, and a way to tell a slow press from a hung one. None of
// that is worth 0.6 s.
//
// **Only chords the user configured.** The route that reaches press() takes a
// transform's *id* and looks the chord up in `wispr.transforms` in the user's
// settings. It never accepts a chord from the request. So a caller holding the
// token can press what the user set up, and nothing else — no Alt+F4, no
// Win+L. `wispr` is USER_ONLY in bridge/prefs.js for the same reason: a
// repository's settings file must not be able to choose which keys get pressed
// on your desktop.
//
// **Windows only.** Wispr Flow has no Linux build, so on a Linux host there is
// nothing for a chord to reach. available() says so, and the page hides the
// buttons rather than drawing ones that cannot work.
//
// The chord grammar is keymap.js's key names with its own modifiers. It does
// not reuse keymap.parseCombo, because that folds Meta and Super into Ctrl —
// right for the window's shortcuts, where Ctrl and Cmd are one modifier, and
// wrong here, where Win+Alt+2 and Ctrl+Alt+2 are different chords.

const { execFile } = require('child_process');
const { CODE_BY_NAME, KEY_NAMES } = require('./keymap');
const { isWsl } = require('./platform');

// Canonical order, which is the order they are written back out and pressed.
const MODS = ['win', 'ctrl', 'alt', 'shift'];
const MOD_LABEL = { win: 'Win', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };
const MOD_ALIASES = {
    win: 'win', windows: 'win', super: 'win', meta: 'win', cmd: 'win',
    ctrl: 'ctrl', control: 'ctrl',
    alt: 'alt', option: 'alt', opt: 'alt',
    shift: 'shift',
};

// Windows virtual-key codes. Left Win rather than either: VK_LWIN is what the
// physical key sends, and some hooks check for it by name.
const MOD_VK = { win: 0x5B, ctrl: 0x11, alt: 0x12, shift: 0x10 };
const KEY_VK = {
    Up: 0x26, Down: 0x28, Left: 0x25, Right: 0x27,
    Enter: 0x0D, Escape: 0x1B, Tab: 0x09, Space: 0x20,
    Backspace: 0x08, Delete: 0x2E, Insert: 0x2D,
    Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
    Minus: 0xBD, Equal: 0xBB, BracketLeft: 0xDB, BracketRight: 0xDD,
    Backslash: 0xDC, Semicolon: 0xBA, Quote: 0xDE, Backquote: 0xC0,
    Comma: 0xBC, Period: 0xBE, Slash: 0xBF,
};

const MAX_TRANSFORMS = 20;
const MAX_TITLE = 60;
const ID_RE = /^[a-z0-9-]{1,40}$/;
const PRESS_TIMEOUT_MS = 8000;

/**
 * Read a chord written as text, e.g. `win+alt+2`.
 *
 * @returns {{win, ctrl, alt, shift: boolean, key: string}|null}
 */
function parseCombo(str) {
    if (typeof str !== 'string') return null;
    const parts = str.trim().split('+').map(p => p.trim());
    // "Ctrl++" is not a key this grammar has, so there is no trailing-separator
    // case to rescue the way keymap.js does.
    if (!parts.length || parts.some(p => p === '')) return null;
    const combo = { win: false, ctrl: false, alt: false, shift: false, key: '' };
    const raw = parts.pop();
    for (const part of parts) {
        const mod = MOD_ALIASES[part.toLowerCase()];
        if (!mod || combo[mod]) return null;
        combo[mod] = true;
    }
    const name = KEY_NAMES.find(n => n.toLowerCase() === raw.toLowerCase());
    if (!name) return null;
    combo.key = name;
    // A bare letter would be pressed into the composer as a letter, which is
    // not a shortcut. Function keys are the exception, as they are in keymap.js.
    if (!MODS.some(m => combo[m]) && !/^F([1-9]|1[0-2])$/.test(name)) return null;
    return combo;
}

function formatCombo(combo) {
    return MODS.filter(m => combo[m]).map(m => MOD_LABEL[m]).concat(combo.key).join('+');
}

/** Text in, canonical text out (`Win+Alt+2`), or null. */
function normalize(str) {
    const combo = parseCombo(str);
    return combo ? formatCombo(combo) : null;
}

/** The virtual-key codes to press, modifiers first. */
function toVk(combo) {
    const code = CODE_BY_NAME[combo.key];
    let key;
    if (/^Key[A-Z]$/.test(code)) key = code.charCodeAt(3);
    else if (/^Digit\d$/.test(code)) key = 0x30 + Number(code[5]);
    else if (/^F\d+$/.test(code)) key = 0x6F + Number(code.slice(1));
    else key = KEY_VK[combo.key];
    if (!key) return null;
    return MODS.filter(m => combo[m]).map(m => MOD_VK[m]).concat(key);
}

/**
 * `wispr.transforms`, entry by entry — the shape of cleanBindings in
 * bridge/prefs.js, for its reason: one bad chord in a hand-edited file must not
 * throw away the transforms beside it.
 *
 * @returns {Array<{id, title, combo}>|undefined} undefined when the value is not
 *   a list at all, which leaves the default alone.
 */
function cleanTransforms(value, note) {
    if (!Array.isArray(value)) return undefined;
    const out = [];
    const ids = new Set();
    for (const raw of value) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            note(`${JSON.stringify(raw)} is not a transform`);
            continue;
        }
        const id = raw.id;
        if (typeof id !== 'string' || !ID_RE.test(id)) {
            note(`${JSON.stringify(id)} is not a transform id — lower-case letters, digits and dashes`);
            continue;
        }
        if (ids.has(id)) {
            note(`${JSON.stringify(id)} is listed twice`);
            continue;
        }
        const title = typeof raw.title === 'string' ? raw.title.trim() : '';
        if (!title || title.length > MAX_TITLE) {
            note(`transform ${JSON.stringify(id)} needs a title of 1 to ${MAX_TITLE} characters`);
            continue;
        }
        const combo = normalize(raw.combo);
        if (!combo) {
            note(`${JSON.stringify(raw.combo)} is not a usable shortcut for ${JSON.stringify(title)}`
                + ' — e.g. Win+Alt+2');
            continue;
        }
        if (out.length >= MAX_TRANSFORMS) {
            note(`more than ${MAX_TRANSFORMS} transforms — the rest dropped`);
            break;
        }
        ids.add(id);
        out.push({ id, title, combo });
    }
    return out;
}

/** The last gate, after cleanTransforms has already dropped what fails. */
function validTransforms(v) {
    return Array.isArray(v) && v.length <= MAX_TRANSFORMS && v.every(t => t
        && ID_RE.test(t.id) && typeof t.title === 'string' && t.title.length > 0
        && t.title.length <= MAX_TITLE && normalize(t.combo) === t.combo);
}

/** Is there anything for a chord to reach? */
function available() {
    return isWsl();
}

/**
 * The PowerShell that presses one chord.
 *
 * The codes are baked into the script rather than passed as arguments: they are
 * integers this module computed, so there is nothing to quote, and the script
 * goes over as -EncodedCommand so nothing is quoted on the way either.
 *
 * Downs in order, ups in reverse, in one SendInput call so nothing can land
 * between them. A scan code goes with each key because some keyboard hooks read
 * that rather than the virtual key. Arrows, navigation keys and Win are
 * *extended* keys, and without the flag Windows reads them as the numeric keypad.
 */
function script(vks) {
    return `$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class CsWisprKeys {
  [StructLayout(LayoutKind.Sequential)] struct KI { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KI ki; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  static bool Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B; }
  static INPUT Key(ushort vk, bool up) {
    var i = new INPUT(); i.type = 1; i.ki.vk = vk; i.ki.scan = (ushort)MapVirtualKey(vk, 0);
    i.ki.flags = (up ? 2u : 0u) | (Extended(vk) ? 1u : 0u); return i;
  }
  public static uint Press(ushort[] vks) {
    var list = new INPUT[vks.Length * 2];
    for (int i = 0; i < vks.Length; i++) list[i] = Key(vks[i], false);
    for (int i = 0; i < vks.Length; i++) list[vks.Length + i] = Key(vks[vks.Length - 1 - i], true);
    return SendInput((uint)list.Length, list, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
[Console]::Out.WriteLine([CsWisprKeys]::Press([UInt16[]]@(${vks.join(',')})))
`;
}

/**
 * Press a chord on the Windows desktop.
 *
 * It goes to whichever window has the focus, which is the point: the page has
 * just focused its composer and selected the text, so the window is this app.
 *
 * @param {string} comboText a canonical chord, as stored in `wispr.transforms`
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
function press(comboText) {
    if (!available()) {
        return Promise.resolve({ ok: false, error: 'Wispr Flow shortcuts need the Windows host' });
    }
    const combo = parseCombo(comboText);
    const vks = combo && toVk(combo);
    if (!vks) return Promise.resolve({ ok: false, error: `${JSON.stringify(comboText)} is not a usable shortcut` });

    const encoded = Buffer.from(script(vks), 'utf16le').toString('base64');
    return new Promise((resolve) => {
        // cwd on a Windows drive, for the reason bridge/devbrowser.js gives:
        // a Windows program started from a \\wsl.localhost cwd warns and may bail.
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            { cwd: '/mnt/c', timeout: PRESS_TIMEOUT_MS, windowsHide: true },
            (err, stdout) => {
                if (err && err.code === 'ENOENT') {
                    return resolve({ ok: false, error: 'powershell.exe not found on PATH' });
                }
                if (err) return resolve({ ok: false, error: err.killed ? 'PowerShell timed out' : 'PowerShell failed' });
                // SendInput answers with how many events it injected. Fewer
                // than all of them means something blocked the input — UIPI,
                // when the focused window is elevated and this is not.
                const sent = parseInt(String(stdout).trim(), 10);
                if (sent !== vks.length * 2) {
                    return resolve({ ok: false, error: 'Windows refused the keystrokes (is the focused window running as administrator?)' });
                }
                resolve({ ok: true });
            });
    });
}

module.exports = {
    parseCombo, formatCombo, normalize, toVk, cleanTransforms, validTransforms,
    available, press, MAX_TRANSFORMS, MAX_TITLE,
};
