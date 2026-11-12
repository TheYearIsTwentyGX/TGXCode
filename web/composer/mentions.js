// `@` mentions: the menu of files and of other running sessions on either
// composer, and inserting `@path` or `@[name]` into the box. Moved out of app.js as it was. The menu shares
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
import { icon } from '../icons.js';
import { state } from '../state.js';
import { closeMenu, drawMenu, live, menuOpen } from './slash.js';
import { revealCaret } from './caret.js';
import { fileMentionText, parseMention } from './mention-parse.js';

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
// resolve on its own. That is what leaves the file group free to insert the bare
// path the CLI already understands.
//
// **Files** come first in the menu, under their own heading, because they are the
// commoner thing to want. They are searched by the bridge (`GET /api/file-search`,
// bridge/file-search.js) in the session's working directory, or in the directory
// typed into the Start-a-session dialog, and inserted as `@relative/path ` — or
// `@"a path with spaces" ` in the quoted form the CLI parses. A directory is
// inserted as `@dir/` with no trailing space and the menu stays open on its
// children, so you can walk down a tree with the keyboard. What counts as a
// fragment — and which of the two groups it asks for — is mention-parse.js.
//
// Anchored to the caret rather than to the whole composer value, which is the one
// real difference from the slash menu above. `/` is anchored to the whole value
// because the CLI dispatches on `text.startsWith("/")`, so a command anywhere else
// is prose; `@` carries no such rule and belongs mid-sentence — "ask @[importer]
// whether it has finished" is the normal shape of it.

// How stale the peer list may be before the picker refetches. Short, because the
// answer is "which sessions are running", and offering one that has since exited
// is offering a message that will not arrive.
const PEERS_TTL_MS = 5_000;

// How many file rows to ask for, and how many to show when sessions match too.
// A bare `@` lists the top of the tree, which can be long; the sessions below it
// are the point of the second group and should stay on screen.
const FILE_LIMIT = 30;
const FILES_WITH_SESSIONS = 10;

/**
 * The typed fragment and where it starts, or null when the caret is not in one.
 * See parseMention for what counts.
 */
function mentionFragment(c) {
    const caret = c.input.selectionStart;
    // Only with no selection: `@` with a range selected is somebody about to
    // overtype it, not somebody addressing a session.
    if (caret !== c.input.selectionEnd) return null;
    return parseMention(c.input.value.slice(0, caret));
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
 * Files matching a fragment, from the bridge, or null when this composer has no
 * working directory yet (the dialog before one is typed).
 *
 * By session where there is one and by path where there is not, as the slash
 * menu's fetch does — the bridge resolves a session to its directory, through a
 * worktree that has since been removed, which a client cannot. Not cached here:
 * the bridge caches the listing, and a client copy of a ranked answer would be a
 * second thing to invalidate.
 */
async function loadFiles(c, text) {
    const at = c.ctx();
    if (!at) return null;
    const where = at.sessionId
        ? `session=${encodeURIComponent(at.sessionId)}`
        : `cwd=${encodeURIComponent(at.cwd)}`;
    const r = await get(`/api/file-search?${where}&q=${encodeURIComponent(text)}&limit=${FILE_LIMIT}`);
    return r.results || [];
}

/**
 * Rows for the two groups, files first, as one flat list — see matchPeers.
 *
 * When sessions match as well, the files are cut to a handful so the second
 * heading is not pushed off the bottom of a menu that scrolls.
 */
function buildRows(files, peerRows) {
    const keep = peerRows.length ? FILES_WITH_SESSIONS : FILE_LIMIT;
    const fileRows = files.slice(0, keep).map(f => ({
        group: 'Files', file: f, insert: fileMentionText(f.path, f.isDirectory),
    }));
    return [...fileRows, ...peerRows];
}

/**
 * Re-read the composer and show, filter or hide the menu to match.
 *
 * Both groups are fetched together and shown together, and either may fail
 * without the other: peers are a fact about the machine and files a fact about one
 * directory, so a bridge that cannot list a directory (outside the roots, gone
 * since) still has sessions to offer.
 *
 * The rows already on screen are left up while the next answer is in flight,
 * rather than replaced by "Looking…" on every keystroke — a menu that flashes a
 * note between each letter reads as lag. The note is for the first open.
 */
export async function updateMentionMenu(c) {
    const frag = mentionFragment(c);
    if (frag === null) return closeMenu(c.mention);

    const seq = ++c.mention.seq;
    const fresh = (Date.now() - state.peers.at < PEERS_TTL_MS);
    const at = c.ctx();
    const wantFiles = frag.files && Boolean(at);
    const wantPeers = frag.sessions;

    // Nothing to ask and nothing to say: a quoted fragment names a file, and a
    // composer with no directory has none.
    if (!wantFiles && !wantPeers) {
        if (c.notReady && frag.files) return drawMenu(c.mention, null, c.notReady);
        return closeMenu(c.mention);
    }

    if (!menuOpen(c.mention) && !(fresh && !wantFiles)) {
        // Something on screen straight away, because the fetch is a round trip and
        // an `@` that does nothing for a moment reads as an `@` that does nothing.
        drawMenu(c.mention, null, wantFiles ? 'Looking…' : 'Looking for sessions…');
    }

    const [peers, files] = await Promise.all([
        wantPeers ? loadPeers().catch(() => null) : [],
        wantFiles ? loadFiles(c, frag.text).catch(() => null) : [],
    ]);
    // Typed on, or moved away, while that was in flight.
    if (seq !== c.mention.seq) return;
    const now = mentionFragment(c);
    if (!now) return closeMenu(c.mention);

    if (peers === null && files === null) {
        return drawMenu(c.mention, null, wantFiles ? 'Could not search.' : 'Could not list sessions.');
    }

    const peerRows = matchPeers(c, peers || [], now.text);
    const rows = buildRows(files || [], peerRows);
    if (!rows.length) {
        // A bare `@` with nothing to offer is worth saying, because the reason is
        // interesting — one session running is a normal state, and the silent
        // alternative is a menu that mysteriously never appears. A fragment that
        // matches nothing is just a typo, and gets out of the way.
        if (!now.text.trim()) {
            if (!at && c.notReady) return drawMenu(c.mention, null, c.notReady);
            return drawMenu(c.mention, null, wantFiles ? 'Nothing here.' : 'No other sessions are running.');
        }
        return closeMenu(c.mention);
    }

    c.mention.rows = rows;
    c.mention.index = 0;
    drawMenu(c.mention, rows, null);
}

/**
 * One row: a file or directory, or a session.
 *
 * A file leads with its icon and name and follows with the directory it is in,
 * dimmed, because the name is what you typed and the directory is what tells two
 * `index.js` apart. A directory's name ends in `/`.
 *
 * A session leads with the title and follows with the name, because the title is
 * what you are looking for and the name is what gets inserted — showing both is
 * what stops the box filling with something you did not expect. A session with no
 * transcript indexed here has no title, and shows its name alone rather than an
 * empty row.
 */
export function mentionRow(m, r, i) {
    const common = {
        class: 'picker-row', type: 'button', role: 'option',
        id: `${m.id}-row-${i}`, tabindex: -1,
        'aria-selected': String(i === m.index),
        onmousedown: (e) => e.preventDefault(),
        onclick: () => acceptMention(m, i),
    };
    if (r.file) {
        const f = r.file;
        return el('button', { ...common, class: 'picker-row file-row', title: f.path },
            el('span', { class: 'file-icon' }, icon(f.isDirectory ? 'folder' : 'file', 14)),
            el('span', { class: 'name' }, f.isDirectory ? `${f.name}/` : f.name),
            f.parent ? el('span', { class: 'desc' }, f.parent) : null,
        );
    }
    const p = r.peer;
    return el('button', common,
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
 *
 * A directory is the exception to "and the menu goes away": the splice is
 * `@dir/`, and the `input` event it fires re-reads the fragment and redraws the
 * menu on that directory's children. So it is *not* closed first — closing and
 * reopening in one tick is a flicker.
 */
export function acceptMention(m, i) {
    const c = m.c;
    const r = m.rows[i == null ? m.index : i];
    const frag = mentionFragment(c);
    if (!r || !frag) return closeMenu(m);
    if (!(r.file && r.file.isDirectory)) closeMenu(m);
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
 *
 * **Through `execCommand('insertText')` where it can be**, so the splice is an
 * edit the browser knows about and Ctrl+Z takes it back out. Writing `.value`
 * is invisible to the undo stack, so Ctrl+Z after a snippet or a mention could
 * not take it back. `insertText` fires the `input` event itself. It acts on
 * whatever has focus, so it is only tried once this box demonstrably has it, and
 * the result is checked: anywhere it does not land exactly, the old assignment
 * runs instead.
 *
 * **Then the caret is scrolled into view**, last, once the `input` listener has
 * sized the box. Nothing else does it for a splice, so a snippet longer than the
 * box used to land with its end, and the caret, out of sight below — see
 * composer/caret.js.
 */
export function insertAt(c, from, to, text) {
    const box = c.input;
    const v = box.value;
    const want = v.slice(0, from) + text + v.slice(to);
    const caret = from + text.length;
    box.focus();
    let done = false;
    // Splicing in nothing is a deletion, which `insertText` with an empty string
    // does not reliably record; `delete` over the selection does, and is the same
    // single undo step. Find and replace is the caller that needs it.
    if (document.activeElement === box && (text || from < to)) {
        box.setSelectionRange(from, to);
        const cmd = text ? 'insertText' : 'delete';
        try { done = document.execCommand(cmd, false, text); } catch { done = false; }
        done = done && box.value === want;
    }
    if (!done) {
        box.value = want;
        box.dispatchEvent(new Event('input'));
    }
    box.setSelectionRange(caret, caret);
    box.focus();
    revealCaret(box);
}
