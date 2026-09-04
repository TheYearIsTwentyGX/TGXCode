# Editing Claude Code's own settings

The settings page landed with every key in `~/.tgxcode/settings.json` behind a
control (see `19-settings.md`). The obvious next question was the one it did not
answer: the app can tell you which of four files gave *it* a value, and nothing
at all about the files that decide what `claude` may do. Changing a permission
rule meant leaving the app for a text editor, from the window you sit in to
watch those sessions run.

This is that gap closed for `settings.json`. `CLAUDE.md` and the
agents/commands/skills library are deliberately not here; see *What is deferred*.

## The one fact everything follows from

**We do not own this format.** Claude Code ships no JSON schema anyone can read
— it is a single bundled binary, `claude doctor` prints prose, and there is no
`claude config`. Its real schema is a permissive object: unknown keys are kept
rather than rejected, and many fields degrade quietly instead of failing.

So a catalogue of keys written by hand is the only option, and it will fall
behind. Every design decision below is about making that cheap rather than
dangerous.

## Why not `bridge/prefs.js`

`Prefs` is the right *shape* and the wrong *home*, and three things
disqualified extending it rather than merely arguing against it:

- **`merge()` iterates `SHAPE`, not the file.** A key it does not know is
  invisible. That is correct for a closed world this app defines and
  catastrophic here: the app would silently hide a permission rule it had not
  heard of. The new module walks the *file*.
- **`save()` stamps `doc.version`.** Right for a format we define; here it would
  inject a key Claude Code does not define into the user's own file. This one
  ended the discussion on its own.
- **`files()` encodes a four-entry chain with a worktree fallback.** Claude Code
  reads the `.claude` of the directory it runs in, so a worktree's own file is
  the one in force and none of that fallback applies. Sharing it would mean
  threading a `family` parameter through every function in the file.

And one more that is about the new requirement rather than the old code: `Prefs`
has no write precondition, deliberately, because nothing else writes
`~/.tgxcode/settings.json`. A precondition is the *central* requirement here.

What did get shared is the part that was already duplicated twice —
`bridge/jsonfile.js`, holding the stat-before-read, the size cap, the BOM, the
atomic write and the `refuse` helper. Extracting it fixed a real bug on the way
past: `prefs.js` wrote `<file>.tmp`, so the everyday bridge and a dev bridge
saving at the same moment raced on one path. `scripts/install-quota-statusline.js`
had already worked that out and used the pid; now one place does.
`test/prefs.test.js` passing unchanged was the acceptance criterion.

## The catalogue has no authority

`bridge/claude-schema.js` proposes a control and a sentence. It cannot drop a
key, correct a value, or declare one invalid. Three mechanisms make that true
rather than aspirational:

1. **A key the catalogue does not model but which holds a scalar gets a generic
   control by JSON type.** On this machine that makes eight of nineteen keys
   editable for about twenty lines of code, with the app claiming to know
   nothing about any of them. It is what makes drift cheap: a key Claude Code
   adds next month is editable the day a session writes one, and cataloguing it
   later only adds a label. The safety is a type guard — a generic path may only
   be set to the type it already holds, so a text box cannot turn
   `switchModelsOnFlag: false` into the string `"false"`.
2. **A value the catalogue does not list is shown as it is.** Every `choice` is
   `open` unless the option list really is closed, and an unrecognised value
   widens the list. `askUserQuestionTimeout` is what taught this: its value here
   is the string `never`, and a catalogue that asserted "a timeout is a number"
   would have drawn a spinner over the word and written `0` on first save.
3. **The raw JSON tab ships in phase one.** Not a fallback added later — it is
   what makes the rest honest. With it there, nothing in those files is beyond
   reach, and it is the only thing in the app that can repair a file that no
   longer parses.

`catalogueAgainst` records the Claude Code version the catalogue was read
against, so "there is no control for that" and "this app is out of date" are
told apart by looking rather than by guessing.

## The stamp, and why read-modify-write is not enough

`claude` writes these files itself: `theme` and `editorMode` from `/config`,
`enabledPlugins` from a plugin toggle, and `.claude/settings.local.json` gains a
rule every time somebody approves a permission mid-turn.

Read-modify-write handles the case people reach for first — set one key, leave
the rest — and it handles it completely, provided the read happens immediately
before the write rather than at page load. So a scalar patch needs no
precondition, and does not have one.

It does nothing for a key whose value is a *collection*. `permissions.allow` is
one key holding twenty-eight rules; writing the array a page loaded ten minutes
ago drops the rule approved since, and the user watched that approval happen. So
`stamp` — `mtimeMs:size`, opaque, from the read that populated the UI — is
required for any write that replaces or removes a whole collection, and for
every whole-document write. A mismatch is `409` carrying the file as it now is.

Two things it deliberately does not do:

- **No lockfile.** `~/.claude/` is Claude Code's directory; a lock we put there
  is a file another program does not know to respect, and a lock outside it
  protects nothing. The residual race is between the stat and the rename, which
  is microseconds against the seconds-to-minutes a settings page is open.
- **No merge.** We do not own the schema, so we cannot merge safely — `hooks` is
  an array where order matters, and a naive union produces a hook that fires
  twice per tool call. Refuse, and let a person look.

## Permission lists are a union, and that broke something

`allow`, `deny` and `ask` add up across every file in the chain rather than the
strongest winning. Two consequences, and the second is the more expensive:

- The "Overridden by … — this has no effect here" sentence the app's own
  settings rows draw must never appear over one of these. What they get instead
  is a count of what this scope sets and what it inherits.
- **A list control must edit this file's own entries, never the merged value.**
  The first version of this page seeded the editor from what was in force, so
  adding one rule at the project-local scope wrote twenty-eight of the user's
  own rules into a repository's file as well. It was caught by driving the real
  UI against the real files, which is the argument for doing that rather than
  trusting the unit tests — nothing in the bridge was wrong.

The inherited entries are shown read-only beside the editable ones, attributed
to the file they came from. That is also the feature: seeing the user file's
rules and a project's together used to mean opening two editors.

## Refusals that are structural rather than checked

- **Symlinks.** `~/.claude/` and `<project>/.claude/` are directories other
  tooling creates. `lstatSync` on the *link* — `statSync` follows, and following
  is the bug — then a `realpath` containment check.
- **Reserved property names.** A client-supplied dotted path is being assigned
  into an object, so `__proto__`, `constructor` and `prototype` are refused *by
  name*. A filter that silently dropped a segment would change which key got
  written.
- **The managed file is read-only and is reported even when absent.** It is the
  one file that overrides everything, and it does not exist on most machines —
  which is exactly why a page showing three rows where there are four would be
  lying in the case that matters. Its path is overridable by environment for one
  reason: without that the read-only scope is untestable, and an untestable
  scope is wrong the first time somebody actually has one.

## Both methods are local-only

`GET /api/prefs` is open to a phone because how somebody wants a transcript
folded is not a capability. This is the reverse on both counts: these files name
hook commands, permission rules and the *values* of environment variables, and
no client off this machine configures the CLI. There is nothing to weigh against
caution, so the read is refused too — on the prefix, with no method test, so
anything added under it later is refused by default rather than by being
remembered.

## Smaller decisions worth not re-litigating

- **`hooks` is read-only with an *Edit as JSON* button.** Thirty-three events, an
  optional matcher, and a five-variant union, where `command` is an arbitrary
  shell string run on every matching tool call — the highest-privilege field in
  the file, and a poor thing to put a casual text box over. What the summary
  offers instead is the one question a text editor cannot answer: **whether the
  script each hook points at still exists.** A hook aimed at a deleted file
  fails silently and nothing in Claude Code says so.
- **`statusLine` is read-only when it is ours.** `install-quota-statusline.js`
  exists precisely to avoid clobbering somebody's deliberate choice; a text box
  here would reopen that hole from the other side. The JSON tab still reaches
  it, which is the difference between hard and impossible.
- **A textarea, not a vendored editor.** `web/vendor/` proves vendoring is
  possible. A few hundred kilobytes of code editor with no build step to prune
  it, to edit a four-kilobyte JSON file, is a poor trade — and the one thing a
  real editor would have earned, knowing where the syntax error is, is a
  `JSON.parse` and the offset it reports.
- **`git check-ignore`, not reading `.gitignore`.** On this machine
  `.claude/settings.local.json` is ignored by `~/.config/git/ignore`, a global
  file no amount of looking in the repository would reveal. The same helper
  closes a gap `docs/api.md` had admitted in prose about the app's own local
  file. A directory that is not a checkout answers "not ignored", because this
  is a claim about privacy and the safe direction to guess in is the one that
  warns.
- **The group has its own scope tabs.** The page's selector means "which of
  *our* three files". Overloading it would move every other group on the page
  when you touched this one, and the chains are different lengths anyway.

## What is deferred, and why

- **`CLAUDE.md`.** Wanted, and the natural next increment: same two-scope shape,
  one file per scope, and the file people edit most. It needs a file-content
  route, which this change deliberately does not add — `/api/fs` lists
  directories and nothing in the bridge reads or writes a file's bytes.
- **`agents/`, `commands/`, `skills/`.** None of those directories exists at
  user or project level on this machine; everything in use arrives from plugins.
  So the value there is *authoring*, which is a small file manager rather than
  another settings group — and editing a plugin-owned file is a footgun, since
  the next plugin update overwrites it.
- **A `hooks` form editor**, for the privilege reason above, and because the
  existence check is most of the value.
- **MCP server configuration** — `~/.claude.json`, `.mcp.json`. A different file
  family, credentials-adjacent, and it needs a threat model this change does not
  have.
- **A diff view on a conflict** — still deferred, and the banner having become
  more common rather than less has not changed the argument. The banner shows
  what is on disk; a real diff is a component.

## Watching the files, which came second on purpose

Deferred in the first pass and built in the next. The bullet said why the order
was right — "the `409` is the safety net meanwhile: correctness before
liveness" — and that is still the shape of it. The watch does not touch the
precondition; it only means a panel usually finds out before it tries to save,
rather than only when the save is refused.

Three things about it are decisions rather than mechanics.

**The directory, not the file.** Both this app's `writeAtomic` and Claude Code's
own writes are `tmp` + `rename`, which replaces the inode — so a watch on the
path fires once and then watches a file nothing will write again. That failure
is silent and looks exactly like the feature working, which is why
`test/claude-config.test.js` writes by `rename` twice and asserts on the second.

**The stamp decides, not the event.** `~/.claude` holds `history.jsonl`,
`daemon.log` and a handful of lock files as direct children, all of them
churning, so most events there are about nothing. One `stat` per watched file
filters that without relying on `fs.watch`'s `filename` (`null` on some
platforms), collapses the repeat events a `rename` produces, and — because
`_write()` records its own stamp — suppresses the echo of our own save for free.
That last one is not tidiness: the page cannot tell that echo from somebody
else's change, and `dirty` survives a tab switch, so it could put a conflict
banner over the user's own edit.

**A project is not watched until somebody asks.** There are ~100 directories
under `~/.claude/projects` and the panel is usually closed, so watching every
checkout for a view nobody has open is the wrong shape. A `GET` with a `cwd`
arms one; a small cap and a ten-minute idle sweep give them back. The
user's file is watched throughout, because it is the one `/config` writes and
there is one of it.

The reason `bridge/prefs.js` re-stats instead — "one inotify watcher for a file
that changes monthly is a poor trade" — is sound and does not transfer. Its file
is written only by this app and read once per session open. Here another program
is the writer, the view is held open across minutes, and there is nothing to
re-stat against because no request is in flight while a panel simply sits there.
