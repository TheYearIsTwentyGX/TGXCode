'use strict';

// The code reviews a session ran — bridge/skill-runs.js finds the runs,
// bridge/code-reviews.js decides which are reviews and reads their findings.
//
// Every fixture here is a shape read off real transcripts, not one imagined:
// `code-review` runs as a fork and leaves its findings only in the fork's own
// file; `/adversarial-reviewer` runs inline with no end marker; a rejected call
// has a string `toolUseResult`; an agent's report is often in its own file,
// handed back. What goes wrong here does not throw — it is a review missing
// from the pane, or one shown as still running for ever — so each case asserts
// what the pane would draw.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-reviews-'));
process.env.XDG_CACHE_HOME = path.join(TMP, 'cache');
process.env.TGXCODE_PROJECTS_DIR = path.join(TMP, 'projects');
// Prefs reads ~/.tgxcode unless told otherwise, and writes it on first run.
process.env.TGXCODE_PREFS_DIR = path.join(TMP, 'prefs');
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});

const { SkillRunIndex } = require('../bridge/skill-runs.js');
const cr = require('../bridge/code-reviews.js');
const { DEFAULTS, Prefs } = require('../bridge/prefs.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

let clock = Date.parse('2026-10-01T10:00:00Z');
const ts = () => new Date(clock += 1000).toISOString();
const user = (uuid, text, extra = {}) => ({
    type: 'user', uuid, timestamp: ts(), isSidechain: false, ...extra,
    message: { role: 'user', content: typeof text === 'string' && extra.plain ? text : [{ type: 'text', text }] },
});
const said = (uuid, text) => ({
    type: 'assistant', uuid, timestamp: ts(), isSidechain: false,
    message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] },
});
const call = (uuid, id, name, input = {}) => ({
    type: 'assistant', uuid, timestamp: ts(), isSidechain: false,
    message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (uuid, id, content, toolUseResult, isError = false) => ({
    type: 'user', uuid, timestamp: ts(), isSidechain: false, toolUseResult,
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: isError }] },
});
// What every transcript carries and every substring filter trips on: the tool
// list, naming Skill and ReportFindings.
const snapshot = () => ({ type: 'attachment', isSidechain: false, timestamp: ts(),
    attachment: { type: 'prompt_snapshot', tools: [{ name: 'Skill' }, { name: 'ReportFindings' }],
        systemPrompt: ['"name":"Skill" '.repeat(500)] } });

const PROJ = path.join(process.env.TGXCODE_PROJECTS_DIR, '-tmp-x');
fs.mkdirSync(PROJ, { recursive: true });
let n = 0;
function session(entries) {
    const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const file = path.join(PROJ, `${id}.jsonl`);
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e) + '\n').join(''));
    return { id, file, rec: { dir: PROJ, file } };
}
const append = (s, entries) => fs.appendFileSync(s.file, entries.map(e => JSON.stringify(e) + '\n').join(''));
function fork(s, agentId, entries, dir = PROJ) {
    const d = path.join(dir, s.id, 'subagents');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `agent-${agentId}.jsonl`),
        entries.map(e => JSON.stringify({ ...e, isSidechain: true, agentId }) + '\n').join(''));
}

const TYPES = DEFAULTS.reviews.types;
const index = new SkillRunIndex(path.join(TMP, 'idx'));
const reviews = (s, types = TYPES, busy = false) => cr.list(index.update(s.id, s.file), types, s.rec, s.id, busy);
const review = (s, id, types = TYPES) => cr.one(index.update(s.id, s.file), types, s.rec, s.id, id, false);
// A transcript last written long ago, so "still being written" is not a reason
// for an open run to count as running.
const age = (s) => { const t = new Date(Date.now() - 3600_000); fs.utimesSync(s.file, t, t); };

const FORK_TEXT = 'Reviewed PR #134 (`working-documents` → `replit-dev`). Two problems.\n\n'
    + '- `src/a.ts:12` — readSheet re-parses the sheet per edit\n'
    + '- `src/b.ts:40` — csv is advertised but never handled';
const FINDINGS = [
    { file: 'src/a.ts', line: 12, category: 'efficiency', severity: 'high', verdict: 'CONFIRMED',
        short_summary: 'readSheet re-parses per edit', summary: 'It re-parses.', failure_scenario: '200 edits, 200 parses.' },
    { file: 'src/b.ts', line: 40, category: 'correctness', verdict: 'CONFIRMED',
        short_summary: 'csv advertised, never handled', summary: 'No CSV path.', failure_scenario: 'A .csv opens and fails.' },
    { file: 'src/c.ts', line: 7, category: 'correctness', verdict: 'PLAUSIBLE',
        summary: 'Maybe a race. Under load.', failure_scenario: 'Two saves at once.' },
];

// ---------------------------------------------------------------------------

{
    const s = session([
        snapshot(),
        user('u1', 'review it'),
        call('a1', 'toolu_fork1', 'Skill', { skill: 'code-review', args: '134 high' }),
        result('r1', 'toolu_fork1', `Skill "code-review" completed (forked execution).\n\nResult:\n${FORK_TEXT}`,
            { success: true, commandName: 'code-review', status: 'forked', agentId: 'afork1', result: FORK_TEXT }),
        said('a2', 'The review found real issues.'),
    ]);
    // The first call was refused for a long short_summary and retried: the retry stands.
    fork(s, 'afork1', [
        user('f0', 'Review target: `134 high`', { isMeta: true }),
        call('f1', 'rf1', 'ReportFindings', { level: 'high', findings: [{ file: 'x', summary: 'refused' }] }),
        result('f2', 'rf1', '<tool_use_error>InputValidationError: short_summary too long</tool_use_error>', null, true),
        call('f3', 'rf2', 'ReportFindings', { level: 'high', findings: FINDINGS }),
        result('f4', 'rf2', '3 findings reported.', null),
        said('f5', FORK_TEXT),
    ]);
    const list = reviews(s);
    assert.strictEqual(list.length, 1);
    const r = list[0];
    assert.strictEqual(r.type.id, 'code-review');
    assert.strictEqual(r.via, 'skill');
    assert.strictEqual(r.forked, true);
    assert.strictEqual(r.status, 'done');
    assert.strictEqual(r.findingSource, 'tool');
    assert.deepStrictEqual(r.counts, { critical: 1, warning: 1, note: 1 });
    assert.deepStrictEqual(r.anchor.kind, 'tool');
    assert.strictEqual(r.anchor.id, 'toolu_fork1');
    assert.strictEqual(r.target.pr, 134);
    assert.strictEqual(r.target.effort, 'high');
    assert.ok(r.startedAt && r.endedAt && r.endedAt > r.startedAt);
    ok('a forked code-review is found, with the findings its fork reported');

    const full = review(s, 'toolu_fork1');
    assert.deepStrictEqual(full.findings.map(f => f.severity), ['critical', 'warning', 'note']);
    const [hi, conf, plaus] = full.findings;
    assert.strictEqual(hi.title, 'readSheet re-parses per edit');
    assert.strictEqual(hi.file, 'src/a.ts');
    assert.strictEqual(hi.line, 12);
    assert.match(hi.body, /It re-parses\.\n\n\*\*How it fails:\*\* 200 edits/);
    assert.strictEqual(conf.confidence, 'CONFIRMED');
    assert.strictEqual(plaus.title, 'Maybe a race.', 'no short_summary: the first sentence');
    assert.strictEqual(plaus.confidence, 'PLAUSIBLE');
    assert.strictEqual(full.raw, FORK_TEXT);
    ok('a stated severity is kept; unrated CONFIRMED is a warning and PLAUSIBLE a note');
    ok('a ReportFindings call refused for validation is passed over for its retry');
}

{
    // The fork file is gone (or never written): the result text is all there is.
    const s = session([
        call('a1', 'toolu_fork2', 'Skill', { skill: 'code-review' }),
        result('r1', 'toolu_fork2', `Skill "code-review" completed (forked execution).\n\nResult:\n${FORK_TEXT}`,
            { success: true, status: 'forked', agentId: 'agone', result: FORK_TEXT }),
    ]);
    const full = review(s, 'toolu_fork2');
    assert.strictEqual(full.findingSource, 'text');
    assert.deepStrictEqual(full.findings.map(f => [f.file, f.line, f.title]), [
        ['src/a.ts', 12, 'readSheet re-parses the sheet per edit'],
        ['src/b.ts', 40, 'csv is advertised but never handled'],
    ]);
    assert.strictEqual(full.target.pr, 134, 'from "Reviewed PR #134" when there were no args');
    ok('with no fork file, a flat `path:line` list in the result is parsed as findings');
}

{
    const fenced = 'Here are the findings:\n\n```json\n' + JSON.stringify(FINDINGS.slice(0, 2), null, 2) + '\n```\n';
    const s = session([
        call('a1', 'toolu_json', 'Skill', { skill: 'code-review', args: '--diff main..HEAD' }),
        result('r1', 'toolu_json', 'Skill "code-review" completed (forked execution).\n\nResult:\n' + fenced,
            { success: true, status: 'forked', agentId: 'anofile', result: fenced }),
    ]);
    const full = review(s, 'toolu_json');
    assert.strictEqual(full.findingSource, 'json');
    assert.strictEqual(full.findings.length, 2);
    assert.strictEqual(full.target.range, 'main..HEAD');
    ok('a ```json array in the result is read as structured findings');
}

{
    // Without toolUseResult — the shape inside a subagent's own transcript.
    const s = session([
        call('a1', 'toolu_prefix', 'Skill', { skill: 'code-review' }),
        result('r1', 'toolu_prefix', `Skill "code-review" completed (forked execution).\n\nResult:\n${FORK_TEXT}`, null),
    ]);
    const [r] = reviews(s);
    assert.strictEqual(r.forked, true);
    assert.strictEqual(r.status, 'done');
    assert.strictEqual(review(s, 'toolu_prefix').raw, FORK_TEXT);
    ok('a fork is recognised from the result text when toolUseResult is missing');
}

const ADVERSARIAL = [
    '## Adversarial Review: PR #172 — Lawsuits port',
    '',
    '**Scope:** 30 files',
    '**Verdict: BLOCK**',
    '',
    '### Critical Findings',
    '',
    '**1. Delete has no audit trail** — `src/lib/server.ts:780`',
    'Rows vanish.',
    '',
    '### Warnings',
    '',
    '**W1 — Dates render a day early** (`src/routes/page.tsx:429`)',
    'Timezone.',
    '',
    '### Notes',
    '',
    'None.',
].join('\n');

{
    const s = session([
        user('c1', '<command-message>adversarial-reviewer</command-message>\n<command-name>/adversarial-reviewer</command-name>\n<command-args>PR 172</command-args>', { plain: true }),
        user('m1', 'Base directory for this skill: /x\n\n# Adversarial Code Reviewer', { isMeta: true }),
        said('a1', 'Let me read the diff.'),
        call('a2', 'toolu_bash', 'Bash', { command: 'git diff' }),
        result('r2', 'toolu_bash', 'diff --git'),
        said('a3', ADVERSARIAL),
        said('a4', 'Want me to fix these?'),
        user('u2', 'yes, fix the critical one'),
        said('a5', 'Fixed in src/lib/server.ts:780.'),
    ]);
    const [r] = reviews(s);
    assert.strictEqual(r.type.id, 'adversarial');
    assert.strictEqual(r.via, 'command');
    assert.strictEqual(r.anchor.kind, 'turn');
    assert.strictEqual(r.anchor.id, 'c1');
    assert.strictEqual(r.status, 'done');
    assert.strictEqual(r.verdict, 'BLOCK');
    assert.strictEqual(r.title, 'PR #172 — Lawsuits port');
    assert.strictEqual(r.target.pr, 172);
    assert.deepStrictEqual(r.counts, { critical: 1, warning: 1, note: 0 });
    const full = review(s, 'c1');
    assert.strictEqual(full.raw, ADVERSARIAL, 'the review, not the "want me to fix" after it, nor the next turn');
    assert.strictEqual(full.findings[0].file, 'src/lib/server.ts');
    ok('a slash /adversarial-reviewer is a review that ends at your next prompt, with its verdict');
}

{
    const s = session([
        user('u1', 'go'),
        call('a1', 'toolu_inline', 'Skill', { skill: 'adversarial-reviewer', args: 'PR 117' }),
        result('r1', 'toolu_inline', 'Launching skill: adversarial-reviewer', { success: true, commandName: 'adversarial-reviewer' }),
        user('m1', 'Base directory for this skill: /x', { isMeta: true, sourceToolUseID: 'toolu_inline' }),
        said('a2', 'Reading.'),
    ]);
    // Mid-run: the transcript was just written, so it is running.
    let [r] = reviews(s);
    assert.strictEqual(r.status, 'running');
    assert.strictEqual(r.findingSource, 'none');
    append(s, [said('a3', ADVERSARIAL)]);
    age(s);
    [r] = reviews(s);
    assert.strictEqual(r.status, 'done', 'quiet transcript, no process: the inline run finished');
    assert.strictEqual(r.verdict, 'BLOCK');
    assert.strictEqual(r.target.pr, 117);
    // The bridge's own process saying the turn is still going wins over the clock.
    [r] = reviews(s, TYPES, true);
    assert.strictEqual(r.status, 'running');
    ok('an inline Skill run is open until the session goes quiet, and its result is picked up on append');
}

{
    const s = session([
        call('a1', 'toolu_no', 'Skill', { skill: 'code-review', args: '5' }),
        result('r1', 'toolu_no', 'The user doesn\'t want to proceed with this tool use.', 'User rejected tool use', true),
    ]);
    const [r] = reviews(s);
    assert.strictEqual(r.status, 'rejected');
    assert.strictEqual(r.findingSource, 'none');
    ok('a rejected review call is listed as rejected, with no findings');
}

{
    const s = session([
        call('a1', 'toolu_agent', 'Agent', { subagent_type: 'feature-dev:code-reviewer', description: 'Review PR 9',
            prompt: 'Review the diff.' }),
        result('r1', 'toolu_agent', [{ type: 'text', text: 'This agent\'s report was delivered to you as a message from "aag1" (its SubagentHandback call).' }],
            { status: 'completed', agentId: 'aag1', handback: 'send' }),
        call('a2', 'toolu_agent2', 'Agent', { subagent_type: 'general-purpose', description: 'Adversarial pass',
            prompt: 'Invoke the `adversarial-reviewer` skill on PR 117. End with `VERDICT: clean` or `VERDICT: issues`.' }),
        result('r2', 'toolu_agent2', [{ type: 'text', text: 'Async agent launched successfully.\nagentId: aag2' }],
            { isAsync: true, status: 'async_launched', agentId: 'aag2' }),
        call('a3', 'toolu_explore', 'Agent', { subagent_type: 'Explore', prompt: 'Find the code-review route. See /code-reviewer docs.' }),
        result('r3', 'toolu_explore', 'found it', { status: 'completed', agentId: 'aexp' }),
    ]);
    fork(s, 'aag1', [call('h1', 'hb', 'SubagentHandback', { message: ADVERSARIAL })]);
    const types = [...TYPES, { id: 'fdr', label: 'Feature dev', skill: 'feature-dev:code-reviewer', colour: 'green' }];
    let list = reviews(s, types);
    assert.deepStrictEqual(list.map(r => r.id), ['toolu_agent', 'toolu_agent2'], 'the Explore agent is not a review');
    assert.strictEqual(list[0].type.id, 'fdr');
    assert.strictEqual(list[0].verdict, 'BLOCK', 'read from the handback, not the pointer');
    assert.strictEqual(list[1].type.id, 'adversarial', 'matched by the prompt naming the skill');
    age(s);
    list = reviews(s, types);
    assert.strictEqual(list[1].status, 'incomplete', 'an async agent with no notification, gone quiet');
    append(s, [{ type: 'attachment', isSidechain: false, timestamp: ts(), attachment: { type: 'queued_command',
        prompt: '<task-notification>\n<task-id>aag2</task-id>\n<tool-use-id>toolu_agent2</tool-use-id>\n<status>completed</status>\n<result>Two issues.\n\nVERDICT: issues</result>\n</task-notification>' } }]);
    age(s);
    list = reviews(s, types);
    assert.strictEqual(list[1].status, 'done');
    assert.strictEqual(list[1].verdict, 'CONCERNS', 'VERDICT: issues');
    ok('agent reviews: by subagent type, by a prompt naming the skill, settled by their notification');
}

{
    // What a bridge-run session writes for `/code-review low` sent over
    // stream-json: no command tags and no assistant turn. Claude Code runs the
    // forked skill itself, and its result is a local_command system entry. The
    // fork is tied to the prompt only by promptId. Read off a live run.
    const s = session([
        user('cv', '<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>',
            { isMeta: true, plain: true, promptId: 'p-1' }),
        user('c1', '/code-review low', { plain: true, promptId: 'p-1' }),
        { type: 'system', subtype: 'local_command', uuid: 's1', isSidechain: false, timestamp: ts(),
            content: '<local-command-stdout>math.js:2 — `add` now returns `a - b` instead of `a + b`.</local-command-stdout>' },
        user('c2', '/review-nonsense', { plain: true, promptId: 'p-2' }),
        { type: 'system', subtype: 'local_command', uuid: 's2', isSidechain: false, timestamp: ts(),
            content: '<local-command-stdout>Unknown command: /review-nonsense</local-command-stdout>' },
        user('u3', '/home/dylan is where it lives', { plain: true }),
    ]);
    fork(s, 'aprompt', [user('f0', 'low effort → 1 diff pass', { plain: true, promptId: 'p-1' }),
        said('f1', 'math.js:2 — `add` now returns `a - b` instead of `a + b`.')]);
    const types = [...TYPES, { id: 'nonsense', label: 'Nonsense', skill: 'review-nonsense', colour: 'peach' }];
    const list = reviews(s, types);
    assert.deepStrictEqual(list.map(r => [r.id, r.via, r.status]), [['c1', 'command', 'done'], ['c2', 'command', 'error']]);
    assert.strictEqual(list[0].forked, true, 'its fork found by promptId');
    assert.strictEqual(list[0].target.effort, 'low');
    const full = review(s, 'c1', types);
    assert.strictEqual(full.findingSource, 'text');
    assert.deepStrictEqual(full.findings.map(f => [f.file, f.line, f.title]),
        [['math.js', 2, 'add now returns a - b instead of a + b']]);
    ok('a slash review sent over stream-json: its printed result, its fork by promptId, an unknown command an error');
}

{
    // Filtering is at query time: adding a type shows past runs with no rebuild.
    const s = session([
        call('a1', 'toolu_sec', 'Skill', { skill: 'security-review' }),
        result('r1', 'toolu_sec', 'Skill "security-review" completed (forked execution).\n\nResult:\nNothing found.',
            { status: 'forked', agentId: 'asec', result: 'Nothing found.' }),
        call('a2', 'toolu_plug', 'Skill', { skill: 'code-review:code-review' }),
        result('r2', 'toolu_plug', 'Launching skill: code-review:code-review', { success: true }),
    ]);
    assert.deepStrictEqual(reviews(s).map(r => r.id), [], 'neither is configured; `code-review` is not `code-review:code-review`');
    const consumed = index.update(s.id, s.file).idx.consumed;
    const types = [...TYPES, { id: 'sec', label: 'Security', skill: '/Security-Review', colour: 'purple' },
        { id: 'plug', label: 'Plugin', skill: 'code-review:code-review', colour: 'peach' }];
    assert.deepStrictEqual(reviews(s, types).map(r => r.type.id), ['sec', 'plug']);
    assert.strictEqual(index.update(s.id, s.file).idx.consumed, consumed, 'nothing re-read');
    ok('which skills are reviews is decided at query time, by exact name, ignoring a leading / and case');
}

{
    // A session that moved into a worktree has a directory under each project;
    // its fork may be filed under the other one.
    const other = path.join(process.env.TGXCODE_PROJECTS_DIR, '-tmp-x--claude-worktrees-w');
    const s = session([
        call('a1', 'toolu_far', 'Skill', { skill: 'code-review' }),
        result('r1', 'toolu_far', 'x', { status: 'forked', agentId: 'afar', result: 'See findings.' }),
    ]);
    fork(s, 'afar', [call('f1', 'rf', 'ReportFindings', { findings: FINDINGS.slice(1, 2) }), result('f2', 'rf', '1 finding reported.')], other);
    const [r] = reviews(s);
    assert.strictEqual(r.findingSource, 'tool');
    assert.strictEqual(r.counts.warning, 1);
    ok('a fork filed under the other worktree directory is still found');
}

{
    // Incremental, and rebuilt when the file is replaced.
    const s = session([user('u1', 'hello'), said('a1', 'hi')]);
    assert.strictEqual(reviews(s).length, 0);
    append(s, [call('a2', 'toolu_late', 'Skill', { skill: 'code-review' })]);
    let [r] = reviews(s);
    assert.strictEqual(r.status, 'running');
    append(s, [result('r1', 'toolu_late', 'x', { status: 'forked', agentId: 'alate', result: 'No problems found.' })]);
    [r] = reviews(s);
    assert.strictEqual(r.status, 'done');

    // A fresh instance reads what the last one saved.
    const again = new SkillRunIndex(path.join(TMP, 'idx'));
    assert.strictEqual(again.update(s.id, s.file).idx.runs.length, 1);

    fs.writeFileSync(s.file, JSON.stringify(user('z1', 'different')) + '\n');
    assert.strictEqual(reviews(s).length, 0, 'a replaced file is rebuilt, not appended to');
    index.forget(s.id);
    assert.ok(!fs.existsSync(path.join(TMP, 'idx', `${s.id}.json`)));
    ok('the index is incremental, survives a restart, rebuilds a replaced file and forgets on delete');
}

{
    const t = cr.targetOf;
    assert.deepStrictEqual(t('134 high'), { pr: 134, range: null, files: [], effort: 'high', text: '134 high' });
    assert.strictEqual(t('PR 117').pr, 117);
    assert.strictEqual(t('--target 162 high').pr, 162);
    assert.strictEqual(t('https://github.com/o/r/pull/88 again').pr, 88);
    assert.strictEqual(t('origin/replit-dev...HEAD high').range, 'origin/replit-dev...HEAD');
    assert.strictEqual(t('--diff fe48..4702\n\nReview 1 commit').range, 'fe48..4702');
    assert.deepStrictEqual(t('high src/lib/a.ts src/b.tsx').files, ['src/lib/a.ts', 'src/b.tsx']);
    assert.deepStrictEqual(t(''), { pr: null, range: null, files: [], effort: null, text: null });
    assert.strictEqual(t('do another strong review').pr, null);
    assert.strictEqual(t('', '', 'medium').effort, 'medium', 'from ReportFindings.level');
    ok('targets: PR numbers, ranges, files and effort in every argument shape seen');
}

{
    const notes = [];
    const clean = require('../bridge/prefs.js').SANITIZE.reviews.types;
    const out = clean([
        { skill: '/code-review' },
        { id: 'adv', label: '  Adversarial  ', skill: 'adversarial-reviewer', colour: 'hotpink' },
        { id: 'adv', skill: 'again' },
        { skill: 'has space' },
        'nope',
    ], (m) => notes.push(m));
    assert.deepStrictEqual(out, [
        { id: 'code-review', label: 'code-review', skill: 'code-review', colour: 'blue' },
        { id: 'adv', label: 'Adversarial', skill: 'adversarial-reviewer', colour: 'blue' },
    ]);
    assert.strictEqual(notes.length, 4);
    assert.ok(require('../bridge/prefs.js').SHAPE.reviews.types(out));
    // A project may set it — prefs.test.js covers how project files merge.
    const { USER_ONLY } = require('../bridge/prefs.js');
    assert.ok(!USER_ONLY.has('reviews'));
    assert.deepStrictEqual(new Prefs().forCwd(null).reviews.types.map(x => x.id), ['code-review', 'adversarial']);
    ok('reviews.types is cleaned entry by entry, defaults to two types, and is not user-only');
}

console.log(`\ncode-reviews: ${pass} passed`);
