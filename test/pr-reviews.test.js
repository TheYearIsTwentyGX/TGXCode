'use strict';

// The nightly review's findings, read back (bridge/pr-reviews.js).
//
// Mostly the parser, because that is the part with no right answer to check
// against: the review is prose a model wrote to a template, and how an item inside
// a section is written changes from night to night. The fixtures below are the
// shapes that have actually appeared — `1. **Title**`, `**W1. Title**`,
// `**C1 — Title**`, `**1. Title**` over plain sub-bullets, and `- **Title**`
// notes — plus the two that would quietly produce wrong findings rather than none:
// a Critical section that says "None." and then lists what it checked, and bold
// sub-bullets (`- **Fix:**`) under a numbered item.
//
// Then the plumbing that decides *which* review a PR shows: the gate's own record
// over GitHub's copy, the comment marker, staleness against the head, and the
// background read that must never run for a PR this bridge reviewed itself.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-pr-reviews-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });
process.env.XDG_CACHE_HOME = TMP;
process.env.XDG_DATA_HOME = TMP;

const reviews = require('../bridge/pr-reviews.js');
const prStore = require('../bridge/pr-store.js');
const { sessionTitle } = require('../bridge/routes/pr-reviews.js');
const { parseReview, pickGateComment, lastAssistantText, fixPrompt, fixAllFindings, countsOf } = reviews;

// --- numbered items, with indented bold sub-bullets ---------------------------

const NUMBERED = `## Adversarial Review: importer, \`aaa..bbb\` (3 commits)

**Scope:** 4 files, +200/−10.

**Verdict:** CONCERNS

### Critical Findings
None. Nothing here loses data.

### Warnings

1. **The guard checks the port asked for, not the one listening.** \`scripts/guard.mjs:155-164\`, mirrored in \`walk.sh:921\`.
   - **Failure case:** two processes claim one port.
   - **Fix:** ask \`ss\` who is listening.

2. **A killed take leaves a stale fingerprint.** \`record.mjs:644–664\`. ffmpeg writes in place.
   - **Fix:** write to a temp file and rename.

3. **Registering the editor key adds a rule that does nothing.** The loader checks \`routes/surveys_.entry_.$id.tsx:145\`.

### Notes
- **SKILL.md is out of date in places.**
- **\`training:publish\` goes live by default.** A \`--yes\` flag would help.

### Summary
Two real problems and a misleading rule.

VERDICT: CONCERNS
`;

{
    const r = parseReview(NUMBERED);
    assert.strictEqual(r.verdict, 'CONCERNS');
    assert.strictEqual(r.title, 'importer, `aaa..bbb` (3 commits)');
    assert.strictEqual(r.scope, '4 files, +200/−10.');
    assert.strictEqual(r.summary, 'Two real problems and a misleading rule.');
    assert.strictEqual(r.raw, NUMBERED);
    ok('the head of a review: verdict, title, scope and summary');

    const warnings = r.findings.filter(f => f.severity === 'warning');
    assert.deepStrictEqual(warnings.map(f => f.title), [
        'The guard checks the port asked for, not the one listening',
        'A killed take leaves a stale fingerprint',
        'Registering the editor key adds a rule that does nothing',
    ]);
    ok('numbered items are one finding each, and their bold sub-bullets are not');

    assert.deepStrictEqual([warnings[0].file, warnings[0].line, warnings[0].endLine], ['scripts/guard.mjs', 155, 164]);
    assert.deepStrictEqual([warnings[1].file, warnings[1].line, warnings[1].endLine], ['record.mjs', 644, 664]);
    assert.deepStrictEqual([warnings[2].file, warnings[2].line], ['routes/surveys_.entry_.$id.tsx', 145]);
    ok('the first file:line a finding names, with an en-dash range and a $ in the path');

    assert.ok(warnings[0].body.includes('**Fix:** ask `ss` who is listening.'));
    assert.ok(!warnings[0].body.includes('ffmpeg'), 'a finding stops where the next one starts');
    ok('a finding\'s body is all of its markdown, and only its own');

    assert.ok(!r.findings.some(f => f.severity === 'critical'));
    assert.deepStrictEqual(r.findings.filter(f => f.severity === 'note').map(f => f.title),
        ['SKILL.md is out of date in places', 'training:publish goes live by default']);
    assert.deepStrictEqual(countsOf(r.findings), { critical: 0, warning: 3, note: 2 });
    ok('bullet notes, and a Critical section that says "None." has no findings');
}

// --- labelled bold paragraphs, with unindented Fix bullets ------------------

const LABELLED = `## Adversarial Review: design-kit sync

**Scope:** 39 files.

**Verdict:** BLOCK

### Critical Findings

**C1 — The guidance documents a pattern that is now lint-blocked.**
It is in \`src/styles.css:99\`.

- **Fix:** delete the section.

**C2 — The branch is 201 commits behind.**

### Warnings

**W1. \`guidelinesGlob\` uploads an internal contract.** See \`docs/api-contract.md\`.
- **Fix:** narrow the glob.

### Notes

- **\`.design-sync/**\` is inside \`tsconfig.json\`'s \`include\`**, so 18 files gate typecheck.
- Spot-checks that came back **accurate**, for the record: all of them.

**VERDICT: BLOCK**
`;

{
    const r = parseReview(LABELLED);
    assert.strictEqual(r.verdict, 'BLOCK');
    assert.deepStrictEqual(r.findings.map(f => [f.severity, f.title]), [
        ['critical', 'The guidance documents a pattern that is now lint-blocked'],
        ['critical', 'The branch is 201 commits behind'],
        ['warning', 'guidelinesGlob uploads an internal contract'],
        ['note', ".design-sync/** is inside tsconfig.json's include"],
        ['note', 'Spot-checks that came back accurate, for the record: all of them'],
    ]);
    ok('**C1 —** and **W1.** paragraphs; the label is dropped from the title');

    assert.ok(r.findings[0].body.includes('- **Fix:** delete the section.'));
    assert.strictEqual(r.findings[0].file, 'src/styles.css');
    assert.strictEqual(r.findings[2].file, 'docs/api-contract.md');
    assert.strictEqual(r.findings[2].line, null);
    ok('an unindented Fix bullet stays with its finding; a path with no line is still a file');
}

// --- bold-numbered paragraphs over plain sub-bullets ------------------------

const BOLD_NUMBERED = `## Adversarial Review: clear button

**Verdict:** BLOCK

### Critical Findings

**1. Clear deletes who reconciled a shift and records nothing.** *(two personas)*
- \`clearVerificationFn\` (\`src/lib/functions.ts\`) never reads the user.
- Nothing writes an audit row.

### Warnings

**2. Restoring stores the time 5–6 hours early.**
- The column is on the allowlist.

VERDICT: BLOCK
`;

{
    const r = parseReview(BOLD_NUMBERED);
    assert.deepStrictEqual(r.findings.map(f => [f.severity, f.title]), [
        ['critical', 'Clear deletes who reconciled a shift and records nothing'],
        ['warning', 'Restoring stores the time 5–6 hours early'],
    ]);
    assert.strictEqual(r.findings[0].file, 'src/lib/functions.ts');
    ok('**1. Title** paragraphs, with their plain bullets as body');
}

// --- a Critical section that lists what it checked --------------------------

{
    const r = parseReview(`**Verdict:** CONCERNS

### Critical Findings
None. I checked these likely failure points and they hold:
- **Central-time conversion.** Correct.
- **Parameter limits.** Under it.

### Warnings
1. **Superseded rows are counted twice** (\`upload.ts:66\`).

VERDICT: CONCERNS`);
    assert.deepStrictEqual(r.findings.map(f => f.severity), ['warning']);
    assert.strictEqual(r.findings[0].title, 'Superseded rows are counted twice');
    ok('"None." followed by a list of things that hold is not a list of criticals');
}

// --- nothing to parse --------------------------------------------------------

{
    const text = 'Still holds: zero models lost. The plan is unchanged and ready.';
    const r = parseReview(text);
    assert.deepStrictEqual(r.findings, []);
    assert.strictEqual(r.verdict, null);
    assert.strictEqual(r.raw, text);
    ok('a final message with no sections has no findings and keeps its text');

    const clean = parseReview('## Adversarial Review: tiny\n\n**Verdict:** CLEAN\n\n### Notes\n- A comment is stale.\n');
    assert.strictEqual(clean.verdict, 'CLEAN');
    assert.deepStrictEqual(clean.findings.map(f => [f.severity, f.title]), [['note', 'A comment is stale']]);
    assert.deepStrictEqual(parseReview('').findings, []);
    assert.deepStrictEqual(parseReview(null).findings, []);
    ok('CLEAN with notes only; empty and null input');

    const crlf = parseReview(NUMBERED.replace(/\n/g, '\r\n'));
    assert.strictEqual(crlf.findings.length, 5);
    ok('CRLF line endings parse the same');
}

// --- the comment GitHub has --------------------------------------------------

{
    const body = '> Automated review of `e6d1c4e1ea55`.\n\n## Adversarial Review: x\n\n**Verdict:** CLEAN\n';
    const picked = pickGateComment({
        reviews: [
            { body: '> Automated review of `111111111111`.\n\nold', submittedAt: '2026-09-01T00:00:00Z' },
            { body, submittedAt: '2026-09-23T07:05:24Z' },
            { body: 'Pre-merge gate, by hand', submittedAt: '2026-10-05T18:06:58Z' },
        ],
        comments: [],
    });
    assert.strictEqual(picked.sha, 'e6d1c4e1ea55');
    assert.strictEqual(picked.text, '## Adversarial Review: x\n\n**Verdict:** CLEAN\n');
    assert.strictEqual(picked.at, Date.parse('2026-09-23T07:05:24Z'));
    ok('the newest body carrying the gate\'s marker, with the marker taken off');

    const truncated = pickGateComment({ comments: [{
        body: '> Automated review of `abcdef1`.\n\ntext\n\n_Truncated — the full review is in the session transcript._',
        createdAt: '2026-09-01T00:00:00Z',
    }] });
    assert.strictEqual(truncated.text, 'text');
    assert.strictEqual(pickGateComment({ reviews: [{ body: 'LGTM' }] }), null);
    assert.strictEqual(pickGateComment(null), null);
    ok('a plain comment counts, the truncation note goes, and no marker is no review');
}

// --- the transcript ------------------------------------------------------------

{
    const lines = [
        { type: 'user', message: { content: 'review it' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }] } },
        { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent says' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '## Adversarial Review: y' }] } },
    ].map(o => JSON.stringify(o)).join('\n') + '\n';
    assert.strictEqual(lastAssistantText(Buffer.from(lines)), '## Adversarial Review: y');
    ok('the last main-conversation text, past tool calls and subagents');
}

// --- the prompt ----------------------------------------------------------------

{
    const r = parseReview(NUMBERED);
    const review = { ...r, sha: 'e6d1c4e1ea55' };
    const pr = { url: 'https://github.com/o/r/pull/7', title: 'Importer', number: 7 };
    const one = fixPrompt({ pr, review, findings: [r.findings[1]], branch: 'worktree-importer' });
    assert.ok(one.startsWith('Fix one finding'));
    assert.ok(one.includes('https://github.com/o/r/pull/7'));
    assert.ok(one.includes('[WARNING] A killed take leaves a stale fingerprint (record.mjs:644-664)'));
    assert.ok(one.includes('git push origin worktree-importer'));
    assert.ok(one.includes('git pull --ff-only origin worktree-importer'));
    assert.ok(one.includes('Reviewed commit: e6d1c4e1ea55'));
    assert.ok(!one.includes('guard checks the port'), 'only the finding asked for');
    ok('one finding: the PR, the branch, the finding, and push to that branch');

    const all = fixAllFindings(r.findings);
    assert.deepStrictEqual(all.map(f => f.severity), ['warning', 'warning', 'warning']);
    const many = fixPrompt({ pr, review, findings: all, branch: 'b' });
    assert.ok(many.startsWith('Fix 3 findings'));
    assert.ok(many.includes('### 3. [WARNING]'));
    const notesOnly = parseReview('**Verdict:** CLEAN\n\n### Notes\n- One.\n- Two.\n').findings;
    assert.strictEqual(fixAllFindings(notesOnly).length, 2);
    ok('"Fix all" is the criticals and warnings, or the notes when that is all there is');

    const raw = fixPrompt({ pr, review: { raw: 'free prose', sha: null, verdict: null }, findings: [], branch: 'b' });
    assert.ok(raw.includes('## The review\n\nfree prose'));
    ok('an unparsed review goes in whole');

    assert.strictEqual(sessionTitle(7, [r.findings[1]]), 'Fix #7: A killed take leaves a stale fingerprint');
    assert.strictEqual(sessionTitle(7, all), 'Fix #7: 3 review findings');
    assert.ok(sessionTitle(7, [{ title: 'x'.repeat(200) }]).length <= 90);
    ok('the session is named for the PR and what it is fixing');
}

// --- which review a PR shows ---------------------------------------------------

(async () => {
    const transcript = path.join(TMP, 'sess-a.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({
        type: 'assistant', message: { content: [{ type: 'text', text: NUMBERED }] },
    }) + '\n');

    const rows = [{
        id: 'sch1', cwd: '/repo', gate: { kind: 'open-prs' },
        reviewed: {
            'o/r#7': { sha: 'aaaaaaaaaaaa', at: 1, sessionId: 'sess-a', outcome: 'CONCERNS' },
            'o/r#8': { sha: 'bbbbbbbbbbbb', at: 2, sessionId: 'sess-b', outcome: null },
            'o/r#9': { sha: 'cccccccccccc', at: 1, sessionId: null, outcome: null, posted: 'seeded' },
        },
    }, {
        id: 'plain', cwd: '/repo', gate: null, reviewed: { 'o/r#7': { sessionId: 'nope', at: 99, outcome: 'BLOCK' } },
    }];
    const live = new Map();
    reviews.init({
        schedules: { list: () => rows },
        pool: { get: (id) => live.get(id) || null },
        index: { get: (id) => (id === 'sess-a' ? { file: transcript } : null) },
    });
    reviews.reset();

    assert.strictEqual(reviews.localRecord('o/r', 7).sessionId, 'sess-a');
    assert.strictEqual(reviews.localRecord('o/r', 9), null);
    ok('the local record comes from open-prs schedules only, and needs a session');

    // First ask kicks off the read and says so; the second has it.
    const first = reviews.reviewFor('o/r', 7);
    assert.strictEqual(first.pending, true);
    assert.strictEqual(first.review, null);
    await new Promise(r => setTimeout(r, 50));
    const second = reviews.reviewFor('o/r', 7);
    assert.strictEqual(second.pending, false);
    assert.strictEqual(second.review.source, 'session');
    assert.strictEqual(second.review.sessionId, 'sess-a');
    assert.strictEqual(second.review.findings.length, 5);
    ok('a transcript is read once, off the request, and answered from memory after');

    const s = reviews.summaryFor('o/r', 7, 'aaaaaaaaaaaaffff');
    assert.deepStrictEqual(
        { verdict: s.verdict, count: s.count, stale: s.stale, source: s.source },
        { verdict: 'CONCERNS', count: 5, stale: false, source: 'session' });
    assert.strictEqual(reviews.summaryFor('o/r', 7, 'dddddddd').stale, true);
    assert.strictEqual(reviews.summaryFor('o/r', 7, null).stale, false);
    ok('the summary is stale only when the PR\'s head is known to be another commit');

    live.set('sess-a', { lastResultBody: '**Verdict:** CLEAN\n' });
    assert.strictEqual(reviews.summaryFor('o/r', 7).verdict, 'CLEAN');
    live.clear();
    ok('a live runner\'s posted text wins over the transcript');

    // GitHub: only for a labelled PR with no finished local review.
    prStore.seed('o/r', { pulls: [
        { number: 7, labels: ['review-concerns'], updatedAt: 't1', headSha: 'a' },
        { number: 8, labels: ['review-blocked'], updatedAt: 't1', headSha: 'b' },
        { number: 10, labels: [], updatedAt: 't1', headSha: 'c' },
    ] });
    const asked = [];
    const run = async (cmd, args) => {
        asked.push(Number(args[2]));
        return { ok: true, stdout: JSON.stringify({ reviews: [{
            body: '> Automated review of `bbbbbbbbbbbb`.\n\n**Verdict:** BLOCK\n\n### Critical Findings\n1. **Bad.**\n',
            submittedAt: '2026-10-01T00:00:00Z',
        }], comments: [] }) };
    };
    const res = await reviews.refreshRemote({ run });
    assert.deepStrictEqual(asked, [8]);
    assert.strictEqual(res.fetched, 1);
    ok('GitHub is asked only about a labelled PR this bridge has no finished review of');

    const eight = reviews.reviewFor('o/r', 8).review;
    assert.strictEqual(eight.source, 'github');
    assert.strictEqual(eight.verdict, 'BLOCK');
    assert.strictEqual(eight.running, true);
    assert.strictEqual(eight.sha, 'bbbbbbbbbbbb');
    ok('a review still running shows the last finished one, from GitHub, marked running');

    asked.length = 0;
    await reviews.refreshRemote({ run });
    assert.deepStrictEqual(asked, []);
    prStore.seed('o/r', { pulls: [{ number: 8, labels: ['review-clean'], updatedAt: 't2', headSha: 'b2' }] });
    await reviews.refreshRemote({ run });
    assert.deepStrictEqual(asked, [8]);
    ok('asked again only once the PR has moved');

    prStore.seed('o/r', { pulls: [] });
    await reviews.refreshRemote({ run });
    assert.strictEqual(reviews.reviewFor('o/r', 8).review, null);
    ok('a PR that has left the open list leaves the cache');

    console.log(`\n  ${pass} checks passed`);
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
