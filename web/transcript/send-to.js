// Send to another session: a message you already sent, handed to a different
// conversation — queued into one that exists, or as the first message of a new one.
//
// **No route of its own.** Into an existing session it is `POST /api/sessions/:id/send`,
// the composer's route, with the composer's body; a new session is the Start-a-session
// dialog opened with the prompt filled in, so the project, mode, model and the *Test
// session* box are chosen where they always are, and nothing here re-implements them.
//
// The dialog's frame — `#send-to-scrim` and its `.modal` — is web/index.html's, so the
// stacking order every scrim relies on stays the document's; what is inside is this
// component, mounted on open and emptied on close, like web/snippets/editor.js.
//
// Imports app.js and its siblings, which import it back. Nothing here reads an
// imported binding while the module evaluates — keep it that way (see context-menu.js).

import { html, useState } from '../vendor/preact.js';
import { post } from '../api.js';
import { closeOnClickOutside, dom, toast } from '../dom.js';
import { clip, shortPath } from '../format.js';
import { state } from '../state.js';
import { modeFor } from '../app.js';
import { paint } from '../boards/parts.js';
import { openNew } from '../new-session/dialog.js';
import { openSession } from './conversation.js';

const modal = () => dom.sendToScrim.querySelector('.modal');

let opened = 0;

export function openSendTo(text) {
    const body = String(text || '').trim();
    if (!body) return;
    opened += 1;
    const here = state.current && state.current.sessionId;
    paint(modal(), html`<${SendTo} key=${opened} text=${body} here=${here}
        sessions=${state.sessions || []} />`);
    dom.sendToScrim.hidden = false;
    const first = dom.sendToScrim.querySelector('#send-to-filter');
    if (first) first.focus();
}

export function closeSendTo() {
    if (dom.sendToScrim.hidden) return;
    dom.sendToScrim.hidden = true;
    paint(modal(), null);
}

export function wireSendTo() {
    closeOnClickOutside(dom.sendToScrim, closeSendTo);
}

const projectOf = (s) => s.projectCwd || s.cwd || '';

function matches(s, q) {
    if (!q) return true;
    return [s.title, s.projectName, projectOf(s)]
        .some(v => String(v || '').toLowerCase().includes(q));
}

/**
 * Queue the text into another session by the composer's route.
 *
 * `permissionMode` is always sent, because the route reads an absent one as `auto`
 * and would quietly move the target out of the mode it is in; `modeFor` is the same
 * chain the composer's selector is painted from. `model` and `effort` are null —
 * leave them as they are — for the same reason.
 *
 * A send that fails *after* the POST (`send-failed`) is handled where every one is,
 * handleSendFailure, which keeps the text as that session's draft. Nothing needs
 * restoring here otherwise: the turn it came from still says it.
 */
async function sendInto(s, text) {
    const r = await post(`/api/sessions/${s.sessionId}/send`, {
        text,
        attachments: [],
        fork: false,
        model: null,
        effort: null,
        permissionMode: modeFor(s.sessionId, s),
    });
    const name = clip(s.title || 'that session', 40);
    toast(r.queued ? `Queued in “${name}”.` : `Sent to “${name}”.`, 'ok', {
        action: { label: 'Open', onClick: () => openSession(s.sessionId) },
    });
}

function SendTo({ text, here, sessions }) {
    const [q, setQ] = useState('');
    const [busy, setBusy] = useState(null);
    const needle = q.trim().toLowerCase();

    const others = sessions.filter(s => s.sessionId !== here && !s.archived && matches(s, needle));
    const projects = [];
    const seen = new Set();
    for (const s of sessions) {
        const cwd = projectOf(s);
        if (!cwd || seen.has(cwd)) continue;
        seen.add(cwd);
        if (!needle || String(s.projectName || '').toLowerCase().includes(needle)
            || cwd.toLowerCase().includes(needle)) {
            projects.push({ cwd, name: s.projectName || shortPath(cwd) });
        }
    }

    const startIn = (cwd) => {
        closeSendTo();
        openNew({ cwd, prompt: text });
    };

    const pick = async (s) => {
        if (busy) return;
        setBusy(s.sessionId);
        try {
            await sendInto(s, text);
            closeSendTo();
        } catch (err) {
            toast(`Could not send: ${err.message}`, 'error');
            setBusy(null);
        }
    };

    const state_ = (s) => {
        const st = s.runner && s.runner.state;
        if (st === 'busy' || st === 'starting') return 'working — it will queue';
        return '';
    };

    return html`
        <div class="modal-head">
            <span id="send-to-title">Send to another session</span>
            <button class="modal-close" type="button" aria-label="Close"
                onClick=${closeSendTo}>✕</button>
        </div>
        <div class="modal-body">
            <div class="send-to-preview">${clip(text, 280)}</div>
            <div class="field">
                <input id="send-to-filter" type="text" autocomplete="off" spellcheck=${false}
                    placeholder="Filter sessions and projects" value=${q}
                    onInput=${(e) => setQ(e.target.value)} />
            </div>
            <div class="send-to-group">
                <div class="send-to-head">Start a new session in</div>
                ${projects.map(p => html`
                    <button key=${p.cwd} class="picker-row" type="button"
                        onClick=${() => startIn(p.cwd)}>
                        <span>${p.name}</span>
                        <span class="path">${shortPath(p.cwd)}</span>
                    </button>`)}
                <button class="picker-row" type="button" onClick=${() => startIn('')}>
                    <span>Another folder…</span>
                </button>
            </div>
            <div class="send-to-group">
                <div class="send-to-head">Send into a session</div>
                ${others.length ? null : html`<div class="note">No other session matches.</div>`}
                ${others.map(s => html`
                    <button key=${s.sessionId} class="picker-row send-to-session" type="button"
                        disabled=${Boolean(busy)} onClick=${() => pick(s)}>
                        <span class="send-to-name">${s.title || 'Untitled session'}</span>
                        <span class="path">${s.projectName || shortPath(projectOf(s))}</span>
                        <span class="tag">${busy === s.sessionId ? 'sending…' : state_(s)}</span>
                    </button>`)}
            </div>
        </div>
        <div class="modal-foot">
            <span class="spacer"></span>
            <button class="btn" type="button" onClick=${closeSendTo}>Cancel</button>
        </div>`;
}
