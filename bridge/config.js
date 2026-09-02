'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

// Claude Code keeps one directory per project here, each holding <session-id>.jsonl
const PROJECTS_DIR = process.env.CLAUDE_SESSIONS_PROJECTS_DIR
    || path.join(HOME, '.claude', 'projects');

// And one file per *running* session here, named for its pid. Read-only to us,
// like everything else under ~/.claude — see bridge/registry.js.
const REGISTRY_DIR = process.env.CLAUDE_SESSIONS_REGISTRY_DIR
    || path.join(HOME, '.claude', 'sessions');

// Our cache lives outside ~/.claude so we never confuse Claude's own tooling.
const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'),
    'claude-sessions');

// State the app owns, as opposed to state it merely reads. Losing the cache costs
// a rescan; losing this loses a decision the user made, so it lives under
// XDG_DATA_HOME rather than in the cache. bridge/flags.js and bridge/auth.js both
// write here and used to each define the path — one definition, so they cannot
// drift apart.
const STATE_DIR = path.join(
    process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'),
    'claude-sessions');

// The bearer token every /api/ route but /api/health requires. Created on first
// run with mode 0600; see bridge/auth.js.
const TOKEN_FILE = path.join(STATE_DIR, 'token');

// Where a project declares the commands this app will offer a button for — see
// bridge/commands.js. The shared file is checked in; the .local one is meant to
// be gitignored, and commands.js says so out loud when it is not.
const TGX_DIR = '.tgxcode';
const COMMANDS_FILE = 'commands.json';
const COMMANDS_LOCAL_FILE = 'commands.local.json';

// And where a project overrides how the app itself behaves — see bridge/prefs.js.
// Same directory and same two-file shape as the commands above, on purpose: one
// place to look, one precedence rule to remember.
const SETTINGS_FILE = 'settings.json';
const SETTINGS_LOCAL_FILE = 'settings.local.json';

// The user's own settings, as opposed to what a project declares. Deliberately
// not STATE_DIR: what lives there is state the app owns and nobody opens, and
// this is a file a person edits by hand — and the start of a directory meant to
// outlive this app's share of it.
const USER_TGX_DIR = path.join(HOME, TGX_DIR);
const USER_PREFS_FILE = path.join(USER_TGX_DIR, SETTINGS_FILE);

// The words the spinner uses while a turn runs — see bridge/spinner.js. A
// directory rather than a key in the settings file: there are thousands of them
// across a hundred-odd themed groups, and one file per group is what makes
// "delete the ones I don't like" a thing you can actually do.
const VERBS_DIR = 'verbs';
const USER_VERBS_DIR = path.join(USER_TGX_DIR, VERBS_DIR);

// A run's output, kept past the end of the run so "why did it die" survives
// longer than the pane. Under the cache rather than the state directory: losing
// it costs nothing a rerun would not recover. Created 0700; the files inside are
// 0600, because a dev server prints tokens.
const RUNS_LOG_DIR = path.join(CACHE_DIR, 'runs');

// 45888 is the everyday instance — the one you leave open with real sessions in
// it. Development runs on 45899 instead (`npm run dev`), so an agent working on
// this codebase can start, restart and kill its own bridge all day without
// touching yours. Nothing here should ever default to the everyday port.
const DEFAULT_PORT = 45888;
const DEV_PORT = 45899;

const PORT = Number(process.env.CLAUDE_SESSIONS_PORT || DEFAULT_PORT);
const IS_DEV = PORT !== DEFAULT_PORT;

// The checkout this bridge is running out of.
//
// Resolved from this file rather than from cwd, because the file's location is
// what decides what gets served: server.js builds WEB_DIR from __dirname too. A
// bridge started as `node bridge/server.js` from a worktree serves that
// worktree's UI no matter where the process was launched from, and this is the
// value that says so out loud — over /api/health, so the Windows shell can check
// what it is about to adopt.
const ROOT = path.resolve(__dirname, '..');

// EnterWorktree puts every worktree under .claude/worktrees/ inside the parent
// checkout, so the path is the test. A worktree bridge is a development bridge
// whatever port it was asked for — see the refusal in server.js.
const IS_WORKTREE = `${ROOT}${path.sep}`.includes(
    `${path.sep}.claude${path.sep}worktrees${path.sep}`);

// WSL runs with networkingMode=mirrored on this machine, so binding loopback is
// enough for the Windows-side Electron shell to reach us on 127.0.0.1.
//
// This never defaults to anything else, and remote access does not need it to.
// `tailscale serve` runs on the Windows host and proxies to Windows 127.0.0.1,
// which mirrored mode forwards in here — so a phone on the tailnet reaches the
// bridge while the socket stays on loopback and nothing is ever offered to the
// LAN. That matters more than usual on this machine: the home network is AT&T
// Community Wi-Fi for Apartments, a /24 shared with the building, and client
// isolation is misconfigured in both directions. See docs/remote.md.
const HOST = process.env.CLAUDE_SESSIONS_HOST || '127.0.0.1';

// Binding a non-loopback interface is a deliberate act, so it takes two env vars
// rather than one — see the refusal in server.js. A typo in HOST should not be
// able to publish the bridge to the building.
const ALLOW_REMOTE_BIND = process.env.CLAUDE_SESSIONS_ALLOW_REMOTE_BIND === '1';

// Whether a session this app starts gets the task tools back.
//
// Claude Code stopped offering them — TaskCreate/Get/Update/List and TodoWrite —
// to Opus 4.8, Sonnet 5 and every newer model, behind
// CLAUDE_CODE_ENABLE_TODO_TOOLS=1. Nothing on this machine has written a task
// list since that landed, so the conversation view's task panel and the boards'
// progress bars are both drawing a list that no longer exists.
//
// An opt-out rather than an opt-in, because the panel is on by default and a
// panel that is empty for everybody is worse than no panel at all. Set
// CLAUDE_SESSIONS_TODO_TOOLS=0 in front of the bridge and it adds nothing.
//
// It reaches only sessions the bridge *starts* — see sessionEnv in runner.js —
// and only from the next process start, so a session already running is
// unaffected. A session in somebody's own terminal keeps no list unless they set
// the variable for themselves.
const TODO_TOOLS = process.env.CLAUDE_SESSIONS_TODO_TOOLS !== '0';

/**
 * `~` and `~/thing` mean the home directory; `~other` is somebody else's and is
 * left alone. Used for the roots below and for any path a person may have typed
 * rather than clicked — a shell expands this before the program ever sees it, so
 * a path box that does not is a box that lies about what it accepts.
 */
function expandHome(p) {
    return String(p || '').replace(/^~(?=$|\/)/, HOME);
}

// Where a session may be started, and how far /api/fs will list. Defaults to the
// home directory: without it, one authenticated call can start an agent in /etc.
// Colon-separated, like PATH.
const ALLOWED_ROOTS = (process.env.CLAUDE_SESSIONS_ROOTS || HOME)
    .split(':').filter(Boolean).map(p => path.resolve(expandHome(p)));

// Extra browser origins allowed to call the API, for a reverse proxy on a hostname
// this code cannot guess. Loopback and *.ts.net are accepted without configuration.
const EXTRA_ORIGINS = (process.env.CLAUDE_SESSIONS_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

// DevBrowser's control server default. It advertises a different port in
// control-server.json when 45777 is taken; devbrowser.js prefers that file.
const DEVBROWSER_DEFAULT_PORT = 45777;

// nvm-managed node means PATH differs per shell, so callers may need to override.
const CLAUDE_BIN = process.env.CLAUDE_SESSIONS_CLAUDE_BIN || 'claude';

// Ports that are never a dev server worth offering a DevBrowser button for.
const PORT_DENYLIST = new Set([
    22, 25, 53, 80, 443, 445, 1433, 3306, 5432, 6379, 8125, 9229,
    11211, 27017, DEVBROWSER_DEFAULT_PORT, PORT,
]);

/**
 * Is this directory somewhere a session may be started, or a listing served?
 *
 * Compared after resolving, and with a separator on the end, so that `/home/dyl`
 * does not pass as being inside `/home/dylan_hays`. A root is inside itself.
 *
 * Symlinks are deliberately not resolved: `fs.realpathSync` here would reject a
 * perfectly ordinary worktree reached through a symlinked home, and the threat this
 * guards against — a caller naming /etc — does not need a symlink to try it.
 */
function withinRoots(dir) {
    if (!dir) return false;
    // Expanded here as well as at the callers, so that a route which forgets to
    // cannot accidentally widen the check: `~/x` unexpanded resolves against the
    // process cwd, which is not where the caller meant and not what will be used.
    const target = path.resolve(expandHome(dir));
    return ALLOWED_ROOTS.some(root =>
        target === root || target.startsWith(root + path.sep));
}

/**
 * A path with every symlink on it resolved, including one that does not exist yet.
 *
 * `fs.realpathSync` throws ENOENT rather than answering for a path that is not
 * there, and half of what this is asked about legitimately is not — a file
 * deleted from the working tree still has a diff against HEAD. So the deepest
 * ancestor that *does* exist is resolved and the rest is re-appended, which is
 * enough: what a containment check has to defend against is a real directory on
 * the way in being a link somewhere else, and a component that does not exist
 * cannot be one.
 *
 * @returns {string|null} the resolved path, or null if it cannot be worked out
 */
function realResolve(file) {
    const parts = [];
    let head = path.resolve(file);
    for (;;) {
        try {
            head = fs.realpathSync(head);
            break;
        } catch (err) {
            if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return null;
            const parent = path.dirname(head);
            // `/` is its own parent. Nothing on the path existed, which for an
            // absolute path should be impossible and is not worth guessing about.
            if (parent === head) return null;
            parts.unshift(path.basename(head));
            head = parent;
        }
    }
    return parts.length ? path.join(head, ...parts) : head;
}

/**
 * One of a session's own files, from a path the client sent.
 *
 * `attachmentPath` above takes the basename and rebuilds the directory, because
 * an attachment's directory is never meaningful. A source file's is, so this
 * cannot narrow the same way — and everything else it does is that function's
 * argument applied to a wider input: the path a client sends is a hint about
 * *which* file, and the answer is recomputed from a root the bridge worked out
 * for itself.
 *
 * `cfg.expandHome` is deliberately not called. The paths this receives are ones
 * the bridge handed the client a moment ago, in `/changes`; a leading `~/` in one
 * is a bug in the client, not a home directory it is entitled to.
 *
 * **Both a lexical and a resolved containment check, and the resolved one is the
 * one that matters.** `path.resolve` only rewrites text, so `..` is handled and a
 * symlink is not — and the first version of this function asked
 * `lstat(file).isSymbolicLink()`, which is the wrong question: `lstat` declines to
 * follow the *last* component only, so a leaf inside a symlinked *directory*
 * reports false and the check never ran. An agent with a shell can write
 * `ln -s / escape` into the checkout it is working in, and `escape/etc/passwd` is
 * then lexically inside the repository — which for the diff route, deliberately
 * readable remotely, would mean any file on the machine. So the real path is
 * always resolved and always compared against the real root.
 *
 * The lexical `cfg.withinRoots` stays as it was, on the unresolved path, because
 * that function resolves nothing on purpose: its subject is a directory the
 * *user* configured, and a home directory that is itself a link is the ordinary
 * case rather than an attack. Checking the resolved path against the roots as
 * well would refuse that. Containment inside the session's own repository is what
 * carries the weight here, and a repository inside the roots is inside them
 * however it is reached.
 *
 * @returns {string|null} the absolute path, or null if it is not inside `root`
 */
function sessionFilePath(root, given) {
    const raw = String(given == null ? '' : given).trim();
    if (!root || !raw) return null;
    // A NUL truncates the path at every syscall that will see it, so a name
    // carrying one is refused rather than silently meaning something shorter.
    if (raw.includes('\0')) return null;

    // An absolute `given` comes back from resolve unchanged, so this one line
    // takes both the repo-relative form the tree list uses and the absolute form
    // an edits row carries outside a repository.
    const file = path.resolve(root, raw);

    const inside = (p, base) => p === base || p.startsWith(base + path.sep);
    if (!inside(file, path.resolve(root))) return null;
    if (!withinRoots(file)) return null;

    const realRoot = realResolve(root);
    const real = realResolve(file);
    if (!realRoot || !real) return null;
    if (!inside(real, realRoot)) return null;

    return file;
}

const VERSION = '1.0.0';

module.exports = {
    HOME, PROJECTS_DIR, REGISTRY_DIR, CACHE_DIR, PORT, HOST, VERSION,
    ROOT, IS_WORKTREE,
    STATE_DIR, TOKEN_FILE,
    TGX_DIR, COMMANDS_FILE, COMMANDS_LOCAL_FILE, RUNS_LOG_DIR,
    SETTINGS_FILE, SETTINGS_LOCAL_FILE, USER_TGX_DIR, USER_PREFS_FILE,
    VERBS_DIR, USER_VERBS_DIR,
    ALLOW_REMOTE_BIND, TODO_TOOLS, ALLOWED_ROOTS, EXTRA_ORIGINS, withinRoots, sessionFilePath, realResolve, expandHome,
    DEFAULT_PORT, DEV_PORT, IS_DEV,
    DEVBROWSER_DEFAULT_PORT, CLAUDE_BIN, PORT_DENYLIST,
};
