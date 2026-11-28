'use strict';

// Waiting for a runtime to name the session it was started for.
//
// A Claude session's id is ours: the bridge mints it and passes it to
// `claude --session-id`. A Codex session's is Codex's, which mints it at
// `thread/start` (docs/plans/23-codex.md, Phase 3), so what `pool.create` returns
// for one is a placeholder until the runner's `init` says `minted`, and anything
// keyed on the id — a label, a schedule's record of its run, an orchestrator's
// worker — has to be keyed on what comes after. The create route was the first
// caller; a draft's Start, a schedule firing and an orchestrator's spawn are the
// others, and each would otherwise have labelled, remembered or filed a session
// that is never seen again.
//
// Moved here out of bridge/routes/sessions.js rather than copied, so that "how
// long a start may take before it is a failure" has one answer.

const runtimes = require('./runtimes');

// How long a create waits for a runtime to name the session it started. Codex
// answers `thread/start` in tens of milliseconds once it is up; the time is in
// spawning it and the handshake, a second or two, more on a cold machine.
const MINT_WAIT_MS = 30_000;

/**
 * The id a runtime minted for the session `r` was started for: `{id}`, or
 * `{error, kind, unsent}` when the start failed or took too long.
 */
function mintedId(r, ms = MINT_WAIT_MS) {
    if (!r) return Promise.resolve({ error: 'the session did not start', kind: 'unknown' });
    return new Promise((resolve) => {
        const done = (v) => {
            clearTimeout(timer);
            r.off('minted', onMint);
            r.off('failed', onFail);
            resolve(v);
        };
        const onMint = ({ to }) => done({ id: to });
        const onFail = (f) => done({ error: f.message || 'the session did not start', kind: f.kind, unsent: f.unsent });
        const timer = setTimeout(() => done({
            error: `${r.adapter.product} did not open the conversation within ${Math.round(ms / 1000)}s`,
            kind: 'unknown',
        }), ms);
        r.on('minted', onMint);
        r.on('failed', onFail);
    });
}

/**
 * What `pool.create` returned, with the session's real id once it has one.
 *
 * For a runtime that takes our id this is `out` at once. For one that mints its
 * own it waits, and answers `{out}` with `sessionId` (and `status`) replaced, or
 * `{error, kind, unsent}` — the start failed, and the message it carried is in
 * `unsent` for the caller to hand back rather than lose.
 *
 * @returns {Promise<{out: object} | {error: string, kind: string, unsent: Array}>}
 */
async function settled(pool, out, runtime, ms = MINT_WAIT_MS) {
    if (!runtimes.mintsId(runtime || runtimes.DEFAULT)) return { out };
    const r = pool.get(out.sessionId);
    const got = await mintedId(r, ms);
    if (got.error) return { error: got.error, kind: got.kind || 'unknown', unsent: got.unsent || [] };
    return { out: { ...out, sessionId: got.id, status: r.status() } };
}

module.exports = { MINT_WAIT_MS, mintedId, settled };
