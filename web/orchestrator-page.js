// The orchestrator page: what an orchestrator session opens onto, instead of a
// conversation with a dock under it.
//
// **Who it is for.** Somebody who handed an orchestrator a task list an hour ago
// and has come back. The real sessions this was designed from go quiet for hours
// while the orchestrator approves plans and closes workers on its own; what the
// person returning wants is "where are we, and what needs me?", and the answer
// used to be scattered through a long transcript — three questions put to the
// user in prose were never answered because they had scrolled away. So the page
// is the overview and the conversation is a column beside it, not the other way
// round:
//
//   - the **head**: the goal, a strip with one segment per task, how many are
//     running against the cap, and the usage meters with the cutoff marked.
//   - **Needs you**: what is waiting on the user rather than on the orchestrator
//     — its open decisions (the brief's `decisions`, answerable here), a pause, its
//     own pending ask, a worker nobody is answering, a worker that failed.
//   - **Tasks from you**: drafts (or the Start dialog) handed over and not yet
//     started, with their age and Take back — right under Needs you, because a
//     task the orchestrator has quietly not picked up is exactly what a person
//     coming back would otherwise never notice.
//   - **Workers**: a stage matrix. One row per worker in the order it started —
//     never re-sorted by state, so a status tick does not move rows under the
//     pointer — with a track as far as it has got and, at the stage it is on,
//     what it is doing in words.
//   - **Merge order**: the PRs, numbered, as the brief orders them.
//   - **Activity**: the raw inbox, folded, so nothing the old dock showed is gone.
//
// A row opens a **drawer** over the conversation column with the worker's ask
// (answerable as the user, through answerAskFor — the orchestrator is told the
// user got there first), its steps with times, and its progress digest from
// `…/orchestrator/read` in `digest` mode, which only reads.
//
// **Layout.** In page mode `#conv-main` becomes a grid — this page, a splitter,
// and the conversation column — with the transcript, the ask dock and the
// composer all in the third column (web/css/orchestrator.css). They are the real
// ones, so the composer, the queue and the approval cards work exactly as they
// do anywhere else. The splitter's width is the user's, kept per window in
// localStorage. `Conversation` in the header puts the plain conversation back,
// with a one-line strip in `#orch-dock` for the way back.
//
// Drawn with Preact from `state.orch` (the `orchestrator` event), the rail's copy
// of each worker's runner status, `state.railPrs` and the quota reading. What a
// row says is worked out in web/orchestrator-model.js, which is pure and tested.

import { html, render } from './vendor/preact.js';
import { state } from './state.js';
import { dom, toast } from './dom.js';
import { post } from './api.js';
import { ago, clip, clockOf } from './format.js';
import { renderMarkdown } from './markdown.js';
import { ICON } from './icons.js';
import { enter, isUp, present, settle } from './motion.js';
import { answerAskFor } from './transcript/approvals.js';
import { holdPaneInsets, releasePaneInsets } from './transcript/layout.js';
import { toolSummary } from './transcript/tools.js';
import { toolDisplayName } from './tool-name.js';
import { sendMessage } from './composer/send.js';
import { onQuotaChange, quotaWindows } from './quota.js';
import { clockAt, goTo, inboxList, paintOrchestrator, resume, settings } from './orchestrator.js';
import {
    STAGES, blockedOn, lastReport, mergeOrder, needsYou, openDecisionFor, progress, shortAge,
    stageLine, usageMeters, workerStage,
} from './orchestrator-model.js';

// ── per-window state ───────────────────────────────────────────────────────

const ui = {
    // orchestrator id → 'overview' | 'conversation'. Overview unless changed.
    mode: new Map(),
    orchId: null,              // the orchestrator the rest of this is about
    peek: null,                // the worker id in the drawer
    finished: false,           // the Finished fold
    activity: false,           // the Activity fold
    brief: false,              // the brief's prose, all of it
    settings: false,           // the settings popover
    answering: new Set(),      // request ids in flight from the drawer
    note: null,                // {requestId, how: 'approve'|'reject'} — a note being written
    reply: null,               // the decision id whose reply field is open
    taking: new Set(),         // task ids being taken back
    sending: new Set(),        // decision ids whose answer is on its way
    digest: new Map(),         // worker id → {at, state, fields, error}
};

const STAGE_WORD = {
    plan: 'Plan', approved: 'Approved', building: 'Building', done: 'Done', pr: 'PR', merged: 'Merged',
};
const ASK_WORD = { plan: 'a plan approval', tool: 'a permission', question: 'an answer' };
/** A worker's title in a sentence: short enough not to become the sentence. */
const nameIn = (w, none = 'A worker') => clip((w && w.title) || none, 48).replace(/\s+…$/, '…');
const node = (id) => document.getElementById(id);
/** "12m ago", or "just now" — shortAge says `now` for the first minute. */
const agoWords = (ms) => { const a = shortAge(ms); return a === 'now' ? 'just now' : `${a} ago`; };

/** Which view an orchestrator is in: its page unless the user chose otherwise. */
export function orchPageMode(orchId) {
    return ui.mode.get(orchId) || 'overview';
}

/** Switch between the page and the plain conversation. */
export function setOrchPageMode(orchId, mode) {
    ui.mode.set(orchId, mode);
    if (mode !== 'overview') dropPeek();
    paintOrchestrator();
}

/**
 * The drawer gone at once, without its exit: the page it sits over is going too
 * (the view switched, another session opened), and an exit played there would
 * draw it as a box under the composer for its length.
 */
function dropPeek() {
    ui.peek = null;
    ui.note = null;
    const d = node('orch-peek');
    if (!d) return;
    settle(d);
    d.hidden = true;
    render(null, d);
}

/**
 * What is open on the page belongs to the orchestrator it was opened on: a
 * popover, a half-written reply or an unfolded section does not follow you to
 * the next one.
 */
function forOrchestrator(id) {
    if (ui.orchId === id) return;
    ui.orchId = id;
    Object.assign(ui, { settings: false, reply: null, note: null, brief: false, finished: false, activity: false });
    dropPeek();
}

/** Is the session on screen an orchestrator shown as its page? */
export function orchPageUp() {
    const s = state.current;
    return !!s && !!s.orchestrator && orchPageMode(s.sessionId) === 'overview';
}

// ── painting ───────────────────────────────────────────────────────────────

let tick = 0;          // the ages on the page move on their own: a repaint a minute
let queued = 0;        // a coalesced repaint from status ticks
let quotaWired = false;

/**
 * Draw the page, or take it down — called from paintOrchestrator, so it moves
 * with everything else about the orchestrator: a session opening, a payload, the
 * role turned off, the view switched.
 *
 * The mode is decided from the session summary (`s.orchestrator`), which the
 * rail already has, rather than from the payload, which is still on the wire
 * when a session opens: otherwise every orchestrator would open as a
 * conversation and jump to its page a moment later.
 */
export function paintOrchPage() {
    const main = dom.convMain;
    const page = node('orch-page');
    if (!main || !page) return;
    const s = state.current;
    const on = orchPageUp();
    paintSeg(s);

    const was = main.hasAttribute('data-orch-page');
    main.toggleAttribute('data-orch-page', on);
    page.hidden = !on;
    node('orch-split').hidden = !on;
    if (!on) {
        render(null, page);
        dropPeek();
        clearInterval(tick);
        tick = 0;
        return;
    }
    forOrchestrator(s.sessionId);
    if (!was) {
        applyConvoWidth();
        enter(page, { as: 'reveal' });
    }
    // Subscribed on first use rather than at load: quota.js and this file are
    // both in the app's import cycle, and its listener set may not exist yet
    // while this module is still being evaluated.
    if (!quotaWired) { quotaWired = true; onQuotaChange(() => orchPageTick()); }
    if (!tick) tick = setInterval(() => { if (orchPageUp()) paintOrchPage(); }, 60_000);

    const p = state.orch && state.orch.orchestratorId === s.sessionId ? state.orch : null;
    render(p ? pageTree(p) : loadingTree(), page);
    paintPeek(p);
}

/**
 * A worker's runner, a PR or the usage reading moved. Repaint once on the next
 * frame if the page is up and it is about this orchestrator — many of these
 * arrive together, and each one alone changes a word.
 */
export function orchPageTick(sessionId = null) {
    if (!orchPageUp() || queued) return;
    const p = state.orch;
    if (sessionId && p && sessionId !== p.orchestratorId && !p.workers.some(w => w.id === sessionId)) return;
    queued = requestAnimationFrame(() => { queued = 0; paintOrchPage(); });
}

/** The Overview | Conversation switch in the conversation header. */
function paintSeg(s) {
    const slot = node('orch-seg');
    if (!slot) return;
    if (!s || !s.orchestrator) { slot.hidden = true; render(null, slot); return; }
    slot.hidden = false;
    const mode = orchPageMode(s.sessionId);
    const pick = (m) => () => setOrchPageMode(s.sessionId, m);
    render(html`<span class="op-seg" role="group" aria-label="Show">
        <button type="button" aria-pressed=${String(mode === 'overview')} onClick=${pick('overview')}
            title="The orchestrator's overview, with the conversation beside it">Overview</button>
        <button type="button" aria-pressed=${String(mode !== 'overview')} onClick=${pick('conversation')}
            title="Just the conversation, full width">Conversation</button>
    </span>`, slot);
}

function loadingTree() {
    return html`<div class="op op-loading" role="status" aria-label="Loading the orchestrator">
        <div class="skel op-skel" style="width: 46%"></div>
        <div class="skel op-skel" style="width: 72%"></div>
        ${[0, 1, 2, 3, 4].map(i => html`<div key=${i} class="skel op-skel op-skel-row"></div>`)}
    </div>`;
}

// What the rest of the app knows about each worker.
const rowOf = (id) => state.sessions.find(x => x.sessionId === id) || null;
const freshPr = (id) => { const r = state.railPrs.get(id); return r ? r.status : null; };

function pageTree(p) {
    const now = Date.now();
    const needs = needsYou(p, { orchRunner: state.runner, now });
    return html`<div class="op" onKeyDown=${(e) => {
        // The drawer goes on Esc from the page beside it as well as from inside
        // it — after a click on a row, focus is still on the row. Anything that
        // has its own Esc (a reply field, the settings) stops it first.
        if (e.key !== 'Escape' || !ui.peek || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        closePeek();
    }}>
        ${head(p)}
        <div class="op-body">
            ${needs.length ? html`<section class="op-sec" aria-label="Needs you">
                <h2 class="op-h">Needs you <span>${needs.filter(n => !(n.decision && n.decision.answeredAt)).length}</span></h2>
                <div class="op-needs">${needs.map(n => needCard(p, n, now))}</div>
            </section>` : null}
            ${tasks(p, now)}
            ${brief(p)}
            ${matrix(p, now)}
            ${order(p)}
            ${activity(p)}
        </div>
    </div>`;
}

// ── head ───────────────────────────────────────────────────────────────────

function head(p) {
    const g = progress(p, { prStatusOf: freshPr });
    const goal = p.summary && p.summary.goal;
    const meters = usageMeters(p.settings.usageStop, quotaWindows());
    // The counts are written on one line, separators and all: htm drops
    // whitespace that holds a newline, which is how "finished" and its "·" once
    // ran together.
    return html`<header class="op-head">
        <div class="op-goal-row">
            <p class="op-goal" data-empty=${String(!goal)}>${goal
                || 'No goal yet — the orchestrator sets one when it writes its brief.'}</p>
            <span class="op-settings-wrap" onKeyDown=${(e) => {
                // On the wrap, not the popover: opened with the mouse, focus is
                // still on the button beside it.
                if (e.key === 'Escape' && ui.settings) { e.preventDefault(); e.stopPropagation(); closeSettings(); }
            }}>
                <button class="icon-btn op-settings-btn" type="button" aria-expanded=${String(ui.settings)}
                    aria-haspopup="dialog" title="This orchestrator's settings"
                    onClick=${() => {
                        ui.settings = !ui.settings;
                        paintOrchPage();
                        if (ui.settings) focusSoon('.op-pop input, .op-pop select');
                    }}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                        <circle cx="16" cy="7" r="2" stroke="currentColor" stroke-width="1.8"/>
                        <circle cx="10" cy="17" r="2" stroke="currentColor" stroke-width="1.8"/>
                    </svg></button>
                ${ui.settings ? html`<div class="op-pop" role="dialog" aria-label="Orchestrator settings">
                    ${settings(p)}</div>` : null}
            </span>
        </div>
        <div class="op-readings">
            <div class="op-progress">
                ${g.total ? html`<span class="op-strip" role="img" aria-label=${`${g.finished} of ${g.total} finished`}>
                    ${g.segments.map(x => html`<i key=${x.id} data-s=${x.s} title=${`${x.title} — ${segWord(x)}`}></i>`)}
                </span>` : null}
                <span class="op-count">${g.total
                    ? html`<b>${g.finished}</b> of ${g.total} finished<span> · </span>${g.running} of ${g.max} running${g.queued ? html`<span> · </span>${g.queued} queued` : null}`
                    : `No tasks yet · up to ${g.max} at once`}</span>
            </div>
            <div class="op-meters">${meters.map(m => html`<span key=${m.type} class="op-meter" data-tone=${m.tone}
                title=${m.cutoff == null ? `${m.label}: no cutoff on this window` : `${m.label}: everything stops at ${m.cutoff}%`}>
                ${m.label}
                <span class="op-bar"><i style=${`width:${Math.min(100, m.used || 0)}%`}></i>${m.cutoff != null
                    ? html`<u style=${`left:${m.cutoff}%`}></u>` : null}</span>
                <span><b>${m.used == null ? '—' : `${m.used}%`}</b>${m.cutoff != null ? ` · stops at ${m.cutoff}%` : ''}</span>
            </span>`)}</div>
        </div>
    </header>`;
}

const SEG_WORD = {
    merged: 'merged', fail: 'needs a fix', done: 'closed', run: 'working',
    wait: 'waiting for an answer', idle: 'idle', queued: 'queued',
};
/** A strip segment's word. A PR says its own status: a draft is not "open". */
const segWord = (x) => (x.s === 'pr' ? `PR ${PR_WORD[x.status] || x.status || ''}`.trim() : SEG_WORD[x.s]);

function closeSettings() {
    ui.settings = false;
    paintOrchPage();
    const b = document.querySelector('.op-settings-btn');
    if (b) b.focus({ preventScroll: true });
}

// A click anywhere outside the popover closes it. Capture, so it runs before
// the click does whatever else it does.
document.addEventListener('pointerdown', (e) => {
    if (!ui.settings || e.target.closest('.op-settings-wrap')) return;
    ui.settings = false;
    paintOrchPage();
}, true);

// ── needs you ──────────────────────────────────────────────────────────────

function needCard(p, n, now) {
    switch (n.kind) {
        case 'paused': return html`<div key=${n.key} class="op-need">
            <div class="op-need-q">${`Paused — ${n.reason}.`}</div>
            <div class="op-need-from">${n.resumeAt ? `Carries on by itself at ${clockAt(n.resumeAt)}.`
                : 'Nothing runs until you resume it.'}</div>
            <div class="op-need-act"><button class="lbtn ok" type="button" onClick=${resume}>Resume</button></div>
        </div>`;
        case 'ask': return html`<div key=${n.key} class="op-need">
            <div class="op-need-q">${n.ask.kind === 'plan' ? 'The orchestrator has a plan for you to approve.'
                : n.ask.kind === 'question' ? 'The orchestrator is asking you something.'
                : `The orchestrator wants permission: ${toolDisplayName(n.ask.displayName || n.ask.tool) || 'a tool'}.`}</div>
            <div class="op-need-from">Answer it in the conversation, beside this.</div>
        </div>`;
        case 'decision': return decisionCard(p, n.decision, now);
        case 'stuck': return html`<div key=${n.key} class="op-need">
            <div class="op-need-q" title=${n.worker.title || ''}>${`${nameIn(n.worker)} has waited ${shortAge(now - n.item.at)} for ${
                ASK_WORD[blockedOn(n.worker, p.inbox)?.kind] || 'an answer'}, and the orchestrator is ${
                p.paused ? 'paused' : 'not working on it'}.`}</div>
            <div class="op-need-act"><button class="lbtn ok" type="button" onClick=${() => openPeek(n.worker.id)}>Look at it</button></div>
        </div>`;
        case 'error': return html`<div key=${n.key} class="op-need" data-tone="error">
            <div class="op-need-q" title=${n.worker.title || ''}>${`${nameIn(n.worker)} stopped with an error.`}</div>
            <div class="op-need-act"><button class="lbtn" type="button" onClick=${() => openPeek(n.worker.id)}>Look at it</button></div>
        </div>`;
        default: return null;
    }
}

function decisionCard(p, d, now) {
    const w = d.workerId && p.workers.find(x => x.id === d.workerId);
    const busy = ui.sending.has(d.id);
    const from = [w ? `From ${nameIn(w, 'a worker')}` : 'From the orchestrator', `asked ${agoWords(now - d.at)}`];
    // The card is the same keyed node whether answered or not, and it can take
    // focus: an answer sent from it disables or removes the control that sent
    // it, and focus waits here rather than falling to the page.
    if (d.answeredAt) {
        return html`<div key=${`d:${d.id}`} class="op-need" data-answered="true" data-need=${d.id} tabindex="-1">
            <div class="op-need-q">${d.text}</div>
            <div class="op-need-from">${`You answered “${clip(d.answer || '', 80)}” ${agoWords(now - d.answeredAt)} — waiting for the orchestrator to pick it up.`}</div>
        </div>`;
    }
    const open = ui.reply === d.id;
    return html`<div key=${`d:${d.id}`} class="op-need" data-busy=${String(busy)} data-stack=${String(d.options.length > 0)}
        data-need=${d.id} tabindex="-1">
        <div class="op-need-q">${d.text}</div>
        <div class="op-need-from" title=${w && w.title ? `From ${w.title}` : null}>${from.join(' · ')}</div>
        <div class="op-need-act">
            ${d.options.map(o => html`<button key=${o} class="lbtn" type="button" disabled=${busy}
                onClick=${() => answerDecision(p, d, o)}>${o}</button>`)}
            ${open ? null : html`<button class="lbtn op-text-btn" type="button" disabled=${busy} data-reply-for=${d.id}
                onClick=${() => { ui.reply = d.id; paintOrchPage(); focusSoon(`#op-reply-${d.id}`); }}>Reply…</button>`}
        </div>
        ${open ? html`<form class="op-reply" onSubmit=${(e) => {
            e.preventDefault();
            const v = e.target.elements.reply.value.trim();
            if (v) answerDecision(p, d, v);
        }}>
            <input id=${`op-reply-${d.id}`} name="reply" type="text" autocomplete="off" disabled=${busy}
                aria-label=${`Your answer to: ${d.text}`} placeholder="Your answer — Enter sends it to the orchestrator"
                onKeyDown=${(e) => {
                    if (e.key !== 'Escape') return;
                    e.preventDefault();
                    e.stopPropagation();
                    ui.reply = null;
                    paintOrchPage();
                    focusSoon(`[data-reply-for="${d.id}"]`);
                }} />
            <button class="lbtn ok" type="submit" disabled=${busy}>Send</button>
        </form>` : null}
    </div>`;
}

function focusSoon(sel) {
    requestAnimationFrame(() => { const n = document.querySelector(sel); if (n) n.focus(); });
}

/**
 * Answer one of the brief's decisions: as an ordinary message to the
 * orchestrator, which it reads like anything else you type — and then, once
 * that is on its way, recorded on the brief so every window shows it answered
 * until the orchestrator rewrites the brief without it.
 */
async function answerDecision(p, d, text) {
    if (ui.sending.has(d.id)) return;
    ui.sending.add(d.id);
    paintOrchPage();
    focusSoon(`[data-need="${d.id}"]`);
    try {
        const sent = await sendMessage({ text: `Re: ${d.text}\n\n${text}`, canned: true });
        if (sent) {
            ui.reply = null;
            await post(`/api/sessions/${p.orchestratorId}/orchestrator/decisions/${d.id}/answered`, { text });
        }
    } catch (err) {
        toast(`Sent, but could not mark it answered: ${err.message}`, 'error');
    } finally {
        ui.sending.delete(d.id);
        paintOrchPage();
    }
}

// ── the brief's prose ──────────────────────────────────────────────────────

function brief(p) {
    const b = p.summary;
    if (!b || !b.text) return null;
    return html`<section class="op-sec op-brief" data-open=${String(ui.brief)} aria-label="Brief">
        <h2 class="op-h">Brief <span>${`updated ${ago(b.at) === 'now' ? 'just now' : `${ago(b.at)} ago`}`}</span></h2>
        <div class="op-brief-text md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(b.text) }}></div>
        ${b.text.length > 280 ? html`<button class="op-more" type="button" aria-expanded=${String(ui.brief)}
            onClick=${() => { ui.brief = !ui.brief; paintOrchPage(); }}>${ui.brief ? 'Show less' : 'Show all'}</button>` : null}
    </section>`;
}

// ── tasks from you ─────────────────────────────────────────────────────────

// Past this a task the orchestrator has not started is drawn the way Needs you
// is — amber — rather than as something that has only just arrived.
const TASK_STALE_MS = 15 * 60_000;

/** "from your draft", "from the Start dialog": where a task or worker came from. */
function originWord(o) {
    if (!o) return '';
    return o.from === 'draft' ? `from your draft${o.title ? ` \u201c${o.title}\u201d` : ''}`
        : `from the Start dialog${o.title ? ` (\u201c${o.title}\u201d)` : ''}`;
}

function tasks(p, now) {
    const list = p.openTasks || [];
    if (!list.length) return null;
    return html`<section class="op-sec" aria-label="Tasks from you">
        <h2 class="op-h">Tasks from you <span>${`${list.length} not started`}</span></h2>
        <div class="op-needs">${list.map(t => taskCard(p, t, now))}</div>
    </section>`;
}

function taskCard(p, t, now) {
    const age = now - t.at;
    const title = t.title || (t.origin && t.origin.title) || clip(t.text, 80);
    const seen = t.status === 'new' ? 'not read yet' : 'read, not started';
    const settings = [t.model || 'inherit', t.effort ? `${t.effort} effort` : null, t.permissionMode,
        t.worktree ? `worktree ${t.worktree.name}` : null].filter(Boolean).join(' · ');
    const busy = ui.taking.has(t.id);
    return html`<div key=${t.id} class="op-need op-task" data-tone=${age > TASK_STALE_MS ? null : 'task'}
        data-busy=${String(busy)}>
        <div class="op-need-q" title=${t.text}>${title}${t.test ? html` <span class="tag-test">test</span>` : null}</div>
        <div class="op-need-from">${`${originWord(t.origin) || 'Handed over'} · ${agoWords(age)} · ${seen}`}
            <span class="op-quiet">${` · ${settings}`}</span></div>
        <div class="op-need-act">
            <button class="lbtn" type="button" disabled=${busy}
                title="Put this back in Drafts — the orchestrator will not start it"
                onClick=${() => takeBack(p, t)}>${busy ? 'Taking back' : 'Take back'}</button>
        </div>
    </div>`;
}

async function takeBack(p, t) {
    ui.taking.add(t.id);
    paintOrchPage();
    try {
        await post(`/api/sessions/${encodeURIComponent(p.orchestratorId)}/orchestrator/tasks/${encodeURIComponent(t.id)}/withdraw`);
        toast('Taken back — it is in Drafts again.', 'ok');
    } catch (err) {
        toast(`Could not take it back: ${err.message}`, 'error');
    } finally {
        ui.taking.delete(t.id);
        paintOrchPage();
    }
}

/** The small "draft" chip on a worker or queued row that began as one of yours. */
const fromTag = (o) => (o ? html`<span class="op-from" title=${`Started ${originWord(o)}`}>${
    o.from === 'draft' ? 'draft' : 'yours'}</span>` : null);

// ── the stage matrix ───────────────────────────────────────────────────────

function matrix(p, now) {
    const ordered = p.workers.slice().sort((a, b) => (a.spawnedAt || 0) - (b.spawnedAt || 0));
    const live = ordered.filter(w => !w.closedAt);
    const done = ordered.filter(w => w.closedAt);
    const counts = [`${live.length} open`, p.pendingSpawns.length ? `${p.pendingSpawns.length} queued` : null,
        done.length ? `${done.length} finished` : null].filter(Boolean).join(' · ');
    return html`<section class="op-sec" aria-label="Workers">
        <h2 class="op-h">Workers <span>${counts}</span></h2>
        ${!p.workers.length && !p.pendingSpawns.length ? html`<div class="op-empty">
            ${`No workers yet. They appear here as the orchestrator starts them, up to ${p.settings.maxRunning} at once.`}</div>`
        : html`<div class="op-matrix">
            <div class="op-cols" aria-hidden="true"><span></span>
                <span class="op-col-names">${STAGES.map(k => html`<span key=${k}>${STAGE_WORD[k]}</span>`)}</span></div>
            ${live.map(w => row(p, w, now))}
            ${p.pendingSpawns.map((q, i) => html`<div key=${q.id} class="op-row op-queued">
                <span class="op-who" title=${q.title || ''}><span class="op-dot" data-s="queued"></span>
                    <span class="op-name">${fromTag(q.origin)}${q.title || 'untitled'}</span></span>
                <span class="op-track"><span class="op-say" title=${queuedSay(q, i)}><b>${queuedSay(q, i)}</b></span></span>
            </div>`)}
            ${done.length ? html`<button key="fold" class="op-fold" type="button" aria-expanded=${String(ui.finished)}
                title=${ui.finished ? null : done.map(w => w.title || 'untitled').join('\n')}
                onClick=${() => { ui.finished = !ui.finished; paintOrchPage(); }}>
                <span class="twist" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                    dangerouslySetInnerHTML=${{ __html: ICON.caret }}></svg></span>
                Finished <b>${done.length}</b>
                ${ui.finished ? null : html`<span class="op-fold-names">${done.map(w => w.title || 'untitled').join(', ')}</span>`}
            </button>` : null}
            ${ui.finished ? done.map(w => row(p, w, now)) : null}
        </div>`}
    </section>`;
}

const ordinal = (n) => (n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`);
const queuedSay = (q, i) => (q.starting ? 'Starting — making its worktree'
    : i === 0 ? 'Queued — starts when a slot frees' : `Queued, ${ordinal(i + 1)} in line`);

function row(p, w, now) {
    const decision = openDecisionFor(p, w.id);
    const r = rowOf(w.id);
    const stage = workerStage(w, p.inbox, { prStatus: freshPr(w.id), mode: r && r.permissionMode, decision });
    const line = stageLine(w, stage, p.inbox, { runner: r && r.runner, now, decision });
    const chip = w.pr && stage.at >= 5 ? html`<span class="op-pr" data-status=${stage.prStatus}>${`#${w.pr.number}`}<em>${
        PR_WORD[stage.prStatus] || stage.prStatus}</em></span>` : null;
    const where = `${STAGE_WORD[STAGES[stage.at - 1]]}: ${[line.lead, line.detail].filter(Boolean).join(', ')
        || (chip ? `#${w.pr.number} ${PR_WORD[stage.prStatus] || ''}` : '')}`;
    const branch = !w.closedAt && w.worktree && w.worktree.branch;
    // Named as a whole: read from its content, the name and the branch ran
    // together with nothing between them.
    const label = `${w.title || 'untitled worker'}${branch ? `, ${branch}` : ''} — ${where}`;
    const open = ui.peek === w.id;
    return html`<button key=${w.id} type="button" class="op-row" data-tone=${stage.tone}
        data-closed=${String(!!w.closedAt)} data-id=${w.id} data-at=${stage.at} aria-label=${label}
        aria-expanded=${String(open)} aria-controls=${open ? 'orch-peek' : null}
        style=${`--at:${stage.at}`} onClick=${() => (open ? closePeek() : openPeek(w.id))}>
        <span class="op-who" title=${[w.title, branch].filter(Boolean).join('\n')}>
            <span class="op-dot" data-s=${DOT[stage.tone] || 'idle'}></span>
            <span class="op-who-text">
                <span class="op-name">${fromTag(w.origin)}${w.title || 'untitled worker'}</span>
                ${branch ? html`<span class="op-branch">${branch}</span>` : null}
            </span>
        </span>
        <span class="op-track" aria-hidden="true">
            ${stage.steps.map((st, i) => html`<i key=${i} data-s=${st}></i>`)}
            <span class="op-say" title=${where}>${chip}${line.lead ? html`<b>${line.lead}</b>` : null}${line.detail
                ? html`<span class="op-say-detail">${line.detail}</span>` : null}</span>
        </span>
    </button>`;
}

const DOT = { wait: 'wait', you: 'wait', error: 'fail', run: 'run', pr: 'done', fail: 'fail', merged: 'done', done: 'done', idle: 'idle', stopped: 'idle' };
const PR_WORD = {
    open: 'open', approved: 'approved', changes: 'changes asked', 'checks-failed': 'checks failed',
    'checks-pending': 'checks running', conflicting: 'conflicts', draft: 'draft', merged: 'merged',
    closed: 'closed', unknown: '',
};

// ── merge order ────────────────────────────────────────────────────────────

function order(p) {
    const m = mergeOrder(p, { prStatusOf: freshPr });
    if (!m.rows.length) return null;
    return html`<section class="op-sec" aria-label="Merge order">
        <h2 class="op-h">Merge order <span>${m.fromBrief ? 'from the brief' : 'in the order the workers started — the brief has none yet'}</span></h2>
        <ol class="op-order">${m.rows.map(r => html`<li key=${r.key} data-merged=${String(r.status === 'merged')}>
            <span class="op-num">${r.n}</span>
            ${r.url ? html`<a class="op-pr" data-status=${r.status} href=${r.url} target="_blank" rel="noreferrer"
                title=${`Open #${r.number} on GitHub`}>${`#${r.number}`}<em>${PR_WORD[r.status] || ''}</em></a>`
                : html`<span class="op-pr" data-status=${r.status}>${`#${r.number}`}</span>`}
            ${r.workerId ? html`<button class="op-order-t" type="button" title=${r.title} onClick=${() => openPeek(r.workerId)}>${r.title}</button>`
                : html`<span class="op-order-t op-quiet" title="Not opened by one of these workers">not opened by one of these workers</span>`}
        </li>`)}</ol>
        ${m.rest.length ? html`<div class="op-order-rest" title=${m.rest.map(x => x.title).join('\n')}>${m.rest.length === 1
            ? `Then ${m.rest[0].title}, once it opens a PR.`
            : `Then ${m.rest.length} more as they open PRs: ${m.rest.map(x => x.title).join(', ')}.`}</div>` : null}
    </section>`;
}

// ── activity ───────────────────────────────────────────────────────────────

function activity(p) {
    return html`<section class="op-sec op-activity" aria-label="Activity">
        <button class="op-fold" type="button" aria-expanded=${String(ui.activity)}
            onClick=${() => { ui.activity = !ui.activity; paintOrchPage(); }}>
            <span class="twist" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                dangerouslySetInnerHTML=${{ __html: ICON.caret }}></svg></span>
            Activity <b>${p.unread ? `${p.unread} unread by the orchestrator` : `${p.inbox.length} items`}</b>
        </button>
        ${ui.activity ? html`<div class="op-activity-body">${inboxList(p)}</div>` : null}
    </section>`;
}

// ── the drawer ─────────────────────────────────────────────────────────────

export function openPeek(workerId) {
    ui.peek = workerId;
    ui.note = null;
    paintOrchPage();
    loadDigest(workerId);
    const d = node('orch-peek');
    requestAnimationFrame(() => { const h = d && d.querySelector('.op-peek-title'); if (h) h.focus({ preventScroll: true }); });
}

export function closePeek({ quiet = false } = {}) {
    const was = ui.peek;
    if (!was) return;
    ui.peek = null;
    ui.note = null;
    const d = node('orch-peek');
    if (d && isUp(d)) present(d, false, { as: 'drawer', onGone: () => { if (!ui.peek) render(null, d); } });
    if (quiet) return;
    paintOrchPage();
    // Back to the row it was opened from.
    const r = document.querySelector(`.op-row[data-id="${was}"]`);
    if (r) r.focus({ preventScroll: true });
}

function paintPeek(p) {
    const d = node('orch-peek');
    if (!d) return;
    const w = p && ui.peek && p.workers.find(x => x.id === ui.peek);
    if (!w) {
        if (ui.peek && p) ui.peek = null;   // gone from the payload — deleted
        if (isUp(d)) present(d, false, { as: 'drawer', onGone: () => { if (!ui.peek) render(null, d); } });
        return;
    }
    render(peekTree(p, w), d);
    if (!isUp(d)) present(d, true, { as: 'drawer' });
    // A worker that moved since its digest was read is worth reading again.
    const dg = ui.digest.get(w.id);
    if (dg && !dg.loading && dg.state !== w.state && Date.now() - dg.at > 5000) loadDigest(w.id);
}

async function loadDigest(workerId) {
    const p = state.orch;
    // The read is one of the orchestrator's own tools, which the bridge refuses
    // to a remote caller (docs/remote.md): say so rather than show the refusal.
    if (!p || state.remote) return;
    const w = p.workers.find(x => x.id === workerId);
    const had = ui.digest.get(workerId);
    ui.digest.set(workerId, { ...(had || {}), loading: true, at: Date.now(), state: w && w.state });
    try {
        const r = await post(`/api/sessions/${p.orchestratorId}/orchestrator/read`, { worker: workerId, mode: 'digest' });
        ui.digest.set(workerId, { loading: false, at: Date.now(), state: w && w.state, fields: r.fields || null,
            // No fields means nothing to read yet, and the text says why.
            note: r.fields ? null : r.text || null, error: null });
    } catch (err) {
        ui.digest.set(workerId, { loading: false, at: Date.now(), state: w && w.state, fields: null, error: err.message });
    }
    if (ui.peek === workerId) paintOrchPage();
}

const hm = (ts) => (ts ? clockOf(ts).replace(/:\d\d(\s?[AP]M)?$/, '$1') : '');

function peekTree(p, w) {
    const b = blockedOn(w, p.inbox);
    const dg = ui.digest.get(w.id);
    const f = dg && dg.fields;
    const reports = p.inbox.filter(i => i.workerId === w.id && ['update', 'done', 'turn', 'question'].includes(i.kind)).slice(0, 3);
    return html`<div class="op-peek" onKeyDown=${(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); closePeek(); }
    }}>
        <header class="op-peek-head">
            <div class="op-peek-top">
                <h2 class="op-peek-title" tabindex="-1" title=${w.title || null}>${w.title || 'untitled worker'}</h2>
                <button class="lbtn" type="button" onClick=${() => goTo(w.id)}>Open session</button>
                <button class="icon-btn" type="button" title="Close — Esc" aria-label="Close" onClick=${() => closePeek()}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
            </div>
            <div class="op-peek-facts">
                ${w.worktree && w.worktree.branch ? html`<span class="op-branch" title=${w.worktree.path || ''}>${w.worktree.branch}</span>` : null}
                <span>${`started ${hm(w.spawnedAt)}`}</span>
                ${w.pr ? html`<a class="op-pr" data-status=${freshPr(w.id) || w.pr.status} href=${w.pr.url || undefined}
                    target="_blank" rel="noreferrer">${`#${w.pr.number}`}<em>${PR_WORD[freshPr(w.id) || w.pr.status] || ''}</em></a>` : null}
            </div>
        </header>
        <div class="op-peek-body">
            ${b ? askBlock(p, w, b) : null}
            ${steps(p, w)}
            <section class="op-peek-sec" aria-label="Progress">
                <h3 class="op-h">So far ${dg && dg.loading ? html`<span>reading…</span>` : null}</h3>
                ${state.remote ? html`<p class="op-quiet">Its progress is only read from the machine the app runs on. Open the session to see its transcript.</p>` : null}
                ${dg && dg.error ? html`<p class="op-quiet">${`Could not read its progress: ${dg.error}`}</p>` : null}
                ${dg && !dg.loading && dg.note ? html`<p class="op-quiet">${dg.note}</p>` : null}
                ${f ? html`<dl class="op-facts">
                    <dt>Turns</dt><dd>${f.turns}</dd>
                    ${f.todo ? html`<dt>Todos</dt><dd>${`${f.todo.done} of ${f.todo.total} done`}${f.todo.now
                        ? html`<span class="op-quiet">${` — now ${f.todo.now}`}</span>` : null}</dd>` : null}
                    ${f.tools.length ? html`<dt>Tools</dt><dd>${f.tools.slice(0, 5).map(t => `${toolDisplayName(t.name)} ×${t.n}`).join(', ')}</dd>` : null}
                    <dt>Files</dt><dd>${f.files.length ? html`<ul class="op-files">${f.files.slice(0, 10).map(x => html`<li key=${x}>${shortPath(x, w)}</li>`)}</ul>${
                        f.files.length > 10 ? html`<span class="op-quiet">${`and ${f.files.length - 10} more`}</span>` : null}` : 'none edited yet'}</dd>
                </dl>` : null}
                ${f && f.diffStat ? html`<pre class="op-stat">${f.diffStat}</pre>` : null}
                ${f && f.lastMessage ? html`<div class="op-last">
                    <h4 class="op-h">Last said</h4>
                    <div class="op-last-text md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(f.lastMessage) }}></div>
                </div>` : null}
            </section>
            ${reports.length ? html`<section class="op-peek-sec" aria-label="Its reports">
                <h3 class="op-h">Its reports</h3>
                <ul class="op-reports">${reports.map(i => html`<li key=${i.id}>
                    <span class="op-quiet">${`${REPORT_WORD[i.kind] || i.kind} · ${agoWords(Date.now() - i.at)}`}</span>
                    <span>${clip(firstLine(i.text), 220)}</span></li>`)}</ul>
            </section>` : null}
        </div>
    </div>`;
}

const REPORT_WORD = { update: 'Update', done: 'Done', turn: 'End of a turn', question: 'Question' };
const firstLine = (t) => String(t || '').split('\n').map(s => s.trim()).find(Boolean) || '';

/** A path inside the worker's own checkout, without the checkout. */
function shortPath(x, w) {
    const root = (w.worktree && w.worktree.path) || w.cwd || '';
    return root && x.startsWith(`${root}/`) ? x.slice(root.length + 1) : x;
}

/** Where it has been, with times — the timeline the payload can still prove. */
function steps(p, w) {
    const mine = p.inbox.filter(i => i.workerId === w.id);
    const plans = mine.filter(i => i.kind === 'plan');
    const plan = plans[plans.length - 1] || null;
    const latest = plans[0] || null;
    // The newest plan decides, as on the row: an approval of an older one does
    // not cover a plan filed since, nor one sent back.
    const ok = latest && latest.settledAt && /^(allow|plan-approved)/.test(latest.outcome || '') ? latest : null;
    const doneItem = mine.find(i => i.kind === 'done') || null;
    const st = freshPr(w.id) || (w.pr && w.pr.status);
    const list = [
        { k: 'Started', at: w.spawnedAt, s: 'done' },
        plan ? { k: 'Plan filed', at: plan.at, s: 'done' } : null,
        ok ? { k: `Approved by ${ok.by === 'user' ? 'you' : 'the orchestrator'}${ok.outcome === 'plan-approved-note' ? ', with a note' : ''}`,
            at: ok.settledAt, s: 'done' }
            : latest && !latest.settledAt && latest.requestId ? { k: 'Waiting for approval', at: null, s: 'now' } : null,
        doneItem || w.closedAt ? { k: doneItem ? 'Said it was done' : 'Closed', at: doneItem ? doneItem.at : w.closedAt, s: 'done' }
            : { k: 'Done', at: null, s: 'todo' },
        w.pr ? { k: `PR #${w.pr.number}`, at: null, s: st === 'merged' ? 'done' : 'now' } : { k: 'Pull request', at: null, s: 'todo' },
    ].filter(Boolean);
    return html`<section class="op-peek-sec" aria-label="Where it is">
        <h3 class="op-h">Where it is</h3>
        <ol class="op-steps">${list.map(x => html`<li key=${x.k} data-s=${x.s}><i></i><span>${x.k}</span>
            <span class="op-steps-at">${x.at ? hm(x.at) : ''}</span></li>`)}</ol>
    </section>`;
}

function askBlock(p, w, b) {
    const item = b.item;
    if (!item) {
        return html`<div class="op-ask"><p><b>${`Waiting for ${ASK_WORD[b.kind] || 'an answer'}.`}</b>
            The request is no longer in the inbox; answer it on its own page.</p>
            <div class="op-ask-btns"><button class="lbtn ok" type="button" onClick=${() => goTo(w.id)}>Open session</button></div></div>`;
    }
    const busy = ui.answering.has(item.requestId);
    const send = (payload) => answerFrom(w, item, payload);
    const reader = item.status === 'new' ? 'The orchestrator has not read it yet.' : 'The orchestrator has it.';
    const waited = shortAge(Date.now() - item.at).replace(/^now$/, '<1m');
    const note = ui.note && ui.note.requestId === item.requestId ? ui.note : null;
    const lead = html`<p><b>${b.kind === 'plan' ? `Plan waiting ${waited}.` : b.kind === 'tool'
        ? `Permission waiting ${waited}.` : `Question waiting ${waited}.`}</b> ${reader} You can answer first; it will be told.</p>`;

    if (b.kind === 'plan') {
        return html`<div class="op-ask" data-busy=${String(busy)}>
            ${lead}
            ${note ? noteForm(item, note, send) : html`<div class="op-ask-btns">
                <button class="lbtn ok" type="button" disabled=${busy}
                    title="Approve, and let it work in auto mode — what the orchestrator does"
                    onClick=${() => send({ decision: 'allow', mode: 'auto' })}>Approve</button>
                <button class="lbtn" type="button" disabled=${busy} data-note="approve"
                    onClick=${() => { ui.note = { requestId: item.requestId, how: 'approve' }; paintOrchPage(); focusSoon('.op-note textarea'); }}>
                    Approve with a note</button>
                <button class="lbtn op-text-btn" type="button" disabled=${busy} data-note="reject"
                    onClick=${() => { ui.note = { requestId: item.requestId, how: 'reject' }; paintOrchPage(); focusSoon('.op-note textarea'); }}>
                    Send it back</button>
            </div>`}
            <div class="op-plan md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(item.text) }}></div>
        </div>`;
    }
    if (b.kind === 'tool') {
        const what = item.ask ? toolSummary({ name: item.ask.tool, input: item.ask.input }) || item.text : item.text;
        return html`<div class="op-ask" data-busy=${String(busy)}>
            ${lead}
            <pre class="op-ask-what"><b title=${(item.ask && item.ask.tool) || null}>${(item.ask && toolDisplayName(item.ask.displayName || item.ask.tool)) || 'Tool'}</b> ${clip(what, 400)}</pre>
            <div class="op-ask-btns">
                <button class="lbtn ok" type="button" disabled=${busy} onClick=${() => send({ decision: 'allow' })}>Allow</button>
                <button class="lbtn" type="button" disabled=${busy} title="Allow it for the rest of that session"
                    onClick=${() => send({ decision: 'allow-always' })}>Always</button>
                <button class="lbtn no" type="button" disabled=${busy} onClick=${() => send({ decision: 'deny' })}>Deny</button>
            </div>
        </div>`;
    }
    // A question. One single-choice question is answered here with a click; any
    // other shape is a form, and the worker's own page already has that form.
    const qs = (item.ask && item.ask.input && item.ask.input.questions) || [];
    const one = qs.length === 1 && !qs[0].multiSelect ? qs[0] : null;
    return html`<div class="op-ask" data-busy=${String(busy)}>
        ${lead}
        ${one ? html`<p class="op-ask-q">${one.question}</p>
            <div class="op-ask-btns">${(one.options || []).map(o => html`<button key=${o.label} class="lbtn" type="button"
                disabled=${busy} title=${o.description || ''}
                onClick=${() => send({ decision: 'allow', answers: { [one.question]: o.label } })}>${o.label}</button>`)}</div>`
            : html`<p class="op-quiet">${clip(firstLine(item.text), 200)}</p>`}
        <div class="op-ask-btns"><button class="lbtn op-text-btn" type="button" onClick=${() => goTo(w.id)}>
            ${one ? 'Answer something else on its page' : 'Answer it on its page'}</button></div>
    </div>`;
}

function noteForm(item, note, send) {
    const approving = note.how === 'approve';
    // Back to the button that opened it, which is drawn again in its place.
    const back = () => { ui.note = null; paintOrchPage(); focusSoon(`#orch-peek [data-note="${note.how}"]`); };
    const go = (e) => {
        e.preventDefault();
        const text = e.target.closest('form').elements.note.value.trim();
        if (!approving && !text) return;
        send(approving ? { decision: 'allow', mode: 'auto', feedback: text } : { decision: 'deny', feedback: text });
    };
    return html`<form class="op-note" onSubmit=${go}>
        <textarea name="note" rows="3" aria-label=${approving ? 'What should it bear in mind?' : 'What should change about this plan?'}
            placeholder=${approving ? 'Anything to bear in mind? Enter approves, Esc goes back.'
                : 'What should change? Enter sends it back, Esc goes back.'}
            onKeyDown=${(e) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(); }
                else if (e.key === 'Enter' && !e.shiftKey) go(e);
            }}></textarea>
        <div class="op-ask-btns">
            <button class="lbtn ${approving ? 'ok' : 'no'}" type="submit">${approving ? 'Approve with this note' : 'Send it back'}</button>
            <button class="lbtn" type="button" onClick=${back}>Cancel</button>
        </div>
    </form>`;
}

async function answerFrom(w, item, payload) {
    if (!item || ui.answering.has(item.requestId)) return;
    ui.answering.add(item.requestId);
    paintOrchPage();
    // The button that sent it is disabled now and gone once the answer lands;
    // the drawer's title stays, so focus waits there.
    focusSoon('#orch-peek .op-peek-title');
    try {
        await answerAskFor(w.id, item.requestId, payload);
        ui.note = null;
    } catch (err) {
        // 409: answered somewhere else first. The event that follows redraws
        // the drawer without the ask, so the message is all that is needed.
        toast(`Could not answer: ${err.message}`, 'error');
    } finally {
        ui.answering.delete(item.requestId);
        paintOrchPage();
    }
}

// ── the splitter ───────────────────────────────────────────────────────────
//
// Between the page and the conversation column: drag it, or focus it and use
// the arrow keys; double-click or Enter puts it back. The value is the width of
// the conversation, which is the thing being chosen, kept per window.
//
// A drag is held to one width write a frame, and while it lasts the pane
// observer in web/transcript/layout.js is told to stand aside
// (`holdPaneInsets`): it would otherwise rewrite the log's width every LOG_STEP
// of travel, and on a long orchestrator each of those writes cost more than the
// frame. Letting go catches the log up once, exactly. The two other
// ResizeObservers in app.js that a drag can wake were left running on purpose:
// the one on `#scroll` keeps a reader who is at the end there, which costs a
// scrollHeight read after a layout that has already happened and would show as
// the end sliding away if deferred; the one on the settings head watches
// something this does not move. Measured on a long orchestrator, a 600px drag
// at 4x CPU throttling went from 200-450ms frames to mostly 16-33ms, with the
// log re-wrapping in a narrowing column what remains.

const CONVO_KEY = 'tgx.orchConvoWidth';
const CONVO_DEFAULT = 420;
const CONVO_MIN = 320;
const PAGE_MIN = 440;
const SPLIT_W = 12;

function storedWidth() {
    try {
        const v = Number(localStorage.getItem(CONVO_KEY));
        return Number.isFinite(v) && v > 0 ? v : CONVO_DEFAULT;
    } catch { return CONVO_DEFAULT; }
}

let convoW = storedWidth();

/** The widest the conversation may be in this window: the page keeps its minimum. */
function maxConvo() {
    const w = dom.convMain ? dom.convMain.clientWidth : 0;
    return Math.max(CONVO_MIN, w - PAGE_MIN - SPLIT_W);
}

/**
 * The width the conversation is drawn at: the chosen one, held to what this
 * window allows. The choice itself is kept as it was, so a window made wider
 * again gets it back. Pass `max` when it has already been read.
 */
const shownWidth = (w = convoW, max = maxConvo()) => Math.min(Math.max(w, CONVO_MIN), max);

// One layout read, and before any write. `maxConvo` asks `#conv-main` how wide it
// is, and this used to ask again for `aria-valuemax` *after* writing the width —
// which made the browser lay out the page and the transcript there and then, on
// every pointermove, and again for the next one. `#conv-main`'s width does not
// depend on the split, so the one answer serves both.
function applyConvoWidth() {
    const main = dom.convMain;
    const split = node('orch-split');
    if (!main) return;
    const max = maxConvo();
    const w = Math.round(shownWidth(convoW, max));
    main.style.setProperty('--orch-convo-w', `${w}px`);
    if (split) {
        split.setAttribute('aria-valuenow', String(w));
        split.setAttribute('aria-valuemin', String(CONVO_MIN));
        split.setAttribute('aria-valuemax', String(Math.round(max)));
        split.setAttribute('aria-valuetext', `Conversation ${w} pixels wide`);
    }
}

function setConvoWidth(w, { save = true } = {}) {
    convoW = Math.min(Math.max(w, CONVO_MIN), maxConvo());
    applyConvoWidth();
    if (!save) return;
    try { localStorage.setItem(CONVO_KEY, String(Math.round(convoW))); } catch { /* private window */ }
}

// At most one width write a frame. A mouse reports more often than the screen
// paints, and a held arrow key repeats faster than a long transcript re-wraps, so
// each of those writing straight through laid the page out several times for
// one frame anybody saw. They record where they want to be instead, and the frame
// writes the last of it. `pending.save` is sticky so a key press coalesced with a
// drag move still gets saved.
const pending = { w: null, save: false, frame: 0 };

function queueConvoWidth(w, { save = true } = {}) {
    pending.w = w;
    pending.save = pending.save || save;
    if (!pending.frame) pending.frame = requestAnimationFrame(flushConvoWidth);
}

/** Write what is queued now, if anything — the frame's job, or release's. */
function flushConvoWidth() {
    cancelAnimationFrame(pending.frame);
    pending.frame = 0;
    if (pending.w == null) return;
    const { w, save } = pending;
    pending.w = null;
    pending.save = false;
    setConvoWidth(w, { save });
}

function wireSplit() {
    const split = node('orch-split');
    if (!split || split.dataset.wired) return;
    split.dataset.wired = '1';

    split.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        split.setPointerCapture(e.pointerId);
        split.dataset.dragging = '1';
        holdPaneInsets();
        const right = dom.convMain.getBoundingClientRect().right;
        const move = (ev) => queueConvoWidth(right - ev.clientX - SPLIT_W / 2, { save: false });
        const up = (ev) => {
            split.removeEventListener('pointermove', move);
            split.removeEventListener('pointerup', up);
            split.removeEventListener('pointercancel', up);
            split.removeEventListener('lostpointercapture', up);
            delete split.dataset.dragging;
            // The release is where it ends, whether or not a move for that spot
            // made it out first; a cancel or a lost capture has no position
            // worth reading. Land it now rather than a frame later, save it, and
            // only then let the log catch up — against the width it ended at.
            if (ev.type === 'pointerup') move(ev);
            flushConvoWidth();
            setConvoWidth(convoW);
            releasePaneInsets();
        };
        split.addEventListener('pointermove', move);
        split.addEventListener('pointerup', up);
        split.addEventListener('pointercancel', up);
        // The split going away mid-drag — the header's Conversation button, a
        // session switch — ends it with neither of those, and the pane observer
        // must not be left held.
        split.addEventListener('lostpointercapture', up);
    });
    split.addEventListener('dblclick', () => queueConvoWidth(CONVO_DEFAULT));
    split.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 64 : 16;
        // From the width on screen, not the one kept: a width saved in a wider
        // window would otherwise swallow the first few presses. And from where the
        // last press asked to be, not what the screen shows yet: two presses
        // inside one frame are two steps.
        const at = shownWidth(pending.w ?? convoW);
        // The separator moves with the arrow: left widens the conversation.
        const to = { ArrowLeft: at + step, ArrowRight: at - step, Home: CONVO_MIN,
            End: maxConvo(), Enter: CONVO_DEFAULT }[e.key];
        if (to == null) return;
        e.preventDefault();
        queueConvoWidth(to);
    });
    // The column narrowing — a window resized, the rail shown, a side panel
    // opened — must not leave the page under its minimum, and the separator's
    // range has to follow it. A ResizeObserver already reports once a frame, after
    // layout; a drag never wakes it, since `#conv-main`'s width does not depend on
    // the split. Without one, `resize` stands in, held to once a frame for the
    // same reason as the drag: a window being dragged reports it as fast as the
    // mouse moves.
    const main = node('conv-main');
    if (main && typeof ResizeObserver === 'function') {
        new ResizeObserver(() => { if (orchPageUp()) applyConvoWidth(); }).observe(main);
    } else {
        let resizeFrame = 0;
        window.addEventListener('resize', () => {
            if (resizeFrame) return;
            resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; if (orchPageUp()) applyConvoWidth(); });
        });
    }
}
wireSplit();
