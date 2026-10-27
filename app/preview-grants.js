'use strict';

// Which sites a preview guest may show, and the user's answers about the ones an
// agent asked for.
//
// Three kinds of yes, checked in this order:
//
//  - **Loopback.** A dev server on this machine is what the preview is for, and
//    needs no asking — for an agent or for anybody.
//  - **This run's grants** (`session`). An origin a chat link opened in the
//    preview (web/link-policy.js decides which; preview-allow-origin), and one the
//    user answered *Allow once* for. Held until the app quits.
//  - **Always** (`always`). Origins the user answered *Always allow* for, which the
//    window saves as the setting `preview.agentOrigins` and hands back here at
//    start-up and whenever it changes. The setting is the record; this is a copy.
//
// And one kind of no: an origin the user answered *Deny* for is refused for
// DENY_MS without asking again, so an agent that retries in a loop cannot turn
// the prompt into a nag. After that it may ask again.
//
// **An ask has no deadline.** The user may be away from the keyboard, and an
// answer that arrives an hour later is still the answer. So an ask is held here,
// in the main process, where it survives a reload of the window and a switch
// between preview pages, and it ends only on Allow once, Always allow or Deny —
// or when nobody is left wanting it: every session that asked has gone away
// (`dropRequester`). Two requests for the same origin are one ask with two
// requesters. What *does* time out is a caller's wait on it (`wait`), because a
// tool call cannot block forever; the ask outlives the wait.
//
// An ask from open_in_preview carries the URL to open, and the window opens it
// when the answer is yes, whenever that is. An ask raised by a refused navigation
// carries nothing to open: the agent was told to retry.
//
// The refusal texts an agent reads are here too, so the words and the decision
// they describe are in one place. Pure Node and no electron, so
// test/preview-grants.test.js can drive it.

const { EventEmitter } = require('events');

const MAX_SESSION = 200;
const MAX_ALWAYS = 100;
const DENY_MS = 10 * 60_000;
const RENOTIFY_MS = 10 * 60_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function parse(url) {
    try { return new URL(String(url)); } catch { return null; }
}

function isLoopbackUrl(url) {
    const u = parse(url);
    return Boolean(u && (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname));
}

/** `https://example.com` for a URL or an origin, or null for anything not http(s). */
function originOf(url) {
    const u = parse(url);
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
    return u.origin;
}

/** How a site is named to the user and to an agent: its host, port and all. */
function hostOf(urlOrOrigin) {
    const u = parse(urlOrOrigin);
    return u ? u.host : String(urlOrOrigin);
}

/** An origin exactly as the setting stores one, or null. */
function cleanOrigin(s) {
    if (typeof s !== 'string' || s.length > 300) return null;
    const o = originOf(s);
    return o && o === s ? o : null;
}

const TEXT = {
    notApproved: (url) => `Navigation to ${url} blocked: ${hostOf(url)} is not approved for agent control in the TGXCode preview. `
        + 'The user has been asked to approve it, and the prompt stays open until they answer — wait for their answer and retry, '
        + 'or call open_in_preview with the URL, which waits for the decision.',
    denied: (url) => `Navigation to ${url} blocked: the user denied ${hostOf(url)} for agent control.`,
    notWeb: (url) => `Navigation to ${url} blocked: only http and https pages load in the TGXCode preview.`,
};

class PreviewGrants extends EventEmitter {
    constructor({ now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
        super();
        this.now = now;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.session = new Set();
        this.always = new Set();
        this.denied = new Map();    // origin -> when
        this.asks = new Map();      // origin -> ask
    }

    // ── grants ───────────────────────────────────────────────────────────

    /** Loopback, or an origin granted this run or always. */
    isGranted(url) {
        if (isLoopbackUrl(url)) return true;
        const o = originOf(url);
        return Boolean(o && (this.session.has(o) || this.always.has(o)));
    }

    isDenied(url) {
        const o = originOf(url);
        const at = o && this.denied.get(o);
        if (!at) return false;
        if (this.now() - at < DENY_MS) return true;
        this.denied.delete(o);
        return false;
    }

    /** A grant for this run. False when it is not an origin or the set is full. */
    grantSession(origin) {
        const o = cleanOrigin(origin);
        if (!o) return false;
        if (!this.session.has(o)) {
            if (this.session.size >= MAX_SESSION) return false;
            this.session.add(o);
        }
        this.denied.delete(o);
        return true;
    }

    /** Replace the always list with the setting's. Bad entries are dropped. */
    setAlways(list) {
        this.always = new Set((Array.isArray(list) ? list : []).map(cleanOrigin).filter(Boolean).slice(0, MAX_ALWAYS));
        for (const o of this.always) this.denied.delete(o);
        this.emit('changed');
    }

    // ── navigation an agent asked for ────────────────────────────────────

    /**
     * Why a top-level navigation of an agent-driven page is refused, or null to
     * let it go. Raises the ask as a side effect, so the retry the text suggests
     * can succeed. `requester` is whoever should keep the ask alive.
     */
    navigationRefusal(url, requester = 'cdp') {
        if (url === 'about:blank') return null;
        if (!originOf(url)) return TEXT.notWeb(url);
        if (this.isGranted(url)) return null;
        if (this.isDenied(url)) return TEXT.denied(url);
        this.ask(url, { requester });
        return TEXT.notApproved(url);
    }

    // ── a guest's own navigations (app/main.js) ──────────────────────────
    //
    // With nobody driving, a link off an approved site leaves for the system
    // browser, as it always has, and a redirect is left alone. With an agent
    // driving, either would be the agent leaving the preview by the side door, to
    // a site nobody approved — so it is stopped and the user is asked instead.
    // Only top-level navigations: what a page loads into its frames is its own.

    /** A link or form in the guest: 'allow', 'external' (the system browser) or 'blocked'. */
    linkDecision(url, driven) {
        if (this.isGranted(url)) return 'allow';
        if (driven) { this.navigationRefusal(url, 'cdp'); return 'blocked'; }
        return originOf(url) ? 'external' : 'blocked';
    }

    /** A server redirect: 'allow' or 'blocked'. */
    redirectDecision(url, driven, isMainFrame) {
        if (!isMainFrame || !driven || this.isGranted(url)) return 'allow';
        this.navigationRefusal(url, 'cdp');
        return 'blocked';
    }

    /** A new window the guest asked for: 'load' it in place, 'external', or 'blocked'. */
    popupDecision(url, driven) {
        if (!driven) return originOf(url) ? 'external' : 'blocked';
        if (this.isGranted(url)) return 'load';
        this.navigationRefusal(url, 'cdp');
        return 'blocked';
    }

    // ── asks ─────────────────────────────────────────────────────────────

    /**
     * Ask the user about the origin of `url`, or join the ask already open.
     * `open` is a URL to show once allowed (open_in_preview's); the first one
     * given is kept.
     *
     * @returns {{state: 'granted'|'denied'|'asking', origin: string|null, existed?: boolean, repeat?: boolean}}
     */
    ask(url, { requester = null, open = null } = {}) {
        const origin = originOf(url);
        if (!origin) return { state: 'denied', origin: null };
        if (this.isGranted(url)) return { state: 'granted', origin };
        if (this.isDenied(url)) return { state: 'denied', origin };
        let a = this.asks.get(origin);
        const existed = Boolean(a);
        if (!a) {
            a = { origin, host: hostOf(origin), url: String(url), open: null, requesters: new Set(),
                since: this.now(), waiters: new Set(), renotify: null, notified: 1 };
            this.asks.set(origin, a);
            // Once more after a while if nobody has answered; never a third time.
            a.renotify = this.setTimer(() => {
                a.renotify = null;
                if (this.asks.get(origin) === a) { a.notified = 2; this.emit('notify', this.public(a)); }
            }, RENOTIFY_MS);
            a.renotify.unref?.();
        }
        // The same open_in_preview asked again: it is told where things stand
        // rather than made to wait out another minute.
        const repeat = Boolean(existed && open && a.open && requester && a.requesters.has(String(requester)));
        if (open && !a.open) a.open = String(open);
        if (requester) a.requesters.add(String(requester));
        if (!existed) this.emit('notify', this.public(a));
        this.emit('changed');
        return { state: 'asking', origin, existed, repeat };
    }

    /**
     * Wait for the answer to an open ask, for at most `ms`.
     * @returns {Promise<'once'|'always'|'deny'|'gone'|'waiting'>}
     */
    wait(origin, ms) {
        const a = this.asks.get(origin);
        if (!a) return Promise.resolve(this.session.has(origin) || this.always.has(origin) ? 'once' : 'gone');
        return new Promise((resolve) => {
            const w = { resolve: null, timer: null };
            w.resolve = (v) => { this.clearTimer(w.timer); a.waiters.delete(w); resolve(v); };
            w.timer = this.setTimer(() => w.resolve('waiting'), ms);
            w.timer.unref?.();
            a.waiters.add(w);
        });
    }

    /**
     * The user's answer. Returns what the window should do next: the URL to open
     * when it was allowed and somebody wanted a page, else null.
     */
    answer(origin, decision) {
        const a = this.asks.get(origin);
        if (decision === 'once' || decision === 'always') {
            if (decision === 'once') this.grantSession(origin);
            else { this.always.add(origin); this.denied.delete(origin); }
        } else if (decision === 'deny') {
            this.denied.set(origin, this.now());
        } else {
            return { ok: false, open: null };
        }
        if (!a) return { ok: true, open: null };
        this._end(a, decision);
        return { ok: true, open: decision === 'deny' ? null : a.open };
    }

    /** A session went away, or a CDP client disconnected. Asks only it wanted end. */
    dropRequester(requester) {
        for (const a of [...this.asks.values()]) {
            if (!a.requesters.delete(String(requester))) continue;
            if (!a.requesters.size) this._end(a, 'gone');
        }
    }

    _end(a, decision) {
        this.asks.delete(a.origin);
        if (a.renotify) this.clearTimer(a.renotify);
        for (const w of [...a.waiters]) w.resolve(decision);
        this.emit('changed');
    }

    public(a) {
        return { origin: a.origin, host: a.host, url: a.url, open: a.open, since: a.since, notified: a.notified };
    }

    /** The open asks, oldest first, for the window to draw. */
    list() {
        return [...this.asks.values()].map(a => this.public(a));
    }
}

module.exports = { PreviewGrants, TEXT, originOf, hostOf, cleanOrigin, isLoopbackUrl, MAX_SESSION, MAX_ALWAYS, DENY_MS, RENOTIFY_MS };
