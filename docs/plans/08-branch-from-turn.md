# 08 — Branch from a turn

**Effort:** S–M · **Depends on:** none · **Touches:** `bridge/runner.js`,
`bridge/server.js`, `web/app.js`, `bridge/transcript.js`

## Why

Most of this already works. Forking is implemented end to end:

- `runner.js:78` — `--fork-session`
- `runner.js:209-213` — a fork arrives as a new `session_id` on `system/init`,
  and the runner re-keys itself
- `runner.js:393-398` — `RunnerPool` re-keys the map so later sends reach the
  copy
- `server.js:461` — broadcasts `session-forked`
- `app.js:879` — the UI follows the new session

The only thing missing is *choosing where to branch from*. Today a fork always
continues from the end. But the useful case is "that was the wrong approach
four turns ago" — and the transcript already records the tree structure:
every entry carries `parentUuid` (visible throughout the JSONL, e.g.
`transcript.js` reads entries whose first field is `parentUuid`).

## Design

### UI

A control on every user turn — in the hover actions of the turn tick, and in a
small menu on the message row itself:

- **Branch from here** — start a copy that ends at this turn, then send a new
  message
- **Edit and branch** — prefill the composer with this turn's text so you can
  rewrite the prompt

Both open the composer with a banner:

```
Branching from turn 4 of 12 — the copy will not include turns 5–12.
[ Cancel ]
```

That sentence matters. "Branch" is ambiguous about what gets kept, and getting
it wrong wastes real work.

### Bridge

`POST /api/sessions/:id/send` gains `fromUuid`.

Behaviour depends on what the CLI supports, checked in this order:

1. **If `--resume` accepts a message uuid** (or an equivalent flag exists for
   resuming at a point), use it with `--fork-session`. Cleanest: Claude Code
   does the truncation and the copy.
2. **Otherwise, synthesize.** Write a new transcript containing entries up to
   and including `fromUuid`, with a fresh session id, into the same project
   directory, then `--resume` it normally.

Option 2 is a **direct conflict with constraint 2** ("we never write to Claude
Code's files") and needs a deliberate decision before it is built. Mitigations
if it is chosen:

- Only ever *create* a new transcript; never modify an existing one.
- Give it a fresh uuid, so nothing else can collide with it.
- Copy the `<session-id>/` sidecar directory (tool-results, subagents) for
  entries that survive the truncation, or accept that spilled output and
  subagent transcripts from the kept portion are unavailable in the copy — and
  say so in the UI.
- Verify Claude Code accepts a transcript it did not write before committing to
  this. If it does not, option 2 is dead and the feature is limited to option 1.

Investigate option 1 first. If it exists, this is a small plan; if it doesn't,
it is a much bigger one and possibly not worth it.

### Tree awareness

Once branching from a point is possible, a session has siblings. Cheap version,
worth doing:

- Record the parent in our own state: `~/.local/share/claude-sessions/lineage.json`
  mapping `childSessionId -> {parent, fromUuid, at}`. This is ours to write.
- Show it in the header: `branched from "add company flow" at turn 4`, as a
  link.
- In the rail, nest branches under their parent the way worktrees already nest
  under their checkout.

`session-forked` already carries `{from, to}`, so populating `lineage.json`
costs one listener in `server.js:461`.

## Risks

- **Copies multiply.** Three branches from one session and the rail is noisy.
  Nesting plus the existing archive flag covers it; do not add another
  hierarchy.
- **Cost.** A branch replays context. Say so on the banner if the session is
  large — this matters more on a quota plan (plan 05) than on API billing.

## Acceptance

- Branching from turn 4 of a 12-turn session produces a copy whose transcript
  ends at turn 4, and the UI follows it.
- The original is untouched and still resumable.
- The header of the copy names its parent and the turn it came from.
