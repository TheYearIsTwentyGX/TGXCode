// The hooks editor: a draft of one settings file's `hooks` block, its review,
// and the save. Drawn on the Hooks page (page.js), which owns the state it
// reads — `state.hooks` — and the redraw it calls.
//
// It used to be a row inside Settings › Claude Code (web/settings/hooks.js),
// sharing `state.claudeCfg` with the rest of that group and redrawing the whole
// panel on every structural change. The move kept the editor as it was and cut
// those two ties: the draft lives in `state.hooks`, so there is only ever one
// of it, and renderHooks() redraws the page rather than a panel that is
// probably closed — renderHooks() returns early when it is, which is why a
// lift-and-mount would have looked fine and then silently stopped redrawing.
//
// What the editor decided, unchanged by the move:
//
// - **A keystroke redraws the editor, not the page.** hkDirtied() marks the
//   draft edited and asks HooksEditor to redraw itself — the footer, the
//   problem marks and the review are all drawn from state. A structural change
//   (a hook added, moved or removed) still goes through renderHooks.
// - **The draft's boxes are uncontrolled**, keyed by the hook's `_k`, its type
//   and the field. Several of them normalise what is typed — a timeout of `0`
//   is dropped, `a, ` becomes `["a"]`, half-typed JSON is not applied — so a
//   controlled value would fight the typing. Reseeding the draft mints new
//   `_k`s, which remounts every box from what was read.
// - **Events, groups and hooks are keyed by `_k`**, so moving one moves its
//   nodes, focus and all.
//
// Imports from page.js, which imports this — safe because nothing here reads a
// page.js binding while the module evaluates, only when a function is called.

import { html, useState } from '../vendor/preact.js';
import { put } from '../api.js';
import { toast } from '../dom.js';
import { shortPath } from '../format.js';
import { icon } from '../boards/parts.js';
import { DeleteButton } from '../snippets/settings.js';
import { grow } from '../composer/send.js';
import { CLAUDE_SCOPES } from '../settings/claude-config.js';
import { foldLabelV, isOpen, setFold } from '../settings/fold.js';
import { clone, hasOwn } from '../settings/project-commands.js';
import { hkJsonLink, hkState, hkTargetRow, loadHooks, renderHooks } from './page.js';
import { ScriptPane, scriptToggle } from './script.js';

// ── the hooks editor ───────────────────────────────────────────────────────
//
// The one control for Claude Code's settings that is a draft rather than
// save-on-change: a hook `command` is an arbitrary shell string run on every
// matching event. A half-typed one reaching disk is a hook that fires, so
// nothing is written until Save — and Save shows what will run before it
// writes it. That review step is what reversed the old decision to keep this
// read-only (docs/plans/20-claude-config.md): the JSON tab could always write
// hooks, so a form adds no capability, only a better place to read one before
// arming it.
//
// Seeded from the target file's own `hooks` and never from anything merged.
// Hooks from every scope all run, so copying the user's hooks into a project
// file would make each of them fire twice.

let hkKeySeq = 0;
export const hkKey = () => (hkKeySeq += 1);

/** The file whose hooks the editor is showing — the target, or Managed read-only. */
function hkFileRow() {
    const s = hkState();
    return hkTargetRow() || (s.data && s.data.files.find(f => f.scope === s.scope)) || null;
}

/** The hooks block as the file has it, or undefined. */
const hkOnDisk = () => {
    const row = hkFileRow();
    return row && row.values ? row.values.hooks : undefined;
};

/**
 * The draft: events in file order, each with its groups and hooks keyed so a
 * card keeps its identity while rows move. Every field the file has is carried
 * on the object as it is — including ones this page has no control for — and
 * only `_k` and `_script` are ours, stripped by hkForWire().
 */
export function hkDraft() {
    const s = hkState();
    if (s.hooksDraft === null) {
        const block = hkOnDisk();
        const scripts = new Map();
        for (const h of (s.data.hooks || [])) {
            if (h.scope === s.scope) scripts.set(`${h.event}|${h.index.group}|${h.index.hook}`, h.script);
        }
        s.hooksSeed = JSON.stringify(block === undefined ? null : block);
        s.hooksDraft = isPlainObj(block)
            ? Object.entries(block).map(([event, groups]) => ({
                _k: hkKey(),
                event,
                groups: (Array.isArray(groups) ? groups : []).map((g, gi) => ({
                    ...(isPlainObj(g) ? g : {}),
                    _k: hkKey(),
                    hooks: (isPlainObj(g) && Array.isArray(g.hooks) ? g.hooks : []).map((h, hi) => ({
                        ...(isPlainObj(h) ? h : {}),
                        _k: hkKey(),
                        _script: scripts.get(`${event}|${gi}|${hi}`) || null,
                    })),
                })),
            }))
            : [];
    }
    return s.hooksDraft;
}

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The draft as the file will hold it, or `null` for "no hooks here at all". */
function hkForWire() {
    const out = {};
    for (const ev of hkDraft()) {
        const groups = ev.groups.map((g) => {
            const { _k, ...rest } = g;
            return {
                ...rest,
                hooks: g.hooks.map(({ _k: _a, _script: _b, ...h }) => h),
            };
        }).filter(g => g.hooks.length);
        if (groups.length) out[ev.event] = groups;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * How the editor redraws itself — set by HooksEditor each time it draws. Until
 * it has drawn there is nothing of its to redraw, so the fallback is the page.
 */
let hkRedraw = () => renderHooks();

/**
 * Mark the draft edited, and redraw the editor. Only the editor: the rail and
 * the head have nothing that depends on a keystroke, and a keystroke should
 * cost a diff of the editor, not of the page.
 */
export function hkDirtied() {
    hkMark();
    hkRedraw();
}

/** Structural change: the draft moved, so the page is redrawn — the rail counts it. */
export function hkChanged() {
    hkMark();
    renderHooks();
}

function hkMark() {
    const s = hkState();
    s.hooksDirty = true;
    s.hooksReview = false;
    // The problems belong to the draft that was checked, not this one.
    s.hooksProblems = null;
}

export function hkClearDraft(s) {
    s.hooksDraft = null;
    s.hooksDirty = false;
    s.hooksReview = false;
    s.hooksProblems = null;
    s.hooksSeed = null;
}

/** Has this file's hooks block moved since the draft was seeded from it? */
function hkIsStale() {
    const s = hkState();
    if (!s.hooksDirty || s.hooksSeed === null) return false;
    const onDisk = hkOnDisk();
    return JSON.stringify(onDisk === undefined ? null : onDisk) !== s.hooksSeed;
}

const hkEventInfo = (name) => (hkState().data.hookEvents || []).find(e => e.name === name) || null;
const hkTypeInfo = (type) => (hkState().data.hookTypes || []).find(t => t.type === type) || null;

/** What a hook does, in one line — the same field the bridge's summary picks. */
function hkTarget(h) {
    let text = '';
    if (typeof h.command === 'string') text = h.command;
    else if (typeof h.url === 'string') text = h.url;
    else if (h.type === 'mcp_tool') text = `${h.server || '?'} / ${h.tool || '?'}`;
    else if (typeof h.prompt === 'string') text = h.prompt;
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > 160 ? `${text.slice(0, 159)}…` : (text || '(empty)');
}

/**
 * What is wrong with the draft before it goes anywhere.
 *
 * The bridge checks the same shape and refuses the lot with one sentence; this
 * says which hook, so the row can be pointed at rather than the reader sent
 * hunting. It is a convenience, not the check — checkHooks() is.
 */
function hkProblems() {
    const out = [];
    for (const ev of hkDraft()) {
        if (!/^[A-Z][A-Za-z]{1,63}$/.test(ev.event)) {
            out.push({ k: ev._k, message: `${ev.event || 'An event'} is not an event name.` });
        }
        for (const g of ev.groups) {
            for (const h of g.hooks) {
                const where = `${ev.event}${g.matcher ? ` · ${g.matcher}` : ''}`;
                if (h._jsonError) { out.push({ k: h._k, message: `${where}: ${h._jsonError}` }); continue; }
                if (typeof h.type !== 'string' || !h.type) {
                    out.push({ k: h._k, message: `${where}: a hook needs a type.` });
                    continue;
                }
                const info = hkTypeInfo(h.type);
                for (const field of (info ? info.required : [])) {
                    if (typeof h[field] !== 'string' || !h[field].trim()) {
                        out.push({ k: h._k, message: `${where}: ${field} is empty.` });
                    }
                }
            }
        }
    }
    return out;
}

/**
 * What Save is about to change, hook by hook.
 *
 * A multiset compare on `event · matcher · hook`, so a hook that only moved is
 * neither added nor removed — and a reorder with nothing else is still said,
 * because order is what decides which of two PreToolUse hooks answers first.
 */
function hkChanges() {
    const flat = (block) => {
        const rows = [];
        if (!isPlainObj(block)) return rows;
        for (const [event, groups] of Object.entries(block)) {
            for (const g of (Array.isArray(groups) ? groups : [])) {
                for (const h of (isPlainObj(g) && Array.isArray(g.hooks) ? g.hooks : [])) {
                    rows.push({
                        key: JSON.stringify([event, g.matcher ?? null, h]),
                        event, matcher: g.matcher ?? null, hook: h,
                    });
                }
            }
        }
        return rows;
    };
    const before = flat(JSON.parse(hkState().hooksSeed || 'null'));
    const after = flat(hkForWire());
    const take = (from, key) => {
        const i = from.findIndex(r => r.key === key);
        if (i === -1) return false;
        from.splice(i, 1);
        return true;
    };
    const left = [...before];
    const added = after.filter(r => !take(left, r.key));
    const removed = left;
    const reordered = !added.length && !removed.length
        && JSON.stringify(before.map(r => r.key)) !== JSON.stringify(after.map(r => r.key));
    return { added, removed, reordered };
}

/**
 * The editor, for one event or for every event in the file.
 *
 * `event` is what the page's rail has selected; `null` is "All events", which
 * is the editor as it was in Settings. Filtering is drawing only: the draft is
 * always the whole file's block, and Save always writes all of it, because the
 * block is one key and the review compares all of it.
 *
 * There is no Clear button: a one-click "remove every hook in this file" is
 * exactly the save-without-looking this editor exists not to have. Clearing is
 * deleting the events and saving, through the same review as everything else.
 */
export function HooksEditor({ event }) {
    const [, redraw] = useState(0);
    hkRedraw = () => redraw(n => n + 1);

    const s = hkState();
    const fileRow = hkFileRow();
    const editable = hkEditable();
    const off = s.data.effective.disableAllHooks;

    const body = [];
    if (off && off.value === true) {
        body.push(html`<div key="off" class="hk-off"><strong>Every hook is turned off</strong>${
            ` by disableAllHooks in ${CLAUDE_SCOPES[off.scope] || 'another file'}. `
            + 'You can still edit them; none of them runs until that is cleared.'}</div>`);
    }

    const onDisk = hkOnDisk();
    if (fileRow && fileRow.exists && !fileRow.parsed) {
        body.push(html`<div key="broken" class="cfg-broken">
            <p><strong>This file does not parse, so its hooks cannot be shown.</strong>${
                ' The JSON tab in Settings has it exactly as it is on disk.'}</p>
            ${hkJsonLink('Open the JSON tab')}
        </div>`);
        return html`<div class="hk">${body}</div>`;
    }
    if (onDisk !== undefined && !isPlainObj(onDisk)) {
        body.push(html`<div key="not-object" class="cfg-broken">
            <p><strong>hooks here is not an object.</strong>${
                ' Claude Code will ignore it, and the editor will not guess what it meant.'}</p>
            ${hkJsonLink('Fix it as JSON')}
        </div>`);
        return html`<div class="hk">${body}</div>`;
    }

    const draft = hkDraft();
    // The file moved under a draft. The draft is kept — see claudeStaleBanner()
    // in Settings for why — and Save stays refused until the reader has looked.
    const now = JSON.stringify(onDisk === undefined ? null : onDisk);
    if (hkIsStale()) {
        body.push(html`<div key="stale" class="cfg-stale">
            <div class="cfg-stale-head">The hooks in this file changed on disk since you started.</div>
            <p>${'Nothing was overwritten, and your edits are kept. Saving would replace '
                + 'what is there now, so the page wants you to choose.'}</p>
            <details><summary>What is on disk</summary><pre class="cfg-stale-text">${
                JSON.stringify(onDisk ?? null, null, 2)}</pre></details>
            <div class="hk-actions">
                <button class="btn small" type="button"
                    onClick=${() => { s.hooksSeed = now; s.hooksReview = false; renderHooks(); }}>Keep my edits</button>
                <button class="btn quiet small" type="button"
                    onClick=${() => { hkClearDraft(s); renderHooks(); }}>Take what is on disk</button>
            </div>
        </div>`);
    }

    const problems = s.hooksProblems || [];
    const shown = event ? draft.filter(ev => ev.event === event) : draft;
    if (!shown.length) {
        body.push(html`<div key="none" class="cfg-list-none">${event
            ? `No ${event} hooks in this file.` : 'No hooks in this file.'}</div>`);
        if (event && editable) {
            body.push(html`<div key="add-here" class="cfg-list-add"><button class="linkish" type="button"
                onClick=${() => hkAddEventNamed(event)}>${`Add a hook on ${event}`}</button></div>`);
        }
    }
    for (const ev of shown) body.push(hkEventCard(ev, draft.indexOf(ev), editable, problems));
    if (editable && !event) body.push(hkAddEvent(draft));
    body.push(hkElsewhere(event));
    if (editable || s.hooksDirty) body.push(hkFoot());
    return html`<div class="hk">${body}</div>`;
}

/** Can the scope the page is on be written at all? */
export function hkEditable() {
    const target = hkTargetRow();
    return !!target && target.writable && !target.symlink && !(target.exists && !target.parsed);
}

/**
 * Put an event in the draft, open, with one group — or say it is there.
 * Used by the add-event select, the "Add a hook on X" link and the recipes,
 * which pass `append` to add their group to an event the file already has.
 *
 * @returns {object|null} the event's draft entry, or null when it was refused
 */
export function hkAddEventNamed(name, { group = hkNewGroup(), append = false } = {}) {
    const draft = hkDraft();
    if (!name) return null;
    let ev = draft.find(e => e.event === name);
    if (ev && !append) {
        toast(`${name} is already here — add a matcher to it instead.`, 'warn');
        return null;
    }
    if (ev) ev.groups.push(group);
    else {
        ev = { _k: hkKey(), event: name, groups: [group] };
        draft.push(ev);
    }
    // Open, or the event you just added would arrive folded shut.
    setFold(`hook:${name}`, true);
    hkChanged();
    return ev;
}

/** A small text button — ↑, ↓, duplicate — in the style of the list's ×. */
const hkMini = (label, title, disabled, go) => html`<button class="cfg-list-x hk-mini" type="button"
    title=${title} aria-label=${title} disabled=${!!disabled} onClick=${go}>${label}</button>`;

/** Swap two neighbours, if there is one in that direction. */
function hkMove(list, i, by) {
    const j = i + by;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    hkChanged();
}

function hkEventCard(ev, i, editable, problems) {
    const info = hkEventInfo(ev.event);
    const draft = hkDraft();
    const bad = problems.filter(p => p.k === ev._k);
    // Folds to its head line — see fold.js. A file with more than a few events
    // starts with them shut, since each card is several fields per hook; one
    // that the review found a problem in is drawn open whatever was chosen,
    // because a Save refused over something you cannot see is no answer.
    const key = `hook:${ev.event}`;
    const inside = bad.length || ev.groups.some(g => problems.some(p => p.k === g._k
        || g.hooks.some(h => p.k === h._k)));
    const open = inside || isOpen(key, draft.length > 3);
    const hooks = ev.groups.reduce((n, g) => n + g.hooks.length, 0);
    return html`<div key=${ev._k} class=${`cmd-card hk-event${bad.length ? ' bad' : ''}${open ? '' : ' is-folded'}`}>
        <div class="cmd-card-head">
            ${foldLabelV(key, open, html`<code class="cmd-card-id">${ev.event}</code>`, 'set-fold is-card', renderHooks)}
            ${info
                ? html`<span class="cmd-card-name">${info.blurb.replace(/`/g, '')}</span>`
                : html`<span class="cfg-tab-tag"
                    title="Kept as it is — Claude Code may know it even if this page does not"
                    >an event this page does not know</span>`}
            ${!open
                ? html`<span class="set-fold-sum is-inline">${
                    `${ev.groups.length} ${ev.groups.length === 1 ? 'group' : 'groups'} · `
                    + `${hooks} ${hooks === 1 ? 'hook' : 'hooks'}`}</span>`
                : null}
            <div class="cmd-card-spacer"></div>
            ${editable ? html`<${DeleteButton} label=${`Remove every ${ev.event} hook`} go=${() => {
                const at = draft.indexOf(ev);
                if (at !== -1) draft.splice(at, 1);
                hkChanged();
            }} />` : null}
        </div>
        ${open ? bad.map((p, n) => html`<p key=${`bad:${n}`} class="cmd-field-bad hk-problem">${p.message}</p>`) : null}
        ${open ? ev.groups.map((g, gi) => hkGroup(ev, g, gi, info, editable, problems)) : null}
        ${open && editable
            ? html`<div class="cfg-list-add"><button class="linkish" type="button" onClick=${() => {
                ev.groups.push(hkNewGroup());
                hkChanged();
            }}>${info && info.matcher === null ? 'Add another group' : 'Add a matcher'}</button></div>`
            : null}
    </div>`;
}

export const hkNewHook = () => ({ _k: hkKey(), _script: null, type: 'command', command: '' });
export const hkNewGroup = () => ({ _k: hkKey(), hooks: [hkNewHook()] });

/**
 * One matcher group.
 *
 * The matcher is drawn only for an event that reads one, or when the file
 * already has one on an event that does not — it is theirs, and hiding it
 * would make the JSON tab and the form disagree.
 */
function hkGroup(ev, g, gi, info, editable, problems) {
    const takesMatcher = !info || info.matcher !== null || typeof g.matcher === 'string';
    const listId = `hk-m-${g._k}`;
    const options = !info ? [] : info.matcher === 'tool'
        ? (hkState().data.toolNames || [])
        : (info.values || []);
    const removeGroup = () => {
        const at = ev.groups.indexOf(g);
        if (at !== -1) ev.groups.splice(at, 1);
        if (!ev.groups.length) hkDraft().splice(hkDraft().indexOf(ev), 1);
        hkChanged();
    };
    return html`<div key=${g._k} class="hk-group">
        <div class="hk-group-head">
            ${takesMatcher
                ? html`<label class="hk-matcher">
                    <span class="cmd-field-label">${info && info.matcher === 'tool' ? 'Tool' : 'Matches'}</span>
                    <input key=${`${g._k}:matcher`} class="settings-text cmd-mono" type="text" spellcheck=${false}
                        list=${options.length ? listId : null}
                        defaultValue=${typeof g.matcher === 'string' ? g.matcher : ''}
                        placeholder="any" disabled=${!editable}
                        onInput=${(e) => {
                            if (e.target.value) g.matcher = e.target.value;
                            else delete g.matcher;
                            hkDirtied();
                        }} />
                    ${options.length
                        ? html`<datalist id=${listId}>${options.map(v => html`<option key=${v} value=${v} />`)}</datalist>`
                        : null}
                </label>`
                : html`<span class="cmd-field-label">Runs every time</span>`}
            <div class="cmd-card-spacer"></div>
            ${editable && ev.groups.length > 1
                ? hkMini('↑', 'Move this group up', gi === 0, () => hkMove(ev.groups, gi, -1)) : null}
            ${editable && ev.groups.length > 1
                ? hkMini('↓', 'Move this group down', gi === ev.groups.length - 1, () => hkMove(ev.groups, gi, 1)) : null}
            ${editable ? html`<${DeleteButton} label="Remove this group" go=${removeGroup} />` : null}
        </div>
        ${takesMatcher && info && info.matcher === 'tool'
            ? html`<p class="cmd-field-note">${'A tool name or a regular expression — '}<code>Edit|Write</code>${', '}<code
                >mcp__.*</code>${'. Empty matches every tool.'}</p>`
            : null}
        ${g.hooks.map((h, hi) => hkHook(ev, g, h, hi, editable, problems, removeGroup))}
        ${editable
            ? html`<div class="cfg-list-add"><button class="linkish" type="button"
                onClick=${() => { g.hooks.push(hkNewHook()); hkChanged(); }}>Add a hook to this group</button></div>`
            : null}
    </div>`;
}

/**
 * One hook: its type, the field that type needs, and the rest folded away.
 *
 * Changing the type keeps the fields every type shares and adds the one the new
 * type needs; the old type's own field goes, because a `prompt` hook carrying a
 * leftover `command` is a file that says two things.
 */
function hkHook(ev, g, h, hi, editable, problems, removeGroup) {
    const types = hkState().data.hookTypes || [];
    const known = !!hkTypeInfo(h.type);
    const bad = problems.filter(p => p.k === h._k);
    const tool = (hkEventInfo(ev.event) || {}).matcher === 'tool';
    const dis = !editable;
    // A box's key: the hook, its type and the field, so a type change or a
    // reseeded draft remounts it from the draft — see the header.
    const fk = (field) => `${h._k}:${h.type}:${field}`;

    const setType = (type) => {
        const keep = {};
        for (const k of ['timeout', 'statusMessage', 'if', 'once']) if (k in h) keep[k] = h[k];
        const info = hkTypeInfo(type);
        const next = { _k: h._k, _script: null, type, ...keep };
        for (const f of (info ? info.required : [])) next[f] = '';
        g.hooks[hi] = next;
        hkChanged();
    };

    const head = html`<div key="head" class="hk-hook-head">
        <select class="settings-select" disabled=${dis} value=${known ? h.type : (h.type || '')}
            onChange=${(e) => setType(e.target.value)}>
            ${types.map(t => html`<option key=${t.type} value=${t.type}>${t.label}</option>`)}
            ${!known ? html`<option key="unknown" value=${h.type || ''}>${`${h.type || 'no type'} (unknown)`}</option>` : null}
        </select>
        ${h._script ? hkScriptTag(h) : null}
        <div class="cmd-card-spacer"></div>
        ${editable && g.hooks.length > 1
            ? hkMini('↑', 'Run this one earlier', hi === 0, () => hkMove(g.hooks, hi, -1)) : null}
        ${editable && g.hooks.length > 1
            ? hkMini('↓', 'Run this one later', hi === g.hooks.length - 1, () => hkMove(g.hooks, hi, 1)) : null}
        ${editable ? hkMini(icon('copy', 13), 'Duplicate this hook', false, () => {
            g.hooks.splice(hi + 1, 0, { ...clone(h), _k: hkKey(), _script: null });
            hkChanged();
        }) : null}
        ${editable ? html`<${DeleteButton} label="Remove this hook" go=${() => {
            const at = g.hooks.indexOf(h);
            if (at !== -1) g.hooks.splice(at, 1);
            if (!g.hooks.length) { removeGroup(); return; }
            hkChanged();
        }} />` : null}
    </div>`;

    const marks = bad.map((p, n) => html`<p key=${`bad:${n}`} class="cmd-field-bad hk-problem">${p.message}</p>`);
    const cls = `hk-hook${bad.length ? ' bad' : ''}`;

    if (!known) {
        return html`<div key=${h._k} class=${cls}>${head}${marks}${hkJsonField(h, dis)}</div>`;
    }
    const script = h._script && hkState().script && hkState().script.k === h._k
        ? html`<${ScriptPane} key="script" />` : null;

    // Fields by type. `str` edits one string key and deletes it when emptied,
    // so the file never collects `"statusMessage": ""`.
    const str = (key, label, o = {}) => hkField(fk(key), label, o.note, o.area
        ? html`<textarea class="cmd-area" spellcheck=${false} rows="1" placeholder=${o.ph || ''}
            disabled=${dis} defaultValue=${typeof h[key] === 'string' ? h[key] : ''}
            onFocus=${(e) => grow(e.target, 26, 240)}
            onInput=${(e) => {
                hkSet(h, key, e.target.value, o.required);
                if (key === 'command') h._script = null;
                grow(e.target, 26, 240);
                hkDirtied();
            }}></textarea>`
        : html`<input class=${`settings-text is-long${o.mono === false ? '' : ' cmd-mono'}`} type="text"
            spellcheck=${false} defaultValue=${typeof h[key] === 'string' ? h[key] : ''}
            placeholder=${o.ph || ''} disabled=${dis}
            onInput=${(e) => { hkSet(h, key, e.target.value, o.required); hkDirtied(); }} />`);
    const timeout = () => hkField(fk('timeout'), 'Timeout (seconds)', null, html`<input class="settings-num"
        type="number" min="1" max="86400" disabled=${dis}
        defaultValue=${Number.isInteger(h.timeout) ? h.timeout : ''} placeholder="default"
        onInput=${(e) => {
            const n = Number(e.target.value);
            if (e.target.value === '' || !Number.isInteger(n) || n < 1) delete h.timeout;
            else h.timeout = n;
            hkDirtied();
        }} />`);
    const bool = (key, label, note) => hkField(fk(key), null, note, html`<label class="hk-check">
        <span class="settings-check">
            <input type="checkbox" checked=${h[key] === true} disabled=${dis}
                onChange=${(e) => { if (e.target.checked) h[key] = true; else delete h[key]; hkDirtied(); }} />
            <span class="settings-box"></span>
        </span>
        <span class="cmd-field-label">${label}</span>
    </label>`);
    const inline = (key, ...kids) => html`<div key=${fk(key)} class="hk-inline">${kids}</div>`;

    const fields = [];
    const more = [];
    more.push(str('statusMessage', 'Status message', { mono: false, ph: 'shown on the spinner while it runs' }));
    if (tool) {
        more.push(str('if', 'Only if', {
            ph: 'Bash(git *)', note: 'A permission rule. The hook runs only for calls it matches.' }));
    }

    switch (h.type) {
        case 'command':
            fields.push(str('command', 'Command', { area: true, required: true, ph: '$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh',
                note: 'Run by the shell. The event arrives as JSON on stdin; exit 2 blocks where the event allows it.' }));
            fields.push(inline('inline', timeout(), bool('async', 'Run in the background', null)));
            more.push(str('shell', 'Shell', { ph: 'bash' }));
            more.push(bool('asyncRewake', 'In the background, but wake Claude if it exits 2', null));
            break;
        case 'http':
            fields.push(str('url', 'URL', { required: true, ph: 'http://127.0.0.1:8080/hook',
                note: 'The event is POSTed as JSON; the response body is read as the hook’s output.' }));
            fields.push(timeout());
            fields.push(hkHeaders(h, dis, fk('headers')));
            more.push(hkField(fk('allowedEnvVars'), 'Variables headers may use',
                'Comma-separated. Only these are substituted into a header.',
                html`<input class="settings-text is-long cmd-mono" type="text" spellcheck=${false} disabled=${dis}
                    defaultValue=${Array.isArray(h.allowedEnvVars) ? h.allowedEnvVars.join(', ') : ''}
                    placeholder="API_TOKEN"
                    onInput=${(e) => {
                        const list = e.target.value.split(',').map(x => x.trim()).filter(Boolean);
                        if (list.length) h.allowedEnvVars = list; else delete h.allowedEnvVars;
                        hkDirtied();
                    }} />`));
            break;
        case 'prompt':
        case 'agent':
            fields.push(str('prompt', 'Prompt', { area: true, required: true, mono: false,
                ph: 'Is this safe to run? $ARGUMENTS',
                note: h.type === 'agent'
                    ? 'A subagent with tools answers it. $ARGUMENTS is the event’s JSON.'
                    : 'One model call answers it. $ARGUMENTS is the event’s JSON.' }));
            fields.push(inline('inline', timeout(), str('model', 'Model', { ph: 'default' })));
            break;
        case 'mcp_tool':
            fields.push(inline('inline',
                str('server', 'Server', { required: true, ph: 'memory' }),
                str('tool', 'Tool', { required: true, ph: 'store' })));
            fields.push(hkInputField(h, dis, fk('input')));
            fields.push(timeout());
            break;
        default:
            break;
    }
    more.push(bool('once', 'Only once', 'Removed after it first succeeds. Meant for skills.'));
    // Opened by default when anything under it is set, so a field the file has
    // is never hidden behind a fold nobody knows to open.
    const anyMore = ['statusMessage', 'if', 'shell', 'asyncRewake', 'once', 'allowedEnvVars'].some(k => k in h);
    const extra = hkExtraKeys(h);
    return html`<div key=${h._k} class=${cls}>
        ${head}
        ${marks}
        ${fields}
        ${script}
        <${HkMore} key=${fk('more')} open=${anyMore}>${more}</${HkMore}>
        ${extra.length
            ? html`<p key="extra" class="cmd-field-note">${'Also in the file, kept as it is: '}${
                extra.flatMap((k, n) => [n ? ', ' : '', html`<code>${k}</code>`])}</p>`
            : null}
    </div>`;
}

/**
 * The More fold. Whether it starts open is decided once, when it first draws:
 * after that it is the reader's, and clearing the last field under it while
 * typing there must not shut it on them.
 */
function HkMore({ open, children }) {
    const [initial] = useState(open);
    return html`<details class="hk-more" open=${initial}><summary>More</summary>${children}</details>`;
}

/** Keys on a hook this editor draws no control for — carried, and said. */
function hkExtraKeys(h) {
    const drawn = new Set(['_k', '_script', '_jsonError', 'type', 'command', 'url', 'prompt', 'server', 'tool',
        'input', 'timeout', 'async', 'asyncRewake', 'shell', 'statusMessage', 'if', 'once', 'model',
        'headers', 'allowedEnvVars']);
    return Object.keys(h).filter(k => !drawn.has(k));
}

function hkSet(h, key, value, required) {
    if (value === '' && !required) delete h[key];
    else h[key] = value;
}

function hkField(key, label, note, control) {
    return html`<div key=${key} class="cmd-field hk-field">
        ${label ? html`<div class="cmd-field-head"><span class="cmd-field-label">${label}</span></div>` : null}
        ${control}
        ${note ? html`<p class="cmd-field-note">${note}</p>` : null}
    </div>`;
}

/** HTTP headers, name and value — the env editor's rows, on a hook. */
function hkHeaders(h, dis, key) {
    const headers = isPlainObj(h.headers) ? h.headers : {};
    const names = Object.keys(headers);
    return hkField(key, 'Headers', 'A value may name a variable as $NAME, if it is listed under More.',
        html`<div class="cfg-list cmd-env">
            ${names.map(k => html`<div key=${k} class="cmd-env-row">
                <input class="settings-text cmd-mono cmd-env-name" type="text" spellcheck=${false}
                    defaultValue=${k} disabled=${dis}
                    onChange=${(e) => {
                        const next = e.target.value.trim();
                        if (next === k) return;
                        const was = headers[k];
                        delete headers[k];
                        if (next) headers[next] = was;
                        hkChanged();
                    }} />
                <input class="settings-text cmd-env-value cmd-mono" type="text" spellcheck=${false}
                    defaultValue=${headers[k]} disabled=${dis}
                    onInput=${(e) => { headers[k] = e.target.value; hkDirtied(); }} />
                <button class="cfg-list-x" type="button" disabled=${dis} title="Remove" aria-label=${`Remove ${k}`}
                    onClick=${() => {
                        delete headers[k];
                        if (!Object.keys(headers).length) delete h.headers;
                        hkChanged();
                    }}>×</button>
            </div>`)}
            ${dis ? null : html`<div class="cfg-list-add"><button class="linkish" type="button" onClick=${() => {
                if (!isPlainObj(h.headers)) h.headers = {};
                let name = 'Authorization';
                for (let n = 2; hasOwn(h.headers, name); n += 1) name = `X-Header-${n}`;
                h.headers[name] = '';
                hkChanged();
            }}>Add a header</button></div>`}
        </div>`);
}

/**
 * A JSON box that only takes effect when it parses.
 *
 * `_jsonError` is how a half-typed object stops Save rather than being lost:
 * the last good value stays on the hook, and hkProblems() refuses to send it
 * while the box says something else. The box is uncontrolled, so the text that
 * does not parse stays in it; the note under it is drawn from `_jsonError`.
 */
function hkJsonBox(text, dis, apply, h, minRows = 2) {
    return html`<div>
        <textarea class="cmd-area hk-json" spellcheck=${false} rows=${minRows} disabled=${dis}
            defaultValue=${text}
            onFocus=${(e) => grow(e.target, 40, 320)}
            onInput=${(e) => {
                grow(e.target, 40, 320);
                try {
                    apply(JSON.parse(e.target.value || 'null'));
                    delete h._jsonError;
                } catch (err) {
                    h._jsonError = `not valid JSON — ${err.message}`;
                }
                hkDirtied();
            }}></textarea>
        <p class="cmd-field-bad" hidden=${!h._jsonError}>${h._jsonError || ''}</p>
    </div>`;
}

function hkInputField(h, dis, key) {
    return hkField(key, 'Input', 'The tool’s arguments as a JSON object. ${tool_input.file_path} and the like are filled in from the event.',
        hkJsonBox(h.input === undefined ? '' : JSON.stringify(h.input, null, 2), dis, (v) => {
            if (v === null) { delete h.input; return; }
            if (!isPlainObj(v)) throw new Error('the input has to be an object');
            h.input = v;
        }, h));
}

/** A hook of a type this page does not know: the whole thing, as JSON. */
function hkJsonField(h, dis) {
    const { _k, _script, _jsonError, ...plain } = h;
    // Keyed without the type: retyping it here, to another type this page does
    // not know, must not remount the box being typed into.
    return hkField(`${h._k}:json`, 'As JSON', 'A type this page has no form for. It is kept exactly as written.',
        hkJsonBox(JSON.stringify(plain, null, 2), dis, (v) => {
            if (!isPlainObj(v)) throw new Error('a hook has to be an object');
            for (const k of Object.keys(h)) if (k !== '_k') delete h[k];
            Object.assign(h, v, { _script: null });
        }, h, 4));
}

/**
 * Add an event: the ones not in this file yet, and a free name for the rest.
 *
 * The select is controlled on the placeholder, and every choice ends in a
 * redraw — so it snaps back to "Add a hook on…" whatever happened, a cancelled
 * prompt included.
 */
function hkAddEvent(draft) {
    const have = new Set(draft.map(e => e.event));
    const events = (hkState().data.hookEvents || []).filter(e => !have.has(e.name));
    const add = (name) => !!hkAddEventNamed(name);
    return html`<div key="add" class="cfg-list-add hk-add">
        <select class="settings-select" value=""
            onChange=${(e) => {
                const v = e.target.value;
                let done;
                if (v === '__other') {
                    // eslint-disable-next-line no-alert
                    const name = (window.prompt('The event’s name, exactly as Claude Code spells it:') || '').trim();
                    done = add(name);
                } else done = add(v);
                if (!done) renderHooks();
            }}>
            <option key="" value="">Add a hook on…</option>
            ${events.map(e => html`<option key=${e.name} value=${e.name}>${`${e.name} — ${e.blurb.replace(/`/g, '')}`}</option>`)}
            <option key="__other" value="__other">Another event…</option>
        </select>
    </div>`;
}

/**
 * The hooks the other files contribute — which all run too.
 *
 * Read-only, and said plainly, because "I removed that hook and it still
 * fires" is what the old one-scope summary made likely: it showed the
 * strongest file's hooks and nothing else.
 */
function hkElsewhere(event) {
    const s = hkState();
    const rows = (s.data.hooks || []).filter(h => h.scope !== s.scope && (!event || h.event === event));
    if (!rows.length) return null;
    const open = isOpen('hook:elsewhere', true);
    return html`<div key="elsewhere" class="cfg-inherit">
        <div class="cfg-inherit-head">${foldLabelV('hook:elsewhere', open,
            `${rows.length} more ${rows.length === 1 ? 'hook runs' : 'hooks run'} from other files — these add to yours`,
            'set-fold is-quiet', renderHooks)}</div>
        ${!open ? null : rows.map((h, n) => html`<div key=${n} class="cfg-inherit-row hk-inherit-row">
            <span class="hk-inherit-scope">${CLAUDE_SCOPES[h.scope] || h.scope}</span>${
                ` ${h.event}${h.matcher ? ` · ${h.matcher}` : ''} → ${h.target || h.type || '—'}`}${
                h.script && !h.script.exists
                    ? html`<span class="cfg-script bad" title=${h.script.file}> script missing</span>`
                    : null}
        </div>`)}
    </div>`;
}

/** The footer: where the draft stands, and Save — or the review Save opens. */
function hkFoot() {
    const s = hkState();
    const target = hkTargetRow();
    const editable = !!target && target.writable && !target.symlink;
    const problems = s.hooksProblems;

    if (s.hooksReview && !problems) {
        const { added, removed, reordered } = hkChanges();
        const line = (r, n) => html`<li key=${n}><code>${`${r.event}${r.matcher ? ` · ${r.matcher}` : ''}`}</code>${
            ' → '}<code class="hk-review-target">${hkTarget(r.hook)}</code></li>`;
        return html`<div key="foot" class="cmd-foot hk-foot is-review">
            <div class="hk-review">
                <div class="cfg-stale-head">${`Write these to ${shortPath(target.file)}?`}</div>
                ${added.length
                    ? html`<div><div class="hk-review-lede">Will run</div><ul>${added.map(line)}</ul></div>`
                    : null}
                ${removed.length
                    ? html`<div><div class="hk-review-lede">Will stop running</div><ul>${removed.map(line)}</ul></div>`
                    : null}
                ${reordered ? html`<p class="cmd-field-note">Only the order changes.</p>` : null}
                ${!added.length && !removed.length && !reordered
                    ? html`<p class="cmd-field-note">Nothing that runs changes.</p>`
                    : null}
                <p class="cmd-field-note">${claudeReachLine()}</p>
                <div class="hk-actions">
                    <button class="btn primary small" type="button" disabled=${!!s.saving}
                        onClick=${() => saveClaudeHooks()}>Write the hooks</button>
                    <button class="btn quiet small" type="button"
                        onClick=${() => { s.hooksReview = false; hkRedraw(); }}>Back to editing</button>
                </div>
            </div>
        </div>`;
    }

    return html`<div key="foot" class="cmd-foot hk-foot">
        <span class=${`cmd-foot-note${problems ? ' bad' : ''}`}>${problems
            ? `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} — fix ${problems.length === 1 ? 'it' : 'them'} to save.`
            : (s.hooksDirty ? 'Edited — not saved.' : 'Matches the file on disk.')}</span>
        <div class="cmd-card-spacer"></div>
        <button class="btn quiet small" type="button" disabled=${!s.hooksDirty}
            onClick=${() => { hkClearDraft(s); renderHooks(); }}>Revert</button>
        <button class="btn primary small" type="button"
            disabled=${!editable || !s.hooksDirty || !!s.saving}
            onClick=${() => {
                if (hkIsStale()) {
                    toast('The hooks changed on disk — choose above which to keep first.', 'warn');
                    return;
                }
                const found = hkProblems();
                if (found.length) {
                    s.hooksProblems = found;
                    hkRedraw();
                    return;
                }
                s.hooksReview = true;
                hkRedraw();
            }}>Review and save</button>
    </div>`;
}

/** The sentence Settings' claudeReachNote() says, for the review. */
function claudeReachLine() {
    const running = hkState().data.running || 0;
    return running
        ? `New sessions pick these up. The ${running} already running will not.`
        : 'New sessions pick these up.';
}

/** The toast after a save — the same caveat, as Settings' claudeSavedNote() says it. */
function hkSavedNote() {
    const running = hkState().data.running || 0;
    return running
        ? `Hooks saved. ${running} session${running === 1 ? '' : 's'} already running will not see them — new ones will.`
        : 'Hooks saved. New sessions will pick them up.';
}

/**
 * Whether the hook's script is there — and the way into it.
 *
 * A button rather than the old tag, because the answer to "script missing" is
 * usually to write it, and the answer to "script present" is often to read it.
 * Not executable is its own state: a hook whose script lost its x bit fails as
 * quietly as one whose script was deleted.
 */
function hkScriptTag(h) {
    const sc = h._script;
    const open = hkState().script && hkState().script.k === h._k;
    const label = !sc.exists ? `script missing — ${sc.file}`
        : sc.executable === false ? 'script not executable' : 'script present';
    const bad = !sc.exists || sc.executable === false;
    return html`<button class=${`cfg-script hk-script-btn${bad ? ' bad' : ''}${open ? ' on' : ''}`} type="button"
        title=${`${sc.file} — ${open ? 'close the editor' : (sc.exists ? 'open it here' : 'create it here')}`}
        aria-expanded=${open ? 'true' : 'false'}
        onClick=${() => scriptToggle(h._k, sc.path || sc.file)}>${label}${
            open ? '' : (sc.exists ? ' · edit' : ' · create')}</button>`;
}

/**
 * Write the draft.
 *
 * Stamped, like every collection write, but the stamp is not the whole guard:
 * a save of another key on this page moves the file's stamp without touching
 * its hooks, so the draft is also compared against the block it was seeded
 * from, and a change there is a conflict even when the stamp would pass.
 */
async function saveClaudeHooks() {
    const s = hkState();
    const row = hkTargetRow();
    if (!row) return;
    s.saving = true;
    renderHooks();
    try {
        const answer = await put('/api/claude-config', {
            scope: s.scope, cwd: hkState().dir, stamp: row.stamp, patch: { hooks: hkForWire() },
        });
        s.data = answer.config;
        hkClearDraft(s);
        s.stale = null;
        toast(hkSavedNote(), 'ok');
    } catch (err) {
        s.hooksReview = false;
        if (err.status === 409) {
            // The draft is kept: loadHooks() leaves a dirty one alone,
            // and the editor draws its own banner once the file it now holds
            // differs from the one the draft started from.
            toast('That file changed on disk. Your edits are kept — look, then save again.', 'warn');
            await loadHooks();
        } else {
            toast(`Could not save the hooks: ${err.message}`, 'error');
        }
    }
    s.saving = false;
    renderHooks();
}
