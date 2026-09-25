// Pull and restart: the button in the quota popover that fast-forwards the
// checkout the bridge serves and hands over to scripts/restart-bridge.sh, and
// the dialog that explains a refusal. Moved out of app.js as it was.
//
// It and quota.js import each other — the button lives in the quota popover
// and its label is drawn there. Safe for the same reason as the app.js import:
// nothing on either side runs the other at module top level.
//
// This imports `openSessionSoon` from app.js, which imports this — safe because
// nothing here reads an app.js binding at module top level, only when a
// function is called.

import { HEADERS, get, post } from './api.js';
import { state } from './state.js';
import { dom, el, toast } from './dom.js';
import { renderQuotaRestart, showQuota } from './quota.js';
import { openSessionSoon } from './transcript/conversation.js';

// ── picking up new code ─────────────────────────────────────
// One button: fast-forward the checkout the bridge is serving, then hand over to
// scripts/restart-bridge.sh. Before this the only ways were a terminal and the
// midnight cron entry, which is why "why is the bridge still on old code?" is a
// question this repo keeps a log file for.
//
// The awkward part is that a 200 here means "the script was launched and the
// bridge is about to die", not "it restarted" — the process that could confirm
// that is the one being replaced. So success is a *changed* pid from
// /api/health, and a pid that never changes means the script refused, which only
// its journal knows about. See docs/api.md §Things that will bite.

// The script waits 30s for the replacement to answer (60 × 0.5s), so anything
// shorter than that would call a slow but working restart a failure.
const RESTART_WAIT_MS = 45_000;
const RESTART_POLL_MS = 700;

/**
 * Press the button. `force` goes ahead with turns in flight; `pull: false` skips
 * the fast-forward, which is what Restart anyway does after watching one fail.
 */
export async function pullAndRestart(opts = {}) {
    dom.quotaRestart.disabled = true;
    dom.quotaRestart.classList.add('busy');
    renderQuotaRestart();
    try {
        // A raw fetch rather than post(), because this route's 409 *is* the
        // answer — the list of what is in the way — and reading it as a normal
        // response rather than out of a thrown Error is what keeps the happy
        // path below flat. (`post()` would now carry the body too, since every
        // helper throws httpError with `status` and `data` on it; the reason
        // this stayed a raw fetch is shape, not capability.)
        const r = await fetch('/api/restart', {
            method: 'POST', headers: HEADERS, body: JSON.stringify(opts),
        });
        const data = await r.json().catch(() => ({}));

        if (r.status === 409 && data.blocked) return openRestartDialog(data);
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

        closeRestart();
        await awaitNewBridge(data);
    } catch (err) {
        toast(err.message, 'error');
    } finally {
        // By here one of the outcomes is known: the dialog is up, the new bridge
        // answered, or the wait timed out. The button is worth clicking again in
        // all three.
        dom.quotaRestart.classList.remove('busy');
        dom.quotaRestart.disabled = false;
        renderQuotaRestart();
    }
}

/**
 * Wait for a different bridge to answer, and say what happened either way.
 *
 * The window's own recovery needs nothing from here: the SSE drop already puts
 * "Reconnecting to the bridge…" on the status line, and the reopen reloads the
 * rail, the drafts and the schedules for exactly this case.
 */
async function awaitNewBridge(started) {
    const until = Date.now() + RESTART_WAIT_MS;
    while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, RESTART_POLL_MS));
        let h = null;
        try { h = await get('/api/health'); } catch { continue; }  // it is down; that is progress
        if (!h.pid || h.pid === started.pid) continue;

        toast(`Bridge restarted. ${arrived(started)}`, 'ok');
        // Only true of a bridge that `npm run dev` was watching, but that is the
        // one an agent is looking at, and the terminal it was started from now
        // has no way to stop it.
        if (started.detached && state.dev) {
            toast(`Ctrl-C no longer stops :${started.port} — kill it by port instead.`, 'warn', 9000);
        }
        return;
    }

    // Nothing changed, so nothing died, so the script decided against it — and
    // the only record of that decision is a file the surviving bridge can read.
    let why = '';
    try {
        const s = await get('/api/restart');
        const last = s.journal[s.journal.length - 1] || '';
        why = last ? ` Last journal line: ${last}` : '';
    } catch { /* the journal is a nicety; the timeout is the finding */ }
    toast(`The bridge did not restart — it is still on pid ${started.pid}.${why}`,
        'error', { ms: 20000, action: { label: 'Try again', onClick: () => pullAndRestart() } });
}

/** What the pull brought in, in the terms that decide whether it mattered. */
function arrived(started) {
    const p = started.pulled || {};
    if (p.skipped) return 'The pull was skipped.';
    if (!p.changed || !p.changed.length) return 'Already up to date.';
    const n = `${p.changed.length} file${p.changed.length === 1 ? '' : 's'}`;
    const reach = started.reach || {};
    if (reach.shell) return `${n} — app/ or package.json changed, so the shell needs a rebuild.`;
    if (reach.bridge) return `${n}, bridge/ among them.`;
    if (reach.web) return `${n}, UI only.`;
    return n;
}

/** What is in the way, and the three things that can be done about it. */
function openRestartDialog(payload) {
    state.restart = payload;
    const pulled = payload.pulled;
    const failedPull = !!(pulled && !pulled.ok);

    dom.restartLede.textContent = !pulled
        ? 'Nothing was pulled and nothing was restarted.'
        : failedPull
            ? 'The pull did not go through, and nothing was restarted.'
            : 'The pull went through, but nothing was restarted.';

    dom.restartProblems.replaceChildren(...payload.problems.map((p) => el('li', null,
        // A failed pull's text is git's own stderr, and its line breaks carry the
        // suggested command you would copy out of it. Everything else here is a
        // sentence this file wrote.
        el('span', { class: p.text.includes('\n') ? 'restart-why raw' : 'restart-why' }, p.text),
        p.files && p.files.length
            ? el('ul', { class: 'restart-files' },
                ...p.files.slice(0, 12).map((f) => el('li', { text: f })),
                p.files.length > 12
                    ? el('li', { class: 'restart-more', text: `and ${p.files.length - 12} more` })
                    : null)
            : null)));

    // A session can commit, stash or explain a checkout. It cannot do anything
    // about a turn that is running, so do not offer.
    const fixable = payload.problems.some((p) => p.kind !== 'busy');
    dom.restartFix.hidden = !fixable;

    // The click that got here came from inside the quota popover, and the
    // outside-click listener only closes that on a click outside .quota-wrap —
    // which the scrim is. Without this it sits open behind the modal.
    showQuota(false);
    dom.restartScrim.hidden = false;
    dom.restartGo.focus();
}

export function closeRestart() {
    dom.restartScrim.hidden = true;
    state.restart = null;
}

/**
 * Hand the checkout to a session.
 *
 * acceptEdits rather than plan: the answer is nearly always a commit or a stash,
 * and a plan to read before either is a round trip for a decision that is
 * already made by pressing this.
 */
export async function startFixSession() {
    const payload = state.restart;
    if (!payload) return;
    if (!state.root) {
        toast('The bridge did not say which checkout it is serving.', 'error');
        return;
    }
    dom.restartFix.disabled = true;
    try {
        const r = await post('/api/sessions', {
            cwd: state.root,
            prompt: fixPrompt(payload),
            permissionMode: 'acceptEdits',
        });
        closeRestart();
        toast('Started a session on the checkout.', 'ok');
        openSessionSoon(r.sessionId);
    } catch (err) {
        toast(`Could not start the session: ${err.message}`, 'error');
    } finally {
        dom.restartFix.disabled = false;
    }
}

/**
 * The brief, for an agent that has none of this context.
 *
 * The instruction not to enter a worktree is the load-bearing line. This repo's
 * CLAUDE.md tells every agent to make one before its first edit, and here the
 * dirty main checkout *is* the job — an agent that follows the general rule
 * carries the problem into a branch and leaves the checkout exactly as it was.
 */
function fixPrompt(payload) {
    const lines = [
        `The bridge at ${state.root} could not be restarted from the app.`,
        'Sort out the checkout so it can be. What is in the way:',
        '',
    ];
    for (const p of payload.problems) {
        // A failed pull's text is several lines of git, so indent the rest of them
        // to keep the bullet a bullet. No separate "git said" section: that text
        // already *is* what git said, and printing it twice reads as two problems.
        const [head, ...rest] = p.text.split('\n');
        lines.push(`- ${head}`, ...rest.map((l) => `  ${l}`));
        for (const f of p.files || []) lines.push(`    ${f}`);
    }
    lines.push(
        '',
        'Two things about how to do this:',
        '',
        `- Work in ${state.root} directly. Do NOT create or enter a worktree, even`,
        '  though CLAUDE.md tells you to — the state of that checkout is the job, and',
        '  a worktree would carry it into a branch and leave the checkout untouched.',
        '- Do not restart the bridge yourself and do not run install.ps1. Say what you',
        '  did and let me press the button again.',
        '',
        'Commit the work if it looks finished, stash it if it does not, and tell me',
        'which you chose and why. Do not discard anything without saying so first.',
    );
    return lines.join('\n');
}
