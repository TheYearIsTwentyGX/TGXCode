# 05 — Usage and quota, for a subscription plan

> **Tier A shipped, and the survey below is out of date in one important way.**
> This document says the rate-limit data gives no percentage. That was true when
> it was written and is not true now. Checked against CLI 2.1.241:
>
> - The status line payload carries `rate_limits.five_hour.used_percentage` and
>   `rate_limits.seven_day.used_percentage`, parsed from
>   `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}` on **every API
>   response**. `used_percentage` is `utilization * 100` — the header is a 0–1
>   fraction, the status-line field is 0–100.
> - The stream's `rate_limit_event` carries `utilization` too, but only on the
>   `allowed_warning` path. Plain `allowed` still carries none, which is what
>   point 1 below was seeing.
> - `rateLimitType` is a known enum: `five_hour`, `seven_day`, `seven_day_opus`,
>   `seven_day_sonnet`, `seven_day_overage_included`, `overage`. The guess below
>   that the weekly window has its own id was right.
>
> What shipped is tier A plus a percentage: `bridge/usage.js` merges the stream
> events with what `scripts/quota-statusline.py` harvests from the status line.
> Point 4 still holds — `/usage` is a slash command, not a CLI subcommand.
>
> **Tier C is not available. Measured, not assumed — do not spend an afternoon
> rediscovering this.** The CLI has an internal `probeQuotaStatus`: a
> `max_tokens: 1` Messages request whose response headers carry the same
> `anthropic-ratelimit-unified-*` fields. Reproducing it from outside the CLI
> with the OAuth token from `~/.claude/.credentials.json` returns **`429`,
> `{"type":"rate_limit_error","message":"Error"}`, and no
> `anthropic-ratelimit-*` headers at all** — including with the CLI's own
> `user-agent`, and on an account that was demonstrably not rate limited at the
> time. The missing headers are the tell: a real quota rejection carries
> `anthropic-ratelimit-unified-status: rejected` plus the utilization figures,
> which is how the CLI itself detects that state. So the request is being
> refused before it reaches the quota system.
>
> The token does carry `user:inference`, so getting further is probably a matter
> of replicating more of the first-party client's identity. **That is the point
> at which to stop** — it is circumventing an access control Anthropic put there
> deliberately, and the prize is a percentage we already get for free whenever a
> terminal is open. The undocumented-endpoint version imagined below is the same
> objection with worse odds.
>
> **A background `claude` as a quota beacon: shipped, after two wrong turns.**
> Since the numbers come from the status line and the status line needs a TUI,
> the way to refresh without a terminal open is to *be* a TUI for a few seconds.
> `bridge/beacon.js` starts `claude`, lets its startup prefetch run the quota
> probe, takes what the harvester wrote, and kills it. Measured at ~4.4s a run.
>
> Two things were assumed wrong on the way, both worth recording:
>
> - **"Keep one open."** No: `probeQuotaStatus` is called from exactly one
>   place, the startup prefetch. The CLI probes once per process start and never
>   on a timer, so a long-lived beacon takes one reading and holds it forever.
>   It has to be *restarted*, not kept.
> - **"Then it will litter the rail, so pin one conversation and `--resume` it."**
>   Also no, and this is the good part: **a session that is never sent a message
>   writes no transcript at all.** No `<id>.jsonl`, so no row, nothing to clean
>   up, no conversation to pin. Verified by watching the project directory
>   across runs. The resume machinery was designed and then deleted unbuilt.
>
> What remains true, and is why the feature is off by default:
>
> - **Modals stop it**, and it will not press keys to get past them. The trust
>   prompt grants read, edit and execute on a directory; a background process
>   confirming dialogs it cannot read is not worth a percentage. Hence
>   `quota.beaconDir` is the user's to name, from the **user settings file only**
>   — a repository does not get to choose where this app starts Claude — and the
>   instruction is to open Claude there yourself once first.
> - **`--bare` must never be passed.** It is what would make startup cheap and
>   it explicitly skips background prefetches, i.e. the probe. `CLAUDE_CODE_SIMPLE`
>   is the same switch and is scrubbed from the child's environment.
> - **Each run costs** a CLI start and one `max_tokens: 1` request. Hence the
>   five-minute floor on the interval.
> - **`tengu_cicada_nap_ms`** gates the prefetch remotely. It is 0 today; raised,
>   runs inside the nap window would skip the probe and the beacon would quietly
>   stop refreshing.
>
> Every one of those fails the same safe way — no new reading, the pill ages
> visibly — and `beacon` in the `/api/quota` payload carries the reason and a
> readable line of whatever dialog is in the way, so the panel can say *why*
> rather than just going stale.
>
> The other mitigation is still in place, and is a property
> worth knowing: the stream's `rate_limit_event` starts carrying `utilization`
> once the account crosses a warning threshold. So the percentage is guaranteed
> live exactly when it is close to mattering, and can only go stale in the range
> where being approximate is cheap.
>
> Tier B is untouched and still worth doing.

**Effort:** M · **Depends on:** 14 for tier C · **Touches:** `bridge/runner.js`,
new `bridge/usage.js`, `bridge/server.js`, `web/app.js`

Replaces the original "cost dashboard" idea, which was written for API billing.
On a quota plan, dollars are the wrong unit — `costUsd` in the transcripts is
literally `0`. The question is **how much of the 5-hour window is left, and how
much of the week.**

## What is actually available on this machine

Investigated rather than assumed:

**1. `rate_limit_event` — already flowing through the runner.** Real payload
observed in a transcript:

```json
{"status":"allowed","resetsAt":1786134000,"rateLimitType":"five_hour",
 "overageStatus":"allowed","overageResetsAt":1786125600,"isUsingOverage":false}
```

`runner.js:262-269` receives these and throws them away unless `status !==
'allowed'`, in which case it raises a transient toast. This is the highest-value
data in the app that is currently discarded.

It gives: **which window**, **when it resets** (unix seconds), **whether you are
in warning/rejected**, and **whether overage is active**. It does *not* give a
percentage.

**2. Per-message `usage` in every transcript.** Observed:

```json
"usage":{"input_tokens":2,"cache_creation_input_tokens":11551,
 "cache_read_input_tokens":16686,"output_tokens":129,
 "cache_creation":{"ephemeral_5m_input_tokens":11551,"ephemeral_1h_input_tokens":0},
 "server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}}
```

Every assistant message, timestamped, with the model on the same line. Enough to
reconstruct consumption over any window, across every session including ones
run in terminals.

**3. `~/.claude/stats-cache.json`.** Daily tokens by model and lifetime totals.
Two problems: `costUSD: 0` throughout (quota plan), and it is only recomputed
on demand — on this machine `lastComputedDate` is a month stale. Useful as a
cross-check, not as a source.

**4. No CLI surface.** `claude --help` lists `agents, auth, auto-mode, doctor,
gateway, import, install, mcp, plugin, project, setup-token, ultrareview,
update`. There is no `claude usage`. The `/usage` view is interactive-only.

**5. OAuth credentials at `~/.claude/.credentials.json`** (0600). The mechanism
`/usage` itself must use.

## Design — three tiers, ship A+B

### Tier A — window state (exact, free, no hacks)

`bridge/usage.js` keeps the last `rate_limit_event` per `rateLimitType`,
persisted to `~/.local/share/claude-sessions/quota.json` so it survives a bridge
restart and is available before the first turn of the day.

```js
{ five_hour: {status, resetsAt, isUsingOverage, overageStatus,
              overageResetsAt, seenAt}, ... }
```

**Do not hardcode `five_hour`.** Only that type was observed locally; the weekly
window certainly has its own identifier and may only be emitted when relevant.
Key the store by whatever `rateLimitType` arrives and render generically —
humanize known types (`five_hour` → "5-hour"), fall through to the raw string
for anything else. That way the weekly gauge appears on its own the first time
the server sends one, with no code change.

Wire `runner.js:262` to emit **every** event, not just non-allowed ones.

UI: a small pill in the header rail.

```
5-hour ▸ resets 14:00 (2h 12m)      week ▸ resets Mon
```

with colour from `status`: normal / warning / rejected, and an overage marker
when `isUsingOverage`.

### Tier B — consumption curve (derived, approximate, genuinely useful)

Scan transcripts for `usage` blocks and build rolling totals.

- **Piggyback on the existing scan.** `scanMeta` (`transcript.js:67`) already
  reads every transcript and is cached by `(size, mtime)`. Add per-session
  token accumulation *bucketed by hour* — hourly buckets keep the cached record
  small and let any window be summed from them.
- Weight the sum. Cache reads are not equivalent to fresh input, and models
  differ. The real formula is not public, so define one weighting in
  `usage.js`, keep it in one place, and label the output as an estimate.
- **Self-calibrate.** Every time a `rate_limit_event` reports warning or
  rejected, record the current rolling total. After a couple of windows you have
  an empirical ceiling for *this* account, and the gauge becomes meaningful:

  ```
  5-hour  ▓▓▓▓▓▓▓░░░  ~68%   ·  est. from 4.1M / 6.0M weighted tokens
  ```

  Before calibration, show the curve without a percentage — "1.2M tokens this
  window" is honest and still useful.
- Always label estimates as estimates. A confidently wrong quota number is worse
  than no number.

Free by-products of the same scan: tokens by model, by project, by day; the
sparkline of a session's own consumption; "this session has cost you 12% of a
window" on the session header.

### Tier C — exact numbers (unofficial, opt-in, off by default)

The `/usage` command gets exact percentages from an Anthropic endpoint using the
OAuth token. The bridge could do the same: read
`~/.claude/.credentials.json`, call the endpoint, cache the response for a few
minutes.

It is your own credential, on your own machine, reading your own quota — but:

- The endpoint is undocumented and can change or disappear without notice.
- It puts a bearer token in the bridge's memory, and the bridge currently has no
  authentication in front of it (see plan 14). **Do not ship C before 14.**
- A wrong or rate-limited call must never affect sending.

So: off by default, `"quotaApi": true` in config, hard-fail closed to A+B, and a
clear note in the README that this part is unsupported and may break.

## UI summary

- **Header pill** — always visible, tier A, one line.
- **Click → panel** — tier B curves: both windows, consumption over time, by
  model, by project, plus the calibration state ("estimate based on 3 observed
  limit events").
- **Session footer** — this session's share of the current window.
- **Notification** (plan 02) — fire once when a window first reports warning,
  once on rejected, deduped per window by `resetsAt`.

## Risks

- **Sparse events.** `rate_limit_event` appears at session start; a long idle
  period means stale data. Show the age (`as of 12 min ago`) rather than
  implying it is live.
- **Sessions run elsewhere.** Tier B counts them (it reads all transcripts).
  Tier A only sees events from runners we spawn — but any terminal session's
  events land in *its* transcript, so the scan in B can harvest those too. Do
  that: parse `rate_limit_event` lines out of transcripts as well as the stream,
  and take the newest by `seenAt`.
- **Don't double count.** Subagent transcripts (`isSidechain`, separate files)
  carry their own usage. Count them once — they are real consumption — but make
  sure the parent's `totalTokens` field isn't added on top of them.

## Acceptance

- The pill shows a correct reset time that matches what `/usage` reports in a
  terminal.
- A weekly window appears automatically when the server first sends one, with no
  code change.
- With no `rate_limit_event` ever seen, the UI degrades to tier B's raw token
  counts instead of showing an empty or fake gauge.
- Nothing in this feature can block or slow a send.
