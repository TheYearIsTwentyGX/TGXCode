// What is under the caret after an `@`, and what accepting a file inserts — the
// text half of the `@` menu, with no DOM in it.
//
// Split from composer/mentions.js, which owns the menu, so that
// test/mention-parse.test.js can pin it under node. Nothing here imports, for the
// same reason caret.js and find-match.js do not.
//
// Three shapes of fragment, and the leading character picks the menu:
//
//   `@[name`   sessions only. The bracket is what session mentions have always
//              inserted, and typing one is how you say "a session, not a file".
//              Spaces are allowed inside it: a title has them.
//   `@"path`   files only, in the quoted form the Claude Code CLI accepts for a
//              path with a space in it (`@"my dir/a b.txt"`). Spaces allowed.
//   `@word`    both: files, then sessions. **No whitespace in it** — the fragment
//              ends at the first space, which is what lets `@src/app.js ` finish
//              cleanly instead of carrying on matching the words after it. (A
//              session found by a title with a space in it is found with `@[`.)
//
// And the `@` must start a word. `me@example.com` has an `@` in the middle of one,
// and offering a file menu to somebody typing an email address is the quickest way
// to make this feature unwelcome.

const SESSION_RE = /(?:^|[\s(])@\[([^\]\n]*)$/;
const QUOTED_RE = /(?:^|[\s(])@"([^"\n]*)$/;
// The first character may not be a bracket (that is SESSION_RE's); later ones may,
// because `app/[id]/page.tsx` is a real path.
const BARE_RE = /(?:^|[\s(])@((?:[^\s[\]"][^\s]*)?)$/;

/**
 * The fragment ending at the end of `before`, or null when there is none.
 *
 * `start` is the index of the `@`, so accepting can replace exactly the fragment
 * and leave everything either side of it alone. `files` / `sessions` say which
 * groups the menu should offer for it. `quoted` is whether the fragment opened
 * with `@"`, which accepting needs to know in order to replace the quote too.
 *
 * @param {string} before the composer's text up to the caret
 * @returns {{text: string, start: number, files: boolean, sessions: boolean, quoted: boolean} | null}
 */
function parseMention(before) {
    let m = SESSION_RE.exec(before);
    let kind = 'session';
    if (!m) { m = QUOTED_RE.exec(before); kind = 'quoted'; }
    if (!m) { m = BARE_RE.exec(before); kind = 'bare'; }
    if (!m) return null;
    // m[0] may open with the whitespace that made the `@` a word boundary, and
    // that character is not part of what gets replaced.
    const lead = m[0].startsWith('@') ? 0 : 1;
    return {
        text: m[1],
        start: before.length - m[0].length + lead,
        files: kind !== 'session',
        sessions: kind !== 'quoted',
        quoted: kind === 'quoted',
    };
}

/**
 * The text a chosen file or directory becomes in the composer.
 *
 * `@relative/path` is what the CLI resolves by itself, relative to the session's
 * working directory. A path with whitespace takes the quoted form the CLI parses
 * (`@"…"`, checked against its own pattern in 2.1.x). A file is followed by a
 * space so the sentence carries on; a directory is not, and ends in `/`, because
 * choosing one means "go in" and the menu stays open on its children.
 *
 * A directory with a space in it is left with its quote *open* (`@"my dir/`), and
 * that is deliberate: the open-quote form is exactly what parseMention reads as a
 * file fragment, so drilling in carries on, and the file picked inside closes the
 * quote. A path with a `"` in it cannot be quoted at all and goes in bare.
 */
function fileMentionText(relPath, isDirectory) {
    const p = isDirectory ? `${relPath.replace(/\/+$/, '')}/` : relPath;
    if (/\s/.test(p) && !p.includes('"')) return isDirectory ? `@"${p}` : `@"${p}" `;
    return isDirectory ? `@${p}` : `@${p} `;
}

export { parseMention, fileMentionText };
