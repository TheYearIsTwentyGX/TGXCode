// One row of the transcript per event: the row shell and its copy button, the
// user, assistant and thinking renderers, and the cards for peer messages,
// handoffs and system lines. Tool calls are drawn by tools.js.
//
// This imports app.js and sibling modules here, which import it back. That is
// safe only because nothing in this file reads an imported binding while the
// module is evaluating — every use is inside a function called later. Keep it
// that way: a top-level `const X = someImport(...)` runs before app.js's body
// and throws in the temporal dead zone, and only loading the page shows it.

import { el, toast } from '../dom.js';
import { clip, clockOf, dateOf, dur } from '../format.js';
import { escapeHtml } from '../highlight.js';
import { icon } from '../icons.js';
import { inline, renderMarkdown } from '../markdown.js';
import { state } from '../state.js';
import { attachExt, openAttachment } from '../composer/attachments.js';
import { insertMention, loadPeers, peerByName } from '../composer/mentions.js';
import { openSession } from './conversation.js';
import { markFindDirty } from './find.js';
import { openAgent } from './subagents.js';
import { renderTool } from './tools.js';
import { turnText } from './turn-rail.js';

// ── copying a message ────────────────────────────────────────────────────
// Selecting rendered prose and pressing Ctrl+C hands over flattened text: the
// list numbers gone, the emphasis gone, the fences gone. That is exactly wrong
// for what a message gets pasted into — another prompt, an issue, a commit
// message — so the row offers the source it was rendered from instead.

/**
 * The markdown a message was written in.
 *
 * Not read back off the DOM, and not `searchableText` either. `.prose` is the
 * rendered result, and a selection over it is precisely what drops the numbering
 * and the asterisks this exists to keep; `searchableText` is a haystack — it
 * folds in file names and a tool's arguments, none of which you meant to paste.
 * A `/command` turn never had markdown of its own, so it gets the line the row
 * shows; an image-only turn has neither and returns empty, which is what
 * suppresses the button.
 */
function messageMarkdown(ev) {
    if (ev.command) return turnText(ev);
    return (ev.text || '').trim();
}

/**
 * The header line of a message: who said it, and the button that copies it.
 *
 * In the flow rather than floating over the body. The label line is the one line
 * in a row whose right side is reliably empty, so a control there cannot land on
 * the first word of a long turn — and it sits in the same place whether the
 * message is two lines or two hundred.
 *
 * Only user and assistant rows call this. The other labelled kinds keep their
 * bare `.ev-label`: a tool call and a thinking block are folds whose whole row
 * is one `<summary>`, where a button would have to cancel the summary's own
 * click, and they are also the only two kinds `closeRun` lifts into a `.trun` —
 * so leaving them out is what guarantees no copy button is ever inside a fold.
 */
function evHead(ev, label) {
    return el('div', { class: 'ev-head' },
        el('div', { class: 'ev-label' }, label),
        copyButton(ev));
}

/**
 * `onclick`, not the delegated `.copy-btn` handler at the foot of web/app.js.
 *
 * That one is delegated because the markdown renderer emits its buttons as
 * innerHTML and they cannot be handed a listener — which is why the fence source
 * has to ride on a `data-code` attribute. This button is built here, beside the
 * event, so a closure is both shorter and exact: no second copy of every message
 * in the DOM, and no id to look up. Both of those matter — the row
 * `showPendingSend` draws has no `ev.id` and is not in `state.nodes` at all, and
 * the subagent pane keeps its own map. It survives the two things that happen to
 * a rendered row for free: `patchTool` and `redrawEvent` replace the node, so the
 * closure is rebuilt with it, and `foldRun` moves the node, so the listener goes
 * along with it.
 */
function copyButton(ev) {
    const md = messageMarkdown(ev);
    if (!md) return null;              // an image-only turn has nothing to take
    const btn = el('button', {
        class: 'ev-copy', type: 'button',
        title: 'Copy message', 'aria-label': 'Copy message',
        // No stopPropagation, unlike the rail's mini buttons: an `.ev` row is
        // not itself clickable.
        onclick: () => copyMessage(btn, md),
    }, icon('copy', 14));
    return btn;
}

/**
 * Put a message on the clipboard twice over: as the markdown it was written in,
 * and as the HTML that markdown renders to.
 *
 * Both, because the two destinations want opposite things. A prompt, an issue or
 * a commit message wants the asterisks and the list numbers as characters; Word
 * and Gmail want them applied. `write` with two blobs is the only call that can
 * say that, and it is also the one most likely to be missing — so a failure
 * there falls back to the text alone rather than to nothing.
 */
async function copyMessage(btn, md) {
    try {
        // `navigator.clipboard` is undefined outside a secure context, which the
        // plain-http LAN bind in docs/remote.md is. Reading `.write` off it would
        // throw here rather than reject, so the whole thing sits in the try.
        const clip = navigator.clipboard;
        if (!clip) throw new Error('no clipboard');
        if (clip.write && window.ClipboardItem) {
            try {
                await clip.write([new ClipboardItem({
                    'text/plain': new Blob([md], { type: 'text/plain' }),
                    'text/html': new Blob([clipboardHtml(md)], { type: 'text/html' }),
                })]);
            } catch { await clip.writeText(md); }
        } else {
            await clip.writeText(md);
        }
    } catch {
        toast('Could not reach the clipboard.', 'error');
        return;
    }
    // A tick where the button was, not a toast: the row you copied is the row you
    // are already looking at, and a toast is this app's channel for things that
    // happened somewhere else. `.done` is also what holds the button visible once
    // the pointer leaves — which the always-on Copy on a code block never had to
    // arrange for itself.
    btn.classList.add('done');
    btn.replaceChildren(icon('tick', 14));
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
        btn.classList.remove('done');
        btn.replaceChildren(icon('copy', 14));
    }, 1400);
}

/**
 * The rendered half of the clipboard — the same `renderMarkdown` the row itself
 * uses, with this app's own furniture taken back out.
 *
 * A fence renders with a head bar carrying a Copy button, and handing that over
 * verbatim puts the word "Copy" above every code block in the document you
 * pasted into. `data-code` goes with it: that is the fence's source over again,
 * url-encoded, and nothing on the far side of a paste reads it.
 */
function clipboardHtml(md) {
    const holder = el('div', { html: renderMarkdown(md) });
    for (const head of holder.querySelectorAll('.code-head')) head.remove();
    for (const b of holder.querySelectorAll('.code-block')) b.removeAttribute('data-code');
    return holder.innerHTML;
}

export function row(ev, kind, ...body) {
    // `date ? … : null` rather than `date && …`: el skips null, but '' would go in
    // as an empty text node.
    const date = dateOf(ev.ts);
    return el('div', { class: `ev ev-${kind}`, 'data-error': ev.isError ? 'true' : null },
        el('div', { class: 'ev-time' },
            date ? el('span', { class: 'ev-date' }, date) : null,
            el('span', { class: 'ev-clock' }, clockOf(ev.ts)),
        ),
        el('div', { class: 'ev-body' }, ...body),
    );
}

export function renderEvent(ev) {
    switch (ev.kind) {
        case 'user': return renderUser(ev);
        case 'assistant': return renderAssistant(ev);
        case 'thinking': return renderThinking(ev);
        case 'tool': return renderTool(ev);
        case 'agent-done': return renderAgentDone(ev);
        case 'peer-message': return renderPeerMessage(ev);
        case 'handoff': return renderHandoff(ev);
        case 'system': return renderSystem(ev);
        case 'compact': return row(ev, 'compact', 'context compacted');
        default: return null;
    }
}

export function renderUser(ev) {
    const body = [];
    body.push(evHead(ev, 'You'));
    if (ev.command) {
        body.push(el('div', { class: 'prose', html:
            `<p><code>/${escapeHtml(ev.command.name)}</code>`
            + (ev.command.args ? ' ' + inline(ev.command.args) : '') + '</p>' }));
    } else {
        body.push(el('div', { class: 'prose', html: renderMarkdown(ev.text) }));
    }
    // Wrapped, and with the styling in a class. Both were fine while a turn could only
    // ever have arrived with one image on it — now that you can paste three, two bare
    // <img> in a row flowed together edge to edge and read as one wide picture.
    const shots = (ev.images || []).filter(img => img.dataUri);
    if (shots.length) {
        body.push(el('div', { class: 'ev-images' }, ...shots.map(img =>
            el('img', { class: 'ev-image', src: img.dataUri, alt: 'attached image' }))));
    }
    // Files this turn attached. An image is usually both — the thumbnail above is what
    // the model was handed, this is the file on disk — because the card is the only one
    // of the two you can click to open, and "open the screenshot I just pasted" is a
    // thing you want as much for a PNG as for a PDF.
    if (ev.files && ev.files.length) body.push(attachCards(ev));
    return row(ev, 'user', ...body);
}

/**
 * The small cards under a user turn, one per attached file.
 *
 * Deliberately not a preview. What you want from a file in a transcript is to know it
 * is there and to be able to open it — rendering a PDF or a spreadsheet inline is a
 * viewer this app has no business being. So: name, size, and a click that hands the
 * path to whatever the machine opens that kind of file with.
 *
 * The paths came out of the message text (`parseAttachmentNote`, bridge/transcript.js),
 * which is why this works for a turn sent months ago and reread off disk.
 */
function attachCards(ev) {
    const sessionId = state.current && state.current.sessionId;
    return el('div', { class: 'ev-files' }, ...ev.files.map(f => el('button', {
        class: 'ev-file', type: 'button',
        title: `Open ${f.relPath}`,
        // Without a session in view there is nothing to resolve the path against.
        disabled: !sessionId,
        onclick: () => sessionId && openAttachment(sessionId, f.relPath),
    },
        el('span', { class: 'ev-file-glyph' }, attachExt(f.name)),
        el('span', { class: 'ev-file-name' }, f.name),
        f.size ? el('span', { class: 'ev-file-size' }, f.size) : null,
    )));
}

function renderAssistant(ev) {
    return row(ev, 'assistant',
        evHead(ev, 'Claude'),
        el('div', { class: 'prose', html: renderMarkdown(ev.text) }),
    );
}

function renderThinking(ev) {
    const words = ev.text.trim().split(/\s+/).length;
    const det = el('details', { class: 'tool thinking' },
        el('summary', {},
            el('span', { class: 'caret' }, '▶'),
            el('span', { class: 'tname' }, 'Thought'),
            el('span', { class: 'targ' }, clip(ev.text, 90)),
            el('span', { class: 'tmeta' }, `${words} words`),
        ),
        el('div', { class: 'tool-body' },
            el('div', { class: 'prose', html: renderMarkdown(ev.text) })),
    );
    return row(ev, 'thinking', det);
}

/**
 * A background task reporting back. It arrives as a user message — that is the
 * only way into a conversation — but you did not write it, so it does not get
 * rendered as though you had.
 */
function renderAgentDone(ev) {
    const failed = ev.status && ev.status !== 'completed';
    const meta = [ev.toolUses && `${ev.toolUses} tools`, dur(ev.durationMs),
        ev.tokens && `${ev.tokens.toLocaleString()} tokens`].filter(Boolean).join(' · ');

    const body = [el('div', { class: 'ev-label' },
        failed ? `Subagent ${ev.status}` : 'Subagent finished')];
    if (ev.summary) body.push(el('div', { class: 'agent-done-sum' }, ev.summary));
    if (meta) body.push(el('div', { class: 'agent-done-meta' }, meta));

    // The notification carries the id of the call that spawned it, which is the
    // same key the transcripts are filed under — so this can be a way in.
    //
    // `hasTranscript` rather than "is this call on screen": a *background shell*
    // reports itself through the same notification, and its `tool-use-id` names a
    // Bash call with nothing filed under `subagents/`, so the old check drew a
    // button that 404'd on click. The bridge answers it, because the bridge is
    // holding the directory — see bridge/transcript.js.
    if (ev.toolUseId && ev.hasTranscript) {
        body.push(el('div', { class: 'subagent-btns' },
            el('button', {
                class: 'more-btn primary', type: 'button',
                onclick: () => openAgent(ev.toolUseId),
            }, 'Open this subagent')));
    }

    if (ev.result) {
        body.push(el('details', { class: 'tool' },
            el('summary', {},
                el('span', { class: 'caret' }, '▶'),
                el('span', { class: 'tname' }, 'Result'),
                el('span', { class: 'targ' }, clip(ev.result, 90)),
            ),
            el('div', { class: 'tool-body' },
                el('div', { class: 'prose', html: renderMarkdown(ev.result) })),
        ));
    }

    return row(ev, 'agent-done', ...body);
}

/**
 * Replace one already-rendered event's node with a freshly built one.
 *
 * Almost everything in the log is a fact about the transcript and never moves.
 * The exception is anything naming another session: a peer message and a
 * `SendMessage` block both want the peer list, which is fetched lazily, so they
 * are drawn once without it and again once it lands. See warmPeers.
 *
 * Both views are searched, because a subagent's transcript is a pane of its own.
 * Which one holds the node is not worth asking about — the id is unique either
 * way, and both panes stay mounted.
 */
function redrawEvent(ev) {
    for (const nodes of [state.nodes, state.agentNodes]) {
        const entry = nodes.get(ev.id);
        if (!entry || !entry.node.isConnected) continue;
        const next = renderEvent(ev);
        if (!next) return;
        entry.node.replaceWith(next);
        nodes.set(ev.id, { ev, node: next });
        markFindDirty();
        return;
    }
}

/**
 * Put names to the sessions this conversation talked to.
 *
 * A message card and a `SendMessage` block both want to say *which* session,
 * and to offer a way into it — which needs the peer list, which is fetched
 * lazily because most conversations never mention another session at all. So
 * the cards draw without it and are redrawn once it lands, rather than every
 * conversation paying for a request it does not need.
 *
 * Only when something in the log actually refers to a peer, and only when the
 * fetch told us something new: a list already in hand means the cards were
 * drawn right the first time and redrawing them would collapse a tool block
 * somebody had just opened.
 */
export async function warmPeers() {
    const cards = [...state.nodes.values()].filter(({ ev }) =>
        ev.kind === 'peer-message' || (ev.kind === 'tool' && ev.name === 'SendMessage'));
    if (!cards.length) return;
    const before = state.peers.at;
    try { await loadPeers(); } catch { return; }
    if (state.peers.at === before) return;
    for (const { ev } of cards) redrawEvent(ev);
}

/**
 * A message from another Claude session.
 *
 * Claude Code delivers one as a user message, because a conversation still has
 * no other channel — so left alone it renders as though somebody had pasted it
 * at you. It is marked meta as well, which is why until now it rendered as
 * nothing at all: a session that got messaged showed an empty gap.
 *
 * The sender's name is also its address — `SendMessage` takes a name and there
 * is no other way to say who you mean — so Reply seeds the composer with it
 * rather than trying to send anything itself. What happens next is the agent's
 * to decide, which is the point of the feature.
 */
function renderPeerMessage(ev) {
    const who = ev.fromName || ev.from || 'another session';
    const peer = ev.fromName ? peerByName(ev.fromName) : null;

    const body = [el('div', { class: 'ev-label' }, `Message from ${who}`)];
    if (peer && peer.title && peer.title !== who) {
        body.push(el('div', { class: 'peer-sub' }, peer.title));
    }
    body.push(el('div', { class: 'prose', html: renderMarkdown(ev.text || '') }));

    const btns = [];
    // Only when that session is one this app can show. A peer is often a
    // background agent with no transcript indexed here, and a button that
    // 404s is worse than no button.
    if (peer && peer.sessionId) {
        btns.push(el('button', { class: 'more-btn', type: 'button',
            onclick: () => openSession(peer.sessionId) }, 'Open that session'));
    }
    if (ev.fromName) {
        btns.push(el('button', { class: 'more-btn', type: 'button',
            onclick: () => insertMention(ev.fromName) }, 'Reply'));
    }
    if (btns.length) body.push(el('div', { class: 'subagent-btns' }, ...btns));

    return row(ev, 'peer-message', ...body);
}

/**
 * Work handed to this session by another one.
 *
 * Beside renderPeerMessage rather than folded into it, because the two answer
 * different questions. A peer message arrived at a session that was already
 * running and has a live sender to reply to. A handoff *started* this turn —
 * the session had very likely stopped, and the sender has very likely finished
 * — so there is nobody to reply to and the interesting fact is that the session
 * is awake at all. Hence no Reply button: the sender is addressed by session id,
 * not by a name the composer could insert, and the thing to do about a handoff
 * is read the plan the session is about to produce.
 *
 * The card is drawn from the wrapper's attributes rather than from the peer
 * list, so it needs no fetch and does not go through warmPeers.
 */
function renderHandoff(ev) {
    const who = ev.fromTitle || 'another session';
    const body = [el('div', { class: 'ev-label' }, `Handed to this session by ${who}`)];
    if (ev.title) body.push(el('div', { class: 'peer-sub' }, ev.title));
    else if (ev.fromProject) body.push(el('div', { class: 'peer-sub' }, ev.fromProject));
    body.push(el('div', { class: 'prose', html: renderMarkdown(ev.text || '') }));

    // Only when the sender is a session this app can show. `from` is the id the
    // sending session was *started* as, so a session that forked since is not
    // findable by it — which is why this is a button that may not appear rather
    // than a link that may not work.
    if (ev.from && state.sessions.some(s => s.sessionId === ev.from)) {
        body.push(el('div', { class: 'subagent-btns' },
            el('button', { class: 'more-btn', type: 'button',
                onclick: () => openSession(ev.from) }, 'Open the session that sent this')));
    }

    return row(ev, 'handoff', ...body);
}

function renderSystem(ev) {
    const label = ev.subtype === 'permission_denied' ? 'Denied'
        : ev.subtype === 'away_summary' ? 'Summary'
        : ev.subtype.replace(/_/g, ' ');
    const body = [
        el('div', { class: 'ev-label' }, label),
        el('div', { class: 'prose', html: renderMarkdown(ev.text) }),
    ];
    if (ev.subtype === 'permission_denied') {
        // Now that asks are answerable, most denials on this line are somebody's
        // answer rather than a mode quietly refusing. Point at the mode only as
        // the thing to change if you are being asked more than you want to be.
        body.push(el('div', { class: 'note', style: 'margin-top:6px; font-size:11.5px; color:var(--text-4)' },
            'The permission mode below the composer decides how often you are asked.'));
    }
    return row(ev, 'system', ...body);
}
