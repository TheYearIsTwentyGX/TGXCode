'use strict';

// A session's own task list — the items, and how far through them it is.
//
// Claude Code keeps a task list per session in ~/.claude/tasks/<session-id>/,
// one small JSON file per task:
//
//   {"id":"3","subject":"Rail 'elsewhere' state and the composer lock",
//    "description":"web/app.js: the rail state, and the lock on the composer.",
//    "activeForm":"Building the rail state and composer lock",
//    "status":"completed","blocks":[],"blockedBy":[]}
//
// This is the best account of what an agent is doing that exists anywhere. It is
// the reason a board card can say "3 of 7" rather than just "working", and the
// reason the conversation view can show the list itself. It is read, never
// written — the same rule as everything else under ~/.claude.
//
// Reading the directory beats reconstructing the list from the transcript. The
// task tools are incremental — TaskCreate adds one, TaskUpdate moves one — so a
// transcript tail shows the last few edits rather than the list, and getting the
// list from it would mean replaying the session from the top. Here the current
// state is simply what is on disk.
//
// Other Claude Code builds write a `TodoWrite` call into the transcript instead
// and keep no directory; `todoList`/`todoProgress` in transcript.js cover those,
// and both entry points below fall back to them.
//
// **The tools are off by default on current models.** Claude Code stopped
// offering TaskCreate/Update and TodoWrite to Opus 4.8, Sonnet 5 and newer
// unless CLAUDE_CODE_ENABLE_TODO_TOOLS=1 is set, which is why `bridge/config.js`
// sets it for sessions this app starts. Without that, everything here correctly
// reports an empty list forever.
//
// Two entry points, because the two callers want different things at different
// rates:
//
//   progress(id, file)  the count, for board cards — asked ~1/s by two boards
//   items(id, file)     the list, for the conversation panel — asked every 400ms
//                       by whichever clients are following that session
//
// They have separate caches for that reason; see LIST_TTL_MS below.

const fs = require('fs');
const path = require('path');

const { HOME } = require('./config');
const { todoProgress, todoList } = require('./transcript');

const TASKS_DIR = process.env.CLAUDE_SESSIONS_TASKS_DIR
    || path.join(HOME, '.claude', 'tasks');

// Files are a few hundred bytes and there are rarely more than a dozen, but the
// board asks once a second per live session, so hold the answer briefly.
const TTL_MS = 3_000;
// The panel's cache is shorter on purpose. A list moves *during* a turn — that
// is the whole reason to show it — and three seconds of latency on "which step
// is it on" is exactly the thing the panel exists to remove. One second is still
// enough to coalesce two windows on the same session and a re-subscribe into one
// directory read.
const LIST_TTL_MS = 1_000;
// A runaway list is a bug somewhere else; do not read a thousand files for it.
const MAX_TASKS = 200;
// One entry per conversation somebody is following, and a client follows one at
// a time. Bounded by size rather than by `keepOnly` — see the note there.
const MAX_LIST_CACHE = 32;

/** @type {Map<string, {value: object|null, at: number}>} sessionId -> progress */
const cache = new Map();
/** @type {Map<string, {value: object, at: number}>} sessionId -> item envelope */
const listCache = new Map();

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

/**
 * The raw task files, newest format first, or null when there is no directory.
 *
 * Sorted numerically by name, which `read` never needed because it only counted.
 * `readdirSync` returns whatever order the filesystem gives, so a list of ten
 * tasks arrived as 1, 10, 2, 3 — invisible in a count and glaring in a list.
 *
 * `truncated` is how many were dropped past the cap, so a panel can say "and 3
 * more" rather than quietly showing the wrong list.
 */
function readFiles(sessionId) {
    const dir = path.join(TASKS_DIR, sessionId);

    let names;
    try { names = fs.readdirSync(dir); } catch { return null; }

    const json = names.filter(n => n.endsWith('.json'));   // this is the .lock skip
    json.sort((a, b) => {
        const na = Number.parseInt(a, 10);
        const nb = Number.parseInt(b, 10);
        if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
        return na - nb;
    });

    const tasks = [];
    let truncated = 0;
    for (const name of json) {
        if (tasks.length >= MAX_TASKS) { truncated++; continue; }
        let raw;
        try { raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
        catch { continue; }                          // half-written, or not ours to read
        if (!raw || typeof raw !== 'object') continue;
        tasks.push(raw);
    }
    if (!tasks.length) return null;
    return { tasks, truncated };
}

/**
 * One item shape, whichever source answered.
 *
 * `id` is null for the todo source, and that is a fact rather than an omission.
 * TodoWrite rewrites the whole list on every call and carries no ids, so any id
 * invented here would be positional and unstable across pushes — and a client
 * keying its DOM or its storage on one would silently mis-associate items the
 * moment the agent inserted a step. Null cannot be mistaken for a handle.
 *
 * `subject` is the one name field. The directory calls it `subject` and
 * TodoWrite calls it `content`; picking here rather than in the client deletes
 * a four-deep `t.subject || t.content || t.description || t.activeForm` guess
 * from a renderer that had no way to know which was right.
 *
 * `status` is closed. Anything outside the three known values reads as
 * `pending`, so a client's switch never falls through to nothing.
 */
function normalise(raw, source) {
    const status = STATUSES.has(raw.status) ? raw.status : 'pending';
    const strings = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
    return {
        id: source === 'directory' && raw.id != null ? String(raw.id) : null,
        subject: String(raw.subject || raw.content || ''),
        description: raw.description ? String(raw.description) : null,
        activeForm: raw.activeForm ? String(raw.activeForm) : null,
        status,
        blocks: strings(raw.blocks),
        blockedBy: strings(raw.blockedBy),
    };
}

/** The counts and the current step over an already-normalised list. */
function tally(items) {
    const active = items.find(t => t.status === 'in_progress') || null;
    const done = items.filter(t => t.status === 'completed').length;
    return {
        done,
        total: items.length,
        // The in-progress task's `activeForm`, which is written for exactly this.
        current: active ? (active.activeForm || active.subject || null) : null,
        // Worth knowing that nothing is moving: a list with work left and
        // nothing in progress is a session that has stopped, not one that is
        // between steps.
        idle: !active && done < items.length,
    };
}

/**
 * What a session's task list says, or null when it has none.
 *
 * Returns {done, total, current, idle, ts} — the same five keys `todoProgress`
 * returns, so one documented shape covers both sources. `ts` is null here
 * because the directory format records no times.
 */
function read(sessionId) {
    const found = readFiles(sessionId);
    if (!found) return null;
    // A deleted task is gone from the directory, so everything here counts.
    return { ...tally(found.tasks.map(t => normalise(t, 'directory'))), ts: null };
}

/** `read`, memoised for a few seconds, falling back to the transcript. */
function progress(sessionId, file = null) {
    const hit = cache.get(sessionId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

    // The directory when there is one; the transcript's own TodoWrite calls for
    // a build that does not write it.
    let value = read(sessionId);
    if (!value && file) value = todoProgress(file);

    cache.set(sessionId, { value, at: Date.now() });
    return value;
}

/**
 * The list itself: {source, items, done, total, current, idle, ts, truncated}.
 *
 * **Always an envelope, never null.** A session that kept no list is an answer —
 * `{source: null, items: []}` — not an absence, so the route always 200s and the
 * client has one branch to render instead of two. `progress()` keeps returning
 * null for that case, because both boards read it as "draw no progress bar".
 *
 * `source` says which of the two places answered, and they are not equally rich:
 * a directory list has ids, descriptions and dependencies and a todo list has
 * none of the three. A caller that wants to offer a description affordance needs
 * to know it can never be filled.
 */
function items(sessionId, file = null) {
    const hit = listCache.get(sessionId);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value;

    let value = null;
    const found = readFiles(sessionId);
    if (found) {
        const list = found.tasks.map(t => normalise(t, 'directory'));
        value = { source: 'directory', items: list, ...tally(list), ts: null,
            truncated: found.truncated };
    } else if (file) {
        const todo = todoList(file);
        if (todo) {
            const list = todo.items
                .filter(t => t && typeof t === 'object')
                .slice(0, MAX_TASKS)
                .map(t => normalise(t, 'todo'));
            value = { source: 'todo', items: list, ...tally(list), ts: todo.ts,
                truncated: Math.max(0, todo.items.length - list.length) };
        }
    }
    if (!value) {
        value = { source: null, items: [], done: 0, total: 0, current: null,
            idle: false, ts: null, truncated: 0 };
    }

    // Oldest out. `keepOnly` is deliberately not used for this cache: it is
    // called with the *board's* session ids, and a conversation somebody has
    // open need not be on the board — so every entry would be evicted a second
    // after it was written, exactly where the cache is meant to help.
    if (listCache.size >= MAX_LIST_CACHE && !listCache.has(sessionId)) {
        listCache.delete(listCache.keys().next().value);
    }
    listCache.set(sessionId, { value, at: Date.now() });
    return value;
}

/** Forget sessions nothing is asking about, so the cache is not a slow leak. */
function keepOnly(ids) {
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
}

module.exports = { progress, read, items, keepOnly, TASKS_DIR, MAX_TASKS };
