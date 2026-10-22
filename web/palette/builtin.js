// The palette's own entries: the views, the settings groups, and the buttons
// that are already on screen. web/palette/registry.js says what an entry is.
//
// **Nothing here does the work itself.** Every entry calls the function its
// button calls, and where a button's handler is an inline listener with logic
// of its own — Stop's hard-stop arming, Reveal's busy state, Pin's toggle — the
// entry clicks that button, which is the one way to be sure it stays the same
// code. `when` mirrors whether the button is there to press.
//
// **Features that have not landed light up by themselves.** Transcript search
// (#195), the worktree janitor (#194) and session templates (#198) are imported
// on the palette's first open with `import()`, and an entry exists only if the
// module and its function do. A missing module is a 404 the palette swallows.
//
// This imports from app.js, which imports this — safe because nothing here reads
// an app.js binding at module top level, only when a function is called.

import { state } from '../state.js';
import { dom, toast } from '../dom.js';
import { setDockSide, setFocus, showView, startRename } from '../app.js';
import { openNew } from '../new-session/dialog.js';
import { openFind } from '../transcript/find.js';
import { SETTINGS } from '../settings/general.js';
import { openSettingsAt } from '../settings/index.js';
import { clickCommand } from '../commands.js';
import { openInDevBrowser } from '../channels.js';
import { showPhoneInstalls } from '../phone-installs.js';
import { registerAction, registerSource } from './registry.js';

const shown = (node) => !!node && !node.hidden && !node.disabled;
// For the bar's pills, which can also be folded into the overflow menu; a pill
// in a closed menu has no box, and its popover would open anchored to nothing.
const onScreen = (node) => shown(node) && node.getClientRects().length > 0;

/** An entry that presses a header button, offered while that button is. */
function viaButton(id, node, title, more = {}) {
    registerAction({
        id, group: 'Actions', title,
        when: () => !!state.current && shown(node),
        run: () => node.click(),
        ...more,
    });
}

export function registerBuiltins() {
    // ── views ──
    // Titles from web/keys.js's labels, so a view is found by the name its
    // shortcut has in Settings › Keyboard.
    const views = [
        ['view.conversation', 'Conversation', 'back close panels transcript'],
        ['view.tasks', 'Tasks', 'task board todo'],
        ['view.live', 'Live board', 'running sessions'],
        ['view.dashboard', 'Dashboard', 'projects worktrees'],
        ['view.history', 'History', 'notes notifications'],
        ['view.drafts', 'Drafts', ''],
        ['view.schedules', 'Schedules', 'cron timer'],
        ['view.settings', 'Settings', 'preferences options'],
        ['view.analytics', 'Analytics', 'cost tokens spend usage'],
        ['view.hooks', 'Hooks', 'claude code hook pretooluse posttooluse sessionstart script recipe'],
    ];
    for (const [command, title, keywords] of views) {
        registerAction({ id: command, group: 'Views', title, keywords, command, run: () => showView(command) });
    }
    for (const g of SETTINGS) {
        registerAction({
            id: `settings.${g.section}`, group: 'Views', quiet: true,
            title: `Settings › ${g.tocTitle && !g.title.includes(g.tocTitle) ? `${g.title} ${g.tocTitle}` : g.title}`,
            keywords: `settings ${g.category}`,
            when: () => !g.when || g.when(),
            run: () => openSettingsAt(g.section),
        });
    }
    registerAction({
        id: 'live.focus', group: 'Views', title: 'Live board focus mode', keywords: 'fullscreen',
        when: () => state.live.open,
        run: () => setFocus(!state.focus),
    });
    registerAction({
        id: 'live.dock', group: 'Views', keywords: 'dock side bottom split',
        title: () => (state.live.dock === 'side' ? 'Dock the live board below' : 'Dock the live board beside'),
        when: () => state.live.open,
        run: () => setDockSide(state.live.dock !== 'side'),
    });

    // ── actions ──
    registerAction({
        id: 'session.new', group: 'Actions', title: 'Start a session', keywords: 'new create',
        command: 'session.new', run: () => openNew(),
    });
    registerAction({
        id: 'schedule.new', group: 'Actions', title: 'Schedule a session', keywords: 'new cron timer',
        run: () => openNew({ schedule: true }),
    });
    viaButton('turn.stop', dom.btnStop, 'Stop the current turn', { keywords: 'cancel interrupt halt' });
    viaButton('session.terminal', dom.btnTerm, 'Terminal', { command: 'terminal.toggle', keywords: 'shell pty' });
    viaButton('session.changes', dom.btnChanges, 'Changes', { keywords: 'diff git files' });
    viaButton('session.reviews', dom.btnReviews,
        () => (state.reviews.on ? 'Hide reviews' : 'Show reviews'), { keywords: 'code review findings adversarial' });
    viaButton('session.images', dom.btnImages,
        () => (state.images.on ? 'Hide images' : 'Show images'), { keywords: 'pictures screenshots attachments gallery' });
    viaButton('session.checklist', dom.btnChecklist, 'Checklist', { keywords: 'todo tasks' });
    viaButton('session.orchestrator', dom.btnOrch, 'Orchestrator', { keywords: 'workers dock' });
    viaButton('session.restart', dom.btnRestartProc, 'Restart process', { keywords: 'reload tools mcp resume' });
    viaButton('session.reveal', dom.btnFolder, 'Reveal in file explorer', { keywords: 'folder open finder' });
    viaButton('session.pin', dom.btnPin,
        () => (state.current && state.current.pinned ? 'Unpin session' : 'Pin session'));
    viaButton('session.archive', dom.btnArchive,
        () => (state.current && state.current.archived ? 'Unarchive session' : 'Archive session'));
    viaButton('session.delete', dom.btnDelete, 'Delete session', { keywords: 'remove trash' });
    registerAction({
        id: 'session.rename', group: 'Actions', title: 'Rename session', keywords: 'title',
        when: () => !!state.current, run: () => startRename(state.current),
    });
    registerAction({
        id: 'find.open', group: 'Actions', title: 'Find in conversation', command: 'find.open',
        when: () => !!state.current, run: () => openFind(),
    });
    registerAction({
        id: 'rail.filter', group: 'Actions', title: 'Filter sessions', command: 'rail.filter',
        keywords: 'search rail', run: () => dom.search.focus(),
    });

    // The bar's window-level pills.
    const pill = (id, node, title, keywords) => registerAction({
        id, group: 'Actions', title, keywords, when: () => onScreen(node), run: () => node.click(),
    });
    pill('bar.quota', dom.quotaPill, 'Usage quota', 'limits tokens');
    pill('bar.version', dom.cvPill, 'Claude Code version', 'update changelog');
    pill('bar.devbrowser', dom.dbStatus, 'Refresh DevBrowser status', 'devbrowser');
    // Always offered, unlike the pills above: "is my install still going?" is
    // asked most when the answer is that there is none, and saying so beats an
    // entry that is not there.
    registerAction({
        id: 'bar.phoneInstalls', group: 'Actions', title: 'Phone installs', keywords: 'apk android install phone',
        // Not a click on the pill: it may be in the More menu or hidden, and the
        // popover opens wherever it is (see dockPhoneInstalls()).
        run: () => (dom.piWrap.hidden ? toast('Nothing has been sent to the phone in the last day', 'info')
            : showPhoneInstalls(true)),
    });
    registerAction({
        id: 'rail.hideDone', group: 'Actions', keywords: 'rail filter',
        title: () => (state.hideDone ? 'Show finished sessions' : 'Hide finished sessions'),
        when: () => onScreen(dom.hideDone), run: () => dom.hideDone.click(),
    });

    // ── what the open session has ──
    // The project's .tgxcode/commands.json (Land and Dev instance, in this repo),
    // run exactly as their buttons run them.
    registerSource('commands', () => ((state.current && state.cmds && state.cmds.commands) || []).map(c => ({
        id: `cmd.${c.id}`, group: 'Actions', title: c.label || c.id,
        meta: c.run || c.command || 'Project command', keywords: 'project command run',
        run: () => clickCommand(c),
    })));
    registerSource('devservers', () => ((state.current && state.channels) || [])
        .filter(p => p.listening)
        .map(p => ({
            id: `port.${p.port}`, group: 'Actions',
            title: `Open :${p.port} in DevBrowser`, meta: p.title || '',
            keywords: 'dev server preview port browser',
            run: () => openInDevBrowser(p),
        })));
}

// ── what lights up once other branches land ──

// Each value is the module once it has loaded, null if it does not exist (yet).
const optional = { search: undefined, worktrees: undefined, templates: undefined };

/**
 * Load the modules other pull requests add, once, and register what they offer.
 * `then` is called when they have answered, so the palette can redraw.
 */
export function loadOptional(then) {
    if (optional.search !== undefined) return;
    optional.search = optional.worktrees = optional.templates = null;
    const tryImport = (path) => import(path).catch(() => null);
    Promise.all([
        // #195 — transcript search.
        tryImport('../search.js').then((m) => {
            if (!m || typeof m.openSearch !== 'function') return;
            optional.search = m;
            registerSource('search', ({ q }) => (q ? [{
                id: 'search.transcripts', group: 'Search', always: true,
                title: `Search transcripts for '${q}'`, command: 'search.open',
                run: () => m.openSearch(q),
            }] : []));
        }),
        // #194 — the worktree janitor, for the open session's project.
        tryImport('../worktrees.js').then((m) => {
            if (!m || typeof m.openWorktrees !== 'function') return;
            optional.worktrees = m;
            registerAction({
                id: 'worktrees.clean', group: 'Actions', title: 'Clean up worktrees',
                keywords: 'janitor remove prune worktree',
                when: () => !!state.current,
                run: () => m.openWorktrees({
                    cwd: state.current.projectCwd || state.current.cwd,
                    name: state.current.projectName,
                }),
            });
        }),
        // #198 — session templates. Picking one is what the dialog's picker does
        // on `change`, so the entry opens the dialog and makes that same choice.
        tryImport('../new-session/templates.js').then((m) => {
            if (!m) return;
            optional.templates = m;
            registerSource('templates', () => ((state.templates && state.templates.rows) || []).map(t => ({
                id: `template.${t.id}`, group: 'Actions',
                title: `Start from template: ${t.name}`, meta: t.projectName || '',
                keywords: 'new session template',
                run: () => {
                    openNew();
                    if (!dom.newTpl) return;
                    dom.newTpl.value = t.id;
                    dom.newTpl.dispatchEvent(new Event('change'));
                },
            })));
        }),
    ]).then(then, then);
}
