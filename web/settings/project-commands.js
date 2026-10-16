// The Commands group: the `.tgxcode/commands.json` a project declares, as a
// form and as JSON. Moved out of app.js as it was.
//
// Drawn with Preact, as part of the Settings tree rather than hung in it as
// foreign DOM — see web/rail.js for the pattern. What that settled here:
//
// - **A redraw of its own for typing.** CmdGroup keeps a counter the way
//   NotifyGroup does, and everything that only changes this group — a
//   keystroke, a fold, the JSON box — redraws just the group through `again()`.
//   A renderSettings() per keystroke would also rebuild every group still made
//   with el() and rerun every foreign group's painter. Changes the rest of the
//   page draws (the file line's "saving…", a tab, a save) still go through
//   renderSettings(), as they always did.
// - **Controlled where the draft moves on input, uncontrolled where it moves
//   on change.** Preact compares `value` with the DOM, and the draft already
//   holds what was typed, so a controlled box keeps its caret through any
//   redraw. A box that writes the draft only on change (the port numbers and
//   its variable, an environment variable's name) would have the old value put
//   back by a redraw mid-typing, so those are `defaultValue`, keyed by whether
//   the field is set — and the card by `_k`, which a revert, save or re-read
//   regenerates — so they still remount with the right value.
// - **The fold and the footer are state.** The card toggle used to flip
//   `aria-expanded`, `hidden` and a class in place, and the footer was found
//   with `querySelector` and repainted, both to dodge a redraw that would have
//   taken the caret. A redraw no longer does.
//
// Imports from app.js, which imports this — safe because nothing here reads an
// app.js binding while the module evaluates, only when a function is called.
// Keep it that way: a module-level `const` built from an app.js `const` throws,
// because every module under web/settings/ evaluates before app.js's body runs.

import { html, useEffect, useState } from '../vendor/preact.js';
import { get, put } from '../api.js';
import { toast } from '../dom.js';
import { shortPath } from '../format.js';
import { state } from '../state.js';
import { loadCommands } from '../commands.js';
import { devBrowserShown } from '../app.js';
import { DeleteButton } from '../snippets/settings.js';
import { icon } from '../boards/parts.js';
import { grow } from '../composer/send.js';
import { copyPath } from './claude-config.js';
import { renderSettings, settingsProject } from './index.js';

// ── the commands a project declares ──────────────────────────────────────
//
// `.tgxcode/commands.json` is the file behind the buttons in the conversation
// header, and until this group existed the only way to change one was a text
// editor. The format does not forgive: `version: 1` is mandatory, five
// placeholders are legal and a sixth is a validation error, `${port}` is
// refused unless the command declares a range — and a file that will not parse
// contributes *nothing*, so the symptom is a header with no buttons and a
// tooltip nobody hovers.
//
// Two files, and the tabs say Shared and Local because the file names are what
// a reader has in mind. The API says `project` and `project-local`, which is
// what bridge/prefs.js and bridge/claude-config.js call the same distinction.
//
// **This group has a Save button, against the page's no-drafts rule.** That
// rule exists so a control cannot disagree with what is in force, and it is
// right for a preference, which is one independent key. A command is a record
// whose fields have to agree: `run` is required, an id is a key, and `${port}`
// is an error until a port range exists. Saving per field would mean writing a
// document the bridge refuses on most keystrokes, into a file that is checked
// in and that every bridge on this machine re-reads every two seconds. The JSON
// tab and the CLAUDE.md editor are already drafts for the smaller version of
// this reason.
//
// The cost is named rather than hidden: a dirty draft blocks a scope, tab or
// project change behind a confirm, and the footer says what is unsaved.

const CMD_SCOPES = { project: 'Shared', 'project-local': 'Local' };

/** The fields of a command, in the order the form draws them. */
const CMD_FIELDS = [
    { key: 'label', kind: 'text', label: 'Label', required: true,
        note: 'What the button says.' },
    { key: 'run', kind: 'area', label: 'Command', required: true,
        note: 'Run through `bash -i`, so `&&`, pipes and your shell’s PATH all work.' },
    { key: 'cwd', kind: 'text', label: 'Directory',
        note: 'Relative to the workspace, and may not climb out of it. Defaults to the workspace itself.' },
    { key: 'port', kind: 'port', label: 'Port',
        note: 'Find a free port in this range before starting, and hand it to the command as `${port}`.' },
    { key: 'devbrowser', kind: 'text', label: 'DevBrowser tab',
        note: 'Name the tab for this port once something answers on it. Empty falls back to the worktree, then the branch, then the project.' },
    { key: 'env', kind: 'env', label: 'Environment',
        note: 'Extra variables, on top of the ones a terminal here already gets.' },
    { key: 'web', kind: 'bool', label: 'Web app', choices: ['Once it answers', 'Straight away'],
        note: 'When to show its page in the preview. Once it answers waits until the port '
            + 'answers HTTP. Straight away opens the preview as soon as the port is taken '
            + 'and lets the page load there, for a server whose first page is slow. '
            + 'Needs a port.' },
    { key: 'disabled', kind: 'bool', label: 'Visibility', choices: ['Shown', 'Hidden'],
        note: 'Hiding one keeps the declaration and takes away the button. Worth '
            + 'setting explicitly on the local tab: a project can ship a command '
            + 'hidden, and showing it again means writing the opposite rather than '
            + 'leaving the key out.' },
];

const cmdCfgState = () => state.cmdCfg;

/** The directory this group is about — the same one the page's selector picks. */
const cmdCfgDir = () => settingsProject();

export const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

/**
 * The client's half of `expand()` in bridge/commands.js.
 *
 * `${port}` is deliberately left alone, exactly as the bridge leaves it: there
 * is no port until a run allocates one, and showing a number here would be
 * showing a number that turns out not to be the one used.
 */
const cmdExpand = (text, ctx) => String(text == null ? '' : text)
    .replace(/\$\{([a-z]+)\}/g, (whole, name) => (name === 'port' ? whole
        : (ctx && ctx[name] != null && ctx[name] !== '' ? String(ctx[name]) : '')));

export async function loadCmdConfig() {
    const s = cmdCfgState();
    if (s.loading) return;
    s.loading = true;
    s.error = null;
    renderSettings();
    try {
        const dir = cmdCfgDir();
        s.data = dir
            ? await get(`/api/commands-config?cwd=${encodeURIComponent(dir)}`)
            : null;
        // A *clean* draft is dropped so the form reseeds from what was just
        // read; a dirty one is kept, which is the whole point of the 409
        // handling below. Keying this off `draft === null` alone was the bug
        // docs/plans/20-claude-config.md records: renderSettings() runs once
        // before this fetch returns and seeds from the data then in hand, so
        // every render afterwards finds a non-null draft and leaves it — and
        // the form goes on showing something that is neither what anybody typed
        // nor what is on disk.
        if (!s.dirty) s.draft = null;
        if (!s.rawDirty) { s.raw = null; s.jsonError = null; }
    } catch (err) {
        s.data = null;
        s.error = err.message;
    }
    s.loading = false;
    renderSettings();
}

/** The row for the selected scope, out of what the bridge reported. */
const cmdCfgRow = () => {
    const s = cmdCfgState();
    return (s.data && s.data.files.find(f => f.scope === s.scope)) || null;
};
const cmdCfgSharedRow = () => {
    const s = cmdCfgState();
    return (s.data && s.data.files.find(f => f.scope === 'project')) || null;
};

/** What the shared file says about each id, for the Local tab's placeholders. */
function cmdSharedById() {
    const row = cmdCfgSharedRow();
    const by = new Map();
    for (const e of (row ? row.commands : [])) {
        if (e && typeof e.id === 'string') by.set(e.id, e);
    }
    return by;
}

/** Whether the form may be typed into at all. */
const cmdEditable = () => {
    const row = cmdCfgRow();
    return !!row && row.writable && !row.symlink;
};

// A key per draft row, so a card keeps its identity while ids are being typed
// and rows are being removed. Stripped before the draft is sent.
let cmdKeySeq = 0;
const cmdKeyed = (entry) => ({ ...entry, _k: (cmdKeySeq += 1) });

/**
 * The draft for the selected scope, seeded from that file's own entries.
 *
 * From `row.commands` — what *this file* says — never from `data.merged`. A
 * control seeded from the merged answer writes the merged answer back, so
 * adding one local override would copy every shared command into a personal
 * file. That is the bug docs/plans/20-claude-config.md records hitting twice,
 * and it is why the bridge serves the two separately at all.
 */
function cmdDraft() {
    const s = cmdCfgState();
    if (s.draft === null) {
        const row = cmdCfgRow();
        s.draft = (row ? row.commands : []).map(e => cmdKeyed(
            e && typeof e === 'object' && !Array.isArray(e) ? e : { id: '' }));
    }
    return s.draft;
}

/** The draft moved. The caller redraws — the group, or the page. */
const cmdDirty = () => {
    const s = cmdCfgState();
    s.dirty = true;
    // The problems belong to the document that was refused, not to this one.
    s.problems = null;
};

/** Strip the client-only key, and drop keys the form left empty. */
const cmdForWire = () => cmdDraft().map((e) => {
    const out = { ...e };
    delete out._k;
    return out;
});

// ── rendering ──────────────────────────────────────────────────────────────

// The mounted group's own redraw, or the page's when it is not mounted.
let redrawCmds = null;
const again = () => (redrawCmds ? redrawCmds() : renderSettings());

/** The group, for SETTINGS' `card`. Its cards share one contents entry. */
export function renderCmdConfig() {
    return html`<${CmdGroup} key="commands" />`;
}

function CmdGroup() {
    const [, redraw] = useState(0);
    redrawCmds = () => redraw(n => n + 1);
    useEffect(() => () => { redrawCmds = null; }, []);
    return cmdSections();
}

function cmdSections() {
    const s = cmdCfgState();
    let tail = null;
    if (s.error) {
        tail = html`<div class="settings-error">${
            `Could not read this project’s commands: ${s.error}`}</div>`;
    } else if (!s.data) {
        tail = html`<div class="settings-empty">${
            s.loading ? 'Reading…' : 'No project selected — pick one above.'}</div>`;
    } else {
        tail = [s.stale ? cmdStaleBanner() : null, cmdProblemNotes()];
    }
    const head = html`<section key="head" class="settings-group" id="set-g-commands">
        <h2 class="settings-group-title">Project commands</h2>
        <p class="settings-group-note">${'What this project declares in '}<code>.tgxcode/</code>${
            ' — one button in the conversation header per command. The shared file '
            + 'is checked in; the local one is yours and is never committed.'}</p>
        ${cmdScopeTabs()}
        ${cmdFileLine()}
        ${cmdReachNote()}
        ${tail}
    </section>`;
    if (s.error || !s.data) return [head];
    return [head, s.tab === 'raw' ? cmdRawCard() : cmdFormCard()];
}

/** A tag in the file line. */
const fileTag = (text, bad) => html`<span class=${bad ? 'settings-file-tag bad' : 'settings-file-tag'}
    >${text}</span>`;

/** Which file, and which of the two ways of looking at it. */
function cmdScopeTabs() {
    const s = cmdCfgState();
    const rows = s.data ? s.data.files : [];
    const go = (fn) => { if (cmdMayLeave()) { fn(); renderSettings(); } };
    return html`<div class="cfg-tabs" role="tablist">
        ${Object.keys(CMD_SCOPES).map((scope) => {
            const row = rows.find(f => f.scope === scope);
            return html`<button key=${scope} class=${`cfg-tab${scope === s.scope ? ' on' : ''}`}
                type="button" role="tab" disabled=${!row}
                aria-selected=${scope === s.scope ? 'true' : 'false'}
                title=${row ? row.file : 'Pick a project above'}
                onClick=${() => go(() => { s.scope = scope; cmdClearDrafts(s); })}
                >${CMD_SCOPES[scope]}${
                    row && !row.exists ? html`<span class="cfg-tab-tag">none</span>` : null}${
                    row && row.exists && !row.parsed ? html`<span class="cfg-tab-tag">broken</span>` : null}${
                    row && row.symlink ? html`<span class="cfg-tab-tag">symlink</span>` : null}</button>`;
        })}
        <div class="cfg-tabs-spacer"></div>
        <button class=${`cfg-tab${s.tab === 'form' ? ' on' : ''}`} type="button"
            onClick=${() => go(() => { s.tab = 'form'; })}>Form</button>
        <button class=${`cfg-tab${s.tab === 'raw' ? ' on' : ''}`} type="button"
            onClick=${() => go(() => { s.tab = 'raw'; })}>JSON</button>
    </div>`;
}

/** The path being written, and everything true about it worth saying. */
function cmdFileLine() {
    const s = cmdCfgState();
    const row = cmdCfgRow();
    if (!row) {
        return html`<div class="settings-file"><span class="settings-file-none"
            >No project selected — pick one above to edit its commands.</span></div>`;
    }
    // The two `ignored` tags: the only thing making the local file personal is
    // a line in .gitignore. When it is missing, a private override becomes a
    // committed one and nobody finds out until it is in somebody else's
    // checkout. The app is in a position to notice, so it says so.
    return html`<div class="settings-file">
        <span class="settings-file-lede">Writing to</span>
        <button class="settings-file-path" type="button" title="Copy this path"
            onClick=${() => copyPath(row.file)}>${row.file}</button>
        ${!row.exists ? fileTag('will be created') : null}
        ${row.exists && !row.parsed ? fileTag('does not parse', true) : null}
        ${row.symlink ? fileTag('a symlink — saving is refused', true) : null}
        ${!row.writable && !row.symlink ? fileTag('not writable', true) : null}
        ${row.scope === 'project-local' && row.ignored === false
            ? fileTag('not ignored — this would be committed', true) : null}
        ${row.scope === 'project-local' && row.ignored && row.ignoredBy
            ? fileTag(`ignored by ${row.ignoredBy}`) : null}
        ${s.saving ? fileTag('saving…') : null}
    </div>`;
}

/**
 * The sentence that stops "I edited it and nothing happened".
 *
 * A worktree is a checkout of the same repository, so it has its own
 * `commands.json` — 66 of them do here — and readMerged() prefers the one in
 * the directory a session is running in. So editing the project's copy changes
 * nothing for a session in a worktree until the branch picks the change up.
 * That is the feature working, and it looks exactly like the feature being
 * broken, which is why it is on screen rather than in a document.
 */
function cmdReachNote() {
    const s = cmdCfgState();
    if (!s.data) return null;
    if (s.scope === 'project-local') {
        return html`<p class="cfg-reach"><strong>Your local overrides follow you into every worktree.</strong>${
            ' This file is read from the main checkout whichever worktree a session is in, '
            + 'which is what it is for — and it is the tab to use when you want a change to '
            + 'reach work already in flight.'}</p>`;
    }
    return html`<p class="cfg-reach"><strong>A worktree carries its own copy of this file.</strong>${
        ' A session running in '}<code>.claude/worktrees/…</code>${
        ' uses that copy, so a change here does not reach it until the branch picks '
        + 'this up. The '}<strong>Local</strong>${' tab is read from the main '
        + 'checkout for every worktree, and does reach them.'}</p>`;
}

/** What the bridge already thinks is wrong with these files, before any edit. */
function cmdProblemNotes() {
    const s = cmdCfgState();
    const row = cmdCfgRow();
    // A parse failure in the file you are looking at is already on screen, said
    // better by the card that offers a way out of it. Repeating it here prints
    // the same sentence twice, a line apart. The *other* file's is kept: that
    // one has nothing else saying it.
    const shown = row && row.exists && !row.parsed ? row.file : null;
    const loud = (s.data.problems || [])
        .filter(p => !p.informational)
        .filter(p => !(shown && p.file === shown && !p.id));
    if (!loud.length) return null;
    // The shape paintSettingsProblems() uses one card up: the path first, in a
    // `code`, then the sentence. Anything else reads as a different kind of
    // message when the two are on screen together, which they routinely are.
    return html`<div class="settings-problems">${loud.map((p, i) => html`<div
        key=${`${p.file || ''}:${p.id || ''}:${i}`} class="settings-problem">${
        p.file ? html`<code>${shortPath(p.file)}</code>` : null}${
        p.id ? html`<code>${p.id}</code>` : null}${' '}${p.message}</div>`)}</div>`;
}

/** A conflict, kept on screen rather than thrown at a toast. */
function cmdStaleBanner() {
    const s = cmdCfgState();
    return html`<div class="cfg-stale">
        <div class="cfg-stale-head">This file changed on disk since the page read it.</div>
        <p>${'Nothing was overwritten, and nothing you typed was lost — what is in '
            + 'the form is still yours. Below is the file as it is now.'}</p>
        ${s.stale.text ? html`<details><summary>What is on disk</summary><pre
            class="cfg-stale-text">${s.stale.text}</pre></details>` : null}
        <button class="linkish" type="button"
            onClick=${() => { s.stale = null; renderSettings(); }}>Dismiss</button>
    </div>`;
}

// ── the form ───────────────────────────────────────────────────────────────

function cmdFormCard() {
    const s = cmdCfgState();
    const row = cmdCfgRow();
    const card = (...kids) => html`<section key="form" class="settings-group cfg-sub"
        id="set-g-commands-form"><h3 class="settings-group-title">The commands</h3>${kids}</section>`;

    if (!row) return card(html`<div class="cfg-list-none">No file for that scope.</div>`);
    // A file that will not parse has no entries to draw, and drawing an empty
    // form over it would offer to replace somebody's file with nothing.
    if (row.exists && !row.parsed) {
        return card(html`<div class="cfg-broken">
            <p><strong>This file does not parse, so the form cannot show it.</strong>${
                ' Nothing here is lost — the JSON tab has the text exactly as it is on disk, '
                + 'and it is the only thing in the app that can repair one.'}</p>
            ${row.problem ? html`<pre class="cfg-stale-text">${row.problem.message}</pre>` : null}
            <button class="btn small" type="button"
                onClick=${() => { s.tab = 'raw'; renderSettings(); }}>Open the JSON tab</button>
        </div>`);
    }

    const draft = cmdDraft();
    const shared = s.scope === 'project-local' ? cmdSharedById() : new Map();
    const editable = cmdEditable();
    const limits = s.data.limits;

    return card(
        !draft.length ? html`<div class="cfg-list-none">${s.scope === 'project-local'
            ? 'Nothing overridden. Add one to change a shared command for yourself alone.'
            : 'No commands declared here yet.'}</div>` : null,
        draft.map((entry, i) => cmdCard(entry, i, shared, editable)),
        html`<div class="cfg-list-add">
            <button class="linkish" type="button"
                disabled=${!editable || draft.length >= limits.maxCommands}
                onClick=${() => {
                    // A new row starts with the keys the file will need and nothing
                    // else, so the JSON tab shows exactly what the form says.
                    const added = cmdKeyed(s.scope === 'project-local'
                        ? { id: '' } : { id: '', label: '', run: '' });
                    draft.push(added);
                    // Open, since the only thing to do with a blank one is fill it in.
                    s.open.add(added._k);
                    cmdDirty();
                    renderSettings();
                }}>Add a command</button>
            ${draft.length >= limits.maxCommands ? html`<span class="settings-row-note"
                >${`${limits.maxCommands} is as many as one file may declare.`}</span>` : null}
        </div>`,
        cmdFoot());
}

/**
 * One command.
 *
 * On the Local tab every field but the id carries a **Set here** checkbox, and
 * it means exactly one thing: whether the key is present in *this file's*
 * entry. Unticked, the control is disabled and the shared file's value is the
 * placeholder. There is no third state, so the JSON tab and the form can never
 * disagree about what is in the file — which is the only way two views of one
 * document are worth having.
 *
 * On the Shared tab the same checkbox is there, forced on and hidden for the
 * two fields a first definition must carry.
 */
function cmdCard(entry, i, shared, editable) {
    const s = cmdCfgState();
    const local = s.scope === 'project-local';
    const base = local ? shared.get(entry.id) : null;
    // A local entry whose id the shared file does not declare is a *first*
    // definition, so the bridge requires a label and a run. One that has them
    // is a command of its own; one that does not is a fragment the reader drops
    // — and the page has to say which, because "saving does nothing" is what it
    // looks like otherwise.
    const orphan = local && !base && !(entry.label && entry.run);
    const problems = (s.problems || []).filter(p => p.index === i);

    // A card the bridge refused is open whatever you last did with it: the
    // reason it was refused is a field inside, and a folded card hides it.
    const open = problems.length > 0 || s.open.has(entry._k)
        || (!!entry.id && s.openIds.has(entry.id));
    // Kept in step on every draw, so an id typed into an open card is the one
    // remembered when a save reseeds the draft.
    if (open) {
        s.open.add(entry._k);
        if (entry.id) s.openIds.add(entry.id);
    }

    // Through the group's own redraw: nothing else on the page depends on it.
    const flip = () => {
        if (open) {
            s.open.delete(entry._k);
            s.openIds.delete(entry.id);
        } else {
            s.open.add(entry._k);
            if (entry.id) s.openIds.add(entry.id);
        }
        again();
    };

    // The id is the join key rather than a field: changing it on an override is
    // "delete this and add another", not an edit, and doing it in place would
    // silently orphan the entry.
    const fields = CMD_FIELDS
        // Settings → DevBrowser → Show off: nothing in the window names it.
        // The key is kept in the file either way; only the field goes.
        .filter(field => field.key !== 'devbrowser' || devBrowserShown())
        .map(field => cmdField(field, entry, i, { local, base, editable, problems }));

    return html`<div key=${entry._k}
        class=${`cmd-card${problems.length ? ' bad' : ''}${open ? ' open' : ''}`} data-index=${i}>
        <div class="cmd-card-head">
            <button class="cmd-card-toggle" type="button" aria-expanded=${open ? 'true' : 'false'}
                onClick=${flip}><code class="cmd-card-id">${entry.id || 'no id yet'}</code><span
                class="cmd-card-name">${entry.label || (base && base.label) || ''}</span>${
                local && base ? html`<span class="cfg-tab-tag">overrides the shared file</span>` : null}${
                local && !base && !orphan ? html`<span class="cfg-tab-tag">local only</span>` : null}${
                orphan ? html`<span class="cfg-tab-tag bad">orphaned</span>` : null}</button>
            ${cmdDeleteButton(i, editable)}
        </div>
        <div class="cmd-card-body" hidden=${!open}>
            ${orphan ? html`<p class="cmd-orphan"><strong>The shared file no longer declares this id.</strong>${
                ' So this is a new command rather than an override, and it needs a label '
                + 'and a command of its own before anything here will save. '}<button
                class="linkish" type="button" disabled=${!editable}
                onClick=${() => {
                    if (!hasOwn(entry, 'label')) entry.label = '';
                    if (!hasOwn(entry, 'run')) entry.run = '';
                    cmdDirty();
                    renderSettings();
                }}>Fill those in</button>${' or remove it.'}</p>` : null}
            ${cmdIdField(entry, local, base, editable, problems)}
            ${fields}
            ${cmdPreview(entry, base)}
        </div>
    </div>`;
}

function cmdIdField(entry, local, base, editable, problems) {
    const s = cmdCfgState();
    const bad = problems.find(p => p.field === 'id');
    // Every tag on the card moves with the id — override, local only,
    // orphaned — so the group redraws as it is typed. Controlled, so the redraw
    // leaves the caret where it is.
    const onInput = (e) => {
        // The old id is forgotten as the fold's second name, or every prefix of
        // the one being typed would stay remembered as open.
        if (entry.id && s.open.has(entry._k)) s.openIds.delete(entry.id);
        entry.id = e.target.value;
        cmdDirty();
        again();
    };
    return html`<div key="id" class=${`cmd-field${bad ? ' bad' : ''}`} data-field="id">
        <div class="cmd-field-head"><span class="cmd-field-label">Id</span></div>
        <input class="settings-text cmd-mono" type="text" spellcheck=${false}
            value=${entry.id || ''} placeholder="dev" disabled=${!editable} onInput=${onInput} />
        <p class="cmd-field-note">${local
            ? 'The id of the shared command this changes — or a new one, for a command only you have.'
            : 'How the file refers to this command. Lower case, digits, dot, dash or underscore.'}</p>
        ${bad ? html`<p class="cmd-field-bad">${bad.message}</p>` : null}
        ${local && base ? html`<p class="cmd-field-note">${'Matches '}<code>${base.id}</code>${
            ' in the shared file.'}</p>` : null}
    </div>`;
}

function cmdField(field, entry, i, ctx) {
    const { local, base, editable, problems } = ctx;
    const set = hasOwn(entry, field.key);
    // On the shared file a first definition must carry these two, so the
    // checkbox would be a control that cannot be used.
    const forced = !local && field.required;
    const bad = problems.find(p => p.field === field.key);
    const inherited = base ? base[field.key] : undefined;
    const disabled = !editable || (!set && !forced);

    const toggle = (on) => {
        if (on) {
            entry[field.key] = inherited !== undefined ? clone(inherited) : cmdBlank(field);
        } else {
            delete entry[field.key];
        }
        cmdDirty();
        renderSettings();
    };

    return html`<div key=${field.key}
        class=${`cmd-field${bad ? ' bad' : ''}${!set && !forced ? ' unset' : ''}`} data-field=${field.key}>
        <div class="cmd-field-head">${
            forced ? null : html`<label class="settings-check cmd-set"><input type="checkbox"
                checked=${set} disabled=${!editable}
                onChange=${(e) => toggle(e.target.checked)} /><span class="settings-box"></span></label>`}<span
            class="cmd-field-label">${field.label}</span>${
            !set && !forced && inherited !== undefined
                ? html`<span class="cmd-field-from">inherited</span>` : null}</div>
        ${cmdControl(field, entry, { set: set || forced, disabled, inherited, local })}
        ${field.note ? html`<p class="cmd-field-note">${field.note}</p>` : null}
        ${bad ? html`<p class="cmd-field-bad">${bad.message}</p>` : null}
    </div>`;
}

/** What an unticked field becomes when somebody ticks it. */
function cmdBlank(field) {
    if (field.kind === 'port') return { range: [3000, 3009] };
    if (field.kind === 'env') return {};
    // Ticking "Set here" on a yes/no row means "I want to decide this",
    // and the answer somebody wants by default is the one that changes nothing.
    if (field.kind === 'bool') return false;
    return '';
}

export const clone = (v) => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));

function cmdControl(field, entry, o) {
    const value = o.set ? entry[field.key] : undefined;
    const ph = o.inherited === undefined ? '' : cmdPlaceholderOf(field, o.inherited);

    // Two named options rather than a checkbox. A checkbox beside the "Set
    // here" one is two boxes that look identical and mean different things —
    // and it cannot say `false` out loud, which is exactly what un-hiding a
    // command the shared file hides requires.
    if (field.kind === 'bool') {
        return html`<select class="settings-select" disabled=${o.disabled}
            value=${value === true ? 'on' : 'off'}
            onChange=${(e) => { entry[field.key] = e.target.value === 'on'; cmdDirty(); again(); }}>
            <option value="off">${field.choices[0]}</option>
            <option value="on">${field.choices[1]}</option>
        </select>`;
    }

    if (field.kind === 'area') {
        // A textarea, not an input: `validate()` refuses only a NUL, so a
        // newline is legal in a command — and a single-line input strips one
        // silently, eating half of somebody's command on the first save.
        // grow() writes the height into `style`, which Preact is never given.
        return html`<textarea class="cmd-area" spellcheck=${false} rows="1" placeholder=${ph}
            disabled=${o.disabled} value=${value == null ? '' : String(value)}
            onFocus=${(e) => grow(e.target, 26, 240)}
            onInput=${(e) => {
                entry[field.key] = e.target.value;
                grow(e.target, 26, 240);
                cmdDirty();
                again();
            }}></textarea>`;
    }

    if (field.kind === 'port') return cmdPortControl(entry, field, o);
    if (field.kind === 'env') return cmdEnvControl(entry, field, o);

    return html`<input class="settings-text is-long" type="text" spellcheck=${false}
        value=${value == null ? '' : String(value)} placeholder=${ph} disabled=${o.disabled}
        onInput=${(e) => { entry[field.key] = e.target.value; cmdDirty(); again(); }} />`;
}

/** The inherited value, as a placeholder reads it. */
function cmdPlaceholderOf(field, v) {
    if (field.kind === 'port') {
        return v && v.range ? `${v.range[0]}–${v.range[1]}` : '';
    }
    if (field.kind === 'env') return '';
    if (field.kind === 'bool') return '';
    return v === '' ? '(empty)' : String(v);
}

/**
 * The port range and its variable.
 *
 * Uncontrolled, because they write the draft on change rather than on input:
 * a controlled box would have the old number put back by any redraw that came
 * while somebody was typing. Keyed by whether the field is set, so ticking or
 * unticking "Set here" remounts them with what the draft now says.
 */
function cmdPortControl(entry, field, o) {
    const v = o.set && entry.port ? entry.port : null;
    const range = (v && Array.isArray(v.range)) ? v.range : [null, null];
    // The inherited block shows through the same way every other field's does.
    // Three empty boxes over a shared command that declares 45899–45918 would be
    // the one place on this tab where "unset" and "set to nothing" look alike.
    const from = o.inherited && typeof o.inherited === 'object' ? o.inherited : null;
    const fromRange = from && Array.isArray(from.range) ? from.range : [null, null];
    const k = o.set ? 'set' : 'unset';
    const num = (at) => html`<input key=${`n${at}:${k}`} class="settings-num" type="number"
        min="1024" max="65535" defaultValue=${range[at] == null ? '' : range[at]} disabled=${o.disabled}
        placeholder=${fromRange[at] == null ? '' : String(fromRange[at])}
        onChange=${(e) => {
            if (!entry.port) entry.port = { range: [0, 0] };
            if (!Array.isArray(entry.port.range)) entry.port.range = [0, 0];
            entry.port.range[at] = Number(e.target.value);
            cmdDirty();
            again();
        }} />`;
    return html`<div class="cmd-port">
        ${num(0)}<span key="dash" class="cmd-port-dash">–</span>${num(1)}<input key=${`env:${k}`}
            class="settings-text cmd-mono cmd-port-env" type="text" spellcheck=${false}
            placeholder=${(from && from.env) || 'PORT (optional)'} defaultValue=${(v && v.env) || ''}
            disabled=${o.disabled}
            onChange=${(e) => {
                if (!entry.port) return;
                const name = e.target.value.trim();
                if (name) entry.port.env = name; else delete entry.port.env;
                cmdDirty();
                again();
            }} />
    </div>`;
}

/**
 * Extra environment, one row per variable.
 *
 * A map, and its unit of override is a key rather than the object — `merge()`
 * folds `{...prev.env, ...here.env}`. So the inherited keys are listed read-only
 * beside the ones this file sets, and the note says the thing the format cannot
 * do: there is no way to *remove* an inherited variable from the local file,
 * only to give it another value.
 *
 * Rows are keyed by name, and the name box is uncontrolled and renames on
 * change: a rename is a new row, which is what it is in the file.
 */
function cmdEnvControl(entry, field, o) {
    const env = o.set && entry.env && typeof entry.env === 'object' ? entry.env : null;
    const keys = env ? Object.keys(env) : [];
    const inherited = o.inherited && typeof o.inherited === 'object' ? o.inherited : {};
    const extra = Object.keys(inherited).filter(k => !keys.includes(k));

    return html`<div class="cfg-list cmd-env">
        ${keys.map(k => html`<div key=${k} class="cmd-env-row">
            <input class="settings-text cmd-mono cmd-env-name" type="text" spellcheck=${false}
                defaultValue=${k} disabled=${o.disabled}
                onChange=${(e) => {
                    const next = e.target.value.trim();
                    if (next === k) return;
                    const was = env[k];
                    delete env[k];
                    if (next) env[next] = was;
                    cmdDirty();
                    renderSettings();
                }} />
            <input class="settings-text cmd-env-value" type="text" spellcheck=${false}
                value=${env[k]} disabled=${o.disabled}
                onInput=${(e) => { env[k] = e.target.value; cmdDirty(); again(); }} />
            <button class="cfg-list-x" type="button" disabled=${o.disabled}
                aria-label=${`Remove ${k}`} title="Remove"
                onClick=${() => { delete env[k]; cmdDirty(); renderSettings(); }}>×</button>
        </div>`)}
        <div class="cfg-list-add">
            <button class="linkish" type="button" disabled=${o.disabled}
                onClick=${() => {
                    if (!entry.env || typeof entry.env !== 'object') entry.env = {};
                    let name = 'NAME';
                    for (let n = 2; hasOwn(entry.env, name); n += 1) name = `NAME_${n}`;
                    entry.env[name] = '';
                    cmdDirty();
                    renderSettings();
                }}>Add a variable</button>
        </div>
        ${extra.length ? html`<div class="cfg-inherit">
            <div class="cfg-inherit-head">${`${extra.length} more from the shared file`}</div>
            ${extra.map(k => html`<div key=${k} class="cfg-inherit-row">${`${k}=${inherited[k]}`}</div>`)}
            <p class="cmd-field-note">${'These add to yours rather than being replaced by them. The format has no '
                + 'way to remove one here — only to give it a different value.'}</p>
        </div>` : null}
    </div>`;
}

/** What this command will actually run, here. */
function cmdPreview(entry, base) {
    const s = cmdCfgState();
    const ctx = s.data.context || {};
    const run = hasOwn(entry, 'run') ? entry.run : (base && base.run);
    if (!run) return null;
    const out = cmdExpand(run, ctx);
    if (out === String(run)) return null;
    return html`<p class="cmd-preview"><span class="cmd-preview-lede">Here, that runs</span><code
        >${out}</code></p>`;
}

/**
 * Remove a command, with the snippets group's arm-in-place confirm.
 *
 * Reused rather than reimplemented, and not only for the look: a misclick here
 * takes a button somebody uses out of the header. "Armed" is the component's
 * own state, so it lasts across the redraws typing elsewhere causes. A file
 * that cannot be written gets the same button, disabled — DeleteButton has no
 * disabled state, and one that cannot arm needs none.
 */
function cmdDeleteButton(i, editable) {
    const label = 'Remove this command';
    if (!editable) {
        return html`<button class="snip-del" type="button" aria-label=${label} title=${label}
            disabled>${icon('trash', 13)}</button>`;
    }
    return html`<${DeleteButton} label=${label} go=${() => {
        cmdDraft().splice(i, 1);
        cmdDirty();
        renderSettings();
    }} />`;
}

// ── saving ─────────────────────────────────────────────────────────────────

function cmdFoot() {
    const s = cmdCfgState();
    const row = cmdCfgRow();
    const editable = cmdEditable();
    return html`<div class="cmd-foot">
        <span class=${`cmd-foot-note${s.problems ? ' bad' : ''}`}>${s.problems
            ? `${s.problems.length} ${s.problems.length === 1 ? 'problem' : 'problems'} — nothing was written.`
            : (s.dirty ? 'Edited — not saved.' : 'Matches the file on disk.')}</span>
        <div class="cmd-card-spacer"></div>
        <button class="btn quiet small" type="button" disabled=${!s.dirty}
            onClick=${() => { cmdClearDrafts(s); renderSettings(); }}>Revert</button>
        <button class="btn primary small" type="button"
            disabled=${!editable || !s.dirty || s.saving}
            onClick=${() => saveCmdConfig()}>${row && row.exists ? 'Save' : 'Create the file'}</button>
    </div>`;
}

export function cmdClearDrafts(s) {
    s.draft = null;
    s.dirty = false;
    s.raw = null;
    s.rawDirty = false;
    s.jsonError = null;
    s.problems = null;
}

/** Nothing typed, or the user said to drop it. */
function cmdMayLeave() {
    const s = cmdCfgState();
    if (!s.dirty && !s.rawDirty) return true;
    // eslint-disable-next-line no-alert
    if (!window.confirm('Discard the changes to this file?')) return false;
    cmdClearDrafts(s);
    return true;
}

async function saveCmdConfig() {
    const s = cmdCfgState();
    const row = cmdCfgRow();
    if (!row || !s.dirty) return;
    s.saving = true;
    s.problems = null;
    renderSettings();
    try {
        const answer = await put('/api/commands-config', {
            scope: s.scope,
            cwd: cmdCfgDir(),
            stamp: row.exists ? row.stamp : null,
            commands: cmdForWire(),
        });
        s.data = answer.config;
        cmdClearDrafts(s);
        toast(`${shortPath(answer.file)} written.`, 'ok');
        // The payoff, and the reason this is not just a file editor: the
        // buttons in the header come from the same files, and a window that
        // did not re-read them would go on showing the old label until the
        // session was reopened.
        loadCommands();
    } catch (err) {
        cmdSaveFailed(err);
    }
    s.saving = false;
    renderSettings();
}

/**
 * A refused save, sorted by what the page can do about it.
 *
 * The draft survives every branch. Losing what somebody typed in order to tell
 * them why it was not written is the one unforgivable move here.
 */
function cmdSaveFailed(err) {
    const s = cmdCfgState();
    const data = err.data || {};
    if (err.status === 409) {
        s.stale = { text: data.text || null };
        toast('That file changed on disk. Your edits are kept — compare and save again.', 'warn');
        const keep = s.draft;
        const keepRaw = s.raw;
        return loadCmdConfig().then(() => {
            s.draft = keep;
            s.raw = keepRaw;
            s.dirty = keep !== null;
            s.rawDirty = keepRaw !== null;
            renderSettings();
        });
    }
    if (Array.isArray(data.problems) && data.problems.length) {
        // Every problem at once, each against the row and field it is about —
        // a form that surfaced one per round trip would make six saves out of
        // one paste.
        s.problems = data.problems;
        toast(err.message, 'error');
        return null;
    }
    toast(`Could not save that file: ${err.message}`, 'error');
    return null;
}

// ── the JSON tab ───────────────────────────────────────────────────────────

/**
 * The file itself, in a text box.
 *
 * Not a fallback added later: it is what makes the form honest. With it here
 * nothing in these files is beyond reach, so a key the form has not learned to
 * draw is an inconvenience rather than a wall — and it is the only thing in the
 * app that can repair a file which no longer parses, which is the state that
 * takes every button out of the header at once.
 */
function cmdRawCard() {
    const s = cmdCfgState();
    const row = cmdCfgRow();
    const card = (...kids) => html`<section key="raw" class="settings-group cfg-sub"
        id="set-g-commands-raw"><h3 class="settings-group-title">The file itself</h3>${kids}</section>`;
    if (!row) return card(html`<div class="cfg-list-none">No file for that scope.</div>`);

    const readonly = !cmdEditable();
    const onDisk = row.text === null
        ? `${JSON.stringify({ version: 1, commands: [] }, null, 2)}\n`
        : row.text;
    // A clean box is a *view* of the file rather than a draft of it, so it
    // reseeds whenever the file moves. `dirty` is the thing that means somebody
    // typed here, and it is the only thing that should stop this.
    if (s.raw === null || !s.rawDirty) s.raw = onDisk;

    return card(
        html`<textarea class="cfg-json" spellcheck=${false} autocapitalize="off" autocorrect="off"
            disabled=${readonly} value=${s.raw}
            onInput=${(e) => {
                // Parsed on every keystroke rather than on save: the point of the
                // message is to be there while the mistake is still on screen.
                s.raw = e.target.value;
                s.rawDirty = s.raw !== onDisk;
                s.jsonError = null;
                if (s.raw.trim()) {
                    try { JSON.parse(s.raw); }
                    catch (err) { s.jsonError = err.message; }
                }
                again();
            }}></textarea>`,
        html`<div class="cmd-foot">
            <div class=${`cfg-json-note${s.jsonError ? ' bad' : ''}`}>${s.jsonError
                || (s.rawDirty ? 'Edited — not saved.' : 'Matches the file on disk.')}</div>
            <div class="cmd-card-spacer"></div>
            <button class="btn quiet small" type="button" disabled=${!s.rawDirty}
                onClick=${() => { cmdClearDrafts(s); renderSettings(); }}>Revert</button>
            <button class="btn primary small" type="button"
                disabled=${readonly || !s.rawDirty || !!s.jsonError || s.saving}
                onClick=${() => saveCmdText()}>${row.exists ? 'Save' : 'Create the file'}</button>
        </div>`);
}

async function saveCmdText() {
    const s = cmdCfgState();
    const row = cmdCfgRow();
    if (!row || s.raw === null) return;
    s.saving = true;
    renderSettings();
    try {
        const answer = await put('/api/commands-config', {
            scope: s.scope,
            cwd: cmdCfgDir(),
            stamp: row.exists ? row.stamp : null,
            text: s.raw,
        });
        s.data = answer.config;
        cmdClearDrafts(s);
        toast(`${shortPath(answer.file)} written.`, 'ok');
        loadCommands();
    } catch (err) {
        cmdSaveFailed(err);
    }
    s.saving = false;
    renderSettings();
}
