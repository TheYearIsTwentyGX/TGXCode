// "While you were away": a card in the corner, when you come back, saying what
// happened since you left — what is waiting on you first, then what failed,
// what finished, and the rest. The assembly is the bridge's
// (`GET /api/digest`, bridge/digest.js); this decides when you were away and
// draws the answer.
//
// **When you were away is decided here, not at the bridge.** The bridge cannot
// know whether anybody is looking at a window, and two windows and a phone each
// have their own answer, so the route takes `since` and keeps nothing. The rule
// is one timestamp, `lastSeen`: the last moment there is evidence somebody was
// at this window — any pointer, key or wheel event, or the moment it was hidden.
// The first sign of life after a gap of `digest.awayMinutes` or more is a
// return, and the card asks for everything since `lastSeen`. A window left in
// the background with nobody touching it is a gap like any other, which is the
// point: "hidden, or untouched" is one rule, not two.
//
// `lastSeen` is mirrored to localStorage, so a window opened in the morning —
// or reopened after the app restarted — shows the night before. Only a launch
// reads it back; a running window trusts its own memory, so two windows do not
// tread on each other.
//
// **One card, never a stack.** Going away again while the card is still up
// widens it rather than adding a second: the refetch keeps the earlier `since`.
// Dismissing it is what says "seen", and the next card starts from then.
//
// **The asks are live.** A row under "Waiting on you" leaves the moment the ask
// is answered, from here or anywhere else — app.js forwards `permission-resolved`
// and `runner-status` to digestOnResolved()/digestOnRunner() — so the card never
// offers an ask that is already gone.
//
// Drawn with Preact, like web/rail.js. This imports app.js, which imports it
// back; nothing here reads an imported binding while the module evaluates.

import { html, render, useState } from './vendor/preact.js';
import { get } from './api.js';
import { BOOT_PREFS } from './boot.js';
import { dom } from './dom.js';
import { clip } from './format.js';
import { toolDisplayName } from './tool-name.js';
import { openFromNote } from './app.js';
import { openSession } from './transcript/conversation.js';
import { showSched } from './schedules.js';

const STORE_KEY = 'digestLastSeen';
// The log keeps a fortnight; the route refuses older, so ask for no more.
const MAX_SINCE_MS = 14 * 24 * 60 * 60 * 1000 - 60_000;
// Writing localStorage on every pointer move would be silly; once in a while
// is enough for a launch to find roughly when you left.
const PERSIST_EVERY_MS = 30_000;
// How many rows a group shows before "+N more".
const FOLD = 5;

const card = {
    open: false,
    since: null,
    data: null,
    expanded: new Set(),
};
let lastSeen = Date.now();
let lastPersist = 0;
let fetching = false;

const prefs = () => (BOOT_PREFS.digest || { enabled: true, awayMinutes: 20 });

function persist(at, force = false) {
    if (!force && at - lastPersist < PERSIST_EVERY_MS) return;
    lastPersist = at;
    try { localStorage.setItem(STORE_KEY, String(at)); } catch { /* private window */ }
}

function stored() {
    try {
        const n = Number(localStorage.getItem(STORE_KEY));
        return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
}

/** A sign that somebody is here. A long enough gap before it is a return. */
function seen() {
    if (document.visibilityState === 'hidden') return;
    const now = Date.now();
    const gap = now - lastSeen;
    const from = lastSeen;
    lastSeen = now;
    persist(now);
    const p = prefs();
    if (p.enabled && gap >= p.awayMinutes * 60_000) showDigest(from);
}

/** Fetch what happened since `from` and show it, widening a card already up. */
export async function showDigest(from) {
    if (fetching) return;
    const since = Math.max(card.open && card.since ? Math.min(card.since, from) : from,
        Date.now() - MAX_SINCE_MS);
    fetching = true;
    let data;
    try {
        data = await get(`/api/digest?since=${Math.floor(since)}`);
    } catch {
        // Nothing to say about it: a card that failed to load is not news, and
        // the next return will try again.
        return;
    } finally {
        fetching = false;
    }
    if (!data || (!data.total && !card.open)) return;
    card.open = true;
    card.since = since;
    card.data = data;
    draw();
}

export function dismissDigest() {
    card.open = false;
    card.since = null;
    card.data = null;
    card.expanded.clear();
    draw();
}

/** An ask was answered somewhere: take its row away. */
export function digestOnResolved(p) {
    if (!card.open || !card.data) return;
    dropWaiting(w => (p.requestId ? w.requestId === p.requestId : w.sessionId === p.sessionId));
}

/** A runner with nothing pending has no ask left to show. */
export function digestOnRunner(s) {
    if (!card.open || !card.data || s.pendingPermission) return;
    dropWaiting(w => w.sessionId === s.sessionId);
}

function dropWaiting(match) {
    const d = card.data;
    const before = d.waiting.length;
    d.waiting = d.waiting.filter(w => !match(w));
    const gone = before - d.waiting.length;
    if (!gone) return;
    d.counts.waiting = Math.max(0, d.counts.waiting - gone);
    d.total = Math.max(0, d.total - gone);
    draw();
}

/** Start watching for returns. Called once from app.js. */
export function wireDigest() {
    const back = stored();
    if (back) lastSeen = back;
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focus']) {
        window.addEventListener(ev, seen, { passive: true, capture: true });
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            // Present up to now. Recorded rather than inferred: a window that is
            // minimised was being looked at until the instant it went.
            lastSeen = Date.now();
            persist(lastSeen, true);
        } else {
            seen();
        }
    });
    window.addEventListener('pagehide', () => persist(Date.now(), true));
    // A launch after a long gap is a return too. Deferred, so it does not
    // compete with the first paint for the bridge.
    // Unless something already counted as the return in the meantime.
    if (back) setTimeout(() => { if (lastSeen === back) seen(); }, 1500);
}

// ── drawing ────────────────────────────────────────────────────────────────

function awayFor(ms) {
    const m = Math.max(1, Math.round(ms / 60_000));
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

function when(at) {
    if (!at) return '';
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

const ASK_WORDS = { tool: 'wants to use', plan: 'has a plan to approve', question: 'has a question' };
const FAIL_WORDS = {
    failed: 'Failed', stalled: 'Stalled', 'schedule-failed': 'Schedule failed',
    'schedule-missed': 'Schedule missed', 'later-failed': 'Send failed', 'later-missed': 'Send missed',
};
const KIND_WORDS = { question: 'asks', update: 'update', done: 'done' };

const openPr = (url) => url && window.open(url, '_blank', 'noreferrer');

// Each group: which list, what it is called, how a row reads, what a click does.
const GROUPS = [
    {
        key: 'waiting', label: 'Waiting on you', tone: 'ask',
        row: (w) => ({
            id: w.requestId || w.sessionId,
            title: w.title || 'A session',
            sub: w.kind === 'tool' ? `${ASK_WORDS.tool} ${toolDisplayName(w.tool) || 'a tool'}` : ASK_WORDS[w.kind] || 'is waiting',
            at: w.askedAt,
            go: () => openSession(w.sessionId),
        }),
    },
    {
        key: 'failed', label: 'Went wrong', tone: 'bad',
        row: (f) => ({
            id: f.id,
            title: f.title || 'A session',
            sub: `${FAIL_WORDS[f.type] || f.type}${f.summary ? ` · ${f.summary}` : ''}`,
            at: f.at,
            go: () => openFromNote(f),
        }),
    },
    {
        key: 'finished', label: 'Finished',
        row: (f) => ({
            id: f.sessionId,
            title: f.title || 'A session',
            sub: (f.standing && f.standing.text) || (f.turns > 1 ? `${f.turns} turns` : 'Turn finished'),
            at: f.lastAt,
            go: () => openSession(f.sessionId),
        }),
    },
    {
        key: 'prs', label: 'Pull requests',
        row: (p) => ({
            id: p.url || `${p.repo}#${p.number}`,
            title: `#${p.number} ${p.title || ''}`.trim(),
            sub: `${p.change[0].toUpperCase()}${p.change.slice(1)} · ${p.repo}`,
            at: p.at,
            approx: p.approx,
            go: () => openPr(p.url),
        }),
    },
    {
        key: 'schedules', label: 'Schedules that ran',
        row: (s) => ({
            id: s.id,
            title: s.title,
            sub: s.findings || s.lastError || (s.lastOutcome ? `Outcome: ${s.lastOutcome}` : 'Ran'),
            at: s.lastFiredAt,
            go: () => (s.lastSessionId ? openSession(s.lastSessionId) : showSched(true)),
        }),
    },
    {
        key: 'reports', label: 'Worker reports',
        row: (r) => ({
            id: `${r.orchestratorId}:${r.workerId}:${r.at}`,
            title: r.workerTitle || 'A worker',
            sub: `${KIND_WORDS[r.kind] || r.kind} · ${clip(r.text.replace(/\s+/g, ' '), 140)}`,
            at: r.at,
            go: () => openSession(r.orchestratorId),
        }),
    },
    {
        key: 'suggestions', label: 'Follow-ups filed',
        row: (s) => ({
            id: `${s.sessionId}:${s.id}`,
            title: s.title || 'A follow-up',
            sub: s.from ? `From ${s.from}` : '',
            at: Date.parse(s.ts) || 0,
            go: () => openSession(s.sessionId),
        }),
    },
];

function Group({ g, list, count }) {
    const [open, setOpen] = useState(card.expanded.has(g.key));
    if (!count) return null;
    const rows = list.map(g.row);
    const shown = open ? rows : rows.slice(0, FOLD);
    const hidden = rows.length - shown.length;
    const unlisted = count - rows.length;
    return html`
        <section class="digest-group" data-tone=${g.tone || null} key=${g.key}>
            <h3 class="digest-group-head">
                <span>${g.label}</span><span class="digest-count">${count}</span>
            </h3>
            <ul class="digest-rows">
                ${shown.map(r => html`
                    <li key=${r.id}>
                        <button type="button" class="digest-row" onClick=${r.go}>
                            <span class="digest-row-title">${r.title}</span>
                            <span class="digest-row-at"
                                title=${r.approx ? 'When this was noticed, not when it happened' : null}
                                >${r.approx ? '≈ ' : ''}${when(r.at)}</span>
                            ${r.sub ? html`<span class="digest-row-sub">${r.sub}</span>` : null}
                        </button>
                    </li>`)}
            </ul>
            ${hidden > 0 ? html`
                <button type="button" class="digest-more"
                    onClick=${() => { card.expanded.add(g.key); setOpen(true); }}
                    >+${hidden} more</button>` : null}
            ${open && unlisted > 0 ? html`
                <p class="digest-more-note">${unlisted} more not listed</p>` : null}
        </section>`;
}

function Card({ d }) {
    const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); dismissDigest(); }
    };
    return html`
        <div class="digest-card" role="region" aria-label="While you were away" onKeyDown=${onKey}>
            <header class="digest-head">
                <h2 class="digest-title">While you were away${' '}
                    <span class="digest-away">· ${awayFor(d.now - d.since)}</span></h2>
                <button type="button" class="digest-close" aria-label="Dismiss"
                    title="Dismiss (Esc)" onClick=${dismissDigest}>✕</button>
            </header>
            <div class="digest-body">
                ${d.total ? GROUPS.map(g => html`
                    <${Group} key=${g.key} g=${g} list=${d[g.key] || []}
                        count=${(d.counts && d.counts[g.key]) || 0}/>`)
                    : html`<p class="digest-empty">Nothing left that needs you.</p>`}
            </div>
        </div>`;
}

function draw() {
    if (!dom.digest) return;
    render(card.open && card.data ? html`<${Card} d=${card.data}/>` : null, dom.digest);
}
