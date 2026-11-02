'use strict';

// The shell's updater: check a feed, fetch the installer it names, check it,
// and run it — on quit, or now with a restart. app/update-feed.js is the pure
// half (formats, versions, settings); this is the state machine around it.
//
// Everything that touches the outside — reading the feed, a download, starting
// the installer, quitting — is handed in, so test/updater.test.js drives the
// whole thing with stubs and a temp directory. app/main.js supplies the real ones.
//
// What it promises, because each is a way to lose the app:
//
//   - **The sha512 is checked twice**: once when the download lands, and again
//     right before the installer runs, so a file changed in between is refused
//     rather than run.
//   - **No downgrade unless asked.** A feed older than what is installed is
//     reported (`older`), never downloaded or installed on its own; only
//     `download({ allowDowngrade: true })` — a button the user pressed — does.
//   - **Nothing is touched until the installer runs**, and the installer is the
//     only thing that touches the install. If it cannot be started — or Windows
//     asks for elevation and the answer is no — the app keeps running (a restart
//     waits for the installer to have started before quitting) and says so. A
//     marker left just before it starts lets the next launch say "the update to X
//     did not finish" instead of leaving you to notice the version did not move.
//     The one case this cannot cover is the installer itself failing halfway:
//     electron-builder's script removes the old copy before it extracts the new
//     one. The installer stays in the cache directory for exactly that, and
//     install.ps1 always works.
//   - **Inert where it should be.** Only a packaged Windows shell on the everyday
//     port installs anything; a dev window (`npm run dev` runs the installed exe
//     on another port) shows the card and changes nothing.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const feed = require('./update-feed');

const STARTUP_DELAY_MS = 15 * 1000;
const PENDING = 'pending.json';
// A marker older than this is stale history, not a failed update worth a sentence.
const PENDING_MAX_AGE_MS = 24 * 3600 * 1000;

class Updater extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} o.installedVersion  app.getVersion()
     * @param {string} o.platform          process.platform
     * @param {boolean} o.enabled          may this shell install anything
     * @param {string} [o.disabledReason]  the sentence for when it may not
     * @param {string} o.defaultFolder     the folder used when none is set
     * @param {string} o.cacheDir          where downloads wait; never the install dir
     * @param {() => object} o.getSettings
     * @param {(s: object) => void} o.saveSettings
     * @param {(url: string) => Promise<string>} o.fetchText    rejects with err.status on HTTP errors
     * @param {(url: string, dest: string, onProgress: (got: number, total: number|null) => void) => Promise<void>} o.download
     * @param {(file: string, args: string[]) => Promise<void>} o.launchInstaller  resolves once it has started
     * @param {() => void} o.quit
     */
    constructor(o) {
        super();
        this.o = { now: () => Date.now(), setTimeout, clearTimeout, startupDelay: STARTUP_DELAY_MS, ...o };
        this.timer = null;
        this.busy = null;              // the check/download promise in flight
        this.allowDowngrade = false;   // set only by an explicit download({ allowDowngrade })
        this.state = {
            phase: o.enabled ? 'idle' : 'disabled',
            available: null,           // pickInstaller()'s result for the feed's version
            relation: null,            // newer | same | older
            progress: null,            // 0..1 while downloading
            error: null,
            checkedAt: null,
            source: null,              // the feed's label: a folder or owner/repo
            readyFile: null,
            notice: null,              // { kind: 'updated' | 'failed', from, to }
        };
        // Only where installs happen: a dev window shares this directory and would
        // otherwise eat the marker and report on an update that is not its own.
        if (o.enabled) this._readPending();
    }

    settings() {
        return feed.normalizeSettings(this.o.getSettings());
    }

    snapshot() {
        const { readyFile, ...st } = this.state;
        return {
            ...st,
            ready: Boolean(readyFile),
            installed: this.o.installedVersion,
            enabled: this.o.enabled,
            disabledReason: this.o.enabled ? null : (this.o.disabledReason || null),
            defaultFolder: this.o.defaultFolder,
            platform: this.o.platform,
            settings: this.settings(),
        };
    }

    _set(patch) {
        Object.assign(this.state, patch);
        this.emit('state', this.snapshot());
    }

    // ── the marker a launched installer leaves behind ──

    _pendingPath() { return path.join(this.o.cacheDir, PENDING); }

    _readPending() {
        let p;
        try { p = JSON.parse(fs.readFileSync(this._pendingPath(), 'utf8')); } catch { return; }
        try { fs.unlinkSync(this._pendingPath()); } catch { /* gone already */ }
        if (!p || typeof p.to !== 'string' || this.o.now() - Number(p.at) > PENDING_MAX_AGE_MS) return;
        this.state.notice = this.o.installedVersion === p.to
            ? { kind: 'updated', from: p.from, to: p.to }
            : { kind: 'failed', from: this.o.installedVersion, to: p.to };
    }

    dismissNotice() { this._set({ notice: null }); }

    // ── scheduling ──

    start() {
        if (!this.o.enabled) return;
        const s = this.settings();
        if (s.source === 'off') { this._set({ phase: 'off' }); return; }
        this._cleanCache();
        if (s.checkOnStartup) this._schedule(this.o.startupDelay);
        else this._schedulePeriodic();
    }

    stop() {
        if (this.timer) this.o.clearTimeout(this.timer);
        this.timer = null;
    }

    _schedule(ms) {
        this.stop();
        if (ms == null) return;
        this.timer = this.o.setTimeout(() => {
            this.timer = null;
            this.check().catch(() => { /* recorded in state */ }).finally(() => this._schedulePeriodic());
        }, ms);
        if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    }

    _schedulePeriodic() {
        if (!this.o.enabled) return;
        this._schedule(feed.nextCheckDelay(this.settings(), this.state.checkedAt, this.o.now()));
    }

    /** The page changed a setting. Returns the new snapshot, or `{ error }`. */
    setSettings(patch) {
        const r = feed.applySettingsPatch(this.o.getSettings(), patch, this.o.platform);
        if (r.error) return { error: r.error };
        const before = this.settings();
        this.o.saveSettings(r.settings);
        const sourceMoved = before.source !== r.settings.source || before.folder !== r.settings.folder
            || before.github.owner !== r.settings.github.owner || before.github.repo !== r.settings.github.repo;
        if (sourceMoved && !this.busy && this.state.phase !== 'installing') {
            // What the old feed offered is no longer what is on offer.
            this.allowDowngrade = false;
            this._set({ phase: !this.o.enabled ? 'disabled' : r.settings.source === 'off' ? 'off' : 'idle',
                available: null, relation: null, error: null, readyFile: null, progress: null, source: null });
        } else {
            this._set({});
        }
        if (this.o.enabled) {
            if (r.settings.source === 'off') this.stop();
            else this._schedulePeriodic();
        }
        return this.snapshot();
    }

    // ── checking ──

    check() {
        if (this.busy) return this.busy;
        if (!this.o.enabled) return Promise.resolve(this.snapshot());
        this.busy = this._check().finally(() => { this.busy = null; });
        return this.busy;
    }

    async _check() {
        const s = this.settings();
        const loc = feed.feedLocation(s, { platform: this.o.platform, defaultFolder: this.o.defaultFolder });
        if (!loc) { this._set({ phase: 'off', error: null }); return this.snapshot(); }
        if (this.state.phase === 'installing') return this.snapshot();
        this._set({ phase: 'checking', error: null, source: loc.label });

        let text;
        try {
            text = loc.kind === 'folder'
                ? await fs.promises.readFile(loc.manifest, 'utf8')
                : await this.o.fetchText(loc.manifest);
        } catch (err) {
            // A feed that went away does not undo an installer already here and
            // checked: it stays ready, and the sentence says the check failed.
            return this._fail(this._readError(loc, err),
                { checkedAt: this.o.now(), ...(this.state.readyFile ? { phase: 'ready' } : {}) });
        }
        const pick = feed.pickInstaller(feed.parseLatestYml(text));
        if (pick.error) {
            return this._fail(`The feed at ${loc.label} is unusable: ${pick.error}.`,
                { checkedAt: this.o.now(), ...(this.state.readyFile ? { phase: 'ready' } : {}) });
        }

        const rel = feed.relation(this.o.installedVersion, pick.version);
        const sameAsReady = this.state.readyFile && this.state.available
            && this.state.available.version === pick.version && this.state.available.sha512 === pick.sha512;
        if (sameAsReady) {
            this._set({ phase: 'ready', relation: rel, checkedAt: this.o.now() });
            return this.snapshot();
        }
        this.allowDowngrade = false;
        this._set({
            phase: rel === 'newer' ? 'available' : rel === 'older' ? 'older' : 'up-to-date',
            available: pick, relation: rel, readyFile: null, progress: null, checkedAt: this.o.now(),
        });
        // Under this check's promise, so a second click waits for both.
        if (rel === 'newer' && s.autoDownload) await this._download();
        return this.snapshot();
    }

    _readError(loc, err) {
        if (loc.kind === 'folder') {
            if (err && err.code === 'ENOENT') {
                return fs.existsSync(loc.dir)
                    ? `No update has been published to ${loc.dir} yet. Build one with npm run release:local.`
                    : `The updates folder ${loc.dir} does not exist yet. npm run release:local creates it.`;
            }
            return `Could not read ${loc.manifest}: ${err && err.message}`;
        }
        if (err && err.status === 404) return `${loc.label} has no release with a latest.yml yet.`;
        return `Could not reach ${loc.label}: ${err && err.message}`;
    }

    _fail(message, extra = {}) {
        this._set({ phase: 'error', error: message, progress: null, ...extra });
        return this.snapshot();
    }

    // ── downloading ──

    /**
     * Fetch the installer the last check found. An older one only with
     * `allowDowngrade`, which is the user choosing it in so many words.
     */
    download({ allowDowngrade = false } = {}) {
        if (this.busy) return this.busy;
        if (!this.o.enabled) return Promise.resolve(this.snapshot());
        const a = this.state.available;
        if (!a) return Promise.resolve(this._fail('Check for an update first.'));
        if (this.state.relation === 'same') return Promise.resolve(this.snapshot());
        if (this.state.relation === 'older') {
            if (!allowDowngrade) {
                return Promise.resolve(this._fail(`${a.version} is older than the installed ${this.o.installedVersion}; `
                    + 'choose “Install older version” to go back to it.', { phase: 'older' }));
            }
            this.allowDowngrade = true;
        }
        this.busy = this._download().finally(() => { this.busy = null; });
        return this.busy;
    }

    async _download() {
        const a = this.state.available;
        const loc = feed.feedLocation(this.settings(), { platform: this.o.platform, defaultFolder: this.o.defaultFolder });
        if (!a || !loc) return this._fail('There is nothing to download.');
        fs.mkdirSync(this.o.cacheDir, { recursive: true });
        const dest = path.join(this.o.cacheDir, a.file);
        const partial = `${dest}.partial`;

        // Already here from an earlier run, and intact: nothing to fetch.
        if (fs.existsSync(dest) && await feed.verifySha512(dest, a.sha512)) {
            this._set({ phase: 'ready', readyFile: dest, progress: 1, error: null });
            return this.snapshot();
        }

        this._set({ phase: 'downloading', progress: 0, error: null });
        try {
            try { fs.unlinkSync(partial); } catch { /* none left over */ }
            if (loc.kind === 'folder') {
                const src = loc.filePath(a.file);
                if (!fs.existsSync(src)) return this._fail(`The feed names ${a.file}, but it is not in ${loc.dir}.`, { phase: 'error' });
                await fs.promises.copyFile(src, partial);
            } else {
                await this.o.download(loc.fileUrl(a.file), partial, (got, total) => {
                    const t = total || a.size;
                    if (t) this._set({ progress: Math.min(1, got / t) });
                });
            }
        } catch (err) {
            try { fs.unlinkSync(partial); } catch { /* nothing written */ }
            return this._fail(`Downloading ${a.file} failed: ${err && err.message}`);
        }
        if (!await feed.verifySha512(partial, a.sha512)) {
            try { fs.unlinkSync(partial); } catch { /* best effort */ }
            return this._fail(`${a.file} did not match the sha512 in the feed, so it was thrown away. `
                + 'The release may still be copying — check again in a minute.');
        }
        fs.renameSync(partial, dest);
        this._set({ phase: 'ready', readyFile: dest, progress: 1, error: null });
        this._cleanCache(dest);
        return this.snapshot();
    }

    /** Installers from earlier downloads; the one about to be used is kept. */
    _cleanCache(keep) {
        let names = [];
        try { names = fs.readdirSync(this.o.cacheDir); } catch { return; }
        for (const n of names) {
            const p = path.join(this.o.cacheDir, n);
            if (p === keep || n === PENDING) continue;
            if (/\.exe(\.partial)?$/i.test(n)) { try { fs.unlinkSync(p); } catch { /* in use */ } }
        }
    }

    // ── installing ──

    /**
     * Run the downloaded installer. `restart` quits the app once it has started
     * and has the installer bring it back; without it the app stays open, which
     * is the install-on-quit path (main.js quits right after).
     */
    async install({ restart = false } = {}) {
        if (!this.o.enabled) return { ok: false, error: this.o.disabledReason || 'updates are off in this window' };
        if (this.busy) return { ok: false, error: 'busy' };
        const a = this.state.available;
        const file = this.state.readyFile;
        if (this.state.phase !== 'ready' || !a || !file) return { ok: false, error: 'no update is ready' };
        if (feed.relation(this.o.installedVersion, a.version) !== 'newer' && !this.allowDowngrade) {
            return { ok: false, error: `${a.version} is not newer than ${this.o.installedVersion}` };
        }
        // The second check: a file can change between download and now.
        if (!await feed.verifySha512(file, a.sha512)) {
            try { fs.unlinkSync(file); } catch { /* best effort */ }
            this._fail('The downloaded installer no longer matches its sha512 and was removed. Check again to fetch it fresh.',
                { readyFile: null });
            return { ok: false, error: this.state.error };
        }

        this._set({ phase: 'installing', error: null });
        try {
            fs.writeFileSync(this._pendingPath(),
                JSON.stringify({ from: this.o.installedVersion, to: a.version, at: this.o.now() }));
        } catch { /* the marker is a courtesy */ }
        try {
            await this.o.launchInstaller(file, feed.installerArgs({ restart }));
        } catch (err) {
            try { fs.unlinkSync(this._pendingPath()); } catch { /* none */ }
            this._set({ phase: 'ready', error: `The installer did not start (${err && err.message}). `
                + `TGXCode ${this.o.installedVersion} is still installed and running.` });
            return { ok: false, error: this.state.error };
        }
        if (restart) this.o.quit();
        return { ok: true };
    }

    /** Whether quitting now should run the installer. */
    wantsInstallOnQuit() {
        return this.o.enabled && this.state.phase === 'ready' && Boolean(this.state.readyFile)
            && this.settings().installOnQuit
            && (this.state.relation === 'newer' || this.allowDowngrade);
    }
}

module.exports = { Updater, STARTUP_DELAY_MS };
