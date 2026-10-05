// What a new window opens to — Settings › On startup.
//
// The address bar is the app's whole memory of where you were (rememberView in
// web/app.js), and a refresh restores it for free. A launch loads the bare
// origin, so it used to start with nothing open. This turns `startup` into the
// address a launch would have had if you had left the window that way, and
// restoreView takes it from there — no second way of opening a panel.
//
// Only a launch. Three things say this load is not one, and each wins:
//
//  - The navigation is a reload. A refresh with nothing open reaches exactly the
//    bare address a launch does, so the address alone cannot tell them apart.
//  - The address already names something. Somebody opened that on purpose.
//  - A `#/session/<id>` hash: a notification was pressed with no window open,
//    and the conversation it asks for must not come up under a panel.
//
// Pure, so test/startup.test.js imports it without a DOM.

/**
 * The query a launch should restore, or null to restore the address as it is.
 *
 * `prefs` is BOOT_PREFS.startup; `navType` is the navigation timing entry's
 * `type` ('navigate', 'reload', 'back_forward', …).
 */
export function startupQuery(prefs, { navType, search, hash } = {}) {
    if (navType === 'reload') return null;
    if (search && search !== '?') return null;
    if (hash && hash.startsWith('#/session/')) return null;

    const view = prefs && prefs.view;
    const live = !!(prefs && prefs.live);
    const q = new URLSearchParams();
    if (view && view !== 'conversation') {
        q.set('view', view);
        if (live) q.set('live', '1');
    } else if (live) {
        q.set('view', 'live');
    }
    return q.toString() ? q : null;
}
