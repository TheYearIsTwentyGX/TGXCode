// A blocked turn: the permission card, the plan pane and the question dock,
// and sending the answer back to the bridge.
//
// This imports app.js and sibling modules here, which import it back. That is
// safe only because nothing in this file reads an imported binding while the
// module is evaluating — every use is inside a function called later. Keep it
// that way: a top-level `const X = someImport(...)` runs before app.js's body
// and throws in the temporal dead zone, and only loading the page shows it.

import { post } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { clip } from '../format.js';
import { renderMarkdown } from '../markdown.js';
import { state } from '../state.js';
import { paintPerm, scrollToEnd } from '../app.js';
import { closeFind } from './find.js';
import { toolSummary } from './tools.js';

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
    // this runs on every status tick and every tail, and rebuilding the question
    // dock would throw away answers that are half typed.
    if (!same || (ask && !askShowing())) {
        state.ask = ask;
        renderAsk();
    }
}

/** Is the surface for the ask on screen already? */
const askShowing = () => Boolean(
    dom.log.querySelector('.perm') || !dom.askDock.hidden || !dom.planPane.hidden);

/** Whichever element is currently carrying the ask, for dimming. */
function askRoot() {
    const kind = state.ask && state.ask.kind;
    if (kind === 'plan') return dom.planPane;
    if (kind === 'question') return dom.askDock;
    return dom.log.querySelector('.perm');
}

/**
 * The buttons that answer the ask, which is narrower than the element carrying
 * it. The plan view's chrome — Set aside, and the bar that brings the plan back
 * — lives in the same section as the answer, and is not an answer: it says
 * nothing to the bridge and stays live even while an answer is in flight.
 *
 * Disabling by askRoot() instead left both of them dead from the first answered
 * plan onwards, since only the footer is rebuilt for the next one. That is the
 * bug this exists for.
 */
function askControls() {
    if (state.ask && state.ask.kind === 'plan') return dom.planFoot;
    return askRoot();
}

/** Show, replace or clear whatever the session is blocked on. */
export function renderAsk() {
    const old = dom.log.querySelector('.perm');
    if (old) old.remove();
    dom.askDock.hidden = true;
    delete dom.askDock.dataset.pending;
    dom.planPane.hidden = true;
    delete dom.planPane.dataset.pending;
    delete dom.planPane.dataset.collapsed;

    // The dock's controls are where the answers live, so it is emptied only
    // once it is no longer the dock for the ask in hand. Going to read a
    // subagent hides it, and must not cost you the options you had picked.
    const ask = state.ask;
    const keep = ask && ask.kind === 'question' && dom.askDock.dataset.request === ask.requestId;
    if (!keep) {
        dom.askDock.replaceChildren();
        delete dom.askDock.dataset.request;
    }

    if (!ask || state.agent) return;

    const kind = ask.kind || 'tool';
    if (kind === 'plan') renderPlanPane(ask);
    else if (kind === 'question') {
        if (keep) dom.askDock.hidden = false;
        else renderQuestionDock(ask);
    } else renderToolCard(ask);
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
 * one deep per status tick.
 */
function renderPlanPane(ask) {
    dom.planDoc.innerHTML = renderMarkdown((ask.input && ask.input.plan) || ask.description || '');
    dom.planAgent.hidden = !ask.agentId;
    dom.planTitle.textContent = ask.readOnly ? 'waiting in another window' : 'ready to start';
    dom.planPane.dataset.readonly = ask.readOnly ? '1' : '';
    if (!ask.readOnly) delete dom.planPane.dataset.readonly;

    // A new plan always arrives open. Setting one aside is a decision about
    // that plan, and it should not carry over to the next one.
    if (state.planFor !== ask.requestId) {
        state.planFor = ask.requestId;
        state.planAside = false;
    }

    dom.planFoot.replaceChildren(...(ask.readOnly
        // Read here, answered there. Which window is not something that can be
        // said — the registry names the process, not the bridge in front of it —
        // so it says what is true and stops.
        ? [el('div', { class: 'plan-elsewhere' },
            el('span', { class: 'plan-elsewhere-mark' }, '◇'),
            'This session is running in another window. The plan can be read here,'
            + ' and has to be approved where it is running.')]
        : [planButtons(), el('div', { class: 'perm-why' },
            'Approving leaves plan mode and sets the permission mode under the composer.')]));

    dom.planPane.hidden = false;
    closeFind();
    setPlanAside(state.planAside);
    if (!state.planAside) dom.planBody.scrollTop = 0;
}

/** `auto` is the default because it is how these sessions run when you are
 *  sitting in front of one: Claude judges each call and asks when a call
 *  warrants it. Blanket-accepting edits is the deliberate second choice. */
function planButtons() {
    return el('div', { class: 'perm-btns' },
        el('button', { class: 'perm-btn allow', type: 'button',
            title: 'Start work, asking about calls that warrant it',
            onclick: () => answerAsk({ decision: 'allow', mode: 'auto' }) },
            'Approve ', el('kbd', {}, 'Y')),
        el('button', { class: 'perm-btn', type: 'button',
            title: 'Start work, and let file edits through without asking',
            onclick: () => answerAsk({ decision: 'allow', mode: 'acceptEdits' }) },
            'Approve — auto-accept edits ', el('kbd', {}, 'A')),
        el('button', { class: 'perm-btn', type: 'button',
            title: 'Approve the plan, with something to bear in mind while doing it',
            onclick: () => openFeedback(dom.planFoot, 'approve') },
            'Approve with feedback ', el('kbd', {}, 'F')),
        el('button', { class: 'perm-btn deny', type: 'button',
            onclick: () => openFeedback(dom.planFoot, 'reject') },
            'Keep planning ', el('kbd', {}, 'N')),
    );
}

/**
 * Fold the plan away to a line, or open it back up.
 *
 * Set aside, the ask is still outstanding — this is not an answer and does not
 * tell the bridge anything. It is for the times the plan only makes sense
 * against what was said before it, which is directly underneath.
 */
export function setPlanAside(aside) {
    state.planAside = aside;
    if (aside) dom.planPane.dataset.collapsed = '1';
    else delete dom.planPane.dataset.collapsed;
    // Focus so Y/A/F/N answer without a click — same rule as everywhere else,
    // never taking it from another window or from something being typed.
    if (!aside && document.hasFocus() && !dom.input.matches(':focus')) {
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
 * It swaps the button row in place, wherever that row lives — the plan view's
 * pinned footer today — so the answer stays where the eye already is.
 *
 * @param {HTMLElement} host the element holding the `.perm-btns` row
 * @param {'approve'|'reject'} how
 */
export function openFeedback(host, how) {
    const btns = host.querySelector('.perm-btns');
    if (!btns || host.querySelector('.perm-feedback')) return;
    const approving = how === 'approve';

    const ta = el('textarea', { class: 'perm-fb', rows: '3',
        'aria-label': approving ? 'What should Claude bear in mind?'
            : 'What should change about this plan?',
        placeholder: approving
            ? 'Anything to bear in mind? Enter to approve, Esc to go back.'
            : 'What should change? Enter to send, Esc to go back.' });
    const send = () => answerAsk(approving
        ? { decision: 'allow', mode: 'auto', feedback: ta.value }
        : { decision: 'deny', feedback: ta.value });
    const cancel = () => {
        box.remove();
        btns.hidden = false;
        const back = host.closest('[tabindex]') || host;
        back.focus({ preventScroll: true });
    };

    const box = el('div', { class: 'perm-feedback' }, ta,
        el('div', { class: 'perm-btns' },
            el('button', { class: `perm-btn ${approving ? 'allow' : 'deny'}`, type: 'button',
                onclick: send },
                approving ? 'Approve with this note ' : 'Send it back ', el('kbd', {}, '⏎')),
            el('button', { class: 'perm-btn', type: 'button', onclick: cancel }, 'Cancel')));

    ta.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' && !(e.key === 'Enter' && !e.shiftKey)) return;
        e.preventDefault();
        // The surface behind this box answers Escape too — by setting a plan
        // aside. Closing the box must not also do that, and cancel() has
        // already removed the box the surface would have tested for.
        e.stopPropagation();
        if (e.key === 'Escape') cancel(); else send();
    });

    btns.hidden = true;
    btns.after(box);
    ta.focus();
}

/**
 * A multiple-choice question, or several, docked above the composer.
 *
 * Native radios and checkboxes rather than clickable divs: arrow keys, space,
 * groups and labels all work without being reimplemented, and a question is
 * exactly the moment not to have reinvented a form control. Every question has
 * an "Other" row, because the honest answer is often none of the above.
 *
 * All of them are built at once and all of them stay in the DOM — only the one
 * you are on is shown. That is what makes browsing free: the controls hold the
 * answers, so there is nothing to save and restore on the way past.
 */
function renderQuestionDock(ask) {
    const questions = (ask.input && ask.input.questions) || [];
    const readers = [];
    const groups = [];
    const dots = [];
    // A question moves you on once. Coming back to change an answer must not
    // fling you forward again — that is the moment you wanted to stay.
    const advanced = new Set();
    let at = 0;

    const body = el('div', { class: 'ask-dock-body' }, el('div', { class: 'perm-qs' }));
    const wrap = body.firstChild;

    questions.forEach((q, qi) => {
        const group = el('div', { class: 'perm-q', role: 'group',
            'aria-label': q.question || q.header || `Question ${qi + 1}` });
        group.append(el('div', { class: 'perm-q-head' },
            q.header ? el('span', { class: 'perm-q-chip' }, q.header) : null,
            el('span', { class: 'perm-q-text' }, q.question || '')));

        const name = `perm-q${qi}`;
        const type = q.multiSelect ? 'checkbox' : 'radio';
        const picks = [];

        for (const [oi, opt] of (q.options || []).entries()) {
            const box = el('input', { type, name, id: `${name}-o${oi}`, value: opt.label || '' });
            box.addEventListener('change', () => picked(qi, q));
            picks.push({ box, label: opt.label || '' });
            group.append(el('label', { class: 'perm-opt', for: `${name}-o${oi}` }, box,
                el('span', { class: 'perm-opt-body' },
                    el('span', { class: 'perm-opt-label' }, opt.label || ''),
                    opt.description ? el('span', { class: 'perm-opt-desc' }, opt.description) : null,
                    // Simply there. A preview is what you are comparing, and one
                    // that only appears under the pointer cannot be compared.
                    opt.preview ? el('pre', { class: 'perm-opt-preview' }, opt.preview) : null)));
        }

        const otherBox = el('input', { type, name, id: `${name}-other` });
        const otherText = el('input', { type: 'text', class: 'perm-other', autocomplete: 'off',
            'aria-label': `A different answer to "${q.question || ''}"`, placeholder: 'Something else…' });
        // Choosing "Other" is the one pick that never moves you on: the answer
        // is the sentence you are about to type, not the radio.
        otherBox.addEventListener('change', update);
        // Typing is choosing; making people also click the radio is a trap.
        otherText.addEventListener('input', () => {
            if (otherText.value.trim()) otherBox.checked = true;
            update();
        });
        group.append(el('label', { class: 'perm-opt perm-opt-other', for: `${name}-other` }, otherBox,
            el('span', { class: 'perm-opt-body' },
                el('span', { class: 'perm-opt-label' }, 'Other'), otherText)));

        // One question's answer, as the string the model will be handed. Several
        // selections read back as a list, which is how they were asked.
        readers.push(() => {
            const chosen = picks.filter(p => p.box.checked).map(p => p.label);
            const other = otherBox.checked ? otherText.value.trim() : '';
            if (other) chosen.push(other);
            return { question: q.question, answer: chosen.join(', ') };
        });

        groups.push(group);
        wrap.append(group);
    });

    // ── the answer row ───────────────────────────────────────────────────
    const submit = el('button', { class: 'perm-btn allow', type: 'button',
        onclick: () => answerAsk({ decision: 'allow', answers: collect() }) },
        questions.length > 1 ? 'Send answers ' : 'Send answer ', el('kbd', {}, '⏎'));
    const remain = el('span', { class: 'ask-remain' });
    const btns = el('div', { class: 'perm-btns' }, submit,
        el('button', { class: 'perm-btn deny', type: 'button',
            title: 'Answer nothing and let Claude decide for itself',
            onclick: () => answerAsk({ decision: 'deny' }) },
            'Skip'),
        remain);

    // ── browsing ─────────────────────────────────────────────────────────
    const prev = el('button', { class: 'ask-step', type: 'button',
        'aria-label': 'The question before this one', onclick: () => show(at - 1) }, '‹');
    const next = el('button', { class: 'ask-step', type: 'button',
        'aria-label': 'The next question', onclick: () => show(at + 1) }, '›');
    const count = el('span', { class: 'ask-nav-count' });
    const dotWrap = el('div', { class: 'ask-dots' });
    questions.forEach((q, qi) => {
        const dot = el('button', { class: 'ask-dot', type: 'button',
            title: q.header || clip(q.question || '', 60) || `Question ${qi + 1}`,
            'aria-label': `Question ${qi + 1}: ${q.header || q.question || ''}`,
            onclick: () => show(qi) });
        dots.push(dot);
        dotWrap.append(dot);
    });
    const nav = el('div', { class: 'ask-nav' }, prev, dotWrap, count, next);

    function show(i) {
        if (i < 0 || i >= groups.length) return;
        at = i;
        groups.forEach((g, gi) => { g.hidden = gi !== i; });
        body.scrollTop = 0;
        update();
        // Landing on the first control makes the arrow keys pick options and
        // Enter send, so a set of questions can be answered without the mouse.
        const first = groups[i].querySelector('input');
        if (first && document.hasFocus() && !dom.input.matches(':focus')) {
            first.focus({ preventScroll: true });
        }
    }

    /** The next question with no answer yet, wrapping — or -1 if there is none. */
    function nextOpen(from) {
        for (let n = 1; n < readers.length; n++) {
            const i = (from + n) % readers.length;
            if (!readers[i]().answer) return i;
        }
        return -1;
    }

    function picked(qi, q) {
        update();
        if (q.multiSelect || advanced.has(qi)) return;
        advanced.add(qi);
        // Long enough that the option you chose is seen to be chosen before the
        // question changes under you — at half this it read as the question
        // being yanked away rather than as an answer landing.
        setTimeout(() => {
            if (at !== qi) return;
            const to = nextOpen(qi);
            if (to >= 0) show(to);
        }, 450);
    }

    function collect() {
        const out = {};
        for (const read of readers) {
            const { question, answer } = read();
            if (answer) out[question] = answer;
        }
        return out;
    }

    // Claude asked all of them; answering some and leaving the rest to guesswork
    // is the outcome this dock exists to avoid. Which ones are still open is on
    // the dots and spelled out beside the button — it used to be a tooltip on a
    // disabled control, which is to say nowhere.
    function update() {
        const done = Object.keys(collect()).length;
        submit.disabled = done !== readers.length;
        dots.forEach((dot, di) => {
            if (readers[di]().answer) dot.dataset.done = '1';
            else delete dot.dataset.done;
            dot.setAttribute('aria-current', di === at ? 'true' : 'false');
        });
        count.textContent = `${at + 1} of ${groups.length}`;
        prev.disabled = at === 0;
        next.disabled = at === groups.length - 1;
        const left = readers.length - done;
        remain.textContent = left ? `${left} still to answer` : '';
    }

    const inner = el('div', { class: 'ask-dock-inner' },
        el('div', { class: 'ask-dock-head' },
            el('span', { class: 'perm-tool' }, 'Question'),
            el('span', { class: 'perm-title' },
                ask.agentId ? 'from a subagent' : 'waiting on you'),
            el('span', { class: 'spacer' }),
            questions.length > 1 ? nav : null),
        body, btns);

    inner.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            if (submit.disabled) return;
            e.preventDefault();
            submit.click();
        // Plain arrows belong to the radio group under the cursor; the modifier
        // is what makes these about the set rather than the options.
        } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            show(at + (e.key === 'ArrowRight' ? 1 : -1));
        }
    });

    dom.askDock.replaceChildren(inner);
    dom.askDock.dataset.request = ask.requestId;
    dom.askDock.hidden = false;
    dom.askDock.setAttribute('aria-label', 'A question waiting for your answer');
    show(0);
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
    const controls = askControls();
    if (root) root.dataset.pending = '1';
    if (controls) for (const b of controls.querySelectorAll('button')) b.disabled = true;
    try {
        await answerAskFor(state.current.sessionId, ask.requestId, payload);
        if (payload.mode) adoptMode(payload.mode);
    } catch (err) {
        // 409 means another window got there first; the resolved event that
        // follows takes the surface down with the right reason on it.
        toast(`Could not answer: ${err.message}`, 'error');
        if (root) delete root.dataset.pending;
        if (controls) for (const b of controls.querySelectorAll('button')) b.disabled = false;
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
