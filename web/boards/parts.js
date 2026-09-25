// The small pieces the boards share, as vnodes.
//
// The live board and the task board draw one session in one vocabulary —
// "Waiting for permission", the task bar, the queued badge, the Stop button —
// because a session that says one thing on one board and something else on the
// other is two boards disagreeing about one fact. When both boards built DOM by
// hand those pieces lived beside the live board in app.js; now that both are
// Preact (web/boards/live.js, web/boards/taskboard.js) they live here, where
// neither owns them.
//
// Written the way web/rail.js settled: htm tagged templates, no JSX, keys on list
// children, and no hand edits to a node Preact owns — state that changes a
// button (Stopping…, a clock moving) is component state, not a `textContent`
// write, because Preact diffs against its last vnode and not against the DOM.
//
// Nothing here reads an app.js binding at module top level: this module
// evaluates before app.js's body does.

import { html, render, Component } from '../vendor/preact.js';
import { post } from '../api.js';
import { toast } from '../dom.js';
import { clip, dur } from '../format.js';
import { ICON } from '../icons.js';
import { awayWords, loadDraft, saveDraft } from '../app.js';

/** One of web/icons.js's ICON glyphs, as a vnode. Its icon() is the DOM twin. */
export function icon(name, size = 15) {
    return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none"
        aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICON[name] }}></svg>`;
}

// Containers that have been emptied of their static markup. See paint().
const claimed = new WeakSet();

/**
 * Render into a container that web/index.html may have put placeholder text in.
 *
 * Preact treats whatever is already inside a container on its first render as
 * DOM it might reuse, which is fine for an empty `<div>` and surprising for a
 * `<p>` holding the sentence the page loads with. So the first render into each
 * container clears it, and every render after that is an ordinary diff.
 */
export function paint(container, tree) {
    if (!claimed.has(container)) {
        claimed.add(container);
        container.textContent = '';
    }
    render(tree, container);
}

/** How many messages are waiting behind the turn. Same words the rail uses. */
export function queuedBadge(queued) {
    return html`<span class="wait"
        title=${`${queued} message${queued === 1 ? '' : 's'} waiting to be sent`}
        >${`+${queued} queued`}</span>`;
}

/** A session's task list, as a bar. app.js keeps the DOM twin for the checklist. */
export function taskBar(t) {
    const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
    return html`<div class="tbar" title=${`${t.done} of ${t.total} tasks done`}
        role="progressbar" aria-valuenow=${t.done} aria-valuemin=${0} aria-valuemax=${t.total}
        ><span class="tbar-fill" style=${`width:${pct}%`}></span></div>`;
}

export const ASK_WORD = {
    tool: 'Waiting for permission',
    plan: 'Waiting on a plan',
    question: 'Waiting on a question',
};

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The one line under the title: what it is doing, and for how long.
 *
 * `tick` says whether the turn clock counts up between renders. The live board
 * asks for that — a still clock is how a stuck turn looks — and the task board
 * does not, which is what it always did: its clocks moved when its payload did.
 */
export function liveStatusWords(s, busy, away, { tick = false } = {}) {
    const r = s.runner;
    if (s.ask) {
        return [html`<span class="lstate ask">${ASK_WORD[s.ask.kind] || 'Waiting for you'}</span>`];
    }
    if (r && r.state === 'error') {
        return [html`<span class="lstate err">${clip(r.error || 'The turn failed.', 68)}</span>`];
    }
    if (busy) {
        return [
            html`<span class=${r.retry ? 'lstate warn' : 'lstate'}>${clip(r.activity || 'Working…', 52)}</span>`,
            r.busySince ? html`<${Clock} since=${r.busySince} tick=${tick} />` : null,
        ];
    }
    if (away) {
        // No activity line to give: the runner that would report one belongs to
        // whoever is driving the session, not to us. The headlines say the rest.
        return [html`<span class="lstate quiet">${lower(awayWords(s.live))}</span>`];
    }
    if (s.tasks && s.tasks.current) {
        return [html`<span class="lstate quiet">${clip(s.tasks.current, 60)}</span>`];
    }
    return [html`<span class="lstate quiet">Idle</span>`];
}

// The clocks that count up on the live board's one-second timer.
const ticking = new Set();

/**
 * Move every live turn clock on by a second.
 *
 * Called by the interval showLive starts while the board is on, which is what
 * keeps a board nobody has open from doing this at all. Each clock re-renders
 * only itself — the cards around it are not asked.
 */
export function tickCardClocks() {
    for (const c of ticking) c.forceUpdate();
}

class Clock extends Component {
    componentDidMount() { if (this.props.tick) ticking.add(this); }
    componentDidUpdate() {
        if (this.props.tick) ticking.add(this);
        else ticking.delete(this);
    }
    componentWillUnmount() { ticking.delete(this); }
    render({ since }) {
        return html`<span class="lcard-clock" data-since=${since}>${dur(Date.now() - since)}</span>`;
    }
}

/**
 * Stop a turn from a card. Always the soft stop — the escalation to a kill is
 * armed by pressing Stop twice in the conversation, and a single button on a
 * card several sessions away from the one you are reading is not the place to
 * offer it.
 *
 * A component rather than a function of the button, because "Stopping…" is a
 * state and the button is Preact's. `reset` is the value that, when it changes,
 * gives the button back: the card's `sig` on the live board, the payload's time
 * on the task board. That is when the imperative version got a fresh button, by
 * the card being rebuilt; a stop that did not take then offers itself again
 * rather than sitting at Stopping… for the rest of the turn.
 */
export class StopButton extends Component {
    render({ cls, reset }, { at }) {
        const stopping = at !== undefined && at === reset;
        return html`<button class=${cls} type="button"
            title="Interrupt the turn this session is running"
            disabled=${stopping}
            onClick=${() => this.stop()}>${stopping ? 'Stopping…' : 'Stop'}</button>`;
    }

    async stop() {
        const { sessionId, reset } = this.props;
        this.setState({ at: reset });
        try {
            const r = await post(`/api/sessions/${sessionId}/stop`, {});
            // Whatever never reached the process comes back, exactly as it does in
            // the conversation view — otherwise a queue would vanish silently. One
            // draft holds all of them, joined the way the composer restores them;
            // saving each in turn would leave only the last.
            const dropped = r.dropped || [];
            if (dropped.length) {
                const held = loadDraft(sessionId);
                saveDraft(sessionId, [held, dropped.join('\n\n')].filter(Boolean).join('\n\n'));
                toast(`Stopped. ${dropped.length} unsent message${dropped.length === 1
                    ? ' is' : 's are'} waiting in that session's composer.`, 'info');
            }
        } catch (err) {
            toast(`Could not stop: ${err.message}`, 'error');
            this.setState({ at: undefined });
        }
    }
}
