'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();

// Claude Code keeps one directory per project here, each holding <session-id>.jsonl
const PROJECTS_DIR = process.env.CLAUDE_SESSIONS_PROJECTS_DIR
    || path.join(HOME, '.claude', 'projects');

// Our cache lives outside ~/.claude so we never confuse Claude's own tooling.
const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'),
    'claude-sessions');

// 45888 is the everyday instance — the one you leave open with real sessions in
// it. Development runs on 45899 instead (`npm run dev`), so an agent working on
// this codebase can start, restart and kill its own bridge all day without
// touching yours. Nothing here should ever default to the everyday port.
const DEFAULT_PORT = 45888;
const DEV_PORT = 45899;

const PORT = Number(process.env.CLAUDE_SESSIONS_PORT || DEFAULT_PORT);
const IS_DEV = PORT !== DEFAULT_PORT;

// WSL runs with networkingMode=mirrored on this machine, so binding loopback is
// enough for the Windows-side Electron shell to reach us on 127.0.0.1.
const HOST = process.env.CLAUDE_SESSIONS_HOST || '127.0.0.1';

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

const VERSION = '1.0.0';

module.exports = {
    HOME, PROJECTS_DIR, CACHE_DIR, PORT, HOST, VERSION,
    DEFAULT_PORT, DEV_PORT, IS_DEV,
    DEVBROWSER_DEFAULT_PORT, CLAUDE_BIN, PORT_DENYLIST,
};
