'use strict';

// One session's working directory rather than its conversation: its dev servers,
// the changes panel (`changes`, `diff`), its pull requests, `reveal`,
// `open-file` and its terminal pane. The conversation is session.js — see the
// header there for why the one `/api/sessions/:id` block became two files.
//
// Refused to a remote caller before it gets here, by remoteRefusal(): `POST
// reveal` and `POST open-file`, which put a window on this machine's desktop.
// `GET diff` is deliberately not — see the note in remoteRefusal().
//
// `workingDir`, `archiveStoppedRuns`, `sessionRoot` and the two diff constants
// came with the routes; `archiveStoppedRuns` is lent to session.js, whose archive
// flag is what calls it.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const fs = require('fs');
const path = require('path');
const changes = require('../changes');
const cfg = require('../config');
const devbrowser = require('../devbrowser');
const devservers = require('../devservers');
const { isLaunchable, openFile, openInExplorer } = require('../explorer');
const git = require('../git');
const { NEXT, readJson, send } = require('../http');
const prStore = require('../pr-store');
const pulls = require('../pulls');

// Handed over by server.js — see the note above ROUTES there.
let index = null;
let runs = null;
let terminals = null;

function init(deps) {
    ({ index, runs, terminals } = deps);
}

// How many working-tree files the changes panel is sent. Well past what anybody
// scrolls, and low enough that a `node_modules` somebody forgot to ignore cannot
// turn one panel into a megabyte of JSON.
const CHANGED_FILE_CAP = 400;

// The three questions "what changed in this file" can mean, and the only three
// `/diff` will answer to. An unrecognised one is a 400 rather than a silent
// fallback to the default: a client asking for `cached` and being handed the
// worktree would draw a confident, wrong answer.
const DIFF_MODES = new Set(['worktree', 'staged', 'unstaged']);

/**
 * The repository root a session's file paths are relative to.
 *
 * `tree.root` only when git said `ok`. A `left-behind` answer carries a `root`
 * too and it is the *parent* repository — the trap workingState documents — so
 * taking it would resolve a removed worktree's paths against the main checkout.
 */
async function sessionRoot(dir) {
    if (!dir) return null;
    const tree = await git.statusOf(dir, { limit: 0 });
    return (tree && tree.ok && tree.root) || dir;
}

/**
 * Where the agent is working now: its current cwd, which for a session that
 * entered a worktree is the worktree itself. Reveal and the terminal pane both
 * mean this directory when they say "where the session is".
 */
function workingDir(summary) {
    return [summary.cwd, summary.worktree && summary.worktree.path, summary.projectCwd]
        .find(d => d && fs.existsSync(d)) || null;
}

/**
 * Archiving a session stops the commands running in its directory — but only
 * once nothing else is using it.
 *
 * Archiving is how you say you are done with a piece of work, and a dev server
 * for a branch nobody is looking at any more is exactly the thing that ends up
 * holding a port for a week. Runs are keyed by directory rather than by session
 * though, and several sessions share a worktree routinely, so archiving one of
 * three would otherwise pull the server out from under the other two. The last
 * one out turns the lights off.
 *
 * @returns {number} how many runs were stopped
 */
function archiveStoppedRuns(summary) {
    const dir = workingDir(summary);
    // Asked first, and cheap: almost every archive is of a session in a
    // directory nothing is running in, and the scan below is not free.
    if (!dir || !runs.forWorkspace(dir).some(r => !r.exitedAt)) return 0;

    // Compared as strings rather than through workingDir(), which stats up to
    // three paths per session — a few thousand of those on every archive click,
    // to answer a question the recorded paths already answer.
    const others = index.list({ includeTest: true, limit: 1000 }).some(s =>
        s.sessionId !== summary.sessionId && !s.archived
        && (s.cwd === dir || (s.worktree && s.worktree.path === dir) || s.projectCwd === dir));
    if (others) return 0;
    const stopped = runs.stopWorkspace(dir);
    if (stopped) {
        console.log(`[tgxcode] archived ${summary.sessionId}: stopped ${stopped} run(s) in ${dir}`);
    }
    return stopped;
}

async function handle(req, res, url, pathname, seg, who) {
    // /api/sessions/:id[/...]
    if (seg[1] === 'sessions' && seg[2]) {
        const sessionId = seg[2];
        const tail = seg[3];


        if (tail === 'devservers' && req.method === 'GET') {
            const data = index.read(sessionId);
            if (!data) return send(res, 404, { error: 'session not found' });
            const s = data.summary;
            const candidates = [...devservers.detect(data.events).values()];
            const titles = await devbrowser.titles();
            const out = await devservers.enrich(candidates, titles, {
                id: sessionId,
                workspace: workingDir(s),
                worktreeName: s.worktree && s.worktree.name,
                projectName: s.projectName,
                lastTs: s.lastTs,
            });
            return send(res, 200, out);
        }

        // What this session changed — the two answers, side by side.
        //
        // `edits` comes out of the transcript and is about this session: it holds
        // files it edited and has since committed, and it is still right when the
        // working tree has moved on or gone. `git` is the tree as it stands and is
        // about the directory: it holds work somebody else did, and drops work
        // this session did and reverted. Neither is a better version of the other,
        // which is why both are sent and the panel draws them as two lists.
        //
        // Not on the summary, for `prs`' reason one line further down: it shells
        // out, and the session list must never wait on that.
        if (tail === 'changes' && req.method === 'GET') {
            // The summary, not the transcript: `changes.js` reads the file itself,
            // from wherever it stopped last time. A panel that re-asked on every
            // turn would otherwise re-parse the whole conversation each time, and
            // the transcripts on this machine run to tens of megabytes.
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const rec = index.get(sessionId);
            const dir = workingDir(summary);
            if (url.searchParams.get('refresh') && dir) git.clearCache(dir);

            const tree = dir
                ? await git.statusOf(dir, { limit: CHANGED_FILE_CAP })
                : { ok: false, reason: 'no-directory' };
            // Line counts only where there is a tree to diff. Untracked files are
            // not in `git diff` and stay countless, which is what the UI's "new"
            // already says about them.
            if (tree && tree.ok) {
                const counts = await git.numstat(dir);
                tree.sample = tree.sample.map(f => ({ ...f, ...(counts.get(f.path) || {}) }));
            }

            const derived = changes.forSession(index, sessionId, {
                sessionDir: rec ? path.join(rec.dir, sessionId) : null,
                // The repository root where there is one, so a path reads the same
                // here as it does in the tree list beside it.
                root: (tree && tree.root) || dir,
            });
            if (!derived) return send(res, 404, { error: 'session not found' });

            return send(res, 200, {
                dir,
                checkedAt: new Date().toISOString(),
                git: tree,
                edits: derived.files,
                agents: derived.agents,
                added: derived.added,
                deleted: derived.deleted,
            });
        }

        // What changed inside one of those files.
        //
        // The content behind a row in `/changes`. This is the *tree's* answer —
        // the transcript's is the structured patch already on each tool result,
        // which a client that has the conversation loaded can assemble itself, and
        // which is the only answer left once a file has been committed. Sending
        // both from here would mean re-parsing the transcript for a file the
        // client can already see.
        //
        // Deliberately not refused to a remote caller, unlike its neighbours. Every
        // clause in `remoteRefusal` is either a write or a reach past the app into
        // the machine, and this is a read — one whose bytes a phone already gets,
        // in the tool results it renders today. What makes that safe rather than
        // merely convenient is `sessionFilePath`: the answer is scoped to this
        // session's own repository, so a leaked token cannot walk it to ~/.ssh.
        //
        // No cache. `statusOf`'s fifteen seconds exist because the dashboard asks
        // about forty directories on a timer; a diff is asked for once, by a person
        // who wants it as it is now, and caching 2MB strings per file would trade
        // memory for nothing.
        if (tail === 'diff' && req.method === 'GET') {
            const given = String(url.searchParams.get('path') || '').trim();
            const mode = url.searchParams.get('mode') || 'worktree';
            // Asked before the session is looked up, for `attachmentRefused`'s
            // reason: a request wrong about both should be refused for the thing
            // that was wrong, not have the difference read as an id oracle.
            if (!given) return send(res, 400, { error: 'path is required' });
            if (!DIFF_MODES.has(mode)) {
                return send(res, 400, {
                    error: `mode must be one of ${[...DIFF_MODES].join(', ')}`,
                });
            }

            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });

            const answer = (body) => send(res, 200, {
                path: given, mode, checkedAt: new Date().toISOString(), ...body,
            });

            const dir = workingDir(summary);
            if (!dir) return answer({ ok: false, reason: 'no-directory' });

            const tree = await git.statusOf(dir, { limit: CHANGED_FILE_CAP });
            if (!tree || !tree.ok) {
                return answer({ ok: false, reason: (tree && tree.reason) || 'status-failed',
                    error: tree && tree.error });
            }
            const root = tree.root;

            const file = cfg.sessionFilePath(root, given);
            if (!file) {
                // Not a 403 with the roots in it unless the roots are what refused
                // it: "outside this session's repository" is the ordinary case here
                // and is an answer the dialog draws, not an error.
                if (!cfg.withinRoots(path.resolve(root, given))) {
                    return send(res, 403, {
                        error: 'that directory is outside the allowed roots',
                        path: path.resolve(root, given), roots: cfg.ALLOWED_ROOTS,
                    });
                }
                return answer({ ok: false, reason: 'outside-repo', root });
            }

            // Every git argument from here is `rel`, recomputed from the resolved
            // path — never the string the client sent.
            const rel = path.relative(root, file);
            const entry = tree.sample.find(e => e.path === rel) || null;
            const untracked = !!entry && entry.status === '??';
            const counts = untracked ? null : (await git.numstat(dir)).get(rel) || null;

            const meta = {
                root, absPath: file, status: entry ? entry.status : null,
                added: counts ? counts.added : 0,
                deleted: counts ? counts.deleted : 0,
                binary: !!(counts && counts.binary),
            };

            // A binary file is a fact rather than a failure, and it is known before
            // the diff is asked for — the diff itself would only say "Binary files
            // differ", which is not something to render as a diff.
            if (meta.binary) return answer({ ok: true, ...meta, diff: '', bytes: 0, truncated: 0 });

            if (!fs.existsSync(file) && !entry) {
                return answer({ ok: false, reason: 'no-such-file', ...meta });
            }

            // Only when it was actually asked for. `Number(null)` is 0, so parsing
            // an absent parameter would ask git for a diff with no context at all.
            const askedContext = url.searchParams.get('context');
            const out = await git.diffText(dir, rel, {
                mode, untracked,
                context: askedContext == null ? undefined : Number(askedContext),
            });
            if (!out.ok) return answer({ ok: false, ...meta, reason: out.reason, error: out.error });
            return answer({ ok: true, ...meta,
                diff: out.diff, bytes: out.bytes, truncated: out.truncated });
        }

        // The status of the pull requests this session raised.
        //
        // Its own route rather than a field on the summary, because the summary is
        // free and this is a lookup into a store a timer fills — they answer
        // different questions and go stale on different clocks. It no longer waits
        // on gh; a PR the store has not resolved yet reports `unknown`, and the
        // header renders it from the summary uncoloured either way.
        if (tail === 'prs' && req.method === 'GET') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });

            // A `pr-link` entry usually names its repository. Where one did not,
            // the session's own directory is the best guess available.
            const list = summary.prs || [];
            const repo = list.some(pr => !pr.repo) && summary.cwd
                ? await pulls.repoOf(summary.cwd)
                : null;

            return send(res, 200, prStore.forSession(list, repo));
        }

        // Show the session's working directory in Windows File Explorer.
        if (tail === 'reveal' && req.method === 'POST') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const dir = workingDir(summary);
            if (!dir) return send(res, 404, { error: 'no directory for this session' });
            const out = await openInExplorer(dir);
            return send(res, out.ok ? 200 : 502, { ...out, dir });
        }

        // Open one of the session's files in whatever Windows opens that kind of
        // file with — reveal's idea, one level finer.
        //
        // The second route here that takes a path from the client and hands it to
        // another program, and it re-derives it exactly as the first one does. See
        // `sessionFilePath`: joined to a root the bridge worked out itself, checked
        // against that root and against the allowed roots, and checked again
        // against its real path when it turns out to be a link.
        //
        // This used to argue that a file-extension denylist was not the answer,
        // on the grounds that the drawer only offers files git already reports as
        // changed and that refusing them would break opening the script you were
        // editing. The second half of that was wrong about what a denylist costs
        // here: `isLaunchable` does not refuse anything, it reveals the file in
        // its folder instead of launching it. So the cost is a click, and the
        // saving is that a `.ps1` an agent wrote into the checkout cannot be run
        // by clicking a row about it. Local-only on top of that, because the
        // window it opens is on this machine's desktop.
        if (tail === 'open-file' && req.method === 'POST') {
            const body = await readJson(req);
            const given = String(body.path == null ? '' : body.path).trim();
            // Before the session lookup, so a request wrong about both is refused
            // for the path rather than turning 400-vs-404 into an id oracle.
            if (!given) return send(res, 400, { error: 'path is required' });

            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const dir = workingDir(summary);
            if (!dir) return send(res, 404, { error: 'no directory for this session' });

            const file = cfg.sessionFilePath(await sessionRoot(dir), given);
            if (!file) {
                // 403 rather than 404, and the same 403 whether the file is absent
                // or out of bounds: the difference between those two is an
                // existence oracle for everything on the machine.
                return send(res, 403, {
                    error: 'that file is outside this session\'s working directory',
                });
            }

            // A file Windows would *run* is revealed in its folder instead of
            // launched, which is the rule POST /api/fs/open landed for text a
            // model wrote into a transcript. `isLaunchable`'s own docstring
            // argues the two callers naming a path this app computed do not need
            // it, and this route is one of those — but the argument is weaker
            // here than there: what this names is a file inside a checkout, and
            // a checkout is exactly where a `.ps1` an agent wrote ten minutes ago
            // would be. Revealing costs a click and refuses nothing; `how` says
            // which happened, so a client can explain it.
            if (isLaunchable(file)) {
                const shown = await openInExplorer(file);
                return send(res, shown.ok ? 200 : 502,
                    { ...shown, how: 'reveal', why: 'executable', file });
            }

            const out = await openFile(file);
            return send(res, out.ok ? 200 : 502, { ...out, how: 'open', file });
        }

        // Open (or come back to) a shell in the same directory reveal would
        // show. One per session, so the pane reopens where you left it.
        if (tail === 'terminal' && req.method === 'POST') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const dir = workingDir(summary);
            if (!dir) return send(res, 404, { error: 'no directory for this session' });
            const body = await readJson(req);
            try {
                const term = terminals.open({
                    sessionId, cwd: dir, rows: body.rows, cols: body.cols,
                });
                // `cwd` in the answer is the shell's own, which for one started
                // before the session moved is not the directory asked for.
                return send(res, 200, { ...term.info(), sessionCwd: dir });
            } catch (err) {
                return send(res, 409, { error: err.message });
            }
        }
    }

    return NEXT;
}

module.exports = { init, handle, archiveStoppedRuns };
