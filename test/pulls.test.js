'use strict';

// Exercises the pure functions in bridge/pulls.js that decide what a pull
// request's status *is* — the part of that module a person reads off an icon and
// a colour, and therefore the part that must not quietly drift.
//
// All pure, so none of this needs a bridge or a network. What is worth pinning
// down is the ordering (a PR is regularly several things at once, and one glyph
// has to pick), the two cases where the answer is deliberately silence, and the
// *second* ordering — `aggregate` folds a session's whole set of PRs down to the
// one word a rail row can carry, and it disagrees with `resolveStatus` on purpose.

const assert = require('assert');
const {
    resolveStatus, checkSummary, aggregate, ATTENTION_ORDER,
} = require('../bridge/pulls.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

/** An open, unremarkable PR, for tests to spoil one field at a time. */
const pull = (over = {}) => ({
    number: 1,
    title: 'A change',
    url: 'https://github.com/o/r/pull/1',
    state: 'OPEN',
    draft: false,
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    checks: null,
    ...over,
});

const is = (over, expected, name) => {
    const got = resolveStatus(pull(over));
    assert.strictEqual(got.status, expected,
        `${name}: got "${got.status}" (${got.label}), wanted "${expected}"`);
    assert.ok(got.label, `${name}: every status needs a label to put in the tooltip`);
    ok(name);
};

// --- the plain cases -------------------------------------------------------
is({}, 'open', 'an open PR with nothing else to say is open');
is({ draft: true }, 'draft', 'a draft is a draft');
is({ state: 'MERGED' }, 'merged', 'a merged PR is merged');
is({ state: 'CLOSED' }, 'closed', 'a closed PR is closed');
is({ reviewDecision: 'APPROVED' }, 'approved', 'an approved PR is approved');
is({ reviewDecision: 'CHANGES_REQUESTED' }, 'changes', 'changes requested wins over open');
is({ mergeable: 'CONFLICTING' }, 'conflicting', 'a conflicting PR is conflicting');

// --- precedence: a PR is several things at once ----------------------------
// Terminal beats everything. A merged PR that was conflicting and had a failing
// check is just merged, and saying otherwise would send someone to look at a PR
// there is nothing left to do about.
is({ state: 'MERGED', mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED' },
    'merged', 'merged beats a conflict and a review');
is({ state: 'MERGED', draft: true }, 'merged', 'merged beats draft');
is({ state: 'CLOSED', reviewDecision: 'APPROVED' }, 'closed', 'closed beats an approval');

// Draft is a statement about intent, so it outranks anything wrong with the code:
// nobody is being asked to act on a draft yet.
is({ draft: true, mergeable: 'CONFLICTING' }, 'draft', 'draft beats a conflict');
is({ draft: true, reviewDecision: 'APPROVED' }, 'draft', 'draft beats an approval');

// A human asking for changes outranks the machine, and both outrank a conflict.
is({ reviewDecision: 'CHANGES_REQUESTED', mergeable: 'CONFLICTING' },
    'changes', 'a review request beats a conflict');
is({ reviewDecision: 'CHANGES_REQUESTED', checks: { total: 2, failed: 1, pending: 0, passed: 1 } },
    'changes', 'a review request beats a failing check');
is({ mergeable: 'CONFLICTING', checks: { total: 2, failed: 1, pending: 0, passed: 1 } },
    'checks-failed', 'a failing check beats a conflict');
is({ mergeable: 'CONFLICTING', checks: { total: 2, failed: 0, pending: 1, passed: 1 } },
    'conflicting', 'a conflict beats checks merely running');

// An approval does not paper over what is still wrong.
is({ reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' },
    'conflicting', 'a conflict beats an approval');
is({ reviewDecision: 'APPROVED', checks: { total: 2, failed: 1, pending: 0, passed: 1 } },
    'checks-failed', 'a failing check beats an approval');
is({ reviewDecision: 'APPROVED', checks: { total: 2, failed: 0, pending: 1, passed: 1 } },
    'checks-pending', 'checks still running beat an approval');

// --- the deliberate silences ----------------------------------------------
// `UNKNOWN` is GitHub not having worked the merge out yet, which happens on any
// freshly-pushed branch. Reading it as either answer would be a guess.
is({ mergeable: 'UNKNOWN' }, 'open', 'an unknown mergeability claims nothing');
is({ mergeable: 'UNKNOWN', reviewDecision: 'APPROVED' },
    'approved', 'an unknown mergeability does not mask an approval');

// An empty rollup is a repository with no CI, not a repository whose CI is
// pending. Neither of this app's own repositories has a workflow, so getting this
// wrong would put a badge on every PR in the window, forever.
assert.strictEqual(checkSummary([]), null, 'an empty rollup says nothing');
ok('an empty rollup says nothing');
assert.strictEqual(checkSummary(null), null, 'a missing rollup says nothing');
ok('a missing rollup says nothing');
is({ checks: checkSummary([]) }, 'open', 'a repo with no CI reads as plain open');

// --- counting a rollup ----------------------------------------------------
// Two entry shapes turn up in the same array: a CheckRun states `status` and,
// once finished, `conclusion`; a StatusContext states `state`.
const counts = (rollup, expected, name) => {
    assert.deepStrictEqual(checkSummary(rollup), expected,
        `${name}: got ${JSON.stringify(checkSummary(rollup))}`);
    ok(name);
};

counts([{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    { total: 1, failed: 0, pending: 0, passed: 1 }, 'a finished CheckRun that passed');
counts([{ status: 'COMPLETED', conclusion: 'FAILURE' }],
    { total: 1, failed: 1, pending: 0, passed: 0 }, 'a finished CheckRun that failed');
counts([{ status: 'IN_PROGRESS' }],
    { total: 1, failed: 0, pending: 1, passed: 0 }, 'a CheckRun still going');
counts([{ status: 'QUEUED' }],
    { total: 1, failed: 0, pending: 1, passed: 0 }, 'a CheckRun not started yet');
counts([{ state: 'SUCCESS' }],
    { total: 1, failed: 0, pending: 0, passed: 1 }, 'a StatusContext that passed');
counts([{ state: 'PENDING' }],
    { total: 1, failed: 0, pending: 1, passed: 0 }, 'a StatusContext still pending');
counts([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'FAILURE' }, { status: 'QUEUED' }],
    { total: 3, failed: 1, pending: 1, passed: 1 }, 'both shapes counted in one rollup');

// Skipped and cancelled jobs count against nothing. GitHub does not fail a PR for
// them, and a skipped job reported as a failure would make the indicator cry wolf.
counts([{ status: 'COMPLETED', conclusion: 'SKIPPED' }],
    { total: 1, failed: 0, pending: 0, passed: 0 }, 'a skipped job is neither');
counts([{ status: 'COMPLETED', conclusion: 'CANCELLED' }],
    { total: 1, failed: 0, pending: 0, passed: 0 }, 'a cancelled job is neither');
counts([{ status: 'COMPLETED', conclusion: 'NEUTRAL' }],
    { total: 1, failed: 0, pending: 0, passed: 0 }, 'a neutral job is neither');
is({ checks: checkSummary([{ status: 'COMPLETED', conclusion: 'SKIPPED' }]) },
    'open', 'a PR whose only job was skipped is plain open');

// A shape this does not recognise is skipped rather than guessed at, and a rollup
// of nothing but those is the same as no rollup at all.
counts([{ nothing: 'useful' }], null, 'an unrecognised entry is not counted');
counts([{ nothing: 'useful' }, { state: 'SUCCESS' }],
    { total: 1, failed: 0, pending: 0, passed: 1 }, 'an unrecognised entry does not spoil the rest');
counts(['not an object', null, 42], null, 'entries that are not objects are skipped');

// --- the tooltip's detail lines -------------------------------------------
const detailOf = (over) => resolveStatus(pull(over)).detail;

assert.deepStrictEqual(
    detailOf({ checks: { total: 5, failed: 2, pending: 0, passed: 3 } }),
    ['2 of 5 checks failed'], 'a failure count reads as a sentence');
ok('a failure count reads as a sentence');
assert.deepStrictEqual(
    detailOf({ checks: { total: 1, failed: 0, pending: 1, passed: 0 } }),
    ['1 check still running'], 'one check is singular');
ok('one check is singular');
assert.deepStrictEqual(
    detailOf({ checks: { total: 3, failed: 0, pending: 0, passed: 3 } }),
    ['3 checks passed'], 'all passing is worth saying');
ok('all passing is worth saying');
assert.deepStrictEqual(detailOf({}), [], 'a PR with nothing extra to say says nothing');
ok('a PR with nothing extra to say says nothing');
assert.deepStrictEqual(
    detailOf({ reviewDecision: 'REVIEW_REQUIRED' }),
    ['review required'], 'an awaited review is detail, not the headline');
ok('an awaited review is detail, not the headline');
// REVIEW_REQUIRED is what an untouched PR reports, so it must not become a status
// of its own — every open PR on a protected branch would wear it.
is({ reviewDecision: 'REVIEW_REQUIRED' }, 'open', 'an awaited review still reads as open');

// --- one status for a whole session ---------------------------------------
// `aggregate` answers a different question from `resolveStatus`: not "what is this
// PR" but "which of these PRs should the row look like". So it has its own order,
// and the cases below are the ones where the two disagree.

/** A resolved entry, as `forSession` would hand it over. */
const at = (status) => ({ status, label: status, url: `https://x/${status}` });

const folds = (statuses, expected, name) => {
    const got = aggregate(statuses.map(at));
    assert.strictEqual(got && got.status, expected,
        `${name}: got "${got && got.status}", wanted "${expected}"`);
    ok(name);
};

folds(['merged', 'draft'], 'draft', 'a merged PR does not hide an unfinished one');
folds(['merged', 'merged'], 'merged', 'all merged reads as merged');
folds(['merged'], 'merged', 'one merged PR reads as merged');
folds(['draft'], 'draft', 'one draft reads as a draft');

// The disagreement with `resolveStatus`, and the reason there are two orders.
// For a single PR, draft outranks a failing check: nobody is being asked to act on
// a draft yet. Across two PRs the failing one is waiting on you now and the draft
// is not, so it wins.
folds(['draft', 'checks-failed'], 'checks-failed', 'a broken PR outranks a draft you left alone');
folds(['draft', 'conflicting'], 'conflicting', 'so does a conflicting one');
folds(['changes', 'conflicting'], 'conflicting', 'a conflict outranks a review');
folds(['approved', 'open'], 'open', 'an approval is more progress than a plain open PR');
folds(['closed', 'merged'], 'closed', 'a PR nobody merged is not the same as one that landed');
folds(['approved', 'merged', 'closed'], 'approved', 'anything still live outranks both settled states');

// gh being unreachable is not a state a PR can be in, so it never beats a real
// answer — but it does beat the settled ones, because "all merged" is a claim that
// cannot be made about a PR nobody could reach.
folds(['unknown', 'merged'], 'unknown', 'one unreachable PR stops the row claiming all merged');
folds(['unknown', 'draft'], 'draft', 'a real answer beats no answer');
folds(['unknown', 'unknown'], 'unknown', 'nothing reachable says nothing');

assert.strictEqual(aggregate([]), null, 'a session with no PRs aggregates to nothing');
ok('a session with no PRs aggregates to nothing');
assert.strictEqual(aggregate(null), null, 'and so does one with no list at all');
ok('and so does one with no list at all');

// What the single word left out, for the tooltip.
const mixed = aggregate([at('merged'), at('draft'), at('merged')]);
assert.deepStrictEqual(mixed.counts, { merged: 2, draft: 1 }, 'counts carry the breakdown');
ok('counts carry the breakdown');
assert.strictEqual(mixed.total, 3, 'total is every PR, not just the winning one');
ok('total is every PR, not just the winning one');
assert.strictEqual(mixed.label, 'draft', 'the label is the winning PR\'s own words');
ok('the label is the winning PR\'s own words');

// The two orders have to stay talking about the same vocabulary. A status
// `resolveStatus` can return and `ATTENTION_ORDER` has never heard of would sort
// by an index of -1 and win every row in the app, silently.
const RESOLVABLE = ['merged', 'closed', 'draft', 'changes', 'checks-failed',
    'conflicting', 'checks-pending', 'approved', 'open'];
for (const status of RESOLVABLE) {
    assert.ok(ATTENTION_ORDER.includes(status),
        `ATTENTION_ORDER is missing "${status}", which resolveStatus can return`);
}
assert.ok(ATTENTION_ORDER.includes('unknown'), 'ATTENTION_ORDER must place gh being unreachable');
assert.strictEqual(ATTENTION_ORDER.length, RESOLVABLE.length + 1,
    'ATTENTION_ORDER has a status resolveStatus cannot produce');
ok('the two orderings share one vocabulary');

console.log(`\n  ${pass} checks passed`);
