// Every image in this conversation, once each: a side pane of thumbnails, opened
// large in the image viewer with a way back to the message it came from.
//
// The bridge decides what counts and does the deduplicating — see
// bridge/image-index.js and GET /api/sessions/:id/images in docs/api.md. An
// entry is one picture however many times it appeared, so the tile carries a ×N
// and the viewer steps through the N places, each with Jump to message.
//
// The pane is the Reviews pane's twin: the same `.tasks` box, strip and header,
// put in and taken out by slidePane, its open/shut remembered per window, and
// refreshed on the same two signals (a turn ending, the transcript growing).
//
// This imports conversation.js, which imports it back. Safe for the reason
// changes.js gives: nothing here reads an imported binding at module top level.

import { get } from '../api.js';
import { dom, toast } from '../dom.js';
import { html, render } from '../vendor/preact.js';
import { ago } from '../format.js';
import { state } from '../state.js';
import { renderHeaderActions } from './conversation.js';
import { loadEarlier } from './earlier.js';
import { openImage } from './image-viewer.js';
import { slidePane, syncPaneInsets } from './layout.js';
import { revealNode } from './turn-rail.js';

// A list fetched this recently is not fetched again just because the pane was
// opened twice. A turn ending, or the transcript growing, refetches regardless.
const IMAGES_STALE_MS = 15_000;
// How long a burst of transcript appends is gathered before the pane asks again.
// An unchanged transcript costs the bridge a stat, but a streaming turn appends
// several times a second.
const TAIL_DEBOUNCE_MS = 1500;

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

// ── the pane ─────────────────────────────────────────────────────────────

/** Put the pane in the layout, or take it out. Remembered across sessions. */
export function showImages(on) {
    state.images.on = on;
    localStorage.setItem('imagesOn', on ? '1' : '0');
    if (on) collapseImages(false, { render: false });
    renderImages();
    renderHeaderActions();
    if (on) loadImagesIfStale();
}

/** Collapse it to its strip, or bring it back. */
export function collapseImages(shut, { render: draw = true } = {}) {
    state.images.shut = shut;
    localStorage.setItem('imagesShut', shut ? '1' : '0');
    if (!draw) return;
    renderImages();
    syncPaneInsets();
    (shut ? dom.imagesStrip : dom.imagesCollapse).focus();
    if (!shut) loadImagesIfStale();
}

const paneUp = () => !!state.current && state.images.on && !state.images.shut;

export function loadImagesIfStale() {
    const s = state.current;
    if (!s || !paneUp()) return;
    const fresh = state.images.sessionId === s.sessionId
        && Date.now() - state.images.at < IMAGES_STALE_MS;
    if (!fresh) loadImages();
}

let tailTimer = null;

/**
 * Something may have added an image: a turn ended, or (`{tail: true}`) the
 * transcript grew. Fetched only while the pane is up — nothing else draws this.
 */
export function refreshImages({ tail = false } = {}) {
    if (!state.current) return;
    // Shut, the list is only marked out of date, so opening it asks again.
    if (!paneUp()) { state.images.at = 0; return; }
    if (!tail) { loadImages(); return; }
    clearTimeout(tailTimer);
    tailTimer = setTimeout(() => { tailTimer = null; loadImages(); }, TAIL_DEBOUNCE_MS);
}

/** Forget what is on screen — the conversation it was about has changed. */
export function resetImages() {
    clearTimeout(tailTimer);
    tailTimer = null;
    state.images.data = null;
    state.images.sessionId = null;
    state.images.at = 0;
    state.images.error = null;
}

export async function loadImages() {
    const s = state.current;
    if (!s || state.images.loading) return;
    const id = s.sessionId;
    state.images.loading = true;
    state.images.error = null;
    try {
        const d = await get(`/api/sessions/${encodeURIComponent(id)}/images`);
        if (!state.current || state.current.sessionId !== id) return;
        state.images.data = d.images || [];
        state.images.sessionId = id;
        state.images.at = Date.now();
    } catch (err) {
        state.images.error = err.message;
    } finally {
        state.images.loading = false;
        // A conversation opened while this was on the wire was turned away by
        // the `loading` guard above, so it is asked for now.
        if (state.current && state.current.sessionId !== id) loadImagesIfStale();
        renderImages();
    }
}

export function renderImages() {
    const present = !!state.images.on && !!state.current;
    slidePane(dom.images, present);
    if (!present) return;

    const list = state.images.data;
    const label = list ? String(list.length) : (state.images.error ? '!' : '…');
    dom.imagesCount.textContent = label;
    dom.imagesStripCount.textContent = label;
    dom.imagesStrip.hidden = !state.images.shut;
    dom.imagesOpen.hidden = state.images.shut;
    dom.images.classList.toggle('shut', state.images.shut);
    if (state.images.shut) return;
    render(imagesGrid(list), dom.imagesBody);
}

function imagesGrid(list) {
    if (state.images.error && !list) {
        return html`<p class="img-empty">Could not read the images: ${state.images.error}</p>`;
    }
    if (!list) return html`<p class="img-empty">Reading the transcript…</p>`;
    if (!list.length) {
        return html`<div class="img-empty">
            <p>No images in this chat yet.</p>
            <p class="img-empty-sub">Pictures you attach, and screenshots or images a tool hands back, collect here.</p>
        </div>`;
    }
    // Newest first, as the bridge sends them: the one that just arrived is the
    // one you came for.
    return html`<ul class="img-grid">${list.map(tile)}</ul>`;
}

function kb(n) {
    return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function describe(img) {
    const bits = [img.label];
    if (img.width && img.height) bits.push(`${img.width}×${img.height}`);
    bits.push(kb(img.bytes));
    if (img.count > 1) bits.push(`appears ${img.count} times`);
    const when = ago(img.at);
    if (when) bits.push(when === 'now' ? 'just now' : /\d[mhd]$/.test(when) ? `${when} ago` : `on ${when}`);
    return bits.join(' · ');
}

function tile(img) {
    const text = describe(img);
    return html`<li key=${img.key} class="img-cell">
        <button type="button" class="img-tile" title=${text} aria-label=${`Open ${text}`}
            onClick=${() => openLarge(img)}>
            ${img.url ? html`<img class="img-thumb" src=${img.url} alt="" loading="lazy" decoding="async"
                width=${img.width} height=${img.height} />`
                : html`<span class="img-thumb img-thumb-none">${img.mediaType}</span>`}
            ${img.count > 1 ? html`<span class="img-badge" aria-hidden="true">×${img.count}</span>` : null}
        </button>
    </li>`;
}

/** The file name Save offers: the label when it is one, else a name off the key. */
function fileName(img, occ) {
    const ext = EXT[img.mediaType] || 'png';
    const label = (occ && occ.label) || img.label || '';
    if (/\.[A-Za-z0-9]{2,5}$/.test(label)) return label;
    return `image-${img.key.slice(0, 10)}.${ext}`;
}

function openLarge(img) {
    if (!img.url) return;
    const occs = img.occurrences || [];
    openImage({
        src: img.url,
        name: fileName(img, occs[0]),
        occurrences: occs.map(o => ({
            name: fileName(img, o),
            title: occTitle(o),
            canJump: !!o.anchor,
        })),
        onJump: (i) => jumpTo(occs[i] && occs[i].anchor),
    });
}

function occTitle(o) {
    const where = o.agent ? 'in a subagent' : o.source === 'user' ? '' : 'from a tool';
    return [o.label, where].filter(Boolean).join(' · ');
}

/**
 * Put an occurrence's row on screen. The row may be above the loaded part of
 * the log: then the stretch from the turn it sits in is loaded first, which is
 * the only kind of offset the range route accepts. A subagent's image lands on
 * the call that spawned it.
 */
async function jumpTo(anchor) {
    if (!anchor) {
        toast('That image is not in the loaded transcript.', 'warn');
        return false;
    }
    const find = () => (anchor.kind === 'tool' ? state.tools.get(anchor.id) : state.nodes.get(anchor.id)) || null;
    let hit = find();
    if (!hit && state.windowStart && anchor.offset != null && anchor.offset < state.windowStart) {
        const turn = (state.turnIndex || []).filter(m => m.kind === 'turn' && m.offset <= anchor.offset).pop();
        await loadEarlier({ through: { offset: turn ? turn.offset : 0 } });
        hit = find();
    }
    if (hit && hit.node) { revealNode(hit.node); return true; }
    toast('That image is not in the loaded transcript.', 'warn');
    return false;
}
