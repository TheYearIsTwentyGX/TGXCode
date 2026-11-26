'use strict';

// Codex's thread items, as the events `web/` already draws.
//
// Codex describes everything a turn does as a v2 `ThreadItem`: a user message, an
// agent message, a command it ran, a patch it applied, a plan. The same item
// reaches us two ways, and this module is the one table both of them go through
// (docs/plans/23-codex.md, D2):
//
//   on disk   an `event_msg` `item_completed` line in the rollout file, which is
//             what bridge/runtimes/codex/transcript.js reads. The type is
//             PascalCase (`CommandExecution`) and the fields are snake_case
//             (`aggregated_output`, `exit_code`, `parsed_cmd`), with a `cwd`
//             written as a `file://` URL, `command` as an argv array, a duration
//             as `{secs, nanos}` and a file change's `changes` as an object keyed
//             by path.
//   on the wire  `item/started` and `item/completed` from `codex app-server`,
//             which the Phase 3 process adapter will read. camelCase type and
//             fields, a plain `cwd`, `command` as one shell-quoted string,
//             `durationMs`, and `changes` as an array of `{path, kind, diff}`.
//
// So there are two steps. `fromRollout` turns the disk form into the wire form,
// and everything after it — `KINDS`, `toolEvent` — reads the wire form only. That
// keeps one table of kinds, and the disk's quirks in one function at the front.
// Measured on 0.172.0: every difference listed above is real, and none of them is
// only a case change, which is why `fromRollout` is per kind and not a key mapper.
//
// **Which items become what.** Messages and reasoning are the rollout reader's to
// take from the `response_item` lines (they carry the images and the raw text the
// model saw), so their entries here say `role` and nothing more. Everything else is
// a `tool` event, named for the tool Codex itself calls it — `exec_command`,
// `apply_patch`, `web_search` — because those are the names the model uses and the
// ones somebody reading a rollout will recognise. An item kind this build does not
// know becomes a generic tool row named after its kind, never an exception: the
// plan's policy is to tolerate what we do not know.

const { fileURLToPath } = require('url');

/** The tool event names this module produces, for the runtime's tool tables. */
const TOOL = Object.freeze({
    command: 'exec_command',
    patch: 'apply_patch',
    plan: 'plan',
    mcp: 'mcp_tool_call',
    dynamic: 'dynamic_tool_call',
    webSearch: 'web_search',
    imageView: 'view_image',
    imageGeneration: 'image_generation',
    sleep: 'sleep',
    agent: 'spawn_agent',
});

// ---------------------------------------------------------------------------
// The disk form, translated to the wire form
// ---------------------------------------------------------------------------

/** `CommandExecution` → `commandExecution`; `unified_exec_startup` → `unifiedExecStartup`. */
function camel(s) {
    if (typeof s !== 'string' || !s) return s;
    const t = s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    return t[0].toLowerCase() + t.slice(1);
}

/** Every top-level key of `o` in camelCase, values untouched. */
function camelKeys(o) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) out[camel(k)] = v;
    return out;
}

/** A `file://` URL as a path; anything else as it was. */
function pathOf(u) {
    if (typeof u !== 'string' || !u.startsWith('file://')) return u == null ? null : u;
    try { return fileURLToPath(u); } catch { return u; }
}

/** `{secs, nanos}` as whole milliseconds, or null. */
function durationMs(d) {
    if (!d || typeof d !== 'object') return typeof d === 'number' ? d : null;
    const ms = (Number(d.secs) || 0) * 1000 + (Number(d.nanos) || 0) / 1e6;
    return Math.round(ms);
}

/** One argv word quoted the way a POSIX shell reads it back. */
function shellQuote(w) {
    const s = String(w);
    return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Text out of a message's `content` blocks, joined. */
function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('');
}

/** Disk → wire, per kind. A kind with no entry gets `camelKeys`. */
const FROM_DISK = {
    UserMessage: (i) => ({ type: 'userMessage', id: i.id, clientId: i.client_id || null,
        content: i.content || [] }),
    AgentMessage: (i) => ({ type: 'agentMessage', id: i.id, text: textOf(i.content),
        phase: i.phase || null, delivery: i.delivery || null, questions: i.questions || null }),
    Reasoning: (i) => ({ type: 'reasoning', id: i.id,
        summary: i.summary_text || [], content: i.raw_content || [] }),
    Plan: (i) => ({ type: 'plan', id: i.id, text: i.text || '' }),
    CommandExecution: (i) => ({
        type: 'commandExecution',
        id: i.id,
        command: Array.isArray(i.command) ? i.command.map(shellQuote).join(' ') : (i.command || ''),
        cwd: pathOf(i.cwd),
        processId: i.process_id == null ? null : String(i.process_id),
        source: camel(i.source) || null,
        status: camel(i.status) || null,
        commandActions: (i.parsed_cmd || []).map(a => ({
            type: a.type, command: a.cmd, name: a.name, path: a.path,
        })),
        aggregatedOutput: i.aggregated_output == null ? null : i.aggregated_output,
        exitCode: i.exit_code == null ? null : i.exit_code,
        durationMs: durationMs(i.duration),
    }),
    FileChange: (i) => ({
        type: 'fileChange',
        id: i.id,
        changes: Array.isArray(i.changes) ? i.changes : Object.entries(i.changes || {}).map(
            ([p, c]) => ({
                path: p,
                kind: { type: (c && c.type) || 'update', move_path: (c && c.move_path) || null },
                diff: (c && (c.unified_diff || c.diff)) || '',
            })),
        status: camel(i.status) || null,
        // Not on the wire, only on disk: what `apply_patch` printed. Kept because a
        // failed patch says why here and nowhere else.
        stdout: i.stdout || null,
        stderr: i.stderr || null,
    }),
    // A tool Codex runs inside itself, keyed `kind` rather than `type`. The one
    // seen on 0.172.0 is `clock.sleep`, which is the wire's `sleep` item.
    Extension: (i) => (i.kind === 'clock.sleep'
        ? { type: 'sleep', id: i.id, durationMs: i.durationMs == null ? null : i.durationMs }
        : { ...camelKeys(i), type: 'extension', extension: i.kind || null }),
};

/**
 * A rollout `item_completed` item in the shape `item/completed` carries on the
 * wire. Null for anything that is not an item.
 */
function fromRollout(item) {
    if (!item || typeof item !== 'object' || typeof item.type !== 'string') return null;
    const f = FROM_DISK[item.type];
    if (f) return f(item);
    return { ...camelKeys(item), type: camel(item.type) };
}

// ---------------------------------------------------------------------------
// The table of kinds (wire form)
// ---------------------------------------------------------------------------

/**
 * A tool event's `status` from an item's. `ok` and `error` are the only two a
 * finished row can have; an item still in progress is `pending`. A command that
 * ran and exited non-zero is an error, as a failing `Bash` is for Claude.
 */
function statusOf(item) {
    const s = item.status;
    if (s === 'inProgress' || s === 'pending') return 'pending';
    if (s === 'failed' || s === 'declined' || s === 'interrupted' || s === 'error') return 'error';
    if (item.exitCode != null && item.exitCode !== 0) return 'error';
    if (item.success === false || item.error) return 'error';
    return 'ok';
}

/**
 * One POSIX shell word read back to the string it stands for — quotes and
 * escapes undone, adjacent pieces joined — or null if `s` is more than one word.
 * Codex quotes an embedded `'` as `'"'"'` on the wire; this file's own
 * `shellQuote` writes `'\''`; both read back the same.
 */
function unshellWord(s) {
    let out = '';
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === "'") {
            const end = s.indexOf("'", i + 1);
            if (end === -1) return null;
            out += s.slice(i + 1, end);
            i = end + 1;
        } else if (c === '"') {
            i++;
            while (i < s.length && s[i] !== '"') {
                if (s[i] === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) i++;
                out += s[i++];
            }
            if (i >= s.length) return null;
            i++;
        } else if (c === '\\') {
            if (i + 1 < s.length) out += s[i + 1];
            i += 2;
        } else if (/\s/.test(c)) {
            return null;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

/** `/bin/bash -lc 'script'` → `script`, the part somebody would have typed. */
function scriptOf(command) {
    const s = String(command || '');
    const m = /^\S*(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/.exec(s);
    if (!m) return s;
    const arg = m[1].trim();
    const word = unshellWord(arg);
    return word === null ? arg : word;
}

/** Added and removed lines in a unified diff, headers excluded. */
function countDiff(diff) {
    let added = 0;
    let deleted = 0;
    for (const line of String(diff || '').split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line[0] === '+') added++;
        else if (line[0] === '-') deleted++;
    }
    return { added, deleted };
}

const KINDS = {
    userMessage: { role: 'user' },
    agentMessage: { role: 'assistant' },
    reasoning: { role: 'thinking' },
    // The hook prompt and a function call's output are records of things the
    // reader draws from elsewhere, or not at all.
    hookPrompt: { role: null },
    functionCallOutput: { role: null },
    contextCompaction: { role: 'compact' },

    commandExecution: {
        tool: () => TOOL.command,
        input: (i) => ({
            command: scriptOf(i.command),
            cwd: i.cwd || null,
            actions: (i.commandActions || []).map(a => ({
                type: a.type || 'unknown', command: a.command || null,
                name: a.name || null, path: a.path || null,
            })),
        }),
        result: (i) => {
            if (i.status === 'inProgress') return null;
            const declined = i.status === 'declined';
            return {
                text: declined ? 'Declined' : (i.aggregatedOutput || ''),
                exitCode: i.exitCode == null ? null : i.exitCode,
                interrupted: i.status === 'interrupted' || (i.status === 'failed' && i.exitCode === -1),
            };
        },
    },
    fileChange: {
        tool: () => TOOL.patch,
        input: (i) => ({
            changes: (i.changes || []).map(c => {
                const kind = c.kind && typeof c.kind === 'object' ? c.kind : { type: c.kind };
                return {
                    path: c.path,
                    kind: kind.type || 'update',
                    movePath: kind.move_path || kind.movePath || null,
                    diff: c.diff || '',
                };
            }),
        }),
        result: (i) => {
            if (i.status === 'inProgress') return null;
            const declined = i.status === 'declined';
            return {
                text: declined ? 'Declined' : [i.stdout, i.stderr].filter(Boolean).join('\n'),
            };
        },
    },
    plan: {
        tool: () => TOOL.plan,
        input: (i) => ({ plan: i.text || '' }),
        result: () => ({ text: '' }),
    },
    mcpToolCall: {
        tool: () => TOOL.mcp,
        input: (i) => ({ server: i.server || null, tool: i.tool || null,
            arguments: i.arguments == null ? null : i.arguments }),
        result: (i) => (i.status === 'inProgress' ? null : {
            text: i.error ? String(i.error.message || i.error) : contentText(i.result),
        }),
    },
    dynamicToolCall: {
        tool: () => TOOL.dynamic,
        input: (i) => ({ namespace: i.namespace || null, tool: i.tool || null,
            arguments: i.arguments == null ? null : i.arguments }),
        result: (i) => (i.status === 'inProgress' ? null : { text: contentText(i.contentItems) }),
    },
    webSearch: {
        tool: () => TOOL.webSearch,
        input: (i) => ({ query: i.query || '' }),
        result: (i) => ({ text: Array.isArray(i.results)
            ? i.results.map(r => [r.title, r.url].filter(Boolean).join(' — ')).join('\n') : '' }),
    },
    imageView: {
        tool: () => TOOL.imageView,
        input: (i) => ({ path: i.path || '' }),
        result: () => ({ text: '' }),
    },
    imageGeneration: {
        tool: () => TOOL.imageGeneration,
        input: (i) => ({ prompt: i.revisedPrompt || '' }),
        result: (i) => ({ text: i.failure ? String(i.failure) : (i.savedPath || '') }),
    },
    sleep: {
        tool: () => TOOL.sleep,
        input: (i) => ({ durationMs: i.durationMs == null ? null : i.durationMs }),
        result: () => ({ text: '' }),
    },
    collabAgentToolCall: {
        tool: () => TOOL.agent,
        input: (i) => ({ tool: i.tool || null, prompt: i.prompt || '', model: i.model || null }),
        result: (i) => (i.status === 'inProgress' ? null : { text: '' }),
    },
};

/** Text out of an MCP result or a dynamic tool's content items. */
function contentText(r) {
    if (r == null) return '';
    if (typeof r === 'string') return r;
    const items = Array.isArray(r) ? r : Array.isArray(r.content) ? r.content : null;
    if (items) return items.map(c => (c && (c.text || (c.type === 'image' ? '[image]' : ''))) || '').join('\n');
    try { return JSON.stringify(r); } catch { return ''; }
}

/** What an item is to the reader: `{role}` for a message kind, or null for a tool. */
function roleOf(item) {
    const k = item && KINDS[item.type];
    return k && 'role' in k ? k.role : undefined;
}

/**
 * A wire-form item as a `tool` event's fields — `{name, input, status, result}` —
 * or null for a kind that is not a tool (a message, reasoning, a compaction).
 * An unknown kind is a generic row named after it, with the item as its input.
 */
function toolEvent(item) {
    if (!item || typeof item.type !== 'string') return null;
    const k = KINDS[item.type];
    if (k && 'role' in k) return null;
    if (!k) {
        const { type, id, ...rest } = item;
        return { name: type, input: rest, status: statusOf(item), result: { text: '' } };
    }
    return { name: k.tool(item), input: k.input(item), status: statusOf(item), result: k.result(item) };
}

module.exports = {
    TOOL, KINDS, fromRollout, toolEvent, roleOf, statusOf, scriptOf, countDiff, textOf, camel,
};
