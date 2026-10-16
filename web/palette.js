// The command palette (Ctrl+K, `palette.open`): one box that finds a session, a
// view or anything a button does, drawn with Preact the way web/rail.js is.
//
// **Three lists and a way out.** Sessions come from `state.sessions`, most
// recent first, matched on title, project and status line. Views and actions
// come from web/palette/registry.js, which any module can add to. Last comes
// Search: "Filter sessions for '…'", which hands the words to the rail's filter
// — Ctrl+K pressed again with something typed does the same, because Ctrl+K was
// the rail filter's chord until this took it — and, once transcript search has
// landed, "Search transcripts for '…'".
//
// **Keyboard first.** Up and Down move (and wrap), Tab and Shift+Tab jump to the
// next or previous group, Enter runs, Escape closes. The pointer selects on
// move rather than on enter, so a list scrolling under a still mouse does not
// steal the selection from the keyboard.
//
// **Not a modal, by modalUp()'s rules.** It holds no work, so it answers Escape —
// from a capture listener, so the key never reaches the ladder in app.js and
// closes the panel behind it. It does not open over a modal dialog, which would
// leave two things claiming the keyboard.
//
// **Motion** is the dialog pair openModal uses — `scrim` on the backdrop and
// `dialog` on the box — so reduced motion is motion.js's business, not ours.
//
// State is in `state.palette`; everything else is derived on each draw.

import { html, render } from './vendor/preact.js';
import { state } from './state.js';
import { closeOnClickOutside, dom, modalUp, toast } from './dom.js';
import { pose, present } from './motion.js';
import * as keys from './keys.js';
import { ago } from './format.js';
import { openSession } from './transcript/conversation.js';
import { rank } from './palette/score.js';
import { entries, refreshSources } from './palette/registry.js';
import { loadOptional } from './palette/builtin.js';

const ORDER = ['Sessions', 'Views', 'Actions'];   // then any other group, then Search
const RECENT = 8;        // sessions listed before anything is typed
const PER_GROUP = 8;     // rows per group once something is typed
const MIN_PER_CHAR = 3;  // see rank() in web/palette/score.js

let back = null;         // what had the focus before the palette opened
let shown = { groups: [], flat: [] };

const recency = (s) => Date.parse(s.lastTs || '') || s.mtimeMs || 0;
const titleOf = (e) => (typeof e.title === 'function' ? e.title() : e.title);

// ── open and shut ────────────────────────────────────────────────────────

export function openPalette() {
    if (state.palette.open || modalUp()) return;
    back = document.activeElement;
    state.palette.open = true;
    state.palette.q = '';
    state.palette.sel = 0;
    drawPalette();
    present(dom.paletteScrim, true, { as: 'scrim' });
    const box = dom.paletteScrim.firstElementChild;
    if (box) pose(box, 'in', { as: 'dialog' });
    const input = dom.paletteScrim.querySelector('input');
    if (input) input.focus();
    loadOptional(() => { if (state.palette.open) drawPalette(); });
    refreshSources().then(() => { if (state.palette.open) drawPalette(); });
}

export function closePalette() {
    if (!state.palette.open) return;
    state.palette.open = false;
    const box = dom.paletteScrim.firstElementChild;
    if (box) pose(box, 'out', { as: 'dialog' });
    present(dom.paletteScrim, false, { as: 'scrim' });
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
    back = null;
}

/**
 * The `palette.open` chord. Shut, it opens. Open with nothing typed, it closes.
 * Open with words typed, it gives them to the rail's filter — the chord used to
 * be the filter's, and this keeps the old habit one keystroke away.
 */
export function togglePalette() {
    if (!state.palette.open) { openPalette(); return; }
    const q = state.palette.q.trim();
    closePalette();
    if (q) filterRail(q);
}

/** Put words in the rail's filter as if typed there; its own listener does the rest. */
function filterRail(q) {
    dom.search.value = q;
    dom.search.dispatchEvent(new Event('input'));
    dom.search.focus();
}

// ── what is listed ───────────────────────────────────────────────────────

function sessionRow({ item: s, hits, score = 0 }) {
    const standing = s.standing && s.standing.text;
    return {
        score,
        id: `s.${s.sessionId}`,
        title: s.title || s.lastPrompt || s.sessionId,
        hits: hits[0],
        meta: html`${s.projectName || ''}${s.worktree && s.worktree.name ? html` <span class="pal-mono">${s.worktree.name}</span>` : null}${
            s.lastTs ? ` · ${ago(s.lastTs)}` : ''}${standing ? html` · <span class="pal-standing">${standing}</span>` : null}`,
        run: () => openSession(s.sessionId),
    };
}

function entryRow({ item: e, hits, score = 0 }) {
    return {
        score,
        id: e.id,
        title: titleOf(e),
        hits: hits[0] || [],
        meta: e.meta || '',
        chord: e.command ? keys.label(e.command) : '',
        run: e.run,
    };
}

function model() {
    const q = state.palette.q.trim();
    const groups = new Map();
    const add = (g, row) => {
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(row);
    };

    const sessions = [...(state.sessions || [])].sort((a, b) => recency(b) - recency(a));
    const found = q
        ? rank(sessions, q, {
            limit: PER_GROUP, perChar: MIN_PER_CHAR,
            fields: s => [
                { text: s.title || s.lastPrompt || '', weight: 1 },
                { text: s.projectName || '', weight: 0.6 },
                { text: (s.standing && s.standing.text) || '', weight: 0.45 },
            ],
        })
        : sessions.slice(0, RECENT).map(item => ({ item, hits: [[]] }));
    for (const r of found) add('Sessions', sessionRow(r));

    const all = entries({ q }).map(e => ({ ...e, title: titleOf(e) }));
    const always = all.filter(e => e.always);
    const pool = all.filter(e => !e.always && (q || !e.quiet));
    const ranked = q
        ? rank(pool, q, {
            perChar: MIN_PER_CHAR,
            fields: e => [
                { text: e.title, weight: 1 },
                { text: e.keywords || '', weight: 0.5 },
                { text: typeof e.meta === 'string' ? e.meta : '', weight: 0.4 },
            ],
        })
        : pool.map(item => ({ item, hits: [[]] }));
    const count = new Map();
    for (const r of ranked) {
        const g = r.item.group || 'Actions';
        const n = count.get(g) || 0;
        if (q && n >= PER_GROUP) continue;
        count.set(g, n + 1);
        add(g, entryRow(r));
    }

    if (q) {
        add('Search', {
            id: 'rail.filter.q', title: `Filter sessions for '${q}'`, hits: [],
            meta: 'In the rail', chord: keys.label('palette.open'), run: () => filterRail(q),
        });
    }
    for (const e of always) add(e.group || 'Search', entryRow({ item: e, hits: [[]] }));

    // Before anything is typed the groups keep their order. Once something is,
    // the group with the best match goes first — typing `land` should put the
    // Land command above eight sessions that mention landing — and Search stays
    // last, being the way out rather than an answer.
    const names = [...groups.keys()];
    const rankOf = (g) => (ORDER.includes(g) ? ORDER.indexOf(g) : g === 'Search' ? 99 : ORDER.length);
    const top = (g) => (g === 'Search' ? -Infinity : Math.max(...groups.get(g).map(r => r.score || 0)));
    names.sort((a, b) => (q ? top(b) - top(a) : 0) || rankOf(a) - rankOf(b));
    const out = names.map(group => ({ group, rows: groups.get(group) }));
    let i = 0;
    for (const g of out) for (const r of g.rows) r.index = i++;
    return out;
}

// ── drawing ──────────────────────────────────────────────────────────────

/** A title with the matched characters picked out. */
function marked(text, hits) {
    if (!hits || !hits.length) return text;
    const at = new Set(hits);
    const parts = [];
    let run = '';
    let on = false;
    for (let i = 0; i < text.length; i++) {
        const hit = at.has(i);
        if (hit !== on && run) { parts.push(on ? html`<b class="pal-hit">${run}</b>` : run); run = ''; }
        on = hit;
        run += text[i];
    }
    if (run) parts.push(on ? html`<b class="pal-hit">${run}</b>` : run);
    return parts;
}

const optionId = (row) => `pal-o-${row.index}`;

export function drawPalette() {
    const groups = model();
    const flat = groups.flatMap(g => g.rows);
    if (state.palette.sel >= flat.length) state.palette.sel = Math.max(0, flat.length - 1);
    shown = { groups, flat };
    const sel = state.palette.sel;
    const active = flat[sel];

    render(html`<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input class="pal-input" type="text" spellcheck="false" autocomplete="off"
            placeholder="Go to a session, a view or an action…"
            role="combobox" aria-expanded="true" aria-controls="pal-list"
            aria-activedescendant=${active ? optionId(active) : ''}
            value=${state.palette.q} onInput=${onInput} onKeyDown=${onKey} />
        <div class="pal-list" id="pal-list" role="listbox" aria-label="Results">
            ${groups.length ? groups.map(g => html`<div key=${g.group} class="pal-group" role="group" aria-label=${g.group}>
                <div class="pal-head">${g.group}</div>
                ${g.rows.map(r => html`<div key=${r.id} id=${optionId(r)} role="option" class="pal-row"
                    aria-selected=${r.index === sel ? 'true' : 'false'}
                    onMouseMove=${() => hover(r.index)} onClick=${() => runRow(r)}>
                    <span class="pal-main">
                        <span class="pal-title">${marked(r.title, r.hits)}</span>
                        ${r.meta ? html`<span class="pal-meta">${r.meta}</span>` : null}
                    </span>
                    ${r.chord ? html`<kbd class="pal-kbd">${r.chord}</kbd>` : null}
                </div>`)}
            </div>`) : html`<div key="empty" class="pal-empty">Nothing matches.</div>`}
        </div>
        <div class="pal-foot" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>Tab</kbd> next group</span>
            <span><kbd>Enter</kbd> open</span>
            <span><kbd>Esc</kbd> close</span>
        </div>
    </div>`, dom.paletteScrim);

    const on = dom.paletteScrim.querySelector('.pal-row[aria-selected="true"]');
    if (on) on.scrollIntoView({ block: 'nearest' });
}

// ── input ────────────────────────────────────────────────────────────────

function onInput(e) {
    state.palette.q = e.currentTarget.value;
    state.palette.sel = 0;
    drawPalette();
}

function hover(i) {
    if (state.palette.sel === i) return;
    state.palette.sel = i;
    drawPalette();
}

function select(i) {
    state.palette.sel = i;
    drawPalette();
}

function onKey(e) {
    const { flat, groups } = shown;
    const n = flat.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (n) select((state.palette.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
        return;
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        if (!groups.length) return;
        const at = groups.findIndex(g => g.rows.some(r => r.index === state.palette.sel));
        const next = (Math.max(0, at) + (e.shiftKey ? -1 : 1) + groups.length) % groups.length;
        select(groups[next].rows[0].index);
        return;
    }
    if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        const row = flat[state.palette.sel];
        if (row) runRow(row);
    }
}

function runRow(row) {
    closePalette();
    Promise.resolve().then(() => row.run()).catch((err) => toast(`${row.title}: ${err.message}`, 'error'));
}

// ── wiring ───────────────────────────────────────────────────────────────

export function wirePalette() {
    // Capture, so a panel behind the palette never sees this Escape.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && state.palette.open) {
            e.preventDefault();
            e.stopPropagation();
            closePalette();
        }
    }, true);
    closeOnClickOutside(dom.paletteScrim, closePalette);
}
