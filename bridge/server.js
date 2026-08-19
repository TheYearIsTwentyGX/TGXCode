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
const { SessionIndex } = require('./sessions');
const { SessionRegistry } = require('./registry');
const { RunnerPool, PERMISSION_MODES } = require('./runner');
const { Flags } = require('./flags');
const { Prefs } = require('./prefs');
const { Suggestions, STATUSES: SUGGESTION_STATUSES } = require('./suggestions');
const { SlashCommandCache } = require('./slash-commands');
const { NotificationLog } = require('./notifications');
const devbrowser = require('./devbrowser');
const tailscale = require('./tailscale');
const devservers = require('./devservers');
const dashboard = require('./dashboard');
const pulls = require('./pulls');
const overview = require('./overview');
const { openInExplorer, openFile } = require('./explorer');
const attachments = require('./attachments');
const { TerminalPool } = require('./terminal');
const commands = require('./commands');
const { RunPool } = require('./runs');

const WEB_DIR = path.join(__dirname, '..', 'web');
const CLIENT_HEADER = 'x-claude-sessions-client';

const flags = new Flags();
// How the person using the app wants it to behave, from their own file and from
// whatever the project they are looking at overrides — see bridge/prefs.js.
const prefs = new Prefs();
// What you did about a suggested follow-up — started it, or waved it away. The
// suggestion itself is in the transcript; only the decision is ours to keep.
const suggestions = new Suggestions();
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
    // The last window watching the board closing is what stops its timer.
    if (c.overview) syncBoard();
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

const board = { timer: null, devTimer: null };

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
    }
}

function buildBoard() {
    return overview.build(index, pool, registry, { includeTest: cfg.IS_DEV });
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
    const ids = buildBoard().sessions.map(s => s.sessionId);
    try {
        if (await overview.refreshDevServers(index, ids)) tickBoard();
    } catch { /* nothing here is worth failing a tick over */ }
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
 *   - **Shutdown** and **stopping a dev server** act on processes the person at the
 *     desk is using, and are trivially a denial of service from anywhere else.
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
 * Refusing at the route rather than in the UI is the point: /m not drawing a button
 * is a courtesy, and this is the rule.
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
    // Attaching a file writes it into a checkout, which is the mkdir clause above.
    //
    // This is the weakest of the refusals on this list and it is worth saying so:
    // a phone taking a photo has nowhere *else* to put it, so "write it on the
    // machine you are sitting at" is advice a phone cannot take. It is refused in
    // v1 because /m has no attach affordance to refuse anything for yet. When it
    // grows one, the answer is a smaller cap for a remote caller — not deleting
    // this line and letting a leaked token write 25MB files into a repo.
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

function tooManyCreates() {
    const now = Date.now();
    CREATE_LIMIT.hits = CREATE_LIMIT.hits.filter(t => now - t < CREATE_LIMIT.windowMs);
    if (CREATE_LIMIT.hits.length >= CREATE_LIMIT.max) return true;
    CREATE_LIMIT.hits.push(now);
    return false;
}

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
        const client = { res, subs: new Map(), agent: null, overview: false };
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

    // --- notification history ---------------------------------------------
    if (pathname === '/api/notifications' && req.method === 'GET') {
        return send(res, 200, {
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
            }),
        });
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
            // even while you are looking at a different one.
            if (st) { s.runner = { state: st.state, activity: st.activity, queued: st.queued }; }
        }
        return send(res, 200, { sessions, ready: index.ready });
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
                    if (st) s.runner = { state: st.state, activity: st.activity, queued: st.queued };
                }
            }
        }
        return send(res, 200, data);
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

            const want = Number(url.searchParams.get('tail'));
            if (Number.isFinite(want) && want > 0 && data.events.length > want) {
                const dropped = data.events.length - want;
                return send(res, 200, {
                    ...data,
                    events: data.events.slice(-want),
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
            const candidates = devservers.detect(data.events);
            const titles = await devbrowser.titles();
            const out = await devservers.enrich(candidates, titles, {
                worktreeName: s.worktree && s.worktree.name,
                projectName: s.projectName,
                lastTs: s.lastTs,
            });
            return send(res, 200, out);
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
    // Added for the phone surface: a PWA that cannot fetch its own manifest or
    // icons is not installable, and both would otherwise be served as
    // application/octet-stream and ignored.
    '.png': 'image/png',
    // The other three the composer will accept and inline. Nothing in web/ is a
    // jpeg today; the table being one short of the set it claims to cover is the
    // kind of gap that only shows up as a broken image months later.
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json',
};

// The two HTML entry points, and what each is reached by.
const PAGES = new Map([
    ['/', 'index.html'],
    ['/m', 'mobile.html'],
    ['/m/', 'mobile.html'],
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
    // desktop on exactly the path a paired phone uses, rather than a second one.
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
// The handshake that gets a phone onto the bridge. You open one long URL — the
// token in the query — and it comes back as an HttpOnly cookie and a redirect to
// /m. Afterwards nothing carries the token in a URL: fetches send the cookie, and
// so does EventSource, which is the point. EventSource cannot set headers, so
// without a cookie the only way to authenticate a stream is `?token=` on the
// stream's URL, in the page, forever.
//
// The gate above has already validated the token — /pair is not under /api/, so it
// is checked here rather than there.

function pair(req, res, url, pathname, who) {
    if (pathname === '/pair/forget') {
        res.writeHead(303, {
            Location: '/m',
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
        // bare /m rather than the credential.
        Location: '/m',
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
pool.on('turn-complete', (r) => { broadcast('turn-complete', r); filed(notifications.turn(r)); });
pool.on('failed', (f) => { broadcast('send-failed', f); filed(notifications.sendFailed(f)); });
// Nothing notifies for a subagent finishing; it is logged so that "what has been
// happening" has an answer at all.
pool.on('agent-done', (a) => filed(notifications.agentDone(a)));

/** Tell any open history view about a new row, so it does not have to re-fetch. */
function filed(row) {
    if (row) broadcast('notification', row);
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

    if (!auth.hostIsLocal(cfg.HOST.replace(/^\[|\]$/g, ''))) {
        console.warn(`[claude-sessions] bound ${cfg.HOST} — reachable from the network. `
            + 'Every remote request is logged below.');
    }

    // This port shows up in DevBrowser's detected list; name it so it isn't just
    // another anonymous number in the rail.
    devbrowser.setTitle(cfg.PORT,
        cfg.IS_DEV ? 'Claude Sessions (dev)' : 'Claude Sessions (app)').catch(() => {});
});
