// The way back to a preview page: the Pages menu, and the chips a conversation
// shows for it.
//
// A dev server's page was always reachable again from its session's port strip.
// A site — a link opened from chat, or a page an agent opened with
// open_in_preview — was not: leave the preview and it was out of reach until its
// keep-alive dropped it, even with an agent still working in it. So there is one
// list of every page the pane holds (web/preview-pages.js builds it), opened from
// three places: the preview's own toolbar, the conversation header's port strip,
// and the palette. And while an agent is on a page you are not looking at, the
// conversation says so, with a button that brings it back.
//
// The menu is the right-click menu's element (web/transcript/context-menu.js),
// anchored under the control that opened it: fixed, clamped to the window, with
// its keys, and closed by the same outside click and Escape.
//
// Favicons are not drawn. The CSP keeps images to this origin, and a site's icon
// is somebody else's — so a page is its host's first letter, and a port its
// number.
//
// This imports app.js, which imports it back — safe for the reason
// web/channels.js gives: nothing here reads an app.js binding at load.

import { el } from './dom.js';
import { state } from './state.js';
import { openContextMenu } from './transcript/context-menu.js';
import { previewPane, showPreviewPage } from './app.js';
import { agentAway } from './preview-pages.js';

function badge(row) {
    if (row.kind === 'port') return el('span', { class: 'pvp-mark port' }, row.host.replace(/^.*:/, ':'));
    const letter = (row.host.replace(/^www\./, '')[0] || '?').toUpperCase();
    return el('span', { class: 'pvp-mark' }, letter);
}

function rowNode(row) {
    const sub = [row.address, row.session ? `from ${row.session}` : null].filter(Boolean).join(' · ');
    return el('span', { class: 'pvp-row', title: row.url },
        badge(row),
        el('span', { class: 'pvp-text' },
            el('span', { class: 'pvp-label' }, row.label),
            el('span', { class: 'pvp-sub' }, sub)),
        row.agent ? el('span', { class: 'pvp-flag agent', title: 'An agent is controlling this page' }, 'Agent')
            : row.asking ? el('span', { class: 'pvp-flag ask', title: 'Waiting for you to allow or deny a site' }, 'Asking')
            : null,
        row.active ? el('span', { class: 'pvp-flag here' }, 'Showing') : null);
}

/** Open the list of pages under `anchor`. */
export function openPagesMenu(anchor) {
    const rows = previewPane.rows();
    const r = anchor.getBoundingClientRect();
    const items = rows.length
        ? rows.map(row => ({ label: rowNode(row), onClick: () => showPreviewPage(row.key) }))
        : [{ label: 'No preview pages are open', disabled: 'Open a port, or a link from chat, in the preview first', onClick: () => {} }];
    openContextMenu({ clientX: r.left, clientY: r.bottom + 4, currentTarget: anchor }, items, { kind: 'pages' });
}

/**
 * The chips this conversation's port strip starts with: the agent's page when
 * it is off screen, and the list of pages when there is one.
 */
export function previewChips() {
    const rows = previewPane.rows();
    if (!rows.length) return [];
    const away = agentAway(rows, {
        sessionId: state.current ? state.current.sessionId : null,
        onScreenKey: previewPane.onScreenKey(),
    });
    const chips = away.map(row => el('div', { class: 'channel pv-agent-chip', 'data-live': 'true' },
        el('button', {
            class: 'chan-open', type: 'button',
            title: `An agent is controlling ${row.url} in the preview. Show it.`,
            onclick: () => showPreviewPage(row.key),
        },
            el('span', { class: 'led' }),
            el('span', { class: 'name' }, 'Agent is using the preview: ', el('strong', {}, row.host)),
            el('span', { class: 'go' }, 'Show'))));
    const pages = el('button', {
        class: 'chan-open', type: 'button', 'aria-haspopup': 'menu',
        title: 'Every page open in the preview',
        onclick: (ev) => openPagesMenu(ev.currentTarget),
    },
        el('span', { class: 'name' }, 'Preview'),
        el('span', { class: 'go' }, rows.length === 1 ? '1 page' : `${rows.length} pages`));
    chips.push(el('div', { class: 'channel pv-pages-chip' }, pages));
    return chips;
}
