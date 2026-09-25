'use strict';

// Suggested follow-ups across every session: listing them, and taking one up as a
// session of its own. Deciding about one task from inside its session is
// `/api/sessions/:id/suggestions`, in session.js.
//
// The start route is matched before the list, as it always was; they cannot
// both match a request, but the order is kept. It refuses a mode a remote caller
// may not start in, beside the route, exactly as `POST /api/sessions` does.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const cfg = require('../config');
const { broadcast } = require('../events');
const { NEXT, readJson, send } = require('../http');
const { resolveWorkdir } = require('../runner');
const { STATUSES: SUGGESTION_STATUSES } = require('../suggestions');

// Handed over by server.js — see the note above ROUTES there.
let CREATE_LIMIT = null;
let flags = null;
let index = null;
let modeRefusal = null;
let normalizeMode = null;
let pool = null;
let suggestions = null;
let tooManyCreates = null;

function init(deps) {
    ({
        CREATE_LIMIT, flags, index, modeRefusal, normalizeMode, pool, suggestions, tooManyCreates,
    } = deps);
}

// What `?status=` on /api/suggestions accepts: the decisions the store
// knows, plus `open` for a task nobody has decided about — which is the absence
// of an entry rather than a status, so the store has no name for it.
const SUGGESTION_STATES = new Set(['open', ...SUGGESTION_STATUSES]);

async function handle(req, res, url, pathname, seg, who) {
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
    // POST /api/suggestions/:sessionId/:toolUseId/start — take a task up as a
    // session of its own.
    //
    // **One call, not the two the web client makes.** `startSuggestion` in
    // web/app.js creates the session and then records the decision, and if the
    // second call fails the task stays offered beside the session that is already
    // doing it. That is survivable when you are looking at the card. It is not for
    // an unattended agent working down a list, which would read "open" and start
    // it again — so here the order is the answer, the argument `fromDraft` makes
    // on `POST /api/sessions`.
    //
    // **Refused unless it is open**, with the status and the session that has it.
    // That refusal is the whole guard against a scheduled run starting a task a
    // second time; undoing a decision first (`status: null` on the per-session
    // route) is how you say you really mean it.
    //
    // `extra` is appended under a rule rather than woven in, so the task as
    // filed is still recognisable at the top of the new session's first message.
    if (seg[1] === 'suggestions' && seg[2] && seg[3] && seg[4] === 'start' && !seg[5]
        && req.method === 'POST') {
        const sourceId = seg[2];
        const toolUseId = seg[3];
        const body = await readJson(req);
        let task = index.listSuggestions({ session: sourceId, includeTest: true })
            .find(t => t.id === toolUseId);
        // A task filed a moment ago is on screen before the index has rescanned
        // the transcript it is in. The web client sends the prompt it is showing
        // so that Start on a fresh card is not a 404; the decision store is still
        // asked, below, whether it is taken.
        if (!task && typeof body.prompt === 'string' && body.prompt.trim()
            && index.summary(sourceId)) {
            const decision = suggestions.forSession(sourceId)[toolUseId] || null;
            task = {
                id: toolUseId, sessionId: sourceId, prompt: body.prompt.trim(),
                title: null, why: null, cwd: null,
                status: decision ? decision.status : 'open',
                startedId: decision ? decision.startedId : null,
                session: { test: flags.get(sourceId).test, projectCwd: null },
            };
        }
        if (!task) return send(res, 404, { error: 'no such task' });
        if (task.status !== 'open') {
            return send(res, 409, {
                error: `that task is already ${task.status}`
                    + (task.startedId ? ` (session ${task.startedId})` : ''),
                status: task.status,
                startedId: task.startedId,
            });
        }

        const cwd = body.cwd ? String(body.cwd) : (task.cwd || task.session.projectCwd);
        try {
            resolveWorkdir(cwd);
        } catch (err) {
            return send(res, 400, { error: err.message });
        }
        // Plan unless asked otherwise, which is what the card's Start button
        // does: a task was written by somebody else's agent, and reading it
        // before editing anything is the cheap default.
        const mode = normalizeMode(body.permissionMode || 'plan');
        const refusal = modeRefusal(mode, who);
        if (refusal) return send(res, 403, { error: refusal, remote: true });
        if (tooManyCreates()) {
            return send(res, 429, {
                error: `more than ${CREATE_LIMIT.max} sessions started in a minute — `
                    + 'slow down, or start the rest from the machine itself',
            });
        }

        const extra = typeof body.extra === 'string' ? body.extra.trim() : '';
        const prompt = extra ? `${task.prompt}\n\n---\n\n${extra}` : task.prompt;
        let out;
        try {
            out = pool.create({ cwd, prompt, model: body.model || null, permissionMode: mode });
        } catch (err) {
            return send(res, 400, { error: err.message });
        }
        const test = !!(task.session.test || body.test);
        if (test) flags.set(out.sessionId, { test: true });
        index.note(out.sessionId);
        const decision = suggestions.set(sourceId, toolUseId, {
            status: 'started', startedId: out.sessionId, via: 'session',
        });
        broadcast('suggestion-changed', { at: Date.now(), sessionId: sourceId, toolUseId });
        return send(res, 200, {
            ...out, test, task: { ...task, ...decision, status: 'started' },
        });
    }

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
                q: url.searchParams.get('q') || null,
                limit: Number(url.searchParams.get('limit')) || 500,
                // Same rule as /api/sessions: a scratch session belongs to the
                // instance that started it.
                includeTest: cfg.IS_DEV,
            }),
            ready: index.ready,
        });
    }

    return NEXT;
}

module.exports = { init, handle };
