// `#151` in a message: whose PR it is, and a way to get there.
//
// web/markdown.js marks every `#N` it sees as `<a class="pr-ref" data-pr="N">` and
// knows nothing more — it renders a string with no idea which conversation it is
// for. This module decides what each mark is: by looking the number up in
// `GET /api/pr-owners` under the repositories this conversation is about
// (web/pr-resolve.js holds that rule, and why it is narrow). A mark that resolves
// to another chat becomes `.linked` — a hover card that says which project and
// which chat, and a click that opens it, or a list to pick from when there are
// several. Everything else stays looking like the plain text it used to be.
//
// Decorated by a MutationObserver rather than from each renderer, because `#N`
// can turn up anywhere renderMarkdown is used — a turn, a subagent's log, a plan —
// and a call per site is a call somebody adds a site without. The rows are el()
// DOM, not Preact, so setting a class on them by hand is safe.

import { get } from './api.js';
import { dom, el } from './dom.js';
import { PR_ICON, icon } from './icons.js';
import { reposOf, resolvePrRef, targetLabel, targetsOf } from './pr-resolve.js';
import { state } from './state.js';
import { openContextMenu } from './transcript/context-menu.js';
import { openSession } from './transcript/conversation.js';
import { present } from './motion.js';

// The bridge keeps its answer for thirty seconds; asking more often than that
// buys nothing, and `prs-changed` refetches regardless.
const STALE_MS = 60_000;
const HOVER_DELAY_MS = 150;

let owners = null;          // GET /api/pr-owners, as served
let loadedAt = 0;
let loading = null;
let hoverTimer = 0;

/** Fetch the owner map, then redraw every mark on the page against it. */
export function loadPrOwners() {
    if (loading) return loading;
    loading = get('/api/pr-owners')
        .then((data) => { owners = data; loadedAt = Date.now(); decorate(document); })
        // A bridge from before the route 404s here. The marks stay plain text,
        // which is exactly what they were before this module existed.
        .catch(() => {})
        .finally(() => { loading = null; });
    return loading;
}

/**
 * The repository a session's checkout points at — `repo` off
 * `GET /api/sessions/:id/prs`, handed over by loadPrStatus. Kept with the id it
 * was asked for, so a late answer cannot paint one chat's repo onto the next.
 */
export function notePrRepo(sessionId, repo) {
    state.prRepo = { sessionId, repo: repo || null };
    decorate(document);
}

function context() {
    const cur = state.current;
    if (!cur || !owners) return null;
    const cwdRepo = state.prRepo && state.prRepo.sessionId === cur.sessionId ? state.prRepo.repo : null;
    return {
        repos: reposOf(cwdRepo, cur.prs),
        owners: owners.owners || {},
        prs: owners.prs || {},
        selfId: cur.sessionId,
    };
}

function sectionsFor(a) {
    const ctx = context();
    return ctx ? resolvePrRef(a.dataset.pr, ctx) : [];
}

/** Link the marks that go somewhere; leave the rest as text. */
export function decorate(root) {
    const marks = root.querySelectorAll ? root.querySelectorAll('a.pr-ref') : [];
    if (!marks.length) return;
    const ctx = context();
    for (const a of marks) {
        const sections = ctx ? resolvePrRef(a.dataset.pr, ctx) : [];
        const go = targetsOf(sections).length > 0;
        a.classList.toggle('linked', go);
        if (go) {
            a.tabIndex = 0;
            a.setAttribute('role', 'link');
            a.dataset.sections = String(sections.length);
        } else {
            a.removeAttribute('tabindex');
            a.removeAttribute('role');
            delete a.dataset.sections;
        }
    }
}

// ── the hover card ────────────────────────────────────────────────────────

function showCard(a) {
    const sections = sectionsFor(a);
    if (!targetsOf(sections).length) return hideCard();
    const pop = dom.prPop;
    const stacked = sections.length > 1;
    const many = targetsOf(sections).length > 1;

    const prLine = (n, pr) => el('div', { class: 'pr-pop-pr' },
        pr ? el('span', { class: 'pr', 'data-status': pr.status }, icon(PR_ICON[pr.status] || 'pr', 12)) : null,
        el('span', { class: 'num' }, `#${n}`),
        pr && pr.title ? el('span', { class: 'title' }, pr.title) : null);

    pop.replaceChildren(
        ...(stacked ? [el('div', { class: 'pop-head' }, el('span', {}, `#${a.dataset.pr}`),
            el('span', { class: 'when' }, `${sections.length} projects`))] : []),
        ...sections.map(s => el('div', { class: 'pr-pop-sec' },
            stacked ? el('div', { class: 'pr-pop-proj' }, s.projectName) : null,
            prLine(a.dataset.pr, s.pr),
            stacked ? null : el('div', { class: 'pr-pop-proj' }, s.projectName),
            ...s.entries.map(e => el('div', { class: 'pr-pop-chat' + (e.self ? ' self' : '') },
                e.title || 'Untitled session', e.self ? el('span', { class: 'note' }, ' · this chat') : null)),
        )),
        el('div', { class: 'pr-pop-foot' }, many ? 'Click to choose a chat' : 'Click to open chat'),
    );
    present(pop, true, { kind: 'pop' });

    // Under the mention, flipped above when there is no room, kept on screen.
    const r = a.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const below = r.bottom + 6;
    pop.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below}px`;
    pop.style.left = `${Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8))}px`;
}

export function hideCard() {
    clearTimeout(hoverTimer);
    if (dom.prPop) present(dom.prPop, false, { kind: 'pop' });
}

// ── the click ─────────────────────────────────────────────────────────────

function follow(e, a) {
    e.preventDefault();
    e.stopPropagation();
    hideCard();
    const sections = sectionsFor(a);
    const targets = targetsOf(sections);
    if (!targets.length) return;
    if (targets.length === 1) return openSession(targets[0].sessionId);

    // A list, a project at a time. A keyboard Enter carries no pointer position,
    // which openContextMenu reads as "anchor to currentTarget".
    const items = [];
    let last = null;
    for (const t of targets) {
        if (last !== null && t.projectName !== last) items.push({ sep: true });
        last = t.projectName;
        items.push({ label: targetLabel(t), onClick: () => openSession(t.sessionId) });
    }
    const at = e.clientX || e.clientY ? e : { clientX: 0, clientY: 0, currentTarget: a };
    openContextMenu(at, items);
}

// ── wiring ────────────────────────────────────────────────────────────────

export function wirePrRefs() {
    new MutationObserver((records) => {
        for (const r of records) {
            for (const n of r.addedNodes) {
                if (n.nodeType !== 1) continue;
                if (n.matches('a.pr-ref')) decorate(n.parentNode || n);
                else if (n.querySelector('a.pr-ref')) decorate(n);
            }
        }
    }).observe(document.body, { childList: true, subtree: true });

    const markOf = (t) => (t && t.closest ? t.closest('a.pr-ref.linked') : null);

    document.addEventListener('mouseover', (e) => {
        const a = markOf(e.target);
        if (!a) return;
        clearTimeout(hoverTimer);
        if (Date.now() - loadedAt > STALE_MS) loadPrOwners();
        hoverTimer = setTimeout(() => { if (a.isConnected) showCard(a); }, HOVER_DELAY_MS);
    });
    document.addEventListener('mouseout', (e) => {
        if (markOf(e.target) && !markOf(e.relatedTarget)) hideCard();
    });
    document.addEventListener('focusin', (e) => { const a = markOf(e.target); if (a) showCard(a); });
    document.addEventListener('focusout', (e) => { if (markOf(e.target)) hideCard(); });

    document.addEventListener('click', (e) => {
        const a = markOf(e.target);
        if (a) follow(e, a);
    });
    document.addEventListener('auxclick', (e) => {
        const a = markOf(e.target);
        if (a && e.button === 1) follow(e, a);
    });
    document.addEventListener('keydown', (e) => {
        const a = markOf(e.target);
        if (a && e.key === 'Enter') follow(e, a);
    });

    // Positioned against the mention, so it cannot follow one that scrolls.
    document.addEventListener('scroll', hideCard, { capture: true, passive: true });

    loadPrOwners();
}
