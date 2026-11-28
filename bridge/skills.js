'use strict';

// The skills on this machine, for both runtimes, as files: listed, read,
// written, created and thrown away. What the Skills page is built from.
//
// docs/plans/20-claude-config.md put this off because "the value there is
// *authoring*, which is a small file manager rather than another settings
// group". This is that file manager. docs/plans/24-skills.md is the design note.
//
// Decided here:
//
// - **Claude's and Codex's skills, read the same way.** Both are a directory
//   per skill with a `SKILL.md` in it, so one scanner serves both and every row
//   says which runtime it is for. The roots:
//
//     claude  user     ~/.claude/skills                       editable
//     claude  synced   ~/.claude/skills/synced/<bucket>        read-only (claude.ai)
//     claude  project  <project>/.claude/skills               editable
//     claude  plugin   <installPath>/skills                   read-only (plugin)
//     codex   user     $CODEX_HOME/skills                     editable
//     codex   system   $CODEX_HOME/skills/.system             read-only (Codex)
//     codex   project  <project>/.agents/skills, .codex/skills editable
//
//   `$CODEX_HOME` is bridge/config.js's, which honours the variable, so a test
//   or a manual check can point the whole Codex half at a scratch directory.
//
// - **Disk, not `skills/list`.** bridge/codex/skills.js asks Codex for its
//   palette and is the right source for "what can I invoke here"; this is "what
//   files are there", which is a readdir. Asking an app-server per page load
//   would cost a process for an answer the disk already has, and it would hide
//   the skills Codex had disabled — the ones somebody most wants to find here.
//
// - **Read-only rows are read-only for a reason the row states.** A plugin's
//   skill is rewritten by the next plugin update, the synced bucket by the next
//   claude.ai sync, `.system` by the next Codex release. An edit there is an
//   edit thrown away later without a word, so the bridge refuses it and the
//   page offers a copy into the user's own skills instead.
//
// - **A write carries a stamp, always** — claude-docs.js's rule and for its
//   reason: every write replaces a whole file. `null` means "this file should
//   not exist yet"; an absent stamp is a refusal.
//
// - **Addressed by directory, checked against the roots every time.** A client
//   names a skill by the absolute directory the list gave it. The bridge
//   recomputes the roots and accepts the directory only when its parent *is*
//   one of them, so a path can never be talked into somewhere else. Relative
//   file paths are refused for `..`, absolute forms and NUL, and every existing
//   component is lstat'ed: a symlink anywhere on the way is a refusal.
//
// - **Delete is a move to the trash**, `CACHE_DIR/skills-trash/<ts>-<name>`,
//   not an `rm -rf`. A skill is somebody's writing, and the button is one
//   misclick from the Edit one.
//
// - **Frontmatter is scanned, not parsed.** No dependencies, and a YAML parser
//   is not "a smaller amount of code" — hook-sources.js and slash-commands.js
//   made the same trade. `name`, `description` (plain, quoted or a `>`/`|`
//   block) and whether `hooks:` or `allowed-tools:` appear are what is read.

const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const { writeAtomic, escapes, refuse, stampOf } = require('./jsonfile');
const { pluginRoots } = require('./slash-commands');

const SKILL_FILE = 'SKILL.md';
const RUNTIMES = ['claude', 'codex'];
/** One cap for reading and writing a file: claude-docs' number. */
const MAX_FILE_BYTES = 256 * 1024;
/** How much of SKILL.md is read for the list. */
const HEAD_BYTES = 8192;
/** A listing is a summary, not an archive. */
const MAX_LIST_FILES = 200;
const MAX_DEPTH = 6;
/** What a new skill name may be: what both runtimes accept as a directory and a slash name. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const NUL = String.fromCharCode(0);

/** Where things live, overridable for tests. */
function homes() {
    return {
        claude: cfg.USER_CLAUDE_DIR,
        codex: process.env.CODEX_HOME || cfg.CODEX_HOME,
        trash: path.join(cfg.CACHE_DIR, 'skills-trash'),
    };
}

let pluginSource = pluginRoots;
/** For tests: replace the installed-plugins reader. */
function setPluginSource(fn) { pluginSource = fn || pluginRoots; }

function projectDir(project) {
    if (!project || !cfg.withinRoots(project)) return null;
    return path.resolve(cfg.expandHome(project));
}

/**
 * Every skills root for this project, editable or not, whether or not it exists.
 * @returns {{runtime, scope, dir, editable, reason?, label}[]}
 */
function roots(project) {
    const h = homes();
    const proj = projectDir(project);
    const out = [];
    const claudeUser = path.join(h.claude, 'skills');
    out.push({ runtime: 'claude', scope: 'user', dir: claudeUser, editable: true, label: '~/.claude/skills' });
    const synced = path.join(claudeUser, 'synced');
    for (const b of dirents(synced)) {
        if (b.isDirectory() && !b.name.startsWith('.')) {
            out.push({ runtime: 'claude', scope: 'synced', dir: path.join(synced, b.name), editable: false,
                reason: 'Synced from claude.ai — the next sync replaces it.', label: 'claude.ai' });
        }
    }
    if (proj) out.push({ runtime: 'claude', scope: 'project', dir: path.join(proj, '.claude', 'skills'), editable: true, label: '.claude/skills' });
    for (const [dir, name] of pluginSource()) {
        out.push({ runtime: 'claude', scope: 'plugin', dir: path.join(dir, 'skills'), editable: false,
            reason: `Part of the ${name} plugin — the next plugin update replaces it.`, label: name, plugin: name });
    }
    const codexUser = path.join(h.codex, 'skills');
    out.push({ runtime: 'codex', scope: 'user', dir: codexUser, editable: true, label: '$CODEX_HOME/skills' });
    out.push({ runtime: 'codex', scope: 'system', dir: path.join(codexUser, '.system'), editable: false,
        reason: 'Ships with Codex — the next Codex release replaces it.', label: 'Codex' });
    if (proj) {
        out.push({ runtime: 'codex', scope: 'project', dir: path.join(proj, '.agents', 'skills'), editable: true, label: '.agents/skills' });
        out.push({ runtime: 'codex', scope: 'project', dir: path.join(proj, '.codex', 'skills'), editable: true, label: '.codex/skills' });
    }
    return out;
}

/** Directories inside a root that are some other root, and so not skills of this one. */
function nestedRootNames(root) {
    if (root.runtime === 'claude' && root.scope === 'user') return new Set(['synced']);
    if (root.runtime === 'codex' && root.scope === 'user') return new Set(['.system']);
    return new Set();
}

/** Where a new or imported skill goes. The first editable root of that kind. */
function targetRoot(runtime, scope, project) {
    if (!RUNTIMES.includes(runtime)) throw refuse('invalid', `unknown runtime "${runtime}"`);
    if (scope !== 'user' && scope !== 'project') throw refuse('invalid', 'a skill can be written to user or project scope');
    if (scope === 'project' && !projectDir(project)) throw refuse('invalid', 'project scope needs a project this bridge can read');
    const r = roots(project).find(x => x.runtime === runtime && x.scope === scope && x.editable);
    if (!r) throw refuse('invalid', 'no such skills directory');
    return r;
}

function dirents(dir) {
    try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function head(file, bytes = HEAD_BYTES) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(bytes);
        const n = fs.readSync(fd, buf, 0, bytes, 0);
        return buf.slice(0, n).toString('utf8');
    } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

function unquote(v) {
    const s = v.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    return s;
}

/**
 * What the frontmatter says, by scanning top-level keys.
 * @returns {{name: string|null, description: string|null, hooks: boolean, allowedTools: string|null, frontmatter: boolean}}
 */
function frontmatter(text) {
    const out = { name: null, description: null, hooks: false, allowedTools: null, frontmatter: false };
    if (!text) return out;
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    if (lines[0].trim() !== '---') return out;
    let end = lines.indexOf('---', 1);
    if (end < 0) end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end < 0) return out;
    out.frontmatter = true;
    for (let i = 1; i < end; i++) {
        const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
        if (!m) continue;
        const key = m[1];
        let value = m[2];
        if (/^[>|][+-]?\s*$/.test(value) || value === '') {
            // A block scalar, or a key whose value is on the indented lines after it.
            const parts = [];
            while (i + 1 < end && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
            value = parts.join(value.startsWith('|') ? '\n' : ' ');
            if (key === 'hooks') { out.hooks = true; continue; }
        }
        if (key === 'name') out.name = unquote(value) || null;
        else if (key === 'description') out.description = unquote(value) || null;
        else if (key === 'hooks') out.hooks = true;
        else if (key === 'allowed-tools') out.allowedTools = unquote(value) || null;
    }
    return out;
}

/** Files under a skill directory, relative, symlinks reported rather than followed. */
function listFiles(dir) {
    const files = [];
    let truncated = false;
    const walk = (abs, rel, depth) => {
        for (const d of dirents(abs).sort((a, b) => a.name.localeCompare(b.name))) {
            if (d.name === '.git') continue;
            const r = rel ? `${rel}/${d.name}` : d.name;
            if (files.length >= MAX_LIST_FILES) { truncated = true; return; }
            const p = path.join(abs, d.name);
            if (d.isSymbolicLink()) { files.push({ path: r, bytes: 0, symlink: true }); continue; }
            if (d.isDirectory()) { if (depth < MAX_DEPTH) walk(p, r, depth + 1); continue; }
            if (!d.isFile()) continue;
            let st;
            try { st = fs.statSync(p); } catch { continue; }
            files.push({ path: r, bytes: st.size, ...(st.mode & 0o111 ? { executable: true } : {}) });
        }
    };
    walk(dir, '', 0);
    return { files, truncated };
}

function skillRow(root, dir) {
    const file = path.join(dir, SKILL_FILE);
    const fm = frontmatter(head(file));
    const { files, truncated } = listFiles(dir);
    return {
        id: dir,
        dir,
        runtime: root.runtime,
        scope: root.scope,
        root: root.dir,
        rootLabel: root.label,
        name: fm.name || path.basename(dir),
        folder: path.basename(dir),
        description: fm.description,
        hooks: fm.hooks,
        allowedTools: fm.allowedTools,
        editable: root.editable,
        ...(root.reason ? { reason: root.reason } : {}),
        ...(root.plugin ? { plugin: root.plugin } : {}),
        files,
        ...(truncated ? { filesTruncated: true } : {}),
    };
}

/** Every skill, every root. */
function list(project) {
    const rs = roots(project);
    const skills = [];
    for (const root of rs) {
        const skip = nestedRootNames(root);
        for (const d of dirents(root.dir)) {
            if (skip.has(d.name) || !d.isDirectory()) continue;
            const dir = path.join(root.dir, d.name);
            if (!fs.existsSync(path.join(dir, SKILL_FILE))) continue;
            skills.push(skillRow(root, dir));
        }
    }
    return {
        project: projectDir(project),
        roots: rs.map(r => ({ ...r, exists: fs.existsSync(r.dir) })),
        skills,
        maxBytes: MAX_FILE_BYTES,
    };
}

/** The root a skill directory belongs to, or a refusal. */
function locate(dir, project) {
    if (typeof dir !== 'string' || !dir || dir.includes(NUL) || !path.isAbsolute(dir)) {
        throw refuse('invalid', 'name a skill by the directory the list gave');
    }
    const abs = path.resolve(dir);
    const parent = path.dirname(abs);
    const root = roots(project).find(r => r.dir === parent && !nestedRootNames(r).has(path.basename(abs)));
    if (!root) throw refuse('not-found', 'that is not a skill directory this bridge manages');
    let st;
    try { st = fs.lstatSync(abs); } catch { throw refuse('not-found', 'that skill is not there any more'); }
    if (st.isSymbolicLink()) throw refuse('symlink', 'that skill is a symlink, and is not followed');
    if (!st.isDirectory()) throw refuse('not-found', 'that skill is not there any more');
    return { root, dir: abs };
}

/** A path relative to the skill directory, or a refusal. Checks every existing component. */
function resolveInside(skillDir, rel) {
    if (typeof rel !== 'string' || !rel || rel.includes(NUL) || rel.includes('\\')) throw refuse('invalid', 'a file path inside the skill');
    if (path.isAbsolute(rel)) throw refuse('invalid', 'the path must be relative to the skill');
    const parts = rel.split('/');
    if (parts.some(p => !p || p === '.' || p === '..')) throw refuse('invalid', 'the path must stay inside the skill');
    if (parts.length > MAX_DEPTH + 1) throw refuse('invalid', 'that path is too deep');
    let cur = skillDir;
    for (const p of parts) {
        cur = path.join(cur, p);
        let st;
        try { st = fs.lstatSync(cur); } catch { break; }
        if (st.isSymbolicLink()) throw refuse('symlink', `${rel} goes through a symlink, which is not followed`);
    }
    const abs = path.join(skillDir, ...parts);
    if (escapes(abs, skillDir)) throw refuse('symlink', `${rel} resolves outside the skill`);
    return abs;
}

function isBinary(buf) {
    return buf.subarray(0, 8192).includes(0);
}

/** One file of a skill, for the editor. */
function readFile({ dir, file, project }) {
    const { root, dir: skillDir } = locate(dir, project);
    const abs = resolveInside(skillDir, file || SKILL_FILE);
    let st;
    try { st = fs.statSync(abs); } catch { throw refuse('not-found', `${file} is not there`); }
    if (!st.isFile()) throw refuse('not-found', `${file} is not a file`);
    const base = { dir: skillDir, file: file || SKILL_FILE, path: abs, stamp: stampOf(st), size: st.size,
        editable: root.editable, maxBytes: MAX_FILE_BYTES };
    if (st.size > MAX_FILE_BYTES) return { ...base, text: null, truncated: true, binary: false };
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) return { ...base, text: null, truncated: false, binary: true };
    return { ...base, text: buf.toString('utf8'), truncated: false, binary: false };
}

function checkText(text) {
    if (typeof text !== 'string') throw refuse('invalid', '`text` must be a string');
    if (text.includes(NUL)) throw refuse('invalid', 'a skill file is text');
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw refuse('too-large', `larger than ${MAX_FILE_BYTES / 1024}KB`);
}

function currentStamp(abs) {
    try {
        const st = fs.statSync(abs);
        return st.isFile() ? stampOf(st) : null;
    } catch { return null; }
}

/** Replace (or create) one text file of an editable skill. */
function writeFile({ dir, file, project, text, stamp }) {
    const { root, dir: skillDir } = locate(dir, project);
    if (!root.editable) throw refuse('read-only', root.reason || 'that skill is read-only');
    if (stamp === undefined) throw refuse('invalid', 'a write needs the `stamp` it was read at (null for a new file)');
    checkText(text);
    const rel = file || SKILL_FILE;
    const abs = resolveInside(skillDir, rel);
    const now = currentStamp(abs);
    if (now !== stamp) {
        const err = refuse('conflict', now === null ? `${rel} was deleted since it was read` : `${rel} changed on disk since it was read`);
        err.detail = { current: now === null ? null : readFile({ dir: skillDir, file: rel, project }) };
        throw err;
    }
    let mode;
    try { mode = fs.statSync(abs).mode & 0o777; } catch { /* new file */ }
    writeAtomic(abs, text, mode === undefined ? {} : { mode });
    return readFile({ dir: skillDir, file: rel, project });
}

/** The text a new skill starts as. */
function template(name, description) {
    const desc = String(description || '').replace(/\s+/g, ' ').trim() || 'What this skill does, and when to use it.';
    return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n# ${name}\n\nWrite the instructions here.\n`;
}

function checkName(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
        throw refuse('invalid', 'a skill name is lower-case letters, digits and hyphens, starting with a letter or digit');
    }
}

/** A new skill directory with a SKILL.md in it. */
function create({ runtime, scope, project, name, description, text }) {
    checkName(name);
    const root = targetRoot(runtime, scope, project);
    const dir = path.join(root.dir, name);
    if (fs.existsSync(dir)) throw refuse('exists', `${name} already exists in ${root.label}`);
    const body = text === undefined ? template(name, description) : text;
    checkText(body);
    fs.mkdirSync(root.dir, { recursive: true });
    if (escapes(root.dir, path.dirname(root.dir))) throw refuse('symlink', `${root.label} is a symlink, and is not written through`);
    fs.mkdirSync(dir);
    writeAtomic(path.join(dir, SKILL_FILE), body);
    return skillRow(root, dir);
}

function trashPath(name) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(homes().trash, `${stamp}-${name}`);
}

/** Move a directory into the trash. Rename when it can, copy-then-remove across devices. */
function toTrash(dir) {
    const dest = trashPath(path.basename(dir));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.renameSync(dir, dest); } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        fs.cpSync(dir, dest, { recursive: true, verbatimSymlinks: true });
        fs.rmSync(dir, { recursive: true, force: true });
    }
    return dest;
}

/** Throw an editable skill away, into the trash. */
function remove({ dir, project }) {
    const { root, dir: skillDir } = locate(dir, project);
    if (!root.editable) throw refuse('read-only', root.reason || 'that skill is read-only');
    return { dir: skillDir, trashed: toTrash(skillDir) };
}

/**
 * Copy a directory tree of plain files into a skills root, refusing symlinks.
 * The one place bytes go into a skills directory from elsewhere: a copy of a
 * read-only skill, and an import (bridge/skill-import.js).
 */
function placeTree(srcDir, root, name, { overwrite = false } = {}) {
    checkName(name);
    const dest = path.join(root.dir, name);
    let trashed = null;
    if (fs.existsSync(dest)) {
        if (!overwrite) throw refuse('exists', `${name} already exists in ${root.label}`);
        if (!root.editable) throw refuse('read-only', root.reason || 'that skills directory is read-only');
        if (fs.lstatSync(dest).isSymbolicLink()) throw refuse('symlink', `${name} is a symlink, and is not replaced`);
        trashed = toTrash(dest);
    }
    fs.mkdirSync(root.dir, { recursive: true });
    const tmp = path.join(root.dir, `.${name}.${process.pid}.tmp`);
    fs.rmSync(tmp, { recursive: true, force: true });
    const copy = (from, to) => {
        fs.mkdirSync(to);
        for (const d of dirents(from)) {
            if (d.name === '.git') continue;
            const a = path.join(from, d.name);
            const b = path.join(to, d.name);
            if (d.isSymbolicLink()) throw refuse('symlink', `${d.name} is a symlink; skills with symlinks are not copied`);
            if (d.isDirectory()) copy(a, b);
            else if (d.isFile()) {
                fs.copyFileSync(a, b);
                fs.chmodSync(b, fs.statSync(a).mode & 0o755);
            }
        }
    };
    try {
        copy(srcDir, tmp);
        fs.renameSync(tmp, dest);
    } catch (err) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw err;
    }
    return { dir: dest, trashed };
}

/** Copy any skill (typically a read-only one) into an editable root. */
function copy({ dir, project, target = {} }) {
    const { dir: skillDir } = locate(dir, project);
    const root = targetRoot(target.runtime || 'claude', target.scope || 'user', project);
    const name = target.name || path.basename(skillDir);
    const placed = placeTree(skillDir, root, name, { overwrite: false });
    return skillRow(root, placed.dir);
}

module.exports = {
    SKILL_FILE, RUNTIMES, MAX_FILE_BYTES, NAME_RE,
    roots, targetRoot, list, locate, resolveInside, readFile, writeFile, create, remove, copy,
    placeTree, frontmatter, listFiles, isBinary, checkName, template, homes, setPluginSource,
};
