// Settings → Window: "Use system titlebar", the way back from the custom one.
//
// Not a row in SETTINGS' table, because it is not a key in
// `~/.tgxcode/settings.json`: a window's frame belongs to the desktop shell, it
// is read before the window exists (and so before any bridge has answered), and
// on Windows the shell cannot read the bridge's files across WSL. So the shell
// keeps it, in `shell-prefs.json` in its own profile (app/titlebar.js), and
// this card asks it over the preload. Only drawn in the desktop app — the group's
// `when` in general.js — since a browser tab has no frame to change.
//
// It takes effect on the next start. A window cannot change frames once it is
// made, and recreating it under the live sessions would be a worse surprise
// than a sentence saying "restart".

import { html, useEffect, useState } from '../vendor/preact.js';
import { settingTip } from './general.js';

const shell = () => window.claudeShell && window.claudeShell.titlebar;

/** Whether this shell can answer the card at all — older ones cannot. */
export const windowSettingsAvailable = () => {
    const s = shell();
    return !!s && typeof s.getSetting === 'function';
};

export function windowCard() {
    return html`<${WindowGroup} key="window" />`;
}

const NOTE = 'The top bar is the window’s titlebar: drag it by any blank part, or '
    + 'press a button and move. On, the window gets the system’s own titlebar back '
    + 'above the bar.';

function WindowGroup() {
    const [st, setSt] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        shell().getSetting().then(setSt).catch((e) => setError(e.message));
    }, []);

    const save = async (on) => {
        setError('');
        const r = await shell().setSystem(on).catch((e) => ({ ok: false, error: e.message }));
        if (!r || !r.ok) { setError(`Could not save: ${(r && r.error) || 'no answer'}`); return; }
        setSt({ ...st, systemTitlebar: on });
    };

    const running = st ? (st.custom ? 'custom' : 'system') : null;
    const wanted = st && !st.forcedByEnv ? (st.systemTitlebar ? 'system' : 'custom') : running;
    const note = !st ? null
        : st.forcedByEnv ? 'TGXCODE_SYSTEM_TITLEBAR is set, so this window has the system titlebar '
            + 'whatever is chosen here.'
            : wanted !== running ? 'Takes effect when you restart TGXCode.' : null;

    return html`<section class="settings-group" id="set-g-window">
        <h2 class="settings-group-title">Window</h2>
        <div class="settings-row">
            <div class="settings-row-text">
                <div class="settings-row-label">Use system titlebar${settingTip(NOTE)}</div>
                <div class="settings-row-note settings-desc">${NOTE}</div>
                ${note ? html`<div class="settings-row-note">${note}</div>` : null}
                ${error ? html`<div class="settings-row-note is-warn">${error}</div>` : null}
            </div>
            <div class="settings-row-ctl">
                <label class="settings-check">
                    <input type="checkbox" checked=${!!st && st.systemTitlebar === true}
                        disabled=${!st} onChange=${(e) => save(e.target.checked)} />
                    <span class="settings-box"></span>
                </label>
            </div>
        </div>
    </section>`;
}
