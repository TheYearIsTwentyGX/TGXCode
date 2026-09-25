'use strict';

// The bridge process itself: `/api/health`, `/api/shutdown`, `/api/restart`,
// the installed Claude Code (`/api/claude-version`, and `/update`), and
// `/api/pairing`, which says how this bridge can be reached.
//
// **The most refused module there is.** Shutdown, restart (both methods) and the
// update are refused to a remote caller by remoteRefusal() in server.js before
// they get here; `/api/pairing` refuses one itself, beside the route. Health is
// the one route with no token, and it tells a remote caller less — see the
// route. `handedOver` lives here because nothing else reads it.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const path = require('path');
const os = require('os');
const cfg = require('../config');
const { broadcast, clients } = require('../events');
const hostClient = require('../host-client');
const { NEXT, readJson, send } = require('../http');
const restart = require('../restart');
const { PERMISSION_MODES } = require('../runner');
const tailscale = require('../tailscale');

// Handed over by server.js — see the note above ROUTES there.
let claudeVersion = null;
let index = null;
let markClaudeVersionSent = null;
let pool = null;
let registry = null;
let runs = null;
let shutdown = null;
let terminals = null;

function init(deps) {
    ({
        claudeVersion, index, markClaudeVersionSent, pool, registry, runs, shutdown, terminals,
    } = deps);
}

// Whether a restart script has been handed over to. One-way: this process is
// being replaced, so there is nothing to set it back for. Two clicks would
// otherwise be two kills and two launch.sh racing for one port.
let handedOver = false;

async function handle(req, res, url, pathname, seg, who) {
    // --- health / meta ----------------------------------------------------
    if (pathname === '/api/health') {
        // The one route with no token, so it is also the one route that has to
        // think about what it gives away. Everything below is a count, a pid or a
        // flag — except root/home, which are paths on this machine and are only
        // here for the Windows shell's benefit. It always asks over loopback, so a
        // remote caller can be told less without costing anything.
        const local = !who.remote;
        return send(res, 200, {
            ok: true, app: 'tgxcode', version: cfg.VERSION,
            pid: process.pid, port: cfg.PORT, dev: cfg.IS_DEV, ready: index.ready,
            sessions: index.sessions.size, host: os.hostname(),
            // Whether this request arrived from off-machine, and whether the bridge
            // is asking for a token at all. The UI reads both: the first raises the
            // remote banner, the second tells an older client why it is getting 401s.
            remote: who.remote, authRequired: true,
            // Which checkout is being served, and the home directory to expand a
            // `~` in the shell's configured bridgeDir against. The Windows shell
            // compares these before it adopts a bridge it did not start: a port
            // answering is not proof it is answering for the right tree.
            ...(local ? { root: cfg.ROOT, home: cfg.HOME } : {}),
            worktree: cfg.IS_WORKTREE,
            // Whether sessions this bridge starts are given the task tools back.
            // False means a task list will usually be empty, which is worth a
            // client explaining rather than drawing as "no tasks". Says nothing
            // about sessions this bridge did not start.
            todoTools: cfg.TODO_TOOLS,
            // Live SSE connections — a quick way to tell whether a UI attached.
            clients: clients.size, runners: Object.keys(pool.statuses()).length,
            terminals: terminals.live().length, runs: runs.live().length,
            // Sessions with a process, from Claude Code's registry — including
            // every one running in a terminal, which no other count here sees.
            live: registry.liveCount, registered: registry.size,
            // Turns in flight, and of those, the ones a restart would end: a turn
            // in the session host survives one and is adopted by the next bridge.
            // Anything that restarts the bridge should look at `atRisk` — `busy`
            // is what it looked at before the host, and still means what it said.
            busy: pool.busyCount,
            atRisk: pool.atRiskCount,
            // The session host this bridge is running turns in, or null when it
            // is spawning them directly. Pid and protocol only; see bridge/host.js.
            sessionHost: hostClient.status(),
            permissionModes: PERMISSION_MODES,
        });
    }

    if (pathname === '/api/shutdown' && req.method === 'POST') {
        // Only honour a shutdown aimed at this exact process. Without it, an app
        // window closing could take down a bridge somebody else started — say one
        // running in a terminal for frontend work.
        const want = url.searchParams.get('pid');
        if (want && Number(want) !== process.pid) {
            return send(res, 409, { error: 'not the bridge you started', pid: process.pid });
        }
        if (pool.busyCount > 0) {
            return send(res, 409, { error: 'a turn is still running', busy: pool.busyCount });
        }
        send(res, 200, { ok: true });
        setTimeout(() => shutdown(0), 100);
        return;
    }

    // What a restart decided, for a client that watched one fail to happen.
    //
    // The journal is the point. A restart that refuses leaves this process alive,
    // so nothing drops, no pid changes and no event fires — the outcome is only
    // ever written to a file, and the bridge that can serve it is whichever one
    // is up now. See the note on bridge/restart.js's `journal`.
    if (pathname === '/api/restart' && req.method === 'GET') {
        return send(res, 200, {
            pid: process.pid, port: cfg.PORT, root: cfg.ROOT,
            worktree: cfg.IS_WORKTREE, busy: pool.busyCount, atRisk: pool.atRiskCount,
            journal: restart.journal(),
        });
    }

    if (pathname === '/api/restart' && req.method === 'POST') {
        // Fast-forward this bridge's own checkout and hand over to
        // scripts/restart-bridge.sh. Sibling of /api/shutdown above, and the
        // ?pid= guard is there for the same reason: a window can adopt a bridge
        // it did not start, and this one's blast radius is larger.
        const want = url.searchParams.get('pid');
        if (want && Number(want) !== process.pid) {
            return send(res, 409, { error: 'not the bridge you started', pid: process.pid });
        }
        if (handedOver) {
            return send(res, 409, { error: 'a restart is already running', pid: process.pid });
        }

        const body = await readJson(req).catch(() => ({}));
        // One meaning only: go ahead with turns in flight. It is the answer to
        // what the dialog asked, not a blanket override — the script is passed
        // --yes on every invocation regardless, because there is never a terminal
        // here to answer its dirty-bridge prompt at.
        const force = body.force === true;
        const wantPull = body.pull !== false;

        // What is in the way, asked twice: before the pull so a refusal never
        // leaves the checkout moved, and after it because the pull takes a moment
        // and may itself have landed the bridge/ change now being complained
        // about.
        //
        // Skipped outright when forcing rather than asked and ignored. That is
        // not only thrift: asking first and refusing anyway is what would make
        // Restart anyway unable to pull.
        const gate = async (sofar) => {
            if (force) return null;
            const found = [
                ...(sofar && !sofar.ok ? [{ kind: 'pull', text: sofar.error }] : []),
                ...await restart.blockers(cfg.ROOT, { busy: pool.atRiskCount }),
            ];
            return found.length ? found : null;
        };

        let problems = await gate(null);
        if (problems) return send(res, 409, { blocked: true, pulled: null, problems });

        const pulled = wantPull
            ? await restart.pull(cfg.ROOT)
            : { ok: true, skipped: true, out: '', error: null, before: null, after: null, changed: [] };

        problems = await gate(pulled);
        if (problems) return send(res, 409, { blocked: true, pulled, problems });

        // The pull may just have replaced the script — which is wanted — or moved
        // it. An ENOENT after the 200 below is unrecoverable: nothing restarts and
        // nothing is left to say so.
        if (!restart.scriptPresent()) {
            return send(res, 500, {
                error: `${restart.SCRIPT} is missing — nothing was restarted`, pulled,
            });
        }

        handedOver = true;
        let fired = false;
        const go = () => {
            if (fired) return;
            fired = true;
            try {
                restart.launch({ force });
            } catch (err) {
                // Nothing was killed, so this process is still the bridge — and a
                // one-way flag would leave the button dead with no way to say why.
                // The 200 has already gone out, so the log is the only place left
                // to put this; the caller finds out by watching pid never change.
                handedOver = false;
                console.error(`[tgxcode] restart: could not start ${restart.SCRIPT}:`,
                    err.message);
            }
        };
        // The script's first act is to SIGTERM this process, so it is not started
        // until the reply is on the socket. /api/shutdown above guesses at this
        // with a 100ms timer; here the event itself is available, and the reply is
        // the only thing that will ever tell the caller the restart began. The
        // timer is the fallback for a client that hung up mid-reply, where
        // 'finish' may never fire.
        res.once('finish', go);
        setTimeout(go, 500).unref();

        const where = {
            log: path.join(cfg.CACHE_DIR, `restart-${cfg.PORT}.out`),
            journal: path.join(cfg.CACHE_DIR, `restart-${cfg.PORT}.log`),
        };
        return send(res, 200, {
            ok: true,
            // Not "restarted": the process that could confirm that is the one
            // being replaced. A caller learns it worked by polling /api/health
            // until `pid` differs from the one below.
            restarting: true,
            pid: process.pid, port: cfg.PORT, force,
            pulled, reach: restart.reach(pulled.changed),
            // Neither is a blocker — both die with the bridge by design — but a
            // dialog should be able to say what is about to go with it.
            warnings: { terminals: terminals.live().length, runs: runs.live().length },
            // The replacement comes back setsid'd from the script, so a bridge
            // started by `npm run dev` is no longer the child of that terminal
            // and Ctrl-C there stops working. Said out loud so the UI can.
            detached: true,
            ...where,
        });
    }

    // Installed Claude Code, the newest on the configured channel, and the live
    // sessions still running something older than what is installed. The
    // registry is asked at most hourly; `?refresh=1` asks now, and is what a
    // person pressing "check again" means.
    if (pathname === '/api/claude-version' && req.method === 'GET') {
        return send(res, 200, await claudeVersion.summary({ fresh: url.searchParams.get('refresh') === '1' }));
    }

    // `claude update`, on the machine. It replaces the binary new processes start
    // from and leaves every running one alone — restarting sessions is the
    // user's call, and the summary's `staleSessions` is how they find which.
    // Local only: see remoteRefusal().
    if (pathname === '/api/claude-version/update' && req.method === 'POST') {
        if (claudeVersion.updating) {
            return send(res, 409, { error: 'an update is already running', running: true,
                summary: claudeVersion.summaryNow() });
        }
        const out = await claudeVersion.update();
        const summary = await claudeVersion.summary({ fresh: true });
        markClaudeVersionSent(JSON.stringify(summary));
        broadcast('claude-version', summary);
        return send(res, 200, { ok: out.ok === true, output: out.output || '', summary });
    }

    // --- pairing -----------------------------------------------------------
    // What the "Connect a phone" dialog needs to build a link that works: the
    // machine's real tailnet name, and whether HTTPS is available on it yet.
    //
    // Local callers only — not because it is secret, but because it is answering
    // "how would a *different* device reach this bridge", and a device that is
    // already talking to it remotely has its answer.
    if (pathname === '/api/pairing' && req.method === 'GET') {
        if (who.remote) return send(res, 403, { error: 'local callers only' });
        const info = await tailscale.pairingHosts(cfg.PORT);
        return send(res, 200, info);
    }

    return NEXT;
}

module.exports = { init, handle };
