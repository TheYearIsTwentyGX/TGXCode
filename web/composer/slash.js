// The composers, and `/` completion on them: makeComposer() and the live one
// (`live`), the popover machinery both menus share — selection, paging,
// positioning, the capture-phase keyboard map — and the slash-command menu
// itself. Moved out of app.js as it was. The `@` menu is mentions.js.
//
// wireSlash() does what this section did at load — the resize and click-outside
// rules, the keyboard map, and wiring the live composer — in the order it did it.
// app.js calls it from where the section used to be, which matters: the keydown
// listener is capture-phase on the document, as is the central ladder's.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.
//
// `live` is built at load too, which is safe: makeComposer is this file's own
// function declaration and reads only its arguments and two other function
// declarations.

import { get } from '../api.js';
import { dom, el } from '../dom.js';
import { clip } from '../format.js';
import { showQuota } from '../quota.js';
import { state } from '../state.js';
import { closeSnips, positionSnips } from '../snippets/popover.js';
import { showNewMenu } from '../new-session/recent.js';
import { showBarMore } from '../settings/toolbar.js';
import { wireAttachments } from './attachments.js';
import { acceptMention, mentionRow, updateMentionMenu } from './mentions.js';
import { enableSend } from './send.js';

// ── slash-command completion ─────────────────────────────────────────────
//
// Typing `/` in the composer offers the commands this session can actually run.
// The list comes from the bridge, which gets it from the CLI's own init message
// — so it covers built-ins, plugins, skills and the project's own commands
// without this file knowing anything about how any of them resolve.
//
// What is inserted is plain text: `/name `. Claude Code expands it on the way
// in, and the transcript comes back with the command already parsed, which is
// why renderUser has drawn these properly since long before you could type one.

// The menu is open **iff** the whole composer is one slash-word. Not "a `/` was
// pressed": deriving it from the text rather than from a keystroke means paste,
// IME and autocorrect all behave, backspacing from `/revi` to `/re` re-opens it
// with no special case, and there is no open/closed flag to fall out of sync
// with what is on screen.
//
// Anchoring to the *whole* value rather than to a line start is not a
// simplification — it is the rule the CLI enforces. Its dispatch tests
// `text.startsWith("/")` on the last text block, untrimmed, so a `/command` on
// line three of a message is sent as prose. A menu that offered one there would
// be promising something that will not happen.
const SLASH_RE = /^\/[A-Za-z0-9_:-]*$/;

// Two popovers hang off each composer — `/` commands and `@` mentions — and they
// share everything except what opens them and what accepting one inserts. So the
// selection, the paging and the keyboard map below take a menu rather than
// reaching for one: `node` is the element it draws into, `id` prefixes its rows'
// DOM ids so aria-activedescendant can name one unambiguously, and `row` is what
// one of its rows looks like — which is a thing a menu knows about itself.
//
// **There are two composers now.** The one under a live conversation, and the
// first-message box in the Start-a-session dialog. What differs between them is
// *data* — where the working directory comes from, what else on screen has to be
// shut on the way up, whether Home and End belong to the menu — so this is a
// descriptor and deliberately not a closure over the functions below.
//
// A closure was the obvious shape and it is worse here. It would re-indent five
// hundred lines of comment-dense code into a diff where nothing is unchanged, in
// a file whose reviewable substance *is* those comments; it would make two copies
// of every function object, which quietly undoes the "one implementation" these
// comments keep claiming; and the callers outside this section would have to say
// `live.closeMenus()`, a factory-of-methods pattern that appears nowhere else in
// this file. So: data here, and every function below takes the composer it is
// acting on.
export function makeComposer({ input, slashNode, mentionNode, id, ctx, container,
    closeOthers = () => {}, notReady = null, homeEnd = true, float = false,
    onInput = null,
    // The snippets popover and the button it hangs off. A third menu on the same
    // composer, which is what earns it the click-outside rule and the reposition
    // pass for nothing — but deliberately *not* a member of closeMenus(), because
    // that is what the textarea's blur calls and this popover takes focus.
    snipBtn = null, snipNode = null,
    // Attachments. A composer with no `attachNode` takes no files at all, and
    // wireAttachments simply skips it — nothing else has to know.
    attachNode = null, attachInput = null, attachBtn = null, dropZone = null,
    uploadMode = 'eager', persistKey = null, afterRender = null,
    // This composer's own Permissions and Model selects, so Ctrl+P and Ctrl+M
    // reach the box the caret is in rather than always the live one — the same
    // reason `snipBtn` is a member. A composer with neither simply has no chord,
    // which is what the handler's null check is for.
    perm = null, model = null }) {
    const c = { input, container, ctx, closeOthers, notReady, homeEnd, onInput,
        attachNode, attachInput, attachBtn, dropZone, uploadMode, persistKey,
        afterRender, perm, model,
        // Staged files, and the counter their keys come from. Per composer, because
        // a screenshot pasted into one box has nothing to do with the other.
        attach: [], attachSeq: 0 };
    c.slash = { rows: [], index: 0, seq: 0, node: slashNode,
        id: `${id}-slash`, row: slashRow, float, c };
    c.mention = { rows: [], index: 0, seq: 0, node: mentionNode,
        id: `${id}-mention`, row: mentionRow, float, c };
    // `caret` is where the selection was when the popover opened, which is what
    // `insert: 'cursor'` lands on — by the time the text arrives the focus has
    // moved at least once. See showSnips.
    c.snips = { node: snipNode, btn: snipBtn, id: `${id}-snips`, index: 0, caret: null, c };
    return c;
}

export const menuOpen = (m) => !m.node.hidden;

/** The other popover on the same composer. */
const otherMenu = (m) => (m === m.c.slash ? m.c.mention : m.c.slash);

/**
 * Whichever of this composer's popovers is up, or null.
 *
 * Only ever one of the two — each closes the other on the way open. Per composer
 * rather than global: two composers can each have a menu up, which is what the
 * single `openMenu()` this replaces could not express.
 */
function openMenuOf(c) {
    if (menuOpen(c.slash)) return c.slash;
    if (menuOpen(c.mention)) return c.mention;
    return null;
}

// The composer under a live conversation. The dialog's is built beside the
// dialog's own wiring, further down.
export const live = makeComposer({
    input: dom.input,
    slashNode: dom.slashMenu,
    mentionNode: dom.mentionMenu,
    id: 'live',
    container: '.input-row',
    snipBtn: dom.btnSnippets,
    snipNode: dom.snipMenu,
    // Addressed by session id, and the cwd rides along only as a cache key: the
    // bridge is what resolves a session to a working directory, through a
    // worktree that has since been landed and removed. A client cannot, having no
    // way to ask whether a path still exists.
    ctx: () => (state.current
        ? { cwd: state.current.cwd, sessionId: state.current.sessionId }
        : null),
    // Main-window furniture that would otherwise sit over the popover. A
    // composer inside a modal has none of it, and passes nothing.
    closeOthers: () => { showQuota(false); showNewMenu(false); showBarMore(false); },

    // Attachments. The strip is above the input row and the drop zone is the whole
    // composer, so a file can be let go anywhere near the box rather than exactly on
    // it. Uploaded on arrival, because a live composer already knows the checkout its
    // files belong in.
    attachNode: dom.attach,
    attachInput: dom.attachInput,
    attachBtn: dom.btnAttach,
    dropZone: dom.composer,
    uploadMode: 'eager',
    // Which localStorage key its chips belong under, or null while no session is on
    // screen. Only the eager composer has one: a held file is bytes in this page, and
    // there is no path to write down.
    persistKey: () => state.current && state.current.sessionId,
    afterRender: () => enableSend(Boolean(state.current)),
    perm: dom.perm,
    model: dom.model,
});

// Filled by wireComposer below, live first. The keyboard map and the
// click-outside rule both walk this, so a composer that is not in it is a box
// whose popovers no key and no click can reach.
export const composers = [];

/** The typed fragment after the slash, or null when this is not a command. */
function slashFragment(c) {
    const v = c.input.value;
    return SLASH_RE.test(v) ? v.slice(1) : null;
}

/**
 * Cached per working directory, because that is what decides the answer — every
 * session in a checkout shares a list, so one session's fetch warms the rest.
 */
async function loadSlashCommands(c) {
    const at = c.ctx();
    if (!at) return [];
    const key = at.cwd || at.sessionId;
    const hit = state.slashCommands.get(key);
    if (hit) return hit.commands;

    // By session where there is one and by path where there is not. The bridge
    // answers both, and says in its own comment that the second form exists for
    // exactly this caller — a dialog that has not started a session yet knows
    // only a path. Encoded because that path is typed by hand: a space, a `#` or
    // an `&` in it would otherwise reach the bridge truncated.
    const q = at.sessionId
        ? `session=${encodeURIComponent(at.sessionId)}`
        : `cwd=${encodeURIComponent(at.cwd)}`;
    const r = await get(`/api/slash-commands?${q}`);
    const entry = { commands: r.commands || [], at: r.at, exact: r.exact };
    state.slashCommands.set(key, entry);
    // The bridge resolves a cwd that no longer exists to the project directory,
    // so its answer can differ from the summary's. Store both, and the SSE
    // event — which speaks in the bridge's cwd — invalidates the right one.
    if (r.cwd) state.slashCommands.set(r.cwd, entry);
    return entry.commands;
}

// By the name as displayed, rather than by anything cleverer. Sorting a list on
// a key the reader cannot see is how a sorted list comes to look broken — so a
// namespaced command files under its plugin, where the text says it is, and not
// under the command's own name.
const bySlashName = (a, b) => a.name.localeCompare(b.name);

/**
 * Prefix matches first, then anything containing the fragment; alphabetical
 * within each of those.
 *
 * Every match is returned, not a first handful: a bare `/` is a request to see
 * what there is, and a list that stops at eight answers a different question.
 * The menu scrolls, and the keys page through it.
 *
 * The CLI reports its commands in an order of its own — roughly by where each
 * came from — which is no order at all to somebody looking for one. Alphabetical
 * is the only arrangement you can search without reading every row.
 *
 * The two groups are kept apart rather than sorted as one, because ranking a
 * command you are part-way through typing above one that merely contains those
 * letters is worth more than a single unbroken A-to-Z: `/co` should offer
 * `/compact` before `/autocompact`.
 */
function matchSlashCommands(items, frag) {
    if (!frag) return items.slice().sort(bySlashName);
    const q = frag.toLowerCase();
    const pre = [];
    const sub = [];
    for (const c of items) {
        const name = c.name.toLowerCase();
        // Also match the part after the namespace: a plugin command reads as
        // `code-review:code-review` but everyone thinks of it as `/code-review`.
        const tail = name.slice(name.lastIndexOf(':') + 1);
        if (name.startsWith(q) || tail.startsWith(q)) pre.push(c);
        else if (name.includes(q)) sub.push(c);
    }
    return pre.sort(bySlashName).concat(sub.sort(bySlashName));
}

/**
 * Hide one popover and forget what was highlighted in it.
 *
 * The combobox state is only given up when the *other* popover on the same
 * composer is not the one using it. That clause arrived with the mention menu and
 * belongs to both: `aria-expanded` describes the box, not the list. Closing the
 * slash menu used to clear it unconditionally, which would have lied the moment
 * both were somehow up — unreachable, and now unreachable by construction.
 */
export function closeMenu(m) {
    if (m.node.hidden) return;
    m.node.hidden = true;
    m.node.replaceChildren();
    if (otherMenu(m).node.hidden) {
        m.c.input.setAttribute('aria-expanded', 'false');
        m.c.input.removeAttribute('aria-activedescendant');
    }
    m.rows = [];
    m.index = 0;
}

/** Both of one composer's popovers — what a blur or a session switch wants. */
export const closeMenus = (c) => { closeMenu(c.slash); closeMenu(c.mention); };

/** Re-read the composer and show, filter or hide the menu to match. */
export async function updateSlashMenu(c) {
    const frag = slashFragment(c);
    if (frag === null) return closeMenu(c.slash);

    // No working directory to ask about yet. Only the dialog can be in this
    // state — a live composer with no session is not on screen — and it says so
    // rather than showing nothing, because a `/` that quietly does nothing reads
    // as a feature that is broken rather than as a field you have not filled in.
    const at = c.ctx();
    if (!at) {
        if (!c.notReady) return closeMenu(c.slash);
        return drawMenu(c.slash, null, c.notReady);
    }

    const seq = ++c.slash.seq;
    const key = at.cwd || at.sessionId;
    let items = state.slashCommands.has(key) ? state.slashCommands.get(key).commands : null;

    if (!items) {
        // First `/` in this directory. Show the box rather than nothing, so a
        // slow bridge reads as loading instead of as no commands.
        drawMenu(c.slash, null, 'Loading commands…');
        try {
            items = await loadSlashCommands(c);
        } catch {
            // Not a toast: the person pressed a key, they did not ask for this.
            if (seq === c.slash.seq) drawMenu(c.slash, null, 'Could not load commands.');
            return;
        }
        // Typed on, or moved away, while that was in flight.
        if (seq !== c.slash.seq) return;
        if (slashFragment(c) === null) return closeMenu(c.slash);
    }

    const rows = matchSlashCommands(items, slashFragment(c) || '');
    // Nothing matches, so there is nothing to choose: get out of the way
    // entirely rather than showing an empty box that also swallows Enter.
    if (!rows.length) return closeMenu(c.slash);

    c.slash.rows = rows;
    c.slash.index = 0;
    drawMenu(c.slash, rows, null);
}

/** One command. */
function slashRow(m, cmd, i) {
    return el('button', {
        class: 'picker-row', type: 'button', role: 'option',
        id: `${m.id}-row-${i}`, tabindex: -1,
        'aria-selected': String(i === m.index),
        // Keeps the caret in the textarea, so clicking a row neither blurs
        // the box nor fires the blur-to-close below.
        onmousedown: (e) => e.preventDefault(),
        onclick: () => acceptSlashCommand(m, i),
    },
    el('span', { class: 'name' }, `/${cmd.name}`),
    cmd.description ? el('span', { class: 'desc' }, clip(cmd.description, 90)) : null,
    cmd.argumentHint ? el('span', { class: 'hint' }, clip(cmd.argumentHint, 24)) : null,
    );
}

/**
 * Draw a popover: a list of rows, or a note in place of one.
 *
 * One function for both menus. They differed in the row builder — which now rides
 * on the menu, where it belongs — and in the group headings, which the `r.group &&`
 * below makes optional rather than a second copy of this whole loop.
 */
export function drawMenu(m, rows, note) {
    // Two popovers on screen at once is nobody's intention. Only on the way
    // open: this redraws on every keystroke, and the others are already shut.
    if (m.node.hidden) { m.c.closeOthers(); closeMenu(otherMenu(m)); }

    // A note is a message, not a list. Clearing the rows behind it matters:
    // otherwise Enter during "Loading…" would accept whatever the *previous*
    // fragment had highlighted, which is not what is on screen.
    if (note) { m.rows = []; m.index = 0; }

    const kids = [];
    let group = null;
    (rows || []).forEach((r, i) => {
        // A row with no group — every slash command — skips this entirely, which
        // is what lets one loop serve both menus. Not a `.picker-row`,
        // deliberately: the shared selection code counts those, so a heading that
        // were one would be a row you could land on and press Enter at.
        if (r.group && r.group !== group) {
            group = r.group;
            kids.push(el('div', { class: 'menu-group', role: 'presentation' }, group));
        }
        kids.push(m.row(m, r, i));
    });

    m.node.replaceChildren(...(note ? [el('div', { class: 'menu-note' }, note)] : kids));
    m.node.hidden = false;
    // After it is on screen and before the highlight is painted: paintSelection
    // scrolls a row into view, and it should be scrolling inside a box that has
    // already been given its height.
    if (m.float) positionMenu(m);
    m.c.input.setAttribute('aria-expanded', 'true');
    if (rows && rows.length) paintSelection(m);
    else m.c.input.removeAttribute('aria-activedescendant');
}

/**
 * Put a floating popover under the box it belongs to, or over it when there is
 * more room that way.
 *
 * Fixed rather than absolute, and this is the whole reason the `float` flag
 * exists: the dialog's box lives inside `.modal-body`, which scrolls, inside
 * `.modal`, which is `overflow: hidden`. An absolutely positioned popover is
 * clipped by both, and that field is the last one in the dialog — so it would be
 * cut almost entirely. Fixed positioning leaves every ancestor's overflow out of
 * it, at the price of having to be told where to go.
 *
 * Measured on every redraw because the anchor moves: the textarea is sized from
 * its contents, so it grows under the popover as you type. Same show-then-place
 * idiom as showTurnPop, and the same z-index.
 *
 * `--menu-max` is the room actually available rather than the flat 400px the
 * anchored menu uses, so a short window gets a short menu instead of one running
 * off the screen. The floor stops it collapsing to nothing when the box is almost
 * at the bottom — better to overhang a little than to show two rows.
 */
function positionMenu(m) {
    const r = m.c.input.getBoundingClientRect();
    const gap = 6;
    const below = window.innerHeight - r.bottom - gap * 2;
    const above = r.top - gap * 2;
    const up = below < 220 && above > below;

    m.node.classList.toggle('up', up);
    m.node.style.setProperty('--menu-max', `${Math.max(140, Math.min(400, up ? above : below))}px`);
    m.node.style.left = `${r.left}px`;
    m.node.style.width = `${r.width}px`;
    if (up) {
        m.node.style.top = 'auto';
        m.node.style.bottom = `${window.innerHeight - r.top + gap}px`;
    } else {
        m.node.style.bottom = 'auto';
        m.node.style.top = `${r.bottom + gap}px`;
    }
}

/**
 * Keep a floating popover attached to its box when the page moves under it.
 *
 * Reposition rather than close: the caret is still in the box and the list is
 * still the answer, so a menu that vanished because the modal scrolled a pixel
 * would be the wrong reading of what happened. Cheap — one rect read per open
 * menu, and there is at most one.
 */
export function repositionFloatingMenus() {
    for (const c of composers) {
        for (const m of [c.slash, c.mention]) {
            if (m.float && !m.node.hidden) positionMenu(m);
        }
        // Always fixed, both composers, so it always needs replacing — see
        // positionSnips on why it does not share positionMenu.
        if (c.snips.node && !c.snips.node.hidden) positionSnips(c);
    }
}

/**
 * The highlight is a property of the list, never of focus — see below.
 *
 * `.picker-row` and nothing else, so a group heading in the mention menu can sit
 * among the rows without becoming one you can land on.
 */
function paintSelection(menu) {
    const rows = [...menu.node.querySelectorAll('.picker-row')];
    rows.forEach((r, i) => r.setAttribute('aria-selected', String(i === menu.index)));
    const on = rows[menu.index];
    if (!on) return;
    menu.c.input.setAttribute('aria-activedescendant', on.id);
    on.scrollIntoView({ block: 'nearest' });
}

function moveSelection(menu, delta) {
    const n = menu.rows.length;
    if (!n) return;
    menu.index = ((menu.index + delta) % n + n) % n;   // a menu is a ring
    paintSelection(menu);
}

/**
 * How many rows a Page key should travel: what is actually on screen, less one.
 *
 * Measured rather than assumed, because the menu's height is a CSS decision and
 * a row's height depends on the font — hard-coding a number here would drift
 * from what the eye sees the moment either changes. The overlap of one row is
 * the usual paging convention: it leaves something recognisable behind.
 */
function menuPageSize(menu) {
    const first = menu.node.querySelector('.picker-row');
    if (!first) return 1;
    const rowH = first.offsetHeight || 32;
    return Math.max(1, Math.floor(menu.node.clientHeight / rowH) - 1);
}

/**
 * Page and Home/End clamp rather than wrap.
 *
 * Deliberately unlike the arrows: pressing Page Down at the foot of a long list
 * should settle on the last command, not reappear at the top having skipped
 * everything in between. Wrapping is a nicety when you are stepping one at a
 * time and a way to lose your place when you are moving in chunks.
 */
function jumpSelection(menu, to) {
    const n = menu.rows.length;
    if (!n) return;
    menu.index = Math.max(0, Math.min(n - 1, to));
    paintSelection(menu);
}

/**
 * Put the command in the box — and never send it.
 *
 * One behaviour for every command, including those that take no arguments: a
 * menu that sometimes sends is a menu that fires `/clear` on a mistyped Enter.
 * The trailing space is so that arguments can be typed straight on.
 *
 * The whole value is replaced, which is safe precisely because the menu is only
 * open when the whole value was the fragment. Dispatching `input` rather than
 * calling autoGrow() and saveDraft() by hand runs the listeners that are already
 * wired to the box, so every draft guarantee holds by construction instead of by
 * a second copy of the logic that can drift from the first.
 */
function acceptSlashCommand(m, i) {
    const cmd = m.rows[i == null ? m.index : i];
    if (!cmd) return;
    const box = m.c.input;
    closeMenu(m);
    box.value = `/${cmd.name} `;
    box.setSelectionRange(box.value.length, box.value.length);
    box.dispatchEvent(new Event('input'));
    box.focus();
}

/**
 * One listener feeding both popovers, because both are derived from the text
 * rather than from a keystroke — see the note above SLASH_RE. Order matters only
 * in that a composer holding one slash-word is never also holding an `@`
 * fragment.
 *
 * `onInput` runs first where a composer has one. The dialog's box is sized from
 * its contents, and a popover positioned against it has to be placed after that
 * has happened rather than against the height it had a keystroke ago.
 */
export function wireComposer(c) {
    c.input.addEventListener('input', () => {
        if (c.onInput) c.onInput();
        updateSlashMenu(c);
        updateMentionMenu(c);
    });
    c.input.addEventListener('blur', () => closeMenus(c));
    composers.push(c);
}


/**
 * Everything this section registered at load, in the order it registered it.
 * Called by app.js from where the section used to be, so the capture-phase
 * keydown below keeps its place relative to the central ladder's.
 */
export function wireSlash() {
    window.addEventListener('resize', repositionFloatingMenus);

    /**
     * Keys, on the document in the capture phase.
     *
     * Deliberately not a second listener on the textarea: those run in registration
     * order, so "register ours first" would work today and break silently the day
     * somebody moves a block in this file. Capturing on an ancestor provably runs
     * before any listener on the target, so stopping propagation here reliably keeps
     * Enter-to-send from also firing.
     *
     * **The target decides which composer this is about, and only then do we ask
     * whether that composer has a popover open.** The other way round — one global
     * "is any menu up" — stopped being answerable the moment there were two
     * composers. It is also the check that keeps this off every other box with an
     * Enter or Escape map of its own: the queue chips, #new-cwd, the New-folder name,
     * the terminal.
     */
    document.addEventListener('keydown', (e) => {
        const c = composers.find(x => x.input === e.target);
        if (!c) return;
        const menu = openMenuOf(c);
        if (!menu) return;
        if (e.isComposing || e.keyCode === 229) return;

        // Above the rows check, deliberately. Escape is the one key that means
        // something even when there is nothing to choose: a note is still something
        // on screen, and something on screen is what Escape dismisses. Left below
        // that check, an Escape during "Loading commands…" fell through to the
        // central ladder, which used to close the whole Start-a-session dialog and
        // the first message you had written; the ladder swallows the key over a
        // modal now, but this is still the handler that makes it mean "never mind
        // the list". Leaves the text exactly as typed.
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeMenu(menu);
            return;
        }

        // Open but with nothing to choose — a note, or a list still loading. Every
        // other key belongs to the composer then; swallowing Enter here would lose a
        // message to a box that had no answer for it.
        if (!menu.rows.length) return;

        const accept = () => (menu === c.slash ? acceptSlashCommand(menu) : acceptMention(menu));

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            moveSelection(menu, e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'PageDown' || e.key === 'PageUp') {
            e.preventDefault();
            e.stopPropagation();
            const step = menuPageSize(menu);
            jumpSelection(menu, menu.index + (e.key === 'PageDown' ? step : -step));
        } else if (c.homeEnd && (e.key === 'Home' || e.key === 'End')) {
            // Only worth taking while the menu is open, and only because the box it
            // sits on is one line: Home and End in a one-line composer move the
            // caret somewhere it already effectively is. A composer whose box is
            // several lines tall keeps them for the caret — see `homeEnd`.
            e.preventDefault();
            e.stopPropagation();
            jumpSelection(menu, e.key === 'Home' ? 0 : menu.rows.length - 1);
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (e.shiftKey && e.key === 'Tab') return;   // still a way out of the box
            e.preventDefault();
            e.stopPropagation();
            accept();
        }
    }, true);

    wireComposer(live);
    wireAttachments(live);

    // A click anywhere outside a composer's own row closes that composer's popovers,
    // and only that composer's. Per composer rather than "everything not in
    // .input-row": clicking a row of the dialog's menu is outside the live composer,
    // and shutting the live one there is harmless, but shutting the dialog's would
    // cancel the click that was choosing something.
    document.addEventListener('click', (e) => {
        for (const c of composers) {
            if (e.target.closest(c.container)) continue;
            closeMenus(c);
            // Closed here rather than in closeMenus(), which the textarea's blur
            // calls: clicking the snippets button blurs the box, so a popover in that
            // set would shut on the click that opened it.
            closeSnips(c);
        }
    });
}
