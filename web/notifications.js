// Desktop notifications and the chime: what reaches you about a session when
// you are not looking at it, and the page side of web/sw.js, the worker that
// puts Allow and Deny on a notification. Moved out of app.js as it was.
//
// The switches for all of this are drawn by the notification settings group,
// web/settings/notifications.js, which reads and writes `notify` from here.
// `window.claudeShell` is the Electron preload (app/preload.js); a browser has
// none, so every use of it stays guarded.
//
// This imports `openSession` and `toolSummary` from app.js, which imports this — safe because
// nothing here reads an app.js binding at module top level, only when a
// function is called.

import { state } from './state.js';
import { clip, dur } from './format.js';
import { openSession, toolSummary } from './app.js';

// ── notifications ────────────────────────────────────────────────────────
//
// A turn can run for minutes, and the point of leaving one going is that you go
// and do something else meanwhile. The rail already says what happened — but
// only once you look at it. This is the part that reaches you when you are not
// looking.
//
// It lives in the page rather than in the Electron shell, which has two
// consequences worth knowing. The good one: the same behaviour comes with the
// browser UI, and a sound has nowhere else to come from anyway. The bad one: a
// window that is closed hears nothing, because the only subscriber to the
// bridge's events went with it. Fixing that means the shell holding an
// EventSource of its own — see docs/plans/02-notifications-and-shell.md.

const NOTIFY = {
    // Under this and you were almost certainly still sitting in front of it.
    minTurnMs: 30_000,
    // One per session per this, so a draining queue is not a stack of toasts.
    perSessionMs: 10_000,
};

export const notify = {
    desktop: localStorage.getItem('notifyDesktop') !== '0',
    sound: localStorage.getItem('notifySound') !== '0',
    sw: null,           // the worker registration, once it is ready — see sw.js
    fired: new Map(),   // sessionId -> when something last fired for it
    busy: new Map(),    // sessionId -> when its running turn started
    audio: null,
};

/**
 * How long the turn kept somebody waiting, measured here rather than taken
 * from the result.
 *
 * The result's own duration is usually the same number — measured against a
 * one-minute turn the two agreed to within 10ms. But it is assembled in
 * runner.js as `duration_ms || duration_api_ms`, and that second field is API
 * time only, so a CLI that ever omits the first quietly starts reporting a
 * fraction of the wall clock. Deciding "long enough to have walked away from"
 * on a number that can change meaning is not worth the coupling.
 *
 * The bridge stamps `busySince` on every status it broadcasts, so this app's
 * own measure is already on the wire. Keep the last one seen per session and
 * subtract when the turn lands; the reported duration is the fallback, for a
 * window that opened after the turn had already started.
 */
export function noteRunner(s) {
    if (s.busySince) notify.busy.set(s.sessionId, s.busySince);
}

function waitedMs(r) {
    const started = notify.busy.get(r.sessionId);
    notify.busy.delete(r.sessionId);
    return started ? Date.now() - started : (r.durationMs || 0);
}

export const notifyPermission = () =>
    (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/**
 * Whether a finished turn is worth interrupting somebody for.
 *
 * Being strict here is the whole game: notifications that fire too often get
 * switched off, and then the one that mattered is lost with them.
 *
 *   - A turn that ended badly always counts. Every other kind of ending you
 *     find out about by waiting; this one leaves you waiting forever.
 *   - Nothing is said about the session you are looking at in a focused
 *     window. You watched it land.
 *   - Half a minute is the line between a turn you sat through and one you
 *     walked away from.
 *   - At most one per session per ten seconds, whatever the reason.
 *
 * Returns false for a normal finish, true for a bad one, null for silence.
 */
function turnWorthSaying(r, waited) {
    const bad = Boolean(r.isError);
    if (!bad) {
        const watching = document.hasFocus()
            && state.current && state.current.sessionId === r.sessionId;
        if (watching || waited < NOTIFY.minTurnMs) return null;
    }
    if (!allowedNow(r.sessionId)) return null;
    return bad;
}

function allowedNow(sessionId) {
    const last = notify.fired.get(sessionId) || 0;
    if (Date.now() - last < NOTIFY.perSessionMs) return false;
    notify.fired.set(sessionId, Date.now());
    return true;
}

const sessionTitle = (id) => {
    const row = state.sessions.find(s => s.sessionId === id);
    return (row && row.title) || 'A session';
};

export function announceTurn(r) {
    // Read before the decision either way: the stamp has to be cleared whether
    // or not this one gets said out loud, or the next turn inherits it.
    const waited = waitedMs(r);
    const bad = turnWorthSaying(r, waited);
    if (bad === null) return;
    announce(
        `${clip(sessionTitle(r.sessionId), 60)} — ${bad ? 'turn failed' : 'finished'}`,
        bad ? clip(r.detail || 'The turn ended with an error.', 160)
            : `Ran for ${dur(waited)}.`,
        bad ? 'fail' : 'done', r.sessionId,
    );
}

// A send that never became a turn: the session is finished in the sense that
// matters, because nothing more is coming and nobody is going to be told. The
// composer's toast covers the window that did the sending — this covers the
// queued message you walked away from.
export function announceSendFailure(f) {
    const watching = document.hasFocus()
        && state.current && state.current.sessionId === f.sessionId;
    if (watching || !allowedNow(f.sessionId)) return;
    announce(
        `${clip(sessionTitle(f.sessionId), 60)} — could not run`,
        clip(f.message || 'The message never reached Claude.', 160),
        'fail', f.sessionId,
    );
}

/**
 * A blocked turn, said out loud.
 *
 * Three things arrive down this channel and only one is a permission — see the
 * approvals section for the vocabulary. What they share is the thing that
 * matters here: the turn does not move until you answer, so unlike a finished
 * turn there is no duration to wait for and nothing to be gained by holding
 * back. If you are not looking at the card, you want to know.
 *
 * A tool and a plan get two buttons, because yes and no are the whole answer
 * for a tool and are approve-or-keep-planning for a plan. A question gets
 * none: its answer is a choice among options that will not fit on a toast, so
 * it can only invite you to come and read it.
 */
export function announceAsk(p) {
    const watching = document.hasFocus()
        && state.current && state.current.sessionId === p.sessionId;
    if (watching) return;

    const kind = p.kind || 'tool';
    const head = ASK_TITLE[kind] || `${p.displayName} needs permission`;
    // Deliberately not gated on allowedNow: the toast carries a tag, so a
    // second ask replaces the first rather than stacking, and suppressing it
    // would leave the old one on screen offering to answer a dead request.
    // Only the noise is rationed, below.
    showAsk(`${clip(sessionTitle(p.sessionId), 60)} — ${head}`, askBody(p, kind), p, kind);
    if (allowedNow(p.sessionId)) chime('ask');
}

const ASK_TITLE = {
    plan: 'a plan to approve',
    question: 'a question for you',
};

export function askBody(p, kind) {
    if (kind === 'plan') {
        return clip((p.input && p.input.plan) || p.description || 'A plan is ready.', 160);
    }
    if (kind === 'question') {
        const qs = (p.input && p.input.questions) || [];
        return clip(qs.length ? qs[0].question : 'A question is waiting.', 160);
    }
    return clip(toolSummary({ name: p.tool, input: p.input }) || p.description || '', 160);
}

const ASK_ACTIONS = {
    tool: [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }],
    plan: [{ action: 'allow', title: 'Approve' }, { action: 'deny', title: 'Keep planning' }],
    question: [],
};

/**
 * Shown through the service-worker registration rather than `new
 * Notification`, because that is the only kind the platform will put buttons
 * on. With no worker — registration failed, or the browser has none — this
 * falls back to a plain notification, which still says what is waiting and
 * still opens the card when clicked. Only the buttons are lost.
 */
function showAsk(title, body, p, kind) {
    if (!notify.desktop || notifyPermission() !== 'granted') return;
    const opts = {
        body,
        tag: askTag(p.sessionId),
        silent: true,
        requireInteraction: true,   // a blocked turn should not time out on screen
        data: { sessionId: p.sessionId, requestId: p.requestId },
        actions: ASK_ACTIONS[kind] || [],
    };
    if (notify.sw) {
        notify.sw.showNotification(title, opts).catch(() => {});
        return;
    }
    announce(title, body, null, p.sessionId);
}

const askTag = (sessionId) => `claude-ask:${sessionId}`;

/**
 * Take the toast down once the ask is no longer waiting — answered in a
 * window, answered from another toast, or resolved by the turn being stopped.
 * A notification offering to allow something that has already been decided is
 * worse than no notification at all.
 */
export function clearAsk(sessionId) {
    if (!notify.sw) return;
    notify.sw.getNotifications({ tag: askTag(sessionId) })
        .then(list => list.forEach(n => n.close()))
        .catch(() => {});
}

/**
 * Said out loud, and clickable back to where it came from.
 *
 * Through the service-worker registration where there is one, which showAsk()
 * already does for the ask toasts — not for the buttons this time, but for the
 * `data` payload. A plain `new Notification` keeps the session id only in the
 * closure below, and a closure lasts exactly as long as the page: reload, or come
 * back to a toast the next morning, and the click has nothing left to route on.
 * The worker's copy is on the notification itself, so `sw.js` can still open the
 * right conversation with no window involved.
 *
 * The plain kind stays as the fallback for a browser with no worker, where losing
 * the click after a reload is better than losing the notification.
 */
export function announce(title, body, tone, sessionId) {
    chime(tone);
    if (!notify.desktop || notifyPermission() !== 'granted') return;
    const opts = {
        body,
        // A second one for the same session replaces the first rather than
        // piling up behind it.
        tag: sessionId ? `claude-session:${sessionId}` : 'claude-session',
        // chime() is the only thing here allowed to make a noise, so that
        // the sound checkbox means what it says.
        silent: true,
    };
    if (notify.sw) {
        notify.sw.showNotification(title, { ...opts, data: { sessionId } }).catch(() => {});
        return;
    }
    let n;
    try {
        n = new Notification(title, opts);
    } catch { return; /* some engines expose Notification but refuse `new` */ }
    n.onclick = () => {
        // Raising the window is the shell's job — a renderer cannot get past
        // the Windows foreground lock on its own — so ask it if it is there.
        // In a browser tab it is not, and window.focus() is what that
        // environment gives us; it works from a notification click, which is
        // a user gesture.
        if (window.claudeShell) window.claudeShell.revealWindow();
        else window.focus();
        if (sessionId) openSession(sessionId);
        n.close();
    };
}

/**
 * Three sounds, because they mean three different things and the whole point
 * of a sound is to be understood without looking.
 *
 *   done  two notes up — finished, nothing wanted from you.
 *   fail  one flat low note — over, and it went wrong.
 *   ask   two notes on the same pitch, like a knock. Something is waiting on
 *         you, and repetition rather than melody is what reads as a request.
 *
 * Synthesised rather than shipped as a file: it is a few oscillators' worth of
 * code against binary assets in a repo that has none, and it keeps the sounds
 * tunable in the same place as everything else.
 *
 * Short and quiet on purpose. This fires in a room where somebody is working.
 * An unrecognised tone is silence, so a caller that has already made its own
 * noise can pass none.
 */
const CHIME = {
    done: [[587.33, 0, 0.16, 0.11], [880, 0.11, 0.34, 0.1]],   // D5 → A5
    fail: [[311.13, 0, 0.44, 0.09]],                            // E♭4, alone
    ask: [[698.46, 0, 0.11, 0.1], [698.46, 0.17, 0.22, 0.1]],   // F5, twice
};

export function chime(tone) {
    if (!notify.sound) return;
    const notes = CHIME[tone];
    if (!notes) return;
    const ctx = audioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.01;
    for (const [hz, at, len, peak] of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = hz;
        const s = t0 + at;
        // Ramped, not switched: a square-edged gain change is a click.
        gain.gain.setValueAtTime(0.0001, s);
        gain.gain.exponentialRampToValueAtTime(peak, s + 0.014);
        gain.gain.exponentialRampToValueAtTime(0.0001, s + len);
        osc.connect(gain).connect(ctx.destination);
        osc.start(s);
        osc.stop(s + len + 0.03);
    }
}

function audioContext() {
    if (notify.audio) return notify.audio;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try { notify.audio = new Ctor(); } catch { return null; }
    return notify.audio;
}

// A context built before the page has been touched starts suspended and stays
// that way, so the first chime after a fresh load would be silent. Build it on
// the first interaction of any kind instead — including, below, the click that
// turns the sound on.
export function wakeAudio() {
    const ctx = audioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}
for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, () => { if (notify.sound) wakeAudio(); }, { once: true });
}

// ── the worker that carries the buttons ──────────────────────────────────
//
// Registered for one capability — actions on a notification — and holding no
// cache and no fetch handler, so it changes nothing else about how the page
// loads. If it fails to register, asks fall back to a plain notification with
// no buttons; everything else carries on.

export async function registerWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
        await navigator.serviceWorker.register('./sw.js');
        notify.sw = await navigator.serviceWorker.ready;
    } catch { /* no buttons, then — showAsk falls back */ }
}

// The worker cannot open a session itself; it can only say which one a click
// was about. Raising the window is the shell's job, and the preload bridge for
// that lives here rather than there.
navigator.serviceWorker?.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type !== 'reveal-session') return;
    if (window.claudeShell) window.claudeShell.revealWindow();
    if (msg.sessionId) openSession(msg.sessionId);
});

/**
 * `#/session/<id>` on load, which is how a click that had to open a window
 * gets to the right conversation. Deliberately the same shape plan 02 gives
 * the deep links, so a `tgxcode://` handler can route into the page
 * without inventing a second vocabulary.
 */
export function openFromHash() {
    const m = /^#\/session\/([0-9a-f-]{8,})$/i.exec(location.hash || '');
    if (!m) return false;
    // The hash is a click that happened once, not a place: consume it so a
    // refresh does not keep re-opening the same session forever. What a refresh
    // lands on instead is the query string, which the open below is about to
    // write through rememberView. Only the hash goes — the search is the durable
    // half and dropping it here would undo the view restored a moment ago.
    history.replaceState(null, '', location.pathname + location.search);
    openSession(m[1]);
    return true;
}
