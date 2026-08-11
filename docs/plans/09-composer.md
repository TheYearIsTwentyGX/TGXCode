# 09 — Composer

**Effort:** M · **Depends on:** none · **Touches:** `web/app.js`,
`web/index.html`, `web/styles.css`, `bridge/server.js`, `bridge/runner.js`

Five related changes to the box you type in. Grouped because they share the
input element, the keyboard map, and the draft-persistence machinery.

The existing draft handling (`app.js:140-166`) is careful work — text survives a
reload, a crash, and a failed turn. Everything here must preserve that.

## A. `@` file mentions and `/` command completion

**Why.** The transcript *renders* slash commands (`parseCommand`,
`transcript.js:383`; `renderUser`, `app.js:486`) but the composer offers no help
typing one, and there is no way to reference a file except by typing its path.

**Design.**

- `@` opens a file picker scoped to the session's `cwd`. New endpoint
  `GET /api/sessions/:id/files?q=` — a prefix/fuzzy match over the working
  directory, respecting `.gitignore`, capped and debounced. The bridge is
  already the filesystem side of the app (`listDir`, `server.js:374`); this is
  the same idea with matching instead of listing.
- `/` at the start of an empty composer opens a command list from
  `~/.claude/commands`, the project's `.claude/commands`, and plugin commands.
  Read the directory names; do not try to reimplement resolution.
- Both render as an inline popover above the composer, `↑`/`↓`/`Enter`/`Esc`,
  same visual language as the new-session project picker (`.picker-row`).
- Insert plain text — `@path/to/file` — not a rich token. Claude Code parses the
  text; a widget would just be something to get out of sync.

## B. Images

**Why.** `renderUser` displays images from the transcript
(`app.js:496-499`, `imageRef` in `transcript.js:373`) but you cannot send one.
Screenshots are half of frontend work.

**Design.**

- Paste and drag-drop onto the composer.
- Thumbnail strip above the input with remove buttons.
- Send as a content block array rather than the current text-only shape. This
  changes `_flushQueue` (`runner.js:147`), which currently hardcodes:

  ```js
  message: { role: 'user', content: [{ type: 'text', text }] }
  ```

  Generalize `send(text)` to `send(content)` where content is a block array,
  keeping a string overload so nothing else changes.
- Cap total payload; `readJson` already refuses bodies over 4MB
  (`server.js:415`) — downscale large screenshots client-side before that limit
  rather than failing at it.

## C. Visible send queue

**Why.** `Runner.queue` (`runner.js:57`) accepts messages while busy and nothing
in the UI shows them. `status()` reports `queued: this.queue.length` and it is
never rendered. You can type three follow-ups and have no evidence they exist.

**Design.**

- Chips under the composer, one per queued message, with the text clipped.
- Remove a queued message before it is flushed — `DELETE
  /api/sessions/:id/queue/:index`, which splices `runner.queue`.
- Reorder by drag, same endpoint family.
- Once flushed to stdin it moves to `inFlight` and is no longer cancellable —
  show that transition (the chip goes solid) rather than pretending.

## D. Retry and edit-resend

**Why.** `handleSendFailure` (`app.js:1082`) hands text back to the box, which
is good, but there is no one-click retry, and no way to re-run a turn with a
tweak.

**Design.**

- On a failed send, the toast already offers "Branch off a copy" for
  `busy-elsewhere`. Add a plain **Retry** action for other kinds.
- On any of your own turns in the log: **Edit and resend** — copies the text
  into the composer. Combined with plan 08, offer **Edit and branch here**,
  which is the version that doesn't duplicate context.

## E. Snippets

**Why.** Low-effort, high-frequency. The same three or four prompts get typed
repeatedly.

**Design.**

- Stored in `~/.local/share/claude-sessions/snippets.json` — ours to own,
  alongside `flags.json`.
- `Ctrl+/` opens the list; insert at cursor.
- Simple `{{cwd}}`, `{{branch}}`, `{{selection}}` substitution, resolved from
  the current session's summary.
- Also offered in the new-session dialog, where a starter prompt is required
  anyway (`startNew`, `app.js:1130` refuses an empty prompt).

## Keyboard map after this plan

| Key | |
|---|---|
| `Ctrl+Enter` | send (unchanged) |
| `@` | file completion |
| `/` (empty composer) | command completion |
| `Ctrl+/` | snippets |
| `↑` (empty composer) | edit your last message |
| `Esc` | close any popover |

`↑` is worth calling out: it is the one addition that changes existing
behaviour, so make it only fire on an empty composer with no popover open.

## Acceptance

- Typing `@run` in a session offers `bridge/runner.js` and inserts its path.
- Pasting a screenshot sends it and it renders in the transcript.
- Three messages typed during a long turn appear as chips; removing the middle
  one works and the other two still send in order.
- Every existing draft guarantee still holds: reload mid-typing, crash
  mid-typing, and a failed send all preserve the text.
