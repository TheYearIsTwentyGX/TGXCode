# 22 — UI overhaul: tokens, motion presets, and the surface brief

**Effort:** L, in three waves · **Depends on:** nothing ·
**Touches (wave 1):** `web/css/*.css`, `web/motion.js`, every caller of it,
`web/terminal.js`, `web/transcript/layout.js` (a comment)

> Wave 1 built: the token layer, the motion presets, and the mechanical
> migration. Wave 2 — restyling each surface on top of them — is the three
> chunks at the end of this document. **If you are a wave-2 worker, read
> §Rules for wave 2 and your chunk; the rest is reference.**

## Why

The direction is **refine, keep identity**. TGXCode stays dark, dense and
tool-like: tonal surfaces rather than borders, pill controls, one restrained
blue. It is not getting a new art direction. What it lacked was a *system*
underneath: the values were right often enough that the app looked designed, and
inconsistent often enough that every new surface invented its own.

Measured before wave 1 (grep over `web/css/`, 15 files, ~10,000 lines):

| | Before | After wave 1 |
|---|---|---|
| Hex colours outside `:root` | ~110, ~60 distinct | 5, all deliberate (see *Exceptions*) |
| Distinct font sizes | 21 (8–26px, half-pixel steps 10.5–13.5 used 200×) | 9 tokens, plus headings and glyph sizes left for wave 2 |
| Line-heights | 1, 1.2, 1.3, 1.35, 1.4, 1.45, 1.5, 1.55, 1.6, 1.65, 1.7, 1.9, 16/17/19/24/26px | 1.3/1.4/1.5/1.6 tokenised; the rest are wave 2's |
| Floating shadows | 6 variants of "menu" | 5 named elevations |
| z-index | raw 50/60/70/80 | 4 named window-wide layers |
| Entrance animations | 6 near-identical keyframes, most **doubled** with a JS animation on the same node | one module, ten presets, one entrance per surface |
| Easing | one curve for enter and exit; exits as long as entries | `--ease-out` in, `--ease-in` out, exits shorter |
| Reduced motion | JS motion zeroed: fades vanished along with the movement; a per-file block beside most entrances | presets keep a short fade and drop travel, scale and height |
| Spacing | gap/padding/margin values 1–15px with every odd step (7, 9, 11, 13 everywhere) | scale defined; **applying it is wave 2** |

Things seen in the screenshots that are not values but are worth fixing (each is
in a chunk below):

- The top bar overflows at 1440px. The settings icon button flex-shrinks into a
  narrow capsule, and the overflow `⋯` button is cut off at the right edge.
- The composer drew a hard rectangular focus ring inside its rounded field. This
  is fixed in wave 1: the field's own `:focus-within` lift is the focus state.
- The Start-a-session dialog at 900px tall opens scrolled, with the first field
  label clipped under the head and nothing separating head from body.
- With the orchestrator dock open, the transcript above it gets about 200px, and
  its first line runs under the conversation header.
- Card actions on the boards are rows of identical full-width buttons ("Open",
  "Run now / Resume / Edit / Delete" in a 2×2 grid). Primary and secondary look
  alike.
- Uppercase tracked overlines (WORKSPACE, PAUSED, DONE, CLAUDE-SESSIONS,
  RECENT ACTIVITY) appear on most surfaces at 10–11px.
- Toasts are the only light surface in the app, so they read louder than they
  mean.

## Design: the token layer

All tokens are in `web/css/base.css`, in two `:root` blocks. Anything not listed
here is not a token: do not invent one in a surface file. If you need one, see
§Rules.

### Colour (the first `:root` block — the dark theme)

The first block is every colour the app uses. **A light theme is a second copy of
that block under `:root[data-theme="light"]` and nothing else**, which holds only
while no other file writes a colour literal. Do not add a global
`color-scheme`: `boards.css` explains why (it repaints every scrollbar and
native control). Set it per surface where a native control needs it, as
`boards.css` and `orchestrator.css` do.

| Token | Use it for |
|---|---|
| `--bg`, `--s1`…`--s6` | Surfaces, by elevation. `--bg` is the page and `--s1` the rail and cards on it. `--s2` is controls at rest, `--s3` hover or a raised panel, `--s4` hover on `--s3`, `--s5` an idle edge, `--s6` the top (scrollbar thumb under the pointer, an idle dot). **Hover is one step up from rest.** |
| `--outline`, `--outline-soft` | The rare hairline. Prefer a surface step. |
| `--text`, `--text-2`, `--text-3`, `--text-4` | Primary, secondary, meta, quietest. Four levels, no more. |
| `--blue` | The accent: links, selected, primary action, focus. |
| `--blue-deep` | A solid primary fill under white text (`--on-blue-deep`). |
| `--blue-cont`, `--blue-cont-hover`, `--blue-cont-active` | A selected row or pressed toggle, its hover, and pressed/menu-open. |
| `--on-blue`, `--on-blue-cont`, `--on-blue-cont-2`, `--on-blue-cont-3` | Text on solid `--blue`; text on a blue container at title, secondary and meta strength. |
| `--blue-tint` | A faint blue ground, for an inactive "primary". |
| `--red`, `--red-cont`, `--red-cont-hover`, `--red-soft`, `--on-red` | Destructive and failed. `-cont` is a destructive hover or a failed row. `--red-soft` is red text read at length (error output). |
| `--yellow`, `--yellow-tint`, `--yellow-cont`, `--yellow-cont-hover`, `--yellow-cont-strong`, `--on-yellow` | Needs-you and warning. `-tint` is a whole card asking for you; `-cont` a warning chip. |
| `--green`, `--green-tint`, `--green-edge` | Live, ok, added. `--green-edge` is a muted green accent edge. |
| `--purple`, `--peach` | Two status hues already in use (PRs, pending). Not accents. |
| `--amber-cont` | The dev badge only. |
| `--mark-bg`, `--mark-fg` | Find-in-page matches. Amber, so a match never reads as a selection. |
| `--selection`, `--on-selection` | `::selection` and the terminal's selection. |
| `--scrim`, `--scrim-strong` | Behind a dialog; the darker base the project tint mixes into. |
| `--recess` | A keycap sunk into a button of any colour. |
| `--scroll-thumb`, `--scroll-thumb-hover` | Scrollbars. |
| `--inverse-bg`, `--inverse-fg`, `--inverse-{err,ok,warn}-{bg,fg}` | Toasts, the one light surface. |
| `--syn-*` | Syntax roles: comment, punct, string, regex, number, keyword, builtin, fn, type, var, flag, add, del. `.tok-*` in `tools.css` maps the highlighter's token names onto these. |
| `--diff-{add,del}-{bg,fg,hl,edge}`, `--diff-change-bg` | Diff lines, shared by `tools.css` and the diff2html overrides in `viewers.css`. |
| `--focus-colour` | The focus ring. |

**Project colour** is not a token. It is `--proj-accent`, set inline by script,
and every rule that uses it hangs off `[data-tinted]` (see `colours.css`). Mix it
with `color-mix(in srgb, var(--proj-accent) N%, var(--s2))`, never against
`transparent`.

**Exceptions**, which are the only colour literals left outside `:root`:
- the device frame in the preview pane (`#fff` page, `#0004` home bar), because
  a web page is white;
- the label on a project-colour swatch (`colours.css`, `#000000b8` and
  `#0000004d`), drawn over whatever colour somebody picked;
- `web/terminal.js`'s ANSI palette (cyan and the bright variants), which is
  xterm's, not ours.

### Type

| Token | px | Role |
|---|---|---|
| `--fs-2xs` | 10 | Tiny badges, the kbd hint in a button |
| `--fs-xs` | 11 | Mono meta (timestamps, paths, branches, counts), uppercase overlines, chips |
| `--fs-sm` | 12 | Sans meta lines, captions, short mono labels |
| `--fs-md` | 13 | UI labels, buttons, secondary sentences, code blocks, form controls |
| `--fs-base` | 14 | Body and prose, list and card titles, field contents, toasts |
| `--fs-lg` | 16 | Section titles |
| `--fs-xl` | 18 | — (available) |
| `--fs-2xl` | 21 | Page titles (Task board, Settings, Work in flight) |
| `--fs-3xl` | 26 | Display |

- **Monospace is one step under the sans beside it.** Mono reads larger at the
  same size, so a branch name next to 12px meta is 11px, and a code block in
  14px prose is 13px.
- Line-heights: `--lh-none` 1 (single-line controls), `--lh-tight` 1.3 (titles),
  `--lh-snug` 1.4 (UI text), `--lh-base` 1.5 (multi-line UI), `--lh-prose` 1.6
  (reading).
- Weights: `--fw-regular` 400, `--fw-medium` 500, `--fw-strong` 600. Hierarchy
  comes from size, colour and weight together. Do not add 700.
- In a `font` shorthand: `font: 500 var(--fs-sm)/var(--lh-snug) var(--sans);`.
- Use `font-variant-numeric: tabular-nums` on anything that counts or ticks.

**How the half-pixel sizes were mapped** (wave 1, by role, not rounded one way):

| From | To | Role |
|---|---|---|
| 13.5 | 14 | Titles and readable text |
| 13.5 | 13 | Button labels |
| 12.5 | 13 | Labels, controls, secondary sentences, code |
| 12.5 | 12 | Short mono labels |
| 11.5 | 12 | Sans meta |
| 11.5 | 11 | Mono meta, uppercase overlines |
| 10.5 | 11 | Badges |

**Left for wave 2:** headings at 15, 19 and 20px (dialog title, conversation
title, settings group title, wordmark, diff title, empty-state heading) and glyph
sizes (8, 8.5, 9px; the 15px ✕ in close buttons). Put headings on `--fs-lg`,
`--fs-xl` or `--fs-2xl` by role. The conversation title and page titles should
agree. Glyph sizes may stay literal.

### Spacing, radii, layers, elevation, focus

- **Spacing** — `--sp-1` 2 · `--sp-2` 4 · `--sp-3` 6 · `--sp-4` 8 · `--sp-5`
  10 · `--sp-6` 12 · `--sp-7` 16 · `--sp-8` 20 · `--sp-9` 24 · `--sp-10` 32.
  *Defined, not yet applied.* Every surface uses odd steps (5, 7, 9, 11, 13,
  15px). Snapping them is wave 2's main job; see each chunk's list. Optical
  adjustments of ±1px are allowed, but write a comment when you keep one.
- **Pane inset** — `--pane-x` 28 (added by chunk A). The horizontal inset of a
  pane in the main column: the conversation header and the log use it, and the
  composer, the docks above it and the board heads should. A layout dimension
  like `--gutter` and `--rail`, not a spacing step.
- **Radii** — `--r-2xs` 3 · `--r-xs` 6 · `--r-sm` 8 · `--r` 12 · `--r-lg` 16 ·
  `--r-xl` 24 · `--pill`. **Inner is one step under outer:** a button in a 12px
  card is 8px or a pill, never 12px. Strays left: 1, 2, 4, 5, 9px in a few
  places (listed per chunk), and the preview device frames, which keep real
  device radii.
- **Layers** — `--z-scrim` 50 · `--z-pop` 60 (menus, popovers) · `--z-over` 70
  (the context menu, over dialogs) · `--z-toast` 80. Layers inside one panel
  (2–5) stay literal; they are that panel's business.
- **Elevation** — `--shadow-1` (a lift under hover) · `--shadow-toast` ·
  `--shadow-pop` (every menu and popover) · `--shadow-float` (a bar floating over
  content, with a hairline) · `--shadow-dialog`. Accent edges are
  `inset var(--edge-w) 0 0 <hue>`.
- **Focus** — the global `:focus-visible` is `--focus-w` solid `--focus-colour`
  at `--focus-offset`. Text fields use `box-shadow: var(--ring-inset)`. A field
  whose container lifts on `:focus-within` (composer, search, live-card reply)
  draws no ring of its own; that rule is in `base.css`. **Never `outline: none`
  without a replacement on the same rule.**
- **Press** — compact buttons (`.btn`, `.btn-send`, `.bar-btn`, `.icon-btn`,
  `.mini`, `.perm-btn`, `.tb-btn`, `.lbtn`, `.seg-btn`, `.more-btn`,
  `.dash-btn`, `.quota-pill`, `.db-status`) get `scale: 0.97` on `:active`, from
  one rule in `base.css`. A new compact button class should be added to that
  list, not given its own press rule. Leave full-width rows out.

## Design: motion

### The tokens

| Token | Value | Use |
|---|---|---|
| `--dur-press` | 90ms | Reserved for a press transition, if one is ever wanted |
| `--dur-fast` | 120ms | Colour and opacity transitions (hover), every exit, small popovers |
| `--dur-base` | 180ms | A menu or dock opening, a list re-sorting, things arriving |
| `--dur-slow` | 240ms | A dialog arriving |
| `--dur-loop` | 1.6s | One breath of a pulsing status dot |
| `--dur-flash` | 1.3s | The highlight on whatever a jump landed on |
| `--ease-standard` | `cubic-bezier(.2,0,0,1)` | Something on screen changing: colour, position, size |
| `--ease-out` | `cubic-bezier(.05,.7,.1,1)` | Something arriving |
| `--ease-in` | `cubic-bezier(.3,0,.8,.15)` | Something leaving |
| `--ease-linear` | `linear` | Constant-rate loops only |

`--t-fast`, `--t-med` and `--ease` remain as aliases of fast, base and
standard. New CSS should use the new names.

### The presets (`web/motion.js`, `PRESETS`)

Call with `as`: `present(node, show, { as: 'menu' })`.

| Preset | For | In | Out | Reduced motion |
|---|---|---|---|---|
| `menu` | Any menu or popover off a trigger: bar menus, project and sort menus, slash, snippet, later, Wispr, the context menu, the turn and PR hover cards | from `translateY(-4px) scale(.98)`, base + out | fast + in | fade |
| `drop` | A bar sliding down from its pane's top edge (find) | from `translateY(-6px)`, base + out | fast + in | fade |
| `dialog` | A modal's box, via `pose(box, 'in'\|'out')` | from `translateY(8px) scale(.98)`, slow + out | fast + in | fade |
| `scrim` | A modal's backdrop | fade, base + out | fast + in | fade |
| `toast` | Toasts; `exit(t, { as: 'toast', collapse: true })` closes the gap | from `translateY(8px)`, base + out | base + in | fade, no collapse |
| `arrive` | Something new in the flow: a board switched in, a transcript entry, the plan pane, the subagent view | from `translateY(6px)`, base + out | fast + in | fade |
| `reveal` | Content appearing in place, with no movement | fade, base + out | fast + in | fade |
| `dock` | `grow()`, `morph()` and `fill()`: docked panes and header strips changing height | height, base + standard | same | instant |
| `reorder` | `flip()` and `flipAll()` | translate, base + standard | — | instant |
| `crossfade` | `swap()` | from opacity .25, fast + standard | — | fade |

**When not to animate.** Keyboard-driven actions (switching sessions with a
shortcut, moving through a list) and anything that happens many times a minute
should be instant. Hover is a colour transition at `--dur-fast`, never movement.
A container that enters gets one entrance: do not also animate its children. A
surface animated by motion.js must not also carry a CSS `animation`. Wave 1
found almost every popover doing both and removed the CSS half.

**CSS or JS?** Use a CSS `transition` for state a pointer drives (hover,
`[aria-expanded]`, a caret turning). Use a CSS `@keyframes` for an autonomous
loop (status dots) or a one-shot entrance on a node nothing else animates
(`.perm`'s `perm-in`). Use motion.js for anything shown or hidden by `hidden`,
anything removed from the DOM, and anything that has to reverse from where it
is.

**Reduced motion.** `base.css` cuts every CSS transition and animation under the
query; loops end on their last frame. motion.js does not snap: travel, scale and
height go, and a ≤120ms opacity change stays, because the fade is often the only
sign that something changed. A surface that needs a reduced variant beyond that
(the quota pill's flash holds a static ring instead) writes its own block next to
the rule.

**Interruption.** Unchanged. Reopening something mid-exit plays the entry from
the current frame, and `hidden` is written only by an exit that finished.
`isUp()` is the honest "is it showing" check.

## Rules for wave 2

Three workers branch from this branch before it merges and run at the same time.
These rules keep them out of each other's way.

1. **Own your files; ask for anything else.** Each chunk below lists the files
   it may edit. A change you need in a file another chunk owns goes in your PR
   description as a request, not as an edit. The shared files are handled like
   this:
   - `web/css/base.css` — **the two token blocks are frozen.** Do not change a
     token's value or name. If you need a new token, add it on its own line at
     the *end* of the second `:root` block (scales) or the first (colours), under
     a comment naming your chunk, and say so in the PR. Two chunks adding
     different lines there merge cleanly. The shell below the tokens (bar,
     quota, menus) is chunk A's.
   - `web/motion.js` — do not change existing presets or functions. A new
     preset, if you really need one, goes at the end of `PRESETS` with a line in
     the header table and in this document.
   - `web/index.html` — edit only the markup of your own surfaces.
   - `web/css/narrow.css` — chunk A's. B and C put narrow-window rules in a
     `@media` block at the end of their own files.
   - `web/app.js` — touch only what your surface needs, and keep it small. It is
     the file most likely to conflict.
2. **No literals.** No hex, no `rgb()`, no px font sizes on the scale, no raw
   shadows or z-layers 50–80 in anything you write or touch. Snap spacing to
   `--sp-*` in every rule you touch. A ±1px optical exception gets a comment.
3. **No layout regressions as a side effect of type.** If a 0.5px change from
   wave 1 broke something on your surface, fix it there.
4. **Behaviour is not yours to change.** Restyle; do not rewire. The
   functionality and the DOM contracts that tests and JS read stay as they are.
   Check with `npm test` and by using the surface.
5. **Verify on your own dev port** (`npm run dev -- --port=…`, labelled in
   DevBrowser), with before/after screenshots at 1440×900 and at a narrow window
   (~1000px) in your PR. Check reduced motion with Playwright's
   `emulateMedia({ reducedMotion: 'reduce' })`.
6. **Keep identity.** Dark, dense, tonal, pill controls, one blue. Do not add
   gradients, glass, grain, a new typeface, or a second accent. Spend boldness
   on hierarchy, not decoration.

## Wave 2 chunks

### A — rail, transcript, top bar

**Owns:** `web/css/rail.css`, `transcript.css`, `tools.css`, `viewers.css`,
`narrow.css`, and `base.css` below the token blocks (bar, quota pill and menu,
version pill). JS: `web/rail.js`, `web/transcript/*` except `approvals.js`,
`web/terminal.js`, `web/term-pane.js`, `web/quota.js`, `web/channels.js`,
`web/commands.js`, `web/pr-refs.js`, `web/settings/toolbar.js` (the bar's
overflow).

- **Top bar overflow (a bug).** At 1440px the icon-only settings button
  flex-shrinks into a narrow capsule and the `⋯` overflow is clipped at the
  right edge. Bar buttons should be `flex: none`, and `paintToolbar()`'s overflow
  should take the room instead. Check at 1200 and 1440.
- **Bar hierarchy.** Eight pills of equal weight. Group the window-level state
  (quota, version, DevBrowser) apart from the navigation (History, Schedules,
  Drafts, Dashboard). The active panel's `.on` is the only blue on the bar; keep
  it that way.
- **Rail rows.** Spacing off-scale throughout (7, 9, 11, 14, 18, 22px). The
  title is now 14px and wraps to two lines often, so decide whether rows clamp
  at one line plus meta. The meta line mixes a mono worktree name with sans
  times and counts joined by middots: give it one rhythm (mono 11 + sans 12 is
  the rule). Use `--blue-cont-*` and `--on-blue-cont-*` for the selected row
  only.
- **Rail groups.** The project card's left accent edge, the uppercase-free
  heads, and the Scheduled sub-group all differ in padding. Unify.
- **Conversation header.** Nine icon buttons in one undifferentiated row. Group
  them (session actions against destructive), and bring `.conv-title` (20px) to
  `--fs-2xl` to agree with the board titles. The breadcrumb `.conv-sub` mixes
  mono and sans, as the rail meta does.
- **Transcript entries.** Tool rows draw a status dot *and* a disclosure caret
  before every summary (`• ▸`). Pick one affordance. Gutter timestamps are mono
  11 at line-height 1.9 (`.ev-time`), so align them to the first line of the
  entry instead. The "running in another window" banner and the worker badge
  are hand-rolled: use `--yellow-cont` and `--blue-tint` grounds.
- **Strays.** `transcript.css` has radii of 1px and 2px, a 6.5px spacing, and the
  most off-scale spacing values of any file (60). `tools.css` has `.tok-*`
  already mapped, so leave it.
- **Motion call sites you own:** `transcript/conversation.js` (`reveal`,
  `arrive`), `subagents.js` (`arrive`, `reveal`), `find.js` (`drop`),
  `turn-rail.js` and `pr-refs.js` (`menu`), `context-menu.js` (`menu`),
  `rail.js` (`flipAll` → `reorder`), `term-pane.js` (`grow` → `dock`).

### B — composer, dialogs, prompts and approvals

**Owns:** `web/css/composer.css`, `dialogs.css`, `prompts.css`, `colours.css`.
JS: `web/composer/*`, `web/new-session/*`, `web/snippets/*`,
`web/transcript/approvals.js`, `web/transcript/review.js`, `web/dom.js` (toast,
modal), `web/github/publish.js`, `web/drafts.js`.

- **Composer focus.** Wave 1 removed the inner ring. The only focus state now is
  the field's ground lifting `--s2`→`--s3`. Decide whether it also needs a quiet
  container edge (a 1px `--outline` inset, not a blue ring: this field has focus
  most of the day).
- **Composer controls.** Send, LGTM, the snippet, later, attach and Wispr
  buttons are different heights and shapes in one row. Make one height and one
  radius, and make Send the only filled one. The model, effort and permissions
  selects below read as plain text: give them the `--s2` control ground used
  elsewhere.
- **Start-a-session dialog.** At 900px tall it opens scrolled, with "Working
  directory" clipped under the head. The head needs a separator (a surface step
  or `--shadow-1` when scrolled), and the body needs scroll padding. The footer's
  four buttons should be one primary (Start), one secondary, and text buttons.
  Project tint rules are in `colours.css`; keep them under `[data-tinted]`.
- **Dialog titles.** `.modal-head` is 20px, so put it on `--fs-xl` or
  `--fs-2xl`. The close ✕ is a 15px glyph in a 34px circle; keep it but align
  it to the title's first line.
- **Toasts.** The only light surface in the app. Decide: keep the inverse
  (`--inverse-*`) and tone the shadow down, or move to a tonal `--s4` toast with
  a coloured `--edge-w` edge per kind. Either way, the entrance and exit are
  `toast` in `dom.js`; do not add CSS animation.
- **Approvals.** `.perm` keeps its own CSS entrance (`perm-in`, base + out).
  It is the one card not shown through motion.js; keep it single. The
  allow/deny buttons use `--blue-cont-hover`/`--red-cont`. Make the keyboard
  hints (`kbd` on `--recess`) consistent across perm, ask and plan. The ask
  dock and plan pane enter through motion.js (`dock`, `arrive`). Spacing here
  is mostly 5/7/9/11/13px: snap it.
- **Strays.** `composer.css` has 44 off-scale spacing values and glyph sizes of
  8.5px and 9px (the file-type glyph, keep them). `dialogs.css` has 42.
- **Motion call sites you own:** `dom.js` (`scrim`, `dialog`, `toast`),
  `composer/slash.js`, `later.js`, `wispr.js`, `snippets/popover.js`,
  `new-session/recent.js` (`menu`), `composer/send.js` (`arrive`),
  `transcript/approvals.js` (`reveal`, `arrive`, `dock`).

### C — boards, settings, orchestrator

**Owns:** `web/css/boards.css`, `dashboard.css`, `settings.css`,
`orchestrator.css`, `preview.css`. JS: `web/boards/*`, `web/settings/*` except
`toolbar.js`, `web/orchestrator.js`, `web/schedules.js`, `web/notifications.js`,
`web/preview.js`, `web/preview-picker.js`.

- **Card actions.** Task board, schedules and live cards end in rows of
  identical full-width buttons ("Open"; "Run now / Resume / Edit / Delete" as a
  2×2 grid). Give each card one primary action, with the rest as quiet text or
  icon buttons, and pin actions to the card foot so they line up across a row.
- **Overlines.** Uppercase tracked labels (PAUSED, DONE, CLAUDE-SESSIONS,
  RECENT ACTIVITY, the settings TOC categories) are the most repeated device on
  these surfaces. Keep them where they head a list. Where they label a single
  value, sentence case at `--fs-sm` `--text-3` reads better.
- **Board headers.** Title 21px, then a one-line summary, then Refresh. Align
  every board to this (task board, dashboard, schedules, drafts, history) and
  use the same column-head treatment on the task board and the live board.
- **Live board cards.** The title is 14px now. The card's accent edge, state
  line and facts line use three different spacings. `.lchip` is mono 11 on a
  17px line-height.
- **Dashboard.** Project cards with a tinted top edge (`--proj-accent`) and rows
  of worktrees. The `.sig` chips (`dirty`, `bad`) are on `--yellow-cont-*` and
  `--red-cont`. The PR chips on the right are a different height from the
  `.sig` chips.
- **Settings.** 1,416 lines, and the most off-scale spacing (81 values). The
  group title is 15px (`--fs-lg`). The TOC categories are uppercase 11. Rows
  alternate between label-left/control-right and stacked. Unify on one row
  anatomy. `--set-s*` remaps the surface ramp inside settings; keep that idiom
  rather than adding colours.
- **Orchestrator dock.** With it open, the transcript gets about 200px at 900px
  tall, and its top line runs under the conversation header. Cap the dock's
  height and let it scroll. Section heads are collapsible rows with mono meta
  right-aligned; `.orch-kind` is mono 11 on a 17px line-height. The dock grows
  through `grow`/`morph` (`dock`). A placeholder glyph in "□ 1 item waiting"
  renders as tofu in some fonts, so check `orchestrator.js`'s icons.
- **Preview pane.** Device frames keep their literal radii and white page. The
  0.35s device-resize transition is the one long duration in the app and is
  deliberate (large travel). Leave it, or move it to `--dur-slow` if it reads
  slow.
- **Motion call sites you own:** `orchestrator.js` (`grow`/`morph` → `dock`),
  `boards/parts.js` (`flipAll` → `reorder`, for cards moving between columns).
  A board switching in is `enter(n, { as: 'arrive' })` in `app.js`; keep it.
  `quota.js` belongs to chunk A.

## Wave 3

The command palette, transcript minimap, orchestrator view and session templates
are planned separately. They use the tokens and presets above, and do not add
their own.
