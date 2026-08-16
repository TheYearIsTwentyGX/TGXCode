'use strict';

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

const VERSION = '1.0.0';

module.exports = {
    HOME, PROJECTS_DIR, REGISTRY_DIR, CACHE_DIR, PORT, HOST, VERSION,
    ROOT, IS_WORKTREE,
    STATE_DIR, TOKEN_FILE,
    ALLOW_REMOTE_BIND, ALLOWED_ROOTS, EXTRA_ORIGINS, withinRoots, expandHome,
    DEFAULT_PORT, DEV_PORT, IS_DEV,
    DEVBROWSER_DEFAULT_PORT, CLAUDE_BIN, PORT_DENYLIST,
};
