// What the command palette offers, apart from the sessions: a list any module
// can add to. web/palette/builtin.js fills it with the views and the buttons
// that already exist; a feature that wants to be reachable from Ctrl+K adds
// itself here, next to its own code, instead of editing the palette.
//
//     import { registerAction } from './palette/registry.js';
//     registerAction({
//         id: 'worktrees.clean', group: 'Actions', title: 'Clean up worktrees',
//         keywords: 'janitor remove prune', when: () => !!state.current,
//         run: () => openWorktrees(…),
//     });
//
// An entry:
//   - `id`       stable and unique; registering it again replaces it.
//   - `group`    'Views' or 'Actions' (or a new heading, listed after those).
//   - `title`    what the row says, or a function returning it when it depends
//                on state (Pin / Unpin). `meta` is an optional quieter line.
//   - `keywords` extra words it should be found by, never shown.
//   - `command`  a web/keys.js command id; its current chord is shown on the row,
//                so a rebinding in Settings shows up here with nothing to update.
//   - `when()`   false hides it — a session action with no session open.
//   - `quiet`    listed only once something is typed (the settings groups:
//                twenty rows nobody wants in an empty palette).
//   - `run()`    what Enter does. The palette is closed first.
//
// A *source* is for lists that change under you — the project's commands, the
// open session's dev servers, the templates — and is asked afresh every time the
// palette draws. It gets `{ q }`, and an entry it returns with `always: true` is
// shown whatever was typed rather than matched against it ("Search transcripts
// for '…'" is that). A source whose list lives on the bridge can pass a
// `refresh()` that returns a promise: the palette calls every one as it opens
// and draws again when they have answered, so the source itself stays
// synchronous and reads only what it was last told.
//
// Pure: no DOM and no app state, so it can be imported from anywhere without a
// cycle, including by modules app.js has not loaded yet.

const actions = new Map();
const sources = new Map();
const refreshers = new Map();

export function registerAction(entry) {
    if (!entry || !entry.id || typeof entry.run !== 'function') {
        throw new Error('registerAction needs an id and a run()');
    }
    actions.set(entry.id, entry);
}

export function unregisterAction(id) {
    actions.delete(id);
}

export function registerSource(id, fn, { refresh = null } = {}) {
    sources.set(id, fn);
    if (refresh) refreshers.set(id, refresh);
    else refreshers.delete(id);
}

/** Ask every source that has one to refresh; settles when all have, failed or not. */
export function refreshSources() {
    return Promise.all([...refreshers.values()].map(fn => {
        try { return Promise.resolve(fn()).catch(() => null); } catch { return null; }
    }));
}

/** Every entry that applies right now, actions first, then each source's. */
export function entries(ctx = {}) {
    const out = [];
    for (const a of actions.values()) {
        try { if (!a.when || a.when()) out.push(a); } catch { /* a broken `when` hides only itself */ }
    }
    for (const fn of sources.values()) {
        try { out.push(...(fn(ctx) || [])); } catch { /* likewise a source */ }
    }
    return out;
}
