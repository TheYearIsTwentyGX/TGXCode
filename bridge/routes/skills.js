'use strict';

// `/api/skills`: the Skills page. The files are bridge/skills.js, importing
// (staging, preview, install, and searching with `npx skills find`) is
// bridge/skill-import.js.
//
// **Every route here is refused to a remote caller, both methods**, and the
// refusal is remoteRefusal()'s in server.js, by prefix. The writes put files
// into directories a model reads its instructions from; the import fetches a
// stranger's repository onto this machine; and even the GETs name every path a
// skill lives at. None of that is something a phone should do or need.
//
// One of the route modules server.js's `api()` asks in turn — `handle` returns
// `NEXT` for anything not its own.

const { NEXT, readJson, send } = require('../http');
const skills = require('../skills');
const imports = require('../skill-import');

function init() { /* no dependencies */ }

/** A refusal's code as an HTTP status. */
function statusOf(code) {
    switch (code) {
        case 'invalid': return 400;
        case 'read-only': case 'symlink': return 403;
        case 'not-found': return 404;
        case 'conflict': case 'exists': return 409;
        case 'too-large': return 413;
        case 'fetch': return 502;
        case 'unavailable': return 503;
        default: return 500;
    }
}

function fail(res, err) {
    if (!err.code || typeof err.code !== 'string' || statusOf(err.code) === 500) {
        return send(res, 500, { error: err.message || String(err), code: 'error' });
    }
    return send(res, statusOf(err.code), { error: err.message, code: err.code, ...(err.detail || {}) });
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

async function handle(req, res, url, pathname) {
    if (pathname !== '/api/skills' && !pathname.startsWith('/api/skills/')) return NEXT;
    const q = (k) => url.searchParams.get(k) || '';
    try {
        if (pathname === '/api/skills' && req.method === 'GET') {
            return send(res, 200, skills.list(q('project')));
        }
        if (pathname === '/api/skills' && req.method === 'POST') {
            const b = await readJson(req);
            return send(res, 201, { skill: skills.create({
                runtime: b.runtime, scope: b.scope, project: b.project, name: b.name, description: b.description,
            }) });
        }
        if (pathname === '/api/skills' && req.method === 'DELETE') {
            return send(res, 200, skills.remove({ dir: q('dir'), project: q('project') }));
        }
        if (pathname === '/api/skills/file' && req.method === 'GET') {
            return send(res, 200, skills.readFile({ dir: q('dir'), file: q('file') || undefined, project: q('project') }));
        }
        if (pathname === '/api/skills/file' && req.method === 'PUT') {
            const b = await readJson(req);
            return send(res, 200, skills.writeFile({
                dir: b.dir, file: b.file, project: b.project, text: b.text,
                // Absent and null mean different things: "forgot the
                // precondition" and "this file should not exist yet".
                stamp: has(b, 'stamp') ? b.stamp : undefined,
            }));
        }
        if (pathname === '/api/skills/copy' && req.method === 'POST') {
            const b = await readJson(req);
            return send(res, 201, { skill: skills.copy({ dir: b.dir, project: b.project, target: b.target || {} }) });
        }
        if (pathname === '/api/skills/search' && req.method === 'GET') {
            return send(res, 200, await imports.search(q('q')));
        }
        if (pathname === '/api/skills/import/stage' && req.method === 'POST') {
            const b = await readJson(req);
            return send(res, 200, await imports.stage({ source: b.source, skill: b.skill }));
        }
        if (pathname === '/api/skills/import/install' && req.method === 'POST') {
            const b = await readJson(req);
            return send(res, 200, imports.install({
                id: b.id, digest: b.digest, skills: b.skills, target: b.target || {}, project: b.project,
                overwrite: b.overwrite === true,
            }));
        }
        const m = /^\/api\/skills\/import\/([A-Za-z0-9_-]+)$/.exec(pathname);
        if (m && req.method === 'DELETE') {
            return send(res, 200, { ok: true, discarded: imports.discard(m[1]) });
        }
    } catch (err) {
        return fail(res, err);
    }
    return NEXT;
}

module.exports = { init, handle, statusOf };
