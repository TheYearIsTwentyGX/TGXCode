# 06 — Multi-session dashboard

**Effort:** M · **Depends on:** 04 (strongly) · **Touches:** `web/app.js`,
`web/index.html`, `web/styles.css`, `bridge/server.js`

## Why

The app is built around one open conversation: `state.current` is a single
session, `/api/subscribe` explicitly drops every other follow —

```js
// server.js:155
// One session in view at a time; drop other follows so we aren't polling
// transcripts nobody is looking at.
```

That is a sound default. But the case this app exists for — several agents
working while you do something else — has no view. You end up clicking between
sessions to see which is stuck.

## Design

A second top-level view, not a replacement. Toggle in the header or `Ctrl+1` /
`Ctrl+2`.

### Cards

One card per session, from a filter that defaults to "running now, plus pinned":

```
┌──────────────────────────────────────────┐
│ ● add-company-flow          claude-sessions│
│   Running: Editing runner.js         1m24s │
│   ▸ 3 of 7 todos · 12 tools · :5006 live  │
│   ┌ last 3 events ─────────────────────┐  │
│   │ Read bridge/runner.js              │  │
│   │ Edit bridge/runner.js              │  │
│   │ "Now wiring the control channel…"  │  │
│   └────────────────────────────────────┘  │
│   [ Open ]  [ Stop ]                       │
└──────────────────────────────────────────┘
```

Card contents, all from data that already exists:

- liveness and pid from plan 04's registry
- `runner.activity` — already on the summary (`server.js:206`)
- elapsed time for the current turn
- todo progress (plan 07's extraction)
- dev-server chips (`/api/sessions/:id/devservers`)
- a permission ask, if one is pending (plan 01) — **answerable from the card**,
  which is the single best reason for this view to exist
- the last 2–3 events, one line each

### The subscription problem

Following N transcripts means N tails. The current design deliberately avoids
that. Two options:

**Preferred: a summary channel, not a content channel.** The dashboard does not
need transcript events — it needs *state*. Add
`GET /api/overview` returning, for every live session, the summary plus its last
few event *headlines* (kind + one-line summary, no bodies). Push it as a single
SSE `overview` event on a 1s tick when anything changed. One payload, one timer,
no per-session watchers. Card bodies stay tiny by construction.

**Fallback:** allow subscribing to up to ~6 sessions, raising the interval from
400ms to ~1.2s for non-focused ones. Simpler, but it scales badly and reopens
the polling cost the original comment was avoiding. Only do this if the
headlines turn out to be insufficient.

Go with the summary channel. It also serves the tray menu (plan 02) and can be
polled cheaply by anything else.

### Layout

Responsive grid, 1–4 columns by width. Sort: needs-you first (pending
permission, error, awaiting input), then running, then recent. "Needs you" at
the top is the whole point — the dashboard should answer "who is blocked on me"
at a glance.

### Focus mode

A stripped variant for a second monitor: no rail, no composer, just cards.
`?view=dashboard&focus=1` so it can be opened in a browser window and left up —
the README already treats browser use as first-class.

## Risks

- **Two renderers of the same state.** Card and rail must not drift. Keep one
  `sessionCard()` builder and let the rail strip be the compact variant of it,
  or accept the duplication explicitly and test both against one fixture.
- **Cost.** N cards each polling `/devservers` would be silly — that endpoint
  does port checks and a DevBrowser round trip. Fold dev-server state into the
  overview payload with a longer refresh (~15s).

## Acceptance

- Five sessions running: all five visible with live activity, one SSE stream,
  one timer.
- A session hitting a permission prompt sorts to the top and can be answered
  without opening it.
- Switching to the dashboard and back does not disturb the open session's tail
  or scroll position.
