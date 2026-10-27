// The browser preview — a dev server's page, inside the window.
//
// DevBrowser (~/Other/dev-browser) was the only way to look at what an agent
// started, and it is a second app on the Windows host: a click here raised a
// window over there. This is the same toolbar, left to right — Home, Back,
// Forward, Reload, Screenshot, Pick, the address bar, the viewport presets and
// the orientation toggle — without DevBrowser's OS-window presets, which resize
// the whole window and make no sense for a pane inside this one. At the far
// right, after Maximize, a Close ×: the same thing Home does, but where a
// window's exit is looked for, since a house did not read as "get me out".
//
// Two ways to hold a page, chosen once per load:
//
//  - **<webview>**, in the packaged shell. It is its own renderer in its own
//    partition, so everything on the toolbar works: history, capturePage for the
//    screenshot, executeJavaScript for the picker. app/main.js decides what a
//    guest may be (loopback or a granted origin, no preload, no Node) in
//    will-attach-webview.
//  - **<iframe>**, anywhere else — a shell built before this existed, or the
//    page opened in a plain browser from `npm run dev:headless`. A cross-origin
//    frame cannot be sent back, captured or scripted, so those four buttons are
//    disabled there and say why, rather than failing on click.
//
// Pages are kept alive after you leave them, for `keepAliveMinutes`, and moved
// off-screen rather than hidden while they wait: `display: none` on a <webview>
// collapses its guest's layout in Chromium, which is why DevBrowser does the
// same. Coming back inside the window finds the page as you left it — scroll,
// form state, an HMR socket still connected. Past it the element is removed,
// which is what actually frees the renderer.
//
// A page is keyed by its port, or — for a link opened from chat
// (web/link-policy.js) — by its origin, a string, so the two never collide.
// A site that is not a local port needs the <webview> and a shell that can be
// told the origin is wanted (allowPreviewOrigin): app/main.js refuses any guest
// that is neither loopback nor granted. Without both, canPreviewUrls is false
// and the link goes to the browser as it always did.
//
// The address bar shows the page's real URL, scheme and all where the scheme
// matters, and follows the page wherever it goes — its own links, an in-page
// route change, an agent driving it. web/preview-pages.js has the rule, the
// meaning of what you type, the list of pages (the way back to one you left)
// and why a page an agent is on outlives its keep-alive.

import { PICKER_SOURCE } from './preview-picker.js';
import { displayAddress, originOf, pageRows, parseAddress, pinnedPage } from './preview-pages.js';

// The webview path needs the tag *and* the shell's clipboard doors: an old shell
// with neither gets the iframe rather than buttons that throw.
const HAS_WEBVIEW = typeof window.claudeShell?.capturePreview === 'function'
    && document.createElement('webview').constructor !== HTMLUnknownElement;

// Not the bridge's own hostname. Cookies are keyed by host and not by port, so a
// dev server on the same host as the bridge would be sent the bridge's token
// cookie with every request an iframe makes — and a dev server is exactly the
// kind of third-party code the token keeps out. The two loopback names are two
// cookie jars. (A <webview> has its own partition and would be fine either way.)
const PREVIEW_HOST = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';

/** Whether a site that is not a local port can be shown here at all. */
export const canPreviewUrls = HAS_WEBVIEW
    && typeof window.claudeShell?.allowPreviewOrigin === 'function';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const VIEWPORTS = {
    fit: null,
    phone: { w: 375, h: 812 },
    tablet: { w: 768, h: 1024 },
    // A shape, not a size: the largest 16:9 the pane has room for.
    desktop: { w: 16, h: 9, fill: true },
};

export function previewUrl(port, path = '') {
    return `http://${PREVIEW_HOST}:${port}/${String(path || '').replace(/^\/+/, '')}`;
}

/** How a toast names a page: `:5173` for a port, the host for a site. */
function nameOf(entry) {
    if (entry.port) return `:${entry.port}`;
    try { return new URL(entry.base).host; } catch { return entry.base; }
}

export class PreviewPane {
    /**
     * @param {object} o
     * @param {HTMLElement} o.root  the #preview section, with the markup in index.html
     * @param {() => number} o.keepAliveMinutes
     * @param {(text: string, kind?: string) => void} o.toast
     * @param {() => void} o.onHome
     * @param {(entry: object) => void} [o.onOutput]      show a task's terminal
     * @param {(entry: object) => void} [o.onDevBrowser]  hand the page to DevBrowser
     * @param {(on: boolean) => void} [o.onMaximize]
     * @param {(webContentsId: number|null) => void} [o.onActive]  the page on screen
     *   changed — web/preview-agent.js tells the shell, which lists it first to an agent
     * @param {() => void} [o.onPages]  the list of pages, or something it shows, changed
     * @param {(anchor: HTMLElement) => void} [o.onPagesMenu]  the toolbar's Pages button
     * @param {(id: string) => string|null} [o.sessionName]
     */
    constructor(o) {
        this.o = o;
        const q = (sel) => o.root.querySelector(sel);
        this.el = {
            home: q('[data-pv="home"]'),
            close: q('[data-pv="close"]'),
            back: q('[data-pv="back"]'),
            forward: q('[data-pv="forward"]'),
            reload: q('[data-pv="reload"]'),
            shot: q('[data-pv="shot"]'),
            pick: q('[data-pv="pick"]'),
            title: q('[data-pv="title"]'),
            path: q('[data-pv="address"]'),
            pages: q('[data-pv="pages"]'),
            pageCount: q('[data-pv="page-count"]'),
            viewports: [...o.root.querySelectorAll('[data-pv-device]')],
            orient: q('[data-pv="orient"]'),
            output: q('[data-pv="output"]'),
            devbrowser: q('[data-pv="devbrowser"]'),
            max: q('[data-pv="max"]'),
            canvas: q('[data-pv="canvas"]'),
            device: q('[data-pv="device"]'),
            frames: q('[data-pv="frames"]'),
            badge: q('[data-pv="badge"]'),
            empty: q('[data-pv="empty"]'),
        };
        this.entries = new Map();   // port or origin -> entry
        this.active = null;         // the entry on screen, or null
        this.visible = false;
        this.device = 'fit';
        this.landscape = false;
        this.maximized = false;
        this.picking = 0;           // pick session number while armed, else 0
        this.agent = null;          // the shell's agent state, for pinning and the list
        this.pagesSig = '';

        const e = this.el;
        e.home.onclick = () => o.onHome();
        e.close.onclick = () => o.onHome();
        e.back.onclick = () => this.withView(v => v.canGoBack() && v.goBack());
        e.forward.onclick = () => this.withView(v => v.canGoForward() && v.goForward());
        e.reload.onclick = () => this.reload();
        e.shot.onclick = () => this.screenshot();
        e.pick.onclick = () => (this.picking ? this.cancelPick() : this.pick());
        e.pages.onclick = () => o.onPagesMenu && o.onPagesMenu(e.pages);
        // Editing shows the whole URL, scheme included; see web/preview-pages.js.
        e.path.addEventListener('focus', () => {
            if (this.active) e.path.value = this.active.url || '';
            e.path.select();
        });
        e.path.addEventListener('blur', () => this.paintAddress());
        e.path.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); this.go(e.path.value); e.path.blur(); }
            // Escape here means "never mind this address", not "close the
            // preview", so it stops before the app's Escape ladder sees it.
            if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.stopPropagation();
                e.path.blur();
                this.paintAddress();
            }
        });
        for (const b of e.viewports) b.onclick = () => this.setDevice(b.dataset.pvDevice);
        e.orient.onclick = () => { this.landscape = !this.landscape; this.paintDevice(); };
        e.output.onclick = () => this.active && o.onOutput && o.onOutput(this.active);
        e.devbrowser.onclick = () => this.active && o.onDevBrowser && o.onDevBrowser(this.active);
        e.max.onclick = () => this.setMaximized(!this.maximized);

        // Esc cancels a pick from the toolbar too, not only from inside the
        // guest, and goes no further — the app's own Esc ladder would otherwise
        // take the same key as "close the preview".
        o.root.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Escape') return;
            if (this.picking) { this.cancelPick(); ev.stopPropagation(); }
        });

        new ResizeObserver(() => this.paintDevice()).observe(e.canvas);
        this.paintToolbar();
    }

    /** Whether this build can do the whole toolbar, for the Settings note. */
    static get full() { return HAS_WEBVIEW; }

    /**
     * Show a port. Creates the page the first time and finds the kept one after
     * that; a `path` on an existing page navigates it, no path leaves it alone.
     */
    open({ port, title = null, path = null, runId = null, sessionId = null }) {
        port = Number(port);
        let entry = this.entries.get(port);
        if (!entry) {
            entry = this.create({ key: port, port, url: previewUrl(port, path) });
            this.entries.set(port, entry);
        } else if (path != null) {
            this.load(entry, previewUrl(port, path));
        }
        if (title) entry.title = title;
        if (runId) entry.runId = runId;
        if (sessionId) entry.sessionId = sessionId;
        this.select(entry);
        return entry;
    }

    /**
     * Show any http(s) URL. A plain-http local port goes to open(), so a link to
     * a running dev server finds the page its chip opened. Anything else is a
     * page of its own, keyed by origin, once the shell has agreed to it.
     *
     * `sessionId` is who asked — the conversation a link was clicked in, or the
     * session whose agent called open_in_preview — for the list of pages.
     *
     * @returns {Promise<boolean>} false when it could not be shown here, and
     *   the caller should send it to the browser instead.
     */
    async openUrl(url, { sessionId = null } = {}) {
        let u;
        try { u = new URL(url); } catch { return false; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        if (u.protocol === 'http:' && u.port && LOOPBACK.has(u.hostname)) {
            this.open({ port: Number(u.port), path: u.pathname + u.search + u.hash, sessionId });
            return true;
        }
        if (!canPreviewUrls) return false;
        const r = await window.claudeShell.allowPreviewOrigin(u.origin).catch(() => null);
        if (!(r && r.ok)) return false;
        let entry = this.entries.get(u.origin);
        if (!entry) {
            entry = this.create({ key: u.origin, base: u.origin, url: u.href });
            this.entries.set(u.origin, entry);
        } else {
            this.load(entry, u.href);
        }
        if (sessionId) entry.sessionId = sessionId;
        this.select(entry);
        return true;
    }

    /** Put a page the pane holds back on screen, by its key. */
    show(key) {
        const entry = this.entries.get(key);
        if (!entry) return false;
        this.select(entry);
        return true;
    }

    /** Every page the pane holds, as web/preview-pages.js lists them. */
    rows() {
        return pageRows(this.entries.values(), {
            agent: this.agent,
            activeKey: this.active ? this.active.key : null,
            sessionName: this.o.sessionName,
        });
    }

    /** The page actually in front of the user, or null. */
    onScreenKey() {
        return this.visible && this.active ? this.active.key : null;
    }

    /**
     * Tell whoever draws the list, but only when something it shows changed:
     * the agent's state comes round once a second while commands flow.
     */
    changed() {
        const rows = this.rows();
        const sig = JSON.stringify([this.onScreenKey(), rows]);
        this.paintPages(rows);
        if (sig === this.pagesSig) return;
        this.pagesSig = sig;
        if (this.o.onPages) this.o.onPages();
    }

    /**
     * The shell's agent state: which guests an agent is attached to, and which
     * sites are waiting on the user. A page in either is pinned — its clock
     * stopped — and one that stops being either gets a fresh clock, as though
     * it had just been left.
     */
    setAgentState(st) {
        this.agent = st || null;
        for (const entry of this.entries.values()) {
            if (this.visible && entry === this.active) continue;
            if (this.isPinned(entry)) {
                clearTimeout(entry.timer);
                entry.timer = null;
                entry.parked = true;
            } else if (entry.parked) {
                this.release(entry);
            }
        }
        this.changed();
    }

    isPinned(entry) {
        return pinnedPage(entry, this.agent);
    }

    /** Drop a page now, whatever its keep-alive says — its server has gone. */
    discard(key) {
        const entry = this.entries.get(typeof key === 'string' && !/^\d+$/.test(key) ? key : Number(key));
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.node.remove();
        this.entries.delete(entry.key);
        if (this.active === entry) { this.active = null; this.paintToolbar(); }
        this.changed();
    }

    /**
     * The panel came on screen or went off it. Leaving is what starts the clock
     * on the page that was showing; coming back stops it.
     */
    setVisible(on) {
        if (on === this.visible) return;
        this.visible = on;
        if (this.active) {
            if (on) this.hold(this.active);
            else { this.cancelPick(); this.release(this.active); }
        }
        this.changed();
    }

    setMaximized(on) {
        this.maximized = on;
        this.el.max.classList.toggle('on', on);
        this.el.max.setAttribute('aria-pressed', String(on));
        this.el.max.title = on ? 'Restore (show the sidebar again)' : 'Maximize — hide everything but the top bar';
        if (this.o.onMaximize) this.o.onMaximize(on);
    }

    // ── pages ─────────────────────────────────────────────────────────────

    /** `port` for a dev server's page, `base` (an origin) for a site's. */
    create({ key, port = null, base = null, url }) {
        const entry = {
            key, port, base, title: null, runId: null, url, timer: null, node: null, ready: false,
            sessionId: null, pageTitle: null, wcId: null, parked: false,
        };
        if (HAS_WEBVIEW) {
            const v = document.createElement('webview');
            // The partition is enforced again in app/main.js; saying it here too
            // is what makes the page's own intent readable.
            v.setAttribute('partition', 'persist:preview');
            v.setAttribute('src', url);
            v.className = 'pv-frame';
            const moved = () => { entry.ready = true; this.onNavigate(entry); };
            v.addEventListener('dom-ready', () => {
                try { entry.wcId = v.getWebContentsId(); } catch { /* going away */ }
                moved();
            });
            v.addEventListener('page-title-updated', (ev) => {
                entry.pageTitle = ev.title || null;
                this.changed();
            });
            v.addEventListener('did-navigate', moved);
            v.addEventListener('did-navigate-in-page', moved);
            v.addEventListener('did-fail-load', (ev) => {
                // -3 is ERR_ABORTED: a navigation replaced by another, not a failure.
                if (ev.isMainFrame && ev.errorCode !== -3 && this.active === entry) {
                    this.o.toast(`${nameOf(entry)} did not load — ${ev.errorDescription || 'no answer'}.`, 'error');
                }
            });
            entry.node = v;
        } else {
            const f = document.createElement('iframe');
            f.className = 'pv-frame';
            // No allow-top-navigation: a page in here must not be able to
            // navigate the app away from under you. Same-origin is the dev
            // server's own origin, not ours, so allowing it grants nothing here.
            f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms '
                + 'allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads');
            f.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
            f.src = url;
            f.addEventListener('load', () => { entry.ready = true; this.onNavigate(entry); });
            entry.node = f;
        }
        this.el.frames.append(entry.node);
        return entry;
    }

    select(entry) {
        if (this.active && this.active !== entry) {
            this.cancelPick();
            this.active.node.classList.remove('active');
            this.release(this.active);
        }
        this.active = entry;
        entry.node.classList.add('active');
        if (this.visible) this.hold(entry);
        this.paintToolbar();
        this.tellActive();
        this.changed();
    }

    /** The guest on screen's webContents id, or null — only a ready <webview> has one. */
    activeWebContentsId() {
        const a = this.active;
        if (!(HAS_WEBVIEW && a && a.ready)) return null;
        try { return a.node.getWebContentsId(); } catch { return null; }
    }

    tellActive() {
        if (this.o.onActive) this.o.onActive(this.activeWebContentsId());
    }

    /** It is being looked at: stop its clock. */
    hold(entry) {
        clearTimeout(entry.timer);
        entry.timer = null;
        entry.parked = false;
    }

    /**
     * Nobody is looking at it: start the clock, or drop it at once for 0 —
     * unless an agent needs it, in which case it waits with no clock at all
     * until setAgentState says the agent is done with it.
     */
    release(entry) {
        clearTimeout(entry.timer);
        entry.timer = null;
        entry.parked = this.isPinned(entry);
        if (entry.parked) return;
        const minutes = Number(this.o.keepAliveMinutes()) || 0;
        if (minutes <= 0) { this.discard(entry.key); return; }
        entry.timer = setTimeout(() => this.expire(entry), minutes * 60_000);
    }

    /** The clock ran out. Checked again: an agent may have arrived meanwhile. */
    expire(entry) {
        entry.timer = null;
        if (this.isPinned(entry)) { entry.parked = true; return; }
        this.discard(entry.key);
    }

    load(entry, url) {
        entry.url = url;
        if (HAS_WEBVIEW && entry.ready) entry.node.loadURL(url).catch(() => { /* reported by did-fail-load */ });
        else if (HAS_WEBVIEW) entry.node.setAttribute('src', url);
        else entry.node.src = url;
        if (entry === this.active) this.paintAddress();
    }

    /**
     * Whatever was typed in the bar; web/preview-pages.js says what it means.
     * A local port finds its page; the site on screen is navigated, as a
     * browser's bar would; another site is the user's own navigation, which is
     * the same as clicking a link to it in chat — granted for the session, and
     * a page of its own. Where no site can be shown, it goes to the browser.
     */
    async go(text) {
        const a = this.active;
        const target = parseAddress(text, a ? a.url : null, PREVIEW_HOST);
        if (!target) {
            if (String(text || '').trim()) this.o.toast(`Not an address this preview can open: ${String(text).trim()}`, 'error');
            this.paintAddress();
            return;
        }
        if (target.port) {
            const u = new URL(target.url);
            this.open({ port: target.port, path: u.pathname + u.search + u.hash });
            return;
        }
        const origin = originOf(target.url);
        if (a && originOf(a.url) === origin) {
            const local = LOOPBACK.has(new URL(target.url).hostname);
            const r = local || !canPreviewUrls ? { ok: true }
                : await window.claudeShell.allowPreviewOrigin(origin).catch(() => null);
            if (r && r.ok) { this.load(a, target.url); return; }
        }
        if (await this.openUrl(target.url, { sessionId: a ? a.sessionId : null })) return;
        window.open(target.url, '_blank', 'noreferrer');
        this.o.toast('This window cannot preview other sites, so it opened in your browser.', 'info');
    }

    reload() {
        const a = this.active;
        if (!a) return;
        if (HAS_WEBVIEW && a.ready) a.node.reload();
        // An iframe's current location is the page's secret, so a reload goes
        // back to the last address this pane itself asked for.
        else if (!HAS_WEBVIEW) a.node.src = a.url;
    }

    withView(fn) {
        if (HAS_WEBVIEW && this.active && this.active.ready) fn(this.active.node);
    }

    onNavigate(entry) {
        if (HAS_WEBVIEW && entry.ready) {
            try { entry.url = entry.node.getURL() || entry.url; } catch { /* guest going away */ }
        }
        // A navigation throws the injected picker away with the old document.
        if (entry === this.active) {
            if (this.picking) this.setPicking(0);
            this.paintToolbar();
            this.tellActive();
        }
        this.changed();
    }

    // ── toolbar ───────────────────────────────────────────────────────────

    paintToolbar() {
        const e = this.el;
        const a = this.active;
        const view = HAS_WEBVIEW && a && a.ready;
        const why = HAS_WEBVIEW ? '' : ' — needs the desktop app (this is an iframe)';
        e.back.disabled = !(view && a.node.canGoBack());
        e.forward.disabled = !(view && a.node.canGoForward());
        e.back.title = 'Back' + why;
        e.forward.title = 'Forward' + why;
        e.reload.disabled = !a;
        e.shot.disabled = !view;
        e.shot.title = 'Copy a screenshot to the clipboard' + why;
        e.pick.disabled = !view;
        e.pick.title = 'Pick an element and copy what it is (Esc cancels)' + why;
        e.path.disabled = !a;
        e.output.hidden = !(a && a.runId && this.o.onOutput);
        e.devbrowser.hidden = !(a && a.port && this.o.onDevBrowser && this.o.showDevBrowser && this.o.showDevBrowser());
        e.empty.hidden = Boolean(a);
        this.paintAddress();
    }

    paintAddress() {
        const e = this.el;
        const a = this.active;
        e.title.hidden = !(a && a.title);
        e.title.textContent = a && a.title ? a.title : '';
        e.path.title = a ? a.url : '';
        if (document.activeElement === e.path) return;   // do not type over the user
        e.path.value = a ? displayAddress(a.url) : '';
    }

    /** The Pages button: there once there is a page, counting them past one. */
    paintPages(rows = this.rows()) {
        const e = this.el;
        e.pages.hidden = !rows.length;
        e.pageCount.hidden = rows.length < 2;
        e.pageCount.textContent = String(rows.length);
        e.pages.classList.toggle('agent', rows.some(r => r.agent));
        e.pages.title = `Preview pages — ${rows.length} open${rows.some(r => r.agent) ? ', an agent is using one' : ''}`;
    }

    setDevice(name) {
        if (!(name in VIEWPORTS)) return;
        this.device = name;
        if (name === 'fit') this.landscape = false;
        for (const b of this.el.viewports) {
            const on = b.dataset.pvDevice === name;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', String(on));
        }
        this.paintDevice();
    }

    /**
     * Size the device frame. The preset's own pixels when they fit — a phone
     * preview that lays the page out at 375 CSS pixels is the point of having
     * one — and scaled down to the canvas, aspect kept, when they do not.
     * DevBrowser always scales to fill; that makes "Phone" mean "tall" rather
     * than "375 wide", which is not what anybody picking it is asking.
     *
     * Desktop is the exception, and `fill` marks it: nobody picking it means a
     * particular width, they mean "a monitor-shaped page", so it is the largest
     * 16:9 the canvas holds and follows the pane as it resizes.
     */
    paintDevice() {
        const e = this.el;
        const preset = VIEWPORTS[this.device];
        e.device.className = `pv-device ${this.device}${this.landscape ? ' landscape' : ''}`;
        e.canvas.classList.toggle('device-mode', Boolean(preset));
        e.orient.disabled = !preset;
        e.orient.classList.toggle('on', this.landscape);
        e.badge.hidden = !preset;
        if (!preset) {
            e.device.style.width = '';
            e.device.style.height = '';
            return;
        }
        const w0 = this.landscape ? preset.h : preset.w;
        const h0 = this.landscape ? preset.w : preset.h;
        const room = 80 + 48;   // canvas padding, plus the thickest bezel pair
        const availW = Math.max(100, e.canvas.clientWidth - room);
        const availH = Math.max(100, e.canvas.clientHeight - room);
        const scale = preset.fill
            ? Math.min(availW / w0, availH / h0)
            : Math.min(1, availW / w0, availH / h0);
        const w = Math.round(w0 * scale);
        const h = Math.round(h0 * scale);
        e.device.style.width = `${w}px`;
        e.device.style.height = `${h}px`;
        e.badge.textContent = preset.fill
            ? `${w} × ${h} — ${w0}:${h0}, as large as fits`
            : scale < 1
            ? `${w} × ${h} — ${w0} × ${h0} scaled to fit`
            : `${w} × ${h}`;
    }

    async screenshot() {
        const a = this.active;
        if (!(HAS_WEBVIEW && a && a.ready)) return;
        try {
            const r = await window.claudeShell.capturePreview(a.node.getWebContentsId());
            if (r && r.ok) this.o.toast(`Screenshot copied — ${r.width} × ${r.height}.`, 'ok');
            else this.o.toast(`Could not capture ${nameOf(a)}${r && r.error ? ` (${r.error})` : ''}.`, 'error');
        } catch (err) {
            this.o.toast(`Could not capture ${nameOf(a)}. ${err.message}`, 'error');
        }
    }

    setPicking(session) {
        this.picking = session;
        this.el.pick.classList.toggle('on', Boolean(session));
        this.el.pick.setAttribute('aria-pressed', String(Boolean(session)));
        this.el.frames.classList.toggle('picking', Boolean(session));
    }

    async pick() {
        const a = this.active;
        if (!(HAS_WEBVIEW && a && a.ready)) return;
        const session = (this.pickCount = (this.pickCount || 0) + 1);
        this.setPicking(session);
        // Keys go to the guest while picking, so its own Esc handler can cancel.
        a.node.focus();
        let payload = null;
        try {
            payload = await a.node.executeJavaScript(PICKER_SOURCE);
        } catch {
            if (this.picking === session) this.o.toast('The picker cannot run on this page.', 'error');
            if (this.picking === session) this.setPicking(0);
            return;
        }
        if (this.picking !== session) return;   // cancelled, navigated, or superseded
        this.setPicking(0);
        if (!payload) { this.o.toast('Pick cancelled.'); return; }
        const r = await window.claudeShell.copyText(payload).catch(() => null);
        this.o.toast(r && r.ok ? 'Element copied to the clipboard.' : 'Could not copy the element.',
            r && r.ok ? 'ok' : 'error');
    }

    cancelPick() {
        if (!this.picking) return;
        this.setPicking(0);
        const a = this.active;
        if (HAS_WEBVIEW && a && a.ready) {
            // Resolves the guest's pending promise with null and removes its overlay.
            a.node.executeJavaScript('window.__devBrowserPickerCancel && window.__devBrowserPickerCancel();')
                .catch(() => { /* the guest navigated or went away */ });
        }
    }
}
