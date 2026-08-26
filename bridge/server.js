'use strict';

// The bridge: an HTTP + SSE server that runs inside WSL and does all the real
// work — reading transcripts, driving `claude`, talking to DevBrowser. The
// Windows-side Electron shell is only a window pointed at this server, so the
// UI can be reloaded without rebuilding anything.
//
// Binding 127.0.0.1 is enough for the Windows side to reach us because this
// machine runs WSL with networkingMode=mirrored.

const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const cfg = require('./config');
const auth = require('./auth');
const { SessionIndex, projectName } = require('./sessions');
const { SessionRegistry } = require('./registry');
const { RunnerPool, PERMISSION_MODES, resolveWorkdir } = require('./runner');
const { Flags } = require('./flags');
const { Prefs } = require('./prefs');
const { Spinner } = require('./spinner');
const { Suggestions, STATUSES: SUGGESTION_STATUSES } = require('./suggestions');
const { Drafts, MAX_DRAFTS } = require('./drafts');
const {
    Schedules, MAX_SCHEDULES, CATCHUP_MS,
    parseCron, nextSlot, dueSlot, describeCron, cronForm, fillPrompt, verdictOf,
    reviewKey, unreviewedPulls,
} = require('./schedule');
const { SlashCommandCache } = require('./slash-commands');
const { NotificationLog, ReadState } = require('./notifications');
const devbrowser = require('./devbrowser');
const tailscale = require('./tailscale');
const devservers = require('./devservers');
const dashboard = require('./dashboard');
const git = require('./git');
const restart = require('./restart');
const changes = require('./changes');
const pulls = require('./pulls');
const { mapLimit } = require('./memo');
const overview = require('./overview');
const taskboard = require('./taskboard');
const { openInExplorer, openFile } = require('./explorer');
const attachments = require('./attachments');
const { TerminalPool } = require('./terminal');
const commands = require('./commands');
const { RunPool } = require('./runs');
// Written here, read back by transcript.js. One format, and the two halves of it
// live in one file so they cannot drift apart.
const { handoffEnvelope, firstLine } = require('./transcript');
const { HandoffLimit, stateOf: handoffState, wakes, wakeFailure } = require('./handoff');

const WEB_DIR = path.join(__dirname, '..', 'web');
const CLIENT_HEADER = 'x-claude-sessions-client';

const flags = new Flags();
// How the person using the app wants it to behave, from their own file and from
// whatever the project they are looking at overrides — see bridge/prefs.js.
const prefs = new Prefs();
// The words a turn in progress calls itself, out of the groups those settings
// enable. Shares the Prefs instance rather than making its own, so the two
// cannot read different settings out of the same file.
const spinner = new Spinner(prefs);
// What you did about a suggested follow-up — started it, or waved it away. The
// suggestion itself is in the transcript; only the decision is ours to keep.
const suggestions = new Suggestions();
// What `?status=` on /api/suggestions accepts: the two decisions the store
// knows, plus `open` for a task nobody has decided about — which is the absence
// of an entry rather than a status, so the store has no name for it.
const SUGGESTION_STATES = new Set(['open', ...SUGGESTION_STATUSES]);
// Sessions set up but not started. The only store here that is not about a
// session that exists: a draft *is* a create call, held back until you press
// Start. See bridge/drafts.js.
const drafts = new Drafts();
// Sessions that start on a clock. A draft that is never consumed, plus a cron
// expression, plus a gate — see bridge/schedule.js. Only the everyday instance
// fires them; the tick below says why.
const schedules = new Schedules();
const index = new SessionIndex(flags);
const registry = new SessionRegistry();
const pool = new RunnerPool();
const terminals = new TerminalPool();
const slashCommands = new SlashCommandCache();
// State only, never bytes: a run's output goes down its own stream. This is what
// lets every open window paint a button green off one small payload.
const runs = new RunPool({ onChange: (e) => broadcast('run-changed', e) });
// Titles are copied onto an entry as it is filed, so the log still reads
// properly after a session is renamed or deleted; the test flag is asked for at
// read time, so labelling a session as scratch afterwards takes its rows out of
// the everyday window too.
const notifications = new NotificationLog({
    describe: (id) => index.summary(id),
    isTest: (id) => flags.get(id).test,
});
// What of that log you have already seen — a watermark per conversation, so
// going to a chat and dealing with the thing clears its rows rather than leaving
// them counted against you. Kept here rather than in the page because two
// windows and a phone all have to agree about the badge.
const reads = new ReadState();

// Which sessions are running, from Claude Code's own registry rather than from
// how recently a file changed. The index works without it; every summary simply
// carries `live: null` and the mtime window is all anyone has to go on.
index.registry = registry;
// So a decision about a suggestion goes when its transcript does, the way a pin
// or an archive does.
index.suggestions = suggestions;

/**
 * @type {Map<string, {
 *   res: http.ServerResponse,
 *   subs: Map<string, {offset:number, watcher:any}>,
 *   agent: {sessionId:string, toolUseId:string, offset:number, watcher:any} | null,
 * }>}
 */
const clients = new Map();

// Whether a restart script has been handed over to. One-way: this process is
// being replaced, so there is nothing to set it back for. Two clicks would
// otherwise be two kills and two launch.sh racing for one port.
let handedOver = false;

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function sseSend(client, event, data) {
    try {
        client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* the socket went away; the close handler cleans up */ }
}

function broadcast(event, data) {
    for (const c of clients.values()) sseSend(c, event, data);
}

/**
 * A pty's output, on a connection of its own.
 *
 * Shared by terminals and by runs, because a run is a terminal underneath. It is
 * deliberately *not* the app's SSE channel: a noisy build moves megabytes and
 * has no business sharing a connection with transcript tailing.
 *
 * `opened` differs between the two — a terminal describes a shell, a run
 * describes a command — so the caller passes it.
 */
function streamBytes(req, res, term, opened) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const emit = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
        catch { /* the socket went away; the close handler cleans up */ }
    };
    emit('opened', opened);
    const detach = term.attach(emit);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);
    ping.unref();
    req.on('close', () => { clearInterval(ping); detach(); });
}

function dropClient(id) {
    const c = clients.get(id);
    if (!c) return;
    for (const sub of c.subs.values()) stopWatch(sub);
    stopAgentWatch(c);
    clients.delete(id);
    // The last window watching a board closing is what stops its timer.
    if (c.overview) syncBoard();
    if (c.taskboard) syncTaskboard();
}

function stopWatch(sub) {
    if (sub.watcher) { clearInterval(sub.watcher); sub.watcher = null; }
}

// ---------------------------------------------------------------------------
// The live board
// ---------------------------------------------------------------------------
//
// One timer for every client watching it, not one per client and certainly not
// one per session. It builds the payload once a second, and sends only when the
// answer actually moved — a board of five idle sessions is silent.

const OVERVIEW_MS = 1_000;

// `last` is whatever `buildBoard` most recently produced, so that the things
// which only want to know *which* sessions are on the board do not each build
// one of their own. It is at most a second old whenever the tick is running.
const board = { timer: null, devTimer: null, last: null };

function boardWatchers() {
    return [...clients.values()].filter(c => c.overview);
}

/** Start or stop the tick to match how many people are looking. */
function syncBoard() {
    const watching = boardWatchers().length > 0;
    if (watching && !board.timer) {
        board.timer = setInterval(tickBoard, OVERVIEW_MS);
        board.timer.unref();
        // Port probes and a DevBrowser round trip: far too expensive for the
        // tick, so it runs on its own slow cycle and the tick reads what it left.
        // Half the cache's life, not all of it: at exactly the TTL every other
        // pass lands on a still-warm entry and does nothing, which made chips
        // twice as stale as the number they are supposed to obey.
        board.devTimer = setInterval(tickDevServers, overview.DEVSERVER_TTL_MS / 2);
        board.devTimer.unref();
        tickDevServers();
    } else if (!watching && board.timer) {
        clearInterval(board.timer);
        clearInterval(board.devTimer);
        board.timer = null;
        board.devTimer = null;
        board.last = null;
    }
}

function buildBoard() {
    board.last = overview.build(index, pool, registry, { includeTest: cfg.IS_DEV });
    return board.last;
}

/**
 * Send the board to anyone who has not already got this exact answer.
 *
 * The "has anything changed" mark is per client, not global. A shared one meant
 * a second window opening the board — which is sent the state directly, so that
 * it is not looking at an empty grid — moved the mark for everybody, and the
 * windows already watching were told nothing until the *next* change.
 */
function tickBoard() {
    const watchers = boardWatchers();
    if (!watchers.length) return;

    // Built once however many windows are watching. That is the whole point of
    // a summary channel.
    const data = buildBoard();
    const sig = signature(data);
    for (const c of watchers) {
        if (c.lastBoard === sig) continue;
        c.lastBoard = sig;
        sseSend(c, 'overview', data);
    }
}

/**
 * The payload with the parts that move on their own taken out, so that "did
 * anything happen" is not answered by the clock. `at` changes on every build by
 * definition, and `busySince` is a fixed instant the UI counts up from itself.
 */
function signature(data) {
    return JSON.stringify(data, (k, v) => (k === 'at' ? 0 : v));
}

/**
 * The board as it stands, to one client that has just asked for it.
 *
 * Sent directly rather than through the tick because a window opening the board
 * should not watch an empty grid for up to a second, and because a second window
 * joining a board that is already ticking would otherwise wait for something to
 * change before it saw anything at all.
 */
function sendBoardNow(client) {
    const data = buildBoard();
    client.lastBoard = signature(data);   // so the next tick does not repeat it
    sseSend(client, 'overview', data);
}

async function tickDevServers() {
    if (!board.timer) return;
    // The board the 1Hz tick just built, not a second one. Building it again
    // walks the whole index and takes a tail read per card, all of it thrown
    // away except the ids — and then a third time when the chips have moved.
    // `last` is empty only on the pass `syncBoard` fires before the first tick.
    const ids = (board.last || buildBoard()).sessions.map(s => s.sessionId);
    try {
        if (await overview.refreshDevServers(index, ids)) tickBoard();
    } catch { /* nothing here is worth failing a tick over */ }
}

// ---------------------------------------------------------------------------
// The task board
// ---------------------------------------------------------------------------
//
// The same machinery as the live board above, on its own slower cycle. Separate
// rather than folded into `tickBoard` because the two answer different questions
// and a client watching one is usually not watching the other: the phone reads
// `overview` and never opens this, and a window left on the task board has no
// use for dev-server chips.
//
// **Three seconds rather than one.** The client takes each column's order once
// and then holds it, so a faster tick buys nothing a person could see — only
// JSON. What it must still be is prompt about the thing the board is *for*: a
// session going from working to blocked shows up within a tick, which is fast
// enough for a view you glance at and slow enough that a payload carrying every
// un-archived session is not built sixty times a minute.

const TASKBOARD_MS = 3_000;

const taskBoard = { timer: null };

function taskboardWatchers() {
    return [...clients.values()].filter(c => c.taskboard);
}

/** Start or stop the tick to match how many people are looking. */
function syncTaskboard() {
    const watching = taskboardWatchers().length > 0;
    if (watching && !taskBoard.timer) {
        taskBoard.timer = setInterval(tickTaskboard, TASKBOARD_MS);
        taskBoard.timer.unref();
    } else if (!watching && taskBoard.timer) {
        clearInterval(taskBoard.timer);
        taskBoard.timer = null;
    }
}

/**
 * Always the windowed idle column, never `?idle=all`.
 *
 * Show-all is a one-off fetch behind a button: the rows it brings back are idle
 * by definition, so nothing about them changes, and pushing all several hundred
 * of them three times a second to a window that may never have pressed it is the
 * cost this view was shaped to avoid.
 */
function buildTaskboard() {
    return taskboard.build(index, pool, { includeTest: cfg.IS_DEV });
}

/** Same per-client mark, for the same reason `tickBoard` gives. */
function tickTaskboard() {
    const watchers = taskboardWatchers();
    if (!watchers.length) return;

    const data = buildTaskboard();
    const sig = signature(data);
    for (const c of watchers) {
        if (c.lastTaskboard === sig) continue;
        c.lastTaskboard = sig;
        sseSend(c, 'taskboard', data);
    }
}

/** The board as it stands, to one client that has just asked for it. */
function sendTaskboardNow(client) {
    const data = buildTaskboard();
    client.lastTaskboard = signature(data);
    sseSend(client, 'taskboard', data);
}

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------
//
// Sessions an agent here could message, newest first. See the route for why
// this reads the registry rather than the session index.
//
// The session this list is for is *not* filtered out here, and that is on
// purpose: whether to hide yourself is a question about a composer, which knows
// which session it is in, and this route is also read by the renderer to put a
// name to a message that has already arrived — where dropping an entry would
// mean failing to name the one session that definitely sent something.

/** @returns {Array<object>} one entry per addressable live session. */
function listPeers() {
    const peers = [];
    for (const entry of registry.running()) {
        // A session with no name cannot be addressed, because the name is the
        // address. One with no inbox is a Claude Code too old for any of this.
        if (!entry.name || !entry.addressable) continue;
        const summary = index.summary(entry.sessionId);
        peers.push({
            name: entry.name,
            // 'derived' means Claude Code made this up from the directory rather
            // than anybody choosing it — worth showing beside a name somebody is
            // about to paste into a message.
            nameSource: entry.nameSource,
            sessionId: entry.sessionId,
            cwd: entry.cwd || (summary && summary.cwd) || null,
            kind: entry.kind,
            entrypoint: entry.entrypoint,
            status: entry.status,
            startedAt: entry.startedAt,
            // Absent for a peer with no transcript indexed here — a background
            // agent, or one working somewhere this app does not look. It is
            // still perfectly reachable, so it is still listed; the client shows
            // the name on its own.
            title: summary ? summary.title : null,
            project: summary ? summary.projectName : null,
        });
    }
    peers.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return peers;
}

function stopAgentWatch(client) {
    if (client.agent) { stopWatch(client.agent); client.agent = null; }
}

/**
 * Follow a transcript for one client. Content always comes from the file, never
 * from the runner's stream, so a session running in the user's terminal streams
 * into the UI exactly like one this app started.
 */
function startWatch(clientId, sessionId, fromOffset) {
    const client = clients.get(clientId);
    if (!client) return;

    const existing = client.subs.get(sessionId);
    if (existing) stopWatch(existing);

    const sub = { offset: fromOffset, watcher: null };
    client.subs.set(sessionId, sub);

    let inFlight = false;
    sub.watcher = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        try {
            const delta = index.readSince(sessionId, sub.offset);
            if (delta) {
                if (delta.reset) {
                    sseSend(client, 'reset', { sessionId });
                    sub.offset = 0;
                } else if (delta.events.length) {
                    sub.offset = delta.offset;
                    sseSend(client, 'tail', { sessionId, events: delta.events, offset: sub.offset });
                } else {
                    sub.offset = delta.offset;
                }
            }
        } finally {
            inFlight = false;
        }
    }, 400);
    sub.watcher.unref();
}

/**
 * Follow one subagent's transcript for a client that is looking at it.
 *
 * Kept separate from the session follow rather than folded into it: a subagent
 * writes to its own file on its own schedule, and the parent transcript records
 * nothing at all between spawning the agent and collecting its result. Watching
 * only the parent would leave a running subagent looking frozen.
 */
function startAgentWatch(clientId, sessionId, toolUseId, fromOffset) {
    const client = clients.get(clientId);
    if (!client) return;
    stopAgentWatch(client);

    const agent = { sessionId, toolUseId, offset: fromOffset, watcher: null };
    client.agent = agent;

    let inFlight = false;
    agent.watcher = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        try {
            const delta = index.subagent(sessionId, toolUseId, agent.offset);
            if (!delta) return;
            if (delta.reset) {
                agent.offset = 0;
                sseSend(client, 'agent-reset', { sessionId, toolUseId });
            } else if (delta.events.length) {
                agent.offset = delta.offset;
                sseSend(client, 'agent-tail', {
                    sessionId, toolUseId, events: delta.events, offset: agent.offset,
                });
            } else {
                agent.offset = delta.offset;
            }
        } finally {
            inFlight = false;
        }
    }, 500);
    agent.watcher.unref();
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    // Where this request came from and whether it carries the token. One object,
    // computed once, because three separate things below need the same answer.
    const who = auth.classify(req, url);

    // Same guard DevBrowser uses: reject cross-origin callers outright. A page in
    // some other tab must not be able to drive Claude on this machine.
    const origin = req.headers.origin;
    if (origin && !isOwnOrigin(origin, req)) return send(res, 403, { error: 'forbidden origin' });

    // A name we do not answer to means somebody else's DNS is pointing at this
    // port — the rebinding case, where a page on a public hostname resolves to
    // 127.0.0.1 and then talks to us as same-origin. Only checked for remote
    // requests: a local Host is the one we already know is ours.
    if (who.remote && !isKnownHost(who.host)) {
        return send(res, 403, { error: 'unexpected host', host: who.host });
    }

    if (pathname.startsWith('/api/') && pathname !== '/api/health'
        && req.method !== 'GET' && !req.headers[CLIENT_HEADER]) {
        return send(res, 403, { error: 'missing client header' });
    }

    // The token. /api/health stays open: app/main.js pings it to decide whether a
    // bridge is up and serving the right checkout, before it could know a token,
    // and it gives away only counts and a pid. Everything else needs the token,
    // loopback included — "any process on this machine" is precisely the hole this
    // closes. A local *browser* is spared a login step by injectToken(), not by an
    // exemption here.
    if (pathname.startsWith('/api/') && pathname !== '/api/health' && !who.ok) {
        if (who.remote) {
            console.warn(`[claude-sessions] rejected ${req.method} ${pathname} from `
                + `${who.peer} — no valid token`);
        }
        return send(res, 401, {
            error: 'unauthorized',
            hint: 'send the token from ~/.local/share/claude-sessions/token as '
                + 'Authorization: Bearer <token>',
        });
    }

    if (who.remote && who.ok && pathname.startsWith('/api/')) logRemote(req, pathname, who);

    // Powers a phone does not get, even holding a valid token.
    if (who.remote) {
        const refusal = remoteRefusal(pathname, req.method);
        if (refusal) {
            console.warn(`[claude-sessions] refused ${req.method} ${pathname} from `
                + `${who.peer} — ${refusal}`);
            return send(res, 403, { error: refusal, remote: true });
        }
    }

    try {
        if (pathname === '/pair' || pathname === '/pair/forget') {
            return pair(req, res, url, pathname, who);
        }
        if (pathname.startsWith('/api/')) return await api(req, res, url, pathname, who);
        return serveStatic(req, res, pathname, who);
    } catch (err) {
        // The stack goes to the log, not to the client. It names paths on this
        // machine and the shape of the code, and a client can do nothing with it.
        console.error(`[claude-sessions] ${req.method} ${pathname} failed:`, err.stack || err);
        send(res, 500, { error: err.message });
    }
});

/**
 * Is this origin one of ours?
 *
 * The check exists to stop a page in another tab driving Claude, and that intent is
 * what decides how far it can widen. "The origin matching the host this request was
 * addressed to" preserves it exactly: our own page, served by us, always matches,
 * and a page on any other origin never does — whatever hostname the bridge is
 * reached by. So a reverse proxy needs no configuration to work, and adds no hole.
 *
 * Loopback stays accepted outright because the Electron shell and `npm run dev`
 * reach us on 127.0.0.1 while the page may say localhost, or a different port.
 */
function isOwnOrigin(origin, req) {
    if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true;
    if (cfg.EXTRA_ORIGINS.includes(origin)) return true;

    let host;
    try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
    if (host === auth.effectiveHost(req)) return true;
    // Tailscale's own names, so `tailscale serve` works out of the box.
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host);
}

/** Hostnames this bridge will answer to when reached from off-machine. */
function isKnownHost(host) {
    if (auth.hostIsLocal(host)) return true;
    if (/\.ts\.net$/.test(host)) return true;
    // An IP address is the LAN-bind case: there is no name to spoof, so there is
    // nothing for a rebinding attack to gain.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true;
    return cfg.EXTRA_ORIGINS.some((o) => {
        try { return new URL(o).hostname.toLowerCase() === host; } catch { return false; }
    });
}

/**
 * What a request from off-machine may not do, and why — or null if it may.
 *
 * The principle, from docs/plans/14-C: a phone should be able to *watch*, and to
 * answer the questions a session is blocked on. It should not be able to reach past
 * the app into the machine. So this is not a general permission system; it is a
 * short list of the routes that stop being reasonable once the caller is not in the
 * room, and every entry earns its place:
 *
 *   - **Terminals** are a raw pty. Everything else here is mediated by the app —
 *     you answer an ask, you send a prompt — but this is a shell, and a leaked
 *     token that reaches it has the machine. A phone has no use for one.
 *   - **Shutdown**, **restarting** and **stopping a dev server** act on processes the
 *     person at the desk is using, and are trivially a denial of service from
 *     anywhere else. Restarting is the worst of the three to hand out: it ends every
 *     turn in flight and comes back running whatever is on disk.
 *   - **Reveal** and **DevBrowser** drive windows on the Windows host. Opening
 *     Explorer on a desktop nobody is sitting at is at best pointless.
 *   - **Making a folder** writes to the filesystem. Note the asymmetry with the
 *     listing beside it, which stays allowed: reading the tree answers "where
 *     could a session start", and a phone may already start one. Creating a
 *     directory is reaching past the app into the machine, which is the line
 *     above — so the refusal is on the exact path, not on /api/fs.
 *   - **Runs** are a terminal wearing a config file's clothes: /api/runs/:id/input
 *     writes bytes to a pty, so the terminal clause above settles it without a
 *     new argument. Starting one is refused on the exact path, the same asymmetry
 *     as /api/fs — a phone reading what a project declares learns nothing it
 *     could not learn by reading the repo; a phone running it does not.
 *
 * Refusing at the route rather than in the UI is the point: a client not drawing a
 * button is a courtesy, and this is the rule.
 */
function remoteRefusal(pathname, method) {
    if (pathname.startsWith('/api/terminals')) {
        return 'terminals are not available remotely';
    }
    if (pathname.startsWith('/api/runs')) {
        return 'project commands can only be run from the machine they run on';
    }
    // Exact equality, not a prefix: GET /api/commands stays readable remotely.
    if (pathname === '/api/commands/run') {
        return 'project commands can only be started from the machine they run on';
    }
    if (pathname === '/api/shutdown') {
        return 'the bridge can only be shut down from the machine it runs on';
    }
    // Both methods: the GET is the journal, which names the checkout and what a
    // restart decided about it, and there is nothing a phone does with that.
    if (pathname === '/api/restart') {
        return 'the bridge can only be restarted from the machine it runs on';
    }
    if (pathname === '/api/devservers/stop') {
        return 'dev servers can only be stopped from the machine they run on';
    }
    if (pathname.startsWith('/api/devbrowser')) {
        return 'DevBrowser is only reachable from the machine it runs on';
    }
    if (/^\/api\/sessions\/[^/]+\/reveal$/.test(pathname) && method === 'POST') {
        return 'opening a folder only makes sense on the machine itself';
    }
    // Exact equality, not a prefix: GET /api/fs stays readable remotely.
    if (pathname === '/api/fs/mkdir') {
        return 'folders can only be created on the machine they live on';
    }
    // A handoff starts a turn in a session the caller is not looking at, and can
    // wake one that has no process at all. That is a reasonable thing for an
    // agent on this machine to do and not a reasonable thing to reach in for from
    // a phone: the blast radius of a leaked token would be every session on the
    // machine, each spending tokens on words nobody typed.
    if (/^\/api\/sessions\/[^/]+\/handoff$/.test(pathname) && method === 'POST') {
        return 'a session can only be handed work from the machine it runs on';
    }
    // Attaching a file writes it into a checkout, which is the mkdir clause above.
    //
    // This is the weakest of the refusals on this list and it is worth saying so:
    // a phone taking a photo has nowhere *else* to put it, so "write it on the
    // machine you are sitting at" is advice a phone cannot take. It was refused in
    // v1 because the phone surface of the day had no attach affordance to refuse
    // anything for, and it stays refused because nothing has replaced that reason
    // yet — not because the argument is strong. If the Android app grows an attach
    // button, the answer is a smaller cap for a remote caller, not deleting this
    // line and letting a leaked token write 25MB files into a repo.
    if (/^\/api\/sessions\/[^/]+\/attachments(\/open)?$/.test(pathname)) {
        return 'files can only be attached on the machine they are saved to';
    }
    return null;
}

/**
 * Modes a remote caller may not start a session in.
 *
 * bypassPermissions runs everything unasked, which is a reasonable thing to choose
 * deliberately while sitting in front of the machine and not a reasonable thing to
 * be one tap away from on a phone that might be in someone else's hand. dontAsk is
 * the same argument with a quieter name.
 *
 * This is a refusal rather than a silent downgrade: quietly running in a safer mode
 * than the one asked for would be its own kind of lie.
 */
const REMOTE_FORBIDDEN_MODES = new Set(['bypassPermissions', 'dontAsk']);

function modeRefusal(mode, who) {
    if (!who.remote || !REMOTE_FORBIDDEN_MODES.has(mode)) return null;
    return `${mode} cannot be started remotely — choose it at the machine itself`;
}

/**
 * A very small token bucket on session creation.
 *
 * Not a security boundary; a brake. `POST /api/sessions` spawns a process, and
 * nothing else stops a loop — or a retrying client — from spawning them as fast as
 * the machine will allow. The pool caps how many stay *live* (MAX_LIVE), which is a
 * different thing from how many get started.
 */
const CREATE_LIMIT = { max: 8, windowMs: 60_000, hits: [] };

function tooManyCreates({ reserve = 0, peek = false } = {}) {
    const now = Date.now();
    CREATE_LIMIT.hits = CREATE_LIMIT.hits.filter(t => now - t < CREATE_LIMIT.windowMs);
    // `reserve` keeps creates back for somebody pressing a button.
    //
    // This bucket is global, which was fine while every caller was a person: they
    // cannot press Start eight times a minute by accident. A scheduled sweep can
    // start a session per open pull request, and spending the whole budget on that
    // means the user's own next Start returns 429 from a limit they never touched.
    // So the sweep asks for less than the whole thing.
    if (CREATE_LIMIT.hits.length >= CREATE_LIMIT.max - reserve) return true;
    // `peek` asks without spending. This function charges a create as a side
    // effect of answering, which is fine for a route that goes on to create one —
    // but the pull-request sweep asks first, against a reserve, and then
    // `runSchedule` asks again. That charged two of the eight for every review:
    // three starts a minute instead of four, and a reserve of two that could be
    // eaten down to one. A pull request whose range would not resolve spent a hit
    // for a session that never happened.
    if (!peek) CREATE_LIMIT.hits.push(now);
    return false;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/**
 * A draft as it goes out on the wire: the stored row plus the project label.
 *
 * Derived here rather than in the store and rather than in each client, so that
 * the desktop, the phone and the Android app cannot come to three different
 * answers about which project a directory belongs to. It is the same
 * `projectName` the rail and the session list use.
 */
function draftOut(draft) {
    return { ...draft, projectName: projectName(draft.cwd) };
}

/** The whole list, which is both the GET body and the SSE payload. */
function draftsPayload() {
    const rows = drafts.list().map(draftOut);
    return { at: Date.now(), drafts: rows, counts: { total: rows.length } };
}

/**
 * Validate what a draft write is asking for, exactly as a create would.
 *
 * The point of checking at *write* time is that a draft you cannot start is
 * worse than a refused save: it sits on the board looking ready and fails every
 * time you press Start. So the directory has to exist and be inside the roots
 * here too — `resolveWorkdir` is the same function `pool.create` calls, so the
 * two cannot disagree — and a remote caller is refused the two modes it is
 * refused on creation, or a phone could stash a `bypassPermissions` draft it is
 * not allowed to run.
 *
 * `partial` is PATCH: a field absent from the body is left alone rather than
 * validated as missing. `cwd` comes back expanded, which is what gets stored, so
 * a `~` typed into the dialog means the same thing a shell would make of it.
 *
 * @returns {{fields: object} | {error: string, status: number, remote?: boolean}}
 */
function draftFields(body, who, { partial }) {
    const fields = {};

    if (!partial || body.cwd !== undefined) {
        if (!body.cwd) return { error: 'cwd is required', status: 400 };
        try {
            fields.cwd = resolveWorkdir(String(body.cwd));
        } catch (err) {
            return { error: err.message, status: 400 };
        }
    }

    if (!partial || body.prompt !== undefined) {
        const prompt = body.prompt && String(body.prompt).trim();
        if (!prompt) return { error: 'prompt is required', status: 400 };
        fields.prompt = prompt;
    }

    if (!partial || body.permissionMode !== undefined) {
        const mode = normalizeMode(body.permissionMode);
        const refusal = modeRefusal(mode, who);
        if (refusal) return { error: refusal, status: 403, remote: true };
        fields.permissionMode = mode;
    }

    // The two that mean "no choice made" when empty, rather than being invalid.
    if (!partial || body.model !== undefined) fields.model = body.model || null;
    if (!partial || body.title !== undefined) fields.title = body.title || null;
    if (!partial || body.test !== undefined) fields.test = !!body.test;

    return { fields };
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------
//
// The firing half of bridge/schedule.js. The store there is deliberately inert —
// it holds rows and answers questions about clocks — because everything that
// actually starts a session needs `pool`, `flags`, `index` and the same refusal
// rules a create call goes through, and all four live here.

// How often to look. Thirty seconds against a schedule whose finest resolution
// is a minute means a slot is noticed within half its own granularity, and the
// check is a `nextSlot` walk per enabled schedule — cheap enough that the
// interval is not worth tuning. Deliberately not a minute: a tick landing on the
// same second as the slot every time would put every schedule on this machine on
// the same instant.
const SCHEDULE_MS = 30_000;

/**
 * Let a development bridge fire, for schedules marked as tests only.
 *
 * Without this the feature is only exercisable on the everyday instance, which is
 * the one thing CLAUDE.md is most insistent nobody touch — so "test it properly"
 * and "do not go near 45888" were in direct conflict, and the way that conflict
 * usually resolves is that nobody tests it.
 *
 * **It is narrow in the direction that matters.** A dev bridge shares
 * `schedules.json` with the everyday one, so an override that simply lifted the
 * gate would have an agent's bridge starting the user's real 2 AM sessions —
 * worse than the problem it solves. With this set, a dev bridge fires *only* rows
 * with `test: true`, which are the ones it made and which stay out of the
 * everyday window anyway.
 *
 * **And the rule is symmetric, which it was not at first.** The everyday instance
 * skips test schedules rather than firing everything: the original guard narrowed
 * a dev bridge and left 45888 running whatever was in the shared file, so a probe
 * schedule created while it was up got run by it — in the user's own checkout.
 * `test` now means "belongs to a development bridge" in both directions, which is
 * what it already meant for a session.
 */
const SCHEDULE_ON_DEV = process.env.CLAUDE_SESSIONS_SCHEDULE_ON_DEV === '1';

/**
 * A schedule as it goes out on the wire.
 *
 * The three derived fields are computed here rather than in the store and rather
 * than in each client, for the reason `draftOut` gives: the desktop, the phone
 * and the Android app must not be able to come to three different answers about
 * when a schedule next runs. `cronText` in particular is not something a client
 * should be reimplementing — `0 2 * * 2-6` is not text anybody should have to
 * decode to check they typed what they meant.
 */
// How many reviewed entries go out on the wire. The store holds up to
// MAX_REVIEWED, and `schedules-changed` fires unprompted — every time a review
// starts or finishes — so sending two hundred entries would be tens of kilobytes
// per push for history no card draws. A tail plus a count says everything the UI
// needs and the full map stays where it is used.
const REVIEWED_ON_WIRE = 20;

function scheduleOut(row) {
    const spec = parseCron(row.cron);
    const reviewedKeys = Object.keys(row.reviewed || {});
    const recent = reviewedKeys
        .sort((a, b) => (row.reviewed[b].at || 0) - (row.reviewed[a].at || 0))
        .slice(0, REVIEWED_ON_WIRE);
    return {
        ...row,
        // **A tail, not the store.** See REVIEWED_ON_WIRE — a client that treated
        // this as the whole map would decide a PR was unreviewed on the strength of
        // it not being in the twenty most recent.
        reviewed: Object.fromEntries(recent.map(k => [k, row.reviewed[k]])),
        reviewedCount: reviewedKeys.length,
        // How many are still going, which is what the card says during a sweep.
        reviewsInFlight: Object.values(row.reviewed || {})
            .filter(e => e.sessionId && !e.outcome).length,
        projectName: projectName(row.cwd),
        cronText: describeCron(spec, { once: row.once }),
        // The same expression as controls rather than as prose, so the dialog can
        // draw a picker without parsing cron in the page. Derived here for the
        // reason above: three clients reading five fields each is three chances
        // to disagree about what `0 2 * * 2-6` selects.
        cronForm: cronForm(spec),
        // Null when the expression can never match again, which is a real answer
        // — `0 0 30 2 *` is a schedule that will never fire — and one the card
        // should be able to say out loud rather than showing a blank.
        nextRunAt: row.enabled ? nextSlot(spec, Date.now()) : null,
    };
}

/** The whole list, which is both the GET body and the SSE payload. */
function schedulesPayload() {
    const rows = schedules.list().map(scheduleOut);
    return {
        at: Date.now(),
        schedules: rows,
        counts: { total: rows.length, enabled: rows.filter(r => r.enabled).length },
    };
}

/**
 * Validate what a schedule write is asking for, exactly as a create would.
 *
 * `draftFields` with three additions, and for the same reason it exists: a
 * schedule you cannot start is worse than a refused save, because nobody is
 * watching at 2 AM to see it fail. So the directory has to exist and be inside
 * the roots here too, and a remote caller is refused the two modes it is refused
 * on creation.
 *
 * That last one matters more here than for a draft. A draft in
 * `bypassPermissions` is a thing somebody has to press Start on; a *schedule* in
 * `bypassPermissions` is an unattended agent with no permission gate, starting
 * itself every night. `modeRefusal` already refuses both modes to a remote
 * caller, so a phone can create an `auto` schedule and not that one — which
 * falls out of the existing rule rather than needing a new one.
 *
 * @returns {{fields: object} | {error: string, status: number, remote?: boolean}}
 */
function scheduleFields(body, who, { partial }) {
    const fields = {};

    if (!partial || body.cwd !== undefined) {
        if (!body.cwd) return { error: 'cwd is required', status: 400 };
        try {
            fields.cwd = resolveWorkdir(String(body.cwd));
        } catch (err) {
            return { error: err.message, status: 400 };
        }
    }

    if (!partial || body.prompt !== undefined) {
        const prompt = body.prompt && String(body.prompt).trim();
        if (!prompt) return { error: 'prompt is required', status: 400 };
        fields.prompt = prompt;
    }

    if (!partial || body.cron !== undefined) {
        if (!body.cron) return { error: 'cron is required', status: 400 };
        const spec = parseCron(String(body.cron));
        if (spec.error) return { error: spec.error, status: 400 };
        // A syntactically fine expression that can never match is still a
        // schedule that will never run, and saying so now is far kinder than a
        // card that sits there for a month saying "next run: never".
        if (nextSlot(spec, Date.now()) === null) {
            return {
                error: `"${spec.text}" parses but never matches a real date`,
                status: 400,
            };
        }
        fields.cron = spec.text;
    }

    if (!partial || body.permissionMode !== undefined) {
        const mode = normalizeMode(body.permissionMode);
        const refusal = modeRefusal(mode, who);
        if (refusal) return { error: refusal, status: 403, remote: true };
        fields.permissionMode = mode;
    }

    // A gate is stored whole or not at all — the store's `cleanGate` drops a
    // half-specified one, so a missing ref is caught here where it can be said
    // rather than silently becoming "no gate".
    if (!partial || body.gate !== undefined) {
        const gate = body.gate;
        if (gate === null || gate === undefined) {
            fields.gate = null;
        } else if (typeof gate !== 'object') {
            return { error: 'gate must be an object or null', status: 400 };
        } else if (gate.kind === 'open-prs') {
            fields.gate = {
                kind: 'open-prs',
                includeDrafts: gate.includeDrafts !== false,
                post: gate.post !== false,
            };
        } else if (gate.kind !== 'git-commits') {
            return {
                error: `unknown gate kind ${JSON.stringify(gate.kind)} — only `
                    + '"git-commits" and "open-prs" are supported',
                status: 400,
            };
        } else if (!gate.ref || !String(gate.ref).trim()) {
            return { error: 'a git-commits gate needs a ref', status: 400 };
        } else {
            fields.gate = {
                kind: 'git-commits',
                ref: String(gate.ref).trim(),
                fetch: gate.fetch !== false,
            };
        }
    }

    // The ones that mean "no choice made" when empty, rather than being invalid.
    if (!partial || body.model !== undefined) fields.model = body.model || null;
    if (!partial || body.title !== undefined) fields.title = body.title || null;
    if (!partial || body.test !== undefined) fields.test = !!body.test;
    if (!partial || body.enabled !== undefined) fields.enabled = body.enabled !== false;
    // Not checked against the expression, deliberately. `once` on `0 2 * * *` is
    // a schedule that runs tomorrow at 2 AM and then switches itself off, which
    // is odd but coherent — and a dated expression *without* the flag is a
    // birthday reminder. Neither is the store's business to refuse.
    if (!partial || body.once !== undefined) fields.once = !!body.once;

    return { fields };
}

/**
 * Sessions this process started from a schedule, so a finished turn can be
 * attributed back.
 *
 * In memory rather than on the row, and only for runs *this* bridge started.
 * The row carries `lastSessionId` for the card to link to, but a verdict may only
 * be recorded by the process that owns the runner — otherwise a dev bridge
 * watching the same file would file a second notification for somebody else's
 * run. Bounded because a long-lived bridge would otherwise accumulate one entry
 * per run forever.
 *
 * The value carries the pull request when there is one, because the GitHub write
 * that follows the turn needs to know its target. **It is not the durable record
 * of that, though** — the reviewed entry on the row is, written at session start,
 * which is what lets a finished review still be attributed after this map has
 * evicted it or a restart has emptied it. See `scheduleOfSession`.
 * @type {Map<string, {scheduleId: string, target: object|null}>}
 */
const scheduledRuns = new Map();
// Raised from 200: a sweep can start a dozen in a night, so the fan-out makes the
// eviction path reachable in a way one-session-per-slot never did.
const SCHEDULED_RUNS_KEPT = 400;

function rememberScheduledRun(sessionId, scheduleId, target = null) {
    scheduledRuns.set(sessionId, { scheduleId, target });
    while (scheduledRuns.size > SCHEDULED_RUNS_KEPT) {
        scheduledRuns.delete(scheduledRuns.keys().next().value);
    }
}

/**
 * Start the session a schedule describes, right now.
 *
 * Shared by the tick and by `POST /api/schedules/:id/run`, which is the whole
 * reason it is a function: "Run now" has to produce a session *identical* to
 * what the clock produces, and the only way to be sure of that is for there to
 * be one path. `POST /api/drafts/:id/start` makes the same argument about the
 * three clients of this API; here the second caller is a timer.
 *
 * `force` is what Run now passes. It skips the gate and does not care about
 * slots — you pressed the button, so something should happen even if there are
 * no new commits — but it does *not* skip `modeRefusal` or the rate limit.
 *
 * `who` is the caller a route was reached by, and **the tick passes `LOCAL_CALLER`
 * rather than nothing.** A schedule firing is the machine acting on its own, which
 * is as local as a caller gets — a schedule saved at the desk in `dontAsk` must
 * still run at 2 AM when there is no request behind it. `modeRefusal` reads
 * `who.remote`, so the tick handing it `null` was a thrown TypeError inside a
 * timer: the slot got claimed, the run never happened, and nothing was recorded
 * against the schedule to say why.
 *
 * @returns {Promise<{ok: true, sessionId: string, prompt: string, facts: object}
 *   | {ok: false, skip: string, error?: string, detail?: string, head?: string}>}
 */
const LOCAL_CALLER = { remote: false, peer: 'the schedule', host: null };

async function runSchedule(row, { force = false, who = LOCAL_CALLER, target = null } = {}) {
    // Re-checked at the moment of spawning, not trusted from write time. The
    // roots are configuration and the mode is the caller's; a directory can be
    // moved after a schedule is saved, and this file is hand-editable. Same
    // reasoning as `POST /api/drafts/:id/start`, and it matters more for a row
    // that may sit unread for months.
    const mode = normalizeMode(row.permissionMode);
    const refusal = modeRefusal(mode, who);
    if (refusal) return { ok: false, skip: 'error', error: refusal };

    try {
        resolveWorkdir(row.cwd);
    } catch (err) {
        return { ok: false, skip: 'error', error: err.message };
    }

    // The gate, and the marker the prompt will be built from.
    //
    // A `target` is a pull request whose range `fireSchedule` has already worked
    // out, so the gate below is skipped entirely: for a PR gate the "has anything
    // changed" question was answered per PR by `unreviewedPulls`, and asking a
    // second time here against `lastMarker` would be asking about the wrong thing.
    let facts = target ? target.facts : { at: Date.now() };
    if (!target && row.gate && row.gate.kind === 'git-commits') {
        const range = await git.commitRange(row.cwd, row.gate.ref, row.lastMarker,
            { fetch: row.gate.fetch });
        if (!range.ok) {
            return {
                ok: false, skip: 'error',
                error: range.error || `cannot read ${row.gate.ref}`,
                detail: range.reason,
            };
        }
        // Nothing new: no session, and — the important half — the marker is
        // left exactly where it was.
        if (!force && range.count === 0) {
            return { ok: false, skip: 'nothing-new', head: range.head };
        }
        // **A forced run with nothing new reviews the tip commit, not nothing.**
        //
        // Run now skips the gate, but skipping the gate alone is not enough:
        // with the marker already at `head`, `{{range}}` comes out as
        // `abc123..abc123` — an empty range — and the session dutifully reports
        // that there is nothing to review. Which makes the button useless in the
        // two cases anybody presses it: checking a schedule works just after
        // setting it up, and asking for a review during a quiet week.
        //
        // Falling back to `head~1..head` is the same thing `fillPrompt` does when
        // there is no marker at all, and it costs nothing: the marker still
        // advances to `head`, which it already was.
        const empty = force && range.count === 0;
        facts = {
            ...facts,
            head: range.head,
            since: (range.staleMarker || empty) ? null : row.lastMarker,
            count: empty ? null : range.count,
            ref: row.gate.ref,
            staleMarker: range.staleMarker,
            fetchError: range.fetchError,
        };
    }

    if (tooManyCreates()) {
        return { ok: false, skip: 'rate-limited',
            error: `more than ${CREATE_LIMIT.max} sessions started in a minute` };
    }

    const prompt = fillPrompt(row.prompt, facts);
    let out;
    try {
        out = pool.create({ cwd: row.cwd, prompt, model: row.model, permissionMode: mode });
    } catch (err) {
        // The marker is untouched, which is the point of doing this in this
        // order: a directory that has moved since you saved the schedule should
        // cost you tonight's run, not the commits it was going to review.
        return { ok: false, skip: 'error', error: err.message };
    }

    if (row.test) flags.set(out.sessionId, { test: true });
    index.note(out.sessionId);
    rememberScheduledRun(out.sessionId, row.id, target);
    return { ok: true, sessionId: out.sessionId, prompt, facts };
}

// ── the pull-request gate ────────────────────────────────────────────────

// How long a slot's review window stays open. A slot does not do all the work
// for a PR gate — twenty concurrent `claude` processes is not a thing to do to a
// laptop at 2 AM, and the create limit would refuse most of them — so it opens a
// window and the batch drains across the ticks that follow. Thirty minutes drains
// far more than any real repository has open, and closes long before the next
// night's slot could collide with it.
const SWEEP_MS = 30 * 60_000;

// Starts per tick, per schedule. The tick is 30s, so two is four a minute —
// comfortably under the create limit even before the reserve below.
const REVIEWS_PER_TICK = 2;

// Concurrent review sessions. Chosen against `MAX_LIVE = 4` in the runner pool
// and the fact that `_evictTo` refuses to evict a *busy* runner: without this cap
// the pool does not bound the fan-out at all, it just quietly grows to one
// `claude` per open pull request. Three leaves the fourth slot for the person
// using the app.
const REVIEWS_IN_FLIGHT = 3;

// Creates a minute kept back for the user. `CREATE_LIMIT` is global, so a sweep
// that spent the whole budget would 429 somebody's own next Start button from a
// limit they never touched.
const CREATE_RESERVE = 2;

/**
 * Pull requests whose range would not resolve, for the sweep they failed in.
 *
 * These are deliberately left *unmarked* in `reviewed` so that the next slot tries
 * them again — a review of the wrong range is worse than a missing one, so a base
 * branch that has been deleted must not be papered over. But "still due" means the
 * drain pass finds it again thirty seconds later, and the first version filed a
 * loud notification each time: about sixty per sweep, per broken pull request,
 * followed by a `sweep-expired` because it never got anywhere.
 *
 * So the failure is remembered for the life of the sweep. Keyed by head SHA as
 * well, so a push that might have fixed it is tried immediately rather than
 * waiting. Cleared when the window closes.
 * @type {Map<string, Set<string>>} scheduleId -> `${key}@${headSha}`
 */
const rangeFailures = new Map();

function noteRangeFailure(scheduleId, key, headSha) {
    if (!rangeFailures.has(scheduleId)) rangeFailures.set(scheduleId, new Set());
    rangeFailures.get(scheduleId).add(`${key}@${headSha}`);
}

const sawRangeFailure = (scheduleId, key, headSha) => Boolean(
    rangeFailures.get(scheduleId)?.has(`${key}@${headSha}`));

// An in-flight review with no outcome that is older than this is not in flight
// any more — its process died with a bridge, or its turn was lost. Without a
// backstop one lost turn would hold a slot in REVIEWS_IN_FLIGHT forever and wedge
// the batch.
const REVIEW_STALE_MS = 2 * 60 * 60_000;

/**
 * The open pull requests a schedule still owes a review, and the repo they are in.
 *
 * @returns {Promise<{ok: boolean, repo: string|null, error: string|null,
 *   pulls: object[], due: object[], openNumbers: number[]}>}
 */
async function pullsForSchedule(row) {
    const repo = await pulls.repoOf(row.cwd);
    if (!repo) {
        return { ok: false, repo: null, pulls: [], due: [], openNumbers: [],
            error: `${row.cwd} has no GitHub origin` };
    }
    const list = await pulls.openPulls(repo);
    if (!list.ok) {
        // **Not a prune, and not an empty batch.** `openPulls` caches a failure
        // for its full TTL, so treating this as "no PRs are open" would look
        // exactly like "everything is reviewed" — and pruning against it would
        // empty the reviewed map and buy a fresh review of the whole repository.
        return { ok: false, repo, pulls: [], due: [], openNumbers: [],
            error: list.error || `cannot list pull requests for ${repo}` };
    }
    const due = unreviewedPulls(list.pulls, row.reviewed, {
        includeDrafts: row.gate.includeDrafts,
    });
    return {
        ok: true, repo, error: null,
        pulls: list.pulls,
        due,
        openNumbers: list.pulls.map(p => p.number),
    };
}

/** How many of this schedule's reviews are still running. */
function reviewsInFlight(row) {
    const now = Date.now();
    let n = 0;
    for (const entry of Object.values(row.reviewed || {})) {
        if (!entry.sessionId || entry.outcome) continue;
        // A lost turn stops counting, or it would hold a slot forever.
        if (now - (entry.at || 0) > REVIEW_STALE_MS) continue;
        const runner = pool.get(entry.sessionId);
        if (runner && runner.state === 'busy') n++;
    }
    return n;
}

/**
 * Work out the diff range for one pull request.
 *
 * **A merge base, and two dots.** Not `origin/<base>..<head>`, which against the
 * *tip* of base includes whatever other people landed on base since this branch
 * diverged — so the review would contain changes the PR did not make. And not
 * three dots either: `A...B` is the right thing for `git diff` and is what
 * GitHub's Files-changed tab shows, but for `git log` the same spelling means the
 * symmetric difference, which is wrong and wrong silently. The prompt is prose and
 * the session may reach for either command, so the range has to mean one thing to
 * both. `mergeBase..head` does.
 *
 * @returns {Promise<{ok: true, range: string, since: string, count: number|null}
 *   | {ok: false, error: string}>}
 */
async function prRange(cwd, pr) {
    // The head has to be reachable locally. `git fetch origin` at the top of the
    // sweep brings down every branch on the remote, which covers every same-repo
    // PR; a fork's head is not there and needs its own ref.
    let have = await git.run('git', ['-C', cwd, 'cat-file', '-e', `${pr.headSha}^{commit}`]);
    if (!have.ok) {
        // Named rather than left in FETCH_HEAD, so the SHA keeps a name that
        // survives the next fetch.
        await git.run('git', ['-C', cwd, 'fetch', '--quiet', '--no-tags', 'origin',
            `pull/${pr.number}/head:refs/claude-sessions/pr/${pr.number}`],
            { timeout: 60_000 });
        have = await git.run('git', ['-C', cwd, 'cat-file', '-e', `${pr.headSha}^{commit}`]);
        if (!have.ok) {
            return { ok: false, error: `cannot reach ${pr.headSha.slice(0, 12)} in ${cwd}` };
        }
    }

    const mb = await git.run('git', ['-C', cwd, 'merge-base',
        `origin/${pr.base}`, pr.headSha]);
    if (!mb.ok) {
        // A base branch that merged and was deleted while the PR stayed open.
        // Deliberately **no fallback to `head~1..head`**: a review of the wrong
        // range is worse than a missing one, and the PR is left unreviewed so it
        // comes back rather than being marked done against a guess.
        return { ok: false, error: `cannot resolve origin/${pr.base} in ${cwd}` };
    }
    const since = mb.stdout.trim();
    const range = `${since.slice(0, 12)}..${pr.headSha.slice(0, 12)}`;

    const counted = await git.run('git', ['-C', cwd, 'rev-list', '--count',
        `${since}..${pr.headSha}`]);
    const count = counted.ok ? Number(counted.stdout.trim()) : null;
    return { ok: true, range, since, count: Number.isFinite(count) ? count : null };
}

/**
 * Resolve the gate, decide what to start, and start as much as the budget allows.
 *
 * The one entry point for both the tick and `POST /api/schedules/:id/run`, which
 * is what keeps "Run now produces what the clock produces" true at the level that
 * matters. For a `git-commits` or ungated row it starts 0 or 1 sessions and the
 * behaviour is exactly what it was before this existed.
 *
 * @returns {Promise<{kind, started: Array<{sessionId, target}>,
 *   skipped: Array<{target, reason, error}>, deferred: number,
 *   remaining: number, gateError: string|null, repo: string|null}>}
 */
async function fireSchedule(row, { force = false, who = LOCAL_CALLER } = {}) {
    const kind = row.gate ? row.gate.kind : null;
    const out = {
        kind, started: [], skipped: [], deferred: 0, remaining: 0,
        gateError: null, repo: null,
    };

    if (kind !== 'open-prs') {
        const one = await runSchedule(row, { force, who });
        if (one.ok) out.started.push({ sessionId: one.sessionId, target: null, facts: one.facts });
        else out.skipped.push({ target: null, reason: one.skip, error: one.error || null });
        return out;
    }

    const found = await pullsForSchedule(row);
    out.repo = found.repo;
    if (!found.ok) {
        out.gateError = found.error;
        out.skipped.push({ target: null, reason: 'error', error: found.error });
        return out;
    }

    // Only on a successful list — see pruneReviews.
    schedules.pruneReviewed(row.id, found.repo, found.openNumbers);

    let due = found.due;
    // Run now with nothing due reviews the most recently updated PR anyway, the
    // same bargain the branch gate strikes: you pressed a button, so something
    // should happen. Commit 5c69146's reasoning, applied to a set.
    if (force && !due.length && found.pulls.length) {
        due = [found.pulls.slice().sort((a, b) =>
            String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]];
    }
    out.remaining = due.length;
    if (!due.length) return out;

    // One fetch for the whole batch rather than one per PR.
    await git.run('git', ['-C', row.cwd, 'fetch', '--quiet', '--no-tags', 'origin'],
        { timeout: 60_000 });

    const inFlight = reviewsInFlight(row);
    let budget = Math.max(0, Math.min(REVIEWS_PER_TICK, REVIEWS_IN_FLIGHT - inFlight));

    for (const pr of due) {
        if (budget <= 0) { out.deferred++; continue; }
        // Peek: `runSchedule` is the one that actually spends it.
        if (tooManyCreates({ reserve: CREATE_RESERVE, peek: true })) {
            out.deferred++;
            continue;
        }

        const key = reviewKey(found.repo, pr.number);
        // Already failed in this sweep at this SHA: still due, deliberately, but
        // not worth saying again every thirty seconds. See rangeFailures.
        if (sawRangeFailure(row.id, key, pr.headSha)) { out.deferred++; continue; }

        const range = await prRange(row.cwd, pr);
        if (!range.ok) {
            // No reviewed entry, so it comes back at the next slot.
            noteRangeFailure(row.id, key, pr.headSha);
            out.skipped.push({ target: pr, reason: 'error', error: range.error });
            continue;
        }

        const one = await runSchedule(row, {
            force, who,
            target: {
                pr,
                repo: found.repo,
                facts: {
                    at: Date.now(),
                    head: pr.headSha,
                    since: range.since,
                    count: range.count,
                    ref: pr.branch,
                    pr: {
                        number: pr.number, url: pr.url, title: pr.title,
                        branch: pr.branch, base: pr.base, author: pr.author,
                        repo: found.repo,
                    },
                },
            },
        });

        if (one.ok) {
            out.started.push({ sessionId: one.sessionId, target: pr, facts: one.facts });
            // **Written at start, not at completion**, and that inversion of this
            // file's usual rule is deliberate. The tick is thirty seconds away and
            // a review takes minutes, so an entry written only on completion means
            // the same PR fires again on every tick until it lands. The crash-after
            // -start case is covered by the boot sweep instead — see
            // recoverInterruptedReviews.
            schedules.noteReview(row.id, key, {
                sha: pr.headSha, at: Date.now(), sessionId: one.sessionId,
                outcome: null, posted: null, postError: null,
            });
            budget--;
        } else {
            out.skipped.push({ target: pr, reason: one.skip, error: one.error || null });
            // A rate limit or a full pool is not this PR's fault; stop starting
            // rather than burning through the rest of the list on the same wall.
            if (one.skip === 'rate-limited') { out.deferred += 1; break; }
        }
    }

    out.deferred = Math.max(0, due.length - out.started.length - out.skipped.length);
    return out;
}

/**
 * One pass over every enabled schedule.
 *
 * **Only the everyday instance fires**, and that guard is the one that actually
 * matters. Several bridges share `schedules.json` by design — the everyday one
 * plus a development bridge per agent working on this codebase — and without
 * this every one of them would spawn the user's 2 AM sessions. `claim()` is the
 * net under it rather than the mechanism.
 *
 * A dev bridge still lists schedules, still edits them, and still honours Run
 * now: that is a press, not a clock.
 */
// One pass at a time.
//
// `tickSchedules` is `await`-heavy — a fetch inside the drain is given sixty
// seconds — and it runs off a thirty-second interval, so two passes overlapping is
// ordinary rather than exotic. Pass one is safe either way because `claim()`
// settles it on disk, but the drain pass has no equivalent: it decides what to
// start from `reviewed`, and the entry for a pull request is only written *after*
// `pool.create` returns. Two overlapping drains could therefore both see the same
// pull request as due, start two review sessions for it, and post two comments.
//
// A boolean rather than a per-schedule lock because the passes are cheap and the
// interval is long: skipping a tick costs thirty seconds of latency on a batch
// that has half an hour, and a lock per schedule would be machinery guarding a
// window this closes entirely.
let ticking = false;

async function tickSchedules() {
    if (cfg.IS_DEV && !SCHEDULE_ON_DEV) return;
    if (ticking) return;
    ticking = true;
    try {
        await runTick();
    } finally {
        ticking = false;
    }
}

async function runTick() {

    // Start from disk. The everyday instance is the only process that fires, and
    // schedules get created and edited on others — so without this, one made from
    // a dev bridge or a phone would sit in the file doing nothing until this
    // process happened to restart. Cheap at 30s intervals, and `reload()` flushes
    // our own pending writes first so nothing in flight is lost.
    schedules.reload();

    const now = Date.now();
    let changed = false;

    for (const row of schedules.enabled()) {
        // **A test schedule belongs to whichever bridge is developing, and to no
        // other.** The rule reads both ways and the first version only wrote one
        // of them: `cfg.IS_DEV && !row.test` narrows a *dev* bridge and does
        // nothing at all on the everyday one, which went on firing everything in
        // the shared file. So a probe schedule created while 45888 was up got run
        // by 45888 — measured, not guessed: it started a session in the user's own
        // checkout. Test *sessions* are hidden from the everyday window; a test
        // schedule should be equally invisible to it, and now is.
        if (cfg.IS_DEV !== !!row.test) continue;

        const spec = parseCron(row.cron);
        if (spec.error) continue;

        // A schedule that has never run counts from when it was created, not
        // from the epoch — otherwise its first tick would owe every slot since
        // 1970 and the walk limit would decide which one it got.
        const cursor = row.lastSlotAt != null ? row.lastSlotAt : row.createdAt;
        const { slot, skipped } = dueSlot(spec, { cursor, now });
        if (slot == null) continue;

        // Past the catch-up cap. Recorded and notified rather than run: a slot
        // from two days ago must not start an unattended agent at a time nobody
        // chose it for, and a schedule that has quietly stopped firing is the
        // failure worth hearing about.
        if (now - slot > CATCHUP_MS) {
            const missed = skipped + 1;
            schedules.note(row.id, {
                slotAt: slot,
                skipReason: 'missed',
                error: `${missed} run${missed === 1 ? '' : 's'} missed — the bridge was `
                    + 'not running',
            });
            fileScheduleNote(row, {
                type: 'schedule-missed',
                summary: `${missed} scheduled run${missed === 1 ? '' : 's'} missed`,
                detail: `"${scheduleTitle(row)}" was due at `
                    + `${new Date(slot).toLocaleString()} and the bridge was not running. `
                    + 'The next run is at its normal time.',
                loud: true,
            });
            changed = true;
            continue;
        }

        // Take the slot before doing anything expensive. A fetch can take
        // seconds, and two ticks overlapping on one schedule would otherwise
        // both get as far as spawning.
        if (!schedules.claim(row.id, slot)) continue;
        changed = true;

        // A pull-request slot opens a window rather than doing the work; the
        // drain pass below picks it up in this same tick.
        if (row.gate && row.gate.kind === 'open-prs') {
            schedules.openSweep(row.id, slot, SWEEP_MS);
            continue;
        }


        // The claim has already been written, so from here every exit has to
        // leave a reason on the row. An unhandled throw between here and the end
        // of the loop consumed the slot and recorded nothing — the schedule
        // simply skipped a night and the card had no idea why. The one that
        // happened was a TypeError in `modeRefusal`; the catch is here so the
        // next one is a visible failure rather than a silent one.
        let result;
        try {
            result = await runSchedule(row);
        } catch (err) {
            result = { ok: false, skip: 'error', error: err.message };
            console.error(`[claude-sessions] schedule ${scheduleTitle(row)} threw: `
                + `${err.stack || err.message}`);
        }

        if (result.ok) {
            schedules.note(row.id, { sessionId: result.sessionId, marker: result.facts.head });
            console.log(`[claude-sessions] schedule ${scheduleTitle(row)} started `
                + `${result.sessionId}`);
        } else {
            // `marker` is deliberately not passed on any of these paths, so a
            // skip or a failure cannot consume the commits it did not review.
            schedules.note(row.id, { skipReason: result.skip, error: result.error || null });
            if (result.skip === 'error') {
                fileScheduleNote(row, {
                    type: 'schedule-failed',
                    summary: 'a scheduled run could not start',
                    detail: `"${scheduleTitle(row)}": ${result.error}`,
                    loud: true,
                });
            }
        }
    }

    // ── pass two: drain any open review window ───────────────────────────
    //
    // Separate from the loop above because it is not about slots. A window may
    // have been opened by this tick or by one twenty minutes ago, and either way
    // the question is the same: what does this schedule still owe, and how much of
    // it may start now. Re-read so a window pass one just opened is seen.
    //
    // **`list()` rather than `enabled()`, because a one-time schedule is disabled
    // by the very slot whose window this is draining.** `claim()` spends a `once`
    // row the moment it takes the slot — deliberately, so a crash cannot leave one
    // armed for a slot it already had — and a PR gate then opens a window that
    // outlives that write by up to half an hour. Walking `enabled()` here would
    // abandon the batch after its first pull request, leave `sweepUntil` set
    // forever, and skip the "N went unreviewed" notification that exists to make
    // exactly that visible. Anything else that is off was turned off by a person,
    // and stays off.
    for (const row of schedules.list()) {
        if (!row.enabled && !(row.once && row.sweepUntil)) continue;
        if (cfg.IS_DEV !== !!row.test) continue;
        if (!row.gate || row.gate.kind !== 'open-prs') continue;
        if (!row.sweepUntil) continue;

        if (now > row.sweepUntil) {
            // Out of time with work left. Said out loud rather than dropped: a cap
            // that truncates silently reads as "everything was reviewed".
            const found = await pullsForSchedule(row).catch(() => null);
            const left = found && found.ok ? found.due.length : 0;
            if (left > 0) {
                schedules.closeSweep(row.id, {
                    skipReason: 'sweep-expired',
                    error: `${left} pull request${left === 1 ? '' : 's'} were not reviewed `
                        + 'before the review window closed',
                });
                fileScheduleNote(row, {
                    type: 'schedule-failed',
                    summary: `${left} pull request${left === 1 ? '' : 's'} went unreviewed`,
                    detail: `"${scheduleTitle(row)}" ran out of its review window with `
                        + `${left} still to do. They will be picked up at the next run.`,
                    loud: true,
                });
            } else {
                schedules.closeSweep(row.id);
            }
            rangeFailures.delete(row.id);
            changed = true;
            continue;
        }

        let swept;
        try {
            swept = await fireSchedule(row);
        } catch (err) {
            swept = null;
            console.error(`[claude-sessions] sweep ${scheduleTitle(row)} threw: `
                + `${err.stack || err.message}`);
            schedules.closeSweep(row.id, { skipReason: 'error', error: err.message });
            changed = true;
            continue;
        }

        if (swept.started.length) {
            changed = true;
            // One `note` per session, not one per tick. `runs` counts sessions, so
            // recording only the last of a fan-out made a card that had just
            // reviewed three pull requests say "1 run". The last call also leaves
            // `lastSessionId` on the newest, which is what the card links to.
            for (const { sessionId, target } of swept.started) {
                console.log(`[claude-sessions] schedule ${scheduleTitle(row)} started `
                    + `${sessionId} for #${target.number}`);
                schedules.note(row.id, { sessionId });
            }
        }

        for (const bad of swept.skipped) {
            changed = true;
            schedules.note(row.id, { skipReason: bad.reason, error: bad.error });
            if (bad.reason !== 'error') continue;
            fileScheduleNote(row, {
                type: 'schedule-failed',
                summary: bad.target
                    ? `#${bad.target.number} could not be reviewed`
                    : 'a scheduled review could not start',
                detail: `"${scheduleTitle(row)}": ${bad.error}`,
                loud: true,
            });
        }

        // Nothing due and nothing deferred: the batch is done and the window can
        // close early rather than sitting open for the rest of its half hour.
        if (!swept.remaining && !swept.deferred) {
            // "Nothing new" is about the *sweep*, not about this tick. The last
            // tick of a successful batch has nothing left to start by definition,
            // so asking only about this tick made a card that had just reviewed
            // three pull requests report that there was nothing to do.
            const workedThisSweep = row.lastFiredAt && row.sweepSlotAt
                && row.lastFiredAt >= row.sweepSlotAt;
            if (!workedThisSweep && !swept.started.length && !swept.skipped.length) {
                schedules.note(row.id, { skipReason: 'nothing-new', error: null });
            }
            schedules.closeSweep(row.id);
            rangeFailures.delete(row.id);
            changed = true;
        }
    }

    if (changed) broadcast('schedules-changed', schedulesPayload());
}

/**
 * Reviews whose process died with a previous bridge.
 *
 * A reviewed entry is written at session start so the fan-out is idempotent —
 * without that, a PR whose review takes minutes would fire again on every
 * thirty-second tick. The cost of writing early is this case: the bridge goes
 * down mid-review, and the entry says the PR was reviewed while nothing was ever
 * posted. Killing a bridge kills its turns, so there is no chance the run is
 * still going.
 *
 * **The SHA is deliberately left in place rather than cleared.** Clearing it is
 * the tidy-looking option and it is the wrong one twice over: a bridge that
 * crashes on startup would re-review the same pull requests every boot, and the
 * review that did run is sitting complete in its transcript — throwing that away
 * to buy a second copy is the expensive direction. Marked `interrupted` with a
 * link instead, which costs one paste and tells the truth.
 */
function recoverInterruptedReviews() {
    let found = 0;
    for (const row of schedules.list()) {
        if (!row.gate || row.gate.kind !== 'open-prs') continue;
        if (cfg.IS_DEV !== !!row.test) continue;
        for (const [key, entry] of Object.entries(row.reviewed || {})) {
            if (!entry.sessionId || entry.outcome || entry.posted) continue;
            found++;
            schedules.noteReview(row.id, key, {
                outcome: 'error', posted: 'interrupted',
                postError: 'the bridge stopped while this review was running',
            });
            fileScheduleNote(row, {
                sessionId: entry.sessionId,
                type: 'schedule-failed',
                summary: `the review of ${key} was interrupted`,
                detail: `"${scheduleTitle(row)}" was reviewing ${key} when the bridge `
                    + 'stopped. Whatever it had written is in the session transcript; it '
                    + 'was not posted, and the pull request will not be reviewed again '
                    + 'unless it gets new commits.',
                loud: true,
            });
        }
    }
    if (found) {
        console.log(`[claude-sessions] ${found} interrupted review(s) marked`);
        broadcast('schedules-changed', schedulesPayload());
    }
}

/** What to call a schedule in a log line or a notification. */
function scheduleTitle(row) {
    return row.title || firstLine(row.prompt).slice(0, 60) || 'a schedule';
}

/**
 * File a notification about a schedule, unless it is a test one.
 *
 * The gate exists because the log's own test filter cannot help here. It asks
 * `flags.get(sessionId).test`, and the rows most worth raising — a missed slot, a
 * ref that would not resolve — have **no session at all**, so `isTest(null)` is
 * false and they read as ordinary. That would put an agent's throwaway probe
 * failing every two minutes into the user's everyday notification list.
 *
 * Checked against the schedule's own flag instead, which is the thing that
 * actually knows. Nothing is lost: a test schedule's failures are visible on its
 * card, on the bridge that owns it, which is where anybody looking for them is.
 */
function fileScheduleNote(row, entry) {
    if (row.test) return;
    filed(notifications.record({ ...entry, title: scheduleTitle(row) }));
}

/** A bounded `?limit=`, so one caller cannot ask for the whole index. */
function limitOf(url, fallback, max) {
    const n = Number(url.searchParams.get('limit'));
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
}

// The brake on handoffs. One per bridge; see bridge/handoff.js for the two
// windows it keeps and why a loop guard is needed at all.
const handoffLimit = new HandoffLimit();

/**
 * Log a remote request, once per minute per source rather than per request.
 *
 * Plan 14-B asks for the source address of every authenticated request when the
 * bridge is reachable from off-machine. Taken literally that is a line per SSE
 * poll, which buries the one line that matters. Per source, per minute, plus every
 * write, keeps it readable and still answers "who has been talking to this bridge".
 */
const remoteSeen = new Map();
function logRemote(req, pathname, who) {
    const writes = req.method !== 'GET';
    const last = remoteSeen.get(who.peer) || 0;
    if (!writes && Date.now() - last < 60_000) return;
    remoteSeen.set(who.peer, Date.now());
    console.log(`[claude-sessions] remote ${req.method} ${pathname} from ${who.peer} `
        + `via ${who.host}`);
}

// How many working-tree files the changes panel is sent. Well past what anybody
// scrolls, and low enough that a `node_modules` somebody forgot to ignore cannot
// turn one panel into a megabyte of JSON.
const CHANGED_FILE_CAP = 400;

async function api(req, res, url, pathname, who) {
    const seg = pathname.split('/').filter(Boolean); // ['api', ...]

    // --- events -----------------------------------------------------------
    if (pathname === '/api/events' && req.method === 'GET') {
        const id = randomUUID();
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const client = { res, subs: new Map(), agent: null, overview: false, taskboard: false };
        clients.set(id, client);
        sseSend(client, 'hello', { clientId: id, version: cfg.VERSION });

        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);
        ping.unref();
        req.on('close', () => { clearInterval(ping); dropClient(id); });
        return;
    }

    if (pathname === '/api/subscribe' && req.method === 'POST') {
        const body = await readJson(req);
        const { clientId, sessionId, offset, agent } = body;
        if (!clients.has(clientId)) return send(res, 404, { error: 'unknown client' });
        const client = clients.get(clientId);

        // The board is a separate follow from the conversation, and orthogonal to
        // it: it stays up while you read one session, and the session keeps
        // tailing while the board is on screen.
        const wants = Boolean(body.overview);
        if (client.overview !== wants) {
            client.overview = wants;
            syncBoard();
            if (wants) sendBoardNow(client);
        }
        // The task board is a third, independent follow, for the same reason.
        // It is not implied by `overview`: the two are different questions and a
        // window is almost never reading both at once.
        const wantsTb = Boolean(body.taskboard);
        if (client.taskboard !== wantsTb) {
            client.taskboard = wantsTb;
            syncTaskboard();
            if (wantsTb) sendTaskboardNow(client);
        }
        // One session in view at a time; drop other follows so we aren't polling
        // transcripts nobody is looking at.
        for (const [sid, sub] of client.subs) {
            if (sid !== sessionId) { stopWatch(sub); client.subs.delete(sid); }
        }
        if (sessionId) startWatch(clientId, sessionId, Number(offset) || 0);

        // The session keeps streaming while a subagent is on screen — switching
        // back should not have to re-read the parent from the top.
        if (agent && agent.toolUseId && sessionId) {
            startAgentWatch(clientId, sessionId, String(agent.toolUseId),
                Number(agent.offset) || 0);
        } else {
            stopAgentWatch(client);
        }
        return send(res, 200, { ok: true });
    }

    // --- health / meta ----------------------------------------------------
    if (pathname === '/api/health') {
        // The one route with no token, so it is also the one route that has to
        // think about what it gives away. Everything below is a count, a pid or a
        // flag — except root/home, which are paths on this machine and are only
        // here for the Windows shell's benefit. It always asks over loopback, so a
        // remote caller can be told less without costing anything.
        const local = !who.remote;
        return send(res, 200, {
            ok: true, app: 'claude-sessions', version: cfg.VERSION,
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
            // Live SSE connections — a quick way to tell whether a UI attached.
            clients: clients.size, runners: Object.keys(pool.statuses()).length,
            terminals: terminals.live().length, runs: runs.live().length,
            // Sessions with a process, from Claude Code's registry — including
            // every one running in a terminal, which no other count here sees.
            live: registry.liveCount, registered: registry.size,
            // Turns in flight. Restarting would end them, so anything that
            // restarts the bridge should look here first.
            busy: pool.busyCount,
            permissionModes: PERMISSION_MODES,
        });
    }

    // Settings, for a caller that wants them fresh rather than as the page was
    // served with them — a settings page saving, or a client checking after the
    // file was edited by hand. `?cwd=` asks what is in force for a project;
    // without it, the user-level answer. Not local-only: reading a preference
    // about how a transcript looks is not a capability a phone should be
    // refused, and prefs.forCwd() runs a cwd through cfg.withinRoots anyway.
    if (pathname === '/api/prefs' && req.method === 'GET') {
        return send(res, 200, prefs.forCwd(url.searchParams.get('cwd') || ''));
    }

    // Which spinner verb groups exist, so the answer to "what may I put in
    // spinner.groups?" is reachable without listing a directory by hand. There
    // is no settings page, so this is the discoverable half of that setting —
    // and where a group that failed to load says why.
    //
    // Not local-only, for the same reason /api/prefs is not: it reports the
    // names and sizes of verb groups, which is not a capability worth refusing
    // a phone. Read-only, like prefs: the files are the interface.
    if (pathname === '/api/spinner/groups' && req.method === 'GET') {
        const cwd = url.searchParams.get('cwd') || '';
        const { groups, problems } = spinner.groups(cwd);
        const settings = prefs.forCwd(cwd).spinner;
        const pool = spinner.pool(cwd);
        return send(res, 200, {
            randomize: settings.randomize,
            rerollMs: settings.rerollMs,
            enabled: settings.groups,
            // What the spinner will actually draw from, which is not the same
            // as `enabled` when a name in settings matches no file.
            pool: pool.verbs.length,
            groups,
            problems: [...problems, ...pool.problems],
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
            worktree: cfg.IS_WORKTREE, busy: pool.busyCount,
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
                ...await restart.blockers(cfg.ROOT, { busy: pool.busyCount }),
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
                console.error(`[claude-sessions] restart: could not start ${restart.SCRIPT}:`,
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

    // --- notification history ---------------------------------------------
    if (pathname === '/api/notifications' && req.method === 'GET') {
        return send(res, 200, {
            // Counted over the whole log rather than over the page below it.
            // The badge used to be worked out client-side from whatever had been
            // fetched, so it quietly saturated at the fetch limit — a number
            // that stops being true when it gets large is worse than no number.
            unread: notifications.countUnread(r => reads.isRead(r), { includeTest: cfg.IS_DEV }),
            read: reads.get(),
            notifications: notifications.list({
                limit: Math.min(Number(url.searchParams.get('limit')) || 200, 1000),
                // 'notable' is the default view: the entries that cleared the bar
                // for interrupting somebody. 'all' also has the quiet ones — a
                // six-second turn, a subagent finishing — which nothing ever
                // notified about but which answer "what has been going on".
                scope: url.searchParams.get('scope') === 'all' ? 'all' : 'notable',
                type: url.searchParams.get('type') || null,
                sessionId: url.searchParams.get('sessionId') || null,
                // Same rule as /api/sessions: a scratch session belongs to the
                // instance that started it.
                includeTest: cfg.IS_DEV,
            // `read` is derived per caller rather than stored on the row: the
            // row is one thing that happened, and whether it is news is a
            // question about the reader. Stamped here so a client need not
            // reimplement the watermark comparison to render a list.
            }).map(row => ({ ...row, read: reads.isRead(row) })),
        });
    }

    if (pathname === '/api/notifications/read' && req.method === 'POST') {
        const body = await readJson(req);
        // `all` and a session id are two different gestures, not one with a flag:
        // opening History says "I have seen everything", opening a chat says "I
        // have seen this conversation". Neither is not a third gesture, so it is
        // refused rather than treated as a no-op — a client that meant to send
        // one and sent nothing should hear about it.
        const wantsAll = body.all === true || Number.isFinite(body.all);
        const sessionId = wantsAll ? null : String(body.sessionId || '');
        if (sessionId === '') {
            return send(res, 400, { error: 'send either {all:true} or {sessionId}' });
        }
        // `all` may name the instant instead of meaning "now", which is what a
        // client migrating an older watermark of its own needs — it knows when it
        // last looked and that is not now. Clamped, because a mark in the future
        // would silence everything filed between here and then, and no honest
        // caller wants that.
        const now = Date.now();
        const at = Number.isFinite(body.all) ? Math.min(Number(body.all), now) : now;
        // `moved` is whether the badge changed, not whether a timestamp did.
        // Every repeat of this call advances the watermark by however long it has
        // been, so a timestamp almost always moves and says nothing; a loud row
        // going from unread to read is the only thing another window would have
        // to repaint for. Every navigation in the UI comes through here, so the
        // difference is a broadcast per rail click against a broadcast per thing
        // actually dealt with.
        const count = () =>
            notifications.countUnread(r => reads.isRead(r), { includeTest: cfg.IS_DEV });
        const before = count();
        if (sessionId === null) reads.markAll(at);
        else reads.markSession(sessionId, at);
        const unread = count();
        const moved = unread !== before;
        if (moved) broadcast('notification-read', { sessionId, at, unread });
        return send(res, 200, { ok: true, moved, unread, read: reads.get() });
    }

    if (pathname === '/api/notifications' && req.method === 'DELETE') {
        notifications.clear();
        broadcast('notifications-cleared', { at: Date.now() });
        return send(res, 200, { ok: true });
    }

    // --- projects & sessions ----------------------------------------------
    if (pathname === '/api/projects' && req.method === 'GET') {
        return send(res, 200, { projects: index.projects() });
    }

    if (pathname === '/api/sessions' && req.method === 'GET') {
        const sessions = index.list({
            query: url.searchParams.get('q') || '',
            project: url.searchParams.get('project') || null,
            limit: Number(url.searchParams.get('limit')) || 500,
            // Scratch sessions an agent started to try something out belong to
            // the instance that started them, not to the window the user leaves
            // open with real work in it.
            includeTest: cfg.IS_DEV,
        });
        const statuses = pool.statuses();
        for (const s of sessions) {
            const st = statuses[s.sessionId];
            // `queued` rides along so the rail can say a session has work waiting
            // even while you are looking at a different one, and `detail` so a
            // row too narrow for the whole label can show the half that matters.
            if (st) {
                s.runner = { state: st.state, activity: st.activity,
                    detail: st.detail, queued: st.queued };
            }
        }
        return send(res, 200, { sessions, ready: index.ready });
    }

    // Who an agent could hand work to. Registered above /api/sessions/:id, or
    // "addressable" would be read as a session id.
    //
    // **The counterpart to /api/peers, and the difference is the whole point.**
    // That route answers "who can receive a message right now", which means live
    // processes with an inbox, because Claude Code's own peer transport needs
    // one. This answers "who could be *given* work", which is nearly everybody:
    // a handoff goes through `pool.ensure`, so an idle session is resumed rather
    // than unreachable. Since MAX_LIVE is 4 and a runner is evicted after
    // fifteen idle minutes, having no process is the normal state of a session
    // and this list is mostly sessions /api/peers cannot see at all.
    //
    // Archived sessions are left out. Filing one away is a statement that it is
    // done, and an agent trawling for somewhere to send work should not reopen
    // it. The route below does not re-check that: an id had to come from
    // somewhere, and refusing one the user named themselves would be worse.
    if (pathname === '/api/sessions/addressable' && req.method === 'GET') {
        const from = url.searchParams.get('from');
        const statuses = pool.statuses();
        const rows = [];
        for (const s of index.list({
            query: url.searchParams.get('q') || '',
            project: url.searchParams.get('project') || null,
            limit: 100_000,
            includeTest: cfg.IS_DEV,
        })) {
            if (s.archived) continue;
            rows.push({
                sessionId: s.sessionId,
                title: s.title,
                cwd: s.cwd,
                projectName: s.projectName,
                // The worktree's short name, not the whole `worktree` object the
                // summary carries — this is a label a model prints in a line, and
                // the rest of that object is about paths it has no use for.
                branch: (s.worktree && s.worktree.name) || s.gitBranch || null,
                lastActive: s.lastTs || null,
                // idle | working | elsewhere — what a handoff would run into, and
                // three answers rather than the taskboard's two. See handoff.js.
                state: handoffState(s, statuses[s.sessionId] || null),
                self: !!from && s.sessionId === from,
            });
        }
        return send(res, 200, {
            sessions: rows.slice(0, limitOf(url, 30, 200)),
            ready: index.ready,
        });
    }

    // Every suggested follow-up, across every session.
    //
    // Until this existed a task was a tool call in one transcript and so was
    // discoverable only while that conversation was open. The offers are now
    // collected by the rescan that already reads every transcript, and the
    // decision beside each one comes off the store it has always lived in.
    //
    // **The offers stay derived.** Nothing here is copied into state this app
    // owns, so deleting a session removes its tasks along with its transcript —
    // see docs/api.md for what that means and why it was chosen.
    if (pathname === '/api/suggestions' && req.method === 'GET') {
        const status = url.searchParams.get('status');
        if (status) {
            const bad = status.split(',').map(v => v.trim()).filter(Boolean)
                .filter(v => !SUGGESTION_STATES.has(v));
            if (bad.length) {
                return send(res, 400, {
                    error: `unknown status ${bad.join(', ')}; `
                        + `expected ${[...SUGGESTION_STATES].join(', ')}`,
                });
            }
        }
        return send(res, 200, {
            suggestions: index.listSuggestions({
                session: url.searchParams.get('session') || null,
                project: url.searchParams.get('project') || null,
                status: status || null,
                limit: Number(url.searchParams.get('limit')) || 500,
                // Same rule as /api/sessions: a scratch session belongs to the
                // instance that started it.
                includeTest: cfg.IS_DEV,
            }),
            ready: index.ready,
        });
    }

    // Who an agent in this session could send a message to.
    //
    // Claude Code gives every live session a name and an inbox, and agents
    // address each other by that name — `SendMessage({to: "<name>"})`, with no
    // other form of address. This route is the list of names that are real,
    // which is what the composer's `@` picker offers.
    //
    // Read out of the registry rather than out of the session index, because
    // they answer different questions. The index knows about transcripts, and
    // filters some of them out — test sessions on the everyday bridge, anything
    // under /tmp. The registry knows about *processes*, and a background agent
    // with no indexed transcript is still perfectly able to receive a message.
    // Titles are joined on from the index where there is one; a peer without one
    // is still listed, because being unnamed here does not make it unreachable.
    if (pathname === '/api/peers' && req.method === 'GET') {
        return send(res, 200, { peers: listPeers(), at: Date.now() });
    }

    // Every live session at once: what it is doing, how far through its tasks it
    // is, and what it is blocked on. State rather than content, which is what
    // makes one payload enough for a screenful of sessions — see overview.js.
    // Pollable by anything; the UI takes it over SSE instead.
    if (pathname === '/api/overview' && req.method === 'GET') {
        return send(res, 200, buildBoard());
    }

    // Everything outstanding at once: open suggested tasks beside every
    // un-archived session, grouped by what state it is in. Derived from what is
    // already in memory and reads no transcripts — see taskboard.js.
    //
    // `?idle=all` drops the recent window on the idle column and returns every
    // un-archived session. Only ever answered here, never pushed: it is what the
    // Show-all button asks for once, and the rows it brings back are idle by
    // definition.
    if (pathname === '/api/taskboard' && req.method === 'GET') {
        return send(res, 200, taskboard.build(index, pool, {
            includeTest: cfg.IS_DEV,
            idle: url.searchParams.get('idle') === 'all' ? 'all' : 'recent',
        }));
    }

    // ── drafts ───────────────────────────────────────────────────────────
    //
    // A session set up but not started. Everything `POST /api/sessions` takes,
    // held in a file until you press Start — see bridge/drafts.js.
    //
    // All five in one block rather than split between the reading and writing
    // halves of this file: it is a small, self-contained surface and the write
    // routes are only interesting next to the read one.
    if (seg[1] === 'drafts') {
        if (!seg[2] && req.method === 'GET') {
            return send(res, 200, draftsPayload());
        }

        if (!seg[2] && req.method === 'POST') {
            const body = await readJson(req);
            const v = draftFields(body, who, { partial: false });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }
            const draft = drafts.create(v.fields);
            // The store says no by returning null rather than by throwing, so
            // the cap is a 409 and not a 500.
            if (!draft) {
                return send(res, 409, {
                    error: `there are already ${MAX_DRAFTS} drafts — start or delete `
                        + 'some before saving another',
                });
            }
            broadcast('drafts-changed', draftsPayload());
            return send(res, 200, { draft: draftOut(draft) });
        }

        if (seg[2] && !seg[3] && req.method === 'PATCH') {
            const body = await readJson(req);
            // Validated *before* the draft is looked up, so a refused mode is a
            // 403 whether or not the id exists. That is the order
            // `POST /api/sessions/:id/send` uses and the reason is the same: the
            // refusal is about what this caller may ask for, not about what it
            // aimed at, so it must not depend on the target being real. Checking
            // existence first made a phone's attempt to escalate an unknown draft
            // a 404, which reads as "wrong id" rather than "not allowed".
            const v = draftFields(body, who, { partial: true });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }
            const draft = drafts.update(seg[2], v.fields);
            if (!draft) return send(res, 404, { error: 'draft not found' });
            broadcast('drafts-changed', draftsPayload());
            return send(res, 200, { draft: draftOut(draft) });
        }

        if (seg[2] && !seg[3] && req.method === 'DELETE') {
            if (!drafts.remove(seg[2])) return send(res, 404, { error: 'draft not found' });
            broadcast('drafts-changed', draftsPayload());
            return send(res, 200, { ok: true, id: seg[2] });
        }

        // Start it, and only then forget it.
        //
        // A server route rather than the client doing create-then-delete,
        // because there are three clients of this API and one of them cannot
        // read this code — the sequence below is not something each should have
        // to get right. It is deliberately the same sequence `POST /api/sessions`
        // runs, including the rate limit, because it *is* that route with its
        // arguments read off a file.
        if (seg[2] && seg[3] === 'start' && req.method === 'POST') {
            const draft = drafts.get(seg[2]);
            if (!draft) return send(res, 404, { error: 'draft not found' });

            // Re-checked at the moment of spawning, not trusted from write time.
            // The roots are configuration and the mode is the caller's: a draft
            // saved locally must not become a way for a phone to start
            // bypassPermissions, and a directory can be moved after it is saved.
            // Normalised on the way out as well as on the way in. The draft was
            // written through `draftFields`, so its mode is already one of the
            // six — but this file is hand-editable and a draft outlives the
            // process that wrote it, so the value reaching `--permission-mode`
            // should not be taken on trust from JSON on disk.
            const mode = normalizeMode(draft.permissionMode);
            const refusal = modeRefusal(mode, who);
            if (refusal) return send(res, 403, { error: refusal, remote: true });

            if (tooManyCreates()) {
                return send(res, 429, {
                    error: `more than ${CREATE_LIMIT.max} sessions started in a minute — `
                        + 'slow down, or start the rest from the machine itself',
                });
            }

            let out;
            try {
                out = pool.create({
                    cwd: draft.cwd,
                    prompt: draft.prompt,
                    model: draft.model,
                    permissionMode: mode,
                });
            } catch (err) {
                // The draft is still there, which is the point of doing this in
                // this order: a directory that has been moved since you saved it
                // should cost you the press, not the message you wrote.
                return send(res, 400, { error: err.message });
            }

            if (draft.test) flags.set(out.sessionId, { test: true });
            index.note(out.sessionId);
            drafts.remove(seg[2]);
            broadcast('drafts-changed', draftsPayload());
            return send(res, 200, { ...out, test: !!draft.test });
        }
    }

    // ── schedules ────────────────────────────────────────────────────────
    //
    // A session that starts on a clock: everything `POST /api/sessions` takes,
    // plus a cron expression and a gate — see bridge/schedule.js.
    //
    // All five in one block, beside drafts and for the same reason: it is a
    // small self-contained surface, and the write routes are only interesting
    // next to the read one.
    if (seg[1] === 'schedules') {
        if (!seg[2] && req.method === 'GET') {
            return send(res, 200, schedulesPayload());
        }

        // What an expression means, without saving anything.
        //
        // The dialog shows "Tue–Sat at 2:00 AM" under the box as you type, and
        // this is where that sentence comes from. A second cron parser in the page
        // could only ever be a way for the page and the bridge to disagree about
        // when a schedule runs — so the process that will actually run it is the
        // one asked. A GET because it changes nothing; before this route existed
        // the page had to attempt a create to find out whether it had typed
        // something valid.
        if (seg[2] === 'describe' && !seg[3] && req.method === 'GET') {
            const text = url.searchParams.get('cron') || '';
            const spec = parseCron(text);
            if (spec.error) return send(res, 400, { error: spec.error });
            const next = nextSlot(spec, Date.now());
            // `once` because the dialog is asking what it is about to save, and a
            // dated expression means two different things with the flag and
            // without it. Read off the query rather than guessed from the shape.
            const once = url.searchParams.get('once') === '1';
            return send(res, 200, {
                cron: spec.text,
                text: describeCron(spec, { once }),
                // The controls that would produce this expression, so a client
                // that has one can select the right row without parsing it.
                form: cronForm(spec),
                // Null is a real answer — `0 0 30 2 *` parses and never matches —
                // and one the dialog says out loud rather than leaving blank.
                next,
            });
        }

        if (!seg[2] && req.method === 'POST') {
            const body = await readJson(req);
            const v = scheduleFields(body, who, { partial: false });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }

            // **Seed the marker before storing, not on the first run.** A gated
            // schedule whose marker starts empty would review the entire history
            // of the repository the first time it fired. Resolving the ref now
            // means the first run covers what arrives after you set it up, which
            // is what "since the prior run" means when there is no prior run.
            //
            // A ref that cannot be resolved is refused rather than seeded empty:
            // a typo'd `orgin/main` should cost you the save, not a month of
            // silent "nothing new".
            if (v.fields.gate && v.fields.gate.kind === 'git-commits') {
                const seed = await git.commitRange(v.fields.cwd, v.fields.gate.ref, null,
                    { fetch: v.fields.gate.fetch });
                if (!seed.ok) {
                    return send(res, 400, {
                        error: seed.error || `cannot resolve ${v.fields.gate.ref}`,
                    });
                }
                v.fields.lastMarker = seed.head;
            }

            // The same seeding for a PR gate, and it matters more: without it,
            // pressing Save starts a review session for every pull request already
            // open — five of them, on a machine where that is a normal number.
            // `seed: "all"` is how you ask for exactly that.
            if (v.fields.gate && v.fields.gate.kind === 'open-prs') {
                const repo = await pulls.repoOf(v.fields.cwd);
                if (!repo) {
                    return send(res, 400, {
                        error: `${v.fields.cwd} has no GitHub origin, so it has no `
                            + 'pull requests to watch',
                    });
                }
                const list = await pulls.openPulls(repo);
                if (!list.ok) {
                    // Refused rather than seeded empty, for the reason a bad ref is
                    // refused: a schedule that cannot see the repository is one that
                    // will report "nothing new" every night and never say why.
                    return send(res, 400, {
                        error: list.error || `cannot list pull requests for ${repo}`,
                    });
                }
                if (String(body.seed || 'skip') !== 'all') {
                    const reviewed = {};
                    for (const pr of list.pulls) {
                        if (!pr.headSha) continue;
                        reviewed[reviewKey(repo, pr.number)] = {
                            sha: pr.headSha, at: Date.now(),
                            sessionId: null, outcome: null, posted: 'seeded', postError: null,
                        };
                    }
                    v.fields.reviewed = reviewed;
                }
            }

            const row = schedules.create(v.fields);
            if (!row) {
                return send(res, 409, {
                    error: `there are already ${MAX_SCHEDULES} schedules — delete `
                        + 'some before adding another',
                });
            }
            broadcast('schedules-changed', schedulesPayload());
            return send(res, 200, { schedule: scheduleOut(row) });
        }

        if (seg[2] && !seg[3] && req.method === 'PATCH') {
            const body = await readJson(req);
            // Validated *before* the schedule is looked up, so a refused mode is
            // a 403 whether or not the id exists — the order
            // `POST /api/drafts/:id` uses, and for the reason given there: the
            // refusal is about what this caller may ask for, not about what it
            // aimed at.
            const v = scheduleFields(body, who, { partial: true });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }

            const before = schedules.get(seg[2]);
            if (!before) return send(res, 404, { error: 'schedule not found' });

            // **The mode already on the row is refused too, not just one in the
            // body.** Checking only what was sent leaves a real hole here that
            // the same check does not leave on a draft: a phone cannot *write*
            // `dontAsk`, but it could send `{enabled: true}` to a paused schedule
            // that already had it, and the local tick would then start an
            // unattended agent with no permission gate. A draft escapes this
            // because the second gate is somebody pressing Start, who is checked
            // in turn; a schedule's second gate is a timer, which is always local.
            //
            // So a remote caller may not touch a schedule it would not be allowed
            // to create. After the lookup rather than before, unavoidably — this
            // one is about the stored row — while the body check above stays
            // first, so "you may not ask for that mode" is still a 403 whether or
            // not the id is real.
            const effective = normalizeMode(
                v.fields.permissionMode !== undefined
                    ? v.fields.permissionMode : before.permissionMode);
            const refusal = modeRefusal(effective, who);
            if (refusal) return send(res, 403, { error: refusal, remote: true });

            // **Repointing the gate, or the checkout, invalidates the marker**, so
            // it has to be reseeded: the stored SHA is on the old ref, and against
            // the new one it is either an ancestor nothing has landed after —
            // "nothing new" forever, a schedule that silently stops reviewing — or
            // a commit on a diverged history, which makes `{{range}}` enormous.
            //
            // Resolved *before* the update, not after. Doing it after means a ref
            // that turns out not to exist leaves the row already edited, pointing
            // somewhere unresolvable, with a marker from the old ref — a 400 that
            // changed something. This way the refusal costs the edit and nothing
            // else, which is the same bargain `POST /api/schedules` strikes.
            const cwd = v.fields.cwd !== undefined ? v.fields.cwd : before.cwd;
            const gate = v.fields.gate !== undefined ? v.fields.gate : before.gate;
            const kind = gate ? gate.kind : null;
            const wasKind = before.gate ? before.gate.kind : null;
            const movedCwd = cwd !== before.cwd;

            let marker = null;
            let reseeded = null;

            // **Branch on the kind, which the first version did not.** It reached
            // for `gate.ref` whatever the gate was, so switching an existing
            // schedule to `open-prs` — which has no ref — called `commitRange` with
            // `undefined` and answered 400 "cannot resolve undefined". The edit
            // dialog could offer that gate and never save it.
            if (kind === 'git-commits'
                && (movedCwd || wasKind !== 'git-commits' || before.gate.ref !== gate.ref)) {
                // Repointing invalidates the marker: it is a SHA on the old ref, and
                // against the new one it is either an ancestor nothing has landed
                // after — "nothing new" forever — or a commit on a diverged history,
                // which makes `{{range}}` enormous. Resolved before the update so a
                // ref that turns out not to exist costs the edit and nothing else.
                const seed = await git.commitRange(cwd, gate.ref, null,
                    { fetch: gate.fetch });
                if (!seed.ok) {
                    return send(res, 400, {
                        error: seed.error || `cannot resolve ${gate.ref}`,
                    });
                }
                marker = seed.head;
            }

            // Becoming a PR gate, or pointing at a different checkout, means the
            // reviewed map describes the wrong repository. Reseeded for the reason
            // the create route seeds: otherwise saving the edit reviews everything
            // already open.
            if (kind === 'open-prs' && (movedCwd || wasKind !== 'open-prs')) {
                const repo = await pulls.repoOf(cwd);
                if (!repo) {
                    return send(res, 400, {
                        error: `${cwd} has no GitHub origin, so it has no pull `
                            + 'requests to watch',
                    });
                }
                const list = await pulls.openPulls(repo);
                if (!list.ok) {
                    return send(res, 400, {
                        error: list.error || `cannot list pull requests for ${repo}`,
                    });
                }
                reseeded = {};
                if (String(body.seed || 'skip') !== 'all') {
                    for (const pr of list.pulls) {
                        if (!pr.headSha) continue;
                        reseeded[reviewKey(repo, pr.number)] = {
                            sha: pr.headSha, at: Date.now(),
                            sessionId: null, outcome: null, posted: 'seeded',
                            postError: null,
                        };
                    }
                }
            }

            const row = schedules.update(seg[2], v.fields);
            if (!row) return send(res, 404, { error: 'schedule not found' });
            if (marker) schedules.note(seg[2], { marker });
            if (reseeded) schedules.setReviewed(seg[2], reseeded);
            // A window belongs to the gate that opened it. Leaving one open across a
            // change of kind meant the drain pass skipped it on the kind guard and
            // nothing ever closed it, so the row carried a stale `sweepUntil`
            // indefinitely.
            if (kind !== wasKind && before.sweepUntil) schedules.closeSweep(seg[2]);

            broadcast('schedules-changed', schedulesPayload());
            return send(res, 200, { schedule: scheduleOut(schedules.get(seg[2])) });
        }

        if (seg[2] && !seg[3] && req.method === 'DELETE') {
            if (!schedules.remove(seg[2])) {
                return send(res, 404, { error: 'schedule not found' });
            }
            broadcast('schedules-changed', schedulesPayload());
            return send(res, 200, { ok: true, id: seg[2] });
        }

        // Run it now, whatever the clock says.
        //
        // The same function the tick calls, which is the point — a run produced
        // by this button has to be identical to one produced by the schedule, and
        // one code path is the only way to be sure. It skips the gate (you
        // pressed the button, so something should happen even with no new
        // commits) and it does not touch `lastSlotAt`, so tonight's scheduled run
        // still happens. It does *not* skip the mode refusal or the rate limit.
        if (seg[2] && seg[3] === 'run' && req.method === 'POST') {
            const row = schedules.get(seg[2]);
            if (!row) return send(res, 404, { error: 'schedule not found' });

            const fired = await fireSchedule(row, { force: true, who });

            if (!fired.started.length) {
                const first = fired.skipped[0]
                    || { reason: 'nothing-new', error: fired.gateError };
                schedules.note(row.id, { skipReason: first.reason, error: first.error || null });
                broadcast('schedules-changed', schedulesPayload());
                // The refusal a remote caller gets is a 403 and says so; a
                // rate limit is a 429; everything else is the directory or the
                // ref, which is a 400 about the request.
                const status = first.reason === 'rate-limited' ? 429
                    : (modeRefusal(normalizeMode(row.permissionMode), who) ? 403 : 400);
                return send(res, status, status === 403
                    ? { error: first.error, remote: true }
                    : { error: first.error || 'nothing to review' });
            }

            // A manual run advances the marker exactly as a scheduled one does.
            // Not doing so would mean pressing Run now caused tonight to review
            // the same commits over again. For a PR gate the per-PR entries were
            // already written by `fireSchedule` at the moment each session started.
            //
            // `note` returns null if the schedule was deleted while this was
            // running, which a gated run makes a real window rather than a
            // theoretical one — a fetch can take the best part of a minute. The
            // sessions have started either way, so their ids must still be
            // reported: answering with a 500 here would tell the caller the run
            // failed while an agent was already working.
            // One per session, so `runs` counts reviews rather than sweeps — see
            // the same loop in tickSchedules.
            const last = fired.started[fired.started.length - 1];
            let updated = null;
            for (const started of fired.started) {
                updated = schedules.note(row.id, {
                    sessionId: started.sessionId,
                    marker: fired.kind === 'open-prs' ? undefined : last.facts.head,
                });
            }

            // A PR sweep that could not start everything keeps its window open so
            // the rest drains on the ticks that follow, rather than waiting for
            // tomorrow's slot. Only on the everyday instance, which is the only one
            // whose tick will come back for it.
            if (fired.kind === 'open-prs' && fired.deferred && !row.sweepUntil) {
                schedules.openSweep(row.id, Date.now(), SWEEP_MS);
            }

            broadcast('schedules-changed', schedulesPayload());
            return send(res, 200, {
                // Singular first, and kept: `web/app.js` and the Android client
                // both read `sessionId`, and a client that has not been updated
                // should get the session it asked for rather than `undefined`.
                // It is the first of `sessionIds` — for a branch gate the only one.
                sessionId: fired.started[0].sessionId,
                sessionIds: fired.started.map(x => x.sessionId),
                deferred: fired.deferred,
                test: !!row.test,
                schedule: updated ? scheduleOut(updated) : null,
            });
        }
    }

    // Work in flight: uncommitted changes and unmerged pull requests, by project.
    // Shells out to git and gh, so it is not on the session list's path — the rail
    // must not wait on GitHub — and everything it reads is cached behind it.
    if (pathname === '/api/dashboard' && req.method === 'GET') {
        const data = await dashboard.build(index, {
            includeTest: cfg.IS_DEV,
            refresh: url.searchParams.get('refresh') === '1',
        });
        // The same live status the rail carries, so a row can say that one of
        // its sessions is working right now rather than looking abandoned.
        const statuses = pool.statuses();
        for (const p of data.projects) {
            for (const w of p.workspaces) {
                for (const s of w.sessions) {
                    const st = statuses[s.sessionId];
                    if (st) {
                        s.runner = { state: st.state, activity: st.activity,
                            detail: st.detail, queued: st.queued };
                    }
                }
            }
        }
        return send(res, 200, data);
    }

    // One PR status per session, for the rail. The same question the conversation
    // header asks about one session, asked about all of them at once — and reduced
    // to a single word each, because a rail row has space for one glyph.
    //
    // Its own route rather than a field on `/api/sessions` for that route's own
    // reason: it shells out to gh and the session list must never wait on GitHub.
    // The rail fetches this after it has painted and colours the glyphs in place.
    if (pathname === '/api/prs' && req.method === 'GET') {
        const sessions = index.list({ limit: 500, includeTest: cfg.IS_DEV })
            .filter(s => s.prs && s.prs.length);

        // A `pr-link` line without a `prRepository` leaves the repo to be read off
        // the session's own checkout, exactly as `/api/sessions/:id/prs` does. Only
        // for the sessions that need it, and once per directory: `repoOf` shells out
        // to git, and most PRs name their own repository.
        const needRepo = [...new Set(sessions
            .filter(s => s.cwd && s.prs.some(p => p && !p.repo))
            .map(s => s.cwd))];
        const repoOfDir = new Map();
        await mapLimit(needRepo, 8, async (dir) => {
            repoOfDir.set(dir, await pulls.repoOf(dir));
        });

        return send(res, 200, await pulls.forSessions(sessions.map(s => ({
            sessionId: s.sessionId,
            prs: s.prs,
            repo: repoOfDir.get(s.cwd) || null,
        }))));
    }

    if (pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readJson(req);
        const cwd = body.cwd && String(body.cwd);
        const prompt = body.prompt && String(body.prompt).trim();
        if (!cwd) return send(res, 400, { error: 'cwd is required' });
        if (!prompt) return send(res, 400, { error: 'prompt is required' });

        const mode = normalizeMode(body.permissionMode);
        const refusal = modeRefusal(mode, who);
        if (refusal) return send(res, 403, { error: refusal, remote: true });

        if (tooManyCreates()) {
            return send(res, 429, {
                error: `more than ${CREATE_LIMIT.max} sessions started in a minute — `
                    + 'slow down, or start the rest from the machine itself',
            });
        }

        try {
            const out = pool.create({
                cwd,
                prompt,
                model: body.model || null,
                permissionMode: mode,
            });
            // Label it before it exists on disk, so it is never briefly visible
            // in the everyday window while the first rescan catches up.
            if (body.test) flags.set(out.sessionId, { test: true });
            index.note(out.sessionId);
            return send(res, 200, { ...out, test: !!body.test });
        } catch (err) {
            return send(res, 400, { error: err.message });
        }
    }

    // /api/sessions/:id[/...]
    if (seg[1] === 'sessions' && seg[2]) {
        const sessionId = seg[2];
        const tail = seg[3];

        if (!tail && req.method === 'GET') {
            const data = index.read(sessionId);
            if (!data) return send(res, 404, { error: 'session not found' });
            const st = pool.statuses()[sessionId];

            // `?tail=N` sends only the last N events, and says how many it left
            // behind so a client can offer to go and get them.
            //
            // For the desktop this would be pointless — it is on loopback and wants
            // the whole conversation anyway. For a phone it is the difference
            // between opening a long session and not: a 60-turn transcript is
            // ~1,800 events and half a megabyte of JSON, over a relay, before
            // anything appears. Slicing here rather than in the client is the whole
            // point; serializing all of it and then throwing most away would save
            // nothing. `offset` is deliberately left as-is — it is a byte position
            // in the file, so the live tail still resumes correctly from it.
            // What was already done about each suggested follow-up in here.
            // Sent whole rather than per event: it is a handful of keys, and a
            // card that arrives on the live tail — after this payload — still
            // needs to know whether it was acted on in another window.
            const acted = suggestions.forSession(sessionId);

            // The settings in force *for this conversation's directory*. The
            // page was served with the user-level answer before it knew which
            // session it was about to show, and a project may override it — so
            // the answer travels with the transcript it applies to, and lands
            // in the same await the client already does before it draws
            // anything. Fetching it separately would be a race the big payload
            // usually wins and sometimes does not.
            const settings = prefs.forCwd(data.summary && data.summary.cwd);

            // `tail=0` is not "no limit", it is "none of them": everything above
            // without the transcript. That is what a polling client wants for the
            // liveness it cannot get from a stream — runner state, the pending ask,
            // the offset to ask `/since` from — at a few hundred bytes rather than
            // half a megabyte. Spelled out rather than relying on `slice(-0)`,
            // which returns the whole array and would make `tail=0` the most
            // expensive call on this route instead of the cheapest.
            // Read as a string first, because `Number(null)` is 0 and the param
            // being absent must not read as "send none of them" — that is the
            // desktop's call, and it wants the whole conversation.
            const asked = url.searchParams.get('tail');
            const want = asked === null ? null : Number(asked);
            if (want !== null && Number.isFinite(want) && want >= 0
                && data.events.length > want) {
                const dropped = data.events.length - want;
                return send(res, 200, {
                    ...data,
                    events: want === 0 ? [] : data.events.slice(-want),
                    truncated: { dropped, total: data.events.length },
                    runner: st || null,
                    suggestions: acted,
                    prefs: settings,
                });
            }
            return send(res, 200, {
                ...data, runner: st || null, suggestions: acted, prefs: settings });
        }

        // Hard delete. Everywhere else in this app "remove" means archive; this
        // is the one place that means it, so it refuses to guess: a session with
        // a turn in flight is not deleted out from under the turn, because the
        // process would keep writing to an unlinked file and the work would be
        // gone with no transcript to show what happened.
        if (!tail && req.method === 'DELETE') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });

            const r = pool.get(sessionId);
            if (r && (r.state === 'busy' || r.state === 'starting')) {
                return send(res, 409, {
                    error: 'a turn is still running — stop it first, then delete',
                });
            }
            await pool.forget(sessionId);
            // The shell was opened on this session's directory and belongs to
            // it; with the session gone there is nothing left to reattach to.
            terminals.closeSession(sessionId);
            // Derived from transcripts that are about to be unlinked, so it goes
            // when they do — the same rule the suggestion cards follow.
            changes.forget(sessionId);

            let removed;
            try { removed = index.remove(sessionId); }
            catch (err) { return send(res, 500, { error: `could not delete: ${err.message}` }); }
            if (!removed) return send(res, 404, { error: 'session not found' });

            // Two events: one for windows showing this conversation, which have
            // to leave it, and the ordinary list refresh for everybody else.
            broadcast('session-deleted', { sessionId, title: summary.title });
            broadcast('sessions-changed', { at: Date.now() });
            return send(res, 200, { ok: true, sessionId, ...removed });
        }

        if (tail === 'since' && req.method === 'GET') {
            const delta = index.readSince(sessionId, Number(url.searchParams.get('offset')) || 0);
            if (!delta) return send(res, 404, { error: 'session not found' });
            return send(res, 200, delta);
        }

        if (tail === 'devservers' && req.method === 'GET') {
            const data = index.read(sessionId);
            if (!data) return send(res, 404, { error: 'session not found' });
            const s = data.summary;
            const candidates = [...devservers.detect(data.events).values()];
            const titles = await devbrowser.titles();
            const out = await devservers.enrich(candidates, titles, {
                workspace: workingDir(s),
                worktreeName: s.worktree && s.worktree.name,
                projectName: s.projectName,
                lastTs: s.lastTs,
            });
            return send(res, 200, out);
        }

        // What this session changed — the two answers, side by side.
        //
        // `edits` comes out of the transcript and is about this session: it holds
        // files it edited and has since committed, and it is still right when the
        // working tree has moved on or gone. `git` is the tree as it stands and is
        // about the directory: it holds work somebody else did, and drops work
        // this session did and reverted. Neither is a better version of the other,
        // which is why both are sent and the panel draws them as two lists.
        //
        // Not on the summary, for `prs`' reason one line further down: it shells
        // out, and the session list must never wait on that.
        if (tail === 'changes' && req.method === 'GET') {
            // The summary, not the transcript: `changes.js` reads the file itself,
            // from wherever it stopped last time. A panel that re-asked on every
            // turn would otherwise re-parse the whole conversation each time, and
            // the transcripts on this machine run to tens of megabytes.
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const rec = index.get(sessionId);
            const dir = workingDir(summary);
            if (url.searchParams.get('refresh') && dir) git.clearCache(dir);

            const tree = dir
                ? await git.statusOf(dir, { limit: CHANGED_FILE_CAP })
                : { ok: false, reason: 'no-directory' };
            // Line counts only where there is a tree to diff. Untracked files are
            // not in `git diff` and stay countless, which is what the UI's "new"
            // already says about them.
            if (tree && tree.ok) {
                const counts = await git.numstat(dir);
                tree.sample = tree.sample.map(f => ({ ...f, ...(counts.get(f.path) || {}) }));
            }

            const derived = changes.forSession(index, sessionId, {
                sessionDir: rec ? path.join(rec.dir, sessionId) : null,
                // The repository root where there is one, so a path reads the same
                // here as it does in the tree list beside it.
                root: (tree && tree.root) || dir,
            });
            if (!derived) return send(res, 404, { error: 'session not found' });

            return send(res, 200, {
                dir,
                checkedAt: new Date().toISOString(),
                git: tree,
                edits: derived.files,
                agents: derived.agents,
                added: derived.added,
                deleted: derived.deleted,
            });
        }

        // The status of the pull requests this session raised.
        //
        // Its own route rather than a field on the summary, because it asks
        // GitHub and the session list must never wait on GitHub — the same reason
        // `/api/dashboard` is not on that path either. The header renders its PRs
        // from the summary immediately and fills the statuses in when this
        // answers, so a slow or absent gh only ever costs the colour.
        if (tail === 'prs' && req.method === 'GET') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });

            // A `pr-link` entry usually names its repository. Where one did not,
            // the session's own directory is the best guess available.
            const list = summary.prs || [];
            const repo = list.some(pr => !pr.repo) && summary.cwd
                ? await pulls.repoOf(summary.cwd)
                : null;

            return send(res, 200, await pulls.forSession(list, repo));
        }

        if (tail === 'subagents' && req.method === 'GET') {
            const agents = index.subagents(sessionId);
            if (!agents) return send(res, 404, { error: 'session not found' });
            return send(res, 200, { agents });
        }

        if (tail === 'subagent' && req.method === 'GET') {
            const toolUseId = url.searchParams.get('toolUseId');
            const from = Number(url.searchParams.get('offset')) || 0;
            const data = index.subagent(sessionId, toolUseId, from);
            if (!data) return send(res, 404, { error: 'subagent transcript not found' });
            return send(res, 200, data);
        }

        if (tail === 'output' && req.method === 'GET') {
            const p = url.searchParams.get('path');
            const data = index.persistedOutput(sessionId, p);
            if (!data) return send(res, 404, { error: 'output not available' });
            return send(res, 200, data);
        }

        if (tail === 'send' && req.method === 'POST') {
            const body = await readJson(req);
            const text = body.text ? String(body.text).trim() : '';
            // A screenshot with nothing typed under it is a real message — "look at
            // this" is the whole content — so an attachment satisfies this on its own.
            if (!text && !(Array.isArray(body.attachments) && body.attachments.length)) {
                return send(res, 400, { error: 'text or an attachment is required' });
            }

            // Sending is also how a mode changes, so the same refusal applies here
            // as on creation — otherwise a phone could start a session in `auto` and
            // escalate it to bypassPermissions with the next message.
            //
            // Checked before the session is looked up, so that the answer does not
            // depend on whether the session exists: a refusal that 404s for an
            // unknown id and 403s for a real one is a way to ask which ids are real.
            const sendMode = normalizeMode(body.permissionMode);
            const sendRefusal = modeRefusal(sendMode, who);
            if (sendRefusal) return send(res, 403, { error: sendRefusal, remote: true });

            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const cwd = sessionCwd(summary);

            // The client is telling us paths it was told a moment ago; this is what
            // makes that safe. Anything that is not in this session's own attachments
            // directory, or is no longer on disk, is dropped rather than refused —
            // losing the whole message because one staged file was tidied away would
            // be the wrong trade.
            let files;
            try {
                files = resolveAttachments(cwd, body.attachments);
            } catch (err) {
                return send(res, 400, { error: err.message });
            }

            const r = pool.ensure(sessionId, {
                cwd,
                model: body.model || null,
                permissionMode: sendMode,
                fork: !!body.fork,
            });
            const entry = r.send(text, files);
            // Which of the two happened matters to the caller: a message that is
            // still queued is safe on this side and will be handed back if the
            // process dies, so the UI only has to hold on to one that went out.
            const status = r.status();
            return send(res, 200, {
                ok: true, id: entry.id, cwd, fork: !!body.fork, status,
                queued: status.queue.some(q => q.id === entry.id),
            });
        }

        // --- handoff -------------------------------------------------------
        // One session telling another something it needs to know, and waking it
        // to deal with it. Reached by `message_session` in bridge/mcp.js.
        //
        // **The wake needed no new machinery.** `pool.ensure` already spawns
        // `claude --resume` when there is no process, so /send has been able to
        // do this since it existed; what was missing was an address an agent
        // could use, since Claude Code's peer names only exist while a process
        // does. So this is /send with four differences, and each is the reason it
        // is not a flag on /send:
        //
        //   * the mode is not the caller's to choose. Forced to `plan`, so a
        //     woken session comes back with a plan for the user instead of
        //     editing a checkout nobody is watching.
        //   * refusals a person would never hit. Handing work to yourself, and
        //     handing it to a session running in a terminal, which /send only
        //     discovers by failing a spawn.
        //   * a rate limit, because the sender is a model and the recipient can
        //     send back. See bridge/handoff.js.
        //   * the message is wrapped, so it renders as work arriving rather than
        //     as something the user typed. See handoffEnvelope in transcript.js.
        //
        // Local callers only — see remoteRefusal.
        if (tail === 'handoff' && req.method === 'POST') {
            const body = await readJson(req);
            const text = body.text ? String(body.text).trim() : '';
            const from = body.from ? String(body.from) : null;
            if (!text) {
                return send(res, 400, {
                    error: 'text is required — say what the other session needs to know.',
                });
            }

            // Before the lookup, as on /send: an answer that depends on whether
            // the session exists is a way to ask which ids are real.
            if (from && from === sessionId) {
                return send(res, 400, {
                    error: 'that is this session. A handoff is for telling another session '
                        + 'something; write it in your own reply instead.',
                });
            }

            const summary = index.summary(sessionId);
            if (!summary) {
                return send(res, 404, {
                    error: 'no session with that id. Use list_sessions to get one — the id '
                        + 'has to come from there, not from a name or a title.',
                });
            }

            // A session held by a terminal, VS Code, or a background agent. Said
            // here rather than left to the spawn, which would fail with the same
            // reason a few seconds later and after a process had been started.
            const st = pool.statuses()[sessionId] || null;
            if (handoffState(summary, st) === 'elsewhere') {
                return send(res, 409, {
                    error: 'that session is running somewhere else — a terminal, or a '
                        + 'background agent — so it cannot be resumed from here. Two writers '
                        + 'cannot append to one transcript. Pick another session, or say what '
                        + 'you found in your reply.',
                });
            }

            const refusal = handoffLimit.refuse(from, sessionId);
            if (refusal) return send(res, 429, { error: refusal });

            const sender = from ? index.summary(from) : null;
            const cwd = sessionCwd(summary);
            // Read before ensure(), which is about to change the answer.
            const woke = wakes(st);

            const r = pool.ensure(sessionId, { cwd, permissionMode: 'plan' });
            const entry = r.send(handoffEnvelope({
                text,
                // Provenance, not authority. The id is whatever the sending
                // session was started as, so a session that later forked reports
                // the one it began with — which is why nothing downstream trusts
                // this to find a session, and why an unknown `from` is carried
                // through rather than refused.
                fromId: from,
                fromTitle: sender ? sender.title : null,
                fromProject: sender ? sender.projectName : null,
                title: body.title ? String(body.title).trim() : null,
            }));
            // A handoff that never landed must not be reported as delivered. The
            // sender is about to finish its turn and tell the user it passed the
            // work on; there is nobody to hand the message back to. So when the
            // send is what started the process, wait briefly to see whether it
            // started. See wakeFailure.
            if (woke) {
                const failure = await wakeFailure(r);
                if (failure) {
                    return send(res, 502, {
                        error: `that session could not be resumed, so nothing was delivered. `
                            + `${failure.message} Say what you found in your reply instead, and `
                            + 'mention that the handoff did not go through.',
                    });
                }
            }

            const status = r.status();
            return send(res, 200, {
                ok: true, id: entry.id, sessionId, cwd, woke, status,
                queued: status.queue.some(q => q.id === entry.id),
            });
        }

        // --- attachments ---------------------------------------------------
        // A file pasted or dropped onto the composer. Written before the message is
        // sent rather than with it: the strip shows real files with real names, the
        // send stays a small JSON POST, and a staged file survives a reload because
        // it is already on disk. See bridge/attachments.js for where it lands.
        if (tail === 'attachments' && !seg[4] && req.method === 'POST') {
            // The name first, before the session is even looked up. It is refused for
            // reasons that have nothing to do with which session asked, and answering
            // "session not found" to a request that also carried `../evil.png` hides
            // the refusal that actually mattered behind an unrelated one.
            const name = url.searchParams.get('name');
            const bad = attachments.attachmentNameProblem(name);
            if (bad) return send(res, 400, { error: bad });

            // And the size, for the same reason and before the same lookup. Answered
            // from Content-Length, so an oversized upload is refused before its bytes
            // travel rather than after.
            if (declaredOverMax(req, attachments.MAX_ATTACHMENT_BYTES)) {
                return refuseUpload(req, res, 413, overMax(attachments.MAX_ATTACHMENT_BYTES));
            }

            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const cwd = sessionCwd(summary);

            const { dir, root } = attachments.attachmentsDirFor(cwd);
            if (!cfg.withinRoots(dir)) {
                return send(res, 403, {
                    error: 'that directory is outside the allowed roots',
                    path: dir, roots: cfg.ALLOWED_ROOTS,
                });
            }

            let buffer;
            try {
                buffer = await readBinary(req, attachments.MAX_ATTACHMENT_BYTES);
            } catch (err) {
                if (err.oversized) return refuseUpload(req, res, err.status, err.message);
                return send(res, err.status || 400, { error: err.message });
            }
            if (!buffer.length) return send(res, 400, { error: 'that file is empty' });

            let written;
            try {
                written = attachments.writeAttachment({ dir, name, buffer });
            } catch (err) {
                if (err.code === 'ENOTDIR') {
                    return send(res, 400, {
                        error: `${dir} exists but is not a directory`,
                    });
                }
                return send(res, 500, { error: `could not save the file: ${err.message}` });
            }

            // After the mkdir, not before: this is the check that catches an
            // attached_assets symlinked out of the roots, which cannot be seen until
            // the directory exists.
            let real = dir;
            try { real = fs.realpathSync(dir); } catch { /* just written; treat as itself */ }
            if (!cfg.withinRoots(real)) {
                try { fs.unlinkSync(written.path); } catch { /* nothing better to do */ }
                return send(res, 403, {
                    error: 'that directory resolves outside the allowed roots',
                    path: real, roots: cfg.ALLOWED_ROOTS,
                });
            }

            attachments.ensureExcluded(root);

            return send(res, 200, {
                ok: true,
                name: written.name,
                renamed: written.renamed,
                path: written.path,
                relPath: attachments.relativeTo(cwd, written.path),
                dir,
                bytes: buffer.length,
                // Sniffed from the bytes, not taken from Content-Type — this is what
                // decides whether the turn carries an inline image block.
                mediaType: attachments.sniffType(buffer, req.headers['content-type']),
            });
        }

        // Open a staged or sent attachment in whatever Windows opens that kind of
        // file with. The path comes from the client, so it is re-derived against this
        // session's own attachments directory before anything is launched — this is
        // the one route here that hands a path to another program.
        if (tail === 'attachments' && seg[4] === 'open' && req.method === 'POST') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const cwd = sessionCwd(summary);
            const body = await readJson(req);

            const file = attachmentPath(cwd, body.path);
            if (!file) {
                return send(res, 404, {
                    error: 'that file is not one of this session\'s attachments',
                });
            }
            const out = await openFile(file);
            return send(res, out.ok ? 200 : 502, { ...out, file });
        }

        if (tail === 'stop' && req.method === 'POST') {
            const r = pool.get(sessionId);
            if (!r) return send(res, 404, { error: 'no live process for this session' });
            const body = await readJson(req);
            // Soft by default: ask the turn to stop rather than killing it, so
            // the session stays resumable. `hard` is the escalation, and the
            // answer says which one actually happened because the outcomes
            // differ enough for the user to care.
            const out = await r.stop({ hard: !!body.hard });
            // Whatever was still queued never reached the process, so it goes
            // back to the composer rather than into the bin.
            return send(res, 200, { ...out, dropped: out.dropped.map(q => q.text) });
        }

        // --- the send queue ------------------------------------------------
        // Messages waiting behind the turn in flight. They live in the runner, so
        // there is nothing to read when no process is live — that is an empty
        // queue, not an error.
        if (tail === 'queue') {
            const r = pool.get(sessionId);
            const qid = seg[4];

            if (req.method === 'GET') {
                const st = r && r.status();
                return send(res, 200, { queue: st ? st.queue : [], status: st || null });
            }

            if (req.method === 'DELETE' && qid) {
                if (!r) return send(res, 404, { error: 'nothing is queued for this session' });
                const removed = r.dequeue(qid);
                // Already written to the process: it cannot be taken back, and
                // saying so beats silently doing nothing.
                if (!removed) return send(res, 409, { error: 'that message has already been sent' });
                return send(res, 200, { ok: true, removed, status: r.status() });
            }

            if (req.method === 'DELETE') {
                if (!r) return send(res, 200, { ok: true, dropped: [] });
                const dropped = r.clearQueue();
                return send(res, 200, { ok: true, dropped, status: r.status() });
            }

            if (req.method === 'POST' && qid === 'reorder') {
                if (!r) return send(res, 404, { error: 'nothing is queued for this session' });
                const body = await readJson(req);
                if (!Array.isArray(body.ids)) return send(res, 400, { error: 'ids must be an array' });
                r.reorder(body.ids.map(String));
                return send(res, 200, { ok: true, status: r.status() });
            }
        }

        // Answer a pending approval. The runner owns the reply channel, so all
        // this does is hand the decision over and let it write.
        if (tail === 'permission' && req.method === 'POST') {
            const r = pool.get(sessionId);
            if (!r) return send(res, 404, { error: 'no live process for this session' });
            const body = await readJson(req);
            const decision = String(body.decision || '');
            if (!['allow', 'allow-always', 'deny'].includes(decision)) {
                return send(res, 400, { error: 'decision must be allow, allow-always or deny' });
            }
            // A plan and a question answer over the same route: the extras are
            // what make them more than yes or no — which mode an approved plan
            // continues in, what to tell the model when it is turned down, and
            // the answers themselves.
            const out = r.answerPermission(String(body.requestId || ''), decision, {
                updatedInput: body.updatedInput && typeof body.updatedInput === 'object'
                    ? body.updatedInput : null,
                answers: body.answers && typeof body.answers === 'object' ? body.answers : null,
                feedback: typeof body.feedback === 'string' ? body.feedback : '',
                mode: PERMISSION_MODES.includes(body.mode) ? body.mode : null,
            });
            // 409 rather than 500: losing the race with another window is an
            // ordinary outcome, not a failure.
            return send(res, out.ok ? 200 : 409, out);
        }

        if (tail === 'flags' && req.method === 'POST') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const body = await readJson(req);
            const next = flags.set(sessionId, {
                pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
                archived: typeof body.archived === 'boolean' ? body.archived : undefined,
                test: typeof body.test === 'boolean' ? body.test : undefined,
            });
            const stopped = next.archived ? archiveStoppedRuns(summary) : 0;
            broadcast('sessions-changed', { at: Date.now() });
            return send(res, 200, { ok: true, sessionId, ...next, runsStopped: stopped });
        }

        // Just the decisions, for a client that has the conversation already and
        // only needs to know what moved. Refetching the whole transcript to
        // learn that one card was dismissed would be megabytes for two fields.
        if (tail === 'suggestions' && !seg[4] && req.method === 'GET') {
            if (!index.summary(sessionId)) return send(res, 404, { error: 'session not found' });
            return send(res, 200, { sessionId, suggestions: suggestions.forSession(sessionId) });
        }

        // What you did about one suggested follow-up.
        //
        // The suggestion itself is never written here — it is a tool call in the
        // transcript and stays the only copy. This records the *decision*, which
        // is the one part of it that is yours: `started`, with the session it
        // produced so the card can become a link, or `dismissed`. Posting with no
        // status takes the decision back and the card offers itself again, which
        // matters because dismiss is the easy one to hit by accident.
        //
        // Broadcast, so a second window showing the same conversation stops
        // offering something that has already been started.
        if (tail === 'suggestions' && seg[4] && req.method === 'POST') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const toolUseId = seg[4];
            const body = await readJson(req);
            const status = body.status == null ? null : String(body.status);

            if (status === null) {
                suggestions.clear(sessionId, toolUseId);
                broadcast('suggestion-changed', { at: Date.now(), sessionId, toolUseId });
                return send(res, 200, { ok: true, sessionId, toolUseId, status: null });
            }
            if (!SUGGESTION_STATUSES.has(status)) {
                return send(res, 400, {
                    error: `status must be one of ${[...SUGGESTION_STATUSES].join(', ')}, `
                        + 'or absent to undo',
                });
            }
            const next = suggestions.set(sessionId, toolUseId, {
                status,
                startedId: typeof body.startedId === 'string' ? body.startedId : null,
            });
            broadcast('suggestion-changed', { at: Date.now(), sessionId, toolUseId });
            return send(res, 200, { ok: true, sessionId, toolUseId, ...next });
        }

        // Show the session's working directory in Windows File Explorer.
        if (tail === 'reveal' && req.method === 'POST') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const dir = workingDir(summary);
            if (!dir) return send(res, 404, { error: 'no directory for this session' });
            const out = await openInExplorer(dir);
            return send(res, out.ok ? 200 : 502, { ...out, dir });
        }

        // Open (or come back to) a shell in the same directory reveal would
        // show. One per session, so the pane reopens where you left it.
        if (tail === 'terminal' && req.method === 'POST') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const dir = workingDir(summary);
            if (!dir) return send(res, 404, { error: 'no directory for this session' });
            const body = await readJson(req);
            try {
                const term = terminals.open({
                    sessionId, cwd: dir, rows: body.rows, cols: body.cols,
                });
                // `cwd` in the answer is the shell's own, which for one started
                // before the session moved is not the directory asked for.
                return send(res, 200, { ...term.info(), sessionCwd: dir });
            } catch (err) {
                return send(res, 409, { error: err.message });
            }
        }
    }

    // --- project commands --------------------------------------------------
    // What a directory declares in .tgxcode/, and the runs started from it. See
    // bridge/commands.js for why reading a file out of a project is new ground,
    // and bridge/runs.js for why a run is a terminal underneath.
    if (seg[1] === 'commands') {
        if (!seg[2] && req.method === 'GET') {
            const dir = url.searchParams.get('cwd');
            if (!dir) return send(res, 400, { error: 'cwd is required' });
            const listed = commands.load(dir);
            if (!listed) return send(res, 403, { error: 'that directory is outside the allowed roots' });
            // The live run travels with the command so one request paints the
            // whole row: a button that does not know it is already running is
            // a button that starts a second server.
            return send(res, 200, {
                ...listed,
                commands: listed.commands.map((c) => {
                    const run = runs.forCommand(listed.workspace, c.id);
                    return { ...c, run: run ? run.info() : null };
                }),
            });
        }

        if (seg[2] === 'run' && req.method === 'POST') {
            const body = await readJson(req);
            if (!body.cwd || !body.id) return send(res, 400, { error: 'cwd and id are required' });
            if (!cfg.withinRoots(body.cwd)) {
                return send(res, 403, { error: 'that directory is outside the allowed roots' });
            }
            const out = await runs.start(body.cwd, body.id);
            if (out.error) {
                return send(res, out.status || 400,
                    { error: out.error, run: out.run ? out.run.info() : undefined });
            }
            return send(res, 200, { run: out.run.info() });
        }
    }

    if (seg[1] === 'runs') {
        if (!seg[2] && req.method === 'GET') return send(res, 200, { runs: runs.list() });

        if (seg[2]) {
            const run = runs.get(seg[2]);
            if (!run) return send(res, 404, { error: 'no such run' });
            const tail = seg[3];

            if (!tail && req.method === 'GET') return send(res, 200, { run: run.info() });

            // The same byte pipe a terminal uses, for the same reason.
            if (tail === 'stream' && req.method === 'GET') {
                return streamBytes(req, res, run.term, run.info());
            }

            if (tail === 'input' && req.method === 'POST') {
                const body = await readJson(req);
                if (typeof body.b64 !== 'string') return send(res, 400, { error: 'b64 is required' });
                // Writable on purpose: vite's `r`, jest's watch keys, and Ctrl-C
                // as a gentler stop than the SIGHUP the stop button sends.
                const ok = run.term.write(Buffer.from(body.b64, 'base64'));
                return send(res, 200, { ok, exited: run.term.exited });
            }

            if (tail === 'resize' && req.method === 'POST') {
                const body = await readJson(req);
                run.term.resize(body.rows, body.cols);
                return send(res, 200, { ok: true, rows: run.term.rows, cols: run.term.cols });
            }

            if (tail === 'stop' && req.method === 'POST') {
                return send(res, 200, { ok: runs.stop(run.id), run: run.info() });
            }

            // Forgetting is not stopping. Conflating them is how somebody kills
            // a dev server by tidying a list.
            if (!tail && req.method === 'DELETE') {
                if (!run.exitedAt) {
                    return send(res, 409, { error: 'still running — stop it first', run: run.info() });
                }
                return send(res, 200, { ok: runs.forget(run.id) });
            }
        }
    }

    // --- terminals ---------------------------------------------------------
    // Keyed by terminal rather than by session so a pane keeps talking to the
    // shell it opened even if the session list moves underneath it.
    if (seg[1] === 'terminals' && seg[2]) {
        const term = terminals.get(seg[2]);
        if (!term) return send(res, 404, { error: 'no such terminal' });
        const tail = seg[3];

        // Its own stream, not the app's SSE channel: this is a byte pipe that
        // can move megabytes when a build is noisy, and it has no business
        // sharing a connection with transcript tailing.
        if (tail === 'stream' && req.method === 'GET') return streamBytes(req, res, term, term.info());

        if (tail === 'input' && req.method === 'POST') {
            const body = await readJson(req);
            // Base64 both ways: a keystroke is bytes, and half a multi-byte
            // character is a legitimate thing to send on its own.
            if (typeof body.b64 !== 'string') return send(res, 400, { error: 'b64 is required' });
            const ok = term.write(Buffer.from(body.b64, 'base64'));
            // The shell exiting while you were mid-keystroke is ordinary, and
            // the pane already knows from the exit event — say so, don't fail.
            return send(res, 200, { ok, exited: term.exited });
        }

        if (tail === 'resize' && req.method === 'POST') {
            const body = await readJson(req);
            term.resize(body.rows, body.cols);
            return send(res, 200, { ok: true, rows: term.rows, cols: term.cols });
        }

        if (!tail && req.method === 'DELETE') {
            terminals.close(term.id);
            return send(res, 200, { ok: true });
        }
    }

    // --- dev servers -------------------------------------------------------
    // Both of these are keyed by port, not by session: the chip is offered
    // because this session started the server, but what answers on the port —
    // and what ends up killed — is whoever holds the socket now, which is the
    // only thing that can be checked for real.

    // Who holds a port, so a chip about to stop one can say whose process it is.
    // Ports get reused across worktrees; the pid and command line are the only
    // things that tell you the server is still the one you meant.
    if (pathname === '/api/devservers/owner' && req.method === 'GET') {
        const port = Number(url.searchParams.get('port'));
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            return send(res, 400, { error: 'invalid port' });
        }
        const [owners, listening] = await Promise.all([
            devservers.owners(port), devservers.isListening(port),
        ]);
        return send(res, 200, { port, listening, owners });
    }

    if (pathname === '/api/devservers/stop' && req.method === 'POST') {
        const body = await readJson(req);
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            return send(res, 400, { error: 'invalid port' });
        }
        // The same list that keeps a port out of the chip row keeps it from being
        // killed through one — this bridge's own port included.
        if (cfg.PORT_DENYLIST.has(port)) {
            return send(res, 403, { error: `:${port} is not a dev server this app will stop` });
        }
        const out = await devservers.stop(port);
        if (out.ok) return send(res, 200, out);
        return send(res, STOP_STATUS[out.reason] || 502, { ...out, error: stopMessage(out, port) });
    }

    // --- devbrowser --------------------------------------------------------
    if (pathname === '/api/devbrowser/status' && req.method === 'GET') {
        const [health, tls] = await Promise.all([devbrowser.health(), devbrowser.titles()]);
        return send(res, 200, { ...health, titles: tls });
    }

    if (pathname === '/api/devbrowser/open' && req.method === 'POST') {
        const body = await readJson(req);
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return send(res, 400, { error: 'invalid port' });
        }
        // Name the tab on the way in when the transcript told us what it is —
        // DevBrowser identifies tabs by port alone, so an unnamed one is just a
        // number in a wall of numbers.
        if (body.title) {
            try { await devbrowser.setTitle(port, String(body.title).slice(0, 64)); } catch { /* best effort */ }
        }
        const out = await devbrowser.openTab(port, body.path || null);
        return send(res, out.ok ? 200 : 502, out);
    }

    if (pathname === '/api/devbrowser/title' && req.method === 'POST') {
        const body = await readJson(req);
        const port = Number(body.port);
        if (!Number.isInteger(port)) return send(res, 400, { error: 'invalid port' });
        const r = await devbrowser.setTitle(port, body.title == null ? null : String(body.title));
        return send(res, r.ok ? 200 : 502, { ok: r.ok });
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

    // --- slash commands (composer completion) ------------------------------
    //
    // Not /api/commands: that is the project's own declared commands, a
    // different feature with a different payload. See bridge/slash-commands.js.
    //
    // Addressed by session or by directory, because both callers exist: the
    // composer knows a session id and nothing else, while a dialog that has not
    // started one yet knows only a path. Answering both here keeps the cwd
    // resolution — which needs the filesystem — on this side.
    if (pathname === '/api/slash-commands' && req.method === 'GET') {
        const session = url.searchParams.get('session');
        let cwd;

        if (session) {
            const summary = index.summary(session);
            if (!summary) return send(res, 404, { error: 'session not found' });
            cwd = sessionCwd(summary);
        } else {
            cwd = cfg.expandHome(url.searchParams.get('cwd') || '');
            if (!cwd) return send(res, 400, { error: 'session or cwd is required' });
            // Same rule as /api/fs: a directory a session could not be started in
            // is one whose commands are not this caller's business either.
            if (!cfg.withinRoots(cwd)) {
                return send(res, 403, {
                    error: 'that directory is outside the allowed roots',
                    path: path.resolve(cwd),
                    roots: cfg.ALLOWED_ROOTS,
                });
            }
        }

        // Never a 404 for "nothing recorded yet": an empty list is a real answer,
        // and it lets the menu say so quietly instead of raising an error at
        // somebody who only pressed a key.
        return send(res, 200, slashCommands.for(cwd));
    }

    // --- filesystem (new-session directory picker) -------------------------
    if (pathname === '/api/fs' && req.method === 'GET') {
        const dir = url.searchParams.get('path') || cfg.HOME;
        // This exists for the new-session directory picker, and a session can only
        // start inside the allowed roots — so listing outside them offers a choice
        // that cannot be taken, on top of enumerating the machine to a caller who
        // has no business doing so.
        if (!cfg.withinRoots(dir)) {
            return send(res, 403, {
                error: 'that directory is outside the allowed roots',
                path: path.resolve(dir),
                roots: cfg.ALLOWED_ROOTS,
            });
        }
        return send(res, 200, listDir(dir));
    }

    // Somewhere to put a project that does not exist yet. The picker can navigate,
    // so this only ever has to make one directory in a place you are already
    // standing — which is why the body is {parent, name} rather than one joined
    // path. A separate `name` can be refused outright for containing a separator,
    // instead of being sanitised after the fact and hoping nothing was missed.
    if (pathname === '/api/fs/mkdir' && req.method === 'POST') {
        const body = await readJson(req);
        const parent = cfg.expandHome(body.parent || '');
        const name = String(body.name == null ? '' : body.name).trim();

        if (!parent) return send(res, 400, { error: 'parent is required' });
        if (!cfg.withinRoots(parent)) {
            return send(res, 403, {
                error: 'that directory is outside the allowed roots',
                path: path.resolve(parent),
                roots: cfg.ALLOWED_ROOTS,
            });
        }

        // Asked before mkdir so a missing or file-shaped parent is a sentence
        // rather than a bare ENOENT/ENOTDIR arriving from two layers down.
        if (!isDirectory(parent)) {
            return send(res, 400, { error: `No such directory: ${parent}` });
        }

        const bad = folderNameProblem(name);
        if (bad) return send(res, 400, { error: bad });

        const target = path.join(path.resolve(parent), name);
        // Belt and braces. The separator refusal above already makes this
        // unreachable, and it is still the check that must not be the one that
        // was left out.
        if (!cfg.withinRoots(target)) {
            return send(res, 403, {
                error: 'that directory is outside the allowed roots',
                path: target, roots: cfg.ALLOWED_ROOTS,
            });
        }

        try {
            // Deliberately not recursive: one segment is all the button offers, and
            // a non-recursive mkdir is what makes EEXIST below mean something.
            fs.mkdirSync(target);
            return send(res, 200, { ok: true, path: target, created: true });
        } catch (err) {
            if (err.code === 'EEXIST') {
                // The caller wanted a directory here by this name, and there is
                // one. Saying "already exists" would be technically true and
                // practically unhelpful — so this is idempotent, and the client
                // navigates into it either way.
                let st = null;
                try { st = fs.statSync(target); } catch { /* raced away */ }
                if (st && st.isDirectory()) {
                    return send(res, 200, { ok: true, path: target, created: false });
                }
                return send(res, 409, {
                    error: `${target} already exists and is not a directory`,
                });
            }
            if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
                return send(res, 404, { error: `${parent} is no longer a directory` });
            }
            if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') {
                return send(res, 403, { error: `Not allowed to create a folder in ${parent}` });
            }
            return send(res, 500, { error: err.message });
        }
    }

    return send(res, 404, { error: 'no such endpoint', pathname });
}

/**
 * Where a session's process should run.
 *
 * The transcript's own cwd, unless it has since been deleted — a worktree that
 * has been landed and removed is the common case — in which case the project
 * directory it belonged to, and failing that home. Shared by the send route and
 * by /api/slash-commands so the two can never disagree about which directory a
 * session belongs to; a client cannot work this out for itself, having no way to
 * ask whether a path still exists.
 */
function sessionCwd(summary) {
    if (summary.cwd && fs.existsSync(summary.cwd)) return summary.cwd;
    if (summary.projectCwd && fs.existsSync(summary.projectCwd)) return summary.projectCwd;
    return cfg.HOME;
}

/**
 * One client-supplied attachment path, re-derived against this session's own
 * attachments directory — or null.
 *
 * The client is handing back a path the bridge gave it a moment ago, which is not the
 * same thing as a path the bridge is willing to act on: a different session's id with
 * this session's file, or a path edited in flight, both arrive looking identical. So
 * only the *basename* is taken from the caller and the directory is recomputed here.
 * That leaves nothing for a `..` to traverse out of.
 */
function attachmentPath(cwd, given) {
    const raw = String(given == null ? '' : given);
    if (!raw) return null;
    const name = path.basename(raw);
    if (attachments.attachmentNameProblem(name)) return null;

    const { dir } = attachments.attachmentsDirFor(cwd);
    if (!cfg.withinRoots(dir)) return null;

    const file = path.join(dir, name);
    if (path.dirname(file) !== dir) return null;      // belt and braces
    try {
        if (!fs.statSync(file).isFile()) return null;
    } catch {
        return null;
    }
    return file;
}

/**
 * The attachments a send may carry, in the order the client staged them.
 *
 * A path that no longer resolves is dropped rather than refused. The alternative is
 * losing a message somebody typed because a file they staged was tidied away in the
 * meantime, and the message is worth more than the completeness of its file list.
 */
function resolveAttachments(cwd, given) {
    if (given == null) return [];
    if (!Array.isArray(given)) throw new Error('attachments must be an array');
    if (given.length > attachments.MAX_PER_MESSAGE) {
        throw new Error(`at most ${attachments.MAX_PER_MESSAGE} files per message`);
    }

    const out = [];
    for (const a of given) {
        const file = attachmentPath(cwd, a && (a.path || a.relPath || a));
        if (!file) continue;
        let bytes = 0;
        try { bytes = fs.statSync(file).size; } catch { /* raced; reported as 0 */ }
        out.push({
            path: file,
            name: path.basename(file),
            relPath: attachments.relativeTo(cwd, file),
            // Sniffed from the file on disk rather than believed from the client, for
            // the same reason the upload route sniffs it: this decides whether the turn
            // carries an inline image block, and a wrong answer is a failed turn.
            mediaType: attachments.sniffType(readHead(file), a && a.mediaType),
            bytes,
        });
    }
    return out;
}

/** The first few bytes of a file, for sniffing. Enough for every magic number. */
function readHead(file, n = 16) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(n);
        const read = fs.readSync(fd, buf, 0, n, 0);
        return buf.subarray(0, read);
    } catch {
        return Buffer.alloc(0);
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    }
}

// An unrecognised mode falls back to the app's default rather than erroring: the
// mode is a knob on a request that has real work in it, and refusing the whole
// send over a typo in one field loses the message.
function normalizeMode(mode) {
    return PERMISSION_MODES.includes(mode) ? mode : 'auto';
}

const STOP_STATUS = { protected: 403, 'no-owner': 409, 'not-permitted': 403 };

/** Why a stop did not happen, in words the chip can put in a toast. */
function stopMessage(out, port) {
    if (out.reason === 'protected') return `:${port} is ${out.what} — left alone`;
    if (out.reason === 'no-owner') {
        return out.listening
            ? `Something answers on :${port} but no Linux process owns it — it may be running on Windows`
            : `Nothing is listening on :${port}`;
    }
    if (out.reason === 'not-permitted') return `Not allowed to signal the process on :${port}`;
    return `:${port} is still listening after SIGKILL`;
}

/**
 * Where the agent is working now: its current cwd, which for a session that
 * entered a worktree is the worktree itself. Reveal and the terminal pane both
 * mean this directory when they say "where the session is".
 */
function workingDir(summary) {
    return [summary.cwd, summary.worktree && summary.worktree.path, summary.projectCwd]
        .find(d => d && fs.existsSync(d)) || null;
}

/**
 * Archiving a session stops the commands running in its directory — but only
 * once nothing else is using it.
 *
 * Archiving is how you say you are done with a piece of work, and a dev server
 * for a branch nobody is looking at any more is exactly the thing that ends up
 * holding a port for a week. Runs are keyed by directory rather than by session
 * though, and several sessions share a worktree routinely, so archiving one of
 * three would otherwise pull the server out from under the other two. The last
 * one out turns the lights off.
 *
 * @returns {number} how many runs were stopped
 */
function archiveStoppedRuns(summary) {
    const dir = workingDir(summary);
    // Asked first, and cheap: almost every archive is of a session in a
    // directory nothing is running in, and the scan below is not free.
    if (!dir || !runs.forWorkspace(dir).some(r => !r.exitedAt)) return 0;

    // Compared as strings rather than through workingDir(), which stats up to
    // three paths per session — a few thousand of those on every archive click,
    // to answer a question the recorded paths already answer.
    const others = index.list({ includeTest: true, limit: 1000 }).some(s =>
        s.sessionId !== summary.sessionId && !s.archived
        && (s.cwd === dir || (s.worktree && s.worktree.path === dir) || s.projectCwd === dir));
    if (others) return 0;
    const stopped = runs.stopWorkspace(dir);
    if (stopped) {
        console.log(`[claude-sessions] archived ${summary.sessionId}: stopped ${stopped} run(s) in ${dir}`);
    }
    return stopped;
}

/**
 * Why this is not a usable folder name, or null if it is one.
 *
 * The leading-dot refusal is not prudishness: listDir() hides dotfiles, so a
 * `.foo` created here would be invisible in the very picker that made it. A name
 * the app will not show is worse than a name it will not accept.
 */
function folderNameProblem(name) {
    if (!name) return 'a name is required';
    if (name === '.' || name === '..') return `"${name}" is not a name`;
    if (name.includes('/')) return 'a folder name cannot contain "/" — make one level at a time';
    if (name.includes('\0')) return 'that name contains a null byte';
    if (name.startsWith('.')) return 'names starting with "." are hidden, and the picker would not show it';
    if (Buffer.byteLength(name) > 255) return 'that name is too long';
    return null;
}

/** Does this path exist and is it a directory? Follows symlinks, unlike a Dirent. */
function isDirectory(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

const LIST_CAP = 500;

function listDir(dir) {
    const resolved = path.resolve(cfg.expandHome(dir));
    let entries = [];
    let truncated = false;
    try {
        const all = fs.readdirSync(resolved, { withFileTypes: true })
            .filter(e => !e.name.startsWith('.'))
            // A symlink pointing at a directory reports isDirectory() false, so
            // without the second arm browsing cannot see a project tree that was
            // linked into place — and people do link them in. Only links pay for
            // the stat, and a dangling one drops out of the list by failing it.
            .filter(e => e.isDirectory()
                || (e.isSymbolicLink() && isDirectory(path.join(resolved, e.name))))
            .map(e => ({ name: e.name, path: path.join(resolved, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
        // The cap used to be silent, which reads as "this is all of it". Saying so
        // costs a boolean and stops the picker implying something false.
        truncated = all.length > LIST_CAP;
        entries = all.slice(0, LIST_CAP)
            // Which of these is a project, without having to click in. One stat
            // per row, capped, and all of it local.
            .map(e => ({ ...e, git: fs.existsSync(path.join(e.path, '.git')) }));
    } catch (err) {
        return {
            path: resolved, error: err.message, entries: [],
            parent: path.dirname(resolved), roots: cfg.ALLOWED_ROOTS,
        };
    }
    const isGit = fs.existsSync(path.join(resolved, '.git'));
    // Stop "up" at the edge of the allowed roots rather than offering a step the
    // route above will refuse. A dead end you can see is better than a button that
    // returns 403.
    const up = resolved === '/' ? null : path.dirname(resolved);
    return {
        path: resolved,
        parent: up && cfg.withinRoots(up) ? up : null,
        // The breadcrumb needs to know where the trail stops and what to call the
        // top of it, and when more than one root is configured this is the only
        // way a client can offer the second one at all. Learning the roots by
        // making a request that fails is backwards.
        roots: cfg.ALLOWED_ROOTS,
        isGit,
        truncated,
        entries,
    };
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function send(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > 4 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(new Error('invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

/**
 * The whole body as bytes, for the one route that takes a file rather than JSON.
 *
 * A sibling of readJson rather than a generalisation of it, for two reasons. It
 * needs a *caller-supplied* cap — 25MB for an attachment against readJson's 4MB —
 * and it needs to fail honestly: readJson's rejection reaches the catch-all in
 * `route`, which turns "body too large" into a 500, and that has been the answer
 * for long enough that other routes may be relying on the shape. So the new reader
 * throws a `status` and this route reads it, and readJson is left alone.
 *
 * Content-Length is checked first where the client sent one, so an oversized upload
 * is refused before the bytes travel rather than after.
 */
const overMax = (max) => `that file is larger than the `
    + `${Math.round(max / (1024 * 1024))}MB limit`;

/**
 * Refuse an upload, and hang up on the rest of it.
 *
 * Both halves matter and the order between them is the whole reason this is a function
 * rather than two lines at each caller. Destroying the socket is what stops a client
 * from spending thirty seconds sending a file that has already been refused; doing it
 * before the response has flushed truncates the sentence that says why, which is how
 * an oversized upload came to report a bare `100 Continue` and nothing else. `finish`
 * is the event that says the answer is out.
 */
function refuseUpload(req, res, status, error) {
    res.on('finish', () => req.destroy());
    return send(res, status || 413, { error });
}

/**
 * A Content-Length the caller already told us is too big.
 *
 * Split out so the route can ask *before* it looks a session up. Both refusals can be
 * true of one request, and the size is the more useful of the two to hear: "session not
 * found" in answer to a 40MB upload hides the thing that would still be wrong after
 * the id was fixed.
 */
function declaredOverMax(req, max) {
    const n = Number(req.headers['content-length']);
    return Number.isFinite(n) && n > max;
}

function readBinary(req, max) {
    return new Promise((resolve, reject) => {
        // Paused, not destroyed. Destroying the socket here was the first version and
        // it is wrong in a way worth remembering: the caller still has to write the
        // 413 onto that socket, and a client that sent `Expect: 100-continue` — curl
        // does, for a body this size — then sees the interim 100 and nothing else. It
        // reports "100" as the status and never learns what the limit was. So the
        // stream stops and the route answers; `oversized` tells it to hang up
        // afterwards, since nothing is going to read the rest of the upload.
        const tooBig = () => {
            req.pause();
            reject(Object.assign(new Error(overMax(max)), { status: 413, oversized: true }));
        };

        // Normally already handled by the caller; kept because this function's contract
        // is the cap, not the caller's diligence.
        if (declaredOverMax(req, max)) return tooBig();

        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            // A Content-Length that lied, or a chunked body. Same answer.
            if (size > max) return tooBig();
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
    // The image types the composer will accept and inline, which would otherwise
    // be served as application/octet-stream and ignored. Nothing in web/ is a
    // jpeg today; the table being one short of the set it claims to cover is the
    // kind of gap that only shows up as a broken image months later.
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
};

// The one HTML entry point. There used to be a second, `/m`, serving a
// phone-shaped page; the phone is the native Android app now and `/m` 404s like
// any other path that is not a file.
const PAGES = new Map([
    ['/', 'index.html'],
]);

function serveStatic(req, res, pathname, who) {
    const rel = PAGES.get(pathname) || pathname.replace(/^\/+/, '');
    const file = path.resolve(WEB_DIR, rel);
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
        return send(res, 403, { error: 'forbidden' });
    }
    let body;
    try { body = fs.readFileSync(file); } catch { return send(res, 404, { error: 'not found' }); }

    // Hand our own page its credentials, so opening 127.0.0.1 in a browser — or the
    // Electron shell doing the same — needs no login step. Only for a local
    // navigation to a page of ours: see auth.localPageRequest.
    //
    // Two forms, for two different jobs.
    //
    // The **cookie** is what authenticates. It means nothing in web/ has to change
    // for the UI to keep working: `fetch` defaults to credentials:'same-origin' and
    // EventSource sends same-origin cookies too, so every existing call — including
    // the two SSE streams and the service worker's, which is the one place a header
    // could not have been threaded through — carries it already. It also puts the
    // desktop on exactly the path a paired remote browser uses, not a second one.
    //
    // The **<meta> tag** is not for authentication; it is so the page can *read* the
    // token, which it needs to build the pairing URL for "Connect a phone". An
    // HttpOnly cookie is deliberately unreadable, and that is the right trade for a
    // credential — hence both.
    const headers = {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
    };
    if (file.endsWith('.html')) {
        // Even same-origin: the token is in this response body, and a referrer is
        // the one way it could leave the page by accident.
        headers['Referrer-Policy'] = 'same-origin';
        if (auth.localPageRequest(req)) {
            body = Buffer.from(auth.injectToken(body.toString('utf8')), 'utf8');
            headers['Set-Cookie'] = auth.pairCookie(auth.current(), { secure: who.secure });
        }
        // Settings go to every page, local or not — they are not a credential,
        // and a remote browser renders the same transcript. In the page rather
        // than behind a fetch because the client opens a session synchronously
        // at startup: a transcript drawn before an async answer arrived would
        // stay drawn the wrong way, since nothing re-renders history.
        body = Buffer.from(auth.injectMeta(body.toString('utf8'),
            'cs-prefs', JSON.stringify(prefs.page(''))), 'utf8');
    }
    headers['Content-Length'] = body.length;

    res.writeHead(200, headers);
    res.end(body);
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------
//
// The handshake that gets a browser onto the bridge from off-machine. You open one
// long URL — the token in the query — and it comes back as an HttpOnly cookie and a
// redirect to /. Afterwards nothing carries the token in a URL: fetches send the
// cookie, and so does EventSource, which is the point. EventSource cannot set
// headers, so without a cookie the only way to authenticate a stream is `?token=`
// on the stream's URL, in the page, forever.
//
// The native Android app does not come through here — it stores the token and sends
// `Authorization: Bearer`. It still depends on this URL's *shape*, because pasting
// the link the desktop's "Connect a phone" dialog generates is how the token gets
// onto the device. So the link is the contract even where the handshake is not.
//
// The gate above has already validated the token — /pair is not under /api/, so it
// is checked here rather than there.

function pair(req, res, url, pathname, who) {
    if (pathname === '/pair/forget') {
        res.writeHead(303, {
            Location: '/',
            'Set-Cookie': auth.pairCookie('', { secure: who.secure }),
            'Cache-Control': 'no-store',
        });
        return res.end();
    }

    if (!who.ok) {
        // Deliberately plain, and deliberately not a JSON error: this is a page a
        // person just opened on a phone, and "unauthorized" in a monospace blob
        // tells them nothing about what to do.
        const body = Buffer.from('<!DOCTYPE html><meta charset="utf-8">'
            + '<meta name="viewport" content="width=device-width,initial-scale=1">'
            + '<title>Claude Sessions — pairing failed</title>'
            + '<style>body{font:16px/1.5 system-ui;margin:0;padding:2rem;'
            + 'background:#131314;color:#e8e8e8}code{background:#232325;padding:.15em .4em;'
            + 'border-radius:4px;font-size:.9em}</style>'
            + '<h1>That link did not work</h1>'
            + '<p>The token is missing, mistyped, or from before the bridge last '
            + 'created one.</p>'
            + '<p>Get a fresh link from <b>Connect a phone</b> in the desktop window, '
            + 'or read the token with <code>cat ~/.local/share/claude-sessions/token</code>.</p>',
            'utf8');
        res.writeHead(401, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': body.length,
            'Cache-Control': 'no-store',
        });
        return res.end(body);
    }

    console.log(`[claude-sessions] paired ${who.peer} via ${who.host}`);
    res.writeHead(303, {
        // 303 with the token stripped, so the address bar and history keep the
        // bare / rather than the credential.
        Location: '/',
        'Set-Cookie': auth.pairCookie(auth.current(), { secure: who.secure }),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
    });
    res.end();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Is anyone in a position to answer an approval for this session?
 *
 * Any live SSE client counts, not just one already following this transcript:
 * the card is a session-level thing and a window that is open can be switched to
 * it. With nothing connected there is nobody to ask, and the runner denies —
 * which is exactly what the app did before approvals existed.
 */
pool.hasViewer = () => clients.size > 0;

// And what it says while it works. Every surface that shows a session working
// reads `runner.activity` off one SSE message, so deciding it here is what makes
// all of them — a phone included — agree. See bridge/spinner.js.
pool.thinking = (cwd, last) => spinner.pick(cwd, last);
pool.rerollAfter = (cwd) => spinner.rerollMs(cwd);

index.on('changed', () => broadcast('sessions-changed', { at: Date.now() }));

// A message from another Claude session, noticed in the transcript rather than
// in a process stream — see SessionIndex#rescan for why that is the only place
// it can be noticed. Broadcast as well as logged, so a window already showing
// that conversation does not have to wait for the rail to tell it something
// happened.
index.on('peer-message', (p) => {
    broadcast('peer-message', p);
    filed(notifications.peerMessage(p));
});
// A handoff this bridge delivered. Watched in the transcript rather than reported
// by the route that sent it, for the same reason as above and one more: the route
// knows a message was queued, and this knows it arrived.
index.on('handoff', (h) => {
    broadcast('handoff', h);
    filed(notifications.handoff(h));
});
// A session starting or stopping in a terminal writes nothing to a transcript,
// so the registry is the only thing that notices — the rail would otherwise wait
// for the next thing that happened to change a file.
registry.on('changed', () => broadcast('sessions-changed', { at: Date.now() }));
// Every status carries `busySince`, which is how the log measures a turn — see
// NotificationLog#noteRunner for why the result's own duration will not do.
pool.on('status', (s) => { notifications.noteRunner(s); broadcast('runner-status', s); });
// A card is answered from the board, so the board must not be up to a second
// behind on an ask appearing or being taken away.
pool.on('permission-request', (p) => {
    broadcast('permission-request', p);
    filed(notifications.ask(p));
    tickBoard();
});
pool.on('permission-resolved', (p) => {
    broadcast('permission-resolved', p);
    const row = notifications.resolve(p.requestId, p.outcome);
    if (row) {
        broadcast('notification-resolved',
            { id: row.id, outcome: row.outcome, outcomeAt: row.outcomeAt });
    }
    tickBoard();
});
pool.on('notice', (n) => broadcast('notice', n));
// Every process announces what slash commands its directory has. Recorded so a
// composer can offer them without a process of its own, and broadcast only when
// the list actually moved — otherwise each session start would push an identical
// list to every open window for nothing.
pool.on('init', ({ cwd, init }) => {
    const entry = slashCommands.note(cwd, init);
    if (entry) broadcast('slash-commands', { cwd, at: entry.at });
});
pool.on('turn-complete', (r) => {
    broadcast('turn-complete', r);
    filed(notifications.turn(r));
    noteScheduledOutcome(r);
});

/**
 * Attribute a finished turn back to the schedule that started it.
 *
 * **Only when there was something to see.** Nobody is awake at 2 AM, so the
 * useful signal in the morning is "did anything go wrong", and a notification per
 * clean overnight review is noise that trains you to ignore the ones that
 * matter. So a BLOCK or CONCERNS verdict, or a turn that errored, is loud; a
 * CLEAN one is recorded on the row for the card and says nothing.
 *
 * A schedule can run any prompt, and most will have no verdict at all. That case
 * is "finished, nothing to say" — recorded quietly, never treated as a failure.
 */
function noteScheduledOutcome(r) {
    const found = scheduleOfSession(r.sessionId);
    if (!found) return;
    scheduledRuns.delete(r.sessionId);

    const { row, target } = found;

    const runner = pool.get(r.sessionId);
    const verdict = r.isError ? null : verdictOf(runner && runner.lastResultText);
    const outcome = r.isError ? 'error' : (verdict || 'done');

    schedules.note(row.id, { outcome });
    if (target) {
        schedules.noteReview(row.id, reviewKey(target.repo, target.number), { outcome });
    }
    broadcast('schedules-changed', schedulesPayload());

    const bad = r.isError || verdict === 'BLOCK' || verdict === 'CONCERNS';

    // The GitHub half. Deliberately after the verdict is recorded and before the
    // notification, so a failed post can add to what the notification says.
    if (target) {
        postReviewToPr(row, target, {
            sessionId: r.sessionId, verdict, outcome,
            body: runner && runner.lastResultBody,
        }).catch(err => console.error(
            `[claude-sessions] posting review for #${target.number} threw: ${err.message}`));
        return;   // postReviewToPr files the notification, once it knows the outcome
    }

    if (!bad) return;

    // This one does carry a session, so the log's own test filter would catch it
    // — but it goes through the same gate as the other two so that "is this
    // schedule a test" is answered in one place rather than two ways.
    fileScheduleNote(row, {
        sessionId: r.sessionId,
        type: 'schedule-findings',
        summary: r.isError
            ? 'a scheduled run ended with an error'
            : `a scheduled review came back ${verdict}`,
        detail: r.isError ? r.detail : null,
        loud: true,
    });
}

/**
 * Which schedule — and which pull request — a finished session belonged to.
 *
 * `scheduledRuns` first, then the reviewed map on disk. The in-memory map is
 * faster and carries the resolved target, but it is lost to a restart and evicted
 * past `SCHEDULED_RUNS_KEPT`, and for a PR run that loss is not cosmetic: the
 * review ran, cost money, and its findings would never be posted anywhere. The
 * reviewed entry is written at session *start* precisely so the mapping survives
 * on disk, which makes it the fallback.
 *
 * @returns {{row: object, target: {repo, number, headSha}|null}|null}
 */
function scheduleOfSession(sessionId) {
    const held = scheduledRuns.get(sessionId);
    if (held) {
        const row = schedules.get(held.scheduleId);
        if (!row) return null;   // deleted while its run was in flight
        const t = held.target;
        return {
            row,
            target: t ? { repo: t.repo, number: t.pr.number, headSha: t.pr.headSha } : null,
        };
    }

    for (const row of schedules.list()) {
        if (!row.gate || row.gate.kind !== 'open-prs') continue;
        for (const [key, entry] of Object.entries(row.reviewed || {})) {
            if (entry.sessionId !== sessionId) continue;
            // **Only a review that has not finished.** Matching on the session id
            // alone meant any later turn in that session — you open the review and
            // ask it a follow-up question — was re-attributed to the pull request
            // and posted a second comment with a second relabel. Before the
            // fallback existed the in-memory map had already been deleted, so the
            // function simply returned; the fallback has to reproduce that.
            if (entry.outcome || entry.posted) continue;
            const hash = key.lastIndexOf('#');
            return {
                row,
                target: {
                    repo: key.slice(0, hash),
                    number: Number(key.slice(hash + 1)),
                    headSha: entry.sha,
                },
            };
        }
    }
    return null;
}

/**
 * Put the finished review on the pull request.
 *
 * The governing rule: **the review is the artefact and this is delivery.** It has
 * already been written to a transcript that is not going anywhere, so nothing here
 * ever unwinds the reviewed entry — re-running a whole review session to retry a
 * *post* would spend minutes of somebody's quota re-deriving text that already
 * exists. A failed post is recorded and said out loud instead.
 *
 * A comment is posted whatever the verdict, including CLEAN: on a pull request,
 * "somebody looked at this and found nothing" is information, unlike in a
 * notification where it is noise.
 */
async function postReviewToPr(row, target, { sessionId, verdict, outcome, body }) {
    const key = reviewKey(target.repo, target.number);
    const bad = outcome === 'error' || verdict === 'BLOCK' || verdict === 'CONCERNS';

    // **A test schedule does not touch GitHub.** `SCHEDULE_ON_DEV` exists so a
    // development bridge fires test schedules, and `gh` is authenticated as the
    // same person either way — so without this line, testing this feature comments
    // on the user's real pull requests. `gate.post` is the same switch for an
    // ordinary schedule that wants the reviews without the noise.
    // Null-safe: the gate can be cleared while a review is in flight, and this
    // path runs minutes after it started. Treating an absent gate as "do not post"
    // is the safe reading — a schedule that is no longer a PR schedule has not
    // asked for a comment.
    if (row.test || !row.gate || row.gate.kind !== 'open-prs' || row.gate.post === false) {
        schedules.noteReview(row.id, key, { posted: 'skipped-test' });
        console.log(`[claude-sessions] not posting #${target.number} (`
            + `${row.test ? 'test schedule' : 'posting is off'}); `
            + `verdict ${verdict || outcome}`);
        broadcast('schedules-changed', schedulesPayload());
        // **Still notify.** Not posting is about not writing to somebody else's
        // repository; it is not about keeping the finding from *you*. Returning
        // early here meant a BLOCK on a schedule with posting switched off told
        // nobody anything — the one configuration where the notification is the
        // only way you would ever hear about it.
        if (bad) {
            fileScheduleNote(row, {
                sessionId,
                type: 'schedule-findings',
                summary: `#${target.number} came back ${verdict || outcome}`,
                detail: `"${scheduleTitle(row)}" reviewed #${target.number} and did not `
                    + 'post, because posting is switched off for this schedule.',
                loud: true,
            });
        }
        return;
    }

    let postError = null;
    let commentOk = false;
    if (body) {
        const wrapped = wrapReviewBody(target, body);
        const posted = await pulls.comment(target.repo, target.number, wrapped);
        commentOk = posted.ok;
        if (!posted.ok) postError = posted.error;
    } else {
        postError = 'the review produced no text to post';
    }

    // The label is decoration, so its failure rides along in `postError` for the
    // log and never raises anything of its own — a toast about a label is exactly
    // the kind that teaches you to ignore the ones that matter.
    if (verdict) {
        // The current labels have to be *known*, not assumed. Passing an empty
        // list when the re-list failed would make `setVerdictLabel`'s remove set
        // empty, so a pull request that was BLOCK last week and is CLEAN today
        // would end up wearing both — a contradiction is worse than a missing
        // label, so a list we could not read means the label is left alone.
        pulls.clearCache();
        const fresh = await pulls.openPulls(target.repo);
        const pr = fresh.ok
            ? fresh.pulls.find(x => x.number === target.number) : null;
        if (!pr) {
            const why = fresh.ok
                ? `#${target.number} is no longer open`
                : (fresh.error || 'could not list pull requests');
            console.error(`[claude-sessions] not labelling #${target.number}: ${why}`);
            if (!postError) postError = `label: ${why}`;
        } else {
            const labelled = await pulls.setVerdictLabel(
                target.repo, target.number, verdict, pr.labels);
            if (!labelled.ok) {
                console.error(`[claude-sessions] could not label #${target.number}: `
                    + labelled.error);
                if (!postError) postError = `label: ${labelled.error}`;
            }
        }
    }

    // `posted` tracks the *comment* only. A label that would not go on is noted in
    // `postError` but does not make the delivery a failure — the findings landed,
    // which is the part anybody needs.
    schedules.noteReview(row.id, key, {
        posted: commentOk ? 'ok' : 'failed',
        postError,
    });
    broadcast('schedules-changed', schedulesPayload());

    // Loud when there is something to act on. A comment that would not post is one
    // of those: the review exists and nobody would otherwise know where.
    if (!bad && commentOk) return;
    fileScheduleNote(row, {
        sessionId,
        type: postError ? 'schedule-failed' : 'schedule-findings',
        summary: postError
            ? `#${target.number} was reviewed but the comment did not post`
            : `#${target.number} came back ${verdict || outcome}`,
        detail: postError
            ? `"${scheduleTitle(row)}" reviewed #${target.number} and could not post it: `
                + `${postError}. The review is in the session transcript.`
            : null,
        loud: true,
    });
}

/**
 * The comment as it appears on the pull request.
 *
 * Wrapped rather than posted raw so that a re-review at a new head SHA is legible
 * in the timeline: three bare reports in a row say nothing about which commit each
 * was looking at.
 */
function wrapReviewBody(target, body) {
    const head = String(target.headSha || '').slice(0, 12);
    // 60_000 is `lastResultBody`'s cap, so a body at exactly that length is one
    // the runner cut rather than one that happened to end there.
    const clipped = body.length >= 60_000;
    // Built by concatenation rather than `[...].filter(Boolean).join()`, which is
    // how the blank line after the header got eaten: an empty string is falsy, so
    // the separator was filtered out along with the optional footer — and without
    // it GitHub renders the review's first paragraph *inside* the blockquote, so
    // the opening sentence reads as part of the machine header.
    let out = `> Automated review of \`${head}\`.\n\n${body}`;
    if (clipped) out += '\n\n_Truncated — the full review is in the session transcript._';
    return out;
}
pool.on('failed', (f) => { broadcast('send-failed', f); filed(notifications.sendFailed(f)); });
// Nothing notifies for a subagent finishing; it is logged so that "what has been
// happening" has an answer at all.
pool.on('agent-done', (a) => filed(notifications.agentDone(a)));

/**
 * Tell any open history view about a new row, so it does not have to re-fetch.
 *
 * `read` and `unread` ride along for the same reason the GET carries them: a
 * client that had to derive the badge itself would need the watermarks, and a
 * client that guessed "a new row means one more" would be wrong for a quiet row,
 * for a test session, and for a row filed against a conversation you are already
 * looking at.
 */
function filed(row) {
    if (!row) return;
    broadcast('notification', {
        ...row,
        read: reads.isRead(row),
        unread: notifications.countUnread(r => reads.isRead(r), { includeTest: cfg.IS_DEV }),
    });
}
pool.on('forked', ({ from, to }) => {
    index.note(to);
    broadcast('session-forked', { from, to });
});

let shuttingDown = false;
function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
        const { stillRunning } = pool.shutdown();
        if (stillRunning) {
            console.log(`[claude-sessions] ${stillRunning} turn(s) were in flight and will `
                + 'stop with this process — their transcripts keep whatever was written.');
        }
    } catch { /* nothing to clean */ }
    // Terminals run in their own process groups, so unlike turns they would
    // outlive us if we did not take them with us. A run is the same, and worse
    // if left: its stdout is a pipe nobody is reading any more, so it would fill
    // the buffer, block on write() and go on holding its port while hung.
    try { terminals.shutdown(); } catch { /* nothing to clean */ }
    try { runs.shutdown(); } catch { /* nothing to clean */ }
    // Drafts are written on a 400ms debounce and this process exits 200ms from
    // here, so a draft saved in the last moment before a restart would simply be
    // gone — having been acknowledged with a 200. Worse in one direction than the
    // other: the *deletion* that a start performs is on the same debounce, so
    // losing it means the draft comes back and can be started a second time.
    // flush() merges, so writing here cannot trample another bridge either.
    try { drafts.flush(); } catch { /* nothing to save */ }
    // The same argument, and one case where it is sharper: an unflushed
    // `lastSlotAt` means the slot this bridge just fired is not on disk, so the
    // next bridge up owes it again and the run happens twice. `claim()` flushes
    // for exactly that reason, but an outcome or a skip recorded in the last
    // 400ms before a restart would otherwise be lost.
    try { schedules.flush(); } catch { /* nothing to save */ }
    try { index.stop(); } catch { /* nothing to clean */ }
    try { registry.stop(); } catch { /* nothing to clean */ }
    try { server.close(); } catch { /* already closed */ }
    setTimeout(() => process.exit(code), 200).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// A worktree may never be the everyday instance.
//
// The everyday port is not something anyone chose here: the bridge hands its own
// environment to every session it starts, so `CLAUDE_SESSIONS_PORT=45888` is
// already set for an agent working in a worktree, and `bash bridge/launch.sh`
// there binds the user's port without a port ever being mentioned. What follows
// is worse than a clash — the bind succeeds if the everyday bridge is not up
// yet, /api/health reports `dev: false`, and the Windows shell adopts it. The
// window then looks exactly like the everyday one while serving a branch's UI
// out of a stale worktree.
//
// scripts/dev.js has always refused this, but only for `npm run dev`; the guard
// belongs where the port is bound so that no way of starting a bridge can get
// around it.
if (cfg.PORT === cfg.DEFAULT_PORT && cfg.IS_WORKTREE) {
    console.error(`[claude-sessions] refusing to serve ${cfg.ROOT} on `
        + `${cfg.DEFAULT_PORT} — that is the everyday instance, and this is a `
        + 'worktree.');
    console.error('  Start a development bridge instead: npm run dev, or '
        + `CLAUDE_SESSIONS_PORT=${cfg.DEV_PORT} bash bridge/launch.sh`);
    console.error('  CLAUDE_SESSIONS_PORT is inherited from the bridge that '
        + 'started this session, so unset it rather than trusting it.');
    process.exit(4);
}

// Binding anything but loopback publishes the bridge, and on this machine that
// means publishing it to a /24 shared with the building — AT&T Community Wi-Fi for
// Apartments, with client isolation misconfigured. A token stands in front of it,
// but a token is not a reason to offer the socket to strangers when there is a
// better way: `tailscale serve` reaches a phone from anywhere while the socket stays
// on loopback. So this takes a second, explicit env var, and says what to do
// instead. Plan 14-B asked for a refusal when no token file existed; a token now
// always exists, so the refusal that still earns its place is this one.
if (!auth.hostIsLocal(cfg.HOST.replace(/^\[|\]$/g, '')) && !cfg.ALLOW_REMOTE_BIND) {
    console.error(`[claude-sessions] refusing to bind ${cfg.HOST} — that offers this `
        + 'bridge to the network, and this machine is on a shared apartment subnet.');
    console.error('  For a phone, prefer `tailscale serve` on the Windows host: it '
        + 'reaches you from anywhere and the bridge never leaves loopback.');
    console.error('  See docs/remote.md. To bind anyway, set '
        + 'CLAUDE_SESSIONS_ALLOW_REMOTE_BIND=1.');
    process.exit(5);
}

// Before the socket, so the first request cannot arrive before there is a token to
// check it against.
auth.ensureToken();

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[claude-sessions] port ${cfg.PORT} is already in use — `
            + 'another bridge is probably running.');
        process.exit(3);
    }
    console.error('[claude-sessions] server error:', err.message);
    process.exit(1);
});

server.listen(cfg.PORT, cfg.HOST, async () => {
    console.log(`[claude-sessions] bridge listening on http://${cfg.HOST}:${cfg.PORT}`);
    // Before the index, so the very first summaries it hands out already say
    // what is running rather than guessing at it for one scan.
    registry.start();
    console.log(`[claude-sessions] registry: ${registry.liveCount} of ${registry.size} `
        + 'session(s) still have a process');

    const t0 = Date.now();
    await index.start();
    console.log(`[claude-sessions] indexed ${index.sessions.size} sessions in ${Date.now() - t0}ms`);

    if (cfg.IS_DEV) {
        console.log('[claude-sessions] development instance — the everyday one on '
            + `${cfg.DEFAULT_PORT} is untouched.`);
    }

    // Schedules: catch up first, then keep looking.
    //
    // The pass here is the whole reason a missed run can be reported at all. The
    // bridge is not up continuously — the window closes, the machine sleeps, the
    // nightly restart happens — so a slot that fell while it was down is found on
    // the way back up rather than never. `tickSchedules` treats that pass and
    // every later one identically; catching up is not a second code path.
    //
    // After the index, because firing needs `index.note` and `flags` to be able
    // to keep a brand-new session out of the everyday window.
    if (!cfg.IS_DEV || SCHEDULE_ON_DEV) {
        // The same symmetric rule the tick applies: a dev bridge counts only test
        // schedules, and the everyday one counts only the rest.
        const armed = schedules.enabled()
            .filter(r => cfg.IS_DEV === !!r.test).length;
        if (cfg.IS_DEV) {
            console.log('[claude-sessions] CLAUDE_SESSIONS_SCHEDULE_ON_DEV=1 — this dev '
                + 'bridge will fire schedules marked as tests, and only those.');
        }
        if (armed) {
            console.log(`[claude-sessions] ${armed} schedule(s) armed; `
                + `checking every ${SCHEDULE_MS / 1000}s`);
        }
        // Before the first tick: a review this process cannot own must be marked
        // before the sweep looks at what is still in flight.
        try { recoverInterruptedReviews(); } catch (err) {
            console.error(`[claude-sessions] review recovery failed: ${err.message}`);
        }
        tickSchedules().catch(err => console.error(
            `[claude-sessions] schedule catch-up failed: ${err.message}`));
        // `.unref()` for the reason handoff.js gives: a timer must never be the
        // thing keeping the bridge from exiting.
        setInterval(() => {
            tickSchedules().catch(err => console.error(
                `[claude-sessions] schedule tick failed: ${err.message}`));
        }, SCHEDULE_MS).unref();
    }

    if (!auth.hostIsLocal(cfg.HOST.replace(/^\[|\]$/g, ''))) {
        console.warn(`[claude-sessions] bound ${cfg.HOST} — reachable from the network. `
            + 'Every remote request is logged below.');
    }

    // This port shows up in DevBrowser's detected list; name it so it isn't just
    // another anonymous number in the rail.
    devbrowser.setTitle(cfg.PORT,
        cfg.IS_DEV ? 'Claude Sessions (dev)' : 'Claude Sessions (app)').catch(() => {});
});
