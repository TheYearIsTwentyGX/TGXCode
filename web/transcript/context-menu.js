// The right-click menu, and the file menu the changes drawer and the diff
// viewer open with it.
//
// This imports app.js and sibling modules here, which import it back. That is
// safe only because nothing in this file reads an imported binding while the
// module is evaluating — every use is inside a function called later. Keep it
// that way: a top-level `const X = someImport(...)` runs before app.js's body
// and throws in the temporal dead zone, and only loading the page shows it.

import { post } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { state } from '../state.js';
import { openAgent } from './subagents.js';
import { jumpToTurn } from './turn-rail.js';

// ── the right-click menu ───────────────────────────────────────────────────
//
// The app's other menus (#bell-menu, #new-menu, #quota-menu) are absolutely
// positioned inside a wrapper that anchors them to the control that opens them.
// A menu anchored to the pointer has no such wrapper, so this is #turn-pop's
// shape instead — one fixed element, filled per open, clamped to the viewport —
// with #new-menu's rows and key handling inside it.

/**
 * The rows that open this menu themselves — a file row, a rail marker, a snippet.
 *
 * The document-level `contextmenu` listener runs on the bubble, after the row's own
 * handler has already opened the menu, so a selector missing from here is a menu that
 * opens and shuts on the same click. Kept in one place because the listener and the
 * handlers are 18,000 lines apart and the failure looks like the handler not firing.
 */
export const CTX_OWNERS = '.ch-row, .turn-tick, .snip-row, .btn-pin-snip, #cv-pill';

/**
 * Open a menu at the pointer.
 *
 * @param {MouseEvent} ev the contextmenu event, already preventDefault'd
 * @param {Array<{label: string, onClick: Function, disabled?: string|false,
 *                danger?: boolean, sep?: boolean}>} items
 *   `disabled` carries the *reason* rather than a boolean, and it becomes the
 *   row's tooltip. Greying a row and not saying why is worse than omitting it.
 */
export function openContextMenu(ev, items) {
    const menu = dom.ctxMenu;
    closeContextMenu({ focus: false });
    state.ctx.from = document.activeElement;

    const rows = [];
    menu.replaceChildren(...items.map((it) => {
        if (it.sep) return el('div', { class: 'sep' });
        const row = el('button', {
            class: `picker-row${it.danger ? ' danger' : ''}`,
            type: 'button', role: 'menuitem', tabindex: -1,
            title: it.disabled || null,
            onclick: () => {
                // Closed without restoring focus: an item that scrolls the
                // transcript or opens a dialog has somewhere better to put it.
                closeContextMenu({ focus: false });
                it.onClick();
            },
            onkeydown: (e) => onContextMenuKey(e, rows.indexOf(row)),
        }, it.label);
        if (it.disabled) row.disabled = true;
        rows.push(row);
        return row;
    }));

    menu.hidden = false;

    // Measured after it is in the layout, and clamped to both axes. The flip is
    // what matters here and does not for #turn-pop: the changes drawer is pinned
    // to the right edge, so clamping alone would drop the menu over the row.
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    // A keyboard invocation (Shift+F10, the Menu key) reports 0,0. Fall back to
    // the row it came from, so the feature works without a mouse.
    let x = ev.clientX;
    let y = ev.clientY;
    if (!x && !y && ev.currentTarget && ev.currentTarget.getBoundingClientRect) {
        const r = ev.currentTarget.getBoundingClientRect();
        x = r.left;
        y = r.bottom;
    }
    if (x + w > window.innerWidth - 8) x -= w;
    menu.style.left = `${Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8))}px`;
    menu.style.top = `${Math.min(Math.max(8, y), Math.max(8, window.innerHeight - h - 8))}px`;

    const first = rows.find(r => !r.disabled);
    if (first) {
        setCtxTab(rows.indexOf(first));
        first.focus();
    }
}

export function closeContextMenu({ focus = false } = {}) {
    if (dom.ctxMenu.hidden) return;
    dom.ctxMenu.hidden = true;
    const back = state.ctx.from;
    state.ctx.from = null;
    if (focus && back && back.isConnected) back.focus();
}

const ctxRows = () => [...dom.ctxMenu.querySelectorAll('.picker-row:not([disabled])')];

function setCtxTab(i) {
    const all = [...dom.ctxMenu.querySelectorAll('.picker-row')];
    all.forEach((r, n) => { r.tabIndex = n === i ? 0 : -1; });
}

function onContextMenuKey(e, _i) {
    const rows = ctxRows();
    if (!rows.length) return;
    const here = rows.indexOf(document.activeElement);
    const go = (n) => {
        const row = rows[(n + rows.length) % rows.length];
        setCtxTab([...dom.ctxMenu.querySelectorAll('.picker-row')].indexOf(row));
        row.focus();
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); return go(here + 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); return go(here - 1); }
    if (e.key === 'Home') { e.preventDefault(); return go(0); }
    if (e.key === 'End') { e.preventDefault(); return go(rows.length - 1); }
    if (e.key === 'Tab') closeContextMenu({ focus: true });
    // Escape is deliberately absent — the central ladder closes this, the same
    // way it closes #new-menu.
}

/**
 * One drawer row's two lists reconciled into what a menu needs.
 *
 * The two kinds carry different things: an edits row has an absolute `path` and a
 * `relPath`, and knows where in the conversation it came from; a tree row has a
 * repo-relative path and a porcelain status, and knows nothing about who changed
 * it. `sendPath` is what goes to the bridge, and it is never an absolute path
 * this client computed — the bridge re-derives, and giving it a path we built
 * would be asking it to trust our arithmetic.
 */
export function fileTarget(f, kind) {
    const d = state.changes.data || {};
    const sample = (d.git && d.git.sample) || [];
    const edits = d.edits || [];

    if (kind === 'edit') {
        const tree = sample.find(g => g.path === f.relPath) || null;
        return {
            kind, sendPath: f.relPath, path: f.relPath, absPath: f.path,
            status: tree ? tree.status : null,
            added: f.added, deleted: f.deleted, binary: tree ? tree.binary : false,
            toolId: f.toolId, agent: f.agent,
        };
    }

    const edit = edits.find(e => e.relPath === f.path) || null;
    return {
        kind, sendPath: f.path, path: f.path,
        absPath: edit ? edit.path : (d.git && d.git.root ? `${d.git.root}/${f.path}` : null),
        status: f.status, added: f.added, deleted: f.deleted, binary: f.binary,
        toolId: edit ? edit.toolId : null, agent: edit ? edit.agent : null,
    };
}

export function openFileMenu(ev, f, kind) {
    ev.preventDefault();
    const t = fileTarget(f, kind);
    const items = [
        { label: 'Open', onClick: () => openOnHost(t) },
    ];

    // Present on an edits row always: `state.tools` fills in as the transcript
    // loads, so a row built a second too early would be greyed for good — the
    // same reason the click itself resolves late. On a tree row it is present
    // only when the file is one this session edited: the working tree cannot
    // know who changed a file, so there is no later state in which it would
    // start working, and greying it would imply there was.
    if (kind === 'edit' || t.toolId || t.agent) {
        items.push({ label: 'Jump To', onClick: () => jumpToFile(t) });
    }

    openContextMenu(ev, items);
}

async function openOnHost(t) {
    // Never disabled ahead of time. What this client knows about whether a file
    // can be opened is poor — a porcelain `D.` and `.D` differ, and an edits row
    // knows nothing at all — while the bridge answers precisely. Fire, and say
    // what it said. The Open folder button in the header works the same way.
    try {
        const out = await post(`/api/sessions/${state.current.sessionId}/open-file`,
            { path: t.sendPath });
        // The bridge reveals rather than launches a file Windows would run. That
        // is a success, and silence would leave you looking at a folder you did
        // not ask for with no idea why.
        if (out.how === 'reveal') {
            toast('Windows would run that file, so its folder opened instead.', 'warn');
        }
    } catch (err) {
        toast(`Could not open that file: ${err.message}`, 'error');
    }
}

function jumpToFile(t) {
    const entry = t.toolId ? state.tools.get(t.toolId) : null;
    if (entry) return jumpToTurn(entry);
    if (t.agent) return openAgent(t.agent.toolUseId);
    toast('That edit is not in the part of the conversation on screen.', 'warn');
}
