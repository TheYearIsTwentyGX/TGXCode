'use strict';

// How far through its own plan a session is.
//
// Claude Code keeps a task list per session in ~/.claude/tasks/<session-id>/,
// one small JSON file per task:
//
//   {"id":"3","subject":"Rail 'elsewhere' state and the composer lock",
//    "activeForm":"Building the rail state and composer lock",
//    "status":"completed","blocks":[],"blockedBy":[]}
//
// This is the best one-line summary of what an agent is doing that exists
// anywhere, and it is the reason a card can say "3 of 7" rather than just
// "working". It is read, never written — the same rule as everything else under
// ~/.claude.
//
// Reading the directory beats reconstructing the list from the transcript. The
// task tools are incremental — TaskCreate adds one, TaskUpdate moves one — so a
// transcript tail shows the last few edits rather than the list, and getting the
// list from it would mean replaying the session from the top. Here the current
// state is simply what is on disk.
//
// Older Claude Code builds write a `TodoWrite` call into the transcript instead
// and keep no directory; `todoProgress` in transcript.js covers those, and
// `progress()` below falls back to it.

const fs = require('fs');
const path = require('path');

const { HOME } = require('./config');
const { todoProgress } = require('./transcript');

const TASKS_DIR = process.env.CLAUDE_SESSIONS_TASKS_DIR
    || path.join(HOME, '.claude', 'tasks');

// Files are a few hundred bytes and there are rarely more than a dozen, but the
// board asks once a second per live session, so hold the answer briefly.
const TTL_MS = 3_000;
// A runaway list is a bug somewhere else; do not read a thousand files for it.
const MAX_TASKS = 200;

/** @type {Map<string, {value: object|null, at: number}>} sessionId -> progress */
const cache = new Map();

/**
 * What a session's task list says, or null when it has none.
 *
 * Returns {done, total, current, blocked} — `current` being the in-progress
 * task's `activeForm`, which is written for exactly this purpose.
 */
function read(sessionId) {
    const dir = path.join(TASKS_DIR, sessionId);

    let names;
    try { names = fs.readdirSync(dir); } catch { return null; }

    const tasks = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;      // skips .lock
        if (tasks.length >= MAX_TASKS) break;
        let raw;
        try { raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
        catch { continue; }                          // half-written, or not ours to read
        if (!raw || typeof raw !== 'object') continue;
        tasks.push(raw);
    }
    if (!tasks.length) return null;

    // A deleted task is gone from the directory, so everything here counts.
    const done = tasks.filter(t => t.status === 'completed').length;
    const active = tasks.find(t => t.status === 'in_progress') || null;
    return {
        done,
        total: tasks.length,
        current: active ? (active.activeForm || active.subject || null) : null,
        // Worth knowing that nothing is moving: a list with work left and
        // nothing in progress is a session that has stopped, not one that is
        // between steps.
        idle: !active && done < tasks.length,
    };
}

/** `read`, memoised for a few seconds. */
function progress(sessionId, file = null) {
    const hit = cache.get(sessionId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

    // The directory when there is one; the transcript's own TodoWrite calls for
    // a Claude Code old enough not to write it.
    let value = read(sessionId);
    if (!value && file) value = todoProgress(file);

    cache.set(sessionId, { value, at: Date.now() });
    return value;
}

/** Forget sessions nothing is asking about, so the cache is not a slow leak. */
function keepOnly(ids) {
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
}

module.exports = { progress, read, keepOnly, TASKS_DIR };
