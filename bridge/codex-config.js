'use strict';

// Codex's own settings and hooks, read and written through Codex — the Codex
// tab of Settings and the Codex side of the Hooks page. Phase 5 of
// docs/plans/23-codex.md.
//
// **We never parse or write TOML.** Every read is `config/read` and every write
// is `config/value/write`, each from a short-lived app-server outside any
// conversation (bridge/codex/client.js `withAppServer`), so `bridge/` keeps its
// no-dependencies rule and the file is only ever edited by the program that
// reads it. Measured on 0.172.0: a write keeps the file's comments and layout,
// `value: null` removes the key, and a bad value is refused with
// `config_write_error_code: configValidationError`.
//
// What that decides:
//
//   - **Only the user's `config.toml` is written.** The app-server refuses any
//     other layer ("Only writes to the user config are allowed"). A project's
//     `.codex/config.toml` is read and reported — a key it overrides says so —
//     and never edited.
//   - **Only catalogued keys are written** (bridge/codex-schema.js), for the
//     reason its header gives.
//   - **No stamp.** A write names one key, Codex reads and rewrites the file
//     itself, and nothing else in it can be reverted by a stale page. The same
//     reasoning claude-config.js uses for a single scalar.
//   - **The values of keys the page has no control for are never sent**, only
//     their names: `config.toml` is where MCP server environments and provider
//     headers live.
//   - **Hooks are read-only.** `hooks/list` says what would run and whether
//     Codex trusts it; trusting one is a decision made in Codex (`/hooks`),
//     not by writing a hash from here.

const path = require('path');

const cfg = require('./config');
const schema = require('./codex-schema');
const { withAppServer } = require('./codex/client');
const { refuse } = require('./jsonfile');

const TIMEOUT_MS = 20_000;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** `a.b` out of an object, `null` where any step is missing. */
function dig(obj, key) {
    let cur = obj;
    for (const part of key.split('.')) {
        if (!isObj(cur) || cur[part] === undefined) return null;
        cur = cur[part];
    }
    return cur;
}

/** A ConfigLayerSource as `{type, file}` — whichever of its paths it has. */
function sourceOf(name) {
    if (!isObj(name)) return null;
    const folder = name.dotCodexFolder ? path.join(name.dotCodexFolder, 'config.toml') : null;
    return { type: name.type || 'unknown', file: name.file || folder };
}

const userFileDefault = () => path.join(cfg.CODEX_HOME, 'config.toml');

/**
 * The page's payload, out of a `config/read` (with layers) and the feature list.
 * Pure, so a test can hand it recorded answers.
 */
function shapeConfig(read, features) {
    const layers = Array.isArray(read.layers) ? read.layers : [];
    const user = layers.find(l => l.name && l.name.type === 'user' && !l.name.profile);
    const userValues = (user && isObj(user.config)) ? user.config : {};
    const effective = read.config || {};
    const origins = read.origins || {};
    const byName = new Map((features || []).map(f => [f.name, f]));

    const row = (entry) => {
        const origin = origins[entry.key] ? sourceOf(origins[entry.key].name) : null;
        return {
            key: entry.key, kind: entry.kind, label: entry.label, note: entry.note || null,
            ...(entry.options && { options: entry.options.map(([value, label]) => ({ value, label })) }),
            user: dig(userValues, entry.key),
            effective: dig(effective, entry.key),
            origin,
        };
    };

    const groups = schema.GROUPS.map(g => ({ title: g.title, keys: g.keys.map(row) }));
    const flags = schema.FEATURES.filter(f => byName.has(f.name)).map((f) => {
        const r = row(schema.entryFor(schema.featureKey(f.name)));
        const live = byName.get(f.name);
        // `config.features` carries only some flags; the list says what is on.
        if (r.effective === null) r.effective = !!live.enabled;
        return { ...r, default: !!live.defaultEnabled, stage: live.stage || null };
    });
    if (flags.length) groups.push({ title: 'Features', keys: flags });

    const catalogued = new Set(groups.flatMap(g => g.keys.map(k => k.key)));
    const otherKeys = [];
    for (const [k, v] of Object.entries(userValues)) {
        if (k === 'features' && isObj(v)) {
            for (const name of Object.keys(v)) {
                if (!catalogued.has(`features.${name}`)) otherKeys.push(`features.${name}`);
            }
        } else if (!catalogued.has(k)) otherKeys.push(k);
    }

    return {
        file: (user && user.name.file) || userFileDefault(),
        groups,
        otherKeys: otherKeys.sort(),
        // Project layers that exist for the directory asked about, and why one
        // is ignored (Codex does not read an untrusted project's file).
        projectLayers: layers.filter(l => l.name && l.name.type === 'project').map(l => ({
            file: sourceOf(l.name).file,
            disabled: l.disabledReason || null,
        })),
    };
}

/** `hooks/list`'s answer for one directory, as the Hooks page draws it. */
function shapeHooks(result) {
    const entry = (result && Array.isArray(result.data) && result.data[0]) || {};
    const hooks = (entry.hooks || []).slice()
        .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
        .map(h => ({
            key: h.key,
            event: h.eventName,
            handler: h.handlerType,
            command: h.handlerType === 'command' ? h.command
                : h.handlerType === 'mcpTool' ? `${h.server}.${h.tool}` : null,
            matcher: h.matcher || null,
            timeoutSec: typeof h.timeoutSec === 'number' ? h.timeoutSec : null,
            statusMessage: h.statusMessage || null,
            source: h.source || 'unknown',
            file: h.sourcePath || null,
            pluginId: h.pluginId || null,
            enabled: h.enabled !== false,
            trust: h.trustStatus || null,
            managed: !!h.isManaged,
        }));
    return {
        hooks,
        warnings: (entry.warnings || []).map(String),
        errors: (entry.errors || []).map(e => ({ file: e.path || null, message: String(e.message || '') })),
    };
}

/** A refusal from the app-server, in this bridge's codes. */
function writeRefusal(err) {
    const code = err && err.data && err.data.config_write_error_code;
    const message = String((err && err.message) || 'refused').replace(/^config\/value\/write: /, '');
    if (code === 'configValidationError' || code === 'configPathNotFound') return refuse('value', message);
    if (code === 'configVersionConflict') return refuse('stale', message);
    if (code === 'configLayerReadonly') return refuse('readonly', message);
    return refuse(code ? 'write' : 'codex', message);
}

/** A directory the project layers may be read from, or null. */
const projectDir = (dir) => (dir && cfg.withinRoots(dir) ? path.resolve(cfg.expandHome(dir)) : null);

async function readWith(rpc, cwd) {
    const read = await rpc.request('config/read', { includeLayers: true, ...(cwd && { cwd }) });
    const features = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
        const r = await rpc.request('experimentalFeature/list', { limit: 200, ...(cursor && { cursor }) });
        features.push(...(r.data || []));
        cursor = r.nextCursor || null;
        if (!cursor) break;
    }
    return { ...shapeConfig(read, features), againstVersion: schema.AGAINST_VERSION };
}

class CodexConfig {
    /**
     * @param {object} [o]
     * @param {(fn: (rpc) => Promise<any>) => Promise<any>} [o.server]  for tests
     */
    constructor({ server = (fn) => withAppServer(fn, { timeoutMs: TIMEOUT_MS }) } = {}) {
        this.server = server;
    }

    /** The settings, with the project layers of `dir` when it has some. */
    read(dir) {
        return this.server((rpc) => readWith(rpc, projectDir(dir)));
    }

    /**
     * Set one catalogued key in the user's config.toml, or remove it (`null`).
     * Resolves the fresh read plus `written` and, when a stronger layer still
     * decides the key, `overridden` with Codex's sentence about it.
     */
    async save({ key, value, dir }) {
        const entry = typeof key === 'string' ? schema.entryFor(key) : null;
        if (!entry) throw refuse('key', `${JSON.stringify(key)} is not a setting this page writes`);
        if (value === undefined || !schema.valid(entry, value)) {
            throw refuse('value', `${JSON.stringify(value)} is not a value ${key} takes`);
        }
        return this.server(async (rpc) => {
            let answer;
            try {
                answer = await rpc.request('config/value/write',
                    { keyPath: key, value, mergeStrategy: 'replace' });
            } catch (err) {
                throw writeRefusal(err);
            }
            const over = answer.overriddenMetadata;
            return {
                written: answer.filePath || userFileDefault(),
                overridden: answer.status === 'okOverridden' && over ? String(over.message || '') : null,
                ...(await readWith(rpc, projectDir(dir))),
            };
        });
    }

    /**
     * What would run in `dir`. With no usable directory, what runs anywhere:
     * asked about the home directory, which has no project layer of its own.
     */
    hooks(dir) {
        const cwd = projectDir(dir) || cfg.HOME;
        return this.server(async (rpc) => ({
            cwd, ...shapeHooks(await rpc.request('hooks/list', { cwds: [cwd] })),
        }));
    }
}

module.exports = { CodexConfig, shapeConfig, shapeHooks, writeRefusal };
