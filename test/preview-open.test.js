'use strict';

// open_in_preview, as the window carries it out (web/preview-open.js), against a
// stub shell that is the real grant store (app/preview-grants.js) behind the same
// four calls app/main.js answers. What the bridge is told is what the agent
// reads, so each outcome is checked by its words: opened at once for a local
// page; asked, then opened, for a site the user allows within the minute;
// denied; and — the user away from the desk — `waiting`, after which a yes still
// opens the page.

const assert = require('assert');
const { PreviewGrants } = require('../app/preview-grants');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

/** The shell's side, as app/main.js wires it, over a given grant store. */
function stubShell(grants) {
    return {
        request: async (url, sessionId) => grants.ask(url, { requester: `session:${sessionId || 'unknown'}`, open: url }),
        wait: (origin, ms) => grants.wait(origin, ms),
        answer: async (origin, decision) => grants.answer(origin, decision),
    };
}

function harness(grants, waitMs = 200) {
    const answers = [];
    const shown = [];
    let reveals = 0;
    const deps = {
        shell: stubShell(grants),
        answer: async (body) => { answers.push(body); },
        show: async (url) => { shown.push(url); return true; },
        reveal: () => { reveals++; },
        waitMs,
    };
    return { deps, answers, shown, reveals: () => reveals };
}

const later = (ms) => new Promise(r => setTimeout(r, ms));

// The grant store unrefs its timers, as a main process should; this is what
// keeps a test waiting on one alive.
const keepAlive = setInterval(() => {}, 1000);

(async () => {
    const { openForAgent, waitingText, deniedText } = await import('../web/preview-open.js');

    // A local page: no asking, no pending.
    {
        const g = new PreviewGrants();
        const h = harness(g);
        await openForAgent({ url: 'http://localhost:5173/cart', sessionId: 'A' }, h.deps);
        assert.deepStrictEqual(h.shown, ['http://localhost:5173/cart']);
        assert.deepStrictEqual(h.answers, [{ ok: true, outcome: 'opened', url: 'http://localhost:5173/cart' }]);
        assert.strictEqual(g.list().length, 0);
        ok('a local page opens at once');
    }

    // Allowed while the agent waits.
    {
        const g = new PreviewGrants();
        const h = harness(g, 2000);
        const run = openForAgent({ url: 'https://pcpartpicker.com/list', sessionId: 'A' }, h.deps);
        await later(20);
        assert.deepStrictEqual(h.answers, [{ pending: true }], 'the bridge is told to keep waiting');
        assert.strictEqual(h.reveals(), 1, 'the preview, where the prompt is, is put on screen');
        assert.deepStrictEqual(g.list().map(a => a.host), ['pcpartpicker.com']);
        // What the window does on a click: answer, and open what comes back.
        const r = await h.deps.shell.answer('https://pcpartpicker.com', 'once');
        await h.deps.show(r.open);
        await run;
        assert.deepStrictEqual(h.shown, ['https://pcpartpicker.com/list']);
        assert.deepStrictEqual(h.answers.at(-1), { ok: true, outcome: 'opened', url: 'https://pcpartpicker.com/list' });
        ok('a site allowed within the minute opens, and the agent is told it did');
    }

    // Denied.
    {
        const g = new PreviewGrants();
        const h = harness(g, 2000);
        const run = openForAgent({ url: 'https://example.com/', sessionId: 'A' }, h.deps);
        await later(20);
        await h.deps.shell.answer('https://example.com', 'deny');
        await run;
        assert.deepStrictEqual(h.answers.at(-1),
            { ok: false, outcome: 'denied', error: 'Not opened: the user denied example.com for agent control.' });
        assert.strictEqual(deniedText('example.com'), h.answers.at(-1).error);
        const h2 = harness(g);
        await openForAgent({ url: 'https://example.com/again', sessionId: 'A' }, h2.deps);
        assert.deepStrictEqual(h2.answers, [h.answers.at(-1)], 'asked again soon after, it is denied without a prompt');
        ok('a denied site is reported as denied, and not asked about again at once');
    }

    // Nobody answers in time: `waiting`, the prompt stays, and a later yes opens it.
    {
        const g = new PreviewGrants();
        const h = harness(g, 100);
        await openForAgent({ url: 'https://amazon.com/dp/1', sessionId: 'A' }, h.deps);
        assert.deepStrictEqual(h.answers.at(-1), { ok: false, outcome: 'waiting', error: waitingText('amazon.com') });
        assert.strictEqual(h.answers.at(-1).error,
            'Waiting for the user to approve amazon.com. The prompt stays open until they answer, and the page opens in '
            + 'the preview by itself when they allow it. Check back later, or call open_in_preview again to see the outcome.');
        assert.strictEqual(g.list().length, 1, 'the prompt is still open');

        const h2 = harness(g, 100);
        const t0 = Date.now();
        await openForAgent({ url: 'https://amazon.com/dp/1', sessionId: 'A' }, h2.deps);
        assert.ok(Date.now() - t0 < 80, 'asked again by the same session, it answers at once');
        assert.strictEqual(h2.answers.length, 1);
        assert.strictEqual(h2.answers[0].outcome, 'waiting');
        assert.strictEqual(g.list().length, 1, 'and there is still one prompt, not two');

        const r = await h.deps.shell.answer('https://amazon.com', 'always');
        assert.strictEqual(r.open, 'https://amazon.com/dp/1', 'the yes, however late, opens the page asked for');
        ok('no answer in a minute is `waiting`; the prompt stays and a later yes opens the page');
    }

    clearInterval(keepAlive);
    console.log(`\n${pass} preview-open checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
