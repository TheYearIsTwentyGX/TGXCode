// The SETTINGS table — one row per key in `~/.tgxcode/settings.json` — and the
// row builders that turn a row into a control.
//
// The builders return Preact vnodes, written the way web/rail.js settled (htm
// templates, keyed list children, no hand edits to a node Preact owns), and
// renderSettings draws them into the panel's body. Every control still saves on
// change and the redraw after the save is still what shows the stored answer;
// what changed is that the redraw is a diff, so a click, a focus or a
// half-typed number survives a save of some other key.
//
// **Two kinds of control.** A checkbox, a radio or a select is controlled —
// Preact compares `checked` and a select's `value` with the DOM, so the redraw
// after a refused save puts the old answer back. A box you type into (a number,
// a path, a weight) is uncontrolled, keyed on the stored value, because a
// controlled one would be reset under your hands by any unrelated redraw; see
// settingsRevert() for the cases where the key has to be moved by hand.
//
// Imports from app.js, which imports this — safe because nothing here reads an
// app.js binding while the module evaluates, only when a function is called.
// Keep it that way: a module-level `const` built from an app.js `const` throws,
// because every module under web/settings/ evaluates before app.js's body runs.

import { html, useState } from '../vendor/preact.js';
import { shortPath } from '../format.js';
import { state } from '../state.js';
import {
    paintBackdropTint, refreshPairUrl, renderProjectBackdrop, renderProjectColors,
    renderProjectOrder,
} from '../app.js';
import { renderSnipSettings } from '../snippets/settings.js';
import { renderWisprSettings, wisprAvailable } from '../composer/wispr.js';
import { renderClaudeConfig } from './claude-config.js';
import {
    renderSettings, saveSetting, saveSettings, SCOPE_NAMES, settingOrigin, settingsTargetRow,
} from './index.js';
import { foldLabelV, isOpen, LONG } from './fold.js';
import { renderClaudeDocs } from './memory.js';
import { notifyCard } from './notifications.js';
import { renderCmdConfig } from './project-commands.js';
import { renderKeymap } from './shortcuts.js';
import { renderToolbarSettings } from './toolbar.js';

// Here rather than beside paintRailSort() in app.js, which draws the rail head's
// menu from it, because SETTINGS below reads it while this module evaluates —
// and that is before app.js's body has run, so a `const` there is not yet set.
//
// The four ways `projects.sort` can order the project cards, in the menu's order.
export const RAIL_SORTS = [
    ['recent', 'Most recent — static', 'Newest first as of when the window opened, then held still'],
    ['dynamic', 'Most recent — dynamic', 'Newest first, and a project moves up when something happens in it'],
    ['alpha', 'Alphabetical', 'By project name'],
    ['custom', 'Custom', 'Drag a project’s heading to place it'],
];
const RAIL_SORT_OPTIONS = RAIL_SORTS.map(([v, label]) => [v, label]);

// The controls, in the order they are drawn. A key in bridge/prefs.js is one
// row here and nothing else — no per-setting function, no switch — which is the
// only way a settings page stays true as the file grows.
//
// `userOnly` mirrors USER_ONLY in bridge/prefs.js. It is drawn rather than
// hidden at a project scope, because a section that vanishes reads as a bug and
// a section that says why it is disabled teaches the rule.
// The four answers to "does the board stay up over this panel?", in the order
// the radios and the All views buttons draw them. See DEFAULTS.live in
// bridge/prefs.js for what each one means.
const LIVE_OVER_OPTIONS = [
    ['hidden', 'Hidden'], ['always', 'Always'], ['side', 'Side-by-Side'], ['stacked', 'Stacked'],
];
const LIVE_OVER_ROWS = [
    ['overTasks', 'Tasks'], ['overDashboard', 'Dashboard'], ['overHistory', 'History'],
    ['overDrafts', 'Drafts'], ['overSchedules', 'Schedules'], ['overSettings', 'Settings'],
].map(([key, label]) => ({ key, type: 'radio', label, options: LIVE_OVER_OPTIONS }));

// The headings the groups below are filed under — in the contents list, where
// each is a label over its groups, and in the body, where each is a heading
// between the cards. Seventeen groups in one flat list was a column of names to
// read down; six headings are something to scan.
//
// A group names its heading with `category`, and SETTINGS keeps each heading's
// groups together, because the body is drawn in SETTINGS order and a heading
// is drawn before the first group of each run. `tocTitle` is the shorter name a
// group takes in the contents, where its heading already says the rest.
export const SETTINGS_CATEGORIES = [
    { key: 'workspace', title: 'Workspace' },
    { key: 'input', title: 'Input' },
    { key: 'browsers', title: 'Browsers' },
    { key: 'claude', title: 'Claude Code' },
    { key: 'projects', title: 'Projects' },
    { key: 'connect', title: 'Connections' },
];

// Most groups are built from `rows`. The rest are not, and say how they are
// drawn instead: `render` (built by hand with el() — Claude Code, its Memory,
// Project commands, whose content only the bridge has), `node` (written out in
// web/index.html, because none is backed by the settings file — one is a store
// of its own, one is per-browser storage and the last is a task rather than a
// setting; renderSettings moves the markup into place, so it takes its turn in
// this order), or `card` (a Preact component of its own).
//
// `render` and `node` are handed to Preact as foreign DOM (see Foreign in
// index.js). `card` and `rows` groups are Preact all the way down.
export const SETTINGS = [
    {
        title: 'Reading', section: 'transcript', category: 'workspace',
        note: 'How a transcript folds the work between one message and the next, '
            + 'and how its clocks read.',
        rows: [
            { key: 'clock', type: 'choice',
                label: 'Clock',
                options: [
                    ['24h', '24-hour · 15:04'],
                    ['12h', '12-hour · 3:04 PM'],
                ],
                note: 'Every time the app shows, not only the transcript’s.' },
            { key: 'groupToolCalls', type: 'bool',
                label: 'Fold finished runs of tool calls',
                note: 'Once a message closes a run, it becomes one row you can open.' },
            { key: 'groupMinCalls', type: 'int', min: 2, max: 1000,
                label: 'Shortest run worth folding',
                note: 'One or two rows collapsed into a summary loses more than it saves.' },
            { key: 'groupIncludesThinking', type: 'bool',
                label: 'A thinking block is part of the run',
                note: 'Off breaks the run there instead, which fragments a turn that '
                    + 'thinks between every call.' },
        ],
    },
    {
        title: 'Live board', section: 'live', category: 'workspace',
        note: 'The board behind Live — every session running right now.',
        rows: [
            { key: 'compact', type: 'bool',
                label: 'Compact cards',
                note: 'Stop every card at its tool-count line: no preview, no message '
                    + 'box, no Open or Stop, no approval row. Many sessions at a glance '
                    + 'rather than any one of them actionable in place.' },
            { key: 'hideElsewhere', type: 'bool',
                label: 'Leave out sessions running elsewhere',
                note: 'Sessions under a terminal or another window — the cards this '
                    + 'board cannot drive. It says how many it left out.' },
            { key: 'order', type: 'radio',
                label: 'Order of the Live group',
                options: [['needs-you', 'Needs you first'], ['arrival', 'Order of arrival']],
                note: 'Order of arrival puts new work at the bottom and moves it up only '
                    + 'as the sessions above it finish, so nothing reorders while you read. '
                    + 'Pinned and Recent activity are unaffected.' },
            { type: 'heading', label: 'Live board visibility',
                note: 'Whether the board stays up, docked beside or under the screen, '
                    + 'while one of these is open. Side-by-Side and Stacked keep it '
                    + 'only while the board’s dock toggle says so; Hidden covers it, '
                    + 'as before.' },
            { type: 'all', label: 'All views', keys: LIVE_OVER_ROWS.map(r => r.key),
                options: LIVE_OVER_OPTIONS,
                note: 'Sets every screen below at once.' },
            ...LIVE_OVER_ROWS,
        ],
    },
    {
        title: 'Spinner', section: 'spinner', category: 'workspace',
        note: 'What a turn in progress calls itself while it works.',
        rows: [
            { key: 'randomize', type: 'bool',
                label: 'A themed verb in front of the work',
                note: 'Off gives back the literal “Thinking…”.' },
            { key: 'rerollMs', type: 'int', min: 0, max: 600000, step: 1000,
                label: 'Milliseconds a verb stands for',
                note: '0 pins one for the whole turn. Otherwise 1000 to 600000.' },
            { key: 'groups', type: 'groups', wide: true,
                label: 'Verb groups in play',
                note: 'From ~/.tgxcode/verbs/, and a project’s own. Enabling all of '
                    + 'them is a soup; the point of the groups is to choose a voice. '
                    + 'Hover a group to read what is in it. The number on a group '
                    + 'chosen is how often it gets to speak against the others — '
                    + 'leave it at 1 for an even split, or 0 to mute it without '
                    + 'giving it up.' },
        ],
    },
    {
        title: 'Quota', section: 'quota', category: 'workspace', userOnly: true,
        note: 'Keeping the percentages current with no terminal open, by starting a '
            + '`claude` for a few seconds and killing it.',
        rows: [
            { key: 'beacon', type: 'bool',
                label: 'Refresh quota in the background',
                note: 'Does nothing until a directory is named below.' },
            { key: 'beaconDir', type: 'path',
                label: 'Directory it runs in',
                note: 'Open Claude Code there yourself at least once first — the beacon '
                    + 'never answers the trust prompt, so an untrusted directory just '
                    + 'makes every run time out.' },
            { key: 'beaconEveryMinutes', type: 'int', min: 5, max: 1440,
                label: 'How often, in minutes',
                note: 'Each run is a CLI start and one tiny API call. Floor of five.' },
        ],
    },
    {
        title: 'Toolbar', section: 'toolbar', category: 'workspace', userOnly: true, toolbar: true,
        note: 'The buttons along the top: their order, which of them fold into the '
            + 'More menu, and which show their name beside the icon. A hidden view '
            + 'still opens from its shortcut.',
        rows: [],
    },
    {
        title: 'Keyboard', section: 'keyboard', category: 'input', userOnly: true, keymap: true,
        note: 'How a few keys behave, and then every shortcut this window '
            + 'answers to.',
        rows: [
            { key: 'contextualTerminalCopy', type: 'bool',
                label: 'Contextual Ctrl+C in the terminal',
                note: 'With a selection, Ctrl+C copies it and clears it — so a second '
                    + 'Ctrl+C still interrupts. With no selection it interrupts as '
                    + 'always. Turning this on also makes plain Ctrl+V paste, instead '
                    + 'of Ctrl+Shift+V. Only while the terminal has the focus.' },
            { key: 'composerSend', type: 'choice',
                label: 'Composer send',
                options: [
                    ['enter', 'Enter sends · Shift+Enter for a newline'],
                    ['ctrl-enter', 'Enter for a newline · Ctrl+Enter sends'],
                ],
                note: 'Ctrl+Enter sends either way.' },
            { key: 'cycleOrder', type: 'choice',
                label: 'Picker cycle order',
                options: [
                    ['default', 'As the dropdown lists them'],
                    ['alphabetical', 'Alphabetical'],
                ],
                note: 'The order Ctrl+P and Ctrl+M step through Permissions and Model, '
                    + 'and Shift walks it backwards. The dropdowns keep their own order.' },
        ],
    },
    {
        title: 'Snippets', section: 'snippets', category: 'input', node: 'setGSnippets',
        after: () => renderSnipSettings(),
    },
    // `when` leaves a group out, contents entry and all: on a host with no Wispr
    // Flow there is nothing for these to configure.
    {
        title: 'Wispr Flow', section: 'wispr', category: 'input', node: 'setGWispr',
        when: () => wisprAvailable,
        after: () => renderWisprSettings(),
    },
    {
        title: 'Browser preview', section: 'preview', category: 'browsers', userOnly: true,
        note: 'The page behind a port or a running task, shown in this window with '
            + 'DevBrowser’s toolbar.',
        rows: [
            { key: 'keepAliveMinutes', type: 'int', min: 0, max: 240,
                label: 'Minutes to keep a page you left',
                note: 'Come back inside this and the page is as you left it — scroll, '
                    + 'form state, the dev server’s live reload still connected. After '
                    + 'it the page is thrown away and loads fresh. 0 throws it away as '
                    + 'soon as you leave.' },
            { key: 'overLive', type: 'bool',
                label: 'Open over the Live board',
                note: 'A port clicked on a Live card covers the board, and Home brings '
                    + 'it back. Off opens that card’s session and previews over it, '
                    + 'with the board still docked beside it.' },
            { key: 'links', type: 'bool',
                label: 'Open links from chat in the preview',
                note: 'A link in a message opens here instead of in your browser. '
                    + 'Ctrl-, Shift- or middle-click still sends it to the browser. '
                    + 'A site other than a local port needs the desktop app, and a '
                    + 'link it leads to on another site still leaves for the browser.' },
            { key: 'listMode', type: 'radio',
                when: (p) => p.preview && p.preview.links === true,
                label: 'Which links',
                options: [['block', 'All but the list'], ['allow', 'Only the list']],
                note: 'The list below is a blocklist or an allowlist. An empty '
                    + 'allowlist previews nothing.' },
            { key: 'list', type: 'list', wide: true,
                when: (p) => p.preview && p.preview.links === true,
                label: 'Domains and URLs',
                placeholder: 'github.com\n*.internal.example\nlocalhost:5173/admin',
                note: 'One per line. example.com is that site and its subdomains, '
                    + '*.example.com subdomains only, and anything with a / is a URL '
                    + 'prefix. Lines starting with # are ignored. Saved when you '
                    + 'leave the box.' },
        ],
    },
    {
        title: 'DevBrowser', section: 'devbrowser', category: 'browsers', userOnly: true,
        note: 'The separate browser app on this machine that shows one tab per port.',
        rows: [
            { key: 'show', type: 'bool',
                label: 'Show DevBrowser in this app',
                note: 'The status pill, “Open in DevBrowser” on a preview, and the '
                    + 'DevBrowser tab field on a project command. Off, every port opens '
                    + 'in the preview here. A task still names its port in DevBrowser '
                    + 'when it comes up; with DevBrowser not running that does nothing.' },
            { key: 'openIn', type: 'choice',
                when: (p) => p.devbrowser && p.devbrowser.show !== false,
                label: 'Open previews in',
                options: [['devbrowser', 'DevBrowser'], ['inline', 'This window']],
                note: 'Where clicking a port or a running task shows its page.' },
            { key: 'whenClosed', type: 'choice',
                when: (p) => p.devbrowser && p.devbrowser.show !== false
                    && p.devbrowser.openIn === 'devbrowser',
                label: 'When DevBrowser is not running',
                options: [['launch', 'Start it'], ['inline', 'Preview here instead'],
                    ['nothing', 'Do nothing']],
                note: 'Starting it opens a window; “do nothing” only says it is closed.' },
        ],
    },
    // Claude Code's own settings — a different owner's files, and the one group
    // built by a `render` rather than from `rows` or from markup. It has to be:
    // what it draws comes from the bridge at load time rather than from a table
    // here, because the whole point is that a key this app has never heard of
    // still gets a control. See renderClaudeConfig().
    {
        title: 'Claude Code', section: 'claude', category: 'claude', tocTitle: 'Settings',
        render: () => renderClaudeConfig(),
    },
    // The same owner's other files, and a `render` for the same reason: what it
    // draws is a document that only the bridge has. Directly under the group
    // above rather than a tab inside it, because those are settings with a
    // precedence chain and these are instructions that add up — one control
    // cannot mean both things. See renderClaudeDocs().
    {
        title: 'Claude Code · Memory', section: 'memory', category: 'claude', tocTitle: 'Memory',
        render: () => renderClaudeDocs(),
    },
    {
        title: 'Projects', section: 'projects', category: 'projects', node: 'setGProjects',
        userOnly: true,
        // The rail's project order, drawn above the colours — see
        // renderProjectOrder(). Separate from `rows` because some of these are
        // only live in one mode, which the plain row list has no way to say.
        orderRows: [
            { key: 'sort', type: 'choice',
                label: 'Project order in the rail',
                options: RAIL_SORT_OPTIONS,
                note: 'Static keeps the order the window opened with. Dynamic starts '
                    + 'the same and moves a project to the top when one of the events '
                    + 'below happens in it. Custom is yours: drag a project’s heading '
                    + 'in the rail, or use Move in its ⋮ menu.' },
            { key: 'bumpOnCreate', type: 'bool', mode: 'dynamic',
                label: 'Move up when a session starts',
                note: 'A new session in the project.' },
            { key: 'bumpOnUser', type: 'bool', mode: 'dynamic',
                label: 'Move up on a message from you',
                note: 'Anything you send in any of its sessions.' },
            { key: 'bumpOnAny', type: 'bool', mode: 'dynamic',
                label: 'Move up on any message',
                note: 'Every line any session in the project writes, Claude’s included. '
                    + 'Expect the rail to jump around a lot while agents are working.' },
            { key: 'bumpOnTurn', type: 'bool', mode: 'dynamic',
                label: 'Move up when an agent finishes',
                note: 'A turn completing in any of its sessions.' },
            { key: 'bumpOnPr', type: 'bool', mode: 'dynamic',
                label: 'Move up when a pull request changes',
                note: 'A review, a build, a merge — anything that changes a PR’s state '
                    + 'in the rail.' },
            { key: 'newAt', type: 'choice', mode: 'custom',
                label: 'Where new projects go',
                options: [['top', 'Top'], ['bottom', 'Bottom']],
                note: 'A project you have not placed yet. It keeps that place once '
                    + 'you drag anything.' },
        ],
        // Ordinary rows, drawn into the markup group because the group is not
        // built from `rows` — see renderProjectBackdrop().
        rows: [
            { key: 'backdropTint', type: 'bool',
                label: 'Tint the backdrop behind a dialog',
                note: 'Start a session and a schedule wash the screen behind them in '
                    + 'the project’s colour. Off gives the plain dim every other dialog '
                    + 'has; the dialog’s own head keeps its colour either way.' },
            { key: 'backdropStrength', type: 'range', min: 0, max: 40, unit: '%',
                label: 'Backdrop tint strength',
                note: 'How much of the colour goes into the dim.',
                preview: (n) => paintBackdropTint(n) },
        ],
        after: () => { renderProjectOrder(); renderProjectBackdrop(); renderProjectColors(); },
    },
    // The commands this project declares, which are the buttons in the
    // conversation header. A `render` for the same reason Claude Code's two use
    // one — what it draws is a pair of files only the bridge has read — and
    // filed with Projects, because it is about a project rather than this window.
    {
        title: 'Project commands', section: 'commands', category: 'projects', tocTitle: 'Commands',
        render: () => renderCmdConfig(),
    },
    {
        title: 'Notifications', section: 'notify', category: 'connect', card: () => notifyCard(),
    },
    {
        title: 'Connect a phone', section: 'pair', category: 'connect', node: 'setGPair',
        after: () => refreshPairUrl(),
    },
];

/**
 * One control, with the two sentences that make it honest: whether this scope
 * set the value, and whether something stronger has taken it over.
 *
 * The label reads down the left and the control sits at the right edge, with
 * the "Clear" or "default" line under it — so the controls form one column the
 * eye can run down, and the column does not move with the length of a label.
 *
 * A row marked `wide` breaks that shape on purpose: the spinner groups are a
 * hundred-odd checkboxes and no right-hand column is the right width for them,
 * so the text and the Clear go across the top and the control gets the full
 * width underneath.
 *
 * A vnode keyed by the row's key, since every caller puts it in a list — the
 * Projects group draws its rows with this too, into containers of its own
 * (renderProjectOrder in app.js).
 */
export function settingRow(group, row, locked) {
    const s = state.settings;
    const section = group.section;
    const target = settingsTargetRow();
    const explicit = !!(target && target.values && target.values[section]
        && target.values[section][row.key] !== undefined);
    const effective = s.data[section] ? s.data[section][row.key] : undefined;
    const value = explicit ? target.values[section][row.key] : effective;

    const origin = settingOrigin(section, row.key);
    // "Stronger" means later in the chain, and the chain is the array order.
    const files = s.data.files || [];
    const overridden = !!(origin && target && origin.file !== target.file
        && files.indexOf(origin) > files.indexOf(target));

    const disabled = locked || !target || (target.exists && !target.parsed) || !target.writable;
    const save = (v) => saveSetting(section, row.key, v);
    // One control writes two keys: the spinner groups carry a weight each, and
    // `spinner.weights` is a key of its own rather than something folded into
    // the list. Nothing else needs this, which is why it is an extra argument
    // and not a change to what `save` means.
    const saveKey = (key, v) => saveSetting(section, key, v);

    // A wide row folds — the verb groups are a hundred-odd pills. See fold.js.
    const fold = row.wide ? settingFoldSummary(row, value) : null;
    const foldKey = `general:${section}.${row.key}`;
    const open = !fold || isOpen(foldKey, fold.long);

    const text = html`<div class="settings-row-text">
        <div class="settings-row-label">${fold ? foldLabelV(foldKey, open, row.label) : row.label}${
            settingTip(row.note)}</div>
        ${!open ? html`<div class="set-fold-sum">${fold.text}</div>` : null}
        ${open ? settingDesc(row.note) : null}
        ${overridden ? html`<div class="settings-row-warn">${
            `Overridden by ${SCOPE_NAMES[origin.scope]} — `}<code>${shortPath(origin.file)}</code>${
            ' wins, so this has no effect here.'}</div>` : null}
    </div>`;

    // `is-origin` is what settings.css keeps out of sight until the row is
    // hovered or focused: at User scope nearly every row says Clear, and forty
    // of them down the right edge were most of the noise on the page.
    const side = html`<div class="settings-row-side is-origin">${explicit
        ? html`<button class="linkish" type="button" disabled=${disabled}
            title="Remove this key so the value falls back"
            onClick=${() => save(null)}>Clear</button>`
        : html`<span class="settings-row-from">${
            origin ? `from ${SCOPE_NAMES[origin.scope]}` : 'default'}</span>`}</div>`;

    if (row.wide) {
        return html`<div key=${row.key} class=${open ? 'settings-row is-wide' : 'settings-row is-wide is-folded'}>
            <div class="settings-row-head">${text}${side}</div>
            ${open ? html`<div class="settings-row-wide">${
                settingControl(row, value, disabled, save, saveKey)}</div>` : null}
        </div>`;
    }
    const control = settingControl(row, value, disabled, save, saveKey);
    return html`<div key=${row.key} class="settings-row">
        ${text}
        <div class="settings-row-ctl">${control}${side}</div>
    </div>`;
}

/** What a folded wide row says in place of its control. Only the verb groups are wide. */
function settingFoldSummary(row, value) {
    if (row.type !== 'groups') return null;
    const cat = state.settings.spinner;
    const total = cat && cat.groups ? cat.groups.length : 0;
    const on = Array.isArray(value) ? value.length : 0;
    return { long: total > LONG, text: `${on} of ${total} chosen` };
}

/**
 * A row's description, as the ⓘ beside its label and as the line under it.
 *
 * Both are always drawn, and the Descriptions picker in the panel's head says
 * which one shows — by `data-notes` on #settings, read by settings.css — so
 * switching is a class flip rather than a redraw, and the groups built by hand
 * (web/index.html, notifications.js) take part by carrying the same two classes
 * without knowing about the picker at all. See paintSettingsNotes() in index.js.
 *
 * The tip is CSS off `data-tip` rather than a `title`: a native tooltip takes a
 * second to appear and never appears for the keyboard, and this one does both.
 */
export function settingTip(note) {
    return note ? html`<button class="set-tip" type="button" aria-label=${note} data-tip=${note}></button>` : null;
}

export function settingDesc(note) {
    return note ? html`<div class="settings-row-note settings-desc">${note}</div>` : null;
}

/** A title partway down a group, for a run of rows that belong together. */
export function settingHeading(row) {
    return html`<div key=${`heading:${row.label}`} class="settings-subhead">
        <h3 class="settings-subhead-title">${row.label}${settingTip(row.note)}</h3>
        ${row.note ? html`<p class="settings-group-note settings-desc">${row.note}</p>` : null}
    </div>`;
}

/**
 * Buttons that set several rows to one value — not a setting of its own, so
 * nothing is stored for it. A button reads as pressed when every row it covers
 * already says its value, which is the only honest thing it can claim.
 */
export function settingAllRow(group, row, locked) {
    const target = settingsTargetRow();
    const disabled = locked || !target || (target.exists && !target.parsed) || !target.writable
        || state.settings.saving;
    const values = row.keys.map((key) => {
        const own = target && target.values && target.values[group.section];
        if (own && own[key] !== undefined) return own[key];
        return state.settings.data[group.section] ? state.settings.data[group.section][key] : undefined;
    });
    return html`<div key=${`all:${row.label}`} class="settings-row">
        <div class="settings-row-text">
            <div class="settings-row-label">${row.label}${settingTip(row.note)}</div>
            ${settingDesc(row.note)}
        </div>
        <div class="settings-row-ctl">
            <div class="seg" role="group" aria-label=${row.label}>
                ${row.options.map(([v, text]) => html`<button key=${v} class="seg-btn" type="button"
                    disabled=${disabled} aria-pressed=${String(values.every(x => x === v))}
                    onClick=${() => saveSettings(group.section,
                        Object.fromEntries(row.keys.map(k => [k, v])))}>${text}</button>`)}
            </div>
        </div>
    </div>`;
}

/**
 * One group that is built from `rows`, as a card. The groups with a `render`
 * or a `node` are put in place by renderSettings instead.
 */
export function settingsCard(group) {
    const s = state.settings;
    const locked = group.userOnly && s.scope !== 'user';
    // A row's own `when` leaves it out while another setting makes it
    // meaningless, and is asked of the merged answer rather than of the
    // file being edited — a choice nothing would consult is not worth a row.
    // renderSettings runs again after every save, which is what brings it
    // back the moment the setting it depends on changes.
    const rows = group.rows.filter(row => !row.when || row.when(s.data)).map(row =>
        (row.type === 'heading' ? settingHeading(row)
            : row.type === 'all' ? settingAllRow(group, row, locked)
                : settingRow(group, row, locked)));
    return html`<section key=${group.section} class="settings-group"
        id=${`set-g-${group.section}`} data-locked=${locked ? '' : undefined}>
        <h2 class="settings-group-title">${group.title}</h2>
        ${group.note ? html`<p class="settings-group-note">${group.note}</p>` : null}
        ${locked ? html`<p class="settings-locked">${'Set for you alone, in '}<code>~/.tgxcode/settings.json</code>${
            ' — a checked-in file cannot change these. '}<button class="linkish" type="button"
            onClick=${() => { s.scope = 'user'; renderSettings(); }}>Switch to User</button></p>` : null}
        ${rows}
        ${group.keymap ? renderKeymap(locked) : null}
        ${group.toolbar ? renderToolbarSettings(locked) : null}
    </section>`;
}

/**
 * Remount every typed-into box from what is stored.
 *
 * Those boxes are uncontrolled (`defaultValue`) so that an unrelated redraw —
 * renderSettings runs twice for every save, and again whenever one of the
 * editor groups finishes loading — cannot put the stored value back over what
 * somebody is typing. They are keyed on the stored value, so a save that moves
 * it remounts them with the new one; this is for the saves that did not move
 * it: refused, dropped because another was running, or a number that was not
 * one. The snippet editor's `revs` is the same idea (web/snippets/settings.js).
 */
export function settingsRevert() {
    state.settings.rev++;
    renderSettings();
}

/** The input itself, by type. Each one saves on change; none of them is a draft. */
function settingControl(row, value, disabled, save, saveKey) {
    const rev = state.settings.rev;
    if (row.type === 'bool') {
        // Controlled: Preact compares `checked` with the DOM rather than with
        // its last render, so the redraw after a refused save puts it back.
        return html`<label class="settings-check">
            <input type="checkbox" checked=${value === true} disabled=${disabled}
                onChange=${(e) => save(e.target.checked)} />
            <span class="settings-box"></span>
        </label>`;
    }
    if (row.type === 'int') {
        return html`<input key=${`int:${rev}:${value ?? ''}`} class="settings-num" type="number"
            defaultValue=${value ?? ''} min=${row.min} max=${row.max} step=${row.step || 1}
            disabled=${disabled}
            onChange=${(e) => {
                const n = Number(e.target.value);
                if (!Number.isInteger(n)) { settingsRevert(); return; }
                save(n);
            }} />`;
    }
    if (row.type === 'path') {
        // A path is the one field somebody types rather than picks, so it
        // commits on blur or Enter instead of per keystroke.
        return html`<input key=${`path:${rev}:${value || ''}`} class="settings-text" type="text"
            spellcheck=${false} defaultValue=${value || ''} disabled=${disabled}
            placeholder="not set"
            onChange=${(e) => save(e.target.value.trim() || null)} />`;
    }
    if (row.type === 'choice') {
        // `value` on the select rather than `selected` on an option: Preact
        // compares a select's value with the DOM, but an option's `selected`
        // only with its last render, which would leave a refused choice showing.
        // A value no option has falls to the first, as the browser would.
        const known = row.options.some(([v]) => v === value);
        return html`<select class="settings-select" disabled=${disabled}
            value=${known ? value : row.options[0][0]}
            onChange=${(e) => save(e.target.value)}>
            ${row.options.map(([v, text]) => html`<option key=${v} value=${v}>${text}</option>`)}
        </select>`;
    }
    if (row.type === 'radio') {
        return html`<div class="settings-radios" role="radiogroup" aria-label=${row.label}>
            ${row.options.map(([v, text]) => html`<label key=${v} class="settings-radio">
                <input type="radio" name=${`set-${row.key}`} value=${v}
                    checked=${v === value} disabled=${disabled}
                    onChange=${() => save(v)} />
                <span>${text}</span>
            </label>`)}
        </div>`;
    }
    if (row.type === 'range') {
        return html`<${SettingRange} key=${`range:${rev}:${value ?? ''}`}
            row=${row} value=${value} disabled=${disabled} save=${save} />`;
    }
    if (row.type === 'list') {
        // One entry per line, committed on blur like a path. An empty box is
        // the default rather than an empty list written into the file.
        const text = Array.isArray(value) ? value.join('\n') : '';
        return html`<textarea key=${`list:${rev}:${text}`} class="settings-text settings-list"
            spellcheck=${false} rows=${Math.min(12, Math.max(4, text.split('\n').length + 1))}
            defaultValue=${text} disabled=${disabled} placeholder=${row.placeholder || ''}
            onChange=${(e) => {
                const lines = e.target.value.split('\n').map(l => l.trim()).filter(Boolean);
                save(lines.length ? lines : null);
            }}></textarea>`;
    }
    if (row.type === 'groups') return settingGroups(value, disabled, save, saveKey);
    return html`<span>${String(value)}</span>`;
}

/**
 * A slider and the number beside it.
 *
 * Dragging shows the number and, where the row has one, what it does — but
 * saves only on release, so a drag across the track is one write and not
 * forty. The number shown mid-drag is this component's own; the key its caller
 * gives it puts it back to the stored value whenever that moves.
 */
function SettingRange({ row, value, disabled, save }) {
    const [live, setLive] = useState(null);
    const shown = live ?? value ?? row.min;
    return html`<label class="settings-range">
        <input type="range" min=${row.min} max=${row.max} step=${row.step || 1}
            defaultValue=${value ?? row.min} disabled=${disabled} aria-label=${row.label}
            onInput=${(e) => {
                setLive(e.target.value);
                if (row.preview) row.preview(Number(e.target.value));
            }}
            onChange=${(e) => save(Number(e.target.value))} />
        <output>${`${shown}${row.unit || ''}`}</output>
    </label>`;
}

/**
 * Everything in a verb group, as a tooltip.
 *
 * A group name is a theme and not a description — "Absurd / Nonsense" and
 * "Kaomoji" tell you nothing about what a turn will actually call itself — so
 * the whole list goes in, alphabetised by the bridge. Wrapped to a readable
 * width because a native tooltip does not wrap on its own, and 185 verbs on one
 * line is a tooltip wider than the screen.
 */
function verbTooltip(group) {
    const verbs = Array.isArray(group.verbs) ? group.verbs : [];
    if (!verbs.length) return group.name;
    const lines = [];
    let line = '';
    for (const verb of verbs) {
        const next = line ? `${line} · ${verb}` : verb;
        if (next.length > 72) { lines.push(line); line = verb; } else { line = next; }
    }
    if (line) lines.push(line);
    return `${group.name} — ${verbs.length} verb${verbs.length === 1 ? '' : 's'}\n${lines.join('\n')}`;
}

/**
 * A group's share of the draws, as something short enough for a pill.
 *
 * The bridge sends the number because the bridge is where the draw happens —
 * see the note on `GET /api/spinner/groups`. Rounding rather than a decimal:
 * this is next to a name in a wrapped pill, and the question it answers is
 * "which of these am I actually going to hear from", not "to what precision".
 */
function shareLabel(share) {
    if (share === null || share === undefined) return '';
    if (share === 0) return 'muted';
    const pct = Math.round(share * 100);
    return pct < 1 ? '<1%' : `${pct}%`;
}

/**
 * The spinner groups, as checkboxes over what the directory actually holds,
 * each chosen one carrying how often it gets to speak.
 *
 * `GET /api/spinner/groups` exists because there was no settings page and the
 * only other answer to "what may I put in that list?" was to go and read a
 * directory. Now that there is one, this is where that route pays for itself.
 *
 * **Only a chosen group gets a weight box.** There are a hundred-odd pills here
 * and a number on every one of them would be a wall; a weight also means
 * nothing until the group is in play. So the unchecked pills are exactly what
 * they were, and the dozen you picked grow a box and a percentage — which is
 * the number worth showing, since a weight on its own says nothing without the
 * others to read it against.
 *
 * **The chosen ones come first, and then the order stops moving.** Alphabetical
 * over a hundred and fifteen pills buries the dozen that are actually in play
 * somewhere in the middle of the wall, and those are the ones you came here to
 * read. But sorting on every render would make the list move under the cursor:
 * tick a group and it leaps to the top, drawing your next click onto whatever
 * slid into its place. So the order is settled once — on opening the panel, on
 * changing project or scope — and held in `state.settings.groupOrder` for as
 * long as you are working in it. A group ticked now goes to the top the next
 * time you come in, which is soon enough.
 *
 * Each pill is keyed by its group's name, so a tick keeps the pill — and its
 * focus — rather than drawing a new one in its place.
 */
function settingGroups(value, disabled, save, saveKey) {
    const cat = state.settings.spinner;
    const enabled = new Set(Array.isArray(value) ? value : []);
    if (!cat || !cat.groups || !cat.groups.length) {
        return html`<div class="settings-groups-none">No verb groups found for this directory.</div>`;
    }
    const weights = (cat && cat.weights) || {};
    const st = state.settings;
    if (!st.groupOrder) {
        // A stable partition: the route hands these over alphabetically, so
        // each half keeps that order and only the split is new.
        st.groupOrder = [
            ...cat.groups.filter(g => enabled.has(g.name)),
            ...cat.groups.filter(g => !enabled.has(g.name)),
        ].map(g => g.name);
    }
    // Drawn in the pinned order, with anything the order has not heard of on
    // the end — a group that appeared in the directory since it was fixed.
    const rank = new Map(st.groupOrder.map((name, i) => [name, i]));
    const ordered = [...cat.groups].sort((a, b) =>
        (rank.has(a.name) ? rank.get(a.name) : rank.size) - (rank.has(b.name) ? rank.get(b.name) : rank.size));
    const toggle = (name, on) => {
        const next = new Set(enabled);
        if (on) next.add(name); else next.delete(name);
        save([...next]);
    };
    // A map goes over whole — `spinner.weights` is replaced by a save, not
    // merged into, the same as `keyboard.bindings`. Unchecking a group leaves
    // its number alone on purpose: the checkbox is how a group is turned off,
    // and losing what you had set would make it destructive.
    const weigh = (name, raw) => {
        const next = { ...weights };
        const n = Number(raw);
        if (raw === '' || !Number.isFinite(n) || n === 1) delete next[name];
        else next[name] = Math.min(1000, Math.max(0, n));
        // An empty map is the same answer as no key, and no key is the tidier
        // file — the same reason a save drops an emptied section.
        saveKey('weights', Object.keys(next).length ? next : null);
    };
    const weighed = cat.groups.some(g => enabled.has(g.name) && g.weight !== 1 && g.weight !== null);
    const rev = st.rev;

    // The weight box commits on blur or Enter rather than per keystroke, like
    // the path field: typing "12" through "1" would otherwise save a weight of
    // 1 on the way past and re-render under your hands.
    const pick = (g) => {
        const on = enabled.has(g.name);
        const weight = g.weight === null || g.weight === undefined ? '' : `${g.weight}`;
        return html`<div key=${g.name} class="settings-group-pick" title=${verbTooltip(g)}>
            <label class="settings-group-toggle">
                <input type="checkbox" checked=${on} disabled=${disabled}
                    onChange=${(e) => toggle(g.name, e.target.checked)} />
                <span class="settings-box"></span>
                <span class="settings-group-name">${g.name}</span>
                <span class="settings-group-count">${`${g.count}`}</span>
            </label>
            ${on ? html`<input key=${`w:${rev}:${weight}`} class="settings-group-weight"
                type="number" min="0" max="1000" step="any" defaultValue=${weight}
                disabled=${disabled} title="How often this group speaks, against the others"
                onChange=${(e) => weigh(g.name, e.target.value.trim())} />` : null}
            ${on ? html`<span class=${`settings-group-share${g.share ? '' : ' is-muted'}`}
                >${shareLabel(g.share)}</span>` : null}
        </div>`;
    };

    // The foot says what the spinner will actually draw from, which is not the
    // same as what is enabled when a name matches no file — or when a group is
    // enabled and weighed 0. The row's own Clear covers `groups`; without Even
    // them out there is no way to put every weight back to 1 from the page.
    return html`<div class="settings-groups">
        ${ordered.map(pick)}
        <div key="foot" class="settings-groups-foot">${
            `${cat.pool} verb${cat.pool === 1 ? '' : 's'} in the pool.`}${
            weighed ? ' ' : null}${
            weighed ? html`<button class="linkish" type="button" disabled=${disabled}
                title="Put every group back to an even share"
                onClick=${() => saveKey('weights', null)}>Even them out</button>` : null}</div>
    </div>`;
}
