// Send later: the popover under the clock button, the chips for messages held
// back to a time, and the bridge calls behind them. wireLater() registers the
// popover's listeners and is called by app.js from the wiring block they used to
// sit in.
//
// **Drawn with Preact**, the way web/rail.js settled: #later's chips and
// #later-menu's rows are rendered into those two containers, and the containers
// themselves — shown, hidden, grown and positioned by hand — are not Preact's.
// The chips are redrawn on every `later-changed`, which any window or the
// bridge's own clock can push while you are hovering one or have a click half
// done; keyed by message id, a chip keeps its node across that. What it decided:
//
//   - **"Send now" in flight is state, not a disabled attribute written by hand.**
//     `state.laterSending` holds the ids, and the render disables the button, so a
//     push that lands mid-request redraws the chip still disabled.
//   - **The popover's date field keeps its own text** (`PickTime`, a hook), being
//     a form control nothing else reads. Everything else it shows comes from
//     `state.laterPick` and the remembered mode. It is emptied when it closes, so
//     reopening starts the picker fresh, as it always has.
//   - Markup and class names are what el() built, so the CSS did not change; the
//     morph, flip and grow around the chips are unchanged.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.

import { del, get, post } from '../api.js';
import { html, render, useState } from '../vendor/preact.js';
import { dom, toast } from '../dom.js';
import { clip, hhmm, pad } from '../format.js';
import { state } from '../state.js';
import { lockedNow, renderRail, restoreToComposer, saveDraft } from '../app.js';
import { closeSnips } from '../snippets/popover.js';
import { clearAttach, readyAttachments, revokePreviews } from './attachments.js';
import { autoGrow } from './send.js';
import { closeMenus, live } from './slash.js';
import { closeWispr } from './wispr.js';
import { flip, grow, isUp, morph, present } from '../motion.js';

// ── send later ───────────────────────────────────────────────────────────
// The same message, at a time you pick. A send held back rather than a schedule:
// there is no cron here and there is not going to be, because the thing this is
// for is one instruction that is only true at one hour — "you may now modify app
// data to get the screenshots" — and a repeating version of that sentence is not
// a thing anybody wants.
//
// **The mode is the feature, not a detail of it.** A permission ask raised while
// no window is open is denied on the spot and two of those stop the turn, so a
// message delivered at 02:00 in `auto` does not run unattended; it stalls. The
// popover therefore asks how to deliver, in the same breath as when, and remembers
// the answer. It is also why the mode is on the *face* of every chip: a message
// that will wake an agent with no permission gate at 2am is not something you
// should have to expand a row to discover.
//
// The whole list is held rather than this session's, because that is the shape
// `later-changed` carries and the rail wants all of it for its badges.

/** The modes worth offering, loudest first — see the note above about `auto`. */
const LATER_MODES = ['bypassPermissions', 'dontAsk', 'acceptEdits', 'auto', 'plan'];

/** What the popover last delivered in, so the choice survives the next message. */
let laterMode = (() => {
    try { return localStorage.getItem('laterMode') || 'bypassPermissions'; }
    catch { return 'bypassPermissions'; }
})();

/**
 * Take the bridge's whole list and repaint.
 *
 * The rail goes with it. Its badge is drawn from *this* list rather than from the
 * `later` field on the session summary, although that field exists and says the
 * same thing: the rail is rebuilt only when the session list changes, and none of
 * the things that move a scheduled message change it — so a badge read off the
 * summary would still say "02:00" an hour after the message had gone. The summary
 * field is for a client that fetches sessions and nothing else.
 */
export function applyLater(payload) {
    state.later = (payload && payload.messages) || [];
    for (const id of state.laterOpen) {
        if (!state.later.some(m => m.id === id)) state.laterOpen.delete(id);
    }
    for (const id of state.laterSending) {
        if (!state.later.some(m => m.id === id && m.state === 'pending')) state.laterSending.delete(id);
    }
    renderLater();
    renderRail();
}

/** Fetched once; the SSE event keeps it current from then on. */
export async function loadLater() {
    try { applyLater(await get('/api/later')); } catch { /* the event will do it */ }
}

/**
 * "in 6h · 02:00" for something waiting, and what happened for something that is
 * not.
 *
 * Both halves on purpose. The relative one is what you actually think in when you
 * schedule something; the absolute one is what you check when you come back and
 * want to know whether it was before or after you went to bed.
 */
function laterWhen(m) {
    if (m.state === 'sent') return `sent ${hhmm(m.sentAt || m.at)}`;
    if (m.state === 'missed') return 'missed';
    if (m.state === 'failed') return 'failed';
    if (m.state === 'delivering') return 'sending…';
    const left = m.at - Date.now();
    if (left <= 0) return `due · ${hhmm(m.at)}`;
    const mins = Math.round(left / 60000);
    const rel = mins < 60 ? `in ${mins}m` : `in ${Math.round(mins / 60)}h`;
    return `${rel} · ${hhmm(m.at)}`;
}

/** The chips above the queue: this session's messages, soonest first. */
export function renderLater() {
    const mine = state.current
        ? state.later.filter(m => m.sessionId === state.current.sessionId)
        : [];
    // While a subagent is on screen the composer belongs to nothing you can send
    // to, so its chips are out of scope too — renderQueue's rule.
    const show = mine.length > 0 && !state.agent;
    if (!show) {
        grow(dom.later, false, { onGone: () => { if (dom.later.hidden) render(null, dom.later); } });
        return;
    }
    const opening = !isUp(dom.later);
    morph(dom.later, () => flip(dom.later, (n) => n.dataset.id,
        () => render(mine.map(laterChip), dom.later)));
    if (opening) grow(dom.later, true);
}

function laterChip(m) {
    const open = state.laterOpen.has(m.id);
    const done = m.state !== 'pending' && m.state !== 'delivering';
    const bad = m.state === 'missed' || m.state === 'failed';
    const loud = m.permissionMode === 'bypassPermissions' || m.permissionMode === 'dontAsk';
    // "Send now" only while it is still waiting. On a message already sent it
    // would send it twice, and the bridge refuses that — better not to offer it.
    const pending = m.state === 'pending';
    return html`<div key=${m.id} data-id=${m.id}
        class=${`later-chip${open ? ' open' : ''}${done ? ' done' : ''}${bad ? ' bad' : ''}`}>
        <span class="later-when" title=${new Date(m.at).toLocaleString()}>${laterWhen(m)}</span>
        <span class=${`later-mode${loud ? ' loud' : ''}`}
            title=${`It will be delivered in ${m.permissionMode}`}>${m.permissionMode}</span>
        ${m.attachments.length
            ? html`<span class="queue-files">${`${m.attachments.length}📎`}</span>`
            : null}
        <button class="later-text" type="button"
            title=${open ? 'Collapse' : 'Show the whole message'}
            onClick=${() => {
                if (open) state.laterOpen.delete(m.id); else state.laterOpen.add(m.id);
                renderLater();
            }}>${open ? m.text : clip(m.text, 120)}</button>
        <span class="queue-acts">
            ${pending
                ? html`<button class="queue-act" type="button"
                    disabled=${state.laterSending.has(m.id)}
                    title="Deliver this message now instead of waiting"
                    onClick=${() => sendLaterNow(m)}>Send now</button>`
                : null}
            <button class="queue-act danger" type="button"
                title=${pending ? 'Cancel this message' : 'Clear this row'}
                aria-label=${pending ? 'Cancel this message' : 'Clear this row'}
                onClick=${() => cancelLater(m)}>×</button>
        </span>
    </div>`;
}

/** Deliver one now. The bridge runs the same path its clock would. */
async function sendLaterNow(m) {
    state.laterSending.add(m.id);
    renderLater();
    try {
        await post(`/api/later/${m.id}/send`, {});
        toast('Sent.', 'ok');
    } catch (err) {
        // 409 is the wait-for-idle refusal and is not a failure — the message is
        // untouched and pressing again in a minute is the right thing to do.
        toast(`Could not send it yet: ${err.message}`, 'warn');
        state.laterSending.delete(m.id);
        renderLater();
    }
}

async function cancelLater(m) {
    try {
        await del(`/api/later/${m.id}`);
    } catch (err) {
        toast(`Could not cancel it: ${err.message}`, 'error');
    }
}

// The presets. Absolute times are resolved here rather than sent as offsets, so
// the row you picked and the row you get cannot disagree — the bridge's clock and
// this one are the same clock on this machine, but the message says a time and a
// time is what it should be stored as.
function atInMinutes(n) { return Date.now() + n * 60_000; }

/** The next time today or tomorrow that the wall clock reads `h:m`. */
function atClock(h, m) {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
}

function laterPresets() {
    return [
        { label: 'in 30 minutes', at: atInMinutes(30) },
        { label: 'in 2 hours', at: atInMinutes(120) },
        { label: 'tonight at 02:00', at: atClock(2, 0) },
        { label: 'tomorrow at 09:00', at: atClock(9, 0) },
    ];
}

/** `datetime-local` wants local wall-clock text, not an ISO instant. */
function localInputValue(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function showLater(on) {
    if (!on) return closeLater();
    // Only ever one popover up — the slash menu, the mentions and the snippets all
    // close each other, and this joins them rather than becoming the exception.
    closeMenus(live);
    closeSnips(live);
    if (live.wispr) closeWispr(live.wispr);
    state.laterPick = false;
    present(dom.laterMenu, true, { kind: 'pop' });
    dom.btnLater.setAttribute('aria-expanded', 'true');
    drawLater();
    positionLater();
}

export function closeLater({ focus = false } = {}) {
    if (!isUp(dom.laterMenu)) return;
    present(dom.laterMenu, false, { kind: 'pop', onGone: () => render(null, dom.laterMenu) });
    dom.btnLater.setAttribute('aria-expanded', 'false');
    if (focus) dom.btnLater.focus();
}

/** positionSnips' arithmetic, on the one popover that is not a composer's. */
function positionLater() {
    const r = dom.btnLater.getBoundingClientRect();
    const gap = 6;
    const below = window.innerHeight - r.bottom - gap * 2;
    const above = r.top - gap * 2;
    const up = below < 260 && above > below;
    const width = Math.min(320, window.innerWidth - 24);

    dom.laterMenu.classList.toggle('up', up);
    dom.laterMenu.style.setProperty('--snip-max',
        `${Math.max(180, Math.min(460, up ? above : below))}px`);
    dom.laterMenu.style.width = `${width}px`;
    dom.laterMenu.style.left = `${Math.max(12, Math.min(r.right - width,
        window.innerWidth - width - 12))}px`;
    if (up) {
        dom.laterMenu.style.top = 'auto';
        dom.laterMenu.style.bottom = `${window.innerHeight - r.top + gap}px`;
    } else {
        dom.laterMenu.style.bottom = 'auto';
        dom.laterMenu.style.top = `${r.bottom + gap}px`;
    }
}

function drawLater() {
    render(laterMenuTree(), dom.laterMenu);
}

function laterMenuTree() {
    return html`
        ${laterPresets().map(p => html`<button key=${p.label} class="later-row" type="button"
            role="option" onClick=${() => scheduleMessage(p.at)}>
            <span>${p.label}</span><span class="at">${hhmm(p.at)}</span>
        </button>`)}
        <button class=${`later-row${state.laterPick ? ' on' : ''}`} type="button" role="option"
            onClick=${() => { state.laterPick = !state.laterPick; drawLater(); }}>
            <span>Pick a time…</span>
        </button>
        <div class="later-sep"></div>
        <div class="later-fields">
            <label><span>Deliver as</span>
                <select aria-label="Permission mode to deliver in" value=${laterMode}
                    onChange=${(e) => {
                        laterMode = e.target.value;
                        try { localStorage.setItem('laterMode', laterMode); } catch { /* private mode */ }
                    }}>
                    ${LATER_MODES.map(m => html`<option key=${m} value=${m}>${m}</option>`)}
                </select>
            </label>
            ${state.laterPick ? html`<${PickTime} />` : null}
        </div>`;
}

/**
 * The pick-a-time fields. The text in the box is this component's own — nothing
 * else reads it until Schedule is pressed — and it starts an hour out each time
 * the fields are opened.
 */
function PickTime() {
    const [when, setWhen] = useState(() => localInputValue(atInMinutes(60)));
    return html`
        <label><span>At</span>
            <input type="datetime-local" value=${when} min=${localInputValue(Date.now())}
                onInput=${(e) => setWhen(e.target.value)} />
        </label>
        <button class="go" type="button" onClick=${() => {
            // `datetime-local` gives wall-clock text with no zone; `new Date`
            // reads it as local, which is what was typed and what is meant.
            const at = new Date(when).getTime();
            if (!Number.isFinite(at)) return toast('Pick a date and a time.', 'warn');
            if (at <= Date.now()) return toast('That time has already passed.', 'warn');
            scheduleMessage(at);
        }}>Schedule</button>`;
}

/**
 * Hold the message back until `at`.
 *
 * sendMessage()'s body, minus the optimistic row and the unsent-text bookkeeping:
 * nothing is going to the process, so there is no turn to draw and nothing to hand
 * back. What it keeps is everything about *leaving the composer* — the same
 * attachments, the same emptying of the box and the strip, the same
 * restoreToComposer on failure — because from where you are sitting this is the
 * send button with a time on it.
 */
async function scheduleMessage(at) {
    const text = dom.input.value.trim();
    const files = readyAttachments(live);
    if ((!text && !files.length) || !state.current) {
        return toast('Write a message first.', 'warn');
    }

    // The lock is a rule, not a disabled button — sendMessage's words. It matters
    // more here: a message scheduled against a session another process is holding
    // is one that fails at 2am, when nobody is up to read the failure.
    if (lockedNow()) {
        toast('This session is running elsewhere, so a message scheduled here would '
            + 'not be delivered. Branch off a copy first.', 'warn');
        dom.lockFork.focus();
        return;
    }

    const sessionId = state.current.sessionId;
    const previews = files.length
        ? live.attach.filter(a => a.previewUrl).map(a => a.previewUrl) : [];

    dom.input.value = '';
    autoGrow();
    saveDraft(sessionId, '');
    clearAttach(live, { revoke: false });
    revokePreviews(previews);      // no row is drawn, so nothing hands these back
    closeLater();

    try {
        await post(`/api/sessions/${sessionId}/later`, {
            text,
            attachments: files,
            model: dom.model.value || null,
            effort: dom.effort.value || null,
            permissionMode: laterMode,
            at,
        });
        // The chip arrives on the `later-changed` event, which the bridge pushes
        // before this resolves — so there is nothing to draw here.
        toast(`Scheduled for ${new Date(at).toLocaleString()}.`, 'ok');
    } catch (err) {
        restoreToComposer(text, files);
        toast(`Could not schedule it: ${err.message}`, 'error');
    }
}


/**
 * The popover's listeners. Called by app.js from where they were registered
 * when this was one file, so the document click below still lands in the same
 * place in the order of every other document click.
 */
export function wireLater() {
    // Send later. Same gesture as the snippets button next to it, and the same
    // stopPropagation, so the click-outside rule below does not close what it opened.
    dom.btnLater.addEventListener('click', (e) => {
        e.stopPropagation();
        showLater(!isUp(dom.laterMenu));
    });
    // A click inside the popover is not a click outside it. Needed because the fields
    // at the foot of it are things you interact with for a while — picking a date,
    // changing the mode — rather than one press that closes the menu anyway.
    dom.laterMenu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => closeLater());
    // Repositioned rather than closed: the popover is anchored to a button that moves
    // when the composer grows, and closing on a resize would lose a half-typed time.
    window.addEventListener('resize', () => { if (!dom.laterMenu.hidden) positionLater(); });
}
