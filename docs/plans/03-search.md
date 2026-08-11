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

### B. Find in conversation

`Ctrl+F` inside an open session. Entirely client-side over `state.nodes` — the
events are already in memory.

- Match against `ev.text`, tool input, and tool result text.
- Highlight all hits; `Enter`/`Shift+Enter` cycle; `Esc` closes.
- Hits inside collapsed tool blocks: mark the collapsed summary with a hit count
  and expand on navigate. Not expanding is worse than the noise of expanding.
- Draw hit markers on the turn rail (see plan 07, which adds a marker layer).
- Count in the field: `3 of 47`.

Caveat: once plan 07 virtualizes the log, hits must come from the event *data*,
not the DOM. Write it against `state.nodes`' event objects from the start so it
survives that change.

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
