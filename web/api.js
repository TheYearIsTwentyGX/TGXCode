// Talking to the bridge: one fetch wrapper per verb.
//
// Moved out of app.js so every surface that calls the bridge imports the same
// five helpers rather than reaching into a 25,000-line module for them. Nothing
// here touches the DOM or app state; a refusal comes back as a thrown Error
// carrying `status` and `data` (see httpError), never as a return value.

// The CSRF header under both names. web/ is live the moment it lands, but the
// bridge serving it keeps its old code until it restarts, and a bridge from
// before the rename only knows X-Claude-Sessions-Client. The same goes for the
// `cs-*` <meta> names read in boot.js beside their `tgx-*` ones. Drop the old names
// once no bridge that predates the rename can be running.
export const HEADERS = { 'X-TGXCode-Client': '1', 'X-Claude-Sessions-Client': '1', 'Content-Type': 'application/json' };

/**
 * The Error a failed call throws, carrying the status and the body with it.
 *
 * Every helper below used to throw a bare `new Error(data.error)`, which is
 * enough while every refusal means the same thing to a caller. It stopped being
 * enough with `PUT /api/claude-config`: a `409` there is not a mistake to
 * apologise for but a file that changed underneath, the body carries the file
 * as it is now, and a caller that could only read the sentence would have to
 * match on prose to tell the two apart.
 */
export function httpError(status, data) {
    const err = new Error(data.error || `HTTP ${status}`);
    err.status = status;
    err.data = data;
    return err;
}

export async function get(path) {
    const r = await fetch(path, { headers: { 'X-TGXCode-Client': '1', 'X-Claude-Sessions-Client': '1' } });
    if (!r.ok) throw httpError(r.status, await r.json().catch(() => ({})));
    return r.json();
}

export async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(r.status, data);
    return data;
}

/**
 * POST a file's bytes, rather than JSON.
 *
 * The only route that takes a body which is not JSON. Raw bytes and not
 * base64-in-JSON because `readJson` on the bridge caps a body at 4MB and base64 is a
 * third bigger than what it encodes — which would put the real limit at under 3MB, and
 * a screenshot off this machine's display goes past that regularly.
 *
 * The client header is what `post` sets too; it is required on every non-GET under
 * /api/, and forgetting it here would fail as a 403 that looks like an auth problem.
 */
export async function postFile(path, file) {
    const r = await fetch(path, {
        method: 'POST',
        headers: {
            'X-TGXCode-Client': '1', 'X-Claude-Sessions-Client': '1',
            // The bridge sniffs the real type from the bytes; this is a hint, and the
            // fallback matters because a File dragged from some places has no type.
            'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(r.status, data);
    return data;
}

/**
 * A partial update — `PATCH /api/drafts/:id`, `/api/snippets/:id` and their
 * neighbours — where the verb is load-bearing: a field left out of the body is
 * left alone, which is how a dialog can save a change to the message without
 * restating the model and the permission mode it did not touch.
 */
export async function patch(path, body) {
    const r = await fetch(path, { method: 'PATCH', headers: HEADERS, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(r.status, data);
    return data;
}

/**
 * A whole value, replaced. Three routes: `PUT /api/prefs`,
 * `PUT /api/claude-config` and `PUT /api/claude-docs`.
 *
 * Not `patch`, even though the body is a patch of sections, because what it
 * replaces is each *key* it names — including `keyboard.bindings`, which is one
 * key whose value is a map and so goes over wholesale. PATCH would promise a
 * merge one level deeper than the bridge does.
 */
export async function put(path, body) {
    const r = await fetch(path, { method: 'PUT', headers: HEADERS, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(r.status, data);
    return data;
}

export async function del(path) {
    const r = await fetch(path, { method: 'DELETE', headers: HEADERS });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(r.status, data);
    return data;
}
