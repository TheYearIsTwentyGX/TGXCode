'use strict';

// Generates app/icon.ico — the taskbar and Start-menu icon.
//
// Run with `node app/make-icon.js` after editing; the .ico is committed so a
// normal build never needs to.
//
// Everything here is hand-rolled because the project has no dependencies and a
// build step for one icon is not worth it. Shapes are signed distance fields,
// which give clean antialiasing without supersampling; PNGs are zlib-deflated
// scanlines; the ICO is a directory of those PNGs (Vista+ reads PNG-in-ICO).
//
// The mark: a rounded square in the app's blue, holding a dark speech bubble.
// Below 32px the caret inside the bubble is dropped — at that size it is mud,
// and the silhouette is what identifies the app in a taskbar anyway.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const BLUE = [168, 199, 250];   // --blue
const BLUE_DEEP = [122, 162, 224];
const INK = [19, 19, 20];       // --bg
const INK_SOFT = [32, 33, 36];  // --s2

// ── signed distance fields ───────────────────────────────────────────────
// Negative inside, positive outside, in the same units as the coordinates.

function sdRoundedRect(px, py, cx, cy, hw, hh, r) {
    const qx = Math.abs(px - cx) - (hw - r);
    const qy = Math.abs(py - cy) - (hh - r);
    const ax = Math.max(qx, 0);
    const ay = Math.max(qy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCircle(px, py, cx, cy, r) {
    return Math.hypot(px - cx, py - cy) - r;
}

/** Distance to a thick line segment (a capsule). */
function sdSegment(px, py, ax, ay, bx, by, r) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) - r;
}

/** Coverage in [0,1] for a distance, antialiased over roughly one pixel. */
function cover(d, aa) {
    return Math.max(0, Math.min(1, 0.5 - d / aa));
}

function over(dst, src, alpha) {
    dst[0] = src[0] * alpha + dst[0] * (1 - alpha);
    dst[1] = src[1] * alpha + dst[1] * (1 - alpha);
    dst[2] = src[2] * alpha + dst[2] * (1 - alpha);
}

// ── the mark ─────────────────────────────────────────────────────────────

function render(size) {
    const S = size;
    const aa = 1.0;                       // antialias width, in pixels
    const rgba = Buffer.alloc(S * S * 4);
    const u = S / 256;                    // design is authored on a 256 grid
    const detail = S >= 32;

    // Tile
    const tileR = 56 * u;
    const tileHalf = 120 * u;
    const c = 128 * u;

    // Bubble
    const bx = 128 * u, by = 118 * u;
    const bhw = 74 * u, bhh = 56 * u, br = 24 * u;

    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const px = x + 0.5, py = y + 0.5;
            const px256 = px, py256 = py;

            const dTile = sdRoundedRect(px256, py256, c, c, tileHalf, tileHalf, tileR);
            const aTile = cover(dTile, aa);
            if (aTile <= 0) continue;      // transparent outside the tile

            // A soft vertical gradient keeps the tile from looking like a swatch.
            const t = y / S;
            const px3 = [
                BLUE[0] + (BLUE_DEEP[0] - BLUE[0]) * t,
                BLUE[1] + (BLUE_DEEP[1] - BLUE[1]) * t,
                BLUE[2] + (BLUE_DEEP[2] - BLUE[2]) * t,
            ];

            // Speech bubble body, plus a tail at the lower left.
            const dBody = sdRoundedRect(px256, py256, bx, by, bhw, bhh, br);
            // The tail starts well inside the body so the two read as one shape.
            const dTail = sdSegment(px256, py256, 84 * u, 146 * u, 60 * u, 198 * u, 16 * u);
            const dBubble = Math.min(dBody, dTail);
            over(px3, INK, cover(dBubble, aa));

            if (detail) {
                // A terminal caret: this is a session manager, not a chat client.
                const w = 9 * u;
                const dCaret = Math.min(
                    sdSegment(px256, py256, 104 * u, 98 * u, 128 * u, 118 * u, w),
                    sdSegment(px256, py256, 128 * u, 118 * u, 104 * u, 138 * u, w));
                const dBar = sdSegment(px256, py256, 146 * u, 140 * u, 172 * u, 140 * u, w);
                // Clip the glyph to the bubble so it can never spill onto the tile.
                const inside = cover(dBubble, aa);
                const glyph = Math.max(cover(dCaret, aa), cover(dBar, aa)) * inside;
                const gcol = [
                    BLUE[0] * 0.95 + INK_SOFT[0] * 0.05,
                    BLUE[1] * 0.95 + INK_SOFT[1] * 0.05,
                    BLUE[2] * 0.95 + INK_SOFT[2] * 0.05,
                ];
                over(px3, gcol, glyph);
            }

            const o = (y * S + x) * 4;
            rgba[o] = Math.round(px3[0]);
            rgba[o + 1] = Math.round(px3[1]);
            rgba[o + 2] = Math.round(px3[2]);
            rgba[o + 3] = Math.round(aTile * 255);
        }
    }
    return rgba;
}

// ── PNG ──────────────────────────────────────────────────────────────────

function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 6;    // colour type: RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    // One filter byte (none) per scanline.
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0;
        rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ── ICO ──────────────────────────────────────────────────────────────────

function encodeIco(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);              // reserved
    header.writeUInt16LE(1, 2);              // type: icon
    header.writeUInt16LE(images.length, 4);

    const dir = Buffer.alloc(16 * images.length);
    let offset = 6 + dir.length;
    images.forEach((img, i) => {
        const o = i * 16;
        dir[o] = img.size >= 256 ? 0 : img.size;      // 0 means 256
        dir[o + 1] = img.size >= 256 ? 0 : img.size;
        dir[o + 2] = 0;                                // palette size
        dir[o + 3] = 0;                                // reserved
        dir.writeUInt16LE(1, o + 4);                   // colour planes
        dir.writeUInt16LE(32, o + 6);                  // bits per pixel
        dir.writeUInt32LE(img.png.length, o + 8);
        dir.writeUInt32LE(offset, o + 12);
        offset += img.png.length;
    });

    return Buffer.concat([header, dir, ...images.map(i => i.png)]);
}

// ── go ───────────────────────────────────────────────────────────────────

const images = SIZES.map(size => ({ size, png: encodePng(render(size), size) }));
const ico = encodeIco(images);

const out = path.join(__dirname, 'icon.ico');
fs.writeFileSync(out, ico);
console.log(`wrote ${out} — ${SIZES.join(', ')}px, ${(ico.length / 1024).toFixed(1)}KB`);

// A PNG copy is handy for previewing the design without an ICO viewer.
if (process.argv.includes('--preview')) {
    const big = images[images.length - 1];
    const p = path.join(__dirname, 'icon-preview.png');
    fs.writeFileSync(p, big.png);
    console.log(`wrote ${p}`);
}

// The same mark, as PNGs, for the phone surface: Android's home screen reads the
// web app manifest and wants 192 and 512. They live in web/ rather than app/
// because the bridge serves them and the packaged shell does not — and they are
// committed for the same reason the .ico is, so no build step depends on this file.
const PWA_SIZES = [192, 512];
for (const size of PWA_SIZES) {
    const file = path.join(__dirname, '..', 'web', `icon-${size}.png`);
    fs.writeFileSync(file, encodePng(render(size), size));
    console.log(`wrote ${file}`);
}
