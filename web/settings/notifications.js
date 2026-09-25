// The Notifications group: the per-browser switches for web/notifications.js.
//
// A Preact component, drawn into the Settings body by renderSettings like the
// groups built from rows. It used to be markup in web/index.html with three
// listeners wired at load and a painter that wrote `checked` and `textContent`
// into it after every redraw; now the markup is here and what it shows is read
// off `notify` each time it draws.
//
// Imports nothing from app.js.

import { html, useState } from '../vendor/preact.js';
import { toast } from '../dom.js';
import { announce, chime, notify, notifyPermission, wakeAudio } from '../notifications.js';

// ── notification settings ────────────────────────────────────────────────
//
// These were a popover under a bell in the bar. The bell is gone: it was two
// things at once — a switch and a status light — and the switch belongs with
// every other switch. What went with it is the at-a-glance reading of whether
// anything would fire at all, which is now only visible here; the note below
// still says what the rules are, and `Try it` still answers "did that work".
//
// Per-browser, and deliberately not moved into `~/.tgxcode/settings.json` with
// the rest of the settings page. Whether a notification *can* fire is something
// each browser decides — a permission granted in Chrome says nothing about the
// Electron shell — so a shared preference would show ticked on one surface and
// be silently overruled on another. The group says "this browser only" out loud
// rather than leaving that to be discovered.

const NOTE = {
    unsupported: 'This browser has no desktop notifications, so the sound is all '
        + 'there is here.',
    denied: 'The browser is blocking notifications for this page. Allow them in '
        + 'its site settings and this will come back.',
    rules: 'A plan, a question or a permission always speaks up — the turn is '
        + 'stopped until you answer. A turn finishing only does if it ran over '
        + '30 seconds. Never for the session already in front of you.',
};

/** The group, as a vnode for renderSettings. */
export function notifyCard() {
    return html`<${NotifyGroup} key="notify" />`;
}

/**
 * What it reads lives in `notify` and in the browser's permission, neither of
 * which is state anything redraws on, so the component redraws itself after
 * each change it makes. The rest of the time it is redrawn with the panel.
 */
function NotifyGroup() {
    const [, redraw] = useState(0);
    const again = () => redraw(n => n + 1);

    const perm = notifyPermission();
    // The checkbox shows what will actually happen, not what was asked for: a
    // ticked box that the browser is quietly overruling is worse than an
    // unticked one, and unticked is also what invites the click that asks.
    // Controlled, and Preact compares `checked` with the DOM, so a click the
    // browser then refused is put back by the redraw.
    const desktopOn = notify.desktop && perm === 'granted';
    const stuck = perm === 'denied' ? NOTE.denied : perm === 'unsupported' ? NOTE.unsupported : '';

    const onDesktop = async (e) => {
        notify.desktop = e.target.checked;
        localStorage.setItem('notifyDesktop', notify.desktop ? '1' : '0');
        // Asking here and nowhere else is deliberate: a permission prompt no
        // gesture invited is the one people press Block on, and some browsers
        // refuse to show it at all.
        if (notify.desktop && notifyPermission() === 'default') {
            try { await Notification.requestPermission(); } catch { /* renders as denied */ }
        }
        again();
    };
    const onSound = (e) => {
        notify.sound = e.target.checked;
        localStorage.setItem('notifySound', notify.sound ? '1' : '0');
        // This click is a gesture, which is what an AudioContext has been waiting
        // for if the page has not been touched yet.
        if (notify.sound) { wakeAudio(); chime('done'); }
        again();
    };
    // Worth having: Focus Assist and Do Not Disturb drop notifications without a
    // word, so "did that work" is otherwise unanswerable until a turn ends.
    const onTry = () => {
        announce('TGXCode', 'This is what a finished turn will look like.', 'done', null);
        if (!notify.sound && (!notify.desktop || notifyPermission() !== 'granted')) {
            toast('Both switches are off, so nothing would fire.', 'warn');
        }
    };

    // htm trims whitespace that holds a newline where text meets a tag, so the
    // space after </strong> below has to stay on its line.
    return html`<section id="set-g-notify" class="settings-group">
        <h2 class="settings-group-title">Notifications</h2>
        <p class="settings-group-note">What reaches you when this window is
            not the thing you are looking at. <strong>This browser only</strong> — unlike
            everything above, these live in its own storage rather than in the
            settings file, because whether a notification can fire at all is
            something each browser decides for itself.</p>

        <div class="settings-row">
            <div class="settings-row-text">
                <div class="settings-row-label">Show a desktop notification</div>
                <div class="settings-row-note">Ticking this is what asks the
                    browser for permission — nothing else does, because a prompt
                    no gesture invited is the one people press Block on.</div>
            </div>
            <div class="settings-row-ctl">
                <label class="settings-check">
                    <input id="opt-desktop" type="checkbox" checked=${desktopOn}
                        disabled=${perm === 'denied' || perm === 'unsupported'}
                        onChange=${onDesktop} />
                    <span class="settings-box"></span>
                </label>
            </div>
        </div>

        <div class="settings-row">
            <div class="settings-row-text">
                <div class="settings-row-label">Play a sound</div>
                <div class="settings-row-note">A short chime, synthesised in the
                    page rather than fetched.</div>
            </div>
            <div class="settings-row-ctl">
                <label class="settings-check">
                    <input id="opt-sound" type="checkbox" checked=${notify.sound}
                        onChange=${onSound} />
                    <span class="settings-box"></span>
                </label>
            </div>
        </div>

        <div class="settings-row">
            <div class="settings-row-text">
                <div class="settings-row-label">When one fires</div>
                <div id="notify-note" class=${'settings-row-note' + (stuck ? ' is-warn' : '')}
                    >${stuck || NOTE.rules}</div>
            </div>
            <div class="settings-row-ctl">
                <button id="notify-try" class="btn" type="button" onClick=${onTry}>Try it</button>
            </div>
        </div>
    </section>`;
}
