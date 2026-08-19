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
// other worktrees entirely.
//
// The evidence above can only ever say a session *talked about* a port, and for
// a long time that was all this file had. It is not enough: `curl localhost:5001`
// scores a bare mention, and "is 5001 listening" is a fact about the machine, so
// a stray curl in one session lit up green the moment another worktree's server
// came up on that port. Ports bled across sessions constantly, and no amount of
// ranking fixed it, because ranking cannot turn a machine-wide fact into a
// session-scoped one.
//
// So attribution comes from the kernel instead. `ss` says which pid holds a
// port; /proc/<pid>/cwd says where that process is running; workspaceOf() turns
// that into a worktree or a checkout. A port belongs to the workspace its
// process is actually in, and a session sees it only if that is *its* workspace.
// No inference, nothing to keep in sync, and it cannot drift.
//
// Ancestry would have been the obvious alternative — walk the holder's parents
// until you reach the session's `claude` — and it does not work: a backgrounded
// dev server is reparented to init the moment its launching shell exits, so by
// the time anyone asks, the chain is gone. Measured on this machine, every
// agent-started server had systemd as its ancestor.
//
// What the kernel cannot answer is a port with no Linux process behind it. WSL
// runs with mirrored networking, so a server on the Windows side answers on
// 127.0.0.1 with no pid this side. Those fall back to the transcript, and only
// to its strong end — a startup banner or a devbrowser call, never a mention.

const fs = require('fs');
const net = require('net');
const { execFile } = require('child_process');
const { PORT_DENYLIST } = require('./config');
const { workspaceOf } = require('./transcript');

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

// Evidence at or above this is a session saying it *started* something: a
// startup banner it printed, a --port it passed, a devbrowser call it made.
// Below it are mentions and stray URLs, which say only that a port was talked
// about. The ladder already drew that line; this is where it gets used.
const STARTED_IT = SCORES.portFlag;

/**
 * Rank detected ports for display, and drop the ones that are not this
 * session's.
 *
 * The ranking is a preference among things worth showing. The attribution below
 * it is a rule about what is worth showing at all, and it comes first: a port
 * held by a process in another worktree is not this session's dev server, however
 * strong the evidence that this session once mentioned it.
 *
 * @param {Array}  candidates  from detect()
 * @param {object} titles      DevBrowser's port -> name map
 * @param {object} session     {workspace, worktreeName, projectName, lastTs}
 */
async function enrich(candidates, titles = {}, session = {}) {
    const [live, held] = await Promise.all([
        Promise.all(candidates.map(c => isListening(c.port))),
        heldPorts(),
    ]);
    const mine = workspaceOf(session.workspace);
    const sessionNames = [session.worktreeName, session.projectName]
        .filter(Boolean).map(s => s.toLowerCase());

    let elsewhere = 0;

    const ranked = candidates.map((c, i) => {
        const listening = live[i];
        const dbTitle = titles[String(c.port)] || null;
        const title = dbTitle || c.title || null;

        // Who actually holds it, according to the kernel. An empty list means
        // nothing on this side does — a Windows-side server, or a port that has
        // just gone — and there is nothing to attribute either way.
        const holder = held.get(c.port) || null;
        const workspaces = holder ? holder.workspaces : [];
        const protectedBy = holder ? holder.protectedBy : null;
        const ours = Boolean(mine) && !protectedBy && workspaces.includes(mine);
        // Held, and not by us. This is the bleed, named.
        const foreign = !protectedBy && workspaces.length > 0 && !ours;
        if (foreign && listening) elsewhere++;

        let rank = c.score;
        if (listening) rank += 120;
        // Worth far more than any textual signal, because it is not a signal:
        // it is the directory the process is running in.
        if (ours) rank += 200;

        // DevBrowser's name for the port matching this session's worktree used
        // to be the strongest association available. It is a tie-break now.
        const owned = Boolean(dbTitle && sessionNames.includes(dbTitle.toLowerCase()));
        if (owned) rank += 30;
        else if (dbTitle) rank += 20;

        // …but a name belonging to somebody *else's* worktree is still worth
        // something, as a refusal. Nothing holds a dead port, so cwd cannot
        // speak for it, and the transcript is no help either: `pgrep -f "vite
        // dev --port 5002"` reads as a start command to any regex looking for
        // one, so a session that merely checked whether another worktree's
        // server was up ends up with a chip named after it. DevBrowser's own
        // name for the port is the one piece of evidence that disagrees.
        const titledElsewhere = Boolean(dbTitle) && !owned && sessionNames.length > 0;

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
            // Attribution, for the UI and for anyone debugging why a chip is or
            // is not there.
            workspace: workspaces[0] || null,
            ours,
            foreign,
            protectedBy,
            titledElsewhere,
            // Held by nothing this side, so shown on this session's own word.
            unverified: listening && workspaces.length === 0 && !protectedBy,
            pids: holder ? holder.pids : [],
        };
    });

    ranked.sort((a, b) => b.rank - a.rank);

    // A live chip means "your dev server, right now". It has to be ours by cwd,
    // or — when nothing on this side holds the port — backed by this session
    // having started it rather than merely named it.
    const liveOnes = ranked.filter(p => p.listening && !p.protectedBy
        && (p.ours
            || (p.workspace === null && !p.titledElsewhere && p.score >= STARTED_IT)));

    // Dead ports are history worth keeping ("the server you started is gone"),
    // but only for a session that did start one. A bare mention that is not even
    // running is nothing at all.
    const deadOnes = ranked
        .filter(p => !p.listening && !p.foreign && !p.protectedBy && !p.titledElsewhere
            && p.score >= STARTED_IT)
        .slice(0, liveOnes.length ? 2 : 4);

    return { ports: liveOnes.concat(deadOnes), total: ranked.length, elsewhere };
}

// ---------------------------------------------------------------------------
// Stopping one
// ---------------------------------------------------------------------------
// The chip says a port is answering; this is what lets the same chip stop it.
// It works from the socket rather than from the transcript: whatever the agent
// typed to start the server, the process holding the port is the one to signal.

/**
 * Processes that are never a dev server, however they got hold of a port.
 *
 * A bridge is a Claude Sessions instance like this one, and killing it takes its
 * turns down with it — `claude` reads stdin, so the closed pipe reads as
 * end-of-input and the turn stops mid-flight. A `claude` process *is* a turn.
 * Neither is something a button in this UI should be able to end by accident.
 */
function protectedAs(cmdline) {
    const argv = cmdline.split('\0').filter(Boolean);
    const joined = argv.join(' ');
    const argv0 = (argv[0] || '').split('/').pop();
    if (/bridge\/server\.js/.test(joined)) return 'a Claude Sessions bridge';
    if (argv0 === 'claude' || /claude-code\/cli\.js|\.claude\/local\/claude/.test(joined)) {
        return 'a claude agent process';
    }
    return null;
}

/**
 * One `ss` sweep: every port being listened on here, and the pids holding it.
 *
 * Several pids can share one listening socket (a forked worker pool), so each
 * port maps to a list. Shelling out once and reading the whole table beats one
 * call per port — enrich() asks about every candidate a transcript mentioned,
 * which is routinely a dozen.
 *
 * @returns {Promise<Map<number, number[]>>}
 */
function ssListening() {
    return new Promise((resolve) => {
        execFile('ss', ['-ltnpH'], { timeout: 3000, maxBuffer: 4 << 20 }, (err, stdout) => {
            const byPort = new Map();
            if (err || !stdout) return resolve(byPort);
            for (const line of stdout.split('\n')) {
                // LISTEN 0 511 127.0.0.1:45899 0.0.0.0:* users:(("node",pid=1234,fd=21))
                const local = line.trim().split(/\s+/)[3];
                if (!local) continue;
                const port = Number(local.slice(local.lastIndexOf(':') + 1));
                if (!Number.isInteger(port)) continue;
                let pids = byPort.get(port);
                if (!pids) { pids = new Set(); byPort.set(port, pids); }
                for (const m of matchAll(line, /pid=(\d+)/g)) pids.add(Number(m[1]));
            }
            for (const [port, pids] of byPort) byPort.set(port, [...pids]);
            resolve(byPort);
        });
    });
}

/**
 * The directory a process is running in.
 *
 * readlink appends " (deleted)" when the directory has been removed since —
 * routine here, because worktrees get deleted while their dev server is still
 * up. Strip it: the path still says which workspace the process belongs to,
 * which is the only thing being asked.
 */
function cwdOf(pid) {
    try {
        return fs.readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, '');
    } catch { return null; }
}

/**
 * Which workspace each listening port belongs to, from the kernel.
 *
 * A port with no entry here is either not listening or held by something with
 * no Linux pid — the two are told apart by isListening(), and the caller has to
 * treat the second case differently because there is nothing to attribute.
 *
 * @returns {Promise<Map<number, {pids: number[], workspaces: string[]}>>}
 */
async function heldPorts() {
    const byPort = await ssListening();
    const out = new Map();
    for (const [port, pids] of byPort) {
        const workspaces = [...new Set(
            pids.map(cwdOf).filter(Boolean).map(workspaceOf).filter(Boolean))];
        // A bridge or a `claude` is never somebody's dev server, however
        // convincingly its working directory says it belongs to you — the
        // everyday instance runs in the main checkout, so a session there would
        // otherwise be offered a green chip, and a stop button, for the app it
        // is being displayed in. protectedAs already refuses to signal these;
        // this stops them being presented as yours in the first place.
        const protectedBy = pids.map(protectedOf).find(Boolean) || null;
        out.set(port, { pids, workspaces, protectedBy });
    }
    return out;
}

/** What kind of untouchable process this pid is, if it is one. */
function protectedOf(pid) {
    if (pid === process.pid || pid === process.ppid) return 'this bridge';
    try {
        return protectedAs(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
    } catch { return null; }
}

/**
 * Who is listening on a port, with enough about each to decide whether to
 * signal it.
 *
 * Only Linux sockets are visible here. WSL's mirrored networking means a
 * Windows-side server answers on 127.0.0.1 too but has no pid on this side —
 * that reads as an empty list, and the caller says so rather than guessing.
 */
async function owners(port) {
    const pids = (await ssListening()).get(Number(port)) || [];
    return pids.map((pid) => {
        let cmdline = '';
        try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { /* gone */ }
        return {
            pid,
            cwd: cwdOf(pid),
            command: clip(cmdline.split('\0').filter(Boolean).join(' '), 120),
            protectedAs: pid === process.pid || pid === process.ppid
                ? 'this bridge' : protectedAs(cmdline),
        };
    });
}

/** Poll until nothing answers on the port, or the deadline passes. */
async function waitGone(port, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
        if (!await isListening(port, 200)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(r => setTimeout(r, 150));
    }
}

/**
 * Stop whatever is listening on `port`: SIGTERM, and SIGKILL only if the socket
 * is still up after a grace period. Signals go to the listening pids themselves,
 * not their process group — a server the agent started in the foreground of a
 * Bash call shares a group with the shell that `claude` is waiting on.
 */
async function stop(port, { graceMs = 2500, hardMs = 1500 } = {}) {
    const found = await owners(port);
    if (!found.length) {
        return { ok: false, reason: 'no-owner', listening: await isListening(port) };
    }
    const guarded = found.find(o => o.protectedAs);
    if (guarded) {
        return { ok: false, reason: 'protected', what: guarded.protectedAs, pid: guarded.pid };
    }

    const pids = found.map(o => o.pid);
    const signal = (sig) => {
        let sent = 0;
        let denied = false;
        for (const pid of pids) {
            try { process.kill(pid, sig); sent++; }
            catch (err) { if (err.code === 'EPERM') denied = true; }  // ESRCH: already gone
        }
        return { sent, denied };
    };

    const term = signal('SIGTERM');
    if (!term.sent && term.denied) return { ok: false, reason: 'not-permitted', pids };
    if (await waitGone(port, graceMs)) {
        return { ok: true, port, pids, commands: found.map(o => o.command), escalated: false };
    }

    signal('SIGKILL');
    const gone = await waitGone(port, hardMs);
    return {
        ok: gone, port, pids, commands: found.map(o => o.command), escalated: true,
        reason: gone ? null : 'still-listening',
    };
}

module.exports = { detect, enrich, isListening, owners, heldPorts, stop };
