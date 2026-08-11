# 12 — Export

**Effort:** S · **Depends on:** none · **Touches:** new `bridge/export.js`,
`bridge/server.js`, `web/app.js`

## Why

There is no way to get a conversation out of the app. Sharing what an agent did
means screenshots or hand-copying. The rendering work is already done — markdown
(`web/markdown.js`), syntax highlighting (`web/highlight.js`), diffs
(`diffView`) — it just has nowhere to go but the screen.

## Design

`GET /api/sessions/:id/export?format=md|html|json&from=&to=&include=`

**Range.** Whole session, or a turn range. The turn rail already gives every
user turn an index (`state.turns`), so "turns 4–7" is a natural selection: shift
-click two ticks.

**`include` flags**, comma-separated, because the right export differs by
purpose:

| Flag | Default | |
|---|---|---|
| `thinking` | off | usually blank anyway (see the README's note) |
| `tools` | on | tool calls |
| `output` | on | tool results, truncated |
| `full-output` | off | pull in spilled `tool-results/*.txt` files |
| `subagents` | off | expand subagent transcripts inline |
| `system` | on | permission denials, compaction markers |

**Formats.**

- **`md`** — the default. Your turns as `## You`, Claude's as prose, tool calls
  as fenced blocks with a one-line header, edits as ```diff fences. Pastes into
  a PR description or an issue and reads correctly. This is the format that will
  actually get used.
- **`html`** — one self-contained file: inline the CSS from `web/styles.css`,
  inline the highlighted markup, no external requests. Reuse the renderers by
  running them server-side… which they can't be, since `web/markdown.js` is an
  ES module for the browser and the bridge is CommonJS with no build step.
  Rather than fight that, generate HTML **in the renderer** — the events are
  already in the DOM — and POST it to the bridge only to write the file. Keeps
  the zero-dependency, no-build constraint intact.
- **`json`** — the event array as the bridge builds it. For anyone wanting to
  process a session with their own tools; it is the most honest export because
  it is exactly what the UI sees.

**Redaction.** A pass that masks anything matching common secret shapes
(`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `.env` contents in a Read result) before
writing, on by default, with a count reported: *"masked 3 possible secrets"*.
Transcripts contain whatever the agent read, and an export is the moment that
content leaves the machine. Off is available; the default is on.

**Delivery.**

- **Copy to clipboard** — the common case, straight from the renderer.
- **Save to a file** — write into the session's cwd or `~/Downloads`, then
  reveal it with the existing `openInExplorer` helper (`explorer.js`).
- No upload, no gist, no share link. Sending a transcript somewhere is a
  decision the user should make with their own tools.

## Acceptance

- Exporting turns 4–7 as markdown produces a document that reads correctly in a
  PR description with working diff blocks.
- The HTML export opens in a browser with no network access and looks like the
  app.
- An API key in a tool result is masked by default, and the export says it
  masked something.
