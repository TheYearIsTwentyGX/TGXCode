// The pinned snippets: a button per pinned snippet, beside the composer's
// snippets icon.
//
// Drawn with Preact and keyed by snippet id, so a push that edits one snippet
// leaves the other buttons — and a press in progress on one — alone. The strip
// (`#pins`) is web/index.html's; everything inside it is Preact's, which is why
// turning the buttons on and off is a render here rather than a loop setting
// `disabled` in web/composer/send.js.
//
// See index.js for the rule every module here follows about app.js bindings.

import { html } from '../vendor/preact.js';
import { state } from '../state.js';
import { dom } from '../dom.js';
import { paint } from '../boards/parts.js';
import { live } from '../composer/slash.js';
import { isBusy } from '../transcript/conversation.js';
import { snipAccent, snipVisible } from './index.js';
import { chooseSnippet, openSnipMenu, snipTitleFor } from './popover.js';

/**
 * Draw the strip.
 *
 * Called when somebody edits a snippet, when the open session moves to a
 * different directory — which is why `openSession` calls it: a snippet scoped to a
 * project appears and disappears as you switch conversations — and whenever the
 * send controls turn on or off or the runner changes what a send would do.
 *
 * Disabled from `dom.btnSend` rather than from state, so there is one answer to
 * "can this session be sent to" and a repaint cannot briefly draw a live button
 * into a window with no session in it.
 *
 * @param {boolean} [busy] whether a send would queue behind a running turn, for
 *   the titles. The runner passes the answer it has just worked out; everyone
 *   else lets it be asked.
 */
export function renderPins(busy = isBusy() && !state.agent) {
    const cwd = state.current && state.current.cwd;
    // Already in display order: the bridge decides it, so the strip, the popover
    // and the editor cannot disagree.
    const rows = state.snippets.rows.filter(s => s.pinned && snipVisible(s, cwd));
    const group = new Map(state.snippets.groups.map(g => [g.id, g]));
    const off = dom.btnSend.disabled;
    paint(dom.pins, rows.map((s) => {
        const accent = snipAccent(group.get(s.groupId));
        return html`<button key=${s.id} class="btn-pin-snip" type="button" data-snip=${s.id}
            style=${accent ? `--snip-accent: ${accent}` : null}
            disabled=${off}
            title=${snipTitleFor(s, busy)}
            onClick=${() => chooseSnippet(live, s)}
            onContextMenu=${(e) => openSnipMenu(e, live, s)}>${s.title}</button>`;
    }));
}

/**
 * Re-say what each button will do when the runner state changes.
 *
 * Once a separate pass that rewrote each button's `title` by hand, so as not to
 * rebuild the strip; with keyed buttons a render *is* that pass, and writing to
 * nodes Preact owns is the one thing that must not happen.
 */
export function paintPinTitles(busy) {
    renderPins(busy);
}
