// Wispr Flow: the transform button beside each message box, and the Settings
// group that lists the transforms. Moved out of app.js as it was, with
// `wisprAvailable`, which is assigned here and read by settings/general.js.
//
// WISPR is filled by wireWispr() rather than built at load, because its two
// composers belong to slash.js and new-session/dialog.js and neither may have
// evaluated when this does. app.js calls wireWispr() from where the section's
// load-time code used to run.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.

import { get, post, put } from '../api.js';
import { BOOT_PREFS } from '../boot.js';
import { dom, el, toast } from '../dom.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { snipDeleteButton } from '../snippets/settings.js';
import { closeSnips } from '../snippets/popover.js';
import { newC } from '../new-session/dialog.js';
import { renderSettings, showSettings } from '../settings/index.js';
import { closeLater } from './later.js';
import { closeMenus, live } from './slash.js';

// ── Wispr Flow transforms ────────────────────────────────────────────────
//
// A button beside each message box lists the transforms set up under Settings →
// Wispr Flow. Picking one selects the text in the box, or keeps your selection
// if you made one, and asks the bridge to press the transform's chord. Wispr then
// rewrites the selection itself, and the textarea's own `input` listeners pick
// the change up the way they would a paste.
//
// The page cannot press the chord: a synthetic KeyboardEvent never leaves the
// renderer, and Wispr listens at the OS. So the bridge does it, by transform id,
// so a request can only ever press a chord the user set up. See bridge/wispr.js.

// Whether a Wispr Flow chord can reach anything from here: the bridge is on the
// Windows host and this page is on the same machine. Asked once at load by
// loadWisprAvailable(), and false until it answers, so nothing is drawn that
// might have to be taken away.
export let wisprAvailable = false;

// Filled by wireWispr(): the two composers belong to modules that may not have
// evaluated yet when this one does, so they cannot be read at load.
const WISPR = [];

/** Draw or hide everything Wispr, once the bridge has said whether a chord can land. */
function paintWisprAvailable() {
    for (const w of WISPR) {
        w.btn.parentElement.hidden = !wisprAvailable;
        if (!wisprAvailable) closeWispr(w);
    }
    if (state.settings.open) renderSettings();
}

/** Asked once at load. A Linux host and a remote caller both answer false. */
async function loadWisprAvailable() {
    try { wisprAvailable = Boolean((await get('/api/wispr')).available); }
    catch { wisprAvailable = false; }
    paintWisprAvailable();
}

function wisprRows(w) {
    return [...w.node.querySelectorAll('.later-row')];
}

function focusWisprAt(w, i) {
    const rows = wisprRows(w);
    if (!rows.length) return;
    w.index = Math.max(0, Math.min(i, rows.length - 1));
    rows[w.index].focus();
}

function showWispr(w, on) {
    if (!on) return closeWispr(w);
    // Only ever one popover up, the rule every other one here keeps.
    closeMenus(w.c);
    closeSnips(w.c);
    w.c.closeOthers();
    if (w.c === live) closeLater();
    for (const other of WISPR) if (other !== w) closeWispr(other);

    w.node.hidden = false;
    w.btn.setAttribute('aria-expanded', 'true');
    drawWispr(w);
    positionWispr(w);
    focusWisprAt(w, 0);
}

export function closeWispr(w, { focus = false } = {}) {
    if (w.node.hidden) return;
    w.node.hidden = true;
    w.node.replaceChildren();
    w.btn.setAttribute('aria-expanded', 'false');
    if (focus) w.btn.focus();
}

/** positionLater's arithmetic, against this composer's button. */
function positionWispr(w) {
    const r = w.btn.getBoundingClientRect();
    const gap = 6;
    const below = window.innerHeight - r.bottom - gap * 2;
    const above = r.top - gap * 2;
    const up = below < 220 && above > below;
    const width = Math.min(300, window.innerWidth - 24);

    w.node.classList.toggle('up', up);
    w.node.style.setProperty('--snip-max', `${Math.max(160, Math.min(420, up ? above : below))}px`);
    w.node.style.width = `${width}px`;
    w.node.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - width - 12))}px`;
    if (up) {
        w.node.style.top = 'auto';
        w.node.style.bottom = `${window.innerHeight - r.top + gap}px`;
    } else {
        w.node.style.bottom = 'auto';
        w.node.style.top = `${r.bottom + gap}px`;
    }
}

function drawWispr(w) {
    const list = BOOT_PREFS.wispr.transforms || [];
    const rows = list.map(t => el('button', {
        class: 'later-row', type: 'button', role: 'option',
        // Before the click, so the textarea keeps the selection it had.
        // Pressing a button would otherwise blur the box, and the selection
        // is read back from the box after that.
        onmousedown: (e) => e.preventDefault(),
        onclick: () => runWispr(w, t),
    }, el('span', {}, t.title), el('kbd', { class: 'at' }, t.combo)));

    if (!rows.length) {
        rows.push(el('button', {
            class: 'later-row', type: 'button', role: 'option',
            onclick: () => { closeWispr(w); openWisprSettings(); },
        }, el('span', {}, 'Set up transforms in Settings…')));
    }
    w.node.replaceChildren(...rows);
}

/**
 * Select the text and have the bridge press the chord.
 *
 * The focus has to be back in the box before the press lands, because Wispr acts
 * on the focused window's selection. `select()` only when nothing is selected, so
 * a transform can be aimed at one paragraph of a longer message.
 */
async function runWispr(w, t) {
    closeWispr(w);
    const box = w.c.input;
    box.focus();
    if (box.selectionStart === box.selectionEnd) box.select();
    try {
        await post('/api/wispr/press', { id: t.id });
    } catch (err) {
        toast(`Could not run ${t.title}: ${err.message}`, 'error');
    }
}

function onWisprKey(e, w) {
    const rows = wisprRows(w);
    if (!rows.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        focusWisprAt(w, (w.index + step + rows.length) % rows.length);
        return;
    }
    if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        focusWisprAt(w, e.key === 'Home' ? 0 : rows.length - 1);
        return;
    }
    // Escape is on the central ladder, like every other popover's.
    if (e.key === 'Tab') closeWispr(w);
}

// ── the settings group ───────────────────────────────────────────────────

/**
 * The rows being edited, which can be ahead of what is saved: a transform you
 * have just added has no title or shortcut yet, and the bridge refuses a list
 * with a half-written entry in it. So an incomplete row stays here until both
 * fields are filled, and is sent with the rest once they are.
 */
let wisprDraft = null;

function wisprId(title) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
    return `${slug || 't'}-${Math.random().toString(36).slice(2, 8)}`;
}

function openWisprSettings() {
    if (!state.settings.open) showSettings(true);
    requestAnimationFrame(() => {
        if (dom.setGWispr.isConnected) dom.setGWispr.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

export function renderWisprSettings() {
    dom.setGWispr.hidden = !wisprAvailable;
    // Never rebuilt under a caret. A save elsewhere redraws the panel, and doing
    // that while you are typing a title would drop the focus and the half-word.
    if (dom.wisprList.contains(document.activeElement)) return;
    const saved = BOOT_PREFS.wispr.transforms || [];
    const pending = (wisprDraft || []).filter(r => !saved.some(s => s.id === r.id) && !r.saved);
    wisprDraft = saved.map(t => ({ ...t, saved: true })).concat(pending);
    drawWisprRows();
}

/**
 * @param {{keepFocus?: boolean}} [opts] put the caret back where it was. A save
 *   lands after the change that caused it, by which time Tab has usually moved
 *   the focus on to the next field, and a redraw must not throw it out of there.
 */
function drawWisprRows({ keepFocus = false } = {}) {
    const at = document.activeElement;
    const had = keepFocus && dom.wisprList.contains(at)
        ? { row: [...dom.wisprList.children].indexOf(at.parentElement), cls: at.className,
            start: at.selectionStart, end: at.selectionEnd }
        : null;
    paintWisprRows();
    if (!had) return;
    const row = dom.wisprList.children[had.row];
    const back = row && row.querySelector(`.${had.cls}`);
    if (!back) return;
    back.focus();
    try { back.setSelectionRange(had.start, had.end); } catch { /* not a text field */ }
}

function paintWisprRows() {
    if (!wisprDraft.length) {
        dom.wisprList.replaceChildren(el('div', { class: 'settings-row-note' },
            'No transforms yet. Add one for each Wispr Flow transform you want a button for.'));
        return;
    }
    dom.wisprList.replaceChildren(...wisprDraft.map((r) => {
        const title = el('input', {
            type: 'text', class: 'wispr-set-title', value: r.title || '',
            placeholder: 'Prompt engineer', maxlength: '60', 'aria-label': 'Title',
            onchange: () => { r.title = title.value.trim(); saveWispr(r); },
        });
        const combo = el('input', {
            type: 'text', class: 'wispr-set-combo', value: r.combo || '',
            placeholder: 'Win+Alt+2', spellcheck: 'false', 'aria-label': 'Shortcut',
            onchange: () => { r.combo = combo.value.trim(); saveWispr(r); },
        });
        return el('div', { class: 'wispr-set-row' },
            title, combo,
            snipDeleteButton(`Remove ${r.title || 'this transform'}`, () => {
                wisprDraft = wisprDraft.filter(x => x !== r);
                drawWisprRows();
                saveWispr(null);
            }),
            r.error ? el('div', { class: 'wispr-set-error' }, r.error) : null);
    }));
}

/**
 * Send every complete row. The array is replaced whole on the bridge, which is
 * what PUT /api/prefs does to any key, so the draft is the whole truth.
 *
 * @param {object|null} row the row that changed, which is where a refusal is shown.
 */
async function saveWispr(row) {
    if (row) row.error = null;
    // Named after its title the first time it is saved, so the settings file
    // reads `prompt-engineer-…` rather than an id made before there was a title.
    // After that it never changes: it is what the popover presses by.
    for (const r of wisprDraft) if (!r.saved && r.title) r.id = wisprId(r.title);
    const complete = wisprDraft.filter(r => r.title && r.combo);
    // A row still being written is not worth a round trip, and sending it would be refused.
    if (row && !complete.includes(row)) { drawWisprRows(); return; }
    try {
        const answer = await put('/api/prefs', {
            scope: 'user',
            patch: {
                wispr: {
                    transforms: complete.length
                        ? complete.map(r => ({ id: r.id, title: r.title, combo: r.combo }))
                        : null,
                },
            },
        });
        BOOT_PREFS.wispr.transforms = (answer.prefs.wispr || {}).transforms || [];
        // What the bridge kept is spelled the way it spells it — `win+alt+2`
        // comes back `Win+Alt+2` — and that is what the row should now show.
        for (const r of wisprDraft) {
            const kept = BOOT_PREFS.wispr.transforms.find(t => t.id === r.id);
            if (kept) Object.assign(r, kept, { saved: true });
        }
    } catch (err) {
        if (row) row.error = err.message.replace(/^wispr\.transforms: /, '');
        else toast(`Could not save the transforms: ${err.message}`, 'error');
    }
    drawWisprRows({ keepFocus: true });
}


/**
 * Everything the Wispr section did at load, in the order it did it. Called by
 * app.js from where the section used to be.
 */
export function wireWispr() {
    WISPR.push(
        { c: live, btn: dom.btnWispr, node: dom.wisprMenu, index: 0 },
        { c: newC, btn: dom.newBtnWispr, node: dom.newWisprMenu, index: 0 },
    );
    for (const w of WISPR) w.c.wispr = w;

    dom.btnWispr.append(icon('wispr', 17));
    dom.newBtnWispr.append(icon('wispr', 15));

    for (const w of WISPR) {
        w.btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showWispr(w, w.node.hidden);
        });
        w.node.addEventListener('keydown', (e) => onWisprKey(e, w));
    }
    document.addEventListener('click', () => { for (const w of WISPR) closeWispr(w); });
    window.addEventListener('resize', () => {
        for (const w of WISPR) if (!w.node.hidden) positionWispr(w);
    });
    dom.newScrim.querySelector('.modal-body').addEventListener('scroll', () => {
        if (!dom.newWisprMenu.hidden) positionWispr(WISPR[1]);
    });

    dom.wisprAdd.addEventListener('click', () => {
        if (!wisprDraft) wisprDraft = [];
        const r = { id: wisprId(''), title: '', combo: '', saved: false };
        wisprDraft.push(r);
        drawWisprRows();
        const inputs = dom.wisprList.querySelectorAll('.wispr-set-title');
        if (inputs.length) inputs[inputs.length - 1].focus();
    });

    loadWisprAvailable();
}
