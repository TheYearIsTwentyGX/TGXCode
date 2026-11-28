'use strict';

// The skills on disk, for both runtimes — bridge/skills.js.
//
// HOME, CODEX_HOME and the cache are redirected before anything is required,
// for claude-docs.test.js's reason: config.js resolves `~/.claude` at load, and
// this module writes into it. The assertion below re-checks before any write.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TGXCODE_ROOTS = home;
process.env.CODEX_HOME = path.join(home, 'codex-home');
process.env.XDG_CACHE_HOME = path.join(home, 'cache');
process.env.XDG_DATA_HOME = path.join(home, 'data');

const cfg = require('../bridge/config.js');
const skills = require('../bridge/skills.js');

assert.ok(cfg.USER_CLAUDE_DIR.startsWith(home), `refusing to run: ${cfg.USER_CLAUDE_DIR} is not inside ${home}`);
assert.ok(skills.homes().codex.startsWith(home), 'refusing to run: CODEX_HOME is not inside the temp home');
assert.ok(skills.homes().trash.startsWith(home), 'refusing to run: the trash is not inside the temp home');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };
const throwsCode = (fn, code, name) => {
    let err;
    try { fn(); } catch (e) { err = e; }
    assert.ok(err, `${name}: expected a refusal`);
    assert.strictEqual(err.code, code, `${name}: ${err.message}`);
};

function mkSkill(root, name, fm = `---\nname: ${name}\ndescription: about ${name}\n---\nbody\n`, extra = {}) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), fm);
    for (const [f, t] of Object.entries(extra)) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), t);
    }
    return dir;
}

const project = path.join(home, 'proj');
const claudeUser = path.join(home, '.claude', 'skills');
const codexUser = path.join(process.env.CODEX_HOME, 'skills');
const pluginDir = path.join(home, 'plugin-cache', 'tools');

mkSkill(claudeUser, 'alpha', '---\nname: alpha\ndescription: >\n  Folded\n  over lines.\nallowed-tools: Bash(git:*)\nhooks:\n  PreToolUse:\n    - x\n---\n', { 'scripts/run.sh': '#!/bin/sh\n' });
mkSkill(path.join(claudeUser, 'synced', 'bucket1'), 'pdf');
mkSkill(path.join(project, '.claude', 'skills'), 'proj-claude');
mkSkill(path.join(pluginDir, 'skills'), 'plug');
mkSkill(codexUser, 'codex-one', '---\nname: codex-one\ndescription: "quoted desc"\n---\n');
mkSkill(path.join(codexUser, '.system'), 'skill-installer');
mkSkill(path.join(project, '.agents', 'skills'), 'proj-codex');
fs.mkdirSync(path.join(claudeUser, 'not-a-skill'), { recursive: true });
skills.setPluginSource(() => [[pluginDir, 'tools', 'tools@market']]);

// ── listing ─────────────────────────────────────────────────────────────
{
    const got = skills.list(project);
    const by = (n) => got.skills.find(s => s.folder === n);
    const names = got.skills.map(s => `${s.runtime}:${s.scope}:${s.folder}`).sort();
    assert.deepStrictEqual(names, [
        'claude:plugin:plug', 'claude:project:proj-claude', 'claude:synced:pdf', 'claude:user:alpha',
        'codex:project:proj-codex', 'codex:system:skill-installer', 'codex:user:codex-one',
    ]);
    ok('lists both runtimes, every scope, and skips nested roots and dirs without SKILL.md');

    assert.strictEqual(by('alpha').description, 'Folded over lines.');
    assert.strictEqual(by('alpha').allowedTools, 'Bash(git:*)');
    assert.strictEqual(by('alpha').hooks, true);
    assert.strictEqual(by('codex-one').description, 'quoted desc');
    assert.ok(by('alpha').files.some(f => f.path === 'scripts/run.sh'));
    ok('reads frontmatter: block scalars, quotes, hooks and allowed-tools');

    for (const n of ['plug', 'pdf', 'skill-installer']) {
        assert.strictEqual(by(n).editable, false, n);
        assert.ok(by(n).reason, `${n} says why it is read-only`);
    }
    for (const n of ['alpha', 'proj-claude', 'codex-one', 'proj-codex']) assert.strictEqual(by(n).editable, true, n);
    ok('plugin, synced and Codex system skills are read-only with a reason');

    const noProj = skills.list('/etc');
    assert.ok(!noProj.skills.some(s => s.scope === 'project'));
    ok('a project outside the roots contributes no project rows');
}

// ── reading and writing ─────────────────────────────────────────────────
{
    const dir = path.join(claudeUser, 'alpha');
    const r = skills.readFile({ dir, project });
    assert.ok(r.text.includes('Folded'));
    assert.ok(r.stamp);

    throwsCode(() => skills.writeFile({ dir, project, text: 'x' }), 'invalid', 'missing stamp');
    const w = skills.writeFile({ dir, project, text: '---\nname: alpha\n---\nnew\n', stamp: r.stamp });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '---\nname: alpha\n---\nnew\n');
    throwsCode(() => skills.writeFile({ dir, project, text: 'y', stamp: r.stamp }), 'conflict', 'stale stamp');
    try { skills.writeFile({ dir, project, text: 'y', stamp: r.stamp }); } catch (e) {
        assert.ok(e.detail && e.detail.current && e.detail.current.text.includes('new'), 'a conflict carries the file as it is now');
    }
    assert.ok(w.stamp);
    ok('a write needs the stamp it was read at; a stale one is a 409 carrying the current file');

    skills.writeFile({ dir, project, file: 'notes/extra.md', text: 'hi', stamp: null });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'notes', 'extra.md'), 'utf8'), 'hi');
    throwsCode(() => skills.writeFile({ dir, project, file: 'notes/extra.md', text: 'again', stamp: null }), 'conflict', 'create over existing');
    ok('stamp null creates a new file, and refuses when one is already there');

    const sh = skills.readFile({ dir, project, file: 'scripts/run.sh' });
    fs.chmodSync(path.join(dir, 'scripts', 'run.sh'), 0o755);
    const sh2 = skills.readFile({ dir, project, file: 'scripts/run.sh' });
    skills.writeFile({ dir, project, file: 'scripts/run.sh', text: '#!/bin/sh\necho\n', stamp: sh2.stamp });
    assert.ok(fs.statSync(path.join(dir, 'scripts', 'run.sh')).mode & 0o100, 'executable bit survives a save');
    assert.ok(sh.text.startsWith('#!'));
    ok('a save keeps a script executable');

    throwsCode(() => skills.writeFile({ dir: path.join(pluginDir, 'skills', 'plug'), project, text: 'x', stamp: null }), 'read-only', 'plugin write');
    throwsCode(() => skills.writeFile({ dir: path.join(codexUser, '.system', 'skill-installer'), project, text: 'x', stamp: null }), 'read-only', 'system write');
    ok('read-only skills refuse writes');
}

// ── path refusals ───────────────────────────────────────────────────────
{
    const dir = path.join(claudeUser, 'alpha');
    for (const bad of ['../beta/SKILL.md', '/etc/passwd', 'a/../../x', 'a\\b', '']) {
        throwsCode(() => skills.readFile({ dir, project, file: bad || 'x/../..' }), 'invalid', `path ${bad}`);
    }
    throwsCode(() => skills.readFile({ dir: '/etc', project }), 'not-found', 'dir outside roots');
    throwsCode(() => skills.readFile({ dir: path.join(claudeUser, 'synced'), project }), 'not-found', 'nested root as skill');
    throwsCode(() => skills.readFile({ dir: 'relative/dir', project }), 'invalid', 'relative dir');

    fs.symlinkSync('/etc', path.join(dir, 'link'));
    throwsCode(() => skills.readFile({ dir, project, file: 'link/passwd' }), 'symlink', 'through a symlink');
    throwsCode(() => skills.writeFile({ dir, project, file: 'link/x', text: 'x', stamp: null }), 'symlink', 'write through a symlink');
    fs.unlinkSync(path.join(dir, 'link'));

    const outside = mkSkill(path.join(home, 'elsewhere'), 'evil');
    fs.symlinkSync(outside, path.join(claudeUser, 'evil'));
    throwsCode(() => skills.readFile({ dir: path.join(claudeUser, 'evil'), project }), 'symlink', 'skill dir symlink');
    fs.unlinkSync(path.join(claudeUser, 'evil'));
    ok('refuses .., absolute paths, backslashes, dirs outside the roots and symlinks anywhere on the way');
}

// ── create, copy, delete ────────────────────────────────────────────────
{
    const made = skills.create({ runtime: 'codex', scope: 'user', name: 'fresh', description: 'new one' });
    assert.strictEqual(made.dir, path.join(codexUser, 'fresh'));
    assert.strictEqual(made.description, 'new one');
    throwsCode(() => skills.create({ runtime: 'codex', scope: 'user', name: 'fresh' }), 'exists', 'duplicate');
    for (const bad of ['Bad', '-x', 'a/b', '..', 'a b', '']) {
        throwsCode(() => skills.create({ runtime: 'claude', scope: 'user', name: bad }), 'invalid', `name ${bad}`);
    }
    throwsCode(() => skills.create({ runtime: 'claude', scope: 'project', name: 'x' }), 'invalid', 'project without project');
    const inProj = skills.create({ runtime: 'claude', scope: 'project', project, name: 'p2' });
    assert.strictEqual(inProj.dir, path.join(project, '.claude', 'skills', 'p2'));
    ok('create writes a SKILL.md into the right root and validates the name');

    const copied = skills.copy({ dir: path.join(pluginDir, 'skills', 'plug'), project, target: { runtime: 'claude', scope: 'user' } });
    assert.strictEqual(copied.dir, path.join(claudeUser, 'plug'));
    assert.strictEqual(copied.editable, true);
    throwsCode(() => skills.copy({ dir: path.join(pluginDir, 'skills', 'plug'), project }), 'exists', 'copy twice');
    ok('a read-only skill can be copied into the user skills');

    const gone = skills.remove({ dir: made.dir, project });
    assert.ok(!fs.existsSync(made.dir));
    assert.ok(fs.existsSync(path.join(gone.trashed, 'SKILL.md')), 'the trash holds it');
    assert.ok(gone.trashed.startsWith(skills.homes().trash));
    throwsCode(() => skills.remove({ dir: path.join(pluginDir, 'skills', 'plug'), project }), 'read-only', 'remove plugin');
    ok('delete moves the skill to the trash, and refuses read-only skills');
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`skills: ${passed} passed`);
