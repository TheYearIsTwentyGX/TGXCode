'use strict';

// `/api/events` and what a window asks it for, plus the three routes that answer
// the same questions by polling: `/api/peers`, `/api/overview`, `/api/taskboard`.
//
// The connections themselves, the boards' ticks and the transcript follows are
// bridge/events.js; these routes only open a connection and choose what it follows.
// All readable remotely: a phone watching is the point of the stream.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const { randomUUID } = require('crypto');
const cfg = require('../config');
const {
    buildBoard, clients, dropClient, listPeers, sendBoardNow, sendTaskboardNow, sseSend,
    startAgentWatch, startWatch, stopAgentWatch, stopWatch, syncBoard, syncTaskboard,
} = require('../events');
const { NEXT, readJson, send } = require('../http');
const taskboard = require('../taskboard');

// Handed over by server.js — see the note above ROUTES there.
let index = null;
let pool = null;

function init(deps) {
    ({ index, pool } = deps);
}

async function handle(req, res, url, pathname, seg, who) {
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

    return NEXT;
}

module.exports = { init, handle };
