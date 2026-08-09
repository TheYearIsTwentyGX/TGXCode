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

- **Work from a worktree, and `cd` here first.** `EnterWorktree` needs a git
  repository at the working directory; an agent launched in `~` reports
  "not in a git repository and no WorktreeCreate hooks are configured", which
  looks like a missing hook but is just the wrong directory. `baseRef` is pinned
  to `head` in `.claude/settings.json` because this repo has no remote.
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
