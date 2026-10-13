'use strict';

// The "while you were away" digest, on its own — no bridge.
//
// buildDigest() is pure, so every question worth asking is about the assembly:
// does `since` cut where it should, does a restart's re-emitted finish count
// twice, does a schedule's failure land with the failures rather than with the
// schedule, does a PR say how sure it is of when it settled. The route on top
// only gathers inputs.
//
// NotificationLog.since() is tested here too, because it is the one input that
// is not just a store read. XDG_DATA_HOME is set before the require for
// notifications.test.js's reason: STATE_DIR is built at require time.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-digest-'));
process.env.XDG_DATA_HOME = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));

const { buildDigest, CAP, DUPLICATE_MS } = require('../bridge/digest');
const { NotificationLog, LOG_FILE } = require('../bridge/notifications');

assert.ok(LOG_FILE.startsWith(home), 'refusing to run: LOG_FILE is not under the temp dir');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const NOW = 1_800_000_000_000;
const SINCE = NOW - 60 * 60_000;
const row = (o) => ({ id: `${o.at}-x`, title: 'A session', project: 'proj', ...o });

// --- empty -----------------------------------------------------------------

{
    const d = buildDigest({ since: SINCE, now: NOW });
    assert.strictEqual(d.total, 0);
    assert.deepStrictEqual(d.counts, {
        waiting: 0, failed: 0, finished: 0, prs: 0, schedules: 0, suggestions: 0, reports: 0,
    });
    for (const k of Object.keys(d.counts)) assert.deepStrictEqual(d[k], []);
    assert.strictEqual(d.since, SINCE);
    assert.strictEqual(d.now, NOW);
    ok('nothing in, every group empty and zero counts');
}

// --- since -----------------------------------------------------------------

{
    const d = buildDigest({
        since: SINCE, now: NOW,
        rows: [
            row({ at: SINCE - 1, type: 'finished', sessionId: 'old' }),
            row({ at: SINCE, type: 'finished', sessionId: 'edge' }),
            row({ at: NOW + 1, type: 'finished', sessionId: 'future' }),
        ],
    });
    assert.deepStrictEqual(d.finished.map(f => f.sessionId), ['edge']);
    ok('since is inclusive, and rows before it or after now are left out');
}

// --- finished turns ----------------------------------------------------------

{
    const standing = { a: { text: 'PR #12 opened, waiting on review', source: 'model', at: NOW } };
    const d = buildDigest({
        since: SINCE, now: NOW,
        rows: [
            row({ at: SINCE + 1000, type: 'finished', sessionId: 'a', title: 'Old name' }),
            row({ at: SINCE + 60_000, type: 'finished', sessionId: 'a', title: 'New name' }),
            row({ at: SINCE + 30_000, type: 'finished', sessionId: 'b' }),
            // A subagent finishing is not a turn.
            row({ at: SINCE + 40_000, type: 'agent-done', sessionId: 'b' }),
        ],
        standingFor: (id) => standing[id] || null,
    });
    assert.deepStrictEqual(d.finished.map(f => [f.sessionId, f.turns]), [['a', 2], ['b', 1]],
        'newest first, one entry per session');
    assert.strictEqual(d.finished[0].title, 'New name', 'the newest title wins');
    assert.strictEqual(d.finished[0].lastAt, SINCE + 60_000);
    assert.deepStrictEqual(d.finished[0].standing, standing.a);
    assert.strictEqual(d.finished[1].standing, null);
    ok('finished turns group per session with the standing line');
}

{
    const d = buildDigest({
        since: SINCE, now: NOW,
        rows: [
            row({ at: SINCE + 1000, type: 'finished', sessionId: 'a' }),
            row({ at: SINCE + 1000 + DUPLICATE_MS - 1, type: 'finished', sessionId: 'a' }),
            row({ at: SINCE + 1000 + DUPLICATE_MS + 10, type: 'finished', sessionId: 'a' }),
        ],
    });
    assert.strictEqual(d.finished[0].turns, 2, 'the re-emitted finish was counted');
    ok('a finish re-emitted by an adopting bridge is not a second turn');
}

// --- failures ---------------------------------------------------------------

{
    const d = buildDigest({
        since: SINCE, now: NOW,
        rows: [
            row({ at: SINCE + 1, type: 'failed', sessionId: 'a', summary: 'boom' }),
            row({ at: SINCE + 2, type: 'stalled', sessionId: 'b' }),
            row({ at: SINCE + 3, type: 'schedule-missed', sessionId: null, title: 'Nightly' }),
            row({ at: SINCE + 4, type: 'later-failed', sessionId: 'c' }),
            row({ at: SINCE + 5, type: 'permission', sessionId: 'd' }),
            row({ at: SINCE + 6, type: 'peer-message', sessionId: 'd' }),
        ],
    });
    assert.deepStrictEqual(d.failed.map(f => f.type),
        ['later-failed', 'schedule-missed', 'stalled', 'failed']);
    const missed = d.failed.find(f => f.type === 'schedule-missed');
    assert.strictEqual(missed.sessionId, null);
    assert.strictEqual(missed.title, 'Nightly');
    assert.strictEqual(d.failed.find(f => f.type === 'failed').summary, 'boom');
    ok('failures, stalls and missed slots are failures; asks and messages are not');
}

// --- waiting ----------------------------------------------------------------

{
    const d = buildDigest({
        since: SINCE, now: NOW,
        statuses: {
            idle: { state: 'idle', pendingPermission: null },
            old: { pendingPermission: { kind: 'tool', tool: 'Bash', requestId: 'r1', askedAt: SINCE - 999 } },
            plan: { pendingPermission: { kind: 'plan', requestId: 'r2', askedAt: SINCE + 50 } },
            hidden: { pendingPermission: { kind: 'question', requestId: 'r3', askedAt: SINCE + 60 } },
        },
        describe: (id) => ({ title: `T-${id}`, projectName: 'P' }),
        isTest: (id) => id === 'hidden',
    });
    assert.deepStrictEqual(d.waiting.map(w => w.sessionId), ['plan', 'old'],
        'newest first; an ask from before you left still waits; test sessions are out');
    assert.deepStrictEqual(d.waiting[1],
        { sessionId: 'old', title: 'T-old', project: 'P', kind: 'tool', tool: 'Bash',
            requestId: 'r1', askedAt: SINCE - 999 });
    ok('waiting is the live asks, whenever they were raised');
}

// --- schedules ------------------------------------------------------------

{
    const d = buildDigest({
        since: SINCE, now: NOW,
        rows: [row({ at: SINCE + 10, type: 'schedule-findings', sessionId: 's1',
            summary: 'Two PRs need changes' })],
        schedules: [
            { id: 'a', title: null, prompt: 'Review PRs', lastFiredAt: SINCE + 5,
                lastSessionId: 's1', lastOutcome: 'changes', runs: 4 },
            { id: 'b', title: 'Old', lastFiredAt: SINCE - 5 },
            { id: 'c', title: 'Never' },
        ],
        scheduleTitle: (r) => r.title || r.prompt,
    });
    assert.deepStrictEqual(d.schedules, [{
        id: 'a', title: 'Review PRs', lastFiredAt: SINCE + 5, lastSessionId: 's1',
        lastOutcome: 'changes', lastError: null, runs: 4, findings: 'Two PRs need changes',
    }]);
    assert.strictEqual(d.failed.length, 0, 'findings are not a failure');
    ok('schedules that fired, with what a review found');
}

// --- pull requests ------------------------------------------------------------

{
    const d = buildDigest({
        since: SINCE, now: NOW,
        prs: {
            repos: {
                'o/r': { pulls: [
                    { number: 1, url: 'u1', title: 'New', createdAt: new Date(SINCE + 100).toISOString() },
                    { number: 2, url: 'u2', title: 'Old', createdAt: new Date(SINCE - 100).toISOString() },
                ] },
            },
            terminal: {
                'o/r#3': { at: NOW - 10, pull: { repo: 'o/r', number: 3, url: 'u3', title: 'M',
                    state: 'MERGED', mergedAt: new Date(SINCE + 200).toISOString() } },
                'o/r#4': { at: SINCE + 300, pull: { repo: 'o/r', number: 4, url: 'u4', title: 'C',
                    state: 'CLOSED' } },
                // Merged before you left, but only noticed now: GitHub's time wins.
                'o/r#5': { at: SINCE + 400, pull: { repo: 'o/r', number: 5, url: 'u5',
                    state: 'MERGED', mergedAt: new Date(SINCE - 1).toISOString() } },
            },
        },
    });
    assert.deepStrictEqual(d.prs.map(p => [p.number, p.change, p.approx]),
        [[4, 'closed', true], [3, 'merged', false], [1, 'opened', false]]);
    assert.strictEqual(d.prs[1].at, SINCE + 200);
    ok('PRs opened, merged and closed, saying when the time is only when it was noticed');
}

// --- suggestions and reports -------------------------------------------------

{
    const d = buildDigest({
        since: SINCE, now: NOW,
        suggestions: [
            { id: 't1', sessionId: 'a', title: 'Add a test', ts: new Date(SINCE + 5).toISOString(),
                status: 'open', session: { title: 'Where' } },
            { id: 't0', sessionId: 'a', title: 'Old', ts: new Date(SINCE - 5).toISOString() },
        ],
        orchestrators: [{
            id: 'o1',
            workers: [{ id: 'w1', title: 'Worker one' }],
            inbox: [
                { workerId: 'w1', kind: 'done', text: 'PR #9', at: SINCE + 20 },
                { workerId: 'w1', kind: 'turn', text: 'ended', at: SINCE + 21 },
                { workerId: 'w2', kind: 'question', text: 'Which?', at: SINCE + 22 },
                { workerId: 'w1', kind: 'update', text: 'old', at: SINCE - 1 },
            ],
        }],
        describe: (id) => ({ o1: { title: 'Orch' }, w2: { title: 'Gone worker' } })[id] || null,
    });
    assert.deepStrictEqual(d.suggestions,
        [{ sessionId: 'a', id: 't1', title: 'Add a test', ts: new Date(SINCE + 5).toISOString(),
            status: 'open', from: 'Where' }]);
    assert.deepStrictEqual(d.reports.map(r => [r.kind, r.workerTitle, r.orchestratorTitle]),
        [['question', 'Gone worker', 'Orch'], ['done', 'Worker one', 'Orch']]);
    ok('suggestions filed and worker reports, but not turn ends in the inbox');
}

// --- caps ----------------------------------------------------------------

{
    const rows = [];
    for (let i = 0; i < CAP + 7; i++) {
        rows.push(row({ at: SINCE + i * 10_000, type: 'finished', sessionId: `s${i}` }));
    }
    const d = buildDigest({ since: SINCE, now: NOW + CAP * 10_000 * 2, rows });
    assert.strictEqual(d.finished.length, CAP);
    assert.strictEqual(d.counts.finished, CAP + 7, 'counts are before the cap');
    assert.strictEqual(d.finished[0].sessionId, `s${CAP + 6}`, 'the cap keeps the newest');
    ok('every group is capped, and counts say how many there were');
}

// --- NotificationLog.since -----------------------------------------------

{
    const log = new NotificationLog({ isTest: (id) => id === 'scratch' });
    log.rows = [
        { id: '1', at: 100, sessionId: 'a', type: 'finished' },
        { id: '2', at: 200, sessionId: 'scratch', type: 'finished' },
        { id: '3', at: 300, sessionId: 'b', type: 'finished' },
    ];
    assert.deepStrictEqual(log.since(150).map(r => r.id), ['3']);
    assert.deepStrictEqual(log.since(150, { includeTest: true }).map(r => r.id), ['2', '3']);
    assert.deepStrictEqual(log.since(100).map(r => r.id), ['1', '3'], 'inclusive, oldest first');
    assert.deepStrictEqual(log.since(301), []);
    ok('NotificationLog.since walks back to the window and drops test rows');
}

console.log(`\n${pass} digest checks passed`);
