'use strict';

// Every image in a conversation, once each: what the Images pane is drawn from.
//
// "An image in the chat" is an `image` content block in a `user` entry — the two
// places Claude Code writes one, read off every transcript on this machine:
//
//   · **at the top level of the message**: a picture you attached to a message
//     (pasted, dropped, or through the composer's attachments, which inline the
//     image as well as listing the file);
//   · **inside a `tool_result`**: a Read of a PNG, a browser or DevBrowser
//     screenshot, anything an MCP tool handed back as an image.
//
// Both in the session's own transcript and in every subagent's, because the
// transcript view opens those too and `/tool-image` already searches them. What
// is *not* counted, and why:
//
//   · `api-request-blob` entries. They hold the same tool results again, as the
//     request that carried them — counting them would double every screenshot.
//   · `toolUseResult.file.base64` on a Read. It is the same picture as the
//     tool_result's own block, in the same line.
//   · Images in assistant markdown. The page's CSP is `default-src 'self'`, so a
//     remote `![](…)` never renders anyway, and a local path is a file on disk
//     rather than something the conversation showed.
//   · Scratchpad files. They are a directory, not the chat; one Claude looked at
//     is here already, as the Read that looked at it.
//
// Decided:
//
// - **Deduplicated by content**: the key is the sha256 of the *decoded* bytes,
//   so the same screenshot attached twice, or one file Read three times, is one
//   entry with a count and every occurrence. Not by base64 text: that is the
//   same bytes in the same encoding here, but hashing what the picture is costs
//   nothing more and is the rule a reader would assume.
//
// - **Incremental, per file**, the way skill-runs.js and turn-index.js are. A
//   transcript only grows, so each file — the session's and each subagent's —
//   remembers how far it was read and the hash of its first line. A file that
//   shrank or whose first line changed (compacted, forked over) throws the whole
//   index away and rebuilds it, because the occurrences it contributed cannot be
//   picked back out of a merged list; that is rare and the rebuild is one read.
//
// - **Filtered before parsing.** Most lines cannot hold an image; only those
//   that contain `"type":"image"` are parsed, plus the assistant lines that call
//   a tool (for a label — "shot.png" rather than "Read" — and for where an Agent
//   call sits, so a subagent's image can jump to the call that spawned it). The
//   tool names are kept in a small bounded map: a result follows its call within
//   a few lines, and the map would otherwise grow with every call in the session.
//
// - **No base64 in the index or on the wire.** Each entry records where its
//   first occurrence is (which file, the byte offset of its line, and which image
//   in that line), and the bytes are read back from there and re-hashed when
//   they are asked for — so a transcript rewritten under a key answers 404 rather
//   than the wrong picture.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { CACHE_DIR } = require('./config');
const { toolDisplayName } = require('./tool-name');

const INDEX_DIR = path.join(CACHE_DIR, 'images');
// Bump when an entry's shape or derivation changes, so an old file is rebuilt.
const INDEX_VERSION = 1;

const HEAD_BYTES = 4096;
// Tool calls remembered while waiting for their result. A result nearly always
// lands within a turn of its call; this only bounds a session of thousands.
const CALLS_MAX = 512;
// Occurrences kept per image. `count` goes on counting past it.
const OCCURRENCES_MAX = 200;

const MAIN = 'main';
const AGENT_TOOLS = new Set(['Agent', 'Task']);

const IMAGE_NEEDLE = Buffer.from('"type":"image"');
const USER_NEEDLE = Buffer.from('"type":"user"');
const TOOL_USE_NEEDLE = Buffer.from('"type":"tool_use"');
const SIDECHAIN_NEEDLE = Buffer.from('"isSidechain":true');

/**
 * A short name for what produced a tool's image: the file a Read named, else the
 * tool as the transcript draws it (`Playwright: Browser Take Screenshot`).
 */
function callLabel(name, input) {
    const file = input && typeof input.file_path === 'string' ? input.file_path : null;
    if (file) return path.basename(file);
    if (typeof name !== 'string' || !name) return 'Tool result';
    return toolDisplayName(name);
}

/**
 * Width and height from an image's own header, for the four types the bridge
 * serves. Null for anything it cannot read — a truncated file, an unusual
 * WebP — which is a picture with no size rather than an error.
 */
function imageSize(buf) {
    try {
        if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
        if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
            return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
        }
        if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
            const kind = buf.toString('ascii', 12, 16);
            if (kind === 'VP8X') {
                return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
            }
            if (kind === 'VP8L') {
                const b = buf.readUInt32LE(21);
                return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
            }
            if (kind === 'VP8 ') {
                return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
            }
        }
        if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
            let i = 2;
            while (i + 9 < buf.length) {
                if (buf[i] !== 0xff) { i++; continue; }
                const marker = buf[i + 1];
                if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
                const len = buf.readUInt16BE(i + 2);
                // SOF0–SOF15, less DHT (C4), JPG (C8) and DAC (CC).
                if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
                }
                i += 2 + len;
            }
        }
    } catch { /* a header that ends early */ }
    return null;
}

/**
 * The image blocks in one entry, in a fixed order — top-level blocks first, then
 * each tool_result's — which is the `i` a location records. Each carries where
 * it came from: `{block, source, toolUseId, n}`, `n` being its index among its
 * own tool result's images, the same `n` `/tool-image` takes.
 */
function imagesIn(entry) {
    const content = entry && entry.message && entry.message.content;
    if (!Array.isArray(content)) return [];
    const out = [];
    for (const b of content) {
        if (b && b.type === 'image') out.push({ block: b, source: 'user', toolUseId: null, n: null });
    }
    for (const b of content) {
        if (!b || b.type !== 'tool_result' || !Array.isArray(b.content)) continue;
        let n = 0;
        for (const c of b.content) {
            if (c && c.type === 'image') out.push({ block: c, source: 'tool', toolUseId: b.tool_use_id || null, n: n++ });
        }
    }
    return out;
}

/** The decoded bytes of a base64 image block, or null. */
function bytesOf(block) {
    const src = block && block.source;
    if (!src || src.type !== 'base64' || typeof src.data !== 'string') return null;
    return Buffer.from(src.data, 'base64');
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function remember(idx, id, call) {
    idx.calls[id] = call;
    const ids = Object.keys(idx.calls);
    for (let k = 0; k < ids.length - CALLS_MAX; k++) delete idx.calls[ids[k]];
}

/** Fold one line into the index. `src` names the file, `offset` where the line starts. */
function absorbLine(idx, slice, src, offset) {
    const hasImage = slice.indexOf(IMAGE_NEEDLE) !== -1;
    const hasCall = !hasImage && slice.indexOf(TOOL_USE_NEEDLE) !== -1;
    if (!hasImage && !hasCall) return;
    // The session's own file guards against sidechain lines the way buildEvents
    // does; a subagent's file is nothing but.
    if (src === MAIN && slice.indexOf(SIDECHAIN_NEEDLE) !== -1) return;
    if (hasImage && slice.indexOf(USER_NEEDLE) === -1 && slice.indexOf(TOOL_USE_NEEDLE) === -1) return;
    let e;
    try { e = JSON.parse(slice.toString('utf8')); } catch { return; }
    if (!e || typeof e !== 'object') return;
    const content = e.message && e.message.content;

    if (e.type === 'assistant' && Array.isArray(content)) {
        for (const b of content) {
            if (!b || b.type !== 'tool_use' || typeof b.id !== 'string') continue;
            remember(idx, b.id, callLabel(b.name, b.input));
            if (AGENT_TOOLS.has(b.name)) idx.agents[b.id] = { src, offset, uuid: e.uuid || null };
        }
        return;
    }
    if (e.type !== 'user') return;

    const found = imagesIn(e);
    for (let i = 0; i < found.length; i++) {
        const f = found[i];
        const buf = bytesOf(f.block);
        if (!buf || !buf.length) continue;
        const key = sha256(buf);
        const occ = {
            src, offset, i,
            uuid: e.uuid || null,
            at: e.timestamp || null,
            source: f.source,
            toolUseId: f.toolUseId,
            n: f.n,
        };
        let img = idx.images[key];
        if (!img) {
            const size = imageSize(buf);
            img = idx.images[key] = {
                seq: idx.seq++,
                mediaType: (f.block.source && f.block.source.media_type) || 'image/png',
                bytes: buf.length,
                width: size ? size.width : null,
                height: size ? size.height : null,
                count: 0,
                occurrences: [],
            };
        }
        img.count++;
        // Labelled now, while the call is still in the bounded map.
        occ.label = f.source === 'user' ? 'Your message'
            : (f.toolUseId && idx.calls[f.toolUseId]) || 'Tool result';
        if (img.occurrences.length < OCCURRENCES_MAX) img.occurrences.push(occ);
    }
}

function absorbBuffer(idx, buf, src, base) {
    let consumed = 0;
    let start = 0;
    while (true) {
        const nl = buf.indexOf(0x0a, start);
        if (nl === -1) break;
        const off = start;
        const slice = buf.subarray(start, nl);
        start = nl + 1;
        consumed = start;
        if (slice.length) absorbLine(idx, slice, src, base + off);
    }
    return consumed;
}

function headOf(file, size) {
    const n = Math.min(size, HEAD_BYTES);
    if (!n) return '';
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
    const nl = buf.indexOf(0x0a);
    return crypto.createHash('sha1').update(nl === -1 ? buf : buf.subarray(0, nl)).digest('hex');
}

function readRange(file, from, to) {
    const len = to - from;
    const buf = Buffer.alloc(len);
    if (!len) return buf;
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
    return buf;
}

/** The whole line that starts at `offset`, read a chunk at a time until its newline. */
function lineAt(file, offset) {
    const fd = fs.openSync(file, 'r');
    try {
        const parts = [];
        let pos = offset;
        const chunk = Buffer.alloc(1 << 20);
        while (true) {
            const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
            if (!n) break;
            const nl = chunk.subarray(0, n).indexOf(0x0a);
            if (nl !== -1) { parts.push(Buffer.from(chunk.subarray(0, nl))); break; }
            parts.push(Buffer.from(chunk.subarray(0, n)));
            pos += n;
        }
        return Buffer.concat(parts);
    } finally { fs.closeSync(fd); }
}

/**
 * Where a jump to this occurrence should land in the session's own log: the row
 * itself, or — for a subagent's image — the Agent call that spawned it, followed
 * up through nested agents until one is in the session's file.
 */
function anchorOf(idx, occ) {
    if (occ.src === MAIN) {
        return occ.source === 'tool' && occ.toolUseId
            ? { kind: 'tool', id: occ.toolUseId, offset: occ.offset }
            : { kind: 'user', id: occ.uuid, offset: occ.offset };
    }
    let src = occ.src;
    for (let depth = 0; depth < 8 && src !== MAIN; depth++) {
        const call = idx.agents[src];
        if (!call) return null;
        if (call.src === MAIN) return { kind: 'tool', id: src, offset: call.offset };
        src = call.src;
    }
    return null;
}

const byFirst = (a, b) => String(a.at || '').localeCompare(String(b.at || ''));

class ImageIndex {
    constructor(dir = INDEX_DIR) {
        this.dir = dir;
        /** @type {Map<string, object>} */
        this.mem = new Map();
    }

    _path(sessionId) {
        return path.join(this.dir, `${sessionId}.json`);
    }

    _load(sessionId) {
        if (this.mem.has(sessionId)) return this.mem.get(sessionId);
        try {
            const idx = JSON.parse(fs.readFileSync(this._path(sessionId), 'utf8'));
            if (idx.version === INDEX_VERSION) { this.mem.set(sessionId, idx); return idx; }
        } catch { /* none yet */ }
        return null;
    }

    _save(sessionId, idx) {
        this.mem.set(sessionId, idx);
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const dest = this._path(sessionId);
            const tmp = `${dest}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(idx));
            fs.renameSync(tmp, dest);
        } catch { /* an optimisation; the next request rebuilds it */ }
    }

    /**
     * The index brought up to date with the session's file and its subagents'.
     * `agents` is readSubagentIndex's map, tool_use id → `{file}`. Null if the
     * session's own file cannot be read.
     */
    update(sessionId, file, agents = new Map()) {
        const files = [[MAIN, file]];
        for (const [id, a] of agents) if (a && a.file) files.push([id, a.file]);
        const stats = new Map();
        for (const [src, f] of files) {
            try { stats.set(src, fs.statSync(f)); } catch {
                if (src === MAIN) return null;
                // A subagent whose transcript is not written yet has nothing to add.
            }
        }

        const fresh = () => ({ version: INDEX_VERSION, sources: {}, images: {}, calls: {}, agents: {}, seq: 0 });
        let idx = this._load(sessionId);
        // A source that is gone, moved or rewritten from the start means the
        // merged list holds occurrences nothing can account for any more.
        const stale = (i) => {
            for (const [src, s] of Object.entries(i.sources)) {
                const st = stats.get(src);
                const f = files.find(x => x[0] === src);
                if (!st || !f || f[1] !== s.file || st.size < s.consumed) return true;
                if (st.size > s.consumed && headOf(s.file, st.size) !== s.head) return true;
            }
            return false;
        };
        let dirty = false;
        try {
            if (!idx || stale(idx)) { idx = fresh(); dirty = true; }
            // The session's file first, so an Agent call is seen before the
            // subagent's images that will want to point back at it.
            for (const [src, f] of files) {
                const st = stats.get(src);
                if (!st) continue;
                let s = idx.sources[src];
                if (!s) s = idx.sources[src] = { file: f, head: null, consumed: 0 };
                if (st.size === s.consumed) continue;
                if (!s.head) s.head = headOf(f, st.size);
                s.consumed += absorbBuffer(idx, readRange(f, s.consumed, st.size), src, s.consumed);
                dirty = true;
            }
        } catch { return null; }
        if (dirty) this._save(sessionId, idx);
        return idx;
    }

    /**
     * The images, newest first by first occurrence, in the wire shape — see
     * `GET /api/sessions/:id/images` in docs/api.md. `urlFor(key)` builds `url`.
     */
    list(idx, urlFor) {
        const out = [];
        for (const [key, img] of Object.entries(idx.images)) {
            const occs = [...img.occurrences].sort(byFirst);
            const first = occs[0];
            out.push({
                key,
                source: first.source,
                toolUseId: first.toolUseId,
                n: first.n,
                uuid: first.uuid,
                at: first.at,
                mediaType: img.mediaType,
                bytes: img.bytes,
                width: img.width,
                height: img.height,
                label: first.label,
                url: urlFor(key),
                count: img.count,
                occurrences: occs.map(o => ({
                    uuid: o.uuid,
                    at: o.at,
                    source: o.source,
                    toolUseId: o.toolUseId,
                    n: o.n,
                    label: o.label,
                    agent: o.src === MAIN ? null : o.src,
                    anchor: anchorOf(idx, o),
                })),
                _seq: img.seq,
            });
        }
        out.sort((a, b) => byFirst(b, a) || b._seq - a._seq);
        for (const o of out) delete o._seq;
        return out;
    }

    /**
     * The bytes behind a key, read back from its first recorded occurrence that
     * still hashes to it. `{mediaType, data}` or null.
     */
    bytes(idx, key) {
        const img = idx && Object.prototype.hasOwnProperty.call(idx.images, key) ? idx.images[key] : null;
        if (!img) return null;
        for (const occ of img.occurrences) {
            const s = idx.sources[occ.src];
            if (!s) continue;
            let entry;
            try { entry = JSON.parse(lineAt(s.file, occ.offset).toString('utf8')); } catch { continue; }
            const f = imagesIn(entry)[occ.i];
            const buf = f && bytesOf(f.block);
            if (buf && sha256(buf) === key) {
                return { mediaType: (f.block.source && f.block.source.media_type) || img.mediaType, data: buf };
            }
        }
        return null;
    }

    forget(sessionId) {
        this.mem.delete(sessionId);
        try { fs.rmSync(this._path(sessionId), { force: true }); } catch { /* none */ }
    }
}

module.exports = { ImageIndex, imageSize, INDEX_DIR, INDEX_VERSION };
