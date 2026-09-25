'use strict';

// `/api/later`: a send held back until a time you picked. Created against a session,
// which is why the create is `POST /api/sessions/:id/later` in session.js; every
// route after that is about one message, and lives here. The store is
// bridge/later.js, and delivery on the clock is bridge/later-delivery.js.
//
// `laterOut`, `laterPayload` and `laterFields` came with the routes, and are
// lent to session.js for the create and to server.js, which hands
// `laterPayload` to later-delivery. `laterFields` asks modeRefusal() when the
// message is written, not when it is due, for the reason draftFields does.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const { broadcast } = require('../events');
const { NEXT, readJson, send } = require('../http');
const { LATE_MS, MAX_AHEAD_MS } = require('../later');
const { deliverLater } = require('../later-delivery');
const { projectName } = require('../sessions');

// Handed over by server.js — see the note above ROUTES there.
let later = null;
let modeRefusal = null;
let normalizeMode = null;

function init(deps) {
    ({ later, modeRefusal, normalizeMode } = deps);
}

/**
 * A scheduled message on the wire.
 *
 * `projectName` for draftOut's reason, and `late` because the window is the one
 * thing a client cannot work out for itself: LATE_MS lives in the bridge, and a
 * chip that said "in -20 minutes" for a row that is never going to be delivered
 * would be worse than one that says it was missed.
 */
function laterOut(row) {
    return {
        ...row,
        projectName: projectName(row.cwd),
        late: row.state === 'pending' && Date.now() - row.at > LATE_MS,
    };
}

/** The whole list, which is both the GET body and the SSE payload. */
function laterPayload() {
    const rows = later.list().map(laterOut);
    return {
        at: Date.now(),
        messages: rows,
        counts: {
            total: rows.length,
            pending: rows.filter(r => r.state === 'pending').length,
        },
    };
}

/**
 * Validate what a scheduled-message write is asking for, exactly as a send would.
 *
 * `draftFields`' shape, and for its reason: the create and the edit have to reach
 * the same verdict, and a message that could be saved but never delivered is worse
 * than a refused save.
 *
 * Two rules that are not `/send`'s:
 *
 *   * **`permissionMode` is required, not defaulted.** `/send` normalises an absent
 *     one to `auto`, and that trap is much worse here: `auto` is the one mode that
 *     cannot work when nobody is watching, and the mistake would only show up as a
 *     session that stalled in the night. A client must say what it means.
 *   * **`at` must be in the future and inside a month.** The upper bound is what
 *     makes a typo'd year a 400 rather than a row that sits in the file forever.
 */
function laterFields(body, who, { partial }) {
    const fields = {};

    if (!partial || body.text !== undefined || body.attachments !== undefined) {
        const text = body.text ? String(body.text).trim() : '';
        const files = Array.isArray(body.attachments) ? body.attachments : [];
        // A screenshot with nothing typed under it is a real message, which is the
        // send route's rule and not worth having twice over.
        if (!text && !files.length) {
            return { error: 'text or an attachment is required', status: 400 };
        }
        fields.text = text;
        fields.attachments = files;
    }

    if (!partial || body.permissionMode !== undefined) {
        if (!body.permissionMode) {
            return {
                error: 'permissionMode is required — a message delivered while nobody is '
                    + 'watching has its permission asks denied automatically, so the mode '
                    + 'has to be a choice rather than a default',
                status: 400,
            };
        }
        const mode = normalizeMode(body.permissionMode);
        const refusal = modeRefusal(mode, who);
        if (refusal) return { error: refusal, status: 403, remote: true };
        fields.permissionMode = mode;
    }

    if (!partial || body.at !== undefined) {
        const at = Number(body.at);
        if (!Number.isFinite(at)) return { error: 'at is required', status: 400 };
        const now = Date.now();
        if (at <= now) {
            return { error: 'at is in the past — pick a time that has not happened yet', status: 400 };
        }
        if (at - now > MAX_AHEAD_MS) {
            return { error: 'at is more than a month away', status: 400 };
        }
        fields.at = at;
    }

    if (!partial || body.model !== undefined) fields.model = body.model || null;

    return { fields };
}

async function handle(req, res, url, pathname, seg, who) {
    // ── messages on a clock ──────────────────────────────────────────────
    //
    // A send held back until a time you picked — see bridge/later.js. Written
    // against a session, which is why the create lives on
    // `POST /api/sessions/:id/later`; everything afterwards is about one message
    // and needs no session in the path.
    //
    // All four in one block, beside drafts and for the reason that block gives.
    if (seg[1] === 'later') {
        if (!seg[2] && req.method === 'GET') {
            return send(res, 200, laterPayload());
        }

        if (seg[2] && !seg[3] && req.method === 'PATCH') {
            const body = await readJson(req);
            // Validated before the message is looked up, the order the drafts PATCH
            // uses and for the reason it gives: the refusal is about what this
            // caller may ask for, not about what it aimed at.
            const v = laterFields(body, who, { partial: true });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }
            const out = later.update(seg[2], v.fields);
            if (!out) return send(res, 404, { error: 'no scheduled message with that id' });
            // Already handed to a process, or already past. Editing it now would be
            // editing the past, and the store refuses rather than pretending.
            if (out.conflict) {
                return send(res, 409, {
                    error: `that message is ${out.conflict} — it cannot be changed now`,
                });
            }
            broadcast('later-changed', laterPayload());
            return send(res, 200, { message: laterOut(out) });
        }

        if (seg[2] && !seg[3] && req.method === 'DELETE') {
            if (!later.remove(seg[2])) {
                return send(res, 404, { error: 'no scheduled message with that id' });
            }
            broadcast('later-changed', laterPayload());
            return send(res, 200, { ok: true, id: seg[2] });
        }

        // Deliver it now, whatever its clock says.
        //
        // The same function the tick calls, for the reason
        // `POST /api/schedules/:id/run` is: "the button delivers what the clock
        // delivers" is only true if there is one path. That includes the
        // wait-for-idle rule — pressing this must not end a turn either.
        if (seg[2] && seg[3] === 'send' && req.method === 'POST') {
            const row = later.get(seg[2]);
            if (!row) return send(res, 404, { error: 'no scheduled message with that id' });
            if (row.state !== 'pending') {
                return send(res, 409, {
                    error: `that message is ${row.state} — it has already been dealt with`,
                });
            }
            // Re-checked here and not only at write time: the file is hand-editable
            // and outlives the process that wrote it, and a message saved at the
            // machine must not become a way for a phone to send bypassPermissions.
            const refusal = modeRefusal(normalizeMode(row.permissionMode), who);
            if (refusal) return send(res, 403, { error: refusal, remote: true });

            if (!later.claim(seg[2])) {
                return send(res, 409, { error: 'a tick is already delivering that message' });
            }
            let out;
            try {
                out = await deliverLater(row);
            } catch (err) {
                out = { ok: false, error: err.message };
            }
            if (out.ok) {
                later.note(seg[2], { state: 'sent', sentAt: Date.now() });
            } else if (out.retry) {
                later.release(seg[2]);
            } else {
                later.note(seg[2], { state: 'failed', error: out.error });
            }
            broadcast('later-changed', laterPayload());
            if (!out.ok) {
                // 409 for the two retryable refusals — the message is untouched and
                // pressing again later is the right thing to do — and 502 for a
                // delivery that was attempted and did not land.
                return send(res, out.retry ? 409 : 502, { error: out.error });
            }
            return send(res, 200, {
                ok: true, message: laterOut(later.get(seg[2])),
                status: out.status, queued: out.queued, woke: out.woke,
            });
        }
    }

    return NEXT;
}

module.exports = { init, handle, laterFields, laterOut, laterPayload };
