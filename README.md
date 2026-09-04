# Claude Sessions

A Windows desktop app for the Claude Code sessions running in WSL2 on this
machine. It lists every session on disk, renders each one as a conversation with
formatted code, and lets you send new messages or start new sessions — and when
a session has a dev server up, one click switches
[DevBrowser](../dev-browser) to that port's tab.

Sessions running in a terminal show up here too and stream as they go: the app
reads the same transcripts Claude Code writes, so there is no separate world.

---

## How it fits together

```
   Windows                                  WSL2 (Ubuntu)
   ┌───────────────────┐                    ┌──────────────────────────────┐
   │ ClaudeSessions    │  HTTP + SSE        │ bridge  (node, no deps)      │
   │ .exe (Electron)   │ ─────────────────► │   • indexes ~/.claude        │
   │                   │  127.0.0.1:45888   │   • tails transcripts        │
   │ a window, and     │                    │   • runs `claude`            │
   │ nothing else      │                    │   • serves web/              │
   └───────────────────┘                    └──────────┬───────────────────┘
            │                                          │
            │ starts on launch (wsl.exe)               │ spawns
            └──────────────────────────────────────────┤
                                                       ▼
   ┌───────────────────┐                    ┌──────────────────────────────┐
   │ DevBrowser        │ ◄───────────────── │ claude -p --input-format     │
   │ 127.0.0.1:45777   │  open tab :5006    │        stream-json …         │
   └───────────────────┘                    └──────────────────────────────┘
```

The split matters. All the real work happens in the **bridge**, a dependency-free
Node process inside WSL: it reads `~/.claude/projects` at native speed, spawns
`claude` with the right environment, and serves the UI. The **Electron shell** is
about 200 lines that start the bridge and point a window at it.

Two things follow from that:

- **Editing `bridge/` or `web/` needs no rebuild.** Restart the app (or press
  Ctrl+R for UI-only changes). You only rerun `install.ps1` when `app/main.js`
  or `package.json` changes.
- **The UI works in any browser.** Run `npm run bridge` in WSL and open
  <http://127.0.0.1:45888>. Handy for iterating on the frontend.

This works because WSL runs with `networkingMode=mirrored` here, so `127.0.0.1`
is the same loopback on both sides — no port proxy, no firewall rule. It is the
same trick DevBrowser's control channel uses.

## Scripts

All of these run from WSL, in this directory.

| | |
|---|---|
| `npm start` | Launch the Windows app. It starts its own bridge on 45888. |
| `npm run restart` | Restart the everyday bridge so it picks up whatever is on main. Refuses while a turn is in flight; `-- --pull` fast-forwards from origin first, `-- --status` just reports. With no terminal to ask at — under cron — it leaves uncommitted `bridge/` changes alone and exits 3 rather than reporting a restart that never happened; `-- --yes` loads them anyway. |
| `npm run dev` | A **separate** instance on 45899 plus its own window, for working on this app without disturbing the one you actually use. |
| `npm run dev:headless` | The same, bridge only — open the printed URL in a browser. The fastest loop for UI work: edit `web/`, hit refresh. |
| `npm run bridge` | The bridge in the foreground on 45888. This is the everyday instance; use `dev` instead unless you mean it. |
| `npm run land` | From a worktree: merge the PR for the branch you are on, then fast-forward the main checkout at `~/Other/claude-sessions`. Never restarts the bridge. `-- --status` reports, `-- --dry-run` rehearses. |
| `npm test` | The auth and remote-access tests. Starts a bridge on a free port, runs everything, stops it; `npm test -- 45901` runs against one you already have. It will not use 45888. |
| `npm run build` | Build and install the app (calls `install.ps1` through PowerShell). Pass options after `--`, e.g. `npm run build -- -NoInstall`. |
| `npm run icon` | Regenerate `app/icon.ico`. |

There is deliberately no `node_modules` in this repo and `electron .` will not
work here: the shell is packaged from a staging directory on the Windows side,
and a Linux Electron is not the app you want anyway. `npm start` finds the built
executable instead, and tells you what to run if it is missing. (`npm run dist`
exists only for `install.ps1` to call inside that staging directory.)

## Install

From PowerShell, in this directory:

```powershell
.\install.ps1
```

or from WSL, `npm run build`.

It checks that WSL can find the bridge, stages the Electron shell into
`%LOCALAPPDATA%\ClaudeSessions-build`, packages it, and runs the installer.
Packaging happens Windows-side on purpose: electron-builder is slow and flaky
over the `\\wsl.localhost` share.

```powershell
.\install.ps1 -NoInstall     # build the installer but don't run it
.\install.ps1 -BridgeDir '~/Other/claude-sessions' -Distro Ubuntu
```

The script bakes the bridge location into `app/config.json`. To change it later
without rebuilding, edit `config.json` next to the installed executable, or
create one in `%APPDATA%\claude-sessions\`:

```json
{ "bridgeDir": "~/Other/claude-sessions", "distro": "Ubuntu" }
```

## Using it

| | |
|---|---|
| **Left rail** | Every session on disk, grouped by project. Worktrees fold under the checkout that owns them. Sessions a schedule started fold into a **Scheduled** section inside their project's card, shut until you open it — they are the same work in the same directory, but a fortnight of nightly reviews between you and the conversation you want is what the rail exists to prevent. Each is named after the schedule and the day it ran. A green dot means the transcript changed in the last 90 seconds — something is working. |
| **Ordering** | By when *you* last wrote, not by last activity. Sorting on activity meant a busy agent kept bumping its session to the top and shuffling the rest out from under the cursor. The timestamp on each row is the one it sorts by. |
| **Pin / archive** | Hover a row for its two buttons, or use the ones beside the session title. Pinned sessions sit in their own group at the top, across projects. Archived ones collapse into a group at the bottom. |
| **Conversation** | Your turns, Claude's replies with syntax-highlighted code, and one collapsible block per tool call. A run of tool calls between one message and the next folds into a single row — *16 tool calls · Bash ×6 · Read ×7* — which opens to the rows themselves; see *Folded tool calls*. Edits render as diffs, and output too large to inline loads on demand. |
| **Plans & questions** | When Claude presents a plan or asks a multiple-choice question, the turn stops on a card at the foot of the transcript. A plan can be approved, approved with a note to bear in mind, or sent back with what to change; approving picks the mode the work continues in. Questions are answered by picking, with an *Other* row for none-of-the-above. |
| **Subagents** | The first chip row under the title, one per subagent, with a light for how it is going and a line of what it is doing. Click to switch the pane over to it; `Esc` or the breadcrumb comes back. |
| **Pull requests** | Every PR the session raised, on the line under the title, each with a glyph and a colour for where it has got to — draft, open, approved, changes requested, checks running or failing, conflicting, merged, closed. Hover for the status in words, the title, and how the checks stand. Merged and closed ones stay, dimmed, so the line is the session's whole PR history rather than only its newest. |
| **Dev servers** | The second chip row. Green means the port is answering right now; click to switch DevBrowser to that tab, starting DevBrowser if it isn't running. The button on the end shuts the server down — one click arms it, the next signals. |
| **Task board** | `Ctrl+2`, or *Tasks* in the top bar with a count of how many sessions are blocked on you. Four columns over everything outstanding: **Needs you** (a permission, a plan or a question waiting, or a turn that failed), **Working**, **Suggested** — every open task from every session, not only the conversation you have open — and **Idle**. Archived sessions are not on it; that is what archiving is for. A task card starts the work or opens it to read; a session card opens the conversation, and the button that appears on hover archives it. Idle leads with what has moved today and *Show all* pages in the rest. Nothing on it reorders while you read — see *The rail is sorted on load*. |
| **Dashboard** | The button in the top bar, with a count of how many places are unfinished. It lists, per project, every directory holding uncommitted changes and every pull request still open, with the sessions that worked there as links back into the conversation. |
| **Open folder** | The folder button by the title shows the session's working directory in Windows File Explorer, through the `\\wsl.localhost` share. |
| **Composer** | Sends to the session, resuming it in place — the same transcript a terminal would append to. |
| **LGTM** | Beside *Send*, for when you have read the work and it is done: it sends a written instruction to put the change on a pull request if it is not on one already, run the project's checks, merge once they pass, and file anything it noticed along the way as a suggested task — and to stop and say so if something blocks it. One click, no confirmation over the top; the session still asks for what its permission mode makes it ask for. |
| **Send queue** | Write while an agent is working and the message waits, listed above the composer in send order. Each one can be expanded, reordered, pulled back for editing, or dropped, right up until its turn starts. `Shift+Tab` out of the composer to work through them without the mouse. |
| **Suggested** | The panel beside the transcript. An agent that notices work outside what it was asked to do files it there, with the prompt already written. Each one folds to its title, and the ⤢ on a row opens it at full width to read; *Start* runs it, *Edit first* opens it in the Start dialog, *Dismiss* puts it away. *Hide* collapses the whole panel to a strip. |
| **Mentions** | `@` in the composer lists the other sessions running on this machine and inserts the one you pick as `@[name]` — the name an agent addresses it by. |

Shortcuts: `Enter` send (or `Ctrl+Enter`, and *Settings → Keyboard* swaps the
two), `Ctrl+1`–`Ctrl+8` the eight things the main pane can show, `Ctrl+F` find
in the conversation with `F3`/`Shift+F3` for the next and previous match,
`Ctrl+K` filter, `Ctrl+N` new session, `Esc` leave a subagent or close whatever
is on top, `Ctrl+R` reload, `Ctrl+±` zoom, `F12` devtools.

Every one of those but the last three can be remapped — see *Settings*. The last
three belong to the Electron shell rather than the page, which is why they
cannot.

In the send queue, `Shift+Tab` from the composer reaches the message you wrote
last, and from there: `↑`/`↓` pick, `Alt+↑`/`Alt+↓` move it, `Space` show it in
full, `Enter` take it back to the composer to reword, `Esc` drop it.

### Subagents are sessions too

Claude Code writes a subagent's conversation to its own file, next to the
transcript that spawned it:

```
<session-id>/subagents/agent-<id>.jsonl        the subagent's conversation
<session-id>/subagents/agent-<id>.meta.json    {agentType, description, toolUseId}
```

So a subagent gets the same treatment a session does — it is rendered by the
same code, and it streams while it runs. The chip row lists them in the order
they were spawned; clicking one switches the pane over to it and starts tailing
its file. Both panes stay mounted, so the session keeps streaming behind you and
neither loses its scroll position.

**Status comes from two places, because it has to.** Whether an agent is still
going is in the *parent* transcript — a `Task` call with no result yet is an
agent still running — and the app already has those events, so the light changes
the moment the call returns without asking the bridge anything. What the agent is
*doing* is only in the agent's own file, so the bridge tails the last 64KB of it
and reports the last thing that happened. That is the line on the chip.

The two together also catch the case neither can catch alone: a call with no
result whose file has not been touched in 90 seconds is not working, it is a
session that went away mid-call. The light stops pulsing and the chip says how
long it has been idle, rather than showing green for something that has stopped.

**A subagent finishing is not a turn you took.** Claude Code delivers that news
as a *user* message, because a conversation has no other channel — so left alone
it renders as though you had personally pasted a block of XML at yourself. It gets
its own event instead, showing the summary, what the run cost, and a way into the
transcript. The same entry is skipped when counting turns and when working out
when you last spoke, which matters more than it sounds: the rail sorts on that,
so an agent finishing would otherwise reorder your session list on its own.

These are recognised by the message *starting* with `<task-notification>` — or
with the `[SYSTEM NOTIFICATION - NOT USER INPUT]` preamble, which is addressed to
the agent when its prompt is assembled and does not reliably reach disk. Anchored
at the start rather than matched anywhere, because quoting one of these back into
a conversation is a thing people do, and a quote really is a turn you took.

Subagents don't take messages — the composer greys out while you are reading one.
A subagent that spawned its own subagents shows them inside its transcript, at
the `Task` call that spawned them, rather than flattening them into the session's
chip row where they did not happen.

### Suggested follow-ups

Agents notice things. "There's a shortcoming here, but that's outside the scope
of this PR" is a sentence every long session produces at least once, and until
now it went nowhere: the agent had already written the prompt for the session
that would fix it, and there was no way to hand that over.

So sessions this app starts get a tool they would not otherwise have —
`suggest_session`, from a small MCP server in `bridge/mcp.js` that the
runner attaches with `--mcp-config`. The agent calls it with a prompt, a reason,
and optionally a directory; the call lands in the transcript like any other tool
call; the panel beside the conversation draws it as a task you can start in one
click.

**It sits beside the transcript rather than in it.** The log is a record of what
happened; an offer is the one thing in the pane that has not happened yet, and it
is a decision waiting on you rather than an event. Inline it interrupted the
reading and scrolled away; in the aside it stays put and stays optional. Each
task folds to its title — open by default while it is still an offer, folded once
you have dealt with it — and the panel itself folds to a strip, so a session that
suggested six things is not permanently narrower than one that suggested none.
Whether the panel is open is remembered across sessions, like the terminal pane's
height; which tasks are open is not, because the useful default changes as you
deal with them.

**The ⤢ on a row opens the task at a readable width.** 300px is right for
scanning a list and wrong for reading a prompt written to brief an agent that has
none of your context — those run to paragraphs, and judging one means reading all
of it rather than the first two lines. The same three buttons are in the dialog as
on the card, because a dialog you have to close before you can act on what it told
you is a dialog that made you read twice. *Copy prompt* puts the source on the
clipboard rather than the rendered markdown.

**The server stores nothing, and that is the design.** The offer is already in the
transcript, which is the copy that survives a restart, shows up in a second
window, and can be read out of a session this bridge does not own — the same way
a pending plan already is. A second copy would only be something to drift.

What *is* the app's is what you did about it. Started or dismissed is a decision
you made rather than something the agent said, so it lives in
`~/.local/share/claude-sessions/suggestions.json` beside `flags.json`, and it is
pruned when the transcript goes. Both are undoable: dismiss is the easy one to
hit by accident, and the suggestion is still sitting in the transcript either way.

A started suggestion runs in `plan` mode regardless of the mode it was raised in.
A prompt written by one agent for another has had no human read it as an
instruction yet, and the first thing the new session should do is say what it
intends to do about it.

The directory is only named on a task that would run somewhere other than where
the conversation is happening. Almost none do, and repeating the same path down
the panel is noise saying nothing — but one pointed at a different checkout is
worth knowing about before you start it.

**A task no longer needs its conversation open to be found.** The rescan that
already reads every transcript collects the offers as it goes — `scanMeta` puts
them on `meta.suggestions`, cached with the rest of the index — and
`GET /api/suggestions` answers with every one of them across every session, each
carrying the decision joined on from `suggestions.json`. The aside beside a
transcript reads that same route scoped to one session rather than lifting the
cards out of the event stream, so there is one answer about a task rather than
two that can disagree.

**They still die with their transcript.** The index is derived and nothing else:
delete a session and its tasks go with it, decisions included. Keeping one alive
past its session would mean copying the title, the reason and the prompt into
state this app owns, and content coming from anywhere but Claude Code's
transcripts is the line held everywhere else here. Being findable without the
conversation being *open* was the actual complaint; outliving the conversation
*existing* was not.

The tool is on `--allowedTools`, so filing one never raises an approval card —
a permission prompt for "may I suggest this?" is noise. Only sessions the bridge
starts have it; a session you started in a terminal will not.

### Sessions can talk to each other

Claude Code gives every running session a name and an inbox of its own, and an
agent reaches another with `SendMessage({to: "<name>"})`. That is all its own
work — the socket, the delivery, the loop guards. **This app dials no socket**, and
for this feature it builds no transport either: what it does is make the
conversation visible, which it was not. (It does build one transport of its own, for
the case `SendMessage` cannot cover at all — a session that is not running. That is
the next section, and it goes nowhere near this socket.)

- **`@` in the composer** lists the sessions that are actually running, from
  Claude Code's own process registry, and inserts the one you pick as
  `@[name]`. The name is the whole address — there is no separate addressing
  syntax — so getting the exact one into the message is the entire job. Rows
  show the title you know the session by and the name that gets inserted, since
  those are often not the same thing.
- **The brackets are ours, not the CLI's.** Nothing parses them; the agent reads
  them as prose. They exist so a session mention cannot be mistaken for
  `@path/to/file`, which the CLI *does* resolve on its own — which is what keeps
  the file half of that menu free for later.
- **A message that arrives now renders.** It used to render as nothing at all:
  Claude Code delivers one as a user message flagged `isMeta`, and
  `bridge/transcript.js` skipped those wholesale, so a session that had been
  messaged showed an empty gap where the message was. It is now recognised by its
  `<cross-session-message>` wrapper and drawn as what it is, with the sender
  named and a way into their session.
- **It is still not a turn you took.** Peer messages stay out of the turn count
  and out of `lastUserTs`, which the rail sorts on — otherwise two agents
  talking would quietly reorder your session list.
- **The notification is filed by the bridge**, not the page, because a message
  can land in a session with no window open on it and no process of ours anywhere
  near it. That is noticed in the transcript during the index rescan, which is
  the only place that knows.

One thing to know if messages seem to vanish: Claude Code has a
`crossSessionInbound` setting — `accept`, `hold`, or `refuse`. On `hold` an
inbound message waits for an interactive approval that a headless session has
nobody to give, so it never arrives. That is the CLI's setting in your own
`~/.claude/settings.json`, and not something this app writes.

### And they can hand each other work

The paragraph above is still true of `SendMessage`, and it stops at a wall: **the
address only exists while the session does.** A name comes from
`~/.claude/sessions/<pid>.json`, so a session that finished an hour ago cannot be
reached at all — and since only four runners stay live and one is evicted after
fifteen idle minutes, that is the ordinary state of a session rather than an edge
case. The agent that just changed an API had no way to tell the session that owns
the mobile client, because that session stopped when its turn ended.

So there is one transport here after all, and it is worth being precise about what
it is. It is not the peer socket — that is still Claude Code's, still versioned,
still not dialled from here (see ROADMAP §Deliberately not doing). It is
`POST /api/sessions/:id/handoff`, over the path this app already owned: **the
bridge could always wake an idle session and did not know it.** `pool.ensure`
spawns `claude --resume` when there is no process, which is what the composer has
been doing every time you typed into a session that had stopped. A handoff is that
same wake, addressed by session id rather than by a name that has expired, and
reachable by an agent.

- **`message_session` and `list_sessions`** join `suggest_session` in
  `bridge/mcp.js`. The list is the counterpart to the `@` menu above and answers
  the opposite question: not "who can receive a message right now" but "who could
  be *given* work", which is nearly everybody.
- **The woken session resumes in plan mode.** It reads the message, checks the
  claim against the files it names, and comes back with a plan — so it lands in
  *needs you* on the board, with something to approve, rather than having edited a
  checkout nobody was watching. You are handed a decision, not a fait accompli.
- **A session in plan mode cannot hand off**, and that turns out to be the right
  shape rather than a limitation. Plan mode routes every tool that is not plainly
  read-only through an approval card whatever is on `--allowedTools` — measured,
  not assumed. So the sender this feature exists for still works, because an agent
  that has just *changed* something was never in plan mode; and the session woken
  *by* a handoff cannot pass the work on to a third one, which is the containment
  the wrapper asks for in prose, enforced.
- **The sender is told to stop there.** The tool's own reply says so, the wrapper
  around the message says so, and the bridge enforces it: one handoff per pair per
  minute, twenty an hour. Two agents that each think the other should know
  something will otherwise wake each other for as long as the machine allows, and
  every round costs a process and a turn. See `bridge/handoff.js`.
- **It renders as work arriving, not as something you typed.** Its own wrapper and
  its own card, deliberately not Claude Code's — reusing `<cross-session-message>`
  would have drawn a card for free and never fired a notification, because the
  count behind that is gated on a field only the CLI writes. Half-working silently
  is worse than a parallel path.
- **And it is not a turn you took either**, for the same reason peer messages are
  not — but it takes real code to hold that line here. A peer message gets it free
  from the `isMeta` flag the CLI sets; a handoff arrives down stdin as an ordinary
  user message, so without an explicit gate in `scanMeta` one agent handing work to
  another would quietly reorder your rail. `test/handoff.test.js` is mostly about
  that one fact.
- **A handoff that did not land is not reported as delivered.** This is the one
  place the bridge waits on a spawn. When `claude --resume` is refused — a session
  id still locked by a process that was killed — the composer's answer is to hand
  your text back for another go; a handoff has nobody to hand it back to, and the
  sender is a sentence away from telling you it passed the work on. So the route
  watches for a few seconds and the tool reports the truth.
- **Local callers only.** A phone may still send to a session by hand, one message
  at a time; what it may not do is hand a token to something that wakes every
  session on the machine.

### The send queue holds messages back on purpose

A turn takes minutes, and the next thing you want to say arrives long before it
ends. The CLI would accept several messages down its stdin at once — but the
moment one is written it is gone: it cannot be reordered, taken back, or even
looked at. That is why nothing was ever shown for it.

So the bridge keeps them instead. One message is in flight at a time; the rest sit
in `Runner.queue` until the turn that was holding them up lands, and only then is
the next one handed over. What you get for that is a queue you can actually work
with — expand a message, drag it earlier, pull it back into the box to reword, or
drop it — because until it is written, it is still yours.

The line the app will not cross is pretending. Once a message has gone to the
process it leaves the list, because it is on its way to the transcript and no
button here can recall it. Everything that stays visible is genuinely still
cancellable:

- **Reordering** is committed to the bridge on drop, and a message that flushed
  mid-drag keeps its place rather than dragging the rest of the queue with it.
- **Stop** drops the queue whichever way it ends the turn, soft interrupt or hard
  kill, since stopping means stopping — but the messages were never sent anywhere,
  so they come back to the composer instead of vanishing.
- **A process that dies** hands back everything it was holding, the turn it died
  on and the queue behind it, in the order you wrote them.
- **A model or permission change** replaces the process; the queue moves across,
  because those messages belong to you, not to the process.

Rows in the rail carry a `+N queued` badge, so a session you queued work for and
walked away from says so from the outside.

**One chip is one tab stop.** The obvious markup — a text button plus *Edit* plus
*×* on every row — puts `Shift+Tab` out of the composer on the drop button of the
last message, which is both surprising and the one control there you would least
like to hit blind. So the row itself is the focusable thing, its buttons are out
of the tab order, and everything they do has a key on the row: `Enter` to reword,
`Esc` to drop, `Space` to read it in full. The two you want mid-turn — *I said
that wrong* and *never mind* — are the unmodified keys. Dropping from the keyboard
moves the focus to the row that took the dropped one's place, or to the composer
if that was the last one, because focus falling to the body would leave the next
`Esc` closing something else entirely.

### The rail is sorted on load, and then left alone

The bridge returns sessions ordered by when *you* last wrote in them, and it
recomputes that whenever anything changes. The rail takes that order once, at
load, and then holds it: a session taking a message does not climb past its
neighbours, and it does not drag its project card to the top of the rail either.
Rows staying where you last saw them matters more than the list being perfectly
ordered at every instant — the alternative moves things out from under the
cursor while you are reading them. Reload to re-sort.

A session that appears *after* that first load is genuinely new rather than
merely busy, so it goes to the top of its group, and a project with no sessions
in it yet gets a new card at the top of the rail. Neither disturbs the position
of anything already placed.

**The task board holds the same rule, per column.** It has the stronger version of
the same problem: a board with every session on it, redrawn every three seconds
while agents work, would be a page of cards swapping places under the cursor. So
position within a column is taken once and then held, and the one thing that can
move a card is *changing column* — which is the news the board exists to carry,
not noise. When it does, it lands at the top of its new column, so a session that
has just become blocked on you is the first thing in *Needs you* and nothing
already placed shifts to make room. A card that goes idle and comes back does not
get a fresh place: it returns to the rank it had, because appearing at the top of
*Working* reads as a new session, and it is not.

### Archiving never deletes — deleting does

Archiving moves a session out of the way and nothing else. The transcript is
untouched, the session still opens and still answers, and a filter that matches
an archived session expands the group so the result is not silently hidden.
Pinning and archiving are mutually exclusive — asking for a session to sit at the
top *and* be tucked away is a contradiction, so each clears the other.

The trash icon, on a row or in the conversation header, is the one control that
does destroy something. It asks first, in a dialog that names the session and its
turn count, because the thing worth checking is *which* conversation. Confirming
removes the transcript and the sidecar directory beside it — the session's
subagent transcripts and any spilled tool output — and nothing else. A session
with a turn in flight is refused rather than deleted out from under the turn;
stop it first.

These flags are the only state this app owns *about a conversation*; everything
else it shows is derived from Claude Code's own files, which it never writes to.
They live in `~/.local/share/claude-sessions/flags.json`, and flags for
transcripts that no longer exist are pruned automatically. Settings — how you
want the app itself to behave — are a separate file you are meant to open; see
*Folded tool calls*.

### Folded tool calls

Between one message and the next an agent may make thirty tool calls, and a
transcript that prints all of them is a wall of `Read`/`Bash`/`Edit` to scroll
past on the way to the sentences that say what happened. So once a message
closes a run of them, the run folds into one row — the same row a tool call
draws, reading *16 tool calls* with a tally of what they were and how long they
took. Open it and the rows are there, unchanged, each still opening to its own
output.

Only once the run is **closed**. While the calls are still arriving they are the
work you are watching, so they stay where they are and fold the moment the agent
speaks again.

Three settings control it, from `~/.tgxcode/settings.json` — written out with the
defaults the first time the bridge runs, so it is there to edit:

```json
{
  "version": 1,
  "transcript": {
    "groupToolCalls": true,
    "groupMinCalls": 3,
    "groupIncludesThinking": true
  }
}
```

`groupMinCalls` is how long a run has to be before folding it is worth it — one
or two rows collapsed into a summary loses more than it saves.
`groupIncludesThinking` decides whether a thinking block is part of the work
stretch or the end of it; folding it in keeps runs long, and breaking on it
fragments a turn that thinks between every call.

A project can override any of these in `<checkout>/.tgxcode/settings.json`, the
same directory it declares its commands in and with the same precedence — see
`docs/api.md` under `GET /api/prefs`. A value that is not what the key allows is
ignored and the default stands, rather than being taken at face value.

There is a settings page — **Settings** in the bar, or `Ctrl+8` — and the file is
still the interface. The page names the exact file it is about to write, saves
one key at a time, and says for each control whether this scope set the value or
inherited it, and which file has taken it over when a stronger one has. See
*Settings* below.

### Cutting the live board down

The same file has a `live` block, for the board behind **Live** (`Ctrl+3`) — two
keys, both off by default:

```json
{
  "version": 1,
  "live": {
    "compact": false,
    "hideElsewhere": false
  }
}
```

`compact` stops every card at its tool-count line. Everything under that line
goes — the few lines of history, the message box, the Open and Stop buttons, and
the Allow/Deny row of a session waiting on permission. What is left is the title,
what it is doing, the task bar and the counts, which is a card you read rather
than one you act on. That is the trade: a screenful of sessions at a glance,
against having to open one to answer it. Clicking anywhere on a card still opens
it, so nothing is unreachable — only a click further away.

`hideElsewhere` leaves out sessions running under something that is not this
bridge: a terminal, VS Code, a background agent, another Claude Sessions window.
They are the cards this window cannot do anything with — it will not send into
them, because two processes appending to one transcript is how a transcript gets
corrupted — so if what you want from the board is only what you can drive from
here, this is the switch. The subtitle still counts what it left out; the board
never quietly shrinks.

Both are read from **your** file rather than a project's, even though a project
may set them. The board is the one view that is not about a single session — it
draws cards from every project on the machine at once, so letting whichever
conversation happens to be open decide how the rest are drawn is a setting that
appears to change on its own.

An existing `~/.tgxcode/settings.json` will not have grown the block: the
defaults are only written out when there is no file at all. Add it by hand, or
tick the two boxes under *Settings → Live board*, which writes them for you and
repaints the board without a reload. A file edited by hand still needs one.

### What a turn in progress calls itself

While a turn runs, every surface that shows it working — the status line, the
rail, the boards, the Android app — says the same thing, because they all read
one label off one SSE message. For most of this app's life that label was
`Thinking…`, replaced by a tool's name while a tool ran. Now it has two halves:

```
Percolating…
Percolating… Reading runner.js
Percolating… Running: npm test
```

The **verb** comes from whichever themed groups you have enabled and drifts on
its own clock — it is what says the session is alive. What follows it is
whatever is specifically happening, and it changes when reality does. Neither
half has to give way to the other, which is what lets the verb keep moving
through a call of any length while that call keeps its name.

The collection is [wynandw87/claude-code-spinner-verbs][verbs] — 3,639 verbs
across 114 groups, the 185 Claude Code itself ships among them.
`scripts/import-spinner-verbs.js` turns its README into
`bridge/spinner-verbs.json`, which is written out on first run as one file per
group:

```
~/.tgxcode/verbs/
  Claude_Code_Defaults.json
  Monty_Python.json
  Tech_Programming.json
  …114 files
```

```json
{
  "Category": "Tech / Programming",
  "Verbs": ["Dockerizing", "Kubernetizing", "Terraforming"]
}
```

**The `Category` is the name, and the filename is an index into it.** They are
written down twice because a category may contain characters a filename may not
— `Tech / Programming` is why `Tech_Programming.json` exists — and because a
group that says what it is survives being renamed or handed to somebody else.
Settings refer to the `Category`, forgivingly: `"Tech / Programming"`,
`"Tech_Programming"` and `"tech-programming"` all find it.

So **adding a group is dropping a file in**, and **removing a verb is deleting a
line**. A group you delete stays deleted: the directory is only ever seeded when
it is missing altogether, never file by file, because the alternative is your
edits undoing themselves on the next run. A project can ship its own groups in
`<checkout>/.tgxcode/verbs/`, and they win over the ones in your home directory.

Which groups are *in play* is a setting, in the same file as the rest:

```json
{
  "spinner": {
    "randomize": true,
    "groups": ["Claude Code Defaults", "Monty Python", "Absurd / Nonsense", "Tech / Programming"],
    "rerollMs": 8000
  }
}
```

Only the groups named there are ever opened, so the size of the directory costs
nothing. `randomize: false` gives back `Thinking…` and nothing else changes.

`rerollMs` is how long a verb stands before the next is drawn, and it is the
only thing that moves it — the half after it changes on its own as the work
does. `0` pins one verb for the whole turn.

A verb is only worn by work. A question waiting on you, an API retry, starting
up and going idle say what they are and nothing else.

`GET /api/spinner/groups?cwd=` lists what you have, with a count each and the
reason any group failed to load. It was built as the discoverable half of a
setting with no page in front of it; now it is what the Settings panel draws its
checkboxes from, and hovering one lists the verbs inside it.

Two things worth knowing. The session rail has room for about twenty characters,
which is not enough for both halves, so it shows the one that carries
information: the tool's name while a tool runs, and the verb whenever nothing
more specific is happening. Every wider surface draws the whole label. And
twenty-three of the groups are full sentences rather than words, which truncate
in the rail for the same reason — the groups enabled by default are all short.

[verbs]: https://github.com/wynandw87/claude-code-spinner-verbs

### Settings

**Settings** in the bar, or `Ctrl+8`. Every key in `~/.tgxcode/settings.json`
with a control in front of it — the reading settings above, the live board, the
spinner, the quota beacon, and the keyboard — plus two groups that are not in
that file: **Notifications**, which is per-browser, and **Connect a phone**,
which is a task rather than a setting. Both used to be buttons in the top bar.

The file stayed the only interface for a long time and that was defensible while
there were three keys in it. At twelve, across five blocks, with a precedence
chain of four files and validators that silently drop what they do not like,
"go and read `bridge/prefs.js`" had become the answer to too many questions —
and the one thing the file cannot tell you is which of the four files a value
came from.

So the panel answers both questions at once. A **scope** selector picks which
file you are editing — *User*, *Project — shared* (checked in, for everyone who
clones the repo) or *Project — local* (gitignored, yours) — beside a **project**
selector that does not depend on what the rail happens to be showing. Under
them it names the exact path it is about to write. Each control says whether
this scope set the value or inherited it, offers *Clear* to remove a key so it
falls back rather than pinning a default, and names the file that has taken over
when a stronger one has.

Nothing here is a draft: every control saves on change, one key at a time. A
settings page with a Save button has a state where what you see and what is in
force disagree, and the failure mode of that is a preference you believe you
set. It also means two windows editing different settings do not clobber each
other, and a save reaches the other window over the live channel rather than
waiting for a reload.

**Two sections are yours alone** — the quota beacon and the keyboard — and a
project file that sets one is ignored and says so. What directory this app
starts `claude` in is not a repository's business, and a repository that could
rebind your keys could make the window unusable with hand-editing a file as the
only way back.

#### Keys

The *Keyboard* group holds two settings that each swap a pair of keys, and then
the shortcut table.

**Contextual Ctrl+C in the terminal.** Off by default. On, `Ctrl+C` copies the
selection and clears it when the terminal has one, and interrupts as always when
it does not — so a second `Ctrl+C` still interrupts, which is the whole reason
it clears. Plain `Ctrl+V` then pastes, instead of `Ctrl+Shift+V`. Only while the
terminal has the focus; `Ctrl+Shift+C` and `Ctrl+Shift+V` keep working either
way. Off by default because the alternative is changing what `Ctrl+C` does to
somebody who did not ask: a selection left in the scrollback would turn an
interrupt into a copy, and the process you were trying to stop keeps running.

**Composer send.** `Enter` sends and `Shift+Enter` is a newline, which is what
this app has always done — or the reverse, for when a message is three
paragraphs and `Enter` sending it halfway through is a real cost.
`Ctrl+Enter` sends under both.

**The shortcut table** covers the eight views, the two rail shortcuts and the
three find shortcuts. *Change* listens for a chord and swallows it, so binding
`Ctrl+4` does not open the dashboard on the way past; *Unbind* leaves a command
with no shortcut, which is a thing you can ask for and is not the same as
resetting it; *Reset* puts it back to the default by removing the override
rather than by writing the default down, so a default that changes later is not
pinned to today's.

A chord has to carry `Ctrl` or `Alt`, or be a function key. These fire while the
composer has the focus, and the composer is a text box — bind a bare letter and
that letter stops being typeable, with hand-editing the settings file as the
only way back. A chord another command already holds is refused with the name of
that command rather than saved into a conflict.

Bindings name **physical** keys: `Ctrl+Shift+3` is the 3 key, whatever your
layout puts there, because `Shift+3` arrives as `#` on a US keyboard and `£` on
a UK one and a binding written against the character works on one and silently
fails on the next. `Ctrl` and `Cmd` are one modifier.

What the table does *not* cover: arrow keys in a menu, `Enter` in a text field,
`Escape`, the `Y`/`A`/`N` letters on a card that already has the focus. Those
are widget semantics rather than shortcuts, and remapping them means breaking
keyboard navigation. Nor the Electron shell's `Ctrl+R`, `F12` and zoom, which
live in the packaged executable rather than the page.

#### The two groups that are not settings-file settings

The last two groups came out of the top bar, which had collected a button each
for them.

**Notifications** is the bell's old popover, and is per-browser — see
*Notifications* above for what it decides and why it is not shared.

**Connect a phone** was a dialog. It builds the pairing link: a host, because
this page is served on 127.0.0.1 and that is the one address useless to a phone,
and the link itself with a Copy beside it. The note under the host says what is
still missing for *that* address rather than how tunnelling works in general —
reaching a `.ts.net` name does nothing until `tailscale serve` points at this
port, and that is the step people forget. See *Reaching it from a phone*.

Both are written into `web/index.html` rather than built from the settings
table, because their controls are wired once at load; the panel moves them into
place so they still take their turn in the order the table lists.

### Test sessions

A session can be marked **test**, which means only a development bridge lists it;
the everyday window on 45888 never shows it. Both instances read the same
transcripts, so this label is the only thing keeping an agent's scratch work out
of a list of real conversations.

The **Test session — dev only** checkbox in the Start a session dialog appears
only on a dev bridge. Over the API it is a field on create, or a flag afterwards:

```bash
TOKEN=$(cat ~/.local/share/claude-sessions/token)

curl -sX POST http://127.0.0.1:45899/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Claude-Sessions-Client: 1' -H 'Content-Type: application/json' \
  -d '{"cwd":"/home/you/project","prompt":"…","test":true}'

curl -sX POST http://127.0.0.1:45899/api/sessions/$ID/flags \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Claude-Sessions-Client: 1' -H 'Content-Type: application/json' \
  -d '{"test":true}'
```

Labelled sessions gather in a **Test sessions** card at the foot of the rail, so
the ones left behind are easy to find and delete. Delete them; the label is a way
to keep them out of sight until you do, not a substitute for cleaning up.

### The icon

`app/icon.ico` is generated by `npm run icon` — signed distance fields for the
shapes, a hand-rolled PNG encoder, and a PNG-in-ICO container, so the project
keeps its zero dependencies. Below 32px the caret inside the bubble is dropped;
at that size it is mud, and the silhouette is what identifies the app anyway. The
`.ico` is committed, so a normal build never regenerates it.

### Permissions

When Claude wants to run something the mode does not already cover, the turn
stops and a card appears at the foot of the transcript with the tool name and its
input rendered the way the tool block will render once it has run:

```
┌ Bash — permission needed ───────────────── 1:42 left ┐
│  rm -rf dist                                          │
│  [ Allow ]  [ Allow Bash all session ]  [ Deny ]      │
└───────────────────────────────────────────────────────┘
```

`Y`, `A` and `N` answer it from the keyboard; the card takes focus on arrival if
the window is focused. **Allow … all session** means this tool for this session
only — a permanent allowlist belongs in Claude Code's own settings, not here.

So the mode under the composer now decides how *often* you are asked, not what is
possible:

- **auto** (default) — Claude judges each call, which is the mode these sessions
  normally run in interactively.
- **acceptEdits** — file edits go through, most other tools ask.
- **manual** — asks about everything.
- **plan** — nothing is changed at all; the turn ends with a plan to read.
- **bypassPermissions** — everything runs, unasked. Convenient and unguarded;
  pick it deliberately.

Changing the mode takes effect on the next message.

The control belongs to the session in front of you, not to the window: opening a
conversation puts it on the mode that session is running in, or — for one with no
process of its own — the mode its transcript was last seen in, read back from
disk. A mode you pick and do not send is remembered against that session for as
long as the window is open, so looking away and back does not quietly drop it —
until the mode moves underneath it, as approving a plan does, which is a decision
about the same thing and a newer one.

**Start a session** starts in **plan** instead, because the first message of a
session is the one written with the least idea of what it will touch. Switch the
composer to another mode once you have read the plan back.

One thing to know about the edges: a card on screen **waits as long as you do**.
There is no countdown and nothing is ever answered on your behalf for having
taken too long — an approval that expires while you are reading it is worse than
a turn that stays blocked. If no window is open at all the ask is denied
immediately, which is what the app did before any of this existed, and two of
those in a row stop the turn rather than let it spin.

Approvals ride a control channel on the same stream that carries the session, and
that channel is not a documented, stable surface. If the installed `claude` turns
out not to support it, the app says so once and falls back to permission modes
alone; sending never breaks over a protocol difference.

### Plans and questions

Two of the things that come down that same channel are not permissions at all —
they are Claude talking to you — and each gets a card of its own.

**A plan** arrives when a session in plan mode is ready to start. The plan is
rendered as the document it is, and approving it decides two things at once:

```
┌ Plan — ready to start ────────────────── 14:53 left ┐
│  ## Add a --version flag                            │
│  • Read the version from package.json…              │
│  • Handle the flag before subcommand dispatch…      │
│                                                     │
│  [ Approve ]  [ Approve — auto-accept edits ]       │
│  [ Approve with feedback ]  [ Keep planning ]       │
└─────────────────────────────────────────────────────┘
```

The second thing is the mode. A session sitting on this card is *in* plan mode,
where the work it is asking to do would be refused — so approving switches the
mode as it starts and the selector under the composer follows. Approving without
that would agree to a plan and then block every edit in it.

Plain **Approve** (`Y`) continues in **auto**, the mode these sessions run in
when you are sitting in front of one: Claude judges each call and asks when one
warrants it. `A` blanket-accepts edits instead, which is the deliberate second
choice rather than the default.

Two of the four buttons are a sentence rather than a verdict, and they reach the
model by different routes because the protocol gives them different routes:

- **Keep planning** (`N`) is feedback, not a refusal. What you write goes back as
  the tool's error, which is where the model reads a refusal — so "too broad, do
  the parser first" produces a different plan rather than the same one again.
  Sent back empty it just says to keep going.
- **Approve with feedback** (`F`) is "yes, and…". The note is appended to the
  plan itself, and Claude Code echoes it back to the model under *Approved Plan
  (edited by user)* — so a condition you attach to a yes becomes part of what was
  agreed to, which is where it belongs. An allow carries no message of its own;
  that was measured, not assumed.

**A question** is Claude's multiple-choice ask, rendered as a form: radios for one
answer, checkboxes where several are allowed, an **Other** row on every question
for when none of them fit, and each option's preview shown as you hover or pick
it. Send stays disabled until every question has an answer — Claude asked them
all, and leaving some to guesswork is what this card exists to avoid. **Skip**
answers nothing and lets it carry on unaided.

Neither card expires — a plan is something you read, and being made to re-read it
because a countdown ran out while you were thinking is its own kind of rude. They
once waited fifteen minutes; now they wait.

Before this, both were denied outright — they arrive flagged as needing an
interactive prompt, which for any other tool means "a dialog this app cannot
draw". For these two it is exactly the dialog it can draw.

### Notifications

*Settings* → **Notifications** decides what reaches you about a session you are
not watching — a desktop notification, a short chime, or both. Clicking one
opens that session.

These two switches are the one part of the settings page that is **per-browser**,
kept in its own storage rather than in `~/.tgxcode/settings.json`: whether a
notification can fire at all is something each browser decides, so a permission
granted in one says nothing about another, and a shared preference would show
ticked on one surface while being silently overruled on the next.

There was a bell in the top bar, which was a switch and a status light at once.
The switch moved here with every other switch. What went with the bell is the
at-a-glance reading of whether anything would fire — so if the app has gone
quiet, this is now the place that says why.

Two different things get announced, and they are not held to the same standard.

**Something waiting on you always speaks up** — a plan, a question, or a
permission. The turn is stopped until it is answered, so there is nothing to be
gained by holding back and no duration to wait for.

**A turn finishing** is rationed, because a notification that fires too often
gets switched off and takes the one that mattered with it. It only speaks up if
it **failed** — the one ending you cannot discover by waiting — or if it ran for
**over 30 seconds**. Never for the session already open in a focused window, in
either case: you can see it.

At most one chime per session per ten seconds, so a draining queue is one sound
rather than five. A send that never became a turn always says so.

A permission or a plan carries **Allow** and **Deny** buttons on the toast
itself, answerable without switching to the app. Chromium allows exactly two
(`Notification.maxActions`), which is why **Allow all session** is not among
them — it is the rarest of the three and the one most worth reading the card
before choosing. A question gets no buttons at all: its answer is a choice among
options that will not fit on a toast. Clicking the body always opens the card,
where every answer lives.

Those buttons are the only reason `web/sw.js` exists. Actions are not available
on a plain notification — only on the persistent kind, shown through a service
worker registration. It holds no cache and installs no `fetch` handler, so it
never serves a request and cannot serve a stale one; editing `web/` and
refreshing behaves exactly as it did before. What it buys is that a button press
is handled in the worker rather than the page, so answering does not depend on
the window being open, focused, or still on that session.

The three sounds mean three different things, since the point of a sound is to
be understood without looking: two notes up for a turn that finished, one flat
low note for one that failed, and two notes on the same pitch — a knock — for
something waiting on you.

The thirty seconds is wall clock, timed from the moment the bridge marked the
runner busy rather than read off the turn's result. The two normally agree to
within milliseconds, but the result's duration falls back to the CLI's *API*
time when the wall-clock field is missing, and a threshold should not rest on a
number that can quietly change meaning.

Two limits worth knowing. **The page is what listens**, not the Windows shell, so
a window that is closed hears nothing — the tray and a shell-side subscriber are
in `docs/plans/02-notifications-and-shell.md`. And Windows **Focus Assist** drops
notifications without a word; **Try it**, in that group, is there so you can
tell that apart from the app being wrong.

In a browser, the first tick of *Show a desktop notification* is what asks
permission — the click is the gesture browsers require, and a prompt nobody
invited is the one people press Block on. The packaged app grants it already.

### How dev servers are found

A long session mentions dozens of ports, most of them history. The bridge scans
Bash traffic and ranks candidates by whether the port is **answering right now**,
whether the agent's last action was to start or kill it, and whether the name
DevBrowser has for it matches the session's worktree. That last signal is the
strongest — it is why naming ports pays off:

```bash
devbrowser title 5006 "add-company-flow"
```

Live ports are always offered; a couple of recently-dead ones are shown greyed
out so a server that has gone away is visible rather than silently missing.

### Stopping one

The chip's end button ends the server. Two clicks, because the chips are
identical in size and sit shoulder to shoulder — the first arms it and the chip
says `Stop?` where it said `Open`, the second signals. Moving off the chip, or
waiting four seconds, calls it off.

What gets signalled comes from the socket, not the transcript: `ss` says which
pids hold the port, they get a `SIGTERM`, and only if the port is still answering
2.5s later a `SIGKILL`. Signals go to those pids alone and never to their process
group, because a server started in the foreground of a Bash call shares a group
with the shell `claude` is waiting on.

Two things are never stopped this way, however they got hold of a port: another
**Claude Sessions bridge** — killing one takes its turns with it, since `claude`
reads the closed stdin as end-of-input — and a **`claude`** process, which *is* a
turn. Both are named and left alone. A port with no Linux process behind it says
so too: with WSL mirrored networking a Windows-side server answers on 127.0.0.1
but has no pid on this side, and the chip reports that rather than guessing.

### What the dashboard counts

A finished conversation is not finished work. The rail is full of sessions that
have been quiet for days and are still holding a worktree with eleven modified
files in it, or a pull request nobody merged. That is what this screen is for,
and it reads none of it from the transcripts:

- **Uncommitted changes** come from `git status --porcelain=v2` in the
  directories sessions were working in. A **directory** is the row, not a
  session, because a worktree is what holds uncommitted work — several sessions
  share one, and a session that has left a worktree still left its changes in it.
- **Open pull requests** come from one `gh pr list --state open` per repository.
  Being absent from that list *is* the answer to "has it been merged": a PR the
  transcripts mention that is not open any more needs nothing from you. This board
  stops there. A conversation header wants the opposite — it keeps a merged PR on
  screen as the record that the work landed — so it asks after that one PR by
  number, once, and remembers the answer for good: merged and closed are the two
  states nothing can move a PR out of. Both go through `bridge/pulls.js`, and both
  read the same snapshot, so the extra question costs one call per settled PR ever
  — it is written to disk, so a restart does not buy it again.

Nothing on this board, or in the rail, or in a conversation header, calls `gh` on
the path of a request. A refresher in the bridge does that on a timer and pushes a
`prs-changed` event when the answer moves; `bridge/pr-store.js` decides which
repositories are worth asking about and holds the last answer. It replaced three
sixty-second client polls that between them re-listed every repository every minute
forever, awake or idle. The trade is written down in that file's header: a PR can be
twenty minutes stale on a repository nobody is working in, and anything a
conversation on this machine can see is picked up within a minute.

A workspace shows the PRs raised from the branch it has checked out, and only
those — a session that raises a PR from a worktree and then leaves reports the
*project* as its directory, and hanging the PR there would file it under a
branch it has nothing to do with. PRs still open with nothing on disk answering
for them get a row of their own, marked *no working directory left*.

Two things stop this reporting nonsense. A worktree that was removed leaves its
directory behind whenever anything untracked was in it, and because those
directories live *inside* the project, git answers about the parent repository
instead — so each directory must be its own checkout root (`rev-parse
--show-toplevel`) or it is skipped. And everything here shells out, so all of it
is cached: working trees for 15 seconds, GitHub for a minute.

### What this session changed

The drawer behind the header's document icon answers "what did this agent
actually change", which otherwise meant scrolling a transcript looking for `Edit`
blocks. It holds two lists, and **they are meant to disagree**:

- **Changed by this session** is derived from the transcript, so it is about the
  conversation. It keeps files that were edited and have since been committed, and
  files edited in a directory that has since been removed, and it is right about a
  session that ran in a terminal months ago. The line counts are the ones the diffs
  in the conversation show — the patch Claude Code recorded with the call — not a
  re-diff of a file that has moved on. Clicking a file jumps to the first edit that
  touched it, which makes a long transcript navigable by file rather than by time.
- **Working tree** is `git status` in the session's directory, so it is about the
  directory. It holds whatever anybody else changed, and it drops what this
  session changed and then reverted.

A session that delegates its work to `Task` subagents has no `Edit` calls of its
own — those are in the agents' own transcripts — so those are folded in and marked
*agent*; clicking one opens that agent's pane, since there is no call in this
conversation to jump to. What no list can hold is a `Bash` running `sed -i`:
nothing in the transcript says which file it touched, which is one more reason the
tree is shown beside the transcript's answer rather than instead of it.

It refetches when a turn ends rather than on a timer — between turns nothing
changes — and `git status` is cached for 15 seconds, shared with the board below.

### The session's own task list

Its sibling panel, on the other side of the transcript: the checklist the agent
keeps for *itself*, with what it has finished. Where the drawer above is a record
of what happened, this is the part that has not happened yet, which is why it sits
on the left and is **on by default**. Clicking an item jumps to the call that last
touched it, and an item's description — where it has one — is in its tooltip.

Two formats feed it, and they are not equally rich. Newer builds keep a directory
at `~/.claude/tasks/<session-id>/`, one small JSON file per task, with ids,
descriptions and dependencies; others write a `TodoWrite` call into the transcript
holding the whole list, with none of those three. `bridge/tasks.js` reads the
first and falls back to the second, normalises both to one item shape, and never
writes either — the same rule as everything else under `~/.claude`.

It arrives on the same follow the transcript does, pushed when the list actually
moves, because a task list moves *during* a turn and watching step 3 of 7 become
step 4 is the whole point. Nothing polls it.

### The columns slide, and hold their place

All three columns beside the transcript — this one, **Suggested** and **Changed**
— are the same width, and none of them jumps. A column arriving or leaving slides,
and the transcript and the composer slide with it rather than being shoved across
in a single frame.

The part that matters more is what *doesn't* move. Going from one conversation to
another used to tear both asides down and rebuild them, so two conversations that
both kept a task list still made the whole pane jump out and back — four times
over, once the turn rail was counted. A column now holds its place while the new
conversation's answer is on the wire, showing an empty box rather than the last
conversation's contents, and only leaves if the new conversation turns out not to
need it. Switching between two conversations with the same columns open moves
nothing at all.

Under `prefers-reduced-motion` none of it animates: the slide duration is read
from the stylesheet, so it reports zero and the columns appear and disappear the
way they used to.

**Claude Code stopped offering the task tools by default.** Opus 4.8, Sonnet 5 and
newer models are not given `TaskCreate`/`TaskUpdate` or `TodoWrite` unless
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is set — so this panel, and the progress bars on
the boards, were drawing a list nothing had written since the day that landed. The
bridge therefore sets it for the sessions it starts. `CLAUDE_SESSIONS_TODO_TOOLS=0`
in front of the bridge opts out, and `/api/health` reports which way it went.

Two limits worth knowing: it reaches only sessions **this app starts**, so one you
run in your own terminal keeps no list unless you set the variable yourself; and it
takes effect at the next process start, so a session already running is unaffected.

## On a phone

The premise of the app is watching sessions you are not sitting in front of, and the
phone takes that one step further. That surface is the native Android app in
`~/Other/tgxcode-mobile` — a separate repository, and a client of this bridge exactly
as the desktop is.

**It is a client, not a second version of this app.** Everything it shows comes over
the same API, written down as a contract in [`docs/api.md`](docs/api.md); it adds no
code here, and cannot read `bridge/`. So a feature the phone needs is a field in that
document rather than a page in `web/`. There was a phone-shaped web page at `/m` for a
while and it has been removed — it had drifted behind the API, and maintaining a
second web UI to sit beside a native one bought nothing.

**Getting there.** Press the phone button in the top bar for a pairing link, and paste
it into the app. It keeps the token and sends it as a header; the link is only how the
token travels.

Reaching the bridge from outside the flat is a deployment choice, and
[`docs/remote.md`](docs/remote.md) is the runbook. The short version is
`tailscale serve` on the Windows host: free, no port forwarding, and — because WSL
runs mirrored and the proxy talks to Windows loopback — **the bridge never binds
anything but `127.0.0.1`**. That matters here, where the home network is a subnet
shared with the building.

**What a phone will not let you do.** It can watch, send, answer permissions, plans
and questions, and start an ordinary session. It cannot open a terminal, shut the
bridge down, stop a dev server, attach a file, or start anything in
`bypassPermissions` — the bridge refuses those with a 403 rather than the UI merely
omitting a button, so the rule holds for any client that holds a valid token. The
reasoning is in `docs/plans/14-bridge-security.md` §C and the table in
`docs/remote.md`.

**One thing worth knowing.** An ask is denied outright when no client is connected —
there is nobody to ask. So a connected phone is what makes a session answerable while
you are away from the desk, and a phone that has dropped its connection is not.

## Layout

| Path | |
|---|---|
| `bridge/server.js` | HTTP + SSE, routing, static files |
| `bridge/config.js` | Paths, ports, allowed roots — every constant with a reason attached |
| `bridge/dashboard.js` | Uncommitted changes and open PRs, per project |
| `bridge/git.js` | Every question the bridge asks git about a directory, cached once for all of them |
| `bridge/restart.js` | Pulling this checkout and handing over to `scripts/restart-bridge.sh` — the one mutating git call |
| `bridge/changes.js` | What a session changed, out of its transcript and its subagents' |
| `bridge/pulls.js` | Everything this app asks GitHub about a pull request, what its status *is*, and the review it leaves behind |
| `bridge/pr-store.js` | When to ask, and last time's answer kept on disk — so no route ever waits on GitHub |
| `bridge/overview.js` | The live board: what every session is doing right now |
| `bridge/taskboard.js` | The task board: everything outstanding, in a column per state |
| `bridge/sessions.js` | The session index — incremental, cached, watched |
| `bridge/registry.js` | Which sessions have a process, from Claude Code's own registry |
| `bridge/transcript.js` | JSONL → render events; pairs tool calls with results; reads subagent transcripts |
| `bridge/tasks.js` | A session's own task list — the items, and how far through them it is |
| `bridge/attachments.js` | Files pasted into the composer — where they land, and out of git |
| `bridge/memo.js` | Small notes the UI keeps against a session |
| `bridge/runner.js` | `claude` processes, one per active conversation |
| `bridge/terminal.js` | The pty, out of `script(1)` — a shell to type into, or a declared command |
| `bridge/commands.js` | What a project declares in `.tgxcode/` |
| `bridge/runs.js` | Running those commands, and keeping the record |
| `bridge/ports.js` | Finding a port that is free *and* unclaimed, holding it, and remembering it |
| `bridge/devservers.js` | Port detection, ranking, and stopping a server |
| `bridge/devbrowser.js` | DevBrowser control client |
| `bridge/explorer.js` | Opens a WSL directory in File Explorer, a file in whatever Windows opens it with, and knows what it will not launch |
| `bridge/notifications.js` | The notification log, what is worth raising, and what you have already read |
| `bridge/flags.js` | Pinned, archived and test state |
| `bridge/prefs.js` | Settings from `~/.tgxcode/` and from the project — which file each one came from, and which one a save goes to |
| `bridge/keymap.js` | The shortcuts that may be rebound, and the grammar for writing one down |
| `bridge/spinner.js` | What a turn in progress calls itself, out of `~/.tgxcode/verbs/` |
| `bridge/spinner-verbs.json` | The verb catalogue, and the seed for that directory |
| `bridge/suggestions.js` | What you did about a suggested follow-up |
| `bridge/drafts.js` | Sessions set up but not started — a create call, held back |
| `bridge/usage.js` | How much of the 5-hour window and the week are gone, merged from turn events and the status line |
| `bridge/beacon.js` | A `claude` started for four seconds and killed, so the quota percentages refresh with no terminal open |
| `bridge/schedule.js` | Sessions that start on a clock — the store, the cron, and what counts as new since last time (a branch's commits, or a pull request nobody has reviewed) |
| `bridge/mcp.js` | The tools this app gives a session: offer the next piece of work, find the other sessions, hand one of them a fact |
| `bridge/handoff.js` | The rules a handoff has to pass: the loop guard, and what waking a session would run into |
| `bridge/slash-commands.js` | What slash commands a directory has, for composer completion |
| `bridge/auth.js` | The access token, and telling local from remote apart |
| `bridge/tailscale.js` | What this machine is reachable as, for pairing |
| `bridge/launch.sh` | Finds a node, then starts the bridge |
| `scripts/import-spinner-verbs.js` | Rebuilds the verb catalogue from upstream |
| `scripts/quota-statusline.py` | Claude Code's status line, harvesting the quota percentages on the way past |
| `scripts/install-quota-statusline.js` | Points `~/.claude/settings.json` at that script, and refuses to clobber one you already have |
| `web/` | The UI. No build step, no dependencies |
| `web/terminal.js` | The terminal pane — a shell, or a run's output |
| `web/keys.js` | Which chord means which command, and the one function that decides it |
| `app/main.js` | The Electron shell |
| `app/make-icon.js` | Generates `app/icon.ico`, the packaged shell's icon |
| `docs/api.md` | The bridge API, as a contract for other clients |
| `docs/remote.md` | Reaching the bridge from a phone |

`launch.sh` exists because `wsl.exe bash -lc` runs a *login* shell, which reads
`~/.profile` but not `~/.bashrc` — and nvm installs itself in `~/.bashrc`. Node
is simply absent in that context, so every caller goes through the script that
knows where to look.

## Two instances

Port **45888** is the everyday app — the window you leave open with real
sessions in it. Port **45899** is for working on this codebase: `npm run dev`
starts a bridge there (or the next free port, so two agents can each have one)
and opens a window titled `dev :45899` with an amber badge, so the two are never
mistaken for each other. It refuses to bind 45888 at all.

Both read the same `~/.claude/projects`, so a session started in one appears in
the other — they are two views of the same transcripts. What is separate is the
*process*, and that is the point:

**Killing a bridge kills the turns running under it.** `claude` reads stdin for
its input, so when the bridge exits and that pipe closes, it treats it as
end-of-input and stops mid-turn. Running it detached with its output on a file
descriptor does not change that — both were tried and measured. There is no way
to make a turn outlive its bridge, so the only real protection is not killing
the bridge somebody is using. Hence two ports.

`pkill -f bridge/server.js` matches every bridge, including the everyday one.
To stop your own, Ctrl-C the `npm run dev` that started it, or kill it by port:

```bash
kill "$(ss -ltnp 2>/dev/null | grep :45899 | grep -oP 'pid=\K\d+' | head -1)"
```

### Which checkout is on the port

Two ports keep the *processes* apart. They did not, for a while, keep the *code*
apart — and the way that failed is worth writing down, because every step of it
looked reasonable.

The bridge handed its own environment to every session it started, so an agent
working on this codebase inherited `CLAUDE_SESSIONS_PORT=45888`. Nothing then had
to mention a port for the mistake to happen: `bash bridge/launch.sh` in a worktree
bound the everyday one. It came up reporting `dev: false`, because that flag is
derived from the port. And the Windows shell, which starts a bridge only when
nothing answers, adopted it. The result is a window that looks exactly like the
everyday app — no amber badge, no `dev` in the title — serving a branch's `web/`
out of a worktree that may be weeks stale. A change merged to `main` is then
simply absent from a window that has been reloaded a dozen times, and every
instinct says to look at the merge.

So the port alone is not identity. `/api/health` reports `root`, the checkout the
bridge is running out of, resolved from `__dirname` because that is what decides
what gets served:

```bash
curl -s http://127.0.0.1:45888/api/health | python3 -m json.tool | grep root
```

Four guards, arranged so that no single one has to hold:

| Where | What |
| --- | --- |
| `bridge/server.js` | Refuses to bind 45888 when running out of `.claude/worktrees/` — exit 4, before the socket, so no way of starting a bridge gets around it. |
| `bridge/runner.js`, `bridge/terminal.js` | Sessions and terminal panes no longer inherit `CLAUDE_SESSIONS_PORT`. The variable is the bridge's own business. |
| `scripts/restart-bridge.sh` | Refuses the everyday port from a worktree, *before* killing anything — otherwise the guard above turns a takeover into an outage. `--status` still works anywhere. |
| `app/main.js` | Verifies `root` against its configured `bridgeDir` before adopting a bridge on 45888, and takes the port back if it does not match. |

Taking the port back goes through `/api/shutdown`, never a kill, because that
endpoint answers 409 while a turn is in flight. A squatter with work running is
waited for — the window says what it is waiting for and how many turns — and the
port is claimed the moment that work lands. A development instance is exempt from
the check: it is pointed at a port deliberately and serves whichever checkout
started it, which is the entire point of having one.

### Picking up new code

The bridge runs whatever was on disk when it started, so it keeps running old
code until you restart it.

**The quickest way is the button in the header**, beside the DevBrowser pill: it
fast-forwards the checkout this bridge is serving and restarts it. When something
is in the way it says so rather than doing half of it — turns in flight, a pull
that would not fast-forward, uncommitted `bridge/` code — and offers to cancel,
to hand the checkout to a session, or to go ahead anyway. That third choice is
the confirmation the script asks for at a terminal, moved somewhere it can be
answered; see `POST /api/restart` in `docs/api.md`.

It restarts *this* bridge, whichever that is, so a dev instance in a worktree
picks up its own branch and not main. One wart: the replacement comes back in its
own session, so a bridge started by `npm run dev` is no longer stoppable with
Ctrl-C in that terminal — kill it by port instead.

For a terminal, add this to `~/.bashrc`:

```bash
alias restart-bridge='bash ~/Other/claude-sessions/scripts/restart-bridge.sh'
```

Then `restart-bridge` from anywhere. It touches only the everyday port, refuses
while a turn is in flight (`--force` overrides), takes `--pull` to fast-forward
from origin first, and `--status` to just report what is running. Any open
window reconnects on its own.

#### The nightly one, and how to tell whether it ran

There is a midnight entry in `crontab -l` — written down here because it is
installed on the machine and nowhere in this repo:

```
SHELL=/bin/bash
MAILTO=""
0 0 * * * /home/dylan_hays/Other/claude-sessions/scripts/restart-bridge.sh >/tmp/bridge.log 2>&1
```

`MAILTO=""` means cron mails nothing, and `/tmp` is a tmpfs that WSL empties on
every shutdown, so that redirect is not a record of anything — by morning it is
usually gone. The script therefore keeps its own, appended, next to the bridge's
log:

```bash
tail ~/.cache/claude-sessions/restart-45888.log
```

One line per event: a `start` line, then one word for the outcome —
`restarted`, `skipped-dirty`, `skipped-declined`, `skipped-busy`,
`refused-worktree`, `failed-pull`, `failed-start`. So `grep skipped-dirty` is a
real question to ask of it, and the last several nights are all still there.
`bridge-45888.log` next to it is the running bridge's own stdout and is
truncated on every restart, which is why it cannot answer this.

Two readings worth knowing:

- **A `start` line with no outcome after it** — the script was killed part-way.
- **No `start` line at all for that night** — cron never fired, which on this
  machine usually means WSL was not running at midnight. That is a different
  problem from a skip, and used to be indistinguishable from one.

A dirty main checkout does **not** stop the nightly run any more, unless the
dirty files are under `bridge/`. That is the only directory a restart actually
loads: the bridge `require`s it once at startup, whereas `web/` is read from disk
per request and so is already live either way, and docs, tests and scripts are
not read by the bridge process at all. Uncommitted `bridge/` code with nobody to
confirm with is left alone and journalled as `skipped-dirty` — put `--yes` in the
crontab if you would rather it loaded whatever is on disk.

## Working on this with agents

`.claude/settings.json` pins `worktree.baseRef` to `head`, so a new worktree
branches from local HEAD. The global default is `fresh`, which branches from
`origin/<default-branch>`. The pin dates from when this repo had no remote; it has
one now — `origin` is `github.com/TheYearIsTwentyGX/TGXCode`, and `main` tracks
`origin/main` — so either setting resolves. `head` is kept because it bases a
worktree on the checkout in front of you, which is the predictable thing while
several agents are committing to main.

When the work is finished, `npm run land` from the worktree merges its PR and
fast-forwards this checkout, which is otherwise a step agents cannot take: a
worktree-isolated session is refused `git -C` against a directory outside its own
tree. It pulls and stops there — restarting the bridge to pick the change up
stays a human decision, because it ends whatever turns are running.

Two other things that trip agents up here:

- **Start them in this directory.** `EnterWorktree` needs a git repository at the
  working directory. An agent launched in `~` reports "not in a git repository
  and no WorktreeCreate hooks are configured", which reads like a missing hook
  but is really just the wrong cwd. Nothing needs configuring — `cd` here first.
- **One build at a time.** `install.ps1` wipes and rebuilds its staging
  directory, so two agents packaging at once will pull the executable out from
  under each other.

## Notes and limits

- **Reasoning is usually blank.** Claude Code writes the signature of a thinking
  block but strips its text — across the 6,898 blocks on this machine only 29
  kept any. Newer sessions do keep it, and those render; older ones show nothing
  because there is nothing there.
- **Content comes from the transcript file, never from the process.** That is
  what makes a session running in your terminal look identical to one started
  here. The trade-off is that updates arrive per message rather than per token.
- **Stop asks first, then insists.** The first click interrupts the turn over the
  control channel: the process stays alive, nothing is left half-written, and the
  session is resumable. For a few seconds afterwards the button reads **Force
  stop**, which kills the process — the old behaviour, and still the thing to
  reach for when the polite path does not take. The status line says which one
  happened, because the outcomes differ.
- **The bridge outlives the window.** It is started detached so a long turn
  survives closing the app, and shuts down on exit only when nothing is running.
  A second launch reuses what is already listening on 45888 — but only after
  checking it is serving the configured checkout; see *Which checkout is on the
  port*.
- **One writer at a time.** Sending from here while the same session is mid-turn
  in a terminal would have two processes appending to one transcript. The rail
  flags active sessions; it does not stop you.
