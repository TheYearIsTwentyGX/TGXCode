// The schedules panel: sessions that start on a clock, drawn with Preact.
//
// Drafts' machinery throughout — an unconditional `schedules-changed` push, no
// watcher gate, no card ranks — because it is the same kind of thing: a create
// call the bridge is holding. The difference is only who presses Start.
//
// **What the card has to answer is not what a draft's card answers.** A draft is
// read to decide whether to release it, so its card shows the message. A schedule
// has already been released; you come here to find out whether it is still
// working. So the card leads with when it next runs and what the last run found,
// and the prompt is secondary — it is the one screen in this app whose job is to
// notice that something has quietly stopped happening.
//
// `nextRunAt`, `cronText` and `spent` are computed by the bridge, not here. Three
// clients read this API and none of them should be reimplementing a cron parser to
// draw a card — the one that runs the schedule is the one that should say when it
// runs, and whether it is ever going to again.
//
// **The panel is a column per project, each column stacked into Active, Paused
// and Done.** Drafts' column shape (web/drafts.js) for the horizontal half, for
// the reason it gives — sub-headings inside one column read as one long list once
// the rows come from five worktrees. The stacking is what makes that safe here:
// the objection this panel used to carry, that splitting by directory would put
// two dead schedules in two different columns, only holds while a dead schedule is
// loose in a list. Under a counted heading it is the first thing the column says.
//
// **Why Preact.** This payload is pushed when a run starts or an outcome lands —
// that is, while nobody has touched anything — and the hand-built panel answered
// every push by emptying `#sched-body` and building it again. A click that
// straddled one was lost, and every column's scroll had to be photographed and
// put back. Cards are keyed by schedule id, bands by their key and columns by
// project, so a push now moves or updates nodes rather than replacing them.
// Written the way web/rail.js settled: htm templates, no build step, no hand
// edits to nodes Preact owns. Markup and class names are what the imperative
// version built, so web/styles.css did not change.
//
// This imports from app.js, which imports this — safe because nothing here
// reads an imported binding at module top level, only when a function runs.

import { html, useState } from './vendor/preact.js';
import { del, get, patch, post } from './api.js';
import { state } from './state.js';
import { dom, toast } from './dom.js';
import { ago, clip } from './format.js';
import * as keys from './keys.js';
import {
    closeOtherPanels, paintPanels, rememberView, syncBoardWatch, syncTaskboardWatch,
} from './app.js';
import { icon, paint } from './boards/parts.js';
import { renderLive } from './boards/live.js';
import { tbCardClickOpens } from './boards/taskboard.js';
import { openNew } from './new-session/dialog.js';
import { termPane } from './term-pane.js';
import { openSession, openSessionSoon } from './transcript/conversation.js';
import { firstLine } from './transcript/suggestions.js';
import { clipLines } from './transcript/turn-rail.js';

export function showSched(on) {
    state.sched.open = on;
    if (on) closeOtherPanels('sched');
    paintPanels();
    syncBoardWatch();
    // As in showDrafts: this panel has no watch of its own, but it closes the
    // task board, whose ~3s tick on the bridge only stops when somebody says
    // they have stopped watching.
    syncTaskboardWatch();

    if (on) {
        renderSched();
        if (!state.sched.at) loadSched();
    } else if (state.live.open) {
        renderLive();
        if (state.current) termPane.refit();
    } else if (state.current) {
        termPane.refit();
    }
    rememberView();
}

const schedVisible = () => state.sched.open;

export function applySched(data) {
    state.sched.rows = data.schedules || [];
    state.sched.at = data.at || Date.now();
    state.sched.error = null;
    paintSchedBadge();
    if (schedVisible()) renderSched();
}

export async function loadSched() {
    if (state.sched.loading) return;
    state.sched.loading = true;
    try {
        const data = await get('/api/schedules');
        state.sched.loading = false;
        applySched(data);
    } catch (err) {
        state.sched.loading = false;
        state.sched.error = err.message;
        if (schedVisible()) renderSched();
    }
}

/**
 * How many schedules are armed.
 *
 * Armed, not stored: a paused schedule is a decision you already made and is not
 * news, and neither is one that has finished. `enabled` alone would count a row
 * whose expression can never match again — armed, and never going to fire — so
 * the badge and the Active band agree by asking the same question.
 *
 * Never `urgent` — a schedule that needs attention says so through a
 * notification, which is the surface that can reach you when this window is shut.
 */
export function paintSchedBadge() {
    const n = state.sched.rows.filter(s => s.enabled && !s.spent).length;
    dom.schedBadge.hidden = !n;
    dom.schedBadge.textContent = String(n);
    dom.btnSched.title = keys.hint(n
        ? `${n} schedule${n === 1 ? '' : 's'} armed`
        : 'Sessions that start on a clock', 'view.schedules');
}

// ── drawing it ───────────────────────────────────────────────────────────

export function renderSched() {
    const rows = state.sched.rows;
    const groups = schedGroups(rows);
    // Below two projects a column is a column with nothing to be told apart from,
    // which is only a narrower list — the drafts board's threshold and its
    // argument. The bands stay either way: they are about the schedules, not
    // about how many directories they came out of.
    const cols = groups.size >= 2;

    dom.schedSub.textContent = rows.length
        ? schedSummary(rows, cols ? groups.size : 0)
        : 'Sessions that start on a clock.';

    // The container is web/index.html's, not Preact's, so its class is still set
    // by hand — the task board's arrangement.
    dom.schedBody.classList.toggle('cols', !state.sched.error && rows.length > 0 && cols);

    if (state.sched.error) {
        paint(dom.schedBody, html`<div key="error" class="dr-note">
            <p>${`Could not read the schedules. ${state.sched.error}`}</p></div>`);
        return;
    }

    if (!rows.length) {
        paint(dom.schedBody, html`<div key="empty" class="dr-note">
            <p>Nothing scheduled yet.</p>
            <p class="dim">${'A schedule is a session that starts on its own '
                + '— an overnight review, a nightly sweep. It can be told to run only '
                + 'when a branch has new commits, and the range since its last run is '
                + 'available to the prompt.'}</p>
            <button class="tb-btn primary" type="button"
                onClick=${() => openNew({ schedule: true })}>New schedule</button>
        </div>`);
        return;
    }

    // Keyed nodes keep their scroll across an ordinary push, which matters more
    // here than on drafts: the push that would lose your place is one nobody
    // asked for. This is the backstop for the passes that replace them — one
    // project becoming two — keyed by project rather than by position, so a
    // column that has just moved left keeps its own place rather than inheriting
    // its neighbour's.
    const scrolls = new Map();
    for (const c of dom.schedBody.querySelectorAll('.tb-col-body')) {
        scrolls.set(c.dataset.project, c.scrollTop);
    }
    const down = dom.schedBody.scrollTop;
    const across = dom.schedBody.scrollLeft;

    if (cols) {
        paint(dom.schedBody, [...groups].map(([name, list]) => schedColumn(name, list)));
    } else {
        const [name] = [...groups.keys()];
        paint(dom.schedBody, schedBands(rows, name));
    }

    for (const c of dom.schedBody.querySelectorAll('.tb-col-body')) {
        const was = scrolls.get(c.dataset.project);
        if (was !== undefined && c.scrollTop !== was) c.scrollTop = was;
    }
    if (dom.schedBody.scrollTop !== down) dom.schedBody.scrollTop = down;
    if (dom.schedBody.scrollLeft !== across) dom.schedBody.scrollLeft = across;
}

/**
 * The schedules, by project.
 *
 * **The order of the keys is the order of the columns, and it needs no sort** —
 * `draftGroups` in web/drafts.js makes the argument at length and it holds
 * identically here: `schedules.list()` is newest-`updatedAt` first, `updatedAt`
 * moves on a create as well as an edit, and a Map keeps the order its keys were
 * first seen in. So one walk lands the projects most-recently-touched first. An
 * object keyed by name would not hold that, and neither would a second pass
 * sorting by anything else.
 *
 * `projectName` comes off the payload rather than being derived here, so every
 * client agrees about which project a directory belongs to.
 */
function schedGroups(rows) {
    const groups = new Map();
    for (const s of rows) {
        const name = s.projectName || 'unknown';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(s);
    }
    return groups;
}

// The three stacks, in the order they are drawn. Active first because it is what
// the panel is for; Done last because it is the half that only grows.
const SCHED_BANDS = [
    { key: 'active', label: 'Active' },
    { key: 'paused', label: 'Paused' },
    { key: 'done', label: 'Done' },
];

/**
 * Which stack a schedule belongs in.
 *
 * `spent` before `enabled`, because a spent one-time schedule is *always*
 * disabled — the bridge clears the flag itself when the slot passes — so reading
 * `enabled` first would file every finished schedule under Paused and say it was
 * waiting for you.
 *
 * The sweep check is first and is not a nicety. A one-time `open-prs` schedule is
 * spent the moment its slot is taken, and then spends the next hour actually
 * reviewing pull requests; without this the only schedule in the app that is
 * doing something would be filed under Done and folded out of sight. `docs/api.md`
 * calls `enabled: false` with an open window a real, transient state, and this is
 * the client end of that.
 */
function schedBand(s) {
    if (s.reviewsInFlight || (s.sweepUntil && s.sweepUntil > Date.now())) return 'active';
    if (s.spent) return 'done';
    if (!s.enabled) return 'paused';
    return 'active';
}

/** The sub-line: what is in the panel, counted the way the bands count it. */
function schedSummary(rows, projects) {
    const n = { active: 0, paused: 0, done: 0 };
    for (const s of rows) n[schedBand(s)]++;
    // Only the non-zero clauses, so a healthy list reads "4 schedules — 4 active."
    // rather than carrying two zeroes it wants you to ignore.
    const parts = [
        n.active ? `${n.active} active` : null,
        n.paused ? `${n.paused} paused` : null,
        n.done ? `${n.done} finished` : null,
    ].filter(Boolean);
    const head = `${rows.length} schedule${rows.length === 1 ? '' : 's'}`
        + (projects ? ` across ${projects} projects` : '');
    return `${head} — ${parts.join(', ')}.`;
}

/**
 * One project, as a column.
 *
 * `draftColumn`'s chrome — `tb-col`, `tb-col-head`, `tb-count`, `tb-col-body` —
 * for the same reason it borrowed it from the task board: the shape exists, and a
 * column here means a place rather than a state, so it takes none of the board's
 * per-column colour. What is stacked inside it is this panel's own.
 */
function schedColumn(name, list) {
    return html`
        <section key=${`project:${name}`} class="tb-col sched-col" data-project=${name}>
            <header class="tb-col-head">
                <h2 title=${name}>${name}</h2>
                <span class="tb-count">${String(list.length)}</span>
            </header>
            <div class="tb-col-body" data-project=${name}>${schedBands(list, name)}</div>
        </section>`;
}

const schedCards = (rows) => rows.map(s => html`<${SchedCard} key=${s.id} s=${s} />`);

/**
 * One project's schedules, stacked Active / Paused / Done.
 *
 * **Headings are dropped when Active is the only band with anything in it**,
 * which is the ordinary case and the one where a heading says nothing — the same
 * argument the column threshold makes one level up. A column of only *paused* or
 * only *done* rows keeps its heading, because "everything here has stopped" is
 * exactly what this panel exists to make impossible to miss.
 *
 * Done is a button rather than a heading, shut by default and shut again on the
 * next render unless you opened it. It is the band that only grows: every spent
 * one-time schedule lands there and nothing takes it out, so left open it would
 * bury the two live rows above it within a month of use.
 */
function schedBands(list, project) {
    const filled = SCHED_BANDS
        .map(b => ({ ...b, rows: list.filter(s => schedBand(s) === b.key) }))
        .filter(b => b.rows.length);
    const bare = filled.length === 1 && filled[0].key === 'active';

    return filled.map((b) => {
        if (bare) {
            return html`<div key=${`band:${b.key}`} class="sched-band" data-band=${b.key}
                >${schedCards(b.rows)}</div>`;
        }
        if (b.key !== 'done') {
            return html`<div key=${`band:${b.key}`} class="sched-band" data-band=${b.key}>
                <h3 class="tb-sub-head">${b.label}<span>${String(b.rows.length)}</span></h3>
                ${schedCards(b.rows)}
            </div>`;
        }
        const open = state.sched.openDone.has(project);
        return html`<div key="band:done" class="sched-band" data-band="done">
            <button class="tb-sub-head sched-band-head" type="button"
                aria-expanded=${String(open)}
                title=${open ? 'Hide the schedules that have finished'
                    : 'Show the schedules that have finished'}
                onClick=${() => {
                    state.sched.openDone[open ? 'delete' : 'add'](project);
                    renderSched();
                }}>
                <span class="twist">${icon('caret', 12)}</span>${b.label}<span>${String(b.rows.length)}</span>
            </button>
            ${open ? schedCards(b.rows) : null}
        </div>`;
    });
}

/**
 * What the last run did, as a phrase and a state.
 *
 * The state drives the dot's colour, and the phrase is the line you actually
 * read. `nothing-new` deserves saying out loud rather than being drawn as
 * nothing: a gated schedule that has been quiet for a week because the branch has
 * been quiet is working perfectly, and a card that showed a blank there would be
 * indistinguishable from one that has broken.
 */
function schedLast(s) {
    // A pull-request schedule mid-sweep is doing something right now, which is
    // more useful than whatever the last finished review said.
    if (s.reviewsInFlight) {
        return { state: 'ok',
            text: `reviewing ${s.reviewsInFlight} pull request${s.reviewsInFlight === 1 ? '' : 's'}` };
    }
    if (s.lastSkipReason === 'sweep-expired') {
        return { state: 'bad', text: s.lastError || 'the review window closed with work left' };
    }
    if (s.lastSkipReason === 'missed') {
        return { state: 'bad', text: s.lastError || 'a run was missed' };
    }
    if (s.lastSkipReason === 'error') {
        return { state: 'bad', text: `could not run — ${s.lastError || 'unknown error'}` };
    }
    if (s.lastSkipReason === 'rate-limited') {
        return { state: 'warn', text: 'skipped — too many sessions were starting at once' };
    }
    if (s.lastSkipReason === 'nothing-new') {
        return { state: 'quiet', text: 'nothing new to do' };
    }
    if (!s.lastFiredAt) return { state: 'quiet', text: 'has not run yet' };

    const when = ago(new Date(s.lastFiredAt).toISOString());
    if (s.lastOutcome === 'BLOCK') return { state: 'bad', text: `ran ${when} — BLOCK` };
    if (s.lastOutcome === 'CONCERNS') return { state: 'warn', text: `ran ${when} — CONCERNS` };
    if (s.lastOutcome === 'CLEAN') return { state: 'ok', text: `ran ${when} — clean` };
    if (s.lastOutcome === 'error') return { state: 'bad', text: `ran ${when} — ended in an error` };
    // Ran, finished, said nothing a verdict could be read out of. Most prompts
    // are like this, so it is the ordinary case and not a defect.
    if (s.lastOutcome === 'done') return { state: 'ok', text: `ran ${when}` };
    return { state: 'ok', text: `started ${when}` };
}

/**
 * `nextRunAt` as something worth reading, or why there is nothing to read.
 *
 * `spent` is asked first and the order is the whole point: a one-time schedule
 * that has fired is disabled by the bridge, so before this field existed the card
 * said "paused" about something that had finished — the one word that promises it
 * will run again when you press Resume.
 */
function schedNext(s) {
    if (s.spent) {
        return s.once ? 'no further runs — it ran its one slot'
            : 'never — the expression matches no real date';
    }
    if (!s.enabled) return 'paused';
    if (!s.nextRunAt) return 'never — the expression matches no real date';
    const d = new Date(s.nextRunAt);
    const soon = s.nextRunAt - Date.now();
    // Under a day, the clock time is what you want; past that, the date is.
    const when = soon < 24 * 3600e3
        ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return `next ${when}`;
}

// A function rather than one shared vnode: a vnode is a record of one place in
// the tree, and the meta line has up to six of these.
const dot = () => html`<span class="dot">·</span>`;

/**
 * The meta line's gate chips.
 *
 * A PR gate has no ref to name; what it has is a count of what it has looked at,
 * and whether it is posting.
 */
function schedGate(g, s) {
    if (!g) return null;
    if (g.kind === 'git-commits') {
        return [dot(), html`<span title=${`only runs when ${g.ref} has new commits`}
            >${`gated on ${g.ref}`}</span>`];
    }
    if (g.kind !== 'open-prs') return [dot()];
    return [
        dot(),
        html`<span title=${g.post
            ? 'reviews each open pull request and comments on it'
            : 'reviews each open pull request; posting is switched off'}
            >${s.reviewedCount ? `open PRs · ${s.reviewedCount} reviewed` : 'open PRs'}</span>`,
        !g.post ? html`<span class="tag-test" title="nothing is written to GitHub">no posting</span>` : null,
        !g.includeDrafts ? html`<span title="draft pull requests are skipped">ready only</span>` : null,
    ];
}

/**
 * One schedule, as a card.
 *
 * The expression is drawn in English, with the raw text as the tooltip for when
 * you do want to check what was typed. A schedule an agent made
 * (`schedule_session`) links to the conversation that says why — nobody
 * remembers setting up a run they asked for in passing a week ago. And the last
 * run has its own row rather than another chip in the meta line, because "this
 * stopped working three days ago" should not have to be found among six other
 * things.
 *
 * `running` is the card's own state, where the hand-built card wrote "Starting"
 * into its button: a push landing mid-run must not hand back a live Run now.
 */
function SchedCard({ s }) {
    const [running, setRunning] = useState(false);
    const last = schedLast(s);
    return html`
        <article class=${`tb-card sched-card${s.enabled ? '' : ' is-off'}`} data-id=${s.id}
            onClick=${(e) => { if (tbCardClickOpens(e)) schedEdit(s); }}>
            <header class="tb-card-head">
                <span class=${`tb-dot sched-dot is-${last.state}`}></span>
                <button class="tb-card-title" type="button" title="Open this schedule for editing"
                    onClick=${() => schedEdit(s)}>${s.title || firstLine(s.prompt)}</button>
            </header>
            <div class="tb-card-meta">
                ${s.test ? html`<span class="tag-test">test</span>` : null}
                <span class="sched-when" title=${s.cron}>${s.cronText || s.cron}</span>
                ${dot()}
                <span>${schedNext(s)}</span>
                ${dot()}
                <span title=${s.cwd}>${s.projectName || 'unknown'}</span>
                ${dot()}
                <span>${s.permissionMode}</span>
                ${schedGate(s.gate, s)}
                ${s.createdBy ? dot() : null}
                ${s.createdBy ? html`<button class="sched-open" type="button"
                    title="Open the session that set this up"
                    onClick=${() => { showSched(false); openSession(s.createdBy.sessionId); }}
                    >${`made by ${s.createdBy.title || 'a session'}`}</button>` : null}
            </div>
            <p class=${`sched-last is-${last.state}`}>${last.text}${
                s.runs ? html`<span class="dim">${` · ${s.runs} run${s.runs === 1 ? '' : 's'}`}</span>` : null}${
                s.lastSessionId ? html`<button class="sched-open" type="button"
                    title="Open the session the last run produced"
                    onClick=${() => { showSched(false); openSession(s.lastSessionId); }}>open</button>` : null}</p>
            <p class="dr-prompt">${clipLines(s.prompt, 400)}</p>
            <div class="tb-acts">
                <button class="tb-btn primary" type="button"
                    title="Start a run now, whatever the clock says"
                    disabled=${running} onClick=${() => schedRun(s, setRunning)}
                    >${running ? 'Starting' : 'Run now'}</button>
                <button class="tb-btn" type="button"
                    title=${s.enabled ? 'Stop it firing, without deleting it' : 'Arm it again'}
                    onClick=${() => schedToggle(s)}>${s.enabled ? 'Pause' : 'Resume'}</button>
                <button class="tb-btn" type="button" onClick=${() => schedEdit(s)}>Edit</button>
                <button class="tb-btn quiet" type="button" title="Delete this schedule"
                    onClick=${() => schedDelete(s)}>Delete</button>
            </div>
        </article>`;
}

// ── acting on a card ─────────────────────────────────────────────────────

/**
 * Run it now.
 *
 * The bridge runs the *same* function the clock runs, so what this produces is
 * what tonight would have produced — which is the only reason the button is
 * trustworthy as a way of checking a schedule before leaving it alone. It skips
 * the gate, since pressing a button should do something, and it advances the
 * marker exactly as a scheduled run does.
 */
async function schedRun(s, setRunning) {
    setRunning(true);
    try {
        const r = await post(`/api/schedules/${s.id}/run`);
        toast('Session started.', 'ok');
        showSched(false);
        openSessionSoon(r.sessionId);
    } catch (err) {
        toast(`Could not run the schedule: ${err.message}`, 'error');
        setRunning(false);
    }
}

/**
 * Pause or arm it.
 *
 * Not a delete, and that distinction is the whole reason the button exists: a
 * schedule you are switching off for a fortnight is one you still want, and
 * rebuilding it from memory afterwards is exactly the work this panel is meant to
 * save. Arming it again does not make it fire for every slot it slept through —
 * the bridge moves the cursor to now.
 */
async function schedToggle(s) {
    try {
        await patch(`/api/schedules/${s.id}`, { enabled: !s.enabled });
    } catch (err) {
        toast(`Could not ${s.enabled ? 'pause' : 'resume'} the schedule: ${err.message}`,
            'error');
    }
}

function schedEdit(s) {
    openNew({ schedule: s });
}

/**
 * Delete it.
 *
 * A confirmation, unlike a draft. Deleting a draft loses a paragraph you can
 * write again; deleting a schedule loses the run history with it — including the
 * marker that says which commits have already been reviewed — so recreating it
 * silently starts the next run's range from scratch. That is worth one press.
 */
async function schedDelete(s) {
    const label = s.title || firstLine(s.prompt);
    if (!window.confirm(`Delete the schedule “${clip(label, 60)}”?\n\n`
        + 'Its run history goes with it, including which commits it has already '
        + 'reviewed.')) return;
    try {
        await del(`/api/schedules/${s.id}`);
    } catch (err) {
        toast(`Could not delete the schedule: ${err.message}`, 'error');
    }
}
