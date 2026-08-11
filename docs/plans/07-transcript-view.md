# 07 — Transcript view: todos, markers, and virtualization

**Effort:** M · **Depends on:** none · **Touches:** `web/app.js`,
`web/styles.css`, `bridge/transcript.js`

Three changes to the same surface. Virtualization is the risky one and should
land last, but it constrains how the other two are written, so they share a
plan.

## A. Sticky todo panel

**Why.** `TodoWrite` renders as one collapsed tool block among hundreds
(`app.js:604`, `todoView` at `app.js:736`). The current todo list is the single
best answer to "what is this agent actually doing", and it is invisible unless
you scroll to the right block and expand it.

**Design.** Track the most recent `TodoWrite` input while building events; hold
it on the summary. Render as a collapsible strip under the conversation header:

```
▸ 3 of 7   ✓ Read the transcript parser  ▸ Wire the control channel  ○ …
```

- Collapsed: counts plus the current in-progress item.
- Expanded: the full list, using the existing `todoView` styling.
- Updates live — it is derived from the same tail as everything else.
- Hidden entirely for sessions that never call `TodoWrite`.

Compute it in the bridge (`buildEvents` can carry `lastTodos` alongside the
`model` it already returns at `transcript.js:370`) so the dashboard cards can
show progress without re-deriving it.

## B. Markers on the turn rail

**Why.** The rail (`renderTurns`, `app.js:952`) is one tick per user turn —
useful, and already doing the hard part (positioning, popover, active
tracking). But a 400-event session where one Bash call failed gives no way to
find that failure.

**Design.** A second class of mark on the same rail, visually subordinate to
turn ticks:

| Mark | From |
|---|---|
| error | `ev.isError`, or tool `status === 'error'` |
| permission | `ev.subtype === 'permission_denied'`, and plan 01's asks |
| compact | `kind === 'compact'` — already an event type |
| subagent | tool events with `ev.agent` |
| search hit | plan 03's find-in-conversation |

- Position by the same offset maths `markActiveTurn` uses.
- `Alt+↓` / `Alt+↑` jump to next/previous error — the actual point of the
  feature.
- Hover shows the same popover, describing the mark.
- Density cap: above ~200 marks, cluster adjacent ones into a single taller mark
  with a count, or the rail becomes a solid bar.

## C. Virtualization

**Why.** `openSession` (`app.js:327`) builds a DOM node for every event and
syntax-highlights each one eagerly. `codePre` caps a single block at 40 000
characters, but there is no cap on the number of blocks. A long session is slow
to open, heavy to hold, and every `renderTurns` walk touches all of it.

**Design.** Windowed rendering, not a rewrite.

- Keep `state.nodes` as the source of truth but make its `node` field lazy: an
  entry may hold `{ev, node: null, height}`.
- Render a window of ~80 events around the viewport plus everything after the
  last user turn (the live tail must never be virtualized — that is where new
  content lands and where auto-scroll lives).
- Use an `IntersectionObserver` on spacer elements above and below the window.
- Cache measured heights per event id so scrollbar position stays stable;
  estimate from event kind before first measure.
- **Defer highlighting.** Highlight a code block when its node enters the
  viewport, not at build time. This alone is most of the win and could ship
  first, independently.

**Order of work:** deferred highlighting → height caching → windowing. Each
step is separately shippable and measurable.

**Invariants that must not break:**

- `jumpToTurn` must work for a turn whose node does not exist yet — jump by
  index, materialize, then scroll.
- Find-in-conversation (plan 03B) must search event *data*, never the DOM.
- The `patchTool` path (`app.js:448`) replaces a node in place; it must no-op
  cleanly when that node is not currently materialized.
- Auto-scroll pinning (`state.pinned`) keys off scroll position; with estimated
  heights above the viewport, the "am I at the bottom" test must use the real
  bottom, not the estimated total.

## Acceptance

- A 3 000-event session opens in under a second and scrolls smoothly.
- `Alt+↓` walks the errors in order.
- The todo strip tracks a running agent live and disappears for sessions with no
  todos.
- Nothing above regresses `patchTool`, the live tail, or turn jumping.
