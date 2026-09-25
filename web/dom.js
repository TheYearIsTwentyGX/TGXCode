// The DOM, looked up once, and the few helpers every surface builds it with.
//
// `dom` maps each id in index.html to its element, camel-cased (`conv-title` is
// `dom.convTitle`). It is filled while this module evaluates, which is safe
// because module scripts are deferred past the parse. `el` is the hand-built
// element factory most of app.js draws with; `toast` the one way to say
// something in passing; modalUp() and closeOnClickOutside() the rules every
// modal dialog shares.

const $ = (id) => document.getElementById(id);
export const dom = {};
for (const id of ['search', 'rail', 'conv', 'placeholder', 'conv-title', 'conv-sub',
    'channels', 'scroll', 'log', 'status-line', 'status-text', 'btn-stop', 'input',
    'btn-send', 'btn-attach', 'attach', 'attach-input', 'composer',
    'pins', 'btn-snippets', 'snip-menu', 'new-btn-snippets', 'new-snip-menu',
    'snip-fill-scrim', 'snip-fill-title', 'snip-fill-form', 'snip-fill-go',
    'snip-edit-scrim',
    'set-g-snippets', 'snip-new', 'snip-group-new', 'snip-settings-body',
    'slash-menu', 'mention-menu', 'new-slash-menu', 'new-mention-menu',
    'new-attach', 'new-attach-input', 'new-attach-btn', 'new-attach-row',
    'queue', 'queue-list', 'queue-count', 'queue-clear',
    'later', 'btn-later', 'later-menu',
    'btn-wispr', 'wispr-menu', 'new-btn-wispr', 'new-wispr-menu',
    'set-g-wispr', 'wispr-list', 'wispr-add',
    'model', 'perm', 'btn-new', 'btn-new-menu', 'new-menu', 'hide-done', 'hide-done-count',
    'rail-sort', 'sort-menu',
    'db-status', 'db-label', 'toasts',
    'quota-wrap', 'quota-pill', 'quota-pill-body', 'quota-menu', 'quota-windows',
    'quota-events', 'quota-note', 'quota-refresh', 'quota-live',
    'quota-restart', 'quota-restart-label', 'quota-restart-sub',
    'cv-wrap', 'cv-pill', 'cv-menu', 'cv-changelog', 'cv-check', 'cv-body', 'cv-update', 'cv-update-label',
    'btn-pin', 'btn-changes', 'btn-folder', 'btn-term', 'btn-archive', 'btn-delete',
    'turns', 'turn-pop',
    'find', 'find-input', 'find-count', 'find-prev', 'find-next',
    'find-subs', 'find-subs-row', 'find-close',
    'changes', 'changes-strip', 'changes-strip-count', 'changes-open', 'changes-count',
    'changes-refresh', 'changes-collapse', 'changes-body',
    'checklist', 'checklist-strip', 'checklist-strip-count', 'checklist-open',
    'checklist-count', 'checklist-collapse', 'checklist-body', 'btn-checklist',
    'conv-main', 'conv-body',
    'term-pane', 'term-grip', 'term-dir', 'term-moved', 'term-body', 'term-restart', 'term-close',
    'term-tabs', 'term-stop', 'term-preview', 'cmds',
    'tasks', 'tasks-strip', 'tasks-strip-count', 'tasks-open', 'tasks-count',
    'tasks-collapse', 'tasks-list',
    'task-scrim', 'task-dlg-title', 'task-dlg-why', 'task-dlg-prompt', 'task-dlg-cwd',
    'task-dlg-copy', 'task-dlg-acts',
    'agents', 'agent-scroll', 'agent-log', 'btn-back', 'btn-back-label',
    'ask-dock', 'plan-pane', 'plan-bar', 'plan-aside', 'plan-agent', 'plan-title',
    'plan-body', 'plan-doc', 'plan-foot',
    'btn-dash', 'dash-badge', 'dash', 'dash-sub', 'dash-body', 'dash-refresh',
    'btn-notes', 'notes-badge', 'notes', 'notes-sub', 'notes-body',
    'btn-taskboard', 'tb-badge', 'taskboard', 'tb-sub', 'tb-body', 'tb-refresh',
    'tb-search', 'tb-unfocus',
    'btn-drafts', 'dr-badge', 'drafts', 'dr-sub', 'dr-body', 'dr-new',
    'btn-sched', 'sched-badge', 'sched', 'sched-sub', 'sched-body', 'sched-new',
    'btn-settings', 'settings', 'set-scope', 'set-project', 'set-project-wrap', 'set-notes',
    'set-file', 'set-problems', 'set-body', 'set-shell', 'set-toc', 'set-top', 'composer-hint',
    'memo-scrim', 'memo-title', 'memo-big', 'memo-note', 'memo-count',
    'memo-close', 'memo-save',
    'set-g-pair', 'set-g-projects', 'pcolor-list', 'pcolor-backdrop',
    'proj-menu', 'pcolor-order', 'pcolor-scrim', 'pcolor-name', 'pcolor-path', 'pcolor-swatches',
    'pcolor-input', 'pcolor-done', 'new-project',
    'new-cron', 'new-cron-row', 'new-cron-note', 'new-gate-ref', 'new-gate-row',
    'new-gate-kind', 'new-gate-note', 'new-gate-ref-row', 'new-pr-row',
    'new-pr-drafts', 'new-pr-post', 'new-sched-save', 'new-sched',
    'new-when-date', 'new-when-once-time', 'new-when-count', 'new-when-unit',
    'new-when-daily-time', 'new-when-weekly-time', 'new-when-days',
    'new-when-dom', 'new-when-monthly-time',
    'notes-notable', 'notes-all', 'notes-clear',
    'lock', 'lock-text', 'lock-fork', 'lock-anyway',
    'btn-live', 'live-badge', 'live', 'live-sub', 'live-body', 'live-focus', 'focus-exit',
    'live-side', 'live-side-label', 'live-side-a', 'live-side-b',
    'new-scrim', 'new-cwd', 'new-picker', 'new-prompt', 'new-model', 'new-perm',
    'new-test', 'new-test-row', 'new-go', 'new-save', 'new-title', 'new-name',
    'new-tab-recent', 'new-tab-browse', 'new-browse', 'new-roots', 'new-crumbs',
    'new-tree', 'new-mkdir', 'new-mkdir-name', 'new-mkdir-go', 'new-browse-note',
    'del-scrim', 'del-what', 'del-meta', 'del-go',
    'diff-scrim', 'diff-title', 'diff-stat', 'diff-unified', 'diff-split',
    'diff-words', 'diff-wrap', 'diff-source', 'diff-note', 'diff-jump',
    'diff-reload', 'diff-copy', 'diff-open', 'diff-body', 'ctx-menu',
    'bar-more-wrap', 'bar-more', 'bar-more-badge', 'bar-more-menu',
    'review-scrim', 'review-modal', 'review-kind', 'review-title', 'review-when',
    'review-outcome', 'review-body', 'review-jump',
    'pair-url', 'pair-host', 'pair-hosts', 'pair-note', 'pair-copy',
    'restart-scrim', 'restart-lede', 'restart-problems',
    'restart-fix', 'restart-go', 'preview']) {
    dom[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = $(id);
}
// The two containers that carry layout state as data attributes rather than
// holding content of their own, so they have classes instead of ids.
dom.main = document.querySelector('.main');
dom.app = document.querySelector('.app');

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function el(tag, attrs, ...kids) {
    // createElement('svg') yields an unknown HTML element that never renders.
    const n = tag === 'svg' ? document.createElementNS(SVG_NS, 'svg')
        : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
        else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
        if (kid === null || kid === undefined || kid === false) continue;
        n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
}

/**
 * @param {object} [opts] {ms, action:{label, onClick}} — an action keeps the
 * toast up until it is used or dismissed, since it is the recovery path.
 */
export function toast(text, kind = 'info', opts = {}) {
    const { ms = 4200, action = null } = typeof opts === 'number' ? { ms: opts } : opts;
    const t = el('div', { class: 'toast', 'data-kind': kind },
        el('span', { class: 'toast-text' }, text));

    if (action) {
        t.append(el('button', {
            class: 'toast-action', type: 'button',
            onclick: () => { t.remove(); action.onClick(); },
        }, action.label));
    }
    t.append(el('button', {
        class: 'toast-close', type: 'button', 'aria-label': 'Dismiss',
        onclick: () => t.remove(),
    }, '✕'));

    dom.toasts.append(t);
    if (!action) setTimeout(() => t.remove(), ms);
    return t;
}

/**
 * Is one of the modal dialogs up? They are `hidden`-toggled divs rather
 * than a native `<dialog>`, so asking the DOM is the only way.
 *
 * Deliberately not a count — this said "six" through two additions and was
 * wrong by the time anyone read it.
 *
 * **A modal is closed by its own ✕ or Cancel, or by a whole click outside it —
 * never by Escape.** It used to go on Escape and on any click landing on the
 * scrim, and both were losing work that only exists in the page:
 * Start-a-session holds a written prompt, a directory and attachments that were
 * never uploaded, and closing it discards the attachments. Escape reaches this
 * app while a dictation tool is cancelling a phrase — Wispr Flow binds it — so
 * it stays swallowed. The scrim click came back once it could be told apart
 * from a drag; see closeOnClickOutside().
 */
export function modalUp() {
    return !dom.newScrim.hidden || !dom.delScrim.hidden
        || !dom.restartScrim.hidden || !dom.taskScrim.hidden
        // Both snippet dialogs hold work that only exists in the page — typed
        // parameter values, and a whole snippet body — so the rule above covers
        // them for the reason it covers Start-a-session. The parameter one can
        // also be up *over* Start-a-session, which is why it is a second term
        // rather than a case: Escape must be swallowed either way.
        || !dom.snipFillScrim.hidden || !dom.snipEditScrim.hidden
        // And the full-height CLAUDE.md editor, which is the plainest case on
        // this list: what it holds is a whole file somebody is part-way through
        // writing. Closing it keeps the draft, so Escape here would not have
        // *lost* anything — but six dialogs swallow the key and a seventh that
        // answered it would be the special case this function exists to stop.
        || !dom.memoScrim.hidden
        // The diff viewer is the one on this list that holds no work at all — it
        // is a read-only view and closing it loses nothing, so the paragraph
        // above is not what puts it here. The sentence after it is: six dialogs
        // swallow the key and a seventh that answered it would be exactly the
        // special case this function exists to stop.
        || !dom.diffScrim.hidden
        // The plan/question review, which is the diff viewer's case exactly: a
        // read-only replay holding no work, so the paragraph above is not what
        // puts it here either. The sentence after it is.
        || !dom.reviewScrim.hidden;
}

/**
 * Close a modal on a click that both starts and ends on its scrim.
 *
 * A `click` alone cannot say that. Drag-selecting in the First message box and
 * releasing past the dialog's edge fires one whose target is the common
 * ancestor of the press and the release — the scrim — and so does the mirror
 * image, a press on the scrim released inside the dialog. So the press and the
 * release are each checked against the scrim itself, and the `click` that
 * follows only closes when both were outside. `=== scrim` rather than
 * `contains`: the scrim contains the dialog, and anything in the dialog is in.
 */
export function closeOnClickOutside(scrim, close) {
    let down = false, up = false;
    scrim.addEventListener('mousedown', (e) => {
        down = e.button === 0 && e.target === scrim;
        up = false;
    });
    scrim.addEventListener('mouseup', (e) => {
        up = down && e.button === 0 && e.target === scrim;
    });
    scrim.addEventListener('click', () => {
        const go = down && up;
        down = up = false;
        if (go) close();
    });
}
