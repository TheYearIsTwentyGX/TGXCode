// Folding the long rows in Settings — the permission lists, the hooks, the
// plugins, the verb-group pills, the shortcut table. Each is a list that can
// run to dozens of entries and push every group under it out of reach.
//
// **Driven by state, not by <details>.** The Claude Code group is rebuilt with
// el() on every renderSettings(), which is twice per save, so an `open`
// attribute the browser kept on the node would be lost the moment anything was
// saved. The fold is a fact in `state.settings.folds` and the row is drawn from
// it, the way `hk-more` recomputes its own `open`.
//
// **Only an explicit choice is stored.** A row nobody has touched is open while
// it is short and shut once it is long (LONG entries), so a list of two rules
// never hides them behind a click — and a choice, once made, stands whatever
// the list grows to. Per-browser, in localStorage, like the rail's collapsed
// groups: how a page is laid out for you is not a setting a file should carry.
//
// Two builders, because the panel is both: foldLabel() for the el() groups and
// foldLabelV() for the Preact ones. Both put the caret and the label in one
// button, so the whole label is the target.

import { html } from '../vendor/preact.js';
import { el } from '../dom.js';
import { ICON, icon } from '../icons.js';
import { state } from '../state.js';
import { renderSettings } from './index.js';

/** A list longer than this starts shut until somebody opens it. */
export const LONG = 8;

export function isOpen(key, long = false) {
    const f = state.settings.folds;
    return Object.prototype.hasOwnProperty.call(f, key) ? f[key] : !long;
}

export function setFold(key, open) {
    state.settings.folds[key] = open;
    try { localStorage.setItem('settingsFolds', JSON.stringify(state.settings.folds)); }
    catch { /* storage refused — the fold still holds until the page reloads */ }
}

const flip = (key, open) => { setFold(key, !open); renderSettings(); };

/** The label as a toggle, for rows built with el(). */
export function foldLabel(key, open, label, cls = 'set-fold') {
    return el('button', {
        class: cls, type: 'button', 'aria-expanded': open ? 'true' : 'false',
        title: open ? 'Fold this away' : 'Show all of it',
        onclick: () => flip(key, open),
    }, el('span', { class: 'set-fold-caret' }, icon('caret', 12)), label);
}

/** The same, as a vnode. */
export function foldLabelV(key, open, label, cls = 'set-fold') {
    return html`<button class=${cls} type="button" aria-expanded=${open ? 'true' : 'false'}
        title=${open ? 'Fold this away' : 'Show all of it'}
        onClick=${() => flip(key, open)}><span class="set-fold-caret"><svg width="12" height="12"
        viewBox="0 0 24 24" fill="none" aria-hidden="true"
        dangerouslySetInnerHTML=${{ __html: ICON.caret }}></svg></span>${label}</button>`;
}
