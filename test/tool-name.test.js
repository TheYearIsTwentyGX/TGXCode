'use strict';

// A tool's name as a person reads it — web/tool-name.js and bridge/tool-name.js.
//
// No bridge needed. The two files are the same function in the two module
// systems, so every case runs through both and the last check is that they
// agree on all of them: the bridge's copy is what the activity line and the
// phone show, the web's is what the transcript shows, and a session whose rail
// said one name and whose transcript said another would look like two tools.

const assert = require('assert');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

process.removeAllListeners('warning');

const CASES = [
    // Our own server, with its branding.
    ['mcp__tgxcode__set_summary', 'TGXCode: Set Summary'],
    ['mcp__tgxcode__report_to_orchestrator', 'TGXCode: Report To Orchestrator'],
    // A server with underscores of its own: split on the first `__` only.
    ['mcp__claude_ai_Claude_Docs__batch', 'Claude Docs: Batch'],
    ['mcp__claude_ai_Some_Connector__do_thing', 'Some Connector: Do Thing'],
    // A plugin's server loses its `plugin_<x>_` prefix.
    ['mcp__plugin_design_figma__get_file', 'Figma: Get File'],
    ['mcp__plugin_engineering_datadog__query_metrics', 'Datadog: Query Metrics'],
    ['mcp__plugin_data_amplitude-eu__run_query', 'Amplitude EU: Run Query'],
    // camelCase and kebab-case tools.
    ['mcp__tgxcode__getUsage', 'TGXCode: Get Usage'],
    ['mcp__my-server__list-open-items', 'My Server: List Open Items'],
    // Acronyms stay upper case, a plural keeps its `s`, an all-caps word stays.
    ['mcp__tgxcode__install_on_phone_apk', 'TGXCode: Install On Phone APK'],
    ['mcp__github__get_pr_url', 'GitHub: Get PR URL'],
    ['mcp__github__list_prs', 'GitHub: List PRs'],
    ['mcp__tgxcode__fetchApiId', 'TGXCode: Fetch API ID'],
    ['mcp__AWS_tools__describe', 'AWS Tools: Describe'],
    // Built-ins and anything not shaped like an MCP name come back as they are.
    ['Bash', 'Bash'],
    ['Read', 'Read'],
    ['ExitPlanMode', 'ExitPlanMode'],
    ['mcp__nodelimiter', 'mcp__nodelimiter'],
    ['mcp__server__', 'mcp__server__'],
    ['', ''],
    [null, null],
    [undefined, undefined],
];

(async () => {
    const web = (await import('../web/tool-name.js')).toolDisplayName;
    const bridge = require('../bridge/tool-name.js').toolDisplayName;

    for (const [raw, want] of CASES) {
        assert.strictEqual(web(raw), want, `web: ${raw}`);
        assert.strictEqual(bridge(raw), want, `bridge: ${raw}`);
    }
    ok(`${CASES.length} names read the same in both copies`);

    // Drawing an already friendly name again changes nothing, so a surface that
    // gets a display name from the bridge can pass it through the helper safely.
    for (const [raw] of CASES) {
        if (typeof raw !== 'string') continue;
        assert.strictEqual(web(web(raw)), web(raw), `idempotent: ${raw}`);
    }
    ok('the helper is idempotent');

    // The bridge's activity line for an MCP tool.
    const { describeTool } = require('../bridge/transcript.js');
    assert.strictEqual(describeTool({ name: 'mcp__tgxcode__set_summary', input: {} }),
        'Running TGXCode: Set Summary');
    assert.strictEqual(describeTool({ name: 'Read', input: { file_path: '/a/b.js' } }), 'Reading b.js');
    ok('the activity line uses the friendly name');

    // Names inside a sentence the CLI or the bridge wrote.
    const webIn = (await import('../web/tool-name.js')).toolNamesIn;
    const bridgeIn = require('../bridge/tool-name.js').toolNamesIn;
    for (const [raw, want] of [
        ['Permission to use mcp__tgxcode__next_message has been denied.',
            'Permission to use TGXCode: Next Message has been denied.'],
        ['mcp__github__list_prs ×3 · Bash', 'GitHub: List PRs ×3 · Bash'],
        ['no tools here', 'no tools here'],
        ['', ''],
        [null, null],
    ]) {
        assert.strictEqual(webIn(raw), want, `web: ${raw}`);
        assert.strictEqual(bridgeIn(raw), want, `bridge: ${raw}`);
    }
    ok('tool names inside text are drawn friendly');

    // The two files must stay the same function: compare their bodies.
    const fs = require('fs');
    const path = require('path');
    const body = (f) => {
        const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        return s.slice(s.indexOf('// Servers whose'), s.indexOf('module.exports') >= 0 ? s.indexOf('module.exports') : undefined)
            .replace(/export function/g, 'function').trim();
    };
    assert.strictEqual(body('bridge/tool-name.js'), body('web/tool-name.js'),
        'bridge/tool-name.js and web/tool-name.js have drifted; change them together');
    ok('the two copies have the same body');

    console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
