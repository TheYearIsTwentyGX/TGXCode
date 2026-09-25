'use strict';

// `/api/schedules`: sessions that start on a clock, including the pull-request
// gate. The store and the cron arithmetic are bridge/schedule.js; firing, and
// the payloads the routes answer with, are bridge/scheduler.js.
//
// A write and a manual run both ask modeRefusal() for a remote caller, beside the
// route, so a phone cannot schedule a mode it could not start by hand.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const { broadcast } = require('../events');
const git = require('../git');
const { NEXT, readJson, send } = require('../http');
const prStore = require('../pr-store');
const pulls = require('../pulls');
const {
    MAX_SCHEDULES, cronForm, describeCron, nextSlot, parseCron, reviewKey,
} = require('../schedule');
const {
    SWEEP_MS, fireSchedule, scheduleFields, scheduleOut, schedulesPayload,
} = require('../scheduler');
const { draftsPayload } = require('./drafts');

// Handed over by server.js — see the note above ROUTES there.
let drafts = null;
let flags = null;
let index = null;
let modeRefusal = null;
let normalizeMode = null;
let schedules = null;

function init(deps) {
    ({ drafts, flags, index, modeRefusal, normalizeMode, schedules } = deps);
}

async function handle(req, res, url, pathname, seg, who) {
    // ── schedules ────────────────────────────────────────────────────────
    //
    // A session that starts on a clock: everything `POST /api/sessions` takes,
    // plus a cron expression and a gate — see bridge/schedule.js.
    //
    // All five in one block, beside drafts and for the same reason: it is a
    // small self-contained surface, and the write routes are only interesting
    // next to the read one.
    if (seg[1] === 'schedules') {
        if (!seg[2] && req.method === 'GET') {
            return send(res, 200, schedulesPayload());
        }

        // What an expression means, without saving anything.
        //
        // The dialog shows "Tue–Sat at 2:00 AM" under the box as you type, and
        // this is where that sentence comes from. A second cron parser in the page
        // could only ever be a way for the page and the bridge to disagree about
        // when a schedule runs — so the process that will actually run it is the
        // one asked. A GET because it changes nothing; before this route existed
        // the page had to attempt a create to find out whether it had typed
        // something valid.
        if (seg[2] === 'describe' && !seg[3] && req.method === 'GET') {
            const text = url.searchParams.get('cron') || '';
            const spec = parseCron(text);
            if (spec.error) return send(res, 400, { error: spec.error });
            const next = nextSlot(spec, Date.now());
            // `once` because the dialog is asking what it is about to save, and a
            // dated expression means two different things with the flag and
            // without it. Read off the query rather than guessed from the shape.
            const once = url.searchParams.get('once') === '1';
            return send(res, 200, {
                cron: spec.text,
                text: describeCron(spec, { once }),
                // The controls that would produce this expression, so a client
                // that has one can select the right row without parsing it.
                form: cronForm(spec),
                // Null is a real answer — `0 0 30 2 *` parses and never matches —
                // and one the dialog says out loud rather than leaving blank.
                next,
            });
        }

        if (!seg[2] && req.method === 'POST') {
            let body = await readJson(req);
            // **Who asked, when it was a session.** `from` is what the agent
            // tools send (bridge/mcp.js), and it does three things. It is
            // recorded, so the card can say which conversation an unattended run
            // came from. It stands in for a missing `cwd` — the project the
            // session belongs to, not a worktree it may since have removed. And a
            // test session's schedule is a test schedule: a probe run from a dev
            // bridge must not leave a row the everyday bridge will fire, and the
            // agent making it cannot be relied on to say so.
            const fromSession = typeof body.from === 'string' && body.from.trim()
                ? body.from.trim() : null;
            const src = fromSession ? index.summary(fromSession) : null;
            if (src && !body.cwd) body = { ...body, cwd: src.projectCwd || src.cwd };
            const v = scheduleFields(body, who, { partial: false });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }

            // **Seed the marker before storing, not on the first run.** A gated
            // schedule whose marker starts empty would review the entire history
            // of the repository the first time it fired. Resolving the ref now
            // means the first run covers what arrives after you set it up, which
            // is what "since the prior run" means when there is no prior run.
            //
            // A ref that cannot be resolved is refused rather than seeded empty:
            // a typo'd `orgin/main` should cost you the save, not a month of
            // silent "nothing new".
            if (v.fields.gate && v.fields.gate.kind === 'git-commits') {
                const seed = await git.commitRange(v.fields.cwd, v.fields.gate.ref, null,
                    { fetch: v.fields.gate.fetch });
                if (!seed.ok) {
                    return send(res, 400, {
                        error: seed.error || `cannot resolve ${v.fields.gate.ref}`,
                    });
                }
                v.fields.lastMarker = seed.head;
            }

            // The same seeding for a PR gate, and it matters more: without it,
            // pressing Save starts a review session for every pull request already
            // open — five of them, on a machine where that is a normal number.
            // `seed: "all"` is how you ask for exactly that.
            if (v.fields.gate && v.fields.gate.kind === 'open-prs') {
                const repo = await pulls.repoOf(v.fields.cwd);
                if (!repo) {
                    return send(res, 400, {
                        error: `${v.fields.cwd} has no GitHub origin, so it has no `
                            + 'pull requests to watch',
                    });
                }
                // Asked now rather than read from the store: this is a press, and
                // seeding a reviewed map against a twenty-minute-old list would
                // quietly mark a PR raised since then as already reviewed.
                // `refreshRepo` folds the answer in, so the next tick inherits it.
                await prStore.refreshRepo(repo);
                const list = prStore.openPulls(repo);
                if (!list.ok) {
                    // Refused rather than seeded empty, for the reason a bad ref is
                    // refused: a schedule that cannot see the repository is one that
                    // will report "nothing new" every night and never say why.
                    return send(res, 400, {
                        error: list.error || `cannot list pull requests for ${repo}`,
                    });
                }
                if (String(body.seed || 'skip') !== 'all') {
                    const reviewed = {};
                    for (const pr of list.pulls) {
                        if (!pr.headSha) continue;
                        reviewed[reviewKey(repo, pr.number)] = {
                            sha: pr.headSha, at: Date.now(),
                            sessionId: null, outcome: null, posted: 'seeded', postError: null,
                        };
                    }
                    v.fields.reviewed = reviewed;
                }
            }

            if (fromSession) {
                v.fields.createdBy = {
                    sessionId: fromSession,
                    title: src ? (src.title || null) : null,
                };
                if (flags.get(fromSession).test) v.fields.test = true;
            }

            const row = schedules.create(v.fields);
            if (!row) {
                return send(res, 409, {
                    error: `there are already ${MAX_SCHEDULES} schedules — delete `
                        + 'some before adding another',
                });
            }

            // **The draft this schedule was converted from, consumed here rather
            // than by the client.**
            //
            // `POST /api/drafts/:id/start` makes the argument and this is the same
            // shape of it: a client doing this as two calls has to decide for
            // itself what happens when the second one fails, and there are three
            // clients to decide it three ways. Done here, the order is the answer
            // — the draft is the copy of this work that still exists if the save
            // above throws, so it goes last and only on success.
            //
            // Deliberately *not* stored on the row. `clean()` in schedule.js is a
            // whitelist another bridge would strip the field back out of within a
            // tick (docs/plans/15-scheduling.md), and nothing after this moment
            // has a use for it: the draft is gone.
            //
            // An id that names nothing is not an error. The schedule saved, which
            // is what was asked for; the draft was already deleted, or belonged to
            // a bridge with a different store.
            const from = typeof body.fromDraft === 'string' ? body.fromDraft : null;
            if (from && drafts.remove(from)) broadcast('drafts-changed', draftsPayload());

            broadcast('schedules-changed', schedulesPayload());
            return send(res, 200, { schedule: scheduleOut(row) });
        }

        if (seg[2] && !seg[3] && req.method === 'PATCH') {
            const body = await readJson(req);
            // Validated *before* the schedule is looked up, so a refused mode is
            // a 403 whether or not the id exists — the order
            // `POST /api/drafts/:id` uses, and for the reason given there: the
            // refusal is about what this caller may ask for, not about what it
            // aimed at.
            const v = scheduleFields(body, who, { partial: true });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }

            const before = schedules.get(seg[2]);
            if (!before) return send(res, 404, { error: 'schedule not found' });

            // **The mode already on the row is refused too, not just one in the
            // body.** Checking only what was sent leaves a real hole here that
            // the same check does not leave on a draft: a phone cannot *write*
            // `dontAsk`, but it could send `{enabled: true}` to a paused schedule
            // that already had it, and the local tick would then start an
            // unattended agent with no permission gate. A draft escapes this
            // because the second gate is somebody pressing Start, who is checked
            // in turn; a schedule's second gate is a timer, which is always local.
            //
            // So a remote caller may not touch a schedule it would not be allowed
            // to create. After the lookup rather than before, unavoidably — this
            // one is about the stored row — while the body check above stays
            // first, so "you may not ask for that mode" is still a 403 whether or
            // not the id is real.
            const effective = normalizeMode(
                v.fields.permissionMode !== undefined
                    ? v.fields.permissionMode : before.permissionMode);
            const refusal = modeRefusal(effective, who);
            if (refusal) return send(res, 403, { error: refusal, remote: true });

            // **Repointing the gate, or the checkout, invalidates the marker**, so
            // it has to be reseeded: the stored SHA is on the old ref, and against
            // the new one it is either an ancestor nothing has landed after —
            // "nothing new" forever, a schedule that silently stops reviewing — or
            // a commit on a diverged history, which makes `{{range}}` enormous.
            //
            // Resolved *before* the update, not after. Doing it after means a ref
            // that turns out not to exist leaves the row already edited, pointing
            // somewhere unresolvable, with a marker from the old ref — a 400 that
            // changed something. This way the refusal costs the edit and nothing
            // else, which is the same bargain `POST /api/schedules` strikes.
            const cwd = v.fields.cwd !== undefined ? v.fields.cwd : before.cwd;
            const gate = v.fields.gate !== undefined ? v.fields.gate : before.gate;
            const kind = gate ? gate.kind : null;
            const wasKind = before.gate ? before.gate.kind : null;
            const movedCwd = cwd !== before.cwd;

            let marker = null;
            let reseeded = null;

            // **Branch on the kind, which the first version did not.** It reached
            // for `gate.ref` whatever the gate was, so switching an existing
            // schedule to `open-prs` — which has no ref — called `commitRange` with
            // `undefined` and answered 400 "cannot resolve undefined". The edit
            // dialog could offer that gate and never save it.
            if (kind === 'git-commits'
                && (movedCwd || wasKind !== 'git-commits' || before.gate.ref !== gate.ref)) {
                // Repointing invalidates the marker: it is a SHA on the old ref, and
                // against the new one it is either an ancestor nothing has landed
                // after — "nothing new" forever — or a commit on a diverged history,
                // which makes `{{range}}` enormous. Resolved before the update so a
                // ref that turns out not to exist costs the edit and nothing else.
                const seed = await git.commitRange(cwd, gate.ref, null,
                    { fetch: gate.fetch });
                if (!seed.ok) {
                    return send(res, 400, {
                        error: seed.error || `cannot resolve ${gate.ref}`,
                    });
                }
                marker = seed.head;
            }

            // Becoming a PR gate, or pointing at a different checkout, means the
            // reviewed map describes the wrong repository. Reseeded for the reason
            // the create route seeds: otherwise saving the edit reviews everything
            // already open.
            if (kind === 'open-prs' && (movedCwd || wasKind !== 'open-prs')) {
                const repo = await pulls.repoOf(cwd);
                if (!repo) {
                    return send(res, 400, {
                        error: `${cwd} has no GitHub origin, so it has no pull `
                            + 'requests to watch',
                    });
                }
                // Asked now, not read from the store — see the create route.
                await prStore.refreshRepo(repo);
                const list = prStore.openPulls(repo);
                if (!list.ok) {
                    return send(res, 400, {
                        error: list.error || `cannot list pull requests for ${repo}`,
                    });
                }
                reseeded = {};
                if (String(body.seed || 'skip') !== 'all') {
                    for (const pr of list.pulls) {
                        if (!pr.headSha) continue;
                        reseeded[reviewKey(repo, pr.number)] = {
                            sha: pr.headSha, at: Date.now(),
                            sessionId: null, outcome: null, posted: 'seeded',
                            postError: null,
                        };
                    }
                }
            }

            const row = schedules.update(seg[2], v.fields);
            if (!row) return send(res, 404, { error: 'schedule not found' });
            if (marker) schedules.note(seg[2], { marker });
            if (reseeded) schedules.setReviewed(seg[2], reseeded);
            // A window belongs to the gate that opened it. Leaving one open across a
            // change of kind meant the drain pass skipped it on the kind guard and
            // nothing ever closed it, so the row carried a stale `sweepUntil`
            // indefinitely.
            if (kind !== wasKind && before.sweepUntil) schedules.closeSweep(seg[2]);

            broadcast('schedules-changed', schedulesPayload());
            return send(res, 200, { schedule: scheduleOut(schedules.get(seg[2])) });
        }

        if (seg[2] && !seg[3] && req.method === 'DELETE') {
            if (!schedules.remove(seg[2])) {
                return send(res, 404, { error: 'schedule not found' });
            }
            broadcast('schedules-changed', schedulesPayload());
            return send(res, 200, { ok: true, id: seg[2] });
        }

        // Run it now, whatever the clock says.
        //
        // The same function the tick calls, which is the point — a run produced
        // by this button has to be identical to one produced by the schedule, and
        // one code path is the only way to be sure. It skips the gate (you
        // pressed the button, so something should happen even with no new
        // commits) and it does not touch `lastSlotAt`, so tonight's scheduled run
        // still happens. It does *not* skip the mode refusal or the rate limit.
        if (seg[2] && seg[3] === 'run' && req.method === 'POST') {
            const row = schedules.get(seg[2]);
            if (!row) return send(res, 404, { error: 'schedule not found' });

            const fired = await fireSchedule(row, { force: true, who });

            if (!fired.started.length) {
                const first = fired.skipped[0]
                    || { reason: 'nothing-new', error: fired.gateError };
                schedules.note(row.id, { skipReason: first.reason, error: first.error || null });
                broadcast('schedules-changed', schedulesPayload());
                // The refusal a remote caller gets is a 403 and says so; a
                // rate limit is a 429; everything else is the directory or the
                // ref, which is a 400 about the request.
                const status = first.reason === 'rate-limited' ? 429
                    : (modeRefusal(normalizeMode(row.permissionMode), who) ? 403 : 400);
                return send(res, status, status === 403
                    ? { error: first.error, remote: true }
                    : { error: first.error || 'nothing to review' });
            }

            // A manual run advances the marker exactly as a scheduled one does.
            // Not doing so would mean pressing Run now caused tonight to review
            // the same commits over again. For a PR gate the per-PR entries were
            // already written by `fireSchedule` at the moment each session started.
            //
            // `note` returns null if the schedule was deleted while this was
            // running, which a gated run makes a real window rather than a
            // theoretical one — a fetch can take the best part of a minute. The
            // sessions have started either way, so their ids must still be
            // reported: answering with a 500 here would tell the caller the run
            // failed while an agent was already working.
            // One per session, so `runs` counts reviews rather than sweeps — see
            // the same loop in tickSchedules.
            const last = fired.started[fired.started.length - 1];
            let updated = null;
            for (const started of fired.started) {
                updated = schedules.note(row.id, {
                    sessionId: started.sessionId,
                    marker: fired.kind === 'open-prs' ? undefined : last.facts.head,
                });
            }

            // A PR sweep that could not start everything keeps its window open so
            // the rest drains on the ticks that follow, rather than waiting for
            // tomorrow's slot. Only on the everyday instance, which is the only one
            // whose tick will come back for it.
            if (fired.kind === 'open-prs' && fired.deferred && !row.sweepUntil) {
                schedules.openSweep(row.id, Date.now(), SWEEP_MS);
            }

            broadcast('schedules-changed', schedulesPayload());
            return send(res, 200, {
                // Singular first, and kept: `web/app.js` and the Android client
                // both read `sessionId`, and a client that has not been updated
                // should get the session it asked for rather than `undefined`.
                // It is the first of `sessionIds` — for a branch gate the only one.
                sessionId: fired.started[0].sessionId,
                sessionIds: fired.started.map(x => x.sessionId),
                deferred: fired.deferred,
                test: !!row.test,
                schedule: updated ? scheduleOut(updated) : null,
            });
        }
    }

    return NEXT;
}

module.exports = { init, handle };
