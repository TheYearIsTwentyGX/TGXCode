'use strict';

// Reads Claude Code's on-disk transcripts and turns them into something a
// conversation view can render.
//
// Layout of a project directory (~/.claude/projects/<escaped-cwd>/):
//
//   <session-id>.jsonl                     the transcript, one JSON object per line
//   <session-id>/tool-results/<id>.txt     tool output too large to inline
//   <session-id>/subagents/agent-<id>.jsonl        a subagent's own transcript
//   <session-id>/subagents/agent-<id>.meta.json    {agentType, description, toolUseId}
//
// The transcript interleaves conversation entries (`user`, `assistant`) with
// bookkeeping entries (`ai-title`, `mode`, `file-history-snapshot`, …). Only the
// former reach the UI; the latter feed session metadata.

const fs = require('fs');
const path = require('path');

// Entries that carry conversation content. Everything else is bookkeeping.
const CONTENT_TYPES = new Set(['user', 'assistant', 'system']);

// Bookkeeping entries we mine for session metadata, cheapest signal last.
const TITLE_TYPES = ['custom-title', 'agent-name', 'ai-title'];

// ---------------------------------------------------------------------------
// Line reading
// ---------------------------------------------------------------------------

/**
 * Split a JSONL buffer into parsed objects, tolerating a truncated final line —
 * we routinely read files that Claude is still appending to.
 * Returns {entries, consumed} where `consumed` is the byte length fully parsed,
 * so a tailing caller can resume from exactly there.
 */
function parseLines(buf) {
    const entries = [];
    let consumed = 0;
    let start = 0;
    while (true) {
        const nl = buf.indexOf(0x0a, start);
        if (nl === -1) break;
        const slice = buf.subarray(start, nl);
        start = nl + 1;
        consumed = start;
        if (!slice.length) continue;
        try {
            entries.push(JSON.parse(slice.toString('utf8')));
        } catch {
            // A partially-flushed line; skip it. If it was genuinely the tail we
            // will re-read it next tick because `consumed` only advances past
            // complete lines that ended in a newline.
        }
    }
    return { entries, consumed };
}

// ---------------------------------------------------------------------------
// Metadata scan (drives the session list)
// ---------------------------------------------------------------------------

/**
 * Extract list-level metadata from a transcript. Uses cheap substring tests to
 * avoid JSON.parse on the large `assistant`/`user` lines — with 700+ files and
 * 300MB of transcripts, parsing everything to count messages is the slow path.
 */
function scanMeta(filePath) {
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }

    const meta = {
        sessionId: path.basename(filePath, '.jsonl'),
        cwd: null,
        gitBranch: null,
        version: null,
        sessionKind: null,
        title: null,
        titleSource: null,
        firstPrompt: null,
        lastPrompt: null,
        model: null,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        firstTs: null,
        lastTs: null,
        lastUserTs: null,
        worktree: null,
        pr: null,
        bytes: text.length,
    };

    const titles = {};

    for (const line of text.split('\n')) {
        if (!line) continue;

        // Cheap classification first. Conversation lines are the big ones and we
        // only need counts and timestamps from them.
        const isUser = line.includes('"type":"user"');
        const isAssistant = !isUser && line.includes('"type":"assistant"');

        if (isUser || isAssistant) {
            // Sidechain traffic lives in separate files, but guard anyway.
            if (line.includes('"isSidechain":true')) continue;

            const ts = matchField(line, 'timestamp');
            if (ts) {
                if (!meta.firstTs) meta.firstTs = ts;
                meta.lastTs = ts;
            }
            if (!meta.cwd) meta.cwd = matchField(line, 'cwd');
            if (!meta.gitBranch) meta.gitBranch = matchField(line, 'gitBranch');
            if (!meta.version) meta.version = matchField(line, 'version');
            if (!meta.sessionKind) meta.sessionKind = matchField(line, 'sessionKind');

            if (isUser) {
                // A tool_result is mechanically a user message; don't count it as one.
                if (line.includes('"type":"tool_result"')) continue;
                if (line.includes('"isMeta":true')) continue;
                // Nor is a background task reporting in. Counting it would both
                // inflate the turn count and, because lastUserTs is what the
                // session list sorts on, let a finishing agent reorder the rail.
                // Worth a real parse rather than a substring test: the tag can
                // legitimately appear inside a message somebody quoted it into,
                // and these lines are rare enough that the cost never shows.
                if (line.includes(NOTIFICATION_TAG)) {
                    const parsed = safeParse(line);
                    if (parsed && isTaskNotification(userText(parsed))) continue;
                }
                meta.userMessages++;
                // When *you* last spoke. The session list sorts on this rather
                // than on file activity, so rows don't reshuffle every time an
                // agent writes a line.
                if (ts) meta.lastUserTs = ts;
                if (!meta.firstPrompt) {
                    const parsed = safeParse(line);
                    const t = parsed ? userText(parsed) : null;
                    if (t) meta.firstPrompt = t.slice(0, 400);
                }
            } else {
                meta.assistantMessages++;
                if (line.includes('"type":"tool_use"')) meta.toolCalls++;
                const m = matchField(line, 'model');
                if (m) meta.model = m;
            }
            continue;
        }

        // Small bookkeeping lines: parse them, they're cheap.
        if (line.includes('-title"') || line.includes('"type":"agent-name"')
            || line.includes('"type":"last-prompt"') || line.includes('"type":"worktree-state"')
            || line.includes('"type":"pr-link"')) {
            const o = safeParse(line);
            if (!o) continue;
            switch (o.type) {
                case 'custom-title': titles['custom-title'] = o.customTitle; break;
                case 'ai-title': titles['ai-title'] = o.aiTitle; break;
                case 'agent-name': titles['agent-name'] = o.agentName; break;
                case 'last-prompt': meta.lastPrompt = (o.lastPrompt || '').slice(0, 400); break;
                case 'worktree-state':
                    if (o.worktreeSession) {
                        meta.worktree = {
                            name: o.worktreeSession.worktreeName,
                            branch: o.worktreeSession.worktreeBranch,
                            path: o.worktreeSession.worktreePath,
                            originalCwd: o.worktreeSession.originalCwd,
                        };
                    }
                    break;
                case 'pr-link':
                    meta.pr = { number: o.prNumber, url: o.prUrl, repo: o.prRepository };
                    break;
            }
        }
    }

    // cwd changes mid-session when the agent enters a worktree, and the directory
    // it is in *now* is the one worth reporting. The loop above kept the first
    // one; take the last instead. lastIndexOf scans natively, so this costs far
    // less than parsing every line for a field we only need once.
    const currentCwd = tailField(text, 'cwd');
    if (currentCwd) meta.cwd = currentCwd;

    for (const t of TITLE_TYPES) {
        if (titles[t]) { meta.title = titles[t]; meta.titleSource = t; break; }
    }
    if (!meta.title && meta.firstPrompt) {
        meta.title = firstLine(meta.firstPrompt, 80);
        meta.titleSource = 'prompt';
    }
    if (!meta.title) { meta.title = 'Untitled session'; meta.titleSource = 'none'; }

    // A worktree session records the worktree as its cwd, but it belongs to the
    // checkout that owns it — otherwise every worktree becomes its own project
    // in the list. Prefer the recorded worktree state; fall back to the on-disk
    // convention <project>/.claude/worktrees/<name>.
    if (meta.worktree && meta.worktree.originalCwd) {
        meta.projectCwd = meta.worktree.originalCwd;
    } else {
        const m = /^(.*)\/\.claude\/worktrees\/([^/]+)/.exec(meta.cwd || '');
        if (m) {
            meta.projectCwd = m[1];
            meta.worktree = { name: m[2], branch: meta.gitBranch, path: meta.cwd, originalCwd: m[1] };
        } else {
            meta.projectCwd = meta.cwd;
        }
    }

    return meta;
}

// Pull "key":"value" out of a raw line without parsing the whole object. Only
// used for fields we know are plain strings without escapes worth caring about.
function matchField(line, key) {
    const needle = '"' + key + '":"';
    const i = line.indexOf(needle);
    if (i === -1) return null;
    const start = i + needle.length;
    const end = line.indexOf('"', start);
    if (end === -1) return null;
    const v = line.slice(start, end);
    return v.includes('\\') ? null : v;
}

/** The last "key":"value" in a whole transcript, without parsing any of it. */
function tailField(text, key) {
    const needle = '"' + key + '":"';
    const i = text.lastIndexOf(needle);
    if (i === -1) return null;
    const start = i + needle.length;
    const end = text.indexOf('"', start);
    if (end === -1) return null;
    const v = text.slice(start, end);
    return v.includes('\\') ? null : v;
}

function safeParse(line) {
    try { return JSON.parse(line); } catch { return null; }
}

function firstLine(s, max) {
    const line = String(s).split('\n').find(l => l.trim()) || String(s);
    const t = line.trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function userText(entry) {
    const c = entry.message && entry.message.content;
    if (typeof c === 'string') return stripEnvelope(c);
    if (!Array.isArray(c)) return null;
    const parts = [];
    for (const b of c) if (b.type === 'text' && b.text) parts.push(b.text);
    return parts.length ? stripEnvelope(parts.join('\n')) : null;
}

// User messages arrive wrapped in bookkeeping tags (command invocations,
// system reminders, stdout captures). Strip them for display purposes.
function stripEnvelope(s) {
    return String(s)
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
        .trim();
}

// ---------------------------------------------------------------------------
// Full transcript parse (drives the conversation view)
// ---------------------------------------------------------------------------

/**
 * Turn a transcript into an ordered list of render events.
 *
 * Tool calls and their results live in separate entries (assistant emits
 * `tool_use`, the following user entry carries `tool_result`); we stitch them
 * into a single event so the UI can render one collapsible block per tool call.
 */
function buildEvents(entries, ctx = {}) {
    const events = [];
    const toolsById = new Map();
    let lastAssistantModel = null;

    for (const e of entries) {
        if (!CONTENT_TYPES.has(e.type)) {
            if (e.type === 'system' || e.type === 'attachment') { /* handled below */ }
            continue;
        }
        if (e.isSidechain) continue; // subagent traffic is loaded on demand

        if (e.type === 'system') {
            const ev = systemEvent(e);
            if (ev) events.push(ev);
            continue;
        }

        const content = e.message && e.message.content;

        if (e.type === 'assistant') {
            lastAssistantModel = (e.message && e.message.model) || lastAssistantModel;
            if (!Array.isArray(content)) continue;
            let n = 0;
            for (const b of content) {
                n++;
                if (b.type === 'thinking' && b.thinking) {
                    events.push({
                        id: `${e.uuid}:think:${n}`, kind: 'thinking', ts: e.timestamp,
                        text: b.thinking,
                    });
                } else if (b.type === 'text' && b.text && b.text.trim()) {
                    events.push({
                        id: `${e.uuid}:text:${n}`, kind: 'assistant', ts: e.timestamp,
                        text: b.text, model: e.message.model,
                    });
                } else if (b.type === 'tool_use') {
                    const ev = {
                        id: b.id, kind: 'tool', ts: e.timestamp,
                        name: b.name, input: b.input || {},
                        status: 'pending', result: null, agent: null,
                    };
                    // A subagent's transcript exists from the moment it starts,
                    // which is exactly when watching it is worth something. Link
                    // it at the call, not at the result — waiting for the result
                    // would mean an agent is only visible once it is over.
                    const spawned = ctx.subagentsByToolUse
                        && ctx.subagentsByToolUse.get(b.id);
                    if (spawned) ev.agent = agentRef(spawned);
                    toolsById.set(b.id, ev);
                    events.push(ev);
                }
            }
            continue;
        }

        // e.type === 'user'
        if (e.isMeta) continue;

        if (Array.isArray(content)) {
            const resultBlocks = content.filter(b => b.type === 'tool_result');
            if (resultBlocks.length) {
                for (const b of resultBlocks) {
                    const payload = resultPayload(b, e, ctx);
                    const target = toolsById.get(b.tool_use_id);
                    if (target) {
                        Object.assign(target, payload);
                        if (target.ts && payload.resultTs) {
                            target.durationMs = Date.parse(payload.resultTs) - Date.parse(target.ts);
                        }
                    } else {
                        // The call itself was in an earlier chunk — this happens on
                        // every live tail. Emit a patch the client applies to the
                        // tool block it already rendered.
                        events.push({
                            id: b.tool_use_id + ':result', kind: 'tool-result',
                            toolId: b.tool_use_id, ts: e.timestamp, ...payload,
                        });
                    }
                }
                continue;
            }
        }

        if (e.isCompactSummary) {
            events.push({
                id: e.uuid, kind: 'compact', ts: e.timestamp,
                text: userText(e) || 'Conversation compacted',
            });
            continue;
        }

        const text = userText(e);

        const notification = parseTaskNotification(text);
        if (notification) {
            events.push({
                id: e.uuid, kind: 'agent-done', ts: e.timestamp, ...notification,
            });
            continue;
        }

        const images = Array.isArray(content)
            ? content.filter(b => b.type === 'image').map(imageRef)
            : [];
        if (!text && !images.length) continue;

        events.push({
            id: e.uuid, kind: 'user', ts: e.timestamp,
            text: text || '', images,
            command: parseCommand(text),
            origin: e.origin && e.origin.kind,
        });
    }

    return { events, model: lastAssistantModel };
}

function imageRef(b) {
    const src = b.source || {};
    return {
        mediaType: src.media_type || 'image/png',
        // Transcripts inline base64; hand it straight to the UI as a data URI.
        dataUri: src.data ? `data:${src.media_type || 'image/png'};base64,${src.data}` : null,
    };
}

// A background task finishing is delivered as a *user* message, because that is
// the only channel into a conversation there is. It is not something you said,
// and treating it as though it were is wrong twice over: it puts words in your
// mouth, and it moves the session up a rail that is sorted by when you last
// spoke — so an agent finishing quietly reorders your list.
//
// Anchored at the *start* of the message rather than matched anywhere in it,
// because quoting one of these back into a conversation is a thing people do,
// and a quote really is a turn you took.
//
// Two openings are accepted. The transcript normally holds the bare tag; the
// preamble is addressed to the agent and added when its prompt is assembled, so
// it does not reliably reach disk. Matching only the preamble — which is what
// this did at first — matches nothing at all.
// Deliberately missing its closing bracket, so the tag still matches if it ever
// grows attributes.
const NOTIFICATION_TAG = '<task-notification';
const NOTIFICATION_PREFIX = '[SYSTEM NOTIFICATION - NOT USER INPUT]';

function isTaskNotification(text) {
    const t = String(text || '').trimStart();
    if (!t.includes(NOTIFICATION_TAG)) return false;
    return t.startsWith(NOTIFICATION_TAG) || t.startsWith(NOTIFICATION_PREFIX);
}

/** Pull the useful fields out of a task notification, or null if it isn't one. */
function parseTaskNotification(text) {
    if (!isTaskNotification(text)) return null;
    const tag = (name) => {
        const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
        return m ? m[1].trim() : null;
    };
    const num = (name) => {
        const v = tag(name);
        return v && /^\d+$/.test(v) ? Number(v) : null;
    };
    const taskId = tag('task-id');
    if (!taskId) return null;   // structurally not one of these after all
    return {
        taskId,
        // The id of the Task call that spawned it — the same key subagent
        // transcripts are filed under, so the UI can offer to open it.
        toolUseId: tag('tool-use-id'),
        status: tag('status') || 'completed',
        summary: tag('summary'),
        result: tag('result'),
        tokens: num('subagent_tokens'),
        toolUses: num('tool_uses'),
        durationMs: num('duration_ms'),
    };
}

// Slash-command invocations arrive as XML-ish tags inside a user message.
function parseCommand(text) {
    if (!text) return null;
    const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
    if (!name) return null;
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    return { name: name[1].trim(), args: args ? args[1].trim() : '' };
}

/** The renderable half of a tool call: status, output, diff, subagent link. */
function resultPayload(block, entry, ctx) {
    const structured = entry.toolUseResult;
    const ev = {
        status: block.is_error ? 'error' : 'ok',
        resultTs: entry.timestamp,
    };

    let text = '';
    if (typeof block.content === 'string') text = block.content;
    else if (Array.isArray(block.content)) {
        text = block.content
            .map(c => (c.type === 'text' ? c.text : `[${c.type}]`))
            .join('\n');
    }

    // Output too large to inline was spilled to a file; expose the path so the
    // UI can offer to load it rather than showing only the 2KB preview.
    const spill = /Full output saved to: (\S+)/.exec(text);
    ev.persistedPath = spill ? spill[1]
        : (structured && structured.persistedOutputPath) || null;

    ev.result = {
        text,
        stdout: structured && typeof structured.stdout === 'string' ? structured.stdout : null,
        stderr: structured && typeof structured.stderr === 'string' ? structured.stderr : null,
        patch: structured && structured.structuredPatch ? structured.structuredPatch : null,
        filePath: structured && (structured.filePath
            || (structured.file && structured.file.filePath)) || null,
        interrupted: !!(structured && structured.interrupted),
        backgroundTaskId: (structured && structured.backgroundTaskId) || null,
    };

    // A Task/Agent call writes its own transcript keyed by the tool_use id.
    if (structured && structured.agentId) {
        ev.agent = {
            agentId: structured.agentId,
            agentType: structured.agentType || null,
            description: structured.description || null,
            model: structured.resolvedModel || null,
            isAsync: !!structured.isAsync,
            durationMs: structured.totalDurationMs || null,
            tokens: structured.totalTokens || null,
            toolUses: structured.totalToolUseCount || null,
        };
    }
    // A transcript on disk means the UI can open the subagent as its own view.
    const spawned = ctx.subagentsByToolUse && ctx.subagentsByToolUse.get(block.tool_use_id);
    if (spawned) {
        // The result's own account of itself wins where it has one, and the meta
        // file fills the gaps. Merged field by field rather than by spreading:
        // the result records absent fields as null, and a plain spread would let
        // those nulls overwrite values the meta file does know.
        const ref = agentRef(spawned);
        const own = ev.agent || {};
        ev.agent = { ...ref, ...own };
        for (const [k, v] of Object.entries(ref)) {
            if (ev.agent[k] == null) ev.agent[k] = v;
        }
        ev.agent.hasTranscript = true;
    }

    return ev;
}

/**
 * The identity of a subagent, as it travels with a tool event. Only identity —
 * size and mtime change constantly and this payload is re-sent on every tail.
 */
function agentRef(spawned) {
    return {
        agentId: spawned.agentId,
        agentType: spawned.agentType,
        description: spawned.description,
        spawnDepth: spawned.spawnDepth,
        hasTranscript: true,
    };
}

/** A short phrase for what a tool call is doing, for status lines. */
function describeTool(block) {
    const name = block.name;
    const input = block.input || {};
    switch (name) {
        case 'Bash': return `Running: ${clip(input.description || input.command, 60)}`;
        case 'Read': return `Reading ${base(input.file_path)}`;
        case 'Edit': return `Editing ${base(input.file_path)}`;
        case 'Write': return `Writing ${base(input.file_path)}`;
        case 'Glob': return `Searching ${clip(input.pattern, 40)}`;
        case 'Grep': return `Grepping ${clip(input.pattern, 40)}`;
        case 'Task':
        case 'Agent': return `Subagent: ${clip(input.description, 50)}`;
        case 'WebFetch': return `Fetching ${clip(input.url, 50)}`;
        case 'WebSearch': return `Searching the web`;
        default: return `Running ${name}`;
    }
}

const base = (p) => (p ? String(p).split('/').pop() : '');
const clip = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// System entries a reader actually wants to see. Everything else — turn timings,
// thinking-token counters, plugin reload chatter — is bookkeeping.
const NOTABLE_SYSTEM = new Set(['permission_denied', 'away_summary']);

function systemEvent(e) {
    const sub = e.subtype || '';
    const text = typeof e.content === 'string' ? e.content
        : (e.message && typeof e.message.content === 'string' ? e.message.content : '');

    // A hook that blocked the turn is worth showing; a hook that ran cleanly is not.
    if (sub === 'stop_hook_summary') {
        const failed = (e.hookErrors && e.hookErrors.length) || e.preventedContinuation;
        if (!failed) return null;
        return {
            id: e.uuid || sub + ':' + e.timestamp, kind: 'system', ts: e.timestamp,
            subtype: sub, isError: true,
            text: (e.hookErrors || []).join('\n')
                || e.stopReason || 'A stop hook prevented the turn from continuing.',
        };
    }

    const isError = e.level === 'error' || /error|failed|denied|blocked/i.test(sub);
    if (!isError && !NOTABLE_SYSTEM.has(sub)) return null;
    if (!text) return null;

    return {
        id: e.uuid || sub + ':' + e.timestamp, kind: 'system', ts: e.timestamp,
        subtype: sub, text: stripEnvelope(text), isError,
    };
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

/**
 * Map tool_use id -> record, for every subagent a session spawned.
 *
 * The size and mtime come along because a subagent has no other liveness signal:
 * its transcript is a plain file nobody closes, so "was it written to recently"
 * is how the UI tells a working agent from a stalled one.
 */
function readSubagentIndex(sessionDir) {
    const out = new Map();
    const dir = path.join(sessionDir, 'subagents');
    let files;
    try { files = fs.readdirSync(dir); } catch { return out; }
    for (const f of files) {
        if (!f.endsWith('.meta.json')) continue;
        let meta;
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
        if (!meta.toolUseId) continue;
        const agentId = f.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
        const file = path.join(dir, `agent-${agentId}.jsonl`);
        // The meta file is written when the agent starts, so the transcript may
        // not exist for a moment. That is a running agent with nothing to show.
        let st = null;
        try { st = fs.statSync(file); } catch { /* not written yet */ }
        out.set(meta.toolUseId, {
            toolUseId: meta.toolUseId,
            agentId,
            agentType: meta.agentType || null,
            description: meta.description || null,
            spawnDepth: meta.spawnDepth || 1,
            file,
            bytes: st ? st.size : 0,
            mtimeMs: st ? st.mtimeMs : 0,
        });
    }
    return out;
}

const NEWLINE = Buffer.from('\n');

/**
 * Parse a subagent transcript from `from` bytes on, into render events.
 *
 * Returns {events, offset, size, reset}. `offset` only advances past lines that
 * ended in a newline, so a caller can hand it straight back to follow the file
 * as the agent writes — the same contract SessionIndex.readSince offers.
 */
function readSubagentTranscript(file, from = 0, ctx = {}) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    if (st.size < from) return { events: [], offset: 0, size: st.size, reset: true };
    if (st.size === from) return { events: [], offset: from, size: st.size, reset: false };

    let buf;
    try {
        const fd = fs.openSync(file, 'r');
        buf = Buffer.alloc(st.size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        fs.closeSync(fd);
    } catch { return null; }

    const { entries, consumed } = parseLines(buf);
    // A last line still missing its newline is worth showing — an agent that
    // finished without one would otherwise lose its final message — but it is
    // not counted as consumed, so the next read picks it up again in full.
    if (consumed < buf.length) {
        const { entries: partial } = parseLines(Buffer.concat([buf.subarray(consumed), NEWLINE]));
        entries.push(...partial);
    }

    // Subagent entries are all flagged isSidechain; clear it so buildEvents keeps them.
    for (const e of entries) e.isSidechain = false;
    const { events } = buildEvents(entries, ctx);
    return { events, offset: from + consumed, size: st.size, reset: false };
}

// How much of a transcript's tail to read when all we want is the last thing
// that happened. Bounded, because this is polled while an agent runs and the
// file it is polling can be tens of megabytes.
const ACTIVITY_TAIL_BYTES = 64 * 1024;

/**
 * The last thing a transcript shows the agent doing — the subagent equivalent of
 * the working pulse in the session rail. Returns {text, ts} or null.
 */
function lastActivity(file) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    if (!st.size) return null;

    const from = Math.max(0, st.size - ACTIVITY_TAIL_BYTES);
    let buf;
    try {
        const fd = fs.openSync(file, 'r');
        buf = Buffer.alloc(st.size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        fs.closeSync(fd);
    } catch { return null; }

    const lines = buf.toString('utf8').split('\n');
    if (from > 0) lines.shift();   // reading from an offset lands mid-line

    for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        const e = safeParse(lines[i]);
        if (!e || e.type !== 'assistant') continue;
        const content = e.message && e.message.content;
        if (!Array.isArray(content)) continue;
        for (let j = content.length - 1; j >= 0; j--) {
            const b = content[j];
            if (b.type === 'tool_use') return { text: describeTool(b), ts: e.timestamp };
            if (b.type === 'text' && b.text && b.text.trim()) {
                return { text: firstLine(b.text, 70), ts: e.timestamp };
            }
        }
    }
    return null;
}

module.exports = {
    parseLines, scanMeta, buildEvents, readSubagentIndex, readSubagentTranscript,
    lastActivity, describeTool, stripEnvelope, firstLine,
};
