'use strict';

// What a client calls a session's agent, and whose version counts as an old
// Claude Code. A Codex session used to read "Claude 0.172.0 (older)" in its
// header and count towards "1 on old Claude", because both labels were written
// as Claude and the stale check compared every runner's version with Claude
// Code's. Now the bridge names each runtime (`agent: {name, product}`), says
// whether it checks that runtime's version (`updateCheck`), and counts Claude
// runners only.

const assert = require('assert');
const runtimes = require('../bridge/runtimes');
const { summarize } = require('../bridge/claude-version');

let pass = 0;
const ok = (what) => { pass++; console.log(`  ok  ${what}`); };

(async () => {
    const { agentFrom, resumeLine } = await import('../web/agent-name.js');

    // --- the bridge names each runtime ----------------------------------------------------------
    assert.deepStrictEqual(runtimes.agentOf('claude'), { name: 'Claude', product: 'Claude Code', resume: ['claude', '--resume'] });
    assert.deepStrictEqual(runtimes.agentOf('codex'), { name: 'Codex', product: 'Codex', resume: ['codex', 'resume'] });
    assert.strictEqual(runtimes.agentOf(), runtimes.agentOf('claude'), 'claude when none is named');
    assert.strictEqual(runtimes.capabilitiesOf('claude').updateCheck, true);
    assert.strictEqual(runtimes.capabilitiesOf('codex').updateCheck, true,
        'Codex is compared with its own releases (test/codex-quota.test.js)');
    ok('each runtime has a display name and says whether its version is checked');

    // --- the client reads them, and falls back to Claude for an older bridge ----------------------
    assert.deepStrictEqual(agentFrom(runtimes.agentOf('codex')), { name: 'Codex', product: 'Codex', resume: ['codex', 'resume'] });
    assert.deepStrictEqual(agentFrom(null), { name: 'Claude', product: 'Claude Code', resume: ['claude', '--resume'] },
        'a bridge that sends no agent ran only Claude');
    assert.deepStrictEqual(agentFrom({ name: 'Gemini' }), { name: 'Gemini', product: 'Claude Code', resume: null },
        'an agent object with no resume has no resume command');
    assert.deepStrictEqual(agentFrom({ name: 7, product: '', resume: ['x', 3] }), { name: 'Claude', product: 'Claude Code', resume: null },
        'a malformed field is no name');
    ok('web/agent-name.js reads the bridge\'s names, with Claude\'s for none');

    // --- the resume line, from the runtime's own argv ----------------------------------------------
    assert.strictEqual(resumeLine(['claude', '--resume'], 'abc-123', '/home/me/proj'),
        'cd /home/me/proj && claude --resume abc-123');
    assert.strictEqual(resumeLine(['codex', 'resume'], 'abc-123', ''), 'codex resume abc-123');
    assert.strictEqual(resumeLine(['claude', '--resume'], 'x', "/tmp/it's here"),
        "cd '/tmp/it'\\''s here' && claude --resume x", 'a path is quoted for the shell');
    assert.strictEqual(resumeLine(null, 'x', '/p'), null, 'no command, no line');
    ok('resumeLine builds a shell line from the runtime\'s argv, cd first');

    // --- only Claude runners count against Claude Code's installed version ------------------------
    const out = summarize({ installed: '2.1.300', runners: {
        claudeOld: { runtime: 'claude', claudeVersion: '2.1.200' },
        claudeNew: { runtime: 'claude', claudeVersion: '2.1.300' },
        legacy: { claudeVersion: '2.1.100' },
        codex: { runtime: 'codex', claudeVersion: '0.172.0' },
    } });
    assert.deepStrictEqual(out.staleSessions.map(s => s.id).sort(), ['claudeOld', 'legacy'],
        'a Codex 0.172.0 is not an older Claude Code; a runner with no runtime is Claude\'s');
    ok('a Codex runner is never counted as an old Claude');

    console.log(`\n${pass} agent-name checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
