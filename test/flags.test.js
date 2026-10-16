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
        // Without the grace period: these were all flagged a moment ago, which
        // otherwise reads as another bridge's session not yet on disk.
        assert.strictEqual(again.prune(new Set(['s4']), 0), true);
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

    // Two Flags on one file are two bridges: the everyday one and a dev one share
    // flags.json, and each used to write its whole in-memory copy over the other's.
    const settle = () => new Promise(r => setTimeout(r, 500));
    // Skip the once-a-second throttle rather than sleep through it.
    const now = (f) => { f._checkedAt = 0; return f; };
    {
        fs.rmSync(STATE_FILE, { force: true });
        const everyday = new Flags();
        everyday.set('pin-me', { pinned: true });
        everyday.set('named', { title: 'Users name' });
        await settle();
        const dev = new Flags();
        dev.set('probe', { test: true });
        await settle();
        // The everyday bridge has never heard of `probe` and writes after it.
        everyday.set('archive-me', { archived: true });
        await settle();
        const disk = new Flags();
        assert.strictEqual(disk.get('probe').test, true, 'the dev bridge\'s label survives the everyday bridge\'s write');
        assert.strictEqual(disk.get('archive-me').archived, true);
        ok('a write from one bridge keeps what another bridge wrote');

        assert.strictEqual(now(everyday).isTest('probe'), true);
        assert.strictEqual(everyday.get('probe').test, true);
        ok('a bridge sees a test label set by another bridge after it started');

        // And the other way: the dev bridge, loaded with the user's pin and name,
        // must not put them back after the user changes them in the everyday window.
        everyday.set('pin-me', { pinned: false });
        everyday.set('named', { title: 'Renamed' });
        await settle();
        dev.set('probe', { title: 'Probe' });
        await settle();
        const after = new Flags();
        assert.strictEqual(after.get('pin-me').pinned, false);
        assert.strictEqual(after.get('named').title, 'Renamed');
        assert.strictEqual(after.get('probe').title, 'Probe');
        assert.strictEqual(after.get('probe').test, true);
        ok('a dev bridge\'s write does not revert the user\'s pins and names');

        // Unsaved changes of this bridge win over a reload of the other's write.
        dev.set('x', { pinned: true });
        everyday.set('y', { pinned: true });
        await settle();
        const both = new Flags();
        assert.ok(both.get('x').pinned && both.get('y').pinned);
        ok('two bridges saving in the same debounce window keep both changes');
    }
    {
        fs.rmSync(STATE_FILE, { force: true });
        const a = new Flags();
        a.set('fresh', { test: true });
        // A file written before stamps existed: an old id has none.
        await settle();
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        raw.archived.push('ancient');
        fs.writeFileSync(STATE_FILE, JSON.stringify(raw));
        const b = new Flags();
        // `b` has no transcript for either and no `pending` entry for `fresh`.
        b.prune(new Set());
        assert.strictEqual(b.get('fresh').test, true, 'a just-flagged id from another bridge is spared');
        assert.strictEqual(b.get('ancient').archived, false, 'an unstamped orphan is still pruned');
        b.prune(new Set(), 0);
        assert.strictEqual(b.get('fresh').test, false, 'and the stamp only buys a grace period');
        await settle();
        assert.strictEqual(new Flags().get('fresh').test, false);
        ok('prune spares an id flagged in the last few minutes, and only that');
    }
    {
        fs.rmSync(STATE_FILE, { force: true });
        const f = new Flags();
        f.set('t', { test: true });
        await settle();
        let stats = 0;
        const real = fs.statSync;
        fs.statSync = (...a) => { stats++; return real(...a); };
        try {
            f._checkedAt = 0;
            for (let i = 0; i < 500; i++) f.get(`row-${i}`);
            for (let i = 0; i < 500; i++) f.isTest(`row-${i}`);
        } finally { fs.statSync = real; }
        assert.ok(stats <= 1, `a 1000-row read should stat the file at most once, did ${stats}`);
        ok('reading a long list costs one stat, not one per row');
    }

    fs.rmSync(home, { recursive: true, force: true });
    console.log(`\n${pass} groups passed`);
})().catch((err) => {
    console.error(err);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
});
