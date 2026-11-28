'use strict';

// How much a skill about to be imported asks of you, as one number and the
// reasons for it. bridge/skill-import.js counts the files; this module only
// weighs what it was handed, so it is pure and test/skill-safety.test.js pins it.
//
// Size used to be a refusal: 500 files or 5 MB and the skill could not be
// installed at all. That turned away a real skill (taste-skill: 1,631 files,
// 37 MB, almost all of it a design asset library) while saying nothing about
// the thing that actually matters, which is what the skill will *run*. So size
// is now one factor among several, and the score is what the preview shows.
//
// **The score is a sum of capped contributions, clamped to 0–100.** Each factor
// saturates, so a thousand SVGs cannot outweigh one hook, and none of them can
// reach red alone except the ones that run code without being asked:
//
// | factor          | what is counted                                    | points                         | cap |
// |-----------------|----------------------------------------------------|--------------------------------|-----|
// | `hooks`         | frontmatter `hooks:` entries                        | 60 for the first, +5 each more | 70  |
// | `allowed-tools` | tools pre-approved by `allowed-tools`               | see `toolWeight`               | 25  |
// | `remote-exec`   | text files that pipe a download into a shell        | 30 for the first, +10 each     | 40  |
// | `scripts`       | files with a script extension (.sh .py .js .mjs …)  | 4·log2(1+n)                    | 20  |
// | `executables`   | files with an executable bit                        | 3·log2(1+n)                    | 10  |
// | `binaries`      | files the preview cannot show as text               | 2·log2(1+n)                    | 10  |
// | `unreadable`    | text files too large to open in the preview (>256KB)| 2 each                         | 10  |
// | `files`         | every file                                          | 5·log2(n/50), from 50 files    | 15  |
// | `bytes`         | every byte                                          | 5·log2(MB), from 1 MB          | 15  |
//
// `toolWeight`: everything (`*`) 25; Bash with no pattern, or `Bash(*)`, 20;
// Bash with a pattern 6 each; Write, Edit, MultiEdit, NotebookEdit 4 each;
// WebFetch, WebSearch 3 each; an MCP tool 2 each; reading tools 0.
//
// **Levels: green below 25, yellow 25–59, red from 60.** Red is what makes the
// client open a full-screen confirmation, and what the bridge refuses to
// install without `confirmedRisk: true`. The first hook is worth 60 on purpose,
// so "a skill that declares a hook is red" is a consequence of the weights
// rather than a special case beside them: the marker on the bar and the level
// beside it can never disagree. A hook is the one thing in a skill that runs a
// command on an event with no model deciding to, every time, in every session
// that has the skill loaded — taste-skill's runs `node scripts/gate.mjs` on
// every Stop with a 600 s timeout.
//
// Below that, a typical tool skill — a few scripts, one executable, Bash
// pre-approved — lands in yellow (`anthropics/skills`' pdf is 33), and a skill
// that is only a SKILL.md is 0.
//
// `parseHooks` reads the `hooks:` block out of the frontmatter. It is not a
// YAML parser, any more than bridge/skills.js's `frontmatter` is: it knows the
// one shape Claude Code documents (event → [{matcher?, hooks: [{type, command,
// timeout?}]}]), tolerates quoting and block scalars, and when it finds a
// `hooks:` key but no command in it, still reports one entry with the raw text,
// so a hook in a shape it does not know is shown rather than missed.

const GREEN_BELOW = 25;
const RED_FROM = 60;

const log2 = Math.log2;
const cap = (n, max) => Math.max(0, Math.min(max, n));

/** Points per factor, as functions of the counted value. Exported for the tests and the docs. */
const WEIGHTS = {
    hooks: (n) => (n ? cap(60 + 5 * (n - 1), 70) : 0),
    'remote-exec': (n) => (n ? cap(30 + 10 * (n - 1), 40) : 0),
    scripts: (n) => cap(4 * log2(1 + n), 20),
    executables: (n) => cap(3 * log2(1 + n), 10),
    binaries: (n) => cap(2 * log2(1 + n), 10),
    unreadable: (n) => cap(2 * n, 10),
    files: (n) => (n > 50 ? cap(5 * log2(n / 50), 15) : 0),
    bytes: (b) => (b > 1024 * 1024 ? cap(5 * log2(b / (1024 * 1024)), 15) : 0),
};
const TOOLS_CAP = 25;

function levelOf(score) {
    if (score >= RED_FROM) return 'red';
    if (score >= GREEN_BELOW) return 'yellow';
    return 'green';
}

// ---------------------------------------------------------------------------
// allowed-tools
// ---------------------------------------------------------------------------

/** `allowed-tools` as written — "Bash, Read", "Bash(git:*) Read", "- Bash - Read", "[Bash, Read]" — as tool names. */
function splitTools(s) {
    const out = [];
    let cur = '';
    let depth = 0;
    for (const ch of String(s || '')) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (depth === 0 && /[\s,[\]]/.test(ch)) { if (cur) out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur) out.push(cur);
    return out.map(t => t.replace(/^['"-]+|['"]+$/g, '')).filter(t => t && t !== '-');
}

/** One tool's points and why. */
function toolWeight(tool) {
    const m = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/.exec(tool);
    if (tool === '*' || tool === 'all') return { points: 25, why: 'every tool' };
    if (!m) return { points: 0, why: null };
    const [, name, pattern] = m;
    if (name === 'Bash') {
        const p = (pattern || '').trim();
        if (!p || p === '*' || p === ':*' || p === '*:*') return { points: 20, why: 'any shell command' };
        return { points: 6, why: `shell: ${p}` };
    }
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return { points: 4, why: `${name.toLowerCase()} files` };
    if (['WebFetch', 'WebSearch'].includes(name)) return { points: 3, why: 'the web' };
    if (name.startsWith('mcp__')) return { points: 2, why: name };
    return { points: 0, why: null };
}

// ---------------------------------------------------------------------------
// hooks:
// ---------------------------------------------------------------------------

const RAW_MAX = 8 * 1024;

function unquote(v) {
    const s = String(v).trim();
    if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
    if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
        try { return JSON.parse(s); } catch { return s.slice(1, -1); }
    }
    return s;
}

const indentOf = (l) => /^\s*/.exec(l)[0].length;

/**
 * The hooks a SKILL.md's frontmatter declares.
 * @returns {{declared: boolean, hooks: {event: string|null, matcher: string|null, type: string|null, command: string|null, timeout: number|null}[], raw: string}}
 */
function parseHooks(text) {
    const none = { declared: false, hooks: [], raw: '' };
    if (!text) return none;
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
    if (lines[0].trim() !== '---') return none;
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end < 0) return none;
    const at = lines.findIndex((l, i) => i > 0 && i < end && /^hooks:/.test(l));
    if (at < 0) return none;

    const inline = lines[at].replace(/^hooks:\s*/, '');
    const block = [];
    for (let i = at + 1; i < end && (!lines[i].trim() || /^\s/.test(lines[i])); i++) block.push(lines[i]);
    while (block.length && !block[block.length - 1].trim()) block.pop();
    const rawFull = [lines[at], ...block].join('\n');
    const raw = rawFull.length > RAW_MAX ? `${rawFull.slice(0, RAW_MAX)}\n…` : rawFull;

    const hooks = [];
    let event = null;
    let matcher = null;
    let cur = null;
    const base = block.filter(l => l.trim()).reduce((m, l) => Math.min(m, indentOf(l)), Infinity);
    const flush = () => { cur = null; };
    const start = () => { cur = { event, matcher, type: null, command: null, timeout: null }; hooks.push(cur); };
    const setKey = (key, value, dash) => {
        if (key === 'matcher') { matcher = unquote(value) || null; flush(); return; }
        if (!['type', 'command', 'timeout'].includes(key)) return;
        if (dash || !cur || cur[key] != null) start();
        if (key === 'timeout') { const n = Number(unquote(value)); cur.timeout = Number.isFinite(n) ? n : null; return; }
        cur[key] = unquote(value);
    };

    for (let i = 0; i < block.length; i++) {
        const line = block[i];
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const ind = indentOf(line);
        const ev = /^\s*([A-Za-z][\w-]*):\s*$/.exec(line);
        if (ev && ind === base) { event = ev[1]; matcher = null; flush(); continue; }
        // A flow mapping on one line: `- { type: command, command: "x" }`.
        const flow = /^\s*(?:-\s+)?\{(.*)\}\s*$/.exec(line);
        if (flow) {
            const body = flow[1];
            const dash = /^\s*-/.test(line);
            const parts = body.match(/[A-Za-z_]+\s*:\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+)/g) || [];
            parts.forEach((p, n) => {
                const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(p.trim());
                if (kv) setKey(kv[1], kv[2], dash && n === 0);
            });
            continue;
        }
        const kv = /^\s*(-\s+)?([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (!kv) continue;
        const dash = Boolean(kv[1]);
        const key = kv[2];
        let value = kv[3];
        if (/^[|>][+-]?\s*$/.test(value)) {
            // A block scalar: every line indented past the key.
            const keyInd = ind + (kv[1] ? kv[1].length : 0);
            const parts = [];
            while (i + 1 < block.length && (!block[i + 1].trim() || indentOf(block[i + 1]) > keyInd)) parts.push(block[++i]);
            const strip = parts.filter(l => l.trim()).reduce((m, l) => Math.min(m, indentOf(l)), Infinity);
            const body = parts.map(l => l.slice(Math.min(strip, indentOf(l)))).join(value[0] === '|' ? '\n' : ' ').trim();
            value = JSON.stringify(body);
        } else if (/^(['"])/.test(value) && !(value.length > 1 && value.trim().endsWith(value[0]))) {
            // A quoted scalar that carries on over the next lines.
            const q = value[0];
            while (i + 1 < block.length) {
                value += ` ${block[++i].trim()}`;
                if (value.trim().endsWith(q)) break;
            }
        }
        if (key === 'hooks' && value.trim() === '') continue;
        setKey(key, value, dash);
    }

    const real = hooks.filter(h => h.command || h.type);
    if (!real.length) {
        return { declared: true, hooks: [{ event, matcher: null, type: null, command: inline.trim() || null, timeout: null }], raw };
    }
    return { declared: true, hooks: real, raw };
}

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function mb(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Weigh one skill.
 * @param {{files: number, bytes: number, scripts: number, executables: number, binaries: number,
 *          unreadable?: number, remoteExec?: string[], hooks?: {declared, hooks}, allowedTools?: string|null}} s
 * @returns {{score: number, level: 'green'|'yellow'|'red', requiresConfirm: boolean,
 *            factors: {factor: string, label: string, value: number|string, contribution: number, note: string}[],
 *            hooks: object[]}}
 */
function scoreSkill(s = {}) {
    const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
    const hookList = (s.hooks && s.hooks.declared) ? s.hooks.hooks : [];
    const remote = Array.isArray(s.remoteExec) ? s.remoteExec : [];
    const tools = s.allowedTools ? splitTools(s.allowedTools) : [];
    const weighed = tools.map(t => ({ tool: t, ...toolWeight(t) })).filter(t => t.points > 0);
    const toolPoints = cap(weighed.reduce((a, t) => a + t.points, 0), TOOLS_CAP);

    const hookNote = hookList.length
        ? hookList.map(h => `${h.event || 'an event'}${h.matcher ? ` (${h.matcher})` : ''}: ${h.command ? h.command : 'a hook in a shape this preview cannot read'}`).join('; ')
        : 'none declared';

    const factors = [
        { factor: 'hooks', label: 'Hooks', value: hookList.length, contribution: WEIGHTS.hooks(hookList.length),
            note: hookList.length ? `runs on its own while the skill is loaded — ${hookNote}` : hookNote },
        { factor: 'allowed-tools', label: 'Pre-approved tools', value: s.allowedTools || '', contribution: toolPoints,
            note: !tools.length ? 'none' : weighed.length ? `without asking: ${weighed.map(t => t.why).join(', ')}` : `read-only: ${tools.join(', ')}` },
        { factor: 'remote-exec', label: 'Downloads piped to a shell', value: remote.length, contribution: WEIGHTS['remote-exec'](remote.length),
            note: remote.length ? `curl | sh or similar in ${remote.slice(0, 3).join(', ')}${remote.length > 3 ? ` and ${remote.length - 3} more` : ''}` : 'none found' },
        { factor: 'scripts', label: 'Scripts', value: n(s.scripts), contribution: WEIGHTS.scripts(n(s.scripts)),
            note: n(s.scripts) ? `${plural(n(s.scripts), 'file')} a model could run` : 'none' },
        { factor: 'executables', label: 'Executables', value: n(s.executables), contribution: WEIGHTS.executables(n(s.executables)),
            note: n(s.executables) ? `${plural(n(s.executables), 'file')} with the executable bit` : 'none' },
        { factor: 'binaries', label: 'Binary files', value: n(s.binaries), contribution: WEIGHTS.binaries(n(s.binaries)),
            note: n(s.binaries) ? `${plural(n(s.binaries), 'file')} the preview cannot show` : 'none' },
        { factor: 'unreadable', label: 'Too large to read here', value: n(s.unreadable), contribution: WEIGHTS.unreadable(n(s.unreadable)),
            note: n(s.unreadable) ? `${plural(n(s.unreadable), 'text file')} over 256 KB` : 'none' },
        { factor: 'files', label: 'Files', value: n(s.files), contribution: WEIGHTS.files(n(s.files)),
            note: n(s.files) > 50 ? `${n(s.files)} files to look through` : `${plural(n(s.files), 'file')}` },
        { factor: 'bytes', label: 'Size', value: n(s.bytes), contribution: WEIGHTS.bytes(n(s.bytes)),
            note: mb(n(s.bytes)) },
    ].map(f => ({ ...f, contribution: Math.round(f.contribution) }));

    const score = Math.min(100, factors.reduce((a, f) => a + f.contribution, 0));
    const level = levelOf(score);
    return { score, level, requiresConfirm: level === 'red', factors, hooks: hookList };
}

module.exports = { scoreSkill, parseHooks, splitTools, toolWeight, levelOf, WEIGHTS, GREEN_BELOW, RED_FROM, TOOLS_CAP };
