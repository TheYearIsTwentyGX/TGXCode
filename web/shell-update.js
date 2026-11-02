// The desktop shell's updates, as the page sees them: the shell's updater
// state (app/updater.js, over the preload), what this shell was built from, and
// what a shell built from the bridge's checkout would be (GET /api/shell-build).
//
// One store, because two things draw it — Settings → Updates and the badge on
// the Settings button — and the shell pushes its state on one IPC channel, which
// should be listened to once, not once per time the card is opened.
//
// **Why the page compares at all.** `web/` is live and `app/` is packaged, so a
// window can run this morning's UI in a shell from weeks ago and nothing says
// so. The shell carries the hash of the app/ it was built from; the bridge hashes
// the checkout's. Different means a rebuild would produce a different shell, and
// "Build update" runs that rebuild into the updates feed, which the updater then
// finds. A shell with no build info predates all of this and is out of date by
// definition.
//
// Nothing here in a browser tab: no shell, nothing to update.

import { get, post } from './api.js';
import { dom, toast } from './dom.js';
import { openSettingsAt } from './settings/index.js';

const shell = () => window.claudeShell && window.claudeShell.updates;

/** Whether this window has an updater to talk to — older shells do not. */
export const updatesAvailable = () => {
    const s = shell();
    return !!s && typeof s.get === 'function';
};

/** Whether this is the desktop app at all, updater or not. */
export const inShell = () => !!window.claudeShell;

const store = {
    state: null,       // the updater's snapshot
    build: null,       // app/build-info.json, or null
    checkout: null,    // GET /api/shell-build
    error: '',
    building: false,
};
const subs = new Set();

export function updatesStore() { return store; }

export function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
}

function changed() {
    paintBadge();
    maybeToast();
    for (const fn of subs) fn(store);
}

/**
 * The shell is behind the checkout. Only claimed when the checkout's hash is
 * known: a bridge that could not answer is not evidence either way.
 */
export function shellStale() {
    if (!inShell() || !store.checkout || !store.checkout.shellHash) return false;
    return !store.build || store.build.shellHash !== store.checkout.shellHash;
}

function take(r) {
    if (!r) return;
    if (r.ok === false) { store.error = r.error || 'no answer'; return; }
    store.error = '';
    if (r.state) store.state = r.state;
    if ('build' in r) store.build = r.build;
}

let started = false;
export async function initShellUpdates() {
    if (started || !inShell()) return;
    started = true;
    if (updatesAvailable()) {
        shell().onState((st) => { store.state = st; changed(); });
        take(await shell().get().catch((e) => ({ ok: false, error: e.message })));
    }
    await refreshCheckout();
    changed();
}

export async function refreshCheckout() {
    try { store.checkout = await get('/api/shell-build'); } catch { store.checkout = null; }
}

// ── actions; each returns after the store has the answer ──

async function call(fn) {
    take(await fn().catch((e) => ({ ok: false, error: e.message })));
    changed();
    return store;
}

export const checkNow = () => call(() => shell().check());
export const downloadUpdate = (opts) => call(() => shell().download(opts));
export const setUpdateSettings = (patch) => call(() => shell().set(patch));
export const dismissNotice = () => call(() => shell().dismissNotice());
export const restartToUpdate = () => call(() => shell().install({ restart: true }));

/**
 * Build a shell from the checkout into the feed (scripts/release.js, run by the
 * bridge), wait for it, then have the updater look. Polled rather than pushed:
 * it is a minute or two, once in a while, and the page that asked is open.
 */
export async function buildUpdate() {
    if (store.building) return store;
    store.building = true;
    store.error = '';
    changed();
    try {
        const r = await post('/api/shell-build/release', {});
        store.checkout = { ...(store.checkout || {}), release: r.release };
        changed();
        for (;;) {
            await new Promise((res) => setTimeout(res, 2000));
            await refreshCheckout();
            changed();
            const rel = store.checkout && store.checkout.release;
            if (!rel || !rel.running) break;
        }
        const rel = store.checkout && store.checkout.release;
        if (rel && rel.exitCode !== 0) store.error = 'The build failed — its output is below.';
        else if (updatesAvailable()) await call(() => shell().check());
    } catch (e) {
        store.error = `Could not start the build: ${e.message}`;
    } finally {
        store.building = false;
        changed();
    }
    return store;
}

// ── the badge and the one toast ──

/** What the badge has to say, or '' — the same words as its tooltip. */
function badgeWhy() {
    const st = store.state;
    if (st && st.enabled && st.ready) return `TGXCode ${st.available.version} is ready — restart to update`;
    if (st && st.enabled && st.phase === 'available') return `TGXCode ${st.available.version} is available`;
    if (shellStale()) return 'The desktop shell is older than this checkout';
    return '';
}

function paintBadge() {
    const b = dom.settingsBadge;
    if (!b) return;
    const why = badgeWhy();
    b.hidden = !why;
    b.textContent = why ? '↑' : '';
    b.title = why;
    if (why) b.setAttribute('aria-label', why);
    else b.removeAttribute('aria-label');
}

// A toast for each thing worth one: a ready update (once per load and version),
// the result of the last install, and a stale shell with nothing on offer. The
// badge stays for as long as it is true.
const toasted = new Set();
function maybeToast() {
    const st = store.state;
    if (st && st.notice && !toasted.has(`notice:${st.notice.to}`)) {
        toasted.add(`notice:${st.notice.to}`);
        if (st.notice.kind === 'updated') {
            toast(`Updated to TGXCode ${st.notice.to}.`, 'info');
        } else {
            toast(`The update to ${st.notice.to} did not finish — TGXCode ${st.notice.from} is still installed. `
                + 'The installer was cancelled, refused elevation, or failed.', 'warn',
            { action: { label: 'Updates', onClick: () => openSettingsAt('updates') } });
        }
        dismissNotice();
        return;
    }
    if (st && st.enabled && st.ready && !toasted.has(`ready:${st.available.version}`)) {
        toasted.add(`ready:${st.available.version}`);
        toast(`TGXCode ${st.available.version} is downloaded. `
            + (st.settings.installOnQuit ? 'It installs when you quit, or now:' : 'Restart to install it.'), 'info',
        { action: { label: 'Restart to update', onClick: () => restartToUpdate() } });
        return;
    }
    // Once per checkout hash rather than per load: the badge already says it, and
    // a sticky toast on every refresh until you rebuild would be nagging.
    const staleKey = store.checkout ? `tgx-shell-stale:${store.checkout.shellHash}` : '';
    if (shellStale() && !(st && (st.ready || st.phase === 'available' || st.phase === 'downloading'))
        && !toasted.has('stale') && !localStorage.getItem(staleKey)) {
        toasted.add('stale');
        try { localStorage.setItem(staleKey, '1'); } catch { /* private mode */ }
        toast('The desktop shell is older than this checkout’s app/.', 'info',
            { ms: 8000, action: { label: 'Update…', onClick: () => openSettingsAt('updates') } });
    }
}
