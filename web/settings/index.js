// The Settings panel: opening and closing it, loading what it shows, saving one
// key at a time, and drawing the head, the table of contents and the groups.
// The controls themselves are in general.js, and each of the other files here
// is one group with an editor of its own.
//
// Drawn with Preact the way web/rail.js settled — htm templates, no build step,
// keyed children, no hand edits to nodes Preact owns. What is Preact so far:
// the head's file line, problems and project list, the contents, the body, and
// every group built from rows (general.js) plus Keyboard's shortcuts
// (shortcuts.js), Toolbar (toolbar.js) and Notifications (notifications.js).
// Still built by hand with el() and hung in the tree as foreign DOM: Claude
// Code, its Memory, Project commands, and the groups written out in
// web/index.html (Projects' colour list, Snippets' shell, Wispr Flow, Connect a
// phone). Snippets' list is Preact of its own (web/snippets/settings.js).
//
// Imports from app.js, which imports this — safe because nothing here reads an
// app.js binding while the module evaluates, only when a function is called.
// Keep it that way: a module-level `const` built from an app.js `const` throws,
// because every module under web/settings/ evaluates before app.js's body runs.

import { html, useLayoutEffect, useRef } from '../vendor/preact.js';
import { get, put } from '../api.js';
import { BOOT_PREFS, PREFS_FALLBACK } from '../boot.js';
import { renderChannels } from '../channels.js';
import { dom, toast } from '../dom.js';
import { noteHome, shortPath } from '../format.js';
import * as keys from '../keys.js';
import { state } from '../state.js';
import { termPane } from '../term-pane.js';
import {
    closeOtherPanels, liveVisible, loadPairing, paintBackdropTint, paintDevBrowserPresence,
    paintPanels, paintRailSort, rememberView, renderLive, renderRail, syncBoardWatch,
    syncTaskboardWatch,
} from '../app.js';
import { paintComposerHint } from '../composer/send.js';
import { openSession } from '../transcript/conversation.js';
import { loadClaudeConfig } from './claude-config.js';
import { settingsCard, SETTINGS, SETTINGS_CATEGORIES } from './general.js';
import { loadClaudeDocs } from './memory.js';
import { loadCmdConfig } from './project-commands.js';
import { paintShortcutHints } from './shortcuts.js';
import { paintToolbar } from './toolbar.js';
import { paint } from '../boards/parts.js';

// ── settings ─────────────────────────────────────────────────────────────
//
// Every key in `~/.tgxcode/settings.json`, with a control in front of it.
//
// The file stayed the only interface for a long time and that was defensible
// while there were three keys in it. At twelve, across four blocks, with a
// precedence chain of four files and validators that silently drop what they do
// not like, "go and read bridge/prefs.js" had become the answer to too many
// questions — and the one thing the file cannot tell you is which of the four
// files a value came from.
//
// So this panel answers both questions at once: what is in force, and where it
// was set. `GET /api/prefs?files=1` returns the merged answer *and* what each
// file says on its own, which is what lets a control distinguish a value you
// set from one you inherited — and name the file that has taken over when a
// stronger one has.
//
// **The file is still the interface.** The head names the exact path it is
// about to write and lets you copy it, and nothing here is stored anywhere a
// text editor cannot reach. This is a better way in, not a replacement.
//
// **Nothing here is a draft.** Every control saves on change, one key at a
// time, because a settings page with a Save button has a state where what you
// see and what is in force disagree — and the failure mode of that is a
// preference you believe you set. One key per request also means two windows
// editing different settings do not clobber each other.

/** Human names for the three scopes, for the sentences below. */
export const SCOPE_NAMES = {
    user: 'User', project: 'Project — shared', 'project-local': 'Project — local',
};

export function showSettings(on) {
    state.settings.open = on;
    if (on) closeOtherPanels('settings');
    paintPanels();
    syncBoardWatch();
    syncTaskboardWatch();

    if (on) {
        // Always re-asked on open rather than cached like the dashboard is. The
        // file can be edited by hand between two visits, and a settings page
        // showing a stale value is the one thing it must never do.
        loadSettings();
    } else if (state.live.open) {
        renderLive();
        if (state.current) termPane.refit();
    } else if (state.current) {
        termPane.refit();
    }
    rememberView();
}

/**
 * Which directory the project scopes are about.
 *
 * Defaults to the open session's project, because that is usually the answer —
 * but it is a selector and not a reading of `state.current`, because Settings is
 * a whole screen you go to with nothing open at least as often as you reach it
 * mid-conversation, and a scope that silently means "wherever the rail happens
 * to be" would write a preference into a repository you were not thinking about.
 *
 * With nothing open it falls back to the newest project the bridge knows,
 * because "no project" is not a state the two project scopes can be read in —
 * they would have no file to name and every control would be disabled with
 * nothing saying why.
 */
export function settingsProject() {
    const s = state.settings;
    if (s.project) return s.project;
    const cur = state.current;
    if (cur && (cur.projectCwd || cur.cwd)) return cur.projectCwd || cur.cwd;
    return (s.projects[0] && s.projects[0].cwd) || '';
}

/**
 * The verb catalogue, and what the spinner is currently doing with it.
 *
 * Its own function because it has to be asked again after a save, not only when
 * the panel opens: this answer carries the pool size, each group's weight and
 * each group's share, so ticking a group or changing a number moves numbers
 * that are drawn from *here* rather than from the prefs the save returns. Left
 * as one fetch on open, the shares sat still while the file underneath them
 * changed — which is worse than not showing them.
 *
 * `verbs=1` because a group's name is not enough to choose it by — the tooltip
 * on each one lists what is actually in it.
 */
async function loadSpinnerGroups(dir) {
    const s = state.settings;
    try { s.spinner = await get(`/api/spinner/groups?verbs=1${dir ? `&cwd=${encodeURIComponent(dir)}` : ''}`); }
    catch { s.spinner = null; }
}

export async function loadSettings() {
    const s = state.settings;
    if (s.loading) return;
    s.loading = true;
    s.error = null;
    // A fresh look at the panel gets a fresh order for the verb groups, chosen
    // ones first. Only here and on a scope change — never on the refetch after
    // a save, which is the whole point of pinning it.
    s.groupOrder = null;
    renderSettings();

    // The project list first, because settingsProject() falls back to it — and
    // asked for once, since it is a directory listing rather than something
    // that moves while you read a settings page.
    if (!s.projects.length) {
        try { s.projects = (await get('/api/projects')).projects || []; }
        catch { /* the selector falls back to the open session's project alone */ }
    }
    try {
        // The whole chain every time, whatever scope is selected: the answer
        // carries all four files, so switching scope is a redraw rather than a
        // fetch, and the User scope can still say which project file overrides
        // it.
        const dir = settingsProject();
        s.data = await get(`/api/prefs?files=1${dir ? `&cwd=${encodeURIComponent(dir)}` : ''}`);
        // Not awaited: it is a second group's worth of content and the page
        // draws fine without it, the way loadPairing() below is not awaited.
        loadClaudeConfig();
        loadClaudeDocs();
        loadCmdConfig();
        // The weakest file in the chain is always the user's own, which is what
        // tells shortPath where home is.
        if (s.data.files && s.data.files.length) noteHome(s.data.files[0].file);
        // Loading the spinner catalogue alongside, because the groups control is
        // a list of checkboxes and the names can only come from the directory.
        await loadSpinnerGroups(dir);
        // What this machine is reachable as, for the pairing group. Not awaited
        // into the render: it shells out to `tailscale.exe` on the Windows host,
        // which is slow enough that holding the whole panel for it would be
        // felt, and the group draws fine from the remembered host meanwhile.
        loadPairing();
    } catch (err) {
        s.error = err.message;
    }
    s.loading = false;
    renderSettings();
    // Somewhere outside the panel asked for one group — see openSettingsAt.
    if (s.jumpTo) {
        const card = document.getElementById(`set-g-${s.jumpTo}`);
        s.jumpTo = null;
        if (card) card.scrollIntoView({ block: 'start' });
    }
}

/**
 * Open Settings scrolled to one group. On the User scope, because the groups
 * anything links to from outside the panel are the user-only ones, and a
 * project scope would show them locked.
 */
export function openSettingsAt(section) {
    state.settings.jumpTo = section;
    state.settings.scope = 'user';
    showSettings(true);
}

/**
 * Save one key, and take the answer as the truth.
 *
 * The response carries the merged settings and the per-file breakdown, so
 * nothing here has to guess at what the write did — including the case where
 * the value lands in a file a stronger one is already overriding, which is the
 * one a client that assumed success would draw wrongly.
 */
export function saveSetting(section, key, value) {
    return saveSettings(section, { [key]: value });
}

/**
 * Save several keys of one section in one write. "All views" under the live
 * board's visibility is six keys, and six saves would be six chances to stop
 * halfway — the bridge validates a patch whole, so this lands all or nothing.
 */
export async function saveSettings(section, patch) {
    const s = state.settings;
    // Dropped while another save runs, as it always was. The typed-into boxes
    // are uncontrolled, so the one this came from would go on showing the value
    // that was never sent: bumping `rev` remounts them from the stored value
    // when the running save redraws. See settingsRevert() in general.js.
    if (s.saving) { s.rev++; return; }
    s.saving = true;
    renderSettings();
    try {
        const dir = settingsProject();
        const answer = await put('/api/prefs', {
            scope: s.scope,
            cwd: dir,
            patch: { [section]: patch },
        });
        s.data = { ...answer.prefs, files: answer.files };
        applyPrefsLive(answer.prefs, section);
        // The spinner panel draws its counts and shares from the catalogue
        // route rather than from the prefs, so a spinner save has to ask it
        // again or the numbers beside the controls stay on the old answer.
        if (section === 'spinner') await loadSpinnerGroups(dir);
    } catch (err) {
        toast(`Could not save that setting: ${err.message}`, 'error');
        // The stored value did not move, so nothing else would remount the box
        // that still shows the refused one.
        s.rev++;
    }
    s.saving = false;
    renderSettings();
}

/**
 * Make a saved setting true of the window it was saved in.
 *
 * The page reads its settings from a `<meta>` tag baked at serve time, and
 * `liveCompact()`/`liveHideElsewhere()` read it directly — so before this, the
 * live-board settings did not take effect until a reload, which README said out
 * loud. Folding the new values into that object closes the gap for everything
 * except history, which is not re-rendered by anything: a change under
 * `transcript` re-opens the session, because the folding decisions were made
 * while the rows were built.
 *
 * Only the user-level answer is applied, which is what BOOT_PREFS is. A project
 * scope's save shows up in this panel and travels with the next transcript.
 */
function applyPrefsLive(prefs, section) {
    if (state.settings.scope !== 'user') return;
    for (const block of Object.keys(PREFS_FALLBACK)) {
        if (block === 'version' || !prefs[block]) continue;
        Object.assign(BOOT_PREFS[block], prefs[block]);
    }
    keys.apply(BOOT_PREFS.keyboard);
    paintShortcutHints();
    paintToolbar();
    paintBackdropTint();
    // `live.over*` can put the board beside the panel you are saving it from.
    if (section === 'live') paintPanels();
    if (liveVisible()) renderLive();
    if (section === 'keyboard') paintComposerHint();
    if (section === 'projects') { renderRail(); paintRailSort(); }
    // The pill, its poll, and every chip's tooltip say which browser a click
    // means, and all of them were drawn under the old answer.
    if (section === 'devbrowser') { paintDevBrowserPresence(); renderChannels(); }
    if (section === 'transcript' && state.current) {
        // Re-read the conversation so the new folding rule applies to what is
        // already on screen. keepDash so going and looking does not close this.
        openSession(state.current.sessionId, { keepDash: true, quiet: true });
    }
}

/**
 * Which file a section.key is actually coming from, and which scope set it.
 *
 * Walks the chain weakest-first, so the last file to mention a key is the one
 * that wins — the same order bridge/prefs.js merges in, and the reason this is
 * derived here rather than asked for: the two must agree, and there is only one
 * rule to agree about.
 */
export function settingOrigin(section, key) {
    const files = (state.settings.data && state.settings.data.files) || [];
    let winner = null;
    for (const f of files) {
        if (f.values && f.values[section] && f.values[section][key] !== undefined) winner = f;
    }
    return winner;
}

/** The file this scope would write, out of the chain we were handed. */
export function settingsTargetRow() {
    const files = (state.settings.data && state.settings.data.files) || [];
    return files.find(f => f.scope === state.settings.scope && f.target) || null;
}

/**
 * Draw the panel: the file line and problems in the pinned head, the groups in
 * the body, the contents down the left.
 *
 * All three are Preact renders into containers from web/index.html, so a
 * redraw is a diff rather than a rebuild — which matters because this runs
 * twice for every save and again whenever an editor group finishes loading,
 * and a rebuild threw away the focus, the hover and any half-typed number in
 * every group each time. The groups are keyed by section, so each keeps its
 * nodes across a redraw however the others change.
 *
 * Groups still built by hand with el() (a `render` or a `node` in SETTINGS)
 * are handed over as foreign DOM — see Foreign below — and are rebuilt or
 * re-hung exactly as before.
 */
export function renderSettings() {
    if (!state.settings.open) return;
    const s = state.settings;

    // The project selector only means anything for the two project scopes, and
    // a disabled one beside "User" is a control that appears broken.
    dom.setProjectWrap.hidden = s.scope === 'user';
    dom.setScope.value = s.scope;
    paintSettingsNotes();
    paintSettingsProjects();
    paintSettingsFile();
    paintSettingsProblems();

    if (s.error) {
        paint(dom.setToc, null);
        paint(dom.setBody, html`<div key="error" class="settings-error">${
            `Could not read the settings: ${s.error}`}</div>`);
        return;
    }
    if (!s.data) {
        paint(dom.setToc, null);
        paint(dom.setBody, html`<div key="empty" class="settings-empty">Reading settings…</div>`);
        return;
    }

    // A heading in front of the first group of each category — SETTINGS keeps
    // a category's groups together, so the first of a run is the first of all.
    const body = [];
    let cat = null;
    for (const group of visibleSettings()) {
        if (group.category !== cat) {
            cat = group.category;
            const c = SETTINGS_CATEGORIES.find(x => x.key === cat);
            body.push(html`<h2 key=${`cat:${cat}`} class="settings-cat" id=${`set-c-${cat}`}
                >${c ? c.title : cat}</h2>`);
        }
        body.push(settingsGroup(group));
    }
    paint(dom.setBody, body);
    renderSettingsToc();
}

/** The groups this host has, in the order they are drawn. */
function visibleSettings() {
    return SETTINGS.filter(g => !g.when || g.when());
}

/**
 * Descriptions under each label, or behind an ⓘ beside it.
 *
 * Every row draws both (settingTip and settingDesc in general.js), and this
 * attribute is what settings.css reads to show one — so the hand-built groups
 * take part without a redraw of their own, and switching is instant. Kept in
 * localStorage beside the folds, because like them it is how this page is laid
 * out for you rather than how the app behaves: it has no business in a file a
 * project can check in.
 */
export function paintSettingsNotes() {
    dom.settings.dataset.notes = state.settings.notes;
    dom.setNotes.value = state.settings.notes;
}

export function setSettingsNotes(mode) {
    state.settings.notes = mode === 'inline' ? 'inline' : 'tips';
    try { localStorage.setItem('settingsNotes', state.settings.notes); } catch { /* per-session then */ }
    paintSettingsNotes();
    // The groups move under the pinned head when their height changes, so the
    // contents has to light whichever one is now at the top.
    markSettingsToc();
}

/** One entry of SETTINGS, as whatever kind of group it is. */
function settingsGroup(group) {
    // A group whose markup already exists is moved rather than rebuilt: its
    // controls were wired at load and would lose their listeners.
    if (group.node) {
        return html`<${Foreign} key=${group.section} nodes=${[dom[group.node]]} after=${group.after} />`;
    }
    // A group that builds itself with el(). One card or several — the contents
    // list still gets one entry, and the first card carries the id it scrolls to.
    if (group.render) {
        return html`<${Foreign} key=${group.section} nodes=${[...group.render()].filter(Boolean)} />`;
    }
    // A group that draws itself as a component.
    if (group.card) return group.card();
    return settingsCard(group);
}

/**
 * Hand-built DOM, hung in a Preact tree.
 *
 * Preact must not be given nodes it did not make as children, and must not
 * have its own nodes edited by hand — so the foreign nodes go inside a host
 * element Preact renders empty, and are put there by a layout effect, which
 * runs synchronously inside the render call. Anything that queries the panel
 * right after renderSettings() returns finds them in place, as it did when
 * renderSettings built everything itself. Preact never looks inside the host,
 * because as far as it knows the host has no children.
 *
 * `display: contents` takes the host out of the layout, so the cards inside it
 * are flex items of `.settings-body` exactly as before and its `gap` still
 * spaces them — no rule in styles.css had to change. Nothing there selects
 * `.settings-body > …`, which is the one thing the host would have broken.
 *
 * `after` runs once the nodes are in place, every render — the `node` groups'
 * painters, which fill their markup from state the way they always did.
 */
function Foreign({ nodes, after }) {
    const host = useRef(null);
    useLayoutEffect(() => {
        const box = host.current;
        const same = box.childNodes.length === nodes.length
            && nodes.every((n, i) => box.childNodes[i] === n);
        if (!same) box.replaceChildren(...nodes);
        if (after) after();
    });
    return html`<div class="settings-foreign" style="display: contents" ref=${host}></div>`;
}

/**
 * Contents down the left: each category, and its groups under it.
 *
 * Worth the space because the panel is seventeen groups and about sixty
 * controls, and the thing you came for is rarely the one on screen. Sticky
 * rather than scrolling with the body, for the same reason. The categories are
 * what make it scannable — a flat list that long is read, not glanced at.
 */
function renderSettingsToc() {
    // Which one is lit is measured off the cards just drawn, so it is worked
    // out before the list is, and the list drawn once.
    state.settings.toc = activeSettingsGroup();
    paintSettingsToc();
}

function paintSettingsToc() {
    const active = state.settings.toc;
    const groups = visibleSettings();
    const activeCat = (groups.find(g => g.section === active) || {}).category;
    const jump = (id) => {
        const node = document.getElementById(id);
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const items = [];
    for (const cat of SETTINGS_CATEGORIES) {
        const mine = groups.filter(g => g.category === cat.key);
        if (!mine.length) continue;
        items.push(html`<button key=${`cat:${cat.key}`} type="button"
            class=${cat.key === activeCat ? 'settings-toc-cat on' : 'settings-toc-cat'}
            onClick=${() => jump(`set-c-${cat.key}`)}>${cat.title}</button>`);
        for (const group of mine) {
            items.push(html`<button key=${group.section} type="button" data-for=${group.section}
                class=${group.section === active ? 'settings-toc-link on' : 'settings-toc-link'}
                onClick=${() => jump(`set-g-${group.section}`)}>${group.tocTitle || group.title}</button>`);
        }
    }
    paint(dom.setToc, items);
}

/**
 * Which group the reader is in.
 *
 * The topmost card whose head has not yet scrolled past the top of the
 * container wins, which is the reading that matches what a person would say
 * they are looking at — the alternative, "whichever card covers the most
 * pixels", flickers between two of them on a long group.
 */
function activeSettingsGroup() {
    // The foot of the pinned head, not the top of the pane: a card scrolled
    // under the head is out of sight, so it is not the one being read.
    const top = dom.setTop.getBoundingClientRect().bottom;
    let active = SETTINGS[0] && SETTINGS[0].section;
    for (const group of SETTINGS) {
        const card = document.getElementById(`set-g-${group.section}`);
        if (card && card.getBoundingClientRect().top - top <= 24) active = group.section;
    }
    return active;
}

/** On scroll: light the group being read, and redraw the list only if it moved. */
export function markSettingsToc() {
    if (!state.settings.open) return;
    const active = activeSettingsGroup();
    if (active === state.settings.toc) return;
    state.settings.toc = active;
    paintSettingsToc();
}

/**
 * The projects in the selector. The select itself is markup with its listener
 * in app.js — which puts its value back by hand when a draft refuses the change
 * — so only its options are drawn here.
 */
function paintSettingsProjects() {
    const s = state.settings;
    const here = settingsProject();
    // The open session's project first even when it is not in the list yet —
    // /api/projects only knows directories a session has run in, and a brand
    // new one has not been indexed.
    const dirs = [...new Set([here, ...s.projects.map(p => p.cwd)].filter(Boolean))];
    paint(dom.setProject, dirs.length
        ? dirs.map(d => html`<option key=${d} value=${d} selected=${d === here}>${shortPath(d)}</option>`)
        : html`<option key="" value="">No projects yet</option>`);
}

function paintSettingsFile() {
    const s = state.settings;
    const row = settingsTargetRow();
    const file = row ? row.file : '';
    if (!file) {
        paint(dom.setFile, html`<span class="settings-file-none"
            >No settings file for that scope — pick a project above.</span>`);
        return;
    }
    paint(dom.setFile, [
        html`<span key="lede" class="settings-file-lede">Writing to</span>`,
        html`<button key="path" class="settings-file-path" type="button" title="Copy this path"
            onClick=${() => navigator.clipboard.writeText(file)
                .then(() => toast('Path copied.'))
                .catch(() => toast('Could not copy that path.', 'error'))}>${file}</button>`,
        !row.exists ? html`<span key="new" class="settings-file-tag">will be created</span>` : null,
        row.exists && !row.parsed ? html`<span key="parse" class="settings-file-tag bad"
            >does not parse — saving is refused</span>` : null,
        !row.writable ? html`<span key="ro" class="settings-file-tag bad">not writable</span>` : null,
        s.saving ? html`<span key="saving" class="settings-file-tag">saving…</span>` : null,
    ]);
}

function paintSettingsProblems() {
    const files = (state.settings.data && state.settings.data.files) || [];
    const rows = [];
    for (const f of files) for (const m of f.problems || []) rows.push({ file: f.file, message: m });
    // The container's own `hidden` is markup's, not Preact's — only its
    // children are rendered — so it is set by hand as before.
    dom.setProblems.hidden = !rows.length;
    paint(dom.setProblems, rows.map((r, i) => html`<div key=${`${r.file}:${i}`} class="settings-problem">
        <code>${shortPath(r.file)}</code>${' '}${r.message}</div>`));
}
