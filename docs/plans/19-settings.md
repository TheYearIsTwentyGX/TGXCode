# 19 — Settings, and remapping keys

## Why

`~/.tgxcode/settings.json` reached twelve keys across four blocks with nothing in
the app that edits any of them. `README.md` said so out loud — "There is no
settings page yet; the file is the interface" — and `docs/api.md` repeated it.
The quota panel had a paragraph telling you to go and hand-edit JSON. The
comment above `GET /api/prefs` in `bridge/server.js` had been anticipating "a
settings page saving" since it was written.

The file being the interface was defensible at three keys. At twelve it was not,
for a reason that is not about convenience: **the file cannot tell you where a
value came from.** Four files feed the chain, validators silently drop what they
do not like, and the only way to answer "why is this not what I set?" was to
read `bridge/prefs.js` and then stat four paths by hand.

Two settings arrived with the page, both about keys, and both asked for
directly:

- **Contextual Ctrl+C in the terminal** — with a selection, `Ctrl+C` copies;
  with none, it interrupts. On, plain `Ctrl+V` pastes instead of
  `Ctrl+Shift+V`.
- **Composer send** — `Enter` sends and `Shift+Enter` is a newline, or the
  reverse.

## What it is

A sixth whole-screen panel on `Ctrl+8`, one centred column with a sticky table
of contents, and a group per block of the settings file. A **scope** selector
picks which of three files a save lands in, beside a **project** selector.

Every control saves on change, one key at a time, through `PUT /api/prefs`.

## The decisions, and what they cost

### The file stays the interface

The head names the exact path it is about to write and lets you copy it. Nothing
the panel writes is anywhere a text editor cannot reach, and `ensureUserFile`
still writes the defaults out on first run. This is a better way in, not a
replacement — which is also why the panel needed no new read route: `GET
/api/prefs` and `GET /api/spinner/groups` already existed *because* there was no
page, and both paid for themselves here.

### Three scopes, and `target` rather than scope arithmetic

VS Code's User/Workspace pair, plus a third the chain already had. The precedence
chain is four files and the scopes are three, because the main checkout's local
file and a worktree's own are both "project-local" — so the save target is
derived by `Prefs.targetFile(scope, dir)` and never picked out of the chain. A
caller that reasoned from the scope alone would write the main checkout's file
from a worktree.

`raw(dir)` is the other half: what each file *says*, as against what the chain
adds up to. `forCwd` answers "what is in force", which cannot distinguish a
value you set from one you inherited — and a control that cannot distinguish
those offers to clear things that were never set, and appears not to work when a
stronger file has taken over.

`settings.local.json` was **not** gitignored in this repository, and
`bridge/prefs.js` had been calling it "the gitignored local file" since before
anything ignored it. Adding the line was part of this change. Note it is only
this repository: the panel cannot promise a scope's file is untracked anywhere
else, and `docs/api.md` says so.

### `null` removes, and is not the same as the default

A patch value of `null` deletes the key so it falls back down the chain. Writing
the default instead would pin it — a `groupMinCalls: 3` written today survives a
change to the default tomorrow, and there would be no way to say "I do not care
about this one" once you had said otherwise.

### `quota` and `keyboard` are the user's alone

Enforced in `merge()` via `USER_ONLY`, and reported rather than silently dropped.

`quota` was *documented* this way and enforced only by its call sites passing no
`cwd`. That held, but `GET /api/prefs?cwd=` echoed a project's value back as
though it counted — harmless while nothing read the answer, and not once a page
prints which file wins for each key. `keyboard` is the same argument one step
further in: a repository that can rebind your keys can make the window unusable,
with hand-editing the file as the only way back.

At a project scope the two groups are drawn disabled with that sentence, rather
than hidden. A section that vanishes reads as a bug; one that says why teaches
the rule.

### A page's write is refused whole; a file's bad value is dropped

Opposite treatments, deliberately. A file is hand-edited and half of it working
beats none of it, so `merge()` drops a bad value and keeps the default. A client
sending a value the bridge will not keep is a bug in the client, so `save()`
validates the whole patch up front and refuses all of it — dropping it silently
would leave a control showing something untrue. Refusals carry a `code` so a
route can classify without matching on prose.

`keyboard.bindings` is the exception inside the file rule: it is a map, so one
typo'd command id costing every binding beside it is a lot of silence for one
mistake. `cleanBindings` takes it entry by entry, one `problems` line each, and
canonicalises what survives.

### Local-only, and the read left open

`PUT /api/prefs` writes a file in the user's home directory, and
`quota.beaconDir` names a directory this app then starts `claude` in. That is
the `mkdir` clause with a longer reach. The GET stays open: how somebody wants a
transcript folded is not a capability, and the phone has a use for the answer —
so the refusal is on the method, and `test/refusals.test.js` pins both halves so
a future prefix rule cannot take the GET with it.

### The catalogue lives in the bridge

`keyboard.bindings` is keyed by command id. Had the catalogue lived only in
`web/keys.js`, those ids would be discoverable by no other client and a typo
would be indistinguishable from a binding that does not work — the exact gap
`CLAUDE.md` warns about. So `bridge/keymap.js` owns it, `bridge/prefs.js`
validates against it, `GET /api/keymap` serves it, and a `cs-keymap` `<meta>`
tag carries it into every page beside `cs-prefs` — because the first keystroke
can land before a fetch could answer.

### Combos name physical keys

`e.code`, not `e.key`, which is the convention `web/terminal.js` already set
with `e.code === 'KeyC'`. `Shift+3` arrives as `#` on a US layout and `£` on a
UK one, so a binding written against the character works on one keyboard and
silently fails on the next. The cost is that a Dvorak layout binds where
QWERTY's key sits, which is the trade every terminal makes and the lesser of the
two. `Ctrl` and `Cmd` are one modifier, because every handler in the window has
always tested `e.ctrlKey || e.metaKey`.

### A binding must carry Ctrl or Alt, or be a function key

Enforced in `SHAPE`, not merely warned about in the UI. These fire while the
composer — a `<textarea>` — has the focus, so a bare letter binding makes that
letter untypeable and the only way back is the file the page exists to save you
from. Function keys are the exception because nothing types them, which is what
lets `F3` be the default for the find repeat.

### The remap table stops at thirteen commands

The window has around forty key handlers. Only these are shortcuts in the sense
worth remapping: a name for a place to go, or for an action, that happens to
have a chord attached. The rest are widget semantics — arrows through a menu,
`Enter` committing a field, `Escape` dismissing what is on top, the `Y`/`A`/`N`
letters on a card that already has the focus. Remapping those means breaking
keyboard navigation.

The Electron shell's `Ctrl+R`, `F12` and zoom are out for a different reason:
they live in `app/main.js`, which is packaged, and shipping a change to it means
`install.ps1` force-closing the user's window.

Two things that *are* preferences about keys became settings rather than
bindings, because each switches a pair of keys at once and a binding cannot say
that: what `Enter` does in the composer, and whether `Ctrl+C` copies in the
terminal.

### The matcher is strict, which changed behaviour

The old conditions tested `e.ctrlKey || e.metaKey` and the key and mostly forgot
Shift, so `Ctrl+Shift+K` opened the filter and `Ctrl+Shift+3` opened the live
board — neither intended. A combo now has to agree about all three modifiers, so
those stop firing and `Ctrl+Shift+3` is free to be bound to something.

`Escape` is not in the catalogue and its ladder is untouched. Adding the Settings
row to it turned up that **Schedules had no row at all** — `Escape` closed the
other four whole-screen panels and left that one up, which reads as the key not
working. Fixed in passing, along with replacing four repeated assignments in
five `show…()` functions with one `closeOtherPanels`: a sixth panel meant editing
five functions that would not have complained about being missed.

### Contextual Ctrl+C, and why it clears the selection

All of it is inside `attachCustomKeyEventHandler`, which only fires for keys
delivered to xterm's own textarea — so "only while the terminal has the focus"
needs no machinery.

Returning `false` makes xterm's `_keyDown` bail *before* it calls
`preventDefault`, which is what makes both halves work: `Ctrl+V` is not sent to
the pty as `^V`, and the browser's native paste still fires and reaches xterm,
which brackets and forwards it. A `clipboard.readText()` branch here would
deliver the text twice — the trap the existing comment about `Ctrl+Shift+V`
already described.

**Clearing the selection after a copy is load-bearing, not tidiness.** Without
it, a selection left in the scrollback makes every `Ctrl+C` a copy and the
runaway process never gets its interrupt. With it, the first copies and the
second interrupts.

Off by default for the same reason: on, a stray selection turns an interrupt into
a copy, and that is not a surprise to hand somebody who did not ask for it.

### Taking effect without a reload

`README.md` admitted the live-board settings needed a page reload, because
`liveCompact()`/`liveHideElsewhere()` read `BOOT_PREFS` — a `<meta>` tag baked at
serve time. A save now folds the new values into that object and repaints, and a
`prefs` SSE event does the same in every other window; two are routinely open
here.

A change under `transcript` additionally re-opens the session, because nothing
re-renders history: the folding decisions were made while the rows were built.

`BOOT_PREFS`'s fallback covered only `transcript` and `live`, so
`BOOT_PREFS.spinner.groups` would throw if the tag were ever missing. Invisible
while nothing read it; the panel reads all of it.

## Layout, after two passes

The first version put each control on the left of its label and the scope
pickers at the far right of a full-width bar. Both were wrong and the second
pass is the one to keep:

- **Label left, control right, `Clear` under the control.** The controls then
  form one column the eye can run down. On the left they started wherever their
  own label ended, which is a column that moves.
- **The verb groups break that shape.** A hundred-odd checkboxes have no
  right-hand column that is the right width, so text and `Clear` go across the
  top and the list gets the full measure underneath.
- **Wrapping flex, not a grid, for those pills.** A grid was tried: it gives
  every pill one width, so the column has to fit "Theater / Stage Manager
  Phrases" or clip it, and at that width "Pirate" is mostly space. Natural
  widths pack four or five per line and clip nothing — the rare case where the
  denser layout is also the more readable one. Thirty-eight rows became
  twenty-five with no truncation.
- **Hovering a group lists its verbs**, alphabetised, from `?verbs=1` on the
  existing route. A group name is a theme, not a description; "Kaomoji" tells
  you nothing about what a turn will call itself.
- **One centred column, pickers under the title.** The pickers say *what you are
  editing*, so they belong with the sentence that says what the screen is.
  Across the far corner of a wide bar they read as unrelated chrome.
- **A sticky table of contents.** Five groups and about forty controls; the one
  you came for is rarely the one on screen.
- **No "you set this" stripe on the row.** There was one. At User scope almost
  every row is set, so it ran the length of every group and read as a badly
  drawn border. The right-hand column says it in a word, beside the control it
  belongs to.

## Tests

`test/prefs.test.js`, twenty-five checks and no bridge needed. It sets `HOME`
before requiring anything, which is load-bearing: `bridge/config.js` computes
`USER_PREFS_FILE` at load and `new Prefs()` writes the defaults there, so
requiring it with the real home directory would have the suite rewrite the
settings of whoever ran it. This is why `test/usage.test.js` avoids constructing
`Prefs` at all; this is the file that can, because it owns the directory.

The cases worth naming: one bad binding costs that entry and nothing else; a
project file cannot set `quota` or `keyboard`; a refused patch writes *none* of
itself, including its valid keys; an unparseable target is refused rather than
replaced; a save invalidates the cache it would otherwise be read back through;
and every refusal carries its code.

`test/refusals.test.js` pins the remote refusal on `PUT` and the two reads that
stay open, plus the client header. `test/browser.test.js` pins the `cs-keymap`
tag and the two new routes.
