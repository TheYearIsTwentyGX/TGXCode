'use strict';

// Importing a skill from somewhere else: finding one with `npx skills find`,
// fetching it into a staging directory, showing every byte that would be
// written, and only then writing it. The skills on disk are bridge/skills.js.
//
// A skill is instructions a model follows and often scripts it runs, fetched
// from a stranger's repository onto this machine, so the shape here is about
// that and not about convenience:
//
// - **Two calls, and nothing touches a skills directory until the second.**
//   `stage` fetches into `CACHE_DIR/skill-imports/<id>/` and answers with a
//   manifest: each skill found, each file in it with its size, sha256, whether
//   it is executable or binary, and its text when small enough to show.
//   `install` names the staging id, the skills ticked, and the `digest` of the
//   manifest the person was shown. The bridge hashes the staged files again and
//   refuses unless they are still exactly that manifest, so what lands is
//   byte-for-byte what was on screen — a staging directory edited in between,
//   or a client that skipped the preview, gets a refusal.
//
// - **The fetch runs nothing it fetched.** `git clone --depth 1` with hooks
//   pointed at /dev/null, the `file` and `ext` transports off, no submodules
//   (git does not recurse unless asked), LFS smudge skipped, and no terminal
//   prompt. A raw `SKILL.md` URL is one https GET. Source parsing reuses
//   bridge/github-clone.js's `parseRepoInput`, which refuses local paths,
//   `file:`, `ext::` and anything that starts with `-`.
//
// - **Size is weighed, not refused.** Every file is walked and counted, so the
//   preview shows true totals, and the counts go to bridge/skill-safety.js,
//   which turns them, the frontmatter hooks and `allowed-tools` into a 0–100
//   score with a green/yellow/red level. A red skill installs only when the
//   request carries `confirmedRisk: true` — the client's full-screen warning
//   is the place that is meant to come from, and the bridge holds the line so
//   that a client which skips the warning is refused rather than trusted.
//   (Until this, 500 files or 5 MB per skill was a refusal, which turned away
//   taste-skill — 1,631 files, mostly design assets — and said nothing about
//   its Stop hook.)
//
// - **One ceiling, against a runaway clone**, not against big skills: 20,000
//   files or 500 MB in the checkout (`.git` aside) and staging gives up with a
//   `too-large`. A clone is also watched while it runs and stopped once its
//   directory passes 1 GB on disk, pack included, so the ceiling protects the
//   disk and not just the answer. A skill containing a symlink, a device or a
//   path nested past 16 levels is still listed with a `problem` and cannot be
//   installed; the rest of the repository is still offered.
//
// - **The answer stays small whatever the skill weighs.** Hashing reads in
//   1 MB chunks, and text is kept only for what is sent inline: files up to
//   64 KB, `SKILL.md`s first, then scripts and executables, then the rest,
//   until 512 KB of text across the whole staging. Every other text file up to
//   256 KB carries `viewable: true` and is read on demand from the staging
//   directory (`stageFile`), which checks its sha256 against the manifest
//   before answering, so what is opened later is still what was hashed.
//
// - **`npx skills` is used to search, never to install.** `skills add` writes
//   straight into the skills directory, which is the step the preview exists to
//   stand in front of. `skills find` prints `owner/repo@skill N installs` and
//   a `└ https://skills.sh/…` line per result; `parseFind` reads that
//   tolerantly (ANSI stripped, the count and the link both optional) and each
//   result becomes a source `stage` accepts. The version is pinned so the
//   output format under test is the one that runs, and it is a subprocess —
//   `package.json` keeps `"dependencies": {}`.
//
// - **A staging directory lives 30 minutes**, and is deleted on install,
//   on discard, and by a sweep of anything older that runs on each stage.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');

const cfg = require('./config');
const { refuse } = require('./jsonfile');
const { parseRepoInput, branchProblem } = require('./github-clone');
const skills = require('./skills');
const safety = require('./skill-safety');

const STAGE_TTL_MS = 30 * 60_000;
/** The runaway-clone ceilings. An object so a test can lower them (`setLimits`). */
const DEFAULT_LIMITS = { stageFiles: 20_000, stageBytes: 500 * 1024 * 1024, cloneDisk: 1024 * 1024 * 1024 };
const LIMITS = { ...DEFAULT_LIMITS };
/** For tests: lower the ceilings, or put them back with no argument. */
function setLimits(l) { Object.assign(LIMITS, DEFAULT_LIMITS, l || {}); }
const MAX_TEXT_INLINE = 64 * 1024;
const INLINE_BUDGET = 512 * 1024;
const MAX_TEXT_FETCH = 256 * 1024;
const MAX_MANIFEST_DEPTH = 16;
const REMOTE_SCAN_MAX = 1024 * 1024;
const MAX_SKILLS = 200;
const MAX_DISCOVER_DEPTH = 6;
const CLONE_TIMEOUT_MS = 2 * 60_000;
const GET_MAX_BYTES = 256 * 1024;
const SKILLS_CLI = 'skills@1.9.1';
const SEARCH_TIMEOUT_MS = 90_000;
const SEARCH_TTL_MS = 5 * 60_000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SCRIPT_RE = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|exe|php)$/i;

const stageRoot = () => path.join(cfg.CACHE_DIR, 'skill-imports');

/** id -> {id, dir, base, source, at, skills: [{folder, files: [...]}], digest} */
const stages = new Map();

// ---------------------------------------------------------------------------
// Fetching, replaceable for tests
// ---------------------------------------------------------------------------

function gitEnv() {
    return {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GH_PROMPT_DISABLED: '1',
        GIT_ALLOW_PROTOCOL: 'https:ssh',
        GIT_LFS_SKIP_SMUDGE: '1',
        GIT_CONFIG_NOSYSTEM: '1',
    };
}

function runGit(args, opts = {}, watch = null) {
    return new Promise((resolve) => {
        const child = execFile('git', args, { timeout: CLONE_TIMEOUT_MS, env: gitEnv(), maxBuffer: 8 * 1024 * 1024, ...opts },
            (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') }));
        if (watch) watch(child);
    });
}

const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
    '-c', 'core.symlinks=true', '-c', 'submodule.recurse=false'];

async function lsRemote(url) {
    const r = await runGit([...SAFE_GIT, 'ls-remote', '--heads', '--tags', '--', url], { timeout: 30_000 });
    if (!r.ok) throw refuse('fetch', firstLine(r.stderr) || 'could not reach the repository');
    return r.stdout.split('\n').map(l => l.split('\t')[1]).filter(Boolean)
        .map(ref => ref.replace(/^refs\/(heads|tags)\//, '').replace(/\^\{\}$/, ''));
}

async function gitClone({ url, branch, dir }) {
    const args = [...SAFE_GIT, 'clone', '--depth', '1', '--single-branch', '--no-tags', '--quiet'];
    if (branch) args.push('--branch', branch);
    args.push('--', url, dir);
    // Watch the disk while it runs: the ceiling is meant to protect the disk,
    // and a check after the clone would only report how full it got.
    let over = false;
    let timer = null;
    const r = await runGit(args, {}, (child) => {
        timer = setInterval(() => {
            if (diskBytes(dir, LIMITS.cloneDisk) > LIMITS.cloneDisk) { over = true; child.kill('SIGKILL'); }
        }, 1000);
    });
    clearInterval(timer);
    if (over) throw refuse('too-large', `that repository passed ${LIMITS.cloneDisk / 1024 / 1024 / 1024} GB while cloning, so the clone was stopped`);
    if (!r.ok) throw refuse('fetch', firstLine(r.stderr) || 'git clone failed');
}

/** Bytes on disk under `dir`, everything included, stopping once past `cap`. */
function diskBytes(dir, cap) {
    let total = 0;
    const walk = (abs) => {
        let items;
        try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
        for (const d of items) {
            if (total > cap) return;
            const p = path.join(abs, d.name);
            if (d.isDirectory()) walk(p);
            else if (d.isFile()) { try { total += fs.statSync(p).size; } catch { /* mid-write */ } }
        }
    };
    walk(dir);
    return total;
}

/** One https GET, following a few https redirects, capped. */
function httpsGet(url, { redirects = 3 } = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch { return reject(refuse('invalid', 'not a URL')); }
        if (u.protocol !== 'https:') return reject(refuse('invalid', 'only https URLs are fetched'));
        const req = https.get(u, { timeout: 30_000, headers: { 'User-Agent': 'tgxcode-skill-import' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirects <= 0) return reject(refuse('fetch', 'too many redirects'));
                return resolve(httpsGet(new URL(res.headers.location, u).toString(), { redirects: redirects - 1 }));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(refuse('fetch', `the server answered ${res.statusCode}`)); }
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
                size += c.length;
                if (size > GET_MAX_BYTES) { req.destroy(); reject(refuse('too-large', 'that file is larger than 256KB')); return; }
                chunks.push(c);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(refuse('fetch', 'the request timed out')));
        req.on('error', (e) => reject(e.code ? e : refuse('fetch', e.message)));
    });
}

let fetcher = { lsRemote, clone: gitClone, get: httpsGet };
/** For tests: replace the network. */
function setFetcher(f) { fetcher = f ? { ...fetcher, ...f } : { lsRemote, clone: gitClone, get: httpsGet }; }

const firstLine = (s) => String(s || '').trim().split('\n').filter(l => !/^hint:/.test(l))[0] || '';

// ---------------------------------------------------------------------------
// Reading a source
// ---------------------------------------------------------------------------

const SUBPATH_RE = /^[A-Za-z0-9._ @+-]+(?:\/[A-Za-z0-9._ @+-]+)*$/;

function cleanSub(sub) {
    const s = String(sub || '').replace(/^\/+|\/+$/g, '');
    if (!s) return null;
    if (!SUBPATH_RE.test(s) || s.split('/').some(p => p === '.' || p === '..')) return { error: `"${s}" is not a path in a repository` };
    return s;
}

/**
 * What was typed, as one of:
 *   {kind: 'file', url}                       a raw SKILL.md over https
 *   {kind: 'repo', url, fullName, ref?, tail?, sub?, skill?}
 * `tail` is a GitHub `tree/…` remainder whose split into ref and path needs the
 * remote's refs to decide; `sub` is a path already known to be one.
 */
function parseSource(input, skill) {
    let s = String(input == null ? '' : input).trim();
    if (!s) return { error: 'enter a repository, a GitHub URL or a SKILL.md URL' };
    if (s.startsWith('-') || /[\0\n\r]/.test(s)) return { error: 'that is not a source' };
    let want = skill ? String(skill).trim() : null;

    // GitHub blob URL of a SKILL.md: fetch it raw.
    let m = /^https:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/(.+\/)?SKILL\.md$/i.exec(s);
    if (m) {
        return { kind: 'file', url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3] || ''}SKILL.md`, name: guessName(m[3]) };
    }
    if (/^https:\/\/\S+\/SKILL\.md(\?.*)?$/i.test(s)) {
        const u = new URL(s);
        return { kind: 'file', url: u.toString(), name: guessName(path.posix.dirname(u.pathname)) };
    }
    // skills.sh page: https://skills.sh/owner/repo/skill
    m = /^https:\/\/(?:www\.)?skills\.sh\/([^/]+)\/([^/]+)(?:\/([^/?#]+))?\/?$/i.exec(s);
    if (m) { s = `${m[1]}/${m[2]}`; want = want || (m[3] ? decodeURIComponent(m[3]) : null); }
    // owner/repo@skill — what `skills find` prints.
    m = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)@(.+)$/.exec(s);
    if (m) { s = m[1]; want = want || m[2]; }

    // owner/repo/sub/path, with no scheme.
    m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(.+)$/.exec(s);
    if (m && !/^(?:www\.)?github\.com$/i.test(m[1]) && !s.includes(':')) {
        const sub = cleanSub(m[3]);
        if (sub && sub.error) return sub;
        const ref = parseRepoInput(`${m[1]}/${m[2]}`);
        if (ref.error) return ref;
        return { kind: 'repo', url: `https://github.com/${ref.fullName}.git`, fullName: ref.fullName, sub, skill: want };
    }

    const ref = parseRepoInput(s);
    if (ref.error) return ref;
    if (ref.kind === 'github') {
        return { kind: 'repo', url: `https://github.com/${ref.fullName}.git`, fullName: ref.fullName,
            ...(ref.branch ? { tail: ref.branch } : {}), skill: want };
    }
    return { kind: 'repo', url: ref.url, fullName: ref.fullName, skill: want };
}

function guessName(dirPath) {
    const base = path.posix.basename(String(dirPath || '').replace(/\/+$/, ''));
    return slug(base) || 'imported-skill';
}

/** A folder or display name as a skill name both runtimes accept. */
function slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/** Split a GitHub `tree/<ref>/<path>` remainder against the remote's refs: longest ref wins. */
function splitTail(tail, refs) {
    const parts = tail.split('/');
    for (let i = parts.length; i > 0; i--) {
        const ref = parts.slice(0, i).join('/');
        if (refs.includes(ref)) return { ref, sub: parts.slice(i).join('/') || null };
    }
    return { ref: parts[0], sub: parts.slice(1).join('/') || null };
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

const CHUNK = 1024 * 1024;
const REMOTE_EXEC_RE = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:ba|z)?sh\s+(?:-c\s+)?["']?\$?\(\s*(?:curl|wget)\b|<\(\s*(?:curl|wget)\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*iex\b/i;

/**
 * One file read in chunks: its sha256, whether it looks binary (a NUL in the
 * first 8KB, the rule bridge/skills.js uses), and whether its text pipes a
 * download into a shell. Holds at most one chunk, whatever the file weighs.
 */
function readFileFacts(p, size) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(size, 1)));
    let binary = false;
    let remote = false;
    let pos = 0;
    let carry = '';
    try {
        for (;;) {
            const n = fs.readSync(fd, buf, 0, buf.length, pos);
            if (!n) break;
            const chunk = buf.subarray(0, n);
            if (pos === 0) binary = skills.isBinary(chunk);
            hash.update(chunk);
            if (!binary && !remote && pos < REMOTE_SCAN_MAX) {
                const t = carry + chunk.toString('utf8');
                remote = REMOTE_EXEC_RE.test(t);
                carry = t.slice(-200);
            }
            pos += n;
        }
    } finally {
        fs.closeSync(fd);
    }
    return { sha256: hash.digest('hex'), binary, remote };
}

/**
 * Every file of one staged skill, hashed and flagged, and the counts the
 * safety score is made of. No text: `inlineTexts` adds that afterwards, within
 * a budget for the whole staging.
 */
function manifestOf(dir) {
    const files = [];
    let bytes = 0;
    let problem = null;
    const counts = { scripts: 0, executables: 0, binaries: 0, unreadable: 0 };
    const remoteExec = [];
    const walk = (abs, rel, depth) => {
        for (const d of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (d.name === '.git') continue;
            const r = rel ? `${rel}/${d.name}` : d.name;
            const p = path.join(abs, d.name);
            // Problems stop the install, not the count: the totals stay true.
            if (d.isSymbolicLink()) { problem = problem || `${r} is a symlink; a skill with symlinks is not installed`; continue; }
            if (d.isDirectory()) {
                if (depth >= MAX_MANIFEST_DEPTH) { problem = problem || `${r} is nested too deep`; continue; }
                walk(p, r, depth + 1);
                continue;
            }
            if (!d.isFile()) { problem = problem || `${r} is not a regular file`; continue; }
            if (files.length >= LIMITS.stageFiles) throw refuse('too-large', `more than ${LIMITS.stageFiles.toLocaleString('en')} files in one skill`);
            const st = fs.statSync(p);
            bytes += st.size;
            if (bytes > LIMITS.stageBytes) throw refuse('too-large', `one skill is larger than ${LIMITS.stageBytes / 1024 / 1024} MB`);
            const facts = readFileFacts(p, st.size);
            const executable = Boolean(st.mode & 0o111);
            const script = SCRIPT_RE.test(d.name);
            if (script) counts.scripts += 1;
            if (executable) counts.executables += 1;
            if (facts.binary) counts.binaries += 1;
            else if (st.size > MAX_TEXT_FETCH) counts.unreadable += 1;
            if (facts.remote) remoteExec.push(r);
            files.push({
                path: r, bytes: st.size, sha256: facts.sha256, executable, binary: facts.binary,
                ...(script ? { script: true } : {}),
                ...(!facts.binary && st.size <= MAX_TEXT_FETCH ? { viewable: true } : {}),
            });
        }
    };
    walk(dir, '', 0);
    return { files, bytes, problem, counts, remoteExec };
}

/** Read `rel` under `abs` only if it still hashes to `sha`; else null. */
function readVerified(abs, rel, sha) {
    const p = path.join(abs, ...rel.split('/'));
    try {
        if (fs.lstatSync(p).isSymbolicLink()) return null;
        const buf = fs.readFileSync(p);
        return sha256(buf) === sha ? buf : null;
    } catch { return null; }
}

/**
 * Put text on the files the answer carries inline: up to 64KB each and
 * INLINE_BUDGET in all, `SKILL.md`s first, then scripts and executables, then
 * everything else in path order. A file whose bytes no longer hash to its
 * manifest row gets none, and its skill a `problem`.
 */
function inlineTexts(rows) {
    const tier = (f) => (f.path === skills.SKILL_FILE ? 0 : (f.script || f.executable) ? 1 : 2);
    const cands = [];
    for (const row of rows) {
        for (const f of row.files) if (f.viewable && f.bytes <= MAX_TEXT_INLINE) cands.push({ row, f, t: tier(f) });
    }
    cands.sort((a, b) => a.t - b.t);
    let budget = INLINE_BUDGET;
    for (const { row, f } of cands) {
        if (f.bytes > budget) continue;
        const buf = readVerified(row.abs, f.path, f.sha256);
        if (!buf) { row.problem = row.problem || `${f.path} changed while it was being staged`; continue; }
        f.text = buf.toString('utf8');
        budget -= f.bytes;
    }
}

/** The digest of what a person is shown: which skills, which files, which bytes, which mode. */
function digestOf(list) {
    const canon = list.filter(s => !s.problem).map(s => [s.folder, s.files.map(f => [f.path, f.sha256, f.executable])]);
    return sha256(Buffer.from(JSON.stringify(canon)));
}

/** Directories under `base` holding a SKILL.md, not descending into one once found. */
function discover(base) {
    const found = [];
    const walk = (abs, depth) => {
        if (found.length >= MAX_SKILLS) return;
        let items;
        try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
        if (items.some(d => d.isFile() && d.name === skills.SKILL_FILE)) { found.push(abs); return; }
        if (depth >= MAX_DISCOVER_DEPTH) return;
        for (const d of items.sort((a, b) => a.name.localeCompare(b.name))) {
            if (d.isDirectory() && !SKIP_DIRS.has(d.name)) walk(path.join(abs, d.name), depth + 1);
        }
    };
    walk(base, 0);
    return found;
}

/** Files and bytes under a checkout, `.git` aside, stopping once past either ceiling. */
function treeStats(dir) {
    let files = 0;
    let bytes = 0;
    const over = () => files > LIMITS.stageFiles || bytes > LIMITS.stageBytes;
    const walk = (abs) => {
        for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
            if (over()) return;
            if (d.name === '.git') continue;
            const p = path.join(abs, d.name);
            if (d.isDirectory()) walk(p);
            else if (d.isFile()) { files += 1; bytes += fs.statSync(p).size; }
        }
    };
    walk(dir);
    return { files, bytes, over: over() };
}

// ---------------------------------------------------------------------------
// Stage, install, discard
// ---------------------------------------------------------------------------

function sweep(now = Date.now()) {
    for (const [id, st] of stages) {
        if (now - st.at > STAGE_TTL_MS) { fs.rmSync(st.dir, { recursive: true, force: true }); stages.delete(id); }
    }
    // Directories a previous bridge left behind.
    let items = [];
    try { items = fs.readdirSync(stageRoot(), { withFileTypes: true }); } catch { /* none yet */ }
    for (const d of items) {
        if (!d.isDirectory() || stages.has(d.name)) continue;
        const p = path.join(stageRoot(), d.name);
        try { if (now - fs.statSync(p).mtimeMs > STAGE_TTL_MS) fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone */ }
    }
}

function matches(row, want) {
    if (!want) return false;
    const w = slug(want);
    return slug(row.name) === w || slug(row.folder) === w;
}

/** What the client gets for a staging: everything but the server's own paths. */
function stageOut(st) {
    return {
        id: st.id,
        source: st.source,
        ...(st.fullName ? { fullName: st.fullName } : {}),
        ...(st.ref ? { ref: st.ref } : {}),
        ...(st.sub ? { sub: st.sub } : {}),
        ...(st.skill ? { skill: st.skill } : {}),
        expiresAt: st.at + STAGE_TTL_MS,
        digest: st.digest,
        skills: st.skills.map(({ abs, ...rest }) => rest),
    };
}

/**
 * Fetch a source into a staging directory and describe every skill in it.
 * @param {{source: string, skill?: string}} body
 */
async function stage({ source, skill } = {}) {
    sweep();
    const src = parseSource(source, skill);
    if (src.error) throw refuse('invalid', src.error);
    const id = crypto.randomBytes(9).toString('base64url');
    const dir = path.join(stageRoot(), id);
    fs.mkdirSync(dir, { recursive: true });
    const st = { id, dir, at: Date.now(), source: String(source).trim(), skill: src.skill || null };
    try {
        let base;
        if (src.kind === 'file') {
            const buf = await fetcher.get(src.url);
            if (skills.isBinary(buf)) throw refuse('invalid', 'that URL is not a text file');
            base = path.join(dir, 'file');
            fs.mkdirSync(path.join(base, src.name), { recursive: true });
            fs.writeFileSync(path.join(base, src.name, skills.SKILL_FILE), buf, { mode: 0o644 });
        } else {
            let ref = null;
            let sub = src.sub || null;
            if (src.tail) {
                const refs = await fetcher.lsRemote(src.url);
                ({ ref, sub } = splitTail(src.tail, refs));
                const bad = branchProblem(ref);
                if (bad) throw refuse('invalid', bad);
                const cleaned = cleanSub(sub);
                if (cleaned && cleaned.error) throw refuse('invalid', cleaned.error);
                sub = cleaned;
            }
            const checkout = path.join(dir, 'repo');
            await fetcher.clone({ url: src.url, branch: ref, dir: checkout });
            const size = treeStats(checkout);
            if (size.over) {
                throw refuse('too-large', `that repository has more than ${LIMITS.stageFiles.toLocaleString('en')} files or ${LIMITS.stageBytes / 1024 / 1024} MB, `
                    + 'which is past what staging will hold; it is not read further');
            }
            base = sub ? path.join(checkout, ...sub.split('/')) : checkout;
            if (!base.startsWith(checkout) || !fs.existsSync(base)) throw refuse('not-found', `${sub} is not in that repository`);
            if (fs.lstatSync(base).isSymbolicLink()) throw refuse('symlink', `${sub} is a symlink`);
            Object.assign(st, { fullName: src.fullName, ref, sub });
        }
        const found = discover(base);
        if (!found.length) throw refuse('not-found', 'no SKILL.md found there');
        const rows = found.map((abs) => {
            const m = manifestOf(abs);
            const skillMd = m.files.find(f => f.path === skills.SKILL_FILE);
            const mdBuf = skillMd && skillMd.viewable ? readVerified(abs, skills.SKILL_FILE, skillMd.sha256) : null;
            const mdText = mdBuf ? mdBuf.toString('utf8') : null;
            const fm = skills.frontmatter(mdText);
            const hooks = safety.parseHooks(mdText);
            // A repository whose root is the skill is named for the repository.
            const folder = st.fullName && abs === path.join(dir, 'repo')
                ? st.fullName.split('/').pop() : path.basename(abs);
            const rel = path.relative(base, abs).split(path.sep).join('/') || '.';
            const row = {
                folder, path: rel, abs,
                name: fm.name || folder,
                description: fm.description,
                installAs: skills.NAME_RE.test(folder) ? folder : (slug(fm.name || folder) || 'imported-skill'),
                hooks: fm.hooks,
                allowedTools: fm.allowedTools,
                bytes: m.bytes,
                files: m.files,
                ...(m.problem ? { problem: m.problem } : {}),
            };
            row.safety = safety.scoreSkill({
                files: m.files.length, bytes: m.bytes, ...m.counts, remoteExec: m.remoteExec,
                hooks, allowedTools: fm.allowedTools,
            });
            row.safety.hooksText = hooks.raw || null;
            row.warnings = warningsOf(row, m);
            return row;
        });
        inlineTexts(rows);
        for (const r of rows) if (matches(r, st.skill)) r.match = true;
        st.skills = rows;
        st.digest = digestOf(rows);
        stages.set(id, st);
        return stageOut(st);
    } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw err;
    }
}

/** What the preview should flag before anybody ticks a box. */
function warningsOf(row, m) {
    const w = [];
    const { executables: exec, scripts, binaries: binary } = m.counts;
    if (exec) w.push({ kind: 'executable', text: `${exec} executable file${exec === 1 ? '' : 's'}` });
    if (scripts) w.push({ kind: 'scripts', text: `${scripts} script${scripts === 1 ? '' : 's'}` });
    if (binary) w.push({ kind: 'binary', text: `${binary} binary file${binary === 1 ? '' : 's'}, not shown` });
    if (row.hooks) {
        const events = [...new Set(row.safety.hooks.map(h => h.event).filter(Boolean))];
        w.push({ kind: 'hooks', text: `declares hooks${events.length ? ` on ${events.join(', ')}` : ''}, which run commands while the skill is active` });
    }
    if (row.allowedTools) w.push({ kind: 'allowed-tools', text: `pre-approves tools: ${row.allowedTools}` });
    if (m.remoteExec.length) w.push({ kind: 'remote-exec', text: `pipes a download into a shell in ${m.remoteExec.length} file${m.remoteExec.length === 1 ? '' : 's'}` });
    return w;
}

/**
 * One staged file's text, read now from the staging directory, for a file the
 * answer did not carry inline. Only a path the manifest lists can be named, so
 * nothing outside the staging is reachable, and the bytes must still hash to
 * the manifest row or it is a 409.
 */
function stageFile({ id, skill, file } = {}) {
    const st = typeof id === 'string' && stages.get(id);
    if (!st) throw refuse('not-found', 'that preview has expired; fetch it again');
    const row = st.skills.find(r => r.folder === skill);
    if (!row) throw refuse('not-found', `"${skill}" is not in this preview`);
    const f = row.files.find(x => x.path === file);
    if (!f) throw refuse('not-found', `${file} is not in ${skill}`);
    const out = { skill, path: f.path, bytes: f.bytes, sha256: f.sha256, binary: f.binary, executable: f.executable };
    if (f.binary || f.bytes > MAX_TEXT_FETCH) return { ...out, text: null, truncated: !f.binary };
    const buf = readVerified(row.abs, f.path, f.sha256);
    if (!buf) throw refuse('conflict', `${file} changed since it was shown; fetch it again`);
    return { ...out, text: buf.toString('utf8'), truncated: false };
}

/**
 * Write ticked skills from a staging into a skills root, if the staging is
 * still exactly what was shown.
 * @param {{id, digest, skills: string[], target: {runtime, scope}, project?, overwrite?}} body
 */
function install({ id, digest, skills: chosen, target = {}, project, overwrite = false, confirmedRisk = false } = {}) {
    sweep();
    const st = typeof id === 'string' && stages.get(id);
    if (!st) throw refuse('not-found', 'that preview has expired; fetch it again');
    if (typeof digest !== 'string' || digest !== st.digest) throw refuse('conflict', 'that is not the preview this import was staged as');
    if (!Array.isArray(chosen) || !chosen.length) throw refuse('invalid', 'tick at least one skill');
    const root = skills.targetRoot(target.runtime, target.scope, project);
    const picks = [];
    for (const name of chosen) {
        const row = st.skills.find(r => r.folder === name);
        if (!row) throw refuse('invalid', `"${name}" is not in this preview`);
        if (row.problem) throw refuse('invalid', `${name}: ${row.problem}`);
        picks.push(row);
    }
    // A red skill needs the warning to have been agreed to, by whichever client sent this.
    const risky = picks.filter(r => r.safety && r.safety.requiresConfirm);
    if (risky.length && confirmedRisk !== true) {
        const err = refuse('unconfirmed', `${risky.map(r => r.folder).join(', ')} ${risky.length === 1 ? 'is' : 'are'} rated red; `
            + 'install again with confirmedRisk: true once the warning has been read');
        err.detail = { skills: risky.map(r => ({ folder: r.folder, score: r.safety.score, level: r.safety.level })) };
        throw err;
    }
    for (const row of picks) {
        const name = row.folder;
        // The bytes on disk must still be the bytes on screen.
        let now;
        try { now = manifestOf(row.abs); } catch { throw refuse('conflict', `${name} changed since it was shown`); }
        const same = !now.problem && now.files.length === row.files.length
            && now.files.every((f, i) => f.path === row.files[i].path && f.sha256 === row.files[i].sha256 && f.executable === row.files[i].executable);
        if (!same) throw refuse('conflict', `${name} changed since it was shown; fetch it again`);
    }
    const names = picks.map(r => r.installAs);
    if (new Set(names).size !== names.length) throw refuse('invalid', 'two of those skills would install under the same name');
    if (!overwrite) {
        const clash = names.find(n => fs.existsSync(path.join(root.dir, n)));
        if (clash) throw refuse('exists', `${clash} already exists in ${root.label}`);
    }
    const installed = [];
    for (const row of picks) {
        const placed = skills.placeTree(row.abs, root, row.installAs, { overwrite });
        installed.push({ name: row.installAs, dir: placed.dir, ...(placed.trashed ? { trashed: placed.trashed } : {}) });
    }
    discard(id);
    return { installed, root: { runtime: root.runtime, scope: root.scope, dir: root.dir, label: root.label } };
}

function discard(id) {
    const st = stages.get(id);
    if (!st) return false;
    fs.rmSync(st.dir, { recursive: true, force: true });
    stages.delete(id);
    return true;
}

// ---------------------------------------------------------------------------
// Search: `npx skills find`
// ---------------------------------------------------------------------------

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/**
 * `skills find` output as results. Tolerant on purpose: colour codes, the
 * install count and the link line are each optional, and anything that is not
 * a result line is skipped rather than failing the parse.
 * @returns {{source, skill, installs: string|null, url: string|null, repoUrl}[]}
 */
function parseFind(text) {
    const lines = String(text || '').replace(ANSI_RE, '').split(/\r?\n/).map(l => l.trim());
    const out = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
        const m = /^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)@(.+?)(?:\s+([\d.,]+\s*[KMB]?)\s+installs?)?$/i.exec(lines[i]);
        if (!m || lines[i].startsWith('Install with')) continue;
        let url = null;
        for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
            const u = /(https:\/\/\S+)/.exec(lines[j]);
            if (u) { url = u[1]; i = j; break; }
            if (lines[j]) break;
        }
        if (url) {
            try { if (new URL(url).hostname !== 'skills.sh') url = null; } catch { url = null; }
        }
        const key = `${m[1]}@${m[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            source: m[1], skill: m[2].trim(), installs: m[3] ? m[3].replace(/\s+/g, '') : null, url,
            repoUrl: `https://github.com/${m[1]}`,
        });
    }
    return out;
}

/** Why a query cannot go to `skills find` as an argument, or null. */
function queryProblem(q) {
    if (!q) return 'type something to search for';
    // skills@1.9.1 takes `--` but does not honour it (`find -- --help` prints
    // the help), so an argument that starts with `-` can only be refused.
    if (q.startsWith('-')) return 'a search cannot start with "-"';
    if (q.length > 100 || /[\0\n\r]/.test(q)) return 'that is not a search';
    return null;
}

function runFind(q) {
    // Checked here as well as in search(), so nothing can reach the argv without it.
    const bad = queryProblem(q);
    if (bad) return Promise.reject(refuse('invalid', bad));
    const cwd = path.join(cfg.CACHE_DIR, 'skills-cli');
    fs.mkdirSync(cwd, { recursive: true });
    const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', npm_config_yes: 'true', npm_config_update_notifier: 'false' };
    return new Promise((resolve, reject) => {
        execFile('npx', ['-y', SKILLS_CLI, 'find', q], { cwd, env, timeout: SEARCH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err && !stdout) {
                    if (err.code === 'ENOENT') return reject(refuse('unavailable', 'npx is not on this bridge’s PATH'));
                    return reject(refuse('fetch', firstLine(stderr) || err.message));
                }
                resolve(String(stdout || ''));
            });
    });
}

let finder = runFind;
/** For tests: replace the subprocess. */
function setFinder(fn) { finder = fn || runFind; }

const searchCache = new Map();
const searchInflight = new Map();

async function search(q) {
    const query = String(q || '').trim();
    const bad = queryProblem(query);
    if (bad) throw refuse('invalid', bad);
    const hit = searchCache.get(query);
    if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.value;
    if (searchInflight.has(query)) return searchInflight.get(query);
    const p = finder(query).then((text) => {
        const value = { q: query, results: parseFind(text), at: Date.now(), via: `npx ${SKILLS_CLI} find` };
        searchCache.set(query, { at: Date.now(), value });
        while (searchCache.size > 50) searchCache.delete(searchCache.keys().next().value);
        return value;
    }).finally(() => searchInflight.delete(query));
    searchInflight.set(query, p);
    return p;
}

module.exports = {
    STAGE_TTL_MS, LIMITS, setLimits, MAX_TEXT_INLINE, MAX_TEXT_FETCH, INLINE_BUDGET, SKILLS_CLI,
    parseSource, splitTail, slug, parseFind, manifestOf, digestOf, discover,
    stage, stageFile, install, discard, search, sweep, setFetcher, setFinder, queryProblem, runFind, diskBytes,
    _stages: stages,
};
