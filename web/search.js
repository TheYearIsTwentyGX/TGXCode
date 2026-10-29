// Search transcripts: full text across every session, drawn with Preact.
//
// The bar's filter matches what a session is *called* — its title, its first
// prompt, its directory. This matches what was *said* in it, through
// `GET /api/search` (bridge/search-index.js), and a hit is a place: clicking it
// opens the session at the turn the words are in, even a turn far above the few
// a session opens with.
//
// Decided:
//
// - **A panel, not a dropdown.** A result is a line of somebody's conversation
//   with the words marked in it, grouped under the session it came from, and
//   that needs the width and the height a dropdown under a 200px field does not
//   have. It is one of app.js's PANELS, so it closes the others, takes Escape,
//   and is remembered in the address like them. Its key is `sx` rather than
//   `search` because `dom.search` is the bar's filter and a panel's key names
//   its section.
//
// - **Two ways in, and one for code.** Ctrl+Shift+F (rebindable, `search.open`),
//   and Enter in the bar's filter, which carries the filter's words across —
//   the moment the filter finds nothing is exactly when this is the next thing
//   to try. `openSearch(q)` is the same door for anything else that wants it.
//
// - **Tool calls are opt-in.** They are most of a transcript's bytes and almost
//   all of its noise — every `ls` and every file read — so "Include tools" is a
//   toggle, off until you turn it on.
//
// - **The jump goes through the turn rail.** A hit names its turn by the id the
//   turn index gives it, so the jump is `jumpToTurn` on the rail's own entry —
//   which already knows how to fetch the stretch above the loaded part — and
//   then the exact message, when it is in that turn and loaded, is flashed.
//
// - **The index may still be filling.** The bridge answers within a budget and
//   says how many sessions it has not finished reading (`pending`). That is said
//   here, with a button to ask again, rather than leaving a short list looking
//   like the whole answer.

import { html } from './vendor/preact.js';
import { get } from './api.js';
import { state } from './state.js';
import { dom } from './dom.js';
import { ago } from './format.js';
import { toolNamesIn } from './tool-name.js';
import { closeOtherPanels, openAtHit, paintPanels, projectColor, rememberView } from './app.js';
import { paint } from './boards/parts.js';
import { termPane } from './term-pane.js';
import { loadEarlier } from './transcript/earlier.js';
import { jumpToTurn, revealNode } from './transcript/turn-rail.js';

const DEBOUNCE_MS = 250;
let timer = null;

export function showSearch(on) {
    state.sx.open = on;
    if (on) closeOtherPanels('sx');
    paintPanels();
    if (on) {
        renderSearch();
        requestAnimationFrame(() => { dom.sxInput.focus(); dom.sxInput.select(); });
    } else if (state.current) {
        termPane.refit();
    }
    rememberView();
}

/**
 * Open the panel on these words and run them. For the bar's filter, and for
 * anything else that wants to send somebody here with a question already asked.
 */
export function openSearch(q = '') {
    const words = String(q || '').trim();
    if (words) {
        dom.sxInput.value = words;
        state.sx.q = words;
    }
    showSearch(true);
    if (words) runSearch();
}

/** Ask the bridge, dropping any answer that arrives after a newer question. */
export async function runSearch() {
    clearTimeout(timer);
    const q = state.sx.q.trim();
    const seq = ++state.sx.seq;
    if (!q) {
        state.sx.data = null;
        state.sx.error = null;
        state.sx.loading = false;
        renderSearch();
        return;
    }
    state.sx.loading = true;
    renderSearch();
    const kinds = state.sx.tools ? 'user,assistant,tool' : 'user,assistant';
    try {
        const data = await get(`/api/search?q=${encodeURIComponent(q)}&kinds=${kinds}`);
        if (seq !== state.sx.seq) return;
        state.sx.data = data;
        state.sx.error = null;
    } catch (err) {
        if (seq !== state.sx.seq) return;
        state.sx.error = err.message;
    }
    state.sx.loading = false;
    renderSearch();
}

/**
 * Put you on the message a hit came from. Called by app.js's takePendingJump
 * once the session it opened has its first window drawn.
 */
export async function jumpToHit(hit) {
    let entry = null;
    if (hit.turnId) {
        entry = state.turns.find(t => t.ev.id === hit.turnId) || null;
        if (entry) await jumpToTurn(entry);
    } else if (state.windowStart) {
        // Said before the first message of your own — a compaction summary, or a
        // session a schedule started — so the top of the file is where it is.
        await loadEarlier({ through: { offset: 0 } });
    }
    // The message itself, when it is not the turn you were already put on.
    const exact = state.nodes.get(hit.eventId) || state.tools.get(hit.eventId);
    if (exact && exact.node && (!entry || exact.node !== entry.node)) revealNode(exact.node);
}

const KIND_LABEL = { user: 'You', assistant: 'Claude', tool: 'Tool' };

// A tool hit's text opens with the tool's raw name, which is what the index
// holds. Friendlier here rather than in the index, which would mean rebuilding
// every session's; searching still matches the raw name.
const friendly = toolNamesIn;

function Segments({ segments, tool }) {
    return segments.map((s, i) => (s.hit
        ? html`<mark key=${i}>${tool ? friendly(s.text) : s.text}</mark>`
        : html`<span key=${i}>${tool ? friendly(s.text) : s.text}</span>`));
}

function Hit({ session, hit }) {
    const open = () => openAtHit(session.sessionId, hit);
    return html`<button class="sx-hit" type="button" data-kind=${hit.kind} onClick=${open}
            title=${hit.turnNo > 0 ? `Turn ${hit.turnNo} of ${session.turns}` : 'Before the first turn'}>
        <span class="sx-hit-kind">${KIND_LABEL[hit.kind] || hit.kind}</span>
        <span class="sx-hit-text"><${Segments} segments=${hit.segments} tool=${hit.kind === 'tool'} /></span>
        <span class="sx-hit-when">${hit.turnNo > 0 ? `turn ${hit.turnNo}` : ''}</span>
    </button>`;
}

function Session({ s }) {
    const colour = projectColor(s.projectCwd || s.cwd);
    return html`<section class="sx-session" key=${s.sessionId} data-id=${s.sessionId}
            style=${colour ? `--sx-proj: ${colour}` : ''}>
        <header class="sx-session-head">
            <button class="sx-session-title" type="button"
                    onClick=${() => openAtHit(s.sessionId, null)}>${s.title || 'Untitled session'}</button>
            <span class="sx-session-meta">
                ${s.projectName || ''}${s.mtimeMs ? ` · ${ago(s.mtimeMs)}` : ''}
                ${' · '}${s.hitCount} ${s.hitCount === 1 ? 'match' : 'matches'}
            </span>
        </header>
        <div class="sx-hits">
            ${s.hits.map(h => html`<${Hit} key=${h.eventId} session=${s} hit=${h} />`)}
            ${s.more ? html`<p class="sx-more">and ${s.more} more in this session</p>` : null}
        </div>
    </section>`;
}

function note(text, extra = null) {
    return html`<div key="note" class="sx-note"><p>${text}</p>${extra}</div>`;
}

export function renderSearch() {
    if (!state.sx.open) return;
    const { q, data, loading, error, tools } = state.sx;
    dom.sxTools.setAttribute('aria-pressed', String(tools));
    dom.sxTools.classList.toggle('on', tools);

    if (error) {
        dom.sxSub.textContent = 'The search did not finish.';
        paint(dom.sxBody, note(`Could not search: ${error}`));
        return;
    }
    if (!q.trim()) {
        dom.sxSub.textContent = 'Everything you and Claude said, in every session.';
        paint(dom.sxBody, note('Type a few words. Every word has to be in the same message; '
            + 'put a phrase in quotes to keep it whole.'));
        return;
    }
    if (!data) {
        dom.sxSub.textContent = loading ? 'Searching…' : '';
        paint(dom.sxBody, html`<div key="empty"></div>`);
        return;
    }

    const shown = data.sessions.length;
    const parts = [];
    parts.push(data.matched
        ? `${data.matched} ${data.matched === 1 ? 'session' : 'sessions'} matched`
        : 'Nothing matched');
    if (data.truncated) parts.push(`showing the newest ${shown}, so narrow the search to see the rest`);
    if (loading) parts.push('searching…');
    dom.sxSub.textContent = `${parts.join(' · ')}.`;

    const pending = data.pending
        ? html`<div key="pending" class="sx-pending">
            <span>Still reading ${data.pending} ${data.pending === 1 ? 'session' : 'sessions'}, so more may turn up.</span>
            <button class="dash-btn" type="button" onClick=${runSearch}>Search again</button>
          </div>`
        : null;
    if (!shown) {
        paint(dom.sxBody, html`<div key="none">${pending}${note(tools
            ? 'No message or tool call has all of those words.'
            : 'No message has all of those words. Tool calls are left out; include them to look there too.')}</div>`);
        return;
    }
    paint(dom.sxBody, html`<div key="list" class="sx-list">
        ${pending}
        ${data.sessions.map(s => html`<${Session} key=${s.sessionId} s=${s} />`)}
    </div>`);
}

/** Listeners on the panel's own controls. Called once, from app.js. */
export function wireSearch() {
    dom.sxInput.addEventListener('input', () => {
        state.sx.q = dom.sxInput.value;
        clearTimeout(timer);
        timer = setTimeout(runSearch, DEBOUNCE_MS);
    });
    dom.sxInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
    });
    dom.sxTools.addEventListener('click', () => {
        state.sx.tools = !state.sx.tools;
        runSearch();
    });
}
