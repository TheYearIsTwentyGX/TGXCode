# 15 — Scheduling and chaining

**Effort:** M · **Depends on:** 14 (required), 02 (for it to be useful) ·
**Touches:** new `bridge/schedule.js`, `bridge/server.js`, `web/app.js`

The weakest plan here. Read the "should this exist" section before building it.

## Should this exist?

Claude Code already has scheduled agents and cron-based routines. Rebuilding
that in this app duplicates something that works, and duplicated schedulers are
a classic source of "why did that run twice".

The case *for* doing it here is narrow but real: this app is where the results
get read. A run scheduled elsewhere lands as another row in the rail with no
indication it was scheduled, no grouping across runs, and no history of "did
last night's pass find anything".

So the recommendation is: **do not build a scheduler. Build a view over one.**

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

## B. Trigger a run now (small)

A button next to a recognised job: run it again immediately. This is just
`POST /api/sessions` with the recorded cwd and prompt — machinery that already
exists.

## C. An actual scheduler (only if A and B prove insufficient)

If it is built:

- **Storage.** `~/.local/share/claude-sessions/schedules.json`.
- **Trigger.** The bridge is not always running — `app/main.js` starts it and
  `stopBridgeIfIdle` shuts it down when the window closes and nothing is busy.
  A scheduler inside a process with that lifecycle will silently miss runs. Use
  the OS: register a systemd user timer or a cron entry inside WSL that calls
  the bridge, and have the bridge start itself if not running. Do not write a
  `setInterval` scheduler and call it done.
- **Permissions.** Unattended runs and `bypassPermissions` are a bad pairing. A
  scheduled run must declare its mode explicitly, default to `acceptEdits`, and
  any permission ask (plan 01) auto-denies with a note after the timeout since
  nobody is watching.
- **Auth.** Requires plan 14 — an unauthenticated bridge that starts agents on a
  timer is worse than one that only does it when asked.
- **Chaining.** `turn-complete` already fires (`server.js:459`). "When this
  finishes, start that one with this prompt" is a listener. Cap chain depth,
  because a chain that loops is a machine that runs agents forever.

## Risks

- **Silent failure.** A schedule that stops firing must be visible. Show last-run
  and next-run times, and notify (plan 02) when an expected run is missed.
- **Quota.** Unattended runs eat the same 5-hour window as interactive ones
  (plan 05). Show a scheduled job's typical consumption before enabling it.

## Acceptance for A + B

- Runs from the same scheduled job group into one rail row with a run history.
- A failed overnight run is visible without opening anything.
- "Run now" produces a session identical to what the schedule produces.
