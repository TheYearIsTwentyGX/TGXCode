'use strict';

// Reading a JSONL file that is still being written.
//
// Lifted out of bridge/transcript.js. Claude Code's transcripts are JSONL, and so
// are Codex's rollout files, so the one routine that reads either without
// choking on a half-flushed last line is not any reader's own.

/**
 * Split a JSONL buffer into parsed objects, tolerating a truncated final line —
 * we routinely read files that Claude is still appending to.
 * Returns {entries, consumed} where `consumed` is the byte length fully parsed,
 * so a tailing caller can resume from exactly there.
 */
function parseLines(buf) {
    const entries = [];
    let consumed = 0;
    let start = 0;
    while (true) {
        const nl = buf.indexOf(0x0a, start);
        if (nl === -1) break;
        const slice = buf.subarray(start, nl);
        start = nl + 1;
        consumed = start;
        if (!slice.length) continue;
        try {
            entries.push(JSON.parse(slice.toString('utf8')));
        } catch {
            // A partially-flushed line; skip it. If it was genuinely the tail we
            // will re-read it next tick because `consumed` only advances past
            // complete lines that ended in a newline.
        }
    }
    return { entries, consumed };
}

module.exports = { parseLines };
