'use strict';

// What the nightly pull-request review found, readable in the app.
//
// The gate (bridge/pr-gate.js) posts each review as a PR comment and labels the
// PR, and until this module that comment was the only place to read it. This is
// the half that brings it back: it finds the latest review of a PR, parses it into
// findings, and keeps the answer in memory so the routes that show it never wait.
//
// What it decided:
//
//   * **The app's own record first.** The gate keeps no review text, only a
//     pointer: `reviewed["owner/name#N"].sessionId` on the schedule row. The text
//     is that session's final message — `runner.lastResultBody` while the process
//     is alive (exactly what was posted), and the transcript's last assistant
//     text after. Reading our own disk is cheaper and more honest than asking
//     GitHub what we told it.
//   * **GitHub only as a fallback, and only off a clock.** A PR wearing a
//     `review-*` label with no local record — reviewed by another machine's
//     bridge, or pruned from `reviewed` — is looked up with `gh pr view` from the
//     PR refresh pass (bridge/pr-refresh.js), a few per pass, and cached in
//     `$XDG_CACHE_HOME/tgxcode/pr-reviews.json`. No route awaits it; a route
//     asked about a PR whose review has not been read yet says `pending`.
//   * **Parsing is best-effort and the raw text always rides along.** The review
//     is prose written to the adversarial-reviewer skill's template — `### Critical
//     Findings`, `### Warnings`, `### Notes` — but how an item inside a section is
//     written varies from run to run: `1. **Title**`, `**W1. Title**`,
//     `**C1 — Title**`, `- **Title**`. `parseReview` recognises those and a
//     section that opens "None." has no findings, whatever bullets of things it
//     checked follow. When nothing parses, `findings` is empty and `raw` is the
//     review, which the UI then shows whole.
//   * **Read-only toward GitHub.** Nothing here posts or labels; that is
//     pr-gate's, and a test schedule's guard lives there.

const fs = require('fs');
const path = require('path');

const { CACHE_DIR } = require('./config');
const pulls = require('./pulls');
const prStore = require('./pr-store');
const { verdictOf } = require('./schedule');
const { parseLines } = require('./transcript');
const { broadcast } = require('./events');

const STORE_FILE = path.join(CACHE_DIR, 'pr-reviews.json');
const STORE_VERSION = 1;
// GitHub lookups per refresh pass. The pass runs every thirty seconds; a backlog
// of labelled PRs drains in a few minutes without a burst of `gh` calls.
const REMOTE_PER_PASS = 3;
const VERDICT_LABEL = /^review-(clean|concerns|blocked)$/;
// The line pr-gate.js `wrapReviewBody` puts above every review it posts.
const MARKER_RE = /^> Automated review of `([0-9a-f]{7,40})`\.?[ \t]*\n+/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const SECTION = [
    [/^critical/i, 'critical'],
    [/^warning/i, 'warning'],
    [/^notes?\b/i, 'note'],
    // Other reviewers' words for the same three, so a review that is not the
    // adversarial template still lands in the right group (bridge/code-reviews.js).
    [/^(?:high|blocking|blockers?|major|severe|p[01])\b/i, 'critical'],
    [/^(?:medium|moderate|should[- ]fix|p2)\b/i, 'warning'],
    [/^(?:low|minor|nits?|nitpicks?|suggestions?|p3)\b/i, 'note'],
];

// A line that opens a finding, in the styles the reviewer actually writes. The
// "strong" ones are numbered or labelled; a section using any of them is split
// on those alone, because its sub-bullets (`- **Fix:**`) start with bold too.
const STRONG_START = [
    /^\d+[.)][ \t]+\S/,                                   // 1. **Title** …
    /^\*\*(?:[CWN]\d+|\d+)\b\.?[^*]*\*\*/,                // **W1. Title** / **C1 — Title** / **1. Title**
    /^#{4,6}[ \t]+\S/,                                    // #### Title
];
const BULLET_START = /^[-*][ \t]+\S/;
// `src/a.ts:12 — summary`, a whole finding on one line, unbulleted.
const LINE_ITEM = /^`?[A-Za-z0-9_@$./-]*[A-Za-z0-9_$-]\.[A-Za-z0-9]{1,8}:\d+(?:[-–]\d+)?`?[ \t]+[—–-][ \t]+\S/;

// `src/a/b.ts:12`, `b.ts:12-34`, `b.ts:12–34`, inside backticks or not.
const LOC_RE = /([A-Za-z0-9_@$./-]*[A-Za-z0-9_$-]\.[A-Za-z0-9]{1,8}):(\d+)(?:[-–](\d+))?/;
const PATH_RE = /`([A-Za-z0-9_@-][A-Za-z0-9_@./-]*\/[A-Za-z0-9_@./-]*\.[A-Za-z0-9]{1,8})`/;

/** The location a finding names first: `{file, line, endLine}`, nulls if none. */
function locationOf(text) {
    const m = LOC_RE.exec(text);
    if (m) {
        return { file: m[1], line: Number(m[2]), endLine: m[3] ? Number(m[3]) : null };
    }
    const p = PATH_RE.exec(text);
    return { file: p ? p[1] : null, line: null, endLine: null };
}

/** A one-line title for a finding, from its opening line. */
function titleOf(first) {
    // Asterisks inside a code span (`.design-sync/**`) are not bold markers, so
    // they are set aside while the bold lead is found and put back after.
    const line = first.replace(/^#{4,6}[ \t]+/, '').replace(/^[-*][ \t]+/, '').replace(/^\d+[.)][ \t]+/, '')
        // `- \`src/a.ts:12\` — the title`: the location leads, and is the
        // finding's `file`, not its title.
        .replace(/^`?[^`\s]*\.[A-Za-z0-9]{1,8}:\d+(?:[-–]\d+)?`?[ \t]*(?:[—–:-][ \t]*)?/, '')
        .replace(/`[^`]*`/g, s => s.replace(/\*/g, '\u0001'));
    // A bold lead is the title; bold somewhere mid-sentence is emphasis, and the
    // title is then the first sentence.
    const bold = /^\*\*(.+?)\*\*/.exec(line);
    let t = bold ? bold[1] : line.split(/(?<=[.!?])\s/)[0];
    // `W1.`, `C2 —`, `1.`, `N3,` — the label is the list's, not the finding's.
    t = t.replace(/^(?:[CWN]\d+|\d+)\b[ \t]*[.):,—–-]?[ \t]*/, '');
    t = t.replace(/`/g, '').replace(/\*\*/g, '').replace(/\u0001/g, '*').trim().replace(/[.:]$/, '');
    if (!t) t = first.replace(/[*`]/g, '').trim();
    return t.length > 160 ? t.slice(0, 157) + '…' : t;
}

/** Split one section's lines into findings. */
function splitItems(lines, severity, mode = null) {
    // "None." — with or without a list of what was checked after it — is a
    // section with nothing in it, which is the commonest Critical section there is.
    const firstText = lines.find(l => l.trim());
    if (!firstText || /^\s*(?:\*\*)?_?none\b/i.test(firstText)) return [];

    const strong = mode ? mode === 'strong' : lines.some(l => STRONG_START.some(re => re.test(l)));
    const starts = (l) => (strong ? STRONG_START.some(re => re.test(l)) : BULLET_START.test(l));

    const items = [];
    let cur = null;
    for (const line of lines) {
        if (starts(line)) {
            cur = [line];
            items.push(cur);
        } else if (cur) {
            cur.push(line);
        }
        // Prose before the first item is the section's preamble, not a finding.
    }
    return items.map((item) => {
        const body = item.join('\n').trim();
        return { severity, title: titleOf(item[0]), ...locationOf(body), body };
    });
}

/**
 * A review's text as `{verdict, title, scope, summary, findings[], raw}`.
 *
 * `verdict` is BLOCK, CONCERNS, CLEAN or null; each finding is
 * `{severity: 'critical'|'warning'|'note', title, file, line, endLine, body}`.
 * Pure; the cases it has to cope with are pinned in test/pr-reviews.test.js.
 */
function parseReview(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n');
    const lines = raw.split('\n');
    const out = { verdict: verdictOf(raw), title: null, scope: null, summary: null, findings: [], raw };

    const head = /^#{1,3}[ \t]+Adversarial Review:?[ \t]*(.+)$/im.exec(raw);
    if (head) out.title = head[1].trim();
    const scope = /^\*\*Scope:?\*\*:?[ \t]*(.+)$/im.exec(raw);
    if (scope) out.scope = scope[1].trim();

    let section = null;     // {kind, lines}
    const sections = [];
    for (const line of lines) {
        const h = /^#{2,3}[ \t]+(.+?)[ \t]*#*$/.exec(line);
        if (h) {
            // `### 🔴 Critical` — a marker before the word is decoration.
            const name = h[1].replace(/[*_]/g, '').trim().replace(/^[^\p{L}\p{N}]+/u, '');
            const known = SECTION.find(([re]) => re.test(name));
            if (known) section = { kind: known[1], lines: [] };
            else if (/^summary\b/i.test(name)) section = { kind: 'summary', lines: [] };
            else section = null;
            if (section) sections.push(section);
            continue;
        }
        // The closing VERDICT line belongs to no section.
        if (section && verdictOf(line)) { section = null; continue; }
        if (section) section.lines.push(line);
    }

    for (const s of sections) {
        if (s.kind === 'summary') {
            const text = s.lines.join('\n').trim();
            if (text) out.summary = text;
        } else {
            out.findings.push(...splitItems(s.lines, s.kind));
        }
    }
    // No severity headings at all — `code-review` writes a flat list:
    // "- `src/a.ts:12` — summary" or "1. **Title** (`src/a.ts:12`)". Split the
    // whole text, and keep only the items that name a file, so a numbered list
    // of what the reviewer *did* does not come back as findings. Unrated, so
    // they are warnings: the review thought each worth raising.
    // Numbered items first; if none of those names a file (a numbered list of
    // steps beside a bulleted list of findings), the bullets.
    // Last, `code-review`'s own restatement: one line per finding, starting
    // with its location — "src/a.ts:12 — summary".
    if (!sections.some(sec => sec.kind !== 'summary')) {
        const located = (mode) => splitItems(lines, 'warning', mode).filter(f => f.file);
        let found = located('strong');
        if (!found.length) found = located('bullet');
        if (!found.length) {
            found = lines.filter(l => LINE_ITEM.test(l))
                .map(l => ({ severity: 'warning', title: titleOf(l), ...locationOf(l), body: l.trim() }));
        }
        out.findings.push(...found);
    }
    return out;
}

/** `{critical, warning, note}` counts. */
function countsOf(findings) {
    const c = { critical: 0, warning: 0, note: 0 };
    for (const f of findings) if (c[f.severity] != null) c[f.severity]++;
    return c;
}

/**
 * The gate's review in a `gh pr view --json reviews,comments` answer: the newest
 * body carrying pr-gate's marker line, as `{text, sha, at}` with the marker taken
 * off, or null. Reviews and plain comments both, newest first — the gate posts a
 * commenting review today, but an older bridge or a person pasting one in might not.
 */
function pickGateComment(json) {
    const all = [];
    for (const r of (json && json.reviews) || []) all.push({ body: r.body, at: r.submittedAt });
    for (const c of (json && json.comments) || []) all.push({ body: c.body, at: c.createdAt });
    const hits = all
        .filter(x => typeof x.body === 'string' && MARKER_RE.test(x.body))
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    if (!hits.length) return null;
    const m = MARKER_RE.exec(hits[0].body);
    return {
        text: hits[0].body.slice(m[0].length).replace(/\n+_Truncated — .*_\s*$/, ''),
        sha: m[1],
        at: hits[0].at ? Date.parse(hits[0].at) || null : null,
    };
}

/** The last thing the main conversation said, from a transcript's bytes. */
function lastAssistantText(buf) {
    let last = '';
    for (const e of parseLines(buf).entries) {
        if (!e || e.isSidechain || e.type !== 'assistant') continue;
        const content = e.message && e.message.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
            if (b && b.type === 'text' && b.text && b.text.trim()) last = b.text;
        }
    }
    return last;
}

// ---------------------------------------------------------------------------
// The prompt a "Fix this" session starts with
// ---------------------------------------------------------------------------

const SEVERITY_WORD = { critical: 'CRITICAL', warning: 'WARNING', note: 'NOTE' };

function describeFinding(f, n) {
    const where = f.file ? ` (${f.file}${f.line ? `:${f.line}${f.endLine ? `-${f.endLine}` : ''}` : ''})` : '';
    return `### ${n}. [${SEVERITY_WORD[f.severity] || f.severity}] ${f.title}${where}\n\n${f.body}`;
}

/**
 * The findings "Fix all" covers: every critical and warning. Notes are left out
 * unless they are all the review has, because a session told to fix twelve
 * nits alongside a data-loss bug tends to give them equal weight.
 */
function fixAllFindings(findings) {
    const serious = findings.filter(f => f.severity === 'critical' || f.severity === 'warning');
    return serious.length ? serious : findings;
}

/**
 * The first message of a session started to fix review findings.
 *
 * `findings` empty means the review never parsed, and the whole of it goes in.
 */
function fixPrompt({ pr, review, findings, branch }) {
    const n = findings.length;
    const what = n === 0 ? 'the findings in the review below'
        : n === 1 ? 'one finding from the automated review of this pull request'
        : `${n} findings from the automated review of this pull request`;
    const parts = [
        `Fix ${what}.`,
        '',
        `Pull request: ${pr.url}${pr.title ? ` — ${pr.title}` : ''}`,
        `Branch: ${branch} (you are in a worktree with it checked out)`,
        review.sha ? `Reviewed commit: ${review.sha}` : null,
        review.verdict ? `Review verdict: ${review.verdict}` : null,
        '',
        n === 0 ? '## The review\n\n' + review.raw
            : '## ' + (n === 1 ? 'The finding' : 'The findings') + '\n\n'
                + findings.map((f, i) => describeFinding(f, i + 1)).join('\n\n'),
        '',
        '## What to do',
        '',
        `1. Bring the branch up to date first: \`git pull --ff-only origin ${branch}\`. The review was of`
            + ' a particular commit, and the branch may have moved since.',
        '2. Check each finding against the code as it is now. A reviewer can be wrong; if one does not'
            + ' hold, say so plainly and why, rather than changing code to satisfy it.',
        '3. Fix what does hold. Follow the conventions in CLAUDE.md, and run the tests that cover what'
            + ' you changed.',
        `4. Commit with a message that says what changed and why, and push to the pull request's branch:`
            + ` \`git push origin ${branch}\`. Do not open a new pull request and do not merge this one.`,
        '5. Finish with a short account of each finding: fixed (and how), or not a real problem (and why).',
    ];
    return parts.filter(p => p !== null).join('\n');
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let schedules = null;
let pool = null;
let index = null;

function init(deps) {
    ({ schedules, pool, index } = deps);
}

// sessionId → {size, review} for transcripts already read.
const local = new Map();
// sessionIds being read right now.
const reading = new Set();
// `repo#N` → {updatedAt, headSha, labels, fetchedAt, review|null}, from GitHub.
let remote = null;
let saveTimer = null;

function loadRemote() {
    if (remote) return;
    remote = new Map();
    try {
        const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
        if (data && data.version === STORE_VERSION && data.reviews) {
            for (const [k, v] of Object.entries(data.reviews)) if (v && typeof v === 'object') remote.set(k, v);
        }
    } catch { /* first run, or a file from somebody else's version */ }
}

function flushRemote() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const tmp = STORE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, reviews: Object.fromEntries(remote) }));
        fs.renameSync(tmp, STORE_FILE);
    } catch (err) {
        console.error(`[tgxcode] could not save PR review cache: ${err.message}`);
    }
}

function saveRemote() {
    if (saveTimer) return;
    saveTimer = setTimeout(flushRemote, 400);
    saveTimer.unref();
}

const keyOf = (repo, number) => `${repo}#${number}`;

/**
 * The newest gate review of a PR this bridge ran: `{sessionId, sha, at, outcome,
 * scheduleId, cwd}`, or null. Across every `open-prs` schedule, because two can
 * cover one repository.
 */
function localRecord(repo, number) {
    if (!schedules) return null;
    const key = keyOf(repo, number);
    let best = null;
    for (const row of schedules.list()) {
        if (!row.gate || row.gate.kind !== 'open-prs' || !row.reviewed) continue;
        const r = row.reviewed[key];
        if (!r || !r.sessionId) continue;
        if (!best || (r.at || 0) > (best.at || 0)) {
            best = { sessionId: r.sessionId, sha: r.sha || null, at: r.at || null,
                outcome: r.outcome || null, scheduleId: row.id, cwd: row.cwd };
        }
    }
    return best;
}

/** True when `sessionId` is a gate review this bridge knows of. */
function isReviewSession(sessionId) {
    if (!schedules || !sessionId) return false;
    for (const row of schedules.list()) {
        if (!row.gate || row.gate.kind !== 'open-prs' || !row.reviewed) continue;
        for (const r of Object.values(row.reviewed)) if (r && r.sessionId === sessionId) return true;
    }
    return false;
}

/**
 * The parsed review behind a local record, if it is to hand. Kicks off a read of
 * the transcript when it is not, and answers `{pending: true}` meanwhile; the
 * read broadcasts `pr-reviews-changed` when it lands.
 */
function localReview(rec, key) {
    const live = pool && pool.get(rec.sessionId);
    if (live && live.lastResultBody) return { review: parseReview(live.lastResultBody) };

    const file = index && index.get(rec.sessionId) && index.get(rec.sessionId).file;
    if (!file) return { review: null };
    let size;
    try { size = fs.statSync(file).size; } catch { return { review: null }; }
    const hit = local.get(rec.sessionId);
    if (hit && hit.size === size) return { review: hit.review };

    if (!reading.has(rec.sessionId)) {
        reading.add(rec.sessionId);
        fs.promises.readFile(file).then((buf) => {
            const text = lastAssistantText(buf);
            local.set(rec.sessionId, { size: buf.length, review: text ? parseReview(text) : null });
            broadcast('pr-reviews-changed', { keys: [key] });
        }).catch(() => {
            local.set(rec.sessionId, { size, review: null });
        }).finally(() => reading.delete(rec.sessionId));
    }
    return { review: hit ? hit.review : null, pending: true };
}

/**
 * The latest review of a PR, whole: `{review, pending}`. `review` is the parse
 * plus `{sha, at, sessionId, source}`, or null. Never waits on anything.
 */
function reviewFor(repo, number) {
    const key = keyOf(repo, number);
    const rec = localRecord(repo, number);
    // A record with no outcome is a review still running; the one before it was
    // overwritten when it started, so GitHub's copy is the newest finished one.
    if (rec && rec.outcome) {
        const { review, pending } = localReview(rec, key);
        if (review) {
            return {
                review: { ...review, sha: rec.sha, at: rec.at, sessionId: rec.sessionId,
                    source: 'session', running: false },
                pending: false,
            };
        }
        if (pending) return { review: null, pending: true };
    }
    loadRemote();
    const r = remote.get(key);
    if (r && r.review) {
        return {
            review: { ...r.review, sessionId: null, source: 'github', running: !!(rec && !rec.outcome) },
            pending: false,
        };
    }
    return { review: null, pending: false };
}

/**
 * The small version every PR row carries: `{verdict, count, counts, sha, at,
 * source, stale, sessionId}` or null. `stale` when the review was of a commit
 * other than the PR's current head.
 */
function summaryFor(repo, number, headSha = null) {
    if (!repo || !number) return null;
    const { review } = reviewFor(repo, number);
    if (!review) return null;
    const counts = countsOf(review.findings);
    return {
        verdict: review.verdict,
        count: review.findings.length,
        counts,
        sha: review.sha || null,
        at: review.at || null,
        sessionId: review.sessionId || null,
        source: review.source,
        stale: !!(headSha && review.sha && !headSha.startsWith(review.sha) && !review.sha.startsWith(headSha)),
    };
}

/** A gate session finished: whatever it said is now the review of its PR. */
function noteTurn(r) {
    if (!r || !isReviewSession(r.sessionId)) return;
    local.delete(r.sessionId);
    broadcast('pr-reviews-changed', { keys: [] });
}

/**
 * The GitHub half, run from the PR refresh pass. For every open PR the store
 * holds that wears a verdict label and has no review this bridge ran, read the
 * gate's comment — when the PR has moved since the last read, and a few at a time.
 */
async function refreshRemote({ run = pulls.run } = {}) {
    loadRemote();
    const due = [];
    const open = new Set();
    for (const [repo, entry] of Object.entries(prStore.snapshot().repos)) {
        for (const pr of (entry && entry.pulls) || []) {
            const key = keyOf(repo, pr.number);
            open.add(key);
            if (!(pr.labels || []).some(l => VERDICT_LABEL.test(l))) continue;
            const rec = localRecord(repo, pr.number);
            if (rec && rec.outcome) continue;
            const have = remote.get(key);
            const labels = (pr.labels || []).filter(l => VERDICT_LABEL.test(l)).sort().join(',');
            if (have && have.updatedAt === pr.updatedAt && have.labels === labels) continue;
            due.push({ repo, pr, key, labels });
        }
    }

    // Closed PRs leave; nothing reads their review from here.
    let changed = false;
    for (const key of [...remote.keys()]) {
        if (!open.has(key)) { remote.delete(key); changed = true; }
    }

    const keys = [];
    for (const { repo, pr, key, labels } of due.slice(0, REMOTE_PER_PASS)) {
        const r = await run('gh', ['pr', 'view', String(pr.number), '--repo', repo, '--json', 'reviews,comments']);
        if (!r.ok) continue;      // asked again next pass; nothing recorded
        let json;
        try { json = JSON.parse(r.stdout); } catch { continue; }
        const found = pickGateComment(json);
        remote.set(key, {
            updatedAt: pr.updatedAt, headSha: pr.headSha || null, labels, fetchedAt: Date.now(),
            review: found ? { ...parseReview(found.text), sha: found.sha, at: found.at } : null,
        });
        keys.push(key);
        changed = true;
    }
    if (changed) saveRemote();
    if (keys.length) broadcast('pr-reviews-changed', { keys });
    return { fetched: keys.length, due: due.length };
}

/** Forget everything. Tests only. */
function reset() {
    local.clear();
    reading.clear();
    remote = new Map();
}

module.exports = {
    init, parseReview, pickGateComment, lastAssistantText, countsOf, locationOf,
    fixPrompt, fixAllFindings,
    localRecord, reviewFor, summaryFor, noteTurn, refreshRemote, reset,
    STORE_FILE,
};
