# 11 — Labels, and what a session was configured with

**Effort:** S · **Depends on:** none · **Touches:** `bridge/flags.js`,
`bridge/sessions.js`, `bridge/transcript.js`, `bridge/server.js`, `web/app.js`

Two small features that both come down to "the app knows more about a session
than it shows".

## A. Titles, tags, and colours

**Why.** Titles come from `TITLE_TYPES = ['custom-title', 'agent-name',
'ai-title']` and fall back to the first line of the first prompt
(`transcript.js:179-186`). When that fallback fires you get things like
*"can you look at why the thing is broken"* as a permanent label, and there is
no way to fix it.

Meanwhile `flags.js` — explicitly "the only state this app owns" — holds two
sets of session ids and nothing else.

**Design.** Generalize `Flags` into per-session records, keeping the file
human-editable and the same atomic-write discipline:

```json
{
  "version": 2,
  "sessions": {
    "8df08a77-…": { "pinned": true, "title": "control channel spike",
                    "tags": ["spike"], "color": "amber", "note": "…" }
  }
}
```

- **Migrate from v1 in place.** `load()` already refuses a version mismatch
  (`flags.js:37`) and silently starts empty — that would throw away real pins,
  so add an explicit v1 → v2 upgrade path rather than bumping the constant.
- `title` overrides the derived one; the derived one stays visible in the
  session info panel so it is never lost.
- `tags` become filter terms (`tag:spike`) in plan 03's grammar and group
  headers in the rail.
- `color` tints the rail strip's left edge — the fastest way to tell projects
  apart at a glance.
- `note` is a free-text scratchpad per session, shown in the info panel. "This
  is the one with the good approach to X" is worth writing down.
- `prune()` (`flags.js:92`) already drops records for vanished transcripts.
  Keep that, but do **not** prune records that carry a title or note without a
  confirmation — those are real work, and a transcript can disappear because a
  project directory was moved rather than because it was deleted.

Rename `flags.js` to `state.js`? Tempting, but the README references it by name
and the file's doc comment explains the design well. Keep the filename; widen
the class.

## B. Session info panel

**Why.** The `system/init` message reports exactly what a session was built
with — model, tools, MCP servers, agents, skills, loaded CLAUDE.md files, the
cwd, the version. `runner.js:205-213` receives it and uses only `session_id`.
For sessions run in a terminal, the same information is in the transcript's
first entries.

When an agent behaves oddly, "which CLAUDE.md and which MCP servers were in
play" is the first question, and the app can answer it for free.

**Design.**

An `ⓘ` in the header opening a panel:

```
Session       8df08a77-…                          [copy]
Started       7 Aug 2026, 13:06     ·  4h 12m
Claude Code   2.1.224
Model         opus-5           Permission mode  acceptEdits
cwd           /home/…/claude-sessions
Worktree      build-app  (from main)
Branch        worktree-build-app          PR #12
Kind          bg   ·  entrypoint cli   ·  pid 524875 (running)
─────────────────────────────────────────────
MCP servers   playwright (connected)
Agents        claude, Explore, Plan, …
Memory        ~/.claude/CLAUDE.md, ./CLAUDE.md
Tokens        1.2M in · 84k out            (plan 05)
Turns         12 yours · 340 assistant · 216 tool calls
```

Most rows already exist on the summary (`sessions.js:197-221`). The new work is:

- capture `system/init` in the runner and stash it on the status object
- for sessions we didn't start, mine the equivalent from the transcript's early
  entries during `scanMeta` — cheap, they are small lines near the top
- pid/running from plan 04

Every id is copyable. The session id in particular gets copied constantly for
`--resume` and for deep links (plan 02).

## Acceptance

- Renaming a session sticks across restarts and does not touch the transcript.
- Existing pins and archives survive the v1 → v2 migration.
- Tags filter the rail and are searchable.
- The info panel shows the same MCP server list a terminal `/status` would.
