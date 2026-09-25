'use strict';

// The commands a project declares, and the runs started from them:
// `/api/commands` (the merged list, and `/run`), `/api/runs`, and
// `/api/commands-config`, the editor's view of the same files. See
// bridge/commands.js and bridge/runs.js.
//
// **Mostly refused remotely, and not all of it.** remoteRefusal() refuses every
// `/api/runs` route, `POST /api/commands/run` and both methods of
// `/api/commands-config`; `GET /api/commands` stays readable. The comments beside
// each route, and in remoteRefusal(), say why the two reads differ.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const commands = require('../commands');
const cfg = require('../config');
const { broadcast, streamBytes } = require('../events');
const git = require('../git');
const { NEXT, readJson, send } = require('../http');

// Handed over by server.js — see the note above ROUTES there.
let runs = null;

function init(deps) {
    ({ runs } = deps);
}

/**
 * Which status a refusal from the project-command editor is.
 *
 * The same split claudeConfigStatus draws — the caller's mistake against the
 * machine's answer about what is possible, with a conflict as neither. `invalid`
 * is this file's `value`: a document the reader would refuse wholesale, carrying
 * `detail.problems` so a form can put each message on the row and field it is
 * about rather than at the top of the card.
 */
function commandsConfigStatus(code) {
    if (['scope', 'dir', 'body', 'stamp', 'invalid', 'json', 'version'].includes(code)) return 400;
    if (['stale', 'exists'].includes(code)) return 409;
    if (code === 'size') return 413;
    return 403;   // readonly, write
}

/**
 * The editor's read, plus the one thing the module cannot answer cheaply.
 *
 * `commands.raw()` asks whether the local file is excluded with the synchronous
 * check the read path already uses, which returns a bare boolean. Here the
 * answer is a sentence on screen, so it is re-asked through git.ignored() for
 * the rule that matched — the same upgrade claudeConfigPayload makes, and for
 * the same reason: on this machine a file can be excluded by a *global* rule
 * that no amount of looking in the repository would reveal, and "add a line to
 * .gitignore" is bad advice when the line is already somewhere else.
 */
async function commandsConfigPayload(cwd) {
    const base = commands.raw(cwd);
    if (!base) return null;
    const files = await Promise.all(base.files.map(async (f) => {
        if (f.scope !== 'project-local') return f;
        const answer = await git.ignored(base.project,
            `${cfg.TGX_DIR}/${cfg.COMMANDS_LOCAL_FILE}`);
        return { ...f, ignored: answer.ignored, ignoredBy: answer.source };
    }));
    return { ...base, files };
}

async function handle(req, res, url, pathname, seg, who) {
    // ── The commands a project declares, as an editor sees them ─────────────
    //
    // Not /api/commands. That route answers "what buttons does this directory
    // have", merged into one list with every placeholder expanded, and it is
    // readable from a phone. This one answers "what does each file *say*",
    // which is a different question with a different audience: a control seeded
    // from the merged answer writes the merged answer back, and one that meant
    // to add a single local override ends up copying every shared command into
    // a personal file. bridge/claude-config.js hit that exact bug twice.
    //
    // Local callers only, both methods — see remoteRefusal() for why the read
    // is refused here where the merged one is not.
    if (pathname === '/api/commands-config' && req.method === 'GET') {
        const payload = await commandsConfigPayload(url.searchParams.get('cwd') || '');
        if (!payload) {
            return send(res, 403, { error: 'that directory is outside the allowed roots' });
        }
        return send(res, 200, payload);
    }

    // Two bodies, one route, in the shape PUT /api/claude-config uses.
    // `commands` replaces the array and is what the form sends; `text` replaces
    // the document and is the only thing that can repair a file which no longer
    // parses. Exactly one of them.
    //
    // `stamp` is required by both and `undefined` is a refusal, unlike
    // claude-config where a single scalar patch may omit it. There is no partial
    // write here — every save replaces the whole array — so there is no write
    // that a read immediately beforehand could make safe.
    //
    // `version` is deliberately not in the body. A client that could send
    // `version: 7` is a client that can write a file this bridge then refuses to
    // read, so the writer stamps it.
    if (pathname === '/api/commands-config' && req.method === 'PUT') {
        const body = await readJson(req);
        const hasCommands = body.commands !== undefined;
        const hasText = body.text !== undefined;
        if (hasCommands === hasText) {
            return send(res, 400, { error: 'send exactly one of commands or text', code: 'body' });
        }
        let saved;
        try {
            const req_ = {
                scope: body.scope || 'project',
                dir: body.cwd || '',
                // Absent and null mean different things — "I forgot the
                // precondition" and "this file should not exist yet" — so the
                // distinction has to survive the JSON.
                stamp: Object.prototype.hasOwnProperty.call(body, 'stamp') ? body.stamp : undefined,
            };
            saved = hasCommands
                ? commands.saveDoc({ ...req_, commands: body.commands })
                : commands.saveText({ ...req_, text: body.text });
        } catch (err) {
            return send(res, commandsConfigStatus(err.code), {
                error: err.message,
                code: err.code || 'save',
                // A conflict carries the file as it is now; an invalid document
                // carries a problem per row. Both let the page say what is wrong
                // rather than only that something is.
                ...(err.detail || {}),
            });
        }
        // The fact of a change, not its content — the trade claude-config and
        // claude-docs both make, and here with a second reason: the content
        // carries env values this route has just classified as local-only, and
        // /api/events reaches every open window including a paired phone.
        //
        // A window listening for this re-reads the settings group, and reloads
        // the header buttons when the directory it has open belongs to the
        // project that changed. Without that second half you rename a command
        // and the button keeps its old label until you switch sessions.
        broadcast('commands-config', {
            at: Date.now(), scope: body.scope || 'project',
            project: saved.project, file: saved.file,
        });
        // The same shape the GET returns, so a client can take the answer
        // wholesale rather than patching its own copy — which is what keeps
        // `ignored` and `merged` from vanishing from a page's state on a save.
        return send(res, 200, {
            file: saved.file,
            stamp: saved.stamp,
            config: await commandsConfigPayload(saved.project),
        });
    }

    // --- project commands --------------------------------------------------
    // What a directory declares in .tgxcode/, and the runs started from it. See
    // bridge/commands.js for why reading a file out of a project is new ground,
    // and bridge/runs.js for why a run is a terminal underneath.
    if (seg[1] === 'commands') {
        if (!seg[2] && req.method === 'GET') {
            const dir = url.searchParams.get('cwd');
            if (!dir) return send(res, 400, { error: 'cwd is required' });
            const listed = commands.load(dir);
            if (!listed) return send(res, 403, { error: 'that directory is outside the allowed roots' });
            // The live run travels with the command so one request paints the
            // whole row: a button that does not know it is already running is
            // a button that starts a second server.
            return send(res, 200, {
                ...listed,
                commands: listed.commands.map((c) => {
                    const run = runs.forCommand(listed.workspace, c.id);
                    return { ...c, run: run ? run.info() : null };
                }),
            });
        }

        if (seg[2] === 'run' && req.method === 'POST') {
            const body = await readJson(req);
            if (!body.cwd || !body.id) return send(res, 400, { error: 'cwd and id are required' });
            if (!cfg.withinRoots(body.cwd)) {
                return send(res, 403, { error: 'that directory is outside the allowed roots' });
            }
            const out = await runs.start(body.cwd, body.id);
            if (out.error) {
                return send(res, out.status || 400,
                    { error: out.error, run: out.run ? out.run.info() : undefined });
            }
            return send(res, 200, { run: out.run.info() });
        }
    }

    if (seg[1] === 'runs') {
        if (!seg[2] && req.method === 'GET') return send(res, 200, { runs: runs.list() });

        if (seg[2]) {
            const run = runs.get(seg[2]);
            if (!run) return send(res, 404, { error: 'no such run' });
            const tail = seg[3];

            if (!tail && req.method === 'GET') return send(res, 200, { run: run.info() });

            // The same byte pipe a terminal uses, for the same reason.
            if (tail === 'stream' && req.method === 'GET') {
                return streamBytes(req, res, run.term, run.info());
            }

            if (tail === 'input' && req.method === 'POST') {
                const body = await readJson(req);
                if (typeof body.b64 !== 'string') return send(res, 400, { error: 'b64 is required' });
                // Writable on purpose: vite's `r`, jest's watch keys, and Ctrl-C
                // as a gentler stop than the SIGHUP the stop button sends.
                const ok = run.term.write(Buffer.from(body.b64, 'base64'));
                return send(res, 200, { ok, exited: run.term.exited });
            }

            if (tail === 'resize' && req.method === 'POST') {
                const body = await readJson(req);
                run.term.resize(body.rows, body.cols);
                return send(res, 200, { ok: true, rows: run.term.rows, cols: run.term.cols });
            }

            if (tail === 'stop' && req.method === 'POST') {
                return send(res, 200, { ok: runs.stop(run.id), run: run.info() });
            }

            // Forgetting is not stopping. Conflating them is how somebody kills
            // a dev server by tidying a list.
            if (!tail && req.method === 'DELETE') {
                if (!run.exitedAt) {
                    return send(res, 409, { error: 'still running — stop it first', run: run.info() });
                }
                return send(res, 200, { ok: runs.forget(run.id) });
            }
        }
    }

    return NEXT;
}

module.exports = { init, handle };
