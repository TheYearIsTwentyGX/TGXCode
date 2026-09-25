// The Commands group: the `.tgxcode/commands.json` a project declares, as a
// form and as JSON. Moved out of app.js as it was.
//
// Imports from app.js, which imports this — safe because nothing here reads an
// app.js binding while the module evaluates, only when a function is called.
// Keep it that way: a module-level `const` built from an app.js `const` throws,
// because every module under web/settings/ evaluates before app.js's body runs.

import { get, put } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { shortPath } from '../format.js';
import { state } from '../state.js';
import { loadCommands } from '../commands.js';
import { devBrowserShown, snipDeleteButton } from '../app.js';
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

const cmdDirty = () => {
    const s = cmdCfgState();
    s.dirty = true;
    // The problems belong to the document that was refused, not to this one.
    s.problems = null;
    const foot = dom.setBody.querySelector('.cmd-foot');
    if (foot) cmdPaintFoot(foot);
};

/** Strip the client-only key, and drop keys the form left empty. */
const cmdForWire = () => cmdDraft().map((e) => {
    const out = { ...e };
    delete out._k;
    return out;
});

// ── rendering ──────────────────────────────────────────────────────────────

export function renderCmdConfig() {
    const s = cmdCfgState();
    const head = el('section', { class: 'settings-group', id: 'set-g-commands' },
        el('h2', { class: 'settings-group-title', text: 'Project commands' }),
        el('p', { class: 'settings-group-note' },
            'What this project declares in ', el('code', { text: '.tgxcode/' }),
            ' — one button in the conversation header per command. The shared file '
            + 'is checked in; the local one is yours and is never committed.'),
        cmdScopeTabs(),
        cmdFileLine(),
        cmdReachNote());

    if (s.error) {
        head.append(el('div', { class: 'settings-error' },
            `Could not read this project’s commands: ${s.error}`));
        return [head];
    }
    if (!s.data) {
        head.append(el('div', { class: 'settings-empty',
            text: s.loading ? 'Reading…' : 'No project selected — pick one above.' }));
        return [head];
    }
    if (s.stale) head.append(cmdStaleBanner());
    cmdProblemNotes(head);

    return [head, s.tab === 'raw' ? cmdRawCard() : cmdFormCard()];
}

/** Which file, and which of the two ways of looking at it. */
function cmdScopeTabs() {
    const s = cmdCfgState();
    const rows = s.data ? s.data.files : [];
    const go = (fn) => { if (cmdMayLeave()) { fn(); renderSettings(); } };
    return el('div', { class: 'cfg-tabs', role: 'tablist' },
        Object.keys(CMD_SCOPES).map((scope) => {
            const row = rows.find(f => f.scope === scope);
            return el('button', {
                class: `cfg-tab${scope === s.scope ? ' on' : ''}`,
                type: 'button', role: 'tab', disabled: !row || null,
                'aria-selected': scope === s.scope ? 'true' : 'false',
                title: row ? row.file : 'Pick a project above',
                onclick: () => go(() => { s.scope = scope; cmdClearDrafts(s); }),
            },
            CMD_SCOPES[scope],
            row && !row.exists ? el('span', { class: 'cfg-tab-tag', text: 'none' }) : null,
            row && row.exists && !row.parsed
                ? el('span', { class: 'cfg-tab-tag', text: 'broken' }) : null,
            row && row.symlink ? el('span', { class: 'cfg-tab-tag', text: 'symlink' }) : null);
        }),
        el('div', { class: 'cfg-tabs-spacer' }),
        el('button', {
            class: `cfg-tab${s.tab === 'form' ? ' on' : ''}`, type: 'button',
            onclick: () => go(() => { s.tab = 'form'; }),
        }, 'Form'),
        el('button', {
            class: `cfg-tab${s.tab === 'raw' ? ' on' : ''}`, type: 'button',
            onclick: () => go(() => { s.tab = 'raw'; }),
        }, 'JSON'));
}

/** The path being written, and everything true about it worth saying. */
function cmdFileLine() {
    const s = cmdCfgState();
    const row = cmdCfgRow();
    const line = el('div', { class: 'settings-file' });
    if (!row) {
        line.append(el('span', { class: 'settings-file-none' },
            'No project selected — pick one above to edit its commands.'));
        return line;
    }
    line.append(...[
        el('span', { class: 'settings-file-lede', text: 'Writing to' }),
        el('button', {
            class: 'settings-file-path', type: 'button', title: 'Copy this path',
            onclick: () => copyPath(row.file),
        }, row.file),
        !row.exists && el('span', { class: 'settings-file-tag', text: 'will be created' }),
        row.exists && !row.parsed
            && el('span', { class: 'settings-file-tag bad', text: 'does not parse' }),
        row.symlink
            && el('span', { class: 'settings-file-tag bad', text: 'a symlink — saving is refused' }),
        !row.writable && !row.symlink
            && el('span', { class: 'settings-file-tag bad', text: 'not writable' }),
        // The only thing making the local file personal is a line in
        // .gitignore. When it is missing, a private override becomes a
        // committed one and nobody finds out until it is in somebody else's
        // checkout. The app is in a position to notice, so it says so.
        row.scope === 'project-local' && row.ignored === false
            && el('span', { class: 'settings-file-tag bad', text: 'not ignored — this would be committed' }),
        row.scope === 'project-local' && row.ignored && row.ignoredBy
            && el('span', { class: 'settings-file-tag', text: `ignored by ${row.ignoredBy}` }),
        s.saving && el('span', { class: 'settings-file-tag', text: 'saving…' }),
    ].filter(Boolean));
    return line;
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
        return el('p', { class: 'cfg-reach' },
            el('strong', { text: 'Your local overrides follow you into every worktree.' }),
            ' This file is read from the main checkout whichever worktree a session is in, '
            + 'which is what it is for — and it is the tab to use when you want a change to '
            + 'reach work already in flight.');
    }
    return el('p', { class: 'cfg-reach' },
        el('strong', { text: 'A worktree carries its own copy of this file.' }),
        ' A session running in ', el('code', { text: '.claude/worktrees/…' }),
        ' uses that copy, so a change here does not reach it until the branch picks '
        + 'this up. The ', el('strong', { text: 'Local' }), ' tab is read from the main '
        + 'checkout for every worktree, and does reach them.');
}

/** What the bridge already thinks is wrong with these files, before any edit. */
function cmdProblemNotes(head) {
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
    if (!loud.length) return;
    // The shape paintSettingsProblems() uses one card up: the path first, in a
    // `code`, then the sentence. Anything else reads as a different kind of
    // message when the two are on screen together, which they routinely are.
    head.append(el('div', { class: 'settings-problems' },
        loud.map(p => el('div', { class: 'settings-problem' },
            p.file ? el('code', { text: shortPath(p.file) }) : null,
            p.id ? el('code', { text: p.id }) : null,
            ' ', p.message))));
}

/** A conflict, kept on screen rather than thrown at a toast. */
function cmdStaleBanner() {
    const s = cmdCfgState();
    return el('div', { class: 'cfg-stale' },
        el('div', { class: 'cfg-stale-head' }, 'This file changed on disk since the page read it.'),
        el('p', null, 'Nothing was overwritten, and nothing you typed was lost — what is in '
            + 'the form is still yours. Below is the file as it is now.'),
        s.stale.text
            ? el('details', null,
                el('summary', { text: 'What is on disk' }),
                el('pre', { class: 'cfg-stale-text', text: s.stale.text }))
            : null,
        el('button', {
            class: 'linkish', type: 'button',
            onclick: () => { s.stale = null; renderSettings(); },
        }, 'Dismiss'));
}

// ── the form ───────────────────────────────────────────────────────────────

function cmdFormCard() {
    const s = cmdCfgState();
    const row = cmdCfgRow();
    const card = el('section', { class: 'settings-group cfg-sub', id: 'set-g-commands-form' },
        el('h3', { class: 'settings-group-title', text: 'The commands' }));

    if (!row) {
        card.append(el('div', { class: 'cfg-list-none', text: 'No file for that scope.' }));
        return card;
    }
    // A file that will not parse has no entries to draw, and drawing an empty
    // form over it would offer to replace somebody's file with nothing.
    if (row.exists && !row.parsed) {
        card.append(el('div', { class: 'cfg-broken' },
            el('p', null, el('strong', { text: 'This file does not parse, so the form cannot show it.' }),
                ' Nothing here is lost — the JSON tab has the text exactly as it is on disk, '
                + 'and it is the only thing in the app that can repair one.'),
            row.problem ? el('pre', { class: 'cfg-stale-text', text: row.problem.message }) : null,
            el('button', {
                class: 'btn small', type: 'button',
                onclick: () => { s.tab = 'raw'; renderSettings(); },
            }, 'Open the JSON tab')));
        return card;
    }

    const draft = cmdDraft();
    const shared = s.scope === 'project-local' ? cmdSharedById() : new Map();
    const editable = cmdEditable();

    if (!draft.length) {
        card.append(el('div', { class: 'cfg-list-none',
            text: s.scope === 'project-local'
                ? 'Nothing overridden. Add one to change a shared command for yourself alone.'
                : 'No commands declared here yet.' }));
    }
    draft.forEach((entry, i) => card.append(cmdCard(entry, i, shared, editable)));

    const limits = s.data.limits;
    card.append(el('div', { class: 'cfg-list-add' },
        el('button', {
            class: 'linkish', type: 'button',
            disabled: !editable || draft.length >= limits.maxCommands || null,
            onclick: () => {
                // A new row starts with the keys the file will need and nothing
                // else, so the JSON tab shows exactly what the form says.
                const added = cmdKeyed(s.scope === 'project-local'
                    ? { id: '' } : { id: '', label: '', run: '' });
                draft.push(added);
                // Open, since the only thing to do with a blank one is fill it in.
                s.open.add(added._k);
                cmdDirty();
                renderSettings();
            },
        }, 'Add a command'),
        draft.length >= limits.maxCommands
            ? el('span', { class: 'settings-row-note',
                text: `${limits.maxCommands} is as many as one file may declare.` })
            : null));

    card.append(cmdFoot());
    return card;
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

    const body = el('div', { class: 'cmd-card-body', hidden: !open || null });
    const toggle = el('button', {
        class: 'cmd-card-toggle', type: 'button',
        'aria-expanded': open ? 'true' : 'false',
        onclick: () => {
            const now = toggle.getAttribute('aria-expanded') !== 'true';
            // Flipped in place rather than through renderSettings(): nothing
            // else on the page depends on it, and a redraw would take focus.
            toggle.setAttribute('aria-expanded', now ? 'true' : 'false');
            body.hidden = !now;
            card.classList.toggle('open', now);
            if (now) {
                s.open.add(entry._k);
                if (entry.id) s.openIds.add(entry.id);
            } else {
                s.open.delete(entry._k);
                s.openIds.delete(entry.id);
            }
        },
    },
    el('code', { class: 'cmd-card-id', text: entry.id || 'no id yet' }),
    el('span', { class: 'cmd-card-name',
        text: entry.label || (base && base.label) || '' }),
    local && base ? el('span', { class: 'cfg-tab-tag', text: 'overrides the shared file' }) : null,
    local && !base && !orphan ? el('span', { class: 'cfg-tab-tag', text: 'local only' }) : null,
    orphan ? el('span', { class: 'cfg-tab-tag bad', text: 'orphaned' }) : null);

    const head = el('div', { class: 'cmd-card-head' }, toggle, cmdDeleteButton(i, editable));

    const card = el('div', {
        class: `cmd-card${problems.length ? ' bad' : ''}${open ? ' open' : ''}`, 'data-index': i,
    }, head, body);

    if (orphan) {
        body.append(el('p', { class: 'cmd-orphan' },
            el('strong', { text: 'The shared file no longer declares this id.' }),
            ' So this is a new command rather than an override, and it needs a label '
            + 'and a command of its own before anything here will save. ',
            el('button', {
                class: 'linkish', type: 'button', disabled: !editable || null,
                onclick: () => {
                    if (!hasOwn(entry, 'label')) entry.label = '';
                    if (!hasOwn(entry, 'run')) entry.run = '';
                    cmdDirty();
                    renderSettings();
                },
            }, 'Fill those in'),
            ' or remove it.'));
    }

    // The id is the join key rather than a field: changing it on an override is
    // "delete this and add another", not an edit, and doing it in place would
    // silently orphan the entry.
    body.append(cmdIdField(entry, i, local, base, editable, problems));
    for (const field of CMD_FIELDS) {
        // Settings → DevBrowser → Show off: nothing in the window names it.
        // The key is kept in the file either way; only the field goes.
        if (field.key === 'devbrowser' && !devBrowserShown()) continue;
        body.append(cmdField(field, entry, i, { local, base, editable, problems }));
    }
    // Filtered rather than passed through: `append` stringifies a null into the
    // literal word, where el()'s own children skip it. The same trap
    // docsFileLine() carries a comment about, and it prints "null" under a
    // command before anybody notices.
    const preview = cmdPreview(entry, base);
    if (preview) body.append(preview);
    return card;
}

function cmdIdField(entry, i, local, base, editable, problems) {
    const s = cmdCfgState();
    const bad = problems.find(p => p.field === 'id');
    return el('div', { class: `cmd-field${bad ? ' bad' : ''}`, 'data-field': 'id' },
        el('div', { class: 'cmd-field-head' }, el('span', { class: 'cmd-field-label', text: 'Id' })),
        el('input', {
            class: 'settings-text cmd-mono', type: 'text', spellcheck: 'false',
            value: entry.id || '', placeholder: 'dev',
            disabled: !editable || null,
            oninput: (e) => { entry.id = e.target.value; cmdDirty(); },
            // Re-drawn on blur rather than per keystroke: the id decides whether
            // a local row is an override or an orphan, and every tag on the card
            // moves with it.
            onchange: () => { if (local) renderSettings(); },
        }),
        el('p', { class: 'cmd-field-note' },
            local
                ? 'The id of the shared command this changes — or a new one, for a command only you have.'
                : 'How the file refers to this command. Lower case, digits, dot, dash or underscore.'),
        bad ? el('p', { class: 'cmd-field-bad', text: bad.message }) : null,
        local && base ? el('p', { class: 'cmd-field-note' },
            'Matches ', el('code', { text: base.id }), ' in the shared file.') : null,
        s.data.patterns ? null : null);
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

    const head = el('div', { class: 'cmd-field-head' },
        forced ? null : el('label', { class: 'settings-check cmd-set' },
            el('input', {
                type: 'checkbox', checked: set || null, disabled: !editable || null,
                onchange: (e) => toggle(e.target.checked),
            }),
            el('span', { class: 'settings-box' })),
        el('span', { class: 'cmd-field-label', text: field.label }),
        !set && !forced && inherited !== undefined
            ? el('span', { class: 'cmd-field-from', text: 'inherited' })
            : null);

    return el('div', {
        class: `cmd-field${bad ? ' bad' : ''}${!set && !forced ? ' unset' : ''}`,
        'data-field': field.key,
    },
    head,
    cmdControl(field, entry, { set: set || forced, disabled, inherited, local }),
    field.note ? el('p', { class: 'cmd-field-note', text: field.note }) : null,
    bad ? el('p', { class: 'cmd-field-bad', text: bad.message }) : null);
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
        return el('select', {
            class: 'settings-select', disabled: o.disabled || null,
            onchange: (e) => { entry[field.key] = e.target.value === 'on'; cmdDirty(); },
        },
        el('option', { value: 'off', selected: value !== true || null }, field.choices[0]),
        el('option', { value: 'on', selected: value === true || null }, field.choices[1]));
    }

    if (field.kind === 'area') {
        // A textarea, not an input: `validate()` refuses only a NUL, so a
        // newline is legal in a command — and a single-line input strips one
        // silently, eating half of somebody's command on the first save.
        return el('textarea', {
            class: 'cmd-area', spellcheck: 'false', rows: 1, placeholder: ph,
            disabled: o.disabled || null,
            onfocus: (e) => grow(e.target, 26, 240),
            oninput: (e) => { entry[field.key] = e.target.value; grow(e.target, 26, 240); cmdDirty(); },
        }, value == null ? '' : String(value));
    }

    if (field.kind === 'port') return cmdPortControl(entry, field, o);
    if (field.kind === 'env') return cmdEnvControl(entry, field, o);

    return el('input', {
        class: 'settings-text is-long', type: 'text', spellcheck: 'false',
        value: value == null ? '' : String(value), placeholder: ph,
        disabled: o.disabled || null,
        oninput: (e) => { entry[field.key] = e.target.value; cmdDirty(); },
    });
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

function cmdPortControl(entry, field, o) {
    const v = o.set && entry.port ? entry.port : null;
    const range = (v && Array.isArray(v.range)) ? v.range : [null, null];
    // The inherited block shows through the same way every other field's does.
    // Three empty boxes over a shared command that declares 45899–45918 would be
    // the one place on this tab where "unset" and "set to nothing" look alike.
    const from = o.inherited && typeof o.inherited === 'object' ? o.inherited : null;
    const fromRange = from && Array.isArray(from.range) ? from.range : [null, null];
    const num = (at) => el('input', {
        class: 'settings-num', type: 'number', min: 1024, max: 65535,
        value: range[at] == null ? '' : range[at], disabled: o.disabled || null,
        placeholder: fromRange[at] == null ? '' : String(fromRange[at]),
        onchange: (e) => {
            if (!entry.port) entry.port = { range: [0, 0] };
            if (!Array.isArray(entry.port.range)) entry.port.range = [0, 0];
            entry.port.range[at] = Number(e.target.value);
            cmdDirty();
        },
    });
    return el('div', { class: 'cmd-port' },
        num(0), el('span', { class: 'cmd-port-dash', text: '–' }), num(1),
        el('input', {
            class: 'settings-text cmd-mono cmd-port-env', type: 'text', spellcheck: 'false',
            placeholder: (from && from.env) || 'PORT (optional)', value: (v && v.env) || '',
            disabled: o.disabled || null,
            onchange: (e) => {
                if (!entry.port) return;
                const name = e.target.value.trim();
                if (name) entry.port.env = name; else delete entry.port.env;
                cmdDirty();
            },
        }));
}

/**
 * Extra environment, one row per variable.
 *
 * A map, and its unit of override is a key rather than the object — `merge()`
 * folds `{...prev.env, ...here.env}`. So the inherited keys are listed read-only
 * beside the ones this file sets, and the note says the thing the format cannot
 * do: there is no way to *remove* an inherited variable from the local file,
 * only to give it another value.
 */
function cmdEnvControl(entry, field, o) {
    const env = o.set && entry.env && typeof entry.env === 'object' ? entry.env : null;
    const keys = env ? Object.keys(env) : [];
    const inherited = o.inherited && typeof o.inherited === 'object' ? o.inherited : {};
    const extra = Object.keys(inherited).filter(k => !keys.includes(k));

    return el('div', { class: 'cfg-list cmd-env' },
        keys.map(k => el('div', { class: 'cmd-env-row' },
            el('input', {
                class: 'settings-text cmd-mono cmd-env-name', type: 'text', spellcheck: 'false',
                value: k, disabled: o.disabled || null,
                onchange: (e) => {
                    const next = e.target.value.trim();
                    if (next === k) return;
                    const was = env[k];
                    delete env[k];
                    if (next) env[next] = was;
                    cmdDirty();
                    renderSettings();
                },
            }),
            el('input', {
                class: 'settings-text cmd-env-value', type: 'text', spellcheck: 'false',
                value: env[k], disabled: o.disabled || null,
                oninput: (e) => { env[k] = e.target.value; cmdDirty(); },
            }),
            el('button', {
                class: 'cfg-list-x', type: 'button', disabled: o.disabled || null,
                'aria-label': `Remove ${k}`, title: 'Remove',
                onclick: () => { delete env[k]; cmdDirty(); renderSettings(); },
            }, '×'))),
        el('div', { class: 'cfg-list-add' },
            el('button', {
                class: 'linkish', type: 'button', disabled: o.disabled || null,
                onclick: () => {
                    if (!entry.env || typeof entry.env !== 'object') entry.env = {};
                    let name = 'NAME';
                    for (let n = 2; hasOwn(entry.env, name); n += 1) name = `NAME_${n}`;
                    entry.env[name] = '';
                    cmdDirty();
                    renderSettings();
                },
            }, 'Add a variable')),
        extra.length
            ? el('div', { class: 'cfg-inherit' },
                el('div', { class: 'cfg-inherit-head' },
                    `${extra.length} more from the shared file`),
                extra.map(k => el('div', { class: 'cfg-inherit-row', text: `${k}=${inherited[k]}` })),
                el('p', { class: 'cmd-field-note' },
                    'These add to yours rather than being replaced by them. The format has no '
                    + 'way to remove one here — only to give it a different value.'))
            : null);
}

/** What this command will actually run, here. */
function cmdPreview(entry, base) {
    const s = cmdCfgState();
    const ctx = s.data.context || {};
    const run = hasOwn(entry, 'run') ? entry.run : (base && base.run);
    if (!run) return null;
    const out = cmdExpand(run, ctx);
    if (out === String(run)) return null;
    return el('p', { class: 'cmd-preview' },
        el('span', { class: 'cmd-preview-lede', text: 'Here, that runs' }),
        el('code', { text: out }));
}

/**
 * Remove a command, with the snippets group's arm-in-place confirm.
 *
 * Reused rather than reimplemented, and not only for the look: that one arms
 * itself inside the button without a re-render, where a version driven from
 * `state` would rebuild the whole panel twice per click — and rebuilding this
 * panel throws away the focus and the caret of whatever field was being typed
 * into. A misclick here takes a button somebody uses out of the header.
 */
function cmdDeleteButton(i, editable) {
    const b = snipDeleteButton('Remove this command', () => {
        cmdDraft().splice(i, 1);
        cmdDirty();
        renderSettings();
    });
    if (!editable) b.disabled = true;
    return b;
}

// ── saving ─────────────────────────────────────────────────────────────────

function cmdFoot() {
    const foot = el('div', { class: 'cmd-foot' });
    cmdPaintFoot(foot);
    return foot;
}

function cmdPaintFoot(foot) {
    const s = cmdCfgState();
    const row = cmdCfgRow();
    const editable = cmdEditable();
    foot.replaceChildren(
        el('span', { class: `cmd-foot-note${s.problems ? ' bad' : ''}` },
            s.problems
                ? `${s.problems.length} ${s.problems.length === 1 ? 'problem' : 'problems'} — nothing was written.`
                : (s.dirty ? 'Edited — not saved.' : 'Matches the file on disk.')),
        el('div', { class: 'cmd-card-spacer' }),
        el('button', {
            class: 'btn quiet small', type: 'button', disabled: !s.dirty || null,
            onclick: () => { cmdClearDrafts(s); renderSettings(); },
        }, 'Revert'),
        el('button', {
            class: 'btn primary small', type: 'button',
            disabled: !editable || !s.dirty || s.saving || null,
            onclick: () => saveCmdConfig(),
        }, row && row.exists ? 'Save' : 'Create the file'));
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
    const card = el('section', { class: 'settings-group cfg-sub', id: 'set-g-commands-raw' },
        el('h3', { class: 'settings-group-title', text: 'The file itself' }));
    if (!row) {
        card.append(el('div', { class: 'cfg-list-none', text: 'No file for that scope.' }));
        return card;
    }

    const readonly = !cmdEditable();
    const onDisk = row.text === null
        ? `${JSON.stringify({ version: 1, commands: [] }, null, 2)}\n`
        : row.text;
    // A clean box is a *view* of the file rather than a draft of it, so it
    // reseeds whenever the file moves. `dirty` is the thing that means somebody
    // typed here, and it is the only thing that should stop this.
    if (s.raw === null || !s.rawDirty) s.raw = onDisk;

    const note = el('div', { class: `cfg-json-note${s.jsonError ? ' bad' : ''}` },
        s.jsonError || (s.rawDirty ? 'Edited — not saved.' : 'Matches the file on disk.'));
    const save = el('button', {
        class: 'btn primary small', type: 'button',
        disabled: readonly || !s.rawDirty || s.saving || null,
        onclick: () => saveCmdText(),
    }, row.exists ? 'Save' : 'Create the file');

    card.append(
        el('textarea', {
            class: 'cfg-json', spellcheck: 'false', autocapitalize: 'off',
            autocorrect: 'off', disabled: readonly || null,
            // Parsed on every keystroke rather than on save: the point of the
            // message is to be there while the mistake is still on screen.
            oninput: (e) => {
                s.raw = e.target.value;
                s.rawDirty = s.raw !== onDisk;
                s.jsonError = null;
                if (s.raw.trim()) {
                    try { JSON.parse(s.raw); }
                    catch (err) { s.jsonError = err.message; }
                }
                note.className = `cfg-json-note${s.jsonError ? ' bad' : ''}`;
                note.textContent = s.jsonError
                    || (s.rawDirty ? 'Edited — not saved.' : 'Matches the file on disk.');
                save.disabled = readonly || !s.rawDirty || !!s.jsonError;
            },
        }, s.raw),
        el('div', { class: 'cmd-foot' }, note, el('div', { class: 'cmd-card-spacer' }),
            el('button', {
                class: 'btn quiet small', type: 'button', disabled: !s.rawDirty || null,
                onclick: () => { cmdClearDrafts(s); renderSettings(); },
            }, 'Revert'),
            save));
    return card;
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
