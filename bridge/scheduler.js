'use strict';

// The firing half of bridge/schedule.js: the tick that starts sessions on a
// clock, the one path Run now shares with it, the shape a schedule goes out on
// the wire in, and attributing a finished turn back to the schedule that started
// it.
//
// The store in schedule.js is deliberately inert, and this is the half that is
// not. It used to be three stretches of server.js — the Schedules section, the
// gate's half of "Keeping pull request status fresh", and the turn-complete
// handler down in Wiring — which between them were a fifth of that file and
// could only be read by scrolling between them. The GitHub side of the
// pull-request gate is next door in bridge/pr-gate.js, because that is the part
// with an invariant worth having a file of its own: a `test` schedule never
// writes to GitHub.
//
// **Why `init`.** Firing needs the runner pool, the flags, the index and the
// notification log — instances server.js builds and owns — plus the refusal
// rules a create call goes through (`modeRefusal`, `tooManyCreates`), which are
// the router's. Requiring server.js back for them would be a cycle that hands
// this file a half-filled exports object, so they are passed in once, where the
// section used to sit, and nothing here runs before that.
//
// **No timers here.** The catch-up pass and the 30s interval are still started
// from server.js's listen callback, after the index is up, exactly where they
// were — this file only says what a tick does.

const cfg = require('./config');
const git = require('./git');
const { projectName } = require('./sessions');
const { resolveWorkdir } = require('./runner');
const {
    CATCHUP_MS,
    parseCron, nextSlot, isSpent, dueSlot, describeCron, cronForm, cronForDate, fillPrompt,
    unattended,
    verdictOf,
    reviewKey, scheduleTitle,
} = require('./schedule');
const { broadcast } = require('./events');
const gate = require('./pr-gate');
const {
    SWEEP_MS, REVIEWS_PER_TICK, REVIEWS_IN_FLIGHT, CREATE_RESERVE,
    rangeFailures, noteRangeFailure, sawRangeFailure,
    pullsForSchedule, reviewsInFlight, prRange, postReviewToPr,
} = gate;

// Handed over by server.js; see the header.
let schedules = null;
let pool = null;
let flags = null;
let index = null;
let notifications = null;
let filed = null;
let normalizeMode = null;
let modeRefusal = null;
let tooManyCreates = null;
let CREATE_LIMIT = null;

function init(deps) {
    ({
        schedules, pool, flags, index, notifications, filed,
        normalizeMode, modeRefusal, tooManyCreates, CREATE_LIMIT,
    } = deps);
    // The gate reads the same store and pool, and files and broadcasts through
    // the two functions below — passed rather than required, so the two files do
    // not require each other.
    gate.init({ schedules, pool, fileScheduleNote, schedulesPayload });
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------
//
// The firing half of bridge/schedule.js. The store there is deliberately inert —
// it holds rows and answers questions about clocks — because everything that
// actually starts a session needs `pool`, `flags`, `index` and the same refusal
// rules a create call goes through, and all four live in server.js — they
// arrive here through `init`.

// How often to look. Thirty seconds against a schedule whose finest resolution
// is a minute means a slot is noticed within half its own granularity, and the
// check is a `nextSlot` walk per enabled schedule — cheap enough that the
// interval is not worth tuning. Deliberately not a minute: a tick landing on the
// same second as the slot every time would put every schedule on this machine on
// the same instant.
const SCHEDULE_MS = 30_000;

/**
 * Let a development bridge fire, for schedules marked as tests only.
 *
 * Without this the feature is only exercisable on the everyday instance, which is
 * the one thing CLAUDE.md is most insistent nobody touch — so "test it properly"
 * and "do not go near 45888" were in direct conflict, and the way that conflict
 * usually resolves is that nobody tests it.
 *
 * **It is narrow in the direction that matters.** A dev bridge shares
 * `schedules.json` with the everyday one, so an override that simply lifted the
 * gate would have an agent's bridge starting the user's real 2 AM sessions —
 * worse than the problem it solves. With this set, a dev bridge fires *only* rows
 * with `test: true`, which are the ones it made and which stay out of the
 * everyday window anyway.
 *
 * **And the rule is symmetric, which it was not at first.** The everyday instance
 * skips test schedules rather than firing everything: the original guard narrowed
 * a dev bridge and left 45888 running whatever was in the shared file, so a probe
 * schedule created while it was up got run by it — in the user's own checkout.
 * `test` now means "belongs to a development bridge" in both directions, which is
 * what it already meant for a session.
 */
const SCHEDULE_ON_DEV = process.env.TGXCODE_SCHEDULE_ON_DEV === '1';

/**
 * A schedule as it goes out on the wire.
 *
 * The three derived fields are computed here rather than in the store and rather
 * than in each client, for the reason `draftOut` gives: the desktop, the phone
 * and the Android app must not be able to come to three different answers about
 * when a schedule next runs. `cronText` in particular is not something a client
 * should be reimplementing — `0 2 * * 2-6` is not text anybody should have to
 * decode to check they typed what they meant.
 */
// How many reviewed entries go out on the wire. The store holds up to
// MAX_REVIEWED, and `schedules-changed` fires unprompted — every time a review
// starts or finishes — so sending two hundred entries would be tens of kilobytes
// per push for history no card draws. A tail plus a count says everything the UI
// needs and the full map stays where it is used.
const REVIEWED_ON_WIRE = 20;

function scheduleOut(row) {
    const spec = parseCron(row.cron);
    const reviewedKeys = Object.keys(row.reviewed || {});
    const recent = reviewedKeys
        .sort((a, b) => (row.reviewed[b].at || 0) - (row.reviewed[a].at || 0))
        .slice(0, REVIEWED_ON_WIRE);
    return {
        ...row,
        // **A tail, not the store.** See REVIEWED_ON_WIRE — a client that treated
        // this as the whole map would decide a PR was unreviewed on the strength of
        // it not being in the twenty most recent.
        reviewed: Object.fromEntries(recent.map(k => [k, row.reviewed[k]])),
        reviewedCount: reviewedKeys.length,
        // How many are still going, which is what the card says during a sweep.
        reviewsInFlight: Object.values(row.reviewed || {})
            .filter(e => e.sessionId && !e.outcome).length,
        projectName: projectName(row.cwd),
        cronText: describeCron(spec, { once: row.once }),
        // The same expression as controls rather than as prose, so the dialog can
        // draw a picker without parsing cron in the page. Derived here for the
        // reason above: three clients reading five fields each is three chances
        // to disagree about what `0 2 * * 2-6` selects.
        cronForm: cronForm(spec),
        // Null when the expression can never match again, which is a real answer
        // — `0 0 30 2 *` is a schedule that will never fire — and one the card
        // should be able to say out loud rather than showing a blank.
        nextRunAt: row.enabled ? nextSlot(spec, Date.now()) : null,
        // Which of `nextRunAt: null`'s two meanings this row is. Paused and
        // finished look identical from the fields above — the bridge clears
        // `enabled` on a one-time row itself — and they are opposite things to
        // anyone reading a card. See isSpent in schedule.js.
        spent: isSpent(row, spec),
    };
}

/** The whole list, which is both the GET body and the SSE payload. */
function schedulesPayload() {
    const rows = schedules.list().map(scheduleOut);
    return {
        at: Date.now(),
        schedules: rows,
        counts: { total: rows.length, enabled: rows.filter(r => r.enabled).length },
    };
}

/**
 * Validate what a schedule write is asking for, exactly as a create would.
 *
 * `draftFields` with three additions, and for the same reason it exists: a
 * schedule you cannot start is worse than a refused save, because nobody is
 * watching at 2 AM to see it fail. So the directory has to exist and be inside
 * the roots here too, and a remote caller is refused the two modes it is refused
 * on creation.
 *
 * That last one matters more here than for a draft. A draft in
 * `bypassPermissions` is a thing somebody has to press Start on; a *schedule* in
 * `bypassPermissions` is an unattended agent with no permission gate, starting
 * itself every night. `modeRefusal` already refuses both modes to a remote
 * caller, so a phone can create an `auto` schedule and not that one — which
 * falls out of the existing rule rather than needing a new one.
 *
 * @returns {{fields: object} | {error: string, status: number, remote?: boolean}}
 */
function scheduleFields(body, who, { partial }) {
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

    // **`at` is a moment, for a caller that has one and not an expression.**
    // It becomes the dated cron plus `once` that the dialog's one-time form
    // saves, so the row is indistinguishable from one made by hand — see
    // `cronForDate` for why it refuses what it refuses. Both at once is refused
    // rather than one quietly winning: they are two answers to one question.
    if (body.at !== undefined && body.at !== null) {
        if (body.cron !== undefined && body.cron !== null) {
            return { error: 'give either at or cron, not both', status: 400 };
        }
        const dated = cronForDate(body.at);
        if (dated.error) return { error: dated.error, status: 400 };
        body = { ...body, cron: dated.cron, once: true };
    }

    if (!partial || body.cron !== undefined) {
        if (!body.cron) return { error: 'cron (or at) is required', status: 400 };
        const spec = parseCron(String(body.cron));
        if (spec.error) return { error: spec.error, status: 400 };
        // A syntactically fine expression that can never match is still a
        // schedule that will never run, and saying so now is far kinder than a
        // card that sits there for a month saying "next run: never".
        if (nextSlot(spec, Date.now()) === null) {
            return {
                error: `"${spec.text}" parses but never matches a real date`,
                status: 400,
            };
        }
        fields.cron = spec.text;
    }

    if (!partial || body.permissionMode !== undefined) {
        const mode = normalizeMode(body.permissionMode);
        const refusal = modeRefusal(mode, who);
        if (refusal) return { error: refusal, status: 403, remote: true };
        fields.permissionMode = mode;
    }

    // A gate is stored whole or not at all — the store's `cleanGate` drops a
    // half-specified one, so a missing ref is caught here where it can be said
    // rather than silently becoming "no gate".
    if (!partial || body.gate !== undefined) {
        const gate = body.gate;
        if (gate === null || gate === undefined) {
            fields.gate = null;
        } else if (typeof gate !== 'object') {
            return { error: 'gate must be an object or null', status: 400 };
        } else if (gate.kind === 'open-prs') {
            fields.gate = {
                kind: 'open-prs',
                includeDrafts: gate.includeDrafts !== false,
                post: gate.post !== false,
            };
        } else if (gate.kind !== 'git-commits') {
            return {
                error: `unknown gate kind ${JSON.stringify(gate.kind)} — only `
                    + '"git-commits" and "open-prs" are supported',
                status: 400,
            };
        } else if (!gate.ref || !String(gate.ref).trim()) {
            return { error: 'a git-commits gate needs a ref', status: 400 };
        } else {
            fields.gate = {
                kind: 'git-commits',
                ref: String(gate.ref).trim(),
                fetch: gate.fetch !== false,
            };
        }
    }

    // The ones that mean "no choice made" when empty, rather than being invalid.
    if (!partial || body.model !== undefined) fields.model = body.model || null;
    if (!partial || body.title !== undefined) fields.title = body.title || null;
    if (!partial || body.test !== undefined) fields.test = !!body.test;
    if (!partial || body.enabled !== undefined) fields.enabled = body.enabled !== false;
    // Not checked against the expression, deliberately. `once` on `0 2 * * *` is
    // a schedule that runs tomorrow at 2 AM and then switches itself off, which
    // is odd but coherent — and a dated expression *without* the flag is a
    // birthday reminder. Neither is the store's business to refuse.
    if (!partial || body.once !== undefined) fields.once = !!body.once;

    return { fields };
}

/**
 * Sessions this process started from a schedule, so a finished turn can be
 * attributed back.
 *
 * In memory rather than on the row, and only for runs *this* bridge started.
 * The row carries `lastSessionId` for the card to link to, but a verdict may only
 * be recorded by the process that owns the runner — otherwise a dev bridge
 * watching the same file would file a second notification for somebody else's
 * run. Bounded because a long-lived bridge would otherwise accumulate one entry
 * per run forever.
 *
 * The value carries the pull request when there is one, because the GitHub write
 * that follows the turn needs to know its target. **It is not the durable record
 * of that, though** — the reviewed entry on the row is, written at session start,
 * which is what lets a finished review still be attributed after this map has
 * evicted it or a restart has emptied it. See `scheduleOfSession`.
 * @type {Map<string, {scheduleId: string, target: object|null}>}
 */
const scheduledRuns = new Map();
// Raised from 200: a sweep can start a dozen in a night, so the fan-out makes the
// eviction path reachable in a way one-session-per-slot never did.
const SCHEDULED_RUNS_KEPT = 400;

function rememberScheduledRun(sessionId, scheduleId, target = null) {
    scheduledRuns.set(sessionId, { scheduleId, target });
    while (scheduledRuns.size > SCHEDULED_RUNS_KEPT) {
        scheduledRuns.delete(scheduledRuns.keys().next().value);
    }
    // The half that outlives this process. This map carries the pull request a
    // run is about and is deliberately in memory only — a restart mid-review is
    // a review that stops. *Which schedule started a session* is a different
    // fact with a different lifetime: the rail groups on it forever.
    schedules.rememberRun(sessionId, scheduleId);
}

/**
 * Start the session a schedule describes, right now.
 *
 * Shared by the tick and by `POST /api/schedules/:id/run`, which is the whole
 * reason it is a function: "Run now" has to produce a session *identical* to
 * what the clock produces, and the only way to be sure of that is for there to
 * be one path. `POST /api/drafts/:id/start` makes the same argument about the
 * three clients of this API; here the second caller is a timer.
 *
 * `force` is what Run now passes. It skips the gate and does not care about
 * slots — you pressed the button, so something should happen even if there are
 * no new commits — but it does *not* skip `modeRefusal` or the rate limit.
 *
 * `who` is the caller a route was reached by, and **the tick passes `LOCAL_CALLER`
 * rather than nothing.** A schedule firing is the machine acting on its own, which
 * is as local as a caller gets — a schedule saved at the desk in `dontAsk` must
 * still run at 2 AM when there is no request behind it. `modeRefusal` reads
 * `who.remote`, so the tick handing it `null` was a thrown TypeError inside a
 * timer: the slot got claimed, the run never happened, and nothing was recorded
 * against the schedule to say why.
 *
 * @returns {Promise<{ok: true, sessionId: string, prompt: string, facts: object}
 *   | {ok: false, skip: string, error?: string, detail?: string, head?: string}>}
 */
const LOCAL_CALLER = { remote: false, peer: 'the schedule', host: null };

async function runSchedule(row, { force = false, who = LOCAL_CALLER, target = null } = {}) {
    // Re-checked at the moment of spawning, not trusted from write time. The
    // roots are configuration and the mode is the caller's; a directory can be
    // moved after a schedule is saved, and this file is hand-editable. Same
    // reasoning as `POST /api/drafts/:id/start`, and it matters more for a row
    // that may sit unread for months.
    const mode = normalizeMode(row.permissionMode);
    const refusal = modeRefusal(mode, who);
    if (refusal) return { ok: false, skip: 'error', error: refusal };

    try {
        resolveWorkdir(row.cwd);
    } catch (err) {
        return { ok: false, skip: 'error', error: err.message };
    }

    // The gate, and the marker the prompt will be built from.
    //
    // A `target` is a pull request whose range `fireSchedule` has already worked
    // out, so the gate below is skipped entirely: for a PR gate the "has anything
    // changed" question was answered per PR by `unreviewedPulls`, and asking a
    // second time here against `lastMarker` would be asking about the wrong thing.
    let facts = target ? target.facts : { at: Date.now() };
    if (!target && row.gate && row.gate.kind === 'git-commits') {
        const range = await git.commitRange(row.cwd, row.gate.ref, row.lastMarker,
            { fetch: row.gate.fetch });
        if (!range.ok) {
            return {
                ok: false, skip: 'error',
                error: range.error || `cannot read ${row.gate.ref}`,
                detail: range.reason,
            };
        }
        // Nothing new: no session, and — the important half — the marker is
        // left exactly where it was.
        if (!force && range.count === 0) {
            return { ok: false, skip: 'nothing-new', head: range.head };
        }
        // **A forced run with nothing new reviews the tip commit, not nothing.**
        //
        // Run now skips the gate, but skipping the gate alone is not enough:
        // with the marker already at `head`, `{{range}}` comes out as
        // `abc123..abc123` — an empty range — and the session dutifully reports
        // that there is nothing to review. Which makes the button useless in the
        // two cases anybody presses it: checking a schedule works just after
        // setting it up, and asking for a review during a quiet week.
        //
        // Falling back to `head~1..head` is the same thing `fillPrompt` does when
        // there is no marker at all, and it costs nothing: the marker still
        // advances to `head`, which it already was.
        const empty = force && range.count === 0;
        facts = {
            ...facts,
            head: range.head,
            since: (range.staleMarker || empty) ? null : row.lastMarker,
            count: empty ? null : range.count,
            ref: row.gate.ref,
            staleMarker: range.staleMarker,
            fetchError: range.fetchError,
        };
    }

    if (tooManyCreates()) {
        return { ok: false, skip: 'rate-limited',
            error: `more than ${CREATE_LIMIT.max} sessions started in a minute` };
    }

    // Placeholders filled, then the note that nobody is watching — see
    // `unattended` in bridge/schedule.js for why it is appended rather than put
    // in front. This is the only expression that produces what a scheduled
    // session is actually sent, so putting it here is what makes the tick, the
    // pull-request drain and Run now agree; and Run now getting it too is the
    // point of the docstring above, not an oversight.
    const prompt = unattended(fillPrompt(row.prompt, facts));
    let out;
    try {
        out = pool.create({ cwd: row.cwd, prompt, model: row.model, permissionMode: mode });
    } catch (err) {
        // The marker is untouched, which is the point of doing this in this
        // order: a directory that has moved since you saved the schedule should
        // cost you tonight's run, not the commits it was going to review.
        return { ok: false, skip: 'error', error: err.message };
    }

    if (row.test) flags.set(out.sessionId, { test: true });
    index.note(out.sessionId);
    rememberScheduledRun(out.sessionId, row.id, target);
    return { ok: true, sessionId: out.sessionId, prompt, facts };
}

/**
 * Resolve the gate, decide what to start, and start as much as the budget allows.
 *
 * The one entry point for both the tick and `POST /api/schedules/:id/run`, which
 * is what keeps "Run now produces what the clock produces" true at the level that
 * matters. For a `git-commits` or ungated row it starts 0 or 1 sessions and the
 * behaviour is exactly what it was before this existed.
 *
 * @returns {Promise<{kind, started: Array<{sessionId, target}>,
 *   skipped: Array<{target, reason, error}>, deferred: number,
 *   remaining: number, gateError: string|null, repo: string|null}>}
 */
async function fireSchedule(row, { force = false, who = LOCAL_CALLER } = {}) {
    const kind = row.gate ? row.gate.kind : null;
    const out = {
        kind, started: [], skipped: [], deferred: 0, remaining: 0,
        gateError: null, repo: null,
    };

    if (kind !== 'open-prs') {
        const one = await runSchedule(row, { force, who });
        if (one.ok) out.started.push({ sessionId: one.sessionId, target: null, facts: one.facts });
        else out.skipped.push({ target: null, reason: one.skip, error: one.error || null });
        return out;
    }

    const found = await pullsForSchedule(row);
    out.repo = found.repo;
    if (!found.ok) {
        out.gateError = found.error;
        out.skipped.push({ target: null, reason: 'error', error: found.error });
        return out;
    }

    // Only on a successful list — see pruneReviews.
    schedules.pruneReviewed(row.id, found.repo, found.openNumbers);

    let due = found.due;
    // Run now with nothing due reviews the most recently updated PR anyway, the
    // same bargain the branch gate strikes: you pressed a button, so something
    // should happen. Commit 5c69146's reasoning, applied to a set.
    if (force && !due.length && found.pulls.length) {
        due = [found.pulls.slice().sort((a, b) =>
            String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]];
    }
    out.remaining = due.length;
    if (!due.length) return out;

    // One fetch for the whole batch rather than one per PR.
    await git.run('git', ['-C', row.cwd, 'fetch', '--quiet', '--no-tags', 'origin'],
        { timeout: 60_000 });

    const inFlight = reviewsInFlight(row);
    let budget = Math.max(0, Math.min(REVIEWS_PER_TICK, REVIEWS_IN_FLIGHT - inFlight));

    for (const pr of due) {
        if (budget <= 0) { out.deferred++; continue; }
        // Peek: `runSchedule` is the one that actually spends it.
        if (tooManyCreates({ reserve: CREATE_RESERVE, peek: true })) {
            out.deferred++;
            continue;
        }

        const key = reviewKey(found.repo, pr.number);
        // Already failed in this sweep at this SHA: still due, deliberately, but
        // not worth saying again every thirty seconds. See rangeFailures.
        if (sawRangeFailure(row.id, key, pr.headSha)) { out.deferred++; continue; }

        const range = await prRange(row.cwd, pr);
        if (!range.ok) {
            // No reviewed entry, so it comes back at the next slot.
            noteRangeFailure(row.id, key, pr.headSha);
            out.skipped.push({ target: pr, reason: 'error', error: range.error });
            continue;
        }

        const one = await runSchedule(row, {
            force, who,
            target: {
                pr,
                repo: found.repo,
                facts: {
                    at: Date.now(),
                    head: pr.headSha,
                    since: range.since,
                    count: range.count,
                    ref: pr.branch,
                    pr: {
                        number: pr.number, url: pr.url, title: pr.title,
                        branch: pr.branch, base: pr.base, author: pr.author,
                        repo: found.repo,
                    },
                },
            },
        });

        if (one.ok) {
            out.started.push({ sessionId: one.sessionId, target: pr, facts: one.facts });
            // **Written at start, not at completion**, and that inversion of this
            // file's usual rule is deliberate. The tick is thirty seconds away and
            // a review takes minutes, so an entry written only on completion means
            // the same PR fires again on every tick until it lands. The crash-after
            // -start case is covered by the boot sweep instead — see
            // recoverInterruptedReviews.
            schedules.noteReview(row.id, key, {
                sha: pr.headSha, at: Date.now(), sessionId: one.sessionId,
                outcome: null, posted: null, postError: null,
            });
            budget--;
        } else {
            out.skipped.push({ target: pr, reason: one.skip, error: one.error || null });
            // A rate limit or a full pool is not this PR's fault; stop starting
            // rather than burning through the rest of the list on the same wall.
            if (one.skip === 'rate-limited') { out.deferred += 1; break; }
        }
    }

    out.deferred = Math.max(0, due.length - out.started.length - out.skipped.length);
    return out;
}

/**
 * One pass over every enabled schedule.
 *
 * **Only the everyday instance fires**, and that guard is the one that actually
 * matters. Several bridges share `schedules.json` by design — the everyday one
 * plus a development bridge per agent working on this codebase — and without
 * this every one of them would spawn the user's 2 AM sessions. `claim()` is the
 * net under it rather than the mechanism.
 *
 * A dev bridge still lists schedules, still edits them, and still honours Run
 * now: that is a press, not a clock.
 */
// One pass at a time.
//
// `tickSchedules` is `await`-heavy — a fetch inside the drain is given sixty
// seconds — and it runs off a thirty-second interval, so two passes overlapping is
// ordinary rather than exotic. Pass one is safe either way because `claim()`
// settles it on disk, but the drain pass has no equivalent: it decides what to
// start from `reviewed`, and the entry for a pull request is only written *after*
// `pool.create` returns. Two overlapping drains could therefore both see the same
// pull request as due, start two review sessions for it, and post two comments.
//
// A boolean rather than a per-schedule lock because the passes are cheap and the
// interval is long: skipping a tick costs thirty seconds of latency on a batch
// that has half an hour, and a lock per schedule would be machinery guarding a
// window this closes entirely.
let ticking = false;

async function tickSchedules() {
    if (cfg.IS_DEV && !SCHEDULE_ON_DEV) return;
    if (ticking) return;
    ticking = true;
    try {
        await runTick();
    } finally {
        ticking = false;
    }
}

async function runTick() {

    // Start from disk. The everyday instance is the only process that fires, and
    // schedules get created and edited on others — so without this, one made from
    // a dev bridge or a phone would sit in the file doing nothing until this
    // process happened to restart. Cheap at 30s intervals, and `reload()` flushes
    // our own pending writes first so nothing in flight is lost.
    schedules.reload();

    const now = Date.now();
    let changed = false;

    for (const row of schedules.enabled()) {
        // **A test schedule belongs to whichever bridge is developing, and to no
        // other.** The rule reads both ways and the first version only wrote one
        // of them: `cfg.IS_DEV && !row.test` narrows a *dev* bridge and does
        // nothing at all on the everyday one, which went on firing everything in
        // the shared file. So a probe schedule created while 45888 was up got run
        // by 45888 — measured, not guessed: it started a session in the user's own
        // checkout. Test *sessions* are hidden from the everyday window; a test
        // schedule should be equally invisible to it, and now is.
        if (cfg.IS_DEV !== !!row.test) continue;

        const spec = parseCron(row.cron);
        if (spec.error) continue;

        // A schedule that has never run counts from when it was created, not
        // from the epoch — otherwise its first tick would owe every slot since
        // 1970 and the walk limit would decide which one it got.
        const cursor = row.lastSlotAt != null ? row.lastSlotAt : row.createdAt;
        const { slot, skipped } = dueSlot(spec, { cursor, now });
        if (slot == null) continue;

        // Past the catch-up cap. Recorded and notified rather than run: a slot
        // from two days ago must not start an unattended agent at a time nobody
        // chose it for, and a schedule that has quietly stopped firing is the
        // failure worth hearing about.
        if (now - slot > CATCHUP_MS) {
            const missed = skipped + 1;
            schedules.note(row.id, {
                slotAt: slot,
                skipReason: 'missed',
                error: `${missed} run${missed === 1 ? '' : 's'} missed — the bridge was `
                    + 'not running',
            });
            fileScheduleNote(row, {
                type: 'schedule-missed',
                summary: `${missed} scheduled run${missed === 1 ? '' : 's'} missed`,
                detail: `"${scheduleTitle(row)}" was due at `
                    + `${new Date(slot).toLocaleString()} and the bridge was not running. `
                    + 'The next run is at its normal time.',
                loud: true,
            });
            changed = true;
            continue;
        }

        // Take the slot before doing anything expensive. A fetch can take
        // seconds, and two ticks overlapping on one schedule would otherwise
        // both get as far as spawning.
        if (!schedules.claim(row.id, slot)) continue;
        changed = true;

        // A pull-request slot opens a window rather than doing the work; the
        // drain pass below picks it up in this same tick.
        if (row.gate && row.gate.kind === 'open-prs') {
            schedules.openSweep(row.id, slot, SWEEP_MS);
            continue;
        }


        // The claim has already been written, so from here every exit has to
        // leave a reason on the row. An unhandled throw between here and the end
        // of the loop consumed the slot and recorded nothing — the schedule
        // simply skipped a night and the card had no idea why. The one that
        // happened was a TypeError in `modeRefusal`; the catch is here so the
        // next one is a visible failure rather than a silent one.
        let result;
        try {
            result = await runSchedule(row);
        } catch (err) {
            result = { ok: false, skip: 'error', error: err.message };
            console.error(`[tgxcode] schedule ${scheduleTitle(row)} threw: `
                + `${err.stack || err.message}`);
        }

        if (result.ok) {
            schedules.note(row.id, { sessionId: result.sessionId, marker: result.facts.head });
            console.log(`[tgxcode] schedule ${scheduleTitle(row)} started `
                + `${result.sessionId}`);
        } else {
            // `marker` is deliberately not passed on any of these paths, so a
            // skip or a failure cannot consume the commits it did not review.
            schedules.note(row.id, { skipReason: result.skip, error: result.error || null });
            if (result.skip === 'error') {
                fileScheduleNote(row, {
                    type: 'schedule-failed',
                    summary: 'a scheduled run could not start',
                    detail: `"${scheduleTitle(row)}": ${result.error}`,
                    loud: true,
                });
            }
        }
    }

    // ── pass two: drain any open review window ───────────────────────────
    //
    // Separate from the loop above because it is not about slots. A window may
    // have been opened by this tick or by one twenty minutes ago, and either way
    // the question is the same: what does this schedule still owe, and how much of
    // it may start now. Re-read so a window pass one just opened is seen.
    //
    // **`list()` rather than `enabled()`, because a one-time schedule is disabled
    // by the very slot whose window this is draining.** `claim()` spends a `once`
    // row the moment it takes the slot — deliberately, so a crash cannot leave one
    // armed for a slot it already had — and a PR gate then opens a window that
    // outlives that write by up to half an hour. Walking `enabled()` here would
    // abandon the batch after its first pull request, leave `sweepUntil` set
    // forever, and skip the "N went unreviewed" notification that exists to make
    // exactly that visible. Anything else that is off was turned off by a person,
    // and stays off.
    for (const row of schedules.list()) {
        if (!row.enabled && !(row.once && row.sweepUntil)) continue;
        if (cfg.IS_DEV !== !!row.test) continue;
        if (!row.gate || row.gate.kind !== 'open-prs') continue;
        if (!row.sweepUntil) continue;

        if (now > row.sweepUntil) {
            // Out of time with work left. Said out loud rather than dropped: a cap
            // that truncates silently reads as "everything was reviewed".
            const found = await pullsForSchedule(row).catch(() => null);
            const left = found && found.ok ? found.due.length : 0;
            if (left > 0) {
                schedules.closeSweep(row.id, {
                    skipReason: 'sweep-expired',
                    error: `${left} pull request${left === 1 ? '' : 's'} were not reviewed `
                        + 'before the review window closed',
                });
                fileScheduleNote(row, {
                    type: 'schedule-failed',
                    summary: `${left} pull request${left === 1 ? '' : 's'} went unreviewed`,
                    detail: `"${scheduleTitle(row)}" ran out of its review window with `
                        + `${left} still to do. They will be picked up at the next run.`,
                    loud: true,
                });
            } else {
                schedules.closeSweep(row.id);
            }
            rangeFailures.delete(row.id);
            changed = true;
            continue;
        }

        let swept;
        try {
            swept = await fireSchedule(row);
        } catch (err) {
            swept = null;
            console.error(`[tgxcode] sweep ${scheduleTitle(row)} threw: `
                + `${err.stack || err.message}`);
            schedules.closeSweep(row.id, { skipReason: 'error', error: err.message });
            changed = true;
            continue;
        }

        if (swept.started.length) {
            changed = true;
            // One `note` per session, not one per tick. `runs` counts sessions, so
            // recording only the last of a fan-out made a card that had just
            // reviewed three pull requests say "1 run". The last call also leaves
            // `lastSessionId` on the newest, which is what the card links to.
            for (const { sessionId, target } of swept.started) {
                console.log(`[tgxcode] schedule ${scheduleTitle(row)} started `
                    + `${sessionId} for #${target.number}`);
                schedules.note(row.id, { sessionId });
            }
        }

        for (const bad of swept.skipped) {
            changed = true;
            schedules.note(row.id, { skipReason: bad.reason, error: bad.error });
            if (bad.reason !== 'error') continue;
            fileScheduleNote(row, {
                type: 'schedule-failed',
                summary: bad.target
                    ? `#${bad.target.number} could not be reviewed`
                    : 'a scheduled review could not start',
                detail: `"${scheduleTitle(row)}": ${bad.error}`,
                loud: true,
            });
        }

        // Nothing due and nothing deferred: the batch is done and the window can
        // close early rather than sitting open for the rest of its half hour.
        if (!swept.remaining && !swept.deferred) {
            // "Nothing new" is about the *sweep*, not about this tick. The last
            // tick of a successful batch has nothing left to start by definition,
            // so asking only about this tick made a card that had just reviewed
            // three pull requests report that there was nothing to do.
            const workedThisSweep = row.lastFiredAt && row.sweepSlotAt
                && row.lastFiredAt >= row.sweepSlotAt;
            if (!workedThisSweep && !swept.started.length && !swept.skipped.length) {
                schedules.note(row.id, { skipReason: 'nothing-new', error: null });
            }
            schedules.closeSweep(row.id);
            rangeFailures.delete(row.id);
            changed = true;
        }
    }

    if (changed) broadcast('schedules-changed', schedulesPayload());
}

/**
 * Reviews whose process died with a previous bridge.
 *
 * A reviewed entry is written at session start so the fan-out is idempotent —
 * without that, a PR whose review takes minutes would fire again on every
 * thirty-second tick. The cost of writing early is this case: the bridge goes
 * down mid-review, and the entry says the PR was reviewed while nothing was ever
 * posted. Killing a bridge kills its turns, so there is no chance the run is
 * still going.
 *
 * **The SHA is deliberately left in place rather than cleared.** Clearing it is
 * the tidy-looking option and it is the wrong one twice over: a bridge that
 * crashes on startup would re-review the same pull requests every boot, and the
 * review that did run is sitting complete in its transcript — throwing that away
 * to buy a second copy is the expensive direction. Marked `interrupted` with a
 * link instead, which costs one paste and tells the truth.
 */
function recoverInterruptedReviews() {
    let found = 0;
    for (const row of schedules.list()) {
        if (!row.gate || row.gate.kind !== 'open-prs') continue;
        if (cfg.IS_DEV !== !!row.test) continue;
        for (const [key, entry] of Object.entries(row.reviewed || {})) {
            if (!entry.sessionId || entry.outcome || entry.posted) continue;
            found++;
            schedules.noteReview(row.id, key, {
                outcome: 'error', posted: 'interrupted',
                postError: 'the bridge stopped while this review was running',
            });
            fileScheduleNote(row, {
                sessionId: entry.sessionId,
                type: 'schedule-failed',
                summary: `the review of ${key} was interrupted`,
                detail: `"${scheduleTitle(row)}" was reviewing ${key} when the bridge `
                    + 'stopped. Whatever it had written is in the session transcript; it '
                    + 'was not posted, and the pull request will not be reviewed again '
                    + 'unless it gets new commits.',
                loud: true,
            });
        }
    }
    if (found) {
        console.log(`[tgxcode] ${found} interrupted review(s) marked`);
        broadcast('schedules-changed', schedulesPayload());
    }
}

/**
 * File a notification about a schedule, unless it is a test one.
 *
 * The gate exists because the log's own test filter cannot help here. It asks
 * `flags.get(sessionId).test`, and the rows most worth raising — a missed slot, a
 * ref that would not resolve — have **no session at all**, so `isTest(null)` is
 * false and they read as ordinary. That would put an agent's throwaway probe
 * failing every two minutes into the user's everyday notification list.
 *
 * Checked against the schedule's own flag instead, which is the thing that
 * actually knows. Nothing is lost: a test schedule's failures are visible on its
 * card, on the bridge that owns it, which is where anybody looking for them is.
 */
function fileScheduleNote(row, entry) {
    if (row.test) return;
    filed(notifications.record({ ...entry, title: scheduleTitle(row) }));
}

/**
 * Attribute a finished turn back to the schedule that started it.
 *
 * **Only when there was something to see.** Nobody is awake at 2 AM, so the
 * useful signal in the morning is "did anything go wrong", and a notification per
 * clean overnight review is noise that trains you to ignore the ones that
 * matter. So a BLOCK or CONCERNS verdict, or a turn that errored, is loud; a
 * CLEAN one is recorded on the row for the card and says nothing.
 *
 * A schedule can run any prompt, and most will have no verdict at all. That case
 * is "finished, nothing to say" — recorded quietly, never treated as a failure.
 */
function noteScheduledOutcome(r) {
    const found = scheduleOfSession(r.sessionId);
    if (!found) return;
    scheduledRuns.delete(r.sessionId);

    const { row, target } = found;

    const runner = pool.get(r.sessionId);
    const verdict = r.isError ? null : verdictOf(runner && runner.lastResultText);
    const outcome = r.isError ? 'error' : (verdict || 'done');

    schedules.note(row.id, { outcome });
    if (target) {
        schedules.noteReview(row.id, reviewKey(target.repo, target.number), { outcome });
    }
    broadcast('schedules-changed', schedulesPayload());

    const bad = r.isError || verdict === 'BLOCK' || verdict === 'CONCERNS';

    // The GitHub half. Deliberately after the verdict is recorded and before the
    // notification, so a failed post can add to what the notification says.
    if (target) {
        postReviewToPr(row, target, {
            sessionId: r.sessionId, verdict, outcome,
            body: runner && runner.lastResultBody,
        }).catch(err => console.error(
            `[tgxcode] posting review for #${target.number} threw: ${err.message}`));
        return;   // postReviewToPr files the notification, once it knows the outcome
    }

    if (!bad) return;

    // This one does carry a session, so the log's own test filter would catch it
    // — but it goes through the same gate as the other two so that "is this
    // schedule a test" is answered in one place rather than two ways.
    fileScheduleNote(row, {
        sessionId: r.sessionId,
        type: 'schedule-findings',
        summary: r.isError
            ? 'a scheduled run ended with an error'
            : `a scheduled review came back ${verdict}`,
        detail: r.isError ? r.detail : null,
        loud: true,
    });
}

/**
 * Which schedule — and which pull request — a finished session belonged to.
 *
 * `scheduledRuns` first, then the reviewed map on disk. The in-memory map is
 * faster and carries the resolved target, but it is lost to a restart and evicted
 * past `SCHEDULED_RUNS_KEPT`, and for a PR run that loss is not cosmetic: the
 * review ran, cost money, and its findings would never be posted anywhere. The
 * reviewed entry is written at session *start* precisely so the mapping survives
 * on disk, which makes it the fallback.
 *
 * @returns {{row: object, target: {repo, number, headSha}|null}|null}
 */
function scheduleOfSession(sessionId) {
    const held = scheduledRuns.get(sessionId);
    if (held) {
        const row = schedules.get(held.scheduleId);
        if (!row) return null;   // deleted while its run was in flight
        const t = held.target;
        return {
            row,
            target: t ? { repo: t.repo, number: t.pr.number, headSha: t.pr.headSha } : null,
        };
    }

    for (const row of schedules.list()) {
        if (!row.gate || row.gate.kind !== 'open-prs') continue;
        for (const [key, entry] of Object.entries(row.reviewed || {})) {
            if (entry.sessionId !== sessionId) continue;
            // **Only a review that has not finished.** Matching on the session id
            // alone meant any later turn in that session — you open the review and
            // ask it a follow-up question — was re-attributed to the pull request
            // and posted a second comment with a second relabel. Before the
            // fallback existed the in-memory map had already been deleted, so the
            // function simply returned; the fallback has to reproduce that.
            if (entry.outcome || entry.posted) continue;
            const hash = key.lastIndexOf('#');
            return {
                row,
                target: {
                    repo: key.slice(0, hash),
                    number: Number(key.slice(hash + 1)),
                    headSha: entry.sha,
                },
            };
        }
    }
    return null;
}

module.exports = {
    init,
    SCHEDULE_MS, SCHEDULE_ON_DEV, SWEEP_MS,
    scheduleOut, schedulesPayload, scheduleFields,
    runSchedule, fireSchedule,
    tickSchedules, recoverInterruptedReviews,
    noteScheduledOutcome,
};
