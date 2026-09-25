// Ctrl+F over the open transcript, the subagent pane included: the index, the
// highlight marks, keeping up as the log moves, and the bar.
//
// This imports app.js and sibling modules here, which import it back. That is
// safe only because nothing in this file reads an imported binding while the
// module is evaluating — every use is inside a function called later. Keep it
// that way: a top-level `const X = someImport(...)` runs before app.js's body
// and throws in the temporal dead zone, and only loading the page shows it.

import { get } from '../api.js';
import { dom, el } from '../dom.js';
import { state } from '../state.js';
import { AGENT_VIEW, SESSION_VIEW } from './conversation.js';
import { agentRows, closeAgent, openAgent } from './subagents.js';
import { fillTool, todoItemsOf, toolSummary } from './tools.js';
import { revealNode, turnText } from './turn-rail.js';

// ── find in conversation ─────────────────────────────────────────────────
//
// Ctrl+F over the open transcript. The browser's own find is not an option
// here: most of a transcript is not in the DOM for it to look at, because a
// tool call's body is built on first expand (fillTool) and runs of calls are
// moved inside collapsed folds. In the packaged shell there is no native find
// at all — app/main.js drops the menu — so this replaces nothing.
//
// **Two layers, and only one of them is the truth.**
//
// The index is built from the *event objects*: `ev.text`, a tool's input, a
// tool's result. That is the only source that can see inside a tool call nobody
// has opened, or a subagent transcript that is not on screen, and it is what
// survives virtualizing the log later on (docs/plans/07-transcript-view.md
// states it as an invariant). So the count is always the data count, and it
// answers "how many places in this conversation say this".
//
// The marks are DOM ranges, because painting needs real text nodes. Ranges are
// held as a cache and nothing else: the DOM's remove steps collapse any live
// range inside a node that *moves*, and this transcript moves nodes — foldRun
// lifts a run of rows into a fold without redrawing them, which is exactly the
// property that keeps patchTool working. A collapsed range paints nothing and
// throws nothing, so the failure is silent; the answer is to rebuild from one
// dirty flag rather than to reason about which mutation did it.
//
// The two strings differ — markdown eats `**` and list markers, `codePre` stops
// at 40 000 characters, `kvView` clips a value at 600 — so the k-th hit in the
// data is not always the k-th range in the DOM. Rather than model that,
// navigation clamps: land on `ranges[min(n, ranges.length - 1)]`, or on the row
// itself if there are no ranges at all. One line, cannot throw, and it degrades
// in the right direction — exact when the two agree, off by a few inside one
// event when they do not, row-level when they disagree completely.
//
// What the count includes and the marks cannot show is not left unexplained
// either: a closed tool block wears a badge saying how many are inside it, so
// marks plus badges add up to the number in the field.
//
// Known misses, all deliberate: a match split across an element boundary (the
// `<code>` in the middle of a sentence) is not found, the same limit native find
// has; output spilled to a file is in neither source, since only the button that
// loads it knows the text; and `agentRows` leaves out agents spawned *by* a
// subagent, so the toggle covers the one level the pill strip shows.

const FIND_MIN = 2;         // shorter than this matches everything and paints nothing useful
// Hits indexed before the count gives up and wears a `+`. Generous on purpose:
// the cap stops indexing partway *down* the transcript, so a low one leaves you
// at the bottom of a long session with every mark up at the top and no way to
// tell. 20 000 covers a two-letter query on the longest session here; the paint
// is bounded by the viewport instead, which is where the cost actually was.
const FIND_MAX = 20000;
const FIND_PAINT_MAX = 3000;    // ranges registered at once

/** Whichever transcript is on screen. Both panes stay mounted; one is hidden. */
function activeView() {
    return state.agent ? AGENT_VIEW : SESSION_VIEW;
}

// ── the index ────────────────────────────────────────────────────────────

export const findKey = (agentId, evId) => `${agentId || ''} ${evId}`;

/** One event's searchable text, lowercased once and kept. */
function findText(agentId, ev) {
    const key = findKey(agentId, ev.id);
    const had = state.find.text.get(key);
    if (had !== undefined) return had;
    const text = searchableText(ev).toLowerCase();
    state.find.text.set(key, text);
    return text;
}

function searchableText(ev) {
    const parts = [];
    switch (ev.kind) {
        case 'user':
            parts.push(turnText(ev));
            for (const f of ev.files || []) parts.push(f.name, f.relPath);
            break;
        case 'assistant':
        case 'thinking':
            parts.push(ev.text);
            break;
        case 'tool':
            parts.push(ev.name, toolSummary(ev), toolText(ev));
            break;
        case 'agent-done':
            parts.push(ev.summary, ev.result);
            break;
        case 'peer-message':
            parts.push(ev.fromName, ev.from, ev.text);
            break;
        case 'handoff':
            parts.push(ev.fromTitle, ev.title, ev.fromProject, ev.text);
            break;
        case 'system':
            parts.push(ev.subtype, ev.text);
            break;
        default:
            parts.push(ev.text);
    }
    return parts.filter(Boolean).join('\n');
}

/**
 * A tool call's text, as toolBody would draw it.
 *
 * This mirrors toolBody's branches on purpose, and the two have to be kept in
 * step: that if-chain is the definition of what a tool call *shows*, and
 * therefore of what should be findable in it. Searching by building the body
 * instead is the thing this whole design exists to avoid — filling every
 * matching block on a long session is seconds of syntax highlighting — so the
 * duplication is the price, and this comment is the receipt.
 */
function toolText(ev) {
    const i = ev.input || {};
    const r = ev.result || {};
    const out = [];

    // --- input ------------------------------------------------------------
    if (ev.name === 'Bash') {
        out.push(i.command);
    } else if (ev.name === 'Write') {
        out.push(i.content);
    } else if (ev.name === 'Edit') {
        if (r.patch) out.push(patchText(r.patch));
        else out.push(i.old_string, i.new_string);
    } else if (ev.name === 'TodoWrite') {
        for (const t of todoItemsOf(i)) {
            out.push(t.subject || t.content || t.description || t.activeForm || '');
        }
    } else if (ev.name === 'Task' || ev.name === 'Agent') {
        out.push(i.prompt);
    } else if (ev.name === 'ExitPlanMode') {
        out.push(i.plan);
        // Only the tail when the approved text differs — a note is a couple of
        // lines and the plan it is appended to is routinely tens of kilobytes,
        // so pushing `r.plan` whole would double the biggest string in the find
        // index to add those two lines.
        if (r.plan && r.plan !== i.plan && r.plan.startsWith(i.plan || '')) {
            out.push(r.plan.slice((i.plan || '').length));
        } else if (r.plan && r.plan !== i.plan) {
            out.push(r.plan);
        }
    } else if (ev.name === 'AskUserQuestion') {
        for (const q of i.questions || []) {
            out.push(q.header, q.question);
            for (const o of q.options || []) out.push(o.label);
        }
        // What you chose is often the only part of a question you remember well
        // enough to search for.
        if (r.answers) out.push(...Object.values(r.answers));
    } else if (ev.name === 'SendMessage') {
        out.push(i.summary);
        out.push(typeof i.message === 'string' ? i.message : JSON.stringify(i.message, null, 2));
    } else {
        // kvView: the keys as well as the values, because a Grep call is mostly
        // its field names, and JSON for anything that is not a string.
        for (const [k, v] of Object.entries(i)) {
            out.push(k, typeof v === 'string' ? v : JSON.stringify(v, null, 1));
        }
    }

    // --- output -----------------------------------------------------------
    if (ev.name === 'Write' || (ev.name === 'Edit' && r.patch)) {
        if (ev.status === 'error') out.push(r.text);
    } else if (r.patch && ev.name !== 'Edit') {
        out.push(patchText(r.patch));
    } else if (r.stdout || r.stderr) {
        out.push(r.stdout, r.stderr);
    } else if (r.text) {
        out.push(r.text);
    }
    if (r.backgroundTaskId) out.push(r.backgroundTaskId);
    if (ev.agent) out.push(ev.agent.description, ev.agent.agentType);

    return out.filter(Boolean).join('\n');
}

function patchText(patch) {
    const out = [];
    for (const h of patch || []) for (const line of h.lines || []) out.push(line);
    return out.join('\n');
}

/**
 * Every match in the conversation, in the order you would read them.
 *
 * With the toggle off this is the visible pane and nothing else. With it on it is
 * always the session's own transcript plus its subagents' — regardless of which
 * pane is showing — and a subagent's hits are spliced in immediately after the
 * call that spawned it, because that is where the work happened. Keeping the
 * index independent of the pane is what lets a step walk into a subagent and back
 * out again without the list changing underneath it.
 */
function buildHits() {
    const f = state.find;
    f.hits = [];
    f.matched = [];
    f.capped = false;
    if (f.q.length < FIND_MIN) return;

    const cross = f.subagents;
    const view = cross ? SESSION_VIEW : activeView();
    const agentId = cross ? null : (view.isAgent ? state.agent : null);

    for (const { ev } of view.nodes.values()) {
        pushHits(agentId, ev);
        if (cross && (ev.name === 'Task' || ev.name === 'Agent')) {
            for (const sub of f.subs.get(ev.id) || []) pushHits(ev.id, sub);
        }
        if (f.capped) break;
    }
}

function pushHits(agentId, ev) {
    const f = state.find;
    const text = findText(agentId, ev);
    const q = f.q;
    let at = text.indexOf(q);
    if (at === -1) return;
    let n = 0;
    while (at !== -1 && f.hits.length < FIND_MAX) {
        f.hits.push({ agentId, evId: ev.id, n: n++ });
        at = text.indexOf(q, at + q.length);
    }
    if (f.hits.length >= FIND_MAX) f.capped = true;
    f.matched.push({ agentId, evId: ev.id, count: n });
}

// ── the marks ────────────────────────────────────────────────────────────

/**
 * Repaint the marks that are on screen, and return the range the current hit
 * landed on.
 *
 * **Only what is on screen.** Painting every match instead is what the first
 * version did, and on the longest session here — 3 600 events, 2 300 tool calls
 * — a two-letter query matched 674 rows and cost 400ms a keystroke. Almost none
 * of that was the tree walking, which is 20ms for the entire log: it was 674
 * badge elements inserted and removed again per repaint, each one invalidating
 * the layout of a very tall document. So the work is bounded by the viewport
 * rather than by the transcript, and scrolling repaints.
 *
 * Which row is *in* the viewport is found by binary search, the same trick and
 * the same reason as markActiveTurn: measuring each candidate is a forced layout
 * of the whole transcript. Rows inside a closed fold have no box at all, so a
 * fold stands in for the rows it swallowed — that is also the only thing of them
 * that can carry a badge.
 */
export function paintFind() {
    const f = state.find;
    clearHitBadges();
    f.painted = [];
    if (!CSS.highlights) return null;
    CSS.highlights.delete('cs-find');
    CSS.highlights.delete('cs-find-at');
    if (!f.open || f.q.length < FIND_MIN) return null;

    const view = activeView();
    const pane = view.isAgent ? state.agent : null;
    const cur = f.hits[f.at] || null;
    const rows = paintable(view, pane);
    const all = [];
    let at = null;

    for (const row of inBand(rows, view)) {
        if (row.fold) {
            // Nothing of the row itself is visible; the fold says how many are
            // in there and opening it is what shows them.
            bumpBadge(row.fold.querySelector('summary'), row.m.count);
            continue;
        }
        const det = row.node.querySelector('details');
        if (det && !det.open) bumpBadge(det.querySelector('summary'), row.m.count);

        const rs = rangesIn(row.node, f.q);
        let mine = -1;
        if (cur && cur.evId === row.m.evId && (cur.agentId || null) === pane && rs.length) {
            mine = Math.min(cur.n, rs.length - 1);
            at = rs[mine];
        }
        for (let k = 0; k < rs.length; k++) {
            if (k === mine) continue;
            if (all.length >= FIND_PAINT_MAX) break;
            all.push(rs[k]);
        }
    }

    // The row the current hit is on, wherever it is. gotoHit paints before it
    // scrolls — it needs the range to know where to scroll *to* — so the one
    // range that matters most is the one the band cannot be relied on to hold.
    if (!at && cur && (cur.agentId || null) === pane) {
        const entry = view.nodes.get(cur.evId);
        const rs = entry ? rangesIn(entry.node, f.q) : [];
        if (rs.length) at = rs[Math.min(cur.n, rs.length - 1)];
    }

    if (all.length) CSS.highlights.set('cs-find', new Highlight(...all));
    if (at) {
        const one = new Highlight(at);
        // Overlapping ranges at equal priority paint indeterminately, which is
        // why the current one is left out of the set above as well as lifted here.
        one.priority = 1;
        CSS.highlights.set('cs-find-at', one);
    }
    f.painted = all;
    return at;
}

/**
 * The matched rows this pane could show, in document order, each paired with the
 * closed fold hiding it if there is one.
 *
 * No layout is read here — `closest` and a map lookup only — which is what lets
 * the binary search below measure a handful rather than all of them.
 */
function paintable(view, pane) {
    const rows = [];
    for (const m of state.find.matched) {
        // A hit in the transcript that is not on screen. Nothing to paint, and
        // nothing to badge either — the pill for that subagent is where it would
        // belong, which is a separate thing worth doing.
        if ((m.agentId || null) !== pane) continue;
        const entry = view.nodes.get(m.evId);
        if (!entry) continue;
        const fold = entry.node.closest('.trun');
        rows.push({ m, node: entry.node, fold: fold && !fold.open ? fold : null });
    }
    return rows;
}

/**
 * Where a row sits, for the two questions that ask.
 *
 * The *fold* when there is one, not the row: a row inside a closed fold has no
 * box at all and measures as zeros, which is not merely useless but actively
 * wrong — it reads as being at the top of the window, and both searches below
 * are binary and need the answer to be monotonic down the list. A fold is a real
 * box in the right place, and several rows sharing one is fine.
 */
const rowBox = (row) => (row.fold || row.node).getBoundingClientRect();

/** The first row at or below `edge`, or -1. Binary, hence rowBox above. */
function firstRowFrom(rows, edge) {
    let lo = 0;
    let hi = rows.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (rowBox(rows[mid]).bottom >= edge) { found = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    return found;
}

/** The stretch of those rows within a screen and a half of the viewport. */
function inBand(rows, view) {
    if (!rows.length) return rows;
    const box = view.scroll.getBoundingClientRect();
    const band = box.height * 1.5;
    const first = firstRowFrom(rows, box.top - band);
    if (first < 0) return [];
    const bottom = box.bottom + band;
    let last = first;
    while (last < rows.length && rowBox(rows[last]).top <= bottom) last++;
    return rows.slice(first, last);
}

/** Every occurrence of `q` inside one row, as ranges, in document order. */
function rangesIn(node, q) {
    const out = [];
    const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
        acceptNode(t) {
            if (!t.nodeValue) return NodeFilter.FILTER_REJECT;
            // The clock in the gutter is not conversation, and a badge this
            // function just wrote is certainly not.
            const p = t.parentElement;
            if (!p || p.closest('.ev-time, .find-hits')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        const s = t.nodeValue.toLowerCase();
        let at = s.indexOf(q);
        while (at !== -1) {
            const r = document.createRange();
            r.setStart(t, at);
            r.setEnd(t, at + q.length);
            out.push(r);
            at = s.indexOf(q, at + q.length);
        }
    }
    return out;
}

/**
 * Say how many matches are inside something that is shut.
 *
 * Both kinds, and both at once where they nest: the tool block itself, and the
 * fold a run of them was lifted into. A fold's badge accumulates, which is why
 * this adds to an existing one rather than replacing it.
 */
function badgeClosed(node, count) {
    const fold = node.closest('.trun');
    if (fold && !fold.open) bumpBadge(fold.querySelector('summary'), count);
    const det = node.querySelector('details');
    if (det && !det.open) bumpBadge(det.querySelector('summary'), count);
}

function bumpBadge(host, count) {
    if (!host || !count) return;
    let tag = host.querySelector(':scope > .find-hits');
    if (!tag) {
        tag = el('span', { class: 'find-hits' }, '0');
        host.append(tag);
    }
    tag.textContent = String((Number(tag.textContent) || 0) + count);
}

function clearHitBadges() {
    for (const tag of document.querySelectorAll('.find-hits')) tag.remove();
}

// ── keeping up with a transcript that moves ──────────────────────────────

/**
 * Something changed under the marks. Rebuild on the next frame.
 *
 * Called from everything that appends, redraws or moves a row. Coalesced,
 * because a live turn does all three several times a second and the rebuild is
 * cheap only once per frame.
 */
export function markFindDirty() {
    const f = state.find;
    if (!f.open) return;
    f.dirty = true;
    if (f.frame) return;
    f.frame = requestAnimationFrame(() => { f.frame = 0; flushFind(); });
}

export function flushFind() {
    const f = state.find;
    if (!f.open) return;
    f.dirty = false;
    // Which hit is current is remembered by identity, not by index: with
    // subagents on a new event splices into the middle of the list, and an index
    // kept across that would quietly move you somewhere else.
    const keep = f.at >= 0 ? f.hits[f.at] : null;
    buildHits();
    f.at = keep
        ? f.hits.findIndex(h => h.evId === keep.evId && h.n === keep.n
            && (h.agentId || null) === (keep.agentId || null))
        : -1;
    paintFind();
    renderFindCount();
}

// ── the bar ──────────────────────────────────────────────────────────────

export function openFind() {
    const f = state.find;
    if (!state.current) return;
    // Only over a conversation you can see. A modal is a different conversation,
    // and `conv.hidden` is paintPanels' own answer to "is a whole-screen panel
    // covering this" — which is also what keeps the Escape ladder honest, since
    // an invisible bar that had claimed Escape would take it from the panel.
    if (dom.conv.hidden) return;
    if (!dom.newScrim.hidden || !dom.delScrim.hidden
        || !dom.taskScrim.hidden) return;

    f.open = true;
    dom.find.hidden = false;
    syncFindSubs();
    // You are reading, not tailing. Without this the next chunk of a live turn
    // scrolls the pane out from under the match you just landed on.
    state.pinned = false;
    dom.findInput.value = f.q;
    dom.findInput.focus();
    dom.findInput.select();
    flushFind();
}

export function closeFind({ focus = false } = {}) {
    const f = state.find;
    if (!f.open) return;
    f.open = false;
    f.at = -1;
    f.hits = [];
    f.matched = [];
    f.painted = [];
    dom.find.hidden = true;
    if (CSS.highlights) {
        CSS.highlights.delete('cs-find');
        CSS.highlights.delete('cs-find-at');
    }
    clearHitBadges();
    // The query survives, so F3 can pick the search back up.
    if (focus && !dom.input.disabled) dom.input.focus();
}

/**
 * Whether the Subagents toggle has anything to offer.
 *
 * `rows` is passed by renderAgents, which has just worked them out; on its own
 * agentRows walks every tool call in the session, and this is called from a
 * repaint.
 */
export function syncFindSubs(rows) {
    if (!state.find.open) return;
    const any = (rows || agentRows()).length;
    // Hidden while you are reading a subagent — you are already in one — unless
    // it is on, in which case it is a thing you may want to turn off.
    dom.findSubsRow.hidden = !any || (Boolean(state.agent) && !state.find.subagents);
    dom.findSubs.checked = state.find.subagents;
}

function renderFindCount() {
    const f = state.find;
    if (f.subsLoading) { dom.findCount.textContent = 'searching subagents…'; }
    else if (f.q.length < FIND_MIN) { dom.findCount.textContent = ''; }
    else if (!f.hits.length) { dom.findCount.textContent = 'No matches'; }
    else {
        const n = f.hits.length + (f.capped ? '+' : '');
        dom.findCount.textContent = f.at >= 0
            ? `${f.at + 1} of ${n}`
            : `${n} match${f.hits.length === 1 && !f.capped ? '' : 'es'}`;
    }
    const none = !f.hits.length;
    dom.findPrev.disabled = none;
    dom.findNext.disabled = none;
}

/**
 * Where a fresh query should land: the first match at or below the top of the
 * pane, so typing searches forward from what you are looking at rather than from
 * the top of a session you have scrolled a long way down.
 *
 * Nothing below the viewport means you are at the end of the transcript, and the
 * answer there is the first match — the same wrap stepping forward would do.
 */
export function hitFromHere() {
    const f = state.find;
    const view = activeView();
    const pane = view.isAgent ? state.agent : null;
    const rows = paintable(view, pane);
    if (!rows.length) return 0;

    const found = firstRowFrom(rows, view.scroll.getBoundingClientRect().top);
    if (found < 0) return 0;
    const want = rows[found].m;
    const i = f.hits.findIndex(h => h.evId === want.evId
        && (h.agentId || null) === (want.agentId || null));
    return i < 0 ? 0 : i;
}

export function stepFind(dir) {
    const f = state.find;
    if (!f.open) {
        // F3 from cold: pick the last search back up rather than only showing the
        // bar, which is what a repeat key is for.
        openFind();
        if (!f.open) return;
    } else if (f.dirty) {
        flushFind();
    }
    if (!f.hits.length) return;
    gotoHit(f.at < 0 ? (dir > 0 ? 0 : f.hits.length - 1) : f.at + dir);
}

/** Land on one hit: switch pane if it is elsewhere, open what is shut, scroll. */
export async function gotoHit(i) {
    const f = state.find;
    if (!f.hits.length) return;
    const n = ((i % f.hits.length) + f.hits.length) % f.hits.length;
    const h = f.hits[n];

    // A hit in another transcript. openAgent is the way in rather than a fetch of
    // our own: it also follows the agent's file and remembers the view.
    const want = h.agentId || null;
    if ((state.agent || null) !== want) {
        if (want) await openAgent(want);
        else closeAgent();
        if (!f.open) return;         // the switch closed us
    }
    f.at = n;

    const view = activeView();
    const entry = view.nodes.get(h.evId);
    if (!entry) { renderFindCount(); return; }

    // Materialize what the match is inside, and do it *now*. Assigning `open`
    // does fire the toggle listener renderTool leaves for this — but a
    // `<details>` queues that event as a task rather than dispatching it, so the
    // body would still be empty when the ranges are built four lines down. The
    // jump then landed on the row instead of on the match, and only a later
    // repaint filled it in. patchTool calls fillTool up front for the same
    // reason. Guarded on the kind because it is the tool renderer that leaves a
    // body empty; a thinking block and a subagent's result arrive with theirs
    // already built, and handing those toolBody's idea of themselves is wrong.
    const fold = entry.node.closest('.trun');
    if (fold) fold.open = true;
    for (const det of entry.node.querySelectorAll('details')) {
        if (entry.ev.kind === 'tool') fillTool(det, entry.ev);
        det.open = true;
    }

    const range = paintFind();
    // No flash when there is a range: the mark is the more precise answer, and a
    // whole row lighting up under it reads as two different claims. Without one,
    // the flash is all there is.
    revealNode(entry.node, { view, range, instant: true, flash: !range });
    renderFindCount();
}

// ── subagents ────────────────────────────────────────────────────────────

/**
 * Fetch the transcripts the toggle just asked for, once each.
 *
 * Rebuilt after every one rather than at the end, so the count climbs while they
 * arrive instead of appearing all at once. A subagent that will not load is
 * cached empty: asking again on every keystroke is worse than missing it.
 */
export async function loadFindSubs() {
    const f = state.find;
    const sessionId = state.current && state.current.sessionId;
    if (!sessionId) return;
    const rows = agentRows().filter(a => !f.subs.has(a.toolUseId));
    if (!rows.length) { markFindDirty(); return; }

    f.subsLoading = true;
    renderFindCount();
    for (const a of rows) {
        if (!f.subagents) break;
        try {
            const d = await get(`/api/sessions/${sessionId}/subagent`
                + `?toolUseId=${encodeURIComponent(a.toolUseId)}`);
            if (!state.current || state.current.sessionId !== sessionId) return;
            f.subs.set(a.toolUseId, foldResults(d.events || []));
        } catch {
            f.subs.set(a.toolUseId, []);
        }
        markFindDirty();
    }
    f.subsLoading = false;
    markFindDirty();
    renderFindCount();
}

/**
 * Merge tool results into their calls, the way appendEvents does on the way to
 * the screen.
 *
 * These events never get rendered, so nothing else would do it — and a result is
 * often the half worth searching: the stdout, the diff, the error.
 */
function foldResults(events) {
    const out = [];
    const byId = new Map();
    for (const ev of events) {
        if (ev.kind === 'suggestion') continue;
        if (ev.kind === 'tool-result') {
            const call = byId.get(ev.toolId);
            if (!call) continue;
            const { id, kind, toolId, ts, ...fields } = ev;
            Object.assign(call, fields);
            continue;
        }
        // A copy: these are the bridge's objects and the merge above writes to
        // them, and nothing here should be able to change what a later fetch of
        // the same subagent sees.
        const copy = { ...ev };
        out.push(copy);
        if (ev.kind === 'tool') byId.set(ev.id, copy);
    }
    return out;
}

/** Forget a session's indexed text. Another session's answers are not these. */
export function resetFind() {
    const f = state.find;
    closeFind();
    f.q = '';
    f.subagents = false;
    f.subs.clear();
    f.text.clear();
    f.subsLoading = false;
}
