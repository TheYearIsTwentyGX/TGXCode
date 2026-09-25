// The quota pill and the Claude Code version pill, and the popovers under
// them: how much of the 5-hour window and the week are gone, and whether the
// installed `claude` is behind. Moved out of app.js as it was; the bridge side
// is bridge/usage.js and bridge/claude-version.js.
//
// `loadQuota` and `loadCv` are called by connect() in app.js on every
// reconnect, and the `apply*` pair by the event stream, so those names are
// the module's contract with the streaming code.
//
// This imports the menus it closes when it opens, `openSession` and friends from app.js, which imports this — safe because
// nothing here reads an app.js binding at module top level, only when a
// function is called.

import { get, post } from './api.js';
import { state } from './state.js';
import { dom, el, toast } from './dom.js';
import { pad, shortPath } from './format.js';
import { pullAndRestart } from './restart.js';
import { showNewMenu } from './app.js';
import { openSession, renderHeader } from './transcript/conversation.js';
import { openContextMenu } from './transcript/context-menu.js';
import { showBarMore } from './settings/toolbar.js';

// ── quota ────────────────────────────────────────────────────────────────
//
// How much of the 5-hour window and the week are gone. Two sources feed the
// snapshot this draws — see bridge/usage.js — and the thing to keep in mind
// here is that **the percentage can be old**. It comes from the status line,
// which only renders in an interactive terminal, so a day spent entirely inside
// this app leaves the number frozen while the stream keeps `status` and
// `resetsAt` current.
//
// So nothing in here shows a bare percentage. Every reading is drawn with its
// age, and a reading past STALE_AFTER goes grey and says so in words. An old
// number presented as current is the one outcome worse than no number, because
// it is the one somebody would plan an afternoon around.

// Past this, the number is presented as a last-known reading rather than as the
// state of the account. Half an hour: long enough that a terminal open in the
// background keeps the pill live, short enough that a stale reading cannot
// quietly survive a working session.
const QUOTA_STALE_AFTER = 30 * 60;

const quota = {
    snap: null,
    // Client clock at the moment `snap` was taken, so ages and countdowns can
    // advance without refetching and without trusting the two clocks to agree.
    at: 0,
    timer: null,
    // The one-second countdown, live only while something is actually counting
    // down. Separate from `timer` because it rewrites text and nothing else —
    // see tickQuotaClocks for why it must not be a faster renderQuota.
    tick: null,
    // The reset we have already refetched for, so a countdown that lands on
    // zero asks the bridge once rather than once a second.
    awaitedReset: 0,
    // A manual refresh is in flight. Held here rather than read off
    // `snap.beacon.running` because the snapshot is only as current as the last
    // fetch, and the button has to change the instant it is pressed.
    refreshing: false,
    // Why the last manual refresh could not be started at all — a 409, not a
    // beacon that ran and failed. That one reports itself through
    // `beacon.reason`, which the panel already draws.
    refreshError: null,
    // The handle that takes the flash back off the pill. Held so that two
    // windows going bad moments apart cannot leave the first one's timer
    // stripping the second one's highlight.
    flashTimer: null,
};

/** Seconds since the snapshot was taken, on this window's clock. */
function quotaDrift() {
    return quota.at ? Math.max(0, (Date.now() - quota.at) / 1000) : 0;
}

/** Age of a server-stamped reading, in seconds, or null if it has no stamp. */
function quotaAge(at) {
    if (!quota.snap || typeof at !== 'number') return null;
    return Math.max(0, (quota.snap.now - at) + quotaDrift());
}

/** Age of a reading, in words. Carries the same rounding trap as fmtLeft:
 *  bucketing on the raw seconds while rounding to minutes prints "60m ago". */
function fmtAge(seconds) {
    if (seconds === null) return '';
    if (seconds < 90) return 'just now';
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(seconds / 3600);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
}

/**
 * Time until a reset, phrased as a wait rather than a clock time.
 *
 * **Every pair of units comes out of one rounded total**, which is the whole
 * trick. The obvious way — floor the hours, round the leftover minutes — prints
 * "3h 60m" at three hours fifty-nine and a half, because the two units are
 * decided independently and nothing reconciles them. Same shape of bug gives
 * "1d 24h", and "60m 00s" one second under the hour. Round once to the smaller
 * unit, then divide.
 *
 * Seconds are only shown inside the last hour. Above that they would be a
 * flickering digit on a number nobody is watching that closely; below it, the
 * countdown is the thing being watched, which is why tickQuotaClocks exists.
 */
function fmtLeft(resetsAt) {
    if (!quota.snap || typeof resetsAt !== 'number') return '';
    const s = resetsAt - (quota.snap.now + quotaDrift());
    if (s <= 0) return 'due now';

    // Whole seconds first, and everything below buckets on this rather than on
    // `s`: ceil(3599.5) is 3600, which has to read "1h" and not "60m 00s".
    const total = Math.ceil(s);
    if (total < 60) return `${total}s`;
    if (total < 3600) return `${Math.floor(total / 60)}m ${pad(total % 60)}s`;

    // An hour and up, in minutes. No `mins < 60` case to handle — the seconds
    // path above owns everything under the hour.
    const mins = Math.round(total / 60);
    const hours = Math.floor(mins / 60);
    const restMins = mins % 60;
    if (hours < 24) return restMins ? `${hours}h ${restMins}m` : `${hours}h`;

    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

function quotaBar(pct, stale) {
    // A window with no percentage draws no bar at all rather than an empty one:
    // an empty bar reads as zero used, which is a very different claim from
    // "nobody has told us".
    if (pct === null) return null;
    return el('span', { class: 'q-bar' },
        el('i', { style: `width:${Math.max(stale ? 0 : 2, Math.min(100, pct))}%` }));
}

/** The pill: one compact group per window, worst first is not needed — the
 *  server already orders them 5-hour then weekly, which is how people ask. */
function renderQuotaPill() {
    const body = dom.quotaPillBody;
    body.textContent = '';

    const windows = (quota.snap && quota.snap.windows) || [];
    const shown = windows.filter(w => w.usedPercent !== null || w.status);
    if (!shown.length) {
        // The restart row lives in this popover now, so a local window keeps the
        // pill even with nothing to report — hiding it would hide the only way
        // to restart the bridge from the UI, and a machine with the beacon off
        // or no trusted directory never gets a reading at all. A remote caller
        // cannot restart anything, so for them an empty pill is still empty.
        dom.quotaWrap.hidden = state.remote;
        // The same label-then-number shape a window gets below, so an empty pill
        // reads as "quota: nothing yet" rather than as a stray mark in the bar.
        // The dash is already this file's word for a window with no percentage.
        body.append(el('span', { class: 'q-win' },
            el('span', { class: 'q-label', text: 'Quota' }),
            el('span', { class: 'q-num', text: '—' })));
        dom.quotaPill.title = 'No quota reading yet';
        dom.quotaPill.setAttribute('aria-label', 'No quota reading yet. Bridge controls');
        return;
    }
    dom.quotaWrap.hidden = false;

    const titles = [];
    for (const w of shown) {
        const age = quotaAge(w.usedPercentAt);
        const stale = age !== null && age > QUOTA_STALE_AFTER;
        const pct = w.usedPercent;

        const group = el('span', {
            class: 'q-win' + (stale ? ' stale' : ''),
            'data-status': w.status || '',
        }, el('span', { class: 'q-label', text: w.shortLabel }));

        const bar = quotaBar(pct, stale);
        if (bar) group.append(bar);
        group.append(el('span', {
            class: 'q-num',
            text: pct === null ? '—' : `${Math.round(pct)}%`,
        }));
        body.append(group);

        titles.push(pct === null
            ? `${w.label}: no reading yet`
            : `${w.label}: ${Math.round(pct)}% used${age === null ? '' : ` (${fmtAge(age)})`}`);
        if (typeof w.resetsAt === 'number') {
            titles[titles.length - 1] += `, resets in ${fmtLeft(w.resetsAt)}`;
        }
        // The word the flash was about, so hovering the pill still explains it
        // once the highlight has faded — and so the accessible name carries it
        // for somebody who never saw the highlight at all.
        if (w.status && w.status !== 'allowed') {
            titles[titles.length - 1] += w.status === 'rejected'
                ? ' — limit reached' : ' — nearly spent';
        }
    }

    // When the window comes back. The percentage says whether to worry; this
    // says whether to wait, and it is the half you plan an afternoon around.
    //
    // The first window that has one, rather than a hardcoded `five_hour`: the
    // bridge orders the 5-hour window first, so that is what this is in
    // practice, but a machine that only ever reports a weekly window still gets
    // a countdown instead of nothing.
    const clock = shown.find(w => typeof w.resetsAt === 'number');
    if (clock) {
        // `html` rather than child elements: el() namespaces an <svg> tag but
        // builds its children with createElement, which yields unknown HTML
        // nodes that never draw. innerHTML on an SVG element parses in the
        // right namespace, so the shape stays declarative and no helper is
        // needed for the one icon this file draws.
        body.append(el('span', { class: 'q-reset', title: `${clock.label} resets` },
            el('svg', {
                width: '11', height: '11', viewBox: '0 0 24 24', fill: 'none',
                'aria-hidden': 'true',
                html: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>'
                    + '<path d="M12 7v5.2l3.4 2" stroke="currentColor" stroke-width="2"'
                    + ' stroke-linecap="round" stroke-linejoin="round"/>',
            }),
            // data-resets-at is what tickQuotaClocks finds. It carries the
            // timestamp rather than the rendered text, so the tick needs to
            // know nothing about the shape of a snapshot.
            el('span', { 'data-resets-at': String(clock.resetsAt), text: fmtLeft(clock.resetsAt) })));
    }

    const summary = titles.join(' · ');
    dom.quotaPill.title = summary;
    // The button's own text is "5h 98% 12m", which is a fine glance and a poor
    // accessible name, and `title` is only a fallback accname that browsers
    // disagree about using. Set here rather than once in the HTML because this
    // function re-runs every 30 seconds on quota.timer, and a name fixed at load
    // is a name that goes stale.
    dom.quotaPill.setAttribute('aria-label', `Quota used. ${summary}`);
}

function renderQuotaPanel() {
    const rows = dom.quotaWindows;
    rows.textContent = '';

    const windows = (quota.snap && quota.snap.windows) || [];
    for (const w of windows) {
        const age = quotaAge(w.usedPercentAt);
        const stale = age !== null && age > QUOTA_STALE_AFTER;
        const pct = w.usedPercent;

        const row = el('div', { class: 'q-row' + (stale ? ' stale' : '') });
        row.append(el('div', { class: 'q-row-top' },
            el('span', { text: w.label }),
            el('span', { class: 'q-pct', text: pct === null ? 'no reading' : `${pct.toFixed(1)}%` })));

        const bar = quotaBar(pct, stale);
        if (bar) {
            const holder = el('span', { class: 'q-win', 'data-status': w.status || '' }, bar);
            row.append(holder);
        }

        // Left: where the number came from and when. Right: the reset, which is
        // the other half of the question and comes from the stream, so it stays
        // current even when the percentage does not.
        const left = pct === null
            ? (w.status ? 'status only — no percentage sent' : 'not observed yet')
            : `${w.usedPercentSource === 'stream' ? 'from a turn' : 'from the status line'}, ${fmtAge(age)}`;

        const sub = el('div', { class: 'q-row-sub' },
            el('span', { class: stale ? 'warn' : '', text: left }));

        // The reset gets an element of its own rather than being joined into
        // one string: tickQuotaClocks rewrites its text every second, and it
        // cannot do that to a span that also holds the overage note.
        const right = el('span', {
            class: w.status === 'rejected' ? 'bad' : w.status === 'allowed_warning' ? 'warn' : '',
        });
        if (w.resetsAt) {
            right.append('resets in ',
                el('span', { 'data-resets-at': String(w.resetsAt), text: fmtLeft(w.resetsAt) }));
        }
        if (w.isUsingOverage) right.append(w.resetsAt ? ' · on overage' : 'on overage');
        sub.append(right);
        row.append(sub);
        rows.append(row);
    }

    if (!windows.length) {
        rows.append(el('div', { class: 'q-row-sub' },
            el('span', { text: 'Nothing observed yet. A turn or an open terminal will fill this in.' })));
    }

    // The history. Only status changes are kept, so this is short by
    // construction and empty most of the time.
    const evs = dom.quotaEvents;
    evs.textContent = '';
    const events = (quota.snap && quota.snap.events) || [];
    if (events.length) {
        evs.append(el('div', { class: 'q-ev-head', text: 'Limit events' }));
        for (const ev of events.slice(0, 6)) {
            const when = fmtAge(quotaAge(ev.at));
            const what = ev.from ? `${ev.from} → ${ev.to}` : ev.to;
            evs.append(el('div', { text: `${ev.label}: ${what.replace(/_/g, ' ')} · ${when}` }));
        }
    }

    // And the one thing the user can act on.
    const note = dom.quotaNote;
    note.textContent = '';
    const sl = quota.snap && quota.snap.statusLine;
    const bc = quota.snap && quota.snap.beacon;

    if (sl && !sl.present) {
        note.append(el('div', { text: 'Percentages come from the Claude Code status line, which only runs in a terminal. To turn it on:' }));
        note.append(el('code', { text: 'node scripts/install-quota-statusline.js' }));
    } else if (sl && sl.present) {
        note.append(el('div', {
            text: `Last harvested from the status line ${fmtAge(quotaAge(sl.capturedAt))}.`,
        }));
    }

    // Why the number is or is not moving. Without this a stale reading is
    // unexplained, which is the failure this whole feature is arranged against
    // — the pill can say a number is old, but only the beacon knows why.
    if (!bc) return;

    // The button was pressed and could not even start. Above the rest, because
    // it is about the thing the user just did.
    if (quota.refreshError) {
        note.append(el('div', { class: 'warn', text: `Refresh: ${quota.refreshError}` }));
    }

    if (!bc.dir) {
        note.append(el('div', {
            text: 'Refreshing it without a terminal open needs the quota beacon: '
                + 'set quota.beacon and quota.beaconDir in ~/.tgxcode/settings.json. '
                + 'Open Claude Code in that directory yourself once first — the beacon '
                + 'will not answer the trust prompt.',
        }));
        return;
    }

    // A directory is set but the timer is off. Refresh still works — it is the
    // timer that flag governs — so say that rather than repeating the setup
    // instructions at somebody who has already followed them.
    if (!bc.enabled) {
        note.append(el('div', {
            text: `Automatic refresh is off (quota.beacon), so the percentage only `
                + `moves while a terminal is open — or when you press Refresh, which `
                + `runs it once in ${bc.dir}.`,
        }));
        return;
    }

    // On, but not on this bridge. Worth saying rather than showing a last-run
    // age that will never move: on a dev window the beacon is the everyday
    // instance's job, and the reading here is whatever that one last harvested.
    if (bc.suppressed === 'dev-bridge') {
        note.append(el('div', {
            text: 'Automatic refresh is off on a dev bridge — the everyday instance '
                + 'runs the clock. The percentages here are whatever it last '
                + 'harvested, and Refresh still works if you want one now.',
        }));
        return;
    }

    const every = bc.everyMinutes ? `every ${bc.everyMinutes}m` : '';
    if (bc.running) {
        note.append(el('div', { text: `Beacon running now in ${bc.dir}.` }));
    } else if (bc.ok === false) {
        // The interesting case: it is on, and not working. Say which directory
        // and what went wrong, because the usual cause is a dialog waiting in a
        // TUI nobody can see.
        note.append(el('div', { class: 'warn', text: `Beacon failing — ${bc.reason}` }));
        // `probed` splits the two failures that used to look identical, and the
        // user's next move is different for each: a run that never rendered is
        // sitting behind a dialog they have to go and answer, while one that
        // rendered and got no percentage is the CLI's own quota probe not
        // firing, which no amount of clicking here will fix.
        note.append(el('div', {
            text: bc.probed
                ? 'It started fine — the CLI just never produced a percentage. '
                    + 'Nothing to answer; the reading below stands until it does.'
                : 'It never got as far as drawing a status line. Open Claude Code '
                    + `in ${bc.dir} yourself and clear whatever is waiting.`,
        }));
        if (bc.screen) note.append(el('code', { text: bc.screen }));
    } else if (bc.ok) {
        note.append(el('div', {
            text: `Beacon on, ${every}, in ${bc.dir} — last run ${fmtAge(quotaAge(bc.at))}`
                + `${typeof bc.ms === 'number' ? ` (${(bc.ms / 1000).toFixed(1)}s)` : ''}.`,
        }));
    } else {
        note.append(el('div', { text: `Beacon on, ${every}, in ${bc.dir} — not run yet.` }));
    }
}

/**
 * The Refresh button's label and whether it can be pressed.
 *
 * Enabled on `beacon.dir` alone, not on `beacon.enabled` — that flag is the
 * *automatic* twenty-minute clock, and a machine with a trusted directory and
 * the timer switched off is exactly the one where pressing this is the point.
 */
function renderQuotaRefresh() {
    const btn = dom.quotaRefresh;
    const bc = (quota.snap && quota.snap.beacon) || null;
    const dir = bc && bc.dir;
    // `running` from the server covers a run the *timer* started, which this
    // window did not press and must still not double.
    const busy = quota.refreshing || !!(bc && bc.running);

    btn.textContent = busy ? 'Refreshing…' : 'Refresh';
    btn.classList.toggle('busy', busy);
    btn.disabled = busy || !dir;
    btn.title = !dir
        ? 'Needs a directory to run in — see below'
        : busy
            ? 'Reading the current percentage'
            : `Start a few-second Claude session in ${dir} just to read the percentage`;
}

/**
 * The restart row's label, and whether it can be pressed.
 *
 * `busy` comes off the class rather than a flag of its own so that
 * pullAndRestart's existing classList calls stay the single record of a restart
 * in progress — there is exactly one place that knows, and this reads it.
 */
export function renderQuotaRestart() {
    const btn = dom.quotaRestart;
    btn.hidden = state.remote;
    const busy = btn.classList.contains('busy');

    dom.quotaRestartLabel.textContent = busy ? 'Restarting…' : 'Restart bridge';
    dom.quotaRestartSub.textContent = busy
        ? 'Waiting for the replacement to answer'
        // shortPath rather than the raw checkout: this popover is 306px wide,
        // and every path on this machine opens with the same 18 characters.
        : `Pull and restart ${state.root ? shortPath(state.root) : 'this bridge'}`;
    btn.title = busy
        ? 'Waiting for a bridge with a different pid to answer'
        : 'Fast-forward the checkout this bridge is serving, then restart it';
}

export function renderQuota() {
    renderQuotaPill();
    renderQuotaRefresh();
    renderQuotaRestart();
    if (!dom.quotaMenu.hidden) renderQuotaPanel();
    syncQuotaClock();
}

/** Seconds left on a reset, on the server's clock corrected for drift. */
function quotaLeft(resetsAt) {
    return resetsAt - (quota.snap.now + quotaDrift());
}

/**
 * Every countdown currently on screen, pill and panel alike.
 *
 * The panel only counts while it is open. Closing it hides #quota-menu without
 * emptying it, so its rows are still in the document — ticking them would keep
 * the interval alive over text nobody can see, and worse, would keep it alive
 * after the pill's own countdown had run out. Reopening rebuilds the rows, so
 * nothing stale is ever shown.
 */
function quotaClockNodes() {
    const nodes = [...dom.quotaPillBody.querySelectorAll('[data-resets-at]')];
    if (!dom.quotaMenu.hidden) nodes.push(...dom.quotaWindows.querySelectorAll('[data-resets-at]'));
    return nodes;
}

/**
 * Move every countdown on the pill and in the panel.
 *
 * **Text only, on purpose.** The obvious implementation of a per-second
 * countdown is renderQuota on a one-second interval, and that is wrong twice
 * over: renderQuotaPill empties #quota-pill-body and rebuilds it, so anything
 * decorating a window group would be destroyed roughly once a second, and it
 * redraws two bars and a whole panel to move one digit. Shaped after
 * tickCardClocks instead — find the marked nodes, rewrite their text, touch
 * nothing else.
 *
 * `title` and `aria-label` are deliberately left to the thirty-second repaint.
 * They are the pill's accessible name, and a name that changes every second is
 * announced as a name that changes every second.
 */
function tickQuotaClocks() {
    if (!quota.snap) return stopQuotaClock();

    let counting = false;
    let last = 0;
    for (const n of quotaClockNodes()) {
        const at = Number(n.dataset.resetsAt);
        n.textContent = fmtLeft(at);
        if (quotaLeft(at) > 0) counting = true;
        last = at;
    }
    if (counting || !last) return;

    // Everything on screen has run out. Stop, and ask once for a snapshot that
    // knows what comes next: the bridge drops a window whose reset has passed
    // (bridge/usage.js), so without this the pill sits on "due now" until some
    // unrelated turn happens to push one. Guarded by the timestamp rather than
    // by a bare flag, so a fetch that changes nothing cannot become a poll.
    stopQuotaClock();
    if (quota.awaitedReset !== last) {
        quota.awaitedReset = last;
        loadQuota();
    }
}

function stopQuotaClock() {
    clearInterval(quota.tick);
    quota.tick = null;
}

/**
 * Run the tick only while a reset is actually approaching.
 *
 * Called from renderQuota, which covers every way the marked nodes can change:
 * a snapshot arriving, the panel opening, and the thirty-second repaint. So the
 * interval is never left running over a pill with no countdown in it, and it
 * starts the moment the first reset time is picked up.
 */
function syncQuotaClock() {
    const live = !!quota.snap
        && quotaClockNodes().some(n => quotaLeft(Number(n.dataset.resetsAt)) > 0);
    if (live) {
        if (!quota.tick) quota.tick = setInterval(tickQuotaClocks, 1000);
    } else if (quota.tick) {
        stopQuotaClock();
    }
}

/**
 * How bad a window's status is, as a number worth comparing.
 *
 * A missing status is 0 rather than "unknown": a window nobody has reported on
 * is not a complaint, and renderQuotaPill already draws it without a colour. An
 * unrecognised string sorts as a warning rather than as fine — a status this app
 * has never heard of is not something to stay quiet about, and the CLI has added
 * to this vocabulary before.
 */
const QUOTA_RANK = { allowed: 0, allowed_warning: 1, rejected: 2 };
function quotaRank(status) {
    if (!status) return 0;
    const r = QUOTA_RANK[status];
    return r === undefined ? 1 : r;
}

/**
 * One quota snapshot, applied. The only place `quota.snap` should ever be set.
 *
 * Funnelled because there are three sources — the SSE push, the reconnect reload
 * and the Refresh button — and a flash that fires from one of them and not the
 * others is a notification whose presence depends on how the snapshot happened
 * to arrive.
 *
 * **The render has to come before the flash, not after.** `.quota-wrap[hidden]`
 * sets `display: none`, and a CSS animation added to a `display: none` subtree
 * never runs at all. renderQuota() is what takes the wrap out of hidden when the
 * first reading for a window lands — which is exactly the case a rate limit
 * arrives in.
 */
export function applyQuotaSnapshot(next) {
    const before = quota.snap;
    quota.snap = next;
    quota.at = Date.now();
    renderQuota();
    quotaFlash(before, next);
}

/**
 * A window's status got worse — say so on the pill.
 *
 * This replaced a toast. `bridge/runner.js` emits a `notice` for a rate limit on
 * every turn for as long as the limit holds, so the toast was the same sentence
 * three times an hour, over the composer, about something already drawn in
 * colour in the header. What the pill was missing was not information; it was
 * something that moves when the state gets worse.
 *
 * Shaped after claudeFlash(): a before/after diff that points at the thing that
 * moved, rather than a second idea about what "this just changed" looks like.
 *
 * **Per window, not worst-overall.** With the 5-hour window already `rejected`
 * and the weekly one going `allowed` -> `rejected`, the worst status is
 * `rejected` on both sides — a worst-only compare says nothing about a second
 * window falling over, which is the moment somebody most needs telling.
 *
 * **A null `before` never flashes.** A cold start with a limit already in force
 * renders a red pill and stays quiet: nothing just happened, and a page load is
 * not news. It does mean a reconnect flashes for anything that worsened while
 * the stream was down, which is the point — loadQuota() runs on `open` for
 * exactly that catch-up.
 *
 * There is no repeat suppression here and none is needed. bridge/server.js only
 * broadcasts `quota` when usage.noteRateLimitEvent says a reading moved, and a
 * reading that moved without a status change raises no rank. Two gates, neither
 * of which is a timer somebody has to tune.
 */
function quotaFlash(before, after) {
    if (!before || !after) return;

    const was = new Map((before.windows || []).map(w => [w.type, quotaRank(w.status)]));
    let worst = 0;
    let which = null;
    for (const w of (after.windows || [])) {
        const now = quotaRank(w.status);
        // A type never seen before, arriving already bad, counts as a rise from
        // fine — which is why the fallback is 0 rather than `now`.
        if (now <= (was.has(w.type) ? was.get(w.type) : 0)) continue;
        if (now > worst) { worst = now; which = w; }
    }
    if (!worst) return;

    const said = `${which.label} quota ${worst >= 2 ? 'limit reached' : 'nearly spent'}.`;

    // No window data means no pill on screen, and a flash nobody can see is not
    // a notification. This is the one case that still earns the toast the rest
    // of this replaced. It should be unreachable — a rate_limit_event always
    // carries a status, and renderQuotaPill shows the wrap for a status alone —
    // but the failure mode without it is silence, which is the thing this
    // feature exists to avoid.
    if (dom.quotaWrap.hidden) { toast(said, 'warn', 7000); return; }

    // #toasts was the aria-live region and is no longer in this path, so the
    // flash would otherwise announce nothing at all.
    dom.quotaLive.textContent = said;

    const pill = dom.quotaPill;
    pill.dataset.flash = worst >= 2 ? 'bad' : 'warn';
    pill.classList.remove('q-flash');
    void pill.offsetWidth;      // restart it when a second window goes moments later
    pill.classList.add('q-flash');
    clearTimeout(quota.flashTimer);
    // Three 0.7s pulses. Removing the class is also what ends the reduced-motion
    // treatment, which holds the tint rather than animating it.
    quota.flashTimer = setTimeout(() => {
        pill.classList.remove('q-flash');
        delete pill.dataset.flash;
    }, 2100);
}

/**
 * Refresh the percentage now.
 *
 * The bridge answers with the whole quota payload rather than an
 * acknowledgement, so one round trip both runs the beacon and returns what it
 * produced — including the reason when a run was blocked by a dialog, which is
 * the case worth seeing.
 */
async function refreshQuotaNow() {
    if (quota.refreshing) return;
    quota.refreshing = true;
    quota.refreshError = null;
    renderQuota();
    try {
        const out = await post('/api/quota/refresh');
        // The beacon only ever moves `usedPercent` and the harvest stamp —
        // `status` is stream-only (bridge/usage.js) — so pressing Refresh cannot
        // flash the pill. It goes through the funnel anyway rather than relying
        // on that staying true.
        if (out && out.quota) applyQuotaSnapshot(out.quota);
    } catch (err) {
        // A 409: not set up, or a run already going. Both are worth a line in
        // the panel and neither is worth a toast — the user is looking straight
        // at the thing they just pressed.
        quota.refreshError = err.message;
    } finally {
        quota.refreshing = false;
        renderQuota();
    }
}

export function showQuota(on) {
    dom.quotaMenu.hidden = !on;
    dom.quotaPill.setAttribute('aria-expanded', String(on));
    // The two popovers must not sit open together, and each one's outside-click
    // listener is stopped by the other's trigger. There were three of these
    // until the bell's went into the settings page.
    // syncQuotaClock as well as the render: the panel can hold a countdown the
    // pill does not draw — the pill only clocks a window that has a percentage
    // or a status — so opening it is one of the ways a first reset time reaches
    // the screen, and closing it is one of the ways the last one leaves.
    if (on) { renderQuotaPanel(); showNewMenu(false); showBarMore(false); showCv(false); }
    syncQuotaClock();
}

export async function loadQuota() {
    try {
        applyQuotaSnapshot(await get('/api/quota'));
    } catch {
        // A bridge without the route, or one that is down. The pill simply does
        // not appear; there is nothing here worth a toast.
    }
}

dom.quotaRefresh.addEventListener('click', (e) => {
    // The pill's own handler toggles the popover, and this button lives inside
    // it — without this the popover would shut on the click that asked for a
    // reading, hiding the result.
    e.stopPropagation();
    refreshQuotaNow();
});

dom.quotaRestart.addEventListener('click', (e) => {
    // Same reason as Refresh above: this button is inside the popover, and
    // without this the pill's toggle and the document listener would shut it on
    // the click that asked for a restart — taking the busy label with it.
    e.stopPropagation();
    pullAndRestart();
});

dom.quotaPill.addEventListener('click', (e) => {
    e.stopPropagation();
    showQuota(dom.quotaMenu.hidden);
});

document.addEventListener('click', (e) => {
    if (!dom.quotaMenu.hidden && !e.target.closest('#quota-wrap')) showQuota(false);
    if (!dom.cvMenu.hidden && !e.target.closest('#cv-wrap')) showCv(false);
});

// ---------------------------------------------------------------------------
// Claude Code version
// ---------------------------------------------------------------------------
//
// The summary is the bridge's (bridge/claude-version.js): installed, newest on
// the configured channel, and which live sessions are on an older binary than
// the one installed. Three surfaces draw it — the bar badge, the Update channel
// row in settings, and the conversation header of a session that is itself on
// an old binary — and all three read `state.cv` and nothing else.

state.cv = null;
state.cvBusy = false;

const cvStale = () => (state.cv && state.cv.staleSessions) || [];

/** The stale-session entry for this id, or null. */
export const cvStaleFor = (id) => cvStale().find(x => x.id === id) || null;

export function applyCv(summary) {
    if (!summary || typeof summary !== 'object') return;
    state.cv = summary;
    renderCv();
}

export async function loadCv({ fresh = false } = {}) {
    try {
        applyCv(await get(`/api/claude-version${fresh ? '?refresh=1' : ''}`));
    } catch {
        // A bridge without the route. Nothing appears, which is the right answer.
    }
}

function renderCv() {
    const cv = state.cv;
    const stale = cvStale();
    const show = !!cv && !state.remote && (cv.behind || stale.length > 0 || cv.updating || state.cvBusy);
    dom.cvWrap.hidden = !show;
    if (!show) showCv(false);
    if (cv) {
        const text = cv.behind
            ? `Claude ↑ ${cv.latest}`
            : `${stale.length} on old Claude`;
        dom.cvPill.textContent = text;
        dom.cvPill.dataset.kind = cv.behind ? 'behind' : 'stale';
        dom.cvPill.title = cv.behind
            ? `Claude Code ${cv.installed} is installed; ${cv.latest} is the newest on ${cv.channel}`
            : `${stale.length} running ${stale.length === 1 ? 'session is' : 'sessions are'} `
                + `on an older binary than the installed ${cv.installed}`;
    }
    if (!dom.cvMenu.hidden) renderCvPanel();
    paintCvSettingsNote();
    if (state.current) renderHeader();
}

function renderCvPanel() {
    const cv = state.cv;
    if (!cv) return;
    const rows = [];
    rows.push(el('div', { class: 'q-row cv-row' },
        el('span', {}, 'Installed'), el('b', {}, cv.installed || 'unknown')));
    rows.push(el('div', { class: 'q-row cv-row' },
        el('span', {}, `Newest on ${cv.channel}`),
        el('b', {}, cv.latest || '—')));
    if (cv.error) {
        rows.push(el('div', { class: 'quota-note' },
            el('div', { class: 'warn' }, `Could not ask the registry: ${cv.error}`)));
    }
    const stale = cvStale();
    if (stale.length) {
        const byId = new Map(state.sessions.map(s => [s.sessionId, s]));
        rows.push(el('div', { class: 'q-row' },
            el('div', { class: 'cv-stale-head' },
                `Running an older binary (${stale.length})`),
            ...stale.map(x => {
                const s = byId.get(x.id);
                return el('button', {
                    class: 'cv-stale', type: 'button', title: 'Open this session',
                    onclick: (e) => { e.stopPropagation(); showCv(false); openSession(x.id); },
                }, el('span', { class: 'cv-stale-title' }, s ? s.title : x.id.slice(0, 8)),
                el('span', { class: 'cv-stale-ver' }, x.version));
            }),
            el('div', { class: 'quota-note' },
                'Each keeps the binary it started on until its process ends. '
                + 'Stop one and send it a message to move it to the installed version.')));
    }
    if (cv.lastUpdate && !cv.lastUpdate.ok) {
        rows.push(el('div', { class: 'quota-note' },
            el('div', { class: 'warn' }, 'The last update failed:'),
            el('code', {}, cv.lastUpdate.output || 'no output')));
    }
    dom.cvBody.replaceChildren(...rows);

    const busy = state.cvBusy || cv.updating;
    dom.cvUpdate.hidden = !cv.behind && !busy;
    dom.cvUpdate.disabled = busy;
    dom.cvUpdate.classList.toggle('busy', busy);
    dom.cvUpdateLabel.textContent = busy ? 'Updating…'
        : cv.latest ? `Update to ${cv.latest}` : 'Update now';
}

export function showCv(on) {
    if (on === !dom.cvMenu.hidden) return;
    dom.cvMenu.hidden = !on;
    dom.cvPill.setAttribute('aria-expanded', String(on));
    if (on) { renderCvPanel(); showQuota(false); showNewMenu(false); showBarMore(false); }
}

async function updateClaudeNow() {
    if (state.cvBusy) return;
    state.cvBusy = true;
    renderCv();
    try {
        const out = await post('/api/claude-version/update');
        applyCv(out.summary);
        if (out.ok) {
            const cv = out.summary || {};
            toast(cv.behind ? 'claude update ran, but the installed version did not move'
                : `Claude Code ${cv.installed} is installed`, cv.behind ? 'warn' : 'info');
        } else {
            toast('Claude Code could not be updated — see the version panel', 'warn');
        }
    } catch (err) {
        if (err.data && err.data.summary) applyCv(err.data.summary);
        toast(err.message || 'Claude Code could not be updated', 'warn');
    } finally {
        state.cvBusy = false;
        renderCv();
    }
}

/**
 * The Update channel row in Claude settings, which is where somebody looking for
 * "what version am I on" goes. Patched in place rather than by re-rendering the
 * settings page, which would throw away whatever is being typed there.
 */
function paintCvSettingsNote() {
    const row = document.querySelector('.settings-row[data-path="autoUpdatesChannel"] .settings-row-text');
    if (!row) return;
    const old = row.querySelector('.cv-note');
    const note = cvSettingsNote();
    if (old) old.replaceWith(note || '');
    else if (note) row.append(note);
}

export function cvSettingsNote() {
    const cv = state.cv;
    if (!cv || !cv.installed) return null;
    const busy = state.cvBusy || cv.updating;
    return el('div', { class: 'settings-row-note cv-note' },
        `Installed ${cv.installed}`,
        cv.latest ? ` · newest on this channel ${cv.latest}` : '',
        cv.behind && !state.remote
            ? el('button', {
                class: 'linkish', type: 'button', disabled: busy || null,
                onclick: updateClaudeNow,
            }, busy ? ' Updating…' : ' Update now')
            : '');
}

dom.cvPill.addEventListener('click', (e) => {
    e.stopPropagation();
    showCv(dom.cvMenu.hidden);
});
/**
 * The release notes for a version. GitHub anchors each CHANGELOG.md heading by
 * its text with the dots dropped, so 2.1.281 is #21281.
 */
const cvChangelogUrl = (v) =>
    `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#${String(v).replace(/\./g, '')}`;

// The two things the pill is for, without opening the panel first. The
// changelog points at the version on offer when there is one, and at the
// installed one when the pill is only up for sessions on an older binary.
dom.cvPill.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCv(false);
    const cv = state.cv || {};
    const busy = state.cvBusy || cv.updating;
    const ver = cv.behind ? cv.latest : cv.installed;
    openContextMenu(e, [
        {
            label: busy ? 'Updating…' : cv.latest ? `Update to ${cv.latest}` : 'Update now',
            onClick: updateClaudeNow,
            disabled: busy ? 'An update is already running'
                : !cv.behind && 'Already on the newest version',
        },
        {
            label: ver ? `Open changelog (${ver})` : 'Open changelog',
            // Electron's window-open handler hands this to the default browser.
            onClick: () => window.open(cvChangelogUrl(ver), '_blank', 'noreferrer'),
            disabled: !ver && 'No version known yet',
        },
    ]);
});
dom.cvCheck.addEventListener('click', async (e) => {
    e.stopPropagation();
    dom.cvCheck.disabled = true;
    try { await loadCv({ fresh: true }); } finally { dom.cvCheck.disabled = false; }
});
dom.cvUpdate.addEventListener('click', (e) => {
    e.stopPropagation();
    updateClaudeNow();
});

// Ages move on their own, so the pill is repainted on a clock rather than only
// when a snapshot arrives. Half a minute is enough for "12m ago" and for the
// crossing into stale, and cheap enough to leave running.
//
// The countdown does not wait for this — tickQuotaClocks runs it at 1 Hz. What
// this interval still owns for the countdown is the marking: it is a full
// render, so it is what puts data-resets-at back on a rebuilt pill, and its
// syncQuotaClock is the safety net that starts the tick if a reset time ever
// arrives by a path that forgets to render.
quota.timer = setInterval(renderQuota, 30000);
