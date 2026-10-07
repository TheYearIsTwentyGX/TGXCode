'use strict';

// Orchestrator sessions: `/api/sessions/:id/orchestrator…` and a worker's
// `/api/sessions/:id/report`. See bridge/orchestrators.js for the store and
// bridge/orchestration.js for what moves; every branch here is a thin call into
// the second.
//
// Two audiences. The UI reads the payload, turns the role on and off, changes
// the settings, dismisses an item and presses Resume. The orchestrator's own MCP
// tools (bridge/mcp.js) call the rest — spawn, next, send, answer, read, stop,
// close, summary — with the orchestrator's id in the path, and a worker calls
// `report` with its own. Those are refused to a remote caller in server.js:
// starting sessions in worktrees and answering their permission prompts is the
// machine acting on itself, not something to reach in for from a phone.
//
// Asked before session.js in ROUTES, though the tails do not overlap.

const { NEXT, readJson, send } = require('../http');
const orchestration = require('../orchestration');
const { REPORT_KINDS } = require('../orchestrators');
const { PERMISSION_MODES } = require('../runner');

let store = null;
let index = null;

function init(deps) {
    ({ orchestrators: store, index } = deps);
}

/** Run `fn`, turning a thrown refusal into its status and sentence. */
async function guarded(res, fn) {
    try {
        return send(res, 200, await fn());
    } catch (err) {
        const status = err.status || (err.refusal ? 409 : 500);
        if (status === 500) throw err;
        return send(res, status, { error: err.message });
    }
}

const strOr = (v, d = null) => (typeof v === 'string' && v.trim() ? v.trim() : d);

async function handle(req, res, url, pathname, seg) {
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
            return guarded(res, () => orchestration.enable(id, body.settings || null));
        }
        if (body.settings) store.setSettings(id, body.settings);
        orchestration.emit(id);
        // A cutoff lowered under the current reading takes effect now, not at
        // the next minute's check.
        orchestration.checkUsage(id);
        return send(res, 200, orchestration.payload(id));
    }

    if (sub === 'inbox' && !seg[5] && req.method === 'GET') {
        const o = store.get(id);
        if (!o) return send(res, 404, { error: 'that session is not an orchestrator' });
        return send(res, 200, { items: o.inbox.slice().reverse(), unread: store.unread(id).length });
    }

    if (sub === 'inbox' && seg[5] && seg[6] === 'dismiss' && req.method === 'POST') {
        const row = store.settle(id, seg[5], { status: 'resolved', outcome: 'dismissed', by: 'user' });
        if (!row) return send(res, 404, { error: 'no inbox item with that id' });
        orchestration.emit(id);
        return send(res, 200, { ok: true, item: row });
    }

    if (sub === 'resume' && req.method === 'POST') return guarded(res, () => orchestration.resume(id));

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
    if (sub === 'send') return guarded(res, () => orchestration.sendTo(id, String(body.worker || ''), body.text));
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
    if (sub === 'summary') return guarded(res, () => ({ summary: orchestration.setSummary(id, body.text) }));

    return NEXT;
}

module.exports = { init, handle };
