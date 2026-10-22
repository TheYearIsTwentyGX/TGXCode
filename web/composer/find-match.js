// Find and replace inside the composer: the matching and the substitution, with
// no DOM in them.
//
// Split from composer/find.js, which owns the bar and the overlay, so that
// test/composer-find.test.js can pin this under node. Nothing here imports, for
// the same reason caret.js does not.
//
// **One RegExp for every mode.** A plain query is escaped into a pattern rather
// than searched with indexOf, so Match case, Whole word and the cap all go down
// one path and a plain search cannot disagree with a regex search for the same
// characters. Flags are `g`, `m` (so `^` and `$` mean a line of the message,
// which is what they mean in every editor's find) and `i` unless Match case is
// on. `u` is added where the pattern compiles with it — it makes `.` take an
// emoji whole and lets `\p{L}` work — and dropped where it does not, because a
// pattern like `\-` or a lone `{` is legal without it and people type those.
//
// **Whole word is a check on each match, not a `\b` in the pattern.** `\b` is
// wrong at an edge that is not a word character: `\bfoo(\b` cannot match
// `foo(x)`, and `foo(` is a perfectly good thing to look for. The check is
// Monaco's: a match fails only at an edge where the character inside it and the
// one outside it are both word characters. A rejected match restarts one
// character later, so `cat` still finds the second word of `concat cat`.
//
// **Substitution is ours, not String.prototype.replace's.** `replace` cannot be
// told to skip the matches Whole word turned down, or to stop at a cap, and
// asking it one match at a time is quadratic on a long paste. So `$$`, `$&`,
// `` $` ``, `$'`, `$1`–`$99` and `$<name>` are expanded here, following the
// spec's GetSubstitution; the test compares the two on the same inputs, so a
// difference would be caught rather than argued about.

/** How many matches are found before the count wears a `+`. */
export const MATCH_CAP = 10000;

const WORD = /[\p{L}\p{N}_]/u;
const isWord = (ch) => ch !== undefined && ch !== '' && WORD.test(ch);

/** A literal string as a pattern. `-` and `/` are left alone: `\-` is an error under `u`. */
export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The query as a RegExp, or why it is not one.
 *
 * @param {string} query
 * @param {{regex?: boolean, matchCase?: boolean}} [opts]
 * @returns {{re: RegExp}|{error: string}|null} null for an empty query, which
 *   is neither a match nor a mistake.
 */
export function compile(query, { regex = false, matchCase = false } = {}) {
    if (typeof query !== 'string' || query === '') return null;
    const source = regex ? query : escapeRegExp(query);
    const flags = `gm${matchCase ? '' : 'i'}`;
    try { return { re: new RegExp(source, `${flags}u`) }; } catch { /* try without u */ }
    try { return { re: new RegExp(source, flags) }; } catch (err) {
        // The engine's message names the pattern back to you, which the field
        // already shows; what is left after the colon is the useful part.
        const msg = String((err && err.message) || 'Invalid regex');
        return { error: msg.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, '') };
    }
}

/** Is [start, end) a whole word in `text`, by the rule in the header? */
export function wholeWordAt(text, start, end) {
    // Also what turns down a zero-length match between two word characters.
    if (start > 0 && isWord(text[start - 1]) && isWord(text[start])) return false;
    if (end > start && end < text.length && isWord(text[end - 1]) && isWord(text[end])) return false;
    return true;
}

/** Past a zero-length match, by a whole code point when the regex reads them. */
function advance(text, i, unicode) {
    if (!unicode || i + 1 >= text.length) return i + 1;
    const c = text.charCodeAt(i);
    if (c < 0xd800 || c > 0xdbff) return i + 1;
    const d = text.charCodeAt(i + 1);
    return d >= 0xdc00 && d <= 0xdfff ? i + 2 : i + 1;
}

/**
 * Every match of `re` in `text`, in order.
 *
 * Each is `{start, end, groups}` where `groups` is the exec result's captures
 * (`[match, $1, $2, …]`) and named captures, kept so a replacement can be
 * expanded without running the regex again.
 *
 * @param {string} text
 * @param {RegExp} re a `g` regex, as compile() makes
 * @param {{wholeWord?: boolean, cap?: number}} [opts]
 * @returns {{matches: Array<{start: number, end: number, captures: string[], named: object|undefined}>, capped: boolean}}
 */
export function findMatches(text, re, { wholeWord = false, cap = MATCH_CAP } = {}) {
    const matches = [];
    if (!re || typeof text !== 'string') return { matches, capped: false };
    // A copy, so a caller's regex is never left with a lastIndex in it.
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let capped = false;
    let m;
    while ((m = r.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (m[0] === '') r.lastIndex = advance(text, start, r.unicode);
        if (wholeWord && !wholeWordAt(text, start, end)) {
            // One step on from where it started, not from where it ended: the
            // next word may begin inside the one that was turned down.
            if (m[0] !== '') r.lastIndex = advance(text, start, r.unicode);
            continue;
        }
        if (matches.length >= cap) { capped = true; break; }
        matches.push({ start, end, captures: Array.from(m), named: m.groups });
        if (r.lastIndex > text.length) break;
    }
    return { matches, capped };
}

/**
 * What one match is replaced with — GetSubstitution, as String.prototype.replace
 * applies it.
 *
 * @param {string} replacement the text typed into Replace
 * @param {string} text the whole string the match is in
 * @param {{start: number, end: number, captures: string[], named: object|undefined}} match
 * @param {boolean} [regex] a plain search takes the replacement literally — `$`
 *   in it means a dollar sign, as it does in every editor's non-regex replace.
 */
export function expand(replacement, text, match, regex = true) {
    if (!regex || !replacement.includes('$')) return replacement;
    const { start, end, captures, named } = match;
    const m = captures.length - 1;
    let out = '';
    for (let i = 0; i < replacement.length; i++) {
        const ch = replacement[i];
        if (ch !== '$' || i + 1 >= replacement.length) { out += ch; continue; }
        const next = replacement[i + 1];
        if (next === '$') { out += '$'; i++; continue; }
        if (next === '&') { out += captures[0]; i++; continue; }
        if (next === '`') { out += text.slice(0, start); i++; continue; }
        if (next === "'") { out += text.slice(end); i++; continue; }
        if (next >= '0' && next <= '9') {
            const two = replacement[i + 2];
            if (two >= '0' && two <= '9') {
                const n = Number(next + two);
                if (n >= 1 && n <= m) { out += captures[n] ?? ''; i += 2; continue; }
            }
            const n = Number(next);
            if (n >= 1 && n <= m) { out += captures[n] ?? ''; i++; continue; }
            out += ch;
            continue;
        }
        if (next === '<' && named) {
            const close = replacement.indexOf('>', i + 2);
            if (close < 0) { out += ch; continue; }
            out += named[replacement.slice(i + 2, close)] ?? '';
            i = close;
            continue;
        }
        out += ch;
    }
    return out;
}

/**
 * Replace every match, as the smallest splice that does it.
 *
 * The composer applies this as one edit — select [from, to), insert `insert` —
 * so a single Ctrl+Z takes back the whole Replace all. Returning the span rather
 * than the new text is what keeps that edit small: a two-word change in a long
 * message is not the whole message going through the undo stack.
 *
 * @returns {{from: number, to: number, insert: string, text: string, count: number}|null}
 *   null when there is nothing to replace.
 */
export function replaceAll(text, matches, replacement, regex = true) {
    if (!matches.length) return null;
    const from = matches[0].start;
    const to = matches[matches.length - 1].end;
    let insert = '';
    let at = from;
    for (const m of matches) {
        insert += text.slice(at, m.start) + expand(replacement, text, m, regex);
        at = m.end;
    }
    insert += text.slice(at, to);
    return { from, to, insert, text: text.slice(0, from) + insert + text.slice(to), count: matches.length };
}

/**
 * Which match is "current" for a caret at `pos`: the first one starting at or
 * after it, wrapping to the first. -1 when there are none.
 */
export function matchFrom(matches, pos) {
    if (!matches.length) return -1;
    // Binary search: the list is sorted and can be ten thousand long, and this
    // runs on every keystroke typed while the bar is open.
    let lo = 0;
    let hi = matches.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (matches[mid].start < pos) lo = mid + 1;
        else hi = mid;
    }
    return lo < matches.length ? lo : 0;
}

/** The counter's text: '', 'No results', '3 of 12', '1 of 10000+'. */
export function countLabel({ query, error, matches, capped, at }) {
    if (!query) return '';
    if (error) return 'Invalid regex';
    if (!matches.length) return 'No results';
    const n = `${matches.length}${capped ? '+' : ''}`;
    return at >= 0 ? `${at + 1} of ${n}` : `${n} results`;
}
