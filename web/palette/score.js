// The command palette's fuzzy match: how well a typed query fits a line of text,
// and which characters it landed on so the row can show them.
//
// **A subsequence, scored by where it lands.** Every character of the query has
// to appear in the text in order, and the score is what the placement is worth:
// a character at the start of a word is worth most (so `nt` prefers *N*ew
// *T*ask to i*nt*o), a run of consecutive characters is worth more than the same characters scattered,
// and every skipped character costs a little. The best placement is found by a
// small dynamic programme rather than taken greedily, because the leftmost match
// is usually the worst one — `dash` in "Live board · dashboard" would otherwise
// light up four letters strewn across the first two words.
//
// **Words in the query are matched separately**, each anywhere, so `set key`
// finds "Settings · Keyboard". A word that matches nothing rules the line out.
//
// **Several fields, with weights.** A session is a title, a project and a
// status line; a match in the title should beat the same match in the status
// line. `best` gives each query word the field it scores highest in.
//
// Pure, no imports, so test/palette-score.test.js can load it in node.

const START = 8;      // the first character of the text
const WORD = 7;       // the first character of a word, or a camelCase hump
const RUN = 5;        // directly after the previous match (or the run's first bonus, if more)
const CHAR = 1;       // any match at all
const GAP = 0.4;      // per character skipped between two matches
const LEAD = 0.15;    // per character before the first match, capped below
const LEAD_MAX = 3;
const WHOLE = 4;      // the word is the entire text: `land` and "Land", over "Lander"

const isWordChar = (c) => /[\p{L}\p{N}]/u.test(c);

/** What landing a query character at `j` is worth, before runs and gaps. */
function placeBonus(text, j) {
    if (j === 0) return START;
    const prev = text[j - 1];
    const cur = text[j];
    if (!isWordChar(prev) && isWordChar(cur)) return WORD;
    // A camelCase hump: `rn` finds `startRename` at the R.
    if (prev === prev.toLowerCase() && cur !== cur.toLowerCase()) return WORD;
    return 0;
}

/**
 * One query word against one text. `{score, hits}`, where `hits` are the indices
 * in `text` the word landed on, or null when it is not a subsequence.
 */
function scoreWord(word, text) {
    const q = word.toLowerCase();
    const t = text.toLowerCase();
    const m = q.length;
    const n = t.length;
    if (!m) return { score: 0, hits: [] };
    if (m > n) return null;

    // Cheap rejection first: most lines in a long list are not even subsequences.
    let k = 0;
    for (let j = 0; j < n && k < m; j++) if (t[j] === q[k]) k++;
    if (k < m) return null;

    // prev/cur[j]: the best score with query char i placed at text index j.
    // lead[j]: the place bonus of the first character of the run that path
    // ends in. A run carries its first character's bonus on to every character
    // after it, as fzf does, so `land` in "Landing" — a word start and three
    // more — beats "L…and" — two word starts with a gap between.
    // from[i][j]: where query char i-1 was placed on that best path.
    const NEG = -Infinity;
    let prev = new Float64Array(n).fill(NEG);
    let lead = new Float64Array(n);
    const from = [null];
    for (let j = 0; j < n; j++) {
        if (t[j] !== q[0]) continue;
        lead[j] = placeBonus(text, j);
        prev[j] = CHAR + lead[j] - Math.min(j * LEAD, LEAD_MAX);
    }
    for (let i = 1; i < m; i++) {
        const cur = new Float64Array(n).fill(NEG);
        const curLead = new Float64Array(n);
        const back = new Int32Array(n).fill(-1);
        // Best of prev[k] - GAP*(j-k-1) over k < j-1, kept as prev[k] + GAP*k
        // so the running maximum does not have to be recomputed per j.
        let gapMax = NEG;
        let gapArg = -1;
        for (let j = i; j < n; j++) {
            const k = j - 2;
            if (k >= 0 && prev[k] !== NEG && prev[k] + GAP * k > gapMax) {
                gapMax = prev[k] + GAP * k;
                gapArg = k;
            }
            if (t[j] !== q[i]) continue;
            const place = placeBonus(text, j);
            if (gapArg >= 0) {
                cur[j] = gapMax - GAP * (j - 1) + CHAR + place;
                curLead[j] = place;
                back[j] = gapArg;
            }
            if (prev[j - 1] !== NEG) {
                const carried = Math.max(RUN, lead[j - 1], place);
                const viaRun = prev[j - 1] + CHAR + carried;
                if (viaRun >= cur[j]) {
                    cur[j] = viaRun;
                    curLead[j] = Math.max(lead[j - 1], place);
                    back[j] = j - 1;
                }
            }
        }
        from.push(back);
        prev = cur;
        lead = curLead;
    }

    let end = -1;
    let top = NEG;
    for (let j = 0; j < n; j++) if (prev[j] > top) { top = prev[j]; end = j; }
    if (end < 0) return null;
    if (m === n) top += WHOLE;
    const hits = new Array(m);
    for (let i = m - 1, j = end; i >= 0; i--) {
        hits[i] = j;
        if (i > 0) j = from[i][j];
    }
    return { score: top, hits };
}

const words = (query) => String(query || '').trim().split(/\s+/).filter(Boolean);

/**
 * A query against one text: `{score, hits}` or null. An empty query matches
 * everything with a score of 0. Hits are sorted and unique.
 */
export function score(query, text) {
    const ws = words(query);
    const t = String(text || '');
    if (!ws.length) return { score: 0, hits: [] };
    let total = 0;
    const hits = new Set();
    for (const w of ws) {
        const r = scoreWord(w, t);
        if (!r) return null;
        total += r.score;
        for (const h of r.hits) hits.add(h);
    }
    return { score: total, hits: [...hits].sort((a, b) => a - b) };
}

/**
 * A query against several weighted fields, `[{text, weight}]`. Each query word
 * counts in the field where it scores best, so the words of one query may land
 * in different fields. `{score, hits}` with `hits` one array per field, or null
 * when some word matches no field.
 */
export function best(query, fields) {
    const ws = words(query);
    const hits = fields.map(() => new Set());
    if (!ws.length) return { score: 0, hits: fields.map(() => []) };
    let total = 0;
    for (const w of ws) {
        let top = null;
        let at = -1;
        fields.forEach((f, i) => {
            if (!f || !f.text) return;
            const r = scoreWord(w, String(f.text));
            if (!r) return;
            const s = r.score * (f.weight ?? 1);
            if (!top || s > top.s) { top = { s, hits: r.hits }; at = i; }
        });
        if (!top) return null;
        total += top.s;
        for (const h of top.hits) hits[at].add(h);
    }
    return { score: total, hits: hits.map(s => [...s].sort((a, b) => a - b)) };
}

/**
 * Rank items by how well they match. `fields(item)` gives the weighted fields.
 * Ties keep the order the items came in, so a list that arrives most recent
 * first stays that way among equals — that is the whole of the recency rule.
 * Returns `[{item, score, hits}]`, at most `limit` of them.
 *
 * `perChar` drops matches worth less than that much per query character. A
 * subsequence is easy to find in a long line — every status line has an s, an e
 * and a t somewhere — and those letters strewn mid-word are noise, not a match.
 */
export function rank(items, query, { fields, limit = Infinity, perChar = 0 } = {}) {
    const floor = perChar * words(query).join('').length;
    const out = [];
    items.forEach((item, i) => {
        const r = best(query, fields(item));
        if (r && r.score >= floor) out.push({ item, score: r.score, hits: r.hits, i });
    });
    out.sort((a, b) => (b.score - a.score) || (a.i - b.i));
    return out.slice(0, limit).map(({ item, score: s, hits }) => ({ item, score: s, hits }));
}
