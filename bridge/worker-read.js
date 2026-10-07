'use strict';

// A worker's transcript, rendered for its orchestrator to read.
//
// The orchestrator is a model with a context window of its own, and a worker's
// raw transcript is the fastest way to fill it: tool results, file contents,
// thinking. So there are three ways in, from cheapest:
//
//   digest  a few lines built without a model — where it stands, what it last
//           said, its todo list, which files it touched, `git diff --stat`.
//   tail    the last few turns as conversation: what was asked, what it said,
//           one line per tool call. No tool output.
//   full    the same rendering for the whole transcript, a page at a time.
//
// (The fourth, `ask`, has the worker summarise itself and is not here: it is a
// message, sent by bridge/orchestration.js, and its answer arrives as a turn.)
//
// Plain functions over a file path, so the test can feed one a fixture.

const fs = require('fs');
const { execFile } = require('child_process');

const { parseLines, describeTool, stripEnvelope, todoProgress, firstLine } = require('./transcript');

const PAGE_CHARS = 40_000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function entriesOf(file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { return []; }
    return parseLines(buf).entries;
}

function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n');
}

/**
 * The transcript as turns: `[{user, steps: [string]}]`. A user entry carrying
 * only tool results continues the turn it belongs to rather than opening one.
 */
function turnsOf(entries) {
    const turns = [];
    let cur = null;
    for (const e of entries) {
        if (!e || e.isSidechain || e.isMeta) continue;
        const content = e.message && e.message.content;
        if (e.type === 'user') {
            const text = stripEnvelope(textOf(content)).trim();
            if (!text) continue; // tool results
            cur = { user: text, steps: [] };
            turns.push(cur);
        } else if (e.type === 'assistant' && Array.isArray(content)) {
            if (!cur) { cur = { user: '', steps: [] }; turns.push(cur); }
            for (const b of content) {
                if (b.type === 'text' && b.text && b.text.trim()) cur.steps.push(b.text.trim());
                else if (b.type === 'tool_use') cur.steps.push(`→ ${describeTool(b)}`);
            }
        }
    }
    return turns;
}

function renderTurns(turns) {
    return turns.map((t, i) => {
        const head = t.user ? `### Turn ${i + 1} — asked:\n${t.user}` : `### Turn ${i + 1}`;
        return t.steps.length ? `${head}\n\n${t.steps.join('\n\n')}` : head;
    }).join('\n\n');
}

/** The last `n` turns, rendered. */
function tail(file, n = 3) {
    const turns = turnsOf(entriesOf(file));
    const from = Math.max(0, turns.length - Math.max(1, n));
    const shown = renderTurns(turns.slice(from)).replace(/^### Turn (\d+)/gm,
        (_, k) => `### Turn ${Number(k) + from}`);
    return { text: shown || '(nothing in the transcript yet)', turns: turns.length };
}

/** One page of the whole transcript, rendered; `next` is the offset to ask for after it. */
function full(file, offset = 0) {
    const all = renderTurns(turnsOf(entriesOf(file)));
    const start = Math.max(0, Math.min(Number(offset) || 0, all.length));
    const end = Math.min(all.length, start + PAGE_CHARS);
    return {
        text: all.slice(start, end) || '(nothing in the transcript yet)',
        offset: start,
        next: end < all.length ? end : null,
        total: all.length,
    };
}

function gitStat(cwd) {
    return new Promise((resolve) => {
        if (!cwd) return resolve(null);
        execFile('git', ['-C', cwd, 'diff', '--stat', 'HEAD'], { timeout: 5000 }, (err, out) => {
            resolve(err ? null : String(out).trim() || null);
        });
    });
}

/**
 * The cheap summary. `status` is the runner's, or null with no process.
 * `lastResult` is the runner's last final text when it has one, which beats
 * digging the same thing out of the file.
 */
async function digest(file, { cwd, status, lastResult } = {}) {
    const entries = entriesOf(file);
    const turns = turnsOf(entries);
    const touched = new Set();
    const tools = new Map();
    let lastText = '';
    for (const e of entries) {
        if (!e || e.isSidechain || e.type !== 'assistant') continue;
        const content = e.message && e.message.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
            if (b.type === 'tool_use') {
                tools.set(b.name, (tools.get(b.name) || 0) + 1);
                const p = b.input && (b.input.file_path || b.input.notebook_path);
                if (EDIT_TOOLS.has(b.name) && p) touched.add(p);
            } else if (b.type === 'text' && b.text && b.text.trim()) {
                lastText = b.text.trim();
            }
        }
    }

    const lines = [];
    const state = status ? status.state : 'no process';
    lines.push(`state: ${state}${status && status.pendingPermission
        ? ` — waiting on ${status.pendingPermission.kind === 'plan' ? 'a plan approval'
            : status.pendingPermission.kind === 'question' ? 'an answer'
            : `permission for ${status.pendingPermission.displayName}`}`
        : ''}`);
    lines.push(`turns: ${turns.length}`);
    const todo = todoProgress(file);
    if (todo) {
        lines.push(`todo: ${todo.done}/${todo.total} done${todo.current ? ` — now: ${todo.current}` : ''}`);
    }
    if (tools.size) {
        lines.push(`tool calls: ${[...tools].sort((a, b) => b[1] - a[1])
            .map(([n, c]) => `${n} ×${c}`).join(', ')}`);
    }
    if (touched.size) lines.push(`files edited:\n${[...touched].map(p => `  ${p}`).join('\n')}`);
    const stat = await gitStat(cwd);
    if (stat) lines.push(`git diff --stat HEAD:\n${stat.split('\n').map(l => `  ${l}`).join('\n')}`);
    const said = (lastResult && lastResult.trim()) || lastText;
    if (said) {
        const cut = said.length > 3000 ? `…${said.slice(-3000)}` : said;
        lines.push(`last message:\n${cut}`);
    }
    return { text: lines.join('\n'), headline: said ? firstLine(said, 120) : null };
}

module.exports = { digest, tail, full, turnsOf, PAGE_CHARS };
