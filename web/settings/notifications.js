// The Notifications group: the per-browser switches for web/notifications.js.
// Moved out of app.js as it was.
//
// Imports nothing from app.js.

import { dom, toast } from '../dom.js';
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

export function paintNotifyRows() {
    const perm = notifyPermission();
    const desktopOn = notify.desktop && perm === 'granted';

    // The checkbox shows what will actually happen, not what was asked for: a
    // ticked box that the browser is quietly overruling is worse than an
    // unticked one, and unticked is also what invites the click that asks.
    dom.optDesktop.checked = desktopOn;
    dom.optDesktop.disabled = perm === 'denied' || perm === 'unsupported';
    dom.optSound.checked = notify.sound;

    const stuck = perm === 'denied' ? NOTE.denied : perm === 'unsupported' ? NOTE.unsupported : '';
    dom.notifyNote.textContent = stuck || NOTE.rules;
    dom.notifyNote.className = 'settings-row-note' + (stuck ? ' is-warn' : '');
}

// Called from app.js where these listeners used to be registered, so the
// order they are added in is the order it always was.
export function wireNotifySettings() {
    dom.optDesktop.addEventListener('change', async () => {
        notify.desktop = dom.optDesktop.checked;
        localStorage.setItem('notifyDesktop', notify.desktop ? '1' : '0');
        // Asking here and nowhere else is deliberate: a permission prompt no
        // gesture invited is the one people press Block on, and some browsers
        // refuse to show it at all.
        if (notify.desktop && notifyPermission() === 'default') {
            try { await Notification.requestPermission(); } catch { /* renders as denied */ }
        }
        paintNotifyRows();
    });

    dom.optSound.addEventListener('change', () => {
        notify.sound = dom.optSound.checked;
        localStorage.setItem('notifySound', notify.sound ? '1' : '0');
        // This click is a gesture, which is what an AudioContext has been waiting
        // for if the page has not been touched yet.
        if (notify.sound) { wakeAudio(); chime('done'); }
        paintNotifyRows();
    });

    // Worth having: Focus Assist and Do Not Disturb drop notifications without a
    // word, so "did that work" is otherwise unanswerable until a turn ends.
    dom.notifyTry.addEventListener('click', () => {
        announce('TGXCode', 'This is what a finished turn will look like.', 'done', null);
        if (!notify.sound && (!notify.desktop || notifyPermission() !== 'granted')) {
            toast('Both switches are off, so nothing would fire.', 'warn');
        }
    });

    document.addEventListener('click', (e) => {
    });
}
