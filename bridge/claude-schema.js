'use strict';

// What this app knows about the keys in Claude Code's own `settings.json`.
//
// **This catalogue has no authority.** It cannot drop a key, correct a value or
// declare one invalid. It proposes a control and a sentence, and everything
// else about the file comes off disk untouched. That is the opposite of
// bridge/prefs.js, whose SHAPE *is* the closed set of what may be in
// `~/.tgxcode/settings.json` — and the difference is not a style choice:
//
//   - **Claude Code ships no schema we can read.** It is one bundled binary;
//     there is no `settings.schema.json`, no `claude config`, and `claude
//     doctor` prints prose. So this file is hand-written, and it *will* fall
//     behind — a key added next month is a key this app has never heard of.
//   - **The real schema's root object is permissive.** Unknown keys are kept,
//     not rejected, and many fields degrade quietly rather than failing. So
//     round-tripping a key we do not model is safe, and refusing one would be
//     us being stricter than the program that reads the file.
//
// Two rules follow, and bridge/claude-config.js enforces both:
//
//   1. A key not in this catalogue is still shown and, if it holds a scalar,
//      still editable — by JSON type, labelled with its dotted path. That is
//      what makes drift cheap: the app grows a control for a new key the day a
//      session writes one, and cataloguing it later only adds a label.
//   2. A value this catalogue does not recognise is displayed as it is. The
//      key that proves why is `askUserQuestionTimeout`, whose value on this
//      machine is the string `"never"`. A catalogue that asserted "a timeout is
//      a number" would draw a spinner over the word `never` and the first save
//      would write `0`. So a `choice` is `open` unless the option list really
//      is closed, and an unrecognised value widens the list rather than losing.
//
// `check` exists for one narrow purpose: validating a value **the form itself
// just produced**. A bad value arriving from our own UI is a bug in our own UI
// and is refused loudly, exactly as PUT /api/prefs refuses one. It is never
// applied to what was read from the file.

// The Claude Code this catalogue was read against. Shown in the group note, so
// that "the app does not have a control for that" and "the app is out of date"
// are told apart by looking rather than by guessing.
const AGAINST_VERSION = '2.1.260';

// Bounds. Generous, because they exist to stop a runaway rather than to express
// a preference — a permissions list of 500 rules is already unmanageable, and
// one of 50,000 is an attempt to make the bridge do unbounded work.
const MAX_RULES = 500;
const MAX_RULE_CHARS = 1024;
const MAX_LIST = 200;
const MAX_MAP_KEYS = 200;
const MAX_STRING = 4096;

const isStr = (v, max = MAX_STRING) => typeof v === 'string' && v.length > 0 && v.length <= max;

/** A list of opaque strings — permission rules, directories, model names. */
function checkList(v, { max = MAX_LIST, chars = MAX_RULE_CHARS, unique = false } = {}) {
    if (!Array.isArray(v) || v.length > max) return false;
    if (!v.every(s => isStr(s, chars))) return false;
    // A duplicate rule in a list of 28 is invisible and always a mistake, so
    // the form refuses to create one. The *file* may well contain one, and
    // reading it is unaffected — this only gates what we write.
    if (unique && new Set(v).size !== v.length) return false;
    return true;
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function checkMap(v, valueOk) {
    if (!isPlainObject(v)) return false;
    const keys = Object.keys(v);
    if (keys.length > MAX_MAP_KEYS) return false;
    return keys.every(k => isStr(k, 256) && valueOk(v[k]));
}

/**
 * The groups, in the order the page draws them.
 *
 * `kind` picks the control and the check. `open` on a choice means the options
 * are a starting point rather than the whole world. `hint` is advisory only —
 * it says where a key normally belongs, and nothing refuses a write on it,
 * because Claude Code's real per-scope rules are not something we can read.
 */
const GROUPS = [
    {
        title: 'Permissions', key: 'permissions',
        note: 'What `claude` may do without asking. These are the highest-stakes '
            + 'keys in the file, and the only ones whose lists add up across '
            + 'scopes instead of overriding.',
        rows: [
            { path: 'permissions.defaultMode', kind: 'choice', open: true,
                options: ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'],
                label: 'Default permission mode',
                note: 'What `claude` starts in when nothing on the command line says '
                    + 'otherwise. A session started from this app gets its mode from the '
                    + 'Start a session dialog instead, so this is about terminals.',
                confirm: { bypassPermissions:
                    'bypassPermissions turns off every permission prompt for every '
                    + 'session that reads this file. Set it anyway?' } },
            { path: 'permissions.allow', kind: 'rules', wide: true,
                label: 'Allowed without asking',
                note: 'One rule per row, in the file’s own order — nothing here sorts '
                    + 'them, so a one-rule change stays a one-line diff.' },
            { path: 'permissions.deny', kind: 'rules', wide: true,
                label: 'Never allowed',
                note: 'Beats an allow rule for the same thing, at every scope.' },
            { path: 'permissions.ask', kind: 'rules', wide: true,
                label: 'Always ask',
                note: 'Asked even when a mode would otherwise let it through.' },
            { path: 'permissions.additionalDirectories', kind: 'strings', wide: true,
                label: 'Directories outside the workspace',
                note: 'Read and write reach these as well as the working directory.' },
            { path: 'permissions.blockReadsOutsideWorkingDirectories', kind: 'bool',
                label: 'Block reads outside the working directory' },
        ],
    },
    {
        title: 'Model', key: 'model',
        note: 'Which model answers, and how hard it thinks.',
        rows: [
            { path: 'model', kind: 'string',
                label: 'Model',
                note: 'An alias or a full id. Left empty, `claude` picks its own default.' },
            { path: 'fallbackModel', kind: 'strings',
                label: 'Fallbacks, in order',
                note: 'Tried when the model above is unavailable. `default` means the '
                    + 'built-in default at that position.' },
            { path: 'effortLevel', kind: 'choice', open: true,
                options: ['low', 'medium', 'high', 'xhigh'],
                label: 'Effort' },
            { path: 'alwaysThinkingEnabled', kind: 'bool', label: 'Always think first' },
            { path: 'autoCompactEnabled', kind: 'bool', label: 'Compact automatically' },
            { path: 'promptCacheTtl', kind: 'choice', open: true, options: ['5m', '1h'],
                label: 'Prompt cache lifetime' },
        ],
    },
    {
        title: 'Commits and pull requests', key: 'attribution',
        note: 'What `claude` writes into a commit message or a pull request body.',
        rows: [
            { path: 'attribution.commit', kind: 'string', label: 'Commit trailer' },
            { path: 'attribution.pr', kind: 'string', label: 'Pull request footer' },
            { path: 'includeCoAuthoredBy', kind: 'bool',
                label: 'Add a Co-Authored-By trailer',
                note: 'Superseded by the two fields above; still read, and worth '
                    + 'clearing once you have set them.' },
            { path: 'includeGitInstructions', kind: 'bool',
                label: 'Include the built-in commit instructions' },
        ],
    },
    {
        title: 'Worktrees', key: 'worktree',
        note: 'How `EnterWorktree` builds a worktree. This repository pins the '
            + 'first of these, and its CLAUDE.md explains why.',
        rows: [
            { path: 'worktree.baseRef', kind: 'choice', open: true, options: ['fresh', 'head'],
                label: 'Branch from',
                note: '`fresh` branches from the default branch on the remote; `head` '
                    + 'from the checkout in front of you.' },
            { path: 'worktree.symlinkDirectories', kind: 'strings',
                label: 'Directories to symlink rather than copy' },
            { path: 'worktree.sparsePaths', kind: 'strings', label: 'Sparse checkout paths' },
        ],
    },
    {
        title: 'Environment', key: 'env',
        note: 'Variables every `claude` started against this file inherits.',
        rows: [
            { path: 'env', kind: 'map-string', wide: true,
                label: 'Environment variables',
                note: 'A value here is visible to anything the session runs. This is a '
                    + 'poor place for a secret — a file in a repository even more so.' },
        ],
    },
    {
        title: 'Plugins and MCP', key: 'plugins',
        note: 'Which plugins load, and which MCP servers a project may bring with it.',
        rows: [
            { path: 'enabledPlugins', kind: 'map-bool', wide: true,
                label: 'Plugins',
                note: 'Every plugin this machine has installed, whether or not the file '
                    + 'has an opinion about it yet.' },
            { path: 'enableAllProjectMcpServers', kind: 'bool',
                label: 'Trust every MCP server a project declares',
                note: 'Off means each one is approved by name in the two lists below.' },
            { path: 'enabledMcpjsonServers', kind: 'strings', label: 'Approved project servers' },
            { path: 'disabledMcpjsonServers', kind: 'strings', label: 'Refused project servers' },
        ],
    },
    {
        title: 'Terminal and housekeeping', key: 'ui',
        note: 'How `claude` looks and behaves in a terminal. Normally set for you '
            + 'alone rather than checked into a repository.',
        rows: [
            { path: 'theme', kind: 'choice', open: true,
                options: ['auto', 'dark', 'light', 'dark-ansi', 'light-ansi',
                    'dark-daltonized', 'light-daltonized'],
                label: 'Theme', hint: 'user' },
            { path: 'editorMode', kind: 'choice', options: ['normal', 'vim'],
                label: 'Editor mode', hint: 'user' },
            { path: 'verbose', kind: 'bool', label: 'Verbose output', hint: 'user' },
            // A string, not a number, and not a choice either: the value on this
            // machine is "never". See the header.
            { path: 'askUserQuestionTimeout', kind: 'choice', open: true,
                options: ['60s', '5m', '10m', 'never'],
                label: 'How long a question waits', hint: 'user' },
            { path: 'preferredNotifChannel', kind: 'choice', open: true,
                options: ['auto', 'terminal_bell', 'iterm2', 'iterm2_with_bell',
                    'kitty', 'ghostty', 'notifications_disabled'],
                label: 'Notification channel', hint: 'user' },
            { path: 'cleanupPeriodDays', kind: 'int', min: 1, max: 3650,
                label: 'Keep transcripts for (days)',
                note: 'Claude Code deletes its own older transcripts on this schedule. '
                    + 'This app never deletes one you did not ask it to.', hint: 'user' },
            { path: 'respectGitignore', kind: 'bool', label: 'Respect ignore files when searching' },
            { path: 'autoUpdatesChannel', kind: 'choice', options: ['stable', 'latest', 'rc'],
                label: 'Update channel', hint: 'user' },
        ],
    },
    {
        title: 'Hooks', key: 'hooks',
        note: 'Commands that run around a session’s work. Read-only here, and '
            + 'deliberately: a hook `command` is an arbitrary shell string run on '
            + 'every matching tool call, which makes it the highest-privilege '
            + 'field in the file. What this shows instead is the one thing a text '
            + 'editor cannot — whether the script each hook points at still exists.',
        rows: [
            { path: 'hooks', kind: 'hooks', wide: true, label: 'Hooks' },
        ],
    },
    {
        title: 'Status line', key: 'statusLine',
        note: 'The line `claude` prints under its prompt.',
        rows: [
            { path: 'statusLine', kind: 'statusline', wide: true, label: 'Status line' },
        ],
    },
];

/** Every catalogued row, by dotted path. */
const CATALOG = new Map();
for (const group of GROUPS) {
    for (const row of group.rows) CATALOG.set(row.path, { ...row, group: group.key });
}

/**
 * Is this a value the form may write for this path?
 *
 * Only ever asked about a value the form produced. A `null` is a removal and
 * never reaches here.
 */
function check(path, value) {
    const row = CATALOG.get(path);
    if (!row) return false;
    switch (row.kind) {
        case 'bool': return typeof value === 'boolean';
        case 'int': return Number.isInteger(value)
            && (row.min === undefined || value >= row.min)
            && (row.max === undefined || value <= row.max);
        case 'string': return isStr(value);
        case 'choice': return row.open
            ? isStr(value, 256)
            : row.options.includes(value);
        case 'rules': return checkList(value, { max: MAX_RULES, unique: true });
        case 'strings': return checkList(value);
        case 'map-bool': return checkMap(value, (v) => typeof v === 'boolean');
        case 'map-string': return checkMap(value, (v) => typeof v === 'string' && v.length <= MAX_STRING);
        // Read-only kinds. The form has no control that produces one, so a
        // patch naming them is a bug rather than a preference, and it is
        // refused here rather than trusted. The raw tab reaches them.
        case 'hooks': case 'statusline': return false;
        default: return false;
    }
}

/** Why a value was refused, for the message the route sends back. */
function describe(path) {
    const row = CATALOG.get(path);
    if (!row) return 'not a key this page knows';
    switch (row.kind) {
        case 'bool': return 'true or false';
        case 'int': return `a whole number from ${row.min} to ${row.max}`;
        case 'string': return `text, up to ${MAX_STRING} characters`;
        case 'choice': return row.open
            ? 'a short string'
            : `one of ${row.options.join(', ')}`;
        case 'rules': return `up to ${MAX_RULES} distinct rules, each up to ${MAX_RULE_CHARS} characters`;
        case 'strings': return `up to ${MAX_LIST} strings`;
        case 'map-bool': return 'a set of names, each true or false';
        case 'map-string': return 'a set of name and value pairs';
        case 'hooks': case 'statusline': return 'read-only on this page — use Edit as JSON';
        default: return 'a value this page cannot produce';
    }
}

module.exports = {
    AGAINST_VERSION, GROUPS, CATALOG, check, describe, isPlainObject,
    MAX_RULES, MAX_RULE_CHARS, MAX_LIST, MAX_MAP_KEYS, MAX_STRING,
};
