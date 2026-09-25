// The Claude Code group: `~/.claude/settings.json` and a project's own, drawn as
// controls where the app knows the key and as JSON where it does not. The hooks
// editor inside it is hooks.js. Moved out of app.js as it was.
//
// Imports from app.js, which imports this — safe because nothing here reads an
// app.js binding while the module evaluates, only when a function is called.
// Keep it that way: a module-level `const` built from an app.js `const` throws,
// because every module under web/settings/ evaluates before app.js's body runs.

import { get, put } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { shortPath } from '../format.js';
import { cvSettingsNote } from '../quota.js';
import { state } from '../state.js';
import { flashNode, grow } from '../app.js';
import { claudeHooksRow, hkClearDraft } from './hooks.js';
import { renderSettings, settingsProject } from './index.js';

// ── Claude Code's own settings ───────────────────────────────────────────
//
// The group above this one edits `~/.tgxcode/settings.json`, which this app
// defines. This one edits `~/.claude/settings.json` and its project siblings,
// which it does not — and almost every difference in the code below follows
// from that one fact.
//
// **The file is drawn, not the catalogue.** `bridge/claude-schema.js` says how
// to render the keys it has heard of; everything else in the file still appears,
// as a generic control when it holds a scalar and as a read-only row with an
// *Edit as JSON* button when it does not. A settings page that quietly omitted
// a permission rule it did not recognise would be worse than no page at all,
// and that is exactly what iterating our own catalogue would do.
//
// **Nothing here is authoritative about precedence.** The bridge computes a
// merged reading and says so; the page repeats the caveat rather than hiding
// it. One consequence is visible in the UI: `permissions.allow`, `deny` and
// `ask` *add up* across files instead of overriding, so the "Overridden by …"
// sentence the group above draws must never appear over them. What they get
// instead is a count of what this scope sets and what it inherits.
//
// **This group has its own scope tabs**, and leaves the page's scope selector
// alone. That selector means "which of *our* three files"; Claude Code's chain
// is four files including one nobody can write, and overloading one control
// would move every other group on the page when you touched this one.

/** The four rows of Claude Code's chain, named for a person. */
export const CLAUDE_SCOPES = {
    user: 'User',
    project: 'Project — shared',
    'project-local': 'Project — local',
    managed: 'Managed',
};

export function claudeState() {
    return state.claudeCfg;
}

/** The directory this group is about — the same one the page's selector picks. */
export function claudeDir() {
    return settingsProject();
}

/**
 * What the panel is currently showing, as `{dottedPath: json}`.
 *
 * Both halves of what a row draws, because either can move without the other:
 * `effective` is the value in force, which changes when a *stronger* file does,
 * and the target file's own `values` are what a control writes, which is what
 * changes when this scope's file does. A row that shows "set here, but
 * overridden" reads differently after either one.
 */
function claudeSnapshot(data) {
    if (!data) return null;
    const s = claudeState();
    const out = {};
    // The whole entry rather than its `value`: a `rules` key carries a per-file
    // breakdown the row draws, and a rule added to a second file that the first
    // already had moves the breakdown without moving the union.
    for (const [path_, eff] of Object.entries(data.effective || {})) {
        out[path_] = JSON.stringify(eff);
    }
    const target = (data.files || []).find(f => f.scope === s.scope);
    for (const [path_, value] of Object.entries((target && target.values) || {})) {
        out[path_] = `${out[path_] || ''}|own:${JSON.stringify(value)}`;
    }
    return out;
}

/**
 * Point at what moved.
 *
 * A reload that arrives because somebody else wrote the file replaces controls
 * silently, and a checkbox that is suddenly the other way round reads as a
 * misremembering rather than as news. So the rows whose value actually changed
 * are flashed — the same affordance a jump into the transcript uses, and for
 * the same reason.
 */
function claudeFlash(before, after) {
    if (!before || !after) return;
    for (const path_ of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[path_] === after[path_]) continue;
        const row = dom.setBody
            && dom.setBody.querySelector(`.settings-row[data-path="${CSS.escape(path_)}"]`);
        if (row) flashNode(row);
    }
}

/**
 * @param {{flash?: boolean}} [opts] `flash` points at the rows that changed,
 *   which only makes sense when the reload was somebody else's doing: a save
 *   from this window has its own toast, and opening the panel has nothing to
 *   have changed *from*.
 */
export async function loadClaudeConfig({ flash = false } = {}) {
    const s = claudeState();
    if (s.loading) return;
    const before = flash ? claudeSnapshot(s.data) : null;
    s.loading = true;
    s.error = null;
    renderSettings();
    try {
        const dir = claudeDir();
        s.data = await get(`/api/claude-config${dir ? `?cwd=${encodeURIComponent(dir)}` : ''}`);
        // A clean hooks draft reseeds from what was just read; a dirty one is
        // kept, and draws its own banner if the file moved under it. The same
        // rule loadCmdConfig() spells out, for the same bug.
        if (!s.hooksDirty) hkClearDraft(s);
        // A scope the current directory does not offer — Project with no
        // project — would leave every control disabled with no way back, so
        // fall to the one row that always exists.
        if (!claudeTargetRow()) s.scope = 'user';
    } catch (err) {
        s.data = null;
        s.error = err.message;
    }
    s.loading = false;
    renderSettings();
    if (flash) claudeFlash(before, claudeSnapshot(s.data));
}

/** The file the current scope writes, out of what the bridge reported. */
export function claudeTargetRow() {
    const s = claudeState();
    if (!s.data) return null;
    return s.data.files.find(f => f.scope === s.scope && f.target) || null;
}

/**
 * Save one path, and take the answer rather than assuming it.
 *
 * `stamp` goes with anything that replaces a whole collection, because
 * `permissions.allow` is one key holding twenty-eight rules and `claude`
 * appends to that list itself. A `409` is not an error to apologise for — it
 * is the page finding out it was about to drop somebody's rule — so it gets a
 * banner and a reload rather than a toast that scrolls away.
 */
async function saveClaudePath(path, value, { collection = false } = {}) {
    const s = claudeState();
    const row = claudeTargetRow();
    if (!row) return;
    s.saving = true;
    renderSettings();
    try {
        const body = { scope: s.scope, cwd: claudeDir(), patch: { [path]: value } };
        if (collection) body.stamp = row.stamp;
        const answer = await put('/api/claude-config', body);
        s.data = answer.config;
        s.stale = null;
        toast(claudeSavedNote(path), 'ok');
    } catch (err) {
        if (err.status === 409) {
            s.stale = err.data && err.data.text ? { text: err.data.text } : { text: null };
            await loadClaudeConfig();
        } else {
            toast(`Could not save that: ${err.message}`, 'error');
        }
    }
    s.saving = false;
    renderSettings();
}

/**
 * What to say after a save landed.
 *
 * Not "Saved" — the thing worth saying is that it has not reached anything yet.
 * Claude Code reads these files when a session starts, so the change is real
 * and invisible until one does, and "I changed it and nothing happened" is the
 * question this sentence exists to answer before it is asked.
 */
export function claudeSavedNote(path) {
    const running = claudeState().data && claudeState().data.running;
    const where = `${path} saved.`;
    if (running) {
        return `${where} ${running} session${running === 1 ? '' : 's'} already running `
            + 'will not see it — new ones will.';
    }
    return `${where} It applies to sessions started from now on.`;
}

/** The raw JSON tab's save. Always stamped: it replaces keys nobody looked at. */
async function saveClaudeText() {
    const s = claudeState();
    const row = claudeTargetRow();
    if (!row || s.draft === null) return;
    s.saving = true;
    renderSettings();
    try {
        const answer = await put('/api/claude-config', {
            scope: s.scope, cwd: claudeDir(), stamp: row.stamp, text: s.draft,
        });
        s.data = answer.config;
        s.draft = null;
        s.dirty = false;
        s.stale = null;
        s.jsonError = null;
        toast(`${shortPath(answer.file)} written.`, 'ok');
    } catch (err) {
        if (err.status === 409) {
            // The draft is kept. Losing what somebody typed in order to show
            // them what somebody else typed is the one unforgivable move here.
            s.stale = { text: (err.data && err.data.text) || null };
            toast('That file changed on disk. Your draft is kept — compare and save again.', 'warn');
            const keep = s.draft;
            await loadClaudeConfig();
            s.draft = keep;
            s.dirty = true;
        } else if (err.data && err.data.code === 'json') {
            s.jsonError = err.message;
        } else {
            toast(`Could not save that file: ${err.message}`, 'error');
        }
    }
    s.saving = false;
    renderSettings();
}

/**
 * The whole group.
 *
 * Returns an array so it can be several cards under one contents entry: nine
 * catalogue groups, the keys the catalogue does not model, and the raw tab.
 */
export function renderClaudeConfig() {
    const s = claudeState();
    const head = el('section', { class: 'settings-group', id: 'set-g-claude' },
        el('h2', { class: 'settings-group-title', text: 'Claude Code' }),
        el('p', { class: 'settings-group-note' },
            'The settings ', el('code', { text: 'claude' }), ' itself reads — not this '
            + 'app’s. Everything in these files is here, including keys this page has no '
            + 'control for; what it does not recognise it shows rather than hides.'),
        claudeScopeTabs(),
        claudeFileLine(),
        claudeReachNote());

    if (s.error) {
        head.append(el('div', { class: 'settings-error' },
            `Could not read Claude Code’s settings: ${s.error}`));
        return [head];
    }
    if (!s.data) {
        head.append(el('div', { class: 'settings-empty', text: 'Reading…' }));
        return [head];
    }
    if (s.stale) head.append(claudeStaleBanner());

    const cards = [head];
    if (s.tab === 'raw') {
        cards.push(claudeRawCard());
        return cards;
    }
    for (const group of s.data.catalogue) {
        const card = el('section', { class: 'settings-group cfg-sub', id: `set-g-claude-${group.key}` },
            el('h3', { class: 'settings-group-title', text: group.title }),
            group.note ? el('p', { class: 'settings-group-note', text: group.note }) : null);
        for (const row of group.rows) card.append(claudeRow(row));
        cards.push(card);
    }
    cards.push(claudeUnknownCard());
    return cards;
}

/** Which of the four files this group is looking at. */
function claudeScopeTabs() {
    const s = claudeState();
    const rows = s.data ? s.data.files : [];
    return el('div', { class: 'cfg-tabs', role: 'tablist' },
        rows.map((f) => el('button', {
            class: `cfg-tab${f.scope === s.scope ? ' on' : ''}`,
            type: 'button', role: 'tab',
            'aria-selected': f.scope === s.scope ? 'true' : 'false',
            // A row nothing can write is still worth opening — it is the answer
            // to "why is this not what I set?" — so Managed is selectable and
            // read-only rather than absent.
            title: f.readonly ? 'An administrator’s file — read-only' : f.file,
            onclick: () => {
                if (f.scope === s.scope || !claudeMayLeave()) return;
                s.scope = f.scope;
                s.stale = null;
                // A clean draft too: it was seeded from the other file, and
                // drawing it here would show that file's hooks under this tab.
                s.draft = null;
                hkClearDraft(s);
                renderSettings();
            },
        },
        CLAUDE_SCOPES[f.scope],
        !f.exists ? el('span', { class: 'cfg-tab-tag', text: 'none' }) : null,
        f.readonly ? el('span', { class: 'cfg-tab-tag', text: 'read-only' }) : null)),
        el('div', { class: 'cfg-tabs-spacer' }),
        el('button', {
            class: `cfg-tab${s.tab === 'form' ? ' on' : ''}`, type: 'button',
            onclick: () => { s.tab = 'form'; renderSettings(); },
        }, 'Controls'),
        el('button', {
            class: `cfg-tab${s.tab === 'raw' ? ' on' : ''}`, type: 'button',
            onclick: () => {
                s.tab = 'raw';
                // Always re-read on the way in, so a draft never starts from
                // text that was true ten minutes ago.
                loadClaudeConfig().then(() => { s.tab = 'raw'; renderSettings(); });
            },
        }, 'JSON'));
}

/** The path being written, and everything true about it that is worth saying. */
function claudeFileLine() {
    const row = claudeTargetRow();
    const s = claudeState();
    const readonly = s.data && s.data.files.find(f => f.scope === s.scope && f.readonly);
    const line = el('div', { class: 'settings-file' });

    if (readonly) {
        line.append(
            el('span', { class: 'settings-file-lede', text: 'Reading' }),
            el('button', {
                class: 'settings-file-path', type: 'button', title: 'Copy this path',
                onclick: () => copyPath(readonly.file),
            }, readonly.file),
            el('span', { class: 'settings-file-tag' },
                readonly.exists ? 'an administrator’s — read-only' : 'not present on this machine'));
        return line;
    }
    if (!row) {
        line.append(el('span', { class: 'settings-file-none' },
            'No file for that scope — pick a project above.'));
        return line;
    }
    // Filtered rather than passed through, because `append` stringifies a
    // `false` into the literal word where el()'s own children skip it — the
    // same trap paintSettingsFile() names a few hundred lines up.
    line.append(...[
        el('span', { class: 'settings-file-lede', text: 'Writing to' }),
        el('button', {
            class: 'settings-file-path', type: 'button', title: 'Copy this path',
            onclick: () => copyPath(row.file),
        }, row.file),
        !row.exists && el('span', { class: 'settings-file-tag', text: 'will be created' }),
        row.symlink
            && el('span', { class: 'settings-file-tag bad', text: 'a symlink — saving is refused' }),
        row.exists && !row.parsed && !row.symlink
            && el('span', { class: 'settings-file-tag bad', text: 'does not parse — use the JSON tab' }),
        !row.writable && !row.symlink
            && el('span', { class: 'settings-file-tag bad', text: 'not writable' }),
        claudeState().saving && el('span', { class: 'settings-file-tag', text: 'saving…' }),
    ].filter(Boolean));

    // Whether the local file is really private, answered by git rather than by
    // hoping. A global excludes file counts, and a repository that relies on
    // one is a repository a colleague's clone has no protection for.
    if (row.scope === 'project-local') {
        line.append(row.ignored
            ? el('span', { class: 'settings-file-tag', title: `ignored by ${row.ignoredBy}` },
                'gitignored')
            : el('span', { class: 'settings-file-tag bad' },
                'not gitignored — this file would be committed'));
    }
    return line;
}

export const copyPath = (file) => navigator.clipboard.writeText(file)
    .then(() => toast('Path copied.'))
    .catch(() => toast('Could not copy that path.', 'error'));

/**
 * The sentence that stops "I changed it and nothing happened".
 *
 * Permanent, and above the controls rather than in a toast, because it is a
 * fact about the whole group rather than about one save.
 */
function claudeReachNote() {
    const s = claudeState();
    const running = (s.data && s.data.running) || 0;
    return el('p', { class: 'cfg-reach' },
        el('strong', { text: 'Claude Code reads these when a session starts.' }),
        ' A change here applies to sessions you start from now on',
        running
            ? ` — the ${running} already running will not see it.`
            : '.',
        s.scope === 'project-local'
            ? el('span', { class: 'cfg-reach-more' },
                ' Claude Code appends to this file itself every time you approve a '
                + 'permission, so it changes under you.')
            : null);
}

/** A conflict, kept on screen rather than thrown at a toast. */
function claudeStaleBanner() {
    const s = claudeState();
    return el('div', { class: 'cfg-stale' },
        el('div', { class: 'cfg-stale-head' }, 'This file changed on disk since the page read it.'),
        el('p', null, 'Nothing was overwritten. Claude Code writes these files too — a '
            + 'permission you approved, or a theme you changed in a session. What is below '
            + 'is the file as it is now.'),
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

/**
 * One catalogued key.
 *
 * The three sentences that make a row honest, and the one this group must not
 * borrow from the group above: for a `rules` list, "overridden" is wrong —
 * those add up — so it says what this scope sets and what it inherits instead.
 */
function claudeRow(row) {
    if (row.kind === 'hooks') return claudeHooksRow(row);
    const s = claudeState();
    const target = claudeTargetRow();
    const readonlyRow = !target;
    const values = readonlyRow
        ? (s.data.files.find(f => f.scope === s.scope) || { values: {} }).values
        : target.values;
    const explicit = values[row.path] !== undefined;
    const eff = s.data.effective[row.path];

    // A scalar control shows what is *in force*, because writing it writes one
    // key and the inherited value is the honest starting point.
    //
    // A list control must not. It edits this file's own entries and nothing
    // else — because a list is written whole, so seeding it with what is in
    // force means the first "add one rule" copies every inherited rule into
    // this file as well. That is not a hypothetical: it is what the first
    // version of this did, and adding one rule at the local scope wrote
    // twenty-eight of the user's own rules into a repository's file.
    // The same argument covers a map: `enabledPlugins` and `env` are single
    // keys holding many entries, so writing the merged map would copy every
    // inherited entry into this file alongside the one that changed.
    const isList = row.kind === 'rules' || row.kind === 'strings';
    const isMap = row.kind === 'map-bool' || row.kind === 'map-string';
    const own = explicit ? values[row.path] : (isList ? [] : {});
    const value = (isList || isMap)
        ? own
        : (explicit ? values[row.path] : (eff ? eff.value : undefined));

    const disabled = readonlyRow || !target.writable || target.symlink
        || (target.exists && !target.parsed);

    const merged = !!(eff && eff.merged);
    const inheritedCount = merged
        ? eff.from.filter(f => f.scope !== s.scope).reduce((n, f) => n + f.count, 0)
        : 0;
    const overridden = !merged && !!(eff && explicit && target && eff.file !== target.file);

    const save = (v, opts) => saveClaudePath(row.path, v, opts);

    const text = el('div', { class: 'settings-row-text' },
        el('div', { class: 'settings-row-label' },
            row.label,
            el('code', { class: 'cfg-path', text: row.path })),
        row.note ? el('div', { class: 'settings-row-note', text: row.note }) : null,
        // What the channel is currently delivering. See paintCvSettingsNote().
        row.path === 'autoUpdatesChannel' ? cvSettingsNote() : null,
        row.hint === 'user' && s.scope !== 'user'
            ? el('div', { class: 'settings-row-note' },
                'Normally set for you alone rather than checked into a repository.')
            : null,
        overridden
            ? el('div', { class: 'settings-row-warn' },
                `Overridden by ${CLAUDE_SCOPES[eff.scope]} — `,
                el('code', { text: shortPath(eff.file) }),
                ' wins, so this has no effect here.')
            : null,
        merged && inheritedCount
            ? el('div', { class: 'settings-row-note cfg-merged' },
                `These add up across files rather than overriding: ${inheritedCount} more `
                + `${inheritedCount === 1 ? 'rule is' : 'rules are'} in force from `
                + `${eff.from.filter(f => f.scope !== s.scope && f.count)
                    .map(f => CLAUDE_SCOPES[f.scope]).join(' and ')}.`)
            : null);

    const side = el('div', { class: 'settings-row-side' },
        explicit
            ? el('button', {
                class: 'linkish', type: 'button', disabled: disabled || null,
                title: 'Remove this key from this file',
                onclick: () => save(null, { collection: !isScalarValue(values[row.path]) }),
            }, 'Clear')
            : el('span', { class: 'settings-row-from',
                text: eff ? `from ${CLAUDE_SCOPES[eff.scope] || 'another file'}` : 'not set' }));

    // What the *other* files contribute, so a list can show it read-only
    // beside the entries this one owns.
    const inherited = eff && eff.merged
        ? eff.from.filter(f => f.scope !== s.scope && f.count)
        : [];
    // What is in force, for a control that has to *show* the merged answer
    // while writing only this file's half — which is every map: a plugin
    // enabled in the user file should read as enabled here, and unticking it
    // should write one key rather than twenty.
    const merged_ = eff ? eff.value : undefined;
    const control = claudeControl(row, value, disabled, save, explicit, inherited, merged_);
    // `data-path` is the only handle a row has: renderSettings() replaces the
    // whole body, so a value that moved underneath cannot be pointed at unless
    // the row it landed in can be found again. See claudeFlash().
    if (row.wide) {
        return el('div', { class: 'settings-row is-wide', 'data-path': row.path },
            el('div', { class: 'settings-row-head' }, text, side),
            el('div', { class: 'settings-row-wide' }, control));
    }
    return el('div', { class: 'settings-row', 'data-path': row.path },
        text,
        el('div', { class: 'settings-row-ctl' }, control, side));
}

const isScalarValue = (v) => v === null
    || ['boolean', 'number', 'string'].includes(typeof v);

/** The control for a catalogued kind. Every one of them saves on change. */
function claudeControl(row, value, disabled, save, explicit, inherited, merged) {
    switch (row.kind) {
        case 'bool':
            return el('label', { class: 'settings-check' },
                el('input', {
                    type: 'checkbox', checked: value === true || null,
                    disabled: disabled || null,
                    onchange: (e) => save(e.target.checked),
                }),
                el('span', { class: 'settings-box' }));

        case 'int':
            return el('input', {
                class: 'settings-num', type: 'number', value: value ?? '',
                min: row.min, max: row.max, disabled: disabled || null,
                onchange: (e) => {
                    const n = Number(e.target.value);
                    if (!Number.isInteger(n)) { renderSettings(); return; }
                    save(n);
                },
            });

        case 'string':
            return el('input', {
                class: 'settings-text', type: 'text', spellcheck: 'false',
                value: value == null ? '' : String(value),
                placeholder: 'not set', disabled: disabled || null,
                onchange: (e) => save(e.target.value.trim() || null),
            });

        case 'choice':
            return claudeChoice(row, value, disabled, save, explicit);

        case 'rules':
        case 'strings':
            return claudeList(row, Array.isArray(value) ? value : [], disabled, save, inherited);

        case 'map-bool':
            return claudeMapBool(row, value, disabled, save, merged);

        case 'map-string':
            return claudeMapString(row, value, disabled, save, merged);

        case 'statusline':
            return claudeStatusLine();

        default:
            return el('code', { class: 'cfg-raw-value', text: JSON.stringify(value) });
    }
}

/**
 * A select whose option list may not be the whole world.
 *
 * A value the catalogue has never heard of is added as an option and marked,
 * rather than being silently absent — which would leave the box showing some
 * *other* value and one careless change away from writing it. The key that
 * taught this is `askUserQuestionTimeout`, whose value on this machine is
 * `never`; a page that assumed a fixed list would have offered to replace it.
 */
function claudeChoice(row, value, disabled, save, explicit) {
    const options = [...row.options];
    const unlisted = value != null && !options.includes(value);
    return el('select', {
        class: 'settings-select', disabled: disabled || null,
        onchange: (e) => save(e.target.value || null),
    },
    !explicit ? el('option', { value: '', text: 'not set' }) : null,
    unlisted
        ? el('option', { value: String(value), selected: true },
            `${value} — not a value this page lists`)
        : null,
    options.map(v => el('option', {
        value: v, selected: v === value || null,
    }, v)));
}

/**
 * A list of opaque strings — permission rules, directories, model names.
 *
 * One row per entry rather than a textarea of lines, and the difference
 * matters: a textarea makes twenty-eight rules into one draft, where a single
 * bad paste replaces the lot. Per row, one delete is one write and one mistake
 * loses one rule.
 *
 * A row is a textarea because an entry is not always short — `autoMode.allow`
 * on this machine holds a seven-hundred-character paragraph — and the list is
 * never sorted, so the order in the file survives and a one-rule change stays
 * one line of diff.
 */
function claudeList(row, list, disabled, save, inherited = []) {
    const commit = (next) => save(next.length ? next : null, { collection: true });
    return el('div', { class: 'cfg-list' },
        list.length
            ? list.map((entry, i) => el('div', { class: 'cfg-list-row' },
                el('textarea', {
                    class: 'cfg-list-value', spellcheck: 'false', rows: 1,
                    disabled: disabled || null,
                    onfocus: (e) => grow(e.target, 26, 240),
                    oninput: (e) => grow(e.target, 26, 240),
                    onchange: (e) => {
                        const text = e.target.value.trim();
                        if (!text) { commit(list.filter((_, j) => j !== i)); return; }
                        if (text === entry) return;
                        if (list.includes(text)) {
                            toast('That entry is already in this list.', 'warn');
                            renderSettings();
                            return;
                        }
                        commit(list.map((v, j) => (j === i ? text : v)));
                    },
                }, entry),
                el('button', {
                    class: 'cfg-list-x', type: 'button', disabled: disabled || null,
                    'aria-label': `Remove ${entry}`, title: 'Remove',
                    onclick: () => commit(list.filter((_, j) => j !== i)),
                }, '×')))
            : el('div', { class: 'cfg-list-none', text: 'Nothing in this file.' }),

        // The other files' entries, read-only and attributed. Shown because
        // these lists add up rather than override, so "what is in force here"
        // is not answerable from one file — and reading it used to mean opening
        // two. Not editable from this scope: the row that owns an entry is the
        // row that may remove it.
        inherited.map(from => el('div', { class: 'cfg-inherit' },
            el('div', { class: 'cfg-inherit-head' },
                `${from.count} more from ${CLAUDE_SCOPES[from.scope]}`,
                el('code', { text: shortPath(from.file) })),
            // Guarded rather than assumed: a page served by one bridge and
            // still open when another restarts is routine here, and a missing
            // field should cost the entry list rather than the whole panel.
            (from.values || []).map(entry => el('div', {
                class: 'cfg-inherit-row', text: entry,
            })))),

        el('div', { class: 'cfg-list-add' },
            el('input', {
                class: 'settings-text is-long', type: 'text', spellcheck: 'false',
                placeholder: row.kind === 'rules' ? 'Bash(npm test)' : 'add an entry',
                disabled: disabled || null,
                onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
                onchange: (e) => {
                    const text = e.target.value.trim();
                    e.target.value = '';
                    if (!text) return;
                    if (list.includes(text)) {
                        toast('That entry is already in this list.', 'warn');
                        return;
                    }
                    // Appended, never inserted in sorted position: the file's
                    // order is somebody's and not ours to tidy.
                    commit([...list, text]);
                },
            })));
}

/**
 * A checkbox per name, over the union of the file and what is installed.
 *
 * The union is what makes this better than a text editor: a plugin this
 * machine has and the file has never mentioned is a row you can tick, rather
 * than a name you have to know how to spell.
 */
function claudeMapBool(row, own, disabled, save, merged) {
    const mine = asMap(own);
    const inForce = asMap(merged);
    const installed = claudeState().data.installedPlugins || [];
    const names = [...new Set([
        ...Object.keys(inForce).sort(),
        ...installed.filter(n => !(n in inForce)).sort(),
    ])];
    if (!names.length) {
        return el('div', { class: 'cfg-list-none', text: 'Nothing in this file, and nothing installed.' });
    }
    return el('div', { class: 'settings-groups' },
        names.map((name) => {
            const here = name in mine;
            return el('label', {
                // Ticked from what is *in force*, so a plugin the user file
                // enables reads as enabled at a project scope too. Written as
                // one key into this file's own map, so unticking it writes one
                // entry rather than a copy of every inherited one.
                class: `settings-group-pill${inForce[name] === true ? ' on' : ''}`,
                title: here
                    ? name
                    : `${name} — not set in this file${name in inForce ? ', inherited' : ', installed'}`,
            },
            el('input', {
                type: 'checkbox', checked: inForce[name] === true || null,
                disabled: disabled || null,
                onchange: (e) => save({ ...mine, [name]: e.target.checked }, { collection: true }),
            }),
            el('span', { class: 'settings-group-name', text: name }),
            !here ? el('span', { class: 'settings-group-count', text: 'inherited' }) : null);
        }));
}

const asMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Name and value rows — `env`, and anything else shaped like it. */
function claudeMapString(row, own, disabled, save, merged) {
    const map = asMap(own);
    const inForce = asMap(merged);
    // Entries another file owns. Read-only for the same reason an inherited
    // permission rule is: the row that owns it is the row that may remove it,
    // and an editable box that cannot delete would be a worse lie than a
    // dimmed one.
    const elsewhere = Object.keys(inForce).filter(n => !(n in map)).sort();
    const names = Object.keys(map);
    const commit = (next) => save(Object.keys(next).length ? next : null, { collection: true });
    return el('div', { class: 'cfg-kv' },
        names.length || elsewhere.length
            ? names.map(name => el('div', { class: 'cfg-kv-row' },
                el('code', { class: 'cfg-kv-name', text: name }),
                el('input', {
                    class: 'settings-text is-long', type: 'text', spellcheck: 'false',
                    value: map[name], disabled: disabled || null,
                    onchange: (e) => commit({ ...map, [name]: e.target.value }),
                }),
                el('button', {
                    class: 'cfg-list-x', type: 'button', disabled: disabled || null,
                    'aria-label': `Remove ${name}`, title: 'Remove',
                    onclick: () => {
                        const next = { ...map };
                        delete next[name];
                        commit(next);
                    },
                }, '×')))
            : el('div', { class: 'cfg-list-none', text: 'Nothing in this file.' }),
        elsewhere.length
            ? el('div', { class: 'cfg-inherit' },
                el('div', { class: 'cfg-inherit-head' },
                    `${elsewhere.length} more in force from another file`),
                elsewhere.map(name => el('div', { class: 'cfg-inherit-row' },
                    `${name} = ${inForce[name]}`)))
            : null,
        el('div', { class: 'cfg-kv-add' },
            el('input', { class: 'settings-text cfg-kv-newname', type: 'text',
                placeholder: 'NAME', spellcheck: 'false', disabled: disabled || null }),
            el('input', { class: 'settings-text is-long cfg-kv-newvalue', type: 'text',
                placeholder: 'value', spellcheck: 'false', disabled: disabled || null }),
            el('button', {
                class: 'dash-btn', type: 'button', disabled: disabled || null,
                onclick: (e) => {
                    const wrap = e.target.closest('.cfg-kv-add');
                    const name = wrap.querySelector('.cfg-kv-newname').value.trim();
                    const val = wrap.querySelector('.cfg-kv-newvalue').value;
                    if (!name) return;
                    commit({ ...map, [name]: val });
                },
            }, 'Add')));
}

/** Nothing typed on this group, or the user said to drop it. */
export function claudeMayLeave() {
    const s = claudeState();
    if (!s.dirty && !s.hooksDirty) return true;
    const what = s.hooksDirty && s.dirty ? 'the JSON and the hooks you have edited'
        : (s.hooksDirty ? 'the hooks you have edited' : 'the JSON you have edited');
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Discard ${what}?`)) return false;
    s.draft = null;
    s.dirty = false;
    s.jsonError = null;
    hkClearDraft(s);
    return true;
}

/**
 * The status line, and whose it is.
 *
 * Read-only when it is the one `scripts/install-quota-statusline.js` wrote,
 * because that script exists precisely to avoid clobbering somebody's
 * deliberate choice — and a text box here would reopen the hole from the other
 * side. The JSON tab still reaches it, which is the difference between making
 * something hard and making it impossible.
 */
function claudeStatusLine() {
    const line = claudeState().data.statusLine;
    if (!line) {
        return el('div', { class: 'cfg-list-none' },
            'No status line set. ', claudeJsonLink('statusLine', 'Add one as JSON'));
    }
    return el('div', { class: 'cfg-statusline' },
        el('code', { class: 'cfg-raw-value', text: line.command || JSON.stringify(line.value) }),
        line.ours
            ? el('p', { class: 'settings-row-note' },
                'This app installed this one, to harvest the quota percentages. ',
                el('code', { text: 'node scripts/install-quota-statusline.js --uninstall' }),
                ' takes it back out.')
            : el('p', { class: 'settings-row-note' },
                'Set outside this app. ', claudeJsonLink('statusLine', 'Edit as JSON')),
        el('div', { class: 'settings-row-from', text: `from ${CLAUDE_SCOPES[line.scope]}` }));
}

/** Jump to the JSON tab, at a key. */
export function claudeJsonLink(path, label) {
    return el('button', {
        class: 'linkish', type: 'button',
        onclick: () => {
            const s = claudeState();
            s.tab = 'raw';
            s.jumpTo = path;
            loadClaudeConfig().then(() => { s.tab = 'raw'; renderSettings(); });
        },
    }, label);
}

/**
 * Everything in the files this page has no control for.
 *
 * The most important card in the group, and the reason this feature is not
 * simply prefs.js pointed at another file. A scalar gets a control by JSON
 * type — which makes eight of the nineteen keys in this machine's file
 * editable without the app claiming to know what any of them mean — and
 * anything else gets a row and a way through to the JSON.
 */
function claudeUnknownCard() {
    const s = claudeState();
    const unknown = s.data.unknown || [];
    const card = el('section', { class: 'settings-group cfg-sub', id: 'set-g-claude-unknown' },
        el('h3', { class: 'settings-group-title', text: 'Also in these files' }),
        el('p', { class: 'settings-group-note' },
            'Keys this page has no control for. Claude Code adds settings faster than '
            + 'this app learns their names, so nothing here is hidden — a scalar gets a '
            + 'plain control by type, and anything larger opens in the JSON tab. Read '
            + 'against Claude Code ', el('code', { text: s.data.catalogueAgainst }), '.'));

    if (!unknown.length) {
        card.append(el('div', { class: 'cfg-list-none',
            text: 'Nothing — this page has a control for every key in these files.' }));
        return card;
    }

    const target = claudeTargetRow();
    for (const item of unknown) {
        const values = target ? target.values : {};
        const explicit = values[item.path] !== undefined;
        const disabled = !target || !target.writable || target.symlink
            || (target.exists && !target.parsed);
        const value = explicit ? values[item.path] : undefined;

        const text = el('div', { class: 'settings-row-text' },
            el('div', { class: 'settings-row-label' }, el('code', { text: item.path })),
            el('div', { class: 'settings-row-note' },
                explicit ? 'Set in this file.' : `Set in ${CLAUDE_SCOPES[item.scope]}.`,
                ' ', el('code', { class: 'cfg-raw-value', text: item.preview })));

        let control;
        if (item.kind === 'scalar' && explicit) {
            control = claudeGenericControl(item, value, disabled);
        } else if (item.kind === 'scalar') {
            control = el('span', { class: 'settings-row-from',
                text: 'inherited — open the file that sets it to change it' });
        } else {
            control = claudeJsonLink(item.path, 'Edit as JSON');
        }

        card.append(el('div', { class: 'settings-row', 'data-path': item.path },
            text,
            el('div', { class: 'settings-row-ctl' },
                control,
                explicit && item.kind === 'scalar'
                    ? el('button', {
                        class: 'linkish', type: 'button', disabled: disabled || null,
                        onclick: () => saveClaudePath(item.path, null),
                    }, 'Clear')
                    : null)));
    }
    return card;
}

/**
 * A control for a key nobody catalogued, chosen by what the value already is.
 *
 * The type is a constraint rather than a guess: the bridge refuses a write that
 * changes it, so a checkbox cannot turn `false` into the string `"false"`. That
 * is the whole safety argument for offering these at all.
 */
function claudeGenericControl(item, value, disabled) {
    const save = (v) => saveClaudePath(item.path, v);
    if (item.type === 'boolean') {
        return el('label', { class: 'settings-check' },
            el('input', {
                type: 'checkbox', checked: value === true || null, disabled: disabled || null,
                onchange: (e) => save(e.target.checked),
            }),
            el('span', { class: 'settings-box' }));
    }
    if (item.type === 'number') {
        return el('input', {
            class: 'settings-num', type: 'number', value: value ?? '',
            disabled: disabled || null,
            onchange: (e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n)) { renderSettings(); return; }
                save(n);
            },
        });
    }
    return el('input', {
        class: 'settings-text', type: 'text', spellcheck: 'false',
        value: value == null ? '' : String(value), disabled: disabled || null,
        onchange: (e) => save(e.target.value),
    });
}

/**
 * The file itself, in a text box.
 *
 * The only thing in the app that can repair a settings file that no longer
 * parses, and the only way to reach a key the catalogue does not model. So it
 * is not a fallback bolted on later — it is what makes the rest of the group
 * honest, because with it here nothing in these files is beyond reach.
 *
 * A textarea rather than a vendored editor. `web/vendor/` shows that vendoring
 * is possible, and a few hundred kilobytes of code editor with no build step to
 * prune it, to edit a four-kilobyte JSON file, is a poor trade. What a real
 * editor would have earned — knowing where the syntax error is — is a
 * `JSON.parse` and the offset it reports.
 *
 * **This one has a Save button**, unlike every other control on the page. The
 * page's no-drafts rule exists so a control cannot disagree with what is in
 * force; a document being typed into is a draft by nature, and saving it per
 * keystroke would write broken JSON forty times a minute.
 */
function claudeRawCard() {
    const s = claudeState();
    const row = claudeTargetRow()
        || s.data.files.find(f => f.scope === s.scope)
        || null;
    const card = el('section', { class: 'settings-group cfg-sub', id: 'set-g-claude-raw' },
        el('h3', { class: 'settings-group-title', text: 'The file itself' }));

    if (!row) {
        card.append(el('div', { class: 'cfg-list-none', text: 'No file for that scope.' }));
        return card;
    }

    const readonly = !!row.readonly || !row.writable || row.symlink;
    const onDisk = row.text === null ? '' : row.text;
    // A clean box is a *view* of the file, not a draft of it, so it re-seeds
    // whenever the file moves. Keying that off `draft === null` instead was
    // wrong in both directions once these files started changing underneath:
    // loadClaudeConfig() renders twice, and the first of those — still holding
    // the old answer — put the old text back before the new one arrived, so a
    // clean JSON tab went on showing the previous contents under the note
    // "Matches the file on disk." `dirty` is the thing that actually means
    // "somebody typed here", and it is the only thing that should stop this.
    if (s.draft === null || !s.dirty) s.draft = onDisk;

    const note = el('div', { class: `cfg-json-note${s.jsonError ? ' bad' : ''}` },
        s.jsonError || (s.dirty ? 'Edited — not saved.' : 'Matches the file on disk.'));

    const box = el('textarea', {
        class: 'cfg-json', spellcheck: 'false', autocapitalize: 'off',
        autocorrect: 'off', disabled: readonly || null,
        // A parse on every keystroke rather than on save: the point of the
        // message is to be there while the mistake is still on screen. Silent
        // on an empty box, the way describeCronSoon() is on a half-typed cron.
        oninput: (e) => {
            s.draft = e.target.value;
            s.dirty = s.draft !== onDisk;
            const text = s.draft.trim();
            if (!text) { s.jsonError = null; }
            else {
                try {
                    const doc = JSON.parse(text);
                    s.jsonError = (doc && typeof doc === 'object' && !Array.isArray(doc))
                        ? null : 'The document has to be a JSON object.';
                } catch (err) { s.jsonError = err.message; }
            }
            note.className = `cfg-json-note${s.jsonError ? ' bad' : ''}`;
            note.textContent = s.jsonError
                || (s.dirty ? 'Edited — not saved.' : 'Matches the file on disk.');
            saveBtn.disabled = readonly || !s.dirty || !!s.jsonError;
            grow(e.target, 220, 900);
        },
    }, s.draft);

    const saveBtn = el('button', {
        class: 'dash-btn', type: 'button',
        disabled: readonly || !s.dirty || !!s.jsonError || null,
        onclick: () => saveClaudeText(),
    }, 'Save the file');

    card.append(
        el('p', { class: 'settings-group-note' },
            readonly
                ? 'Read-only.'
                : 'Saved whole, and re-indented to two spaces on the way — so a '
                + 'hand-formatted file comes back formatted like the ones Claude Code '
                + 'writes. Keys keep their order.'),
        box,
        el('div', { class: 'cfg-json-foot' },
            note,
            el('div', { class: 'cfg-json-acts' },
                s.dirty
                    ? el('button', {
                        class: 'linkish', type: 'button',
                        onclick: () => {
                            s.draft = onDisk;
                            s.dirty = false;
                            s.jsonError = null;
                            renderSettings();
                        },
                    }, 'Discard changes')
                    : null,
                saveBtn)));

    // Requested by an Edit as JSON button. Scrolling to the key beats dropping
    // somebody into four thousand characters with no idea where to look.
    if (s.jumpTo) {
        const at = onDisk.indexOf(`"${s.jumpTo.split('.')[0]}"`);
        s.jumpTo = null;
        if (at >= 0) {
            setTimeout(() => {
                box.focus();
                box.setSelectionRange(at, at);
                // Roughly: line height times the lines before it.
                box.scrollTop = onDisk.slice(0, at).split('\n').length * 18 - 60;
            }, 0);
        }
    }
    return card;
}
