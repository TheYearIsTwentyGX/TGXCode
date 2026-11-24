'use strict';

// Writing a small PNG from raw pixels, with nothing but zlib.
//
// Screenshots of an interface are mostly flat colour, so most of what makes one
// large is the 8-bit-per-channel antialiasing around text. Two steps, the second
// only when the first is not enough:
//
//   1. encode losslessly, choosing a filter per row (the usual heuristic: the one
//      whose output has the smallest sum of absolute values) and deflating at
//      level 9; and if the picture has no more than 256 colours, as an indexed
//      image, which is exact and smaller still;
//   2. otherwise, quantise to 256 colours by median cut, weighted by how many
//      pixels use each colour, so the colours that make up most of the picture
//      get the palette entries. No dithering: an interface has few gradients, and
//      dithering turns flat regions into noise that deflate cannot compress.
//
// `maxBytes` decides whether step 2 happens at all — a screenshot that fits as it
// is stays exactly as it was.

const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
}

function ihdr(width, height, colourType) {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(width, 0);
    b.writeUInt32BE(height, 4);
    b[8] = 8;           // bit depth
    b[9] = colourType;  // 2 = RGB, 3 = indexed
    return chunk('IHDR', b);
}

/** Filter every row with whichever of the five PNG filters leaves the least to compress. */
function filterRows(raw, width, height, bpp) {
    const stride = width * bpp;
    const out = Buffer.alloc((stride + 1) * height);
    const candidates = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
    for (let y = 0; y < height; y++) {
        const row = raw.subarray(y * stride, (y + 1) * stride);
        const prev = y ? raw.subarray((y - 1) * stride, y * stride) : null;
        let best = 0;
        let bestScore = Infinity;
        for (let f = 0; f < 5; f++) {
            const c = candidates[f];
            let score = 0;
            for (let i = 0; i < stride; i++) {
                const a = i >= bpp ? row[i - bpp] : 0;
                const b = prev ? prev[i] : 0;
                const cc = prev && i >= bpp ? prev[i - bpp] : 0;
                let pred = 0;
                if (f === 1) pred = a;
                else if (f === 2) pred = b;
                else if (f === 3) pred = (a + b) >> 1;
                else if (f === 4) {
                    const p = a + b - cc;
                    const pa = Math.abs(p - a);
                    const pb = Math.abs(p - b);
                    const pc = Math.abs(p - cc);
                    pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
                }
                const v = (row[i] - pred) & 255;
                c[i] = v;
                score += v < 128 ? v : 256 - v;
            }
            if (score < bestScore) { bestScore = score; best = f; }
        }
        out[y * (stride + 1)] = best;
        candidates[best].copy(out, y * (stride + 1) + 1);
    }
    return out;
}

function encodeRgb(rgba, width, height) {
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
        rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2];
    }
    const idat = zlib.deflateSync(filterRows(rgb, width, height, 3), { level: 9 });
    return Buffer.concat([SIGNATURE, ihdr(width, height, 2), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function encodeIndexed(indices, palette, width, height) {
    const plte = Buffer.alloc(palette.length * 3);
    palette.forEach((c, i) => { plte[i * 3] = c[0]; plte[i * 3 + 1] = c[1]; plte[i * 3 + 2] = c[2]; });
    const idat = zlib.deflateSync(filterRows(indices, width, height, 1), { level: 9 });
    return Buffer.concat([SIGNATURE, ihdr(width, height, 3), chunk('PLTE', plte),
        chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Every distinct colour with how many pixels use it. Opaque: alpha is dropped. */
function histogram(rgba) {
    const counts = new Map();
    for (let i = 0; i < rgba.length; i += 4) {
        const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
}

/** Median cut: split the box with the widest channel range at its weighted median. */
function medianCut(counts, size) {
    const colours = [...counts.entries()].map(([key, n]) => ({ key, n, c: [key >> 16, (key >> 8) & 255, key & 255] }));
    const boxes = [colours];
    const range = (box) => {
        let lo = [255, 255, 255];
        let hi = [0, 0, 0];
        for (const { c } of box) {
            for (let k = 0; k < 3; k++) { if (c[k] < lo[k]) lo[k] = c[k]; if (c[k] > hi[k]) hi[k] = c[k]; }
        }
        const spans = hi.map((h, k) => h - lo[k]);
        const ch = spans.indexOf(Math.max(...spans));
        return { ch, span: spans[ch] };
    };
    while (boxes.length < size) {
        let pick = -1;
        let pickScore = 0;
        for (let i = 0; i < boxes.length; i++) {
            if (boxes[i].length < 2) continue;
            const { span } = range(boxes[i]);
            // Weight by pixel count as well as by spread, or a rare accent colour
            // takes entries from the background everyone can see.
            const weight = boxes[i].reduce((s, x) => s + x.n, 0);
            const score = span * Math.sqrt(weight);
            if (score > pickScore) { pickScore = score; pick = i; }
        }
        if (pick < 0) break;
        const box = boxes[pick];
        const { ch } = range(box);
        box.sort((a, b) => a.c[ch] - b.c[ch]);
        const total = box.reduce((s, x) => s + x.n, 0);
        let acc = 0;
        let cut = 1;
        for (let i = 0; i < box.length - 1; i++) {
            acc += box[i].n;
            cut = i + 1;
            if (acc >= total / 2) break;
        }
        boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
    }
    const palette = [];
    const lookup = new Map();
    boxes.forEach((box, i) => {
        const weight = box.reduce((s, x) => s + x.n, 0) || 1;
        palette.push([0, 1, 2].map(k => Math.round(box.reduce((s, x) => s + x.c[k] * x.n, 0) / weight)));
        for (const x of box) lookup.set(x.key, i);
    });
    return { palette, lookup };
}

/**
 * @param {Uint8Array|Buffer} rgba   width × height × 4
 * @param {number} maxBytes          quantise to 256 colours if the lossless file is larger
 * @returns {{png: Buffer, lossy: boolean}}
 */
function encode(rgba, width, height, maxBytes = 380 * 1024) {
    const data = Buffer.from(rgba.buffer ? Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length) : rgba);
    const counts = histogram(data);

    // Few enough colours to be indexed exactly.
    const indexedFrom = (lookup, palette) => {
        const idx = Buffer.alloc(width * height);
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            idx[p] = lookup.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        }
        return encodeIndexed(idx, palette, width, height);
    };

    if (counts.size <= 256) {
        const palette = [];
        const lookup = new Map();
        for (const key of counts.keys()) { lookup.set(key, palette.length); palette.push([key >> 16, (key >> 8) & 255, key & 255]); }
        return { png: indexedFrom(lookup, palette), lossy: false };
    }

    const lossless = encodeRgb(data, width, height);
    if (lossless.length <= maxBytes) return { png: lossless, lossy: false };

    const { palette, lookup } = medianCut(counts, 256);
    return { png: indexedFrom(lookup, palette), lossy: true };
}

module.exports = { encode };
