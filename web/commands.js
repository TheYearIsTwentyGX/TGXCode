// The session's project commands: what its directory declares in .tgxcode/,
// drawn as a button each in the header, and the runs those buttons start. Moved
// out of app.js as it was. The editor for the declarations is a different thing
// and lives in settings/project-commands.js.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.

import { get, post } from './api.js';
import { dom, el, toast } from './dom.js';
import { state } from './state.js';
import { paintTermHead, renderTermTabs, setTermTab, showTerm, termPane } from './term-pane.js';
import { openPreview, opensInDevBrowser, previewPane } from './app.js';

// ── project commands ─────────────────────────────────────────────────────
// What the session's directory declares in .tgxcode/, as a button each. The
// directory is the session's own, so a session inside a worktree gets that
// worktree's dev server on its own port rather than the main checkout's.
//
// Nothing here ever starts anything on its own — the declaration is read on
// open, and a command runs when it is clicked and not before. The exact string
// that will run is on every button's tooltip, because a checked-in file can
// change what a familiar button does and the honest answer to that is to show
// it rather than to ask about it every time.

/** Where commands for the session on screen are read from. */
export function cmdDir() {
    return (state.current && state.current.cwd) || null;
}

const runFor = (commandId) => {
    const dir = cmdDir();
    if (!dir) return null;
    for (const run of state.runs.values()) {
        if (run.workspace === dir && run.commandId === commandId) return run;
    }
    return null;
};

export const liveRuns = () => [...state.runs.values()].filter(r => r.workspace === cmdDir());

export async function loadCommands() {
    const dir = cmdDir();
    state.cmdsFor = dir;
    if (!dir) { state.cmds = null; renderCommands(); return; }
    let payload;
    try {
        payload = await get(`/api/commands?cwd=${encodeURIComponent(dir)}`);
    } catch {
        // A directory outside the allowed roots, or a bridge that has gone
        // away. Either way there is nothing to offer and no news in saying so.
        payload = null;
    }
    // The session moved while this was in flight.
    if (state.cmdsFor !== dir) return;
    state.cmds = payload;
    // Replaced, not merged. The bridge drops a run's record when the same button
    // is clicked again, and merging kept the dead one alive on this side — which
    // showed as two tabs for one command, one of them a run that no longer
    // existed. The payload is the whole truth about this directory.
    state.runs = new Map();
    if (payload) {
        for (const c of payload.commands) if (c.run) state.runs.set(c.run.id, c.run);
    }
    renderCommands();
}

/**
 * A command's button, coloured by what its run is doing.
 *
 * Green is reserved in this UI for something actually running, so it goes on
 * `listening` and on `running` — not on `starting`, where the honest answer is
 * "asked for, not there yet".
 */
function commandButton(cmd) {
    const run = runFor(cmd.id);
    const state_ = run ? run.state : 'idle';
    // Red is for something that fell over, not for something you stopped.
    const failed = !!run && run.state === 'exited' && !run.stopped
        && !!run.exit && !!(run.exit.code || run.exit.signal);
    const up = state_ === 'listening' || state_ === 'running';

    const bits = [`${cmd.command}`, `in ${cmd.cwd}`];
    if (run && run.port) bits.push(up ? `on port ${run.port}` : `port ${run.port}`);
    if (failed) bits.push(`exited ${run.exit.signal || run.exit.code}`);
    // What a click does, since it depends on the run: start it, show its log,
    // or show its page. See clickCommand().
    bits.push(runPreviewable(run) ? 'Click to show its page'
        : run && run.state !== 'exited' ? 'Click to show its output'
        : 'Click to start');

    return el('button', {
        class: `cmd-btn${up ? ' on' : ''}${failed ? ' failed' : ''}`
            + (state_ === 'starting' || state_ === 'stopping' ? ' pending' : ''),
        type: 'button',
        title: bits.join('\n'),
        'data-id': cmd.id,
        onclick: () => clickCommand(cmd),
    },
    el('span', { class: 'cmd-dot' }),
    el('span', { class: 'cmd-label' }, cmd.label),
    up && run.port ? el('span', { class: 'cmd-port' }, `:${run.port}`) : null);
}

export function renderCommands() {
    const payload = state.cmds;
    const list = payload ? payload.commands : [];
    dom.cmds.replaceChildren(...list.map(commandButton));

    // Problems go on the container rather than into a row of their own: a
    // config file with a typo in it should be findable, not shouty.
    const problems = (payload && payload.problems) || [];
    const loud = problems.filter(p => !p.informational);
    dom.cmds.classList.toggle('has-problems', loud.length > 0);
    if (loud.length) {
        dom.cmds.title = loud.map(p =>
            `${p.file || ''}${p.id ? ` [${p.id}]` : ''}: ${p.message}`).join('\n');
    } else {
        dom.cmds.removeAttribute('title');
    }
    renderTermTabs();
}

/**
 * Start it, or show what it is already doing.
 *
 * A live run is never restarted by clicking its button — that would take a dev
 * server down because somebody meant to look at its log. Stopping is a separate,
 * labelled button in the pane.
 */
export async function clickCommand(cmd) {
    const existing = runFor(cmd.id);
    if (existing && existing.state !== 'exited') {
        // Up and serving pages: the page is what the button is for. The log is
        // one click away, on the preview's toolbar, and the pane is left as it
        // was rather than opened underneath where nobody can see it.
        if (runPreviewable(existing)) {
            openRunPreview(existing);
            return;
        }
        showTerm(true);
        setTermTab(existing.id);
        // Still coming up: show the page once it does. One-shot, and only for
        // the run this click was about.
        if (existing.port) state.previewWhenUp = existing.id;
        return;
    }
    try {
        const { run } = await post('/api/commands/run', { cwd: cmdDir(), id: cmd.id });
        // One run per command per directory, the same rule the bridge enforces:
        // whatever was here before has just been replaced, record and log alike.
        const stale = runFor(cmd.id);
        if (stale) state.runs.delete(stale.id);
        state.runs.set(run.id, run);
        renderCommands();
        showTerm(true);
        setTermTab(run.id);
        // Starting a server is asking to look at it: the log first, while it
        // compiles, and the page once it answers.
        if (run.port) state.previewWhenUp = run.id;
    } catch (err) {
        toast(`${cmd.label}: ${err.message}`, 'error');
    }
}

/**
 * Whether a task's page is worth showing yet: its port is taken, and either it
 * has answered HTTP or the command says it is a web app (`"web": true`). The
 * second is for a server whose first page takes longer than anyone wants to
 * wait for a probe: the preview goes up at once and the page loads in front of
 * you, rather than the button only showing the log.
 */
export function runPreviewable(run) {
    return !!run && run.state === 'listening' && !!run.port
        && (run.http === true || run.web === true);
}

/** A task's page, by the same rule as any other port. */
export function openRunPreview(run) {
    openPreview({
        port: run.port,
        title: run.label || null,
        runId: run.id,
        http: run.http || run.web,
    }).catch((err) => toast(`Could not open :${run.port}. ${err.message}`, 'error'));
}

/** A run's state changed somewhere — possibly in another window. */
export function applyRunChange(e) {
    const known = state.runs.get(e.runId);
    if (known) {
        state.runs.set(e.runId, { ...known, state: e.state, port: e.port, http: e.http,
            exit: e.exit, stopped: e.stopped });
        const run = state.runs.get(e.runId);
        // The one-shot a click on a starting task left behind, now due. In this
        // window only: raising DevBrowser because a server finished compiling
        // is the window-on-the-Windows-host that bridge/runs.js name() refuses
        // to open, and a click that happened a minute ago is not consent to it.
        if (state.previewWhenUp === e.runId && runPreviewable(run)) {
            state.previewWhenUp = null;
            if (!opensInDevBrowser() && run.workspace === cmdDir()) openRunPreview(run);
        }
        // Its server is gone, so its kept page is a page of nothing.
        if (e.state === 'exited' && e.port) {
            if (state.previewWhenUp === e.runId) state.previewWhenUp = null;
            previewPane.discard(e.port);
        }
    } else if (e.workspace === cmdDir()) {
        // Started from another window, in the directory on screen. Ask for the
        // whole record rather than inventing one from a state change.
        loadCommands();
        return;
    } else {
        return;
    }
    renderCommands();
    if (state.termTab === e.runId) paintTermHead(termPane.info);
}
