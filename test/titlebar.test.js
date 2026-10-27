'use strict';

// The top bar as the window's titlebar — web/titlebar-drag.js, which decides
// whether a press on a bar button is a click or a window drag, and the pure
// parts of app/titlebar.js: the window options per platform, where a maximised
// window lands when it is dragged off the top, and the setting that puts the
// system frame back.
//
// No bridge and no Electron. The state machine's cases are the ones a user
// meets as a misfire: a click that moved the window, a drag that also clicked,
// a second pointer jumping a drag, a press that was cancelled turning into a
// click nobody finished.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

process.removeAllListeners('warning');

(async () => {
    const { pressStep, IDLE, DRAG_THRESHOLD } = await import('../web/titlebar-drag.js');
    const tb = require('../app/titlebar.js');

    /** Run a sequence of events; return every action in order and the last state. */
    const run = (events) => {
        let st = IDLE;
        const acts = [];
        for (const ev of events) {
            const [next, a] = pressStep(st, ev);
            st = next;
            if (a) acts.push(a);
        }
        return { st, acts };
    };
    const down = (x = 10, y = 10, extra = {}) => ({ type: 'down', id: 1, x, y, button: 0, draggable: true, ...extra });
    const move = (x, y, id = 1) => ({ type: 'move', id, x, y });
    const up = (id = 1) => ({ type: 'up', id });

    // ── click vs drag ──
    assert.strictEqual(DRAG_THRESHOLD, 4);
    assert.deepStrictEqual(run([down(), up()]).acts, ['click']);
    assert.deepStrictEqual(run([down(), move(12, 11), move(13, 10), up()]).acts, ['click']);
    ok('press and release without travelling is a click, a jitter included');

    const drag = run([down(), move(14, 10), move(40, 30), up()]);
    assert.deepStrictEqual(drag.acts, ['drag-start', 'drag-end']);
    assert.strictEqual(drag.st.phase, 'idle');
    ok('travel past the threshold starts one drag, and the release ends it without a click');

    // 3,3 is 4.24 away: a diagonal counts its real distance, not each axis.
    assert.deepStrictEqual(run([down(), move(13, 13)]).acts, ['drag-start']);
    assert.deepStrictEqual(run([down(), move(12, 12)]).acts, []);
    ok('the threshold is a distance, so a diagonal starts as soon as a straight line does');

    // ── what may not start a drag ──
    assert.deepStrictEqual(run([down(10, 10, { draggable: false }), move(80, 80), up()]).acts, []);
    assert.deepStrictEqual(run([down(10, 10, { button: 2 }), move(80, 80), up()]).acts, []);
    assert.deepStrictEqual(run([down(10, 10, { button: 1 }), move(80, 80), up()]).acts, []);
    ok('a text box, an open menu, a right or middle button never moves the window');

    // ── cancel ──
    assert.deepStrictEqual(run([down(), { type: 'cancel' }, up()]).acts, []);
    assert.deepStrictEqual(run([down(), move(30, 10), { type: 'cancel' }, up()]).acts, ['drag-start', 'drag-end']);
    assert.strictEqual(run([down(), move(30, 10), { type: 'cancel' }]).st.phase, 'idle');
    assert.deepStrictEqual(run([{ type: 'cancel' }]).acts, []);
    ok('a cancelled press is nothing, and a cancelled drag ends exactly once');

    // ── other pointers ──
    const two = run([down(), { type: 'down', id: 2, x: 500, y: 500, button: 0, draggable: true },
        move(500, 500, 2), up(2), up()]);
    assert.deepStrictEqual(two.acts, ['click']);
    const during = run([down(), move(30, 10), move(900, 900, 2), up(2), up()]);
    assert.deepStrictEqual(during.acts, ['drag-start', 'drag-end']);
    ok('a second pointer neither restarts, moves nor ends the first one’s press');

    // A move after the drag started asks for nothing more: the shell follows
    // the cursor itself from then on.
    assert.deepStrictEqual(run([down(), move(30, 10), move(60, 10), move(90, 10)]).acts, ['drag-start']);
    // And a stray up with nothing pressed does nothing.
    assert.deepStrictEqual(run([up()]).acts, []);
    ok('a drag starts once and an unpaired release is ignored');

    // ── app/titlebar.js ──
    assert.deepStrictEqual(tb.windowOptions('win32', false), {});
    const win = tb.windowOptions('win32', true, { color: '#101010', symbolColor: '#eeeeee' });
    assert.strictEqual(win.titleBarStyle, 'hidden');
    assert.deepStrictEqual(win.titleBarOverlay, { color: '#101010', symbolColor: '#eeeeee', height: 52 });
    assert.strictEqual(tb.windowOptions('linux', true).titleBarStyle, 'hidden');
    const mac = tb.windowOptions('darwin', true);
    assert.strictEqual(mac.titleBarStyle, 'hiddenInset');
    assert.strictEqual(mac.titleBarOverlay, true);
    assert.ok(mac.trafficLightPosition.y > 0 && mac.trafficLightPosition.y < 52);
    ok('Windows and Linux get the caption-button overlay, macOS its traffic lights in the bar');

    assert.strictEqual(tb.clampHeight(52, 1), 52);
    assert.strictEqual(tb.clampHeight(52, 1.25), 65);
    assert.strictEqual(tb.clampHeight(52, 0.5), tb.MIN_HEIGHT);
    assert.strictEqual(tb.clampHeight(52, 3), tb.MAX_HEIGHT);
    assert.strictEqual(tb.clampHeight(undefined, undefined), 52);
    ok('the overlay follows the zoom, inside a floor and a ceiling');

    // Grabbed three-quarters of the way along a 2000-wide maximised window,
    // 20 below its top: three-quarters of the way along the 1000-wide restore.
    const r = tb.restoredBounds({ x: 1500, y: 20 }, { x: 0, y: 0, width: 2000, height: 1200 },
        { width: 1000, height: 700 }, 20);
    assert.deepStrictEqual(r, { x: 750, y: 0, width: 1000, height: 700 });
    // Windows reports a maximised window 8px outside the screen; the fraction
    // is taken from its own bounds, so that is accounted for.
    const w8 = tb.restoredBounds({ x: 992, y: 30 }, { x: -8, y: -8, width: 2016, height: 1216 },
        { width: 1000, height: 700 }, 38);
    assert.strictEqual(w8.x, 992 - Math.round(1000 * (1000 / 2016)));
    assert.strictEqual(w8.y, -8);
    // A cursor off the window's edge is clamped to it rather than flinging
    // the window past the cursor.
    assert.strictEqual(tb.restoredBounds({ x: -50, y: 5 }, { x: 0, y: 0, width: 100, height: 100 },
        { width: 60, height: 60 }, 5).x, -50);
    ok('a window dragged out of maximised keeps the cursor where it held the bar');

    assert.strictEqual(tb.cleanColor('#131314'), '#131314');
    assert.strictEqual(tb.cleanColor(' rgba(1, 2, 3, 0.5) '), 'rgba(1, 2, 3, 0.5)');
    assert.strictEqual(tb.cleanColor('red; x'), null);
    assert.strictEqual(tb.cleanColor(12), null);
    ok('only a colour reaches the overlay');

    // ── the way back to the system titlebar ──
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-titlebar-'));
    try {
        assert.deepStrictEqual(tb.readPrefs(dir), {});
        assert.strictEqual(tb.wantsCustom(tb.readPrefs(dir), {}), true);
        tb.writePrefs(dir, { systemTitlebar: true });
        assert.strictEqual(tb.wantsCustom(tb.readPrefs(dir), {}), false);
        // Other keys in the file survive a write.
        fs.writeFileSync(path.join(dir, 'shell-prefs.json'), '﻿{"other": 1, "systemTitlebar": true}');
        tb.writePrefs(dir, { systemTitlebar: false });
        assert.deepStrictEqual(tb.readPrefs(dir), { other: 1, systemTitlebar: false });
        assert.strictEqual(tb.wantsCustom(tb.readPrefs(dir), {}), true);
        // The environment wins, for when the custom bar is what is broken.
        assert.strictEqual(tb.wantsCustom({}, { TGXCODE_SYSTEM_TITLEBAR: '1' }), false);
        fs.writeFileSync(path.join(dir, 'shell-prefs.json'), 'not json');
        assert.deepStrictEqual(tb.readPrefs(dir), {});
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    ok('“Use system titlebar” is a file in the shell’s profile, and the environment overrides it');

    console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
