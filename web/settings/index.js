// The Settings panel: opening and closing it, loading what it shows, saving one
// key at a time, and drawing the head, the table of contents and the groups.
// The controls themselves are in general.js, and each of the other files here
// is one group with an editor of its own. Moved out of app.js as it was.
//
// Imports from app.js, which imports this — safe because nothing here reads an
// app.js binding while the module evaluates, only when a function is called.
// Keep it that way: a module-level `const` built from an app.js `const` throws,
// because every module under web/settings/ evaluates before app.js's body runs.

import { get, put } from '../api.js';
import { BOOT_PREFS, PREFS_FALLBACK } from '../boot.js';
import { renderChannels } from '../channels.js';
import { dom, el, toast } from '../dom.js';
import { noteHome, shortPath } from '../format.js';
import * as keys from '../keys.js';
import { state } from '../state.js';
import {
    closeOtherPanels, liveVisible, loadPairing, paintBackdropTint,
    paintComposerHint, paintDevBrowserPresence, paintPanels, paintRailSort, rememberView,
    renderLive, renderRail, syncBoardWatch, syncTaskboardWatch, termPane,
} from '../app.js';
import { openSession } from '../transcript/conversation.js';
import { loadClaudeConfig } from './claude-config.js';
import { settingAllRow, settingHeading, settingRow, SETTINGS } from './general.js';
import { loadClaudeDocs } from './memory.js';
import { loadCmdConfig } from './project-commands.js';
import { paintShortcutHints, renderKeymap } from './shortcuts.js';
import { paintToolbar, renderToolbarSettings } from './toolbar.js';

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
    if (s.saving) return;
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

export function renderSettings() {
    if (!state.settings.open) return;
    const s = state.settings;

    // The project selector only means anything for the two project scopes, and
    // a disabled one beside "User" is a control that appears broken.
    dom.setProjectWrap.hidden = s.scope === 'user';
    dom.setScope.value = s.scope;
    paintSettingsProjects();
    paintSettingsFile();
    paintSettingsProblems();

    dom.setBody.replaceChildren();
    if (s.error) {
        dom.setToc.replaceChildren();
        dom.setBody.append(el('div', { class: 'settings-error' },
            `Could not read the settings: ${s.error}`));
        return;
    }
    if (!s.data) {
        dom.setToc.replaceChildren();
        dom.setBody.append(el('div', { class: 'settings-empty', text: 'Reading settings…' }));
        return;
    }

    for (const group of SETTINGS) {
        if (group.when && !group.when()) continue;
        // A group whose markup already exists is moved rather than rebuilt: its
        // controls were wired at load and would lose their listeners to a
        // replaceChildren. Detaching and re-appending keeps them.
        if (group.node) {
            dom.setBody.append(dom[group.node]);
            if (group.after) group.after();
            continue;
        }
        // A group that builds itself. One card or several — the contents list
        // still gets one entry, and the first card carries the id it scrolls to.
        if (group.render) {
            dom.setBody.append(...group.render());
            continue;
        }
        const locked = group.userOnly && s.scope !== 'user';
        const card = el('section', {
            class: 'settings-group', id: `set-g-${group.section}`,
            'data-locked': locked || null,
        },
            el('h2', { class: 'settings-group-title', text: group.title }),
            group.note ? el('p', { class: 'settings-group-note', text: group.note }) : null,
            locked ? el('p', { class: 'settings-locked' },
                'Set for you alone, in ', el('code', { text: '~/.tgxcode/settings.json' }),
                ' — a checked-in file cannot change these. ',
                el('button', {
                    class: 'linkish', type: 'button',
                    onclick: () => { s.scope = 'user'; renderSettings(); },
                }, 'Switch to User')) : null);

        // A row's own `when` leaves it out while another setting makes it
        // meaningless, and is asked of the merged answer rather than of the
        // file being edited — a choice nothing would consult is not worth a row.
        // renderSettings runs again after every save, which is what brings it
        // back the moment the setting it depends on changes.
        for (const row of group.rows) {
            if (row.when && !row.when(s.data)) continue;
            card.append(row.type === 'heading' ? settingHeading(row)
                : row.type === 'all' ? settingAllRow(group, row, locked)
                : settingRow(group, row, locked));
        }
        if (group.keymap) card.append(renderKeymap(locked));
        if (group.toolbar) card.append(renderToolbarSettings(locked));
        dom.setBody.append(card);
    }
    renderSettingsToc();
}

/**
 * Contents down the left, one entry per group.
 *
 * Worth the space because the panel is five groups and about forty controls,
 * and the thing you came for is rarely the one on screen. Sticky rather than
 * scrolling with the body, for the same reason.
 */
function renderSettingsToc() {
    dom.setToc.replaceChildren(...SETTINGS.filter(g => !g.when || g.when()).map(group => el('button', {
        class: 'settings-toc-link', type: 'button', 'data-for': group.section,
        onclick: () => {
            const card = document.getElementById(`set-g-${group.section}`);
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
    }, group.title)));
    markSettingsToc();
}

/**
 * Which group the reader is in.
 *
 * The topmost card whose head has not yet scrolled past the top of the
 * container wins, which is the reading that matches what a person would say
 * they are looking at — the alternative, "whichever card covers the most
 * pixels", flickers between two of them on a long group.
 */
export function markSettingsToc() {
    if (!state.settings.open) return;
    // The foot of the pinned head, not the top of the pane: a card scrolled
    // under the head is out of sight, so it is not the one being read.
    const top = dom.setTop.getBoundingClientRect().bottom;
    let active = SETTINGS[0] && SETTINGS[0].section;
    for (const group of SETTINGS) {
        const card = document.getElementById(`set-g-${group.section}`);
        if (card && card.getBoundingClientRect().top - top <= 24) active = group.section;
    }
    for (const link of dom.setToc.children) {
        link.classList.toggle('on', link.dataset.for === active);
    }
}

function paintSettingsProjects() {
    const s = state.settings;
    const here = settingsProject();
    // The open session's project first even when it is not in the list yet —
    // /api/projects only knows directories a session has run in, and a brand
    // new one has not been indexed.
    const dirs = [...new Set([here, ...s.projects.map(p => p.cwd)].filter(Boolean))];
    dom.setProject.replaceChildren(...dirs.map(d => el('option', {
        value: d, selected: d === here || null,
    }, shortPath(d))));
    if (!dirs.length) {
        dom.setProject.replaceChildren(el('option', { value: '', text: 'No projects yet' }));
    }
}

function paintSettingsFile() {
    const s = state.settings;
    const row = settingsTargetRow();
    const file = row ? row.file : '';
    dom.setFile.replaceChildren();
    if (!file) {
        dom.setFile.append(el('span', { class: 'settings-file-none' },
            'No settings file for that scope — pick a project above.'));
        return;
    }
    // Filtered, because `append` stringifies a null into the literal word
    // rather than skipping it the way el()'s children do.
    dom.setFile.append(...[
        el('span', { class: 'settings-file-lede', text: 'Writing to' }),
        el('button', {
            class: 'settings-file-path', type: 'button', title: 'Copy this path',
            onclick: () => navigator.clipboard.writeText(file)
                .then(() => toast('Path copied.'))
                .catch(() => toast('Could not copy that path.', 'error')),
        }, file),
        !row.exists && el('span', { class: 'settings-file-tag', text: 'will be created' }),
        row.exists && !row.parsed
            && el('span', { class: 'settings-file-tag bad', text: 'does not parse — saving is refused' }),
        !row.writable && el('span', { class: 'settings-file-tag bad', text: 'not writable' }),
        s.saving && el('span', { class: 'settings-file-tag', text: 'saving…' }),
    ].filter(Boolean));
}

function paintSettingsProblems() {
    const files = (state.settings.data && state.settings.data.files) || [];
    const rows = [];
    for (const f of files) for (const m of f.problems || []) rows.push({ file: f.file, message: m });
    dom.setProblems.hidden = !rows.length;
    dom.setProblems.replaceChildren(...rows.map(r => el('div', { class: 'settings-problem' },
        el('code', { text: shortPath(r.file) }), ' ', r.message)));
}
