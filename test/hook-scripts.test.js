'use strict';

// The Hooks page's script editor — bridge/hook-scripts.js — and the
// `$CLAUDE_PROJECT_DIR` resolution in bridge/claude-config.js it leans on.
//
// HOME is redirected before anything is required, for the reason
// claude-config.test.js gives: bridge/config.js resolves `~/.claude` at load,
// and this module writes executable files under it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-scripts-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TGXCODE_ROOTS = home;
process.env.TGXCODE_MANAGED_SETTINGS = path.join(home, 'managed-settings.json');

const cfg = require('../bridge/config.js');
const { scriptPath, scriptState } = require('../bridge/claude-config.js');
const { HookScripts, MAX_SCRIPT_BYTES } = require('../bridge/hook-scripts.js');

assert.ok(cfg.USER_CLAUDE_DIR.startsWith(home),
    `refusing to run: ${cfg.USER_CLAUDE_DIR} is not inside ${home}`);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };
const codeOf = (fn) => { try { fn(); return null; } catch (err) { return err.code || 'no-code'; } };
const modeOf = (file) => fs.statSync(file).mode & 0o777;

const project = path.join(home, 'proj');
const projHooks = path.join(project, '.claude', 'hooks');
fs.mkdirSync(projHooks, { recursive: true });
const write = (file, text, mode) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    if (mode !== undefined) fs.chmodSync(file, mode);
};

// A project hook that names its script through the variable, and a user hook
// that names one outside any hooks directory.
const elsewhere = path.join(home, 'tools', 'guard.sh');
write(elsewhere, '#!/bin/sh\nexit 0\n', 0o750);
write(path.join(project, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: '"${CLAUDE_PROJECT_DIR}/.claude/hooks/block.sh" --strict' },
    ] }] },
}));
write(cfg.USER_CLAUDE_SETTINGS, JSON.stringify({
    hooks: { Stop: [{ hooks: [
        { type: 'command', command: `bash ${elsewhere}` },
        { type: 'command', command: '/usr/bin/env true' },
    ] }] },
}));

// ── $CLAUDE_PROJECT_DIR ────────────────────────────────────────────────────

assert.strictEqual(scriptPath('"$CLAUDE_PROJECT_DIR/.claude/hooks/a.sh"', project),
    path.join(project, '.claude/hooks/a.sh'));
assert.strictEqual(scriptPath('${CLAUDE_PROJECT_DIR}/x.sh', project), path.join(project, 'x.sh'));
assert.strictEqual(scriptPath('$CLAUDE_PROJECT_DIR/x.sh'), null,
    'without a project the variable is unresolvable, not the filesystem root');
assert.strictEqual(scriptPath('python3 ~/h.py', project), path.join(home, 'h.py'));
assert.deepStrictEqual(
    { exists: scriptState('$CLAUDE_PROJECT_DIR/.claude/hooks/none.sh', project).exists },
    { exists: false });
ok('$CLAUDE_PROJECT_DIR resolves against the project, and only when there is one');

const hs = new HookScripts();

// ── the path policy ────────────────────────────────────────────────────────

{
    const got = hs.read({ dir: project, path: path.join(projHooks, 'block.sh') });
    assert.strictEqual(got.referenced, true);
    assert.strictEqual(got.exists, false);
    assert.strictEqual(got.maxBytes, MAX_SCRIPT_BYTES);

    const user = hs.read({ dir: project, path: elsewhere });
    assert.strictEqual(user.referenced, true, 'a script a user hook names is allowed wherever it is');
    assert.strictEqual(user.text, '#!/bin/sh\nexit 0\n');
    assert.strictEqual(user.executable, true);
    ok('a script a hook in the chain names may be read');
}

{
    assert.strictEqual(codeOf(() => hs.read({ dir: project, path: '/etc/passwd' })), 'path');
    assert.strictEqual(codeOf(() => hs.read({ dir: project, path: path.join(home, 'tools', 'other.sh') })), 'path');
    assert.strictEqual(codeOf(() => hs.read({ dir: project, path: path.join(projHooks, '..', 'settings.json') })),
        'path', '.. out of the hooks directory is folded away and then refused');
    assert.strictEqual(codeOf(() => hs.read({ dir: project, path: '/usr/bin/env' })), 'path',
        'a binary a hook mentions is not inside the roots, so it is not editable');
    assert.strictEqual(codeOf(() => hs.read({ dir: '/etc', path: '/etc/hooks/x' })), 'dir');
    assert.strictEqual(codeOf(() => hs.read({ dir: project, path: '' })), 'path');
    ok('anything else is refused, .. included');
}

{
    const fresh = path.join(projHooks, 'lib', 'common.sh');
    const got = hs.read({ dir: project, path: fresh });
    assert.strictEqual(got.referenced, false);
    assert.strictEqual(got.writable, true);
    assert.strictEqual(hs.read({ dir: '', path: path.join(cfg.USER_CLAUDE_DIR, 'hooks', 'n.sh') }).exists, false);
    ok('a new file inside a .claude/hooks directory is allowed');
}

// ── the precondition ───────────────────────────────────────────────────────

{
    const file = path.join(projHooks, 'block.sh');
    assert.strictEqual(codeOf(() => hs.save({ dir: project, path: file, text: 'x' })), 'stamp');
    const made = hs.save({ dir: project, path: file, stamp: null, text: '#!/bin/sh\necho hi\n', executable: true });
    assert.strictEqual(made.exists, true);
    assert.strictEqual(modeOf(file), 0o755, 'a new script with executable:true is 0755');
    assert.strictEqual(codeOf(() => hs.save({ dir: project, path: file, stamp: null, text: 'y' })), 'exists');

    let err;
    try { hs.save({ dir: project, path: file, stamp: 'nope', text: 'y' }); } catch (e) { err = e; }
    assert.strictEqual(err.code, 'stale');
    assert.strictEqual(err.detail.text, '#!/bin/sh\necho hi\n', 'a conflict carries what is on disk now');
    ok('stamp absent, null-but-exists and stale are each refused');
}

// ── the mode survives ──────────────────────────────────────────────────────

{
    const before = hs.read({ dir: project, path: elsewhere });
    const after = hs.save({ dir: project, path: elsewhere, stamp: before.stamp, text: '#!/bin/sh\nexit 1\n' });
    assert.strictEqual(modeOf(elsewhere), 0o750, 'the old mode is put back after the rename');
    assert.strictEqual(fs.readFileSync(elsewhere, 'utf8'), '#!/bin/sh\nexit 1\n');

    fs.chmodSync(elsewhere, 0o640);
    const plain = hs.read({ dir: project, path: elsewhere });
    assert.strictEqual(plain.executable, false);
    hs.save({ dir: project, path: elsewhere, stamp: plain.stamp, text: after.text, executable: true });
    assert.strictEqual(modeOf(elsewhere), 0o751, 'executable:true adds the x bits to the mode it had');
    ok('a save keeps the file mode, and executable:true adds to it');
}

// ── what is not saved ──────────────────────────────────────────────────────

{
    const file = path.join(projHooks, 'n.sh');
    const nul = String.fromCharCode(0);
    assert.strictEqual(codeOf(() => hs.save({ dir: project, path: file, stamp: null, text: `a${nul}b` })), 'body');
    assert.strictEqual(codeOf(() => hs.save({
        dir: project, path: file, stamp: null, text: 'x'.repeat(MAX_SCRIPT_BYTES + 1),
    })), 'size');

    const bin = path.join(projHooks, 'bin');
    write(bin, `ELF${nul}${nul}`);
    const got = hs.read({ dir: project, path: bin });
    assert.strictEqual(got.binary, true);
    assert.strictEqual(got.text, null);
    assert.strictEqual(codeOf(() => hs.save({ dir: project, path: bin, stamp: got.stamp, text: 'x' })), 'readonly');

    const link = path.join(projHooks, 'link.sh');
    fs.symlinkSync(elsewhere, link);
    const l = hs.read({ dir: project, path: link });
    assert.strictEqual(l.symlink, true);
    assert.strictEqual(l.writable, false);
    assert.strictEqual(codeOf(() => hs.save({ dir: project, path: link, stamp: l.stamp, text: 'x' })), 'readonly');
    ok('NUL, oversize, a binary and a symlink are each refused');
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${passed} hook-scripts checks passed`);
