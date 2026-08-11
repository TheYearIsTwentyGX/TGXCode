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
const { SessionIndex } = require('./sessions');
const { RunnerPool, PERMISSION_MODES } = require('./runner');
const { Flags } = require('./flags');
const devbrowser = require('./devbrowser');
const devservers = require('./devservers');
const dashboard = require('./dashboard');
const { openInExplorer } = require('./explorer');
const { TerminalPool } = require('./terminal');

const WEB_DIR = path.join(__dirname, '..', 'web');
const CLIENT_HEADER = 'x-claude-sessions-client';

const flags = new Flags();
const index = new SessionIndex(flags);
const pool = new RunnerPool();
const terminals = new TerminalPool();

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

function dropClient(id) {
    const c = clients.get(id);
    if (!c) return;
    for (const sub of c.subs.values()) stopWatch(sub);
    stopAgentWatch(c);
    clients.delete(id);
}

function stopWatch(sub) {
    if (sub.watcher) { clearInterval(sub.watcher); sub.watcher = null; }
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

    // Same guard DevBrowser uses: reject cross-origin callers outright. A page in
    // some other tab must not be able to drive Claude on this machine.
    const origin = req.headers.origin;
    if (origin && !isOwnOrigin(origin)) return send(res, 403, { error: 'forbidden origin' });
    if (pathname.startsWith('/api/') && pathname !== '/api/health'
        && req.method !== 'GET' && !req.headers[CLIENT_HEADER]) {
        return send(res, 403, { error: 'missing client header' });
    }

    try {
        if (pathname.startsWith('/api/')) return await api(req, res, url, pathname);
        return serveStatic(res, pathname);
    } catch (err) {
        send(res, 500, { error: err.message, stack: err.stack });
    }
});

function isOwnOrigin(origin) {
    return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

async function api(req, res, url, pathname) {
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
        const client = { res, subs: new Map(), agent: null };
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
        return send(res, 200, {
            ok: true, app: 'claude-sessions', version: cfg.VERSION,
            pid: process.pid, port: cfg.PORT, dev: cfg.IS_DEV, ready: index.ready,
            sessions: index.sessions.size, host: os.hostname(),
            // Live SSE connections — a quick way to tell whether a UI attached.
            clients: clients.size, runners: Object.keys(pool.statuses()).length,
            terminals: terminals.live().length,
            // Turns in flight. Restarting would end them, so anything that
            // restarts the bridge should look here first.
            busy: pool.busyCount,
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
        try {
            const out = pool.create({
                cwd,
                prompt,
                model: body.model || null,
                permissionMode: normalizeMode(body.permissionMode),
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
            return send(res, 200, { ...data, runner: st || null });
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
            const text = body.text && String(body.text).trim();
            if (!text) return send(res, 400, { error: 'text is required' });

            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const cwd = summary.cwd && fs.existsSync(summary.cwd)
                ? summary.cwd
                : (summary.projectCwd && fs.existsSync(summary.projectCwd)
                    ? summary.projectCwd : cfg.HOME);

            const r = pool.ensure(sessionId, {
                cwd,
                model: body.model || null,
                permissionMode: normalizeMode(body.permissionMode),
                fork: !!body.fork,
            });
            const entry = r.send(text);
            // Which of the two happened matters to the caller: a message that is
            // still queued is safe on this side and will be handed back if the
            // process dies, so the UI only has to hold on to one that went out.
            const status = r.status();
            return send(res, 200, {
                ok: true, id: entry.id, cwd, fork: !!body.fork, status,
                queued: status.queue.some(q => q.id === entry.id),
            });
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
            broadcast('sessions-changed', { at: Date.now() });
            return send(res, 200, { ok: true, sessionId, ...next });
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
        if (tail === 'stream' && req.method === 'GET') {
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
            emit('opened', term.info());
            const detach = term.attach(emit);
            const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);
            ping.unref();
            req.on('close', () => { clearInterval(ping); detach(); });
            return;
        }

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

    // --- filesystem (new-session directory picker) -------------------------
    if (pathname === '/api/fs' && req.method === 'GET') {
        const dir = url.searchParams.get('path') || cfg.HOME;
        return send(res, 200, listDir(dir));
    }

    return send(res, 404, { error: 'no such endpoint', pathname });
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

function listDir(dir) {
    const resolved = path.resolve(dir);
    let entries = [];
    try {
        entries = fs.readdirSync(resolved, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => ({ name: e.name, path: path.join(resolved, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 500);
    } catch (err) {
        return { path: resolved, error: err.message, entries: [], parent: path.dirname(resolved) };
    }
    const isGit = fs.existsSync(path.join(resolved, '.git'));
    return {
        path: resolved,
        parent: resolved === '/' ? null : path.dirname(resolved),
        isGit,
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

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
};

function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(WEB_DIR, rel);
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
        return send(res, 403, { error: 'forbidden' });
    }
    let body;
    try { body = fs.readFileSync(file); } catch { return send(res, 404, { error: 'not found' }); }
    res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    res.end(body);
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
pool.on('status', (s) => broadcast('runner-status', s));
pool.on('permission-request', (p) => broadcast('permission-request', p));
pool.on('permission-resolved', (p) => broadcast('permission-resolved', p));
pool.on('notice', (n) => broadcast('notice', n));
pool.on('turn-complete', (r) => broadcast('turn-complete', r));
pool.on('failed', (f) => broadcast('send-failed', f));
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
    // outlive us if we did not take them with us.
    try { terminals.shutdown(); } catch { /* nothing to clean */ }
    try { index.stop(); } catch { /* nothing to clean */ }
    try { server.close(); } catch { /* already closed */ }
    setTimeout(() => process.exit(code), 200).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

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
    const t0 = Date.now();
    await index.start();
    console.log(`[claude-sessions] indexed ${index.sessions.size} sessions in ${Date.now() - t0}ms`);

    if (cfg.IS_DEV) {
        console.log('[claude-sessions] development instance — the everyday one on '
            + `${cfg.DEFAULT_PORT} is untouched.`);
    }

    // This port shows up in DevBrowser's detected list; name it so it isn't just
    // another anonymous number in the rail.
    devbrowser.setTitle(cfg.PORT,
        cfg.IS_DEV ? 'Claude Sessions (dev)' : 'Claude Sessions (app)').catch(() => {});
});
