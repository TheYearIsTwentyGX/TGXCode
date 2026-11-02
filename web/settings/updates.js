// Settings → Updates: where the desktop shell looks for a new build, what it
// found, and the button that installs it.
//
// Not a row in SETTINGS' table, for the reason the Window card is not: the
// shell does the checking and keeps these in `shell-prefs.json` in its own
// profile (app/updater.js), because on Windows it cannot read the bridge's
// settings across WSL. This card talks to it over the preload, through the
// store in web/shell-update.js, which also draws the badge on the Settings
// button.
//
// Drawn in any desktop shell, including one that predates the updater — that is
// the one that most needs telling how to get onto a build that has it.

import { html, useEffect, useState } from '../vendor/preact.js';
import { settingTip } from './general.js';
import {
    buildUpdate, checkNow, downloadUpdate, inShell, restartToUpdate, setUpdateSettings,
    shellStale, subscribe, updatesAvailable, updatesStore,
} from '../shell-update.js';

export const updatesSettingsAvailable = () => inShell();

export function updatesCard() {
    return html`<${UpdatesGroup} key="updates" />`;
}

const SOURCE_NOTE = 'Folder: a folder npm run release:local publishes to — on this machine, a share or a '
    + 'synced drive. GitHub releases: the latest release of a repository, once releases are published there.';
const TRUST_NOTE = 'The installer is checked against the sha512 in latest.yml before it is run, which catches '
    + 'a damaged or half-copied file. It does not make an untrusted feed safe: whoever can write to the folder, '
    + 'or publish to the repository, can run code as you — the same trust install.ps1 has.';

function useStore() {
    const [, setTick] = useState(0);
    useEffect(() => subscribe(() => setTick((n) => n + 1)), []);
    return updatesStore();
}

const short = (h) => (h ? String(h).slice(0, 10) : '—');

function phaseText(st) {
    if (!st) return '';
    const a = st.available;
    switch (st.phase) {
    case 'disabled': return st.disabledReason || 'Updates are off in this window.';
    case 'off': return 'Not checking for updates.';
    case 'idle': return 'Not checked yet.';
    case 'checking': return `Checking ${st.source || ''}…`;
    case 'up-to-date': return `Up to date — ${st.source} has ${a ? a.version : 'nothing newer'}.`;
    case 'available': return `${a.version} is available.`;
    case 'older': return `${st.source} has ${a.version}, which is older than this one. It will not be installed unless you choose it.`;
    case 'downloading': return `Downloading ${a ? a.version : ''}… ${st.progress != null ? Math.round(st.progress * 100) + '%' : ''}`;
    case 'ready': return `${a.version} is downloaded and checked. `
        + (st.settings.installOnQuit ? 'It installs when you quit TGXCode, or now with a restart.' : 'Restart to install it.');
    case 'installing': return `Installing ${a ? a.version : ''}…`;
    case 'error': return '';
    default: return '';
    }
}

function UpdatesGroup() {
    const store = useStore();
    const st = store.state;
    const has = updatesAvailable();
    const [folder, setFolder] = useState(null);   // the text being typed, or null for "as saved"
    const [repo, setRepo] = useState(null);
    const [busy, setBusy] = useState(false);

    const act = async (fn) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
    const s = st && st.settings;
    const enabled = !!(st && st.enabled);
    const working = busy || (st && ['checking', 'downloading', 'installing'].includes(st.phase));

    const saveFolder = () => {
        if (folder === null || !s || folder.trim() === s.folder) { setFolder(null); return; }
        act(async () => { await setUpdateSettings({ folder }); if (!store.error) setFolder(null); });
    };
    const saveRepo = () => {
        if (repo === null || !s) return;
        const [owner, name] = repo.trim().split('/');
        if (owner === s.github.owner && name === s.github.repo) { setRepo(null); return; }
        act(async () => { await setUpdateSettings({ github: { owner: owner || '', repo: name || '' } }); if (!store.error) setRepo(null); });
    };
    const onKey = (save) => (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };

    const checkout = store.checkout;
    const release = checkout && checkout.release;
    const stale = shellStale();
    // A shell with no updater could not take what this builds.
    const canBuild = has && checkout && checkout.canRelease;

    return html`<section class="settings-group" id="set-g-updates">
        <h2 class="settings-group-title">Updates</h2>
        <p class="settings-group-note">The desktop shell — the window around this page — is the only
            part of TGXCode that is installed; the rest is read live from the checkout. This is how
            it gets a new build without a reinstall.</p>

        <div class="settings-row upd-status">
            <div class="settings-row-text">
                <div class="settings-row-label">TGXCode ${st ? st.installed : (store.build && store.build.version) || ''}${settingTip(TRUST_NOTE)}</div>
                ${!has ? html`<div class="settings-row-note is-warn">This shell was built before it could update
                    itself. Run install.ps1 (or npm run build) once more from WSL; after that, updates arrive here.</div>` : null}
                ${has ? html`<div class="settings-row-note">${phaseText(st)}</div>` : null}
                ${st && st.phase === 'downloading' && st.progress != null
                    ? html`<progress class="upd-progress" max="1" value=${st.progress}></progress>` : null}
                ${st && st.error ? html`<div class="settings-row-note is-warn">${st.error}</div>` : null}
                ${store.error ? html`<div class="settings-row-note is-warn">${store.error}</div>` : null}
            </div>
            ${has && st ? html`<div class="settings-row-ctl upd-actions">
                <button type="button" class="btn small" disabled=${!enabled || working || s.source === 'off'}
                    onClick=${() => act(checkNow)}>Check now</button>
                ${st.phase === 'available' && !s.autoDownload ? html`<button type="button" class="btn small"
                    disabled=${working} onClick=${() => act(() => downloadUpdate())}>Download</button>` : null}
                ${st.phase === 'older' ? html`<button type="button" class="btn small" disabled=${working}
                    title="Go back to the version in the feed"
                    onClick=${() => {
                        if (window.confirm(`Install ${st.available.version} over ${st.installed}? That is a downgrade.`)) {
                            act(() => downloadUpdate({ allowDowngrade: true }));
                        }
                    }}>Install older version</button>` : null}
                ${st.ready ? html`<button type="button" class="btn small primary" disabled=${working}
                    onClick=${() => act(restartToUpdate)}>Restart to update</button>` : null}
            </div>` : null}
        </div>

        <div class="settings-row">
            <div class="settings-row-text">
                <div class="settings-row-label">This shell and the checkout</div>
                <div class="settings-row-note">${!checkout ? 'The bridge did not say what its checkout would build.'
                    : !stale ? `The shell matches the checkout’s app/ (${short(checkout.shellHash)}).`
                        : store.build && store.build.shellHash
                            ? `app/ has changed since this shell was built (${short(store.build.shellHash)} → ${short(checkout.shellHash)}). `
                                + `A build now would be ${checkout.version}.`
                            : `This shell carries no build information, so it predates the checkout’s app/. A build now would be ${checkout.version}.`}</div>
                ${release && (release.running || release.exitCode) ? html`<pre class="upd-log">${release.tail || '…'}</pre>` : null}
            </div>
            ${canBuild ? html`<div class="settings-row-ctl">
                <button type="button" class=${stale ? 'btn small primary' : 'btn small'}
                    disabled=${store.building || (release && release.running)}
                    title="npm run release:local: package the shell on the Windows side and publish it to the updates folder"
                    onClick=${() => buildUpdate()}>${store.building || (release && release.running) ? 'Building…' : 'Build update'}</button>
            </div>` : null}
        </div>

        ${has && s ? html`
        <div class="settings-row">
            <div class="settings-row-text">
                <div class="settings-row-label">Where to look${settingTip(SOURCE_NOTE)}</div>
                ${!enabled && st.disabledReason ? html`<div class="settings-row-note">${st.disabledReason}</div>` : null}
            </div>
            <div class="settings-row-ctl">
                <div class="seg" role="group" aria-label="Where to look">
                    ${[['folder', 'Folder'], ['github', 'GitHub releases'], ['off', 'Off']].map(([v, t]) => html`
                        <button key=${v} class="seg-btn" type="button" aria-pressed=${String(s.source === v)}
                            disabled=${busy} onClick=${() => act(() => setUpdateSettings({ source: v }))}>${t}</button>`)}
                </div>
            </div>
        </div>
        ${s.source === 'folder' ? html`<div class="settings-row is-wide">
            <div class="settings-row-head"><div class="settings-row-text">
                <div class="settings-row-label">Updates folder</div>
                <div class="settings-row-note">Empty uses the folder shown, which is where npm run release:local publishes.</div>
            </div></div>
            <div class="settings-row-wide">
                <input class="settings-text is-long" type="text" spellcheck="false" placeholder=${st.defaultFolder || ''}
                    value=${folder ?? s.folder}
                    onInput=${(e) => setFolder(e.target.value)} onBlur=${saveFolder} onKeyDown=${onKey(saveFolder)} />
            </div>
        </div>` : null}
        ${s.source === 'github' ? html`<div class="settings-row is-wide">
            <div class="settings-row-head"><div class="settings-row-text">
                <div class="settings-row-label">Repository</div>
                <div class="settings-row-note">owner/repo. Public releases only; the latest release needs a latest.yml beside its installer.</div>
            </div></div>
            <div class="settings-row-wide">
                <input class="settings-text is-long" type="text" spellcheck="false"
                    value=${repo ?? `${s.github.owner}/${s.github.repo}`}
                    onInput=${(e) => setRepo(e.target.value)} onBlur=${saveRepo} onKeyDown=${onKey(saveRepo)} />
            </div>
        </div>` : null}
        ${s.source !== 'off' ? html`
        ${check('Check when TGXCode starts', s.checkOnStartup, busy, (v) => act(() => setUpdateSettings({ checkOnStartup: v })))}
        <div class="settings-row">
            <div class="settings-row-text">
                <div class="settings-row-label">Check every … hours</div>
                <div class="settings-row-note">0 checks only when TGXCode starts.</div>
            </div>
            <div class="settings-row-ctl">
                <input key=${`h:${s.intervalHours}`} class="settings-num" type="number" min="0" max="168" step="1"
                    value=${s.intervalHours} disabled=${busy}
                    onChange=${(e) => act(() => setUpdateSettings({ intervalHours: Number(e.target.value) }))} />
            </div>
        </div>
        ${check('Download updates automatically', s.autoDownload, busy, (v) => act(() => setUpdateSettings({ autoDownload: v })))}
        ${check('Install when TGXCode quits', s.installOnQuit, busy, (v) => act(() => setUpdateSettings({ installOnQuit: v })),
            'A downloaded update installs as the app closes, and the next launch is the new version. '
            + 'Live sessions are unaffected: they run in the bridge, which the new window picks up.')}
        ` : null}
        ` : null}
    </section>`;
}

function check(label, value, disabled, onChange, note) {
    return html`<div class="settings-row" key=${label}>
        <div class="settings-row-text">
            <div class="settings-row-label">${label}${note ? settingTip(note) : null}</div>
        </div>
        <div class="settings-row-ctl">
            <label class="settings-check">
                <input type="checkbox" checked=${value === true} disabled=${disabled}
                    onChange=${(e) => onChange(e.target.checked)} />
                <span class="settings-box"></span>
            </label>
        </div>
    </div>`;
}
