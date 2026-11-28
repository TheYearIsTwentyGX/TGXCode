'use strict';

// The keys of Codex's `config.toml` worth a control: claude-schema.js's smaller
// sibling, read by bridge/codex-config.js and drawn by
// web/settings/codex-config.js.
//
// It differs from claude-schema.js in two ways, and both come from who owns the
// file:
//
//   - **This catalogue is the closed set of what may be written.** Claude's
//     settings are a JSON file we edit ourselves; Codex's are TOML we never
//     touch, written through the app-server's `config/value/write`. That method
//     validates the keys Codex has types for, but it takes any name under
//     `[features]` without a word (measured on 0.172.0), so a typo would sit in
//     the file doing nothing. Only a key listed here is written.
//   - **It is short on purpose.** Everything else in the file is named by the
//     page and left alone; `codex` itself and a text editor are how it is set.
//
// `kind`: `model` (a string; choices from `model/list`), `effort` (a string; the
// choices are the models'), `enum` (`options`), `bool`. A value on disk that
// does not fit — a granular `approval_policy` table, an effort a newer Codex
// added — is shown as it is and not rewritten unless somebody picks another.

// The Codex this catalogue was read against.
const AGAINST_VERSION = '0.172.0';

// TGXCode sends its own approval policy and sandbox on every turn
// (bridge/runtimes/codex/process.js, D5), so saying nothing would promise a
// change that never happens to a session started here.
const NOT_OURS = 'Applies to Codex in a terminal. Sessions TGXCode runs set this on every '
    + 'turn from the permission mode, whatever this says.';

const GROUPS = [
    {
        title: 'Model',
        keys: [
            { key: 'model', kind: 'model', label: 'Model',
                note: 'What a session runs on when none is picked for it.' },
            { key: 'model_reasoning_effort', kind: 'effort', label: 'Reasoning effort',
                note: 'How long the model thinks. Which levels there are depends on the model.' },
        ],
    },
    {
        title: 'Permissions',
        keys: [
            { key: 'approval_policy', kind: 'enum', label: 'Approval policy',
                options: [
                    ['untrusted', 'Ask for all but known-safe reads'],
                    ['on-request', 'Ask when the model wants more'],
                    ['never', 'Never ask'],
                ],
                note: NOT_OURS },
            { key: 'sandbox_mode', kind: 'enum', label: 'Sandbox',
                options: [
                    ['read-only', 'Read only'],
                    ['workspace-write', 'Write in the workspace'],
                    ['danger-full-access', 'No sandbox — full access'],
                ],
                note: NOT_OURS },
        ],
    },
    {
        title: 'Tools',
        keys: [
            { key: 'web_search', kind: 'enum', label: 'Web search',
                options: [
                    ['disabled', 'Off'],
                    ['cached', 'Cached results'],
                    ['indexed', 'Indexed results'],
                    ['live', 'Live'],
                ],
                note: 'What the web search tool may reach.' },
        ],
    },
];

// `[features]`. Only the flags Codex still reports (`experimentalFeature/list`)
// are shown, so one a later version removes drops off the page by itself.
const FEATURES = [
    { name: 'default_mode_request_user_input', label: 'Ask questions outside plan mode',
        note: 'Lets a session put a question card up in any mode, not only while planning. '
            + 'Still under development in Codex.' },
    { name: 'goals', label: 'Goals', note: 'Let a thread keep working towards a goal.' },
    { name: 'memories', label: 'Memories', note: 'Carry notes from one session to the next.' },
    { name: 'hooks', label: 'Hooks', note: 'Run your hooks at all.' },
    { name: 'apps', label: 'Apps', note: 'ChatGPT connectors.' },
    { name: 'plugins', label: 'Plugins', note: 'Installed plugins and what they bring.' },
    { name: 'image_generation', label: 'Image generation', note: 'The image tool.' },
    { name: 'fast_mode', label: 'Fast mode', note: 'Offer the faster service tier.' },
    { name: 'shell_snapshot', label: 'Shell snapshot',
        note: 'Snapshot your shell environment once instead of on every command.' },
];

const featureKey = (name) => `features.${name}`;

/** The catalogue entry for a key path, or null: what may be written. */
function entryFor(key) {
    for (const g of GROUPS) {
        const hit = g.keys.find(k => k.key === key);
        if (hit) return hit;
    }
    const f = FEATURES.find(x => featureKey(x.name) === key);
    return f ? { key, kind: 'bool', label: f.label, note: f.note } : null;
}

/** Is `value` something the form could have produced for this entry? */
function valid(entry, value) {
    if (value === null) return true;        // remove the key
    switch (entry.kind) {
        case 'model': return typeof value === 'string' && /^[\w.:/-]{1,200}$/.test(value);
        case 'effort': return typeof value === 'string' && /^[a-z0-9_-]{1,32}$/i.test(value);
        case 'enum': return entry.options.some(([v]) => v === value);
        case 'bool': return typeof value === 'boolean';
        default: return false;
    }
}

module.exports = { AGAINST_VERSION, GROUPS, FEATURES, featureKey, entryFor, valid };
