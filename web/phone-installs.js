// APKs on their way to the phone: a pill in the bar while there is one from the
// last 24 hours, a popover listing them, and one toast per install rewritten in
// place as the `phone_install` events arrive.
//
// The record is filed by an agent (the install_on_phone tool) and moved on by
// the TGXCode app on the phone — see bridge/phone-installs.js. The toast used to
// be the only sign of one, and a toast goes away: an install the phone claimed
// and then never reported on again looked, from the desk, exactly like one that
// had not been filed. The pill is what stays. It turns yellow for the three
// things somebody has to look at — a phone gone quiet (`stalled`), a failure
// nobody has opened the popover on since, and Android waiting on a tap — and the
// popover's Retry is the way out of the first two.
//
// **The records are the bridge's.** `state.phoneInstalls` is a cache of
// `GET /api/phone-installs`, refilled on every reconnect (connect() in app.js)
// and kept current by the events, which carry the whole record. `stalled` is the
// bridge's, but a record goes stalled by the clock passing rather than by an
// event, so it is also worked out here against `updatedAt` — the bridge
// broadcasts the moment once, and a window that missed it should not have to
// wait for the next change to show it.
//
// The pill and the popover body are Preact's (the containers #pi-pill and
// #pi-body); the wrap's `hidden`, the button's title and `present()` on the menu
// are hand-edited, the split web/quota.js describes. The toast is built by
// toast() in dom.js and edited by hand afterwards, which is fine there and would
// not be under Preact: these nodes are `el()`'s.
//
// **Where it sits is Settings → Toolbar's** (`phoneInstalls` in web/settings/
// toolbar.js): the bar, the More menu or nowhere. `hidden` on the wrap stays
// this module's — nothing from the last day — and holds in every place, so in
// the More menu it is a row only while there is a list behind it. The pill
// carries a name and a `.bar-badge` that only the menu shows, which is how the
// ⋯ button counts it. The popover cannot hang off a pill that is in a closed
// menu or not drawn, so off the bar it is moved out to the bar itself and
// pinned under ⋯ (or the bar's right end) — see dockPhoneInstalls(). The
// toast and the palette open it the same way wherever the pill is.

import { html, render } from './vendor/preact.js';
import { get, post } from './api.js';
import { state } from './state.js';
import { dom, toast } from './dom.js';
import { ago } from './format.js';
import { isUp, present } from './motion.js';
import { showCv, showQuota } from './quota.js';
import { showNewMenu } from './new-session/recent.js';
import { showBarMore } from './settings/toolbar.js';

/** id → record, as the bridge last said. */
state.phoneInstalls = new Map();
/** When the popover was last opened: a failure older than that has been seen. */
state.phoneInstallsSeenAt = 0;

/** The pill's horizon, and the bridge's: an APK is gone after a day. */
const RECENT_MS = 24 * 60 * 60 * 1000;
/** How many the popover lists, which is what `GET /api/phone-installs` returns. */
const LIMIT = 20;
/** The bridge's STALL_MS. */
const STALL_MS = 90 * 1000;
/** How often relative times move while something is in flight. */
const TICK_MS = 10 * 1000;

const CLAIMED = new Set(['downloading', 'installing']);
const IN_FLIGHT = new Set(['pending', 'downloading', 'installing', 'needs_action']);

const isStalled = (r, now = Date.now()) =>
    !!r.stalled || (CLAIMED.has(r.state) && now - r.updatedAt > STALL_MS);

const canRetry = (r) => r.state === 'failed' || r.state === 'needs_action' || r.state === 'cancelled'
    || isStalled(r);
const canCancel = (r) => r.state === 'pending' || r.state === 'downloading';

function name(r) {
    if (r.packageName) return `${r.packageName}${r.versionName ? ` ${r.versionName}` : ''}`;
    return r.label || r.fileName;
}

function percent(r) {
    const p = r.progress;
    return p && p.total > 0 ? Math.min(100, Math.round((p.bytes / p.total) * 100)) : null;
}

/** Newest first, the last day's, at most LIMIT. */
function recent(now = Date.now()) {
    return [...state.phoneInstalls.values()]
        .filter(r => now - Math.max(r.createdAt, r.updatedAt) < RECENT_MS)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, LIMIT);
}

// ── the toast ────────────────────────────────────────────────────────────

/** id → {node, timer} for the toasts still up. */
const open = new Map();

/** How long a toast stays once nothing more is expected, by state. */
const LINGER_MS = { installed: 6000, failed: 12000, cancelled: 4000, needs_action: 15000 };
/** And while the phone is still working — long enough to see it move. */
const WORKING_MS = 20000;

function describe(r) {
    if (isStalled(r)) return [`The phone stopped reporting on ${name(r)}`, 'warn'];
    switch (r.state) {
    case 'pending':
        return [`Queued for the phone: ${r.label || r.fileName}${r.message ? ` — ${r.message}` : ''}`, 'info'];
    case 'downloading': {
        const pct = percent(r);
        return [`The phone is downloading ${r.label || r.fileName}…${pct === null ? '' : ` ${pct}%`}`, 'info'];
    }
    case 'installing': return [`Installing ${name(r)} on the phone…`, 'info'];
    case 'needs_action': return [`${name(r)}: tap Install on the phone`, 'warn'];
    case 'installed': return [`Installed ${name(r)} on the phone`, 'ok'];
    case 'failed':
        return [`Phone install failed: ${name(r)}${r.message ? ` — ${r.message}` : ''}`, 'error'];
    case 'cancelled':
        return [`Phone install cancelled: ${name(r)}${r.message ? ` — ${r.message}` : ''}`, 'info'];
    default: return [`${name(r)}: ${r.state}`, 'info'];
    }
}

function dismiss(id) {
    const t = open.get(id);
    if (!t) return;
    clearTimeout(t.timer);
    open.delete(id);
    const close = t.node.querySelector('.toast-close');
    if (close && t.node.isConnected) close.click();
}

function cancelInstall(id) {
    open.delete(id);
    post(`/api/phone-installs/${encodeURIComponent(id)}/cancel`)
        .catch(err => toast(`Could not cancel: ${err.message}`, 'error'));
}

function retryInstall(id) {
    post(`/api/phone-installs/${encodeURIComponent(id)}/retry`)
        .catch(err => toast(`Could not retry: ${err.message}`, 'error'));
}

function showToast(r) {
    const [text, kind] = describe(r);
    let t = open.get(r.id);
    if (t && !t.node.isConnected) { open.delete(r.id); t = null; }

    if (!t) {
        // Cancel is offered while nothing has reached the phone's installer. The
        // toast's own timeout is pushed out of reach (setTimeout's ceiling), so
        // the timer below, reset on every event, is the one that decides.
        const node = toast(text, kind, {
            action: canCancel(r) && !state.remote ? { label: 'Cancel', onClick: () => cancelInstall(r.id) } : null,
            ms: 2 ** 31 - 1,
        });
        // The rest of the toast opens the popover, where the whole story is.
        node.classList.add('pi-toast');
        node.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            e.stopPropagation();
            showPhoneInstalls(true);
        });
        t = { node, timer: null };
        open.set(r.id, t);
    } else {
        t.node.dataset.kind = kind;
        t.node.querySelector('.toast-text').textContent = text;
        // Too late to take it back once the phone's installer has it.
        if (!canCancel(r)) {
            const act = t.node.querySelector('.toast-action');
            if (act) act.remove();
        }
    }

    clearTimeout(t.timer);
    t.timer = setTimeout(() => dismiss(r.id), isStalled(r) ? LINGER_MS.failed : LINGER_MS[r.state] || WORKING_MS);
}

// ── the cache ────────────────────────────────────────────────────────────

/** One `phone_install` event: the whole record. */
export function applyPhoneInstall(r) {
    if (!r || !r.id) return;
    state.phoneInstalls.set(r.id, r);
    showToast(r);
    renderPhoneInstalls();
}

/** On every reconnect: the events missed while the stream was down. */
export async function loadPhoneInstalls() {
    try {
        const { installs } = await get('/api/phone-installs');
        state.phoneInstalls = new Map((installs || []).map(r => [r.id, r]));
        renderPhoneInstalls();
    } catch {
        // A bridge from before the route, or one that is down: no pill.
    }
}

// ── the pill and the popover ─────────────────────────────────────────────

const PHONE_ICON = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="6.2" y="2.8" width="11.6" height="18.4" rx="2.4" stroke="currentColor" stroke-width="1.7"/>
    <path d="M10.4 17.9h3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
</svg>`;

/** What the pill says, its tint, and its title. */
function summary(rows, now) {
    const flight = rows.filter(r => IN_FLIGHT.has(r.state));
    const stalled = rows.filter(r => isStalled(r, now));
    const failed = rows.filter(r => r.state === 'failed' && r.updatedAt > state.phoneInstallsSeenAt);
    const waiting = rows.filter(r => r.state === 'needs_action');
    let text = '';
    if (stalled.length) text = 'Stalled';
    else if (failed.length) text = 'Failed';
    else if (waiting.length) text = 'Tap Install';
    else if (flight.length === 1 && percent(flight[0]) !== null) text = `${percent(flight[0])}%`;
    else if (flight.length) text = String(flight.length);
    const kind = stalled.length || failed.length || waiting.length ? 'warn' : flight.length ? 'busy' : 'idle';
    const parts = [];
    for (const [n, what] of [[flight.length, 'in flight'], [stalled.length, 'stalled'],
        [failed.length, 'failed'], [waiting.length, 'waiting for a tap on the phone']]) {
        if (n) parts.push(`${n} ${what}`);
    }
    // What the More menu's ⋯ adds up: everything still moving or wanting a look.
    const count = flight.length + failed.length;
    return { text, kind, count, title: `Phone installs${parts.length ? ` — ${parts.join(', ')}` : ''}` };
}

/** "downloading · 3m, no update for 2m" */
function stateLine(r, now) {
    const word = r.state === 'pending' ? 'queued' : r.state.replace('_', ' ');
    if (!IN_FLIGHT.has(r.state)) return `${word} · ${ago(r.updatedAt) === 'now' ? 'just now' : `${ago(r.updatedAt)} ago`}`;
    const age = ago(r.createdAt);
    let line = `${word} · ${age === 'now' ? 'just now' : age}`;
    if (CLAIMED.has(r.state) && now - r.updatedAt >= 60 * 1000) line += `, no update for ${ago(r.updatedAt)}`;
    if (r.attempts > 1) line += ` · attempt ${r.attempts}`;
    return line;
}

function copyLine(r) {
    const pkg = r.packageName ? `, ${name(r)}` : '';
    return `${r.label} (${r.fileName}${pkg}) — install id ${r.id}`;
}

function rowV(r, now) {
    const stalled = isStalled(r, now);
    const pct = r.state === 'downloading' ? percent(r) : null;
    const act = (label, title, fn, primary = false) => html`<button key=${label} type="button"
        class=${`quota-refresh pi-act${primary ? ' primary' : ''}`}
        title=${title} onClick=${(e) => { e.stopPropagation(); fn(); }}>${label}</button>`;
    return html`<div key=${r.id} class="q-row pi-row" data-state=${r.state} data-stalled=${stalled ? '1' : '0'}>
        <div class="q-row-top">
            <span class="pi-label" title=${r.label}>${r.label}</span>
        </div>
        ${(r.packageName || r.fileName !== r.label) && html`<div class="pi-pkg">
            ${r.packageName ? name(r) : r.fileName}</div>`}
        <div class="q-row-sub"><span class="pi-state">${stateLine(r, now)}</span>
            ${pct !== null && html`<span>${pct}%</span>`}</div>
        ${pct !== null && html`<div class="q-bar"><i style=${`width: ${pct}%`}></i></div>`}
        ${r.message && html`<div class="pi-msg">${r.message}</div>`}
        <div class="pi-acts">
            ${canRetry(r) && act('Retry', 'Put it back in the queue for the phone', () => retryInstall(r.id),
                stalled || r.state === 'failed')}
            ${canCancel(r) && !state.remote && act('Cancel', 'Take it back before the phone installs it',
                () => cancelInstall(r.id))}
            ${act('Copy', 'Copy the label, file and install id', () => {
                navigator.clipboard.writeText(copyLine(r))
                    .then(() => toast('Copied', 'info', 1500))
                    .catch(() => toast('Could not copy', 'error'));
            })}
        </div>
    </div>`;
}

let ticker = 0;

export function renderPhoneInstalls() {
    const now = Date.now();
    const rows = recent(now);
    dom.piWrap.hidden = !rows.length;
    if (!rows.length && !dom.piMenu.hidden) showPhoneInstalls(false);
    const s = summary(rows, now);
    dom.piPill.dataset.kind = s.kind;
    dom.piPill.title = s.title;
    dom.piPill.setAttribute('aria-label', s.title);
    render(html`${PHONE_ICON}<span class="pi-name">Phone installs</span>
        ${s.text && html`<span class="pi-text">${s.text}</span>`}
        <span class=${s.kind === 'warn' ? 'bar-badge urgent' : 'bar-badge'} hidden=${!s.count}>${s.count}</span>`,
    dom.piPill);
    if (!dom.piMenu.hidden) {
        render(rows.length ? rows.map(r => rowV(r, now))
            : html`<div class="quota-note">Nothing sent to the phone in the last day.</div>`, dom.piBody);
    }
    // Relative times and `stalled` move with the clock, so the pill re-reads it
    // while there is something whose words would change.
    const moving = rows.some(r => IN_FLIGHT.has(r.state)) || !dom.piMenu.hidden;
    if (moving && !ticker) ticker = setInterval(renderPhoneInstalls, TICK_MS);
    else if (!moving && ticker) { clearInterval(ticker); ticker = 0; }
}

/**
 * Put the popover where it can be seen: inside the pill while the pill is on
 * the bar, and otherwise — in the More menu, spilled there by a narrow window,
 * or hidden by Settings — on the bar, fixed under the ⋯ button or the bar's
 * right-hand end. Called by paintToolbar() on every refit and again on open.
 */
export function dockPhoneInstalls() {
    const bar = dom.barMoreWrap.parentElement;
    const onBar = dom.piWrap.parentElement === bar && !dom.piWrap.hasAttribute('data-bar-hidden');
    const home = onBar ? dom.piWrap : bar;
    if (dom.piMenu.parentElement !== home) home.appendChild(dom.piMenu);
    dom.piMenu.classList.toggle('pi-detached', !onBar);
    if (onBar) { dom.piMenu.style.top = ''; dom.piMenu.style.right = ''; return; }
    const r = !dom.barMoreWrap.hidden ? dom.barMore.getBoundingClientRect() : bar.getBoundingClientRect();
    const pad = dom.barMoreWrap.hidden ? parseFloat(getComputedStyle(bar).paddingRight) || 0 : 0;
    dom.piMenu.style.top = `${r.bottom + 8}px`;
    dom.piMenu.style.right = `${window.innerWidth - r.right + pad}px`;
}

export function showPhoneInstalls(on) {
    if (on && dom.piWrap.hidden) return;
    if (on === isUp(dom.piMenu)) return;
    if (on) dockPhoneInstalls();
    present(dom.piMenu, on, { as: 'menu' });
    dom.piPill.setAttribute('aria-expanded', String(on));
    if (on) {
        showQuota(false); showCv(false); showNewMenu(false); showBarMore(false);
        // Opening it is having seen the failures in it; the pill stops shouting.
        state.phoneInstallsSeenAt = Date.now();
    }
    renderPhoneInstalls();
}

dom.piPill.addEventListener('click', (e) => {
    e.stopPropagation();
    showPhoneInstalls(!isUp(dom.piMenu));
});

document.addEventListener('click', (e) => {
    if (!dom.piMenu.hidden && !e.target.closest('#pi-wrap, #pi-menu')) showPhoneInstalls(false);
});

// Drawn once now, empty, so the pill has its icon before anything was sent —
// the Toolbar settings row copies its glyph from it.
renderPhoneInstalls();
