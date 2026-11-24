'use strict';

// Writes a Claude Code transcript — the `<session-id>.jsonl` the CLI keeps under
// ~/.claude/projects/<escaped-cwd>/ — for a conversation that never happened.
//
// The shape is copied from what the CLI writes: one entry per content block
// (an assistant turn with a thought, a sentence and a tool call is three
// entries sharing a message id), every entry pointing at the one before through
// `parentUuid`, a tool's result as the *user* entry that follows it, and the
// diff of an Edit as `toolUseResult.structuredPatch`. Only fields the app reads
// are filled in; the CLI's own bookkeeping (request blobs, cost state) is left out.
//
// File edits are real. `edit()` and `write()` change the file under `cwd` as well
// as recording the call, and `edit()` throws when `old` is not in the file — so a
// scripted conversation cannot drift away from the project it claims to edit, and
// the Changes drawer, which diffs the working tree, shows what the transcript says.

const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');

const VERSION = '2.1.322';
const MODEL = 'claude-sonnet-5-5';

let toolCounter = 0;
const toolId = () => `toolu_${createHash('sha1').update(String(++toolCounter) + 'demo').digest('hex').slice(0, 22)}`;
const msgId = () => `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

/** `cat -n` as the Read tool returns it: a right-aligned number, an arrow, the line. */
function numbered(text, from = 1) {
    return text.replace(/\n$/, '').split('\n')
        .map((l, i) => `${String(i + from).padStart(6)}→${l}`).join('\n');
}

/**
 * The hunk an Edit's result carries: the changed lines with three of context on
 * each side, found by trimming what two versions of a file share at both ends.
 */
function patchFor(before, after) {
    const a = before.replace(/\n$/, '').split('\n');
    const b = after.replace(/\n$/, '').split('\n');
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head
        && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const ctx = 3;
    const from = Math.max(0, head - ctx);
    const aEnd = Math.min(a.length, a.length - tail + ctx);
    const bEnd = Math.min(b.length, b.length - tail + ctx);
    const lines = [
        ...a.slice(from, head).map(l => ' ' + l),
        ...a.slice(head, a.length - tail).map(l => '-' + l),
        ...b.slice(head, b.length - tail).map(l => '+' + l),
        ...a.slice(a.length - tail, aEnd).map(l => ' ' + l),
    ];
    return [{ oldStart: from + 1, oldLines: aEnd - from, newStart: from + 1, newLines: bEnd - from, lines }];
}

class Conversation {
    /**
     * @param {object} o
     * @param {string} o.sessionId
     * @param {string} o.cwd         where the session ran — the project or a worktree of it
     * @param {string} o.title       what the rail calls it (an `ai-title` entry)
     * @param {number} o.startedAt   epoch ms of the first prompt
     * @param {string} [o.branch]
     * @param {string} [o.mode]      the permission mode the prompts ran under
     */
    constructor({ sessionId, cwd, title, startedAt, branch = 'main', mode = 'default' }) {
        this.sessionId = sessionId;
        this.cwd = cwd;
        this.title = title;
        this.branch = branch;
        this.mode = mode;
        this.clock = startedAt;
        this.lines = [];
        this.parent = null;
        this.promptId = null;
        this.message = null;
        this.pendingUse = null;
        this.turn = 0;
    }

    // -- time ------------------------------------------------------------

    /** Move the clock on; a conversation reads as one when its turns are not simultaneous. */
    wait(seconds) { this.clock += seconds * 1000; return this; }

    get now() { return this.clock; }

    // -- plumbing --------------------------------------------------------

    _stamp(entry) {
        this.clock += 700 + Math.floor((this.lines.length * 397) % 2300);
        const uuid = randomUUID();
        const full = {
            parentUuid: this.parent,
            isSidechain: false,
            ...entry,
            uuid,
            timestamp: new Date(this.clock).toISOString(),
            userType: 'external',
            entrypoint: 'tgxcode',
            cwd: this.cwd,
            sessionId: this.sessionId,
            version: VERSION,
            gitBranch: this.branch,
        };
        this.parent = uuid;
        this.lines.push(full);
        return full;
    }

    _assistant(block, stop) {
        if (!this.message) this.message = msgId();
        const out = 40 + Math.floor((block.text || block.thinking || JSON.stringify(block.input || '')).length / 3.2);
        return this._stamp({
            type: 'assistant',
            message: {
                model: MODEL, id: this.message, type: 'message', role: 'assistant',
                content: [block], stop_reason: stop,
                usage: {
                    input_tokens: 3, cache_creation_input_tokens: 9000 + this.lines.length * 420,
                    cache_read_input_tokens: 60000 + this.lines.length * 7500, output_tokens: out * 9,
                },
            },
            requestId: `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        });
    }

    // -- the prompt, the thinking, the answer ----------------------------

    user(text) {
        this.message = null;
        this.turn++;
        this.promptId = randomUUID();
        this._stamp({
            type: 'user',
            promptId: this.promptId,
            message: { role: 'user', content: [{ type: 'text', text }] },
            permissionMode: this.mode,
            promptSource: 'sdk',
            turnOrigin: 'sdk',
        });
        return this;
    }

    think(text) {
        this._assistant({ type: 'thinking', thinking: text, signature: 'ZGVtbw==' }, 'tool_use');
        return this;
    }

    say(text, { last = false } = {}) {
        this._assistant({ type: 'text', text }, last ? 'end_turn' : 'tool_use');
        if (last) this.message = null;
        return this;
    }

    // -- tools -----------------------------------------------------------

    /** A tool call and its result. `result` is the text; `extra` is `toolUseResult`. */
    tool(name, input, result, extra = {}, { error = false } = {}) {
        const id = toolId();
        const use = this._assistant({ type: 'tool_use', id, name, input, caller: { type: 'direct' } }, 'tool_use');
        this.wait(1 + (this.lines.length % 4));
        this._stamp({
            type: 'user',
            promptId: this.promptId,
            message: {
                role: 'user',
                content: [{ tool_use_id: id, type: 'tool_result', content: result, is_error: error }],
            },
            toolUseResult: extra,
            sourceToolAssistantUUID: use.uuid,
        });
        return this;
    }

    /** A tool call the CLI is still waiting to run: used for a turn that ends blocked. */
    open(name, input) {
        const id = toolId();
        this._assistant({ type: 'tool_use', id, name, input, caller: { type: 'direct' } }, 'tool_use');
        this.pendingUse = id;
        return id;
    }

    read(file, { offset, limit } = {}) {
        const abs = this.abs(file);
        const text = fs.readFileSync(abs, 'utf8');
        const all = text.replace(/\n$/, '').split('\n');
        const start = offset || 1;
        const slice = all.slice(start - 1, limit ? start - 1 + limit : undefined);
        return this.tool('Read', { file_path: abs, ...(offset ? { offset } : {}), ...(limit ? { limit } : {}) },
            numbered(slice.join('\n'), start),
            { type: 'text', file: { filePath: abs, content: slice.join('\n'), numLines: slice.length,
                startLine: start, totalLines: all.length } });
    }

    edit(file, oldString, newString) {
        const abs = this.abs(file);
        const before = fs.readFileSync(abs, 'utf8');
        if (!before.includes(oldString)) {
            throw new Error(`demo edit does not apply: ${file} has no "${oldString.slice(0, 50)}…"`);
        }
        if (before.split(oldString).length > 2) {
            throw new Error(`demo edit is ambiguous: ${file} has "${oldString.slice(0, 50)}…" more than once`);
        }
        const after = before.replace(oldString, () => newString);
        fs.writeFileSync(abs, after);
        return this.tool('Edit', { file_path: abs, old_string: oldString, new_string: newString },
            `The file ${abs} has been updated successfully.`,
            { filePath: abs, oldString, newString, originalFile: before,
                structuredPatch: patchFor(before, after), userModified: false, replaceAll: false });
    }

    write(file, content) {
        const abs = this.abs(file);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const existed = fs.existsSync(abs);
        fs.writeFileSync(abs, content);
        return this.tool('Write', { file_path: abs, content },
            `File ${existed ? 'updated' : 'created'} successfully at: ${abs}`,
            { type: existed ? 'update' : 'create', filePath: abs, content, structuredPatch: [] });
    }

    bash(command, stdout, { description, stderr = '', error = false } = {}) {
        return this.tool('Bash', { command, ...(description ? { description } : {}) },
            [stdout, stderr].filter(Boolean).join('\n'),
            { stdout, stderr, interrupted: false, isImage: false, noOutputExpected: !stdout },
            { error });
    }

    grep(pattern, where, output) {
        return this.tool('Grep', { pattern, path: this.abs(where), output_mode: 'content', '-n': true },
            output, { mode: 'content', numLines: output.split('\n').length, content: output });
    }

    todo(items) {
        const todos = items.map(([content, status]) => ({
            content, status, activeForm: content.replace(/^(\w+)/, (w) => w.replace(/e$/, '') + 'ing'),
        }));
        return this.tool('TodoWrite', { todos }, 'Todos have been modified successfully.',
            { oldTodos: [], newTodos: todos });
    }

    /** A picture a tool returned — what the Images pane lists. */
    image(describe, file, png) {
        const abs = this.abs(file);
        const id = toolId();
        const use = this._assistant({ type: 'tool_use', id, name: 'Read', input: { file_path: abs }, caller: { type: 'direct' } }, 'tool_use');
        this.wait(2);
        this._stamp({
            type: 'user',
            promptId: this.promptId,
            message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', is_error: false,
                content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }] }] },
            toolUseResult: { type: 'image', file: { base64: '', type: 'image/png', originalSize: png.length } },
            sourceToolAssistantUUID: use.uuid,
        });
        void describe;
        return this;
    }

    /** A pull request this session opened, which the rail shows beside its title. */
    pr(number, repo) {
        this.lines.push({ type: 'pr-link', sessionId: this.sessionId, prNumber: number,
            prUrl: `https://github.com/${repo}/pull/${number}`, prRepository: repo,
            timestamp: new Date(this.clock).toISOString() });
        return this;
    }

    abs(file) { return path.isAbsolute(file) ? file : path.join(this.cwd, file); }

    // -- output ----------------------------------------------------------

    /** The JSONL text. The title entry goes first, as the CLI writes it. */
    toJsonl() {
        const head = [{ type: 'ai-title', aiTitle: this.title, sessionId: this.sessionId }];
        return [...head, ...this.lines].map(l => JSON.stringify(l)).join('\n') + '\n';
    }

    /**
     * Write it under `projectsDir/<escaped cwd>/`, and stamp the file's mtime as
     * the moment of the last entry — which is what "last active" and the rail's
     * ordering read.
     */
    save(projectsDir, { endAt } = {}) {
        // Built from a clock that starts at zero and shifted so the last entry
        // lands where the caller wants — "twelve minutes ago" is then a number
        // given once, not arithmetic repeated through the script.
        if (endAt != null) {
            const shift = endAt - this.clock;
            for (const l of this.lines) l.timestamp = new Date(Date.parse(l.timestamp) + shift).toISOString();
            this.clock = endAt;
        }
        const dir = path.join(projectsDir, this.cwd.replace(/[/.]/g, '-'));
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${this.sessionId}.jsonl`);
        fs.writeFileSync(file, this.toJsonl());
        const t = new Date(this.clock);
        fs.utimesSync(file, t, t);
        return file;
    }
}

module.exports = { Conversation, numbered, patchFor };
