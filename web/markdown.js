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

/**
 * Inline marks. Code spans are extracted first and parked as placeholders so
 * their contents are never treated as markdown, then restored at the end.
 */
export function inline(src) {
    const parked = [];
    let s = String(src == null ? '' : src);

    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, code) => {
        const text = code.replace(/^ (.*) $/, '$1');
        parked.push(`<code>${escapeHtml(text)}</code>`);
        return `\u0000${parked.length - 1}\u0000`;
    });

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
