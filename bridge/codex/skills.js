'use strict';

// The slash palette for a Codex session: Codex's skills, from Codex itself.
//
// Codex has no `init.slash_commands`; custom prompts were removed in March 2026,
// and what is left to invoke by name is skills (docs/plans/23-codex.md, Phase 4).
// `skills/list {cwds}` answers per directory with every skill that applies there
// — the repo's (`.agents/skills`, `.codex/skills`), the user's, the admin's and
// Codex's own `system` ones — each with a name, a description, a scope and the
// path of its SKILL.md. So, as bridge/codex/models.js does for the model list,
// this asks a short-lived `codex app-server` outside any conversation and caches
// the answer per directory.
//
// What a client gets is `/api/slash-commands`' shape (bridge/slash-commands.js):
// `{cwd, commands: [{name, description, scope}], at, exact: true, source:
// "codex"}`. A disabled skill is left out, as Claude's `terminal_slash_commands`
// are.
//
// **A chosen skill goes to Codex as a skill input**, not as text. The composer
// sends `/name args` for either runtime; the process adapter looks the name up
// here (`lookup`, from the cache the palette just filled) and sends
// `{type:"skill", name, path}` beside the text `$name args`, which is how
// Codex's own clients write a skill mention. A name this cache does not know is
// sent as typed: `/tmp/x is broken` is a sentence, not a command.

const { spawnAppServer, initialize } = require('./client');

const FRESH_MS = 30_000;
const FAILED_MS = 60_000;
const TIMEOUT_MS = 15_000;
const MAX_DIRS = 50;

/** cwd -> {at, ok, value} */
const cache = new Map();
/** cwd -> Promise */
const inflight = new Map();

/** A palette row's description: the short one when a skill has one. */
function describe(s) {
    const short = (s.interface && s.interface.shortDescription) || s.shortDescription || '';
    const text = String(short || s.description || '').trim();
    const line = text.split('\n')[0];
    return line.length > 200 ? line.slice(0, 199) + '…' : line;
}

/** `skills/list`'s answer for one directory, as the palette's rows plus the paths. */
function shape(cwd, data) {
    const entry = (data || []).find(d => d && d.cwd === cwd) || (data || [])[0] || { skills: [] };
    const seen = new Set();
    const skills = [];
    for (const s of entry.skills || []) {
        if (!s || !s.name || s.enabled === false || seen.has(s.name)) continue;
        seen.add(s.name);
        skills.push({ name: String(s.name), description: describe(s), scope: s.scope || null, path: s.path || null });
    }
    return skills;
}

async function ask(cwd) {
    const { child, rpc } = spawnAppServer({ cwd, timeoutMs: TIMEOUT_MS });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, TIMEOUT_MS + 2000);
    killer.unref();
    try {
        await initialize(rpc);
        const r = await rpc.request('skills/list', { cwds: [cwd] });
        return shape(cwd, r && r.data);
    } finally {
        clearTimeout(killer);
        try { child.stdin.end(); } catch { /* closed */ }
        setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, 500).unref();
    }
}

/** What `/api/slash-commands` answers for a Codex directory. */
function out(cwd, hit) {
    return {
        cwd,
        at: hit.at,
        exact: hit.ok,
        source: 'codex',
        commands: hit.value.map(({ name, description, scope }) => ({
            name, ...(description && { description }), ...(scope && { scope }),
        })),
        ...(hit.error && { error: hit.error }),
    };
}

/**
 * The palette for `cwd`, from cache when it is fresh. Never rejects: a Codex
 * that could not be asked is an empty list with `error`, cached for a minute.
 */
async function list(cwd, { refresh = false } = {}) {
    const hit = cache.get(cwd);
    if (!refresh && hit && Date.now() - hit.at < (hit.ok ? FRESH_MS : FAILED_MS)) return out(cwd, hit);
    if (inflight.has(cwd)) return inflight.get(cwd);
    const p = ask(cwd).then((value) => ({ at: Date.now(), ok: true, value }), (err) => ({
        at: Date.now(), ok: false, value: hit && hit.ok ? hit.value : [],
        error: `Codex could not list its skills: ${err.message}`,
    })).then((rec) => {
        cache.delete(cwd);
        cache.set(cwd, rec);
        while (cache.size > MAX_DIRS) cache.delete(cache.keys().next().value);
        return out(cwd, rec);
    }).finally(() => inflight.delete(cwd));
    inflight.set(cwd, p);
    return p;
}

/** `{name, path}` for a skill `cwd`'s cached list has, or null. Synchronous. */
function lookup(cwd, name) {
    const hit = cache.get(cwd);
    const s = hit && hit.value.find(x => x.name === name);
    return s && s.path ? { name: s.name, path: s.path } : null;
}

/** For tests: put a directory's list in the cache as if Codex had answered. */
function prime(cwd, data) {
    cache.set(cwd, { at: Date.now(), ok: true, value: shape(cwd, data) });
}

module.exports = { list, lookup, shape, prime };
