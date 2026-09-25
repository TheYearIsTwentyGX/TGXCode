'use strict';

// Sessions as a collection: the list, `/api/projects`, who an agent could hand
// work to (`/api/sessions/addressable`), starting one (`POST /api/sessions`), and
// `/api/slash-commands` for the composer. One session's own routes are
// session.js and session-workspace.js.
//
// **Asked before session.js, and that order is load-bearing.**
// `/api/sessions/addressable` would otherwise be read as a session id. It is the
// one pair of routes in the API that overlap; see the note above ROUTES.
//
// Starting a session is open to a remote caller, but not in every mode:
// modeRefusal() is asked beside the route, before the create limit is charged.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const path = require('path');
const cfg = require('../config');
const { broadcast } = require('../events');
const { stateOf: handoffState } = require('../handoff');
const { NEXT, readJson, send } = require('../http');
const { resolveWorkdir } = require('../runner');
const { draftsPayload } = require('./drafts');
const { resolveAttachments } = require('./files');

// Handed over by server.js — see the note above ROUTES there.
let CREATE_LIMIT = null;
let drafts = null;
let flags = null;
let index = null;
let modeRefusal = null;
let normalizeMode = null;
let pool = null;
let sessionCwd = null;
let slashCommands = null;
let tooManyCreates = null;

function init(deps) {
    ({
        CREATE_LIMIT, drafts, flags, index, modeRefusal, normalizeMode, pool, sessionCwd, slashCommands, tooManyCreates,
    } = deps);
}

/** A bounded `?limit=`, so one caller cannot ask for the whole index. */
function limitOf(url, fallback, max) {
    const n = Number(url.searchParams.get('limit'));
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
}

async function handle(req, res, url, pathname, seg, who) {
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
                    detail: st.detail, queued: st.queued, claudeVersion: st.claudeVersion };
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

    if (pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readJson(req);
        const cwd = body.cwd && String(body.cwd);
        const prompt = body.prompt && String(body.prompt).trim();
        if (!cwd) return send(res, 400, { error: 'cwd is required' });
        // A screenshot with nothing typed is a message, exactly as it is on the send
        // route. Asked of the request rather than of the resolved list, also as it is
        // there: a file that has been tidied away since it was staged should not turn
        // into "prompt is required", which is advice about the wrong field.
        if (!prompt && !(Array.isArray(body.attachments) && body.attachments.length)) {
            return send(res, 400, { error: 'prompt is required' });
        }

        // Staged by POST /api/attachments a moment ago, and re-derived here against
        // the directory they claim to be in — the same guard the send route uses, and
        // for the same reason: the client is handing back a path we gave it, which is
        // not the same thing as a path we are willing to act on.
        let files = [];
        if (Array.isArray(body.attachments) && body.attachments.length) {
            let dir;
            try {
                dir = resolveWorkdir(cwd);
            } catch (err) {
                return send(res, 400, { error: err.message });
            }
            try {
                files = resolveAttachments(dir, body.attachments);
            } catch (err) {
                return send(res, 400, { error: err.message });
            }
        }

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
                attachments: files,
            });
            // Label it before it exists on disk, so it is never briefly visible
            // in the everyday window while the first rescan catches up.
            if (body.test) flags.set(out.sessionId, { test: true });
            index.note(out.sessionId);

            // **The draft this was started from, consumed here rather than by
            // the caller.**
            //
            // Pressing Start in the dialog you opened a draft in is the same act
            // as pressing Start on its card, so it has to leave the board the
            // same way. It did not: the card's button is
            // `POST /api/drafts/:id/start` and this route had never heard of
            // drafts, so editing a draft and starting it from the dialog spawned
            // the session and left the card sitting there to be started again.
            //
            // A field on this call rather than a `DELETE /api/drafts/:id` the
            // caller sends afterwards — the argument `POST /api/schedules` makes
            // about the same field. As two calls, each client has to decide for
            // itself what a failed second one means once the first has already
            // started a process, and there are three of them to decide it three
            // ways. Here the order *is* the answer.
            //
            // After `pool.create` and only if it returned: until then the draft
            // is the only copy of what was typed, so a directory moved since you
            // saved it costs you the press and nothing else. The rule
            // `/api/drafts/:id/start` states, for the reason it gives.
            //
            // Nothing is re-validated on the way through, unlike that route,
            // because nothing off the draft is used to spawn — `cwd`, `prompt`
            // and the mode all came off this request and are already past
            // `resolveWorkdir`, `normalizeMode` and `modeRefusal`. Consuming one
            // is a delete, which a remote caller may already do.
            //
            // An id naming no draft is not an error. The session started, which
            // is what was asked for, and an id goes missing for two innocent
            // reasons: it was already deleted, or it belongs to a bridge with
            // another state directory.
            const from = typeof body.fromDraft === 'string' ? body.fromDraft : null;
            if (from && drafts.remove(from)) broadcast('drafts-changed', draftsPayload());

            return send(res, 200, { ...out, test: !!body.test });
        } catch (err) {
            return send(res, 400, { error: err.message });
        }
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

    return NEXT;
}

module.exports = { init, handle };
