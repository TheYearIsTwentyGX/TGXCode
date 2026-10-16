// The full-size preview behind a tool result's image: click the thumbnail in a
// Read's dropdown and the picture fills the window, with Copy, Save and Close
// in the corner.
//
// One `#img-scrim` in index.html, reused for every image, wired on first open
// rather than at load — this file is imported from tools.js, whose header says
// why nothing should run at the top level of a module in that cycle.
//
// Copy and Save fetch the bytes again rather than reading them off the <img>:
// the route answers with a private cache header, so the second request is the
// browser's cache and not the bridge, and a Blob is what both the clipboard and
// a download want.

import { closeModal, closeOnClickOutside, dom, el, openModal, toast } from '../dom.js';
import { icon } from '../icons.js';

let wired = false;
let current = null;

/**
 * @param {{src: string, name: string}} img  `name` is the file name offered by
 *   Save and shown in the bar.
 */
export function openImage(img) {
    wire();
    current = img;
    dom.imgTitle.textContent = img.name;
    dom.imgView.src = img.src;
    dom.imgView.alt = img.name;
    resetButtons();
    openModal(dom.imgScrim);
}

function closeImage() {
    // Emptied once it has faded, so the picture stays up while it goes.
    closeModal(dom.imgScrim, () => {
        dom.imgView.removeAttribute('src');
        current = null;
    });
}

function wire() {
    if (wired) return;
    wired = true;
    dom.imgCopy.append(icon('copy', 16));
    dom.imgSave.append(icon('download', 16));
    for (const n of dom.imgScrim.querySelectorAll('[data-close-img]')) {
        n.addEventListener('click', closeImage);
    }
    // A click in the bar's gaps lands on the bar, not the scrim, so it does
    // not close: closeOnClickOutside() wants press and release on the scrim.
    closeOnClickOutside(dom.imgScrim, closeImage);
    dom.imgCopy.addEventListener('click', copyImage);
    dom.imgSave.addEventListener('click', saveImage);
}

function resetButtons() {
    for (const [btn, name] of [[dom.imgCopy, 'copy'], [dom.imgSave, 'download']]) {
        clearTimeout(btn._doneTimer);
        btn.classList.remove('done');
        btn.replaceChildren(icon(name, 16));
    }
}

/** A tick in the button's place for a moment, as the message Copy does it. */
function done(btn, name) {
    btn.classList.add('done');
    btn.replaceChildren(icon('tick', 16));
    clearTimeout(btn._doneTimer);
    btn._doneTimer = setTimeout(() => {
        btn.classList.remove('done');
        btn.replaceChildren(icon(name, 16));
    }, 1400);
}

async function bytes() {
    const r = await fetch(current.src);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.blob();
}

/**
 * The clipboard takes PNG and nothing else, in every browser this runs in, so a
 * JPEG or WebP is redrawn as one first.
 */
async function asPng(blob) {
    if (blob.type === 'image/png') return blob;
    const bmp = await createImageBitmap(blob);
    const c = el('canvas', { width: bmp.width, height: bmp.height });
    c.getContext('2d').drawImage(bmp, 0, 0);
    return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode'))), 'image/png'));
}

async function copyImage() {
    const img = current;
    try {
        // `navigator.clipboard` is undefined outside a secure context — the
        // plain-http LAN bind in docs/remote.md — so the check is inside the try.
        const clip = navigator.clipboard;
        if (!clip || !clip.write || !window.ClipboardItem) throw new Error('no clipboard');
        // The promise goes into the ClipboardItem rather than being awaited
        // first: Safari drops the user activation across an await, and Chromium
        // accepts either.
        await clip.write([new ClipboardItem({ 'image/png': bytes().then(asPng) })]);
    } catch {
        if (img === current) toast('Could not copy the image.', 'error');
        return;
    }
    if (img === current) done(dom.imgCopy, 'copy');
}

async function saveImage() {
    const img = current;
    let blob;
    try { blob = await bytes(); } catch (err) {
        toast(`Could not read the image: ${err.message}`, 'error');
        return;
    }
    // A download link on a blob URL: the browser's own Save, and in the
    // Electron shell its save dialog, with the name filled in.
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: img.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (img === current) done(dom.imgSave, 'download');
}
