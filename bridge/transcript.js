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
                meta.userMessages++;
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
    // A transcript on disk means the UI can offer to expand the subagent inline.
    const spawned = ctx.subagentsByToolUse && ctx.subagentsByToolUse.get(block.tool_use_id);
    if (spawned) {
        const { file, ...rest } = spawned; // the client addresses it by tool_use id
        ev.agent = { ...rest, ...(ev.agent || {}), hasTranscript: true };
    }

    return ev;
}

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

/** Map tool_use id -> {file, agentId, agentType, description} for a session. */
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
        out.set(meta.toolUseId, {
            agentId,
            agentType: meta.agentType || null,
            description: meta.description || null,
            spawnDepth: meta.spawnDepth || 1,
            file: path.join(dir, `agent-${agentId}.jsonl`),
        });
    }
    return out;
}

/** Parse one subagent transcript into render events. */
function readSubagentTranscript(file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { return null; }
    const { entries } = parseLines(Buffer.concat([buf, Buffer.from('\n')]));
    // Subagent entries are all flagged isSidechain; clear it so buildEvents keeps them.
    for (const e of entries) e.isSidechain = false;
    return buildEvents(entries).events;
}

module.exports = {
    parseLines, scanMeta, buildEvents, readSubagentIndex, readSubagentTranscript,
    stripEnvelope, firstLine,
};
