'use strict';

// Codex hooks that failed, kept so the conversation can say so.
//
// Claude Code writes a `stop_hook_summary` line into its transcript, so a hook
// that failed is a row in the history like any other. **Codex writes nothing**:
// measured on 0.172.0, a rollout records the context a hook *added* and not one
// line about a hook that exited non-zero or blocked the prompt. The only word of
// it is the live `hook/completed` notification, which would be lost on the next
// re-read of the file.
//
// So this keeps those, one small JSON-lines file per thread under STATE_DIR, and
// the Codex transcript reads (bridge/sessions.js) lay them back among the
// rollout's own events as `system` rows. Content still comes from files; this is
// a second one, ours.
//
//   - **Only failures.** `failed`, `blocked` and `stopped`. A hook that ran
//     cleanly is not news, which is the rule the Claude reader has.
//   - **Placed by byte offset.** A note records how long the rollout was when it
//     arrived, so a windowed read (a turn range, the live tail) carries the
//     notes that fall inside it and no others.
//   - **Once.** An adopted process replays its log, so a run already noted is
//     not noted again.
//   - **A runtime with hooks only.** A thread a terminal ran, with no bridge
//     listening, has no notes: there was nobody to hear them.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { STATE_DIR } = require('../config');

const DIR = () => path.join(STATE_DIR, 'codex-hooks');
// A hook that fails on every tool call would grow a row per call for ever.
const MAX_NOTES = 200;
const MAX_TEXT = 2000;
const WRONG = { failed: 'failed', blocked: 'blocked', stopped: 'stopped' };

// Thread ids are UUIDs; anything else is not a file name we will make.
const fileFor = (threadId) => (/^[0-9a-f-]{8,64}$/i.test(String(threadId || ''))
    ? path.join(DIR(), `${String(threadId).toLowerCase()}.jsonl`) : null);

const cache = new Map();    // file -> {stamp, notes}

/** Is this `HookRunSummary` one worth a row? */
const worthNoting = (run) => !!run && Object.prototype.hasOwnProperty.call(WRONG, run.status);

/** The transcript row for one run. */
function eventOf(run, turnId, at) {
    const key = crypto.createHash('sha1')
        .update(`${run.id}|${run.startedAt}|${turnId || ''}`).digest('hex').slice(0, 16);
    const said = (run.entries || [])
        .filter(e => e && e.text && e.kind !== 'context')
        .map(e => String(e.text).trim())
        .filter(Boolean)
        .join('\n').slice(0, MAX_TEXT);
    const name = run.eventName ? `\`${run.eventName}\`` : 'A';
    const did = run.status === 'failed' ? 'failed'
        : run.status === 'blocked' ? 'blocked the turn' : 'stopped the turn';
    return {
        id: `hook:${key}`, kind: 'system', ts: new Date(at).toISOString(),
        subtype: `hook_${WRONG[run.status]}`, isError: true,
        text: `${run.eventName ? `The ${name} hook` : 'A hook'} ${did}${said ? `: ${said}` : '.'}`
            + (run.sourcePath ? `\n\n\`${run.sourcePath}\`` : ''),
    };
}

/** A thread's notes, oldest first: `[{offset, event}]`. */
function list(threadId) {
    const file = fileFor(threadId);
    if (!file) return [];
    let st;
    try { st = fs.statSync(file); } catch { return []; }
    const stamp = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(file);
    if (hit && hit.stamp === stamp) return hit.notes;
    const notes = [];
    try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line) continue;
            try {
                const n = JSON.parse(line);
                if (n && n.event && n.event.id) notes.push(n);
            } catch { /* a torn line */ }
        }
    } catch { return []; }
    cache.set(file, { stamp, notes });
    return notes;
}

/**
 * Note one `hook/completed` run. Returns the row it became, or null when it is
 * not worth one, has been noted already, or the thread has had too many.
 */
function record(threadId, { run, turnId = null, offset = 0, now = Date.now() } = {}) {
    const file = fileFor(threadId);
    if (!file || !worthNoting(run)) return null;
    const event = eventOf(run, turnId, now);
    const notes = list(threadId);
    if (notes.length >= MAX_NOTES || notes.some(n => n.event.id === event.id)) return null;
    try {
        fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 });
        fs.appendFileSync(file, `${JSON.stringify({ offset, event })}\n`, { mode: 0o600 });
        cache.delete(file);
    } catch (err) {
        console.error(`[codex] could not note a hook failure: ${err.message}`);
    }
    return event;
}

/**
 * `events` (a read of the rollout from byte `from` to `to`, `to` null for the
 * end) with the thread's notes from that stretch laid in by time. `events` is
 * returned as it is when there are none.
 */
function merge(events, threadId, from = 0, to = null) {
    const here = list(threadId).filter(n => n.offset >= from && (to === null || n.offset < to));
    if (!here.length) return events;
    const out = events.slice();
    for (const { event } of here) {
        const at = out.findIndex(e => e.ts && e.ts > event.ts);
        if (at < 0) out.push(event); else out.splice(at, 0, event);
    }
    return out;
}

module.exports = { record, list, merge, eventOf, worthNoting, MAX_NOTES };
