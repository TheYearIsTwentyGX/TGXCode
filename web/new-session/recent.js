// The recent-directories menu on the New button's split half. Moved out of
// app.js as it was. wireNewMenu() binds the button and the click-outside rule,
// and is called by app.js where they ran.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.

import { dom, el } from '../dom.js';
import { clip } from '../format.js';
import { showQuota } from '../quota.js';
import { projectColor } from '../app.js';
import { showBarMore } from '../settings/toolbar.js';
import { loadProjects, openNew } from './dialog.js';

// ── the recent-directories menu ──────────────────────────────────────────

// Six, so the whole menu — including the way out of it — fits without
// scrolling. The dialog's Recent tab is still there for the long tail; this is
// meant to be the handful of directories you are actually in this week.
const NEW_MENU_MAX = 6;
let newMenuSeq = 0;

export function showNewMenu(on, { focusFirst = false } = {}) {
    dom.newMenu.hidden = !on;
    dom.btnNewMenu.setAttribute('aria-expanded', String(on));
    if (on) { showQuota(false); showBarMore(false); fillNewMenu({ focusFirst }); }
}

/**
 * Asked for on every open rather than cached.
 *
 * The endpoint is one pass over an index already in memory; the ordering is the
 * whole point of the menu and moves whenever a session writes a line; and
 * `state.browse.known` — the only list this page holds — is filled solely by
 * openNew(), so a cache-first menu would be empty on a fresh load where the
 * dialog has never been opened. That is the one click that has to work.
 */
async function fillNewMenu({ focusFirst = false } = {}) {
    const seq = ++newMenuSeq;
    dom.newMenu.replaceChildren(el('div', { class: 'menu-note' }, 'Loading…'));

    let projects;
    try {
        projects = await loadProjects();
    } catch (err) {
        if (seq === newMenuSeq) {
            dom.newMenu.replaceChildren(
                el('div', { class: 'menu-note' }, `Could not list projects: ${err.message}`));
        }
        return;
    }
    // Closed, or opened again behind this request.
    if (seq !== newMenuSeq || dom.newMenu.hidden) return;

    const rows = projects.slice(0, NEW_MENU_MAX).map((p, i) => el('button', {
        class: 'picker-row', type: 'button', role: 'menuitem', tabindex: -1,
        // The same dot the dialog's Recent list carries, for the same reason: this
        // menu is the short way to scope a session, so it is the place a colour
        // has to be readable before the press.
        'data-tinted': projectColor(p.cwd) ? '1' : null,
        style: projectColor(p.cwd) ? `--proj-accent: ${projectColor(p.cwd)}` : null,
        onclick: () => { showNewMenu(false); openNew({ cwd: p.cwd }); },
        onkeydown: (e) => onNewMenuKey(e, i),
    },
        el('span', { class: 'pdot' }, ''),
        el('span', {}, clip(p.name, 26)),
        // Green stays reserved for something actually running, as everywhere
        // else; the session count is the quieter fact.
        p.active
            ? el('span', { class: 'tag' }, `${p.active} live`)
            : el('span', { class: 'tag dim' }, String(p.sessions)),
        el('span', { class: 'path' }, clip(p.cwd, 44)),
    ));

    // The way out of a short list, for a directory with no history. It writes
    // `newPickerTab`, so the dialog opens on Browse next time too — which is
    // right: the app already remembers your last tab, and asking for Browse is
    // a statement about where you are working now.
    const browse = el('button', {
        class: 'picker-row', type: 'button', role: 'menuitem', tabindex: -1,
        onclick: () => { showNewMenu(false); openNew({ tab: 'browse' }); },
        onkeydown: (e) => onNewMenuKey(e, rows.length),
    }, el('span', {}, 'Another directory…'));

    // Flat, so every menuitem is a direct child of the menu.
    dom.newMenu.replaceChildren(
        ...(rows.length ? rows : [el('div', { class: 'menu-note' }, 'No directories yet.')]),
        el('div', { class: 'sep' }),
        browse,
    );
    const first = setNewMenuTab(0);
    if (focusFirst && first) first.focus();
}

// One tab stop for the whole menu, arrows to move within it — the folder tree's
// shape (setTreeTab), with wrapping, because a menu is a ring and a tree is not.
const newMenuRows = () => [...dom.newMenu.querySelectorAll('.picker-row')];

function setNewMenuTab(i = 0) {
    const rows = newMenuRows();
    rows.forEach((r, n) => { r.tabIndex = n === i ? 0 : -1; });
    return rows[i] || null;
}

function focusNewMenuAt(i) {
    const rows = newMenuRows();
    if (!rows.length) return;
    const n = ((i % rows.length) + rows.length) % rows.length;
    setNewMenuTab(n);
    rows[n].focus();
}

/** Escape is deliberately absent — the central ladder closes the menu. */
function onNewMenuKey(e, i) {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusNewMenuAt(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusNewMenuAt(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusNewMenuAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusNewMenuAt(-1); }
    else if (e.key === 'Tab') showNewMenu(false);
}

/** The split button's listeners, called by app.js where they always ran. */
export function wireNewMenu() {
    dom.btnNewMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        showNewMenu(dom.newMenu.hidden);
    });

    // Down on the caret is the keyboard's "open this and start choosing". The fill
    // is async, so the intent is carried into it rather than acted on here.
    dom.btnNewMenu.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        if (dom.newMenu.hidden) showNewMenu(true, { focusFirst: true });
        else focusNewMenuAt(e.key === 'ArrowDown' ? 0 : -1);
    });

    document.addEventListener('click', (e) => {
        if (!dom.newMenu.hidden && !e.target.closest('.new-wrap')) showNewMenu(false);
    });
}
