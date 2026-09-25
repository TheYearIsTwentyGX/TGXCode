'use strict';

// `/api/drafts`: a session set up but not started — everything `POST /api/sessions`
// takes, held in a file until you press Start. The store is bridge/drafts.js.
//
// `draftOut`, `draftsPayload` and `draftFields` came with the routes.
// `draftsPayload` is lent to sessions.js and schedules.js, which both consume a
// draft and have to tell the windows it went. `draftFields` asks modeRefusal()
// at *write* time, so a phone cannot stash a draft it would not be allowed to start.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const { MAX_DRAFTS } = require('../drafts');
const { broadcast } = require('../events');
const { NEXT, readJson, send } = require('../http');
const { resolveWorkdir } = require('../runner');
const { projectName } = require('../sessions');

// Handed over by server.js — see the note above ROUTES there.
let CREATE_LIMIT = null;
let drafts = null;
let flags = null;
let index = null;
let modeRefusal = null;
let normalizeMode = null;
let pool = null;
let tooManyCreates = null;

function init(deps) {
    ({
        CREATE_LIMIT, drafts, flags, index, modeRefusal, normalizeMode, pool, tooManyCreates,
    } = deps);
}

/**
 * A draft as it goes out on the wire: the stored row plus the project label.
 *
 * Derived here rather than in the store and rather than in each client, so that
 * the desktop, the phone and the Android app cannot come to three different
 * answers about which project a directory belongs to. It is the same
 * `projectName` the rail and the session list use.
 */
function draftOut(draft) {
    return { ...draft, projectName: projectName(draft.cwd) };
}

/** The whole list, which is both the GET body and the SSE payload. */
function draftsPayload() {
    const rows = drafts.list().map(draftOut);
    return { at: Date.now(), drafts: rows, counts: { total: rows.length } };
}

/**
 * Validate what a draft write is asking for, exactly as a create would.
 *
 * The point of checking at *write* time is that a draft you cannot start is
 * worse than a refused save: it sits on the board looking ready and fails every
 * time you press Start. So the directory has to exist and be inside the roots
 * here too — `resolveWorkdir` is the same function `pool.create` calls, so the
 * two cannot disagree — and a remote caller is refused the two modes it is
 * refused on creation, or a phone could stash a `bypassPermissions` draft it is
 * not allowed to run.
 *
 * `partial` is PATCH: a field absent from the body is left alone rather than
 * validated as missing. `cwd` comes back expanded, which is what gets stored, so
 * a `~` typed into the dialog means the same thing a shell would make of it.
 *
 * @returns {{fields: object} | {error: string, status: number, remote?: boolean}}
 */
function draftFields(body, who, { partial }) {
    const fields = {};

    if (!partial || body.cwd !== undefined) {
        if (!body.cwd) return { error: 'cwd is required', status: 400 };
        try {
            fields.cwd = resolveWorkdir(String(body.cwd));
        } catch (err) {
            return { error: err.message, status: 400 };
        }
    }

    if (!partial || body.prompt !== undefined) {
        const prompt = body.prompt && String(body.prompt).trim();
        if (!prompt) return { error: 'prompt is required', status: 400 };
        fields.prompt = prompt;
    }

    if (!partial || body.permissionMode !== undefined) {
        const mode = normalizeMode(body.permissionMode);
        const refusal = modeRefusal(mode, who);
        if (refusal) return { error: refusal, status: 403, remote: true };
        fields.permissionMode = mode;
    }

    // The two that mean "no choice made" when empty, rather than being invalid.
    if (!partial || body.model !== undefined) fields.model = body.model || null;
    if (!partial || body.title !== undefined) fields.title = body.title || null;
    if (!partial || body.test !== undefined) fields.test = !!body.test;

    return { fields };
}

async function handle(req, res, url, pathname, seg, who) {
    // ── drafts ───────────────────────────────────────────────────────────
    //
    // A session set up but not started. Everything `POST /api/sessions` takes,
    // held in a file until you press Start — see bridge/drafts.js.
    //
    // All five in one block rather than split between the reading and writing
    // halves of this file: it is a small, self-contained surface and the write
    // routes are only interesting next to the read one.
    if (seg[1] === 'drafts') {
        if (!seg[2] && req.method === 'GET') {
            return send(res, 200, draftsPayload());
        }

        if (!seg[2] && req.method === 'POST') {
            const body = await readJson(req);
            const v = draftFields(body, who, { partial: false });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }
            const draft = drafts.create(v.fields);
            // The store says no by returning null rather than by throwing, so
            // the cap is a 409 and not a 500.
            if (!draft) {
                return send(res, 409, {
                    error: `there are already ${MAX_DRAFTS} drafts — start or delete `
                        + 'some before saving another',
                });
            }
            broadcast('drafts-changed', draftsPayload());
            return send(res, 200, { draft: draftOut(draft) });
        }

        if (seg[2] && !seg[3] && req.method === 'PATCH') {
            const body = await readJson(req);
            // Validated *before* the draft is looked up, so a refused mode is a
            // 403 whether or not the id exists. That is the order
            // `POST /api/sessions/:id/send` uses and the reason is the same: the
            // refusal is about what this caller may ask for, not about what it
            // aimed at, so it must not depend on the target being real. Checking
            // existence first made a phone's attempt to escalate an unknown draft
            // a 404, which reads as "wrong id" rather than "not allowed".
            const v = draftFields(body, who, { partial: true });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }
            const draft = drafts.update(seg[2], v.fields);
            if (!draft) return send(res, 404, { error: 'draft not found' });
            broadcast('drafts-changed', draftsPayload());
            return send(res, 200, { draft: draftOut(draft) });
        }

        if (seg[2] && !seg[3] && req.method === 'DELETE') {
            if (!drafts.remove(seg[2])) return send(res, 404, { error: 'draft not found' });
            broadcast('drafts-changed', draftsPayload());
            return send(res, 200, { ok: true, id: seg[2] });
        }

        // Start it, and only then forget it.
        //
        // A server route rather than the client doing create-then-delete,
        // because there are three clients of this API and one of them cannot
        // read this code — the sequence below is not something each should have
        // to get right. It is deliberately the same sequence `POST /api/sessions`
        // runs, including the rate limit, because it *is* that route with its
        // arguments read off a file.
        if (seg[2] && seg[3] === 'start' && req.method === 'POST') {
            const draft = drafts.get(seg[2]);
            if (!draft) return send(res, 404, { error: 'draft not found' });

            // Re-checked at the moment of spawning, not trusted from write time.
            // The roots are configuration and the mode is the caller's: a draft
            // saved locally must not become a way for a phone to start
            // bypassPermissions, and a directory can be moved after it is saved.
            // Normalised on the way out as well as on the way in. The draft was
            // written through `draftFields`, so its mode is already one of the
            // six — but this file is hand-editable and a draft outlives the
            // process that wrote it, so the value reaching `--permission-mode`
            // should not be taken on trust from JSON on disk.
            const mode = normalizeMode(draft.permissionMode);
            const refusal = modeRefusal(mode, who);
            if (refusal) return send(res, 403, { error: refusal, remote: true });

            if (tooManyCreates()) {
                return send(res, 429, {
                    error: `more than ${CREATE_LIMIT.max} sessions started in a minute — `
                        + 'slow down, or start the rest from the machine itself',
                });
            }

            let out;
            try {
                out = pool.create({
                    cwd: draft.cwd,
                    prompt: draft.prompt,
                    model: draft.model,
                    permissionMode: mode,
                });
            } catch (err) {
                // The draft is still there, which is the point of doing this in
                // this order: a directory that has been moved since you saved it
                // should cost you the press, not the message you wrote.
                return send(res, 400, { error: err.message });
            }

            if (draft.test) flags.set(out.sessionId, { test: true });
            index.note(out.sessionId);
            drafts.remove(seg[2]);
            broadcast('drafts-changed', draftsPayload());
            return send(res, 200, { ...out, test: !!draft.test });
        }
    }

    return NEXT;
}

module.exports = { init, handle, draftsPayload };
