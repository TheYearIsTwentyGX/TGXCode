'use strict';

// Suggested tasks: what was decided about them, and how they are searched.
//
// The decisions store (bridge/suggestions.js) and the joined list
// (`SessionIndex.listSuggestions`) on their own — no bridge. The list is driven
// with a stand-in `this` rather than a real index, because what is under test
// is the join and the filter, not the transcript scan that fills `meta`.
//
// **XDG_DATA_HOME before the require**, for the reason test/schedule.test.js
// gives: bridge/config.js builds STATE_DIR once, at load, and the real
// suggestions.json is the user's.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-suggestions-'));
process.env.XDG_DATA_HOME = home;

const { Suggestions, STATE_FILE, STATUSES, MAX_NOTE } = require('../bridge/suggestions');
const { SessionIndex } = require('../bridge/sessions');

assert.ok(STATE_FILE.startsWith(home),
    `refusing to run: STATE_FILE is ${STATE_FILE}, outside the throwaway ${home}`);

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

function fresh() {
    try { fs.unlinkSync(STATE_FILE); } catch { /* first run */ }
    return new Suggestions();
}

/** Write now rather than after the debounce, then read it back as a new process would. */
function reload(store) {
    clearTimeout(store._saveTimer);
    store._saveTimer = null;
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
        version: 1, sessions: Object.fromEntries(store.bySession),
    }));
    return new Suggestions();
}

{
    assert.ok(STATUSES.has('completed'));
    const s = fresh();

    // Started, then completed with no startedId: the completion keeps who did
    // it, because the link is the useful part of a finished card.
    s.set('src', 't1', { status: 'started', startedId: 'worker', via: 'subagent' });
    const done = s.set('src', 't1', { status: 'completed', note: '  https://x/pr/1  ' });
    assert.strictEqual(done.status, 'completed');
    assert.strictEqual(done.startedId, 'worker');
    assert.strictEqual(done.via, 'subagent');
    assert.strictEqual(done.note, 'https://x/pr/1', 'trimmed');

    // A dismissal drops both, as it always has.
    const gone = s.set('src', 't2', { status: 'dismissed', startedId: 'x', via: 'session',
        note: 'not needed' });
    assert.strictEqual(gone.startedId, null);
    assert.strictEqual(gone.via, null);
    assert.strictEqual(gone.note, 'not needed');

    // A note is a pointer, not a report.
    assert.strictEqual(s.set('src', 't3', { status: 'completed', note: 'x'.repeat(2000) })
        .note.length, MAX_NOTE);
    // An unknown via is dropped, not stored.
    assert.strictEqual(s.set('src', 't4', { status: 'started', via: 'telepathy' }).via, null);

    const back = reload(s);
    assert.deepStrictEqual(
        { ...back.forSession('src').t1, at: 0 },
        { status: 'completed', startedId: 'worker', via: 'subagent', note: 'https://x/pr/1', at: 0 },
        'survives a reload');
    ok('completed keeps startedId and via, notes are trimmed and capped, and all of it reloads');
}

{
    // The join and the search, against a stand-in index.
    const store = fresh();
    const meta = (id, title, suggestions) => ({
        meta: { sessionId: id, title, projectCwd: '/p', cwd: '/p', suggestions },
        mtimeMs: 1,
    });
    const fake = {
        sessions: new Map([
            ['a', meta('a', 'Port to Preact', [
                { id: 'ta1', title: 'Split app.js', prompt: 'Move api and state out',
                    why: 'too big', ts: '2026-09-23T15:30:00Z' },
                { id: 'ta2', title: 'Port the Settings forms', prompt: 'Use preact for settings',
                    ts: '2026-09-23T15:31:00Z' },
            ])],
            ['b', meta('b', 'Something else', [
                { id: 'tb1', title: 'Fix the importer', prompt: 'column renamed',
                    ts: '2026-09-23T16:00:00Z' },
            ])],
        ]),
        flags: { get: () => ({ pinned: false, archived: false, test: false }) },
        suggestions: store,
    };
    const list = (opts) => SessionIndex.prototype.listSuggestions.call(fake, opts);

    assert.deepStrictEqual(list({}).map(t => t.id), ['tb1', 'ta2', 'ta1'], 'newest first');
    assert.deepStrictEqual(list({ q: 'preact' }).map(t => t.id), ['ta2', 'ta1'],
        'the source session title counts');
    assert.deepStrictEqual(list({ q: 'SPLIT api' }).map(t => t.id), ['ta1'],
        'every word, any case, across title and prompt');
    assert.deepStrictEqual(list({ q: 'too big' }).map(t => t.id), ['ta1'], 'why counts');
    assert.deepStrictEqual(list({ q: 'split importer' }), [], 'all words, not any');

    store.set('a', 'ta1', { status: 'started', startedId: 'w', via: 'session' });
    store.set('a', 'ta1', { status: 'completed', note: 'PR #9' });
    const row = list({ status: 'completed' });
    assert.strictEqual(row.length, 1);
    assert.strictEqual(row[0].note, 'PR #9');
    assert.strictEqual(row[0].via, 'session');
    assert.strictEqual(row[0].startedId, 'w');
    assert.deepStrictEqual(list({ session: 'a', status: 'open' }).map(t => t.id), ['ta2']);
    ok('listSuggestions searches every word, and carries completed, note and via');
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} groups passed`);
