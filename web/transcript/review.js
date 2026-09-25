// Reviewing a plan or a question after the fact, opened from its tool block or
// from the turn rail.
//
// This imports app.js and sibling modules here, which import it back. That is
// safe only because nothing in this file reads an imported binding while the
// module is evaluating — every use is inside a function called later. Keep it
// that way: a top-level `const X = someImport(...)` runs before app.js's body
// and throws in the temporal dead zone, and only loading the page shows it.

import { dom, el } from '../dom.js';
import { clip, clockOf, dateOf } from '../format.js';
import { renderMarkdown } from '../markdown.js';
import { state } from '../state.js';
import { closeContextMenu } from './context-menu.js';
import { readAnswer } from './tools.js';
import { hideTurnPop } from './turn-rail.js';

// ── reviewing a plan or a question ───────────────────────────────────────
//
// Both get a whole surface while they are live — #plan-pane lays a plan over
// the transcript, #ask-dock walks you through the questions — and then they are
// gone, collapsed into an ordinary tool row somewhere in the log. These are the
// two moments in a session where *you* decided something, and they were the
// hardest things in it to find again.
//
// So the turn rail carries a marker for each (see renderTurns), and this is
// what a marker opens: the same thing, replayed, read-only.

/** What became of an ask, in the few words a tick label and a popover have room for. */
export function markOutcome(ev) {
    if (!ev.result) return 'still waiting';
    const stopped = /^Stopped from (TGXCode|Claude Sessions)/.test(ev.result.text || '');
    if (ev.name === 'ExitPlanMode') {
        if (ev.status === 'error') return stopped ? 'stopped' : 'sent back';
        return ev.result.planWasEdited ? 'approved with a note' : 'approved';
    }
    if (ev.status === 'error') return stopped ? 'stopped' : 'dismissed';
    return 'answered';
}

/**
 * Open the review for a plan or a question.
 *
 * Keyed by the event id rather than by the entry, because `patchTool` rebuilds
 * the block and swaps `entry.node` out from under anything holding one — so a
 * dialog opened on a plan that is still waiting, and still up when the answer
 * lands, would otherwise repaint from a stale object and jump to a detached
 * node. The same late lookup `jumpToFile` does, for the same reason.
 */
export function openReview(evId) {
    if (!state.nodes.has(evId)) return;
    state.review.evId = evId;
    closeContextMenu({ focus: false });
    hideTurnPop();
    paintReview();
    dom.reviewScrim.hidden = false;
    // The dialog itself, not its body: focus has to come inside the scrim or the
    // keyboard is still out in the rail behind it, but a body that fills the
    // dialog wears the focus ring as a border around everything, which reads as
    // decoration rather than as focus. The body stays tabbable, so one Tab gets
    // the arrow keys scrolling a long plan.
    dom.reviewModal.focus({ preventScroll: true });
}

export function closeReview() {
    if (dom.reviewScrim.hidden) return;
    state.review.evId = null;
    dom.reviewScrim.hidden = true;
    // A plan is tens of kilobytes of rendered markdown and a four-question
    // review is a few hundred nodes of options and previews. Same reason
    // closeDiff empties its body rather than leaving it attached to a hidden
    // dialog nobody is looking at.
    dom.reviewBody.replaceChildren();
    dom.reviewOutcome.replaceChildren();
}

/** Fill the dialog from whatever the event says now. Safe to call again. */
export function paintReview() {
    const entry = state.nodes.get(state.review.evId);
    if (!entry) return closeReview();
    const ev = entry.ev;
    const plan = ev.name === 'ExitPlanMode';

    dom.reviewKind.textContent = plan ? 'Plan' : 'Question';
    dom.reviewTitle.textContent = markOutcome(ev);
    // Dated on the same rule as the transcript gutter: a plan read back out of a
    // week-old session has the same bare-clock problem, and the header line here
    // has room for both.
    const when = ev.resultTs || ev.ts;
    dom.reviewWhen.textContent = `${dateOf(when)} ${clockOf(when)}`.trim();
    dom.reviewModal.dataset.kind = plan ? 'plan' : 'question';
    dom.reviewOutcome.replaceChildren();
    dom.reviewBody.replaceChildren(plan ? reviewPlan(ev) : reviewQuestions(ev));
}

/**
 * The plan, as markdown.
 *
 * `result.plan` in preference to `input.plan`: the input is what was put
 * forward and the result is what was agreed to. Approving with a note appends a
 * `## Note from the user` section to the plan the tool receives, so that note
 * exists in the result and nowhere else — and showing the proposal instead
 * would quietly drop the one part of the plan you wrote yourself.
 */
function reviewPlan(ev) {
    const r = ev.result || {};
    const text = r.plan || ev.input.plan || '';

    if (ev.status === 'error') {
        const stopped = /^Stopped from (TGXCode|Claude Sessions)/.test(r.text || '');
        dom.reviewOutcome.replaceChildren(stopped
            // Nobody turned this down — the turn ended while it was still up.
            // Printing the canned sentence as though it were feedback would put
            // words in the user's mouth.
            ? el('span', { class: 'review-said' }, 'Stopped before it was answered.')
            : el('div', {},
                el('span', { class: 'review-said-head' }, 'Kept planning — what you said'),
                el('div', { class: 'review-said' }, r.text || '')));
    } else if (r.planWasEdited) {
        dom.reviewOutcome.replaceChildren(el('span', { class: 'review-said' },
            'Approved with a note, which is at the foot of the plan.'));
    }

    return el('div', { class: 'plan-rev prose', html: renderMarkdown(text) });
}

/**
 * Every question at once, side by side.
 *
 * The live dock shows one at a time and moves you on as you answer, which is
 * right when you are answering and wrong when you are reading back: what you
 * want then is the shape of the whole decision, and that means seeing the
 * questions together.
 *
 * The columns reuse the dock's own classes — .perm-q, .perm-opt and the rest —
 * so this looks like the thing it is replaying rather than like a second design
 * of it. What it does not reuse is the inputs: these are divs, because a radio
 * you cannot change is a control that lies about being one.
 */
function reviewQuestions(ev) {
    const qs = ev.input.questions || [];
    const answers = (ev.result && ev.result.answers) || null;
    const grid = el('div', { class: 'qrev' });
    // The dialog is sized from the count — see .review-modal in the CSS. One
    // question in a 1400px box is a sentence marooned in a field; four at 640
    // are four unreadable columns, and the count is known the moment it opens.
    dom.reviewModal.dataset.cols = String(Math.min(Math.max(qs.length, 1), 4));

    if (ev.status === 'error') {
        const stopped = /^Stopped from (TGXCode|Claude Sessions)/.test((ev.result || {}).text || '');
        dom.reviewOutcome.replaceChildren(el('span', { class: 'review-said' }, stopped
            ? 'Stopped before it was answered.'
            : 'Dismissed — Claude carried on unaided.'));
    }

    for (const q of qs) {
        const { chosen, said } = readAnswer(answers && answers[q.question], q.options);
        const col = el('div', { class: 'perm-q', role: 'group',
            'aria-label': q.question || q.header || 'Question' });
        col.append(el('div', { class: 'perm-q-head' },
            q.header ? el('span', { class: 'perm-q-chip' }, q.header) : null,
            el('span', { class: 'perm-q-text' }, q.question || '')));

        for (const opt of q.options || []) {
            const picked = chosen.has(opt.label || '');
            col.append(el('div', { class: 'perm-opt', 'data-chosen': picked ? '1' : null },
                el('span', { class: 'qrev-mark' }, picked ? '●' : '○'),
                el('span', { class: 'perm-opt-body' },
                    el('span', { class: 'perm-opt-label' }, opt.label || ''),
                    opt.description ? el('span', { class: 'perm-opt-desc' }, opt.description) : null,
                    // Kept, for the reason the dock keeps it: a preview is what
                    // you were comparing, and one you have to hover for cannot
                    // be compared.
                    opt.preview ? el('pre', { class: 'perm-opt-preview' }, opt.preview) : null)));
        }

        // Typed rather than picked. About one answer in nine goes through the
        // tool's "Other" box, and a handful do both — picking an option and
        // adding a condition to it — so this is "also" when something was
        // chosen and stands alone when nothing was.
        if (said) {
            col.append(el('div', { class: 'qrev-said' },
                el('span', { class: 'qrev-said-head' }, chosen.size ? 'You also said' : 'You said'),
                el('span', {}, said)));
        } else if (!chosen.size) {
            col.append(el('div', { class: 'qrev-none' }, 'Not answered'));
        }

        grid.append(col);
    }

    if (!qs.length) grid.append(el('div', { class: 'qrev-none' }, 'No questions recorded.'));
    return grid;
}

export function kvView(obj) {
    const dl = el('dl', { class: 'kv' });
    for (const [k, v] of Object.entries(obj)) {
        const text = typeof v === 'string' ? v : JSON.stringify(v, null, 1);
        dl.append(el('dt', {}, k), el('dd', {}, clip(text, 600)));
    }
    return dl;
}
