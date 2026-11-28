# Vendoring a browser library

`package.json` has `"dependencies": {}` and `web/` has no build step, on purpose
(CLAUDE.md §*No dependencies, no build step* says why). When a library genuinely
earns its place, it goes in `web/vendor/` as a **prebuilt bundle, committed**.
Today that is xterm (and its fit addon), diff2html for the diff viewer, and Preact
for the rail.

## Fetching one

Use `npm pack`, which writes a tarball and leaves no `node_modules`. Never
`npm install`.

```bash
npm pack diff2html@3.4.56 --pack-destination /tmp
tar -xzf /tmp/diff2html-3.4.56.tgz -C /tmp
cp /tmp/package/bundles/js/diff2html.min.js   web/vendor/diff2html.js
cp /tmp/package/bundles/css/diff2html.min.css web/vendor/diff2html.css
cp /tmp/package/LICENSE.md                    web/vendor/LICENSE.diff2html
```

## What may land in `web/vendor/`

- **A prebuilt browser bundle, or nothing.** A package that ships only `cjs`/`esm`
  with bare imports needs a bundler to become one. That is what ruled out
  `react-diff-viewer-continued`, which was the preferred diff library on the merits.
- **Renamed to plain `.js` and `.css`**, whatever it ships as: xterm dropped `.mjs`,
  diff2html dropped `.min.js`. The bridge's MIME table already knows those two
  extensions, so adding a file needs no bridge change and no restart (the comment
  above the imports in `web/terminal.js` says the same).
- **With its licence beside it** as `LICENSE.<name>`, and **its version recorded**
  in a comment: in the CSS block that themes it, or the header of the file that
  loads it. The next upgrade should be a diff against a known base.
- **Never from a CDN.** The CSP `<meta>` in `web/index.html` is `default-src 'self'`,
  so a remote script, stylesheet or font is refused. The page still loads; the
  feature is just missing, with a console message as the only sign.

## Check the footer before you decide how to load it

`head -c 200` and `tail -c 200` the file.

- **It ends in `export{…}`: ESM.** Import it. `xterm.js` is the ESM build renamed
  (`export{Dl as Terminal}`), and `web/terminal.js` imports it normally.
- **It opens `!function(e,t){…}(this, …)`: UMD.** It assigns its global off the
  `this` it was called with, and top-level `this` in a module is `undefined`, so
  `import './vendor/diff2html.js'` throws before `app.js` runs a line. Load it with
  a classic `<script>` before the module script (as `web/index.html` does) and read
  `window.Diff2Html` at call time.

Both loads carry a comment saying which and why. The UMD one looks like something
to tidy up, and tidying it up crashes the page on load.

## Preact

`web/vendor/preact.js` is htm 3.1.1's `preact/standalone.module.js`: Preact 10, its
hooks and htm in one ESM file with no `eval`, so the CSP accepts it. It carries no
version string of its own; `web/rail.js`'s header records what is known. The
licences are in `LICENSE.preact`, and **htm is Apache-2.0, not MIT**, so both texts
are there.

`web/rail.js` is the pattern for moving a surface over; the rest of `app.js` still
builds DOM by hand with `el()`.

- **No JSX.** Components are `` html`<div class=${…}>…</div>` ``, which htm turns
  into `h()` calls at runtime. Attributes are written the DOM's way (`class`,
  `aria-*`, `data-*`); events are `onClick`, `onDragStart`.
- **State stays in `app.js`'s `state`.** A render is a plain synchronous
  `render(tree, container)` from the existing entry point, so callers do not
  change. Builders are ordinary functions returning vnodes; use hooks only for
  state a piece genuinely owns.
- **Key every list child** by something stable (`sessionId`, a group key). Keys
  are what keep a node, with its hover, focus, animation and in-flight click,
  across an update. Electron 31 is Chromium 126, which has no `moveBefore`, so a
  node that actually moves can still lose focus.
- **Do not touch rendered DOM by hand.** No `setAttribute`, `classList` or
  `insertBefore` on nodes Preact owns: it diffs against its last vnode, not the
  DOM, so a hand edit is undone later or never. Put the fact in `state` and
  re-render. The rail's drag-to-reorder works this way (`state.railDrag.order`).
- A `null` prop is written as an empty DOM property, so you will see `title=""`
  and `draggable="false"` where `el()` left the attribute off. That is harmless,
  but do not write CSS that depends on those attributes being absent.
