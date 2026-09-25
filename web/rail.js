// The sessions rail, drawn with Preact.
//
// **Why Preact, and why here first.** renderRail() used to empty #rail and build
// every card and row again, and it runs on every `sessions-changed` broadcast —
// several times a minute on a busy machine. A click whose mousedown and mouseup
// straddled a rebuild never fired, because the button pressed was no longer in the
// document; hover went with the node, so a row's hover-only buttons blinked; the
// `breathe` on a running row started over; focus and the ⋮ menu's anchor were
// lost. The fixes piled up as patchers that edited rows in place to avoid the
// rebuild. Keyed reconciliation is the general answer to all of them: a render
// diffs against the last one, a row that did not change keeps its node, and a
// re-sort moves nodes rather than making new ones.
//
// **What is vendored.** `vendor/preact.js` is htm 3.1.1's `preact/standalone.module.js`
// — htm and Preact 10 in one ~13KB ESM file, imported normally like xterm.js (it
// ends in an `export{…}`; it is not the UMD shape diff2html needs a <script> for).
// The bundle carries no version string: htm 3.1.1 was built against `preact@^10.2.0`
// and published 2022-04-26, so it is some 10.x no newer than 10.7.1. It contains no
// eval, so the `default-src 'self'` CSP is satisfied. Licences in
// `vendor/LICENSE.preact` (htm is Apache-2.0, Preact MIT).
//
// **How it is written.** No JSX and no build step — `html\`…\`` tagged templates,
// which htm turns into `h()` calls at runtime. State is not in Preact: it stays in
// app.js's `state`, and `drawRail()` is a plain synchronous render of it, so the
// callers of renderRail() did not change. The row and card builders are ordinary
// functions returning vnodes rather than components, because none of them holds
// state of its own; what matters is the `key` on each root — `sessionId` on a row,
// the group key on a card.
//
// **What it does not fix.** Electron 31 is Chromium 126, which has no
// `Element.moveBefore`, so a row that genuinely changes position is moved with
// insertBefore — and a focused element that moves loses focus. Rows that stay put
// keep it, which is nearly all of them nearly all of the time.
//
// Markup and class names are exactly what the imperative version built, so
// web/styles.css did not change.
//
// This imports from app.js, which imports this — safe because nothing here reads
// an app.js binding at module top level, only when a function is called.

import { html, render } from './vendor/preact.js';
import { state } from './state.js';
import { dom } from './dom.js';
import { BOOT_PREFS } from './boot.js';
import { ago, clip, hhmm } from './format.js';
import { ICON, PR_ICON } from './icons.js';
import {
    projectColor,
    elsewhere, awayWords, prWords, prUnknownWhy, inProjectCard, groupKeyOf, rankOf,
    openSession, setFlags, askDelete, startRename, cancelRename, commitRename, toggleGroup, onRailDragStart, onRailDragEnd,
    showProjMenu, closeProjMenu, renderRail,
} from './app.js';

/**
 * Draw the rail into #rail. Called only by renderRail() in app.js, which paints
 * what lives outside the rail around it.
 *
 * @returns {number} how many sessions are finished, for the Hide finished button
 */
export function drawRail() {
    const { tree, finished } = railTree();
    render(tree, dom.rail);
    return finished;
}

function railTree() {
    if (!state.sessions.length) {
        return {
            finished: 0,
            tree: html`<div key="empty" class="rail-empty">${
                state.query ? 'Nothing matches that filter.' : 'No sessions on disk yet.'}</div>`,
        };
    }

    // Held order, not the order the bridge sent. See rememberOrder.
    const ordered = [...state.sessions].sort((a, b) => rankOf(a) - rankOf(b));

    const pinned = ordered.filter(s => s.pinned);
    const archived = ordered.filter(s => s.archived && !s.pinned);
    // Scratch sessions gathered in one place, because the point of labelling one
    // is to be able to find it again and delete it. Only a development bridge
    // sends any, so the everyday window never grows this card.
    const test = ordered.filter(s => s.test && !s.pinned && !s.archived);
    const rest = ordered.filter(inProjectCard);

    // `hideDone`: drop the rows whose work has landed. Only from the project
    // cards — pinning is something you did on purpose, archived is already out of
    // the way, and the test card exists to be emptied by hand.
    //
    // Two things are never hidden. The session on screen, because a row leaving
    // from under the conversation you are reading is the rail disagreeing with the
    // main pane about where you are. And nothing at all while a search is running,
    // for the reason `isOpen` gives for forcing groups open: a filter must not hide
    // its own results, and somebody typing the title of a merged session is looking
    // for exactly that.
    const hiding = state.hideDone && !state.query;
    const finished = rest.filter(prDone);
    const gone = new Set(hiding
        ? finished.filter(s => !state.current || state.current.sessionId !== s.sessionId)
            .map(s => s.sessionId)
        : []);

    const cards = [];

    // Pinned first, across every project — that is the point of pinning.
    if (pinned.length) cards.push(groupCard('pinned', 'Pinned', pinned));

    const groups = new Map();
    for (const s of rest) {
        const key = groupKeyOf(s);
        // `cwd` is the group's *directory*, which the key is deliberately not:
        // the key is the project's name, so the collapse state written against it
        // survives a checkout being moved. A colour is keyed on the path instead
        // — see projectColor() — so the card has to carry one, and it takes it
        // from the first session filed under the name. Two checkouts sharing a
        // basename therefore share a colour, which is the same collision that
        // already puts them in one card.
        if (!groups.has(key)) {
            groups.set(key, {
                label: s.projectName || 'unknown',
                cwd: s.projectCwd || s.cwd || '',
                list: [],
            });
        }
        groups.get(key).list.push(s);
    }
    const custom = BOOT_PREFS.projects.sort === 'custom';
    for (const [key, { label, cwd, list }] of orderGroups([...groups])) {
        // Sessions a schedule started fold into their own subsection inside the
        // project card. They are the same work in the same directory — so a card
        // of their own at the foot of the rail, the way test sessions get one,
        // would file them away from the project they are about — but there can
        // be a great many of them and they are all alike, and a fortnight of
        // nightly reviews between you and the conversation you are looking for
        // is what the rail exists to prevent.
        const shown = list.filter(s => !gone.has(s.sessionId));
        // A project with nothing left to show goes with its rows. An empty card
        // is a heading claiming a count it is not drawing, which is the one thing
        // `all` below is there to avoid.
        if (!shown.length) continue;
        const sched = shown.filter(s => s.schedule);
        const plain = shown.filter(s => !s.schedule);
        cards.push(groupCard(key, label, plain, {
            // What makes this card a *project* rather than Pinned or Archived:
            // the ⋮ menu and the colour both hang off it, and neither belongs on
            // a card that is not about a directory.
            project: { key, name: label, cwd },
            draggable: custom,
            // The project heading still counts what it contains, subsection
            // included: a card saying 3 above a shut section holding 11 is
            // wrong about the project, which is what the heading names. Hidden
            // rows are counted for the same reason — the project has them, and
            // the button in the rail head is where the hiding is accounted for.
            all: list,
            lead: sched.length
                ? groupCard(`sched:${key}`, 'Scheduled', sched, { nested: true })
                : null,
        }));
    }

    if (test.length) cards.push(groupCard('test', 'Test sessions', test));
    if (archived.length) cards.push(groupCard('archived', 'Archived', archived));

    // Said out loud rather than left to look like a rail that has lost its
    // sessions — the same promise the live board makes when `hideElsewhere`
    // empties it. The button above is still lit, but an empty column is read
    // before the control that caused it.
    if (!cards.length && gone.size) {
        cards.push(html`<div key="all-hidden" class="rail-empty">${
            `${gone.size === 1 ? 'One session is' : `All ${gone.size} sessions are`} finished, `
            + 'and hidden. Press Hide finished to see them.'}</div>`);
    }

    return { tree: cards, finished: finished.length };
}

/**
 * The project cards in the order `projects.sort` asks for.
 *
 * `recent` and `dynamic` are the held ranks — the same list; the difference is
 * only whether bumpGroup is allowed to change them. `custom` places each card
 * by its directory's index in `projects.order`, and a card the list does not
 * name yet goes above or below all of those by `newAt`, keeping its held rank
 * among the other unnamed ones so that several new projects still arrive in a
 * sensible order.
 *
 * While a card is being dragged, `custom` reads the order the drag has reached
 * instead of the saved one — the drag previews through the same render as
 * everything else, so a broadcast mid-drag redraws the rail without dropping
 * the card being carried. See onRailDragOver.
 *
 * @param {Array<[string, {label: string, cwd: string}]>} groups
 */
function orderGroups(groups) {
    const p = BOOT_PREFS.projects;
    const rank = ([key]) => state.groupOrder.get(key) ?? 0;
    if (p.sort === 'alpha') {
        return groups.sort((a, b) => a[1].label.localeCompare(b[1].label, undefined,
            { sensitivity: 'base', numeric: true }) || rank(a) - rank(b));
    }
    if (p.sort === 'custom') {
        const order = (state.railDrag && state.railDrag.order) || p.order || [];
        const at = new Map(order.map((d, i) => [d, i]));
        const unlisted = p.newAt === 'bottom' ? Infinity : -Infinity;
        const pos = (g) => at.has(g[1].cwd) ? at.get(g[1].cwd) : unlisted;
        return groups.sort((a, b) => (pos(a) - pos(b)) || rank(a) - rank(b));
    }
    return groups.sort((a, b) => rank(a) - rank(b));
}

/**
 * Is a rail group open?
 *
 * Two sets, because the two kinds of group want opposite defaults and one set
 * cannot express both. `state.collapsed` holds the *shut* keys, so a project
 * seen for the first time defaults open — which is right for a project and
 * wrong for the Scheduled subsection, whose whole point is to be out of the way
 * until you go looking. `state.schedOpen` holds the *open* ones instead, so a
 * project that starts running a schedule tomorrow does not silently grow eleven
 * rows in the rail.
 *
 * Inverting per-kind rather than seeding a default at first sight, because
 * seeding writes to storage during a render and gets the answer wrong exactly
 * once — on the render where the key first appears.
 *
 * A filter that matches inside a shut group must not hide its own results, so a
 * live query forces every group open. The heading still toggles while filtering;
 * it takes effect once the filter clears.
 */
function isOpen(key, nested) {
    if (state.query) return true;
    return nested ? state.schedOpen.has(key) : !state.collapsed.has(key);
}

/** One of web/icons.js's ICON glyphs, as a vnode. Its icon() is the DOM twin. */
function icon(name, size = 15) {
    return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none"
        aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICON[name] }}></svg>`;
}

/**
 * A rail group: a card whose heading shuts it. `key` is what the open/shut
 * state is remembered under, and what the card is keyed by across renders.
 *
 * `opts.lead` is a vnode rendered above the rows — a nested card, in the one
 * case there is. `opts.all` is the list the *heading* counts, when that is wider
 * than the rows beneath it. `opts.nested` marks a card that sits inside another,
 * which changes both how it is drawn and where its open/shut state lives: see
 * `isOpen`.
 */
function groupCard(key, label, list, opts = {}) {
    const open = isOpen(key, opts.nested);
    const counted = opts.all || list;
    const live = counted.filter(s => s.active || (s.runner && s.runner.state === 'busy')).length;
    const bodyId = `group-${key.replace(/[^\w-]/g, '_')}`;
    // Only a project card has a directory, so only a project card can have a
    // colour or a menu. Pinned, Archived, Test and the nested Scheduled
    // subsection get neither — there is nothing for either to be about.
    const accent = opts.project ? projectColor(opts.project.cwd) : '';

    // `custom` order: the heading is the handle. Only the heading, so a row
    // dragged out of the card is still nothing — rows are not reordered here.
    // A card with no directory (`unknown`) has nothing to be keyed by in
    // `projects.order`, so it cannot be placed.
    const drag = opts.project && opts.draggable && !!opts.project.cwd;
    const carried = drag && state.railDrag && state.railDrag.cwd === opts.project.cwd;
    // The ⋮ menu is fixed and lives outside the rail; `state.projMenu` is how the
    // button knows it is the one the menu belongs to.
    const menuOpen = !!opts.project && !!state.projMenu && state.projMenu.key === key;

    // The ⋮ button is a sibling of the head rather than a child of it, because
    // the head is itself a <button> and a button inside a button is not a thing
    // the browser will build. It is positioned over the card's top-right corner
    // instead, with the head padded to keep the count out from under it.

    return html`
        <section key=${key}
            class=${'rail-group' + (opts.nested ? ' nested' : '') + (carried ? ' dragging' : '')}
            data-key=${key}
            data-cwd=${opts.project ? opts.project.cwd : null}
            data-tinted=${accent ? '1' : null}
            style=${accent ? `--proj-accent: ${accent}` : null}>
            <button class="group-head" type="button"
                aria-expanded=${String(open)}
                aria-controls=${bodyId}
                draggable=${drag ? 'true' : null}
                title=${drag ? 'Drag to reorder projects' : null}
                onClick=${() => { toggleGroup(key, open, opts.nested); renderRail(); }}
                onDragStart=${drag ? (e) => onRailDragStart(e, opts.project.cwd) : null}
                onDragEnd=${drag ? onRailDragEnd : null}>
                ${drag ? html`<span class="group-grip">${icon('grip', 13)}</span>` : null}
                <span class="twist">${icon('caret', 13)}</span>
                <span class="group-label">${label}</span>
                ${live ? html`<span class="live">${`${live} live`}</span>` : null}
                <span class="count">${String(counted.length)}</span>
            </button>
            ${opts.project ? html`
                <button class="group-menu-btn" type="button"
                    aria-haspopup="menu" aria-expanded=${String(menuOpen)}
                    aria-label=${`More for ${label}`} title=${`More for ${label}`}
                    onClick=${(e) => {
                        e.stopPropagation();
                        if (menuOpen) closeProjMenu();
                        else showProjMenu(opts.project, e.currentTarget);
                    }}>${icon('dots', 15)}</button>` : null}
            ${open ? html`
                <div class="group-body" id=${bodyId}>
                    ${opts.lead || null}
                    ${list.map(strip)}
                </div>` : null}
        </section>`;
}

function strip(s) {
    const running = s.runner && (s.runner.state === 'busy' || s.runner.state === 'starting');
    const current = state.current && state.current.sessionId === s.sessionId;
    const queued = (s.runner && s.runner.queued) || 0;
    const away = elsewhere(s);
    const when = ago(s.lastUserTs || s.lastTs);
    const renaming = !!state.railRename && state.railRename.id === s.sessionId;

    // A row, not a button: it holds its own pin and archive controls, and
    // nesting buttons is not allowed.
    //
    // Pinning is a state worth seeing without hovering, so it gets a tag in the
    // meta line now that the buttons are hover-only. `test` is only ever set on a
    // development bridge, and worth saying on the row: a labelled session is one
    // somebody meant to throw away. A background agent is a different sort of
    // thing from a session somebody is sitting in front of, and only the registry
    // knows. The PR glyph goes ahead of the worktree name and the activity, which
    // are the two things this line is allowed to squeeze out; the time is the one
    // the list is ordered by, so the order reads as sorted. A queue count goes
    // ahead of the activity because the activity is the one part of the row that
    // may be cut short — it is the least specific thing on it.
    const meta = html`
                <span class="strip-meta">
                    ${s.pinned ? html`<span class="tag-pin" title="Pinned">${icon('pin', 11)}</span>` : null}
                    ${s.test ? html`<span class="tag-test">test</span>` : null}
                    ${(s.live && s.live.kind === 'bg')
                        ? html`<span class="tag-bg" title="A background agent">bg</span>` : null}
                    ${prBadge(s)}
                    ${s.worktree ? html`<span class="wt">${s.worktree.name}</span>` : null}
                    ${s.worktree ? html`<span class="dot">·</span>` : null}
                    <span title=${`You last wrote here ${when} ago`}>${when}</span>
                    <span class="dot">·</span>
                    <span>${`${s.userMessages} ${s.userMessages === 1 ? 'turn' : 'turns'}`}</span>
                    ${queued ? queuedBadge(queued) : null}
                    ${dueBadge(s.sessionId)}
                    ${activityBits(running ? s.runner : null)}
                </span>`;

    // Renaming swaps the button for a plain box around the input: an input inside
    // a button is not something the browser will let you type into.
    return html`
        <div key=${s.sessionId} class="strip"
            data-id=${s.sessionId}
            data-state=${stripState(s)}
            title=${away ? awayWords(away) : null}
            data-pinned=${String(!!s.pinned)}
            data-archived=${String(!!s.archived)}
            data-renaming=${renaming ? 'true' : null}
            aria-current=${current ? 'true' : null}>
            ${renaming
                ? html`<div class="strip-main">${renameInput(s)}${meta}</div>`
                : html`<button class="strip-main" type="button" onClick=${() => openSession(s.sessionId)}>
                    <span class="strip-title">${s.title}</span>${meta}</button>`}
            <div class="strip-actions">
                <button class="mini" type="button" title="Rename"
                    onClick=${(e) => { e.stopPropagation(); startRename(s); }}
                >${icon('pencil')}</button>
                <button class=${'mini' + (s.pinned ? ' on' : '')} type="button"
                    title=${s.pinned ? 'Unpin' : 'Pin to the top'}
                    aria-pressed=${String(!!s.pinned)}
                    onClick=${(e) => { e.stopPropagation(); setFlags(s, { pinned: !s.pinned }); }}
                >${icon('pin')}</button>
                <button class="mini" type="button"
                    title=${s.archived ? 'Restore from archive' : 'Archive'}
                    onClick=${(e) => { e.stopPropagation(); setFlags(s, { archived: !s.archived }); }}
                >${icon(s.archived ? 'unarchive' : 'archive')}</button>
                <button class="mini danger" type="button" title="Delete permanently"
                    onClick=${(e) => { e.stopPropagation(); askDelete(s); }}
                >${icon('trash')}</button>
            </div>
        </div>`;
}

/**
 * The title's place while it is being renamed. Enter and a click away both keep
 * the name; Escape drops it. Emptying it gives the transcript's name back.
 *
 * The value is read from `state.railRename` and written back on every keystroke,
 * so the `sessions-changed` renders that arrive mid-word pass the same value and
 * leave the node, its caret and its focus where they were.
 */
function renameInput(s) {
    return html`<input class="strip-rename" type="text" maxlength="200"
        aria-label=${`Rename ${s.title}`}
        placeholder="Name this session"
        value=${state.railRename.draft}
        ref=${focusOnce}
        onInput=${(e) => { if (state.railRename) state.railRename.draft = e.currentTarget.value; }}
        onKeyDown=${(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitRename(s); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRename(); }
        }}
        onBlur=${() => commitRename(s)} />`;
}

// Inputs already focused, so a re-render's ref call does not select the text
// out from under somebody typing. A WeakSet rather than a mark on the node,
// which Preact owns.
const focused = new WeakSet();

function focusOnce(node) {
    if (!node || focused.has(node)) return;
    focused.add(node);
    node.focus();
    node.select();
}

/** Three states where there used to be two. `active` is the mtime fallback. */
function stripState(s) {
    if (s.runner && (s.runner.state === 'busy' || s.runner.state === 'starting')) return 'running';
    if (elsewhere(s)) return 'elsewhere';
    return s.active ? 'active' : 'idle';
}

/**
 * What a row says about the turn it is running: its separator and the activity
 * line, as a pair.
 *
 * Only the words. That a session is working at all is said by the dot at the head
 * of the meta line, which is the part that has to survive a narrow rail — this
 * text is last in a row that does not wrap, so it is the first thing to go.
 *
 * `detail` before `activity`, and that is the one place in the app that unpicks
 * the label. Everywhere else has room for `Percolating… Reading runner.js`;
 * twenty-odd characters does not, and clipping it there would spend them all on
 * the spinner verb and cut the tool name off the end — the decorative half
 * surviving at the expense of the informative one. `detail` is that label
 * without its verb, and it is null exactly when the verb is all there is to
 * say, so the rail still shows a verb whenever nothing more specific is
 * happening.
 */
function activityBits(runner) {
    if (!runner) return null;
    return [
        html`<span class="dot dot-act">·</span>`,
        html`<span class="pulse"><span class="pulse-t">${
            clip(runner.detail || runner.activity || 'Working', 22)}</span></span>`,
    ];
}

/** The rail's copy of app.js's queuedBadge(), which the live board still uses as DOM. */
function queuedBadge(queued) {
    return html`<span class="wait"
        title=${`${queued} message${queued === 1 ? '' : 's'} waiting to be sent`}
        >${`+${queued} queued`}</span>`;
}

/**
 * Messages written for this session and waiting on a clock.
 *
 * Its own badge rather than folded into the one above, because the two facts do
 * not mean the same thing to somebody scanning the rail: a queued message goes the
 * moment the turn ends, and this one goes at the hour it says. Showing the hour is
 * the whole point — "something arrives here at 02:00" should be answerable without
 * opening the session, which is the one thing nobody is going to do at 02:00.
 */
function dueBadge(sessionId) {
    let pending = 0;
    let nextAt = 0;
    for (const m of state.later) {
        if (m.sessionId !== sessionId || m.state !== 'pending') continue;
        pending++;
        if (!nextAt || m.at < nextAt) nextAt = m.at;
    }
    if (!pending) return null;
    return html`<span class="due"
        title=${`${pending} message${pending === 1 ? '' : 's'} scheduled; the next at `
            + new Date(nextAt).toLocaleString()}
        >${`\u{1F550} ${hhmm(nextAt)}${pending > 1 ? ` +${pending - 1}` : ''}`}</span>`;
}

/**
 * Is there nothing left open on this session's pull requests?
 *
 * `merged` and `closed` are the last two in the bridge's `ATTENTION_ORDER`, below
 * every live state, so a session reduces to one of those two words only when none
 * of its PRs is still going. The single word is therefore already the "all of
 * them" test and the counts do not need consulting — which is the same reason the
 * ranking lives on the bridge and is not copied here.
 *
 * A session with no PRs is not finished, it is unmeasured, and has no entry here
 * at all; nor is one whose PRs could not be reached, which is `unknown`. Both keep
 * their rows, which is the distinction `prBadge` already draws in colour.
 */
function prDone(s) {
    const agg = state.railPrs.get(s.sessionId);
    return !!agg && (agg.status === 'merged' || agg.status === 'closed');
}

/**
 * What a session's pull requests have come to, as one glyph.
 *
 * The same glyph set and the same colour table as the header chip, at 11px — one
 * PR vocabulary, learned once. Which of several PRs it draws is the bridge's call
 * (`ATTENTION_ORDER` in `pulls.js`); having a second copy of that ranking here is
 * how the two would drift.
 *
 * Drawn from `prs` on the summary, which is free, so the glyph appears with the
 * rail and gains its colour when the `prs-changed` payload arrives — exactly what
 * `prLink` does in the header. A session with no PRs draws nothing at all, which
 * is not the same as one whose PRs could not be reached: that one is grey.
 */
function prBadge(s) {
    if (!s.prs || !s.prs.length) return null;
    const agg = state.railPrs.get(s.sessionId) || null;
    const status = (agg && agg.status) || 'unknown';
    return html`<span class="tag-pr" data-status=${status} title=${prBadgeTip(s, agg)}>${
        icon(PR_ICON[status] || 'pr', 11)}</span>`;
}

/**
 * The glyph is recognisable without being read; the words are here.
 *
 * Same three-part shape as the header's tooltip — what it is, what the one word
 * left out, then which PRs are being talked about. The breakdown is skipped for a
 * session with one PR, where it would only say the headline twice.
 */
function prBadgeTip(s, agg) {
    const numbers = s.prs.map(p => `#${p.number}`).join(' · ');
    const plural = `${s.prs.length} pull request${s.prs.length === 1 ? '' : 's'}`;

    // Before the first payload lands, and after one that could not answer: the row
    // knows how many PRs there are and nothing about them, and says exactly that.
    if (!agg) return `${plural}\nAsking GitHub…\n${numbers}`;
    if (agg.status === 'unknown') return `${plural}\n${prUnknownWhy()}\n${numbers}`;

    const breakdown = Object.entries(agg.counts)
        .sort((a, b) => b[1] - a[1])
        .map(([status, n]) => `${n} ${prWords(status)}`)
        .join(' · ');

    return [
        agg.label || prWords(agg.status),
        agg.total > 1 ? `${plural} — ${breakdown}` : null,
        numbers,
    ].filter(Boolean).join('\n');
}
