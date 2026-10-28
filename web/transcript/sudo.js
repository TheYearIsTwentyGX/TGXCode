// The sudo card: a `sudo -A` an agent ran, waiting on your password.
//
// Raised by the askpass helper (bridge/sudo.js says what was measured and why it
// is shaped this way) and shown at the foot of the log like a permission card,
// but its own thing: it is answered to /api/sudo, not to the CLI, and it can be
// up while a permission card is. So it has its own class (`sudo-ask`, not
// `perm`, which approvals.js treats as the one live permission card) and its
// own slot in state (`state.sudoAsk`).
//
// **The password lives in the input until it is sent.** It is read once, into
// the request body, and the field is emptied in the same breath; nothing here
// puts it in state, in storage, or anywhere that outlives the request. The input is
// `autocomplete="off"` so the browser does not offer to save it.
//
// Built with `el()`, for approvals.js's reason: it is a row of the log, built
// once per ask and never redrawn in place.

import { post } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { clip } from '../format.js';
import { state } from '../state.js';
import { scrollToEnd } from '../app.js';
import { exit, isLeaving } from '../motion.js';

const OUTCOME_WORD = {
    approved: 'Password sent.',
    denied: 'Denied.',
    cancelled: 'Withdrawn',
};

/** The card in the log, not counting one playing its way out. */
function liveSudoCard() {
    return [...dom.log.querySelectorAll('.sudo-ask')].find(n => !isLeaving(n)) || null;
}

/**
 * Settle the card from what the status says this session is waiting on. Runs on
 * every status tick, so it redraws only when the ask changed or its card is
 * missing — a session switch empties the log.
 */
export function refreshSudo(ask) {
    const mine = ask && state.current && ask.sessionId === state.current.sessionId ? ask : null;
    const same = mine && state.sudoAsk && mine.id === state.sudoAsk.id;
    if (same && liveSudoCard()) return;
    if (!mine && !state.sudoAsk && !liveSudoCard()) return;
    state.sudoAsk = mine;
    renderSudo();
}

/** Show, replace or clear the card. */
export function renderSudo() {
    const old = liveSudoCard();
    const ask = state.sudoAsk;
    if (old && (!ask || old.dataset.id !== ask.id)) exit(old, { as: 'reveal', collapse: true });
    else if (old) return;
    if (!ask || state.agent) return;
    dom.log.append(sudoCard(ask));
    if (state.pinned) scrollToEnd(false);
}

/** Take the card down for a resolved ask, and say how it ended. */
export function resolveSudo(p) {
    if (!state.sudoAsk || state.sudoAsk.id !== p.id) return;
    state.sudoAsk = null;
    renderSudo();
    let word = OUTCOME_WORD[p.outcome] || 'Answered.';
    if (p.outcome === 'cancelled') word += p.reason ? ` — ${p.reason}.` : '.';
    dom.log.append(el('div', { class: 'perm-done' }, `sudo — ${word}`));
    if (state.pinned) scrollToEnd(false);
}

function sudoCard(ask) {
    // A remote window may answer only when the setting says so; it can always deny.
    const canAnswer = !state.remote || ask.remoteAnswer;
    const card = el('div', { class: 'sudo-ask', 'data-id': ask.id, role: 'group',
        'aria-label': 'sudo needs your password' });

    card.append(el('div', { class: 'perm-head' },
        el('span', { class: 'perm-tool' }, 'sudo'),
        el('span', { class: 'perm-title' }, 'needs your password'),
        ask.runsShell ? el('span', { class: 'sudo-flag' }, 'runs a shell') : null));

    // What sudo was given, exactly — read from the sudo process, not from the agent.
    card.append(el('div', { class: 'perm-arg', title: 'The command line of the waiting sudo process' },
        ask.sudoLine));

    const as = ask.group ? `${ask.user}:${ask.group}` : ask.user;
    const where = ask.chdir ? `${ask.chdir} (from ${ask.cwd || 'unknown'})` : (ask.cwd || 'unknown');
    card.append(el('dl', { class: 'sudo-facts' },
        el('dt', {}, 'As'), el('dd', {}, as || 'root'),
        el('dt', {}, 'In'), el('dd', {}, where),
        el('dt', {}, 'Session'), el('dd', {}, sessionName(ask.sessionId))));

    if (ask.runsShell) {
        card.append(el('div', { class: 'perm-why sudo-warn' },
            'This starts a shell as root: approving it approves whatever that shell runs, '
            + 'which is not shown here.'));
    }
    // The cached credential covers the rest of the Bash call, so that is part
    // of what is being approved.
    if (ask.context && ask.context.trim() !== ask.sudoLine) {
        card.append(el('div', { class: 'perm-why' },
            'Part of this Bash command. sudo remembers the password for the rest of it, '
            + 'so any later sudo in it runs without asking:'));
        card.append(el('div', { class: 'perm-arg sudo-context' }, clip(ask.context, 1200)));
    }
    if (ask.attempt > 1) {
        card.append(el('div', { class: 'perm-why sudo-warn' },
            `That password was not accepted. Try ${ask.attempt} of sudo's usual 3.`));
    }

    const deny = el('button', { class: 'perm-btn deny', type: 'button' }, 'Deny');
    if (!canAnswer) {
        card.append(el('div', { class: 'perm-why' },
            'Approve at the desktop. Answering sudo from a phone is off in Settings › Sudo.'));
        card.append(el('div', { class: 'perm-btns' }, deny));
        deny.addEventListener('click', () => send(card, 'deny'));
        return card;
    }

    const input = el('input', { class: 'sudo-pw', type: 'password', autocomplete: 'off',
        spellcheck: 'false', 'aria-label': 'Your password, for sudo',
        placeholder: 'Your password' });
    const approve = el('button', { class: 'perm-btn allow', type: 'submit' }, 'Approve ', el('kbd', {}, '⏎'));
    const form = el('form', { class: 'sudo-form', autocomplete: 'off' }, input,
        el('div', { class: 'perm-btns' }, approve, deny));
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!input.value) { input.focus(); return; }
        send(card, 'answer', input);
    });
    deny.addEventListener('click', () => send(card, 'deny', input));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); send(card, 'deny', input); }
    });
    card.append(form);

    // Focus the field only when you are here and not typing something else.
    if (document.hasFocus() && !dom.input.matches(':focus')) {
        queueMicrotask(() => input.focus({ preventScroll: true }));
    }
    return card;
}

/**
 * Send the answer. The password is read out of the field into the request body
 * and the field is cleared before the request is even made.
 */
async function send(card, verb, input = null) {
    const id = card.dataset.id;
    const body = verb === 'answer' && input ? { password: input.value } : {};
    if (input) input.value = '';
    for (const b of card.querySelectorAll('button, input')) b.disabled = true;
    card.dataset.pending = '1';
    try {
        await post(`/api/sudo/${encodeURIComponent(id)}/${verb}`, body);
    } catch (err) {
        toast(`Could not answer sudo: ${err.message}`, 'error');
        delete card.dataset.pending;
        for (const b of card.querySelectorAll('button, input')) b.disabled = false;
    }
}

function sessionName(sessionId) {
    const s = state.sessions.find(x => x.sessionId === sessionId);
    return (s && (s.title || s.firstPrompt)) ? clip(s.title || s.firstPrompt, 80) : sessionId.slice(0, 8);
}
