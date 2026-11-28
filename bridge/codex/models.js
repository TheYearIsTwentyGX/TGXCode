'use strict';

// The models a Codex session may be started on, from Codex itself.
//
// **Never hard-coded** (docs/plans/23-codex.md, Phase 3). Which models there are,
// and which is the default, depends on the account and moves between Codex
// versions: signed out the default was `gpt-6.2-sol` on 0.172.0, and on a
// ChatGPT Free account `gpt-6-luna`. A turn naming a model the account cannot use
// fails late, at the end of the turn rather than at `turn/start`, so a picker
// with the wrong list in it is worse than no picker.
//
// So this asks: a short-lived `codex app-server` outside any conversation
// (bridge/codex/client.js), the handshake, `model/list` page by page, and exit.
// The answer is cached, because the pickers ask on every dialog open and a
// spawn costs a second; and a failure is cached for less, so a Codex that is not
// installed is not spawned on every keystroke, and one installed since is seen
// within a minute.
//
// What clients get is `{models: [{id, label, note, default, efforts,
// defaultEffort, images}], efforts}` — the shape bridge/models.js gives for
// Claude, plus the per-model effort list Codex has and Claude does not.
// `efforts` at the top is every level any model offers, for a picker that is
// drawn before a model is chosen. docs/api.md §`GET /api/models`.

const { spawnAppServer, initialize } = require('./client');

const FRESH_MS = 10 * 60_000;
const FAILED_MS = 60_000;
const TIMEOUT_MS = 15_000;

let cache = null;          // {at, ok, value}
let inflight = null;

function shape(data) {
    const models = data.filter(m => m && !m.hidden).map(m => ({
        id: m.id || m.model,
        label: m.displayName || m.id,
        note: m.description || '',
        default: !!m.isDefault,
        efforts: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort).filter(Boolean),
        defaultEffort: m.defaultReasoningEffort || null,
        images: !Array.isArray(m.inputModalities) || m.inputModalities.includes('image'),
    }));
    const efforts = [];
    for (const m of models) for (const e of m.efforts) if (!efforts.includes(e)) efforts.push(e);
    return { models, efforts };
}

async function ask() {
    const { child, rpc } = spawnAppServer({ timeoutMs: TIMEOUT_MS });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, TIMEOUT_MS + 2000);
    killer.unref();
    try {
        await initialize(rpc);
        const data = [];
        let cursor = null;
        for (let page = 0; page < 10; page++) {
            const r = await rpc.request('model/list', cursor ? { cursor } : {});
            data.push(...(r.data || []));
            cursor = r.nextCursor || null;
            if (!cursor) break;
        }
        return shape(data);
    } finally {
        clearTimeout(killer);
        try { child.stdin.end(); } catch { /* closed */ }
        setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, 500).unref();
    }
}

/**
 * The list, from cache when it is fresh. Resolves `{models, efforts}`, or
 * `{models: [], efforts: [], error}` when Codex could not be asked.
 */
async function list({ refresh = false } = {}) {
    const age = cache ? Date.now() - cache.at : Infinity;
    if (!refresh && cache && age < (cache.ok ? FRESH_MS : FAILED_MS)) return cache.value;
    if (inflight) return inflight;
    inflight = ask().then((value) => {
        cache = { at: Date.now(), ok: true, value };
        return value;
    }, (err) => {
        const value = { models: [], efforts: [], error: `Codex could not list its models: ${err.message}` };
        cache = { at: Date.now(), ok: false, value };
        return value;
    }).finally(() => { inflight = null; });
    return inflight;
}

/**
 * The list as last fetched, or null when it never has been or the last ask
 * failed. Synchronous, for a caller that cannot wait — an orchestrator's brief is
 * written as its process starts — and that says something else when it is null.
 */
function cached() {
    return cache && cache.ok ? cache.value : null;
}

module.exports = { list, shape, cached };
