'use strict';

// What a session changed, out of the transcript.
//
// The other half of the answer — what is in the working tree right now — is
// `git.js`, and the two are deliberately not reconciled. They disagree for real
// reasons: this one holds files the session edited and has since committed, or
// edited in a directory that has moved on, and it holds them for a session run
// in a terminal months ago. Git holds files somebody else changed, and files
// this session edited and then reverted. Showing one number would mean picking
// which of those to lie about.
//
// Constraint 1 of the roadmap — content comes from the transcript, never from
// the process — is what makes this possible at all: an `Edit` result carries the
// structured patch Claude Code computed, so the line counts are the ones the
// diff in the conversation shows, not a re-diff of a file that has changed since.
//
// Two things here are easy to get wrong and are the reason this is a module
// rather than four lines in a route:
//
//   * **Which tool calls count.** Keyed on the tool's *name*, never on a result
//     having a `filePath` — `ExitPlanMode` results carry one too (the plan file),
//     so keying on the field lists plans as edits.
//   * **Subagents.** A `Task` writes its own transcript, so a session that
//     delegates its work has no `Edit` calls of its own at all. Folding those in
//     is the difference between "no files changed" and the truth, and it is why
//     rows carry which agent made them: clicking one has to open that agent's
//     pane rather than hunting for a tool call the conversation never had.

const path = require('path');

const { readSubagentIndex, readSubagentTranscript } = require('./transcript');

// Everything that changes a file on disk and reports a patch for it. `Bash`
// running `sed -i` is not here and cannot be: nothing in the transcript says
// which file it touched, which is exactly why the working tree is shown beside
// this rather than instead of it.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// How many sessions to remember reads for. The point of the cache is a panel
// re-opened on the same conversation, so a handful is the whole need.
const CACHE_SESSIONS = 8;

/**
 * Per session: what has been read, and what came of it.
 *
 * Every read here is incremental, and the reason is a transcript this machine
 * really has — 48MB of it. The panel re-asks whenever a turn ends, and re-parsing
 * the whole file each time to find the last two `Edit` calls would make watching
 * a session cost more than running it. Both halves resume from a byte offset:
 * `SessionIndex.readSince` for the conversation, `readSubagentTranscript` for each
 * agent, and both only advance past complete lines.
 *
 * @type {Map<string, {main: Holder, agents: Map<string, Holder>}>}
 * @typedef {{offset: number, files: Map<string, any>, pending: Map<string, any>, done: Set<string>}} Holder
 */
const cache = new Map();

const holder = () => ({
    offset: 0, files: new Map(), pending: new Map(), done: new Set(),
});

function stateOf(sessionId) {
    let entry = cache.get(sessionId);
    if (!entry) {
        entry = { main: holder(), agents: new Map() };
        cache.set(sessionId, entry);
        // Oldest first in a Map's insertion order, which is the one to drop.
        while (cache.size > CACHE_SESSIONS) cache.delete(cache.keys().next().value);
    }
    return entry;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

const lineCount = (s) => (s ? String(s).split('\n').length : 0);

/** Added and deleted lines in a structured patch, counted the way `diffView` reads it. */
function countPatch(patch) {
    let added = 0;
    let deleted = 0;
    for (const hunk of patch || []) {
        for (const line of hunk.lines || []) {
            if (line[0] === '+') added++;
            else if (line[0] === '-') deleted++;
        }
    }
    return { added, deleted };
}

/**
 * What one edit changed.
 *
 * The patch is the good answer and is normally there. The fallback is for the
 * calls where it is not — an `Edit` whose result never arrived because the turn
 * was interrupted, an older transcript — and it is the same fallback `toolBody`
 * makes in the UI: the strings the call was made with.
 */
function countEdit(ev) {
    const r = ev.result || {};
    if (r.patch && r.patch.length) return countPatch(r.patch);

    const i = ev.input || {};
    if (ev.name === 'Write') return { added: lineCount(i.content), deleted: 0 };
    if (Array.isArray(i.edits)) {
        return i.edits.reduce((n, e) => ({
            added: n.added + lineCount(e.new_string),
            deleted: n.deleted + lineCount(e.old_string),
        }), { added: 0, deleted: 0 });
    }
    return { added: lineCount(i.new_string), deleted: lineCount(i.old_string) };
}

/** The path an edit was aimed at: the result's, or failing that the call's own. */
function pathOf(ev) {
    const r = ev.result || {};
    return r.filePath || (ev.input && (ev.input.file_path || ev.input.notebook_path)) || null;
}

// ---------------------------------------------------------------------------
// Accumulating
// ---------------------------------------------------------------------------

/**
 * Fold every file-changing tool call in `events` into `into`, keyed by absolute path.
 *
 * `pending` is what makes an incremental read correct. `buildEvents` merges a
 * result into its call where both are in the same chunk and emits a `tool-result`
 * patch where they are not — which is every read that resumes from an offset, and
 * so every re-open of the panel on a running agent. Holding the calls that have
 * no result yet, across reads, is how the second half finds the first.
 *
 * `done` is the other half of that: `readSubagentTranscript` deliberately hands
 * back a trailing line that has no newline yet without consuming it, so an agent
 * caught mid-write offers the same call again on the next read. Counting a file's
 * `+84 −12` twice is exactly the kind of wrong that looks plausible.
 *
 * @param {Array} events render events, from `buildEvents`
 * @param {{into?: Map<string, any>, pending?: Map<string, any>, done?: Set<string>,
 *          agent?: {toolUseId, agentType, description}}} opts
 */
function fromEvents(events, {
    into = new Map(), pending = new Map(), done = new Set(), agent = null,
} = {}) {
    const record = (ev) => {
        const file = pathOf(ev);
        if (!file) return;
        if (done.has(ev.id)) return;
        done.add(ev.id);

        const { added, deleted } = countEdit(ev);
        let row = into.get(file);
        if (!row) {
            row = { path: file, added: 0, deleted: 0, edits: [] };
            into.set(file, row);
        }
        row.added += added;
        row.deleted += deleted;
        row.edits.push({ toolId: ev.id, ts: ev.resultTs || ev.ts || null, added, deleted, agent });
    };

    for (const ev of events || []) {
        if (ev.kind === 'tool-result') {
            const call = pending.get(ev.toolId);
            if (!call) continue;
            pending.delete(ev.toolId);
            if (ev.status === 'ok') record({ ...call, ...ev, id: call.id });
            continue;
        }
        if (ev.kind !== 'tool' || !EDIT_TOOLS.has(ev.name)) continue;

        // A call that failed changed nothing, and a call still running has not
        // changed anything yet. Either would otherwise land as a 0/0 row that
        // the panel counts as a changed file.
        if (ev.status === 'ok') record(ev);
        else if (ev.status === 'pending') pending.set(ev.id, ev);
    }
    return into;
}

/** Fold one accumulator into another, summing the files they share. */
function merge(into, from) {
    for (const [file, row] of from) {
        const cur = into.get(file);
        if (!cur) {
            into.set(file, { ...row, edits: [...row.edits] });
            continue;
        }
        cur.added += row.added;
        cur.deleted += row.deleted;
        cur.edits.push(...row.edits);
    }
    return into;
}

/**
 * The accumulator as the panel wants it: newest first, one row per file.
 *
 * `toolId` is the *first* edit made in this conversation, because that is where
 * clicking the row goes — the start of what happened to this file, not the end.
 * Where every edit came from a subagent there is no such call to jump to, so the
 * row carries the agent instead and the UI opens its pane.
 */
function summarize(byPath, { root = null } = {}) {
    const out = [];
    for (const row of byPath.values()) {
        const edits = [...row.edits].sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
        const mine = edits.find(e => !e.agent) || null;
        const first = edits[0] || null;

        out.push({
            path: row.path,
            relPath: root && row.path.startsWith(`${root}/`) ? row.path.slice(root.length + 1) : row.path,
            added: row.added,
            deleted: row.deleted,
            edits: edits.length,
            firstTs: first ? first.ts : null,
            lastTs: edits.length ? edits[edits.length - 1].ts : null,
            toolId: mine ? mine.toolId : null,
            // Only when nothing in this conversation touched the file, so that a
            // file both worked on jumps to the transcript rather than sideways.
            agent: mine ? null : (first && first.agent) || null,
        });
    }
    // Most recently touched first: the panel sits beside a live transcript, and
    // the file being worked on now is the one you are looking for.
    out.sort((a, b) => (Date.parse(b.lastTs) || 0) - (Date.parse(a.lastTs) || 0));
    return out;
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

/**
 * Every file-changing call in every subagent this session spawned.
 *
 * Nested agents need no special handling: the meta files all land in the one
 * `subagents/` directory whatever their depth, keyed by the tool call that
 * spawned them — which is also the id `/api/sessions/:id/subagent` answers to,
 * so a row from a depth-two agent still opens.
 */
function fromSubagents(sessionId, sessionDir) {
    const seen = stateOf(sessionId).agents;
    const index = readSubagentIndex(sessionDir);
    const byPath = new Map();
    let edited = 0;

    for (const entry of index.values()) {
        let held = seen.get(entry.file) || holder();
        // A file that shrank was replaced; start it again rather than reading
        // from an offset into different content.
        if (entry.bytes < held.offset) held = holder();

        if (entry.bytes > held.offset || !seen.has(entry.file)) {
            const read = readSubagentTranscript(entry.file, held.offset);
            if (read) {
                if (read.reset) held = holder();
                fromEvents(read.events, {
                    into: held.files,
                    pending: held.pending,
                    done: held.done,
                    agent: {
                        toolUseId: entry.toolUseId,
                        agentType: entry.agentType,
                        description: entry.description,
                    },
                });
                held.offset = read.offset;
            }
        }
        seen.set(entry.file, held);

        if (held.files.size) edited++;
        merge(byPath, held.files);
    }

    // An agent whose transcript is gone should not keep its edits alive.
    const live = new Set([...index.values()].map(e => e.file));
    for (const file of [...seen.keys()]) if (!live.has(file)) seen.delete(file);

    return { byPath, agents: { total: index.size, edited } };
}

/**
 * The conversation's own file-changing calls, from wherever the last read stopped.
 *
 * `readSince` is the live tail's own reader, and using it here rather than
 * `index.read` is the difference between parsing a whole transcript per refresh
 * and parsing the turn that just ended. `reset` means the file was replaced —
 * a fork, a compaction — and the answer is to forget and read it again from the
 * top rather than to trust an offset into different content.
 */
function fromTranscript(index, sessionId) {
    const state = stateOf(sessionId);
    let delta = index.readSince(sessionId, state.main.offset);
    if (delta && delta.reset) {
        state.main = holder();
        delta = index.readSince(sessionId, 0);
    }
    if (!delta) return null;

    fromEvents(delta.events, {
        into: state.main.files,
        pending: state.main.pending,
        done: state.main.done,
    });
    state.main.offset = delta.offset;
    return state.main.files;
}

/** Drop what is remembered about a session — it was deleted, or forked away. */
function forget(sessionId) {
    cache.delete(sessionId);
}

/**
 * Everything this session changed: its own transcript and its subagents'.
 *
 * @param {import('./sessions').SessionIndex} index
 * @param {string} sessionId
 * @param {{sessionDir: string|null, root?: string|null}} opts
 * @returns {{files: Array, agents: {total:number, edited:number}, added:number,
 *            deleted:number}|null} null when there is no such session
 */
function forSession(index, sessionId, { sessionDir, root = null }) {
    const mine = fromTranscript(index, sessionId);
    if (!mine) return null;

    // A copy, because what `fromTranscript` returns is the cache itself and the
    // subagents' rows are merged in on top.
    const byPath = merge(new Map(), mine);
    const subs = sessionDir
        ? fromSubagents(sessionId, sessionDir)
        : { byPath: new Map(), agents: { total: 0, edited: 0 } };
    merge(byPath, subs.byPath);

    const files = summarize(byPath, { root });
    return {
        files,
        agents: subs.agents,
        added: files.reduce((n, f) => n + f.added, 0),
        deleted: files.reduce((n, f) => n + f.deleted, 0),
    };
}

module.exports = { fromEvents, countEdit, countPatch, summarize, forSession, forget, EDIT_TOOLS };
