// The Memory group — the user's and the project's CLAUDE.md in a text box — and
// the full-height dialog that edits the same file. Moved out of app.js as it was.
//
// The group is Preact, drawn as part of the Settings tree rather than hung in
// it as foreign DOM — see web/rail.js for the pattern. What that settled here:
// the box is controlled, and typing redraws this group alone through its own
// counter (NotifyGroup's arrangement), so the foot is drawn from state instead
// of three nodes painted by hand, and the caret stays put because Preact leaves
// a `value` that already matches alone. The rendered markdown lives in a node
// Preact renders empty (MdPreview), so it can still be written at most once a
// frame. The dialog is markup in web/index.html and stays painted by hand,
// except its Edit/Split/Preview, which share the panel's builder.
//
// Imports from app.js, which imports this — safe because nothing here reads an
// app.js binding while the module evaluates, only when a function is called.
// Keep it that way: a module-level `const` built from an app.js `const` throws,
// because every module under web/settings/ evaluates before app.js's body runs.

import { html, useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact.js';
import { get, put } from '../api.js';
import { dom, closeModal, openModal, toast } from '../dom.js';
import { shortPath } from '../format.js';
import { renderMarkdown } from '../markdown.js';
import { state } from '../state.js';
import { formatBytes } from '../composer/attachments.js';
import { grow } from '../composer/send.js';
import { paint } from '../boards/parts.js';
import { copyPath } from './claude-config.js';
import { renderSettings, settingsProject } from './index.js';

// ── Claude Code's memory files ───────────────────────────────────────────
//
// `~/.claude/CLAUDE.md` and the open project's own, in a text box. The group
// above this one edits the same owner's *settings*; this edits their
// instructions, and the difference is not cosmetic:
//
// **These two files are additive.** Claude Code reads the user file and the
// project file and both are in force — there is no precedence, nothing
// overrides anything, and the "Overridden by … — this has no effect here"
// sentence every other scope-aware control on this page can draw would be a lie
// here. What each tab says instead is that the other file also applies, with
// its size, so the scope tabs cannot be misread as a chain.
//
// **The whole control is a draft.** The JSON tab next door is the page's one
// exception to the no-drafts rule; this is the second, and it is the same
// exception rather than a new one. That rule exists so a *control* cannot
// disagree with what is in force — a checkbox reading "on" for a setting that
// is off is the failure it prevents. A document somebody is typing into is a
// draft by nature: there is no keystroke at which the paragraph is finished,
// and saving per keystroke would write half-sentences into a file every session
// on this machine reads. So it gets a Save button, and it keeps the rule's
// intent the way the JSON tab does — by saying out loud, at all times, whether
// what you are looking at is what is on disk.
//
// A textarea rather than a vendored editor, for the reason
// docs/plans/20-claude-config.md gives: a few hundred kilobytes of code editor
// with no build step to prune it, to edit a twenty-kilobyte markdown file, is a
// poor trade. What an editor would have earned here — seeing the headings as
// headings — is renderMarkdown, which this page already has.

/** The two scopes, named for a person. */
const MEMORY_SCOPES = { user: 'User', project: 'Project' };

function docsState() {
    return state.claudeDocs;
}

/** The directory this group is about — the same one the page's selector picks. */
function docsDir() {
    return settingsProject();
}

export async function loadClaudeDocs() {
    const s = docsState();
    if (s.loading) return;
    s.loading = true;
    s.error = null;
    renderSettings();
    try {
        const dir = docsDir();
        s.data = await get(`/api/claude-docs${dir ? `?cwd=${encodeURIComponent(dir)}` : ''}`);
        // A *clean* draft is dropped so the box reseeds from what was just
        // read. Without this the lazy seed in docsEditorCard() wins forever:
        // renderSettings() runs once before this fetch returns, seeds `draft`
        // from the data then in hand, and every render after it finds a
        // non-null draft and leaves it alone — so the box goes on showing text
        // that is neither what somebody typed nor what is on disk. Found by
        // deleting a file behind the page and watching it keep the old
        // contents while the file line correctly said "will be created".
        //
        // A dirty draft is kept, which is the whole point of the 409 handling
        // below and is why this is not simply `s.draft = null`.
        if (!s.dirty) s.draft = null;
        // With no project there is no project row, so a scope selected earlier
        // would leave the group with nothing to draw and no way back to
        // something that works.
        if (!docsRow()) s.scope = 'user';
    } catch (err) {
        s.data = null;
        s.error = err.message;
    }
    s.loading = false;
    renderSettings();
}

/** The row for the selected scope, out of what the bridge reported. */
export function docsRow() {
    const s = docsState();
    if (!s.data) return null;
    return s.data.docs.find(d => d.scope === s.scope) || null;
}

/** The other one — the file that also applies, whichever tab you are on. */
function docsOtherRow() {
    const s = docsState();
    if (!s.data) return null;
    return s.data.docs.find(d => d.scope !== s.scope) || null;
}

/** Bytes, not characters. A 23KB CLAUDE.md is a hundred characters short of it. */
const docsBytes = (text) => new TextEncoder().encode(text || '').length;

/**
 * The counter under the box.
 *
 * Exact bytes rather than formatBytes(), which is the right call everywhere
 * else in this app and the wrong one here: rounded to "3.8 KB" the number does
 * not move while somebody types, and a counter that does not respond to typing
 * is furniture. The cap beside it is rounded, because that one never changes.
 */
function docsCount(bytes, cap) {
    const n = bytes.toLocaleString();
    return cap ? `${n} bytes of ${formatBytes(cap)}` : `${n} bytes`;
}

/** Is this file one the box may be typed into at all? */
function docsEditable(row) {
    return !!row && row.writable && !row.symlink && !row.truncated;
}

/**
 * Leaving a scope or discarding with something unsaved in the box.
 *
 * A confirm rather than an autosave, because the whole point of the Save button
 * is that this app does not get to decide when a paragraph is finished.
 */
function docsMayLeave(s) {
    if (!s.dirty) return true;
    const row = docsRow();
    return window.confirm(
        `Discard the changes you have made to ${row ? shortPath(row.file) : 'this file'}?`);
}

export function docsClearDraft(s) {
    s.draft = null;
    s.dirty = false;
    s.stale = null;
    s.caret = 0;
    restoreCaret = false;
}

// ── rendering ──────────────────────────────────────────────────────────────

// The mounted group's own redraw, or the page's when it is not mounted.
let redrawDocs = null;
const again = () => (redrawDocs ? redrawDocs() : renderSettings());

// Set by whatever takes the caret away from the box on purpose — a view switch,
// the dialog — and spent by the box the next time it is drawn. A flag rather
// than "`s.caret` is not zero", which re-focused the box on every redraw of the
// page, wherever the focus had gone since.
let restoreCaret = false;

/**
 * The whole group, for SETTINGS' `card`.
 *
 * Two cards, like Claude Code's group, so the head and the editor are separate
 * sections under one contents entry — returned as an array, since the vendored
 * Preact has no Fragment to wrap them in.
 */
export function renderClaudeDocs() {
    return html`<${DocsGroup} key="memory" />`;
}

function DocsGroup() {
    const [, redraw] = useState(0);
    redrawDocs = () => redraw(n => n + 1);
    useEffect(() => () => { redrawDocs = null; }, []);

    const s = docsState();
    let tail = null;
    if (s.error) {
        tail = html`<div class="settings-error">${
            `Could not read Claude Code’s memory files: ${s.error}`}</div>`;
    } else if (!s.data) {
        tail = html`<div class="settings-empty">Reading…</div>`;
    } else if (s.stale) {
        tail = docsStaleBanner();
    }
    const head = html`<section key="head" class="settings-group" id="set-g-memory">
        <h2 class="settings-group-title">Claude Code · Memory</h2>
        <p class="settings-group-note">${'The instructions '}<code>claude</code>${' is given before your '
            + 'first message — '}<code>CLAUDE.md</code>${', yours and this '
            + 'project’s. Both apply at once; neither overrides the other.'}</p>
        ${docsScopeTabs()}
        ${docsFileLine()}
        ${docsBothNote()}
        ${docsReachNote()}
        ${tail}
    </section>`;
    if (s.error || !s.data) return [head];
    return [head, html`<${DocsEditor} key="file" />`];
}

/** Which file, and which of the two ways of looking at it. */
function docsScopeTabs() {
    const s = docsState();
    const rows = s.data ? s.data.docs : [];
    // Both tabs are drawn even when the bridge sent no row for one, disabled
    // with a reason. Absent, the project tab would make it look as though this
    // app only knows about one CLAUDE.md.
    return html`<div class="cfg-tabs" role="tablist">
        ${['user', 'project'].map((scope) => {
            const row = rows.find(d => d.scope === scope);
            return html`<button key=${scope} class=${`cfg-tab${scope === s.scope ? ' on' : ''}`}
                type="button" role="tab" disabled=${!row}
                aria-selected=${scope === s.scope ? 'true' : 'false'}
                title=${row ? row.file : 'Pick a project above'}
                onClick=${() => {
                    if (!docsMayLeave(s)) return;
                    s.scope = scope;
                    docsClearDraft(s);
                    renderSettings();
                }}>${MEMORY_SCOPES[scope]}${
                    row && !row.exists ? html`<span class="cfg-tab-tag">none</span>` : null}${
                    row && row.symlink ? html`<span class="cfg-tab-tag">symlink</span>` : null}</button>`;
        })}
        <div class="cfg-tabs-spacer"></div>
        ${viewTabsV(s.view, (view) => {
            // Where the caret was, so coming back does not drop somebody at
            // the top of a twenty-thousand-character file. Split has a box
            // too, so this is any move away from one, not only to Preview.
            const box = dom.setBody.querySelector('.cfg-md');
            if (box) s.caret = box.selectionStart || 0;
            restoreCaret = true;
            s.view = view;
            try { localStorage.setItem('memoView', view); } catch { /* per-session then */ }
            renderSettings();
        })}
    </div>`;
}

const MEMO_VIEWS = [['edit', 'Edit'], ['split', 'Split'], ['preview', 'Preview']];

/** Edit · Split · Preview, for the panel and the dialog alike. */
export function viewTabsV(current, pick) {
    return MEMO_VIEWS.map(([view, label]) => html`<button key=${view}
        class=${`cfg-tab${view === current ? ' on' : ''}`} type="button"
        aria-pressed=${view === current ? 'true' : 'false'}
        onClick=${() => { if (view !== current) pick(view); }}>${label}</button>`);
}

/**
 * Render `s.draft` into `node`, at most once a frame.
 *
 * Split re-renders on every keystroke, and a 23KB file through renderMarkdown
 * is a few milliseconds — fine once, not fine queued behind a held key. A
 * frame is the natural batch: nothing drawn more often could be seen.
 */
const previewPending = new WeakSet();
export function schedulePreview(node) {
    if (previewPending.has(node)) return;
    previewPending.add(node);
    requestAnimationFrame(() => {
        previewPending.delete(node);
        node.innerHTML = renderMarkdown(docsState().draft || '');
    });
}

/**
 * Keep the preview beside a box at the same place in the document.
 *
 * Proportional, and one way — box to preview. Rendered markdown is not the same
 * height as its source line for line, so a ratio is an approximation, but for
 * prose it lands on the paragraph being typed. Syncing back the other way makes
 * each scroll trigger the other's and the two fight.
 */
export function syncPreviewScroll(box, preview) {
    const room = box.scrollHeight - box.clientHeight;
    const ratio = room > 0 ? box.scrollTop / room : 0;
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
}

/**
 * The rendered markdown, in a node whose contents Preact never sees.
 *
 * Rendered with no children, so a redraw has nothing to diff inside it and the
 * HTML written here stays — the same arrangement as the foreign host in
 * index.js. Rendered at once when it appears, so a scroll sync straight after
 * has a height to work with, and through schedulePreview() after that, so a
 * held key costs one markdown render a frame.
 */
function MdPreview({ text, nodeRef }) {
    const own = useRef(null);
    const ref = nodeRef || own;
    const drawn = useRef(false);
    useLayoutEffect(() => {
        if (!drawn.current) {
            drawn.current = true;
            ref.current.innerHTML = renderMarkdown(text || '');
        } else {
            schedulePreview(ref.current);
        }
    }, [text]);
    return html`<div class="cfg-md-preview prose" ref=${ref}></div>`;
}

/** The path being written, and everything true about it worth saying. */
function docsFileLine() {
    const s = docsState();
    const row = docsRow();
    if (!row) {
        return html`<div class="settings-file"><span class="settings-file-none"
            >No project selected — pick one above to edit its CLAUDE.md.</span></div>`;
    }
    const tag = (text, bad) => html`<span class=${bad ? 'settings-file-tag bad' : 'settings-file-tag'}
        >${text}</span>`;
    return html`<div class="settings-file">
        <span class="settings-file-lede">Writing to</span>
        <button class="settings-file-path" type="button" title="Copy this path"
            onClick=${() => copyPath(row.file)}>${row.file}</button>
        ${!row.exists ? tag('will be created') : null}
        ${row.symlink ? tag('a symlink — saving is refused', true) : null}
        ${row.truncated ? tag('too large to edit here', true) : null}
        ${!row.writable && !row.symlink ? tag('not writable', true) : null}
        ${s.saving ? tag('saving…') : null}
    </div>`;
}

/**
 * The other file, which also applies.
 *
 * This is the sentence that stops the scope tabs reading as a precedence
 * chain — which is the shape every other scope selector on this page really
 * is. The group above answers the same question with inherited permission rules
 * listed read-only beside the editable ones; there is no per-entry equivalent
 * for prose, so it is one line with a size on it.
 */
function docsBothNote() {
    const other = docsOtherRow();
    if (!other) return null;
    const name = MEMORY_SCOPES[other.scope].toLowerCase();
    return html`<p class="settings-group-note cfg-md-both">${other.exists
        ? `The ${name} file applies as well — ${formatBytes(other.size)} at `
        : `The ${name} file would apply as well, but is not there yet: `}<code
        >${shortPath(other.file)}</code>${other.exists ? '. Neither replaces the other.' : '.'}</p>`;
}

/** The sentence that stops "I changed it and nothing happened". */
function docsReachNote() {
    return html`<p class="cfg-reach"><strong>Claude Code reads these when a session starts.</strong>${
        ' A session already running has them in its context and will never pick up '
        + 'an edit — not "not yet". Start a new one, or say the change in a message.'}</p>`;
}

/** A conflict, kept on screen rather than thrown at a toast. */
function docsStaleBanner() {
    const s = docsState();
    return html`<div class="cfg-stale">
        <div class="cfg-stale-head">This file changed on disk since the page read it.</div>
        <p>${'Nothing was overwritten, and nothing you typed was lost — what is in '
            + 'the box is still yours. Below is the file as it is now.'}</p>
        ${s.stale.text ? html`<details><summary>What is on disk</summary><pre
            class="cfg-stale-text">${s.stale.text}</pre></details>` : null}
        <button class="linkish" type="button"
            onClick=${() => { s.stale = null; renderSettings(); }}>Dismiss</button>
    </div>`;
}

/**
 * The file itself, in a text box — or the same text rendered.
 *
 * A component for the two refs it holds: the box, which its effects size and
 * put the caret back in, and the preview, which the box's scroll drives. The
 * box is controlled and typing redraws only this group, so the foot's note,
 * count, Discard and Save are drawn from state rather than painted by hand —
 * and the caret, which Preact leaves alone while `value` already matches, stays
 * where it was.
 */
function DocsEditor() {
    const s = docsState();
    const row = docsRow();
    const box = useRef(null);
    const preview = useRef(null);
    const split = s.view === 'split';

    // Sized on the way in as well as on input. Without this the box opens at
    // its CSS height and jumps on the first keystroke. Split is two panes of
    // one fixed height rather than a box that grows: grow() would lengthen the
    // left one on every new line while the right one stayed put, and the two
    // would stop lining up at the top. grow() writes `style`, which Preact is
    // never given for this node.
    useLayoutEffect(() => {
        if (box.current && !split) grow(box.current, 220, 560);
    }, [s.view, s.draft]);
    // Coming back from Preview, or from the dialog.
    useLayoutEffect(() => {
        const b = box.current;
        if (!restoreCaret || !b) return;
        restoreCaret = false;
        if (!s.caret) return;
        const at = Math.min(s.caret, (s.draft || '').length);
        b.focus();
        b.setSelectionRange(at, at);
        if (preview.current) syncPreviewScroll(b, preview.current);
    });

    const card = (...kids) => html`<section class="settings-group cfg-sub" id="set-g-memory-file"
        ><h3 class="settings-group-title">The file itself</h3>${kids}</section>`;

    if (!row) return card(html`<div class="cfg-list-none">No file for that scope.</div>`);
    // A file past the cap is reported rather than opened, because the bridge
    // sends no text for one — and a box seeded with the first 256KB of a larger
    // file would delete the rest on the first save. Saying so beats a box that
    // looks like it works.
    if (row.truncated) {
        return card(html`<div class="cfg-list-none">${`That file is ${formatBytes(row.size)}, which is past the `
            + `${formatBytes(s.data.maxBytes)} this page will open. Edit it in a text editor.`}</div>`);
    }

    const onDisk = row.text === null ? '' : row.text;
    // Seeded lazily, inside the render, so a re-render can never clobber typing
    // and `draft === null` stays the one meaning of "nothing unsaved".
    if (s.draft === null) s.draft = onDisk;
    const editable = docsEditable(row);

    if (s.view === 'preview') {
        return card(
            html`<p key="note" class="settings-group-note">${s.dirty
                ? 'Rendering what is in the box, not what is on disk.'
                : 'Rendering the file as it is on disk.'}</p>`,
            html`<${MdPreview} key="preview" text=${s.draft} />`,
            docsFoot(row, editable));
    }

    const textarea = html`<textarea key="box" ref=${box} class="cfg-md" spellcheck=${false}
        autocapitalize="off" autocorrect="off" disabled=${!editable} value=${s.draft}
        onInput=${(e) => {
            s.draft = e.target.value;
            s.dirty = s.draft !== onDisk;
            again();
        }}
        onScroll=${split ? (e) => { if (preview.current) syncPreviewScroll(e.target, preview.current); } : null}
        ></textarea>`;

    return card(
        html`<p key="note" class="settings-group-note">${editable
            ? 'Saved exactly as typed — no reformatting, and the trailing newline is '
            + 'yours to get right.'
            : 'Read-only.'}</p>`,
        split
            ? html`<div key="split" class="cfg-md-split">${textarea}<${MdPreview} key="preview"
                text=${s.draft} nodeRef=${preview} /></div>`
            : textarea,
        docsFoot(row, editable));
}

/**
 * The row under the box: what state the draft is in, how big it is, and Save.
 * Discard is only an offer while there is something to discard.
 */
function docsFoot(row, editable) {
    const s = docsState();
    const bytes = docsBytes(s.draft);
    const cap = (s.data && s.data.maxBytes) || 0;
    const over = !!cap && bytes > cap;
    return html`<div key="foot" class="cfg-json-foot">
        <div class=${`cfg-json-note${over ? ' bad' : ''}`}>${over
            ? `That is ${formatBytes(bytes)}, past the ${formatBytes(cap)} limit — saving is refused.`
            : (s.dirty ? 'Edited — not saved.' : 'Matches the file on disk.')}</div>
        <div class="cfg-json-acts">
            <span class="cfg-md-count">${docsCount(bytes, cap)}</span>
            <button class="linkish cfg-md-discard" type="button" hidden=${!s.dirty}
                onClick=${() => {
                    if (!docsMayLeave(s)) return;
                    docsClearDraft(s);
                    renderSettings();
                }}>Discard changes</button>
            <button class="linkish cfg-md-expand" type="button"
                title="Edit this in a full-height window"
                onClick=${() => openMemoDialog()}>Expand</button>
            <button class="dash-btn cfg-md-save" type="button"
                disabled=${!editable || !s.dirty || over}
                onClick=${() => saveClaudeDocs()}>${row && !row.exists ? 'Create the file' : 'Save the file'}</button>
        </div>
    </div>`;
}

/**
 * The save.
 *
 * Always stamped: every write here replaces the whole file, which is exactly
 * the case the bridge requires a stamp for. A file that is not there yet sends
 * `null`, which asks to create it and is refused if something else got there
 * first.
 */
export async function saveClaudeDocs() {
    const s = docsState();
    const row = docsRow();
    if (!row || s.draft === null) return;
    s.saving = true;
    renderSettings();
    try {
        const answer = await put('/api/claude-docs', {
            scope: s.scope,
            cwd: docsDir(),
            stamp: row.exists ? row.stamp : null,
            text: s.draft,
        });
        s.data = { docs: answer.docs, maxBytes: answer.maxBytes };
        docsClearDraft(s);
        toast(`${shortPath(answer.file)} written.`, 'ok');
    } catch (err) {
        if (err.status === 409) {
            // The draft is kept. Losing what somebody typed in order to show
            // them what somebody else typed is the one unforgivable move here,
            // and a CLAUDE.md is somebody's afternoon rather than a checkbox.
            s.stale = { text: (err.data && err.data.text) || null };
            toast('That file changed on disk. Your draft is kept — compare and save again.', 'warn');
            const keep = s.draft;
            const caret = s.caret;
            await loadClaudeDocs();
            s.draft = keep;
            s.dirty = true;
            s.caret = caret;
        } else {
            toast(`Could not save that file: ${err.message}`, 'error');
        }
    }
    s.saving = false;
    renderSettings();
    if (!dom.memoScrim.hidden) paintMemoDialog();
}

// ── the same file, full height ───────────────────────────────────────────
//
// The settings panel is a column, and a 23KB CLAUDE.md in a 560px box is a
// keyhole. Expand puts the same draft in a dialog with the height of the
// window.
//
// It is the *same* draft, not a copy: both textareas write
// `state.claudeDocs.draft`, only one of them is on screen at a time, and Save
// does the same thing from either — so there is no second source of truth to
// reconcile. The markup lives in web/index.html because a scrim is wired once
// at load, the way the `node` groups in SETTINGS are.
//
// It closes by its ✕ or Close and nothing else — see modalUp() for the rule and
// why Escape is swallowed rather than answered.

function openMemoDialog() {
    const s = docsState();
    const row = docsRow();
    if (!row || row.truncated) return;
    if (s.draft === null) s.draft = row.text === null ? '' : row.text;
    const box = dom.setBody.querySelector('.cfg-md');
    if (box) s.caret = box.selectionStart || 0;
    openModal(dom.memoScrim);
    paintMemoDialog();
    // The preview is rendered now rather than on the next frame, so the
    // scroll sync below has a height to work with.
    dom.memoPreview.innerHTML = renderMarkdown(s.draft);
    const at = Math.min(s.caret || 0, s.draft.length);
    dom.memoBig.setSelectionRange(at, at);
    if (s.dialogView !== 'preview') dom.memoBig.focus();
    syncPreviewScroll(dom.memoBig, dom.memoPreview);
}

/** The dialog's Edit / Split / Preview. It keeps its own, apart from the panel's. */
function setMemoDialogView(view) {
    const s = docsState();
    s.dialogView = view;
    try { localStorage.setItem('memoDialogView', view); } catch { /* per-session then */ }
    paintMemoDialog();
    if (view !== 'preview') dom.memoBig.focus();
}

export function closeMemoDialog() {
    const s = docsState();
    s.caret = dom.memoBig.selectionStart || 0;
    closeModal(dom.memoScrim);
    // Redraw the inline card from the draft the dialog was editing, and put the
    // caret back in it where the dialog left it.
    restoreCaret = true;
    renderSettings();
}

/** Everything in the dialog that depends on state. */
export function paintMemoDialog() {
    const s = docsState();
    const row = docsRow();
    if (!row) return;
    const editable = docsEditable(row);
    const bytes = docsBytes(s.draft);
    const cap = (s.data && s.data.maxBytes) || 0;
    const over = !!cap && bytes > cap;

    dom.memoTitle.textContent = shortPath(row.file);
    // Only when it differs, so a repaint mid-typing does not move the caret.
    if (dom.memoBig.value !== s.draft) dom.memoBig.value = s.draft || '';
    // Which panes show is CSS off this one attribute, so the textarea is never
    // rebuilt and switching views keeps the caret and the undo history.
    dom.memoBody.dataset.view = s.dialogView;
    paint(dom.memoViews, viewTabsV(s.dialogView, setMemoDialogView));
    if (s.dialogView !== 'edit') schedulePreview(dom.memoPreview);
    dom.memoBig.disabled = !editable;
    dom.memoCount.textContent = docsCount(bytes, cap);
    dom.memoNote.className = `cfg-json-note${over ? ' bad' : ''}`;
    dom.memoNote.textContent = over
        ? `That is ${formatBytes(bytes)}, past the ${formatBytes(cap)} limit — saving is refused.`
        : (s.dirty ? 'Edited — not saved.' : 'Matches the file on disk.');
    dom.memoSave.disabled = !editable || !s.dirty || over;
    dom.memoSave.textContent = row.exists ? 'Save the file' : 'Create the file';
}
