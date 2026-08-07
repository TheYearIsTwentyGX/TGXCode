// A small syntax highlighter.
//
// Each language is an ordered list of token rules compiled into one sticky
// regex. Scanning left-to-right with a single pass avoids the classic bug of
// running string/comment/keyword replacements in sequence and having a keyword
// inside a string get marked up.

const KEYWORDS = {
    js: 'as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public return satisfies set static super switch this throw true try typeof var void while with yield keyof readonly declare namespace abstract infer asserts is any unknown never',
    py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self cls',
    sh: 'if then else elif fi for while until do done case esac function in return exit break continue local export readonly declare set unset shift source alias echo cd trap eval exec',
    sql: 'select from where group by order having limit offset insert into values update set delete create table alter drop index view join left right inner outer full on as and or not null is distinct union all case when then else end with returning primary key foreign references default constraint cascade begin commit rollback',
    css: 'important media supports keyframes import charset font-face namespace container layer',
    go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false make new len cap append copy delete panic recover',
    rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
    cs: 'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while yield record nameof when',
    yaml: 'true false null yes no on off',
};

const ALIASES = {
    javascript: 'js', jsx: 'js', typescript: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js',
    python: 'py', py3: 'py',
    bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', terminal: 'sh',
    postgres: 'sql', postgresql: 'sql', mysql: 'sql',
    golang: 'go', rs: 'rust',
    'c#': 'cs', csharp: 'cs', dotnet: 'cs',
    yml: 'yaml',
    htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
    scss: 'css', less: 'css',
    patch: 'diff',
    text: null, txt: null, plain: null, log: null, '': null,
};

// Build the rule table. Order within a language is significant.
function rules(lang) {
    const kw = (name) => new RegExp('\\b(?:' + KEYWORDS[name].trim().split(/\s+/).join('|') + ')\\b');

    switch (lang) {
        case 'js':
            return [
                ['comment', /\/\*[\s\S]*?\*\/|\/\/[^\n]*/],
                ['string', /`(?:\\[\s\S]|\$\{[^}]*\}|[^\\`])*`|"(?:\\[\s\S]|[^\\"])*"|'(?:\\[\s\S]|[^\\'])*'/],
                ['regex', /\/(?![*/])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+\/[gimsuyd]*(?=[\s;,).\]}]|$)/],
                ['number', /\b0[xXbBoO][0-9a-fA-F_]+n?\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?\b/],
                ['keyword', kw('js')],
                ['builtin', /\b(?:console|window|document|process|Math|JSON|Object|Array|String|Number|Boolean|Promise|Map|Set|Date|RegExp|Error|Symbol|BigInt|globalThis|require|module|exports|__dirname|__filename)\b/],
                ['fn', /\b[A-Za-z_$][\w$]*(?=\s*\()/],
                ['type', /\b[A-Z][A-Za-z0-9_$]*\b/],
                ['punct', /[{}[\]().,;:?!<>+\-*/%&|^~=]+/],
            ];
        case 'py':
            return [
                ['comment', /#[^\n]*/],
                ['string', /[rbfu]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^\\"])*"|'(?:\\[\s\S]|[^\\'])*')/],
                ['decorator', /@[\w.]+/],
                ['number', /\b0[xXbBoO][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?j?\b/],
                ['keyword', kw('py')],
                ['builtin', /\b(?:print|len|range|dict|list|set|tuple|str|int|float|bool|open|enumerate|zip|map|filter|sorted|sum|min|max|abs|isinstance|type|super|hasattr|getattr|setattr)\b/],
                ['fn', /\b[A-Za-z_]\w*(?=\s*\()/],
                ['type', /\b[A-Z]\w*\b/],
                ['punct', /[{}[\]().,;:?+\-*/%&|^~=<>]+/],
            ];
        case 'sh':
            return [
                ['comment', /#[^\n]*/],
                ['string', /"(?:\\[\s\S]|[^\\"])*"|'[^']*'/],
                ['var', /\$(?:\{[^}]*\}|[A-Za-z_]\w*|[@*#?$!0-9-])/],
                ['flag', /(?:^|\s)--?[A-Za-z][\w-]*/],
                ['number', /\b\d+\b/],
                ['keyword', kw('sh')],
                ['builtin', /\b(?:git|npm|pnpm|yarn|node|python3?|docker|kubectl|curl|grep|sed|awk|find|ls|cat|mkdir|rm|cp|mv|chmod|ssh|make|cargo|go|dotnet|devbrowser)\b/],
                ['punct', /[|&;()<>{}[\]]+/],
            ];
        case 'sql':
            return [
                ['comment', /--[^\n]*|\/\*[\s\S]*?\*\//],
                ['string', /'(?:''|[^'])*'/],
                ['number', /\b\d+(?:\.\d+)?\b/],
                ['keyword', new RegExp('\\b(?:' + KEYWORDS.sql.trim().split(/\s+/).join('|') + ')\\b', 'i')],
                ['fn', /\b[A-Za-z_]\w*(?=\s*\()/],
                ['punct', /[(),.;*=<>+\-/|]+/],
            ];
        case 'json':
            return [
                ['key', /"(?:\\.|[^\\"])*"(?=\s*:)/],
                ['string', /"(?:\\.|[^\\"])*"/],
                ['number', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
                ['keyword', /\b(?:true|false|null)\b/],
                ['punct', /[{}[\],:]+/],
            ];
        case 'css':
            return [
                ['comment', /\/\*[\s\S]*?\*\//],
                ['string', /"(?:\\.|[^\\"])*"|'(?:\\.|[^\\'])*'/],
                ['at', /@[\w-]+/],
                ['number', /-?\b\d*\.?\d+(?:px|rem|em|%|vh|vw|s|ms|deg|fr|ch|ex|pt)?\b/],
                ['selector', /[.#][\w-]+|::?[\w-]+(?:\([^)]*\))?/],
                ['prop', /\b[a-z-]+(?=\s*:)/],
                ['fn', /\b[\w-]+(?=\()/],
                ['punct', /[{}();:,>+~]+/],
            ];
        case 'html':
            return [
                ['comment', /<!--[\s\S]*?-->/],
                ['doctype', /<!DOCTYPE[^>]*>/i],
                ['tag', /<\/?[A-Za-z][\w:-]*/],
                ['string', /"(?:\\.|[^\\"])*"|'(?:\\.|[^\\'])*'/],
                ['attr', /\b[a-zA-Z-:@][\w:.-]*(?==)/],
                ['punct', /[/>]+/],
            ];
        case 'yaml':
            return [
                ['comment', /#[^\n]*/],
                ['key', /^[ \t]*-?[ \t]*[\w.$-]+(?=\s*:)/m],
                ['string', /"(?:\\.|[^\\"])*"|'(?:''|[^'])*'/],
                ['number', /\b-?\d+(?:\.\d+)?\b/],
                ['keyword', kw('yaml')],
                ['punct', /[[\]{}:,>|*&-]+/],
            ];
        case 'diff':
            return [
                ['diff-meta', /^(?:diff|index|---|\+\+\+|@@)[^\n]*/m],
                ['diff-add', /^\+[^\n]*/m],
                ['diff-del', /^-[^\n]*/m],
            ];
        case 'go':
        case 'rust':
        case 'cs':
            return [
                ['comment', /\/\*[\s\S]*?\*\/|\/\/[^\n]*/],
                ['string', /"(?:\\[\s\S]|[^\\"])*"|`[^`]*`|'(?:\\.|[^\\'])'/],
                ['number', /\b0[xXbB][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?[a-zA-Z]*\b/],
                ['keyword', kw(lang)],
                ['fn', /\b[A-Za-z_]\w*(?=\s*[(<])/],
                ['type', /\b[A-Z]\w*\b/],
                ['punct', /[{}[\]().,;:?!<>+\-*/%&|^~=]+/],
            ];
        default:
            return null;
    }
}

const compiled = new Map();

function compile(lang) {
    if (compiled.has(lang)) return compiled.get(lang);
    const rs = rules(lang);
    if (!rs) { compiled.set(lang, null); return null; }
    // One sticky alternation; group N+1 tells us which rule matched.
    const source = rs.map(([, re]) => '(' + re.source + ')').join('|');
    const flags = 'gy' + (rs.some(([, re]) => re.flags.includes('m')) ? 'm' : '')
        + (rs.some(([, re]) => re.flags.includes('i')) ? 'i' : '');
    const entry = { types: rs.map(([t]) => t), re: new RegExp(source, flags) };
    compiled.set(lang, entry);
    return entry;
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Resolve a fence info string ("ts", "bash", "js title=x") to a language key. */
export function resolveLang(info) {
    const raw = String(info || '').trim().split(/[\s:,]/)[0].toLowerCase();
    if (raw in ALIASES) return ALIASES[raw];
    if (KEYWORDS[raw] || raw === 'json' || raw === 'diff' || raw === 'html') return raw;
    return null;
}

/** Highlight `code` as `lang`, returning HTML. Unknown languages are escaped only. */
export function highlight(code, lang) {
    const key = resolveLang(lang);
    const entry = key && compile(key);
    if (!entry) return escapeHtml(code);

    const { re, types } = entry;
    re.lastIndex = 0;
    let out = '';
    let i = 0;

    while (i < code.length) {
        re.lastIndex = i;
        const m = re.exec(code);
        if (!m) {
            out += escapeHtml(code.slice(i));
            break;
        }
        // Sticky flag guarantees m.index === i, so no gap handling is needed.
        let type = null;
        for (let g = 1; g < m.length; g++) {
            if (m[g] !== undefined) { type = types[g - 1]; break; }
        }
        const text = m[0];
        if (!text.length) { // pathological empty match: bail out safely
            out += escapeHtml(code.slice(i));
            break;
        }
        out += type ? `<span class="tok-${type}">${escapeHtml(text)}</span>` : escapeHtml(text);
        i += text.length;

        // Advance over anything the rules didn't claim.
        if (i < code.length) {
            re.lastIndex = i;
            if (!re.test(code)) {
                let j = i;
                while (j < code.length) {
                    re.lastIndex = j;
                    if (re.test(code)) break;
                    j++;
                }
                out += escapeHtml(code.slice(i, j));
                i = j;
            }
        }
    }
    return out;
}

export { escapeHtml };
