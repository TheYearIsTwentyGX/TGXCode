// Which snippet, if any, the word before the caret is asking for.
//
// Typing a snippet's trigger and pressing Tab puts the snippet in the box in place
// of the word. This file is the question "is there a trigger here", and nothing
// else: no DOM, no state, no imports, so test/snippet-trigger.test.js can load it
// under node, and popover.js does the answering — through `chooseSnippet`, the
// same path a click takes, so placeholders ask exactly what they ask from a click.
//
// What it decided:
//
//   - **The word is everything back to the last whitespace.** Not a word-character
//     run: a trigger may be `;sig` or `lgtm!`, punctuation and all, and the bridge
//     refuses only whitespace in one, so whitespace is the only thing that can end
//     one here.
//   - **And the caret has to be at its end.** `LGTM|foo` is not a word you just
//     finished typing, it is the middle of one; expanding there would splice a
//     paragraph into `foo`. So the character after the caret must be whitespace or
//     nothing.
//   - **Case-insensitive**, which is the bridge's uniqueness rule — two triggers
//     differing only in case cannot both exist, so this cannot pick between them.
//   - **The first in the order given wins.** Two bridges can each hand one word to
//     a different snippet (bridge/snippets.js says why that is tolerated), and the
//     caller passes rows in display order, so the answer is the one higher up the
//     popover.

/**
 * The run of non-whitespace ending at `caret`, or null when there is none or the
 * caret sits inside a word rather than at the end of one.
 *
 * @returns {{token: string, start: number, end: number}|null}
 */
export function tokenBefore(text, caret) {
    const v = String(text || '');
    const end = Math.max(0, Math.min(Number.isInteger(caret) ? caret : v.length, v.length));
    if (end < v.length && !/\s/.test(v[end])) return null;
    let start = end;
    while (start > 0 && !/\s/.test(v[start - 1])) start--;
    if (start === end) return null;
    return { token: v.slice(start, end), start, end };
}

/**
 * The snippet whose trigger is the word before the caret, and the range to replace.
 *
 * @param {Array<{trigger?: string|null}>} snippets in display order
 * @returns {{snippet: object, start: number, end: number}|null}
 */
export function triggerAt(text, caret, snippets) {
    const at = tokenBefore(text, caret);
    if (!at) return null;
    const key = at.token.toLowerCase();
    const snippet = (snippets || []).find(s => s && typeof s.trigger === 'string'
        && s.trigger && s.trigger.toLowerCase() === key);
    return snippet ? { snippet, start: at.start, end: at.end } : null;
}
