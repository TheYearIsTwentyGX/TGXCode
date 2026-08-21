# 10 — Code and git

**Effort:** M · **Depends on:** none · **Touches:** new `bridge/git.js`,
`bridge/explorer.js`, `bridge/server.js`, `web/app.js`

> **§A is built.** `bridge/git.js` holds the git primitives, extracted from
> `bridge/dashboard.js` as this plan expected and now sharing one cached
> `git status` with it. `bridge/changes.js` derives the transcript half,
> `GET /api/sessions/:id/changes` sends both, and the drawer sits beside the
> transcript rather than over it — built on the suggested-follow-ups aside, so
> it collapses to the same strip and disappears in the same narrow window.
> The two lists are stacked rather than side by side: at 300px there is room
> for one column of paths, and putting them side by side would have meant a
> panel wide enough to cover the transcript it jumps into.
>
> Three things this design did not anticipate, all of them now in
> `bridge/changes.js`:
>
> - **Subagents.** A session that delegates its work has no `Edit` calls of its
>   own, so "changed by this session" was empty for exactly the sessions that
>   changed the most. Their transcripts are folded in, read incrementally from a
>   remembered offset, and a row that came from one opens that agent's pane —
>   there is no call in this conversation to jump to.
> - **`ExitPlanMode` results carry a `filePath`** — the plan file. Keying on "the
>   result names a file" rather than on the tool's name listed approved plans as
>   edited code. `test/changes.test.js` pins that.
> - **A trailing line with no newline** is handed back by
>   `readSubagentTranscript` without being consumed, so the next read offers the
>   same call again — and a file's line counts double. Recorded ids are kept per
>   agent to stop it.
>
> §B and §C still stand. §B's `"explorer"` option is already written —
> `openFile` in `bridge/explorer.js`, which attachments use — so what is left
> there is the editor half and the containment check.

Three features about the code a session touched, sharing one bridge module.

## A. Session changes panel

**Why.** "What did this agent actually change" currently means scrolling the
whole transcript looking for `Edit` and `Write` blocks.

**Design.**

Two independent sources, shown together:

1. **From the transcript.** Every `Edit`/`Write` tool event carries
   `result.filePath` and `result.patch` (`transcript.js:413-422`, structured
   patch already extracted and rendered by `diffView`). Accumulate per session:
   file → list of {toolId, ts, hunks}. Purely derived, works for sessions run in
   a terminal, and correct even after the working tree has moved on.
2. **From git.** `git status --porcelain=v2` and `git diff` in the session's
   cwd — the *current* state of the tree, which may include changes the agent
   didn't make and exclude ones it made and reverted.

Panel, opened from the header:

```
Changed by this session (7 files)          Working tree (9 files)
  bridge/runner.js      +84 −12   3 edits     M bridge/runner.js
  bridge/server.js      +31 −4    2 edits     M bridge/server.js
  …                                           ?? scratch.md
```

Clicking a file scrolls to its first edit in the transcript, or opens the diff
inline. This makes the transcript navigable by *file*, which is often how you
remember what happened.

`bridge/git.js` runs git with `execFile`, never a shell, always with `cwd` set
and a timeout. Any git failure degrades to "not a git repo" — plenty of sessions
run outside one.

## B. Open in editor

**Why.** `explorer.js` already opens a *directory* in Windows File Explorer
through `\\wsl.localhost`. Files are the thing you actually want.

**Design.**

- Every file path in the UI — tool summaries, the changes panel, diff headers —
  becomes clickable.
- `POST /api/open-file` with `{path, line}`, resolving through an `editor`
  setting:
  - `"vscode"` (default): `code -g <path>:<line>` inside WSL, which attaches to
    an existing Remote-WSL window.
  - `"explorer"`: reveal in File Explorer via the existing helper.
  - `"none"`: open a read-only preview inside the app instead.
- **Path validation is mandatory.** Only allow paths inside the session's `cwd`
  or `projectCwd`, resolved with `path.resolve` and prefix-checked — exactly the
  containment check `persistedOutput` already does (`sessions.js:315-317`).
  Follow that pattern; it is the right one.

## C. Worktree creation

**Why.** Worktrees are already first-class in the data model — `scanMeta` reads
`worktree-state` entries, derives them from the
`<project>/.claude/worktrees/<name>` convention (`transcript.js:192-202`), the
rail nests them, and the header shows the branch. But making one still means
dropping to a terminal.

**Design.**

In the new-session dialog, next to the directory picker:

```
( ) Work in the project directory
(•) Create a worktree   [ branch name: ______________ ]  from [ main ▾ ]
```

Creating one runs `git worktree add` under the same convention Claude Code
uses, then starts the session with `cwd` set to the new worktree — after which
the existing detection recognises it with no further work.

Guard rails:
- Refuse if the branch exists as a worktree already; offer to open that session
  instead.
- Show the resulting path before creating.
- Do not offer worktree *removal* here. Deleting a worktree with uncommitted
  work in it is the kind of irreversible action this app should stay out of;
  point at the terminal.

## Risks

- **Big diffs.** A generated-file commit produces a huge `git diff`. Cap what is
  inlined and offer "open in editor" past that, reusing `codePre`'s existing
  40 000-character strategy.
- **Slow git.** A large repo makes `git status` non-instant. Cache per cwd with
  a short TTL and never block a render on it.

## Acceptance

- The panel lists every file a session edited, with per-file counts, and
  clicking one jumps to the edit.
- Clicking `bridge/runner.js:147` in a tool summary opens that file at that line
  in the existing VS Code window.
- A path outside the session's directory tree is refused by the bridge.
- Creating a worktree from the new-session dialog produces a session that the
  rail nests under the right project.
