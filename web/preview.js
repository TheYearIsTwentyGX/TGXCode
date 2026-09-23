// The browser preview — a dev server's page, inside the window.
//
// DevBrowser (~/Other/dev-browser) was the only way to look at what an agent
// started, and it is a second app on the Windows host: a click here raised a
// window over there. This is the same toolbar, left to right — Home, Back,
// Forward, Reload, Screenshot, Pick, the address bar, the viewport presets and
// the orientation toggle — without DevBrowser's OS-window presets, which resize
// the whole window and make no sense for a pane inside this one.
//
// Two ways to hold a page, chosen once per load:
//
//  - **<webview>**, in the packaged shell. It is its own renderer in its own
//    partition, so everything on the toolbar works: history, capturePage for the
//    screenshot, executeJavaScript for the picker. app/main.js decides what a
//    guest may be (loopback only, no preload, no Node) in will-attach-webview.
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

import { PICKER_SOURCE } from './preview-picker.js';

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

const VIEWPORTS = {
    fit: null,
    phone: { w: 375, h: 812 },
    tablet: { w: 768, h: 1024 },
    desktop: { w: 1440, h: 900 },
};

export function previewUrl(port, path = '') {
    return `http://${PREVIEW_HOST}:${port}/${String(path || '').replace(/^\/+/, '')}`;
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
     */
    constructor(o) {
        this.o = o;
        const q = (sel) => o.root.querySelector(sel);
        this.el = {
            home: q('[data-pv="home"]'),
            back: q('[data-pv="back"]'),
            forward: q('[data-pv="forward"]'),
            reload: q('[data-pv="reload"]'),
            shot: q('[data-pv="shot"]'),
            pick: q('[data-pv="pick"]'),
            title: q('[data-pv="title"]'),
            host: q('[data-pv="host"]'),
            path: q('[data-pv="path"]'),
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
        this.entries = new Map();   // port -> entry
        this.active = null;         // the entry on screen, or null
        this.visible = false;
        this.device = 'fit';
        this.landscape = false;
        this.maximized = false;
        this.picking = 0;           // pick session number while armed, else 0

        const e = this.el;
        e.home.onclick = () => o.onHome();
        e.back.onclick = () => this.withView(v => v.canGoBack() && v.goBack());
        e.forward.onclick = () => this.withView(v => v.canGoForward() && v.goForward());
        e.reload.onclick = () => this.reload();
        e.shot.onclick = () => this.screenshot();
        e.pick.onclick = () => (this.picking ? this.cancelPick() : this.pick());
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
    open({ port, title = null, path = null, runId = null }) {
        port = Number(port);
        let entry = this.entries.get(port);
        if (!entry) {
            entry = this.create(port, path);
            this.entries.set(port, entry);
        } else if (path != null) {
            this.load(entry, previewUrl(port, path));
        }
        if (title) entry.title = title;
        if (runId) entry.runId = runId;
        this.select(entry);
        return entry;
    }

    /** Drop a page now, whatever its keep-alive says — its server has gone. */
    discard(port) {
        const entry = this.entries.get(Number(port));
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.node.remove();
        this.entries.delete(entry.port);
        if (this.active === entry) { this.active = null; this.paintToolbar(); }
    }

    /**
     * The panel came on screen or went off it. Leaving is what starts the clock
     * on the page that was showing; coming back stops it.
     */
    setVisible(on) {
        if (on === this.visible) return;
        this.visible = on;
        if (!this.active) return;
        if (on) this.hold(this.active);
        else { this.cancelPick(); this.release(this.active); }
    }

    setMaximized(on) {
        this.maximized = on;
        this.el.max.classList.toggle('on', on);
        this.el.max.setAttribute('aria-pressed', String(on));
        this.el.max.title = on ? 'Restore (show the sidebar again)' : 'Maximize — hide everything but the top bar';
        if (this.o.onMaximize) this.o.onMaximize(on);
    }

    // ── pages ─────────────────────────────────────────────────────────────

    create(port, path) {
        const url = previewUrl(port, path);
        const entry = { port, title: null, runId: null, url, timer: null, node: null, ready: false };
        if (HAS_WEBVIEW) {
            const v = document.createElement('webview');
            // The partition is enforced again in app/main.js; saying it here too
            // is what makes the page's own intent readable.
            v.setAttribute('partition', 'persist:preview');
            v.setAttribute('src', url);
            v.className = 'pv-frame';
            const moved = () => { entry.ready = true; this.onNavigate(entry); };
            v.addEventListener('dom-ready', moved);
            v.addEventListener('did-navigate', moved);
            v.addEventListener('did-navigate-in-page', moved);
            v.addEventListener('did-fail-load', (ev) => {
                // -3 is ERR_ABORTED: a navigation replaced by another, not a failure.
                if (ev.isMainFrame && ev.errorCode !== -3 && this.active === entry) {
                    this.o.toast(`:${port} did not load — ${ev.errorDescription || 'no answer'}.`, 'error');
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
    }

    /** It is being looked at: stop its clock. */
    hold(entry) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }

    /** Nobody is looking at it: start the clock, or drop it at once for 0. */
    release(entry) {
        clearTimeout(entry.timer);
        const minutes = Number(this.o.keepAliveMinutes()) || 0;
        if (minutes <= 0) { this.discard(entry.port); return; }
        entry.timer = setTimeout(() => this.discard(entry.port), minutes * 60_000);
    }

    load(entry, url) {
        entry.url = url;
        if (HAS_WEBVIEW && entry.ready) entry.node.loadURL(url).catch(() => { /* reported by did-fail-load */ });
        else if (HAS_WEBVIEW) entry.node.setAttribute('src', url);
        else entry.node.src = url;
        if (entry === this.active) this.paintAddress();
    }

    go(path) {
        if (!this.active) return;
        this.load(this.active, previewUrl(this.active.port, path));
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
        }
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
        e.devbrowser.hidden = !(a && this.o.onDevBrowser && this.o.showDevBrowser && this.o.showDevBrowser());
        e.empty.hidden = Boolean(a);
        this.paintAddress();
    }

    paintAddress() {
        const e = this.el;
        const a = this.active;
        e.title.hidden = !(a && a.title);
        e.title.textContent = a && a.title ? a.title : '';
        e.host.textContent = a ? `${PREVIEW_HOST}:${a.port}/` : '';
        if (document.activeElement === e.path) return;   // do not type over the user
        let path = '';
        if (a) {
            try {
                const u = new URL(a.url);
                path = (u.pathname + u.search + u.hash).replace(/^\//, '');
            } catch { /* leave it empty */ }
        }
        e.path.value = path;
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
        const scale = Math.min(1, availW / w0, availH / h0);
        const w = Math.round(w0 * scale);
        const h = Math.round(h0 * scale);
        e.device.style.width = `${w}px`;
        e.device.style.height = `${h}px`;
        e.badge.textContent = scale < 1
            ? `${w} × ${h} — ${w0} × ${h0} scaled to fit`
            : `${w} × ${h}`;
    }

    async screenshot() {
        const a = this.active;
        if (!(HAS_WEBVIEW && a && a.ready)) return;
        try {
            const r = await window.claudeShell.capturePreview(a.node.getWebContentsId());
            if (r && r.ok) this.o.toast(`Screenshot copied — ${r.width} × ${r.height}.`, 'ok');
            else this.o.toast(`Could not capture :${a.port}${r && r.error ? ` (${r.error})` : ''}.`, 'error');
        } catch (err) {
            this.o.toast(`Could not capture :${a.port}. ${err.message}`, 'error');
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
