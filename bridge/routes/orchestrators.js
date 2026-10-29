'use strict';

// Orchestrator sessions: `/api/sessions/:id/orchestrator…` and a worker's
// `/api/sessions/:id/report`. See bridge/orchestrators.js for the store and
// bridge/orchestration.js for what moves; every branch here is a thin call into
// the second.
//
// Two audiences. The UI reads the payload, turns the role on and off, changes
// the settings, dismisses an item, records the answer to one of the brief's
// decisions, presses Resume and moves one to its main checkout or elsewhere. The orchestrator's own MCP
// tools (bridge/mcp.js) call the rest — spawn, next, send, answer, read, stop,
// close, summary — with the orchestrator's id in the path, and a worker calls
// `report` with its own. Those are refused to a remote caller in server.js:
// starting sessions in worktrees and answering their permission prompts is the
// machine acting on itself, not something to reach in for from a phone.
//
// Tasks — a draft, or the Start dialog as it stood, handed to an orchestrator —
// are the user's side and stay open to a paired phone, as starting a draft and
// `/send` do: filing one starts no session, it gives the orchestrator something
// to decide about. What a phone may not ask for here is what it may not ask for
// anywhere: a forbidden permission mode, or a worktree.
//
// Also `GET /api/orchestrators`, the list the Send-to-orchestrator picker draws.
//
// Asked before session.js in ROUTES, though the tails do not overlap.

const { broadcast } = require('../events');
const { NEXT, readJson, send } = require('../http');
const orchestration = require('../orchestration');
const { REPORT_KINDS } = require('../orchestrators');
const { PERMISSION_MODES } = require('../runner');
const { draftFields, draftOut, draftsPayload } = require('./drafts');

let store = null;
let index = null;
let drafts = null;
let modeRefusal = null;
let normalizeMode = null;

function init(deps) {
    ({ orchestrators: store, index, drafts, modeRefusal, normalizeMode } = deps);
}

/** A prompt's first line, as a title for something that was never given one. */
const firstLine = (s) => String(s || '').split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 80) || null;

/**
 * Stamp who set `usageStop.autoResume` onto a settings PUT, in place, and
 * return the stamp (null when the body does not set it). A client never
 * supplies the stamp: whatever it sent is dropped. `by: "agent"` is what the
 * orchestrator's own `set_auto_resume` sends; anything else — the page's
 * popover — is the user, and the user's toggle always replaces the agent's.
 */
function stampAutoResume(body) {
    const u = body.settings && body.settings.usageStop;
    if (!u || typeof u !== 'object') return null;
    delete u.autoResumeBy;
    if (typeof u.autoResume !== 'boolean') return null;
    const reason = typeof body.reason === 'string' ? body.reason : null;
    u.autoResumeBy = { by: body.by === 'agent' ? 'agent' : 'user', at: Date.now(), reason };
    return u.autoResumeBy;
}

/**
 * What a task-filing body asks for, validated, or why not.
 *
 * Two sources, which is what lets one route serve the Drafts board, the draft
 * editor and the Start dialog. `fields` is the dialog's create call and goes
 * through drafts' own `draftFields`, so it is held to exactly what saving a
 * draft would be. `draftId` alone uses the stored draft — run through the same
 * check, because the file is hand-editable and a directory can move after it is
 * saved. Both: the fields win and the draft is consumed (an edited draft sent
 * without saving first).
 *
 * The two Start-only fields are decided here. A `worktree {name, base?}` is
 * carried as a hint the spawn honours — refused remotely, as creating a session
 * in one is. `orchestrator: true` is refused: a worker cannot be one.
 *
 * @returns {{task: object, draftId: string|null} | {error: string, status: number, remote?: boolean}}
 */
function taskSource(body, who) {
    const b = body && typeof body === 'object' ? body : {};
    const draftId = typeof b.draftId === 'string' && b.draftId ? b.draftId : null;
    const f = b.fields && typeof b.fields === 'object' ? b.fields : null;
    if (!f && !draftId) return { error: 'send a draftId, or the fields of a create call', status: 400 };
    if (f && f.orchestrator === true) {
        return { error: 'a task cannot start an orchestrator — orchestrators only go one level deep', status: 400 };
    }

    let worktree = null;
    if (f && f.worktree != null) {
        if (who.remote) {
            return { error: 'a worktree cannot be created remotely — start it at the machine itself',
                status: 403, remote: true };
        }
        const wt = f.worktree;
        if (typeof wt !== 'object' || typeof wt.name !== 'string' || !wt.name.trim()) {
            return { error: 'worktree must be an object {name, base?}', status: 400 };
        }
        worktree = { name: wt.name.trim(), base: typeof wt.base === 'string' && wt.base.trim() ? wt.base.trim() : null };
    }

    let draft = null;
    if (draftId) {
        draft = drafts.get(draftId);
        if (!draft) return { error: 'draft not found', status: 404 };
    }
    const v = draftFields(f || draft, who, { partial: false });
    if (v.error) return v;
    const fields = v.fields;
    // The everyday window leaves `test` out of the dialog's body (the box is
    // dev-only), so an edited test draft must not come back unflagged.
    if (f && draft && f.test === undefined) fields.test = !!draft.test;
    // The dialog's name for it, else the draft's, else its first line — what
    // "from your draft '…'" says on the page and in the worker's brief.
    const title = fields.title || (draft && draft.title) || null;
    return {
        draftId: draft ? draft.id : null,
        task: {
            ...fields, title, worktree,
            // The draft's id and age travel with the task, so Take back can
            // restore that same draft rather than make a new one.
            origin: { from: draft ? 'draft' : 'dialog', draftId: draft ? draft.id : null,
                draftCreatedAt: draft ? draft.createdAt : null,
                title: title || firstLine(fields.prompt) },
        },
    };
}

/** Run `fn`, turning a thrown refusal into its status and sentence. */
async function guarded(res, fn) {
    try {
        return send(res, 200, await fn());
    } catch (err) {
        const status = err.status || (err.refusal ? 409 : 500);
        if (status === 500) throw err;
        return send(res, status, { error: err.message, ...(err.extra || {}) });
    }
}

const strOr = (v, d = null) => (typeof v === 'string' && v.trim() ? v.trim() : d);

async function handle(req, res, url, pathname, seg, who) {
    if (seg[1] === 'orchestrators' && !seg[2] && req.method === 'GET') {
        return send(res, 200, { orchestrators: orchestration.list() });
    }
    if (seg[1] !== 'sessions' || !seg[2]) return NEXT;
    const id = seg[2];

    if (seg[3] === 'report' && !seg[4] && req.method === 'POST') {
        const body = await readJson(req);
        const kind = String(body.kind || '');
        if (!REPORT_KINDS.includes(kind)) {
            return send(res, 400, { error: `kind must be one of ${REPORT_KINDS.join(', ')}` });
        }
        const text = strOr(body.text);
        if (!text) return send(res, 400, { error: 'text is required' });
        if (store.roleOf(id) !== 'worker') {
            return send(res, 409, { error: 'this session is not an orchestrator\'s worker, so there is '
                + 'nobody to report to' });
        }
        const row = orchestration.report(id, kind, text);
        return send(res, 200, { ok: true, id: row && row.id });
    }

    if (seg[3] !== 'orchestrator') return NEXT;
    const sub = seg[4] || '';

    if (!sub && req.method === 'GET') return send(res, 200, orchestration.payload(id));

    if (!sub && req.method === 'PUT') {
        const body = await readJson(req);
        if (body.enabled === false) return send(res, 200, orchestration.disable(id));
        if (!store.get(id)) {
            if (body.enabled !== true) return send(res, 404, { error: 'that session is not an orchestrator' });
            if (!index.summary(id)) return send(res, 404, { error: 'session not found' });
            stampAutoResume(body);
            return guarded(res, () => orchestration.enable(id, body.settings || null));
        }
        const by = stampAutoResume(body);
        if (body.settings) store.setSettings(id, body.settings);
        // The orchestrator's own model, changed: replaced now when it is idle,
        // when its turn ends when not — what a composer model change does.
        const own = body.settings && ('orchestratorModel' in body.settings || 'orchestratorEffort' in body.settings)
            ? orchestration.applyOwnModel(id) : null;
        if (by && by.by === 'agent') orchestration.noteAutoResume(id);
        orchestration.emit(id);
        // A cutoff lowered under the current reading takes effect now, not at
        // the next minute's check.
        orchestration.checkUsage(id);
        // Already paused: the wake time follows the new settings — auto-resume
        // turned on starts the clock, turned off stops it.
        if (body.settings && body.settings.usageStop) orchestration.rearmPause(id);
        // A raised cap, or a cutoff the reading is now under, has room for the
        // queue now — not when some worker next ends a turn. drainSpawns starts
        // nothing while paused, and checkUsage above has just paused it if the
        // new settings are over the line.
        orchestration.drainSpawns(id);
        return send(res, 200, { ...orchestration.payload(id), ownModelApplied: own });
    }

    if (sub === 'inbox' && !seg[5] && req.method === 'GET') {
        const o = store.get(id);
        if (!o) return send(res, 404, { error: 'that session is not an orchestrator' });
        return send(res, 200, { items: o.inbox.slice().reverse(), unread: store.unread(id).length });
    }

    // Recorded, not delivered: the client sends the answer to the orchestrator
    // as an ordinary message (`/send`), and this marks the question answered so
    // every window stops asking it before the orchestrator gets round to
    // rewriting its brief.
    if (sub === 'decisions' && seg[5] && seg[6] === 'answered' && !seg[7] && req.method === 'POST') {
        const body = await readJson(req);
        return guarded(res, () => ({ decision: orchestration.answerDecision(id, seg[5], strOr(body.text)) }));
    }

    if (sub === 'inbox' && seg[5] && seg[6] === 'dismiss' && req.method === 'POST') {
        const row = store.settle(id, seg[5], { status: 'resolved', outcome: 'dismissed', by: 'user' });
        if (!row) return send(res, 404, { error: 'no inbox item with that id' });
        orchestration.emit(id);
        return send(res, 200, { ok: true, item: row });
    }

    if (sub === 'resume' && req.method === 'POST') return guarded(res, () => orchestration.resume(id));

    // Somewhere else — out of a worktree it had no way out of, or wherever it
    // or the user asks — now if it is idle, at the end of the turn if not. See
    // orchestration.moveTo. `move-to-checkout` is the same with no directory.
    // DELETE drops a move still waiting for its turn to end. Open to a paired
    // phone, as Resume is: it starts nothing, and what it leaves is left as it was.
    if (sub === 'move' && !seg[5] && req.method === 'POST') {
        const body = await readJson(req);
        return guarded(res, () => orchestration.moveTo(id, {
            cwd: body.cwd === undefined ? null : body.cwd, force: body.force === true }));
    }
    if (sub === 'move' && !seg[5] && req.method === 'DELETE') {
        return guarded(res, () => orchestration.cancelMove(id));
    }
    if (sub === 'move-to-checkout' && !seg[5] && req.method === 'POST') {
        const body = await readJson(req);
        return guarded(res, () => orchestration.moveToCheckout(id, { force: body.force === true }));
    }

    // Hand it a task. Validated before the orchestrator is looked up, so a
    // refused mode is a 403 whatever the id — PATCH /api/drafts/:id's order and
    // reason. Filed first, the draft removed second: a refusal keeps the draft.
    if (sub === 'tasks' && !seg[5] && req.method === 'POST') {
        const v = taskSource(await readJson(req), who);
        if (v.error) {
            return send(res, v.status, v.remote ? { error: v.error, remote: true } : { error: v.error });
        }
        return guarded(res, () => {
            const out = orchestration.fileTask(id, v.task);
            const draftRemoved = !!v.draftId && drafts.remove(v.draftId);
            if (draftRemoved) broadcast('drafts-changed', draftsPayload());
            return { ok: true, ...out, draftRemoved };
        });
    }

    // Take it back: it becomes a draft again. A phone may, as it may save a
    // draft — but not one in a mode it could not have saved.
    if (sub === 'tasks' && seg[5] && seg[6] === 'withdraw' && !seg[7] && req.method === 'POST') {
        const item = store.item(id, seg[5]);
        if (item && item.task) {
            const refusal = modeRefusal(normalizeMode(item.task.permissionMode), who);
            if (refusal) return send(res, 403, { error: refusal, remote: true });
        }
        return guarded(res, () => {
            const out = orchestration.withdrawTask(id, seg[5]);
            return { ok: true, draft: draftOut(out.draft) };
        });
    }

    if (sub === 'workers' && req.method === 'GET') {
        const p = orchestration.payload(id);
        if (!p.enabled) return send(res, 404, { error: 'that session is not an orchestrator' });
        return send(res, 200, { workers: p.workers, pendingSpawns: p.pendingSpawns,
            maxRunning: p.settings.maxRunning, paused: p.paused });
    }

    if (sub === 'usage' && req.method === 'GET') return send(res, 200, orchestration.usageFor(id));

    if (req.method !== 'POST') return NEXT;
    const body = await readJson(req);

    if (sub === 'spawn') {
        return guarded(res, () => orchestration.spawn(id, {
            // A task item to start: the user's settings come from it, and
            // `prompt` becomes optional — see spawnOptsFromTask.
            task: strOr(body.task),
            prompt: strOr(body.prompt),
            title: strOr(body.title),
            cwd: strOr(body.cwd),
            worktree: typeof body.worktree === 'boolean' || typeof body.worktree === 'string'
                ? body.worktree : null,
            // Short of bypassPermissions, as every agent-facing mode list is.
            permissionMode: ['plan', 'auto', 'acceptEdits', 'dontAsk', 'manual'].includes(body.permissionMode)
                ? body.permissionMode : null,
            model: strOr(body.model),
            effort: strOr(body.effort),
        }));
    }
    if (sub === 'next') {
        if (!store.get(id)) return send(res, 404, { error: 'that session is not an orchestrator' });
        const max = Number.isInteger(body.max) ? Math.min(Math.max(body.max, 1), 50) : 1;
        const items = store.pull(id, max);
        orchestration.emit(id);
        return send(res, 200, { items, left: store.unread(id).length });
    }
    if (sub === 'send') {
        return guarded(res, () => orchestration.sendTo(id, String(body.worker || ''), body.text,
            { task: strOr(body.task) }));
    }
    if (sub === 'answer') {
        const decision = String(body.decision || '');
        if (!['allow', 'allow-always', 'deny'].includes(decision)) {
            return send(res, 400, { error: 'decision must be allow, allow-always or deny' });
        }
        return guarded(res, () => orchestration.answer(id, String(body.itemId || ''), decision, {
            feedback: typeof body.feedback === 'string' ? body.feedback : '',
            answers: body.answers && typeof body.answers === 'object' ? body.answers : null,
            mode: PERMISSION_MODES.includes(body.mode) && body.mode !== 'bypassPermissions' ? body.mode : null,
        }));
    }
    if (sub === 'read') {
        const mode = ['digest', 'tail', 'full', 'ask'].includes(body.mode) ? body.mode : 'digest';
        return guarded(res, () => orchestration.read(id, String(body.worker || ''),
            { mode, turns: body.turns, offset: body.offset }));
    }
    if (sub === 'stop') {
        return guarded(res, () => orchestration.stopWorker(id, String(body.worker || ''), { hard: !!body.hard }));
    }
    if (sub === 'close') {
        return guarded(res, () => orchestration.closeWorker(id, String(body.worker || ''),
            { archive: body.archive !== false }));
    }
    if (sub === 'summary') {
        // The structured fields are passed only when present: absent keeps what
        // the brief had, null clears it — see Orchestrators#setSummary.
        const fields = {};
        for (const k of ['goal', 'decisions', 'mergeOrder']) {
            if (Object.prototype.hasOwnProperty.call(body, k)) fields[k] = body[k];
        }
        return guarded(res, () => ({ summary: orchestration.setSummary(id, body.text, fields) }));
    }

    return NEXT;
}

module.exports = { init, handle, taskSource };
