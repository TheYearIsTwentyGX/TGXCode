// An APK on its way to the phone: one toast per install, rewritten in place as
// the `phone_install` events arrive, rather than a stack of four for one build.
//
// The record is filed by an agent (the install_on_phone tool) and moved on by
// the TGXCode app on the phone — see bridge/phone-installs.js. Nothing here is
// kept: a window that opens half-way through simply picks the toast up at the
// next event, and the record's own history is the bridge's.
//
// The toast is built by toast() in dom.js and edited by hand afterwards, which
// is fine there and would not be under Preact: these nodes are `el()`'s.

import { post } from './api.js';
import { toast } from './dom.js';

/** id → {node, timer} for the toasts still up. */
const open = new Map();

/** How long a toast stays once nothing more is expected, by state. */
const LINGER_MS = { installed: 6000, failed: 12000, cancelled: 4000, needs_action: 15000 };
/** And while the phone is still working — long enough to see it move. */
const WORKING_MS = 20000;

function name(r) {
    if (r.packageName) return `${r.packageName}${r.versionName ? ` ${r.versionName}` : ''}`;
    return r.label || r.fileName;
}

function describe(r) {
    switch (r.state) {
    case 'pending': return [`Queued for the phone: ${r.label || r.fileName}`, 'info'];
    case 'downloading': return [`The phone is downloading ${r.label || r.fileName}…`, 'info'];
    case 'installing': return [`Installing ${name(r)} on the phone…`, 'info'];
    case 'needs_action': return [`${name(r)}: tap Install on the phone`, 'warn'];
    case 'installed': return [`Installed ${name(r)} on the phone`, 'ok'];
    case 'failed':
        return [`Phone install failed: ${name(r)}${r.message ? ` — ${r.message}` : ''}`, 'error'];
    case 'cancelled':
        return [`Phone install cancelled: ${name(r)}${r.message ? ` — ${r.message}` : ''}`, 'info'];
    default: return [`${name(r)}: ${r.state}`, 'info'];
    }
}

function dismiss(id) {
    const t = open.get(id);
    if (!t) return;
    clearTimeout(t.timer);
    open.delete(id);
    const close = t.node.querySelector('.toast-close');
    if (close && t.node.isConnected) close.click();
}

export function applyPhoneInstall(r) {
    const [text, kind] = describe(r);
    let t = open.get(r.id);
    if (t && !t.node.isConnected) { open.delete(r.id); t = null; }

    if (!t) {
        // Cancel is offered while nothing has reached the phone's installer. The
        // toast's own timeout is pushed out of reach (setTimeout's ceiling), so
        // the timer below, reset on every event, is the one that decides.
        const cancellable = r.state === 'pending' || r.state === 'downloading';
        const node = toast(text, kind, {
            action: cancellable ? {
                label: 'Cancel',
                onClick: () => {
                    open.delete(r.id);
                    post(`/api/phone-installs/${encodeURIComponent(r.id)}/cancel`)
                        .catch(err => toast(`Could not cancel: ${err.message}`, 'error'));
                },
            } : null,
            ms: 2 ** 31 - 1,
        });
        t = { node, timer: null };
        open.set(r.id, t);
    } else {
        t.node.dataset.kind = kind;
        t.node.querySelector('.toast-text').textContent = text;
        // Too late to take it back once the phone's installer has it.
        if (r.state !== 'pending' && r.state !== 'downloading') {
            const act = t.node.querySelector('.toast-action');
            if (act) act.remove();
        }
    }

    clearTimeout(t.timer);
    t.timer = setTimeout(() => dismiss(r.id), LINGER_MS[r.state] || WORKING_MS);
}
