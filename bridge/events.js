'use strict';

// The server side of `GET /api/events`: the connections, the fan-out, the two
// boards' ticks, the transcript follows, and the list of peers a session could
// message.
//
// It was the first thing in server.js after the instances were built, and it
// came out whole because nothing in it is about a route. The routes that drive it
// — `/api/events` opening a connection, `/api/subscribe` choosing what it follows
// — stay in the router and call in here, which is the same split every other
// module under bridge/ has with server.js.
//
// **Why `init` rather than requiring the instances.** The session index, the
// runner pool and the registry are built by server.js, which owns their
// lifetime, and requiring server.js back from here would hand this file a
// half-filled exports object in the middle of server.js's own load. So they are
// passed in once, by `init`, at the point where this section used to sit — which
// is before anything could call in, since nothing here runs at load.
//
// `clients` lives here because every function in this file is about it. It is
// exported as the Map itself, so server.js (the health count, `hasViewer`) and
// this file are looking at the same connections rather than at a copy.
//
// **No timers at load, still.** The board ticks start and stop with the windows
// watching them (`syncBoard`, `syncTaskboard`) and a follow starts when a client
// subscribes, exactly as when this was inline.

const cfg = require('./config');
const overview = require('./overview');
const taskboard = require('./taskboard');
const tasks = require('./tasks');

// Handed over by server.js; see the header.
let index = null;
let pool = null;
let registry = null;

function init(deps) {
    ({ index, pool, registry } = deps);
}

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
 * The session's own task list, when it has moved since this client last heard.
 *
 * Rides the transcript follow rather than a timer of its own, because the list
 * only ever moves while a turn is running and that is exactly when somebody is
 * following. `bridge/tasks.js` caches for a second, so the 400ms tick costs at
 * most one directory read per second per session however many windows are open.
 *
 * The mark lives on the *sub* rather than on the client or in a module-level
 * map: a client's follow is what it is about, and the board's comment above
 * records what sharing one mark between clients cost last time.
 *
 * Deliberately not on the session summary. Every session opened would then read
 * the tasks directory whether or not anything drew the list, and it still would
 * not answer liveness — the same reasoning `/changes` already carries.
 */
function pushTasks(client, sessionId, sub) {
    const rec = index.get(sessionId);
    const data = tasks.items(sessionId, rec ? rec.file : null);
    const sig = signature(data);
    if (sub.taskSig === sig) return;
    sub.taskSig = sig;
    sseSend(client, 'task-list', { sessionId, ...data });
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

    const sub = { offset: fromOffset, watcher: null, taskSig: null };
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
            pushTasks(client, sessionId, sub);
        } finally {
            inFlight = false;
        }
    }, 400);
    sub.watcher.unref();

    // Once now, rather than up to 400ms of an empty panel — `sendBoardNow` is
    // here for the same reason. It also means `subscribe` needs no extra line,
    // and an SSE reconnect re-pushes for free. The cost is one identical push
    // per re-subscribe, which the signature check makes free after the first.
    pushTasks(client, sessionId, sub);
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

module.exports = {
    init,
    clients,
    sseSend, broadcast, streamBytes,
    dropClient, stopWatch,
    syncBoard, buildBoard, tickBoard, sendBoardNow,
    syncTaskboard, sendTaskboardNow,
    listPeers,
    startWatch, startAgentWatch, stopAgentWatch,
};
