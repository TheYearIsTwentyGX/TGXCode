// The hooks editor inside the Claude Code group: a draft of the `hooks` block,
// its review, and the save. Moved out of app.js as it was.
//
// Imports from app.js, which imports this — safe because nothing here reads an
// app.js binding while the module evaluates, only when a function is called.
// Keep it that way: a module-level `const` built from an app.js `const` throws,
// because every module under web/settings/ evaluates before app.js's body runs.

import { put } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { shortPath } from '../format.js';
import { icon } from '../icons.js';
import { snipDeleteButton } from '../snippets/settings.js';
import { grow } from '../composer/send.js';
import {
    CLAUDE_SCOPES, claudeDir, claudeJsonLink, claudeSavedNote, claudeState, claudeTargetRow,
    loadClaudeConfig,
} from './claude-config.js';
import { renderSettings } from './index.js';
import { clone, hasOwn } from './project-commands.js';

// ── the hooks editor ───────────────────────────────────────────────────────
//
// The one control in this group that is a draft rather than save-on-change,
// and for the reason the group note gives: a hook `command` is an arbitrary
// shell string run on every matching event. A half-typed one reaching disk is
// a hook that fires, so nothing is written until Save — and Save shows what
// will run before it writes it. That review step is what reversed the old
// decision to keep this read-only (docs/plans/20-claude-config.md): the JSON
// tab could always write hooks, so a form adds no capability, only a better
// place to read one before arming it.
//
// Seeded from the target file's own `hooks` and never from anything merged.
// That one is not the list lesson claudeRow() carries so much as its sharper
// cousin: hooks from every scope all run, so copying the user's hooks into a
// project file would make each of them fire twice.

let hkKeySeq = 0;
const hkKey = () => (hkKeySeq += 1);

/** The file whose hooks the editor is showing — the target, or Managed read-only. */
function hkFileRow() {
    const s = claudeState();
    return claudeTargetRow() || (s.data && s.data.files.find(f => f.scope === s.scope)) || null;
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
function hkDraft() {
    const s = claudeState();
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

/** Mark the draft edited, and repaint only the footer — see cmdDirty(). */
function hkDirtied() {
    const s = claudeState();
    s.hooksDirty = true;
    s.hooksReview = false;
    // The problems belong to the draft that was checked, not this one. Their
    // marks come off in place rather than by a redraw, which would take the
    // caret out of the box being typed into.
    if (s.hooksProblems) {
        s.hooksProblems = null;
        const row = dom.setBody && dom.setBody.querySelector('.settings-row[data-path="hooks"]');
        if (row) {
            row.querySelectorAll('.hk-problem').forEach(n => n.remove());
            row.querySelectorAll('.hk-hook.bad, .hk-event.bad').forEach(n => n.classList.remove('bad'));
        }
    }
    const foot = dom.setBody && dom.setBody.querySelector('.hk-foot');
    if (foot) hkPaintFoot(foot);
}

/** Structural change: the draft moved, so the panel is redrawn. */
function hkChanged() {
    hkDirtied();
    renderSettings();
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
    const s = claudeState();
    if (!s.hooksDirty || s.hooksSeed === null) return false;
    const onDisk = hkOnDisk();
    return JSON.stringify(onDisk === undefined ? null : onDisk) !== s.hooksSeed;
}

const hkEventInfo = (name) => (claudeState().data.hookEvents || []).find(e => e.name === name) || null;
const hkTypeInfo = (type) => (claudeState().data.hookTypes || []).find(t => t.type === type) || null;

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
    const before = flat(JSON.parse(claudeState().hooksSeed || 'null'));
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
 * The Hooks row — the editor, with the facts around it.
 *
 * Not claudeRow()'s shape: that row has a Clear button in its side column that
 * saves on click, and a one-click "remove every hook in this file" is exactly
 * the save-without-looking this editor exists not to have. Clearing is
 * deleting the events and saving, through the same review as everything else.
 */
export function claudeHooksRow(row) {
    const s = claudeState();
    const fileRow = hkFileRow();
    const target = claudeTargetRow();
    const editable = !!target && target.writable && !target.symlink && !(target.exists && !target.parsed);
    const off = s.data.effective.disableAllHooks;

    const text = el('div', { class: 'settings-row-text' },
        el('div', { class: 'settings-row-label' },
            row.label, el('code', { class: 'cfg-path', text: row.path })),
        el('div', { class: 'settings-row-note' },
            'Each event holds groups; a group’s matcher picks what it fires for, and '
            + 'its hooks run in order. Nothing here is written until you save.'));

    const body = el('div', { class: 'hk' });
    if (off && off.value === true) {
        body.append(el('div', { class: 'hk-off' },
            el('strong', { text: 'Every hook is turned off' }),
            ` by disableAllHooks in ${CLAUDE_SCOPES[off.scope] || 'another file'}. `
            + 'You can still edit them; none of them runs until that is cleared.'));
    }

    const onDisk = hkOnDisk();
    if (fileRow && fileRow.exists && !fileRow.parsed) {
        body.append(el('div', { class: 'cfg-broken' },
            el('p', null, el('strong', { text: 'This file does not parse, so its hooks cannot be shown.' }),
                ' The JSON tab has it exactly as it is on disk.'),
            claudeJsonLink('hooks', 'Open the JSON tab')));
        return hkWrap(row, text, body);
    }
    if (onDisk !== undefined && !isPlainObj(onDisk)) {
        body.append(el('div', { class: 'cfg-broken' },
            el('p', null, el('strong', { text: 'hooks here is not an object.' }),
                ' Claude Code will ignore it, and the editor will not guess what it meant.'),
            claudeJsonLink('hooks', 'Fix it as JSON')));
        return hkWrap(row, text, body);
    }

    const draft = hkDraft();
    // The file moved under a draft. The draft is kept — see claudeStaleBanner()
    // for why — and Save stays refused until the reader has looked.
    const now = JSON.stringify(onDisk === undefined ? null : onDisk);
    if (hkIsStale()) {
        body.append(el('div', { class: 'cfg-stale' },
            el('div', { class: 'cfg-stale-head' }, 'The hooks in this file changed on disk since you started.'),
            el('p', null, 'Nothing was overwritten, and your edits are kept. Saving would replace '
                + 'what is there now, so the page wants you to choose.'),
            el('details', null, el('summary', { text: 'What is on disk' }),
                el('pre', { class: 'cfg-stale-text', text: JSON.stringify(onDisk ?? null, null, 2) })),
            el('div', { class: 'hk-actions' },
                el('button', {
                    class: 'btn small', type: 'button',
                    onclick: () => { s.hooksSeed = now; s.hooksReview = false; renderSettings(); },
                }, 'Keep my edits'),
                el('button', {
                    class: 'btn quiet small', type: 'button',
                    onclick: () => { hkClearDraft(s); renderSettings(); },
                }, 'Take what is on disk'))));
    }

    if (!draft.length) {
        body.append(el('div', { class: 'cfg-list-none', text: 'No hooks in this file.' }));
    }
    const problems = s.hooksProblems || [];
    for (const [i, ev] of draft.entries()) body.append(hkEventCard(ev, i, editable, problems));
    if (editable) body.append(hkAddEvent(draft));
    body.append(hkElsewhere());
    if (editable || s.hooksDirty) {
        const foot = el('div', { class: 'cmd-foot hk-foot' });
        hkPaintFoot(foot);
        body.append(foot);
    }
    body.append(el('div', { class: 'cfg-list-add' }, claudeJsonLink('hooks', 'Edit as JSON')));
    return hkWrap(row, text, body);
}

function hkWrap(row, text, body) {
    return el('div', { class: 'settings-row is-wide', 'data-path': row.path },
        el('div', { class: 'settings-row-head' }, text),
        el('div', { class: 'settings-row-wide' }, body));
}

/** A small text button — ↑, ↓, duplicate — in the style of the list's ×. */
const hkMini = (label, title, disabled, go) => el('button', {
    class: 'cfg-list-x hk-mini', type: 'button', title, 'aria-label': title,
    disabled: disabled || null, onclick: go,
}, label);

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
    const card = el('div', { class: `cmd-card hk-event${bad.length ? ' bad' : ''}` },
        el('div', { class: 'cmd-card-head' },
            el('code', { class: 'cmd-card-id', text: ev.event }),
            info ? el('span', { class: 'cmd-card-name', text: info.blurb.replace(/`/g, '') })
                : el('span', { class: 'cfg-tab-tag', title: 'Kept as it is — Claude Code may know it even if this page does not' },
                    'an event this page does not know'),
            el('div', { class: 'cmd-card-spacer' }),
            editable ? snipDeleteButton(`Remove every ${ev.event} hook`, () => {
                draft.splice(i, 1);
                hkChanged();
            }) : null));
    for (const p of bad) card.append(el('p', { class: 'cmd-field-bad hk-problem', text: p.message }));
    ev.groups.forEach((g, gi) => card.append(hkGroup(ev, g, gi, info, editable, problems)));
    if (editable) {
        card.append(el('div', { class: 'cfg-list-add' },
            el('button', {
                class: 'linkish', type: 'button',
                onclick: () => {
                    ev.groups.push(hkNewGroup());
                    hkChanged();
                },
            }, info && info.matcher === null ? 'Add another group' : 'Add a matcher')));
    }
    return card;
}

const hkNewHook = () => ({ _k: hkKey(), _script: null, type: 'command', command: '' });
const hkNewGroup = () => ({ _k: hkKey(), hooks: [hkNewHook()] });

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
        ? (claudeState().data.toolNames || [])
        : (info.values || []);
    const removeGroup = () => {
        ev.groups.splice(gi, 1);
        if (!ev.groups.length) hkDraft().splice(hkDraft().indexOf(ev), 1);
        hkChanged();
    };
    const wrap = el('div', { class: 'hk-group' },
        el('div', { class: 'hk-group-head' },
            takesMatcher
                ? el('label', { class: 'hk-matcher' },
                    el('span', { class: 'cmd-field-label', text: info && info.matcher === 'tool' ? 'Tool' : 'Matches' }),
                    el('input', {
                        class: 'settings-text cmd-mono', type: 'text', spellcheck: 'false',
                        list: options.length ? listId : null,
                        value: typeof g.matcher === 'string' ? g.matcher : '',
                        placeholder: 'any', disabled: !editable || null,
                        oninput: (e) => {
                            if (e.target.value) g.matcher = e.target.value;
                            else delete g.matcher;
                            hkDirtied();
                        },
                    }),
                    options.length
                        ? el('datalist', { id: listId }, options.map(v => el('option', { value: v })))
                        : null)
                : el('span', { class: 'cmd-field-label', text: 'Runs every time' }),
            el('div', { class: 'cmd-card-spacer' }),
            editable && ev.groups.length > 1 ? hkMini('↑', 'Move this group up', gi === 0, () => hkMove(ev.groups, gi, -1)) : null,
            editable && ev.groups.length > 1 ? hkMini('↓', 'Move this group down', gi === ev.groups.length - 1,
                () => hkMove(ev.groups, gi, 1)) : null,
            editable ? snipDeleteButton('Remove this group', removeGroup) : null),
        takesMatcher && info && info.matcher === 'tool'
            ? el('p', { class: 'cmd-field-note' },
                'A tool name or a regular expression — ', el('code', { text: 'Edit|Write' }), ', ',
                el('code', { text: 'mcp__.*' }), '. Empty matches every tool.')
            : null);
    g.hooks.forEach((h, hi) => wrap.append(hkHook(ev, g, h, hi, editable, problems, removeGroup)));
    if (editable) {
        wrap.append(el('div', { class: 'cfg-list-add' },
            el('button', {
                class: 'linkish', type: 'button',
                onclick: () => { g.hooks.push(hkNewHook()); hkChanged(); },
            }, 'Add a hook to this group')));
    }
    return wrap;
}

/**
 * One hook: its type, the field that type needs, and the rest folded away.
 *
 * Changing the type keeps the fields every type shares and adds the one the new
 * type needs; the old type's own field goes, because a `prompt` hook carrying a
 * leftover `command` is a file that says two things.
 */
function hkHook(ev, g, h, hi, editable, problems, removeGroup) {
    const types = claudeState().data.hookTypes || [];
    const known = !!hkTypeInfo(h.type);
    const bad = problems.filter(p => p.k === h._k);
    const tool = (hkEventInfo(ev.event) || {}).matcher === 'tool';
    const dis = !editable || null;

    const setType = (type) => {
        const keep = {};
        for (const k of ['timeout', 'statusMessage', 'if', 'once']) if (k in h) keep[k] = h[k];
        const info = hkTypeInfo(type);
        const next = { _k: h._k, _script: null, type, ...keep };
        for (const f of (info ? info.required : [])) next[f] = '';
        g.hooks[hi] = next;
        hkChanged();
    };

    const head = el('div', { class: 'hk-hook-head' },
        el('select', {
            class: 'settings-select', disabled: dis,
            onchange: (e) => setType(e.target.value),
        },
        types.map(t => el('option', { value: t.type, selected: t.type === h.type || null }, t.label)),
        !known ? el('option', { value: h.type || '', selected: true }, `${h.type || 'no type'} (unknown)`) : null),
        h._script
            ? el('span', {
                class: `cfg-script${h._script.exists ? '' : ' bad'}`, title: h._script.file,
            }, h._script.exists ? 'script present' : `script missing — ${h._script.file}`)
            : null,
        el('div', { class: 'cmd-card-spacer' }),
        editable && g.hooks.length > 1 ? hkMini('↑', 'Run this one earlier', hi === 0, () => hkMove(g.hooks, hi, -1)) : null,
        editable && g.hooks.length > 1 ? hkMini('↓', 'Run this one later', hi === g.hooks.length - 1, () => hkMove(g.hooks, hi, 1)) : null,
        editable ? hkMini(icon('copy', 13), 'Duplicate this hook', false, () => {
            g.hooks.splice(hi + 1, 0, { ...clone(h), _k: hkKey(), _script: null });
            hkChanged();
        }) : null,
        editable ? snipDeleteButton('Remove this hook', () => {
            g.hooks.splice(hi, 1);
            if (!g.hooks.length) { removeGroup(); return; }
            hkChanged();
        }) : null);

    const card = el('div', { class: `hk-hook${bad.length ? ' bad' : ''}` }, head);
    for (const p of bad) card.append(el('p', { class: 'cmd-field-bad hk-problem', text: p.message }));

    if (!known) {
        card.append(hkJsonField(h, g, hi, dis));
        return card;
    }

    // Fields by type. `str` edits one string key and deletes it when emptied,
    // so the file never collects `"statusMessage": ""`.
    const str = (key, label, o = {}) => hkField(label, o.note, o.area
        ? el('textarea', {
            class: 'cmd-area', spellcheck: 'false', rows: 1, placeholder: o.ph || '', disabled: dis,
            onfocus: (e) => grow(e.target, 26, 240),
            oninput: (e) => { hkSet(h, key, e.target.value, o.required); if (key === 'command') h._script = null; grow(e.target, 26, 240); hkDirtied(); },
        }, typeof h[key] === 'string' ? h[key] : '')
        : el('input', {
            class: `settings-text is-long${o.mono === false ? '' : ' cmd-mono'}`, type: 'text', spellcheck: 'false',
            value: typeof h[key] === 'string' ? h[key] : '', placeholder: o.ph || '', disabled: dis,
            oninput: (e) => { hkSet(h, key, e.target.value, o.required); hkDirtied(); },
        }));
    const timeout = () => hkField('Timeout (seconds)', null, el('input', {
        class: 'settings-num', type: 'number', min: 1, max: 86400, disabled: dis,
        value: Number.isInteger(h.timeout) ? h.timeout : '', placeholder: 'default',
        oninput: (e) => {
            const n = Number(e.target.value);
            if (e.target.value === '' || !Number.isInteger(n) || n < 1) delete h.timeout;
            else h.timeout = n;
            hkDirtied();
        },
    }));
    const bool = (key, label, note) => hkField(null, note, el('label', { class: 'hk-check' },
        el('span', { class: 'settings-check' },
            el('input', {
                type: 'checkbox', checked: h[key] === true || null, disabled: dis,
                onchange: (e) => { if (e.target.checked) h[key] = true; else delete h[key]; hkDirtied(); },
            }),
            el('span', { class: 'settings-box' })),
        el('span', { class: 'cmd-field-label', text: label })));

    const more = [];
    more.push(str('statusMessage', 'Status message', { mono: false, ph: 'shown on the spinner while it runs' }));
    if (tool) {
        more.push(str('if', 'Only if', {
            ph: 'Bash(git *)', note: 'A permission rule. The hook runs only for calls it matches.' }));
    }

    switch (h.type) {
        case 'command':
            card.append(str('command', 'Command', { area: true, required: true, ph: '$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh',
                note: 'Run by the shell. The event arrives as JSON on stdin; exit 2 blocks where the event allows it.' }));
            card.append(el('div', { class: 'hk-inline' }, timeout(),
                bool('async', 'Run in the background', null)));
            more.push(str('shell', 'Shell', { ph: 'bash' }));
            more.push(bool('asyncRewake', 'In the background, but wake Claude if it exits 2', null));
            break;
        case 'http':
            card.append(str('url', 'URL', { required: true, ph: 'http://127.0.0.1:8080/hook',
                note: 'The event is POSTed as JSON; the response body is read as the hook’s output.' }));
            card.append(timeout());
            card.append(hkHeaders(h, dis));
            more.push(hkField('Variables headers may use', 'Comma-separated. Only these are substituted into a header.',
                el('input', {
                    class: 'settings-text is-long cmd-mono', type: 'text', spellcheck: 'false', disabled: dis,
                    value: Array.isArray(h.allowedEnvVars) ? h.allowedEnvVars.join(', ') : '',
                    placeholder: 'API_TOKEN',
                    oninput: (e) => {
                        const list = e.target.value.split(',').map(x => x.trim()).filter(Boolean);
                        if (list.length) h.allowedEnvVars = list; else delete h.allowedEnvVars;
                        hkDirtied();
                    },
                })));
            break;
        case 'prompt':
        case 'agent':
            card.append(str('prompt', 'Prompt', { area: true, required: true, mono: false,
                ph: 'Is this safe to run? $ARGUMENTS',
                note: h.type === 'agent'
                    ? 'A subagent with tools answers it. $ARGUMENTS is the event’s JSON.'
                    : 'One model call answers it. $ARGUMENTS is the event’s JSON.' }));
            card.append(el('div', { class: 'hk-inline' }, timeout(),
                str('model', 'Model', { ph: 'default' })));
            break;
        case 'mcp_tool':
            card.append(el('div', { class: 'hk-inline' },
                str('server', 'Server', { required: true, ph: 'memory' }),
                str('tool', 'Tool', { required: true, ph: 'store' })));
            card.append(hkInputField(h, dis));
            card.append(timeout());
            break;
        default:
            break;
    }
    more.push(bool('once', 'Only once', 'Removed after it first succeeds. Meant for skills.'));
    // Opened by default when anything under it is set, so a field the file has
    // is never hidden behind a fold nobody knows to open.
    const anyMore = ['statusMessage', 'if', 'shell', 'asyncRewake', 'once', 'allowedEnvVars'].some(k => k in h);
    card.append(el('details', { class: 'hk-more', open: anyMore || null },
        el('summary', { text: 'More' }), ...more));
    const extra = hkExtraKeys(h);
    if (extra.length) {
        card.append(el('p', { class: 'cmd-field-note' },
            'Also in the file, kept as it is: ', ...extra.flatMap((k, n) => [n ? ', ' : '', el('code', { text: k })])));
    }
    return card;
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

function hkField(label, note, control) {
    return el('div', { class: 'cmd-field hk-field' },
        label ? el('div', { class: 'cmd-field-head' }, el('span', { class: 'cmd-field-label', text: label })) : null,
        control,
        note ? el('p', { class: 'cmd-field-note', text: note }) : null);
}

/** HTTP headers, name and value — the env editor's rows, on a hook. */
function hkHeaders(h, dis) {
    const headers = isPlainObj(h.headers) ? h.headers : {};
    const names = Object.keys(headers);
    return hkField('Headers', 'A value may name a variable as $NAME, if it is listed under More.',
        el('div', { class: 'cfg-list cmd-env' },
            names.map(k => el('div', { class: 'cmd-env-row' },
                el('input', {
                    class: 'settings-text cmd-mono cmd-env-name', type: 'text', spellcheck: 'false',
                    value: k, disabled: dis,
                    onchange: (e) => {
                        const next = e.target.value.trim();
                        if (next === k) return;
                        const was = headers[k];
                        delete headers[k];
                        if (next) headers[next] = was;
                        hkChanged();
                    },
                }),
                el('input', {
                    class: 'settings-text cmd-env-value cmd-mono', type: 'text', spellcheck: 'false',
                    value: headers[k], disabled: dis,
                    oninput: (e) => { headers[k] = e.target.value; hkDirtied(); },
                }),
                el('button', {
                    class: 'cfg-list-x', type: 'button', disabled: dis, title: 'Remove', 'aria-label': `Remove ${k}`,
                    onclick: () => {
                        delete headers[k];
                        if (!Object.keys(headers).length) delete h.headers;
                        hkChanged();
                    },
                }, '×'))),
            dis ? null : el('div', { class: 'cfg-list-add' },
                el('button', {
                    class: 'linkish', type: 'button',
                    onclick: () => {
                        if (!isPlainObj(h.headers)) h.headers = {};
                        let name = 'Authorization';
                        for (let n = 2; hasOwn(h.headers, name); n += 1) name = `X-Header-${n}`;
                        h.headers[name] = '';
                        hkChanged();
                    },
                }, 'Add a header'))));
}

/**
 * A JSON box that only takes effect when it parses.
 *
 * `_jsonError` is how a half-typed object stops Save rather than being lost:
 * the last good value stays on the hook, and hkProblems() refuses to send it
 * while the box says something else.
 */
function hkJsonBox(text, dis, apply, h, minRows = 2) {
    const note = el('p', { class: 'cmd-field-bad', hidden: true });
    const ta = el('textarea', {
        class: 'cmd-area hk-json', spellcheck: 'false', rows: minRows, disabled: dis,
        onfocus: (e) => grow(e.target, 40, 320),
        oninput: (e) => {
            grow(e.target, 40, 320);
            try {
                apply(JSON.parse(e.target.value || 'null'));
                delete h._jsonError;
                note.hidden = true;
            } catch (err) {
                h._jsonError = `not valid JSON — ${err.message}`;
                note.textContent = h._jsonError;
                note.hidden = false;
            }
            hkDirtied();
        },
    }, text);
    return [ta, note];
}

function hkInputField(h, dis) {
    const [ta, note] = hkJsonBox(h.input === undefined ? '' : JSON.stringify(h.input, null, 2), dis, (v) => {
        if (v === null) { delete h.input; return; }
        if (!isPlainObj(v)) throw new Error('the input has to be an object');
        h.input = v;
    }, h);
    return hkField('Input', 'The tool’s arguments as a JSON object. ${tool_input.file_path} and the like are filled in from the event.',
        el('div', null, ta, note));
}

/** A hook of a type this page does not know: the whole thing, as JSON. */
function hkJsonField(h, g, hi, dis) {
    const { _k, _script, _jsonError, ...plain } = h;
    const [ta, note] = hkJsonBox(JSON.stringify(plain, null, 2), dis, (v) => {
        if (!isPlainObj(v)) throw new Error('a hook has to be an object');
        for (const k of Object.keys(h)) if (k !== '_k') delete h[k];
        Object.assign(h, v, { _script: null });
    }, h, 4);
    return hkField('As JSON', 'A type this page has no form for. It is kept exactly as written.',
        el('div', null, ta, note));
}

/** Add an event: the ones not in this file yet, and a free name for the rest. */
function hkAddEvent(draft) {
    const have = new Set(draft.map(e => e.event));
    const events = (claudeState().data.hookEvents || []).filter(e => !have.has(e.name));
    const add = (name) => {
        if (!name) return;
        if (have.has(name)) { toast(`${name} is already here — add a matcher to it instead.`, 'warn'); return; }
        draft.push({ _k: hkKey(), event: name, groups: [hkNewGroup()] });
        hkChanged();
    };
    return el('div', { class: 'cfg-list-add hk-add' },
        el('select', {
            class: 'settings-select',
            onchange: (e) => {
                const v = e.target.value;
                if (v === '__other') {
                    // eslint-disable-next-line no-alert
                    const name = (window.prompt('The event’s name, exactly as Claude Code spells it:') || '').trim();
                    add(name);
                } else add(v);
            },
        },
        el('option', { value: '', text: 'Add a hook on…', selected: true }),
        events.map(e => el('option', { value: e.name, text: `${e.name} — ${e.blurb.replace(/`/g, '')}` })),
        el('option', { value: '__other', text: 'Another event…' })));
}

/**
 * The hooks the other files contribute — which all run too.
 *
 * Read-only, and said plainly, because "I removed that hook and it still
 * fires" is what the old one-scope summary made likely: it showed the
 * strongest file's hooks and nothing else.
 */
function hkElsewhere() {
    const s = claudeState();
    const rows = (s.data.hooks || []).filter(h => h.scope !== s.scope);
    if (!rows.length) return el('span', { hidden: true });
    return el('div', { class: 'cfg-inherit' },
        el('div', { class: 'cfg-inherit-head' },
            `${rows.length} more ${rows.length === 1 ? 'hook runs' : 'hooks run'} from other files — these add to yours`),
        rows.map(h => el('div', { class: 'cfg-inherit-row hk-inherit-row' },
            el('span', { class: 'hk-inherit-scope', text: CLAUDE_SCOPES[h.scope] || h.scope }),
            ` ${h.event}${h.matcher ? ` · ${h.matcher}` : ''} → ${h.target || h.type || '—'}`,
            h.script && !h.script.exists
                ? el('span', { class: 'cfg-script bad', title: h.script.file }, ' script missing')
                : null)));
}

function hkPaintFoot(foot) {
    const s = claudeState();
    const target = claudeTargetRow();
    const editable = !!target && target.writable && !target.symlink;
    const problems = s.hooksProblems;
    const nodes = [];

    if (s.hooksReview && !problems) {
        const { added, removed, reordered } = hkChanges();
        const line = (r) => el('li', null,
            el('code', { text: `${r.event}${r.matcher ? ` · ${r.matcher}` : ''}` }),
            ' → ', el('code', { class: 'hk-review-target', text: hkTarget(r.hook) }));
        nodes.push(el('div', { class: 'hk-review' },
            el('div', { class: 'cfg-stale-head' },
                `Write these to ${shortPath(target.file)}?`),
            added.length
                ? el('div', null, el('div', { class: 'hk-review-lede', text: 'Will run' }),
                    el('ul', null, added.map(line)))
                : null,
            removed.length
                ? el('div', null, el('div', { class: 'hk-review-lede', text: 'Will stop running' }),
                    el('ul', null, removed.map(line)))
                : null,
            reordered ? el('p', { class: 'cmd-field-note', text: 'Only the order changes.' }) : null,
            !added.length && !removed.length && !reordered
                ? el('p', { class: 'cmd-field-note', text: 'Nothing that runs changes.' })
                : null,
            el('p', { class: 'cmd-field-note' }, claudeReachLine()),
            el('div', { class: 'hk-actions' },
                el('button', {
                    class: 'btn primary small', type: 'button', disabled: s.saving || null,
                    onclick: () => saveClaudeHooks(),
                }, 'Write the hooks'),
                el('button', {
                    class: 'btn quiet small', type: 'button',
                    onclick: () => { s.hooksReview = false; hkPaintFoot(foot); },
                }, 'Back to editing'))));
        foot.classList.add('is-review');
        foot.replaceChildren(...nodes);
        return;
    }

    foot.classList.remove('is-review');
    foot.replaceChildren(
        el('span', { class: `cmd-foot-note${problems ? ' bad' : ''}` },
            problems
                ? `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} — fix ${problems.length === 1 ? 'it' : 'them'} to save.`
                : (s.hooksDirty ? 'Edited — not saved.' : 'Matches the file on disk.')),
        el('div', { class: 'cmd-card-spacer' }),
        el('button', {
            class: 'btn quiet small', type: 'button', disabled: !s.hooksDirty || null,
            onclick: () => { hkClearDraft(s); renderSettings(); },
        }, 'Revert'),
        el('button', {
            class: 'btn primary small', type: 'button',
            disabled: !editable || !s.hooksDirty || s.saving || null,
            onclick: () => {
                if (hkIsStale()) {
                    toast('The hooks changed on disk — choose above which to keep first.', 'warn');
                    return;
                }
                const found = hkProblems();
                if (found.length) {
                    s.hooksProblems = found;
                    renderSettings();
                    return;
                }
                s.hooksReview = true;
                hkPaintFoot(foot);
            },
        }, 'Review and save'));
}

/** The sentence claudeReachNote() says, for the review. */
function claudeReachLine() {
    const running = claudeState().data.running || 0;
    return running
        ? `New sessions pick these up. The ${running} already running will not.`
        : 'New sessions pick these up.';
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
    const s = claudeState();
    const row = claudeTargetRow();
    if (!row) return;
    s.saving = true;
    renderSettings();
    try {
        const answer = await put('/api/claude-config', {
            scope: s.scope, cwd: claudeDir(), stamp: row.stamp, patch: { hooks: hkForWire() },
        });
        s.data = answer.config;
        hkClearDraft(s);
        s.stale = null;
        toast(claudeSavedNote('hooks'), 'ok');
    } catch (err) {
        s.hooksReview = false;
        if (err.status === 409) {
            // The draft is kept: loadClaudeConfig() leaves a dirty one alone,
            // and the editor draws its own banner once the file it now holds
            // differs from the one the draft started from.
            toast('That file changed on disk. Your edits are kept — look, then save again.', 'warn');
            await loadClaudeConfig();
        } else {
            toast(`Could not save the hooks: ${err.message}`, 'error');
        }
    }
    s.saving = false;
    renderSettings();
}
