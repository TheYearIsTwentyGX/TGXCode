// The app's side of the terminal pane: the one TerminalPane (web/terminal.js is
// the widget), whether it is open per session, its height, its head, and the tabs
// that switch it between the shell and a project command's run. Moved out of
// app.js as it was. wireTerm() binds the pane's buttons and grip, and is called
// by app.js from the wiring block they used to sit in.
//
// `termPane` is built at load. TerminalPane is from web/terminal.js, which
// imports nothing of ours, and the constructor only stores its options.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.

import { post } from './api.js';
import { BOOT_PREFS } from './boot.js';
import { clickCommand, liveRuns, openRunPreview, runPreviewable } from './commands.js';
import { dom, el, toast } from './dom.js';
import { state } from './state.js';
import { TerminalPane } from './terminal.js';
import { opensInDevBrowser, openTitle } from './app.js';
import { renderHeaderActions } from './transcript/conversation.js';

// ── terminal ─────────────────────────────────────────────────────────────

// The pane is a property of the session, not of the window: a shell is opened
// to do something in one conversation's directory, and a session you never
// wanted one in should not inherit it just because the last one had it open.
// So the open flag is remembered per session, the way a draft is.
//
// The height is the other way round — that really is a property of the window,
// and a pane that resized itself as you moved between sessions would be worse
// than one that did not.
const TERM_MIN = 120;

export const termPane = new TerminalPane({
    mount: dom.termBody,
    onOpen: (info) => paintTermHead(info),
    onError: (msg) => toast(`Terminal: ${msg}`, 'error'),
    // A function rather than a value, so toggling the setting reaches a shell
    // that is already open. `keyboard` is user-level only, which is why this
    // reads BOOT_PREFS and not the open session's answer.
    contextualCopy: () => BOOT_PREFS.keyboard.contextualTerminalCopy,
});

function termHeight() {
    const saved = Number(localStorage.getItem('termHeight'));
    return Number.isFinite(saved) && saved >= TERM_MIN ? saved : 300;
}

function setTermHeight(px) {
    const max = Math.max(TERM_MIN, Math.round(window.innerHeight * 0.78));
    const h = Math.min(max, Math.max(TERM_MIN, Math.round(px)));
    dom.termPane.style.setProperty('--term-h', `${h}px`);
    localStorage.setItem('termHeight', String(h));
}

// Only a session with the pane open holds a key, so closing it leaves nothing
// behind and the storage grows with shells you are actually using.
const termKey = (id) => `term:${id}`;

export function termOpen(id) {
    try { return !!id && localStorage.getItem(termKey(id)) === '1'; } catch { return false; }
}

export function setTermOpen(id, on) {
    if (!id) return;
    try {
        if (on) localStorage.setItem(termKey(id), '1');
        else localStorage.removeItem(termKey(id));
    } catch { /* storage unavailable; the pane is still right for this window */ }
}

/** A path the way a shell prompt writes it: ~ for home, and only the tail. */
export function homely(cwd) {
    const short = String(cwd || '').replace(/^\/home\/[^/]+/, '~');
    if (short.length <= 52) return short;
    const parts = short.split('/');
    const out = [];
    // Whole segments only — half a directory name is worse than fewer of them.
    for (let i = parts.length - 1; i >= 0; i--) {
        if (out.join('/').length + parts[i].length + 1 > 50) break;
        out.unshift(parts[i]);
    }
    return `…/${out.join('/')}`;
}

/**
 * Label the pane with the directory the shell is actually in.
 *
 * Not with the session's, because the two drift: a session that enters a
 * worktree after the pane was opened leaves its shell behind in the old
 * directory. Saying so is the honest thing — the alternative is a heading that
 * quietly contradicts the prompt two lines below it.
 */
export function paintTermHead(info) {
    // A run tab describes a command, not a directory, and has its own controls.
    if (state.termTab !== 'shell') return paintRunHead();

    dom.termRestart.hidden = false;
    dom.termStop.hidden = true;
    dom.termPreview.hidden = true;

    const shellCwd = (info && info.cwd) || '';
    dom.termDir.textContent = homely(shellCwd);
    dom.termDir.title = shellCwd;

    const now = state.current && state.current.cwd;
    const moved = !!(info && now && now !== shellCwd);
    dom.termMoved.hidden = !moved;
    if (moved) {
        dom.termMoved.textContent = `· session moved to ${homely(now)}`;
        dom.termMoved.title = now;
    }
    dom.termRestart.title = moved
        ? `Restart the shell in ${now}` : 'End this shell and start a new one';
}

/**
 * The head, when the pane is showing a run.
 *
 * The command itself goes where the shell's directory would be, because that is
 * what the tab is: not "a place" but "this exact string, which you can read
 * before and after it runs".
 */
function paintRunHead() {
    const run = state.runs.get(state.termTab);
    dom.termRestart.hidden = true;
    if (!run) {
        dom.termDir.textContent = '';
        dom.termMoved.hidden = true;
        dom.termStop.hidden = true;
        dom.termPreview.hidden = true;
        return;
    }

    dom.termDir.textContent = run.command;
    dom.termDir.title = `${run.command}\nin ${run.cwd}`;

    const live = run.state !== 'exited';
    const bits = [];
    if (run.port) bits.push(`port ${run.port}`);
    if (run.state === 'starting') bits.push('starting…');
    if (!live) {
        // A run somebody stopped just says so. The signal it actually died of is
        // a detail of how hard the bridge had to insist, not something that
        // happened to it.
        if (run.stopped) bits.push('stopped');
        else if (run.exit && run.exit.signal) bits.push(`killed (${run.exit.signal})`);
        else if (run.exit) bits.push(`exited ${run.exit.code}`);
        else bits.push('gone');
    }
    // Said out loud rather than discovered: a run belongs to the bridge that
    // started it, and there is no way to make one outlive its process.
    if (live) bits.push('stops when the bridge restarts');
    dom.termMoved.hidden = !bits.length;
    dom.termMoved.textContent = bits.length ? `· ${bits.join(' · ')}` : '';
    dom.termMoved.removeAttribute('title');

    dom.termStop.hidden = false;
    dom.termStop.textContent = live ? 'Stop' : 'Start again';
    dom.termStop.title = live
        ? `Stop ${run.label} — SIGHUP to the whole job, then SIGKILL`
        : `Run ${run.command} again`;
    paintRunPreview(run, live);
}

/**
 * The run's Preview button, the one control that says out loud that a task's
 * page can be shown. Clicking the task's own header button does the same once
 * it is up, but nothing about a button that started something says so.
 *
 * Up and answering: it opens the page. Still coming up: it waits, and a click
 * arms the same one-shot a click on a starting task does, so the page opens
 * once the server answers. Never armed toward DevBrowser, for the reason
 * applyRunChange() gives, so in that mode it just waits.
 */
function paintRunPreview(run, live) {
    const b = dom.termPreview;
    b.hidden = !live || !run.port;
    if (b.hidden) return;
    const ready = runPreviewable(run);
    const toDevBrowser = opensInDevBrowser();
    const armed = !toDevBrowser && state.previewWhenUp === run.id;
    b.disabled = !ready && (armed || toDevBrowser);
    b.textContent = toDevBrowser ? 'Open in DevBrowser'
        : !ready && armed ? 'Preview when up' : 'Preview';
    b.title = ready ? openTitle({ port: run.port, title: run.label, http: true })
        : armed ? `Opens by itself once :${run.port} answers`
        : opensInDevBrowser() ? `Waiting for :${run.port} to answer`
        : `:${run.port} has not answered yet — open its page once it does`;
}

/**
 * The tab strip: the shell, then a tab per run in this directory.
 *
 * Absent entirely when there are no runs, so a session in a project that
 * declares nothing sees exactly the pane it saw before.
 */
export function renderTermTabs() {
    const runs = liveRuns().sort((a, b) => a.startedAt - b.startedAt);
    if (!runs.length) {
        dom.termTabs.replaceChildren();
        dom.termTabs.hidden = true;
        if (state.termTab !== 'shell') setTermTab('shell');
        return;
    }
    dom.termTabs.hidden = false;

    const tab = (key, label, extra) => el('button', {
        class: `term-tab${state.termTab === key ? ' on' : ''}${extra || ''}`,
        type: 'button', role: 'tab',
        'aria-selected': String(state.termTab === key),
        onclick: () => setTermTab(key),
    }, label);

    dom.termTabs.replaceChildren(
        tab('shell', 'Shell'),
        ...runs.map((r) => {
            const up = r.state === 'listening' || r.state === 'running';
            const label = r.port && up ? `${r.label} :${r.port}` : r.label;
            return tab(r.id, label, up ? ' on-air' : (r.state === 'exited' ? ' dead' : ''));
        }),
    );
}

/** Point the pane at a tab. The other tab's process is untouched either way. */
export function setTermTab(key) {
    state.termTab = key;
    renderTermTabs();
    if (dom.termPane.hidden) return;
    syncTerm();
}

/** Show or hide the pane. The shell itself is unaffected either way. */
export function showTerm(on, { focus = false } = {}) {
    setTermOpen(state.current && state.current.sessionId, on);
    dom.termPane.hidden = !on;
    dom.btnTerm.classList.toggle('on', on);
    dom.btnTerm.setAttribute('aria-pressed', String(on));
    renderHeaderActions();
    if (!on) {
        // The focus was inside the thing that just disappeared — the shell, or
        // the Hide button that did it — so it would otherwise fall to <body> and
        // the next keystroke would go nowhere. The composer is where you were
        // going anyway.
        if (dom.termPane.contains(document.activeElement) && !dom.input.disabled) dom.input.focus();
        termPane.detach();
        return;
    }

    setTermHeight(termHeight());
    syncTerm();
    if (focus) termPane.focus();
}

/** Point the pane at whatever session — or run — is on screen. */
function syncTerm() {
    if (dom.termPane.hidden) return;
    if (!state.current) { termPane.detach(); paintTermHead(null); return; }

    if (state.termTab !== 'shell') {
        paintRunHead();
        termPane.attachRun(state.termTab);
        return;
    }

    // Already attached: the shell is known, so the head can be right now rather
    // than after a round trip. Otherwise stand in with where it is about to open.
    if (termPane.info && termPane.sessionId === state.current.sessionId) {
        paintTermHead(termPane.info);
    } else {
        dom.termRestart.hidden = false;
        dom.termStop.hidden = true;
        dom.termPreview.hidden = true;
        dom.termDir.textContent = homely(state.current.cwd);
        dom.termDir.title = state.current.cwd || '';
        dom.termMoved.hidden = true;
    }
    termPane.attach(state.current.sessionId);
}

/**
 * Drag the grip to resize. Measured from the pane's bottom edge rather than
 * from where the drag started, so the pointer stays on the grip however far
 * the clamp has moved it.
 */
function startTermDrag(e) {
    e.preventDefault();
    const bottom = dom.termPane.getBoundingClientRect().bottom;
    dom.termGrip.classList.add('dragging');
    document.body.classList.add('term-resizing');

    const move = (ev) => setTermHeight(bottom - ev.clientY);
    const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        dom.termGrip.classList.remove('dragging');
        document.body.classList.remove('term-resizing');
        termPane.refit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
}


/**
 * The pane's buttons and its grip. Called by app.js from the wiring block these
 * were registered in, so they keep their place in the order.
 */
export function wireTerm() {
    dom.btnTerm.addEventListener('click', () => {
        if (!state.current) return;
        showTerm(dom.termPane.hidden, { focus: true });
    });
    dom.termClose.addEventListener('click', () => showTerm(false));
    dom.termRestart.addEventListener('click', async () => {
        await termPane.kill();
        syncTerm();
        termPane.focus();
    });
    // Stop, or start again — the same button, because for a run those are the two
    // halves of one question and the label says which one it is asking.
    dom.termStop.addEventListener('click', async () => {
        const run = state.runs.get(state.termTab);
        if (!run) return;
        if (run.state !== 'exited') {
            try { await post(`/api/runs/${run.id}/stop`, {}); }
            catch (err) { toast(`Stopping ${run.label}: ${err.message}`, 'error'); }
            return;
        }
        const cmd = (state.cmds && state.cmds.commands.find(c => c.id === run.commandId));
        if (!cmd) { toast(`${run.label} is no longer declared here`, 'warn'); return; }
        // The old record goes as the new one takes its place: same button, same tab
        // slot, and the bridge has already dropped the log with it.
        state.runs.delete(run.id);
        clickCommand(cmd);
    });
    dom.termPreview.addEventListener('click', () => {
        const run = state.runs.get(state.termTab);
        if (!run) return;
        if (runPreviewable(run)) { openRunPreview(run); return; }
        state.previewWhenUp = run.id;
        paintRunHead();
    });
    dom.termGrip.addEventListener('pointerdown', startTermDrag);
    // Keyboard equivalent of the drag, so the pane is not mouse-only.
    dom.termGrip.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 60 : 20;
        if (e.key === 'ArrowUp') { e.preventDefault(); setTermHeight(dom.termPane.offsetHeight + step); }
        if (e.key === 'ArrowDown') { e.preventDefault(); setTermHeight(dom.termPane.offsetHeight - step); }
    });
}
