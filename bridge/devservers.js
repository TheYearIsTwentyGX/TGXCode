'use strict';

// Works out which localhost ports a session's agent brought up, so the
// conversation view can offer a "show this in DevBrowser" button.
//
// Evidence comes from the transcript's Bash traffic. The strongest signal is the
// agent naming a port through the devbrowser CLI, which this machine's
// conventions ask it to do whenever it starts a dev server; framework startup
// banners and explicit --port flags fill in the rest.
//
// The hard part is not finding ports — a long session mentions dozens — but
// deciding which one the user means *now*. A transcript accumulates ports that
// were started and killed days ago, and it also mentions ports belonging to
// other worktrees entirely. Three things separate signal from noise: whether the
// port is currently accepting connections, whether the last thing the agent did
// to it was start it or kill it, and whether the name DevBrowser has for it
// matches this session's worktree.

const net = require('net');
const { PORT_DENYLIST } = require('./config');

// Commands that plausibly start a long-lived server.
const DEV_COMMAND = /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|\bvite\b|\bnext\s+dev\b|\bnodemon\b|\bdotnet\s+(?:run|watch)\b|\bflask\s+run\b|\buvicorn\b|\brails\s+s(?:erver)?\b|\bng\s+serve\b|\bhttp-server\b/;

// …and commands that take one down.
const KILL_COMMAND = /\b(?:pkill|kill|killall|fuser)\b/;

const SCORES = {
    devbrowserTitle: 100,  // the agent explicitly named this port
    devbrowserTab: 90,     // the agent opened a tab for it
    banner: 85,            // a framework printed its startup banner
    portFlag: 70,          // an explicit --port on a dev-server command
    url: 45,               // a localhost URL in output
    mention: 30,           // a bare localhost:port anywhere
};

/**
 * Collect port evidence from a session's render events.
 * @returns {Array} candidates, richest evidence first
 */
function detect(events) {
    /** @type {Map<number, object>} */
    const found = new Map();

    const touch = (port) => {
        const p = Number(port);
        if (!Number.isInteger(p) || p < 1024 || p > 65535) return null;
        if (PORT_DENYLIST.has(p)) return null;
        let rec = found.get(p);
        if (!rec) {
            rec = { port: p, score: 0, title: null, source: null, ts: null,
                evidence: null, background: false, startedTs: null, killedTs: null };
            found.set(p, rec);
        }
        return rec;
    };

    const record = (port, weight, source, ts, evidence, extra = {}) => {
        const rec = touch(port);
        if (!rec) return;
        if (weight > rec.score) { rec.score = weight; rec.source = source; }
        if (ts && (!rec.ts || ts >= rec.ts)) { rec.ts = ts; rec.evidence = evidence; }
        if (extra.title) rec.title = extra.title;
        if (extra.background) rec.background = true;
        if (extra.started && ts && (!rec.startedTs || ts > rec.startedTs)) rec.startedTs = ts;
        if (extra.killed && ts && (!rec.killedTs || ts > rec.killedTs)) rec.killedTs = ts;
    };

    for (const ev of events) {
        if (ev.kind !== 'tool') continue;
        if (ev.name !== 'Bash' && ev.name !== 'BashOutput' && ev.name !== 'Monitor') continue;

        const command = (ev.input && ev.input.command) || '';
        const background = !!(ev.input && ev.input.run_in_background);
        const starts = DEV_COMMAND.test(command);
        const kills = KILL_COMMAND.test(command);
        const ts = ev.ts;

        // -- the devbrowser CLI: the agent telling us directly ---------------
        for (const m of matchAll(command, /devbrowser\s+title\s+(\d{2,5})\s+(?:--clear|(["'])([^"']{1,64})\2|(\S+))/g)) {
            const clearing = /--clear/.test(m[0]);
            record(m[1], SCORES.devbrowserTitle, 'devbrowser-title', ts,
                { command: clip(command), from: 'command' },
                { title: clearing ? null : (m[3] || m[4] || null), killed: clearing });
        }
        for (const m of matchAll(command, /devbrowser\s+(?:open|go|reload)\s+(\d{2,5})/g)) {
            record(m[1], SCORES.devbrowserTab, 'devbrowser-tab', ts,
                { command: clip(command), from: 'command' }, {});
        }

        // -- explicit ports on the command line ------------------------------
        // A bare `-p N` is only trustworthy next to something that serves.
        const flagRe = starts
            ? /(?:--port[= ]|-p\s+|PORT=|--server\.port[= ])(\d{2,5})\b/g
            : /(?:--port[= ]|PORT=|--server\.port[= ])(\d{2,5})\b/g;
        for (const m of matchAll(command, flagRe)) {
            // "kill the old one, then start it again" is a restart, not a stop —
            // so a command that does both counts as a start.
            record(m[1], starts ? SCORES.portFlag : SCORES.portFlag - 20, 'port-flag', ts,
                { command: clip(command), from: 'command' },
                { background, started: starts, killed: kills && !starts });
        }

        // A kill aimed at a port, with no restart in the same command.
        if (kills && !starts) {
            for (const m of matchAll(command, /(\d{2,5})/g)) {
                const rec = found.get(Number(m[1]));
                if (rec && ts && (!rec.killedTs || ts > rec.killedTs)) rec.killedTs = ts;
            }
        }

        // -- server output ----------------------------------------------------
        const out = [ev.result && ev.result.stdout, ev.result && ev.result.stderr,
            ev.result && ev.result.text].filter(Boolean).join('\n');
        if (!out) continue;

        for (const m of matchAll(out, /(?:Local|Network|ready(?:\s+in\s+\S+)?|started server|Listening|listening|running)\b[^\n]{0,80}?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})/g)) {
            record(m[1], SCORES.banner, 'server-banner', ts,
                { command: clip(command), from: 'output' }, { background, started: true });
        }
        // Weaker output signals are only meaningful next to a server command;
        // otherwise every `curl localhost:5000` becomes a false positive.
        if (starts || background) {
            for (const m of matchAll(out, /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/g)) {
                record(m[1], SCORES.url, 'url', ts, { command: clip(command), from: 'output' }, {});
            }
        } else {
            for (const m of matchAll(out, /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/g)) {
                record(m[1], SCORES.mention, 'mention', ts,
                    { command: clip(command), from: 'output' }, {});
            }
        }
    }

    return [...found.values()];
}

function* matchAll(text, re) {
    if (!text) return;
    // Guard against pathological output.
    const t = text.length > 200_000 ? text.slice(0, 200_000) : text;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) yield m;
}

function clip(s, n = 160) {
    const one = String(s || '').replace(/\s+/g, ' ').trim();
    return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/** Is something accepting connections on this port right now? */
function isListening(port, timeout = 300) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
        sock.setTimeout(timeout);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        sock.connect(port, '127.0.0.1');
    });
}

/**
 * Rank detected ports for display.
 *
 * @param {Array}  candidates  from detect()
 * @param {object} titles      DevBrowser's port -> name map
 * @param {object} session     {worktreeName, projectName, lastTs}
 */
async function enrich(candidates, titles = {}, session = {}) {
    const live = await Promise.all(candidates.map(c => isListening(c.port)));
    const sessionNames = [session.worktreeName, session.projectName]
        .filter(Boolean).map(s => s.toLowerCase());

    const ranked = candidates.map((c, i) => {
        const listening = live[i];
        const dbTitle = titles[String(c.port)] || null;
        const title = dbTitle || c.title || null;

        let rank = c.score;
        if (listening) rank += 120;

        // DevBrowser's name for the port matching this session's worktree is the
        // strongest association we can make: the tab is literally named after it.
        const owned = Boolean(dbTitle && sessionNames.includes(dbTitle.toLowerCase()));
        if (owned) rank += 150;
        else if (dbTitle) rank += 20;

        // The agent's last action on this port was to kill it. Something
        // answering on the port overrules that — it is evidently back up.
        const stopped = !listening
            && Boolean(c.killedTs && (!c.startedTs || c.killedTs > c.startedTs));
        if (stopped) rank -= 100;

        // Decay by how long ago the port was last mentioned, relative to the end
        // of the conversation. Ports from days-old turns are history, not state.
        const age = c.ts && session.lastTs
            ? Date.parse(session.lastTs) - Date.parse(c.ts) : 0;
        if (age > 0) rank -= Math.min(60, Math.floor(age / (6 * 3600 * 1000)) * 12);

        return {
            port: c.port,
            title,
            titled: Boolean(dbTitle),
            owned,
            listening,
            stopped,
            source: c.source,
            rank,
            score: c.score,
            background: c.background,
            lastSeen: c.ts,
            evidence: c.evidence,
        };
    });

    ranked.sort((a, b) => b.rank - a.rank);

    // Everything live is worth offering. Beyond that, a few recent dead ports are
    // useful context ("the server you started is gone") but a long tail is not.
    const liveOnes = ranked.filter(p => p.listening);
    const deadOnes = ranked.filter(p => !p.listening).slice(0, liveOnes.length ? 2 : 4);
    return { ports: liveOnes.concat(deadOnes), total: ranked.length };
}

module.exports = { detect, enrich, isListening };
