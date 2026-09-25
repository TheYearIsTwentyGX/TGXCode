// The snippet editor, in Settings.
//
// A group in the settings panel rather than a panel of its own, using the `node`
// hatch `SETTINGS` already has for the groups that are not backed by the settings
// file. The note in the markup says so out loud the way the Notifications one
// does: the scope picker at the top of the panel means nothing here.
//
// **`after` fires on every unrelated save**, twice — `renderSettings` runs before
// and after each `saveSetting` — so everything here has to be cheap and nothing
// may eat a half-typed value. That was the argument for the inline name box
// committing on `change` rather than per keystroke, and it is now also why that
// box is uncontrolled (`defaultValue`): Preact compares a controlled `value`
// against the DOM, so a render in the middle of typing would put the stored name
// back over what you had typed.
//
// An uncontrolled box stops following `defaultValue` once it has been typed in,
// so the name and colour inputs are *keyed* on the stored value instead: a rename
// from another window changes the key and remounts the box with the new value.
// That never lands mid-typing, because nothing is stored until `change`. Where the
// stored value did not move — a cleared name, a refused save — the group's entry
// in `state.snippets.revs` is bumped, which changes the key just the same.
//
// **The arrangement is state, not DOM.** The hand-built editor let a drag move
// rows with `insertBefore` and then read the order back out of the DOM, which is
// exactly what cannot be done to nodes Preact owns: it diffs against its last
// render and would put them back. So a drag, or an arrow, writes the
// arrangement to `state.snippets.order` and re-renders from it — the rail's
// drag-to-reorder (`state.railDrag.order`) settled that — and the save reads it
// from there. It is held until the bridge's push answers it (applySnippets).
//
// See index.js for the rule every module here follows about app.js bindings.

import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { del, patch, post } from '../api.js';
import { state } from '../state.js';
import { dom, el, toast } from '../dom.js';
import { icon as domIcon } from '../icons.js';
import { icon, paint } from '../boards/parts.js';
import { applySnippets, snipAccent, snipById, snipPreview } from './index.js';
import { openSnipEditor } from './editor.js';

/** How long a delete button offers to be sure. armForce's window and its idea. */
const SNIP_ARM_MS = 4000;

/** The ungrouped list's key in an arrangement. A group id is never empty. */
const LOOSE = '';

/**
 * Which groups, in what order, and which snippets in each.
 *
 * From the held arrangement while there is one, and from the payload otherwise —
 * the payload is already in display order, so that half needs no sort. A held
 * arrangement is laid over the current rows rather than trusted whole: a snippet
 * deleted since it was taken is dropped, and one added since goes at the foot of
 * its group, so a push from another window mid-drag cannot draw a row twice or
 * lose one.
 */
function snipArrangement() {
    const rows = state.snippets.rows;
    const groups = state.snippets.groups;
    const known = new Set(groups.map(g => g.id));
    const home = (s) => (s.groupId && known.has(s.groupId) ? s.groupId : LOOSE);
    const held = state.snippets.order;

    const byId = new Map(groups.map(g => [g.id, g]));
    const order = held
        ? [...held.groups.filter(id => byId.has(id)),
            ...groups.map(g => g.id).filter(id => !held.groups.includes(id))]
        : groups.map(g => g.id);

    const lists = new Map([...order, LOOSE].map(k => [k, []]));
    const placed = new Set();
    if (held) {
        const live = new Set(rows.map(s => s.id));
        for (const [k, ids] of Object.entries(held.lists)) {
            if (!lists.has(k)) continue;
            for (const id of ids) {
                if (!live.has(id) || placed.has(id)) continue;
                lists.get(k).push(id);
                placed.add(id);
            }
        }
    }
    for (const s of rows) {
        if (!placed.has(s.id)) lists.get(home(s)).push(s.id);
    }
    return { groups: order.map(id => byId.get(id)), lists };
}

/** An arrangement as plain data, to be held in state and edited. */
function holdArrangement() {
    const a = snipArrangement();
    return {
        groups: a.groups.map(g => g.id),
        lists: Object.fromEntries([...a.lists].map(([k, ids]) => [k, [...ids]])),
    };
}

export function renderSnipSettings() {
    if (!dom.snipSettingsBody) return;
    const { groups, lists } = snipArrangement();
    const rowsOf = (k) => lists.get(k).map(snipById).filter(Boolean);
    const nothing = !state.snippets.rows.length && !state.snippets.groups.length;

    paint(dom.snipSettingsBody, [
        ...groups.map(g => snipSettingsGroup(g, rowsOf(g.id))),
        // The ungrouped block is drawn even when it is empty, because it is where
        // a drag has to be able to drop a snippet to take it out of a group.
        snipSettingsGroup(null, rowsOf(LOOSE)),
        nothing ? html`<p key="note" class="settings-group-note">${
            'Nothing yet. A snippet is a message you send often — the text, what to '
            + 'ask for before sending it, and whether it sends itself.'}</p>` : null,
    ]);
}

function snipSettingsGroup(g, rows) {
    const accent = snipAccent(g);
    const key = g ? g.id : LOOSE;
    const rev = g ? state.snippets.revs[g.id] || 0 : 0;
    return html`<section key=${g ? `group:${g.id}` : 'loose'}
        class=${g ? 'snip-set-group' : 'snip-set-group is-loose'}
        style=${accent ? `--snip-accent: ${accent}` : null}>
        <div class="snip-set-head">${g ? [
            html`<span class="snip-grip" title="Drag to reorder">${icon('grip', 14)}</span>`,
            html`<input key=${`name:${rev}:${g.name}`} class="snip-set-name" type="text"
                defaultValue=${g.name} aria-label="Group name"
                onChange=${(e) => {
                    const name = e.target.value.trim();
                    // A cleared name is not saved, so do not leave it looking
                    // cleared: remount the box from the stored name.
                    if (!name) { redrawSnipGroup(g.id); return; }
                    saveSnipGroup(g.id, { name });
                }} />`,
            html`<input key=${`accent:${rev}:${accent}`} class="snip-set-accent" type="color"
                defaultValue=${accent || '#9aa0a6'}
                aria-label="Group colour" title="Group colour"
                onChange=${(e) => saveSnipGroup(g.id, { accent: e.target.value })} />`,
            ...snipMoveButtons('group', g.id),
            html`<${DeleteButton} label="Delete this group" go=${() => deleteSnipGroup(g)} />`,
        ] : html`<span class="snip-set-loose">Ungrouped</span>`}</div>
        <div class="snip-set-list" data-group=${key}
            onDragOver=${(e) => onSnipDragOver(e, key)}
            onDrop=${(e) => e.preventDefault()}>
            ${rows.map(snipSettingsRow)}
        </div>
        <div class="snip-set-foot">
            <button class="linkish" type="button"
                onClick=${() => openSnipEditor(null, g ? g.id : null)}>Add a snippet here</button>
        </div>
    </section>`;
}

function snipSettingsRow(s) {
    const badges = [];
    if (s.pinned) badges.push('pinned');
    if (s.autoSubmit) badges.push(s.permissionMode ? `sends · ${s.permissionMode}` : 'sends');
    if (s.insert !== 'overwrite') badges.push(s.insert);
    if (s.params.length) badges.push(`${s.params.length} to fill in`);
    if (s.projects.length) badges.push(`${s.projects.length} project${s.projects.length > 1 ? 's' : ''}`);
    // Reported rather than refused, in both directions — see the bridge's
    // scanPlaceholders. The editor is where it is explained; this is the hint that
    // sends you there.
    if (s.undeclared.length) badges.push(`${s.undeclared.length} unasked`);

    return html`<div key=${s.id} class="snip-set-row" draggable="true" data-snip=${s.id}
        onDragStart=${(e) => onSnipDragStart(e, s.id)}
        onDragEnd=${() => commitSnipOrder()}>
        <span class="snip-grip" title="Drag to reorder">${icon('grip', 14)}</span>
        <div class="snip-set-text">
            <div class="snip-set-title">${s.title}</div>
            <div class="snip-set-preview">${snipPreview(s)}</div>
        </div>
        <div class="snip-set-badges">${badges.map(b => html`<span class="snip-badge">${b}</span>`)}</div>
        ${snipMoveButtons('snippet', s.id)}
        <button class="btn small" type="button" onClick=${() => openSnipEditor(s)}>Edit</button>
        <${DeleteButton} label="Delete this snippet" go=${() => deleteSnippet(s)} />
    </div>`;
}

/**
 * The arrows, which do what the drag does and are the whole of it for a keyboard.
 *
 * They change the held arrangement and then commit it the same way a drop does,
 * so there is one path to the bridge rather than two. Focus is put back on the
 * button after the redraw, so holding one keeps walking the same row rather than
 * pressing whatever landed underneath — a node Preact moves can lose it.
 */
function snipMoveButtons(kind, id) {
    return [-1, 1].map(step => html`<button class="snip-move" type="button"
        aria-label=${step < 0 ? 'Move up' : 'Move down'}
        title=${step < 0 ? 'Move up' : 'Move down'}
        onClick=${() => moveSnipRow(kind, id, step)}>${step < 0 ? '↑' : '↓'}</button>`);
}

function moveSnipRow(kind, id, step) {
    const held = holdArrangement();
    // The ungrouped block is not a group anybody ordered, and it is always last,
    // so it is not in `held.groups` to be swapped with.
    const list = kind === 'group' ? held.groups
        : Object.values(held.lists).find(ids => ids.includes(id));
    if (!list) return;
    const at = list.indexOf(id);
    const to = at + step;
    if (at < 0 || to < 0 || to >= list.length) return;
    [list[at], list[to]] = [list[to], list[at]];

    state.snippets.order = held;
    renderSnipSettings();
    const label = step < 0 ? 'Move up' : 'Move down';
    const home = kind === 'group'
        ? dom.snipSettingsBody.querySelector(`.snip-set-list[data-group="${CSS.escape(id)}"]`)
            ?.closest('.snip-set-group')?.querySelector('.snip-set-head')
        : dom.snipSettingsBody.querySelector(`.snip-set-row[data-snip="${CSS.escape(id)}"]`);
    const again = home && home.querySelector(`:scope > .snip-move[aria-label="${label}"]`);
    if (again && document.activeElement !== again) again.focus();
    commitSnipOrder();
}

function onSnipDragStart(e, id) {
    state.snippets.drag = id;
    state.snippets.order = holdArrangement();
    e.dataTransfer.effectAllowed = 'move';
    // Firefox will not start a drag without something on the transfer.
    e.dataTransfer.setData('text/plain', id);
}

/**
 * Move the row under the cursor as the drag goes, rather than only on the drop.
 *
 * The queue's idiom, and its reason: the list you are looking at is the answer, so
 * you should be able to see it before you let go. Dropping into another group's
 * list is a move between groups as well as a reorder, which `commitSnipOrder`
 * picks up from where the row ends rather than from the drag itself.
 *
 * Where it lands is measured off the rows on screen — reading the DOM is fine;
 * writing it is what is not — and the move is a change to the held arrangement
 * and a render, made only when the answer changed so a drag is not a render per
 * pixel.
 */
function onSnipDragOver(e, key) {
    const id = state.snippets.drag;
    if (!id || !state.snippets.order) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const list = e.currentTarget;
    const after = [...list.querySelectorAll('.snip-set-row')]
        .filter(n => n.dataset.snip !== id)
        .find((n) => {
            const box = n.getBoundingClientRect();
            return e.clientY < box.top + box.height / 2;
        });

    const lists = state.snippets.order.lists;
    const target = (lists[key] || []).filter(x => x !== id);
    const at = after ? target.indexOf(after.dataset.snip) : target.length;
    target.splice(at < 0 ? target.length : at, 0, id);
    if ((lists[key] || []).join() === target.join()) return;
    for (const k of Object.keys(lists)) lists[k] = lists[k].filter(x => x !== id);
    lists[key] = target;
    renderSnipSettings();
}

/**
 * Tell the bridge what the arrangement now says, and let the push redraw it.
 *
 * Read out of the held arrangement — which is what is on screen, so it cannot
 * disagree with what somebody saw. A snippet that ended up in a different list is
 * patched first: its `groupId` is part of where it is, and reordering it into a
 * group it does not belong to would put it back on the next redraw.
 *
 * **One save at a time.** Two quick arrow presses, or a drop and then an arrow,
 * used to send two reorders side by side, and if the second reached the bridge
 * first the bridge ended on the first one's arrangement — the user's later move,
 * silently undone. So a commit made while a save is running only raises `again`,
 * and the running save goes round once more when it finishes, reading the held
 * arrangement afresh. Several presses during one save coalesce into one more
 * request carrying the last of them, which is also the only one that matters.
 *
 * `committing` is true for the whole loop and keeps the arrangement held across
 * the pushes its writes provoke on the way, which would otherwise redraw the old
 * order for a moment between the first write and the last.
 *
 * When the loop finishes the arrangement is let go of, success or failure. The
 * push answering a reorder is broadcast before the HTTP response, so it usually
 * lands while this is still running and cannot drop the order itself — and a
 * reorder that moved nothing sends no push at all. Left held, it would mask
 * whatever another window changed since and send that stale arrangement back on
 * the next arrow. The reorder route answers with the whole payload, which is laid
 * down only if it is newer than what the pushes already brought: a push from
 * another window can arrive between the broadcast and this response.
 */
let again = false;

async function commitSnipOrder() {
    state.snippets.drag = null;
    state.snippets.order = state.snippets.order || holdArrangement();
    if (state.snippets.committing) { again = true; return; }

    state.snippets.committing = true;
    let answer = null;
    try {
        do {
            again = false;
            const held = state.snippets.order || holdArrangement();
            // In the order the blocks are drawn: groups first, the ungrouped block last.
            const moves = [];
            const ids = [];
            for (const key of [...held.groups, LOOSE]) {
                const groupId = key || null;
                for (const id of held.lists[key] || []) {
                    const s = snipById(id);
                    ids.push(id);
                    if (s && (s.groupId || null) !== groupId) moves.push({ id, groupId });
                }
            }
            for (const m of moves) await patch(`/api/snippets/${m.id}`, { groupId: m.groupId });
            answer = await post('/api/snippets/reorder', { snippets: ids, groups: held.groups });
        } while (again);
    } catch (err) {
        again = false;
        answer = null;
        toast(`Could not save the order: ${err.message}`, 'error');
        // Back to what the bridge has, rather than leaving the screen claiming an
        // arrangement that was refused — unless a drag is live, which needs it.
        if (!state.snippets.drag) state.snippets.order = null;
    } finally {
        state.snippets.committing = false;
        // Sound only because the reorder route builds its payload, broadcasts it
        // and responds with it with no await in between (bridge/server.js, the
        // `reorder` branch), so this response and its own push carry the same
        // `at`, and a push with a later one really did come from somewhere else.
        // An await there would let another write slip between the two.
        if (answer && answer.at > state.snippets.at) {
            applySnippets(answer);
        } else {
            if (!state.snippets.drag) state.snippets.order = null;
            renderSnipSettings();
        }
    }
}

/**
 * A delete that asks once, in the button, rather than behind a third dialog.
 *
 * `armForce`'s idea: the second press within a few seconds is the confirmation.
 * A scrim for this would be heavier than what is being deleted — a snippet is a
 * paragraph you can write again, which is drafts' argument for having no dialog at
 * all, and this is one step more careful than that because a snippet is one you
 * tuned rather than one you just wrote.
 *
 * Two of them, for the two ways a surface is drawn: `DeleteButton` for Preact,
 * where "armed" is the component's state, and `snipDeleteButton` for the Settings
 * groups still built by hand with `el()` — hooks, project commands, Wispr — which
 * own their nodes and may write to them.
 */
export function DeleteButton({ label, go }) {
    const [armed, setArmed] = useState(0);
    const timer = useRef(null);
    useEffect(() => () => clearTimeout(timer.current), []);
    const press = () => {
        if (Date.now() - armed < SNIP_ARM_MS) { go(); return; }
        const now = Date.now();
        setArmed(now);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setArmed(0), SNIP_ARM_MS + 50);
    };
    return html`<button class=${armed ? 'snip-del armed' : 'snip-del'} type="button"
        aria-label=${label} title=${label} onClick=${press}
        >${armed ? 'Really?' : icon('trash', 13)}</button>`;
}

export function snipDeleteButton(label, go) {
    let armed = 0;
    const b = el('button', {
        class: 'snip-del', type: 'button', 'aria-label': label, title: label,
        onclick: () => {
            if (Date.now() - armed < SNIP_ARM_MS) { go(); return; }
            armed = Date.now();
            b.textContent = 'Really?';
            b.classList.add('armed');
            setTimeout(() => {
                if (Date.now() - armed < SNIP_ARM_MS) return;
                b.replaceChildren(domIcon('trash', 13));
                b.classList.remove('armed');
            }, SNIP_ARM_MS + 50);
        },
    }, domIcon('trash', 13));
    return b;
}

async function deleteSnippet(s) {
    try { await del(`/api/snippets/${s.id}`); }
    catch (err) { toast(`Could not delete the snippet: ${err.message}`, 'error'); }
}

async function deleteSnipGroup(g) {
    try {
        const r = await del(`/api/snippet-groups/${g.id}`);
        // Said rather than left to be noticed: deleting a heading does not delete
        // what was under it, and a block of snippets moving to Ungrouped is a big
        // enough change to announce.
        if (r.orphaned) {
            toast(`${r.orphaned} snippet${r.orphaned > 1 ? 's' : ''} moved to Ungrouped.`);
        }
    } catch (err) {
        toast(`Could not delete the group: ${err.message}`, 'error');
    }
}

export async function newSnipGroup() {
    try { await post('/api/snippet-groups', { name: 'New group', accent: '#a8c7fa' }); }
    catch (err) { toast(`Could not make the group: ${err.message}`, 'error'); }
}

async function saveSnipGroup(id, fields) {
    try { await patch(`/api/snippet-groups/${id}`, fields); }
    catch (err) {
        toast(`Could not save the group: ${err.message}`, 'error');
        // The box still shows what was refused; put the stored value back.
        redrawSnipGroup(id);
    }
}

/** Remount a group's name and colour boxes from what is stored. See the header. */
function redrawSnipGroup(id) {
    state.snippets.revs[id] = (state.snippets.revs[id] || 0) + 1;
    renderSnipSettings();
}
