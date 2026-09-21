'use strict';

// How wide the transcript lays itself out — `nextLogWidth` in web/app.js.
//
// The function that decides the number is pure, and it is the half of this
// feature whose mistakes are silent. A log a step *wider* than its pane stops
// being a frozen width at all: `min()` falls through to the `100%` floor in
// styles.css, the width resolves from the pane again, and every column that
// slides in is back to re-laying out two thousand rows a frame. That reads as
// "the fix did nothing" rather than as a bug, so it is worth a test.
//
// **Lifted out of web/app.js as text, and deliberately.** `web/` has no build
// step and app.js is a browser module that touches the DOM on the way in, so
// there is nothing here to require; the alternative is a module of its own for
// one expression, which README §Layout would then have to carry. The slice is
// anchored on the two constants and the function's own name, so a rename breaks
// this loudly rather than quietly testing nothing — which is what the first
// assertion below is for.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const slice = /\nconst LOG_MAX = [\s\S]*?\nfunction nextLogWidth\([\s\S]*?\n}\n/.exec(src);
assert.ok(slice, 'web/app.js no longer has LOG_MAX and nextLogWidth where this test looks');

const { nextLogWidth, LOG_MAX, LOG_STEP } =
    new Function(`${slice[0]}\nreturn { nextLogWidth, LOG_MAX, LOG_STEP };`)();

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// --- the cap -------------------------------------------------------------
// Above the cap the pane's width stops mattering, which is the behaviour the
// old `max-width` had and the one nothing here may change.
assert.strictEqual(nextLogWidth(LOG_MAX), LOG_MAX);
assert.strictEqual(nextLogWidth(LOG_MAX + 600), LOG_MAX);
assert.strictEqual(nextLogWidth(LOG_MAX + 600, { live: true }), LOG_MAX,
    'a drag must not quantize a width that is already at the cap');
ok('space at or above the cap always gives exactly the cap');

// --- below the cap -------------------------------------------------------
assert.strictEqual(nextLogWidth(742), 742);
assert.strictEqual(nextLogWidth(742.9), 742, 'a fractional pane must round down, never up');
ok('a click gets the exact width the space allows');

// --- the drag ------------------------------------------------------------
// The one that matters: quantized *down*, so the log is a little narrower than
// its pane and never a pixel wider.
for (let avail = 60; avail < LOG_MAX; avail += 7) {
    const w = nextLogWidth(avail, { live: true });
    assert.ok(w <= avail, `${avail} gave ${w}, which overhangs the pane`);
    assert.ok(avail - w < LOG_STEP, `${avail} gave ${w}, more than a step of gutter`);
    assert.strictEqual(w % LOG_STEP, 0, `${avail} gave ${w}, which is off the step grid`);
}
ok('a drag is quantized down to the step, never past it, never over the pane');

// The point of the step: a drag reports every frame, and 20px of travel has to
// be at most one width change wherever in the range it starts — not eleven.
for (let from = 200; from < LOG_MAX - 20; from += 3) {
    const run = [];
    for (let a = from; a > from - 20; a -= 2) run.push(nextLogWidth(a, { live: true }));
    assert.ok(new Set(run).size <= 2,
        `a 20px drag from ${from} changed the width ${new Set(run).size} times`);
}
ok('twenty pixels of drag is at most one width change, wherever it starts');

// --- the floor -----------------------------------------------------------
// Flooring to the grid must not hand back 0 for a pane narrower than one step;
// the log would collapse and `100%` would take over.
assert.strictEqual(nextLogWidth(30, { live: true }), LOG_STEP);
assert.strictEqual(nextLogWidth(1, { live: true }), LOG_STEP);
ok('a pane narrower than a step still gets a step, not zero');

// --- the invariant the CSS floor rests on --------------------------------
// `.composer-inner` and `.ask-dock-inner` sit inside 28px of padding a side, so
// they resolve 56px below the log. The step has to stay under that or a drag
// could make the log the narrower of the two and the pair would read as
// crooked — see the comment on `.log` in web/styles.css.
assert.ok(LOG_STEP < 56, 'LOG_STEP has grown past the composer inset');
ok('the step is smaller than the composer inset it must not cross');

console.log(`\n${pass} log-width checks passed`);
