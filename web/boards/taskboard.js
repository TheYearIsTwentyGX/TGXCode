// The task board, drawn with Preact. Everything outstanding, in four columns.
//
// The other three views each answer a narrower question and none of them
// answers this one. The rail is one conversation at a time. The live board is
// only what is running this second — a session that finished an hour ago has no
// card there and never will. A suggested follow-up used to be visible only while
// the conversation that raised it was open, which meant the app's own mechanism
// for handing work forward could only be read by going and looking for it.
//
// So: open tasks beside every un-archived session, grouped by what state it is
// in, with needs-you first because that is why you looked.
//
// **Nothing on it moves while you are reading.** This is the constraint that
// shapes the whole renderer, and it is the rail's rule for the rail's reason —
// see docs/manual.md, "The rail is sorted on load, and then left alone". A board of
// agents working would otherwise reshuffle every three seconds under the cursor
// of somebody trying to read one card. So position within a column is taken once
// and then held, and the only thing that moves a card is changing column, which
// is news rather than noise.
//
// **One payload for the whole board.** The `taskboard` SSE event, on a three-
// second tick the bridge only runs while somebody is watching, and only sends
// when the answer actually moved. Nothing here fetches per card.
//
// **Focus is the fifth state the board can be in**, and the only one the four
// columns cannot express. A backlog of suggested tasks outgrows its column long
// before any of the other three fills up — they are bounded by how many sessions
// exist, and that one is bounded by how many follow-ups every agent has ever
// raised. So the Suggested head carries a Focus button: press it and the other
// three columns go, and the tasks spread across the whole width one column per
// project, with a search box over them in the header.
//
// It borrows the drafts panel's machinery rather than growing its own, because
// that panel already answers the same question — a variable number of project
// columns built out of this board's `.tb-col` chrome. `tbFocusGroups` is
// `draftGroups` and `tbProjectColumn` is `draftColumn`; `.tb-body.cols` is
// `.dr-body.cols`. The one thing that is this board's and not that one's is that
// the rows still go through `tbHold` first, so a card cannot move under the
// cursor here either.
//
// **Why Preact.** Held order stopped cards *moving*; it did not stop them being
// *rebuilt*. Every push emptied #tb-body and built four columns again, so a click
// whose mousedown and mouseup straddled a push was lost, hover blinked off, and
// each column's scroll had to be photographed and put back. Keyed reconciliation
// — a column by its state or its project, a card by session or task id — keeps
// every node that did not change, and with it hover, focus and scroll. The held
// order is untouched by this: `tbHold` still decides where each card sits, and
// Preact only makes sure the card that sits there is the same node it was.
//
// Opening and closing the panel (`showTaskboard`), the watch flag the stream's
// `hello` re-subscribes with (`syncTaskboardWatch`) and the badge stay in
// app.js's `// ── task board ──`, beside the other panels. Markup and class names
// are what the imperative version built, so web/styles.css did not change.
//
// This imports from app.js, which imports this — safe because nothing here reads
// an app.js binding at module top level, only when a function is called.

import { html } from '../vendor/preact.js';
import { get } from '../api.js';
import { state } from '../state.js';
import { dom, toast } from '../dom.js';
import { ago, clip } from '../format.js';
import {
    paintTaskboardBadge, projectColor, setFlags, showTaskboard,
} from '../app.js';
import { openSession } from '../transcript/conversation.js';
import {
    actOnSuggestion, firstLine, openTaskDialog, startSuggestion,
} from '../transcript/suggestions.js';
import { toolSummary } from '../transcript/tools.js';
import { openNew } from '../new-session/dialog.js';
import {
    icon, liveStatusWords, paint, queuedBadge, StopButton, taskBar,
} from './parts.js';

/** Is the board both open and not covered by something else? */
export const taskboardVisible = () => state.taskboard.open;

/**
 * A payload arriving, from the stream or from a fetch.
 *
 * The badge is kept up to date whether or not the board is open — the same
 * bargain the live board strikes — but the drawing only happens when there is
 * something to draw on.
 */
export function applyTaskboard(data, { all = false } = {}) {
    state.taskboard.data = data;
    state.taskboard.at = Date.now();
    state.taskboard.error = null;
    tbRememberOrder(data, all);
    paintTaskboardBadge();
    if (taskboardVisible()) renderTaskboard();
}

/**
 * Fetch the board once.
 *
 * Three callers, all of them one-offs: the Refresh button, a window opening the
 * board before its stream is up, and the Show-all button — which is the only one
 * that passes `all`, and the only reason this takes an argument at all. The
 * steady state is the push.
 */
export async function loadTaskboard({ all = false } = {}) {
    if (state.taskboard.loading) return;
    state.taskboard.loading = true;
    if (taskboardVisible()) renderTaskboard();
    try {
        const data = await get(`/api/taskboard${all ? '?idle=all' : ''}`);
        // Held apart from the pushed payload rather than merged into it: the
        // push never carries the older idle sessions, so merging would have them
        // vanish again three seconds later.
        if (all) state.taskboard.allIdle = data.idle;
        state.taskboard.loading = false;
        applyTaskboard(data, { all });
    } catch (err) {
        state.taskboard.loading = false;
        state.taskboard.error = err.message;
        if (taskboardVisible()) renderTaskboard();
    }
}

// ── holding the order ────────────────────────────────────────────────────
//
// The rail's mechanism (`rememberOrder`, and the comment on it), applied per
// column. Ranks from the first load count up from zero in the order the bridge
// sent them; anything first seen after that takes a negative rank, so it lands at
// the top of its column without moving anything already placed.
//
// **Keyed by column as well as by id**, which is what makes a session changing
// state the one thing that can move a card. Its key in the new column has never
// been seen, so it goes to the top of it — a session that has just become
// blocked on you appearing at the top of *Needs you* is exactly the behaviour
// wanted — while every card that did not change state keeps the rank it had.
//
// The old key is left behind rather than swept up. It is a few bytes per column
// per session, it costs nothing, and clearing it would mean a session that goes
// working → idle → working comes back at the top of *Working* having never left
// the board, which reads as a new session when it is not.
//
// None of this changed with the move to Preact. The Preact keys below are the
// session or task id alone, not this column-qualified key: a card that changes
// column is a different place on the board, and it is fine — right, even — for
// it to be a new node there.

const tbKey = (col, id) => `${col}:${id}`;

export function tbRememberOrder(data, all = false) {
    const first = state.taskboard.order.size === 0;
    const rows = [
        ...data.needs.map(c => tbKey('needs', c.sessionId)),
        ...data.working.map(c => tbKey('working', c.sessionId)),
        ...data.suggested.map(t => tbKey('task', t.id)),
        // Not on an `?idle=all` answer: `data.idle` is then every un-archived
        // session rather than today's, and putting all of it through the rule
        // below would rank the whole history as newly arrived and stand the
        // column on its head. The tail loop underneath is where those belong,
        // and the ones already placed are skipped there by id.
        ...(all ? [] : data.idle.map(c => tbKey('idle', c.sessionId))),
    ];
    for (const key of rows) {
        if (state.taskboard.order.has(key)) continue;
        state.taskboard.order.set(key,
            first ? state.taskboard.order.size : --state.taskboard.freshRank);
    }

    // Show-all is the exception, and it has to be, because it is the one thing
    // that adds rows which are *older* than everything already placed. Given the
    // rule above they would each be "new", take a negative rank, and land above
    // today's sessions — the column inverted, oldest first, and then held that
    // way. So they count up from the high-water mark instead, which puts them
    // under what is already there, in the order the bridge sent them.
    for (const c of state.taskboard.allIdle || []) {
        const key = tbKey('idle', c.sessionId);
        if (state.taskboard.order.has(key)) continue;
        // Above every rank handed out so far, whichever branch handed it out:
        // `order.size` counts the negative ranks too, so it is a high-water mark
        // that only ever rises, and taking the max of the two keeps this
        // monotonic across several presses.
        state.taskboard.tailRank =
            Math.max(state.taskboard.tailRank, state.taskboard.order.size);
        state.taskboard.order.set(key, state.taskboard.tailRank++);
    }
}

const tbRankOf = (col, id) => state.taskboard.order.get(tbKey(col, id)) ?? 0;

/** One column's rows, in the order they were first placed in. */
function tbHold(col, rows, idOf) {
    return [...rows].sort((a, b) => tbRankOf(col, idOf(a)) - tbRankOf(col, idOf(b)));
}

// ── drawing it ───────────────────────────────────────────────────────────

const TB_COLUMNS = [
    { key: 'needs', label: 'Needs you', empty: 'Nothing is blocked on you.' },
    { key: 'working', label: 'Working', empty: 'Nothing is running.' },
    { key: 'suggested', label: 'Suggested', empty: 'No open tasks.' },
    { key: 'idle', label: 'Idle', empty: 'Nothing here.' },
];

export function renderTaskboard() {
    const d = state.taskboard.data;

    dom.tbRefresh.disabled = state.taskboard.loading;
    dom.tbRefresh.textContent = state.taskboard.loading ? 'Reading…' : 'Refresh';

    if (state.taskboard.error) {
        dom.tbBody.classList.remove('cols');
        paint(dom.tbBody, html`<div key="error" class="tb-note"><p>${
            `Could not read the board. ${state.taskboard.error}`}</p></div>`);
        return;
    }
    if (!d) {
        dom.tbBody.classList.remove('cols');
        paint(dom.tbBody, html`<div key="wait" class="tb-note"><p>Reading every session…</p></div>`);
        return;
    }

    const focused = state.taskboard.focus;
    const groups = focused ? tbFocusGroups(d) : null;
    const shown = focused
        ? [...groups.values()].reduce((n, rows) => n + rows.length, 0) : 0;
    const cols = !focused ? TB_COLUMNS.map(c => tbColumn(c, d))
        : groups.size ? [...groups].map(([name, rows]) => tbProjectColumn(name, rows))
            : [tbFocusNote(d)];
    // A note is one wide block and not a row of columns, so it keeps the plain
    // grid — otherwise it would sit in a 300px lane with the rest of the board
    // blank beside it. The container is web/index.html's, not Preact's, so its
    // class is still set by hand.
    dom.tbBody.classList.toggle('cols', focused && groups.size > 0);

    dom.tbSub.textContent = focused ? tbFocusWords(d, groups.size, shown) : [
        `${d.counts.needs} blocked on you`,
        `${d.counts.working} working`,
        `${d.counts.suggested} open ${d.counts.suggested === 1 ? 'task' : 'tasks'}`,
        `${d.counts.idle} idle`,
    ].join(' · ');

    // Each column scrolls on its own. Keyed columns keep their nodes, and so
    // their scroll, across an ordinary push; this is the backstop for the passes
    // that replace a column — focus coming on or off. Keyed by whichever of the
    // two things a column is — a state unfocused, a project focused — so that a
    // column keeps its own place in its own list rather than the neighbour's.
    const scrolls = new Map();
    for (const c of dom.tbBody.querySelectorAll('.tb-col-body')) {
        scrolls.set(c.dataset.col || c.dataset.project, c.scrollTop);
    }
    const bodyScroll = dom.tbBody.scrollLeft;

    // Somebody typing a task into the box at the foot of the Suggested column
    // must not have it pulled out from under them mid-word. The text itself is in
    // `state.taskboard.draft`, which the box writes on every keystroke, and the
    // box keeps its node across a push; this puts the focus and the caret back
    // in the rare pass where it does not.
    const active = document.activeElement;
    const typing = active && active.classList.contains('tb-new-box')
        ? { at: active.selectionStart, to: active.selectionEnd }
        : null;

    paint(dom.tbBody, cols);

    for (const c of dom.tbBody.querySelectorAll('.tb-col-body')) {
        const key = c.dataset.col || c.dataset.project;
        if (scrolls.has(key) && c.scrollTop !== scrolls.get(key)) c.scrollTop = scrolls.get(key);
    }
    if (dom.tbBody.scrollLeft !== bodyScroll) dom.tbBody.scrollLeft = bodyScroll;

    if (typing && document.activeElement !== active) {
        const box = dom.tbBody.querySelector('.tb-new-box');
        if (box) {
            box.focus({ preventScroll: true });
            box.setSelectionRange(typing.at, typing.to);
        }
    }
}

function tbColumn(col, d) {
    const cards = col.key === 'suggested'
        ? tbTaskCards(d)
        : tbSessionCards(col.key, d);

    // The Focus button is the way in to the focused view, and the only one. The
    // way out is the button in the board's header, because by then this column
    // no longer exists to hold a second copy of it. Not `aria-pressed`: it is not
    // a switch that stays here and lights up. Pressing it replaces the view this
    // button is part of, and the way back is the header's.
    return html`
        <section key=${`col:${col.key}`} class="tb-col" data-col=${col.key}>
            <header class="tb-col-head">
                <h2>${col.label}</h2>
                <span class="tb-count">${String(d.counts[col.key])}</span>
                ${col.key === 'suggested' ? html`<button class="tb-focus-btn" type="button"
                    title="Suggested tasks only, one column per project"
                    onClick=${() => tbSetFocus(true)}>Focus</button>` : null}
            </header>
            <div class="tb-col-body" data-col=${col.key}>
                ${cards.length ? cards : html`<p key="empty" class="tb-empty">${col.empty}</p>`}
                ${col.key === 'idle' ? tbShowAll(d) : null}
                ${col.key === 'suggested' ? tbComposer() : null}
            </div>
        </section>`;
}

/**
 * The session columns.
 *
 * Idle is the one with a tail. When Show-all has been pressed, the older
 * sessions it fetched are drawn under the ones the push keeps current — filtered
 * against the two live columns, because a session that has started working since
 * that fetch is on the board twice otherwise, once truthfully and once as a
 * stale copy of itself.
 */
function tbSessionCards(key, d) {
    let rows = d[key];
    if (key === 'idle' && state.taskboard.allIdle) {
        const elsewhere = new Set([...d.needs, ...d.working].map(c => c.sessionId));
        const fresh = new Set(d.idle.map(c => c.sessionId));
        rows = [...d.idle, ...state.taskboard.allIdle.filter(
            c => !fresh.has(c.sessionId) && !elsewhere.has(c.sessionId))];
    }
    return tbHold(key, rows, c => c.sessionId).map(c => tbSessionCard(c));
}

/** Tasks, grouped by the project they were raised in, as the rail groups rows. */
function tbTaskCards(d) {
    const held = tbHold('task', d.suggested, t => t.id);

    const groups = new Map();
    for (const t of held) {
        const name = (t.session && t.session.projectName) || 'Elsewhere';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(t);
    }
    // One heading over the whole column says nothing. Grouping earns its keep
    // only once there is more than one group to tell apart.
    if (groups.size < 2) return held.map(tbTaskCard);

    const out = [];
    for (const [name, rows] of groups) {
        out.push(html`<h3 key=${`head:${name}`} class="tb-sub-head">${name}<span>${String(rows.length)}</span></h3>`);
        out.push(...rows.map(tbTaskCard));
    }
    return out;
}

// ── the focused view ─────────────────────────────────────────────────────

/** Turn the focused view on or off, and remember which. */
export function tbSetFocus(on) {
    state.taskboard.focus = on;
    localStorage.setItem('tbFocus', on ? '1' : '0');
    if (!on) {
        // The box goes away with the view, so a query left behind in it would
        // be invisible and still filtering the next time focus came on.
        state.taskboard.query = '';
        dom.tbSearch.value = '';
    }
    tbPaintTools();
    renderTaskboard();
    if (on) dom.tbSearch.focus({ preventScroll: true });
}

/** The header controls that belong to the focused view. */
export function tbPaintTools() {
    const on = state.taskboard.focus;
    dom.tbSearch.hidden = !on;
    dom.tbUnfocus.hidden = !on;
}

/**
 * Does a task match what is in the search box?
 *
 * Every word has to appear somewhere, rather than any of them, so that a second
 * word narrows the board instead of widening it — which is what you reach for
 * when the first one still left forty cards. The prompt is searched as well as
 * the title because a task raised without a title is titled by its first line,
 * and the sentence you remember is usually further in than that. The
 * conversation's own title is in there too: "the one from the schedule work" is
 * how you look for a task you did not read at the time.
 */
function tbMatches(t) {
    const q = state.taskboard.query.trim().toLowerCase();
    if (!q) return true;
    const hay = [t.title, t.prompt, t.why, t.session && t.session.title]
        .filter(Boolean).join('\n').toLowerCase();
    return q.split(/\s+/).every(word => hay.includes(word));
}

/**
 * The open tasks, filtered, as one group per project.
 *
 * `tbHold` first and the filter second, so the search narrows an order that has
 * already been settled rather than deciding one of its own — a card keeps its
 * place in its column as words are typed and deleted.
 *
 * **The order of the keys is the order of the columns, and it needs no sort.**
 * `draftGroups` explains this at length and it is the same argument: the held
 * rows are newest-first, a Map keeps the order its keys were first seen in, so
 * walking them once lands the projects most-recently-suggested-in first. Held
 * thereafter, like everything else on this board.
 *
 * Grouped by `session.projectName` — the key the sub-headings in the unfocused
 * column already use — rather than by worktree, so that every task raised in a
 * repo arrives in one column instead of being scattered across however many
 * worktrees of it are live. The worktree is still on each card.
 */
function tbFocusGroups(d) {
    const groups = new Map();
    for (const t of tbHold('task', d.suggested, x => x.id)) {
        if (!tbMatches(t)) continue;
        const name = (t.session && t.session.projectName) || 'Elsewhere';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(t);
    }
    return groups;
}

/**
 * One project, as a column.
 *
 * `draftColumn`'s shape, for `draftColumn`'s reason: the chrome is this board's
 * already. No `data-col`, deliberately — that attribute colours a *state*, and
 * a project is not one. The cards keep `.tb-task`'s own stripe, which still says
 * the right thing.
 *
 * The head takes the project's own colour where it has one, on the argument
 * draftColumn spells out: a colour chosen for a project is not one this board
 * invented. `Elsewhere` is the group for tasks with no session behind them, and
 * it resolves to no directory and therefore no colour, which is right.
 */
function tbProjectColumn(name, rows) {
    const from = rows[0] && rows[0].session;
    const accent = projectColor((from && (from.projectCwd || from.cwd)) || '');
    return html`
        <section key=${`project:${name}`} class="tb-col tb-focus-col" data-project=${name}
            data-tinted=${accent ? '1' : null}
            style=${accent ? `--proj-accent: ${accent}` : null}>
            <header class="tb-col-head">
                <h2 title=${name}>${name}</h2>
                <span class="tb-count">${String(rows.length)}</span>
            </header>
            <div class="tb-col-body" data-project=${name}>${rows.map(tbTaskCard)}</div>
        </section>`;
}

/** Nothing to show: an empty board and a search that found nothing differ. */
function tbFocusNote(d) {
    const q = state.taskboard.query.trim();
    if (q) {
        return html`<div key="note" class="tb-note">
            <p>${`No task matches “${q}”.`}</p>
            <p class="dim">${`${d.counts.suggested} open `
                + `${d.counts.suggested === 1 ? 'task is' : 'tasks are'} hidden by it.`}</p>
        </div>`;
    }
    return html`<div key="note" class="tb-note">
        <p>No open tasks.</p>
        <p class="dim">${'Suggested tasks are raised by agents as they '
            + 'work, for the things they noticed and did not do.'}</p>
    </div>`;
}

/** The subtitle, focused. */
function tbFocusWords(d, projects, shown) {
    const total = d.counts.suggested;
    const where = `${projects} ${projects === 1 ? 'project' : 'projects'}`;
    if (state.taskboard.query.trim()) {
        return `${shown} of ${total} matching “${state.taskboard.query.trim()}”`
            + (projects ? ` · ${where}` : '');
    }
    return `${total} open ${total === 1 ? 'task' : 'tasks'}`
        + (projects ? ` · ${where}` : '');
}

/**
 * A suggested task, as a card.
 *
 * Every button on it is the one the tasks panel beside a transcript already
 * uses — `startSuggestion`, `openTaskDialog`, `actOnSuggestion` — because a task
 * started from here and a task started from there must do the same thing, and
 * two code paths for one gesture is how they stop doing it.
 *
 * The `tb-from` line is where it came from. The point of the column is that
 * this is a task from a conversation you are not in, so saying which one is not
 * decoration — it is how you judge the offer.
 */
function tbTaskCard(t) {
    const where = t.session || {};
    return html`
        <article key=${`task:${t.id}`} class="tb-card tb-task" data-archived=${String(!!t.archived)}
            onClick=${(e) => { if (tbCardClickOpens(e)) openTaskDialog(t); }}>
            <header class="tb-card-head">
                <span class="tb-dot"></span>
                <button class="tb-card-title" type="button" title="Read this at full width"
                    onClick=${() => openTaskDialog(t)}>${t.title || firstLine(t.prompt)}</button>
            </header>
            <div class="tb-card-meta">
                <span>Suggested</span>
                <span class="dot">·</span>
                <span>${where.worktree ? where.worktree.name : (where.projectName || 'unknown')}</span>
                <span class="dot">·</span>
                <span title=${t.ts || ''}>${ago(t.ts)}</span>
            </div>
            <div class="tb-from">
                <button class="linky" type="button" title="Open the conversation that raised this"
                    onClick=${() => { showTaskboard(false); openSession(t.sessionId); }}
                    >${clip(where.title || 'a conversation', 44)}</button>
                ${t.archived ? html`<span class="tb-tag">archived</span>` : null}
                ${(t.session && t.session.test) ? html`<span class="tb-tag">test</span>` : null}
            </div>
            <div class="tb-acts">
                <button class="tb-btn primary" type="button"
                    onClick=${(e) => tbStartTask(t, e.currentTarget)}>Start</button>
                <button class="tb-btn" type="button" onClick=${() => openTaskDialog(t)}>View task</button>
                <button class="tb-btn quiet" type="button" title="Not this one"
                    onClick=${() => tbDecide(t, 'dismissed')}>Dismiss</button>
            </div>
        </article>`;
}

/**
 * A session, as a card.
 *
 * Deliberately the live board's vocabulary — `liveStatusWords`, `ASK_WORD`,
 * `taskBar`, `ago`, all in web/boards/parts.js — rather than a second set of
 * words for the same states. A session that says "Waiting for permission" on one
 * board and something else on the other is two boards disagreeing about one fact.
 *
 * Three choices below that read as omissions. An idle card has no status line:
 * it has no runner to report an activity and no task list asked for, so
 * `liveStatusWords` can only say "Idle" — under a column heading that already
 * says it, to fifty-odd cards at once. An ask is said rather than answered:
 * answering one from a tile is the live board's job and it does it well; this
 * board is the map, and two places to approve the same thing is one too many.
 * And the Open button is filled only where the card is asking for something: a
 * column of fifty idle sessions each with a bright button is a wall that says
 * nothing about which of them matters.
 */
function tbSessionCard(s) {
    const r = s.runner;
    const busy = r && (r.state === 'busy' || r.state === 'starting');
    const away = s.live && s.live.running && !r;

    return html`
        <article key=${`session:${s.sessionId}`} class="tb-card tb-session" data-col=${s.column} data-id=${s.sessionId}
            onClick=${(e) => { if (tbCardClickOpens(e)) tbOpen(s.sessionId); }}>
            <header class="tb-card-head">
                <span class="tb-dot"></span>
                <button class="tb-card-title" type="button" title="Open this conversation"
                    onClick=${() => tbOpen(s.sessionId)}>${s.title}</button>
                <button class="mini" type="button" title="Archive"
                    onClick=${(e) => { e.stopPropagation(); tbArchive(s); }}>${icon('archive')}</button>
            </header>
            <div class="tb-card-meta">
                ${s.pinned ? html`<span class="tag-pin" title="Pinned">${icon('pin', 11)}</span>` : null}
                ${s.test ? html`<span class="tag-test">test</span>` : null}
                <span>${s.worktree ? s.worktree.name : s.projectName}</span>
                <span class="dot">·</span>
                <span title=${s.lastTs || ''}>${ago(s.lastTs)}</span>
                <span class="dot">·</span>
                <span>${`${s.userMessages} ${s.userMessages === 1 ? 'turn' : 'turns'}`}</span>
                ${(r && r.queued) ? queuedBadge(r.queued) : null}
            </div>
            ${s.column === 'idle' ? null
                : html`<div class="tb-card-line">${liveStatusWords(s, busy, away)}</div>`}
            ${s.tasks ? taskBar(s.tasks) : null}
            ${s.tasks ? html`<div class="tb-card-meta"><span>${
                `${s.tasks.done} of ${s.tasks.total} tasks`}</span></div>` : null}
            ${s.ask ? html`<p class="tb-ask">${tbAskWords(s.ask)}</p>` : null}
            <div class="tb-acts">
                <button class=${s.ask ? 'tb-btn primary' : 'tb-btn'} type="button"
                    onClick=${() => tbOpen(s.sessionId)}>${s.ask ? 'Answer it' : 'Open'}</button>
                ${busy ? html`<${StopButton} cls="tb-btn" sessionId=${s.sessionId}
                    reset=${state.taskboard.at} />` : null}
            </div>
        </article>`;
}

/** What the session is blocked on, in one line. */
function tbAskWords(ask) {
    if (ask.kind === 'plan') return 'A plan is waiting to be approved.';
    if (ask.kind === 'question') return 'It asked you a question.';
    const what = toolSummary({ name: ask.tool, input: ask.input }) || ask.displayName;
    return `Wants to run ${clip(what, 60)}`;
}

/**
 * The same rule the live board uses: a click on a control is not "take me there".
 * The drafts and schedules panels (web/drafts.js, web/schedules.js) use it too.
 */
export function tbCardClickOpens(e) {
    if (e.target.closest('button, a, input, textarea, select, label')) return false;
    const picked = window.getSelection();
    return !(picked && picked.type === 'Range' && String(picked).trim());
}

/** Leaving the board for a conversation, which is what every card offers. */
function tbOpen(sessionId) {
    showTaskboard(false);
    openSession(sessionId);
}

/** The rest of the idle sessions, once, behind a button. */
function tbShowAll(d) {
    if (state.taskboard.allIdle) return null;
    if (!d.idleHidden) return null;
    return html`
        <div key="more" class="tb-more">
            <button class="tb-btn" type="button"
                onClick=${() => loadTaskboard({ all: true })}>${`Show all ${d.counts.idle}`}</button>
            <p>${`${d.idleHidden} older ${d.idleHidden === 1 ? 'session' : 'sessions'} `
                + 'are not shown. The column leads with what has moved today.'}</p>
        </div>`;
}

/**
 * A line at the foot of the Suggested column for a task of your own.
 *
 * It opens the ordinary new-session dialog with what you typed already in it,
 * rather than starting anything: a task typed into a one-line box has had no
 * directory chosen for it, and guessing one is how a session ends up running in
 * the wrong checkout.
 *
 * The box is controlled by `state.taskboard.draft`, which every keystroke
 * writes, so a push mid-word passes the value the box already has and Preact
 * leaves it and its caret alone.
 */
function tbComposer() {
    const go = () => {
        const text = state.taskboard.draft.trim();
        if (!text) return;
        state.taskboard.draft = '';
        showTaskboard(false);
        openNew({ prompt: text });
    };
    return html`
        <div key="new" class="tb-new">
            <input class="tb-new-box" type="text" placeholder="Start a task…"
                value=${state.taskboard.draft}
                onInput=${(e) => { state.taskboard.draft = e.currentTarget.value; }}
                onKeyDown=${(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    go();
                }} />
            <button class="tb-btn" type="button" onClick=${go}>Start</button>
        </div>`;
}

// ── acting on a card ─────────────────────────────────────────────────────
//
// Every one of these goes through the function the rest of the app already uses
// and then takes the card off the board itself. The push would do it within
// three seconds, but three seconds of a button that visibly did nothing is how a
// board teaches you to click twice.

async function tbStartTask(t, btn) {
    tbDropTask(t.id);
    // The card, and the button with it, is gone from the board by now: render is
    // synchronous. startSuggestion's writes to `btn` land on a detached node,
    // which is what they did when the board was built by hand as well.
    await startSuggestion(t, btn);
}

async function tbDecide(t, status) {
    tbDropTask(t.id);
    await actOnSuggestion(t, status);
}

/**
 * Take one task off the board now.
 *
 * The column is open tasks only, so any decision removes it. Not rolled back on
 * failure: `actOnSuggestion` rolls back its own state and says so in a toast, and
 * the next push puts the row back where it belongs a moment later — which is
 * more honest than this guessing at which of the two it was.
 */
function tbDropTask(id) {
    const d = state.taskboard.data;
    if (!d) return;
    const before = d.suggested.length;
    d.suggested = d.suggested.filter(t => t.id !== id);
    if (d.suggested.length !== before) d.counts.suggested -= 1;
    if (taskboardVisible()) renderTaskboard();
}

function tbArchive(s) {
    const d = state.taskboard.data;
    if (d) {
        for (const key of ['needs', 'working', 'idle']) {
            const before = d[key].length;
            d[key] = d[key].filter(c => c.sessionId !== s.sessionId);
            if (d[key].length !== before) d.counts[key] -= 1;
        }
        if (state.taskboard.allIdle) {
            state.taskboard.allIdle =
                state.taskboard.allIdle.filter(c => c.sessionId !== s.sessionId);
        }
        if (taskboardVisible()) renderTaskboard();
    }
    setFlags(s, { archived: true });
    toast(`Archived “${clip(s.title, 40)}”.`, 'ok');
}
