// The secret card: an agent asked for a secret by name, with request_secret.
//
// bridge/secrets.js has the design. The card is the sudo card's shape
// (web/transcript/sudo.js) and for the same reasons: answered to its own route
// rather than to the CLI, able to be up beside a permission card, so its own
// class (`secret-ask`) and its own slot in state (`state.secretAsk`).
//
// **The value lives in the input until it is sent**, then in the request body,
// and the field is emptied in the same breath — the sudo card's rule. The agent
// is told only that it was saved.
//
// Built with `el()`, like the sudo card: a row of the log, built once per ask.

import { post } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { clip, shortPath } from '../format.js';
import { state } from '../state.js';
import { scrollToEnd } from '../app.js';
import { exit, isLeaving } from '../motion.js';
import { secretsChanged } from '../settings/secrets.js';

const OUTCOME_WORD = {
    saved: 'Saved. The agent can use it now.',
    denied: 'Denied.',
    cancelled: 'Withdrawn',
};

function liveCard() {
    return [...dom.log.querySelectorAll('.secret-ask')].find(n => !isLeaving(n)) || null;
}

/** Settle the card from the status's `secretAsk`. Runs on every status tick. */
export function refreshSecret(ask) {
    const mine = ask && state.current && ask.sessionId === state.current.sessionId ? ask : null;
    const same = mine && state.secretAsk && mine.id === state.secretAsk.id;
    if (same && liveCard()) return;
    if (!mine && !state.secretAsk && !liveCard()) return;
    state.secretAsk = mine;
    renderSecret();
}

export function renderSecret() {
    const old = liveCard();
    const ask = state.secretAsk;
    if (old && (!ask || old.dataset.id !== ask.id)) exit(old, { as: 'reveal', collapse: true });
    else if (old) return;
    if (!ask || state.agent) return;
    dom.log.append(secretCard(ask));
    if (state.pinned) scrollToEnd(false);
}

/** Take the card down for a resolved ask, and say how it ended. */
export function resolveSecret(p) {
    if (p.outcome === 'saved') secretsChanged();
    if (!state.secretAsk || state.secretAsk.id !== p.id) return;
    state.secretAsk = null;
    renderSecret();
    let word = OUTCOME_WORD[p.outcome] || 'Answered.';
    if (p.outcome === 'cancelled') word += p.reason ? ` — ${p.reason}.` : '.';
    dom.log.append(el('div', { class: 'perm-done' }, `${p.name || 'Secret'} — ${word}`));
    if (state.pinned) scrollToEnd(false);
}

/** Why this client may not type the value here, or null. The route's conditions, said before you type. */
function remoteBlock(ask) {
    if (!state.remote) return null;
    if (!ask.remoteAnswer) return 'Turn on in Settings › Secrets at your desk to enter it here. Until then it can only be typed there.';
    if (ask.exists) return `${ask.name} is already set. Change it at your desk.`;
    if (location.protocol !== 'https:') return 'This connection is not encrypted, so a secret cannot be sent over it.';
    return null;
}

function secretCard(ask) {
    const card = el('div', { class: 'secret-ask', 'data-id': ask.id, role: 'group',
        'aria-label': `The agent asks for the secret ${ask.name}` });
    card.append(el('div', { class: 'perm-head' },
        el('span', { class: 'perm-tool' }, 'Secret'),
        el('span', { class: 'perm-title' }, 'the agent asks for a value')));
    card.append(el('div', { class: 'perm-arg' }, ask.name));
    if (ask.why) card.append(el('div', { class: 'perm-why' }, clip(ask.why, 500)));
    card.append(el('div', { class: 'perm-why' },
        `Saved for ${ask.project ? shortPath(ask.project) : 'this project'}. The agent uses it as $${ask.name} `
        + 'in Bash and never sees it; it is not written to the conversation.'));

    const deny = el('button', { class: 'perm-btn deny', type: 'button' }, 'Deny');
    const blocked = remoteBlock(ask);
    if (blocked) {
        card.append(el('div', { class: 'perm-why' }, blocked));
        card.append(el('div', { class: 'perm-btns' }, deny));
        deny.addEventListener('click', () => send(card, 'deny'));
        return card;
    }

    if (state.remote) card.append(el('div', { class: 'perm-why' }, `Sent over HTTPS via ${location.hostname}.`));
    const input = el('input', { class: 'sudo-pw', type: 'password', autocomplete: 'off',
        spellcheck: 'false', 'aria-label': `The value of ${ask.name}`, placeholder: 'Value' });
    const save = el('button', { class: 'perm-btn allow', type: 'submit' }, 'Save ', el('kbd', {}, '⏎'));
    const form = el('form', { class: 'sudo-form', autocomplete: 'off' }, input,
        el('div', { class: 'perm-btns' }, save, deny));
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
    if (document.hasFocus() && !dom.input.matches(':focus')) {
        queueMicrotask(() => input.focus({ preventScroll: true }));
    }
    return card;
}

async function send(card, verb, input = null) {
    const id = card.dataset.id;
    const body = verb === 'answer' && input ? { value: input.value } : {};
    if (input) input.value = '';
    for (const b of card.querySelectorAll('button, input')) b.disabled = true;
    card.dataset.pending = '1';
    try {
        await post(`/api/secrets/asks/${encodeURIComponent(id)}/${verb}`, body);
    } catch (err) {
        toast(`Could not answer: ${err.message}`, 'error');
        delete card.dataset.pending;
        for (const b of card.querySelectorAll('button, input')) b.disabled = false;
    }
}
