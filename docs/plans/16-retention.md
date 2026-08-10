# 16 — Retention

**Effort:** S · **Depends on:** 03 (the storage view is a search facet) ·
**Touches:** `bridge/sessions.js`, `bridge/server.js`, `web/app.js`

## Why

The app never deletes anything, and the README is proud of it:

> **Archiving never deletes.** Archiving moves a session out of the way and
> nothing else.

That is the right default and it should stay the default. But ~700 transcripts
and a few hundred MB accumulate, a cold scan gets slower, and there is currently
no way to even *see* what is taking the space, let alone act on it.

The goal is visibility first, and a deliberate, loud, opt-in removal path
second.

## A. Storage view (the actual feature)

A panel showing where the bytes are — `rec.size` is already tracked on every
index record (`sessions.js:92`) and exposed as `bytes` on the summary
(`sessions.js:219`), so this is presentation only:

```
By project                      By age
  LTCDataPlus     212 MB  340    < 7 days      41 MB   28
  claude-sessions  38 MB   62    7–30 days    120 MB  118
  TableGX          21 MB   44    30–90 days   190 MB  310
                                 > 90 days     94 MB  244
```

Plus the outliers: largest single transcripts, sessions with the most spilled
tool output, sessions with the most subagent transcripts. Often one runaway
session accounts for a surprising share, and knowing that is more useful than
any bulk operation.

## B. Bulk selection

Selection over search results (plan 03), so the criteria are the query grammar
rather than a second set of controls:

```
before:2026-01-01 is:archived
```

Then apply to the selection: archive, unarchive, tag, or delete.

Archive-in-bulk is the safe workhorse and should be the prominent action.

## C. Deletion, made deliberate

Deleting a transcript removes a record of work that cannot be recovered and that
Claude Code itself may still reference. Requirements:

- **Never the default.** No "clean up" button. Reached only from the storage
  view, on an explicit selection.
- **Show exactly what goes.** The `.jsonl`, its `<session-id>/` sidecar
  directory (tool-results, subagents), and the total bytes.
- **Refuse the live ones.** Anything running (plan 04's registry) or with a
  runner in the pool is excluded, with a reason shown.
- **Trash, not `unlink`.** Move to
  `~/.local/share/claude-sessions/trash/<date>/` and keep it for 30 days. The
  app gets its storage back on a delay, and a mistake is recoverable. Purging
  trash is its own explicit action.
- **Type to confirm** for anything over, say, 20 sessions or 100 MB.
- **Never touch a session with a custom title or note** (plan 11) without
  calling it out specifically — those carry a human decision.

This is the one place in the app that destroys data, and it should feel like it.

## D. Index hygiene, unrelated to deletion

Worth doing regardless:

- `_loadCache` discards the whole cache on a `CACHE_VERSION` bump
  (`sessions.js:146`), forcing a full re-scan of every transcript. Fine today at
  a few seconds. Consider per-record versioning so a shape change only
  reparses what actually changed.
- The cache file holds every record's metadata in one JSON blob rewritten on a
  2s debounce (`sessions.js:153-168`). At 700 records that is fine; at 5 000 it
  will not be. Worth a note in the code about when to reach for something else.

## Acceptance

- The storage view accounts for the total size of `~/.claude/projects` within a
  reasonable margin.
- Bulk-archiving 200 sessions from a search result works and is reversible.
- Deleting moves to trash, excludes live sessions, and requires typed
  confirmation past the threshold.
- Nothing in this plan can run without an explicit selection and confirmation.
