// Turning timestamps, durations, paths and model ids into short text.
//
// Pure, and deliberately free of DOM access at top level, so the Node suite
// imports this file directly — test/message-date.test.js does — rather than
// cutting functions out of app.js as text. Keep it that way: a function that
// needs `dom` or `state` belongs somewhere else.

export const pad = (n) => String(n).padStart(2, '0');

// Whether a wall clock reads 12-hour — `transcript.clock` in bridge/prefs.js.
// Set from outside, the way noteHome sets `homeDir`, so this file stays free of
// `state`: web/app.js's applyClock() calls setClock at boot and on every save.
let clock12 = false;
export const setClock = (fmt) => { clock12 = fmt === '12h'; };

// For the few clocks drawn by `toLocale*String` rather than by hand, so they
// follow the setting instead of the locale.
export const hourOpts = () => ({ hour12: clock12 });

// `3:04` or `15:04`, and the meridiem to go after it, if any.
function hourMinute(d) {
    const h = d.getHours();
    return clock12
        ? [`${h % 12 || 12}:${pad(d.getMinutes())}`, h < 12 ? ' AM' : ' PM']
        : [`${pad(h)}:${pad(d.getMinutes())}`, ''];
}

export function clockOf(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const [hm, meridiem] = hourMinute(d);
    return `${hm}:${pad(d.getSeconds())}${meridiem}`;
}

// The date a message was recorded, or '' when the clock alone places it.
//
// Both conditions are required. A message from earlier today needs no date
// whatever the hour — you have been here all day. And a message from late last
// night is still "last night" at breakfast, so the calendar rolling over is on
// its own not enough; twelve hours is where a bare clock stops being something
// you can place. A `ts` in the future (clock skew) fails the second test and
// stays bare, which is the right way round: it is not a date to assert.
//
// Read once, when the row is drawn, and rows are never redrawn — so a message
// sitting at eleven hours old does not sprout a date when it crosses twelve
// while you watch. Fixing that wants a ticker over the whole log, which is a
// lot of invalidation for a session left open half a day.
export function dateOf(ts, now = Date.now()) {
    if (!ts) return '';
    const d = new Date(ts);
    const t = d.getTime();
    if (!Number.isFinite(t)) return '';
    const n = new Date(now);
    const sameDay = d.getFullYear() === n.getFullYear()
        && d.getMonth() === n.getMonth()
        && d.getDate() === n.getDate();
    if (sameDay || now - t <= 12 * 3600e3) return '';
    const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    // A year only when it is not this one. 'Dec 3' on a session from last
    // December reads as three weeks ago rather than a year, and that is a date
    // a reader would act on.
    return d.getFullYear() === n.getFullYear()
        ? date
        : `${date} ’${pad(d.getFullYear() % 100)}`;
}

export function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    const d = Math.floor(s / 86400);
    if (d < 7) return `${d}d`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function dur(ms) {
    if (!ms || ms < 0) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m${pad(Math.floor((ms % 60000) / 1000))}s`;
}

export const fileName = (p) => (p ? String(p).split('/').pop() : '');

// A path with the home directory folded back to `~`. The settings panel names
// files, and every one of them starts with the same 18 characters — which is
// the part a reader already knows and the part that pushes the rest out of a
// narrow column. `HOME` is read off a path the bridge already sends rather than
// asked for: `~/.tgxcode/settings.json` is always the weakest file in the
// chain, so the prefix is derivable and needs no route.
let homeDir = '';
export const noteHome = (userPrefsFile) => {
    const m = /^(.*)\/\.tgxcode\/settings\.json$/.exec(userPrefsFile || '');
    if (m) homeDir = m[1];
};
export const shortPath = (p) => {
    const s = String(p || '');
    return homeDir && s.startsWith(`${homeDir}/`) ? `~${s.slice(homeDir.length)}` : s;
};
export const shortModel = (m) => (m ? String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '') : '');

export function clip(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/**
 * A wall clock without the seconds.
 *
 * `clockOf` keeps them because it timestamps events, where a second is real
 * information. Nothing here is accurate to a second and nothing here is meant to
 * be — you pick a time to the minute and the tick finds it within thirty — so the
 * extra digits are noise on every chip and badge this section draws.
 */
export const hhmm = (ts) => (ts ? hourMinute(new Date(ts)).join('') : '');
