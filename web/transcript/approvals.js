// A blocked turn: the permission card, the plan pane and the question dock,
// and sending the answer back to the bridge.
//
// **The question dock and the plan footer are drawn with Preact.** Both used to
// be emptied and built again on every redraw, which threw away whatever you had
// half done in them — picked options, a sentence typed into Other, a note to a
// plan, the focus, a click whose mouseup landed on a button that was no longer in
// the document. The dock dodged that with a "keep" check and a `dataset.request`
// on the node; now a redraw of the same ask is a diff, and the dock is keyed by
// requestId, so only a *different* question starts it fresh. web/rail.js has the
// pattern and the reasons.
//
// What moved into `state` so no Preact-owned node is edited by hand:
// `askDockFor` (which question is mounted — was `dataset.request`), `askPending`
// (an answer is in flight, so the buttons draw disabled — was a loop setting
// `.disabled`), and `planFeedback` (the plan's feedback box is open). The answers
// themselves are the dock's own hook state: nothing outside it reads them until
// it sends them. The containers — `#ask-dock`, `#plan-pane` — are markup, not
// Preact's, so their `hidden`, `aria-label` and `dataset.pending` are still set
// here directly, and web/motion.js animates them.
//
// Order matters when the dock opens: render, then `grow` (which unhides it and
// measures what it holds), then focus — an element still `hidden` takes no focus.
//
// **The permission card stays `el()`.** It is a row of the transcript log, and
// web/transcript/window.js moves the log's children about; it is built once per
// request and never redrawn in place, so a diff would buy it nothing. The plan
// document stays rendered markdown (`innerHTML`), outside the footer's container.
//
// This imports app.js and sibling modules here, which import it back. That is
// safe only because nothing in this file reads an imported binding while the
// module is evaluating — every use is inside a function called later. Keep it
// that way: a top-level `const X = someImport(...)` runs before app.js's body
// and throws in the temporal dead zone, and only loading the page shows it.

import { html, render, useLayoutEffect, useRef, useState } from '../vendor/preact.js';
import { post } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { clip } from '../format.js';
import { renderMarkdown } from '../markdown.js';
import { state } from '../state.js';
import { paintPerm, scrollToEnd } from '../app.js';
import { closeFind } from './find.js';
import { toolSummary } from './tools.js';
import { exit, grow, isLeaving, isUp, present } from '../motion.js';

// ── approvals, plans and questions ───────────────────────────────────────
// A blocked turn, never a toast: toasts are dismissible and this is not — the
// turn is waiting on the answer.
//
// Three things arrive down this channel and only one of them is a permission,
// so each gets the surface its answer actually needs:
//
//   tool      may I run this? — yes, yes-always, or no. One line about one
//             call, and where in the transcript it happened is part of what
//             you are judging, so it stays a card at the foot of the log.
//   question  a multiple-choice question, or several. Docked above the
//             composer, one at a time, everything about each option open.
//   plan      a document. It takes the conversation over, because reading one
//             through a card-sized porthole is how plans get approved unread.
//             Turning it down is feedback, not a refusal, so there is
//             somewhere to say what was wrong with it.
//
// One ask per session at a time — the bridge guarantees that — so exactly one
// of the three surfaces is ever up, and renderAsk clears all of them first.

const DECISION_WORD = {
    allow: 'Allowed.', 'allow-always': 'Allowed for the rest of this session.',
    deny: 'Denied.', stopped: 'Stopped before it was approved.',
    cancelled: 'Withdrawn — the turn ended.',
    superseded: 'Replaced by a later request.',
    'auto-denied': 'Denied automatically — nobody answered.',
    abandoned: 'The Claude process exited before this was answered.',
    'plan-approved': 'Approved.',
    'plan-approved-note': 'Approved, with a note to bear in mind.',
    'plan-rejected': 'Sent back for more planning.',
    answered: 'Answered.',
    dismissed: 'Dismissed — Claude carries on unaided.',
};

/** Head words per kind: what the card calls itself. */
export const ASK_HEAD = {
    plan: { name: 'Plan', title: 'ready to start' },
    question: { name: 'Question', title: 'waiting on you' },
};

/** Don't fire single-key shortcuts at somebody who is writing a sentence. */
export const isTyping = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

/**
 * A plan waiting in the transcript of a session this bridge does not own.
 *
 * `ExitPlanMode` is a tool call like any other, so the moment Claude asks the
 * question the call — plan text and all — is in the JSONL, and it stays
 * `pending` until the answer produces a result. Any window reading the file can
 * therefore *read* a plan belonging to a session running somewhere else: the
 * everyday window, a second window, an agent's dev bridge.
 *
 * Answering is a different matter and deliberately not attempted here. The
 * control request lives in the process that raised it, and only the bridge that
 * owns that process can respond — which is why what comes back is marked
 * read-only and the view drops its buttons.
 *
 * A live runner here is the authority on what it is blocked on, so this is only
 * consulted when there is no runner. Otherwise a plan just approved would
 * reappear read-only for the moment between the answer and its tool result.
 */
function transcriptPlan() {
    if (!state.current || state.runner) return null;
    let found = null;
    for (const id of state.plans) {
        const entry = state.tools.get(id);
        if (!entry || entry.ev.status !== 'pending') continue;
        const { ev } = entry;
        if (!found || Date.parse(ev.ts) >= Date.parse(found.ts)) found = ev;
    }
    if (!found) return null;
    return {
        // Stable across ticks, and unmistakable for a real request id — nothing
        // may be POSTed against it.
        requestId: `transcript:${found.id}`,
        kind: 'plan',
        tool: 'ExitPlanMode',
        displayName: 'ExitPlanMode',
        input: found.input || {},
        readOnly: true,
    };
}

/**
 * Settle what the session is blocked on: the live ask if we own the process,
 * and otherwise whatever the transcript says is still waiting.
 */
export function refreshAsk(runnerAsk) {
    const ask = runnerAsk || transcriptPlan();
    const same = ask && state.ask && ask.requestId === state.ask.requestId;
    // Redraw on any change, and also when the surface should be up but is not —
    // coming back from a subagent leaves the pane without one. Never otherwise:
    // this runs on every status tick and every tail. The dock and the plan footer
    // would survive a redraw now, but the plan document, its scroll and the
    // focus rules around them are cheaper never to replay.
    if (!same || (ask && !askShowing())) {
        state.ask = ask;
        renderAsk();
    }
}

/** Is the surface for the ask on screen already? */
const askShowing = () => Boolean(
    liveCard() || isUp(dom.askDock) || isUp(dom.planPane));

/** Whichever element is currently carrying the ask, for dimming. */
function askRoot() {
    const kind = state.ask && state.ask.kind;
    if (kind === 'plan') return dom.planPane;
    if (kind === 'question') return dom.askDock;
    return liveCard();
}

/** Show, replace or clear whatever the session is blocked on. */
export function renderAsk() {
    const ask = state.ask;
    const kind = ask && !state.agent ? (ask.kind || 'tool') : null;

    // What is going away plays out, and what is staying is redrawn in place. A
    // card replaced by another card is swapped outright — the new one has its own
    // entrance — but one that is simply answered closes its gap in the log.
    const old = liveCard();
    if (old) {
        if (kind === 'tool') old.remove();
        else exit(old, { as: 'reveal', collapse: true });
    }
    // An answer in flight belongs to its request; a redraw of that same request
    // keeps it dimmed and its buttons dead, so it cannot be sent twice.
    if (!ask || state.askPending !== ask.requestId) state.askPending = null;
    if (!state.askPending) {
        delete dom.askDock.dataset.pending;
        delete dom.planPane.dataset.pending;
    }
    delete dom.planPane.dataset.collapsed;

    // The dock's controls are where the answers live, so it is emptied only
    // once it is no longer the dock for the ask in hand. Going to read a
    // subagent hides it, and must not cost you the options you had picked.
    const keep = ask && ask.kind === 'question' && state.askDockFor === ask.requestId;
    if (!keep) state.askDockFor = null;
    if (kind !== 'question') {
        // Shrunk with its last question still in it, and emptied once shut —
        // unless a question has been put back in it by then.
        grow(dom.askDock, false, { onGone: () => {
            if (!state.askDockFor) render(null, dom.askDock);
        } });
    }
    if (kind !== 'plan') present(dom.planPane, false, { as: 'arrive' });

    if (!kind) return;
    if (kind === 'plan') renderPlanPane(ask);
    else if (kind === 'question') renderQuestionDock(ask, keep);
    else renderToolCard(ask);
}

/** Redraw whichever Preact surface carries the ask — no motion, no focus. */
function paintAsk() {
    const kind = state.ask && state.ask.kind;
    if (kind === 'plan') paintPlanFoot();
    else if (kind === 'question') paintDock();
}

/** The permission card in the log, not counting one playing its way out. */
function liveCard() {
    return [...dom.log.querySelectorAll('.perm')].find(n => !isLeaving(n)) || null;
}

/** "May I run this?" — the original card, in the original place. */
function renderToolCard(ask) {
    const card = el('div', { class: 'perm perm-tool-ask', tabindex: '0', role: 'group',
        'aria-label': `Permission needed for ${ask.displayName}` });

    card.append(el('div', { class: 'perm-head' },
        el('span', { class: 'perm-tool' }, ask.displayName),
        el('span', { class: 'perm-title' }, 'permission needed')));

    if (ask.agentId) card.append(el('div', { class: 'perm-why' }, 'Asked by a subagent.'));

    // toolSummary is the collapsed-row text of an ordinary tool block. Shape
    // the ask like the event it reads and the two render identically.
    card.append(el('div', { class: 'perm-arg' },
        toolSummary({ name: ask.tool, input: ask.input }) || ask.description || ''));

    if (ask.reason) card.append(el('div', { class: 'perm-why' }, clip(ask.reason, 220)));

    card.append(el('div', { class: 'perm-btns' },
        el('button', { class: 'perm-btn allow', type: 'button',
            onclick: () => answerAsk({ decision: 'allow' }) },
            'Allow ', el('kbd', {}, 'Y')),
        el('button', { class: 'perm-btn', type: 'button',
            onclick: () => answerAsk({ decision: 'allow-always' }) },
            `Allow ${ask.displayName} all session `, el('kbd', {}, 'A')),
        el('button', { class: 'perm-btn deny', type: 'button',
            onclick: () => answerAsk({ decision: 'deny' }) },
            'Deny ', el('kbd', {}, 'N')),
    ));

    card.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
        const k = e.key.toLowerCase();
        const decision = k === 'y' ? 'allow' : k === 'a' ? 'allow-always' : k === 'n' ? 'deny' : null;
        if (!decision) return;
        e.preventDefault();
        answerAsk({ decision });
    });

    dom.log.append(card);

    // Taking focus makes the single-key answers work without a click, but only
    // when the user is actually here — stealing focus from another window, or
    // from something being typed, would be worse than a click.
    if (document.hasFocus() && !dom.input.matches(':focus')) card.focus({ preventScroll: true });
    if (state.pinned) scrollToEnd(false);
}

/**
 * A plan, and the two things approving one actually decides: that the work
 * starts, and what it is allowed to do once it has.
 *
 * The session is in plan mode while this is up, so approving without changing
 * the mode would agree to the plan and then refuse every edit in it. That is
 * why these are one button and not two steps.
 *
 * The pane itself is markup, not built here — it persists across renders, so
 * its listeners are wired once at the foot of web/app.js rather than stacked up
 * one deep per status tick. Only its footer is Preact's.
 */
function renderPlanPane(ask) {
    dom.planDoc.innerHTML = renderMarkdown((ask.input && ask.input.plan) || ask.description || '');
    dom.planAgent.hidden = !ask.agentId;
    dom.planTitle.textContent = ask.readOnly ? 'waiting in another window' : 'ready to start';
    dom.planPane.dataset.readonly = ask.readOnly ? '1' : '';
    if (!ask.readOnly) delete dom.planPane.dataset.readonly;

    // A new plan always arrives open, at the top, with no note started. Setting
    // one aside is a decision about that plan, and it should not carry over to
    // the next one — but a redraw of the same plan must not undo where you were
    // reading or what you were typing.
    const fresh = state.planFor !== ask.requestId;
    if (fresh) {
        state.planFor = ask.requestId;
        state.planAside = false;
        state.planFeedback = null;
    }

    paintPlanFoot();
    present(dom.planPane, true, { as: 'arrive' });
    closeFind();
    setPlanAside(state.planAside, !dom.planFoot.contains(document.activeElement));
    if (fresh && !state.planAside) dom.planBody.scrollTop = 0;
}

function paintPlanFoot() {
    const ask = state.ask;
    if (!ask || ask.kind !== 'plan') return;
    render(planFoot(ask, state.askPending === ask.requestId, state.planFeedback), dom.planFoot);
}

/**
 * The plan's footer: the answers, or the feedback box standing in for them.
 *
 * `auto` is the default because it is how these sessions run when you are
 * sitting in front of one: Claude judges each call and asks when a call warrants
 * it. Blanket-accepting edits is the deliberate second choice.
 *
 * The plan view's chrome — Set aside, and the bar that brings the plan back —
 * lives in the same section as the answer and is not an answer: it says nothing
 * to the bridge and stays live while an answer is in flight. That is why
 * `pending` reaches these buttons and nothing else in the pane.
 */
function planFoot(ask, pending, feedback) {
    // Read here, answered there. Which window is not something that can be said
    // — the registry names the process, not the bridge in front of it — so it
    // says what is true and stops.
    if (ask.readOnly) {
        return html`<div key="elsewhere" class="plan-elsewhere"><span class="plan-elsewhere-mark">◇</span>${
            'This session is running in another window. The plan can be read here,'
            + ' and has to be approved where it is running.'}</div>`;
    }
    return [
        html`<div key="btns" class="perm-btns" hidden=${!!feedback}>
            <button class="perm-btn allow" type="button" disabled=${pending}
                title="Start work, asking about calls that warrant it"
                onClick=${() => answerAsk({ decision: 'allow', mode: 'auto' })}>Approve <kbd>Y</kbd></button>
            <button class="perm-btn" type="button" disabled=${pending}
                title="Start work, and let file edits through without asking"
                onClick=${() => answerAsk({ decision: 'allow', mode: 'acceptEdits' })}>Approve — auto-accept edits <kbd>A</kbd></button>
            <button class="perm-btn" type="button" disabled=${pending}
                title="Approve the plan, with something to bear in mind while doing it"
                onClick=${() => openFeedback('approve')}>Approve with feedback <kbd>F</kbd></button>
            <button class="perm-btn deny" type="button" disabled=${pending}
                onClick=${() => openFeedback('reject')}>Keep planning <kbd>N</kbd></button>
        </div>`,
        feedback
            ? html`<${Feedback} key=${`fb:${ask.requestId}:${feedback}`} how=${feedback} pending=${pending} />`
            : null,
        html`<div key="why" class="perm-why">Approving leaves plan mode and sets the permission mode under the composer.</div>`,
    ];
}

/**
 * Fold the plan away to a line, or open it back up.
 *
 * Set aside, the ask is still outstanding — this is not an answer and does not
 * tell the bridge anything. It is for the times the plan only makes sense
 * against what was said before it, which is directly underneath.
 *
 * @param {boolean} aside
 * @param {boolean} [focus] false to leave the focus where it is — a redraw must
 *   not pull it out of a note half typed in the footer
 */
export function setPlanAside(aside, focus = true) {
    state.planAside = aside;
    if (aside) dom.planPane.dataset.collapsed = '1';
    else delete dom.planPane.dataset.collapsed;
    // Focus so Y/A/F/N answer without a click — same rule as everywhere else,
    // never taking it from another window or from something being typed.
    if (focus && !aside && document.hasFocus() && !dom.input.matches(':focus')) {
        dom.planPane.focus({ preventScroll: true });
    }
}

/**
 * Say something about the plan — whether or not you are approving it.
 *
 * Both answers are a sentence rather than a verdict, and they reach the model
 * by different routes because the protocol gives them different routes. Turned
 * down, the note is the tool's error, which is where the model reads a refusal
 * — so "too broad, do the parser first" is planned against, while a silent no
 * is usually just re-sent shorter. Approved, it is appended to the plan itself,
 * because a condition you attach to a yes is part of what was agreed to.
 *
 * It swaps the footer's button row for a box in place, so the answer stays where
 * the eye already is. Whether it is open is `state.planFeedback`, which is also
 * what the pane's keyboard handler in web/app.js asks.
 *
 * @param {'approve'|'reject'} how
 */
export function openFeedback(how) {
    const ask = state.ask;
    if (!ask || ask.kind !== 'plan' || ask.readOnly || state.planFeedback) return;
    state.planFeedback = how;
    paintPlanFoot();
}

/** The feedback box. Its text is the textarea's own: nothing reads it until it is sent. */
function Feedback({ how, pending }) {
    const approving = how === 'approve';
    const ta = useRef(null);
    useLayoutEffect(() => { ta.current.focus(); }, []);

    const send = () => {
        const feedback = ta.current.value;
        answerAsk(approving
            ? { decision: 'allow', mode: 'auto', feedback }
            : { decision: 'deny', feedback });
    };
    const cancel = () => {
        state.planFeedback = null;
        paintPlanFoot();
        dom.planPane.focus({ preventScroll: true });
    };
    const onKeyDown = (e) => {
        if (e.key !== 'Escape' && !(e.key === 'Enter' && !e.shiftKey)) return;
        e.preventDefault();
        // The surface behind this box answers Escape too — by setting a plan
        // aside. Closing the box must not also do that, and cancel() has
        // already removed the box the surface would have tested for.
        e.stopPropagation();
        if (e.key === 'Escape') cancel(); else send();
    };

    return html`<div class="perm-feedback">
        <textarea ref=${ta} class="perm-fb" rows="3" onKeyDown=${onKeyDown}
            aria-label=${approving ? 'What should Claude bear in mind?' : 'What should change about this plan?'}
            placeholder=${approving
                ? 'Anything to bear in mind? Enter to approve, Esc to go back.'
                : 'What should change? Enter to send, Esc to go back.'}></textarea>
        <div class="perm-btns">
            <button class=${`perm-btn ${approving ? 'allow' : 'deny'}`} type="button" disabled=${pending}
                onClick=${send}>${approving ? 'Approve with this note ' : 'Send it back '}<kbd>⏎</kbd></button>
            <button class="perm-btn" type="button" disabled=${pending} onClick=${cancel}>Cancel</button>
        </div>
    </div>`;
}

/**
 * Open the dock for a question. `keep` is the same question coming back — from
 * reading a subagent, say — and it is a redraw, not a new start: the answers are
 * the mounted dock's state, and the key keeps that dock.
 */
function renderQuestionDock(ask, keep) {
    state.askDockFor = ask.requestId;
    paintDock();
    grow(dom.askDock, true);
    if (keep) return;
    dom.askDock.setAttribute('aria-label', 'A question waiting for your answer');
    focusQuestion();
}

function paintDock() {
    const ask = state.ask;
    if (!ask || state.askDockFor !== ask.requestId) return;
    render(html`<${QuestionDock} key=${ask.requestId} ask=${ask}
        pending=${state.askPending === ask.requestId} />`, dom.askDock);
}

/**
 * Landing on the first control of the question on show makes the arrow keys pick
 * options and Enter send, so a set of questions can be answered without the mouse.
 */
function focusQuestion() {
    const first = dom.askDock.querySelector('.perm-q:not([hidden]) input');
    if (first && document.hasFocus() && !dom.input.matches(':focus')) {
        first.focus({ preventScroll: true });
    }
}

/** One question's answer, as the string the model will be handed. Several
 *  selections read back as a list, which is how they were asked. */
function answerOf(q, a) {
    const chosen = (q.options || []).filter((_, oi) => a.picks.includes(oi)).map(o => o.label || '');
    const other = a.other ? a.text.trim() : '';
    if (other) chosen.push(other);
    return chosen.join(', ');
}

/**
 * A multiple-choice question, or several, docked above the composer.
 *
 * Native radios and checkboxes rather than clickable divs: arrow keys, space,
 * groups and labels all work without being reimplemented, and a question is
 * exactly the moment not to have reinvented a form control. Every question has
 * an "Other" row, because the honest answer is often none of the above.
 *
 * All of them are drawn at once and all of them stay in the DOM — only the one
 * you are on is shown. The answers are this component's state, one entry per
 * question, and the controls are drawn from it.
 */
function QuestionDock({ ask, pending }) {
    const questions = (ask.input && ask.input.questions) || [];
    const n = questions.length;
    const [answers, setAnswers] = useState(() => questions.map(() => ({ picks: [], other: false, text: '' })));
    const [at, setAt] = useState(0);
    const [, bump] = useState(0);
    // Read by the auto-advance timer, which outlives the render that set it.
    const live = useRef({ at: 0, answers });
    live.current.answers = answers;
    // A question moves you on once. Coming back to change an answer must not
    // fling you forward again — that is the moment you wanted to stay.
    const advanced = useRef(new Set());
    const timers = useRef([]);
    const body = useRef(null);
    const landing = useRef(false);

    useLayoutEffect(() => () => timers.current.forEach(clearTimeout), []);
    useLayoutEffect(() => {
        if (!landing.current) return;
        landing.current = false;
        body.current.scrollTop = 0;
        focusQuestion();
    });

    const done = answers.filter((a, qi) => answerOf(questions[qi], a)).length;
    // Claude asked all of them; answering some and leaving the rest to guesswork
    // is the outcome this dock exists to avoid. Which ones are still open is on
    // the dots and spelled out beside the button.
    const complete = done === n;

    function show(i) {
        if (i < 0 || i >= n) return;
        live.current.at = i;
        landing.current = true;
        setAt(i);
        bump(x => x + 1);   // land again even when already there
    }

    /** The next question with no answer yet, wrapping — or -1 if there is none. */
    function nextOpen(from) {
        const list = live.current.answers;
        for (let k = 1; k < n; k++) {
            const i = (from + k) % n;
            if (!answerOf(questions[i], list[i])) return i;
        }
        return -1;
    }

    function picked(qi, q) {
        if (q.multiSelect || advanced.current.has(qi)) return;
        advanced.current.add(qi);
        // Long enough that the option you chose is seen to be chosen before the
        // question changes under you — at half this it read as the question
        // being yanked away rather than as an answer landing.
        timers.current.push(setTimeout(() => {
            if (live.current.at !== qi) return;
            const to = nextOpen(qi);
            if (to >= 0) show(to);
        }, 450));
    }

    function collect() {
        const out = {};
        questions.forEach((q, qi) => {
            const answer = answerOf(q, answers[qi]);
            if (answer) out[q.question] = answer;
        });
        return out;
    }

    const send = () => answerAsk({ decision: 'allow', answers: collect() });
    const setOne = (qi, fn) => setAnswers(list => list.map((a, i) => (i === qi ? fn(a) : a)));

    const onKeyDown = (e) => {
        if (e.ctrlKey || e.metaKey) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            if (pending || !complete) return;
            e.preventDefault();
            send();
        // Plain arrows belong to the radio group under the cursor; the modifier
        // is what makes these about the set rather than the options.
        } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            show(at + (e.key === 'ArrowRight' ? 1 : -1));
        }
    };

    const group = (q, qi) => {
        const a = answers[qi];
        const name = `perm-q${qi}`;
        const type = q.multiSelect ? 'checkbox' : 'radio';
        const options = (q.options || []).map((opt, oi) => {
            const id = `${name}-o${oi}`;
            const onChange = (e) => {
                const on = e.currentTarget.checked;
                if (q.multiSelect) {
                    setOne(qi, x => ({ ...x,
                        picks: on ? [...x.picks, oi].sort((l, r) => l - r) : x.picks.filter(p => p !== oi) }));
                } else setOne(qi, x => ({ ...x, picks: [oi], other: false }));
                picked(qi, q);
            };
            return html`<label key=${oi} class="perm-opt" for=${id}><input type=${type} name=${name} id=${id}
                value=${opt.label || ''} checked=${a.picks.includes(oi)} onChange=${onChange} /><span class="perm-opt-body">
                <span class="perm-opt-label">${opt.label || ''}</span>
                ${opt.description ? html`<span class="perm-opt-desc">${opt.description}</span>` : null}
                ${/* Simply there. A preview is what you are comparing, and one
                     that only appears under the pointer cannot be compared. */
                  opt.preview ? html`<pre class="perm-opt-preview">${opt.preview}</pre>` : null}
            </span></label>`;
        });

        // Choosing "Other" is the one pick that never moves you on: the answer is
        // the sentence you are about to type, not the radio.
        const onOther = (e) => {
            const on = e.currentTarget.checked;
            setOne(qi, x => (q.multiSelect ? { ...x, other: on } : { ...x, picks: [], other: true }));
        };
        // Typing is choosing; making people also click the radio is a trap.
        const onText = (e) => {
            const text = e.currentTarget.value;
            setOne(qi, x => (text.trim()
                ? { ...x, text, other: true, picks: q.multiSelect ? x.picks : [] }
                : { ...x, text }));
        };

        return html`<div key=${qi} class="perm-q" role="group" hidden=${qi !== at}
                aria-label=${q.question || q.header || `Question ${qi + 1}`}>
            <div class="perm-q-head">${q.header ? html`<span class="perm-q-chip">${q.header}</span>` : null}<span class="perm-q-text">${q.question || ''}</span></div>
            ${options}
            <label key="other" class="perm-opt perm-opt-other" for=${`${name}-other`}><input type=${type} name=${name}
                id=${`${name}-other`} checked=${a.other} onChange=${onOther} /><span class="perm-opt-body">
                <span class="perm-opt-label">Other</span>
                <input type="text" class="perm-other" autocomplete="off" value=${a.text} onInput=${onText}
                    aria-label=${`A different answer to "${q.question || ''}"`} placeholder="Something else…" />
            </span></label>
        </div>`;
    };

    const nav = n > 1 ? html`<div class="ask-nav">
        <button class="ask-step" type="button" aria-label="The question before this one"
            disabled=${pending || at === 0} onClick=${() => show(at - 1)}>‹</button>
        <div class="ask-dots">${questions.map((q, qi) => html`<button key=${qi} class="ask-dot" type="button"
            title=${q.header || clip(q.question || '', 60) || `Question ${qi + 1}`}
            aria-label=${`Question ${qi + 1}: ${q.header || q.question || ''}`}
            aria-current=${qi === at ? 'true' : 'false'}
            data-done=${answerOf(q, answers[qi]) ? '1' : undefined}
            disabled=${pending} onClick=${() => show(qi)}></button>`)}</div>
        <span class="ask-nav-count">${`${at + 1} of ${n}`}</span>
        <button class="ask-step" type="button" aria-label="The next question"
            disabled=${pending || at === n - 1} onClick=${() => show(at + 1)}>›</button>
    </div>` : null;

    const left = n - done;
    return html`<div class="ask-dock-inner" onKeyDown=${onKeyDown}>
        <div class="ask-dock-head">
            <span class="perm-tool">Question</span>
            <span class="perm-title">${ask.agentId ? 'from a subagent' : 'waiting on you'}</span>
            <span class="spacer"></span>
            ${nav}
        </div>
        <div class="ask-dock-body" ref=${body}><div class="perm-qs">${questions.map(group)}</div></div>
        <div class="perm-btns">
            <button class="perm-btn allow" type="button" disabled=${pending || !complete}
                onClick=${send}>${n > 1 ? 'Send answers ' : 'Send answer '}<kbd>⏎</kbd></button>
            <button class="perm-btn deny" type="button" disabled=${pending}
                title="Answer nothing and let Claude decide for itself"
                onClick=${() => answerAsk({ decision: 'deny' })}>Skip</button>
            <span class="ask-remain">${left ? `${left} still to answer` : ''}</span>
        </div>
    </div>`;
}

/**
 * Send an answer to a named ask, wherever it is being answered from.
 *
 * Takes the session and the request rather than reading `state.current`, because
 * the live board answers asks belonging to sessions that are not open — which is
 * the point of that view. Throws; the caller decides what to say about it.
 *
 * @param {{decision:'allow'|'allow-always'|'deny', mode?:string,
 *          answers?:object, feedback?:string}} payload
 */
export function answerAskFor(sessionId, requestId, payload) {
    return post(`/api/sessions/${sessionId}/permission`, { requestId, ...payload });
}

/**
 * Send an answer for the session on screen.
 *
 * Only the buttons that answer go dead while it is in flight — the plan footer,
 * not the pane around it, whose Set aside and bring-back bar say nothing to the
 * bridge. Disabling the whole pane once left both dead from the first answered
 * plan onwards. The dock and the footer draw that from `state.askPending`; the
 * permission card is `el()`, so its buttons are set directly.
 *
 * @param {{decision:'allow'|'allow-always'|'deny', mode?:string,
 *          answers?:object, feedback?:string}} payload
 */
export async function answerAsk(payload) {
    const ask = state.ask;
    if (!ask || !state.current) return;
    // Read out of a transcript, not raised by a process here: there is nothing
    // on this bridge to answer, and its requestId is not one.
    if (ask.readOnly) return;
    const root = askRoot();
    const card = (ask.kind || 'tool') === 'tool' ? liveCard() : null;
    const busy = (on) => {
        if (card) for (const b of card.querySelectorAll('button')) b.disabled = on;
        else if (on) state.askPending = ask.requestId;
        else if (state.askPending === ask.requestId) state.askPending = null;
        if (!card && state.ask === ask) paintAsk();
    };
    if (root) root.dataset.pending = '1';
    busy(true);
    try {
        await answerAskFor(state.current.sessionId, ask.requestId, payload);
        if (payload.mode) adoptMode(payload.mode);
    } catch (err) {
        // 409 means another window got there first; the resolved event that
        // follows takes the surface down with the right reason on it.
        toast(`Could not answer: ${err.message}`, 'error');
        if (root) delete root.dataset.pending;
        busy(false);
    }
}

/**
 * Approving a plan decides the mode the work runs in, so the selector has to
 * agree at once rather than after the next status tick — and to keep agreeing
 * once the process behind it has gone.
 *
 * Three caches, and all three have to move together: a mode picked from the
 * dropdown before the plan arrived is spent and must not win afterwards; the
 * per-session record of what a bridge last reported is the only lasting
 * evidence the switch happened; and the summary is corrected so a repaint
 * before the next tick does not flicker back.
 */
function adoptMode(mode) {
    const id = state.current && state.current.sessionId;
    if (!id || !mode) return;
    state.permChoice.delete(id);
    state.runnerMode.set(id, mode);
    state.current.permissionMode = mode;
    paintPerm();
}

/** Take the surface down and leave a line in the transcript saying how it ended. */
export function resolveAsk(outcome) {
    if (!state.ask) return;
    const head = ASK_HEAD[state.ask.kind];
    const tool = head ? head.name : state.ask.displayName;
    state.ask = null;
    renderAsk();
    const word = DECISION_WORD[outcome] || 'Answered.';
    // The transcript will carry the real record; this is only the acknowledgement
    // that the card is gone and why.
    dom.log.append(el('div', { class: 'perm-done' }, `${tool} — ${word}`));
    if (state.pinned) scrollToEnd(false);
}
