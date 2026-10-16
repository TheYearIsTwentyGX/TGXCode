'use strict';

// The code reviews a session has run: the runs bridge/skill-runs.js recorded
// whose skill is one of the configured review types (`reviews.types` in
// bridge/prefs.js), each with its target, verdict and findings. What
// `GET /api/sessions/:id/reviews` answers with; see docs/api.md.
//
// Decided:
//
// - **Filtered here, not in the index.** The index records every skill run, so
//   adding a type in Settings shows that skill's past runs at once, with nothing
//   rebuilt.
//
// - **Findings come from the most structured place that has them**, and
//   `findingSource` says which:
//
//   · `tool`: the ReportFindings call in a forked skill's (or an agent's) own
//     transcript. `code-review` reports through it, and it is the only place the
//     file, line and failure scenario come apart cleanly. Read only for a run
//     that is a review, and cached by the file's size, so the list costs one
//     stat per fork once warm.
//   · `json`: a ```json array of the same objects in the result text, which is
//     how `code-review` restates them in about a third of its runs.
//   · `text`: parseReview() from bridge/pr-reviews.js — #199's parser for the
//     adversarial template, taught a few more severity words and a flat-list
//     fallback for this.
//   · `none`: nothing parsed. `raw` is always there, and the UI shows it.
//
// - **Three severities, #199's.** ReportFindings rarely says one (it has no
//   severity field; reviewers add `high`/`medium`/`low` about a quarter of the
//   time). When it says none, a CONFIRMED finding is a warning and a PLAUSIBLE
//   one a note: the reviewer verified the first and only suspects the second.
//   Nothing is `critical` unless somebody said so.

const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const { parseReview } = require('./pr-reviews');
const { verdictOf } = require('./schedule');

// How recently a transcript must have been written for an unfinished run in it
// to count as still running when the bridge has no process for the session —
// the rail's window for "live".
const LIVE_WINDOW_MS = 90 * 1000;
const RAW_MAX = 200 * 1024;
const FORK_CACHE_MAX = 300;

const norm = (s) => String(s || '').trim().replace(/^\/+/, '').toLowerCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The configured type a run belongs to, or null. A skill or command matches by
 * name, exactly (so `code-review` is not `code-review:code-review`); an agent by
 * its subagent_type, or by its prompt naming the skill — "/adversarial-reviewer"
 * or "the `adversarial-reviewer` skill", which is how a review is handed to a
 * subagent in practice.
 */
function typeOf(run, types) {
    const name = norm(run.skill);
    for (const t of types || []) {
        const want = norm(t.skill);
        if (!want) continue;
        if (name === want) return t;
        if (run.via === 'agent' && run.prompt) {
            const e = escapeRe(want);
            const slash = new RegExp(`(?:^|[\\s(\`'"])/${e}(?![\\w:/.-])`, 'i');
            const named = new RegExp(`(?:^|[^\\w:/.-])${e}[\`'"]?\\s+skill\\b`, 'i');
            if (slash.test(run.prompt) || named.test(run.prompt)) return t;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// The fork's own transcript
// ---------------------------------------------------------------------------

const forkPaths = new Map();   // `${sessionId}/${agentId}` -> path
const forkReads = new Map();   // path -> {size, read}

/**
 * Where a fork or agent's transcript is. Under the session's own directory,
 * usually; but a session that moved into a worktree has a directory under each
 * project, and about one fork in twelve is filed under the other one.
 */
function forkFile(rec, sessionId, agentId) {
    if (!agentId || !/^[A-Za-z0-9_-]+$/.test(agentId)) return null;
    const key = `${sessionId}/${agentId}`;
    const known = forkPaths.get(key);
    if (known && fs.existsSync(known)) return known;
    const name = `agent-${agentId}.jsonl`;
    const first = rec && rec.dir ? path.join(rec.dir, sessionId, 'subagents', name) : null;
    let found = first && fs.existsSync(first) ? first : null;
    if (!found) {
        let dirs = [];
        try { dirs = fs.readdirSync(cfg.PROJECTS_DIR); } catch { /* none */ }
        for (const d of dirs) {
            const p = path.join(cfg.PROJECTS_DIR, d, sessionId, 'subagents', name);
            if (fs.existsSync(p)) { found = p; break; }
        }
    }
    if (found) forkPaths.set(key, found);
    return found;
}

const promptForks = new Map();   // `${sessionId}/${promptId}` -> path

/**
 * A fork found by the prompt that ran it. A review sent as `/code-review` over
 * stream-json is run by Claude Code itself, and the parent then names no agent
 * id at all — but the fork's first entry carries the same `promptId` as the
 * `/code-review` entry, which is what this looks for. Each fork's first line
 * is read once; a miss is not remembered, since the fork may not be written yet.
 */
function forkByPrompt(rec, sessionId, promptId) {
    if (!promptId || !/^[A-Za-z0-9-]+$/.test(promptId)) return null;
    const key = `${sessionId}/${promptId}`;
    const known = promptForks.get(key);
    if (known && fs.existsSync(known)) return known;
    const dirs = [];
    if (rec && rec.dir) dirs.push(path.join(rec.dir, sessionId, 'subagents'));
    try {
        for (const d of fs.readdirSync(cfg.PROJECTS_DIR)) {
            const p = path.join(cfg.PROJECTS_DIR, d, sessionId, 'subagents');
            if (!dirs.includes(p) && fs.existsSync(p)) dirs.push(p);
        }
    } catch { /* none */ }
    const needle = `"promptId":"${promptId}"`;
    for (const dir of dirs) {
        let names = [];
        try { names = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')); } catch { continue; }
        for (const n of names) {
            const file = path.join(dir, n);
            let head = '';
            try {
                const fd = fs.openSync(file, 'r');
                try {
                    const buf = Buffer.alloc(4096);
                    const got = fs.readSync(fd, buf, 0, buf.length, 0);
                    head = buf.subarray(0, got).toString('utf8');
                } finally { fs.closeSync(fd); }
            } catch { continue; }
            const first = head.split('\n')[0];
            if (first.includes(needle)) { promptForks.set(key, file); return file; }
        }
    }
    return null;
}

/**
 * What a fork's transcript says that the parent does not: the findings it
 * reported, the effort level, and the report it handed back.
 *
 * The last ReportFindings call that was not refused is the one that stands —
 * a call over the 60-character `short_summary` limit is refused and retried, and
 * about one call in four is.
 */
function readFork(file) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const hit = forkReads.get(file);
    if (hit && hit.size === st.size) return hit.read;

    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const calls = [];           // {id, input}
    const refused = new Set();
    let handback = null;
    let lastText = null;
    for (const line of text.split('\n')) {
        if (!line) continue;
        const hasRF = line.includes('"ReportFindings"');
        const isAssistant = line.includes('"type":"assistant"');
        const isResult = line.includes('"tool_result"') && calls.some(c => line.includes(c.id));
        if (line.includes('prompt_snapshot')) continue;
        if (!isAssistant && !isResult) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const content = e.message && e.message.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
            if (!b) continue;
            if (b.type === 'tool_use' && b.name === 'ReportFindings' && hasRF) {
                calls.push({ id: b.id, input: b.input || {} });
            } else if (b.type === 'tool_use' && b.name === 'SubagentHandback') {
                const m = b.input && b.input.message;
                if (typeof m === 'string' && m.trim()) handback = m;
            } else if (b.type === 'tool_result' && b.is_error) {
                refused.add(b.tool_use_id);
            } else if (b.type === 'tool_result') {
                const t = typeof b.content === 'string' ? b.content
                    : (Array.isArray(b.content) ? b.content.map(x => x && x.text || '').join('') : '');
                if (/InputValidationError|<tool_use_error>/.test(t)) refused.add(b.tool_use_id);
            } else if (b.type === 'text' && e.type === 'assistant' && b.text && b.text.trim()) {
                lastText = b.text;
            }
        }
    }
    const stands = calls.filter(c => !refused.has(c.id)).pop() || null;
    const read = {
        findings: stands && Array.isArray(stands.input.findings) ? stands.input.findings : null,
        level: stands && typeof stands.input.level === 'string' ? stands.input.level : null,
        handback,
        lastText,
    };
    forkReads.set(file, { size: st.size, read });
    if (forkReads.size > FORK_CACHE_MAX) forkReads.delete(forkReads.keys().next().value);
    return read;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

const SEVERITY_WORD = {
    critical: 'critical', blocker: 'critical', blocking: 'critical', high: 'critical', major: 'critical',
    medium: 'warning', moderate: 'warning', warning: 'warning',
    low: 'note', minor: 'note', nit: 'note', note: 'note', info: 'note',
};

function firstSentence(s) {
    const t = String(s || '').trim().split(/(?<=[.!?])\s/)[0];
    return t.length > 160 ? t.slice(0, 157) + '…' : t;
}

/** One ReportFindings-shaped object as a #199 finding, plus what it adds. */
function structuredFinding(f) {
    const said = SEVERITY_WORD[norm(f.severity)];
    const confidence = f.verdict === 'CONFIRMED' || f.verdict === 'PLAUSIBLE' ? f.verdict : null;
    const severity = said || (confidence === 'PLAUSIBLE' ? 'note' : 'warning');
    const line = Number.isInteger(f.line) && f.line > 0 ? f.line : null;
    let body = String(f.summary || '').trim();
    if (f.failure_scenario) body += `${body ? '\n\n' : ''}**How it fails:** ${String(f.failure_scenario).trim()}`;
    return {
        severity,
        title: String(f.short_summary || '').trim() || firstSentence(f.summary) || 'Finding',
        file: typeof f.file === 'string' && f.file ? f.file : null,
        line, endLine: null,
        body,
        category: typeof f.category === 'string' ? f.category : null,
        confidence,
    };
}

const isFindingLike = (o) => o && typeof o === 'object' && (typeof o.summary === 'string' || typeof o.short_summary === 'string');

/** A ```json fence holding an array of finding objects, or null. */
function jsonFindings(text) {
    const re = /```json[ \t]*\n([\s\S]*?)\n```/g;
    let m;
    while ((m = re.exec(text))) {
        try {
            const v = JSON.parse(m[1]);
            const arr = Array.isArray(v) ? v : (v && Array.isArray(v.findings) ? v.findings : null);
            if (arr && arr.length && arr.every(isFindingLike)) return arr;
            if (arr && !arr.length) return [];
        } catch { /* not this one */ }
    }
    return null;
}

const ORDER = { critical: 0, warning: 1, note: 2 };
const bySeverity = (a, b) => ORDER[a.severity] - ORDER[b.severity];

function countsOf(findings) {
    const c = { critical: 0, warning: 0, note: 0 };
    for (const f of findings) if (c[f.severity] !== undefined) c[f.severity]++;
    return c;
}

// `VERDICT: clean` / `VERDICT: issues` is what a review handed to an agent is
// usually asked to end with. verdictOf() is the PR gate's and stays exactly as
// strict as the gate needs; these two words are read here only.
const AGENT_VERDICT_RE = /^[ \t]*(?:[#>*-]+[ \t]*)?(?:\*\*)?VERDICT(?:\*\*)?[ \t]*:?[ \t]*(?:\*\*)?[ \t]*(clean|issues)\b/im;

function verdictFor(raw, source, findings) {
    const v = verdictOf(raw);
    if (v) return v;
    const a = AGENT_VERDICT_RE.exec(raw);
    if (a) return a[1].toLowerCase() === 'clean' ? 'CLEAN' : 'CONCERNS';
    // A reviewer that reported through the tool and reported nothing is the
    // closest thing to a clean verdict `code-review` gives.
    if ((source === 'tool' || source === 'json') && !findings.length) return 'CLEAN';
    return null;
}

function titleFor(raw) {
    const h = /^#{1,3}[ \t]+(?:Adversarial Review|Code Review|Review)\b[ \t]*[:—–-]?[ \t]*(.+)$/im.exec(raw);
    if (h) return h[1].replace(/[*_`]/g, '').trim() || null;
    return null;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * What a review was of, as far as can be told: `{pr, range, files, effort, text}`.
 * From the arguments it was given first — `134 high`, `PR 117`, `--diff a..b`,
 * `origin/x...HEAD high`, a list of paths — then the opening line of its result
 * ("Reviewed PR #134 …"). No arguments and nothing said is the current diff.
 */
function targetOf(args, resultText, level) {
    const a = String(args || '').trim();
    const out = { pr: null, range: null, files: [], effort: null, text: a ? a.slice(0, 200) : null };
    const words = a.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length && i < 40; i++) {
        const w = words[i].replace(/^[`'"(]+|[`'",.;:)]+$/g, '');
        if (!w) continue;
        if (!out.effort && EFFORTS.includes(w.toLowerCase())) { out.effort = w.toLowerCase(); continue; }
        if (!out.pr && /^#?\d{1,6}$/.test(w) && (i === 0 || i === words.length - 1
            || /^(?:pr|--target|#)$/i.test(words[i - 1]) || w.startsWith('#'))) {
            out.pr = Number(w.replace('#', ''));
            continue;
        }
        const pull = /\/pull\/(\d+)/.exec(w);
        if (!out.pr && pull) { out.pr = Number(pull[1]); continue; }
        if (!out.range && /^[\w./@^~-]+\.\.\.?[\w./@^~-]+$/.test(w)) { out.range = w; continue; }
        if (/^--?\w/.test(w)) continue;
        if (/^[\w@-][\w@.-]*(?:\/[\w@.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(w) && out.files.length < 50) {
            out.files.push(w);
        }
    }
    if (!out.pr) {
        const pr = /\bPR[ \t]*#?(\d{1,6})\b/i.exec(a) || /^\s*Reviewed (?:PR|pull request) #?(\d{1,6})/i.exec(String(resultText || ''));
        if (pr) out.pr = Number(pr[1]);
    }
    if (!out.effort && level && EFFORTS.includes(level)) out.effort = level;
    return out;
}

/**
 * A run's findings, from the most structured source that has them.
 * @returns {{findings, source, level, raw}}
 */
function findingsFor(run, fork) {
    let raw = run.resultText || run.lastText || '';
    if (run.via === 'agent' && fork) {
        if (fork.handback) raw = fork.handback;
        else if (!raw || /report was delivered to you as a message|Async agent launched/.test(raw)) raw = fork.lastText || raw;
    }
    raw = String(raw).replace(/\r\n/g, '\n');
    if (raw.length > RAW_MAX) raw = raw.slice(0, RAW_MAX - 1) + '…';
    const level = fork && fork.level || null;

    if (fork && fork.findings) {
        return { findings: fork.findings.filter(isFindingLike).map(structuredFinding).sort(bySeverity), source: 'tool', level, raw };
    }
    const json = jsonFindings(raw);
    if (json) return { findings: json.map(structuredFinding).sort(bySeverity), source: 'json', level, raw };
    const parsed = parseReview(raw);
    if (parsed.findings.length) {
        return { findings: parsed.findings.map(f => ({ ...f, category: null, confidence: null })).sort(bySeverity),
            source: 'text', level, raw, summary: parsed.summary };
    }
    return { findings: [], source: 'none', level, raw };
}

/**
 * Whether a run the index still has open is actually still running. The index
 * cannot know: an inline review has no end marker, and its session may simply
 * have gone quiet. The bridge's own process says so when there is one; failing
 * that, a transcript written in the last minute and a half.
 */
function statusOf(run, live) {
    if (run.status !== 'running') return run.status;
    if (live) return 'running';
    // An inline run whose session went quiet finished; a forked skill or agent
    // whose result never arrived did not.
    return run.via === 'command' || (run.via === 'skill' && !run.forked && run.lastTs) ? 'done' : 'incomplete';
}

function summarise(run, type, f, live) {
    const target = targetOf(run.args, f.raw, f.level);
    const verdict = verdictFor(f.raw, f.source, f.findings);
    return {
        id: run.id,
        type: { id: type.id, label: type.label, colour: type.colour },
        skill: run.skill,
        via: run.via,
        forked: Boolean(run.forked),
        status: statusOf(run, live),
        startedAt: run.startedAt || null,
        endedAt: run.endedAt || (run.status === 'running' && !live ? run.lastTs || null : null),
        anchor: run.anchor,
        target,
        verdict,
        counts: countsOf(f.findings),
        findingSource: f.source,
        title: titleFor(f.raw),
    };
}

function detailOf(run, type, rec, sessionId, live) {
    let file = null;
    if (run.status !== 'rejected') {
        if (run.agentId) file = forkFile(rec, sessionId, run.agentId);
        // A command that printed its result was a forked skill run by Claude
        // Code itself; its fork is found by the prompt.
        else if (run.via === 'command' && run.printed) file = forkByPrompt(rec, sessionId, run.promptId);
    }
    const fork = file ? readFork(file) : null;
    const f = findingsFor(run, fork);
    const summary = summarise(run, type, f, live);
    if (file && run.via === 'command') summary.forked = true;
    return { f, summary };
}

/**
 * Every review in a session, oldest first.
 *
 * @param {{idx, mtimeMs}} got what SkillRunIndex.update() returned
 * @param {boolean} busy whether the bridge's own process for it is mid-turn
 */
function list(got, types, rec, sessionId, busy) {
    const live = busy || (got.mtimeMs && Date.now() - got.mtimeMs < LIVE_WINDOW_MS);
    const out = [];
    for (const run of got.idx.runs) {
        const type = typeOf(run, types);
        if (!type) continue;
        // Only the last open run can be the one still going.
        const isOpen = run.status === 'running';
        out.push(detailOf(run, type, rec, sessionId, isOpen && live).summary);
    }
    return out;
}

/** One review in full: its summary, findings and raw text. Null if not a review. */
function one(got, types, rec, sessionId, runId, busy) {
    const run = got.idx.runs.find(r => r.id === runId);
    if (!run) return null;
    const type = typeOf(run, types);
    if (!type) return null;
    const live = busy || (got.mtimeMs && Date.now() - got.mtimeMs < LIVE_WINDOW_MS);
    const { f, summary } = detailOf(run, type, rec, sessionId, run.status === 'running' && live);
    return { ...summary, summary: f.summary || null, findings: f.findings, raw: f.raw };
}

module.exports = {
    typeOf, targetOf, findingsFor, structuredFinding, jsonFindings, verdictFor, titleFor,
    readFork, forkFile, statusOf, list, one, countsOf,
};
