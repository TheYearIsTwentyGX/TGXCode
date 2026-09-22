# 21 — Editing the commands a project declares

**Effort:** M · **Depends on:** 17, 19, 20 ·
**Touches:** `bridge/commands.js`, `bridge/server.js`, `web/app.js`,
`web/styles.css`, new `test/commands.test.js`, `test/refusals.test.js`,
`docs/api.md`, `docs/remote.md`

> Built.

## Why

Plan 17 shipped project commands with no way to edit them. A project declares
what it runs in `.tgxcode/commands.json`, the app draws a button per command in
the conversation header, and the only way to change one was a text editor — from
the window you sit in to watch those commands run. Plan 20 closed exactly this
gap for Claude Code's own files and made the argument in full; this is the same
move for the one config file the app reads out of a project and could not write.

The format does not forgive. `version: 1` is mandatory. Five placeholders are
legal and a sixth is a validation error rather than an empty string. `${port}`
is refused unless the command declares a range. And the failure mode is the
quiet one: a file that will not parse contributes *nothing*, so the symptom is a
header with no buttons and an explanation in a tooltip on a container that is
now empty and therefore has no hover target worth finding.

That failure was live in this repository while the plan was being written — a
trailing comma after a newly added `land` entry — and nothing on screen said so.

## Design

### A. The write lives in `bridge/commands.js`

Plan 20 gave three reasons for splitting `claude-config.js` out of `prefs.js`,
and all three point the other way here: `merge()` iterating a fixed shape is
wrong for a format we do not own and right for one we do; stamping `doc.version`
injects a key into somebody else's format and is correct in ours; and the file
chain that did not transfer to Claude Code is, here, the same chain in the same
module. What a second module would duplicate is the format itself — the id
pattern, every field rule, the caps, the two filenames and the precedence
between them — and two owners of that is how a reader and a writer drift apart.

`bridge/jsonfile.js` already holds the parts that *are* shared. `readConfig()`
predated it and was the third copy of the stat-before-read, the size cap, the
BOM and the parse; it now delegates and keeps only the `version` and `commands`
rules. That also gets `text` back on a parse failure, which the old version read
and threw away — and without which the JSON tab could not exist.

### B. `raw()`, and the trap it exists to avoid

`load()` answers "what is in force": both files merged, every placeholder
expanded. An editor seeded from that writes it back, so adding one local
override copies every shared command into a personal file. Plan 20 records
hitting that bug twice, in two different shapes, and it was found both times by
driving the real UI rather than by a unit test.

So `raw(dir)` reports the files separately and its `commands` are **verbatim** —
the entries as written, unvalidated, including keys this app does not model.
Validation is a gate, not a transform. `validate()` builds a fresh object and
drops what it has not heard of, so a `raw()` that returned its output would make
the editor silently narrow the file on every round trip.

### C. A separate route prefix, so the refusal can be a prefix

`/api/commands-config`, not `/api/commands/config`. `GET /api/commands` is
deliberately readable from a phone, so its refusal is an exact-path equality on
`/api/commands/run` — and under that prefix the default for anything added later
is *allowed*. A separate prefix gets the property `/api/claude-config` has:
refused with `startsWith`, both methods, so what comes next is refused by
default rather than by being remembered.

**The read is refused too**, one line away from a read that is allowed, and the
asymmetry is the design. What a project *declares* is in its repository already
and the merged payload has never carried `env`. This route serves the files,
including the gitignored one — which is exactly where an environment variable
with a token in it lives. `test/refusals.test.js` pins the two adjacent, with the
reason between them, so a tidy-up cannot make them agree.

### D. A draft with a Save button, against the page's own rule

Every other control in Settings saves on `change`. That rule exists so a control
cannot disagree with what is in force, and it is right for a preference, which is
one independent key.

A command is a record whose fields have to agree: `run` is required, an id is a
key, and `${port}` is an error until a port range exists. Saving per field means
writing a document the bridge refuses on most keystrokes, into a file that is
checked in and that every bridge on this machine re-reads every two seconds.

The alternative considered was autosave with incomplete rows staged client-side
and promoted only once valid. It works, and it keeps the header and the form in
step — a real advantage, since the form edits the file the buttons come from.
It was rejected as more machinery than the problem: it needs a second holding
array, a rule that an existing command may not *become* incomplete, and a
client-side mirror of the schema authoritative enough to decide promotion. The
JSON tab and the `CLAUDE.md` editor are already drafts for the smaller version of
this reason, and a save here re-reads the header buttons, which is most of what
autosave would have bought.

### E. "Set here", and what a partial override looks like

The local file exists to change one thing about a command without restating it,
so an editor that cannot express that is worse than the text editor it replaces.

Each field carries a checkbox meaning exactly one thing: **is this key present
in this file's entry**. Ticked, the key exists with whatever is typed. Unticked,
the control is disabled and the shared file's value is the placeholder. No third
state — which is the only way the form and the JSON tab can be trusted against
each other.

Three consequences worth naming:

- **Visibility is a two-option select, not a checkbox.** A second checkbox
  beside "Set here" is two boxes that look identical and mean different things,
  and it cannot say `false` out loud — which is what un-hiding a command the
  shared file hides requires.
- **`env` overrides by key, not by object**, because `merge()` folds
  `{...prev.env, ...here.env}`. The inherited keys are listed read-only beside
  the editable ones, with the sentence the format forces: there is no way to
  *remove* an inherited variable here, only to give it a different value.
- **An override whose shared command is gone is an orphan.** The merge turns it
  into a first definition, which then needs a label and a run, so the whole
  document is refused and the page looks stuck. It gets a badge, the parser's
  own sentence, and two ways out.

### F. The worktree sentence

A worktree is a checkout of the same repository, so it has its own
`commands.json` — 66 of them do here — and `readMerged()` prefers the one in the
directory a session is running in. Editing the project's copy therefore changes
nothing for a session in a worktree.

That is the feature working and it looks exactly like the feature being broken,
so it is on screen in bold rather than in a document. The Local tab carries the
opposite sentence, because that file *is* read from the main checkout for every
worktree — which makes it the answer to "I want this to reach work already in
flight" rather than a lesser version of the shared one.

## Risks

- **The symlink check had a hole, and it was in the shared helper.**
  `jsonfile.escapes()` answers about a path that exists — `lstat` throws for a
  missing one and "absent" is correctly not an escape. But missing is the normal
  case here, since the first save creates both the file and `.tgxcode`. So the
  containing directory is checked as well as the file, and against the *project
  root* rather than `<project>/.tgxcode`: if that directory is itself a symlink
  then `commands.json` inside it is an ordinary file whose realpath sits happily
  inside the realpath of the link target. Both corrections were found by writing
  the test and watching it pass when it should not have.
  **`bridge/claude-config.js` appears to have the same gap** for a
  `.claude/settings.json` that does not exist yet under a symlinked `.claude`.
  Not fixed here; it is a different module with its own tests.
- **Nothing watches these files.** Plan 20 added a watch in its second pass and
  said why the order was right — the `409` is the safety net meanwhile, and
  correctness before liveness. The same holds: a hand edit behind an open panel
  is caught on save, with the draft kept and the file shown.
- **`append(null)` prints the word.** The codebase already carries a comment
  about `append` stringifying a `false`; this hit the null version of it and
  printed "null" under a command until the real UI showed it.
- **Env values are secrets on a screen people share.** The route is local-only
  and the local file is the one that holds them. Masking the values behind a
  reveal was considered and left out: it would be a lie on the JSON tab next
  door, and a half-applied one is worse than none.

## Acceptance

- ✅ A file with a trailing comma reports the parser's own message, the form
  says it cannot show it, and the JSON tab repairs it — the real case, from this
  repository, rather than a staged one.
- ✅ A save is refused whole: one bad entry writes nothing, including the good
  entries and including the file itself when it was being created, and every bad
  row is reported at once against its row and field.
- ✅ Editing the file behind an open page gives a `409` with the draft kept and
  the file on disk shown; nothing is overwritten.
- ✅ Overriding `run` alone writes `{id, run}` and nothing else, and the merged
  reading keeps the shared label.
- ✅ Every inherited value shows through as a placeholder — label, command,
  directory, port range, DevBrowser tab — so "unset" and "set to nothing" never
  look alike.
- ✅ An override whose shared command has been deleted is tagged, explained and
  recoverable.
- ✅ A symlinked `.tgxcode` is refused, and nothing appears at the link target.
- ✅ A save is visible to the very next read, and to the header buttons in every
  open window.
- ✅ A remote caller may read what a project declares and may not read the files
  behind it.
