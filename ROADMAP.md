# Roadmap

Where this app goes next, and why. Each entry links to a plan in
[`docs/plans/`](docs/plans/) with the actual design.

Nothing here is committed work. The ordering is a recommendation, not a
schedule, and the tiers are about *how much the absence hurts*, not effort.

## The three constraints everything is designed against

These come out of how the app already works, and every plan respects them.

1. **Content comes from the transcript, never from the process.** It is what
   makes a session running in a terminal look identical to one started here. A
   feature that renders from the runner's stream instead reintroduces the
   de-duplication problem the current design avoids. The one sanctioned
   exception is *liveness* — state about a turn, not content of it.
2. **We never write to Claude Code's files.** `~/.claude/projects` is read-only
   as far as this app is concerned. State the app owns goes in
   `~/.local/share/claude-sessions/`.
3. **The bridge does the work; the shell is a window.** Anything touching the
   filesystem, `claude`, or the network belongs in `bridge/`. Anything needing
   Windows — tray, notifications, Explorer, protocol handlers — belongs in
   `app/main.js`. Keeping that line clean is why `bridge/` and `web/` need no
   rebuild.

## Tier 1 — felt daily

| | Plan | Why now |
|---|---|---|
| 1 | [Permission prompts and real interrupt](docs/plans/01-permissions-and-interrupt.md) | Today "prompting means denied", so the only working modes are *edits only* or *no guardrails at all*. This is the difference between a viewer and a client. |
| 2 | [Notifications, tray, and deep links](docs/plans/02-notifications-and-shell.md) | The premise of the app is watching sessions you aren't sitting in front of, and it currently cannot tell you anything. |
| 3 | [Search](docs/plans/03-search.md) | 700 transcripts, and the only thing you can match on is the title and first prompt. |
| 4 | [Liveness and the live-elsewhere lock](docs/plans/04-liveness-and-locking.md) | `~/.claude/sessions/*.json` is an authoritative registry of running sessions we aren't reading. It replaces an mtime guess and closes the two-writers hole. |
| 5 | [Usage and quota](docs/plans/05-usage-and-quota.md) | On a quota plan the question is "how much of my 5-hour window is left", and the answer is already flowing past us in `rate_limit_event`. |

## Tier 2 — makes long sessions and many sessions workable

| | Plan | Why |
|---|---|---|
| 6 | [Multi-session dashboard](docs/plans/06-dashboard.md) | One-session-at-a-time is the wrong shape when five agents are running. |
| 7 | [Transcript view: todos, error markers, virtualization](docs/plans/07-transcript-view.md) | Long sessions are slow to open and hard to navigate, and the todo list — the best summary of what an agent is doing — is buried in a collapsed block. |
| 8 | [Branch from a turn](docs/plans/08-branch-from-turn.md) | Forking is already implemented end to end; it just isn't reachable from a point in history. |
| 9 | [Composer](docs/plans/09-composer.md) | `@` files, `/` commands, images, a visible send queue, retry, snippets. |

## Tier 3 — the surrounding workflow

| | Plan | Why |
|---|---|---|
| 10 | [Code and git](docs/plans/10-code-and-git.md) | "What did this agent actually change" currently means scrolling. Part of the git side exists: `bridge/dashboard.js` already runs `git status --porcelain=v2` per directory, cached, for the dashboard — the primitives to extract into `bridge/git.js` are there. |
| 11 | [Labels and session info](docs/plans/11-labels-and-session-info.md) | Auto-titles are often bad, and the `system/init` message knows exactly which config produced a session's behaviour. |
| 12 | [Export](docs/plans/12-export.md) | Sharing what an agent did without screenshotting it. |
| 13 | [Dev servers](docs/plans/13-dev-servers.md) | We detect ports but can't act on them. |

## Tier 4 — worth doing, with caveats

| | Plan | Caveat |
|---|---|---|
| 14 | [Bridge security](docs/plans/14-bridge-security.md) | Anything that reaches loopback and sets one header can start a `bypassPermissions` session today. Prerequisite for 5-C and 15. |
| 15 | [Scheduling and chaining](docs/plans/15-scheduling.md) | Overlaps Claude Code's own cron. Only worth it to collect results in this UI. |
| 16 | [Retention](docs/plans/16-retention.md) | The app never deletes, which is the right default; this adds an opt-in path with a loud confirmation. |

## Suggested build order

**04 → 01 → 02 → 05 → 03.**

Liveness first because it is small, it is pure reading, and both the permission
work and the dashboard want a trustworthy answer to "is this session actually
running." Then permissions, which is the largest single behaviour change.
Notifications next because by then there are real events worth surfacing.
Usage and search are independent of everything and can slot in anywhere.

## Deliberately not doing

- **Rendering from the runner's token stream.** Tempting for per-token
  streaming, but it breaks constraint 1. Revisit only if partial-message events
  can be reconciled against the transcript by uuid.
- **Editing transcripts.** Not ours to write.
- **Reimplementing what `claude` already does well.** The bridge should drive
  the CLI, not reproduce its logic.
