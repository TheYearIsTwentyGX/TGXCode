'use strict';

// Hooks from plugins, skills and agents — bridge/hook-sources.js.
//
// HOME is redirected first: the plugin manifest and `~/.claude/skills` are both
// resolved from it at load.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-sources-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TGXCODE_ROOTS = home;
process.env.TGXCODE_MANAGED_SETTINGS = path.join(home, 'managed-settings.json');

const cfg = require('../bridge/config.js');
const { HookSources, frontmatterHooks } = require('../bridge/hook-sources.js');

assert.ok(cfg.USER_CLAUDE_DIR.startsWith(home), `refusing to run: ${cfg.USER_CLAUDE_DIR} is not inside ${home}`);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };
const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
};

// ── frontmatter ────────────────────────────────────────────────────────────

{
    const text = [
        '---',
        'name: guarded',
        'description: x',
        'hooks:',
        '  PreToolUse:',
        '    - matcher: "Bash"',
        '      hooks:',
        '        - type: command',
        '          command: ./check.sh',
        '  Stop:',
        '    - hooks: []',
        'model: sonnet',
        '---',
        'body',
    ].join('\n');
    const got = frontmatterHooks(text);
    assert.deepStrictEqual(got.events, ['PreToolUse', 'Stop'], 'only the first level under hooks: is an event');
    assert.strictEqual(got.name, 'guarded');
    assert.ok(got.yaml.startsWith('hooks:') && got.yaml.endsWith('    - hooks: []'),
        'the block stops at the next top-level key');
    assert.deepStrictEqual(frontmatterHooks(text, { agent: true }).events, ['PreToolUse', 'SubagentStop'],
        'an agent’s Stop runs as SubagentStop');
    assert.strictEqual(frontmatterHooks('---\nname: a\n---\n'), null);
    assert.strictEqual(frontmatterHooks('no frontmatter\nhooks:\n  Stop:'), null);
    ok('the hooks: block of a frontmatter is found, and its events named');
}

// ── a plugin, a skill, an agent ────────────────────────────────────────────

const pluginDir = path.join(home, '.claude', 'plugins', 'cache', 'm', 'guard', '1.0.0');
write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    plugins: {
        'guard@m': [{ installPath: pluginDir }, { installPath: pluginDir }],
        'quiet@m': [{ installPath: path.join(home, 'nowhere') }],
    },
});
write(path.join(pluginDir, 'hooks', 'hooks.json'), {
    hooks: { SessionStart: [{ matcher: 'startup', hooks: [
        { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" go' },
    ] }] },
});
write(path.join(pluginDir, 'hooks', 'run.sh'), '#!/bin/sh\n');
write(path.join(pluginDir, 'agents', 'reviewer.md'), '---\nname: reviewer\nhooks:\n  Stop:\n    - hooks: []\n---\n');
write(path.join(home, '.claude', 'skills', 'deploy', 'SKILL.md'),
    '---\nname: deploy\nhooks:\n  PostToolUse:\n    - matcher: Bash\n---\n');
write(path.join(home, '.claude', 'skills', 'plain', 'SKILL.md'), '---\nname: plain\n---\n');
const project = path.join(home, 'proj');
write(path.join(project, '.claude', 'agents', 'helper.md'), '---\nhooks:\n  PreToolUse: []\n---\n');

{
    const got = new HookSources().read(project, { 'guard@m': true });
    assert.strictEqual(got.plugins.length, 1, 'a plugin listed twice is read once, and one without hooks is absent');
    const [p] = got.plugins;
    assert.strictEqual(p.id, 'guard@m');
    assert.strictEqual(p.enabled, true);
    assert.strictEqual(p.hooks.length, 1);
    assert.strictEqual(p.hooks[0].event, 'SessionStart');
    assert.strictEqual(p.hooks[0].scope, 'plugin');
    assert.strictEqual(p.hooks[0].script.exists, true, '${CLAUDE_PLUGIN_ROOT} is resolved for the script check');
    ok('a plugin’s hooks.json is read as settings-shaped hook rows');

    assert.deepStrictEqual(got.skills.map(s => [s.name, s.origin, s.events]), [['deploy', 'user', ['PostToolUse']]],
        'a skill without hooks: is not listed');
    const agents = Object.fromEntries(got.agents.map(a => [a.name, a]));
    assert.deepStrictEqual(agents.helper.events, ['PreToolUse']);
    assert.strictEqual(agents.helper.origin, 'project');
    assert.deepStrictEqual(agents.reviewer.events, ['SubagentStop']);
    assert.strictEqual(agents.reviewer.origin, 'plugin:guard@m');
    assert.strictEqual(agents.reviewer.enabled, true);
    ok('skills and agents with hooks: are found at user, project and plugin level');
}

{
    const got = new HookSources().read('', {});
    assert.strictEqual(got.plugins[0].enabled, false, 'absent from enabledPlugins is not enabled');
    assert.ok(!got.agents.some(a => a.origin === 'project'), 'no project, no project agents');
    ok('a plugin not in enabledPlugins is reported disabled');
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${passed} hook-sources checks passed`);
