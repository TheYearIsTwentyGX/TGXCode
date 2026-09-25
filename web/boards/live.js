// The live board, drawn with Preact.
//
// The rail is one conversation at a time, which is the right shape for reading
// one and the wrong shape for an afternoon with five agents working. This is
// the other view: a card per running session, needs-you first, so that "which
// one is stuck" is a glance rather than a round of clicking.
//
// Everything on a card arrives in a single `overview` event. Nothing here
// subscribes to a transcript. The view plumbing — showLive, the dock, focus
// mode, the address bar — stays in app.js's `// ── live ──` section; this file is
// what gets drawn.
//
// **Why Preact.** The board is pushed whenever anything moves, which is
// constantly while agents are working. The imperative version grew its own
// answer to that — a per-card cache keyed on the bridge's `sig`, and a
// `reconcile` that swapped only the positions holding a new node and fell back
// to `replaceChildren` whenever the order changed. That fallback was the rail's
// old bug in miniature: a click whose mousedown and mouseup straddled a re-sort
// never fired, hover went with the node, and a card's composer lost its caret.
// Keyed reconciliation is the general answer, and it is what web/rail.js already
// uses: cards are keyed by session id, groups by their key, and a card that moves
// is moved rather than rebuilt.
//
// **The `sig` still does the work it did.** Every card carries a hash of its own
// contents (`fingerprint` in bridge/overview.js), so a push where one agent moved
// is a push where every other card is byte-identical. `LiveCard` compares it in
// shouldComponentUpdate, which keeps Preact from even diffing those cards — the
// cost the cache was there to avoid, of thirty-odd elements per card per second
// beside a document that also holds the whole open transcript.
//
// Markup and class names are what the imperative version built, so
// web/styles.css did not change.
//
// This imports from app.js, which imports this — safe because nothing here reads
// an app.js binding at module top level, only when a function is called.

import { html, Component } from '../vendor/preact.js';
import { post } from '../api.js';
import { BOOT_PREFS } from '../boot.js';
import { state } from '../state.js';
import { dom, toast } from '../dom.js';
import { ago, clip } from '../format.js';
import {
    elsewhere, openPreview, openTitle, opensInDevBrowser,
} from '../app.js';
import { askBody } from '../notifications.js';
import { answerAskFor, ASK_HEAD } from '../transcript/approvals.js';
import { openSession } from '../transcript/conversation.js';
import { toolSummary } from '../transcript/tools.js';
import { enterSends, grow } from '../composer/send.js';
import {
    liveStatusWords, paint, queuedBadge, StopButton, taskBar,
} from './parts.js';

/**
 * Whether the board is the sideways strip under a conversation.
 *
 * `state.live.dock` is not this question. It remembers which side you docked to
 * and keeps saying 'bottom' when the board has the whole window, where nothing
 * runs sideways at all — so anything about the arrangement has to ask
 * `data-mode` as well. Both the stripped-down card and the jump's scroll axis
 * want this one.
 */
export const liveStrip = () => dom.live.dataset.mode === 'dock' && state.live.dock === 'bottom';

/**
 * The board's settings — the user's own, and deliberately never `state.prefs`.
 *
 * `state.prefs` is the *open session's* answer, project overrides and all, and
 * the board is the one view that is not about one session: it draws cards from
 * every project on the machine at once. Reading that would let whichever
 * conversation happens to be open decide how every other project's cards are
 * drawn, which is a setting that appears to change on its own.
 */
const liveCompact = () => BOOT_PREFS.live.compact;
const liveHideElsewhere = () => BOOT_PREFS.live.hideElsewhere;
const liveByArrival = () => BOOT_PREFS.live.order === 'arrival';

// How much history a card carries when it has the screen to itself.
const HEADLINES_SHOWN = 3;

/**
 * Composers mounted during the current render that came back with a draft in
 * them, for the one thing that has to measure them after they are on screen.
 */
let freshBoxes = [];

export function renderLive() {
    const d = state.live.data;

    if (!d) {
        paint(dom.liveSub, 'Asking the bridge what is running…');
        paint(dom.liveBody, html`<div key="note" class="live-note">
            <p>Asking the bridge what is running…</p></div>`);
        return;
    }

    // Every arrangement is grouped: "running" against "I merely touched this
    // today" is what makes the board pickable, and that is as true of the grid
    // with the window to itself as of the strip. It was the strip's idea first,
    // which is why it was once the strip's flag.
    //
    // What is still a question about the layout is density — only the bottom
    // strip is short of room. As a column, or full screen, there is height for a
    // fuller card.
    const strip = liveStrip();

    // `live.hideElsewhere`: drop the cards this window has no process for. The
    // test is the one the rail already uses, so the two views cannot disagree
    // about what "not ours" means. `recent` needs no filtering — a session the
    // bridge put in that group is one it found idle, and a session running in a
    // terminal is never idle.
    const sessions = liveHideElsewhere()
        ? d.sessions.filter(s => !elsewhere(s))
        : d.sessions;
    const hiddenAway = d.sessions.length - sessions.length;
    // Before the filter above is applied, so that turning `hideElsewhere` on and
    // off does not send every terminal session to the back of the queue.
    rememberArrival(d.sessions.filter(s => s.reason !== 'pinned'));

    const bits = [];
    if (d.waiting) bits.push(`${d.waiting} waiting for you`);
    // Recounted rather than taken from the payload, which counted the cards
    // before any of them were hidden. Same two reasons the bridge counts.
    bits.push(`${sessions.filter(s => s.reason === 'here' || s.reason === 'elsewhere').length} running`);
    // What the other groups hold, and a way to get to them — the strip's
    // problem first. Five sessions working is 1650px of Live before Recent
    // activity even begins, so a group past the first is not so much missing as
    // unmentioned, and the first thing anybody says is that the section never
    // appeared. A count alone would still leave the scroll to be discovered, so
    // the count is the way there. Full screen the same run of cards is below the
    // fold rather than off the side, which is the same problem lying down.
    const recent = (d.recent || []).length;
    const pinned = sessions.filter(s => s.reason === 'pinned').length;
    if (recent) bits.push(jumpToGroup('recent', `${recent} recent`));
    if (pinned) bits.push(jumpToGroup('pinned', `${pinned} pinned`));
    if (d.hidden) bits.push(`${d.hidden} more not shown`);
    // Said out loud rather than left to look like an empty board — the same
    // promise the cap above makes. A setting that silently removes cards is
    // indistinguishable from a bridge that has stopped noticing them.
    if (hiddenAway) bits.push(`${hiddenAway} elsewhere, hidden`);
    // Interleaved rather than joined: some of these are buttons now.
    paint(dom.liveSub, bits.flatMap((bit, i) => (i
        ? [html`<span class="live-sep">${' · '}</span>`, bit]
        : [bit])));

    // Nothing to draw at all — the recent group is a reason to draw the board
    // even with nothing running, and it is drawn in every arrangement now.
    if (!sessions.length && !recent) {
        paint(dom.liveBody, html`<div key="note" class="live-note"><p>${
            // The plain sentence claims the terminals too, so it must not be
            // said when `hideElsewhere` is the reason the board is empty.
            hiddenAway
                ? `Nothing here is running. ${hiddenAway === 1 ? 'One session is' : `${hiddenAway} sessions are`} `
                    + 'running outside this window, and live.hideElsewhere keeps them off the board.'
                : 'Nothing is running. Every session on this machine is idle, '
                    + 'here and in every terminal.'}</p></div>`);
        return;
    }

    // Keyed reconciliation keeps the focused composer's node, and with it the
    // caret, in every ordinary pass. This is the backstop for the passes that do
    // replace the node — the board going from its note to its groups, say — and
    // costs nothing when the focus survived.
    const active = document.activeElement;
    const typing = active && active.dataset && active.dataset.sendFor
        ? { id: active.dataset.sendFor, at: active.selectionStart, to: active.selectionEnd }
        : null;
    const scroll = { x: dom.liveBody.scrollLeft, y: dom.liveBody.scrollTop };

    freshBoxes = [];
    paint(dom.liveBody, liveGroups({ ...d, sessions }, strip));
    dom.liveBody.scrollLeft = scroll.x;
    dom.liveBody.scrollTop = scroll.y;

    if (typing && document.activeElement !== active) {
        const box = dom.liveBody.querySelector(
            `[data-send-for="${CSS.escape(typing.id)}"]`);
        if (box) {
            box.focus({ preventScroll: true });
            box.setSelectionRange(typing.at, typing.to);
        }
    }

    // Sizing a composer means writing a height, reading `scrollHeight` and
    // writing again — a forced synchronous layout, of a document that also
    // holds the whole open transcript. Doing that per card per second is what
    // made the board unusable beside a large session. Only a box that is both
    // newly mounted and carrying a restored draft needs it: an empty one is the
    // height its single row gives it, and one that survived the pass already
    // has its height. Reads are batched between the writes so the run costs one
    // layout rather than one each.
    const boxes = freshBoxes;
    freshBoxes = [];
    if (boxes.length) {
        for (const box of boxes) box.style.height = 'auto';
        const heights = boxes.map(box => Math.max(30, Math.min(84, box.scrollHeight)));
        boxes.forEach((box, i) => { box.style.height = `${heights[i]}px`; });
    }
}

/**
 * A composer has just been mounted. A stable function, so Preact calls it once
 * per node rather than on every render; `value` is already set by then.
 */
function noteFreshBox(node) {
    if (node && node.value) freshBoxes.push(node);
}

/**
 * A count in the subtitle that takes you to the group it counts.
 *
 * `scrollIntoView` along whichever axis the board is arranged in — the group is
 * off to the right in the strip and further down in the column or the
 * full-window grid, and asking for the wrong one moves nothing. Which is why
 * the axis comes from `liveStrip()` and not from `state.live.dock`: that still
 * reads 'bottom' with no conversation open, so an inline scroll was requested
 * down a board that only scrolls vertically.
 */
function jumpToGroup(key, label) {
    return html`<button key=${`jump-${key}`} class="live-jump" type="button"
        title=${`Show the ${label.replace(/^\d+ /, '')} group`}
        onClick=${() => {
            const group = dom.liveBody.querySelector(`.live-group[data-group="${key}"]`);
            if (!group) return;
            group.scrollIntoView(liveStrip()
                ? { behavior: 'smooth', inline: 'start', block: 'nearest' }
                : { behavior: 'smooth', block: 'start', inline: 'nearest' });
        }}>${label}</button>`;
}

/**
 * When the work behind a card began, for seeding the queue on the first pass.
 * `busySince` is the turn's own start; a session running in a terminal has no
 * runner, so it falls back to the last thing somebody asked it.
 */
function startedAt(s) {
    if (s.runner && s.runner.busySince) return s.runner.busySince;
    const ts = Date.parse(s.lastUserTs || s.lastTs || '');
    return Number.isNaN(ts) ? 0 : ts;
}

/**
 * Keep `state.live.arrival` in step with the Live group: forget what has left
 * it, and put what is new on the end.
 *
 * Forgetting is the half that makes the queue move — a card climbs because the
 * ones above it stopped holding ranks, not because its own changed — and it is
 * also why a session that finishes and is later asked something else rejoins at
 * the bottom rather than where it used to be. That is the queue as asked for,
 * even though a turn that ends and is followed at once by another is two visits.
 *
 * The first pass has nothing to go on but the cards themselves, all "new" at
 * once, so it orders them by when their work started instead: the board opens
 * with the longest-running job on top, as if it had been watching all along.
 */
function rememberArrival(list) {
    const a = state.live.arrival;
    const ids = new Set(list.map(s => s.sessionId));
    for (const id of a.keys()) if (!ids.has(id)) a.delete(id);

    const fresh = list.filter(s => !a.has(s.sessionId));
    if (!a.size) fresh.sort((x, y) => startedAt(x) - startedAt(y));
    for (const s of fresh) a.set(s.sessionId, state.live.nextArrival++);
}

/**
 * The board in three parts — along the strip, down the column, or down the page.
 *
 * Pinned and running are already known — they are the reasons the bridge sorts
 * the board by — so those two groups are that one list cut in two rather than a
 * second opinion about it, and the needs-you-first order inside each survives
 * the cut — unless `live.order` is `arrival`, when Live is put back into the
 * order its cards joined in. Recent is the array the bridge sends beside it.
 *
 * Empty groups are dropped rather than shown empty: three headings over one card
 * is mostly headings, and the strip has no room to spare for them.
 */
function liveGroups(d, strip) {
    const live = d.sessions.filter(s => s.reason !== 'pinned');
    if (liveByArrival()) {
        const rank = (s) => state.live.arrival.get(s.sessionId) ?? Infinity;
        live.sort((x, y) => rank(x) - rank(y));
    }
    const pinned = d.sessions.filter(s => s.reason === 'pinned');
    const recent = d.recent || [];
    // A settings question rather than a layout one: how much of a card there is
    // to draw at all. Read once per pass and handed down, because a card that
    // has not changed skips its render — and must not skip this changing.
    const compact = !!liveCompact();

    return [
        // Only `recent` carries its own overflow. `hidden` is the board's cap
        // biting, and it bites the bottom of the rank order — pinned before
        // running — so the payload cannot say which of these two groups lost a
        // card, and the subtitle above already reports the number for the board
        // as a whole.
        ['live', 'Live', live, 0],
        ['recent', 'Recent activity', recent, d.recentHidden],
        ['pinned', 'Pinned', pinned, 0],
    ].filter(([, , list]) => list.length)
        .map(([key, label, list, hidden]) => liveGroup(key, label, list, hidden, strip, compact));
}

/**
 * One headed segment of the board. Keyed by its group, so the section and its
 * heading are the same nodes from push to push and a card inside one is never
 * re-parented — which is what used to blur whatever was focused inside it.
 *
 * `lgroup-more` makes the subtitle's promise about the board as a whole for one
 * group: what fell off the end is reported, because a list that silently stops
 * reads as the end of the list.
 */
function liveGroup(key, label, list, hidden, strip, compact) {
    return html`
        <section key=${key} class="live-group" data-group=${key}>
            <h2 class="lgroup-head">
                <span class="lgroup-label">${label}</span>
                <span class="lgroup-count">${String(list.length)}</span>
                <span class="lgroup-more" hidden=${!hidden}>${hidden ? `+${hidden} more` : ''}</span>
            </h2>
            <div class="lgroup-body">
                ${list.map(s => html`<${LiveCard} key=${s.sessionId} s=${s} strip=${strip} compact=${compact} />`)}
            </div>
        </section>`;
}

/**
 * One session, as a card.
 *
 * Deliberately built from the same pieces as the rail row and the task board —
 * queuedBadge, liveStatusWords, taskBar, ago, clip — rather than a second
 * vocabulary for the same facts. The risk with a view like this is two renderers
 * of one state drifting apart, and sharing the small parts is what keeps them
 * honest.
 *
 * `strip` is part of the comparison because it changes what is drawn — a dock
 * that has just been moved must not keep cards cut for the other shape — and
 * `compact` because a setting changed in Settings has to reach every card.
 *
 * The state is what used to be written into the DOM by hand: `sending` is the
 * composer between Send and the reply, `answering` the ask buttons after one was
 * pressed (held against the `sig` it was pressed at, so an ask that arrives later
 * gets live buttons, as it used to by the card being rebuilt), and `chips` the
 * dev-server ports being opened.
 */
class LiveCard extends Component {
    shouldComponentUpdate(next, nextState) {
        return next.s.sig !== this.props.s.sig
            || next.strip !== this.props.strip
            || next.compact !== this.props.compact
            || nextState !== this.state;
    }

    render({ s, strip, compact }) {
        const r = s.runner;
        const busy = r && (r.state === 'busy' || r.state === 'starting');
        const away = s.live && s.live.running && !r;
        // In the bottom strip every row a card gives up is a row of transcript, so
        // it drops what is duplicated elsewhere: one line of history, and the Open
        // button — the title above it already opens the session, and the rail is
        // right there. Beside the conversation there is height to spare and the
        // fuller card is free.
        const lines = strip ? 2 : HEADLINES_SHOWN;
        const open = () => openSession(s.sessionId);

        // The title is still a button, though the whole card opens the session:
        // it is what a keyboard reaches and what a screen reader announces, and
        // the card around it is a mouse affordance layered over the top.
        //
        // The chips are ports something is answering on right now. The overview
        // refreshes these on its own slow cycle, so a chip is at most ~15s old.
        //
        // Below the facts line is everything `live.compact` takes away — the
        // approval row with the rest of it. Losing that one is the real cost of
        // the setting, since answering is what the board is for; the card still
        // says it is asking, in its status words and in its coloured edge, and
        // clicking it goes to where the question can be answered.
        return html`
            <article class="lcard" data-reason=${s.reason} data-id=${s.sessionId}
                data-compact=${compact ? '1' : null}
                onClick=${(e) => { if (cardClickOpens(e)) open(); }}>
                <header class="lcard-head">
                    <span class="lcard-dot"></span>
                    <button class="lcard-title" type="button" title="Open this conversation"
                        onClick=${open}>${clip(s.title, 60)}</button>
                    <span class="lcard-where">${s.worktree ? s.worktree.name : s.projectName}</span>
                </header>
                <div class="lcard-line">${liveStatusWords(s, busy, away, { tick: true })}</div>
                ${s.tasks ? taskBar(s.tasks) : null}
                <div class="lcard-facts">
                    ${s.tasks ? html`<span>${`${s.tasks.done} of ${s.tasks.total} tasks`}</span>` : null}
                    <span>${`${s.toolCalls} tool${s.toolCalls === 1 ? '' : 's'}`}</span>
                    ${(r && r.queued) ? queuedBadge(r.queued) : null}
                    ${(s.devservers || []).map(d => this.devChip(d))}
                    <span class="lcard-ago">${ago(s.lastTs)}</span>
                </div>
                ${(compact || !s.ask) ? null : this.ask()}
                ${(compact || !s.headlines.length) ? null : html`
                    <ol class="lcard-log">${s.headlines.slice(-lines).map((h, i) =>
                        html`<li key=${i} title=${h.text}>${clip(h.text, 74)}</li>`)}</ol>`}
                ${compact ? null : this.composer(busy, away)}
                ${(!compact && (!strip || busy)) ? html`
                    <div class="lcard-acts">
                        ${strip ? null : html`<button class="lbtn" type="button" onClick=${open}>Open</button>`}
                        ${busy ? html`<${StopButton} cls="lbtn" sessionId=${s.sessionId} reset=${s.sig} />` : null}
                    </div>` : null}
            </article>`;
    }

    /**
     * A line to write back to the session, on the card.
     *
     * The common thing to want from this view is a sentence — "yes, carry on",
     * "try the other one" — to a session you are not reading. Making that a trip
     * through the conversation and back is most of the reason the view would go
     * unused.
     *
     * A session running under something that is not this bridge does not get one.
     * That is the same rule as the composer lock, and for the same reason: sending
     * would put a second process on one transcript. The card says so and hands
     * over to the conversation, where the branch is offered properly — a fork is
     * too big a thing to do from a tile by accident.
     */
    composer(busy, away) {
        const { s } = this.props;
        if (away) {
            return html`<div class="lsend locked"
                title=${'Sending from here would put a second process on this '
                    + 'session\'s transcript. Open it to branch off a copy.'}
                ><span>Running elsewhere — open to branch.</span></div>`;
        }
        const sending = !!this.state.sending;
        // The draft is held in `state.live.drafts` rather than in the DOM, so it
        // outlives the card. The box is controlled by it: a render passes the
        // value the box already has, and Preact leaves the caret alone.
        return html`
            <div class="lsend">
                <textarea class="lsend-box" rows=${1}
                    placeholder=${busy ? 'Queue a message…' : 'Send a message…'}
                    aria-label=${`Message ${s.title}`}
                    data-send-for=${s.sessionId}
                    value=${state.live.drafts.get(s.sessionId) || ''}
                    disabled=${sending}
                    ref=${noteFreshBox}
                    onInput=${(e) => {
                        state.live.drafts.set(s.sessionId, e.currentTarget.value);
                        grow(e.currentTarget, 30, 84);
                    }}
                    onKeyDown=${(e) => {
                        // The same rule as the main composer, from the same
                        // setting: a card's box is a composer with less room, and
                        // having Enter mean two different things depending on
                        // which box you are in would be worse than either mode.
                        if (!enterSends(e)) return;
                        e.preventDefault();
                        this.send(e.currentTarget);
                    }}></textarea>
                <button class="lbtn ok lsend-go" type="button"
                    title=${busy ? 'Add to this session\'s queue' : 'Send to this session'}
                    disabled=${sending}
                    onClick=${(e) => this.send(e.currentTarget.parentElement.querySelector('.lsend-box'))}
                    >${busy ? 'Queue' : 'Send'}</button>
            </div>`;
    }

    async send(box) {
        const { s } = this.props;
        const text = box.value.trim();
        if (!text || this.state.sending) return;

        this.setState({ sending: true });
        try {
            const r = await post(`/api/sessions/${s.sessionId}/send`, {
                text,
                // Carried, not defaulted. The send route turns a missing mode into
                // `auto`, and pool.ensure replaces the process when the mode it is
                // given differs from the one it is in — so saying nothing here
                // would restart a session that was running in acceptEdits or plan.
                permissionMode: s.permissionMode || undefined,
            });
            state.live.drafts.delete(s.sessionId);
            // The render that follows writes the emptied value; the height is
            // the one thing Preact does not own on this box.
            box.value = '';
            grow(box, 30, 84);
            // Same rule as the composer: only a message that reached the process
            // needs holding, since a queued one is on the bridge and comes back by
            // itself if the process dies.
            if (!r.queued) state.unsent.set(s.sessionId, text);
            toast(r.queued
                ? `Queued for “${clip(s.title, 32)}”.`
                : `Sent to “${clip(s.title, 32)}”.`, 'ok', 3000);
        } catch (err) {
            toast(`Could not send: ${err.message}`, 'error');
        } finally {
            this.setState({ sending: false });
        }
    }

    /**
     * The ask, on the card.
     *
     * A tool ask is answered here — that is the single best reason for this view
     * to exist, and it is the common case by a wide margin. A plan or a set of
     * questions is not: the answer is a choice made against text that does not
     * fit in a tile, and offering two buttons against a plan nobody has read is
     * worse than a button that goes and shows it. Same judgement the notification
     * actions already make.
     */
    ask() {
        const { s } = this.props;
        const ask = s.ask;
        const kind = ask.kind || 'tool';
        const what = kind === 'tool'
            ? (toolSummary({ name: ask.tool, input: ask.input }) || ask.displayName)
            : askBody(ask, kind);
        const off = this.state.answering !== undefined && this.state.answering === s.sig;

        return html`
            <div class=${`lask lask-${kind}`}>
                <div class="lask-what">
                    <b>${kind === 'tool' ? ask.displayName : ASK_HEAD[kind].name}</b>
                    ${what ? html`<span>${clip(what, 90)}</span>` : null}
                </div>
                <div class="lask-acts">
                    ${kind === 'tool' ? [
                        html`<button key="allow" class="lbtn ok" type="button" disabled=${off}
                            onClick=${() => this.answer({ decision: 'allow' })}>Allow</button>`,
                        html`<button key="always" class="lbtn" type="button" disabled=${off}
                            title=${`Allow ${ask.displayName} for the rest of this session`}
                            onClick=${() => this.answer({ decision: 'allow-always' })}>Always</button>`,
                        html`<button key="deny" class="lbtn no" type="button" disabled=${off}
                            onClick=${() => this.answer({ decision: 'deny' })}>Deny</button>`,
                    ] : html`<button class="lbtn ok" type="button"
                        onClick=${() => openSession(s.sessionId)}>Answer →</button>`}
                </div>
            </div>`;
    }

    async answer(payload) {
        const { s } = this.props;
        this.setState({ answering: s.sig });
        try {
            await answerAskFor(s.sessionId, s.ask.requestId, payload);
        } catch (err) {
            toast(`Could not answer: ${err.message}`, 'error');
            this.setState({ answering: undefined });
        }
    }

    /**
     * A port this session has something answering on, as a chip that shows it —
     * in DevBrowser or in the preview, by Settings.
     *
     * Not the channel strip's `openInDevBrowser`, which writes progress into a
     * separate "Open" button it is given — handing it the chip's own label made a
     * successful click rename `:5006` to `Open`.
     */
    devChip(d) {
        const busy = !!(this.state.chips && this.state.chips[d.port]);
        return html`<button key=${`chip-${d.port}`} class=${busy ? 'lchip busy' : 'lchip'} type="button"
            title=${openTitle(d)} disabled=${busy}
            onClick=${() => this.openChip(d)}
            >${`:${d.port}`}${d.title ? html`<i>${clip(d.title, 16)}</i>` : null}</button>`;
    }

    async openChip(d) {
        const { s } = this.props;
        const mark = (on) => this.setState(({ chips }) => ({ chips: { ...chips, [d.port]: on } }));
        mark(true);
        try {
            // Over the board, or over that card's session as though it had been
            // opened and the chip clicked there — preview.overLive.
            const overLive = BOOT_PREFS.preview.overLive !== false;
            if (!overLive && !opensInDevBrowser() && s && d.http !== false
                && (!state.current || state.current.sessionId !== s.sessionId)) {
                await openSession(s.sessionId);
            }
            await openPreview({
                port: d.port,
                title: d.title || null,
                // Name the tab if the transcript knew what it was and DevBrowser
                // did not.
                devbrowserTitle: d.owned ? undefined : d.title || undefined,
                http: d.http,
                from: overLive ? 'live' : 'session',
            });
        } catch (err) {
            toast(`Could not open :${d.port}. ${err.message}`, 'error');
        } finally {
            mark(false);
        }
    }
}

/**
 * Whether a click on a card was meant as "open this session".
 *
 * The card is one big target, which is what you want when the alternative is
 * hitting a line of text — but everything on it that does something of its own
 * has to keep doing it. Allowing, denying, stopping a turn or opening a dev
 * server are not "take me there", and neither is putting the cursor in the
 * message box or dragging across a line to copy it.
 */
function cardClickOpens(e) {
    if (e.target.closest('button, a, input, textarea, select, label, .lsend, .lask')) return false;
    // Selecting text on a card ends in a click; that should leave the selection
    // alone rather than navigating away from it.
    const picked = window.getSelection();
    return !(picked && picked.type === 'Range' && String(picked).trim());
}
