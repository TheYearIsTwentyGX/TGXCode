// The dev-server channel strip: a chip for each port the open session started
// or mentioned, which opens it in DevBrowser or, armed and pressed again, stops
// it. Moved out of app.js as it was; the bridge side is bridge/devservers.js.
//
// This imports the preview opener and `icon` from app.js, which imports this — safe because
// nothing here reads an app.js binding at module top level, only when a
// function is called.

import { get, post } from './api.js';
import { state } from './state.js';
import { dom, el, toast } from './dom.js';
import { icon, openPreview, openTitle } from './app.js';

// ── dev-server channel strip ─────────────────────────────────────────────

export async function loadChannels() {
    if (!state.current) return;
    const id = state.current.sessionId;
    try {
        const { ports, elsewhere } = await get(`/api/sessions/${id}/devservers`);
        if (!state.current || state.current.sessionId !== id) return;
        state.channels = ports;
        state.channelsElsewhere = elsewhere || 0;
        renderChannels();
    } catch {
        // A missing channel strip is not worth interrupting the user over.
    }
}

export function renderChannels() {
    const chips = state.channels.map(channelChip);
    // Say when ports were left out, rather than leaving the strip looking like
    // nothing is running. These are servers held by another worktree — the
    // reason chips used to bleed across sessions — and naming the count is what
    // makes their absence legible instead of merely quiet.
    const n = state.channelsElsewhere;
    if (n) {
        chips.push(el('span', {
            class: 'chan-note',
            title: n > 1
                ? `${n} ports this session mentioned are held by processes another `
                    + 'session started, so they are not shown here.'
                : 'A port this session mentioned is held by a process another '
                    + 'session started, so it is not shown here.',
        }, `${n} elsewhere`));
    }
    dom.channels.replaceChildren(...chips);
}

/**
 * One port: most of the chip switches DevBrowser to it, and — while it is still
 * answering — a button on the end shuts it down.
 */
function channelChip(p) {
    const go = el('span', { class: 'go' }, p.listening ? 'Open' : 'Gone');
    // Why this chip is here, which is the question the strip used to be unable
    // to answer. `ours` is the kernel's word: the process holding the port was
    // started by this session (`session`), or, if no session started it, runs in
    // this session's directory. `unverified` is nobody's word but this
    // session's own output: nothing on the Linux side holds the port, which on
    // this machine means a server on the Windows side of the mirror.
    const why = p.ours
        ? (p.session ? 'Started by this session' : `Running in ${p.workspace}`)
        : (p.unverified ? 'No local process holds this port — shown because this '
            + 'session started it' : '');
    const chip = el('div', {
        class: `channel${p.unverified ? ' unverified' : ''}`,
        'data-live': String(p.listening),
        title: [why, p.evidence ? `${p.evidence.from}: ${p.evidence.command}` : '']
            .filter(Boolean).join('\n'),
    },
        el('button', {
            class: 'chan-open', type: 'button',
            title: openTitle(p),
            onclick: () => openInDevBrowser(p, chip, go),
        },
            el('span', { class: 'led' }),
            el('span', { class: 'port' }, ':' + p.port),
            p.title ? el('span', { class: 'name' }, p.title) : null,
            go,
        ),
    );
    if (p.listening) chip.append(stopButton(p, chip, go));
    return chip;
}

/**
 * Killing a server is a click too cheap to leave unguarded: the chips sit side by
 * side, all the same size, and the one you meant is usually the neighbour of the
 * one you hit. So the first click only arms — the chip says what is about to
 * happen — and the second signals. Leaving the chip, or waiting, calls it off.
 */
function stopButton(p, chip, go) {
    let timer = null;
    const disarm = () => {
        clearTimeout(timer);
        if (chip.dataset.arm !== 'true') return;
        chip.dataset.arm = 'false';
        go.textContent = 'Open';
    };
    const btn = el('button', {
        class: 'chan-stop', type: 'button',
        title: `Stop the server on :${p.port}`,
        'aria-label': `Stop the server on :${p.port}`,
        onclick: () => {
            if (chip.dataset.arm === 'true') { disarm(); stopChannel(p, chip, go); return; }
            chip.dataset.arm = 'true';
            go.textContent = 'Stop?';
            timer = setTimeout(disarm, 4000);
            nameOwner(p, chip, btn);
        },
    }, icon('power', 13));
    chip.addEventListener('mouseleave', disarm);
    return btn;
}

/**
 * While a chip is armed, its tooltip stops describing the command that *started*
 * the server and describes the process that holds the port now. Ports get reused
 * across worktrees, so the pid and command line are the only things that say the
 * server is still the one the transcript found.
 */
async function nameOwner(p, chip, btn) {
    try {
        const r = await get(`/api/devservers/owner?port=${p.port}`);
        if (chip.dataset.arm !== 'true') return;   // disarmed while we asked
        btn.title = r.owners.length
            ? r.owners.map(o => `Stop pid ${o.pid} — ${o.command}`).join('\n')
            : `Nothing on this side owns :${p.port}`;
    } catch { /* the confirmation stands without it */ }
}

async function stopChannel(p, chip, go) {
    chip.classList.add('busy');
    go.textContent = 'Stopping';
    try {
        const r = await post('/api/devservers/stop', { port: p.port });
        const who = `:${p.port} (pid ${r.pids.join(', ')})`;
        toast(r.escalated
            ? `Stopped ${who} — it ignored SIGTERM, so it was killed.`
            : `Stopped ${who}.`, 'ok');
        // The chip's own state is now stale in more ways than one — the port is
        // dead, and its rank against the others has changed. Ask again.
        loadChannels();
    } catch (err) {
        chip.classList.remove('busy');
        go.textContent = 'Open';
        toast(err.message, 'error');
    }
}

async function openInDevBrowser(p, chip, go) {
    chip.classList.add('busy');
    const was = go.textContent;
    go.textContent = 'Opening';
    try {
        await openPreview({
            port: p.port,
            title: p.title || null,
            // Give the tab a name if the transcript knew one and DevBrowser did not.
            devbrowserTitle: !p.titled && p.title ? p.title : undefined,
            http: p.http,
        });
        go.textContent = 'Open';
    } catch (err) {
        go.textContent = was;
        toast(`Could not open :${p.port}. ${err.message}`, 'error');
    } finally {
        chip.classList.remove('busy');
    }
}
