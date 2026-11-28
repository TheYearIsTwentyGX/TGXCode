'use strict';

// Codex's settings and memory files — bridge/codex-config.js, bridge/codex-schema.js,
// the AGENTS.md half of bridge/claude-docs.js, and the `/api/codex-config` routes'
// answers.
//
// No Codex and no real home. The app-server is a stand-in answering in the shapes
// measured on 0.172.0 (a `config/read` with layers and origins, a `hooks/list`,
// the refusals `config/value/write` makes); HOME and CODEX_HOME are redirected
// before anything is required, because bridge/config.js resolves both at load
// and the docs module writes under them.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-test-'));
const codexHome = path.join(home, '.codex');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODEX_HOME = codexHome;
process.env.TGXCODE_ROOTS = home;
process.env.XDG_DATA_HOME = path.join(home, 'data');
process.env.XDG_CACHE_HOME = path.join(home, 'cache');

const cfg = require('../bridge/config.js');
const schema = require('../bridge/codex-schema.js');
const { CodexConfig, shapeConfig, shapeHooks, writeRefusal } = require('../bridge/codex-config.js');
const { ClaudeDocs } = require('../bridge/claude-docs.js');
const { RpcError } = require('../bridge/codex/rpc.js');

assert.ok(cfg.CODEX_HOME.startsWith(home), `refusing to run: ${cfg.CODEX_HOME} is not inside ${home}`);
assert.ok(cfg.USER_CLAUDE_MEMORY.startsWith(home), 'refusing to run: HOME did not take');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };
const codeOf = (fn) => { try { fn(); return null; } catch (err) { return err.code || 'no-code'; } };

const project = path.join(home, 'proj');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
const userToml = path.join(codexHome, 'config.toml');

const read = {
    config: { model: 'gpt-x', model_reasoning_effort: 'low', approval_policy: null, web_search: null,
        features: { goals: false }, mcp_servers: { secret: { env: { KEY: 'sk-do-not-send' } } } },
    origins: {
        model: { name: { type: 'user', file: userToml, profile: null }, version: 'sha256:a' },
        model_reasoning_effort: {
            name: { type: 'project', dotCodexFolder: path.join(project, '.codex') }, version: 'sha256:b' },
    },
    layers: [
        { name: { type: 'project', dotCodexFolder: path.join(project, '.codex') }, version: 'sha256:b',
            config: { model_reasoning_effort: 'low' } },
        { name: { type: 'user', file: userToml, profile: null }, version: 'sha256:a',
            config: { model: 'gpt-x', features: { goals: false, made_up: true },
                mcp_servers: { secret: { env: { KEY: 'sk-do-not-send' } } } } },
    ],
};
const features = [
    { name: 'goals', enabled: false, defaultEnabled: true, stage: 'stable' },
    { name: 'memories', enabled: false, defaultEnabled: false, stage: 'stable' },
    { name: 'something_uncatalogued', enabled: true, defaultEnabled: true, stage: 'stable' },
];

// ── the read ───────────────────────────────────────────────────────────────

{
    const out = shapeConfig(read, features);
    const keys = new Map(out.groups.flatMap(g => g.keys).map(k => [k.key, k]));
    assert.strictEqual(out.file, userToml);
    assert.deepStrictEqual([keys.get('model').user, keys.get('model').effective], ['gpt-x', 'gpt-x']);
    const effort = keys.get('model_reasoning_effort');
    assert.deepStrictEqual([effort.user, effort.effective, effort.origin.type], [null, 'low', 'project']);
    assert.strictEqual(effort.origin.file, path.join(project, '.codex', 'config.toml'),
        'a project layer names its folder; the row names the file');
    ok('a key says what your file has, what is in force and which file decided');

    assert.deepStrictEqual(out.groups.find(g => g.title === 'Features').keys.map(k => k.key),
        ['features.goals', 'features.memories'],
        'only catalogued flags Codex still reports');
    assert.deepStrictEqual([keys.get('features.goals').user, keys.get('features.goals').default],
        [false, true]);
    assert.strictEqual(keys.get('features.memories').effective, false,
        'a flag config/read does not carry takes the feature list’s answer');
    ok('features come from the catalogue and the live list together');

    assert.deepStrictEqual(out.otherKeys, ['features.made_up', 'mcp_servers']);
    assert.ok(!JSON.stringify(out).includes('sk-do-not-send'),
        'the values of keys with no control never leave the bridge');
    ok('other keys are named and their values withheld');
}

// ── the write ──────────────────────────────────────────────────────────────

function standIn({ refuse = null, overridden = null } = {}) {
    const calls = [];
    const rpc = {
        async request(method, params) {
            calls.push([method, params]);
            if (method === 'config/read') return read;
            if (method === 'experimentalFeature/list') return { data: features, nextCursor: null };
            if (method === 'config/value/write') {
                if (refuse) throw refuse;
                return { status: overridden ? 'okOverridden' : 'ok', filePath: userToml, version: 'sha256:c',
                    overriddenMetadata: overridden ? { message: overridden } : null };
            }
            if (method === 'hooks/list') return { data: [{ cwd: params.cwds[0], hooks: [], warnings: [], errors: [] }] };
            throw new Error(`unexpected ${method}`);
        },
    };
    return { calls, config: new CodexConfig({ server: (fn) => fn(rpc) }) };
}

(async () => {
    {
        const { calls, config } = standIn();
        const out = await config.save({ key: 'features.goals', value: true, dir: project });
        assert.deepStrictEqual(calls[0],
            ['config/value/write', { keyPath: 'features.goals', value: true, mergeStrategy: 'replace' }]);
        assert.deepStrictEqual(calls[1], ['config/read', { includeLayers: true, cwd: project }]);
        assert.strictEqual(out.written, userToml);
        assert.strictEqual(out.overridden, null);
        assert.ok(out.groups.length, 'the fresh read rides back with the write');
        ok('a save writes one key and answers with a fresh read');

        calls.length = 0;
        await config.save({ key: 'model', value: null });
        assert.deepStrictEqual(calls[0][1], { keyPath: 'model', value: null, mergeStrategy: 'replace' });
        assert.deepStrictEqual(calls[1][1], { includeLayers: true }, 'no directory, no project layers');
        ok('null removes a key');
    }

    {
        const { calls, config } = standIn();
        for (const [key, value, code] of [
            ['features.nonsense', true, 'key'],          // Codex itself would take this one
            ['mcp_servers', {}, 'key'],
            [undefined, 1, 'key'],
            ['web_search', 'sometimes', 'value'],
            ['features.goals', 'yes', 'value'],
            ['model', 'a b', 'value'],
            ['model', undefined, 'value'],
        ]) {
            await assert.rejects(config.save({ key, value }), (e) => e.code === code, `${key}=${value}`);
        }
        assert.deepStrictEqual(calls, [], 'a refused value never reaches Codex');
        ok('only catalogued keys and their own kinds of value are written');
    }

    {
        const rpcErr = (c) => new RpcError(-32600, 'config/value/write: nope', { config_write_error_code: c });
        assert.deepStrictEqual(['configValidationError', 'configVersionConflict', 'configLayerReadonly']
            .map(c => writeRefusal(rpcErr(c)).code), ['value', 'stale', 'readonly']);
        assert.strictEqual(writeRefusal(rpcErr('configValidationError')).message, 'nope');
        assert.strictEqual(writeRefusal(new Error('exited 1')).code, 'codex');
        const { config } = standIn({ refuse: rpcErr('configValidationError') });
        await assert.rejects(config.save({ key: 'model', value: 'x' }), (e) => e.code === 'value');
        const over = await standIn({ overridden: 'a project sets it' }).config.save({ key: 'model', value: 'x' });
        assert.strictEqual(over.overridden, 'a project sets it');
        ok('Codex’s refusals become the bridge’s codes, and an override is said');
    }

    // ── hooks ──────────────────────────────────────────────────────────────

    {
        const shaped = shapeHooks({ data: [{ cwd: project, warnings: ['w'],
            errors: [{ path: '/x/hooks.json', message: 'bad' }],
            hooks: [
                { key: 'b', eventName: 'stop', handlerType: 'mcpTool', server: 's', tool: 't', displayOrder: 1,
                    enabled: true, trustStatus: 'trusted', source: 'project', sourcePath: '/p', timeoutSec: 5 },
                { key: 'a', eventName: 'preToolUse', handlerType: 'command', command: 'x.sh', matcher: 'Bash',
                    displayOrder: 0, enabled: false, trustStatus: 'untrusted', source: 'user', sourcePath: '/u',
                    isManaged: false },
            ] }] });
        assert.deepStrictEqual(shaped.hooks.map(h => [h.key, h.command, h.trust, h.enabled]),
            [['a', 'x.sh', 'untrusted', false], ['b', 's.t', 'trusted', true]]);
        assert.deepStrictEqual(shaped.errors, [{ file: '/x/hooks.json', message: 'bad' }]);
        const { calls, config } = standIn();
        assert.strictEqual((await config.hooks(project)).cwd, project);
        assert.strictEqual((await config.hooks('/etc')).cwd, home, 'a directory outside the roots is not asked about');
        assert.deepStrictEqual(calls.map(c => c[1].cwds), [[project], [home]]);
        ok('hooks are listed in order with their trust, for a directory we may read');
    }

    // ── AGENTS.md ──────────────────────────────────────────────────────────

    {
        const docs = new ClaudeDocs({ kinds: ['claude-md', 'agents-md'] });
        const rows = docs.read(project).docs;
        assert.deepStrictEqual(rows.map(r => r.id),
            ['claude-md:user', 'claude-md:project', 'agents-md:user', 'agents-md:project']);
        assert.strictEqual(rows[2].file, path.join(codexHome, 'AGENTS.md'), 'the user file is in CODEX_HOME');
        assert.strictEqual(rows[3].file, path.join(project, 'AGENTS.md'));
        assert.deepStrictEqual(docs.read('').docs.map(r => r.id), ['claude-md:user', 'agents-md:user']);
        assert.deepStrictEqual(new ClaudeDocs().read(project).docs.map(r => r.kind), ['claude-md', 'claude-md'],
            'an instance serves only what it was built with');
        ok('AGENTS.md is listed beside CLAUDE.md, user and project');

        docs.save({ kind: 'agents-md', scope: 'user', stamp: null, text: '# codex\n' });
        docs.save({ kind: 'agents-md', scope: 'project', dir: project, stamp: null, text: '# proj\n' });
        assert.strictEqual(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), '# codex\n');
        assert.strictEqual(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), '# proj\n');
        assert.ok(!fs.existsSync(path.join(project, 'CLAUDE.md')), 'the other file is not touched');
        assert.strictEqual(codeOf(() => docs.save({ kind: 'agents-md', scope: 'user', stamp: null, text: 'x' })), 'exists');
        assert.strictEqual(codeOf(() => docs.save({ kind: 'readme', scope: 'user', stamp: null, text: 'x' })), 'kind');
        assert.strictEqual(codeOf(() => docs.save({ kind: '__proto__', scope: 'user', stamp: null, text: 'x' })), 'kind');
        assert.strictEqual(codeOf(() => new ClaudeDocs().save(
            { kind: 'agents-md', scope: 'user', stamp: null, text: 'x' })), 'kind');
        ok('a write names its file and keeps the stamp rule');

        const over = path.join(project, 'AGENTS.override.md');
        const row = () => docs.read(project).docs.find(r => r.id === 'agents-md:project');
        fs.writeFileSync(over, '');
        assert.strictEqual(row().overriddenBy, null, 'an empty override overrides nothing');
        fs.writeFileSync(over, 'instead\n');
        assert.strictEqual(row().overriddenBy, over);
        ok('an AGENTS.override.md beside the file is said');
    }

    assert.ok(schema.entryFor('features.goals') && !schema.entryFor('features.made_up'));
    console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
