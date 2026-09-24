'use strict';

// A session named from the rail.
//
// The name is kept in flags.json beside the pin rather than in the transcript
// (bridge/flags.js says why), so the two things worth checking are that the
// store round-trips and forgets it the way it does a pin, and that `_summary`
// ranks it above every other source of a title — a schedule's composed one
// included, since that is the one somebody is most likely to want to replace.
//
// **XDG_DATA_HOME is set before the require**, for the reason snippets.test.js
// gives: bridge/config.js builds STATE_DIR from it once, at load, and a test
// that wrote the real flags.json would unpin the user's sessions.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-flags-'));
process.env.XDG_DATA_HOME = home;

const { Flags, STATE_FILE, cleanTitle, TITLE_MAX } = require('../bridge/flags');
const { SessionIndex } = require('../bridge/sessions');

let pass = 0;
const ok = (what) => { pass++; console.log(`  ok  ${what}`); };

assert.ok(STATE_FILE.startsWith(home), `flags.json should be under the temp dir, got ${STATE_FILE}`);

/** Wait out the debounced save, then read what a fresh bridge would. */
async function reload(flags) {
    await new Promise(r => setTimeout(r, 500));
    assert.strictEqual(flags._saveTimer, null);
    return new Flags();
}

(async () => {
    {
        assert.strictEqual(cleanTitle('  a\n  b\t c  '), 'a b c');
        assert.strictEqual(cleanTitle('   '), null);
        assert.strictEqual(cleanTitle(null), null);
        assert.strictEqual(cleanTitle(42), null);
        assert.strictEqual(cleanTitle('x'.repeat(TITLE_MAX + 50)).length, TITLE_MAX);
        ok('a name is trimmed, collapsed and capped; blank is no name');
    }
    {
        const f = new Flags();
        assert.strictEqual(f.get('s1').title, null);
        assert.strictEqual(f.set('s1', { title: ' Night review ' }).title, 'Night review');
        // Absence leaves it alone: a pin must not clear a name.
        assert.strictEqual(f.set('s1', { pinned: true }).title, 'Night review');
        const again = await reload(f);
        assert.deepStrictEqual(again.get('s1'),
            { pinned: true, archived: false, test: false, title: 'Night review' });
        ok('a name survives a pin and a restart');

        assert.strictEqual(again.set('s1', { title: '' }).title, null);
        again.set('s2', { title: 'Other' });
        assert.strictEqual(again.set('s2', { title: null }).title, null);
        ok('an empty string and null both clear it');

        again.set('s3', { title: 'Gone soon' });
        again.set('s4', { title: 'Stays' });
        assert.strictEqual(again.prune(new Set(['s4'])), true);
        assert.strictEqual(again.get('s3').title, null);
        assert.strictEqual(again.get('s4').title, 'Stays');
        await reload(again);
        ok('prune forgets the name of a deleted transcript');
    }
    {
        // A file from before names existed, which is every file on disk today.
        fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 1, pinned: ['p'], archived: [], test: [] }));
        const f = new Flags();
        assert.strictEqual(f.get('p').pinned, true);
        assert.strictEqual(f.get('p').title, null);
        // And a hand-edited one with rubbish in it.
        fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 1, titles: { a: '  ', b: 7, c: 'Fine' } }));
        const g = new Flags();
        assert.deepStrictEqual([...g.titles], [['c', 'Fine']]);
        ok('a flags.json without titles, or with bad ones, still loads');
    }
    {
        const flags = new Flags();
        const summary = (meta, schedule) => SessionIndex.prototype._summary.call({
            flags, registry: null, later: null,
            schedules: { forSession: () => schedule },
        }, { meta: { sessionId: 'x', firstTs: '2026-09-01T00:00:00Z', ...meta } });

        const sched = { id: 'sch', title: 'Nightly' };
        const before = summary({ title: '/review', titleSource: 'prompt' }, sched);
        assert.strictEqual(before.titleSource, 'schedule');

        flags.set('x', { title: 'Mine' });
        for (const [meta, s] of [
            [{ title: '/review', titleSource: 'prompt' }, sched],
            [{ title: 'Claude named it', titleSource: 'custom-title' }, null],
            [{ title: 'Untitled session', titleSource: 'none' }, null],
        ]) {
            const out = summary(meta, s);
            assert.strictEqual(out.title, 'Mine');
            assert.strictEqual(out.titleSource, 'user');
        }
        flags.set('x', { title: null });
        const after = summary({ title: 'Claude named it', titleSource: 'custom-title' }, null);
        assert.strictEqual(after.title, 'Claude named it');
        assert.strictEqual(after.titleSource, 'custom-title');
        await reload(flags);
        ok('a name beats the transcript and the schedule, and clearing it gives them back');
    }

    fs.rmSync(home, { recursive: true, force: true });
    console.log(`\n${pass} groups passed`);
})().catch((err) => {
    console.error(err);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
});
