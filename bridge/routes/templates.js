'use strict';

// `/api/templates`: a create call kept for reuse, with placeholders. The store is
// bridge/templates.js.
//
// Writes are validated by `draftFields` from routes/drafts.js, with its two
// requirements switched off. A template is checked the way a draft is, so the
// directory has to exist inside the roots, and a remote caller is refused the
// modes it would be refused when creating. Only the template's own fields are
// checked here.
//
// **Nothing here starts a session.** `resolve` hands back filled fields and the
// client puts them in the Start dialog, where Start sends `POST /api/sessions`
// as usual. Every refusal on that route (rate limit, worktree name, remote
// worktree, mode) therefore still applies, and a template is never a second
// way round them.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract.

const git = require('../git');
const { broadcast } = require('../events');
const { NEXT, readJson, send } = require('../http');
const { resolveWorkdir } = require('../runner');
const { projectName } = require('../sessions');
const {
    MAX_NAME, MAX_TEMPLATES, fillTemplate, localDate, scanTemplate, worktreeSlug,
} = require('../templates');
const { draftFields } = require('./drafts');

let templates = null;

function init(deps) {
    ({ templates } = deps);
}

/**
 * A template as it goes out: the row, plus the project label and which
 * placeholders it uses. Derived here so the desktop and the phone agree on what
 * needs asking, the reason `snippetOut` gives.
 */
function templateOut(row) {
    const { builtins, asks } = scanTemplate(row);
    return {
        ...row,
        projectName: row.project ? projectName(row.project) : null,
        builtins, asks,
    };
}

/** The whole list, which is both the GET body and the SSE payload. Never narrowed. */
function templatesPayload() {
    const rows = templates.list().map(templateOut);
    return { at: Date.now(), templates: rows, counts: { total: rows.length } };
}

/**
 * Everything a template write may carry, checked. `draftFields` covers the fields
 * a draft shares with it; this adds the four only a template has.
 *
 * @returns {{fields: object} | {error: string, status: number, remote?: boolean}}
 */
function templateFields(body, who, { partial }) {
    const v = draftFields(body, who, { partial, requireCwd: false, requirePrompt: false });
    if (v.error) return v;
    const fields = v.fields;
    // Drafts have a title and templates do not. Dropping it here is what keeps a
    // request body from storing one.
    delete fields.title;

    if (!partial || body.name !== undefined) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return { error: 'name is required', status: 400 };
        if (name.length > MAX_NAME) {
            return { error: `name is longer than ${MAX_NAME} characters`, status: 400 };
        }
        fields.name = name;
    }

    if (!partial || body.project !== undefined) {
        // Any directory, whether or not it exists here, for snippets'
        // `cleanProjects` reason: this is a filter, not where a process starts.
        if (body.project != null && typeof body.project !== 'string') {
            return { error: 'project must be a directory or null', status: 400 };
        }
        fields.project = body.project || null;
    }

    if (!partial || body.worktree !== undefined) {
        const wt = body.worktree;
        if (wt != null) {
            if (typeof wt !== 'object' || Array.isArray(wt)
                || typeof wt.name !== 'string' || !wt.name.trim()
                || (wt.base != null && typeof wt.base !== 'string')) {
                return { error: 'worktree must be null or an object {name, base?}', status: 400 };
            }
            // The rule `POST /api/sessions` applies, on draftFields' terms: a
            // phone should not be able to save a template it could never start.
            if (who.remote) {
                return {
                    error: 'a worktree cannot be created remotely — save this template at the machine itself',
                    status: 403, remote: true,
                };
            }
        }
        fields.worktree = wt || null;
    }

    if (!partial || body.orchestrator !== undefined) fields.orchestrator = body.orchestrator === true;
    return { fields };
}

/** The current branch of `dir`, or null when it is not a repository or HEAD is detached. */
async function branchOf(dir) {
    const r = await git.run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 });
    const b = r.ok ? r.stdout.trim() : '';
    return b && b !== 'HEAD' ? b : null;
}

/**
 * Fill a template for use in `cwd`. Built-ins first; then the caller's answers,
 * which may override a built-in (a branch you want to name differently is a
 * reasonable thing to type).
 */
async function resolve(tpl, body) {
    const cwd = (typeof body.cwd === 'string' && body.cwd.trim()) || tpl.cwd || tpl.project || null;
    const values = { date: localDate() };
    if (cwd) {
        values.project = projectName(cwd.replace(/\/\.claude\/worktrees\/[^/]+\/?$/, ''));
        // Only inside the roots, so this cannot become a way to run git in an
        // arbitrary directory. Outside them `{{branch}}` is just left alone, and
        // Start says why the directory is refused.
        let dir = null;
        try { dir = resolveWorkdir(cwd); } catch { /* left unfilled */ }
        if (dir) {
            const b = await branchOf(dir);
            if (b) values.branch = b;
        }
    }
    const given = body.values && typeof body.values === 'object' ? body.values : {};
    for (const [k, v] of Object.entries(given)) {
        if (typeof v === 'string' && v.trim()) values[k] = v.trim();
    }

    const prompt = fillTemplate(tpl.prompt, values);
    const wtName = tpl.worktree ? fillTemplate(tpl.worktree.name, values) : null;
    // A name still holding a placeholder slugs to null, and the dialog asks for one.
    const worktree = tpl.worktree ? { name: worktreeSlug(wtName), base: tpl.worktree.base } : null;
    const left = scanTemplate({ prompt, worktree: wtName ? { name: wtName } : null });
    return {
        fields: {
            cwd, prompt,
            model: tpl.model, effort: tpl.effort, permissionMode: tpl.permissionMode,
            worktree, orchestrator: tpl.orchestrator, test: tpl.test,
        },
        missing: [...left.builtins, ...left.asks],
    };
}

async function handle(req, res, url, pathname, seg, who) {
    if (seg[1] !== 'templates') return NEXT;

    if (!seg[2] && req.method === 'GET') {
        const cwd = url.searchParams.get('cwd');
        if (!cwd) return send(res, 200, templatesPayload());
        const rows = templates.list({ cwd }).map(templateOut);
        return send(res, 200, { at: Date.now(), templates: rows, counts: { total: rows.length } });
    }

    if (!seg[2] && req.method === 'POST') {
        const body = await readJson(req);
        const v = templateFields(body, who, { partial: false });
        if (v.error) {
            return send(res, v.status, v.remote ? { error: v.error, remote: true } : { error: v.error });
        }
        const tpl = templates.create(v.fields);
        if (!tpl) {
            return send(res, 409, {
                error: `there are already ${MAX_TEMPLATES} templates — delete some before saving another`,
            });
        }
        broadcast('templates-changed', templatesPayload());
        return send(res, 200, { template: templateOut(tpl) });
    }

    if (seg[2] && !seg[3] && req.method === 'PATCH') {
        const body = await readJson(req);
        // Validated before the lookup, in the order drafts' PATCH uses: a refusal
        // is about the caller, not about whether the id exists.
        const v = templateFields(body, who, { partial: true });
        if (v.error) {
            return send(res, v.status, v.remote ? { error: v.error, remote: true } : { error: v.error });
        }
        const tpl = templates.update(seg[2], v.fields);
        if (!tpl) return send(res, 404, { error: 'template not found' });
        broadcast('templates-changed', templatesPayload());
        return send(res, 200, { template: templateOut(tpl) });
    }

    if (seg[2] && !seg[3] && req.method === 'DELETE') {
        if (!templates.remove(seg[2])) return send(res, 404, { error: 'template not found' });
        broadcast('templates-changed', templatesPayload());
        return send(res, 200, { ok: true, id: seg[2] });
    }

    if (seg[2] && seg[3] === 'resolve' && req.method === 'POST') {
        const tpl = templates.get(seg[2]);
        if (!tpl) return send(res, 404, { error: 'template not found' });
        const body = await readJson(req);
        return send(res, 200, await resolve(tpl, body || {}));
    }

    return NEXT;
}

module.exports = { init, handle, templatesPayload, resolve };
