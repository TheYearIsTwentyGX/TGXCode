// The notification history panel, drawn with Preact.
//
// web/notifications.js is what reaches you; this is what you read afterwards to
// find out what it was. The read-state bookkeeping — watermarks, the badge,
// marking a conversation's rows read when it is opened — is app.js's
// (`// ── notification history ──`), because openSession and the stream both
// reach into it. This file is the list.
//
// Keyed by row id, so a `notification` push that adds a row at the top inserts
// one node rather than rebuilding three hundred: the row under the cursor keeps
// its hover, a click in flight lands, and the panel's scroll stays where it was.
// Markup and class names are what the imperative version built, so
// web/styles.css did not change.
//
// This imports from app.js, which imports this — safe because nothing here reads
// an app.js binding at module top level, only when a function is called.

import { html } from '../vendor/preact.js';
import { state } from '../state.js';
import { dom } from '../dom.js';
import { ago } from '../format.js';
import { loadNotes, noteUnread, openFromNote } from '../app.js';
import { paint } from './parts.js';

const NOTE_LABEL = {
    permission: 'Permission',
    plan: 'Plan to review',
    question: 'Question',
    finished: 'Finished',
    failed: 'Failed',
    'agent-done': 'Subagent done',
    'peer-message': 'From another session',
    handoff: 'Handed work',
    'schedule-findings': 'Scheduled review',
    'schedule-failed': 'Schedule failed',
    'schedule-missed': 'Schedule missed',
    // Both always carry a sessionId, unlike two of the three above: a scheduled
    // message is written against a session that exists, so there is always
    // somewhere for the row to open.
    'later-failed': 'Message not delivered',
    'later-missed': 'Message missed',
};

// The runner's vocabulary for how an ask ended, said the way a person would.
const NOTE_OUTCOME = {
    allow: 'allowed',
    'allow-always': 'allowed for the session',
    deny: 'denied',
    answered: 'answered',
    'plan-approved': 'approved',
    'plan-approved-note': 'approved with a note',
    'plan-rejected': 'kept planning',
    dismissed: 'dismissed',
    'auto-denied': 'denied — no window was open',
    superseded: 'replaced by a later ask',
    cancelled: 'withdrawn',
    abandoned: 'abandoned — the bridge stopped',
    stopped: 'the turn was stopped',
};

export function renderNotes() {
    const rows = state.notes.rows;
    dom.notesClear.disabled = state.notes.loading || !rows.length;

    if (state.notes.error) {
        paint(dom.notesBody, html`<div key="error" class="dash-note error">
            <p>${`Could not read the notification log: ${state.notes.error}`}</p>
            <button class="more-btn" type="button" onClick=${() => loadNotes()}>Try again</button>
        </div>`);
        return;
    }
    if (state.notes.loading && !rows.length) {
        paint(dom.notesBody, html`<div key="wait" class="dash-note"><p>Reading the log…</p></div>`);
        return;
    }
    if (!rows.length) {
        paint(dom.notesBody, html`<div key="empty" class="dash-note"><p>${
            state.notes.scope === 'notable'
                ? 'Nothing has wanted you. Everything switches to the quiet rows too — '
                    + 'short turns, subagents finishing.'
                : 'Nothing yet. Anything that wants you from now on is written down here, '
                    + 'whether or not a window was open to hear it.'}</p></div>`);
        return;
    }

    dom.notesSub.textContent = `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`
        + (state.notes.scope === 'notable' ? ' worth interrupting you for.' : ', including the quiet ones.');
    paint(dom.notesBody, rows.map(noteRow));
}

function noteRow(n) {
    const meta = [n.project, n.outcome ? (NOTE_OUTCOME[n.outcome] || n.outcome) : null]
        .filter(Boolean);
    // `data-unread` is what the badge was counting when this panel opened, marked
    // so the number is traceable to rows. Quiet rows are never counted, so they
    // are never marked either.
    return html`
        <div key=${n.id} class="note-row" data-type=${n.type} data-loud=${String(n.loud)}
            data-unread=${String(n.loud && noteUnread(n, state.notes.mark || state.notes.read))}
            data-id=${n.id}>
            <button class="note-main" type="button" title=${`Open ${n.title}`}
                onClick=${() => openFromNote(n)}>
                <span class="note-head">
                    <span class="note-kind">${NOTE_LABEL[n.type] || n.type}</span>
                    <span class="note-title">${n.title}</span>
                    <span class="note-when" title=${new Date(n.at).toLocaleString()}>${ago(n.at)}</span>
                </span>
                <span class="note-summary">${n.summary || ''}</span>
                ${meta.length ? html`
                    <span class="note-meta">
                        ${n.outcome ? html`<span class="note-outcome" data-outcome=${n.outcome}>${
                            NOTE_OUTCOME[n.outcome] || n.outcome}</span>` : null}
                        ${n.project ? html`<span class="note-project">${n.project}</span>` : null}
                    </span>` : null}
            </button>
        </div>`;
}
