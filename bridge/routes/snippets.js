'use strict';

// `/api/snippets` and `/api/snippet-groups`: canned messages and the headings
// they are drawn under. The store, and the seeding of the shipped ones, is
// bridge/snippets.js.
//
// **`reorder` is matched before the `:id` branches**, inside the snippets block,
// exactly as before — see the note there. A snippet that sends itself carries a
// mode, so `snippetFields` asks modeRefusal() for a remote caller.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const cfg = require('../config');
const { broadcast } = require('../events');
const { NEXT, readJson, send } = require('../http');
const { PERMISSION_MODES } = require('../runner');
const {
    INSERT_STYLES, MAX_BODY, MAX_GROUPS, MAX_PARAMS, MAX_PROJECTS, MAX_SNIPPETS,
    MAX_TITLE, isAccent, isParamName, scanPlaceholders,
} = require('../snippets');

// Handed over by server.js — see the note above ROUTES there.
let modeRefusal = null;
let snippetStore = null;

function init(deps) {
    ({ modeRefusal, snippetStore } = deps);
}

/**
 * A snippet as it goes out on the wire: the stored row, plus what its body and
 * its declared parameters say about each other.
 *
 * Derived here rather than in each client, the way `draftOut` derives
 * `projectName` and for the same reason — the desktop, the phone and the Android
 * app should not each get to decide what counts as an undeclared placeholder.
 *
 * **Neither list is an error**, and no route below refuses on either. `undeclared`
 * is left in the message verbatim when the snippet is used; `unused` is a
 * parameter you have declared and not wired up yet, which is a normal state to
 * save a half-finished snippet in. They are here so an editor can say so quietly
 * under the body.
 */
function snippetOut(row) {
    const { undeclared, unused } = scanPlaceholders(row.body, row.params);
    return { ...row, undeclared, unused };
}

/**
 * The whole list, which is both the GET body and the SSE payload.
 *
 * **Never filtered by `cwd`**, even though the GET route offers that filter: one
 * payload goes to every open window and each window's composer is in a different
 * directory. A client that narrowed its first load has to narrow the event too.
 */
function snippetsPayload() {
    const rows = snippetStore.list().map(snippetOut);
    const groups = snippetStore.listGroups();
    return {
        at: Date.now(),
        snippets: rows,
        groups,
        counts: {
            snippets: rows.length,
            groups: groups.length,
            pinned: rows.filter(r => r.pinned).length,
        },
    };
}

/**
 * A snippet's permission mode, where null means inherit.
 *
 * Deliberately not `normalizeMode`. That one answers an unrecognised mode with
 * `auto`, which is the right inert fallback for a send — `auto` is the app's
 * default — and exactly the wrong one here, because a snippet carrying a mode
 * *moves the user's selector* before it sends. Turning a typo into a silent change
 * to the permission mode of the next thing you send is the one direction this
 * field must not fail in. Null is the absence of a choice and there is nothing
 * safer to land on.
 *
 * Still a normalisation rather than a refusal, for the reason `normalizeMode`
 * exists at all: losing a whole snippet over one bad field is worse than the field
 * doing nothing.
 */
function snippetMode(v) {
    if (v == null || v === '') return null;
    return PERMISSION_MODES.includes(v) ? v : null;
}

/**
 * Validate what a snippet write is asking for.
 *
 * `partial` is PATCH: a field absent from the body is left alone rather than
 * validated as missing. The `{fields} | {error, status, remote?}` shape is
 * `draftFields`', and so is the habit of returning the first problem rather than
 * collecting them — a form with one bad field is the normal case.
 *
 * Two fields **normalise** rather than refuse and two do not, and the split is on
 * purpose. A parameter's `type` and a group's `accent` are open sets whose worst
 * case is a field that still holds the right value, so an unrecognised one widens
 * to `text` and to no accent. An unrecognised `insert` is a 400, because its three
 * values decide what happens to text the user has *already typed* and one of them
 * replaces it — there is no fallback that is both the natural default and
 * harmless. It is also a closed set of three drawn as a picker, so a bad value
 * cannot come from a person; it comes from a script, and a script is exactly the
 * caller worth telling.
 *
 * @returns {{fields: object} | {error: string, status: number, remote?: boolean}}
 */
function snippetFields(body, who, { partial }) {
    const fields = {};

    if (!partial || body.title !== undefined) {
        const title = body.title && String(body.title).trim();
        if (!title) return { error: 'title is required', status: 400 };
        if (title.length > MAX_TITLE) {
            return { error: `title is longer than ${MAX_TITLE} characters`, status: 400 };
        }
        fields.title = title;
    }

    if (!partial || body.body !== undefined) {
        const text = body.body == null ? '' : String(body.body);
        // Non-empty once trimmed, but **stored untrimmed**: an `insert` of
        // `append` or `cursor` makes leading and trailing whitespace part of what
        // the snippet means. Two different tests, deliberately.
        if (!text.trim()) return { error: 'body is required', status: 400 };
        if (text.length > MAX_BODY) {
            return { error: `body is longer than ${MAX_BODY} characters`, status: 400 };
        }
        fields.body = text;
    }

    if (!partial || body.groupId !== undefined) {
        const groupId = body.groupId == null ? null : String(body.groupId);
        // Checked on write and *not* on read, which is asymmetric on purpose: the
        // caller picked from a list of groups this bridge just sent it, so a bad
        // id here is a bug worth naming. A row already on disk pointing at a group
        // this process cannot see may belong to another bridge that still holds
        // it, and rewriting it would be the thing merge-on-write exists to avoid.
        if (groupId && !snippetStore.getGroup(groupId)) {
            return { error: 'no such snippet group', status: 400 };
        }
        fields.groupId = groupId;
    }

    if (!partial || body.params !== undefined) {
        const list = body.params === undefined ? [] : body.params;
        if (!Array.isArray(list)) return { error: 'params must be an array', status: 400 };
        if (list.length > MAX_PARAMS) {
            return { error: `a snippet may declare at most ${MAX_PARAMS} parameters`, status: 400 };
        }
        const seen = new Set();
        for (const p of list) {
            const name = p && p.name && String(p.name).trim();
            // All three failures mean one thing — this parameter can never be
            // referenced — because a parameter's identity *is* its name, and that
            // name is what `{{name}}` in the body looks up.
            if (!name || !isParamName(name)) {
                return {
                    error: `"${name || ''}" is not a usable parameter name — letters, `
                        + 'digits and underscores, not starting with a digit',
                    status: 400,
                };
            }
            if (seen.has(name)) {
                return { error: `two parameters are both called "${name}"`, status: 400 };
            }
            seen.add(name);
        }
        fields.params = list;
    }

    if (!partial || body.insert !== undefined) {
        const insert = body.insert === undefined ? 'overwrite' : body.insert;
        if (!INSERT_STYLES.includes(insert)) {
            return {
                error: `insert must be one of ${INSERT_STYLES.join(', ')}`,
                status: 400,
            };
        }
        fields.insert = insert;
    }

    if (!partial || body.permissionMode !== undefined) {
        const mode = snippetMode(body.permissionMode);
        // A snippet with `autoSubmit` and a mode is one pinned button that sets the
        // mode and sends — which is a sharper version of what REMOTE_FORBIDDEN_MODES
        // is about, not a weaker one. Refused twice over: here, so a phone cannot
        // stash one, and again by the send route when it is used.
        const refusal = mode ? modeRefusal(mode, who) : null;
        if (refusal) return { error: refusal, status: 403, remote: true };
        fields.permissionMode = mode;
    }

    if (!partial || body.projects !== undefined) {
        const list = body.projects === undefined ? [] : body.projects;
        if (!Array.isArray(list)) return { error: 'projects must be an array', status: 400 };
        if (list.length > MAX_PROJECTS) {
            return { error: `a snippet may name at most ${MAX_PROJECTS} projects`, status: 400 };
        }
        fields.projects = list;
    }

    if (!partial || body.order !== undefined) {
        if (body.order !== undefined && body.order !== null && !Number.isInteger(body.order)) {
            return { error: 'order must be an integer or null', status: 400 };
        }
        fields.order = body.order === undefined ? null : body.order;
    }

    // The rest mean "no" when absent rather than being invalid.
    if (!partial || body.hint !== undefined) fields.hint = body.hint || null;
    if (!partial || body.autoSubmit !== undefined) fields.autoSubmit = !!body.autoSubmit;
    if (!partial || body.pinned !== undefined) fields.pinned = !!body.pinned;

    return { fields };
}

/** The same, for a group: a name, a colour and a place in the row. */
function snippetGroupFields(body, { partial }) {
    const fields = {};

    if (!partial || body.name !== undefined) {
        const name = body.name && String(body.name).trim();
        if (!name) return { error: 'name is required', status: 400 };
        if (name.length > MAX_TITLE) {
            return { error: `name is longer than ${MAX_TITLE} characters`, status: 400 };
        }
        fields.name = name;
    }

    if (!partial || body.accent !== undefined) {
        // Normalised rather than refused — but strictly, because the client sets
        // this as a CSS custom property and anything looser is a declaration in
        // the page's stylesheet rather than a colour.
        fields.accent = isAccent(body.accent) ? body.accent : null;
    }

    if (!partial || body.order !== undefined) {
        if (body.order !== undefined && body.order !== null && !Number.isInteger(body.order)) {
            return { error: 'order must be an integer or null', status: 400 };
        }
        fields.order = body.order === undefined ? null : body.order;
    }

    return { fields };
}

async function handle(req, res, url, pathname, seg, who) {
    // ── snippets ─────────────────────────────────────────────────────────
    //
    // Canned messages: a title, a body, what to ask before sending it and where
    // it lands in the compose box — see bridge/snippets.js. What replaced the one
    // hard-coded LGTM button.
    //
    // All eight in one block, beside drafts and for the reason that block gives.
    //
    // **`reorder` is matched before the `:id` branches**, and the order of these
    // `if`s is load-bearing rather than stylistic: a snippet id is a UUID or a
    // `seed-` string so a real collision is impossible, but a `POST` to
    // `/api/snippets/reorder` reaching the id branches instead would be a silent
    // miss rather than an error. Groups live at `/api/snippet-groups` rather than
    // under this prefix precisely so there is only one reserved word to remember.
    if (seg[1] === 'snippets') {
        if (!seg[2] && req.method === 'GET') {
            const cwd = url.searchParams.get('cwd');
            if (!cwd) return send(res, 200, snippetsPayload());
            // The filter is offered so a client need not implement the prefix rule
            // itself. The counts stay whole on purpose: a popover that says "2 more
            // here" needs both numbers, and a snippet you cannot find because you
            // are in the wrong directory is otherwise indistinguishable from one
            // you deleted.
            const all = snippetsPayload();
            return send(res, 200, {
                ...all,
                snippets: snippetStore.list({ cwd: cfg.expandHome(cwd) }).map(snippetOut),
            });
        }

        if (!seg[2] && req.method === 'POST') {
            const body = await readJson(req);
            const v = snippetFields(body, who, { partial: false });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }
            const snippet = snippetStore.create(v.fields);
            // The store says no by returning null rather than by throwing, so the
            // cap is a 409 and not a 500.
            if (!snippet) {
                return send(res, 409, {
                    error: `there are already ${MAX_SNIPPETS} snippets — delete some `
                        + 'before saving another',
                });
            }
            broadcast('snippets-changed', snippetsPayload());
            return send(res, 200, { snippet: snippetOut(snippet) });
        }

        // The whole arrangement in one call. A drag knows the final order and so
        // does an up arrow, and a swap done as two PATCHes has an instant in the
        // middle where both rows hold the same number and two events go out.
        if (seg[2] === 'reorder' && !seg[3] && req.method === 'POST') {
            const body = await readJson(req);
            for (const key of ['snippets', 'groups']) {
                if (body[key] === undefined) continue;
                if (!Array.isArray(body[key]) || body[key].some(id => typeof id !== 'string')) {
                    return send(res, 400, { error: `${key} must be an array of ids` });
                }
            }
            const moved = snippetStore.reorder(body);
            // Nothing moved is not an error and not worth a push: a drag that lands
            // where it started is a no-op all the way down.
            if (moved.snippets || moved.groups) {
                broadcast('snippets-changed', snippetsPayload());
            }
            return send(res, 200, snippetsPayload());
        }

        if (seg[2] && !seg[3] && req.method === 'PATCH') {
            const body = await readJson(req);
            // Validated *before* the snippet is looked up, so a refused mode is a
            // 403 whether or not the id exists — the order the drafts PATCH uses,
            // and the reason is the same: the refusal is about what this caller
            // may ask for, not about what it aimed at.
            const v = snippetFields(body, who, { partial: true });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }
            const snippet = snippetStore.update(seg[2], v.fields);
            if (!snippet) return send(res, 404, { error: 'snippet not found' });
            broadcast('snippets-changed', snippetsPayload());
            return send(res, 200, { snippet: snippetOut(snippet) });
        }

        if (seg[2] && !seg[3] && req.method === 'DELETE') {
            if (!snippetStore.remove(seg[2])) {
                return send(res, 404, { error: 'snippet not found' });
            }
            broadcast('snippets-changed', snippetsPayload());
            return send(res, 200, { ok: true, id: seg[2] });
        }
    }

    // ── snippet groups ───────────────────────────────────────────────────
    //
    // A heading and an accent colour for the snippets drawn under it. Its own
    // prefix rather than `/api/snippets/groups`, so that `reorder` above is the
    // only reserved word in that path and `groups` cannot be mistaken for an id.
    //
    // There is no `GET`: a group is only ever read as part of the snippet list,
    // and a route returning half the popover's data would be one more thing for a
    // client to keep in step.
    if (seg[1] === 'snippet-groups') {
        if (!seg[2] && req.method === 'POST') {
            const body = await readJson(req);
            const v = snippetGroupFields(body, { partial: false });
            if (v.error) return send(res, v.status, { error: v.error });
            const group = snippetStore.createGroup(v.fields);
            if (!group) {
                return send(res, 409, {
                    error: `there are already ${MAX_GROUPS} snippet groups — delete some `
                        + 'before making another',
                });
            }
            broadcast('snippets-changed', snippetsPayload());
            return send(res, 200, { group });
        }

        if (seg[2] && !seg[3] && req.method === 'PATCH') {
            const body = await readJson(req);
            const v = snippetGroupFields(body, { partial: true });
            if (v.error) return send(res, v.status, { error: v.error });
            const group = snippetStore.updateGroup(seg[2], v.fields);
            if (!group) return send(res, 404, { error: 'snippet group not found' });
            broadcast('snippets-changed', snippetsPayload());
            return send(res, 200, { group });
        }

        // Deleting a heading does not delete what was written under it. The
        // snippets come loose and keep their `groupId`, so recreating a group with
        // the same id puts them back — and so that one bridge is not rewriting
        // rows on the strength of a deletion another has not seen. `orphaned` is
        // how many moved, so the UI can say so rather than leaving somebody to
        // notice.
        if (seg[2] && !seg[3] && req.method === 'DELETE') {
            const out = snippetStore.removeGroup(seg[2]);
            if (!out) return send(res, 404, { error: 'snippet group not found' });
            broadcast('snippets-changed', snippetsPayload());
            return send(res, 200, { ok: true, id: seg[2], orphaned: out.orphaned });
        }
    }

    return NEXT;
}

module.exports = { init, handle };
