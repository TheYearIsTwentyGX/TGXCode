# 03 — Search: across transcripts, within a conversation, and filters

**Effort:** M–L · **Depends on:** none · **Touches:** `bridge/sessions.js`,
new `bridge/search.js`, `bridge/server.js`, `web/app.js`, `web/index.html`

Three surfaces, one plan, because they share a result model and a keyboard
story.

## Why

`SessionIndex.list()` (`sessions.js:173-192`) matches a query against exactly
five fields:

```js
const hay = [m.title, m.firstPrompt, m.lastPrompt, m.cwd,
             m.worktree && m.worktree.name, m.sessionId]
```

So "the session where I fixed the mirrored-networking thing" is unfindable
unless that phrase happens to be in the first prompt. There are ~700 transcripts
and a few hundred MB of content on this machine that no tool can currently
search. This is the largest capability the app has and does not expose.

Within a session it is worse: no find at all, in a document that can be
thousands of events long.

## Design

### A. Full-text across all transcripts

**Do not build an index.** A persistent inverted index over a corpus that is
appended to constantly is a lot of machinery and a lot of ways to be subtly
stale. Transcripts are JSONL on a local SSD; brute force with good filtering is
fast enough and is always correct.

`bridge/search.js`:

```js
async function* search({ query, scope, limit, signal })
```

- **Candidate ordering.** Walk `index.sessions` newest-`mtimeMs` first. Recency
  is the strongest relevance prior for this corpus and it means the first
  results appear immediately.
- **Cheap reject.** `fs.readFileSync` + `text.toLowerCase().includes(q)` before
  any parsing. Most files reject in one pass at memory bandwidth.
- **Parse only survivors.** Run the surviving lines through `parseLines` and
  pull the matching event via the existing `buildEvents` shapes, so a hit knows
  whether it was your message, Claude's, or a tool's input/output.
- **Stream results.** SSE or chunked JSON, so the UI fills in progressively and
  a search over 300MB feels instant even when it takes 3 seconds. Support
  cancellation — a new keystroke aborts the previous walk.
- **Budget.** Stop after N hits (default 200) or T ms (default 5000), and say so
  in the UI: "showing 200 of many — narrow the search". Never silently truncate.

Query syntax, kept small and learnable:

| Form | Meaning |
|---|---|
| `some words` | all terms, case-insensitive, anywhere |
| `"exact phrase"` | literal |
| `/regex/` | regex, applied per line |
| `project:claude-sessions` | restrict by project |
| `in:you` / `in:claude` / `in:tool` | restrict by event kind |
| `tool:Bash` | tool calls of one kind |
| `after:2026-07-01` `before:…` | timestamp range |
| `is:pinned` `is:archived` `is:error` | flags |

Parse in the bridge, not the UI. Unknown `key:value` pairs degrade to literal
text rather than erroring.

**Result model** — one object per hit, grouped by session in the UI:

```js
{ sessionId, projectName, title, ts, kind, toolName, eventId,
  excerpt: { before, match, after }, turnIndex }
```

`eventId` and `turnIndex` are what make a result *actionable*: clicking it opens
the session and jumps to that event, reusing `jumpToTurn`'s scroll-and-flash
(`web/app.js:1001`).

**UI**: a full-pane search view (not a dropdown — results need room), reached by
`Ctrl+Shift+F` or by typing in the rail filter and pressing Enter. Results
grouped by session, newest first, each showing the matching line with the term
highlighted, plus session/project/when.

### B. Find in conversation — **built**

`Ctrl+F` inside an open session. Entirely client-side over `state.nodes` — the
events are already in memory. Lives in the find section of `web/app.js`, whose
header comment carries the reasoning; this is what was asked for and what
changed on the way.

- Match against `ev.text`, tool input, and tool result text. ✓ `searchableText`
  and `toolText` do this from the event objects, mirroring `toolBody`'s branches.
- Highlight all hits; `Enter`/`Shift+Enter` cycle; `Esc` closes. ✓ — plus
  `F3`/`Shift+F3`, which is what a repeat key is on this platform, and which also
  reopens the bar on the last query when it is shut.
- Hits inside collapsed tool blocks: mark the collapsed summary with a hit count
  and expand on navigate. ✓ Both kinds of shut thing get a badge: the tool block
  and the fold a run of them was lifted into.
- Count in the field: `3 of 47`. ✓
- Draw hit markers on the turn rail. **Not done**, deliberately: `.turns` is a
  fixed-height tick per user message, not a proportional map of the transcript,
  so a hit's position does not map to a tick's without the marker layer plan 07
  §B adds. The cheap interim if it is wanted before then is `data-hits` on the
  existing `.turn-tick`, recoloured through the mechanism `[aria-current]`
  already uses — but `renderTurns` calls `replaceChildren`, so find would have to
  repaint after every one.

Added beyond the plan, because it was asked for: a **Subagents** toggle in the
bar. Off by default and not persisted. With it on the index covers the session's
transcript *and* its subagents', spliced in at the `Task` call that spawned each
one, and stepping into a subagent hit switches the pane through `openAgent`.
The index is then independent of which pane is showing, which is what lets a step
walk in and back out without the list changing underneath it. The toggle hides
itself when the session spawned nothing, and while you are reading a subagent —
you are already in one — unless it is on and therefore a thing to turn off. It
covers the one level the pill strip shows: `agentRows` leaves out agents spawned
*by* a subagent.

The caveat held, and turned out to be about more than plan 07: hits come from the
event data, and the DOM ranges that paint them are a cache rebuilt from a dirty
flag. Not only because virtualizing the log will take the DOM away, but because
`foldRun` *moves* rows into a fold without redrawing them — and the DOM's remove
steps collapse any live range inside a node that moves, silently, painting
nothing and throwing nothing.

Two things measurement changed. Painting every match cost 400ms a keystroke on
the longest session here (3 600 events, 2 300 tool calls, a two-letter query
matching 674 rows) — and almost none of it was the tree walking, which is 20ms
for the whole log. It was 674 badge elements inserted and removed per repaint,
each invalidating the layout of a very tall document. So the paint is bounded by
the viewport and scrolling repaints; the worst case is now under 100ms. And the
hit cap has to be generous (20 000) rather than tight, because it stops indexing
partway *down* the transcript: a low one leaves you at the bottom of a long
session with every mark up at the top and nothing saying so.

Known misses, all deliberate and all commented at the code: a match split across
an element boundary is not found, the same limit native find has; output spilled
to a file is in neither the data nor the DOM, since only the button that loads it
knows the text; and the two strings differ where markdown eats syntax or
`codePre` truncates, which navigation absorbs by clamping to the last range in
the row rather than by modelling the difference.

### C. Filters and the quick switcher

The rail gets a filter row above the list. Filters compose with the text query
and map onto the same `key:value` grammar, so the UI is just a builder for a
query string — one code path, and a filter can always be typed instead.

- **Active only** — uses plan 04's authoritative liveness
- **Project** — a dropdown from `/api/projects`
- **Has errors** — needs a `hasError` bit in `scanMeta`; cheap to add
  (`line.includes('"is_error":true')`) alongside the existing counters
- **Model**, **date range**, **worktrees only**
- **Sort**: last activity (current default is `mtimeMs`; note the metadata
  already tracks `lastUserTs` for the "your last message" ordering), turns, size

**Quick switcher** (`Ctrl+P`): a palette over session titles only — fuzzy, in
memory, instant, no server round trip. Deliberately *not* full text; that's
`Ctrl+Shift+F`. Two different questions deserve two different keys.

## Performance notes

- A cold full-text pass over ~300MB is roughly 1–3s on an SSD; the recency
  ordering means useful results appear in the first ~100ms.
- Cache nothing except what `SessionIndex` already caches. Adding a search
  cache means invalidating it, and the whole point of brute force is not having
  that problem.
- `readFileSync` of a 50MB transcript spikes memory. Above a threshold
  (say 8MB), stream in chunks with a carry-over buffer for line boundaries.

## Acceptance

- Searching a phrase you know is in an old session finds it, with the right
  excerpt, and clicking lands on that turn.
- `project:foo tool:Bash npm run dev` returns only Bash calls in that project.
- `Ctrl+F` finds text inside a collapsed tool block and expands it.
- A search started and abandoned mid-flight doesn't leave the bridge busy.
