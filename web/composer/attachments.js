// Attachments: files pasted, dropped or picked into either composer, staged as
// chips, uploaded into the session's checkout (the live composer) or held until
// the session exists (the Start-a-session dialog). Moved out of app.js as it was.
// wireAttachments(c) is called once per composer, by slash.js for the live one
// and by app.js for the dialog's.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.

import { post, postFile } from '../api.js';
import { el, toast } from '../dom.js';
import { state } from '../state.js';
import { saveAttach } from '../app.js';

// ── attachments ──────────────────────────────────────────────────────────
// Files pasted or dropped onto a composer.
//
// Under a live conversation each one is uploaded the moment it arrives, before the
// message is sent. That is what makes the rest of this simple: the chip shows the name
// the file really has on disk, a staged file survives a reload because only its path
// has to be remembered, and the send stays the same small JSON POST it always was — a
// list of paths, not a payload. The bridge writes them into attached_assets/ at the
// root of the session's checkout; see bridge/attachments.js for why there.
//
// **The Start-a-session dialog cannot do that, and holds its files instead.** Where a
// file lands is decided by the working directory, and that box is still editable after
// you have pasted — so uploading on arrival would put the screenshot in whichever
// project happened to be selected at the time, and leave it there when you browsed
// somewhere else and pressed Start. Held chips are committed by startNew, once the
// directory has stopped moving.
//
// Three things follow from holding them, and they are the price of it. A held chip
// shows the name you gave rather than the name on disk, because a collision has not
// renamed it yet. It does not survive a reload, since the bytes are in this page — and
// nothing is lost, because a reload closes the dialog anyway. And Start becomes two
// phases, which is why it refuses to start at all if an upload fails: a first message
// naming a file that was never written is worse than not starting.

// Matches the bridge, which is the side that enforces them. Checked here so that
// dropping a video says what the limit is instead of uploading 200MB to be refused.
const MAX_ATTACH_BYTES = 25 * 1024 * 1024;
const MAX_ATTACH_FILES = 5;

// The types the bridge will inline as an image, and so the ones a chip draws a
// thumbnail for.
const ATTACH_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function formatBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A name for a file that arrived without a usable one.
 *
 * A pasted screenshot is `image.png` in Chromium and nameless everywhere else, so the
 * client always supplies something and the bridge always requires it — better here,
 * where the clock and the media type are both to hand, than invented server-side.
 */
function attachName(file) {
    if (file.name) return file.name;
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
        + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const ext = (file.type || '').split('/')[1] || 'bin';
    return `pasted-${stamp}.${ext === 'jpeg' ? 'jpg' : ext}`;
}

/** Does this drag carry files, as opposed to one of our own chips? */
export function dragHasFiles(dt) {
    return Boolean(dt && Array.from(dt.types || []).includes('Files'));
}

/**
 * Take files in — from a paste, a drop, or the paperclip. The single entry point.
 *
 * Uploaded one at a time rather than all at once. It keeps several 25MB bodies off the
 * wire together, and it makes the per-chip failure story true: four succeed and the
 * fifth goes red, instead of a batch that half-worked.
 */
async function attachFiles(c, list) {
    if (!c.ctx()) {
        // The dialog can be in this state — no directory chosen — and a file that
        // arrives now has nowhere to be described relative to.
        if (c.notReady) toast(c.notReady, 'warn');
        return;
    }
    const files = Array.from(list || []).filter(f => f && f.size !== undefined);
    if (!files.length) return;

    const room = MAX_ATTACH_FILES - c.attach.length;
    if (room <= 0) {
        toast(`${MAX_ATTACH_FILES} files is the limit for one message.`, 'warn');
        return;
    }
    if (files.length > room) {
        toast(`Only ${room} more file${room === 1 ? '' : 's'} fit on this message.`, 'warn');
    }

    for (const file of files.slice(0, room)) {
        // Refused here, with the number in it. The bridge refuses it too, but a 413
        // arriving after a 40MB upload is a worse way to learn the same thing.
        if (file.size > MAX_ATTACH_BYTES) {
            toast(`${file.name || 'That file'} is ${formatBytes(file.size)} — the limit `
                + `is ${formatBytes(MAX_ATTACH_BYTES)}.`, 'warn');
            continue;
        }
        if (!file.size) {
            toast(`${file.name || 'That file'} is empty.`, 'warn');
            continue;
        }

        const entry = {
            key: `a${++c.attachSeq}`,
            name: attachName(file),
            bytes: file.size,
            mediaType: file.type || 'application/octet-stream',
            // Cheaper than a FileReader and it never holds the bytes in a string.
            // Revoked on removal, on send and on leaving the session.
            previewUrl: ATTACH_IMAGE_TYPES.has(file.type) ? URL.createObjectURL(file) : null,
            path: null, relPath: null,
            // `held` is the deferred composer's resting state: on disk nowhere, and
            // waiting for a directory to stop moving.
            status: c.uploadMode === 'deferred' ? 'held' : 'uploading',
            error: null,
            file,
        };
        c.attach.push(entry);
        renderAttach(c);
        if (c.uploadMode !== 'deferred') await uploadAttachment(c, entry);
    }
}

/**
 * Where one file goes: this composer's session if it has one, its directory if not.
 *
 * The two routes are the same upload — the session in the path was only ever a way of
 * naming a working directory. See docs/api.md on POST /api/attachments.
 */
function attachUrl(c, name) {
    const at = c.ctx();
    if (!at) return null;
    const n = `name=${encodeURIComponent(name)}`;
    return at.sessionId
        ? `/api/sessions/${at.sessionId}/attachments?${n}`
        : `/api/attachments?cwd=${encodeURIComponent(at.cwd)}&${n}`;
}

async function uploadAttachment(c, entry) {
    const url = attachUrl(c, entry.name);
    if (!url || !entry.file) return;
    entry.status = 'uploading';
    entry.error = null;
    renderAttach(c);
    try {
        const r = await postFile(url, entry.file);
        // The name on disk wins. A collision made it `shot-2.png`, and a chip still
        // saying `shot.png` would name a file the message does not attach.
        entry.name = r.name;
        entry.path = r.path;
        entry.relPath = r.relPath;
        entry.mediaType = r.mediaType;
        entry.bytes = r.bytes;
        entry.status = 'ready';
        // Nothing needs the File once the bytes are on disk, and holding it keeps a
        // blob alive for as long as the chip does.
        entry.file = null;
        saveAttachFor(c);
    } catch (err) {
        entry.status = 'failed';
        entry.error = err.message;
    }
    renderAttach(c);
}

/**
 * Put every held file on disk, and answer with what a create call should carry —
 * or null, meaning do not start.
 *
 * Refusing on the first failure is the whole point. The alternative is a session
 * whose first message names a file that was never written, which reads to the agent
 * as a missing file and to the person as the feature being broken. The chip keeps its
 * File, so the Retry button on it still works.
 */
export async function commitAttachments(c) {
    for (const a of c.attach) {
        if (a.status === 'ready') continue;
        await uploadAttachment(c, a);
        if (a.status !== 'ready') {
            toast(`Could not attach ${a.name}: ${a.error || 'upload failed'}`, 'error');
            return null;
        }
    }
    return readyAttachments(c);
}

/** Only a composer with somewhere to persist to — see the section header. */
function saveAttachFor(c) {
    const id = c.persistKey && c.persistKey();
    if (id) saveAttach(id, c.attach);
}

/** Chips for files the bridge already knows about — a restored draft, or an edit. */
export function adoptAttachments(c, files) {
    for (const f of files || []) {
        if (c.attach.length >= MAX_ATTACH_FILES) break;
        if (c.attach.some(a => a.path && a.path === f.path)) continue;
        c.attach.push({
            key: `a${++c.attachSeq}`,
            name: f.name || String(f.relPath || '').split('/').pop(),
            bytes: f.bytes || 0,
            mediaType: f.mediaType || 'application/octet-stream',
            // No object URL: these files were never a File in this page. A restored
            // image chip draws the glyph rather than a broken img.
            previewUrl: null,
            path: f.path || null,
            relPath: f.relPath || null,
            status: 'ready',
            error: null,
            file: null,
        });
    }
    renderAttach(c);
    saveAttachFor(c);
}

function removeAttach(c, key) {
    const i = c.attach.findIndex(a => a.key === key);
    if (i < 0) return;
    const [gone] = c.attach.splice(i, 1);
    if (gone.previewUrl) URL.revokeObjectURL(gone.previewUrl);
    // Deliberately not deleted from disk. A delete route is a second thing that
    // writes to a checkout and a second refusal to reason about, and an unsent file
    // in attached_assets/ is a harmless untracked file you can see — where a delete
    // that resolves the wrong path is not harmless. A held file was never written at
    // all, so there is nothing to say about it either way.
    renderAttach(c);
    saveAttachFor(c);
}

/**
 * Everything staged, gone — on a send, or on leaving the session.
 *
 * `revoke: false` is for the send path, and it is not an optimisation. The row drawn
 * at the foot of the log the instant you press Enter shows the thumbnails, and those
 * are these object URLs; revoking them here blanked the image in the same frame it
 * appeared. So the send hands them to the pending row, which revokes them when it
 * goes — and every path that does not draw one revokes them itself.
 */
export function clearAttach(c, { save = true, revoke = true } = {}) {
    if (revoke) revokePreviews(c.attach.map(a => a.previewUrl));
    c.attach = [];
    renderAttach(c);
    if (save) saveAttachFor(c);
}

export function revokePreviews(urls) {
    for (const u of urls || []) if (u) URL.revokeObjectURL(u);
}

/** What a send may carry: the ones that made it to disk. */
export const readyAttachments = (c) => c.attach
    .filter(a => a.status === 'ready' && a.path)
    .map(a => ({ path: a.path, relPath: a.relPath, mediaType: a.mediaType, name: a.name }));

// The extension, for the glyph on a non-image chip. Short enough to read at 10px.
export function attachExt(name) {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
    return m ? m[1].toLowerCase() : 'file';
}

export function renderAttach(c) {
    const list = c.attach;
    c.attachNode.hidden = !list.length;
    c.attachNode.replaceChildren(...list.map((a) => {
        const bits = [];
        if (a.previewUrl) {
            bits.push(el('img', { class: 'attach-thumb', src: a.previewUrl, alt: '' }));
        } else {
            bits.push(el('span', { class: 'attach-glyph' }, attachExt(a.name)));
        }
        bits.push(el('span', { class: 'attach-name', title: a.relPath || a.name }, a.name));
        bits.push(el('span', { class: 'attach-size' },
            a.status === 'uploading' ? 'uploading…' : formatBytes(a.bytes)));
        if (a.status === 'failed') {
            bits.push(el('button', {
                class: 'attach-act', type: 'button', title: a.error || 'Upload failed',
                onclick: () => uploadAttachment(c, a),
            }, 'Retry'));
        }
        bits.push(el('button', {
            class: 'attach-act danger', type: 'button', 'aria-label': `Remove ${a.name}`,
            title: 'Remove', onclick: () => removeAttach(c, a.key),
        }, '×'));

        return el('div', {
            class: `attach-chip${a.status === 'ready' ? '' : ` ${a.status}`}`,
            title: a.status === 'failed' ? a.error : (a.relPath || a.name),
        }, ...bits);
    }));
    // An attachment on its own is a message, so whatever sends it has to follow the
    // strip and not only the box.
    if (c.afterRender) c.afterRender();
}

/**
 * A paste that carries files.
 *
 * The condition is narrow on purpose. Cancelling a paste that was only ever text is
 * the most likely way this feature breaks something that worked, and web/terminal.js
 * already carries a comment about the last time a paste handler in this codebase took
 * over more than it should have. A screenshot arrives with files and no `text/plain`;
 * a file copied out of a file manager brings `text/uri-list` alongside it; text
 * copied out of an editor brings `text/plain` and no files at all. So: files, and
 * either nothing textual or an actual image.
 */
function onComposerPaste(c, e) {
    const dt = e.clipboardData;
    if (!dt) return;
    const items = Array.from(dt.items || []);
    const files = Array.from(dt.files || []);
    if (!files.length && !items.some(i => i.kind === 'file')) return;

    const hasText = Array.from(dt.types || []).includes('text/plain');
    const anyImage = files.some(f => ATTACH_IMAGE_TYPES.has(f.type));
    if (hasText && !anyImage) return;

    e.preventDefault();
    attachFiles(c, files.length ? files
        : items.filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean));
}

/**
 * Dragging files over the composer.
 *
 * Both gates are before `preventDefault`, and that is what keeps the queue-chip drag
 * working without touching a line of it: a chip drag puts only `text/plain` on the
 * transfer, so `dragHasFiles` is false, this returns early, and #queue-list's own
 * dragover still sees the event exactly as it did before.
 */
function onComposerDragOver(c, e) {
    if (state.queueDrag) return;
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    c.dropZone.classList.add('drop-target');
}

function onComposerDragLeave(c, e) {
    // Only when the pointer has actually left the composer. Without the check the
    // highlight flickers off every time the drag crosses a child element.
    if (e.relatedTarget && c.dropZone.contains(e.relatedTarget)) return;
    c.dropZone.classList.remove('drop-target');
}

function onComposerDrop(c, e) {
    if (state.queueDrag) return;
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    c.dropZone.classList.remove('drop-target');
    attachFiles(c, e.dataTransfer.files);
}

/**
 * Everything a composer needs to take files: the strip, the picker, the drop zone.
 *
 * Separate from wireComposer because not every composer has one — a composer with no
 * `attachNode` simply never gets these listeners, and nothing else has to know.
 */
export function wireAttachments(c) {
    if (!c.attachNode) return;
    c.input.addEventListener('paste', (e) => onComposerPaste(c, e));
    c.dropZone.addEventListener('dragover', (e) => onComposerDragOver(c, e));
    c.dropZone.addEventListener('dragleave', (e) => onComposerDragLeave(c, e));
    c.dropZone.addEventListener('drop', (e) => onComposerDrop(c, e));
    if (c.attachBtn) {
        c.attachBtn.addEventListener('click', () => c.attachInput.click());
    }
    if (c.attachInput) {
        c.attachInput.addEventListener('change', () => {
            attachFiles(c, c.attachInput.files);
            // So picking the same file twice in a row fires `change` the second time.
            c.attachInput.value = '';
        });
    }
}

/**
 * Open one of a turn's attachments in whatever this machine opens that kind of file
 * with. The bridge re-derives the path against the session's own attachments
 * directory before launching anything — see `attachmentPath` in bridge/server.js.
 */
export async function openAttachment(sessionId, relPath) {
    try {
        await post(`/api/sessions/${sessionId}/attachments/open`, { path: relPath });
    } catch (err) {
        toast(`Could not open ${relPath}: ${err.message}`, 'warn');
    }
}
