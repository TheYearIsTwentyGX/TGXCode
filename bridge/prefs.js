'use strict';

// Settings the person using the app chose, as opposed to flags they set on one
// conversation.
//
// The first of these is how the transcript folds a finished run of tool calls
// into one row — whether to do it at all, how long a run has to be, and whether
// a thinking block counts as part of the run or ends it. They are preferences
// about reading rather than about any one session, so they do not belong in
// bridge/flags.js, and they are not per-browser either: the same answer should
// come back in the Electron window, in a tab, and on a phone.
//
// `spinner` is the second, and the same argument puts it here: what a turn in
// progress calls itself should read the same on every surface, and it does,
// because the bridge decides it rather than each client. The verbs themselves
// are too many for this file and live one group per file in `~/.tgxcode/verbs/`
// — see bridge/spinner.js. What lands here is only which groups are in play.
//
// `live` is the third, and it is about a view rather than about reading or
// about wording: how much of a card the live board draws, and whether it draws
// sessions this window has no process for. Per-browser was the obvious home for
// it — the board's other layout choice, side or bottom, is localStorage — but it
// is the same argument as above that puts it here instead. How much of a card
// you want to see is a preference about the app, not about the machine you
// happened to open it on.
//
// `projects` is the fourth, and it is the only one that is a *map* rather than
// a handful of named keys: a colour per project directory, which the rail, the
// boards and the Start-a-session dialog wear so that a session scoped to the
// wrong checkout is something you see rather than something you read. It is
// here for `live`'s reason again — a colour you chose should be the same colour
// in the Electron window and in a tab — and it is **user-only** for a reason of
// its own, spelled out at USER_ONLY below: the map names other projects' paths,
// so a repository setting one would be a repository colouring its neighbours.
// Beside the map sit two plain keys about how strongly one piece of that is
// worn — the wash over a dialog's backdrop — which are here rather than in a
// section of their own because they mean nothing without the map.
//
// `keyboard` is the fifth, and it is the one section that is not about a view
// at all: which chord reaches which command, what Enter does in the composer,
// and whether Ctrl+C in the terminal copies a selection or interrupts. The
// bindings themselves are validated against bridge/keymap.js, which owns the
// catalogue of what may be bound — see the header there for why the list is not
// in `web/`.
//
// `toolbar` is the sixth: which buttons the top bar carries, in what order,
// which of them are folded into its More menu, and which show their text. A
// view rather than a behaviour, and here for `live`'s reason — the bar you
// arranged should be the same bar in every window.
//
// `wispr` is the seventh: the Wispr Flow transforms the composer's Wispr button
// lists, each a title and the chord Wispr Flow has it on. The bridge presses
// that chord on the desktop (see bridge/wispr.js), so it is **user-only** for
// `keyboard`'s reason made sharper — a repository choosing which keys get
// pressed on your machine is not a preference.
//
// **Where the file lives is the deliberate part.** `~/.tgxcode/settings.json`,
// not STATE_DIR. Everything under STATE_DIR is state the app owns and nobody is
// expected to open — a token, a set of archived ids. This is a file a person
// edits by hand and the settings page writes, and it is the start of a
// directory meant to hold more than this app's share of it. A
// project may override any key from `<workspace>/.tgxcode/settings.json`, which
// is the same directory a project already declares its commands in — see
// bridge/commands.js, whose precedence this mirrors so the two cannot disagree
// about what "the local file" means. `CLAUDE_SESSIONS_PREFS_DIR` moves the
// user's half somewhere else (see bridge/config.js). It is there so a dev
// bridge can test a save, not to give the file a second home.
//
// Unlike Flags, the defaults are written out on first read. A settings file
// with no UI in front of it has to be discoverable to be editable at all, and
// an empty `~/.tgxcode/` teaches nobody what may go in it. There is a settings
// page now — see `save()` at the foot of this file — and the defaults still get
// written, because the file being readable by hand is the thing that made the
// page possible to build rather than a step on the way to it.

const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const keymap = require('./keymap');
const { readJson, serialize, writeAtomic, writable, refuse } = require('./jsonfile');
// The accent rule, borrowed rather than copied. bridge/snippets.js owns it and
// argues at length for why it is that strict — the client turns the value into
// a CSS custom property, so `red`, `var(--x)` and `#fff;}` are all refused. A
// project's colour ends up in the same stylesheet as a snippet group's, so the
// two must not drift apart.
const { isAccent } = require('./snippets');
const { projectRootOf } = require('./transcript');
const wispr = require('./wispr');

const VERSION = 1;

// The size cap, the stat-before-read, the BOM and the atomic write all live in
// bridge/jsonfile.js now — three callers needed them and two of them had
// already drifted. What stays here is the one rule that is this file's own: a
// `version` that is not ours drops the file whole.

// Re-stat rather than watch, as commands.js does: one inotify watcher for a
// file that changes monthly is a poor trade, and this is read once per session
// open.
const CACHE_MS = 2000;

// How many projects may carry a colour. The same bound `spinner.groups` and
// `spinner.weights` take, for the same reason: this is a file people edit, and
// one naming ten thousand directories is either a mistake or an attempt to make
// the bridge do unbounded work. Nobody has two hundred projects; anybody who
// does has stopped being able to tell them apart by colour anyway.
const MAX_COLORS = 200;

// What the top bar is made of, in the order it has always been drawn. The page
// holds the same list — see TOOLBAR in web/app.js — and this copy exists so a
// file naming a button that does not exist is told so rather than kept.
//
// Two of them have rules the rest do not, and they are enforced here rather
// than only in the page, because the page is not the only thing that writes
// this file:
//
//  - `settings` may go into the More menu but never be hidden. It is the one
//    place a hidden button can be brought back from, so hiding it would leave
//    hand-editing the file as the only way home.
//  - `quota` stays on the bar. Its popover is anchored to the pill and holds
//    Restart bridge, and neither works from inside another popover.
const TOOLBAR_IDS = ['tasks', 'live', 'dashboard', 'history', 'drafts', 'schedules',
    'settings', 'quota', 'devbrowser'];
const TOOLBAR_PLACES = new Set(['bar', 'more', 'hidden']);
const TOOLBAR_PINNED = { settings: new Set(['bar', 'more']), quota: new Set(['bar']) };

const DEFAULTS = {
    version: VERSION,
    transcript: {
        // Fold a run of tool calls into one row once a message closes it.
        groupToolCalls: true,
        // ...but only when the run is at least this long. One or two rows
        // collapsed into a summary row loses more than it saves.
        groupMinCalls: 3,
        // Whether a thinking block is part of the work stretch or the end of
        // it. Folding it in keeps runs long; breaking on it fragments a turn
        // that thinks between every call into groups of two.
        groupIncludesThinking: true,
    },
    live: {
        // Stop a card at the tool-count line: no history preview, no message
        // box, no Open/Stop, and no approval row either. Everything below that
        // line goes, which is more than "a bit tighter" — a compact card is a
        // status light, and answering anything on it means opening the session.
        // That is the trade being asked for: many sessions readable at a glance
        // beats any one of them being actionable in place.
        compact: false,
        // Leave out sessions running under something that is not this bridge —
        // a terminal, VS Code, another Claude Sessions window. They are the
        // cards the board cannot do anything with: no send, no stop, no answer,
        // because a second process on one transcript is two writers on one file.
        // Off by default, because a session you cannot drive from here is still
        // a session you may want to know is running.
        hideElsewhere: false,
    },
    projects: {
        // Directory -> `#rgb` or `#rrggbb`. Absent means no colour, which is
        // what nearly every project is: the point of colouring one is to tell
        // it apart from the rest, and a rail where every card is painted says
        // no more than a rail where none is.
        //
        // Keyed by **path**, not by the name the rail draws. That name is the
        // last segment of the directory, so two checkouts called `api` share
        // one, and a colour keyed on it would be wrong for both of them.
        //
        // A directory is matched as a prefix at a path boundary, longest first,
        // so a worktree under `<proj>/.claude/worktrees/` wears its checkout's
        // colour without anything having to be said about it twice. That rule
        // lives in the client — see projectColor() in web/app.js — because it
        // is asked on every keystroke in the Start-a-session dialog.
        colors: {},
        // Whether the backdrop behind a project-scoped dialog takes a wash of
        // the project's colour, and how much of it — a percentage mixed into
        // the dim. 13 is what the dialog drew before either was a setting, so
        // nobody who never opens it sees anything change. Off leaves the plain
        // dim every other dialog has; the dialog's own head keeps its colour.
        backdropTint: true,
        backdropStrength: 13,
    },
    quota: {
        // Refresh the quota percentages by starting a short-lived `claude`,
        // letting its startup probe run, harvesting the status line and killing
        // it — so the pill stays current with no terminal open. It leaves
        // nothing behind: a session that is never sent a message writes no
        // transcript, so there is no row in the rail and nothing to clean up.
        //
        // Off until `beaconDir` names somewhere, and deliberately **read from
        // the user file only** — a project's `.tgxcode/settings.json` is
        // checked into a repository, and what directory this app starts Claude
        // in is not a repository's business.
        beacon: false,
        // Where it runs. **Open Claude Code there yourself at least once
        // first.** The beacon never answers the trust prompt — that dialog
        // grants read, edit and execute on the directory, and a background
        // process confirming it on your behalf is not a thing this app will do.
        // Naming a directory you have not trusted just makes every run time
        // out, which the quota panel will tell you about.
        beaconDir: null,
        // How often, in minutes. Each run costs a CLI start and one
        // `max_tokens: 1` API call — a rounding error against a window, but not
        // nothing, so this is a floor of five rather than a free knob.
        beaconEveryMinutes: 20,
    },
    spinner: {
        // What a turn in progress calls itself. Off gives back the literal
        // "Thinking…" this app said for its whole life before now.
        randomize: true,
        // Which groups from `~/.tgxcode/verbs/` are in play. Named, not
        // globbed: enabling all 114 at once is a soup, and the point of the
        // groups is to choose a voice.
        groups: ['Claude Code Defaults', 'Monty Python', 'Absurd / Nonsense', 'Tech / Programming'],
        // How often each of those groups gets to speak, as a share of the
        // draws: weight 4 against weight 1 is drawn four times as often,
        // whatever the two groups' sizes. A group nobody weighed is 1, so `{}`
        // is every enabled group equally likely — and `0` mutes one without
        // unchecking it, which is the difference between "not now" and
        // "forget this". See bridge/spinner.js.
        weights: {},
        // How long a verb stands before another is drawn. This is the only
        // thing that moves it: the verb is a prefix, and what follows it — a
        // tool's name, `Writing…` — changes on its own as reality does. So the
        // verb drifts straight through a call of any length without displacing
        // what that call is. 0 pins it for the whole turn.
        rerollMs: 8000,
    },
    keyboard: {
        // Ctrl+C in the terminal copies when there is a selection and
        // interrupts when there is not, and Ctrl+V then pastes without the
        // Shift a terminal usually asks for. Off, because the alternative is
        // changing what Ctrl+C does to somebody who did not ask: a selection
        // left in the scrollback would turn an interrupt into a copy, and the
        // process you were trying to stop keeps running.
        //
        // **User file only.** Which keys your hands use is not a repository's
        // business — the same argument as `quota` below it, and see USER_ONLY.
        contextualTerminalCopy: false,
        // What Enter does in a composer. 'enter' is what this app has always
        // done — Enter sends, Shift+Enter is a newline. 'ctrl-enter' swaps
        // them, for anyone who writes several paragraphs before sending one.
        // Ctrl+Enter sends either way, which it already did.
        composerSend: 'enter',
        // The order Ctrl+P / Ctrl+M (and their Shift twins) walk the composer's
        // Permissions and Model pickers in. 'default' is the order the dropdown
        // lists them; 'alphabetical' sorts by the label you see, with an empty
        // "inherit" choice kept first because it is the absence of a pick rather
        // than one more name. Only the cycle — the dropdown itself is unchanged.
        cycleOrder: 'default',
        // Command id -> combo, or null to leave a command unbound. Absent means
        // the default in bridge/keymap.js, so this holds only what you changed
        // and a command added later arrives already bound.
        bindings: {},
    },
    toolbar: {
        // The top bar, one entry per button: `{id, place, label}`, in the order
        // they are drawn. `place` is `bar`, `more` (the overflow menu) or
        // `hidden`; `label` is whether the text shows beside the icon. Empty
        // means the built-in layout, and an id the list leaves out is drawn in
        // its default place — so a button added later arrives without anybody
        // having to say so, the way an unmentioned binding keeps its default.
        //
        // Hiding a view removes its button and nothing else: its shortcut still
        // opens it, so a button hidden by mistake is not a view lost.
        items: [],
    },
    wispr: {
        // {id, title, combo}, in the order the popover lists them. `combo` is
        // the chord you gave the transform in Wispr Flow, written the way
        // bridge/wispr.js spells it — `Win+Alt+2`.
        transforms: [],
    },
};

// Sections a project may not set, however the precedence would otherwise fall.
//
// `quota` because the beacon starts a `claude` in a directory of its own
// choosing, and a checked-in file deciding that for everyone who clones the
// repository is not a preference — it is a repository reaching outside itself.
// `keyboard` for the same reason one step further in: a repository that can
// rebind your keys can make the window unusable, and the way back would be
// hand-editing the file the page exists to save you from.
//
// Both were already meant to work this way. `quota` said so in prose and was
// enforced only by its call sites passing no `cwd` (see bridge/server.js,
// quotaPrefs) — which held, but left `GET /api/prefs?cwd=…` echoing a project's
// value back as though it counted. That was harmless while nothing read the
// answer and is not once a settings page prints which file wins for each key.
//
// `toolbar` is the keyboard argument applied to the bar: a checked-in file that
// could move or hide your buttons would be a repository rearranging your window.
const USER_ONLY = new Set(['quota', 'keyboard', 'projects', 'toolbar', 'wispr']);

// What each key is allowed to be. A file is a thing people edit, so a bad value
// is dropped and the default kept rather than taken at face value — a
// `groupMinCalls` of `"3"` or of `-1` would otherwise turn grouping off with no
// account of itself.
const SHAPE = {
    transcript: {
        groupToolCalls: (v) => typeof v === 'boolean',
        groupMinCalls: (v) => Number.isInteger(v) && v >= 2 && v <= 1000,
        groupIncludesThinking: (v) => typeof v === 'boolean',
    },
    live: {
        compact: (v) => typeof v === 'boolean',
        hideElsewhere: (v) => typeof v === 'boolean',
    },
    projects: {
        // The last gate rather than the only one, as `keyboard.bindings` and
        // `spinner.weights` are: cleanColors() below has already thrown out the
        // entries that fail, one problem each.
        colors: (v) => {
            if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
            const dirs = Object.keys(v);
            if (dirs.length > MAX_COLORS) return false;
            return dirs.every(d => d.startsWith('/') && d === path.resolve(d) && isAccent(v[d]));
        },
        backdropTint: (v) => typeof v === 'boolean',
        // Capped at 40 because past that the dim stops being a dim: the window
        // behind the dialog turns into a coloured sheet, which says no more
        // about which project than a lighter wash does.
        backdropStrength: (v) => Number.isInteger(v) && v >= 0 && v <= 40,
    },
    quota: {
        beacon: (v) => typeof v === 'boolean',
        beaconDir: (v) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 4096),
        // A floor of five minutes. Each run is a process and an API call, and a
        // settings file asking for one every ten seconds is a mistake rather
        // than a preference.
        beaconEveryMinutes: (v) => Number.isInteger(v) && v >= 5 && v <= 1440,
    },
    spinner: {
        randomize: (v) => typeof v === 'boolean',
        // A bound on the list rather than on the catalogue: the files are the
        // user's to add to, but a settings file naming ten thousand groups is
        // either a mistake or an attempt to make the bridge do unbounded work.
        groups: (v) => Array.isArray(v) && v.length <= 200
            && v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 80),
        // The last gate rather than the only one, exactly as `bindings` is:
        // cleanWeights() above has already dropped the entries that fail.
        weights: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
        // A floor of a second, because a label changing faster than you can
        // read it is worse than one that never changes. 0 is off.
        rerollMs: (v) => v === 0 || (Number.isInteger(v) && v >= 1000 && v <= 600_000),
    },
    keyboard: {
        contextualTerminalCopy: (v) => typeof v === 'boolean',
        composerSend: (v) => v === 'enter' || v === 'ctrl-enter',
        cycleOrder: (v) => v === 'default' || v === 'alphabetical',
        // The last gate rather than the only one: cleanBindings() below has
        // already thrown out the entries that fail, one problem each, so
        // anything reaching here is a map of known command ids to `null` or a
        // canonical combo.
        bindings: (v) => {
            if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
            const ids = Object.keys(v);
            if (ids.length > keymap.MAX_BINDINGS) return false;
            return ids.every(id => keymap.COMMAND_IDS.has(id)
                && (v[id] === null || keymap.normalize(v[id]) === v[id]));
        },
    },
    toolbar: {
        // The last gate again: cleanToolbar() below has already dropped what
        // fails and moved a pinned button back where it is allowed to be.
        items: (v) => Array.isArray(v) && v.length <= TOOLBAR_IDS.length
            && new Set(v.map(e => e && e.id)).size === v.length
            && v.every(e => e && TOOLBAR_IDS.includes(e.id) && TOOLBAR_PLACES.has(e.place)
                && typeof e.label === 'boolean'
                && (!TOOLBAR_PINNED[e.id] || TOOLBAR_PINNED[e.id].has(e.place))),
    },
    wispr: {
        // The last gate again: cleanTransforms() has dropped the bad entries.
        transforms: wispr.validTransforms,
    },
};

/**
 * `keyboard.bindings`, entry by entry.
 *
 * Every other setting is one value, so SHAPE's all-or-nothing rule reads as
 * "that number was wrong, the default stands". A map is different: one typo'd
 * command id would throw away every binding beside it, which is a lot of
 * silence for one mistake in a file people edit by hand. So each entry stands
 * or falls on its own and says which it was, and what survives is spelled the
 * way bridge/keymap.js spells it — `cmd+k` in the file becomes `Ctrl+K`, so
 * nothing downstream has to know the aliases.
 *
 * @param {*} value whatever the file had
 * @param {(msg: string) => void} note where a rejected entry gets reported
 * @returns {object|undefined} the cleaned map, or undefined to leave the
 *   default alone — which is what a value that is not a map at all gets.
 */
function cleanBindings(value, note) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    for (const [id, raw] of Object.entries(value)) {
        if (!keymap.COMMAND_IDS.has(id)) {
            note(`${JSON.stringify(id)} is not a command`);
            continue;
        }
        if (raw === null) { out[id] = null; continue; }
        const combo = keymap.normalize(raw);
        if (!combo) {
            note(`${JSON.stringify(raw)} is not a usable combo for ${id}`);
            continue;
        }
        out[id] = combo;
    }
    return out;
}

/**
 * `spinner.weights`, entry by entry.
 *
 * The same shape as cleanBindings() above and for the same reason: one number
 * somebody fat-fingered must not throw away the weights beside it. What a
 * weight *means* is a group's share of the draws — see bridge/spinner.js — and
 * which group it names is resolved there too, forgivingly, so a key is only
 * checked for being a plausible group name here rather than for matching one.
 * A file may legitimately weigh a group it has not enabled, or one that lives
 * in a directory this workspace cannot see.
 *
 * @param {*} value whatever the file had
 * @param {(msg: string) => void} note where a rejected entry gets reported
 * @returns {object|undefined} the cleaned map, or undefined to leave the
 *   default alone — which is what a value that is not a map at all gets.
 */
function cleanWeights(value, note) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    let n = 0;
    for (const [name, raw] of Object.entries(value)) {
        // The same bound the `groups` list puts on one of its entries: it is
        // the same kind of name, written in the same file.
        if (!name || name.length > 80) {
            note(`${JSON.stringify(name)} is not a group name`);
            continue;
        }
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1000) {
            note(`${JSON.stringify(raw)} is not a weight for ${JSON.stringify(name)}`);
            continue;
        }
        // Bounded like `groups`, and for the same reason: a file naming ten
        // thousand weights is a mistake rather than a preference.
        if (n >= 200) {
            note('more than 200 weights — the rest dropped');
            break;
        }
        n++;
        out[name] = raw;
    }
    return out;
}

/**
 * `projects.colors`, entry by entry.
 *
 * The third of these and the same shape as the two above, for the reason they
 * both give: one hand-typed colour that is not a colour must not throw away the
 * projects beside it. What is different is that the *key* can fail too — this
 * is the only setting whose keys carry meaning — so a directory that is not an
 * absolute path is rejected on its own account rather than silently colouring
 * nothing.
 *
 * Paths are resolved, so `~/proj/` and `/home/you/proj/../proj` cannot become a
 * second entry for a project that already has one. `~` is deliberately *not*
 * expanded: the client sends the same absolute directories `GET /api/projects`
 * gave it, and a file written by hand with a `~` in it is better rejected with
 * a message than quietly attached to whoever the bridge is running as.
 *
 * @param {*} value whatever the file had
 * @param {(msg: string) => void} note where a rejected entry gets reported
 * @returns {object|undefined} the cleaned map, or undefined to leave the
 *   default alone — which is what a value that is not a map at all gets.
 */
function cleanColors(value, note) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    let n = 0;
    for (const [dir, raw] of Object.entries(value)) {
        if (typeof dir !== 'string' || !dir.startsWith('/') || dir.length > 4096) {
            note(`${JSON.stringify(dir)} is not an absolute directory`);
            continue;
        }
        if (!isAccent(raw)) {
            note(`${JSON.stringify(raw)} is not a colour for ${JSON.stringify(dir)}`
                + ' — #abc or #aabbcc');
            continue;
        }
        if (n >= MAX_COLORS) {
            note(`more than ${MAX_COLORS} project colours — the rest dropped`);
            break;
        }
        n++;
        out[path.resolve(dir)] = raw;
    }
    return out;
}

/**
 * `toolbar.items`, entry by entry.
 *
 * A list rather than a map, but the argument is cleanBindings()'s: one button
 * misspelled must not put every other button back where it started. An entry
 * with no `label` takes true, which is what a hand-written `{"id": "live",
 * "place": "more"}` obviously means.
 *
 * A pinned button asked to go somewhere it may not is *moved* rather than
 * dropped, and reported. Dropping it would put it back in its default place,
 * which for `settings` is also the bar — but the entry's position in the list is
 * the other half of what it said, and that part is still worth keeping.
 *
 * @returns {Array|undefined} the cleaned list, or undefined to leave the
 *   default alone — which is what a value that is not a list at all gets.
 */
function cleanToolbar(value, note) {
    if (!Array.isArray(value)) return undefined;
    const out = [];
    const seen = new Set();
    for (const raw of value) {
        const id = raw && typeof raw === 'object' ? raw.id : raw;
        if (typeof id !== 'string' || !TOOLBAR_IDS.includes(id)) {
            note(`${JSON.stringify(id)} is not a toolbar button`);
            continue;
        }
        if (seen.has(id)) {
            note(`${JSON.stringify(id)} is listed twice — the first stands`);
            continue;
        }
        let place = raw.place === undefined ? 'bar' : raw.place;
        if (!TOOLBAR_PLACES.has(place)) {
            note(`${JSON.stringify(place)} is not a place for ${id} — bar, more or hidden`);
            continue;
        }
        const label = raw.label === undefined ? true : raw.label;
        if (typeof label !== 'boolean') {
            note(`${JSON.stringify(label)} is not a label setting for ${id} — true or false`);
            continue;
        }
        if (TOOLBAR_PINNED[id] && !TOOLBAR_PINNED[id].has(place)) {
            note(`${id} cannot be ${place === 'hidden' ? 'hidden' : `put in "${place}"`} — kept on the bar`);
            place = 'bar';
        }
        seen.add(id);
        out.push({ id, place, label });
    }
    return out;
}

// Section keys whose value is a map and so gets the treatment above, before
// SHAPE sees it. Five entries; the table exists so the next one does not have
// to special-case merge().
const SANITIZE = {
    keyboard: { bindings: cleanBindings },
    spinner: { weights: cleanWeights },
    projects: { colors: cleanColors },
    toolbar: { items: cleanToolbar },
    wispr: { transforms: wispr.cleanTransforms },
};

/**
 * Read one settings file.
 *
 * bridge/jsonfile.js does the stat-before-read, the size cap, the BOM and the
 * parse. What is left here is the version rule, which is ours alone: a file
 * stamped with a version this bridge does not know is dropped whole rather than
 * half-read, because an old key that has changed meaning is worse than a
 * missing one.
 *
 * @returns {{data: object|null, stamp: string|null, problem: object|null}}
 */
function readFile(file) {
    const read = readJson(file);
    if (read.problem || !read.data) {
        return { data: read.data, stamp: read.stamp, problem: read.problem };
    }
    // Absent is fine: a project file that only sets one key has no reason to
    // restate the version. A *wrong* version is not.
    if (read.data.version !== undefined && read.data.version !== VERSION) {
        return { data: null, stamp: read.stamp,
            problem: { file, message: `unknown version ${JSON.stringify(read.data.version)} — expected ${VERSION}` } };
    }
    return { data: read.data, stamp: read.stamp, problem: null };
}

/**
 * Fold one file's keys over an accumulating result, dropping what fails SHAPE.
 *
 * @param {boolean} isUser whether `file` is the user's own settings, which is
 *   what decides whether a USER_ONLY section counts or is reported and skipped.
 */
function merge(into, data, file, problems, isUser) {
    for (const [section, checks] of Object.entries(SHAPE)) {
        const block = data[section];
        if (block === undefined) continue;
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
            problems.push({ file, message: `"${section}" is not an object — ignored` });
            continue;
        }
        if (USER_ONLY.has(section) && !isUser) {
            problems.push({ file,
                message: `"${section}" may only be set in ${cfg.USER_PREFS_FILE} — ignored` });
            continue;
        }
        for (const [key, ok] of Object.entries(checks)) {
            if (block[key] === undefined) continue;
            const sanitize = SANITIZE[section] && SANITIZE[section][key];
            const value = sanitize
                ? sanitize(block[key], (message) => problems.push({ file, message: `${section}.${key}: ${message} — ignored` }))
                : block[key];
            if (value === undefined) {
                problems.push({ file,
                    message: `${section}.${key}: ${JSON.stringify(block[key])} is not a valid value — ignored` });
                continue;
            }
            if (!ok(value)) {
                problems.push({ file,
                    message: `${section}.${key}: ${JSON.stringify(block[key])} is not a valid value — ignored` });
                continue;
            }
            into[section][key] = value;
        }
    }
}

class Prefs {
    constructor() {
        this.cache = new Map();   // workspace ('' for user-level only) -> {at, stamp, value}
        this.ensureUserFile();
    }

    /**
     * Write the defaults out if there is no user file yet.
     *
     * Failure is not fatal and not worth a throw: a read-only home directory
     * costs the user a place to edit, not the app a preference — everything
     * still falls back to DEFAULTS.
     */
    ensureUserFile() {
        try {
            if (fs.existsSync(cfg.USER_PREFS_FILE)) return;
            writeAtomic(cfg.USER_PREFS_FILE, serialize(DEFAULTS));
        } catch (err) {
            console.error(`[claude-sessions] could not create ${cfg.USER_PREFS_FILE}: ${err.message}`);
        }
    }

    /**
     * Which files apply, weakest first.
     *
     * The project half mirrors readMerged() in commands.js exactly, because the
     * two read the same directory and a reader should not have to hold two
     * different precedence rules in mind:
     *
     *  - the workspace's own checked-in file, falling back to the project's
     *    only if it has none, so a worktree branched before the file existed
     *    does not lose the setting;
     *  - the gitignored local file from the main checkout, so your own
     *    overrides follow you into every worktree of it;
     *  - ...unless somebody deliberately put one in the worktree.
     *
     * `scope` is the settings page's name for a file — `user`, `project` or
     * `project-local`. Two of the four are `project-local`, because the main
     * checkout's local file and a worktree's own are both that: which is why
     * the page's save target comes from targetFile() and never from a row here.
     */
    files(dir) {
        const out = [{ file: cfg.USER_PREFS_FILE, scope: 'user' }];
        if (!dir || !cfg.withinRoots(dir)) return out;

        const workspace = path.resolve(cfg.expandHome(dir));
        const project = projectRootOf(workspace);
        out.push(
            { file: path.join(workspace, cfg.TGX_DIR, cfg.SETTINGS_FILE), scope: 'project',
                fallback: path.join(project, cfg.TGX_DIR, cfg.SETTINGS_FILE) },
            { file: path.join(project, cfg.TGX_DIR, cfg.SETTINGS_LOCAL_FILE), scope: 'project-local' },
            { file: path.join(workspace, cfg.TGX_DIR, cfg.SETTINGS_LOCAL_FILE), scope: 'project-local' },
        );
        return out;
    }

    /**
     * The one file a given scope writes, for a given directory.
     *
     * Derived rather than picked out of files(): the page offers three scopes
     * and the chain has four entries, and the entry that is not offered — the
     * main checkout's local file seen from a worktree — is exactly the one a
     * caller would pick by accident.
     *
     * @returns {string|null} null if the scope needs a directory and has none,
     *   or the directory is not one this bridge will read.
     */
    targetFile(scope, dir) {
        if (scope === 'user') return cfg.USER_PREFS_FILE;
        if (scope !== 'project' && scope !== 'project-local') return null;
        if (!dir || !cfg.withinRoots(dir)) return null;
        const workspace = path.resolve(cfg.expandHome(dir));
        return path.join(workspace, cfg.TGX_DIR,
            scope === 'project' ? cfg.SETTINGS_FILE : cfg.SETTINGS_LOCAL_FILE);
    }

    /**
     * The settings in force for a directory.
     *
     * @param {string} [dir] a workspace — a session's cwd. Omitted gives the
     *   user-level answer, which is what the page is served before it knows
     *   which conversation it is about to show.
     * @returns {{version, transcript, live, projects, quota, spinner, keyboard,
     *   wispr, sources: string[], problems: object[]}}
     */
    forCwd(dir) {
        const key = dir || '';
        const specs = this.files(dir);

        const reads = [];
        for (const spec of specs) {
            let read = readFile(spec.file);
            let file = spec.file;
            if (!read.data && !read.problem && spec.fallback && spec.fallback !== spec.file) {
                file = spec.fallback;
                read = readFile(file);
            }
            reads.push({ file, read, scope: spec.scope });
        }

        const stamp = reads.map(r => `${r.file}@${r.read.stamp || '-'}`).join('|');
        const hit = this.cache.get(key);
        if (hit && hit.stamp === stamp && Date.now() - hit.at < CACHE_MS) return hit.value;

        const value = {
            version: VERSION,
            transcript: { ...DEFAULTS.transcript },
            live: { ...DEFAULTS.live },
            projects: { ...DEFAULTS.projects, colors: { ...DEFAULTS.projects.colors } },
            quota: { ...DEFAULTS.quota },
            spinner: { ...DEFAULTS.spinner, weights: { ...DEFAULTS.spinner.weights } },
            keyboard: { ...DEFAULTS.keyboard, bindings: { ...DEFAULTS.keyboard.bindings } },
            toolbar: { ...DEFAULTS.toolbar, items: [...DEFAULTS.toolbar.items] },
            wispr: { transforms: [...DEFAULTS.wispr.transforms] },
            sources: [],
            problems: [],
        };
        // In the main checkout the project and workspace local files are the
        // same path; reading it twice would double every problem it reports.
        const seen = new Set();
        for (const { file, read, scope } of reads) {
            if (seen.has(file)) continue;
            seen.add(file);
            if (read.problem) value.problems.push(read.problem);
            if (!read.data) continue;
            merge(value, read.data, file, value.problems, scope === 'user');
            value.sources.push(file);
        }

        this.cache.set(key, { at: Date.now(), stamp, value });
        return value;
    }

    /**
     * The same answer without the diagnostics, for the copy that goes into
     * every page as a <meta> tag. `sources` names files in the user's home
     * directory and nothing in the page reads it; a route can say more than a
     * document that gets served to a phone.
     */
    page(dir) {
        const { sources, problems, ...settings } = this.forCwd(dir);
        return settings;
    }

    /**
     * What each file in the chain *says*, as opposed to what the chain adds up
     * to.
     *
     * forCwd() answers "what is in force", which is the only thing the app
     * itself needs. A settings page needs the other question as well: a
     * checkbox has to know whether this scope set the value or inherited it,
     * because clearing an inherited one is meaningless and clearing a set one
     * is the whole point — and when a stronger file has taken over, the page
     * has to be able to name it rather than show a control that appears not to
     * work.
     *
     * Weakest first, the same order as sources. Rows are informational: what a
     * save would write comes from targetFile().
     *
     * @returns {Array<{file, scope, target, exists, parsed, writable, values,
     *   problems: string[]}>} — `parsed` false means the file was dropped
     *   whole, so what it says is unknown and a save to it will be refused.
     */
    raw(dir) {
        const seen = new Set();
        const out = [];
        for (const spec of this.files(dir)) {
            let read = readFile(spec.file);
            let file = spec.file;
            if (!read.data && !read.problem && spec.fallback && spec.fallback !== spec.file) {
                file = spec.fallback;
                read = readFile(file);
            }
            if (seen.has(file)) continue;
            seen.add(file);

            // Only the keys this bridge knows, and only the ones that pass —
            // the page draws controls from this, and a key it has no control
            // for would be invisible while still counting.
            const values = {};
            const problems = [];
            if (read.data) {
                const holder = {};
                for (const section of Object.keys(SHAPE)) holder[section] = {};
                merge(holder, read.data, file, problems, spec.scope === 'user');
                for (const [section, block] of Object.entries(holder)) {
                    if (Object.keys(block).length) values[section] = block;
                }
            }
            out.push({
                file,
                scope: spec.scope,
                target: file === this.targetFile(spec.scope, dir),
                exists: read.stamp !== null,
                parsed: !read.problem,
                writable: writable(file),
                values,
                problems: (read.problem ? [read.problem.message] : []).concat(problems.map(p => p.message)),
            });
        }
        return out;
    }

    /**
     * Write settings to one file in the chain.
     *
     * A patch of sections rather than a whole document, because the page edits
     * one control at a time and a whole-document write would have two windows
     * clobbering each other's unrelated keys. A `null` leaf **removes** the key
     * so the value falls back down the chain — which is not the same as writing
     * the default, and is the only way to say "I do not care about this one"
     * once you have said otherwise.
     *
     * A patch is per *key*, not deeper: `keyboard.bindings` is one key whose
     * value happens to be a map, so sending it replaces the whole map. That is
     * on purpose — inside the map `null` already means "unbound on purpose",
     * so there is no spare way to spell "drop this one entry back to its
     * default", and a caller that holds the resolved map (which the page does)
     * can say exactly what it wants by sending all of it.
     *
     * Everything is validated before anything is written, and the first failure
     * refuses the whole call. That is the opposite of what a *file* gets, where
     * a bad value is dropped and the default stands — deliberately: the file is
     * hand-edited and half of it working beats none of it, whereas a page
     * sending a value the bridge will not keep is a bug in the page, and
     * silently dropping it would leave a control showing something that is not
     * true.
     *
     * @param {{scope: string, dir?: string, patch: object}} req
     * @returns {{file, prefs, files}} the target and the answer that now holds
     * @throws {Error} with `.code` — `scope`, `section`, `value`, `dir`,
     *   `readonly`, `unparseable` or `write` — so a route can turn it into the
     *   right status without matching on prose.
     */
    save({ scope, dir, patch }) {
        if (scope !== 'user' && scope !== 'project' && scope !== 'project-local') {
            throw refuse('scope', `${JSON.stringify(scope)} is not a settings scope`);
        }
        if (scope !== 'user' && !dir) throw refuse('dir', `scope ${scope} needs a directory`);
        if (scope !== 'user' && !cfg.withinRoots(dir)) {
            throw refuse('dir', `${dir} is not a directory this bridge will read`);
        }
        const file = this.targetFile(scope, dir);
        if (!file) throw refuse('scope', `no settings file for scope ${JSON.stringify(scope)}`);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw refuse('section', 'patch is not an object');
        }

        // Validate the whole patch first. `null` skips SHAPE because it is a
        // removal rather than a value, and the sanitizers run here too so what
        // lands on disk is spelled canonically.
        const clean = {};
        for (const [section, block] of Object.entries(patch)) {
            if (!SHAPE[section]) throw refuse('section', `"${section}" is not a settings section`);
            if (!block || typeof block !== 'object' || Array.isArray(block)) {
                throw refuse('section', `"${section}" is not an object`);
            }
            if (USER_ONLY.has(section) && scope !== 'user') {
                throw refuse('readonly', `"${section}" may only be set in ${cfg.USER_PREFS_FILE}`);
            }
            clean[section] = {};
            for (const [key, value] of Object.entries(block)) {
                if (!SHAPE[section][key]) throw refuse('section', `${section}.${key} is not a setting`);
                if (value === null) { clean[section][key] = null; continue; }
                const sanitize = SANITIZE[section] && SANITIZE[section][key];
                const rejected = [];
                const next = sanitize ? sanitize(value, (m) => rejected.push(m)) : value;
                if (rejected.length) throw refuse('value', `${section}.${key}: ${rejected[0]}`);
                if (next === undefined || !SHAPE[section][key](next)) {
                    throw refuse('value', `${section}.${key}: ${JSON.stringify(value)} is not a valid value`);
                }
                clean[section][key] = next;
            }
        }

        // Read what is there before touching it. A file that does not parse is
        // refused rather than replaced: whatever is in it is somebody's work,
        // and a settings page is not a good enough reason to throw it away.
        const before = readFile(file);
        if (before.problem) throw refuse('unparseable', `${file}: ${before.problem.message}`);
        const doc = before.data ? { ...before.data } : {};
        doc.version = VERSION;
        for (const [section, block] of Object.entries(clean)) {
            const existing = (doc[section] && typeof doc[section] === 'object' && !Array.isArray(doc[section]))
                ? { ...doc[section] } : {};
            for (const [key, value] of Object.entries(block)) {
                if (value === null) delete existing[key];
                else existing[key] = value;
            }
            // An empty section is noise in a file people read, so it goes
            // rather than sitting there as `{}`.
            if (Object.keys(existing).length) doc[section] = existing;
            else delete doc[section];
        }

        try {
            writeAtomic(file, serialize(doc));
        } catch (err) {
            throw refuse('write', `${file}: ${err.message}`);
        }

        // The cache is keyed by workspace and stamped on mtime, but CACHE_MS is
        // two seconds of clock as well — long enough that a save followed
        // straight away by a read could answer with the old value.
        this.cache.clear();
        return { file, prefs: this.forCwd(dir), files: this.raw(dir) };
    }
}

module.exports = { Prefs, DEFAULTS, SHAPE, SANITIZE, USER_ONLY, VERSION, TOOLBAR_IDS };
