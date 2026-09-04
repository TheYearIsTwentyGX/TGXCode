// A compact CommonMark-ish renderer — enough for what Claude actually writes:
// fenced code, headings, lists, tables, blockquotes, and the usual inline marks.
//
// Blocks are parsed line-by-line; inline marks are applied only to text runs, so
// a `*` inside a code span never becomes emphasis and nothing ever double-escapes.

import { highlight, escapeHtml } from './highlight.js';

const RE = {
    fence: /^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*)$/,
    heading: /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
    hr: /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/,
    ulItem: /^( *)([-*+])[ \t]+(.*)$/,
    olItem: /^( *)(\d{1,9})[.)][ \t]+(.*)$/,
    quote: /^ {0,3}>[ \t]?(.*)$/,
    tableSep: /^ *\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|? *$/,
};

/**
 * Where the machine's filesystem is, for the paths a transcript mentions.
 *
 * Null until the page says so - see configurePaths - and null is the whole
 * feature off. That is deliberate rather than a fallback: a path on this machine
 * means nothing to a browser on a phone, and the route that opens one is refused
 * to a remote caller anyway. Better no link than a link that cannot work.
 *
 * A module variable rather than an argument because renderMarkdown is called
 * from a dozen places in web/app.js, and threading an options bag through
 * blocks() -> list() -> looseItem() -> inline() to reach one regex is a larger
 * change than the feature. Nothing here reads the DOM, for the same reason
 * nothing else in this module does: it has to import under plain node.
 */
let HOST = null;

/**
 * Say where paths point, or pass null to leave them as plain text.
 * @param {{distro: string, home: string}|null} host
 */
export function configurePaths(host) {
    HOST = host && host.distro
        ? { distro: String(host.distro), home: String(host.home || '') }
        : null;
}

export function renderMarkdown(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    return blocks(lines, 0, lines.length);
}

function blocks(lines, start, end) {
    let out = '';
    let i = start;

    while (i < end) {
        const line = lines[i];

        if (!line.trim()) { i++; continue; }

        // --- fenced code ---------------------------------------------------
        const fence = RE.fence.exec(line);
        if (fence) {
            const marker = fence[2][0];
            const len = fence[2].length;
            const info = fence[3].trim();
            const body = [];
            i++;
            while (i < end) {
                const close = new RegExp('^ {0,3}' + (marker === '`' ? '`' : '~') + `{${len},}[ \\t]*$`);
                if (close.test(lines[i])) { i++; break; }
                body.push(lines[i]);
                i++;
            }
            out += codeBlock(body.join('\n'), info);
            continue;
        }

        // --- heading ---------------------------------------------------------
        const h = RE.heading.exec(line);
        if (h) {
            const level = h[1].length;
            out += `<h${level}>${inline(h[2])}</h${level}>`;
            i++;
            continue;
        }

        // --- horizontal rule ---------------------------------------------------
        if (RE.hr.test(line)) { out += '<hr>'; i++; continue; }

        // --- blockquote --------------------------------------------------------
        if (RE.quote.test(line)) {
            const body = [];
            while (i < end && (RE.quote.test(lines[i]) || (lines[i].trim() && !isBlockStart(lines[i])))) {
                const m = RE.quote.exec(lines[i]);
                body.push(m ? m[1] : lines[i]);
                i++;
            }
            out += `<blockquote>${blocks(body, 0, body.length)}</blockquote>`;
            continue;
        }

        // --- table -------------------------------------------------------------
        if (line.includes('|') && i + 1 < end && RE.tableSep.test(lines[i + 1])) {
            const header = splitRow(line);
            const align = splitRow(lines[i + 1]).map(c => (
                /^:.*:$/.test(c) ? 'center' : /:$/.test(c) ? 'right' : /^:/.test(c) ? 'left' : null));
            i += 2;
            const rows = [];
            while (i < end && lines[i].trim() && lines[i].includes('|')) {
                rows.push(splitRow(lines[i]));
                i++;
            }
            out += table(header, align, rows);
            continue;
        }

        // --- lists ---------------------------------------------------------------
        if (RE.ulItem.test(line) || RE.olItem.test(line)) {
            const [html, next] = list(lines, i, end);
            out += html;
            i = next;
            continue;
        }

        // --- paragraph ------------------------------------------------------------
        const para = [];
        while (i < end && lines[i].trim() && !isBlockStart(lines[i])) {
            para.push(lines[i]);
            i++;
        }
        if (para.length) out += `<p>${inline(para.join('\n'))}</p>`;
        else i++; // defensive: never spin on a line we failed to consume
    }

    return out;
}

function isBlockStart(line) {
    return RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line)
        || RE.quote.test(line) || RE.ulItem.test(line) || RE.olItem.test(line);
}

/** Parse one list (and any nested lists) starting at `start`. */
function list(lines, start, end) {
    const first = RE.ulItem.exec(lines[start]) || RE.olItem.exec(lines[start]);
    const ordered = !RE.ulItem.test(lines[start]);
    const baseIndent = first[1].length;
    const items = [];
    let i = start;

    while (i < end) {
        const line = lines[i];
        if (!line.trim()) {
            // A blank line ends the list unless the next line continues it.
            const next = lines[i + 1];
            if (next === undefined || !next.trim()) break;
            const cont = RE.ulItem.exec(next) || RE.olItem.exec(next);
            if (!cont && next.search(/\S/) <= baseIndent) break;
            i++;
            continue;
        }

        const m = RE.ulItem.exec(line) || RE.olItem.exec(line);
        const indent = line.search(/\S/);

        if (m && m[1].length <= baseIndent) {
            // Sibling item (or the start of a differently-marked list).
            const isOrdered = !RE.ulItem.test(line);
            if (m[1].length < baseIndent || isOrdered !== ordered) break;
            items.push([m[3]]);
            i++;
            continue;
        }

        if (indent > baseIndent && items.length) {
            items[items.length - 1].push(line.slice(Math.min(indent, baseIndent + 2)));
            i++;
            continue;
        }

        if (!m && items.length && indent > baseIndent) { i++; continue; }
        break;
    }

    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && first[2] !== '1' ? ` start="${Number(first[2])}"` : '';
    const body = items.map((chunk) => {
        const text = chunk.join('\n');
        // A checkbox item renders as a real (disabled) checkbox.
        const task = /^\[([ xX])\]\s+([\s\S]*)$/.exec(text);
        if (task) {
            const checked = task[1].toLowerCase() === 'x';
            return `<li class="task"><input type="checkbox" disabled${checked ? ' checked' : ''}>`
                + `<span>${looseItem(task[2])}</span></li>`;
        }
        return `<li>${looseItem(text)}</li>`;
    }).join('');

    return [`<${tag}${startAttr}>${body}</${tag}>`, i];
}

/** An item's content: inline if it's a single simple line, full blocks otherwise. */
function looseItem(text) {
    const ls = text.split('\n');
    const multiline = ls.length > 1 && ls.slice(1).some(l => l.trim());
    if (!multiline) return inline(ls[0]);
    const html = blocks(ls, 0, ls.length);
    // Unwrap a lone paragraph so simple items don't gain vertical space.
    return html.replace(/^<p>([\s\S]*)<\/p>$/, '$1');
}

function splitRow(row) {
    let s = row.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
        if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
        cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
}

function table(header, align, rows) {
    const th = header.map((c, i) => `<th${align[i] ? ` style="text-align:${align[i]}"` : ''}>`
        + `${inline(c)}</th>`).join('');
    const body = rows.map(r => '<tr>' + header.map((_, i) =>
        `<td${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(r[i] || '')}</td>`
    ).join('') + '</tr>').join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function codeBlock(code, info) {
    const lang = info.split(/\s+/)[0] || '';
    const html = highlight(code, lang);
    const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
    return `<div class="code-block" data-code="${encodeURIComponent(code)}">`
        + `<div class="code-head">${label}<button class="copy-btn" type="button" title="Copy">Copy</button></div>`
        + `<pre><code>${html}</code></pre></div>`;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * A path-shaped run of text.
 *
 * Two lookbehinds do most of the work. `(?<!\]\()` keeps the target of a
 * markdown link out - without it `[docs](/home/x/y.md)` would grow an anchor
 * inside an href attribute, which is a broken tag rather than merely a wrong
 * link. `(?<![\w:@~.\-/])` is what stops the `/home/foo.md` inside
 * `https://example.com/home/foo.md` matching, and stops the second slash of
 * `a//b` starting a run of its own.
 *
 * The character class is narrower than what a filesystem allows, on purpose:
 * this runs on prose. A space, a comma, a semicolon and a bracket all end the
 * run, so sentence punctuation is never swallowed and a trailing `:12:3` is the
 * only colon that survives.
 *
 * The consequence, and it is the first thing somebody will try to "fix": a path
 * with a space in it is not matched. `/mnt/c/Program Files/x.pdf` matches as far
 * as `/mnt/c/Program` and then fails at the bridge with a message saying so.
 * Admitting an interior space would turn "in /home/dylan and then" into a link
 * that eats the rest of the sentence. Under-matching fails visibly, once;
 * over-matching is wrong on every paragraph.
 */
const PATH_RE = /(?<!\]\()(?<![\w:@~.\-/])(?:~\/|\/)[A-Za-z0-9._~+@\-/]*(?::\d+(?::\d+)?)?/g;

// Roots that are real places rather than namespaces. `/api/sessions/:id/reveal`
// is the case this list exists for: absolute, full of slashes, and a route.
const PATH_ROOTS = /^(?:~|\/(?:home|root|mnt|tmp|var|etc|usr|opt|srv))(?:\/|$)/;
// ...or anything absolute whose last segment carries an extension. That lets
// `/api/foo.json` through, which is the wrong answer for a route that ends in a
// file name - a rare enough shape, and the cost of the miss is a link that
// reports the file does not exist.
const PATH_EXT = /\/[^/]*[A-Za-z0-9]\.[A-Za-z0-9]{1,8}$/;

/**
 * Split a candidate into what to open and what to show, or null for "not a path".
 */
function pathParts(raw) {
    let p = raw;
    let suffix = '';
    // `file.js:120` and `file.js:120:5` are how every tool in this app writes a
    // location. The line number stays in the link text and comes off the path,
    // because Windows would take it for part of the name.
    const lc = /(:\d+(?::\d+)?)$/.exec(p);
    if (lc) { suffix = lc[1]; p = p.slice(0, -suffix.length); }
    // A full stop that ended the sentence, not the file name.
    let tail = '';
    while (p.endsWith('.')) { p = p.slice(0, -1); tail += '.'; }
    if (p.length < 2) return null;
    if (!PATH_ROOTS.test(p) && !PATH_EXT.test(p)) return null;
    return { path: p, text: p + suffix, tail };
}

/** `~/x` as an absolute path, for display only. The bridge does the real one. */
function absolute(p) {
    return p.startsWith('~/') ? HOST.home + p.slice(1) : p;
}

/**
 * The `\\wsl.localhost\...` form, for the hover title.
 *
 * Cosmetic, and worth saying plainly: /mnt/<letter> meaning a Windows drive is a
 * *convention* - automount.root is configurable - and a distribution name is not
 * always what the share ends up called. The translation that gets acted on is
 * `wslpath -w` on the bridge; see POST /api/fs/open.
 */
function uncPath(p) {
    const abs = absolute(p);
    const drive = /^\/mnt\/([a-z])(?=\/|$)/.exec(abs);
    if (drive) {
        return drive[1].toUpperCase() + ':' + (abs.slice(6).replace(/\//g, '\\') || '\\');
    }
    return '\\\\wsl.localhost\\' + HOST.distro + abs.replace(/\//g, '\\');
}

/** The same place as a URL, for `href`. Never navigated to - see the click handler. */
function fileUrl(p) {
    const abs = absolute(p);
    const drive = /^\/mnt\/([a-z])(?=\/|$)/.exec(abs);
    return encodeURI(drive
        ? 'file:///' + drive[1].toUpperCase() + ':' + (abs.slice(6) || '/')
        : 'file://wsl.localhost/' + HOST.distro + abs);
}

/**
 * The anchor for one path.
 *
 * `data-path` is the path exactly as it was written, `~` and all: the bridge
 * expands it with the same expander every other path-taking route uses, and a
 * second expander on this side is how the two drift apart.
 *
 * The href is decoration. Chrome refuses an http: page a file: navigation and
 * does it silently, so it never fires - it is there so copy-link-address gives
 * something pasteable, and so this is a real link to a screen reader.
 */
function pathAnchor(it) {
    return '<a class="fs-path" href="' + escapeHtml(fileUrl(it.path)) + '"'
        + ' title="' + escapeHtml(uncPath(it.path)) + '"'
        + ' data-path="' + escapeHtml(it.path) + '">' + escapeHtml(it.text) + '</a>';
}

/**
 * Link the paths in a run of *raw* text; `park` decides where the anchor goes.
 *
 * Raw and not escaped, which is why this is a pass of its own rather than one
 * more regex in the list inside inline(): a path is escaped exactly once, in
 * pathAnchor, and the finished anchor is then invisible to everything after it.
 * Returns null when there is nowhere for a path to point.
 */
function linkPaths(src, park) {
    if (!HOST) return null;
    return src.replace(PATH_RE, (m, off, whole) => {
        // The other half of the markdown-link guard: `[/home/x.md](url)` would
        // otherwise nest an anchor inside an anchor.
        if (whole.slice(off + m.length, off + m.length + 2) === '](') return m;
        const it = pathParts(m);
        return it ? park(pathAnchor(it)) + it.tail : m;
    });
}

/**
 * A code span's text, escaped, with its paths linked.
 *
 * Most of the paths in these transcripts are written inside backticks, so
 * linking only the bare ones would miss the case the feature is for. The
 * sentinel is a different control character from inline()'s purely so the two
 * can never be confused; escapeHtml leaves both alone, which is what lets the
 * gaps be escaped here and the finished anchors not.
 */
function pathsInCode(text) {
    const anchors = [];
    const marked = linkPaths(text, (html) => `\u0001${anchors.push(html) - 1}\u0001`);
    if (marked === null) return escapeHtml(text);
    return escapeHtml(marked).replace(/\u0001(\d+)\u0001/g, (_, n) => anchors[Number(n)]);
}

/**
 * Inline marks. Code spans are extracted first and parked as placeholders so
 * their contents are never treated as markdown, then restored at the end.
 */
export function inline(src) {
    const parked = [];
    let s = String(src == null ? '' : src);

    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, code) => {
        const text = code.replace(/^ (.*) $/, '$1');
        parked.push(`<code>${pathsInCode(text)}</code>`);
        return `\u0000${parked.length - 1}\u0000`;
    });

    // Absolute paths in the prose around them, parked like a code span.
    //
    // Parked for two reasons rather than one. The anchor is finished HTML and
    // the escapeHtml on the next line would show it as text; and a path with two
    // underscores in it - /home/d/my_file_name.py - is exactly what the emphasis
    // rules further down chew into <em>. A placeholder is inert to both, and the
    // unpark at the end of this function already restores it.
    const linked = linkPaths(s, (html) => `\u0000${parked.push(html) - 1}\u0000`);
    if (linked !== null) s = linked;

    s = escapeHtml(s);

    // Images before links: the syntaxes differ only by a leading '!'.
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
        (_, alt, src2) => `<img src="${safeUrl(src2)}" alt="${alt}" loading="lazy">`);

    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
        (m, text, href) => {
            const url = safeUrl(href);
            return url ? `<a href="${url}" target="_blank" rel="noreferrer">${text}</a>` : m;
        });

    // Bare URLs, but not ones already inside an href we just produced.
    s = s.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<>()"']+[^\s<>()"'.,;:!?])/g,
        (m, pre, url) => `${pre}<a href="${safeUrl(url.startsWith('www.') ? 'http://' + url : url)}" `
            + `target="_blank" rel="noreferrer">${url}</a>`);

    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w_])__([\s\S]+?)__(?!\w)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');

    s = s.replace(/\n/g, '<br>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => parked[Number(n)]);
    return s;
}

function safeUrl(href) {
    const url = String(href).trim();
    // Block javascript: and data: — transcripts can contain anything.
    if (/^(?:javascript|vbscript|data):/i.test(url)) return '';
    return url.replace(/"/g, '%22');
}

export { escapeHtml };
