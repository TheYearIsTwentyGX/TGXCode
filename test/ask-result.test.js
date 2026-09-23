'use strict';

// What a plan and a question leave behind once they have been answered.
//
// The record of a decision used to show the choices and not the choice. A
// question's answers are in the transcript — `toolUseResult.answers`, keyed by
// the question text — but `resultPayload` keeps a fixed whitelist of result
// fields and that was not on it, so every option read back with the same mark
// and the one fact worth reviewing was dropped a layer below the UI. Same for a
// plan approved with a note: the note is appended to the plan the *tool*
// receives, so it lives in `toolUseResult.plan` and nowhere else, and reading
// `input.plan` gives you the plan as proposed rather than as agreed to.
//
// Here rather than against a live bridge, for the reason handoff.test.js gives:
// this is a property of `buildEvents` reading entries, and `buildEvents` takes
// already-parsed objects — so there is no file, no port and no bridge in it.
//
// **The case that could actually crash.** `toolUseResult` is an object for a
// call that produced structure and a bare string — "Error: …" — on every error
// path. The fields that were there before got away with reading straight
// through it, because a string answers `undefined` to every property they
// wanted. `answers` and `plan` are the fields an error case would most
// plausibly carry, so the guard is deliberate rather than accidental, and case
// 2 is what stops a later refactor from removing it.

const assert = require('assert');

const { buildEvents } = require('../bridge/transcript.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TS = '2026-09-22T12:00:00.000Z';

/** An assistant entry holding one tool call. */
function call(id, name, input) {
    return {
        type: 'assistant', timestamp: TS, uuid: `u-${id}`,
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    };
}

/** The user entry that carries its result back. */
function result(id, { text = '', isError = false, structured = undefined } = {}) {
    return {
        type: 'user', timestamp: TS, uuid: `r-${id}`,
        message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }],
        },
        toolUseResult: structured,
    };
}

// buildEvents answers `{events, model}` rather than a bare array — the model is
// the last assistant model seen, which nothing here cares about.
const toolOf = (out, id) => out.events.find(e => e.kind === 'tool' && e.id === id);
const patchOf = (out, id) => out.events.find(e => e.kind === 'tool-result' && e.toolId === id);

// ── 1. a question's answers survive ──────────────────────────────────────

const QUESTIONS = [
    {
        question: 'Which layout?', header: 'Layout', multiSelect: false,
        options: [{ label: 'Wide modal' }, { label: 'Equal columns' }],
    },
    {
        // A label with a comma of its own. 187 of 414 real questions on this
        // machine had one, which is why the documented way to read a
        // multi-select answer consumes whole labels rather than splitting on
        // ", ".
        question: 'Which surfaces?', header: 'Surfaces', multiSelect: true,
        options: [{ label: 'Bar, count, cycling' }, { label: 'The rail' }],
    },
];

const ANSWERS = {
    'Which layout?': 'Wide modal',
    'Which surfaces?': 'Bar, count, cycling, The rail',
};

{
    const events = buildEvents([
        call('toolu_q1', 'AskUserQuestion', { questions: QUESTIONS }),
        result('toolu_q1', {
            text: 'Your questions have been answered.',
            // The real shape: the echo of the input beside the answers.
            structured: { questions: QUESTIONS, answers: ANSWERS },
        }),
    ]);
    const ev = toolOf(events, 'toolu_q1');
    assert.strictEqual(ev.status, 'ok');
    assert.deepStrictEqual(ev.result.answers, ANSWERS);
    ok('a question carries the answers it was given');

    // The other half of that result is a verbatim echo of the call's own input.
    // Carrying it would double the payload to repeat what the client already
    // has, so it is left behind — and this is the assertion a later "just
    // spread `structured`" refactor would trip over, which is the point.
    assert.strictEqual(ev.result.questions, undefined);
    ok('the echoed questions are left behind, not carried twice');
}

// ── 2. a string toolUseResult yields nulls and does not throw ────────────

{
    const events = buildEvents([
        call('toolu_q2', 'AskUserQuestion', { questions: QUESTIONS }),
        result('toolu_q2', {
            text: 'The question was dismissed unanswered. Use your own judgement and carry on.',
            isError: true,
            structured: 'Error: The question was dismissed unanswered.',
        }),
    ]);
    const ev = toolOf(events, 'toolu_q2');
    assert.strictEqual(ev.status, 'error');
    assert.strictEqual(ev.result.answers, null);
    assert.strictEqual(ev.result.plan, null);
    assert.strictEqual(ev.result.planWasEdited, false);
    // The reason is still readable — it is the half of the record the client
    // shows when there are no answers to show.
    assert.match(ev.result.text, /dismissed unanswered/);
    ok('a dismissed question reads back as an error with nulls, not a crash');
}

// ── 3. an approved plan is the plan as approved ──────────────────────────

const PROPOSED = '# Do the thing\n\nFirst this, then that.';
const NOTE = '\n\n## Note from the user\nLeave the migration alone.\n';

{
    const events = buildEvents([
        call('toolu_p1', 'ExitPlanMode', { plan: PROPOSED, planFilePath: '/tmp/plan.md' }),
        result('toolu_p1', {
            text: `User has approved your plan.\n\n## Approved Plan:\n${PROPOSED}${NOTE}`,
            structured: { plan: PROPOSED + NOTE, planWasEdited: true, filePath: '/tmp/plan.md' },
        }),
    ]);
    const ev = toolOf(events, 'toolu_p1');
    assert.strictEqual(ev.status, 'ok');
    assert.strictEqual(ev.result.planWasEdited, true);
    assert.match(ev.result.plan, /## Note from the user/);
    // The whole reason the field exists: the input is what was put forward and
    // the result is what was agreed to. If these were ever equal here, reading
    // `input.plan` would have been enough and this test would be theatre.
    assert.notStrictEqual(ev.result.plan, ev.input.plan);
    assert.strictEqual(ev.input.plan, PROPOSED);
    ok('a plan approved with a note carries the note, and the input still has the proposal');
}

{
    const events = buildEvents([
        call('toolu_p2', 'ExitPlanMode', { plan: PROPOSED }),
        result('toolu_p2', {
            text: 'User has approved your plan.',
            structured: { plan: PROPOSED },
        }),
    ]);
    const ev = toolOf(events, 'toolu_p2');
    assert.strictEqual(ev.result.plan, PROPOSED);
    // Written only when true, so its absence is the ordinary case saying
    // nothing rather than a recorded `false`.
    assert.strictEqual(ev.result.planWasEdited, false);
    ok('a plain approval carries the plan and reports no edit');
}

// ── 4. a rejected plan keeps the feedback ────────────────────────────────

{
    const said = 'Research the alternatives first.';
    const events = buildEvents([
        call('toolu_p3', 'ExitPlanMode', { plan: PROPOSED }),
        result('toolu_p3', { text: said, isError: true, structured: `Error: ${said}` }),
    ]);
    const ev = toolOf(events, 'toolu_p3');
    assert.strictEqual(ev.status, 'error');
    assert.strictEqual(ev.result.plan, null);
    assert.strictEqual(ev.result.text, said);
    ok('a plan sent back keeps what was said about it');
}

// ── 5. the tail path carries them too ────────────────────────────────────
//
// A call resolves in one of two ways: in the same read as its result, where the
// payload is assigned onto the tool event, or in a later one, where it is
// emitted as a `tool-result` patch the client applies. Every live tail takes
// the second path, so a field that only worked in the first would be missing
// exactly while you were watching — and present on reload, which is the worst
// way to find a bug. Carrying the fields unconditionally is what lets this be
// a deepStrictEqual against case 1 rather than a weaker assertion.

{
    const first = buildEvents([call('toolu_q3', 'AskUserQuestion', { questions: QUESTIONS })]);
    assert.strictEqual(toolOf(first, 'toolu_q3').result, null);

    const second = buildEvents([result('toolu_q3', {
        text: 'Your questions have been answered.',
        structured: { questions: QUESTIONS, answers: ANSWERS },
    })]);
    const patch = patchOf(second, 'toolu_q3');
    assert.ok(patch, 'a result whose call was in an earlier read emits a patch');
    assert.deepStrictEqual(patch.result.answers, ANSWERS);
    ok('the answers ride the tool-result patch, not only the resolved call');
}

{
    const second = buildEvents([result('toolu_p4', {
        text: 'User has approved your plan.',
        structured: { plan: PROPOSED + NOTE, planWasEdited: true },
    })]);
    const patch = patchOf(second, 'toolu_p4');
    assert.match(patch.result.plan, /## Note from the user/);
    assert.strictEqual(patch.result.planWasEdited, true);
    ok('so does the approved plan');
}

// ── readAnswer, the client's half of that contract ───────────────────────
//
// `docs/api.md` describes how a value in `answers` decomposes into the options
// it picked and the words somebody typed, because a second client has to do the
// same work. This is the first client's implementation of it, and it is the one
// piece of this feature with logic subtle enough to have already been wrong
// once: it used to search the whole string for a label, which marked an option
// that had been quoted mid-sentence to argue *against* it.
//
// It lives in web/app.js, which the Node suite cannot require — that file is a
// browser module with a `dom` and a `state` behind it. So the function is cut
// out by name and evaluated on its own. That is a liberty, and it is taken for
// exactly one reason: this function is pure, it is the part a wrong answer is
// silently wrong in, and the alternative on offer was not testing it. The
// extractor fails loudly rather than quietly matching nothing if it is renamed.

const fs = require('fs');
const path = require('path');

/** Cut one top-level function out of web/app.js by name, by counting braces. */
function lift(name) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
    const at = src.indexOf(`function ${name}(`);
    assert.notStrictEqual(at, -1, `${name} is gone from web/app.js — this test is stale`);
    let depth = 0;
    let i = src.indexOf('{', at);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
    }
    assert.ok(i < src.length, `${name} has unbalanced braces`);
    return new Function(`${src.slice(at, i + 1)}; return ${name};`)();
}

const readAnswer = lift('readAnswer');
const OPTS = [{ label: 'Wide modal' }, { label: 'Equal columns' },
    { label: 'Approve' }, { label: 'Approve with feedback' }];
const read = (a, opts = OPTS) => {
    const r = readAnswer(a, opts);
    return { chosen: [...r.chosen], said: r.said };
};

assert.deepStrictEqual(read('Wide modal'), { chosen: ['Wide modal'], said: '' });
ok('a single choice is the label, verbatim');

assert.deepStrictEqual(read('Wide modal, Equal columns'),
    { chosen: ['Wide modal', 'Equal columns'], said: '' });
// One transcript on this machine joined with no space after the comma.
assert.deepStrictEqual(read('Wide modal,Equal columns'),
    { chosen: ['Wide modal', 'Equal columns'], said: '' });
ok('a multi-select splits on the separator, with or without the space');

// Longest-first. Taking "Approve" first would leave " with feedback" behind as
// free text and mark the wrong option.
assert.deepStrictEqual(read('Approve with feedback'),
    { chosen: ['Approve with feedback'], said: '' });
ok('a label that is a prefix of another does not win');

// A label containing a comma of its own — 187 of 414 real questions had one, so
// splitting on ", " would shred this and mark nothing.
const COMMA = [{ label: 'Bar, count, cycling' }, { label: 'The rail' }];
assert.deepStrictEqual(read('Bar, count, cycling, The rail', COMMA),
    { chosen: ['Bar, count, cycling', 'The rail'], said: '' });
ok('a label with a comma inside it survives');

// **The regression.** Both of these used to mark "Wide modal": the label is a
// whole comma-bounded segment, so a search over the whole string found it. It
// is being at the *front* that means somebody picked it — the dock joins the
// picks first and pushes anything typed onto the end.
assert.deepStrictEqual(read('Because of X, Wide modal, is wrong'),
    { chosen: [], said: 'Because of X, Wide modal, is wrong' });
assert.deepStrictEqual(read('I would rather not use Wide modal'),
    { chosen: [], said: 'I would rather not use Wide modal' });
ok('a label quoted mid-sentence is not a choice');

// The ambiguous one, documented at readAnswer and in docs/api.md: this is the
// same bytes as ticking the option and typing the qualifier, so it is read as
// both. The typed words are kept either way, which is what makes that reading
// safe to take.
assert.deepStrictEqual(read('Wide modal, but simpler'),
    { chosen: ['Wide modal'], said: 'but simpler' });
ok('a label followed by typed words keeps both');

assert.deepStrictEqual(read('Just do whatever'), { chosen: [], said: 'Just do whatever' });
ok('free text that matches nothing comes back whole');

// Degenerate input reaches this straight off a transcript nobody validated.
for (const [a, opts] of [[null, OPTS], [undefined, OPTS], ['', OPTS], ['x', undefined],
    ['a', [null, { label: 'a' }]], ['a', [{ label: '' }, { label: 'a' }]],
    [',', [{ label: ',' }]], [',,,', [{ label: 'a' }]]]) {
    assert.doesNotThrow(() => readAnswer(a, opts));
}
ok('nothing in the degenerate cases throws or hangs');

console.log(`\nask-result: ${pass} passed`);
