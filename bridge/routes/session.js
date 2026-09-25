'use strict';

// One session's conversation: `/api/sessions/:id` itself (read, delete), and what
// is sent to it and read out of it — `send`, `later`, `handoff`, `stop`,
// `queue`, `permission`, `flags`, attachments, suggestions, tasks, subagents.
// The routes about the *directory* it works in are session-workspace.js.
//
// **The split is by `tail`, and nothing else.** Both modules open with the same
// `seg[1] === 'sessions' && seg[2]` guard the one block used to, and every branch
// under it names a different `tail`, so no request can match in both and the
// order between the two files changes nothing.
//
// Refused to a remote caller before it gets here, by remoteRefusal(): `POST
// handoff` and both attachment routes. `send` asks modeRefusal() itself.
// `handoffLimit` is here because the handoff route is its only user; it is one
// per bridge, as it was.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const changes = require('../changes');
const { broadcast } = require('../events');
const { openFile } = require('../explorer');
const { HandoffLimit, stateOf: handoffState, wakeFailure, wakes } = require('../handoff');
const { NEXT, readJson, send } = require('../http');
const { MAX_PER_SESSION: MAX_LATER_PER_SESSION } = require('../later');
const { PERMISSION_MODES } = require('../runner');
const { STATUSES: SUGGESTION_STATUSES } = require('../suggestions');
const tasks = require('../tasks');
// Written here, read back by transcript.js. One format, and the two halves of it
// live in one file so they cannot drift apart.
const { handoffEnvelope } = require('../transcript');
const {
    attachmentPath, attachmentRefused, receiveAttachment, resolveAttachments,
} = require('./files');
const { laterFields, laterOut, laterPayload } = require('./later');
const { archiveStoppedRuns } = require('./session-workspace');

// Handed over by server.js — see the note above ROUTES there.
let flags = null;
let index = null;
let later = null;
let modeRefusal = null;
let normalizeMode = null;
let pool = null;
let prefs = null;
let sessionCwd = null;
let suggestions = null;
let terminals = null;

function init(deps) {
    ({
        flags, index, later, modeRefusal, normalizeMode, pool, prefs, sessionCwd, suggestions, terminals,
    } = deps);
}

// The brake on handoffs. One per bridge; see bridge/handoff.js for the two
// windows it keeps and why a loop guard is needed at all.
const handoffLimit = new HandoffLimit();

async function handle(req, res, url, pathname, seg, who) {
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

            // Nothing left to deliver them to. The same rule the changes above
            // follow: what was about this session goes when the session does.
            if (later.forget(sessionId)) broadcast('later-changed', laterPayload());

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

        // The session's own task list, items and all.
        //
        // The panel is fed by the `task-list` event on the transcript follow, so
        // this route is not what the desktop uses. It is here because SSE is
        // best-effort and polling is the guaranteed path — a Cloudflare quick
        // tunnel delivers zero event bytes in 75 seconds, measured — and a
        // feature reachable only over SSE is a feature a client behind one
        // cannot have. It is also what makes this answerable with curl.
        //
        // Read-only over the user's own files with nothing shelled out, so no
        // remote refusal rule: the same classification as `changes` below.
        if (tail === 'tasks' && req.method === 'GET') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const rec = index.get(sessionId);
            // Always 200, even with nothing in it. A session that kept no list
            // and a session that does not exist are different things, and only
            // the second is a 404.
            return send(res, 200, {
                sessionId,
                ...tasks.items(sessionId, rec ? rec.file : null),
            });
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

        // --- the same message, later ---------------------------------------
        // The create half of /api/later, here because a scheduled message is
        // written *against a session* — everything after this is about one
        // message and needs no session in the path. See bridge/later.js.
        if (tail === 'later' && req.method === 'GET') {
            return send(res, 200, { messages: later.forSession(sessionId).map(laterOut) });
        }

        if (tail === 'later' && req.method === 'POST') {
            const body = await readJson(req);
            // Before the session is looked up, so a refused mode does not depend on
            // whether the id is real — `/send`'s order, two routes up.
            const v = laterFields(body, who, { partial: false });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }

            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });

            const row = later.create({
                ...v.fields,
                sessionId,
                cwd: sessionCwd(summary),
                // Copied off the session rather than asked for. It decides which
                // bridge delivers this, and a test session's messages belong to the
                // dev bridge for the same reason the session itself does.
                test: !!summary.test,
            });
            if (!row) {
                return send(res, 409, {
                    error: `that session already has ${MAX_LATER_PER_SESSION} messages `
                        + 'waiting — send or cancel some before scheduling another',
                });
            }
            broadcast('later-changed', laterPayload());
            return send(res, 200, { message: laterOut(row) });
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
        //
        // The session in the path is only ever a way of naming a working directory —
        // that is the whole of what decides where the file goes. POST /api/attachments
        // is the same route for a composer that has no session to name yet, and the
        // two share everything from the cwd onward.
        if (tail === 'attachments' && !seg[4] && req.method === 'POST') {
            const name = url.searchParams.get('name');
            if (attachmentRefused(req, res, name)) return;

            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });

            return receiveAttachment(req, res, sessionCwd(summary), name);
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
                // Awaited: a message already handed to the running turn is taken
                // back from the CLI's own queue, which is a round trip.
                const removed = await r.dequeue(qid);
                // Already read by the turn, or written as one: it cannot be taken
                // back, and saying so beats silently doing nothing.
                if (!removed) return send(res, 409, { error: 'that message has already been sent' });
                return send(res, 200, { ok: true, removed, status: r.status() });
            }

            if (req.method === 'DELETE') {
                if (!r) return send(res, 200, { ok: true, dropped: [] });
                const dropped = await r.clearQueue();
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
                // A string names the session and `null` or `""` clears the name.
                title: (typeof body.title === 'string' || body.title === null) ? body.title : undefined,
            });
            const stopped = next.archived ? archiveStoppedRuns(summary) : 0;
            broadcast('sessions-changed', { at: Date.now() });
            // `title` is the name the session now shows, not the flag: with the
            // name cleared, that is whatever the transcript or schedule calls it,
            // which the caller has no other cheap way to learn.
            const after = index.summary(sessionId) || summary;
            return send(res, 200, {
                ok: true, sessionId, ...next,
                title: after.title, titleSource: after.titleSource,
                runsStopped: stopped,
            });
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
            // `ifOpen` makes this a claim rather than an overwrite: refused when
            // a decision is already recorded. It is how an agent takes a task up
            // inside its own session (`start_task` as a subagent) without the
            // read-then-write gap in which a second run takes it too.
            const prior = suggestions.forSession(sessionId)[toolUseId];
            if (body.ifOpen && prior) {
                return send(res, 409, {
                    error: `that task is already ${prior.status}`
                        + (prior.startedId ? ` (session ${prior.startedId})` : ''),
                    status: prior.status,
                    startedId: prior.startedId,
                });
            }
            const next = suggestions.set(sessionId, toolUseId, {
                status,
                startedId: typeof body.startedId === 'string' ? body.startedId : null,
                via: typeof body.via === 'string' ? body.via : null,
                note: typeof body.note === 'string' ? body.note : null,
            });
            broadcast('suggestion-changed', { at: Date.now(), sessionId, toolUseId });
            return send(res, 200, { ok: true, sessionId, toolUseId, ...next });
        }
    }

    return NEXT;
}

module.exports = { init, handle };
