// Doing one of your earlier turns over: Edit and resend, and Edit and branch.
//
// Both start the same way — the turn's text goes back in the composer to be
// edited — and differ in where the send goes:
//
// - **Edit and resend** continues this session. Nothing is undone; the edited
//   message is simply the next turn. No bridge change, and none needed.
// - **Edit and branch** sends it to a *copy* of this session cut back to just
//   before that turn, so the turns after it are not in the copy's history. The
//   original is never rewritten: the bridge passes `--fork-session` with
//   `--resume-session-at`, and Claude Code writes the copy under a new id. That
//   is what makes this safe to offer on a session you care about.
//
// The branch is state (`state.branchFrom`) and a banner, not a mode of the Send
// button, because a failure has to be able to retry it: the POST can succeed and
// the CLI still refuse the cut, and the Retry on that toast must branch again.
//
// Turn 1 has nothing before it, so branching from it is a new session in the same
// folder with the edited text as its prompt — the bridge refuses the cut, and this
// does the thing that was meant instead.
//
// Imports app.js, which imports it back through composer/send.js and
// transcript/rows.js. Safe only because nothing here reads an imported binding
// while the module evaluates — see the note at the top of send.js.

import { dom } from '../dom.js';
import { state } from '../state.js';
import { restoreToComposer } from '../app.js';
import { turnText } from '../transcript/turn-rail.js';

/** What a turn said, as the composer should get it back. */
function turnSource(ev) {
    if (ev.command) return turnText(ev);
    return (ev.text || '').trim();
}

/**
 * Where a turn sits in the whole conversation, 1-based, and how many there are.
 *
 * From `state.turns`, which the turn rail builds from the bridge's turn index as
 * well as the rows on screen — so "turn 4 of 40" is right on a long transcript
 * opened from its end, where only the last few rows are loaded.
 */
function turnPosition(ev) {
    const i = state.turns.findIndex(t => t.ev && t.ev.id === ev.id);
    return { turn: i < 0 ? null : i + 1, total: state.turns.length };
}

/** Put the text back to be edited, and continue this session with it. */
export function editAndResend(ev) {
    cancelBranch();
    restoreToComposer(turnSource(ev));
}

/** Put the text back to be edited, and send it to a copy cut back to before it. */
export function editAndBranch(ev) {
    if (!state.current || !ev.id) return;
    const { turn, total } = turnPosition(ev);
    state.branchFrom = {
        sessionId: state.current.sessionId,
        uuid: ev.id,
        turn, total,
        // `parent` is new on the event; a bridge that predates it sends none, and
        // then only the position can say whether this is the first turn.
        first: ev.parent === null || (ev.parent === undefined && turn === 1),
    };
    paintBranch();
    restoreToComposer(turnSource(ev));
}

/** The branch the next send from this session would make, if any. */
export function branchFor(sessionId) {
    const b = state.branchFrom;
    return b && b.sessionId === sessionId ? b : null;
}

export function cancelBranch() {
    if (!state.branchFrom) return;
    state.branchFrom = null;
    paintBranch();
}

/** The banner above the box, for the session on screen. */
export function paintBranch() {
    const b = state.current ? branchFor(state.current.sessionId) : null;
    // Another session opened: the branch was about that one, and would be a
    // surprise waiting for you when you came back.
    if (state.branchFrom && !b) state.branchFrom = null;
    dom.branch.hidden = !b;
    if (!b) return;
    dom.branchText.textContent = branchLine(b);
}

function branchLine(b) {
    if (b.first) {
        return 'Branching from the first turn — this starts a new session in the same folder.';
    }
    if (!b.turn) return 'Branching from an earlier turn — the copy will not include it or anything after it.';
    const dropped = b.turn === b.total ? `turn ${b.turn}` : `turns ${b.turn}–${b.total}`;
    return `Branching from turn ${b.turn} of ${b.total} — the copy will not include ${dropped}.`;
}
