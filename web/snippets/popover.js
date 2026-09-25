// The snippets popover on each composer, choosing a snippet, and the dialog that
// asks for what a snippet still needs before it is a message.
//
// The three questions this file has to get right, none of which is obvious:
//
// **Where the text goes when the snippet also sends itself.** `overwrite` plus
// `autoSubmit` is the shape the LGTM button had, and that button never touched the
// compose box — press it with a half-written message in there and the message is
// still there afterwards. Taking `overwrite` literally first and sending second
// would destroy it. So that one combination, on the live composer, goes straight
// to `sendMessage` with the text as an override and never writes to the box at
// all; `append` and `cursor` must go through it, because what is already in the
// box is part of what gets sent.
//
// **Where the caret was.** `insert: 'cursor'` needs the selection as it stood when
// you reached for the snippet, not as it stands when the text arrives — by then
// the popover has taken focus and the parameter dialog may have taken it again.
// It is recorded at the gesture, and both a pinned button and the right-click menu
// have to record it themselves because they open no popover on the way past.
//
// **What auto-submit means in a dialog with no Send.** See startFromSnippet.
//
// **Why Preact.** The popover can be open while another window saves an edit, and
// the push that brings it redrew the popover from scratch — under a pointer that
// may have been halfway through a click. Rows are keyed by snippet id and cards by
// group, so a push updates them in place. The popover node itself (`c.snips.node`)
// is web/index.html's; its position and `hidden` are still set by hand, since
// Preact owns only what is inside it.
//
// See index.js for the rule every module here follows about app.js bindings.

import { html } from '../vendor/preact.js';
import { state } from '../state.js';
import { dom, toast } from '../dom.js';
import { paint } from '../boards/parts.js';
import { closeMenus, composers, live } from '../composer/slash.js';
import { insertAt } from '../composer/mentions.js';
import { sendMessage } from '../composer/send.js';
import { closeWispr } from '../composer/wispr.js';
import { newDialogValues } from '../new-session/dialog.js';
import { startNew } from '../new-session/trigger.js';
import { openContextMenu } from '../transcript/context-menu.js';
import { isBusy } from '../transcript/conversation.js';
import { fillSnipBody, snipAccent, snipPreview, snipVisible } from './index.js';

/** What a parameter of each type is asked for with. */
const SNIP_INPUT = {
    text: { type: 'text' },
    integer: { type: 'number', step: '1', inputmode: 'numeric' },
    decimal: { type: 'number', step: 'any' },
    date: { type: 'date' },
    time: { type: 'time' },
    datetime: { type: 'datetime-local' },
};

/** The working directory a composer is pointed at, or null. */
function snipCwd(c) {
    if (c === live) return (state.current && state.current.cwd) || null;
    return dom.newCwd.value.trim() || null;
}

/**
 * The popover's contents: a card per group, then whatever is ungrouped.
 *
 * Ungrouped last rather than first. A group is drawn as a tinted card and the
 * loose ones are a plain list, so putting the plain list first would open the
 * popover on the part that looks like nothing.
 */
function snipCards(cwd) {
    const rows = state.snippets.rows.filter(s => snipVisible(s, cwd));
    const cards = state.snippets.groups
        .map(g => ({ group: g, rows: rows.filter(s => s.groupId === g.id) }))
        .filter(card => card.rows.length);
    const known = new Set(state.snippets.groups.map(g => g.id));
    // A snippet whose group this window cannot see draws loose rather than
    // vanishing — the bridge keeps that `groupId` on purpose, and a row nobody can
    // reach would be worse than one in the wrong place.
    const loose = rows.filter(s => !s.groupId || !known.has(s.groupId));
    if (loose.length) cards.push({ group: null, rows: loose });
    return cards;
}

// ── the popover ──────────────────────────────────────────────────────────

const snipRows = (c) => [...c.snips.node.querySelectorAll('.snip-row')];

/**
 * Place it, in fixed coordinates, against the button rather than the box.
 *
 * `positionMenu` cannot be reused as it stands: it anchors to `c.input` and gives
 * the popover the box's width, and this one hangs off a button and is deliberately
 * *wider* than its anchor, because the groups sit side by side. That is where the
 * clamp comes from — right-aligned to the button, then held inside the viewport,
 * which an anchored popover never had to express.
 *
 * Fixed for both composers rather than only the dialog's. The dialog's has to be,
 * since `.modal` is `overflow: hidden`; doing the same for the live one costs
 * nothing and means the arithmetic above lives in one place instead of two.
 *
 * The node is web/index.html's and not Preact's, which is why its class and
 * style can be written here.
 */
export function positionSnips(c) {
    const m = c.snips;
    const r = m.btn.getBoundingClientRect();
    const gap = 6;
    const below = window.innerHeight - r.bottom - gap * 2;
    const above = r.top - gap * 2;
    const up = below < 260 && above > below;

    const width = Math.min(720, window.innerWidth - 24);
    m.node.classList.toggle('up', up);
    m.node.style.setProperty('--snip-max',
        `${Math.max(180, Math.min(460, up ? above : below))}px`);
    m.node.style.width = `${width}px`;
    m.node.style.left = `${Math.max(12, Math.min(r.right - width,
        window.innerWidth - width - 12))}px`;
    if (up) {
        m.node.style.top = 'auto';
        m.node.style.bottom = `${window.innerHeight - r.top + gap}px`;
    } else {
        m.node.style.bottom = 'auto';
        m.node.style.top = `${r.bottom + gap}px`;
    }
}

/**
 * Draw the popover's contents, with the highlight where `c.snips.index` says.
 *
 * A roving `tabindex` rather than the `aria-activedescendant` the slash and
 * mention menus use, and the difference is not cosmetic: those keep the caret in
 * the textarea because the list filters as you type, and this one is opened by a
 * button with nothing being typed, so it takes focus like any other menu. Moving
 * the highlight is a render with a new index, not an attribute written by hand.
 *
 * `follow` is for a redraw nobody asked for — a push while the popover is open.
 * Rows may have come or gone above the highlight, so the index is re-derived from
 * the row that has focus, by snippet id, and clamped in any case: left alone it
 * could point at a different row or past the end, and the arrow keys index
 * `cards` with it.
 */
export function drawSnips(c, { follow = false } = {}) {
    const m = c.snips;
    const cards = snipCards(snipCwd(c));
    const busy = isBusy() && !state.agent;

    const order = cards.flatMap(card => card.rows.map(s => s.id));
    if (follow) {
        const f = document.activeElement;
        const at = f && m.node.contains(f) && f.dataset.snip ? order.indexOf(f.dataset.snip) : -1;
        if (at >= 0) m.index = at;
    }
    m.index = Math.max(0, Math.min(m.index || 0, order.length - 1));

    let empty = null;
    if (!state.snippets.rows.length) {
        empty = html`<div key="empty" class="snip-empty">No snippets yet. Add some in Settings.</div>`;
    } else if (!cards.length) {
        // Told rather than shown as an empty list: a snippet hidden because you
        // are in the wrong directory is otherwise indistinguishable from one you
        // deleted, and that is a bad ten minutes.
        empty = html`<div key="empty" class="snip-empty">${
            `None of your ${state.snippets.rows.length} snippets apply in this `
            + 'directory. Their project list is in Settings.'}</div>`;
    }

    let i = 0;
    const drawn = cards.map((card) => {
        const accent = snipAccent(card.group);
        return html`<section key=${card.group ? `group:${card.group.id}` : 'loose'}
            class=${card.group ? 'snip-card' : 'snip-card is-loose'}
            style=${accent ? `--snip-accent: ${accent}` : null}>
            ${card.group ? html`<h3 class="snip-card-name">${card.group.name}</h3>` : null}
            ${card.rows.map((s) => {
                const at = i++;
                return html`<button key=${s.id} class="snip-row" type="button" role="option"
                    data-i=${at} data-snip=${s.id} tabindex=${at === m.index ? 0 : -1}
                    aria-selected=${String(at === m.index)}
                    title=${snipTitleFor(s, busy, c)}
                    onClick=${() => chooseSnippet(c, s)}
                    onContextMenu=${(e) => openSnipMenu(e, c, s)}>
                    <span class="snip-row-title">${s.title}</span>
                    <span class="snip-row-preview">${snipPreview(s)}</span>
                </button>`;
            })}
        </section>`;
    });
    paint(m.node, [empty, ...drawn]);
}

function focusSnipAt(c, i) {
    const n = snipRows(c).length;
    if (!n) return;
    c.snips.index = Math.max(0, Math.min(i, n - 1));
    drawSnips(c);
    snipRows(c)[c.snips.index].focus();
}

export function showSnips(c, on) {
    if (!on) { closeSnips(c); return; }
    const m = c.snips;
    // Taken before anything moves the focus. A textarea keeps its selection across
    // a blur, but only until something writes to `.value`, and "mostly" is not a
    // contract to build `insert: 'cursor'` on.
    markSnipCaret(c);
    // Only ever one popover up, per composer and across them.
    closeMenus(c);
    c.closeOthers();
    for (const other of composers) if (other !== c) closeSnips(other);
    for (const other of composers) if (other.wispr) closeWispr(other.wispr);

    m.index = 0;
    m.node.hidden = false;
    m.btn.setAttribute('aria-expanded', 'true');
    drawSnips(c);
    positionSnips(c);
    focusSnipAt(c, 0);
}

export function closeSnips(c, { focus = false } = {}) {
    const m = c.snips;
    if (m.node.hidden) return;
    m.node.hidden = true;
    paint(m.node, null);
    m.btn.setAttribute('aria-expanded', 'false');
    if (focus) m.btn.focus();
}

/**
 * Arrows walk the rows, and Left and Right step between the cards.
 *
 * Up and Down alone would be a poor map for a popover whose whole point is that
 * groups sit beside each other: they run down one card and then jump to the top of
 * the next, so reaching the third group means walking through the first two.
 */
export function onSnipsKey(e, c) {
    const rows = snipRows(c);
    if (!rows.length) return;
    const at = c.snips.index;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        focusSnipAt(c, (at + step + rows.length) % rows.length);
        return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const cards = [...c.snips.node.querySelectorAll('.snip-card')];
        const mine = cards.findIndex(card => card.contains(rows[at]));
        const next = cards[mine + (e.key === 'ArrowRight' ? 1 : -1)];
        if (!next) return;
        // The same depth in the next card where there is one, so walking sideways
        // through a row of groups stays on that row.
        const inMine = [...cards[mine].querySelectorAll('.snip-row')].indexOf(rows[at]);
        const there = [...next.querySelectorAll('.snip-row')];
        focusSnipAt(c, rows.indexOf(there[Math.min(inMine, there.length - 1)]));
        return;
    }
    if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        focusSnipAt(c, e.key === 'Home' ? 0 : rows.length - 1);
        return;
    }
    // Tab closes and lets the focus go on, which is the recent-menu's rule.
    // Escape is handled by the central ladder, deliberately not here.
    if (e.key === 'Tab') closeSnips(c);
}

// ── choosing one ─────────────────────────────────────────────────────────

/** Where the selection is right now, for an `insert: 'cursor'` that happens later. */
function markSnipCaret(c) {
    c.snips.caret = { start: c.input.selectionStart, end: c.input.selectionEnd };
}

/**
 * The one way in: a row, a pinned button, Enter on a row, or the right-click menu.
 *
 * The caret is captured here as well as in `showSnips` because a pinned button
 * opens no popover — it is the case that would otherwise silently insert at the
 * end of the box instead of where you were.
 *
 * @param {object|null} over `{insert, autoSubmit}` for this one use, from the
 *   right-click menu. Spread over a *copy*: the rows in `state.snippets.rows` are
 *   what the popover, the pinned strip and the editor all draw from, and a stored
 *   decision must not move because somebody departed from it once.
 */
export function chooseSnippet(c, s, over = null) {
    // Not re-taken for an override: `openSnipMenu` took it at the gesture, before
    // the menu pulled the focus off the box, which is the only moment it is true.
    if (!over && c.snips.node.hidden) markSnipCaret(c);
    closeSnips(c);
    const use = over ? { ...s, ...over } : s;
    if (use.params && use.params.length) openSnipFill(c, use);
    else applySnippet(c, use, {});
}

/**
 * Right-click: use this snippet once, some other way than the way it is set up.
 *
 * `insert` and `autoSubmit` are stored decisions, and until this there was no way to
 * depart from one for a single use — an LGTM button that sends is an LGTM button that
 * sends, and getting its text into the box to edit meant a round trip through
 * Settings and back.
 *
 * Five of the six combinations. `cursor` + send is the one left out: it says "put
 * this in the middle of what I typed and send the lot", which reads as a mistake
 * rather than an intention. The editor can still store it and a left-click still
 * honours it — this menu is not the definition of what a snippet may do.
 *
 * `permissionMode` is deliberately not offered. It is orthogonal to placement and is
 * read only on the send path, so a snippet that says "run this in plan mode" still
 * means it whenever it sends, and the three non-sending rows leave `#perm` alone
 * exactly as they leave the transcript alone.
 */
export function openSnipMenu(ev, c, s) {
    ev.preventDefault();
    // The pinned-button case: no popover opened, so nothing else has recorded where
    // the caret was, and `openContextMenu` is about to take the focus.
    if (c.snips.node.hidden) markSnipCaret(c);

    const send = c === live
        ? ['Send it now', 'Add it to the end and send']
        : ['Start with this', 'Add it to the end and start'];
    const items = [
        { label: 'Replace what is in the box', over: { insert: 'overwrite', autoSubmit: false } },
        { label: 'Add it to the end', over: { insert: 'append', autoSubmit: false } },
        { label: 'Insert at the cursor', over: { insert: 'cursor', autoSubmit: false } },
        { label: send[0], over: { insert: 'overwrite', autoSubmit: true } },
        { label: send[1], over: { insert: 'append', autoSubmit: true } },
    ];
    openContextMenu(ev, items.map(it => ({
        label: it.label,
        onClick: () => chooseSnippet(c, s, it.over),
    })));
}

// ── the fill dialog ──────────────────────────────────────────────────────
//
// Its fields are drawn into web/index.html's `#snip-fill-form` once per open and
// unmounted on close, so a second open of the same snippet starts from its
// defaults again rather than from the last answers. Nothing re-renders it while
// it is up — no push is about the question being asked — so the inputs hold
// their own values and are read back on confirm.

function openSnipFill(c, s) {
    state.snippets.fill = { snippet: s, composer: c };
    dom.snipFillTitle.textContent = s.title;
    paint(dom.snipFillForm, s.params.map((p, i) => {
        return html`<div key=${p.name} class="field">
            <label for=${`snip-p-${i}`}>${p.label || p.name}</label>
            <input id=${`snip-p-${i}`} data-name=${p.name} autocomplete="off"
                required=${Boolean(p.required)} value=${p.default || ''} ...${SNIP_INPUT[p.type] || SNIP_INPUT.text} />
        </div>`;
    }));
    dom.snipFillScrim.hidden = false;
    const first = dom.snipFillForm.querySelector('input');
    if (first) { first.focus(); first.select(); }
}

/**
 * @returns {object|null} the answers, or null having said which box is empty.
 *   A `default` pre-fills and nothing more, so a required parameter with one is
 *   still a box you can clear and must then refill.
 */
function snipFillValues() {
    const out = {};
    for (const input of dom.snipFillForm.querySelectorAll('input')) {
        const v = input.value.trim();
        if (!v && input.required) {
            toast(`${input.previousElementSibling.textContent} is needed.`, 'warn');
            input.focus();
            return null;
        }
        out[input.dataset.name] = v;
    }
    return out;
}

export function confirmSnipFill() {
    const held = state.snippets.fill;
    if (!held) return;
    const values = snipFillValues();
    if (!values) return;
    closeSnipFill();
    applySnippet(held.composer, held.snippet, values);
}

export function closeSnipFill() {
    dom.snipFillScrim.hidden = true;
    paint(dom.snipFillForm, null);
    state.snippets.fill = null;
}

// ── putting it in the box ────────────────────────────────────────────────

/**
 * Put the resolved text where the snippet says, and send it if it says to.
 *
 * The `straight` case is the one worth reading twice. An overwriting snippet that
 * sends itself, on the live composer, never writes to the box: the text goes to
 * `sendMessage` as an override, which is exactly what the LGTM button did and why
 * pressing it has never cost anybody a half-typed message. `overwrite` there
 * describes what would have happened had you not also asked for a send.
 *
 * The dialog is excluded from it because `startNew()` reads `#new-prompt` — there
 * is no override path into it — so everything there goes through the box.
 */
function applySnippet(c, s, values) {
    const text = fillSnipBody(s.body, s.params, values);
    const straight = s.autoSubmit && s.insert === 'overwrite' && c === live;
    if (!straight) insertSnippet(c, text, s.insert);
    if (s.autoSubmit) submitSnippet(c, s, text, straight);
}

function insertSnippet(c, text, how) {
    const v = c.input.value;
    if (how === 'overwrite') { insertAt(c, 0, v.length, text); return; }
    if (how === 'append') {
        // A blank line between, unless the box already ends in a break. Two
        // paragraphs run together read as one, and this is a message.
        const lead = !v ? '' : (v.endsWith('\n') ? '' : '\n\n');
        insertAt(c, v.length, v.length, lead + text);
        return;
    }
    const at = c.snips.caret || {};
    const from = Math.min(at.start == null ? v.length : at.start, v.length);
    const to = Math.min(Math.max(at.end == null ? from : at.end, from), v.length);
    insertAt(c, from, to, text);
}

function submitSnippet(c, s, text, straight) {
    if (c !== live) { startFromSnippet(s); return; }
    if (s.permissionMode) setPermMode(s.permissionMode);
    // `canned` is not what leaves the box alone — `override` is. It says only that
    // the text is not worth holding on a failure, which is true exactly when it
    // never came out of the box. Once it did, what would be dropped is something
    // somebody typed.
    if (straight) { sendMessage({ text, canned: true }); return; }
    // The insert may have opened the slash menu over a box that is about to empty.
    closeMenus(c);
    sendMessage();
}

/**
 * Move the permission selector, and hold it there.
 *
 * Writing `permChoice` is not optional bookkeeping. `paintPerm()` runs inside
 * `applyRunner`, which fires on the `runner-status` the send provokes moments
 * later — so without this the selector would visibly snap back to its computed
 * answer a beat after a snippet moved it. It is the same thing the `#perm` change
 * listener does, for the same reason: a mode is chosen for the conversation in
 * front of you, so it is remembered against that session.
 */
function setPermMode(mode) {
    if (![...dom.perm.options].some(o => o.value === mode)) return;
    dom.perm.value = mode;
    if (state.current) state.permChoice.set(state.current.sessionId, mode);
}

/**
 * Auto-submit, in the dialog that has no Send.
 *
 * It presses Start. A snippet that says `autoSubmit` means "I do not want to look
 * at this again", and honouring that in one of the two places a snippet can be
 * used and not the other is the kind of difference nobody discovers until it has
 * cost them something.
 *
 * It is safe to be that literal because it refuses exactly where the Start button
 * refuses: `newDialogValues()` already toasts for a missing directory and an empty
 * message, so the only way to reach a process is from a dialog that was one click
 * from starting one anyway.
 *
 * The mode is written whether or not the start happens — "this prompt runs in plan
 * mode" is a fact about the snippet, worth seeing even when you are going to press
 * Start yourself. There is no `permChoice` here: `#new-perm` is the whole of that
 * control's state, and `openNew` rewrites it on every open.
 */
function startFromSnippet(s) {
    if (s.permissionMode
        && [...dom.newPerm.options].some(o => o.value === s.permissionMode)) {
        dom.newPerm.value = s.permissionMode;
    }
    if (!newDialogValues()) return;
    startNew();
}

/**
 * What a button will actually do, said before the click rather than after.
 *
 * The two prefixes are what `LGTM_TITLE` and `LGTM_TITLE_BUSY` used to be, now
 * that the sentence after them comes from the snippet instead of from this file.
 * `hint` is that sentence where a snippet has one, because the first line of a
 * body is a guess and LGTM's wording was not.
 */
export function snipTitleFor(s, busy, c = live) {
    const what = s.hint || snipPreview(s);
    const lead = !s.autoSubmit ? 'Put this in the message box'
        : c !== live ? 'Fill the message in and press Start'
            : busy ? 'Queue behind the running turn' : 'Send';
    // The override menu is otherwise undiscoverable: nothing about a button that
    // sends says the sending is a setting rather than the whole of what it is.
    return `${lead}: ${what}\nRight-click for other ways to use it.`;
}
