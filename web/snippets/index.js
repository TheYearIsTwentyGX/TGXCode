// Snippets: canned messages, and the buttons that send them.
//
// Drafts' machinery for the list itself — an unconditional `snippets-changed`
// push carrying the whole payload, held as sent, no watcher to gate — with one
// difference that shapes everything in this directory: **this list is read while
// its editor is shut.** The pinned buttons live on the composer, so it loads at
// boot rather than when a panel opens, and every push repaints three places
// rather than one.
//
// **The bridge decides the order**, which is why nothing here sorts. `order` is a
// stored decision and `null` means alphabetical, and having the store settle that
// is what keeps the popover, the pinned strip and the editor from each arriving at
// a slightly different answer.
//
// The feature is split by surface, each drawn with Preact the way web/rail.js
// settled — htm templates, no build step, keyed children, no hand edits to nodes
// Preact owns:
//
//   index.js    this file — the list, the rules every surface shares, and wiring
//   popover.js  the popover on each composer, choosing a snippet, the fill dialog
//   pins.js     the pinned buttons beside the composer's snippets icon
//   settings.js the editor group in Settings, its drag-to-reorder, and the
//               arm-then-confirm delete button other Settings groups borrow
//   editor.js   one snippet, in the editor dialog
//
// Every module here evaluates before app.js's body does, so none may read an
// imported app.js binding at top level — only inside a function called later.
// Load-time listeners are in wireSnippets(), which app.js calls where they
// always registered.

import { get } from '../api.js';
import { state } from '../state.js';
import { dom, closeOnClickOutside } from '../dom.js';
import { clip } from '../format.js';
import { icon } from '../icons.js';
import { hexAccent } from '../app.js';
import { composers, live } from '../composer/slash.js';
import { newC } from '../new-session/dialog.js';
import {
    closeSnipFill, confirmSnipFill, drawSnips, onSnipsKey, showSnips,
} from './popover.js';
import { renderPins } from './pins.js';
import { newSnipGroup, renderSnipSettings } from './settings.js';
import { closeSnipEditor, openSnipEditor } from './editor.js';

/** The same expression the bridge substitutes with. Two would be one too many. */
export const SNIP_PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

export const snipById = (id) => state.snippets.rows.find(s => s.id === id) || null;

/**
 * Take the whole payload as the truth, and repaint everything drawn from it.
 *
 * Three places rather than drafts' one, because two of them are visible when the
 * editor is not: the pinned buttons on the composer, and a popover that may be
 * open over it while another window saves an edit.
 *
 * An arrangement held in the editor (`state.snippets.order`, see settings.js) is
 * dropped here, because this payload is the bridge's answer to it — unless the
 * save that produced it is still going, in which case this is only one of the
 * pushes its own writes provoke on the way, or a drag is still in the air, which
 * needs it to go on moving the row.
 */
export function applySnippets(data) {
    state.snippets.rows = data.snippets || [];
    state.snippets.groups = data.groups || [];
    state.snippets.at = data.at || Date.now();
    state.snippets.error = null;
    if (!state.snippets.committing && !state.snippets.drag) state.snippets.order = null;
    renderPins();
    for (const c of composers) if (!c.snips.node.hidden) drawSnips(c);
    if (state.settings.open) renderSnipSettings();
}

export async function loadSnippets() {
    if (state.snippets.loading) return;
    state.snippets.loading = true;
    try {
        // Never with `?cwd=`, even though the route offers it. The event is not
        // filtered — one payload goes to every window — so a narrowed first load
        // would silently widen the moment anybody edited anything. The filter is
        // applied here instead, per composer, which is where the directory is
        // actually known.
        applySnippets(await get('/api/snippets'));
    } catch (err) {
        state.snippets.error = err.message;
    }
    state.snippets.loading = false;
}

/**
 * Does this snippet belong in a composer pointed at this directory?
 *
 * The bridge's `matchesCwd`, in the client because `web/` has no build step and
 * shares no code with `bridge/`. A prefix at a path boundary: `/a/b` covers
 * `/a/b/c` and not `/a/bc`, which is a different repository sharing five
 * characters.
 *
 * **Fails open when the directory is unknown.** A composer with no session in it
 * should show every snippet rather than none, and `state.current.cwd` is a cache
 * key rather than the authority — the bridge is what resolves a session to a
 * directory, through worktrees that have since been landed and removed.
 */
export function snipVisible(s, cwd) {
    if (!s.projects || !s.projects.length) return true;
    if (!cwd) return true;
    const here = String(cwd).replace(/[/\\]+$/, '');
    return s.projects.some(p => here === p
        || here.startsWith(p + '/') || here.startsWith(p + '\\'));
}

/** One line of what it says, for the row under the title. */
export const snipPreview = (s) => clip(s.body, 120);

/** A group's stored accent, through the one gate the page has — see hexAccent. */
export const snipAccent = (g) => (g ? hexAccent(g.accent) : '');

/**
 * Fill a body from the answers, and leave alone what it cannot answer.
 *
 * The bridge's `fillBody`, and the rule it enforces is worth restating where it is
 * duplicated: a placeholder with no answer falls back to its default and then to
 * itself, **never to the empty string**. `{{` is not reserved punctuation in
 * prose, and blanking what this does not recognise would quietly delete part of a
 * message somebody wrote.
 */
export function fillSnipBody(body, params, answers) {
    const known = new Map((params || []).map(p => [p.name, p.default]));
    return String(body).replace(SNIP_PLACEHOLDER, (whole, key) => {
        if (!known.has(key)) return whole;
        const given = answers[key];
        if (given !== undefined && given !== null && given !== '') return String(given);
        const fallback = known.get(key);
        return fallback === null || fallback === undefined ? whole : fallback;
    });
}

/**
 * Every listener the snippets surfaces register at load.
 *
 * Called by app.js where these always registered, beside the rest of the
 * composer's wiring. One click on a snippet, and no confirmation over the top of
 * it: the click *is* the approval, and the session still asks for whatever its
 * permission mode makes it ask for before anything is pushed or merged.
 */
export function wireSnippets() {
    dom.btnSnippets.addEventListener('click', (e) => {
        e.stopPropagation();
        showSnips(live, dom.snipMenu.hidden);
    });
    dom.newBtnSnippets.addEventListener('click', (e) => {
        e.stopPropagation();
        showSnips(newC, dom.newSnipMenu.hidden);
    });
    dom.snipMenu.addEventListener('keydown', (e) => onSnipsKey(e, live));
    dom.newSnipMenu.addEventListener('keydown', (e) => onSnipsKey(e, newC));

    // ✕, Cancel and a whole click outside, on both — no Escape; see modalUp().
    for (const n of dom.snipFillScrim.querySelectorAll('[data-close-fill]')) {
        n.addEventListener('click', closeSnipFill);
    }
    closeOnClickOutside(dom.snipFillScrim, closeSnipFill);
    dom.snipFillGo.addEventListener('click', confirmSnipFill);
    // Enter in a one-line box confirms. There is no textarea parameter type, so
    // nothing in this form wants the key for itself.
    dom.snipFillForm.addEventListener('submit', (e) => { e.preventDefault(); confirmSnipFill(); });

    // The glyph goes in from script rather than being written into the markup,
    // because every other icon in this app comes out of the ICON map.
    dom.btnSnippets.append(icon('snippets', 17));

    // The editor dialog's own controls are its component's (editor.js); the
    // scrim around it is web/index.html's, and so is a click outside it.
    closeOnClickOutside(dom.snipEditScrim, closeSnipEditor);
    dom.snipNew.addEventListener('click', () => openSnipEditor(null));
    dom.snipGroupNew.addEventListener('click', newSnipGroup);
}
