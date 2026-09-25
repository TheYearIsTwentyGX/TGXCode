// What the page was handed in its <meta> tags, read once, synchronously, at load.
//
// **Synchronous on purpose.** restoreView() opens a session during boot, and a
// transcript drawn before an answer arrived would stay drawn the wrong way —
// nothing re-renders history — so these are read while the module evaluates,
// never behind a fetch. Anything added here must keep that property: it is the
// only reason these values are in the page at all.
//
// The shortcuts' own tag (`tgx-keymap`) is read by keys.js, which owns them.
// Applying what is read here — configurePaths(), keys.apply() — stays in app.js,
// which decides the order boot happens in.

// What the user's own ~/.tgxcode/settings.json says, handed to the page in a
// <meta> tag by bridge/server.js. In the page rather than behind a fetch
// because restoreView() opens a session synchronously at startup: a transcript
// drawn before an answer arrived would stay drawn the wrong way, since nothing
// re-renders history. A project may override any of it, and that answer travels
// with the transcript instead — see openSession.
// Every block gets a fallback, not just the two the transcript needs. The
// settings page draws controls straight off this, and a missing or malformed tag
// used to leave `BOOT_PREFS.spinner` undefined — which was invisible while
// nothing read it and is a thrown error the moment something does.
export const PREFS_FALLBACK = {
    version: 1,
    transcript: { groupToolCalls: true, groupMinCalls: 3, groupIncludesThinking: true },
    live: {
        compact: false, hideElsewhere: false,
        overTasks: 'hidden', overDashboard: 'hidden', overHistory: 'hidden',
        overDrafts: 'hidden', overSchedules: 'hidden', overSettings: 'hidden',
    },
    projects: {
        colors: {}, backdropTint: true, backdropStrength: 13,
        sort: 'recent', bumpOnCreate: true, bumpOnUser: true, bumpOnAny: false,
        bumpOnTurn: false, bumpOnPr: false, order: [], newAt: 'top',
    },
    quota: { beacon: false, beaconDir: null, beaconEveryMinutes: 20 },
    spinner: { randomize: true, groups: [], weights: {}, rerollMs: 8000 },
    keyboard: { contextualTerminalCopy: false, composerSend: 'enter', cycleOrder: 'default', bindings: {} },
    toolbar: { items: [] },
    wispr: { transforms: [] },
    preview: { keepAliveMinutes: 10, overLive: true, links: false, listMode: 'block', list: [] },
    devbrowser: { show: true, openIn: 'devbrowser', whenClosed: 'launch' },
};


/** One block of settings folded over its fallback, with the shape guaranteed. */
export const mergePrefs = (d) => {
    const out = { ...PREFS_FALLBACK, ...(d || {}) };
    for (const section of Object.keys(PREFS_FALLBACK)) {
        if (section === 'version') continue;
        out[section] = { ...PREFS_FALLBACK[section], ...((d && d[section]) || {}) };
    }
    return out;
};

export const BOOT_PREFS = (() => {
    try {
        const m = document.querySelector('meta[name="tgx-prefs"], meta[name="cs-prefs"]');
        if (!m) return mergePrefs(null);
        return mergePrefs(JSON.parse(decodeURIComponent(m.content)));
    } catch { return mergePrefs(null); }
})();

// Where the bridge's filesystem is, so an absolute path in a transcript can be
// drawn as a link to the Windows form of it. In the page for the same reason
// BOOT_PREFS is, and absent for two reasons that need no distinguishing here: a
// remote page is not served the tag, and neither is a bridge outside WSL.
// Absent means markdown.js leaves paths as plain text — see configurePaths.
export const BOOT_HOST = (() => {
    try {
        const m = document.querySelector('meta[name="tgx-host"], meta[name="cs-host"]');
        return m ? JSON.parse(decodeURIComponent(m.content)) : null;
    } catch { return null; }
})();

/**
 * The bridge's token, handed to a page fetched over loopback (bridge/auth.js
 * injectToken) so the Connect-a-phone group can build a pairing link. Null on a
 * remote page, which is never served it. Read at call time, not at load.
 */
export function pairToken() {
    const meta = document.querySelector('meta[name="tgx-token"], meta[name="cs-token"]');
    return meta ? meta.content : null;
}
