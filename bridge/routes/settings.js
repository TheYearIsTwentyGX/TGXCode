'use strict';

// Settings, three kinds of them: this app's (`/api/prefs`, and the two catalogues
// its page is drawn from, `/api/keymap` and `/api/spinner/groups`), Claude Code's
// own (`/api/claude-config`), and Claude Code's memory files (`/api/claude-docs`).
//
// **Local and remote differ per route, and each says so beside it.** Reading
// prefs is open; saving them is refused to a remote caller. Both claude-config
// and claude-docs are refused remotely for *both* methods. Those refusals are
// remoteRefusal()'s in server.js, run before `api()`; the comments here say why.
//
// `claudeConfigPayload` and the two status tables came with the routes, which
// were their only callers.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const path = require('path');
const { MAX_DOC_BYTES } = require('../claude-docs');
const cfg = require('../config');
const { broadcast } = require('../events');
const git = require('../git');
const { NEXT, readJson, send } = require('../http');
const keymap = require('../keymap');
const { norm: spinnerNorm } = require('../spinner');

// Handed over by server.js — see the note above ROUTES there.
let claudeConfig = null;
let claudeDocs = null;
let prefs = null;
let registry = null;
let spinner = null;

function init(deps) {
    ({ claudeConfig, claudeDocs, prefs, registry, spinner } = deps);
}

/**
 * The claude-config read, plus the two things the module cannot answer alone.
 *
 * `running` is how many sessions are live, because a change to these files
 * reaches the next session and not the ones already going — and "I changed it
 * and nothing happened" is the question that count exists to answer before it
 * is asked. Taken from the registry rather than from the runner pool on
 * purpose: a session under a terminal will not see the change either, and
 * leaving it out of the count would make the sentence wrong in the reassuring
 * direction.
 *
 * `ignored` is asked of git rather than of a `.gitignore`, because the answer
 * on this machine comes from a *global* excludes file — see git.ignored().
 * Only the local row is asked: the shared one is meant to be committed.
 */
async function claudeConfigPayload(cwd) {
    const base = claudeConfig.read(cwd);
    const here = cwd ? path.resolve(cfg.expandHome(cwd)) : null;
    const live = registry.running();
    const running = here
        ? live.filter(e => e.cwd && (e.cwd === here || e.cwd.startsWith(`${here}${path.sep}`))).length
        : live.length;

    const files = await Promise.all(base.files.map(async (f) => {
        if (f.scope !== 'project-local' || !here) return f;
        const answer = await git.ignored(here, `${cfg.CLAUDE_DIR}/${cfg.CLAUDE_SETTINGS_LOCAL_FILE}`);
        return { ...f, ignored: answer.ignored, ignoredBy: answer.source };
    }));
    return { ...base, files, running };
}

/**
 * Which status a claude-config refusal is.
 *
 * The split is the same one PUT /api/prefs draws — the caller's mistake against
 * the machine's answer about what is possible — with one addition: a conflict
 * is neither. `409` says the request was well formed and would have been
 * accepted a moment ago, which is exactly the case a client has to handle
 * differently from both a bad value and a file it may not write.
 */

function claudeConfigStatus(code) {
    if (['scope', 'dir', 'body', 'path', 'value', 'json', 'stamp'].includes(code)) return 400;
    if (['stale', 'exists'].includes(code)) return 409;
    if (code === 'size') return 413;
    return 403;   // readonly, unparseable, write
}

/**
 * Which status a claude-docs refusal is.
 *
 * The same split claudeConfigStatus draws, over a smaller set of codes: there
 * is no `patch` here and nothing to parse, so `path`, `value`, `json` and
 * `unparseable` have no way to happen and are deliberately absent rather than
 * carried across for symmetry.
 */
function claudeDocsStatus(code) {
    if (['scope', 'dir', 'body', 'stamp'].includes(code)) return 400;
    if (['stale', 'exists'].includes(code)) return 409;
    if (code === 'size') return 413;
    return 403;   // readonly, write
}

async function handle(req, res, url, pathname, seg, who) {
    // Settings, for a caller that wants them fresh rather than as the page was
    // served with them — the settings page after a save, or a client checking
    // after the file was edited by hand. `?cwd=` asks what is in force for a
    // project; without it, the user-level answer. Not local-only: reading a
    // preference about how a transcript looks is not a capability a phone should
    // be refused, and prefs.forCwd() runs a cwd through cfg.withinRoots anyway.
    //
    // `?files=1` adds what each file in the chain says on its own, which is the
    // other half of the question and only the settings page asks it: "in force"
    // cannot tell a value you set from one you inherited, and a control that
    // cannot tell those apart offers to clear things that were never set and
    // appears not to work when a stronger file has taken over.
    if (pathname === '/api/prefs' && req.method === 'GET') {
        const cwd = url.searchParams.get('cwd') || '';
        const body = prefs.forCwd(cwd);
        if (url.searchParams.get('files')) return send(res, 200, { ...body, files: prefs.raw(cwd) });
        return send(res, 200, body);
    }

    // Save some of them. A patch of `{section: {key: value}}` rather than a
    // whole document, so two windows editing different settings do not clobber
    // each other, and `null` for a value removes the key so it falls back down
    // the chain. `scope` picks which of the three files it lands in — see
    // Prefs.targetFile. Local-only; see remoteRefusal.
    //
    // Refusals carry the code Prefs.save classified them with, so a client can
    // tell "you sent a value this key does not allow" from "that file is not
    // yours to write" without matching on prose.
    if (pathname === '/api/prefs' && req.method === 'PUT') {
        const body = await readJson(req);
        let saved;
        try {
            saved = prefs.save({
                scope: body.scope || 'user',
                dir: body.cwd || '',
                patch: body.patch,
            });
        } catch (err) {
            // A bad value or an unknown key is the caller's mistake; a file it
            // may not write, or one that does not parse, is the machine's
            // answer about what is possible.
            const status = (err.code === 'value' || err.code === 'section'
                || err.code === 'scope' || err.code === 'dir') ? 400 : 403;
            return send(res, status, { error: err.message, code: err.code || 'save' });
        }
        // Every window reads settings, and two of them are routinely open here —
        // the Electron shell and a browser tab on the same bridge. Only the
        // user-level answer is broadcast: a project's is the open session's
        // business and arrives with the transcript.
        broadcast('prefs', prefs.page(''));
        return send(res, 200, { file: saved.file, prefs: saved.prefs, files: saved.files });
    }

    // ── Claude Code's own settings ──────────────────────────────────────────
    //
    // The chain, the merged reading of it, and everything in the files that
    // this app has no control for — see bridge/claude-config.js for why that
    // last part is the whole point rather than a nicety.
    //
    // Local callers only, **including the GET**, which is the opposite of
    // /api/prefs. There the argument for an open GET was that a phone has a use
    // for how somebody wants a transcript folded. These files name hook
    // commands, permission rules and the *values* of environment variables, and
    // no client that is not on this machine has any use for them — so there is
    // nothing to weigh against caution. See docs/remote.md.
    if (pathname === '/api/claude-config' && req.method === 'GET') {
        const cwd = url.searchParams.get('cwd') || '';
        return send(res, 200, await claudeConfigPayload(cwd));
    }

    // Two bodies, one route. `patch` is `{dotted.path: value|null}` and touches
    // only the paths it names; `text` replaces the document and is the only
    // thing that can repair a file which no longer parses. Exactly one of them.
    //
    // `stamp` is the precondition that makes this safe to offer at all: these
    // files are written by `claude` itself, so "the file I read" is a claim
    // worth checking rather than an assumption. It is required for a whole
    // collection and for a whole document, and deliberately not for one scalar.
    if (pathname === '/api/claude-config' && req.method === 'PUT') {
        const body = await readJson(req);
        const hasPatch = body.patch !== undefined;
        const hasText = body.text !== undefined;
        if (hasPatch === hasText) {
            return send(res, 400, {
                error: 'send exactly one of patch or text', code: 'body',
            });
        }
        let saved;
        try {
            const req_ = {
                scope: body.scope || 'user',
                dir: body.cwd || '',
                // Absent and null mean different things — "I am only setting a
                // scalar" and "this file should not exist" — so the distinction
                // has to survive the JSON.
                stamp: Object.prototype.hasOwnProperty.call(body, 'stamp') ? body.stamp : undefined,
            };
            saved = hasPatch
                ? claudeConfig.save({ ...req_, patch: body.patch })
                : claudeConfig.saveText({ ...req_, text: body.text });
        } catch (err) {
            return send(res, claudeConfigStatus(err.code), {
                error: err.message,
                code: err.code || 'save',
                // A conflict carries the file as it is now, so the page can say
                // what changed instead of only that something did.
                ...(err.detail || {}),
            });
        }
        // The fact of a change, not its content: nothing in this app behaves
        // differently because of these files, so a listening window only needs
        // to know it should re-read. Broadcasting the content would also push a
        // file this route classifies as local-only down every open channel.
        broadcast('claude-config', {
            at: Date.now(), scope: body.scope || 'user', file: saved.file,
        });
        // The same shape the GET returns, so a client can take the answer
        // wholesale rather than patching its own copy — and so the `ignored`
        // and `running` fields do not vanish from a page's state on a save.
        return send(res, 200, {
            file: saved.file,
            stamp: saved.stamp,
            config: await claudeConfigPayload(body.cwd || ''),
        });
    }

    // ── Claude Code's memory files ─────────────────────────────────────
    //
    // The first route in this bridge that reads or writes a whole file's
    // contents. Everything else here reads a file the app owns, or a directory
    // listing, or a JSON key; /api/fs lists and /api/fs/mkdir creates, and that
    // was the entire filesystem surface before this.
    //
    // So the conservative parts are load-bearing rather than ceremony: the
    // request names a `scope` and the bridge builds the path, so there is
    // nothing to traverse with; the read and the write share one size cap; a
    // symlink is refused rather than followed; and every write carries the
    // stamp of the file it was read from. Local callers only, both methods, for
    // the reason remoteRefusal() gives.
    //
    // `cwd` is passed through rather than validated here, exactly as
    // /api/claude-config does it: cfg.withinRoots inside the module drops the
    // project row, so a directory this bridge will not read degrades to the
    // user file alone rather than 403-ing a group that has a perfectly good
    // user scope to show. The write refuses it outright, which is where it
    // matters.
    //
    // `maxBytes` rides along so a page can label its byte counter with the real
    // cap instead of hardcoding one. A client that hardcoded it would go on
    // saying "of 256 KB" after the constant moved, which is the sort of drift
    // that is only ever found by somebody hitting the limit.
    if (pathname === '/api/claude-docs' && req.method === 'GET') {
        const read = claudeDocs.read(url.searchParams.get('cwd') || '');
        return send(res, 200, { ...read, maxBytes: MAX_DOC_BYTES });
    }

    // One body, unlike the route above: there is no partial write of a prose
    // file, so `text` is the only shape and `stamp` is never optional.
    if (pathname === '/api/claude-docs' && req.method === 'PUT') {
        const body = await readJson(req);
        let saved;
        try {
            saved = claudeDocs.save({
                scope: body.scope || 'user',
                dir: body.cwd || '',
                // Absent and null mean different things — "I forgot the
                // precondition" and "this file should not exist yet" — so the
                // distinction has to survive the JSON.
                stamp: Object.prototype.hasOwnProperty.call(body, 'stamp') ? body.stamp : undefined,
                text: body.text,
            });
        } catch (err) {
            return send(res, claudeDocsStatus(err.code), {
                error: err.message,
                code: err.code || 'save',
                // A conflict carries the file as it is now, so the page can show
                // what it would have overwritten instead of only that it did not.
                ...(err.detail || {}),
            });
        }
        // The fact of a change, not its content — the same trade the
        // claude-config event makes, and for the same two reasons: nothing in
        // this app behaves differently because of these files, and pushing the
        // contents of a file this route classifies as local-only down every open
        // channel would be a poor way to save a fetch.
        broadcast('claude-docs', {
            at: Date.now(), scope: body.scope || 'user', file: saved.file,
        });
        return send(res, 200, { ...saved, maxBytes: MAX_DOC_BYTES });
    }

    // What may be rebound, and the closed set of key names a combo may end in.
    // The catalogue lives in bridge/keymap.js rather than in the page for the
    // reason its header gives: `keyboard.bindings` is keyed by command id, and
    // ids only the page knows are ids nobody else can discover.
    //
    // Not local-only — a list of command names is not a capability — and served
    // in a `tgx-keymap` <meta> tag as well, so the window's first keystroke does
    // not race a fetch.
    if (pathname === '/api/keymap' && req.method === 'GET') {
        return send(res, 200, keymap.payload());
    }

    // Which spinner verb groups exist, so the answer to "what may I put in
    // spinner.groups?" is reachable without listing a directory by hand — and
    // where a group that failed to load says why. This is what the settings
    // page draws its checkboxes from; it was built when there was no settings
    // page, and it is the reason there did not have to be a second route now.
    //
    // `?verbs=1` adds each group's verbs, sorted. Only the settings page asks:
    // it puts them in the tooltip on a group, which is the difference between
    // choosing a voice and guessing from a name. Off by default because it is
    // 3,639 strings across the catalogue and a caller that wanted counts should
    // not pay for them.
    //
    // Not local-only, for the same reason /api/prefs is not: the names and
    // contents of verb groups are not a capability worth refusing a phone.
    if (pathname === '/api/spinner/groups' && req.method === 'GET') {
        const cwd = url.searchParams.get('cwd') || '';
        const withVerbs = Boolean(url.searchParams.get('verbs'));
        const { groups: all, problems } = spinner.groups(cwd);
        const settings = prefs.forCwd(cwd).spinner;
        const pool = spinner.pool(cwd);
        // A weight and a share on every group, because the bridge is where the
        // draw is decided — a page that recomputed a share from the weights
        // would be a second implementation of the algorithm, and the two would
        // disagree the first time this one changed. `null` for a group that is
        // not in play: it has no share of anything, which is a different
        // statement from a share of zero.
        // Keyed by the normalised name, not the written one: a bucket is named
        // however the settings file spelled it, and `Tech_Programming` and
        // `Tech / Programming` are the same group.
        const shares = new Map(pool.buckets.map(b => [spinnerNorm(b.name), b]));
        const enabledNames = new Set(settings.groups.map(spinnerNorm));
        const groups = all.map(({ verbs, ...g }) => {
            const bucket = shares.get(spinnerNorm(g.name));
            const enabled = enabledNames.has(spinnerNorm(g.name));
            const weight = !enabled ? null : bucket ? bucket.weight : 0;
            return {
                ...g,
                weight,
                share: weight && pool.weight ? weight / pool.weight : enabled ? 0 : null,
                ...(withVerbs ? { verbs } : {}),
            };
        });
        return send(res, 200, {
            randomize: settings.randomize,
            rerollMs: settings.rerollMs,
            enabled: settings.groups,
            weights: settings.weights,
            // What the spinner will actually draw from, which is not the same
            // as `enabled` when a name in settings matches no file — or when a
            // group is enabled and weighed 0.
            pool: pool.verbs.length,
            groups,
            problems: [...problems, ...pool.problems],
        });
    }

    return NEXT;
}

module.exports = { init, handle };
