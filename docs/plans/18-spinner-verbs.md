# 18 — What a turn in progress calls itself

**Effort:** S · **Depends on:** none ·
**Touches:** new `bridge/spinner.js`, new `bridge/spinner-verbs.json`,
new `scripts/import-spinner-verbs.js`, new `test/spinner.test.js`,
`bridge/prefs.js`, `bridge/runner.js`, `bridge/server.js`, `bridge/config.js`,
`web/app.js`, `test/run.js`

> Built.

## Why

Eight surfaces in this app show that a session is working — the composer status
line, rail rows, the subagent header, the live board, the task board, the
dashboard chips, and a phone at `/m`. Every one of them said the same three
words, because every one of them reads `runner.activity` off one SSE message and
that string was the literal `Thinking…`, set in four places in `runner.js`.

Claude Code itself stopped saying `Thinking…` a long time ago, and
[wynandw87/claude-code-spinner-verbs][verbs] has since collected 3,639 verbs
across 114 themed groups. Wiring that in is a small change with a good
return: the app gets a personality it did not have, and it costs one module.

[verbs]: https://github.com/wynandw87/claude-code-spinner-verbs

## The two decisions worth recording

**The bridge composes the label, not the browser.** This is what makes the change
small. Because all eight surfaces already agree by reading one label off one
message, replacing four literals in `runner.js` reaches all of them — mobile
included. The alternative was teaching each surface about verb pools, in two
clients, and two windows would still have disagreed about what a session was
doing.

The one exception is the session rail, and it is worth spelling out. The label is
two halves — `Percolating… Reading runner.js` — and the rail has room for about
twenty characters, which is not enough for both. Clipping there would have spent
them all on the verb and cut the tool name off the end: the decorative half
surviving at the expense of the informative one. So `status()` carries `verb` and
`detail` alongside the composed `activity`, and `activityBits` in `web/app.js`
draws `detail || activity`. Because `detail` is null exactly when the verb is all
there is to say, that one expression gives the rail the tool name while a tool
runs and the verb the rest of the time. Every wider surface — status line, boards,
subagent header, mobile — draws `activity` and needs neither field.

`BOOT_PREFS` in `web/app.js` also carries the new `spinner` block, harmlessly and
unread; that is the meta tag being generic, not a client that needs it.

**The verbs are a directory, the toggles are a setting.** 3,639 verbs will not go
in `~/.tgxcode/settings.json` — prefs.js caps that file at 64KB, rightly. More to
the point, the whole value of themed groups is choosing among them and pruning
inside them, and "delete the ones I don't like" has to be an operation you can
perform. So each group is a file under `~/.tgxcode/verbs/`, seeded from the
checked-in catalogue on first run, and `spinner.groups` in the settings file names
which of them are in play. Only the named ones are ever opened, so a directory of
114 files costs nothing per pick.

The category is written down twice — as the filename and as `Category` inside the
file — and that is deliberate rather than redundant. A filename cannot hold
`Tech / Programming`, which is why `Tech_Programming.json` exists; and a group
that states its own name survives being renamed, moved, or sent to somebody else.
Resolution is two-tier because of it: slug the requested name and stat that file
(the normal case, one stat), and only on a miss read the directory and match on
`Category`. Both tiers are safe against a hostile name, the first because the
slug is reduced to `[A-Za-z0-9_-]` before it becomes a path and the second
because it matches against a listing.

## Two halves, and what each one is for

The first cut of this had the verb *replace* the label, the way `Thinking…` used
to be replaced by a tool's name. That forced a choice nobody should have to make:
either the verb stops moving for the length of a tool call — and a spinner that
has stopped spinning reads as a session that has stopped working — or it keeps
moving and the tool's name is gone. Showing both dissolves the problem. The verb
drifts on its own clock, the detail tracks reality, and neither waits for the
other.

It also means `rerollMs` is the *only* thing that moves the verb. Redrawing it at
every transition as well — which the first cut did — changes both halves at once
on every tool call, and the detail is already the half that says what moved. So
`_work(detail)` draws a verb only if there isn't one, and `_drift()` is what
replaces it.

The bookkeeping is two lines at the top of `_setState`: cancel any pending drift,
and if this is not `_say` talking, clear both halves. That is what keeps a
question waiting on a person, an API retry, `Starting Claude…`, going idle and
stopping from ever wearing a verb, without a single call site having to remember
it. Measured live with `rerollMs` at 8000: a 20-second `sleep` held
`… Running: Sleep 20 seconds then echo` across two different verbs, then handed
back to `Writing`.

`Spinner#pick` answers **null** rather than a fallback string, and that is load
bearing. The composer needs to tell "no verb" from "a verb that happens to read
like the old label", because with no verb the label has to be byte-identical to
what this app showed before — the detail alone, or `Thinking…`. `randomize:
false` is therefore a genuine no-op rather than a different code path, and
`test/spinner.test.js` asserts exactly that.

## What was considered and dropped

- **Picking per-client**, so the label could animate without SSE traffic. Costs
  eight surfaces × two clients of teaching, and gives up the guarantee that two
  windows agree. The bridge already owns this label.
- **A `"*"` group meaning all of them.** Enabling all 114 groups is a soup, and
  the point of groups is to choose a voice. Naming them is the feature.
- **Restoring a missing group file** on the theory that the directory should
  match the catalogue. This would make deleting a group you dislike undo itself
  on the next run, which is the opposite of the point. The directory is seeded
  only when it is absent altogether.
- **Randomizing `Writing…` and the tool descriptions** too. Those say something
  true about what is happening; the verb goes in front of them instead. Only the
  placeholder was a placeholder.
- **Letting the verb replace a long tool call's name** after a few seconds, which
  is what the first cut did and what the second rejected. See above.

## Cost

`_setState` at the two sites that were often no-ops — a permission resolving, a
tool result landing — now moves the label every time, so it emits where it used
to stay quiet, plus one status message per busy session per `rerollMs`, including
during tool calls now that the drift runs through them. Against the `describeTool`
updates already flowing through the same channel this is noise-level, but it is a
real increase and not zero.
