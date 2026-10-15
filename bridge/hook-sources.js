'use strict';

// Hooks that do not live in a settings file — plugins, skills and agents.
//
// Claude Code runs hooks from more places than the four files
// bridge/claude-config.js reads: an enabled plugin's `hooks/hooks.json`, a
// skill's frontmatter for the rest of the session once it is invoked, and a
// subagent's frontmatter while it runs. The Hooks page lists them so that
// "why did something run on SessionStart?" has an answer on the page that is
// supposed to answer it. All of it is read-only: these files belong to the
// plugin or to whoever wrote the skill, and editing a plugin's cache directory
// is an edit the next plugin update throws away.
//
// Plugins are read properly — `hooks.json` is JSON in the settings shape, so
// each row goes through hookSummary() and looks exactly like a settings hook.
//
// Skills and agents are not, and that is a decision rather than a gap. Their
// hooks are YAML in frontmatter, this bridge has no dependencies, and a YAML
// parser is not "a smaller amount of code". So the block is returned as the
// author wrote it, plus the event names found by scanning the keys one level
// under `hooks:` — enough to count and file it under the right event, without
// pretending to know its matchers. bridge/slash-commands.js made the same
// trade for `description`.

const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const { hookSummary } = require('./claude-config');
const { isPlainObject } = require('./claude-schema');
const { readJson } = require('./jsonfile');
const { pluginRoots } = require('./slash-commands');

/** How much of a skill or agent file is read looking for frontmatter. */
const HEAD_BYTES = 8192;

/** The same short cache claude-config keeps; these files change on install, not per keystroke. */
const CACHE_MS = 5000;

/** Skills directories hold one directory per skill; agents, one file per agent. */
const SKILL_FILE = 'SKILL.md';

function head(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(HEAD_BYTES);
        const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
        return buf.slice(0, n).toString('utf8');
    } catch { return null; } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already gone */ }
    }
}

/**
 * The `hooks:` block of a frontmatter, as written, and the events it names.
 *
 * `null` when there is no frontmatter or no `hooks:` key in it. The block runs
 * from `hooks:` to the next line that is not indented (the next top-level key)
 * or the end of the frontmatter. Events are the keys at the first indentation
 * level below it — `  PreToolUse:` — and nothing deeper is interpreted.
 *
 * @param {string} text the start of the file
 * @param {{agent?: boolean}} [opts] an agent's `Stop` runs as `SubagentStop`
 * @returns {{yaml: string, events: string[], name: string|null}|null}
 */
function frontmatterHooks(text, { agent = false } = {}) {
    if (typeof text !== 'string') return null;
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ''));
    if (!m) return null;
    const lines = m[1].split(/\r?\n/);
    const nameLine = lines.find(l => /^name\s*:/.test(l));
    const name = nameLine ? nameLine.replace(/^name\s*:\s*/, '').trim().replace(/^["'](.*)["']$/, '$1') : null;

    const start = lines.findIndex(l => /^hooks\s*:/.test(l));
    if (start < 0) return null;
    const block = [lines[start]];
    for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i].trim() && !/^\s/.test(lines[i])) break;
        block.push(lines[i]);
    }
    while (block.length > 1 && !block[block.length - 1].trim()) block.pop();

    // The first indented key sets the level; only keys at that level are events.
    let indent = null;
    const events = [];
    for (const line of block.slice(1)) {
        const k = /^(\s+)([A-Za-z][A-Za-z]*)\s*:/.exec(line);
        if (!k) continue;
        if (indent === null) indent = k[1].length;
        if (k[1].length !== indent) continue;
        const event = agent && k[2] === 'Stop' ? 'SubagentStop' : k[2];
        if (!events.includes(event)) events.push(event);
    }
    return { yaml: block.join('\n'), events, name };
}

/** `<root>/skills/<name>/SKILL.md` and `<root>/agents/*.md`, with hooks. */
function scanRoot(root, origin) {
    const skills = [];
    const agents = [];
    let items;
    try { items = fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true }); } catch { items = []; }
    for (const item of items) {
        if (!item.isDirectory()) continue;
        const file = path.join(root, 'skills', item.name, SKILL_FILE);
        const got = frontmatterHooks(head(file));
        if (got) skills.push({ name: got.name || item.name, file, origin, events: got.events, yaml: got.yaml });
    }
    try { items = fs.readdirSync(path.join(root, 'agents'), { withFileTypes: true }); } catch { items = []; }
    for (const item of items) {
        if (!item.isFile() || !item.name.endsWith('.md')) continue;
        const file = path.join(root, 'agents', item.name);
        const got = frontmatterHooks(head(file), { agent: true });
        if (got) {
            agents.push({ name: got.name || item.name.slice(0, -3), file, origin, events: got.events, yaml: got.yaml });
        }
    }
    return { skills, agents };
}

/**
 * Put `${CLAUDE_PLUGIN_ROOT}` back in the commands, so the script check can
 * find a plugin's script. Claude Code substitutes it before running, and a
 * summary that left it in would report every plugin script as unresolvable.
 */
function withPluginRoot(hooks, root) {
    const sub = (s) => s.replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?/g, root);
    const out = {};
    for (const [event, groups] of Object.entries(hooks)) {
        out[event] = Array.isArray(groups) ? groups.map(g => (isPlainObject(g) && Array.isArray(g.hooks)
            ? { ...g, hooks: g.hooks.map(h => (isPlainObject(h) && typeof h.command === 'string'
                ? { ...h, command: sub(h.command) } : h)) }
            : g)) : groups;
    }
    return out;
}

class HookSources {
    constructor() { this.cache = new Map(); }

    /**
     * Every hook outside the settings files that could run in `dir`.
     *
     * @param {string} dir a workspace, or '' for the user level alone
     * @param {Record<string, boolean>} [enabledPlugins] the effective map; a
     *   plugin absent from it is reported as not enabled, which is what
     *   Claude Code does with it
     */
    read(dir, enabledPlugins = {}) {
        const key = `${dir || ''}\n${JSON.stringify(enabledPlugins || {})}`;
        const hit = this.cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

        const plugins = [];
        const skills = [];
        const agents = [];
        const add = (got) => { skills.push(...got.skills); agents.push(...got.agents); };

        add(scanRoot(cfg.USER_CLAUDE_DIR, 'user'));
        if (dir && cfg.withinRoots(dir)) {
            add(scanRoot(path.join(path.resolve(cfg.expandHome(dir)), cfg.CLAUDE_DIR), 'project'));
        }

        for (const [root, name, id] of pluginRoots()) {
            const enabled = !!(enabledPlugins && enabledPlugins[id]);
            const file = path.join(root, 'hooks', 'hooks.json');
            const { data, problem } = readJson(file);
            if (data && isPlainObject(data.hooks)) {
                plugins.push({
                    id, name, enabled, file,
                    hooks: hookSummary(withPluginRoot(data.hooks, root), { scope: 'plugin', file, projectDir: dir }),
                });
            } else if (problem) {
                plugins.push({ id, name, enabled, file, hooks: [], problem: problem.message });
            }
            const got = scanRoot(root, `plugin:${id}`);
            for (const s of [...got.skills, ...got.agents]) s.enabled = enabled;
            add(got);
        }

        const value = { plugins, skills, agents };
        this.cache.set(key, { at: Date.now(), value });
        if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value);
        return value;
    }
}

module.exports = { HookSources, frontmatterHooks, scanRoot };
