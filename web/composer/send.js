// Sending from the live composer: sizing the box, turning the send controls on
// and off together, the optimistic chip a message shows until the transcript has
// it, and whether Enter sends. Moved out of app.js as it was.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.

import { post } from '../api.js';
import { BOOT_PREFS } from '../boot.js';
import { dom, toast } from '../dom.js';
import { state } from '../state.js';
import { applyRunner, lockedNow, restoreToComposer, saveDraft, scrollToEnd } from '../app.js';
import { renderUser } from '../transcript/rows.js';
import { clearAttach, readyAttachments, revokePreviews } from './attachments.js';
import { live } from './slash.js';

// ── composer ─────────────────────────────────────────────────────────────

/**
 * Size a textarea to its contents.
 *
 * `height: auto` first so the box can shrink again — scrollHeight never reports
 * less than the height already set, so measuring without clearing it makes a
 * textarea that only ever grows.
 */
export function grow(ta, min, max) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(min, Math.min(max, ta.scrollHeight)) + 'px';
}

// Never below the button height, so an empty composer stays centred.
export const autoGrow = () => grow(dom.input, 38, 220);


/**
 * Every way of sending from this composer turns on and off together.
 *
 * The pinned snippets are in it because each one is an ordinary message with a
 * written-out text, so it goes into the same transcript by the same path — which
 * is the argument the LGTM button's line here used to make on its own, back when
 * there was exactly one of them.
 */
export function enableSend(on) {
    dom.btnSend.disabled = !on;
    dom.btnSnippets.disabled = !on;
    for (const b of dom.pins.children) b.disabled = !on;
    // Attaching needs a session for the same reason sending does — the file goes into
    // *that* session's checkout — so it turns on and off with them.
    dom.btnAttach.disabled = !on;
    // And so does scheduling, which is a send with a time on it.
    dom.btnLater.disabled = !on;
}

// ── optimistic sends ─────────────────────────────────────────────────────
// A message you have just sent is not in the transcript yet, and cannot be: the
// bridge never writes transcripts, `claude` appends the user entry itself, and the
// bridge only learns of it on the next poll of the file. On a cold start — spawning
// the process and resuming a long transcript before it reads its first line — that
// is seconds, which looks exactly like a Send that did nothing. So the row is drawn
// here at the click, and the real one takes its place when it arrives.

// How long a drawn-but-unconfirmed row may stand. Long enough to clear a cold start
// and a poll; erring long costs nothing, because the row is right and only
// unconfirmed.
const PENDING_MS = 30000;

/**
 * Draw the message that has just been sent, ahead of the transcript.
 *
 * Only ever one at a time: pressing Enter twice in the same moment sends a second
 * message the bridge queues, and a queued message is already shown as a chip.
 */
function showPendingSend(sessionId, text, files, previews) {
    if (state.pendingSend) return revokePreviews(previews);
    // The real renderer, so the swap when the transcript catches up is one node for
    // another and not a reflow. No `ts`: clockOf gives an empty gutter for a missing
    // one, and the marker on it says what that means. Sending the local clock
    // instead would print a time the transcript is then free to disagree with —
    // a cold start really does record the entry a second or more later.
    // The object URLs and the file list, so the row that appears the instant you press
    // Enter is the row the transcript will replace it with — thumbnail, cards and all —
    // rather than a bare line of text that grows a screenshot a second later.
    const node = renderUser({
        kind: 'user', text, ts: null,
        images: (previews || []).map(url => ({ dataUri: url })),
        files: (files || []).map(f => ({ relPath: f.relPath, name: f.name, size: null })),
    });
    node.dataset.pending = '1';
    dom.log.append(node);
    state.pendingSend = {
        sessionId, node, previews, timer: setTimeout(clearPendingSend, PENDING_MS),
    };
    state.pinned = true;
    scrollToEnd(false);
}

/**
 * Take the pending row down, however it ended.
 *
 * Nothing here has to hand the text back: a row that is retired because the
 * transcript arrived has been replaced by the real thing, and every other route —
 * a refused POST, a send-failed, a session that went away — either restores the
 * composer itself or still holds the text in state.unsent.
 */
export function clearPendingSend() {
    const p = state.pendingSend;
    if (!p) return;
    clearTimeout(p.timer);
    state.pendingSend = null;
    p.node.remove();
    // The row was the last thing holding these; the transcript's own copy of the
    // image comes from the transcript.
    revokePreviews(p.previews);
}

export async function sendMessage({ fork = false, text: override = null, canned = false } = {}) {
    const text = override != null ? override : dom.input.value.trim();
    // Attachments only ride on a message that came out of the box. A canned send — a
    // snippet that sends itself, a follow-up card — must not walk off with a screenshot
    // you staged for something else, by the same argument that leaves the half-typed
    // text alone.
    const files = override == null ? readyAttachments(live) : [];
    // A screenshot with nothing typed under it is a message: "look at this" is the
    // whole content of it.
    if ((!text && !files.length) || !state.current) return;
    const sessionId = state.current.sessionId;

    // The lock is a rule, not a disabled button. Greying out the buttons left
    // Enter — and every internal caller, a snippet included — going straight past it
    // into the two-writers case the whole thing exists to prevent. Branching is
    // exempt: a fork is the way out, and it writes to a new transcript rather
    // than this one.
    if (!fork && lockedNow()) {
        toast('This session is running elsewhere. Branch off a copy, or choose '
            + '“Send anyway”.', 'warn');
        dom.lockFork.focus();
        return;
    }

    // Only a message that came out of the box empties the box — and only then is
    // the saved draft gone with it. A canned send leaves a half-written message
    // where it was, rather than dropping it on the way past.
    // Taken before the strip is emptied, because emptying it is what would revoke them.
    const previews = files.length
        ? live.attach.filter(a => a.previewUrl).map(a => a.previewUrl)
        : [];

    if (override == null) {
        dom.input.value = '';
        autoGrow();
        saveDraft(sessionId, '');
        clearAttach(live, { revoke: false });
    }

    // Drawn in the same frame the box empties, so the message moves from one to the
    // other rather than vanishing. Only a message that goes straight to the process,
    // though: one the bridge queues must not appear at the foot of the log, because
    // the foot of the log is *after* output that is still streaming above it — and a
    // queued message already has somewhere to be seen, as a chip on the composer.
    // The runner state is the same thing the button reads to decide whether it says
    // Queue or Send. The bridge's own answer is better, but it only arrives after
    // the await, and waiting for it is the delay this exists to remove. A fork is
    // left out because the copy gets its own transcript, and this log with it.
    const runner = state.runner;
    const willQueue = Boolean(runner
        && (runner.state === 'busy' || runner.state === 'starting'));
    if (!fork && !willQueue) showPendingSend(sessionId, text, files, previews);
    // No row was drawn, so nothing is going to hand these back.
    else revokePreviews(previews);

    enableSend(false);

    try {
        const r = await post(`/api/sessions/${sessionId}/send`, {
            text,
            // Paths, not bytes: every one of these is already on disk, written by the
            // attachments route before its chip appeared.
            attachments: files,
            fork,
            model: dom.model.value || null,
            permissionMode: dom.perm.value,
        });
        // Only a message that actually went to the process needs holding here:
        // if it died before answering, this is the only surviving copy of what
        // was typed. A queued one is still on the bridge, which hands the whole
        // queue back on failure. Canned text is not worth holding at all — it is
        // a button press away, and it is long.
        if (!r.queued && !canned) state.unsent.set(sessionId, text);
        applyRunner(r.status);
        if (!r.queued) {
            state.pinned = true;
            scrollToEnd(false);
        } else {
            // Our reading of the runner was behind the bridge's — another window
            // sent a moment ago, or the session is being held somewhere else. The
            // chip is the honest home for a queued message, so the row gives way.
            clearPendingSend();
        }
    } catch (err) {
        clearPendingSend();   // it never reached the bridge; the log must not claim it did
        // The files are still on disk, so handing their metadata back is enough to put
        // the chips where they were.
        if (!canned) restoreToComposer(text, files);
        toast(`Could not send: ${err.message}`, 'error');
    } finally {
        enableSend(Boolean(state.current));
    }
}

/** A turn that never started: give the text back, and offer the way forward. */
export function handleSendFailure(f) {
    // Everything the process was holding, in send order — the turn it died on
    // plus whatever was still queued behind it.
    const text = (f.unsent && f.unsent.length)
        ? f.unsent.join('\n\n')
        : (state.unsent.get(f.sessionId) || '');
    state.unsent.delete(f.sessionId);
    // The turn never started, so nothing is coming to replace the row. This arrives
    // as an event rather than as a refused POST — a process that died on the write,
    // a session already held in a terminal — and can be about a session that is not
    // the one on screen, hence the check.
    if (state.pendingSend && state.pendingSend.sessionId === f.sessionId) {
        clearPendingSend();
    }

    const onCurrent = state.current && state.current.sessionId === f.sessionId;
    if (text) {
        if (onCurrent) restoreToComposer(text);
        else saveDraft(f.sessionId, text);   // waiting when they come back
    }

    if (f.kind === 'busy-elsewhere' && onCurrent && text) {
        toast(`${f.message} Your message is back in the box.`, 'warn', {
            action: { label: 'Branch off a copy', onClick: () => sendMessage({ fork: true }) },
        });
    } else {
        toast(text ? `${f.message} Your message was put back.` : f.message, 'error',
            { ms: 9000 });
    }
}


/**
 * Does this Enter send, or break the line?
 *
 * `keyboard.composerSend` picks between two shapes. `'enter'` is the chat
 * convention and what this app has always done: Enter sends, Shift+Enter is a
 * newline. `'ctrl-enter'` swaps them, which is what you want when a message is
 * three paragraphs and Enter sending it halfway through is a real cost.
 *
 * Ctrl/Cmd+Enter sends in both. It used to be the only way and fingers
 * remember, and it is unambiguous under either mode.
 *
 * Alt+Enter is a newline throughout, and `isComposing` keeps an IME's Enter for
 * the IME — it is picking a candidate, not finishing a message.
 */
export function enterSends(e) {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return false;
    if (e.altKey) return false;
    if (e.ctrlKey || e.metaKey) return true;
    if (e.shiftKey) return false;
    return BOOT_PREFS.keyboard.composerSend !== 'ctrl-enter';
}

/** The strip under the composer, which says whichever mode is in force. */
export function paintComposerHint() {
    dom.composerHint.textContent = BOOT_PREFS.keyboard.composerSend === 'ctrl-enter'
        ? 'Ctrl+Enter to send · Enter for a newline'
        : 'Enter to send · Shift+Enter for a newline';
}
