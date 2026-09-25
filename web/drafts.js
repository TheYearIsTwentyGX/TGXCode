// The drafts panel: sessions set up but not started, drawn with Preact.
//
// Every other screen in this app is a view over something that already happened:
// a transcript, a running process, a task an agent raised, a notification that
// was sent. This one is the only one about work that has not begun — which is why
// it is a panel rather than a fifth column on the task board, and why the bridge
// keeps a file for it instead of deriving it from anything.
//
// **A draft is a whole create call, held back.** Not a note about a session: the
// same working directory, first message, model and permission mode that
// `POST /api/sessions` takes, validated the same way when it is saved, so
// pressing Start cannot fail for any reason you could have been told about
// earlier. That is also why there is no second form — the Start-a-session dialog
// already collects exactly these fields, so it grew a third and a fourth: Save as
// draft, and Schedule.
//
// **Nothing here moves on its own**, so none of the two boards' machinery is
// needed: no watcher-gated tick to subscribe to, and no `tbRememberOrder` ranks
// to stop a card sliding out from under the cursor. The bridge pushes the whole
// list on `drafts-changed` whenever somebody changes something, and this draws it
// in the order it arrived — newest-edited first.
//
// **The board is a column per project once there are two**, which is the task
// board's shape borrowed for a different question. Over there a column is a
// state; here it is a place, and the order of the columns is which project you
// touched last. It costs no sort — see `draftGroups` — and below two projects it
// stays the single readable column it has always been, because a column with
// nothing to be told apart from is just a narrower list.
//
// **Why Preact.** The push lands whenever any window edits a draft, and the
// hand-built version answered it by emptying `#dr-body` and building every card
// again — so a click whose mousedown and mouseup straddled a push never fired,
// and each column's scroll had to be photographed and put back. Cards are keyed
// by draft id and columns by project, which keeps their nodes (and hover, scroll
// and a Start button's "Starting") across a push. Written the way web/rail.js
// settled: htm templates, no build step, no hand edits to nodes Preact owns.
// Markup and class names are what the imperative version built, so
// web/styles.css did not change.
//
// Opening and closing the panel stays here too, beside what it draws; the
// shared panel plumbing (`closeOtherPanels`, `paintPanels`) is still app.js's.
// This imports from app.js, which imports this — safe because nothing here
// reads an imported binding at module top level, only when a function runs.

import { html, useState } from './vendor/preact.js';
import { del, get, post } from './api.js';
import { state } from './state.js';
import { dom, toast } from './dom.js';
import { ago, hourOpts } from './format.js';
import * as keys from './keys.js';
import {
    closeOtherPanels, paintPanels, projectColor, rememberView, syncBoardWatch,
    syncTaskboardWatch,
} from './app.js';
import { paint } from './boards/parts.js';
import { renderLive } from './boards/live.js';
import { tbCardClickOpens } from './boards/taskboard.js';
import { openNew } from './new-session/dialog.js';
import { termPane } from './term-pane.js';
import { openSessionSoon } from './transcript/conversation.js';
import { firstLine } from './transcript/suggestions.js';
import { clipLines } from './transcript/turn-rail.js';

export function showDrafts(on) {
    state.drafts.open = on;
    if (on) closeOtherPanels('drafts');
    paintPanels();
    syncBoardWatch();
    // This panel has no watch of its own — the push is unconditional — but it
    // *closes* the task board, and the board's ~3s `taskboard.build` on the bridge
    // only stops when somebody says they have stopped watching. Leaving this out
    // let that tick run for the rest of the session.
    syncTaskboardWatch();

    if (on) {
        // Draw whatever is already held so the panel is never briefly empty, and
        // fetch behind it. Unlike the two boards there is no subscribe to wait
        // on: the push is unconditional, so a fetch is only needed for a window
        // that has not had one yet.
        renderDrafts();
        if (!state.drafts.at) loadDrafts();
    } else if (state.live.open) {
        // The live board was left switched on underneath and has been ignoring
        // its pushes; catch it up before it comes back into view.
        renderLive();
        if (state.current) termPane.refit();
    } else if (state.current) {
        termPane.refit();
    }
    rememberView();
}

export const draftsVisible = () => state.drafts.open;

/**
 * A payload arriving, from the stream or from a fetch.
 *
 * The badge is kept current whether or not the panel is open, the same bargain
 * the other boards strike — and here it costs nothing, because the push is not
 * gated on anybody watching.
 */
export function applyDrafts(data) {
    state.drafts.rows = data.drafts || [];
    state.drafts.at = data.at || Date.now();
    state.drafts.error = null;
    paintDraftsBadge();
    if (draftsVisible()) renderDrafts();
}

export async function loadDrafts() {
    if (state.drafts.loading) return;
    state.drafts.loading = true;
    try {
        const data = await get('/api/drafts');
        state.drafts.loading = false;
        applyDrafts(data);
    } catch (err) {
        state.drafts.loading = false;
        state.drafts.error = err.message;
        if (draftsVisible()) renderDrafts();
    }
}

/**
 * How many drafts are waiting, on the button that opens the panel.
 *
 * Fed straight from the rows, unlike the task board's badge — which has to come
 * from `state.waiting` because its payload only arrives while it is being
 * watched. This payload always arrives, so the simple thing is also the correct
 * one.
 *
 * Never `urgent`: a draft is the one thing in this app that is explicitly not
 * asking for attention, and colouring it red would be arguing with the reason it
 * exists.
 */
export function paintDraftsBadge() {
    const n = state.drafts.rows.length;
    dom.drBadge.hidden = !n;
    dom.drBadge.textContent = String(n);
    dom.btnDrafts.title = keys.hint(n
        ? `${n} draft${n === 1 ? '' : 's'} waiting to be started`
        : 'Sessions set up but not started', 'view.drafts');
}

// ── drawing it ───────────────────────────────────────────────────────────

export function renderDrafts() {
    const rows = state.drafts.rows;
    const groups = draftGroups(rows);
    // One project is one column, which is a column that says nothing — the same
    // threshold the sub-headings used to use, now deciding the whole layout.
    // Below it the panel stays the readable single column it has always been; at
    // two it becomes the task board's shape.
    const cols = groups.size >= 2;

    dom.drSub.textContent = !rows.length
        ? 'Sessions you have set up but not started.'
        : cols
            ? `${rows.length} drafts across ${groups.size} projects, newest edit first.`
            : `${rows.length} ${rows.length === 1 ? 'draft' : 'drafts'}, newest edit first.`;

    // The container is web/index.html's, not Preact's, so its class is still set
    // by hand — the task board's arrangement.
    dom.drBody.classList.toggle('cols', !state.drafts.error && rows.length > 0 && cols);

    if (state.drafts.error) {
        paint(dom.drBody, html`<div key="error" class="dr-note">
            <p>${`Could not read the drafts. ${state.drafts.error}`}</p></div>`);
        return;
    }

    if (!rows.length) {
        paint(dom.drBody, html`<div key="empty" class="dr-note">
            <p>Nothing set up yet.</p>
            <p class="dim">${'A draft is a session with its directory, first '
                + 'message, model and permissions already chosen — for work that is '
                + 'ready to go but blocked on something else.'}</p>
            <button class="tb-btn primary" type="button" onClick=${() => openNew()}>New draft</button>
        </div>`);
        return;
    }

    // Keyed nodes keep their scroll across an ordinary push. This is the backstop
    // for the passes that replace them — one project becoming two, say — keyed
    // by project rather than by position, so a column that has just moved left
    // keeps its own place in its own list rather than inheriting the neighbour's.
    const scrolls = new Map();
    for (const c of dom.drBody.querySelectorAll('.tb-col-body')) {
        scrolls.set(c.dataset.project, c.scrollTop);
    }
    const down = dom.drBody.scrollTop;
    const across = dom.drBody.scrollLeft;

    paint(dom.drBody, cols
        ? [...groups].map(([name, list]) => draftColumn(name, list))
        : rows.map(d => html`<${DraftCard} key=${d.id} d=${d} />`));

    for (const c of dom.drBody.querySelectorAll('.tb-col-body')) {
        const was = scrolls.get(c.dataset.project);
        if (was !== undefined && c.scrollTop !== was) c.scrollTop = was;
    }
    if (dom.drBody.scrollTop !== down) dom.drBody.scrollTop = down;
    if (dom.drBody.scrollLeft !== across) dom.drBody.scrollLeft = across;
}

/**
 * The drafts, by project.
 *
 * **The order of the keys is the order of the columns, and it needs no sort.**
 * The bridge hands the rows over newest-`updatedAt` first, and `updatedAt` moves
 * on a create as well as on an edit — so the first row of a project is its most
 * recently touched draft, and a Map keeps the order its keys were first seen in.
 * Walking the rows once therefore lands the projects in exactly the order the
 * board wants them: most recently added-or-edited first. Quietly load-bearing,
 * which is why it is written down here rather than left to be rediscovered — an
 * object keyed by name would not hold it, and neither would a second pass that
 * sorted the groups by anything else.
 *
 * `projectName` comes off the payload rather than being derived here, so every
 * client agrees about which project a directory belongs to.
 */
function draftGroups(rows) {
    const groups = new Map();
    for (const d of rows) {
        const name = d.projectName || 'unknown';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(d);
    }
    return groups;
}

/**
 * One project, as a column.
 *
 * The task board's own chrome — `tb-col`, `tb-col-head`, `tb-count`,
 * `tb-col-body` — rather than a second set of styles for a shape that already
 * exists, which is the borrowing `DraftCard` below already does with `tb-card`.
 *
 * What differs is what a column *means*. Over there it is a state, and the
 * colour says which one; here it is a project. So no `data-col` — that attribute
 * is what colours a state, and a project is not one — and the cards keep
 * `.dr-card`'s quiet stripe, which is still the right one: a draft is the thing
 * in this app that is explicitly not asking for anything.
 *
 * The head *does* carry a colour now, and the two are not in tension. The rule
 * was never that a project has no colour; it was that this board must not invent
 * one, because an invented colour claims a meaning it cannot deliver. A colour
 * somebody chose for the project is not an invention, and it says the only thing
 * a project's colour ever says: which project. Absent for every project nobody
 * has coloured, which is most of them.
 */
function draftColumn(name, list) {
    const accent = projectColor((list[0] && list[0].cwd) || '');
    return html`
        <section key=${`project:${name}`} class="tb-col dr-col" data-project=${name}
            data-tinted=${accent ? '1' : null}
            style=${accent ? `--proj-accent: ${accent}` : null}>
            <header class="tb-col-head">
                <h2 title=${name}>${name}</h2>
                <span class="tb-count">${String(list.length)}</span>
            </header>
            <div class="tb-col-body" data-project=${name}>
                ${list.map(d => html`<${DraftCard} key=${d.id} d=${d} />`)}
            </div>
        </section>`;
}

/**
 * One draft, as a card.
 *
 * Deliberately the task board's card vocabulary — `tb-card`, `tb-card-meta`,
 * `tb-acts`, `tb-btn` — rather than a second set of styles for the same shape.
 * The prompt is shown rather than only its first line: the whole point of coming
 * here is to read what you wrote before releasing it, and a draft is usually a
 * paragraph rather than a transcript.
 *
 * The model says `inherit` rather than nothing: a model the session will pick
 * for itself is a real answer, and a blank would read as unset. The prompt goes
 * through `clipLines`, not `clip`: clip() flattens every run of whitespace to a
 * single space, which would turn a prompt written as a list of steps into one
 * long line — and the whole reason the message is on the card is to be read
 * back before it runs. The CSS clamps the height; this caps the text.
 *
 * `starting` is the card's own state, where the hand-built card wrote "Starting"
 * into its button: a push landing mid-start must not hand back a live Start.
 */
function DraftCard({ d }) {
    const [starting, setStarting] = useState(false);
    const start = () => drStart(d, setStarting);
    return html`
        <article class="tb-card dr-card" data-id=${d.id}
            onClick=${(e) => { if (tbCardClickOpens(e)) drEdit(d); }}>
            <header class="tb-card-head">
                <span class="tb-dot"></span>
                <button class="tb-card-title" type="button" title="Open this draft for editing"
                    onClick=${() => drEdit(d)}>${d.title || firstLine(d.prompt)}</button>
            </header>
            <div class="tb-card-meta">
                ${d.test ? html`<span class="tag-test">test</span>` : null}
                <span title=${d.cwd}>${d.projectName || 'unknown'}</span>
                <span class="dot">·</span>
                <span>${d.model || 'inherit'}</span>
                <span class="dot">·</span>
                <span>${d.permissionMode}</span>
                <span class="dot">·</span>
                <span title=${new Date(d.updatedAt).toLocaleString(undefined, hourOpts())}>${
                    ago(new Date(d.updatedAt).toISOString())}</span>
            </div>
            <p class="dr-prompt">${clipLines(d.prompt, 600)}</p>
            <div class="tb-acts">
                <button class="tb-btn primary" type="button" title="Start this session now"
                    disabled=${starting} onClick=${start}>${starting ? 'Starting' : 'Start'}</button>
                <button class="tb-btn" type="button" onClick=${() => drEdit(d)}>Edit</button>
                <button class="tb-btn quiet" type="button" title="Delete this draft"
                    onClick=${() => drDelete(d)}>Delete</button>
            </div>
        </article>`;
}

// ── acting on a card ─────────────────────────────────────────────────────

/**
 * Start it.
 *
 * One call: the bridge starts the session and forgets the draft, in that order,
 * so a failure leaves the draft where it was. Doing it here as two calls would
 * mean this window deciding what happens if the second one fails — and the phone
 * and the Android client would each have to decide the same thing again.
 */
async function drStart(d, setStarting) {
    setStarting(true);
    try {
        const r = await post(`/api/drafts/${d.id}/start`);
        toast('Session started.', 'ok');
        showDrafts(false);
        // The transcript only exists once `claude` has written its first line.
        openSessionSoon(r.sessionId);
    } catch (err) {
        toast(`Could not start the draft: ${err.message}`, 'error');
        setStarting(false);
    }
    // No re-enable on the happy path: the push takes the card off the board, and
    // a button that came back to life on a card about to vanish invites a second
    // press that would start the session twice.
}

/**
 * Open it in the dialog it was written in.
 *
 * The panel stays open behind the modal, so closing the dialog lands you back on
 * the board with the change already drawn — the `drafts-changed` push arrives
 * while it is still covered.
 */
function drEdit(d) {
    openNew({ draft: d });
}

/**
 * Delete it.
 *
 * No confirmation, unlike a session. `#del-scrim` exists because deleting a
 * transcript destroys a conversation that cannot be reconstructed; a draft is a
 * paragraph you wrote and can write again, and putting a dialog in front of it
 * would make tidying the board a chore.
 */
async function drDelete(d) {
    try {
        await del(`/api/drafts/${d.id}`);
    } catch (err) {
        toast(`Could not delete the draft: ${err.message}`, 'error');
    }
}
