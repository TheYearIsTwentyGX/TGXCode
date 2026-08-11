# 05 — Usage and quota, for a subscription plan

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
