// The directory picker in the Start-a-session dialog — its Recent and Browse
// tabs, the tree and its keyboard — and the New-folder row under it. Moved out of
// app.js as it was. Its listeners are bound by wireNewDialog() in dialog.js.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.

import { get, post } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { clip } from '../format.js';
import { state } from '../state.js';
import { homely } from '../term-pane.js';
import { setNewCwd } from './dialog.js';

// ── the directory picker ─────────────────────────────────────────────────
//
// Two tabs over one decision. *Recent* is the list this app has always had —
// every directory a session has ever run in. *Browse* is for the case it cannot
// answer: a directory with no history, or one that does not exist yet.
//
// The rule that keeps the two from fighting is that **walking into a folder is
// how you choose it**. There is no select-versus-descend distinction, no
// checkmark, and no second click: every navigation writes #new-cwd, and #new-cwd
// stays the single answer to "where will this run". So "how do I pick the folder
// I am looking at?" answers itself — you already have, and the box above says so.

export function setPickerTab(tab, { load = false } = {}) {
    const browsing = tab === 'browse';
    state.browse.tab = browsing ? 'browse' : 'recent';
    try { localStorage.setItem('newPickerTab', state.browse.tab); } catch { /* private mode */ }

    dom.newTabRecent.setAttribute('aria-selected', String(!browsing));
    dom.newTabBrowse.setAttribute('aria-selected', String(browsing));
    dom.newPicker.hidden = browsing;
    dom.newBrowse.hidden = !browsing;
    if (!browsing) cancelMkdir();
    if (browsing && (load || !state.browse.dir)) browseTo(startDir());
}

/** Where Browse should open: whatever the box says, else wherever we were. */
function startDir() {
    return dom.newCwd.value.trim() || state.browse.dir || '';
}

/** Strip a trailing slash so a typed path can be compared with a listed one. */
const tidyPath = (p) => String(p || '').trim().replace(/(?!^)\/+$/, '');

/**
 * List a directory and — because navigating is selecting — point #new-cwd at it.
 *
 * `select: false` is for the one case where that would be wrong: a first load
 * that lands somewhere other than where the box already says.
 */
export async function browseTo(dir, { select = true, fromKeyboard = false } = {}) {
    const seq = ++state.browse.seq;
    let data;
    try {
        data = await get(`/api/fs?path=${encodeURIComponent(dir)}`);
    } catch (err) {
        // A 403 for a path outside the roots is the bridge's call, not ours to
        // predict — the roots live in one place. Say what it said and stay put.
        toast(`Could not open that folder: ${err.message}`, 'error');
        if (!state.browse.dir && dir) browseTo('', { select: false });
        return;
    }
    if (seq !== state.browse.seq) return;   // a later click already won

    Object.assign(state.browse, {
        dir: data.path,
        parent: data.parent || null,
        roots: data.roots || [],
        entries: data.entries || [],
        truncated: !!data.truncated,
        // A readdir that failed comes back 200 with this set — the path and the
        // way back up are still good, so the pane keeps working around it.
        error: data.error || null,
        focus: null,
    });
    if (select) setNewCwd(data.path);
    cancelMkdir();
    renderBrowse();
    if (fromKeyboard) focusRowAt(0);
}

function renderBrowse() {
    const b = state.browse;

    // More than one root configured means the second one is otherwise unreachable
    // from here: the trail stops at the top of whichever root you are inside.
    dom.newRoots.hidden = b.roots.length < 2;
    if (b.roots.length >= 2) {
        dom.newRoots.replaceChildren(
            el('span', {}, 'Roots:'),
            ...b.roots.map(r => el('button', {
                class: 'crumb', type: 'button', onclick: () => browseTo(r),
            }, homely(r))));
    }

    dom.newCrumbs.replaceChildren(...crumbsFor(b));

    // The way back up is rendered whatever happened below it, so an unreadable
    // folder is somewhere you can leave rather than somewhere you are stuck.
    const rows = b.parent ? [upRow()] : [];
    if (b.error) {
        rows.push(el('div', { class: 'picker-msg' }, `Cannot read this folder — ${b.error}`));
    } else {
        rows.push(...b.entries.map((e, i) => treeRow(e, i)));
        if (!b.entries.length) {
            // The sentence that answers "so how do I pick where I am?", at the
            // moment somebody standing in an empty folder asks it.
            rows.push(el('div', { class: 'picker-msg' },
                'No sub-folders here. Start uses this one.'));
        }
    }
    dom.newTree.replaceChildren(...rows);
    setTreeTab();

    dom.newMkdir.textContent = `New folder in ${clip(baseName(b.dir), 24)}`;
    dom.newBrowseNote.textContent = browseNote(b);
}

function baseName(p) {
    const parts = String(p || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '/';
}

/** What the pane wants to say under itself, if anything. */
export function browseNote(b) {
    const typed = tidyPath(dom.newCwd.value);
    if (typed && b.dir && typed !== b.dir) {
        return `Showing ${homely(b.dir)} — press Enter in the box to browse to what you typed.`;
    }
    if (b.truncated) return `Showing the first 500 folders — type a path to go straight there.`;
    return '';
}

/**
 * The trail, stopping at the top of whichever root contains this directory
 * rather than walking on to `/` — every crumb has to be somewhere you may go.
 */
function crumbsFor(b) {
    if (!b.dir) return [];
    const root = b.roots
        .filter(r => b.dir === r || b.dir.startsWith(`${r}/`))
        .sort((x, y) => y.length - x.length)[0] || '/';

    const rest = b.dir.slice(root.length).split('/').filter(Boolean);
    const out = [crumb(homely(root), root, !rest.length)];
    let at = root === '/' ? '' : root;
    rest.forEach((seg, i) => {
        at += `/${seg}`;
        const here = at;
        out.push(el('span', {}, '/'), crumb(seg, here, i === rest.length - 1));
    });
    return out;
}

function crumb(label, target, current) {
    return el('button', {
        class: 'crumb', type: 'button',
        // The last crumb re-lists rather than doing nothing, which doubles as the
        // refresh you want after making a folder outside the app.
        'aria-current': current ? 'page' : null,
        onclick: () => browseTo(target),
    }, label);
}

function upRow() {
    return el('button', {
        class: 'picker-row up', type: 'button', 'data-path': state.browse.parent,
        onclick: () => browseTo(state.browse.parent),
        onkeydown: (e) => onTreeKey(e, -1),
    }, el('span', {}, '↑ ..'), el('span', { class: 'path' }, homely(state.browse.parent)));
}

function treeRow(entry, i) {
    const seen = state.browse.known.get(entry.path);
    // Having worked here is the stronger signal, so it wins the one tag slot.
    // Green is kept for a session actually running, as it is everywhere else —
    // "you have been here before" is a quieter fact than "something is happening".
    const tag = seen
        ? (seen.active
            ? el('span', { class: 'tag' }, `${seen.active} live`)
            : el('span', { class: 'tag dim' }, 'seen'))
        : (entry.git ? el('span', { class: 'tag dim' }, 'git') : null);
    return el('button', {
        class: 'picker-row', type: 'button', 'data-path': entry.path,
        'aria-current': entry.path === tidyPath(dom.newCwd.value) ? 'true' : null,
        onclick: () => browseTo(entry.path),
        onkeydown: (e) => onTreeKey(e, i),
    }, el('span', {}, clip(entry.name, 48)), tag);
}

// One tab stop for the whole list, arrows to move within it — the same shape as
// the send queue, which is the only other long list of buttons in this file.
function setTreeTab() {
    const rows = [...dom.newTree.querySelectorAll('.picker-row')];
    const want = rows.find(r => r.dataset.path === state.browse.focus) || rows[0];
    for (const r of rows) r.tabIndex = r === want ? 0 : -1;
}

function focusRowAt(i) {
    const rows = [...dom.newTree.querySelectorAll('.picker-row')];
    const row = rows[Math.max(0, Math.min(i, rows.length - 1))];
    if (!row) { dom.newTree.focus?.(); return false; }
    state.browse.focus = row.dataset.path;
    setTreeTab();
    row.focus({ preventScroll: false });
    return true;
}

/**
 * `i` is the row's index, or -1 for the Up row that sits above them all.
 *
 * Escape is deliberately absent: a row has nothing of its own to cancel, so the
 * central ladder should get it and close the dialog. The only thing here that
 * stops Escape is the New folder box.
 */
function onTreeKey(e, i) {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRowAt(rowIndex(i) + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); focusRowAt(rowIndex(i) - 1); return; }
    if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
        if (!state.browse.parent) return;
        e.preventDefault();
        browseTo(state.browse.parent, { fromKeyboard: true });
        return;
    }
    if (e.key === 'ArrowRight') {
        e.preventDefault();
        const target = i < 0 ? state.browse.parent : state.browse.entries[i]?.path;
        if (target) browseTo(target, { fromKeyboard: true });
    }
    // Enter and Space are a button's own job — the click handler navigates.
}

/** Position in the rendered list, where the Up row (i === -1) is index 0. */
function rowIndex(i) {
    const offset = state.browse.parent ? 1 : 0;
    return i < 0 ? 0 : i + offset;
}

// ── new folder ───────────────────────────────────────────────────────────

export function startMkdir() {
    state.browse.naming = true;
    dom.newMkdir.hidden = true;
    dom.newMkdirName.hidden = false;
    dom.newMkdirGo.hidden = false;
    dom.newMkdirName.value = '';
    dom.newMkdirName.focus();
}

export function cancelMkdir() {
    state.browse.naming = false;
    dom.newMkdir.hidden = false;
    dom.newMkdirName.hidden = true;
    dom.newMkdirGo.hidden = true;
    dom.newMkdirName.value = '';
}

export async function submitMkdir() {
    const name = dom.newMkdirName.value.trim();
    const parent = state.browse.dir;
    if (!name) { dom.newMkdirName.focus(); return; }
    if (!parent) return;

    // Pre-empt the duplicate the pane can already see. The server still answers
    // for the one it cannot — something else may have created it meanwhile.
    if (state.browse.entries.some(e => e.name === name)) {
        toast(`${name} is already here.`, 'warn');
        return;
    }

    dom.newMkdirGo.disabled = true;
    try {
        const r = await post('/api/fs/mkdir', { parent, name });
        cancelMkdir();
        // Walking in is what selects it, so this is also the pick.
        await browseTo(r.path);
        toast(r.created ? `Created ${name}.` : `${name} was already there.`, 'ok');
        dom.newPrompt.focus();
    } catch (err) {
        // The name box stays open with the text in it — retyping a rejected name
        // is the one thing that should not be part of fixing it.
        toast(`Could not create the folder: ${err.message}`, 'error');
        dom.newMkdirName.focus();
    } finally {
        dom.newMkdirGo.disabled = false;
    }
}
