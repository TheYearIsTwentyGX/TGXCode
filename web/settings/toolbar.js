// The top bar's layout — which buttons it carries and where, and the More menu —
// and the Toolbar settings group that edits it. Moved out of app.js as it was.
//
// Imports from app.js, which imports this — safe because nothing here reads an
// app.js binding while the module evaluates, only when a function is called.
// Keep it that way: a module-level `const` built from an app.js `const` throws,
// because every module under web/settings/ evaluates before app.js's body runs.

import { BOOT_PREFS } from '../boot.js';
import { html, useRef, useState } from '../vendor/preact.js';
import { dom } from '../dom.js';
import { icon } from '../boards/parts.js';
import { showCv, showQuota } from '../quota.js';
import { devBrowserShown } from '../app.js';
import { showNewMenu } from '../new-session/recent.js';
import { saveSetting } from './index.js';

// ── the top bar's layout ─────────────────────────────────────────────────
//
// Which buttons the bar carries, in what order, which of them live in its More
// menu and which show their text — `toolbar.items` in the settings file, see
// bridge/prefs.js. The page draws none of these buttons: they are all in
// web/index.html with their listeners and badges already attached, and
// paintToolbar() only *moves* them. That is the whole trick, and the reason it
// is safe — a button in the More menu is the same node with the same id, so
// paintPanels() still lights it, its badge still counts, and the focus-mode CSS
// that hides `#btn-dash` by id still finds it.
//
// `places` is the rule bridge/prefs.js enforces as TOOLBAR_PINNED, repeated
// because a hand-edited file reaches this page before anybody has saved it:
// Settings is the way back from everything else here, so it is never hidden,
// and the quota pill is a popover anchor with Restart bridge in it, so it never
// leaves the bar. Hiding a view removes its button and nothing else — the
// shortcut on the Ctrl ladder still opens it.
const TOOLBAR = [
    { id: 'tasks', node: 'btnTaskboard', name: 'Tasks', icon: true },
    { id: 'live', node: 'btnLive', name: 'Live', icon: true },
    { id: 'dashboard', node: 'btnDash', name: 'Dashboard', icon: true },
    { id: 'history', node: 'btnNotes', name: 'History', icon: true },
    { id: 'drafts', node: 'btnDrafts', name: 'Drafts', icon: true },
    { id: 'schedules', node: 'btnSched', name: 'Schedules', icon: true },
    // Icon-only until somebody says otherwise, which is how it has always been
    // drawn: the one view that is not about work earns a place and not a word.
    { id: 'settings', node: 'btnSettings', name: 'Settings', icon: true, label: false,
        places: ['bar', 'more'],
        why: 'Settings can go in More, but not away — it is where hidden buttons come back from.' },
    { id: 'quota', node: 'quotaWrap', name: 'Quota',
        places: ['bar'], why: 'Always on the bar — its popover holds Restart bridge.' },
    { id: 'devbrowser', node: 'dbStatus', name: 'DevBrowser' },
];
const TOOLBAR_PLACES = [['bar', 'Bar'], ['more', 'More menu'], ['hidden', 'Hidden']];

/**
 * The saved list, resolved against the catalogue.
 *
 * What was saved comes first and in its own order; anything it does not mention
 * — everything, on a file that never touched this, or a button added since —
 * goes back in after the button it follows by default, so a new one lands where
 * it would have been rather than at the end.
 *
 * @returns {Array<{def, place, label}>}
 */
function toolbarLayout() {
    const byId = new Map(TOOLBAR.map(d => [d.id, d]));
    const out = [];
    const saved = (BOOT_PREFS.toolbar && BOOT_PREFS.toolbar.items) || [];
    for (const e of Array.isArray(saved) ? saved : []) {
        const def = e && byId.get(e.id);
        if (!def || out.some(o => o.def === def)) continue;
        const places = def.places || ['bar', 'more', 'hidden'];
        out.push({
            def,
            place: places.includes(e.place) ? e.place : 'bar',
            label: typeof e.label === 'boolean' ? e.label : def.label !== false,
        });
    }
    TOOLBAR.forEach((def, i) => {
        if (out.some(o => o.def === def)) return;
        let at = 0;
        for (let j = i - 1; j >= 0; j--) {
            const k = out.findIndex(o => o.def === TOOLBAR[j]);
            if (k >= 0) { at = k + 1; break; }
        }
        out.splice(at, 0, { def, place: 'bar', label: def.label !== false });
    });
    return out;
}

/** The layout as the settings file spells it. */
const toolbarItems = (layout) => layout.map(o => ({ id: o.def.id, place: o.place, label: o.label }));

export function paintToolbar() {
    const bar = dom.barMoreWrap.parentElement;
    for (const { def, place: placed, label } of toolbarLayout()) {
        const node = dom[def.node];
        // Settings → DevBrowser → Show, which outranks where the pill was put:
        // off means no DevBrowser anywhere, the More menu included.
        const place = def.id === 'devbrowser' && !devBrowserShown() ? 'hidden' : placed;
        if (place === 'more') dom.barMoreMenu.append(node);
        else bar.insertBefore(node, dom.barMoreWrap);
        // An attribute of our own rather than `hidden`, which the quota pill
        // already uses to mean "no data yet" and must keep meaning.
        node.toggleAttribute('data-bar-hidden', place === 'hidden');
        if (def.icon) {
            node.classList.toggle('icon-only', !label);
            // With the text gone the title is all that is left of a name, and a
            // title is not one a screen reader reliably reads.
            if (label) node.removeAttribute('aria-label');
            else node.setAttribute('aria-label', def.name);
        }
    }
    // The version badge is not in the catalogue: it is an indicator that is
    // absent unless something is behind, not a button anybody places. It rides
    // beside the quota pill, which is always on the bar, rather than being left
    // wherever the moves above happened to strand it.
    bar.insertBefore(dom.cvWrap, dom.quotaWrap);
    paintBarMore();
}

/**
 * The More button's own state, read off what is inside it.
 *
 * Its badge adds up the counts it is hiding, so putting Dashboard away does not
 * also put away the fact that something is waiting there — and it is urgent if
 * any of them is. It is lit when the open view is one of its own.
 */
function paintBarMore() {
    const inside = barMoreRows();
    dom.barMoreWrap.hidden = !inside.length;
    if (!inside.length && !dom.barMoreMenu.hidden) showBarMore(false);

    let sum = 0;
    let urgent = false;
    const parts = [];
    for (const node of inside) {
        const badge = node.querySelector('.bar-badge');
        if (!badge || badge.hidden) continue;
        const n = Number(badge.textContent) || 0;
        sum += n;
        urgent = urgent || badge.classList.contains('urgent');
        const def = TOOLBAR.find(d => dom[d.node] === node);
        if (n && def) parts.push(`${n} in ${def.name}`);
    }
    dom.barMoreBadge.hidden = !sum;
    dom.barMoreBadge.textContent = String(sum);
    dom.barMoreBadge.classList.toggle('urgent', urgent);
    dom.barMore.title = parts.length ? `More — ${parts.join(', ')}` : 'More';
    dom.barMore.classList.toggle('on', inside.some(n => n.classList.contains('on')));
}

export function showBarMore(on) {
    if (on && dom.barMoreWrap.hidden) return;
    dom.barMoreMenu.hidden = !on;
    dom.barMore.setAttribute('aria-expanded', String(on));
    if (on) { showQuota(false); showNewMenu(false); showCv(false); }
}

function barMoreRows() {
    return [...dom.barMoreMenu.children].filter(n => !n.hasAttribute('data-bar-hidden'));
}

// The bar's own listeners, and its first paint. A function rather than top-level
// statements so they still run where this section used to sit in app.js —
// after everything above it there has been defined — and not at import time.
export function wireToolbar() {
    dom.barMore.addEventListener('click', (e) => {
        e.stopPropagation();
        showBarMore(dom.barMoreMenu.hidden);
    });

    dom.barMore.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        showBarMore(true);
        const rows = barMoreRows();
        (e.key === 'ArrowDown' ? rows[0] : rows[rows.length - 1])?.focus();
    });

    // A ring, like #new-menu. Escape is on the central ladder with the others.
    dom.barMoreMenu.addEventListener('keydown', (e) => {
        const rows = barMoreRows();
        if (!rows.length) return;
        const i = rows.indexOf(document.activeElement);
        const go = (n) => { e.preventDefault(); rows[((n % rows.length) + rows.length) % rows.length].focus(); };
        if (e.key === 'ArrowDown') go(i + 1);
        else if (e.key === 'ArrowUp') go(i - 1);
        else if (e.key === 'Home') go(0);
        else if (e.key === 'End') go(-1);
        else if (e.key === 'Tab') showBarMore(false);
    });

    // Choosing something closes the menu. The button's own listener has already run
    // by the time this bubbles here, so the view it opened is up underneath.
    dom.barMoreMenu.addEventListener('click', () => showBarMore(false));

    document.addEventListener('click', (e) => {
        if (!dom.barMoreMenu.hidden && !e.target.closest('.bar-more-wrap')) showBarMore(false);
    });

    // Every badge and every `.on` inside the menu is set by code that has never heard
    // of it — renderLive, paintPanels and the rest write to their own button — so
    // the menu watches its contents rather than asking six painters to call it.
    new MutationObserver(paintBarMore).observe(dom.barMoreMenu, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['hidden', 'class', 'data-bar-hidden'],
    });

    paintToolbar();
}

// ── the Toolbar settings group ───────────────────────────────────────────
//
// One row per button, in bar order: dragged or stepped into place, sent to the
// bar, the More menu or nowhere, and with its text on or off. Every change
// saves the whole list, because `toolbar.items` is one key — see the note on
// saveBinding() for why a map, or here a list, goes over whole.
//
// A Preact component inside the Toolbar card (see general.js). **The order
// during a drag is the component's, not the DOM's.** The hand-built list let a
// drag move rows with `insertBefore` and read the order back out of the DOM,
// which cannot be done to nodes Preact owns: it diffs against its last render
// and would put them back. So a drag holds an order of ids, draws from it, and
// saves it on release — the snippet editor's arrangement (web/snippets/
// settings.js), smaller. The held order is let go of once its save is over,
// success or not, so what is drawn after that is what the file says.

/** The Toolbar group's list, as a vnode for settingsCard(). */
export function renderToolbarSettings(locked) {
    return html`<${ToolbarSettings} key="toolbar" locked=${locked} />`;
}

function ToolbarSettings({ locked }) {
    // `{ id, order }` while a drag is live (`id` is the row in the air) or while
    // the save it ended in is running (`id` is null). A ref, because dragover
    // and dragend read it faster than a render lands; `redraw` draws it.
    const drag = useRef(null);
    const [, redraw] = useState(0);
    const hold = (next) => { drag.current = next; redraw(n => n + 1); };

    const saved = toolbarLayout();
    const layout = drag.current ? heldLayout(saved, drag.current.order) : saved;
    const commit = (next) => saveSetting('toolbar', 'items', toolbarItems(next));

    const onDragStart = (e, id) => {
        hold({ id, order: layout.map(o => o.def.id) });
        e.dataTransfer.effectAllowed = 'move';
        // Firefox will not start a drag without something on the transfer.
        e.dataTransfer.setData('text/plain', id);
    };

    // The row under the cursor moves as the drag goes — the snippet list's idiom.
    // Where it lands is measured off the rows on screen (reading the DOM is fine;
    // writing it is what is not), and a redraw happens only when that changed.
    const onDragOver = (e) => {
        const d = drag.current;
        if (!d || !d.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const after = [...e.currentTarget.querySelectorAll('.settings-bar-row')]
            .filter(n => n.dataset.id !== d.id)
            .find((n) => {
                const box = n.getBoundingClientRect();
                return e.clientY < box.top + box.height / 2;
            });
        const order = d.order.filter(x => x !== d.id);
        const at = after ? order.indexOf(after.dataset.id) : order.length;
        order.splice(at < 0 ? order.length : at, 0, d.id);
        if (order.join() === d.order.join()) return;
        hold({ ...d, order });
    };

    // Save the order the drag ended on, if it changed. Held (with no row in the
    // air) until the save is over, so the list does not flick back to the old
    // order between the release and the file answering.
    const onDragEnd = () => {
        const d = drag.current;
        if (!d) return;
        if (d.order.join() === saved.map(o => o.def.id).join()) { hold(null); return; }
        hold({ id: null, order: d.order });
        commit(heldLayout(saved, d.order)).finally(() => hold(null));
    };

    const hasSaved = (BOOT_PREFS.toolbar.items || []).length > 0;
    return html`<div>
        <div class="settings-bar" onDragOver=${onDragOver} onDrop=${(e) => e.preventDefault()}>
            ${layout.map((o, i) => toolbarRow(o, i, layout, locked, {
                commit, onDragStart, onDragEnd,
                dragging: !!(drag.current && drag.current.id === o.def.id),
            }))}
        </div>
        ${hasSaved ? html`<div class="settings-bar-foot">
            <button class="linkish" type="button" disabled=${locked}
                onClick=${() => saveSetting('toolbar', 'items', null)}>Reset to default</button>
        </div>` : null}
    </div>`;
}

/**
 * A held order of ids, laid over the layout the file gives. Anything the held
 * order does not name goes on the end, so a row cannot vanish while held.
 */
function heldLayout(saved, order) {
    const byId = new Map(saved.map(o => [o.def.id, o]));
    const out = order.map(id => byId.get(id)).filter(Boolean);
    for (const o of saved) if (!out.includes(o)) out.push(o);
    return out;
}

/**
 * The button's own icon, copied out of the bar as a vnode — the same glyph the
 * bar shows, without a second copy of every icon here. DevBrowser's pill
 * carries a light rather than an icon; the blank keeps its name in the same
 * column as the rest.
 */
function barGlyph(def) {
    const svg = dom[def.node].querySelector('svg');
    if (!svg) return html`<span class="settings-bar-noglyph"></span>`;
    const attrs = {};
    for (const a of svg.attributes) attrs[a.name] = a.value;
    return html`<svg ...${attrs} dangerouslySetInnerHTML=${{ __html: svg.innerHTML }}></svg>`;
}

function toolbarRow(o, i, layout, locked, { commit, onDragStart, onDragEnd, dragging }) {
    const { def } = o;
    const places = def.places || TOOLBAR_PLACES.map(([v]) => v);
    const edit = (change) => {
        const next = layout.map(x => ({ ...x }));
        Object.assign(next[i], change);
        commit(next);
    };
    const move = (step) => {
        const j = i + step;
        if (j < 0 || j >= layout.length) return;
        const next = layout.slice();
        [next[i], next[j]] = [next[j], next[i]];
        commit(next);
    };

    return html`<div key=${def.id} class=${dragging ? 'settings-bar-row dragging' : 'settings-bar-row'}
        data-id=${def.id} data-place=${o.place}
        draggable=${locked ? undefined : 'true'}
        onDragStart=${(e) => onDragStart(e, def.id)}
        onDragEnd=${onDragEnd}>
        <span class="snip-grip" title="Drag to reorder">${icon('grip', 14)}</span>
        <span class="settings-bar-name">${barGlyph(def)}<span>${def.name}</span></span>
        ${def.icon
            ? html`<label class="settings-check settings-bar-label">
                <input type="checkbox" checked=${o.label} disabled=${locked}
                    onChange=${(e) => edit({ label: e.target.checked })} />
                <span class="settings-box"></span>
                <span>Show label</span>
            </label>`
            : html`<span class="settings-bar-label"></span>`}
        ${places.length > 1
            ? html`<select class="settings-select settings-bar-place" disabled=${locked}
                aria-label=${`Where ${def.name} goes`} title=${def.why || undefined}
                value=${o.place}
                onChange=${(e) => edit({ place: e.target.value })}>
                ${TOOLBAR_PLACES.filter(([v]) => places.includes(v)).map(([v, text]) =>
                    html`<option key=${v} value=${v}>${text}</option>`)}
            </select>`
            : html`<span class="settings-bar-fixed" title=${def.why || undefined}>Always on the bar</span>`}
        ${[-1, 1].map(step => html`<button key=${step} class="snip-move" type="button"
            disabled=${locked || (step < 0 ? i === 0 : i === layout.length - 1)}
            aria-label=${`Move ${def.name} ${step < 0 ? 'earlier' : 'later'}`}
            title=${step < 0 ? 'Earlier in the bar' : 'Later in the bar'}
            onClick=${() => move(step)}>${step < 0 ? '↑' : '↓'}</button>`)}
    </div>`;
}
