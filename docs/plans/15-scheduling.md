# 15 — Scheduling and chaining

**Effort:** M · **Depends on:** 14 (required), 02 (for it to be useful) ·
**Touches:** new `bridge/schedule.js`, `bridge/server.js`, `web/app.js`

> **Status: C was built, and A and B were not.** This note recommended the
> opposite, on a premise that turned out to be wrong — see below. `bridge/schedule.js`
> and the `/api/schedules` routes are the scheduler; `docs/api.md` is the contract.
> **A is still worth doing** and is the obvious next piece: the runs a schedule
> produces are ordinary rail rows, with no grouping and no run history.

## Should this exist?

**This section was wrong, and the way it was wrong is worth keeping.** It argued
that Claude Code already schedules agents, so building a second scheduler here
would duplicate something that works. Three things were checked before building
and none of them held:

- **There is no durable local scheduler to build a view over.** The CLI's own
  cron is session-scoped and in memory — it dies with the session and expires
  after a week. It cannot hold a nightly schedule at all.
- **Cloud routines can, but not for this.** They run against a clone, so a
  schedule that depends on anything only present in a local checkout — an
  uncommitted skill, a worktree, a gitignored config — cannot run there. The job
  this was built for is exactly that case.
- **"Since the prior run" is state nobody else keeps.** A reviewed-SHA marker per
  schedule has to live wherever the schedule does.

The general lesson stands even though the conclusion did not: *check whether the
thing you would be duplicating actually does what you need* — the answer here was
"nearly, in a way that never survives contact".

What does survive is the warning in section C, which was the useful half of this
note and is honoured in full. See the header comment in `bridge/schedule.js`.

## A. Recognise scheduled runs (done)

Below as written, minus the "read the schedule from Claude Code's own config"
line — the schedule is ours now, and `GET /api/schedules` already serves it with
`lastSessionId`, `runs` and `lastOutcome` on every row. What was missing was a
`scheduleId` on the session, so the rail could group them.

It is there now, as `schedule: {id, title}` on every session summary, and the rail
folds a project's scheduled runs into a **Scheduled** subsection of its card.
Three things about how, because none of them was the obvious answer:

- **`jobId` and `sessionKind` were the wrong place to look.** Neither is written
  for a session this bridge starts — `pool.create` mints an ordinary session, on
  purpose, so that "Run now" and the clock produce the same thing. The link has to
  be recorded on our side or not at all.
- **The record is a file of its own**, `schedule-runs.json`, not a field on the
  schedule row. `clean()` in `bridge/schedule.js` is a whitelist and every bridge
  rewrites `schedules.json` through it on its tick, so a row field a *running*
  older bridge has not heard of is stripped within half a minute of being written.
- **Sessions that predate all of this are still recognised**, by matching the
  literal head of a schedule's prompt — everything before its first
  `{{placeholder}}` — against the session's first prompt, in the schedule's own
  directory. Without that arm the grouping would have started empty and filled in
  over a fortnight of nights. Note that the `<command-message>` tags a scheduled
  prompt leaves in a transcript are *not* the signal: every slash command typed by
  hand writes the same ones.

## A. Recognise scheduled runs (do this)

Claude Code records enough to identify these. `scanMeta` already reads
`sessionKind` from transcripts (`transcript.js:119`) — `bg` marks background
agents — and the session registry (plan 04) carries `kind`, `entrypoint`, and
`jobId`.

- Group runs sharing a `jobId` in the rail: one collapsible row, *"nightly test
  triage — 14 runs, last 3h ago, 2 with errors"*.
- Show a run history strip: one mark per run, coloured by outcome, click to open.
- Surface the schedule that produced them, read from Claude Code's own config —
  read-only.

This is small, it is consistent with the app's "derive everything from Claude
Code's files" design, and it delivers most of the value.

## B. Trigger a run now — **done**

`POST /api/schedules/:id/run`, and the important part is what it turned out to
need: it runs the *same function* the tick runs rather than reassembling a create
call, because "Run now produces a session identical to what the schedule
produces" is only true if there is one code path.

## C. An actual scheduler — **built**

What was predicted here, and what it actually took:

- **Storage.** `~/.local/share/claude-sessions/schedules.json`. As written. It
  also needed drafts.js's *merge-on-write*, which this note did not anticipate:
  several bridges share the file, and a whole-file rewrite loses the others' rows.
- **Trigger.** The warning was right and the prescription was not. An in-bridge
  `setInterval` alone does miss runs — but a cron entry that starts the bridge
  cannot help either, since cron does not run when WSL is off. What works is a
  30s tick **plus a catch-up pass on boot**, so a slot missed while the bridge was
  down is found on the way back up, with a 12-hour cap so a machine that slept for
  a week does not produce five reviews at breakfast. That cap is the piece that
  makes "do not write a `setInterval` scheduler and call it done" satisfiable
  in-process.
- **Permissions.** Refined. Defaulting to `acceptEdits` is wrong for the
  read-only reviews this is mostly for: they never edit, and `auto` would sit at
  the first prompt until morning. The dialog defaults a *schedule* to `dontAsk`
  where it defaults a session to `plan`, and the existing remote refusal of
  `dontAsk`/`bypassPermissions` covers the phone case with no new rule. The
  auto-deny-after-timeout idea was not needed and was not built.
- **Auth.** Plan 14 landed first, as required.
- **Chaining.** Not built. Still a listener on `turn-complete`, and the cap on
  chain depth is still the thing to get right.

One risk this note did not name, found the hard way while building: **an exception
after the slot is claimed loses the run silently.** The claim is on disk, so the
schedule believes it ran; nothing is recorded to say it did not. The tick catches
per schedule and records the throw as a failure.

## Risks

- **Silent failure.** Handled: the card shows last-run and next-run, `lastSkipReason`
  distinguishes "nothing to do" from "broken", and a missed slot notifies loudly.
- **Quota.** Not addressed. Unattended runs eat the same window as interactive ones
  and nothing shows a schedule's typical consumption before you enable it.

## Acceptance

- ~~Runs from the same scheduled job group into one rail row with a run history.~~
  **Not done** — this is A, and it is what is left.
- A failed overnight run is visible without opening anything. **Done**, on the card
  and as a notification.
- "Run now" produces a session identical to what the schedule produces. **Done**,
  by construction.
