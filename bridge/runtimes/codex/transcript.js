'use strict';

// The Codex transcript reader: Codex's rollout files, turned into the same events
// the Claude reader produces, so `web/` draws a Codex conversation without knowing
// which CLI wrote it (docs/plans/23-codex.md, D1 and D2). The other side of the
// seam bridge/transcript.js describes; READER there lists what a reader promises.
//
// Codex writes one file per thread:
//
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl
//
// and every line is `{timestamp, type, payload}` (0.172.0 adds an `ordinal`).
// What this reads, and what it makes of it:
//
//   session_meta                 the row: id, cwd, CLI version, a fork's parent
//   turn_context                 where a turn begins, its model and its policy
//   response_item message        `user` / `assistant`, minus the harness's noise
//   response_item reasoning      `thinking`, when Codex wrote a summary
//   response_item function_call  `request_user_input` only — the blocking question
//   event_msg item_completed     every tool: commands, patches, plans, MCP calls…
//   event_msg turn_aborted       an `interrupted` system row
//   event_msg plan_update        the checklist, drawn as an `update_plan` row
//   compacted                    `compact`
//
// Decided, all of it measured on 0.172.0 against test/fixtures/codex/:
//
// - **Tools come from `item_completed`, never from `custom_tool_call`.** Codex runs
//   the model in code mode: one `exec` tool taking JavaScript, so a `response_item`
//   says what script ran, not what command. The item is the only record of the
//   command, its output and its exit code, and of a patch and its diff. The kinds
//   are in bridge/codex/items.js, which the live wire will share.
// - **Messages come from `response_item`.** The item stream has them too, but the
//   response items are what the model saw, images included. The one exception is
//   an `agentMessage` with `delivery: "async"` — a question the model asked without
//   waiting — which exists only as an item, so it is drawn from there.
// - **The harness's own messages are stripped.** Every turn opens with `developer`
//   messages (instructions, skills, the multi-agent role) and a user-role
//   `<environment_context>`. They are Codex's `<system-reminder>`. Recognised by
//   `content_item_kinds` where 0.172.0 writes it, and by the opening tag where not.
// - **A fork reads its parent first.** A forked thread's rollout opens with a
//   `session_meta` carrying `history_base {thread_id, end_ordinal_exclusive,
//   end_byte_offset}` and then holds only its own lines. `inherited` reads the
//   parent's lines up to that point. By ordinal where the lines carry one, because
//   the byte offset is only true of the file Codex wrote — a copy that was edited,
//   as the fixtures are, has moved its bytes and kept its ordinals.
// - **`.jsonl.zst` is read when Node can.** `zlib.zstdDecompressSync` is Node
//   22.15+. Older Node reads a compressed rollout as nothing, rather than throwing.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { parseLines } = require('../../jsonl');
const { projectRootOf, worktreeNameOf, branchOf } = require('../../places');
const items = require('../../codex/items');

// The rollout's file name: `rollout-<timestamp>-<uuid>.jsonl[.zst]`.
const ROLLOUT_RE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i;

// Tags that open a user-role message the harness wrote rather than a person.
const NOISE_TAGS = ['<environment_context>', '<user_instructions>', '<permissions instructions>',
    '<collaboration_mode>', '<turn_aborted>', '<user_shell_command>', '# AGENTS.md instructions'];

// Codex's approval policy and sandbox, read back as our six mode names (the
// inverse of D5's table). Approximate on purpose: only the mode chip reads it.
function modeOf(ctx) {
    if (!ctx) return null;
    const collab = ctx.collaboration_mode && ctx.collaboration_mode.mode;
    if (collab === 'plan') return 'plan';
    const policy = ctx.approval_policy;
    const sandbox = (ctx.sandbox_policy && ctx.sandbox_policy.type) || ctx.sandbox_mode || null;
    if (policy === 'never') return sandbox === 'danger-full-access' ? 'bypassPermissions' : 'dontAsk';
    if (policy === 'untrusted') return 'manual';
    if (ctx.approvals_reviewer === 'auto_review') return 'auto';
    if (policy === 'on-request' || policy === 'on-failure') {
        return sandbox === 'read-only' ? 'manual' : 'acceptEdits';
    }
    return null;
}

/** The thread id a rollout's name carries, or null. */
function idFromName(file) {
    const m = ROLLOUT_RE.exec(path.basename(file));
    return m ? m[1].toLowerCase() : null;
}

/** Whether Node can read a `.zst` rollout here. */
const CAN_ZSTD = typeof zlib.zstdDecompressSync === 'function';

/** A rollout's bytes, decompressed if it is a `.zst`. Null if unreadable. */
function readFile(file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { return null; }
    if (!file.endsWith('.zst')) return buf;
    if (!CAN_ZSTD) return null;
    try { return zlib.zstdDecompressSync(buf); } catch { return null; }
}

function safeParse(line) {
    try { return JSON.parse(line); } catch { return null; }
}

function firstLine(s, max) {
    const line = String(s || '').split('\n').find(l => l.trim()) || '';
    const t = line.trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Was this user-role `response_item` written by the harness rather than a person? */
function isHarness(payload) {
    const meta = payload.internal_chat_message_metadata_passthrough;
    const kinds = meta && Array.isArray(meta.content_item_kinds) ? meta.content_item_kinds : null;
    if (kinds && kinds.length) return !kinds.some(k => typeof k === 'string' && k.startsWith('user.'));
    return false;
}

/** The parts of a user message a person wrote: `{text, images}`. */
function userParts(payload) {
    const texts = [];
    const images = [];
    for (const b of payload.content || []) {
        if (!b) continue;
        if (b.type === 'input_text' && typeof b.text === 'string') {
            const t = b.text.trimStart();
            if (NOISE_TAGS.some(tag => t.startsWith(tag))) continue;
            texts.push(b.text);
        } else if (b.type === 'input_image') {
            const url = typeof b.image_url === 'string' ? b.image_url : null;
            const m = url && /^data:([^;,]+)[;,]/.exec(url);
            images.push({ mediaType: m ? m[1] : 'image/png', dataUri: url && url.startsWith('data:') ? url : null });
        }
    }
    return { text: texts.join('\n\n'), images };
}

// A plan turn's last message repeats the plan inside this tag. The `plan` item is
// the record of it and is drawn as its own row, so the copy comes out of the text.
const PROPOSED_PLAN_RE = /<proposed_plan>[\s\S]*?<\/proposed_plan>/g;

/** The text of an assistant `response_item`, without a repeated plan. */
function assistantText(payload) {
    return (payload.content || [])
        .map(b => (b && (b.type === 'output_text' || b.type === 'text') ? b.text || '' : ''))
        .join('')
        .replace(PROPOSED_PLAN_RE, '')
        .trim();
}

/** The reasoning summary Codex chose to write, joined. Empty when it wrote none. */
function reasoningText(payload) {
    return (payload.summary || [])
        .map(b => (b && typeof b.text === 'string' ? b.text : ''))
        .filter(Boolean)
        .join('\n\n');
}

/** A real person's message, by the rules above: `{text, images}` or null. */
function personMessage(payload) {
    if (!payload || payload.type !== 'message' || payload.role !== 'user') return null;
    if (isHarness(payload)) return null;
    const parts = userParts(payload);
    if (!parts.text.trim() && !parts.images.length) return null;
    return parts;
}

// ---------------------------------------------------------------------------
// Metadata scan (drives the session list)
// ---------------------------------------------------------------------------

// The lines the scan has to parse. Rollouts are written compact, so these are
// exact substrings; everything else — the large tool outputs, the encrypted
// reasoning, the token counts — is counted past without a parse.
const SCAN_NEEDLES = ['"type":"session_meta"', '"type":"turn_context"', '"role":"user"',
    '"role":"assistant"', '"type":"item_completed"'];

/**
 * List-level metadata for one rollout, in the shape the Claude reader's
 * `scanMeta` returns, plus `runtime: "codex"`.
 *
 * The title is the first prompt here. Codex keeps a thread's name in
 * `session_index.jsonl`, beside `sessions/`, not in the rollout, so
 * bridge/sessions.js lays that over this.
 */
function scanMeta(file) {
    const buf = readFile(file);
    if (!buf) return null;
    const text = buf.toString('utf8');

    const meta = {
        runtime: 'codex',
        sessionId: idFromName(file),
        cwd: null,
        gitBranch: null,
        version: null,
        sessionKind: null,
        title: null,
        titleSource: null,
        firstPrompt: null,
        lastPrompt: null,
        model: null,
        permissionMode: null,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        peerMessages: 0,
        lastPeerTs: null,
        lastPeerFrom: null,
        handoffs: 0,
        lastHandoffTs: null,
        lastHandoffFrom: null,
        firstTs: null,
        lastTs: null,
        lastUserTs: null,
        worktree: null,
        inWorktree: false,
        worktreeStateTs: null,
        prs: [],
        suggestions: [],
        // Codex's own: which client started the thread (`codex_exec` from a
        // terminal, `clientInfo.name` from an app-server) and the thread it was
        // forked from, if any.
        originator: null,
        forkedFrom: null,
        bytes: text.length,
    };

    let sawMeta = false;
    for (const line of text.split('\n')) {
        if (!line) continue;
        if (!SCAN_NEEDLES.some(n => line.includes(n))) continue;
        const o = safeParse(line);
        if (!o || !o.payload) continue;
        const p = o.payload;
        const ts = typeof o.timestamp === 'string' ? o.timestamp : null;

        if (o.type === 'session_meta') {
            // A fork's file opens with its own; the parent's lines are not in it.
            // The first one is the thread's.
            if (sawMeta) continue;
            sawMeta = true;
            if (p.id) meta.sessionId = String(p.id).toLowerCase();
            if (typeof p.cwd === 'string') meta.cwd = p.cwd;
            meta.version = p.cli_version || null;
            meta.sessionKind = p.source || null;
            meta.originator = p.originator || null;
            meta.forkedFrom = p.forked_from_id || null;
            if (p.git && typeof p.git.branch === 'string') meta.gitBranch = p.git.branch;
            if (!meta.firstTs) meta.firstTs = p.timestamp || ts;
            continue;
        }
        if (o.type === 'turn_context') {
            if (p.model) meta.model = p.model;
            const mode = modeOf(p);
            if (mode) meta.permissionMode = mode;
            continue;
        }
        if (o.type === 'response_item' && p.type === 'message') {
            if (ts) { if (!meta.firstTs) meta.firstTs = ts; meta.lastTs = ts; }
            if (p.role === 'assistant') { meta.assistantMessages++; continue; }
            const person = personMessage(p);
            if (!person) continue;
            meta.userMessages++;
            if (ts) meta.lastUserTs = ts;
            const said = person.text.slice(0, 400);
            if (!meta.firstPrompt) meta.firstPrompt = said;
            meta.lastPrompt = said;
            continue;
        }
        if (o.type === 'event_msg' && p.type === 'item_completed') {
            if (ts) meta.lastTs = ts;
            const item = items.fromRollout(p.item);
            if (item && items.toolEvent(item)) meta.toolCalls++;
        }
    }

    if (meta.firstPrompt) {
        meta.title = firstLine(meta.firstPrompt, 80);
        meta.titleSource = 'prompt';
    } else {
        meta.title = 'Untitled session';
        meta.titleSource = 'none';
    }

    // Which project, and whether it is a worktree of one: the same convention the
    // Claude reader applies, from the one directory Codex records. Codex has no
    // worktree-state entry and no per-line cwd, so this is all there is.
    meta.projectCwd = meta.cwd ? projectRootOf(meta.cwd) : null;
    if (meta.cwd && meta.projectCwd !== meta.cwd) {
        meta.worktree = {
            name: worktreeNameOf(meta.cwd),
            branch: meta.gitBranch || branchOf(meta.cwd) || null,
            path: meta.cwd,
            originalCwd: meta.projectCwd,
        };
        meta.inWorktree = true;
    }
    return meta;
}

// ---------------------------------------------------------------------------
// Forks
// ---------------------------------------------------------------------------

/** How deep a chain of forks is followed before giving up. */
const FORK_DEPTH = 16;

/**
 * The lines a forked thread inherits from its parent, in order, oldest first —
 * or `[]` for a thread that is not a fork, or whose parent cannot be found.
 *
 * `entries` are this thread's own parsed lines (its first is the `session_meta`
 * that names the parent). `locate(threadId)` returns the parent's rollout path;
 * bridge/sessions.js answers it from the index. A parent that is itself a fork
 * is read the same way, so a chain comes back whole.
 */
function inherited(entries, { locate } = {}, depth = 0) {
    const head = (entries || []).find(e => e && e.type === 'session_meta');
    const base = head && head.payload && head.payload.history_base;
    if (!base || !base.thread_id || typeof locate !== 'function' || depth >= FORK_DEPTH) return [];
    const file = locate(String(base.thread_id).toLowerCase());
    if (!file) return [];
    const buf = readFile(file);
    if (!buf) return [];

    const all = parseLines(buf).entries;
    const end = Number(base.end_ordinal_exclusive);
    let mine;
    if (Number.isFinite(end) && all.some(e => typeof e.ordinal === 'number')) {
        mine = all.filter(e => typeof e.ordinal !== 'number' || e.ordinal < end);
    } else {
        const off = Number(base.end_byte_offset);
        mine = Number.isFinite(off) ? parseLines(buf.subarray(0, off)).entries : all;
    }
    return [...inherited(mine, { locate }, depth + 1), ...mine];
}

// ---------------------------------------------------------------------------
// Full transcript parse (drives the conversation view)
// ---------------------------------------------------------------------------

/** `pending | in_progress | completed`, whichever spelling Codex used. */
function stepStatus(s) {
    if (s === 'inProgress' || s === 'in_progress') return 'in_progress';
    if (s === 'completed') return 'completed';
    return 'pending';
}

/** `request_user_input`'s answer, keyed by question text as AskUserQuestion's is. */
function answersOf(output, questions) {
    let o = output;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }
    const by = o && o.answers;
    if (!by || typeof by !== 'object') return null;
    const out = {};
    for (const q of questions) {
        const a = q.id && by[q.id];
        if (a && Array.isArray(a.answers)) out[q.question] = a.answers.join(', ');
    }
    return out;
}

/**
 * Turn rollout lines into render events, in the kinds and shapes the Claude
 * reader emits (docs/api.md, *Event kinds*). See the header for what each line
 * becomes. Unknown line types and unknown item kinds are skipped or drawn as a
 * generic tool row; nothing here throws on a shape it has not seen.
 *
 * Every tool row arrives complete: Codex writes an item once it is done, so on
 * disk there is no call without its result and no `tool-result` patch — except
 * for the one question tool, whose answer is a separate line and can land in a
 * later read.
 */
function buildEvents(entries, ctx = {}) {
    const events = [];
    const asks = new Map();
    let model = ctx.model || null;
    // Which turn the lines belong to, so an event can say. Used for ids only.
    let turnId = null;

    for (const e of entries || []) {
        if (!e || typeof e !== 'object') continue;
        const p = e.payload || {};
        const ts = typeof e.timestamp === 'string' ? e.timestamp : null;

        if (e.type === 'turn_context') {
            if (p.model) model = p.model;
            turnId = p.turn_id || turnId;
            continue;
        }

        if (e.type === 'compacted') {
            events.push({
                id: `compact:${e.ordinal != null ? e.ordinal : ts}`, kind: 'compact', ts,
                text: (typeof p.message === 'string' && p.message.trim()) || 'Conversation compacted',
            });
            continue;
        }

        if (e.type === 'response_item') {
            if (p.type === 'message' && p.role === 'user') {
                const person = personMessage(p);
                if (!person) continue;
                events.push({
                    id: p.id || `user:${e.ordinal != null ? e.ordinal : ts}`, kind: 'user', ts,
                    text: person.text, images: person.images, files: [], command: null,
                    origin: 'human',
                    // A Codex turn cannot be branched from yet (`branchFromTurn` is
                    // false), so there is no chain entry to name.
                    parent: null,
                });
                continue;
            }
            if (p.type === 'message' && p.role === 'assistant') {
                const text = assistantText(p);
                if (!text.trim()) continue;
                events.push({
                    id: `${p.id || `assistant:${e.ordinal}`}:text`, kind: 'assistant', ts,
                    text, model,
                });
                continue;
            }
            if (p.type === 'reasoning') {
                const text = reasoningText(p);
                if (!text) continue;
                events.push({ id: `${p.id || `reasoning:${e.ordinal}`}:think`, kind: 'thinking', ts, text });
                continue;
            }
            // The blocking question. Its arguments are AskUserQuestion's shape, so it
            // is drawn as one: header, question, options with labels.
            if (p.type === 'function_call' && p.name === 'request_user_input') {
                let args = p.arguments;
                if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
                const questions = (args && Array.isArray(args.questions) ? args.questions : []).map(q => ({
                    id: q.id || null, header: q.header || null, question: q.question || '',
                    options: (q.options || []).map(o => ({ label: o.label || String(o), description: o.description || null })),
                    multiSelect: false,
                }));
                const ev = {
                    id: p.call_id || p.id, kind: 'tool', ts, name: 'request_user_input',
                    input: { questions }, status: 'pending', result: null, agent: null,
                };
                asks.set(ev.id, ev);
                events.push(ev);
                continue;
            }
            if (p.type === 'function_call_output' && p.call_id) {
                const ask = asks.get(p.call_id);
                const call = ask || (ctx.pendingAsks && ctx.pendingAsks.get(p.call_id));
                if (!call) continue;
                const answers = answersOf(p.output, call.input.questions);
                const result = { text: answers ? Object.values(answers).join('\n') : String(p.output || ''), answers };
                if (ask) {
                    Object.assign(ask, { status: 'ok', result, resultTs: ts });
                    if (ask.ts && ts) ask.durationMs = Date.parse(ts) - Date.parse(ask.ts);
                } else {
                    events.push({ id: `${p.call_id}:result`, kind: 'tool-result', toolId: p.call_id, ts,
                        status: 'ok', result, resultTs: ts });
                }
                continue;
            }
            // custom_tool_call `exec` and its output are the code-mode script the
            // items below came out of; additional_tools and configuration_update
            // are the harness's. None of them is drawn.
            continue;
        }

        if (e.type !== 'event_msg') continue;

        if (p.type === 'item_completed') {
            const item = items.fromRollout(p.item);
            if (!item) continue;
            // A question asked without waiting exists only as an item.
            if (item.type === 'agentMessage' && item.delivery === 'async' && item.text) {
                events.push({ id: `${item.id}:text`, kind: 'assistant', ts, text: item.text, model });
                continue;
            }
            const t = items.toolEvent(item);
            if (!t) continue;
            const started = typeof p.started_at_ms === 'number' ? p.started_at_ms : null;
            const done = typeof p.completed_at_ms === 'number' ? p.completed_at_ms : null;
            events.push({
                id: item.id || `item:${e.ordinal}`, kind: 'tool',
                ts: started ? new Date(started).toISOString() : ts,
                name: t.name, input: t.input, status: t.status, result: t.result, agent: null,
                durationMs: item.durationMs != null ? item.durationMs
                    : (started != null && done != null ? done - started : null),
                resultTs: done ? new Date(done).toISOString() : ts,
            });
            continue;
        }

        if (p.type === 'turn_aborted') {
            events.push({
                id: `aborted:${p.turn_id || turnId || e.ordinal}`, kind: 'system', ts,
                subtype: 'interrupted', isError: false,
                text: p.reason === 'interrupted' ? 'Interrupted.' : `Turn ended: ${p.reason || 'aborted'}.`,
            });
            continue;
        }

        if (p.type === 'error' && typeof p.message === 'string') {
            events.push({ id: `error:${e.ordinal != null ? e.ordinal : ts}`, kind: 'system', ts,
                subtype: 'error', isError: true, text: p.message });
            continue;
        }

        if (p.type === 'plan_update') {
            events.push({
                id: `plan:${e.ordinal != null ? e.ordinal : ts}`, kind: 'tool', ts,
                name: 'update_plan',
                input: {
                    explanation: p.explanation || null,
                    plan: (p.plan || []).map(s => ({ step: s.step || '', status: stepStatus(s.status) })),
                },
                status: 'ok', result: { text: '' }, agent: null,
            });
        }
    }

    return { events, model };
}

/** Where a turn starts in a rollout: is this line a `turn_context`? */
function isTurnStart(entry) {
    return !!entry && entry.type === 'turn_context';
}

module.exports = {
    readFile, parseLines, scanMeta, buildEvents, inherited, isTurnStart, personMessage,
    idFromName, modeOf, ROLLOUT_RE, CAN_ZSTD,
};
