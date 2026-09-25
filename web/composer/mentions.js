// `@` mentions: the menu of other running sessions on either composer, and
// inserting `@[name]` into the box. Moved out of app.js as it was. The menu shares
// its selection and keyboard machinery with the slash menu in slash.js.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.

import { get } from '../api.js';
import { el } from '../dom.js';
import { state } from '../state.js';
import { closeMenu, drawMenu, live } from './slash.js';

// ── @ mentions ───────────────────────────────────────────────────────────
//
// Typing `@` offers the other Claude sessions running on this machine, so you
// can name one to the agent you are talking to.
//
// Claude Code gives every session a name and an inbox of its own, and an agent
// reaches another with `SendMessage({to: "<name>"})`. **The name is the whole
// address — there is no separate addressing syntax.** So what this menu is for
// is not sending anything; it is getting the exact name into the message,
// because a name spelt approximately reaches nobody and an agent cannot guess
// which of your fourteen sessions you meant.
//
// What is inserted is `@[name]`, and the brackets are load-bearing. They are not
// CLI syntax — nothing parses them, and the agent reads them as prose — but they
// keep session mentions from colliding with `@path/to/file`, which the CLI *does*
// resolve on its own. That leaves the file half of the menu free to insert the
// bare path the CLI already understands, which is why the group headings exist
// before there is a second group to head.
//
// Anchored to the caret rather than to the whole composer value, which is the one
// real difference from the slash menu above. `/` is anchored to the whole value
// because the CLI dispatches on `text.startsWith("/")`, so a command anywhere else
// is prose; `@` carries no such rule and belongs mid-sentence — "ask @[importer]
// whether it has finished" is the normal shape of it.

// The fragment under the caret: an `@` at a word boundary, then the name being
// typed. Spaces are allowed inside the brackets — derived names have none, but
// they are permitted, and a menu that stopped matching at the first space would
// be unusable for one that did.
const MENTION_RE = /(?:^|[\s(])@\[?([^\]\n]*)$/;

// How stale the peer list may be before the picker refetches. Short, because the
// answer is "which sessions are running", and offering one that has since exited
// is offering a message that will not arrive.
const PEERS_TTL_MS = 5_000;

/**
 * The typed fragment and where it starts, or null when the caret is not in one.
 *
 * `start` is the index of the `@`, so accepting can replace exactly the fragment
 * and leave everything either side of it alone.
 */
function mentionFragment(c) {
    const caret = c.input.selectionStart;
    // Only with no selection: `@` with a range selected is somebody about to
    // overtype it, not somebody addressing a session.
    if (caret !== c.input.selectionEnd) return null;
    const before = c.input.value.slice(0, caret);
    const m = MENTION_RE.exec(before);
    if (!m) return null;
    // m[0] may open with the whitespace that made the `@` a word boundary, and
    // that character is not part of what gets replaced.
    const lead = m[0].startsWith('@') ? 0 : 1;
    return { text: m[1], start: caret - m[0].length + lead };
}

/** Peers, from memory when the answer is fresh enough to still be true. */
export async function loadPeers() {
    if (Date.now() - state.peers.at < PEERS_TTL_MS) return state.peers.list;
    const r = await get('/api/peers');
    state.peers.list = r.peers || [];
    state.peers.at = Date.now();
    return state.peers.list;
}

/** A peer by the name that is also its address, or null. */
export function peerByName(name) {
    return state.peers.list.find(p => p.name === name) || null;
}

/**
 * Rows for a fragment, as a flat list where each carries the group it belongs to.
 *
 * Flat rather than nested so that the index arithmetic in the shared keyboard map
 * keeps working untouched — headings are drawn between rows but are not rows, and
 * `.picker-row` is what the selection counts.
 *
 * The session you are in is dropped: it is running, so the bridge lists it, but
 * telling an agent to message itself is never the intention. A composer that is
 * not *in* a session — the Start-a-session dialog — drops nothing, and that is
 * right rather than merely harmless: a session open behind the modal is a
 * perfectly good thing for the one you are about to start to go and talk to.
 */
function matchPeers(c, peers, frag) {
    const q = frag.trim().toLowerCase();
    const mine = (c.ctx() || {}).sessionId;
    const usable = peers.filter(p => p.sessionId !== mine);

    // Matched on the title and the project as well as the name, because the title
    // is what you remember a session by and the name is what has to be sent.
    // Looking one up by the thing you know is the entire job of this menu.
    const hit = (p) => !q
        || p.name.toLowerCase().includes(q)
        || (p.title || '').toLowerCase().includes(q)
        || (p.project || '').toLowerCase().includes(q);

    // Prefix on the name first — you may be part-way through typing one — then
    // everything else that matches, each alphabetical by what the row shows.
    const byLabel = (a, b) => (a.title || a.name).localeCompare(b.title || b.name);
    const pre = [];
    const rest = [];
    for (const p of usable) {
        if (!hit(p)) continue;
        (q && p.name.toLowerCase().startsWith(q) ? pre : rest).push(p);
    }
    return [...pre.sort(byLabel), ...rest.sort(byLabel)]
        .map(p => ({ group: 'Sessions', peer: p, insert: `@[${p.name}] ` }));
}

/**
 * Re-read the composer and show, filter or hide the menu to match.
 *
 * No check for a session here, unlike the slash menu's check for a directory:
 * peers are a fact about the machine rather than about this composer, so every
 * composer offers the same names and one with nothing behind it still has an
 * answer.
 */
export async function updateMentionMenu(c) {
    const frag = mentionFragment(c);
    if (frag === null) return closeMenu(c.mention);

    const seq = ++c.mention.seq;
    let peers = (Date.now() - state.peers.at < PEERS_TTL_MS) ? state.peers.list : null;

    if (!peers) {
        // Something on screen straight away, because the fetch is a round trip and
        // an `@` that does nothing for a moment reads as an `@` that does nothing.
        drawMenu(c.mention, null, 'Looking for sessions…');
        try {
            peers = await loadPeers();
        } catch {
            if (seq === c.mention.seq) drawMenu(c.mention, null, 'Could not list sessions.');
            return;
        }
        // Typed on, or moved away, while that was in flight.
        if (seq !== c.mention.seq) return;
        if (mentionFragment(c) === null) return closeMenu(c.mention);
    }

    const now = mentionFragment(c);
    if (!now) return closeMenu(c.mention);

    const rows = matchPeers(c, peers, now.text);
    if (!rows.length) {
        // A bare `@` with nothing to offer is worth saying, because the reason is
        // interesting — one session running is a normal state, and the silent
        // alternative is a menu that mysteriously never appears. A fragment that
        // matches nothing is just a typo, and gets out of the way.
        if (!now.text.trim()) return drawMenu(c.mention, null, 'No other sessions are running.');
        return closeMenu(c.mention);
    }

    c.mention.rows = rows;
    c.mention.index = 0;
    drawMenu(c.mention, rows, null);
}

/**
 * One session.
 *
 * The title leads and the name follows, because the title is what you are looking
 * for and the name is what gets inserted — showing both is what stops the box
 * filling with something you did not expect. A session with no transcript indexed
 * here has no title, and shows its name alone rather than an empty row.
 */
export function mentionRow(m, r, i) {
    const p = r.peer;
    return el('button', {
        class: 'picker-row', type: 'button', role: 'option',
        id: `${m.id}-row-${i}`, tabindex: -1,
        'aria-selected': String(i === m.index),
        onmousedown: (e) => e.preventDefault(),
        onclick: () => acceptMention(m, i),
    },
    el('span', { class: 'name' }, p.title || p.name),
    el('span', { class: 'desc' }, p.name),
    el('span', { class: 'hint' }, p.project || p.kind || ''),
    );
}

/**
 * Replace the fragment under the caret with the mention, and never send.
 *
 * A splice rather than the whole-value replace the slash menu does, because a
 * mention belongs mid-sentence: the words either side of it are the message.
 */
export function acceptMention(m, i) {
    const c = m.c;
    const r = m.rows[i == null ? m.index : i];
    const frag = mentionFragment(c);
    if (!r || !frag) return closeMenu(m);
    closeMenu(m);
    insertAt(c, frag.start, c.input.selectionStart, r.insert);
}

/**
 * Put a mention in the composer from somewhere other than the menu.
 *
 * Reply on a received message is the caller. It goes to the front rather than to
 * the caret: replying is the first thing the message is for, so the sentence
 * being written is the reply and the name belongs at the start of it.
 *
 * Hard-wired to the live composer, and staying that way. Its one caller means the
 * box under the conversation the message arrived in and could not mean anything
 * else, so a parameter here would only be a way to get it wrong.
 */
export function insertMention(name) {
    const text = `@[${name}] `;
    if (live.input.value.startsWith(text)) { live.input.focus(); return; }
    insertAt(live, 0, 0, text);
}

/**
 * Splice `text` over [from, to) in a composer, caret after it.
 *
 * Dispatching `input` rather than calling autoGrow() and saveDraft() by hand runs
 * the listeners already wired to the box, so every draft guarantee holds by
 * construction instead of by a second copy of the logic that can drift. It is
 * also what makes a second composer work for nothing: the dialog's box has its
 * own input listener, which sizes it, and this runs that too.
 */
export function insertAt(c, from, to, text) {
    const v = c.input.value;
    c.input.value = v.slice(0, from) + text + v.slice(to);
    const caret = from + text.length;
    c.input.setSelectionRange(caret, caret);
    c.input.dispatchEvent(new Event('input'));
    c.input.focus();
}
