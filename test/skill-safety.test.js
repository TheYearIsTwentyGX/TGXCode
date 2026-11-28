'use strict';

// The safety score for a skill being imported — bridge/skill-safety.js. Pure:
// counts in, a score, a level and the breakdown out. The cases are the ones
// the weights were chosen against: a bare SKILL.md, a typical tool skill, a
// big asset library with no code in it, and taste-skill's real Stop hook.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const s = require('../bridge/skill-safety.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };
const factor = (r, name) => r.factors.find(f => f.factor === name);

// ── levels and the shape ───────────────────────────────────────────────
{
    assert.strictEqual(s.levelOf(0), 'green');
    assert.strictEqual(s.levelOf(s.GREEN_BELOW - 1), 'green');
    assert.strictEqual(s.levelOf(s.GREEN_BELOW), 'yellow');
    assert.strictEqual(s.levelOf(s.RED_FROM - 1), 'yellow');
    assert.strictEqual(s.levelOf(s.RED_FROM), 'red');

    const bare = s.scoreSkill({ files: 1, bytes: 400, scripts: 0, executables: 0, binaries: 0 });
    assert.deepStrictEqual([bare.score, bare.level, bare.requiresConfirm], [0, 'green', false]);
    assert.deepStrictEqual(bare.factors.map(f => f.factor),
        ['hooks', 'allowed-tools', 'remote-exec', 'scripts', 'executables', 'binaries', 'unreadable', 'files', 'bytes']);
    for (const f of bare.factors) {
        assert.deepStrictEqual(Object.keys(f).sort(), ['contribution', 'factor', 'label', 'note', 'value'], f.factor);
        assert.ok(Number.isInteger(f.contribution) && f.contribution >= 0, f.factor);
        assert.strictEqual(typeof f.note, 'string');
    }
    assert.strictEqual(bare.score, bare.factors.reduce((a, f) => a + f.contribution, 0), 'the score is the sum of the rows');
    ok('green below 25, yellow to 59, red from 60; every factor is a row, and the rows sum to the score');

    // Garbage in is zero, not NaN.
    const junk = s.scoreSkill({ files: -3, bytes: NaN, scripts: 'x' });
    assert.strictEqual(junk.score, 0);
    assert.strictEqual(s.scoreSkill().score, 0);
    ok('missing or nonsense counts score nothing');
}

// ── each factor saturates ──────────────────────────────────────────────
{
    const huge = 1e9;
    assert.strictEqual(s.WEIGHTS.files(huge), 15);
    assert.strictEqual(s.WEIGHTS.bytes(huge), 15);
    assert.strictEqual(s.WEIGHTS.scripts(huge), 20);
    assert.strictEqual(s.WEIGHTS.executables(huge), 10);
    assert.strictEqual(s.WEIGHTS.binaries(huge), 10);
    assert.strictEqual(s.WEIGHTS.unreadable(huge), 10);
    assert.strictEqual(s.WEIGHTS.hooks(huge), 70);
    assert.strictEqual(s.WEIGHTS['remote-exec'](huge), 40);
    assert.strictEqual(s.WEIGHTS.files(50), 0, 'no points for 50 files or fewer');
    assert.strictEqual(s.WEIGHTS.bytes(1024 * 1024), 0, 'no points up to 1MB');
    assert.ok(s.WEIGHTS.files(200) > s.WEIGHTS.files(100) && s.WEIGHTS.scripts(8) > s.WEIGHTS.scripts(2), 'more is more, until the cap');

    // Size alone, however big, never reaches red.
    const assets = s.scoreSkill({ files: 20_000, bytes: 500 * 1024 * 1024, scripts: 0, executables: 0, binaries: 0 });
    assert.strictEqual(assets.score, 30);
    assert.strictEqual(assets.level, 'yellow');
    assert.strictEqual(assets.requiresConfirm, false);
    ok('every factor is capped, and size and count alone stop at yellow');
}

// ── hooks are red on their own ─────────────────────────────────────────
{
    const one = { declared: true, hooks: [{ event: 'Stop', matcher: null, type: 'command', command: 'node gate.mjs', timeout: 600 }] };
    const r = s.scoreSkill({ files: 1, bytes: 300, hooks: one });
    assert.deepStrictEqual([r.score, r.level, r.requiresConfirm], [60, 'red', true]);
    assert.ok(/Stop: node gate\.mjs/.test(factor(r, 'hooks').note));
    assert.deepStrictEqual(r.hooks, one.hooks);
    const three = { declared: true, hooks: [...one.hooks, ...one.hooks, ...one.hooks] };
    assert.strictEqual(factor(s.scoreSkill({ hooks: three }), 'hooks').contribution, 70);
    ok('one hook alone is 60, which is red and asks for confirmation; more hooks add a little');
}

// ── allowed-tools ──────────────────────────────────────────────────────
{
    assert.deepStrictEqual(s.splitTools('Bash(git add:*), Read Write'), ['Bash(git add:*)', 'Read', 'Write']);
    assert.deepStrictEqual(s.splitTools('- Bash - Read'), ['Bash', 'Read']);
    assert.deepStrictEqual(s.splitTools('[Bash, "Read"]'), ['Bash', 'Read']);
    const pts = (t) => factor(s.scoreSkill({ allowedTools: t }), 'allowed-tools').contribution;
    assert.strictEqual(pts('Read, Grep, Glob'), 0);
    assert.strictEqual(pts('Bash'), 20);
    assert.strictEqual(pts('Bash(*)'), 20);
    assert.strictEqual(pts('Bash(git status:*)'), 6);
    assert.strictEqual(pts('Write Edit'), 8);
    assert.strictEqual(pts('*'), 25);
    assert.strictEqual(pts('Bash Write Edit WebFetch mcp__x__y'), 25, 'capped');
    assert.ok(/any shell command/.test(factor(s.scoreSkill({ allowedTools: 'Bash' }), 'allowed-tools').note));
    ok('unrestricted Bash weighs most, a scoped Bash and file writes less, reading tools nothing');
}

// ── the cases the weights were set against ─────────────────────────────
{
    // anthropics/skills' pdf, roughly: a few scripts, one executable, Bash.
    const pdf = s.scoreSkill({ files: 8, bytes: 70_000, scripts: 3, executables: 1, binaries: 1, allowedTools: 'Bash' });
    assert.strictEqual(pdf.level, 'yellow');
    assert.ok(pdf.score > 25 && pdf.score < 45, `pdf ${pdf.score}`);

    const curl = s.scoreSkill({ files: 1, bytes: 900, remoteExec: ['SKILL.md'] });
    assert.strictEqual(curl.level, 'yellow', 'a curl | sh is never green');
    assert.ok(/SKILL\.md/.test(factor(curl, 'remote-exec').note));

    // taste-skill, with its real SKILL.md.
    const md = fs.readFileSync(path.join(__dirname, 'fixtures', 'skills', 'taste-skill.SKILL.md'), 'utf8');
    const hooks = s.parseHooks(md);
    const taste = s.scoreSkill({ files: 1631, bytes: 36_601_022, scripts: 54, executables: 0, binaries: 400, unreadable: 12, hooks });
    assert.strictEqual(taste.level, 'red');
    assert.strictEqual(taste.score, 100);
    assert.strictEqual(factor(taste, 'hooks').contribution, 60);
    ok('a bare skill is green, a tool skill yellow, a curl | sh yellow, taste-skill red at 100');
}

// ── parseHooks ─────────────────────────────────────────────────────────
{
    assert.deepStrictEqual(s.parseHooks('---\nname: x\n---\nhooks: not frontmatter\n'), { declared: false, hooks: [], raw: '' });
    assert.deepStrictEqual(s.parseHooks(''), { declared: false, hooks: [], raw: '' });

    const md = fs.readFileSync(path.join(__dirname, 'fixtures', 'skills', 'taste-skill.SKILL.md'), 'utf8');
    const taste = s.parseHooks(md);
    assert.strictEqual(taste.hooks.length, 1);
    const h = taste.hooks[0];
    assert.deepStrictEqual([h.event, h.type, h.timeout, h.matcher], ['Stop', 'command', 600, null]);
    assert.ok(h.command.startsWith('for f in ${CLAUDE_SKILL_DIR:+"$CLAUDE_SKILL_DIR/scripts/gate.mjs"}'), h.command.slice(0, 80));
    assert.ok(h.command.endsWith('exit 0'), 'the whole single-quoted command, braces and all');
    assert.ok(h.command.includes('exec node "$f" --hook claude'));
    ok("reads taste-skill's real Stop hook: event, command (with ${…} in it), timeout");

    const many = s.parseHooks([
        '---', 'name: x', 'hooks:',
        '  PreToolUse:',
        '    - matcher: "Bash"',
        '      hooks:',
        '        - type: command',
        '          command: |',
        '            echo one',
        '            echo two',
        '        - { type: command, command: "./b.sh", timeout: 5 }',
        '  Stop:',
        '    - hooks:',
        '      - type: command',
        '        command: "say \\"done\\""',
        '  PostToolUse:',
        '    - hooks:',
        "      - command: 'it''s'",
        '---', '',
    ].join('\n'));
    assert.deepStrictEqual(many.hooks.map(x => [x.event, x.matcher, x.command, x.timeout]), [
        ['PreToolUse', 'Bash', 'echo one\necho two', null],
        ['PreToolUse', 'Bash', './b.sh', 5],
        ['Stop', null, 'say "done"', null],
        ['PostToolUse', null, "it's", null],
    ]);
    ok('block scalars, flow mappings, double and single quotes, matchers per event');

    const odd = s.parseHooks('---\nhooks: {Stop: [{hooks: [{type: command, command: x}]}]}\n---\n');
    assert.strictEqual(odd.declared, true);
    assert.strictEqual(odd.hooks.length, 1, 'a shape it cannot read is still one hook, not none');
    assert.ok(/Stop/.test(odd.hooks[0].command) && /Stop/.test(odd.raw));
    const r = s.scoreSkill({ hooks: odd });
    assert.strictEqual(r.level, 'red');
    ok('a hooks: block in a shape the reader does not know is still reported, raw, and still red');
}

console.log(`skill-safety: ${passed} passed`);
