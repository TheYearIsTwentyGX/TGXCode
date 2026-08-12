# Working on Claude Sessions

This app is used while it is being worked on. Dylan keeps a window open with
live sessions in it, and those sessions are real work in progress. The rules
below exist because breaking them destroys that work.

## Never touch the everyday instance

**Port 45888 belongs to the user.** Do not start a bridge on it, do not
`pkill -f bridge/server.js`, and do not `Stop-Process` ClaudeSessions.

Use your own instance instead:

```bash
npm run dev            # bridge on 45899 (or the next free port) + a window
npm run dev:headless   # bridge only; open the printed URL in a browser
```

`npm run dev` refuses to bind 45888 and picks a free port near 45899, so two
agents can each have one. The window it opens is titled `dev :45899` and carries
an amber badge, so it is never confused with the everyday one.

`pkill -f bridge/server.js` matches *every* bridge including the user's. If you
must stop your own, Ctrl-C the `npm run dev` you started, or kill it by port:

```bash
kill "$(ss -ltnp 2>/dev/null | grep :45899 | grep -oP 'pid=\K\d+' | head -1)"
```

**`CLAUDE_SESSIONS_PORT` in your environment is not a port you chose.** A session
started from the app inherits the bridge's environment, so for a long time that
variable arrived pre-set to `45888` — and `bash bridge/launch.sh` or
`node bridge/server.js` from a worktree then bound the user's port without a port
ever being mentioned. That bridge reported `dev: false`, the Windows shell adopted
it in place of its own, and the everyday window quietly served a branch's UI out
of a stale worktree. It is the most expensive way this rule has been broken.

Three things stop it now, and none of them is you remembering:

- `bridge/server.js` refuses to bind 45888 when it is running out of
  `.claude/worktrees/` — exit 4, before the socket. `npm run dev` still refuses
  the port outright.
- The bridge no longer passes `CLAUDE_SESSIONS_PORT` to the sessions or terminals
  it starts, so a fresh session inherits nothing to trip over.
- `scripts/restart-bridge.sh` refuses the everyday port from a worktree. Without
  that it would kill the user's bridge and then fail to replace it, which is worse
  than the bug. `--status` still works from anywhere.

`/api/health` reports `root` — which checkout a bridge is serving. When a window
shows something you cannot explain, check that first:

```bash
curl -s http://127.0.0.1:45888/api/health | python3 -m json.tool | grep root
```

## Work in a worktree, never the main checkout

Several agents work on this repo at once — there are usually a handful of live
worktrees under `.claude/worktrees/` — and they all reach for the same few files
in `bridge/` and `web/`. Editing `/home/dylan_hays/Other/claude-sessions`
directly means two agents silently overwriting each other, and it leaves the
user's own checkout dirty while they are running the app out of it.

**Make the worktree your first action, before the first edit.** Use
`EnterWorktree` with a short name for the work; it branches `worktree-<name>` off
HEAD and moves you there.

- **`cd` into the repo first.** `EnterWorktree` needs a git repository at the
  working directory; an agent launched in `~` reports "not in a git repository
  and no WorktreeCreate hooks are configured", which looks like a missing hook
  but is just the wrong directory.
- `baseRef` is pinned to `head` in `.claude/settings.json` because this repo has
  no remote — there is no `origin/main` to branch from.
- **Enter it before you start editing, not after.** Moving mid-session works, but
  every edit you have already made stays behind in the main checkout and has to
  be carried across by hand — which is a merge you did not need to do.
- Either way, a session that enters a worktree ends up with two transcript files.
  That is expected and handled; see *Notes that save time* for what it means.
- A dev bridge run from inside the worktree serves that worktree's `bridge/` and
  `web/`, which is what you want when verifying your own change.

Not everything is an edit. Reading transcripts, diagnosing, querying a bridge and
running `npm run dev` are fine from wherever you are. The rule is about writing
to tracked files: if you are about to change one, be in a worktree. When in
doubt, make one — it costs a second and nothing is lost by it.

## Clean up the sessions you start

Every session you start to try something out lands in the user's sidebar, because
both instances read the same `~/.claude/projects`. Groups full of `probe`,
`sandbox` and the like are what that looks like after a few agents have been
through. **Do not leave them there.** Either:

- **Mark it a test session**, which keeps it out of the everyday window entirely.
  Tick *Test session — dev only* in the Start a session dialog, or pass the field:

  ```bash
  curl -sX POST http://127.0.0.1:45899/api/sessions \
    -H 'X-Claude-Sessions-Client: 1' -H 'Content-Type: application/json' \
    -d '{"cwd":"'"$PWD"'","prompt":"…","test":true}'
  ```

  Labelled sessions collect in a **Test sessions** card at the foot of the rail on
  dev only. Prefer this: a session you forget to delete is then still invisible to
  the user.

- **Or delete it when you are done**, with the trash icon on the row, or:

  ```bash
  curl -sX DELETE http://127.0.0.1:45899/api/sessions/$ID \
    -H 'X-Claude-Sessions-Client: 1'
  ```

  This is a hard delete — the transcript and its sidecar directory. Do it to
  sessions *you* created, never to one you found.

Best is both: label it on the way in, delete it on the way out.

## Never rebuild without asking

`install.ps1` force-closes any running ClaudeSessions and replaces the
executable, which shuts the user's window. You almost never need it: **changes
to `bridge/` and `web/` need no rebuild at all** — restart your dev bridge, or
just refresh for UI-only edits. Only `app/main.js` and `package.json` are
packaged, and if one of those has to ship, say so and let the user run it.

Two agents packaging at once will also pull the executable out from under each
other, since the staging directory is wiped and rebuilt.

## What is safe

- Editing anything under `bridge/`, `web/`, `scripts/`.
- Running `npm run dev` and restarting it as often as you like.
- Reading transcripts: both instances read the same `~/.claude/projects`, so a
  session you start in dev is visible in the everyday window and vice versa.

## Notes that save time

- **Entering a worktree splits the session's transcript in two.** Claude Code
  files a transcript under the project directory for the cwd it is running in,
  and a worktree is a project directory of its own, so a session that crosses
  into one leaves a second `<id>.jsonl` under
  `~/.claude/projects/…--claude-worktrees-<name>/`. One copy holds the
  conversation and the other only bookkeeping — a title, a mode, the worktree
  state — and which gets which goes either way: both orders exist on this
  machine. `conversationRecord` in `bridge/sessions.js` is what picks the copy
  with the conversation in it. Before that the index took whichever copy was
  scanned last, so directory order decided whether a session showed its history
  or showed 0 turns and nothing at all.
- **No `node_modules`, on purpose.** `electron .` will not work here; the shell
  is packaged from a Windows-side staging directory. `npm start` finds the built
  executable instead.
- **A login shell has neither node nor `claude` on PATH** — nvm and `~/.local/bin`
  both come from `~/.bashrc`, which `bash -lc` never reads. `bridge/launch.sh`
  resolves node itself; that is why it exists.
- **Killing a bridge kills its turns.** This is measured, not assumed: `claude`
  reads stdin for input, so when the bridge exits and that pipe closes it treats
  it as end-of-input and stops, mid-turn. Running it detached with its output on
  a file descriptor does not change this. There is no way to make a turn outlive
  its bridge, which is the whole reason for the separate development port.
