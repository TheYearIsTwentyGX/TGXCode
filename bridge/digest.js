'use strict';

// "While you were away": what happened since a moment the caller names.
//
// A client knows when it stopped looking — the window went hidden, or nobody
// touched it for twenty minutes — and the bridge does not, so `since` comes in
// from the caller and nothing here is kept per client. That is also what makes
// it survive a restart: every input below is a store the bridge already
// persists (the notification log, schedules.json, orchestrators.json, the PR
// cache, the transcripts), so a digest asked for after the bridge came back up
// is the same digest it would have been before. A phone asks with its own
// `since` and gets its own answer.
//
// **No log of its own.** The notification log is already the record of what
// reached out to you, and it is the backbone here: finished and failed turns,
// stalls, schedule failures. The rest is read where it already lives rather
// than copied into a second log that would need its own pruning and could
// disagree with the first.
//
// **`waiting` is now, not then.** It comes from the runners' live statuses, so
// an ask raised and answered while you were away is not in it, and one raised
// before you left still is. That is the question the card is answering — what
// needs you — and the log's `outcome` field cannot answer it, because an ask
// whose bridge restarted never gets an outcome.
//
// buildDigest() is pure — data in, digest out — so the whole of the assembly is
// unit-tested without a bridge (test/digest.test.js). bridge/routes/digest.js
// gathers the inputs.

// How many items a group returns. `counts` is the total before the cap, so a
// client can say "+N more" without a second call.
const CAP = 50;

// The rows that mean something went wrong. `schedule-findings` is not one: a
// review that found something is a schedule doing its job, and it is reported
// with the schedule.
const FAILED_TYPES = new Set([
    'failed', 'stalled', 'schedule-failed', 'schedule-missed', 'later-failed', 'later-missed',
]);

const REPORT_KINDS = new Set(['question', 'update', 'done']);

// A bridge that adopts a turn which ended while it was down re-emits that
// turn's completion, and the log files a second `finished` row for it. Two
// finishes of one session this close together are that, not two turns.
const DUPLICATE_MS = 5000;

const tsMs = (v) => {
    if (Number.isFinite(v)) return v;
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : 0;
};

function capped(list) {
    return list.length > CAP ? list.slice(0, CAP) : list;
}

/**
 * @param {object} p
 * @param {number} p.since                    epoch ms
 * @param {number} [p.now]
 * @param {object[]} [p.rows]                 notification rows, any order
 * @param {Object<string, object>} [p.statuses]  sessionId -> runner status
 * @param {object[]} [p.schedules]            schedule rows, as Schedules.list()
 * @param {object[]} [p.suggestions]          rows as index.listSuggestions()
 * @param {object[]} [p.orchestrators]        orchestrator records
 * @param {{repos?: object, terminal?: object}} [p.prs]  pr-store snapshot()
 * @param {(id: string) => ({title?: string, projectName?: string}|null)} [p.describe]
 * @param {(id: string) => object|null} [p.standingFor]
 * @param {(id: string) => boolean} [p.isTest]
 * @param {(row: object) => string} [p.scheduleTitle]
 */
function buildDigest({
    since, now = Date.now(), rows = [], statuses = {}, schedules = [], suggestions = [],
    orchestrators = [], prs = {}, describe = () => null, standingFor = () => null,
    isTest = () => false, scheduleTitle = (r) => r.title || 'a schedule',
} = {}) {
    const named = (id) => {
        const s = (id && describe(id)) || {};
        return { title: s.title || null, project: s.projectName || null };
    };

    // --- waiting on you: live -------------------------------------------------
    const waiting = [];
    for (const [sessionId, st] of Object.entries(statuses || {})) {
        const ask = st && (st.pendingPermission || st.sudoAsk);
        if (!ask || isTest(sessionId)) continue;
        const n = named(sessionId);
        waiting.push({
            sessionId,
            title: n.title,
            project: n.project,
            kind: ask.kind || 'tool',
            tool: ask.displayName || ask.tool || null,
            requestId: ask.requestId || null,
            askedAt: tsMs(ask.askedAt) || null,
        });
    }
    waiting.sort((a, b) => (b.askedAt || 0) - (a.askedAt || 0));

    // --- from the log -------------------------------------------------------
    const recent = rows.filter(r => r && r.at >= since && r.at <= now && !isTest(r.sessionId))
        .sort((a, b) => a.at - b.at);

    const bySession = new Map();
    const failed = [];
    const findings = new Map();   // sessionId -> row, for a schedule that found something
    for (const r of recent) {
        if (r.type === 'finished' && r.sessionId) {
            let f = bySession.get(r.sessionId);
            if (f && r.at - f.lastAt < DUPLICATE_MS) continue;
            if (!f) {
                f = { sessionId: r.sessionId, title: r.title, project: r.project,
                    turns: 0, lastAt: 0, standing: null };
                bySession.set(r.sessionId, f);
            }
            f.turns++;
            f.lastAt = r.at;
            // The newest title wins: a session renamed while you were away
            // should be shown under the name it has now.
            if (r.title) f.title = r.title;
        } else if (FAILED_TYPES.has(r.type)) {
            failed.push({
                id: r.id, sessionId: r.sessionId || null, title: r.title,
                project: r.project || null, type: r.type, summary: r.summary || null,
                at: r.at, anchorId: r.anchorId || null,
            });
        } else if (r.type === 'schedule-findings' && r.sessionId) {
            findings.set(r.sessionId, r);
        }
    }
    const finished = [...bySession.values()]
        .map(f => ({ ...f, standing: standingFor(f.sessionId) || null }))
        .sort((a, b) => b.lastAt - a.lastAt);
    failed.sort((a, b) => b.at - a.at);

    // --- schedules ----------------------------------------------------------
    const ran = schedules
        .filter(s => s && tsMs(s.lastFiredAt) >= since && tsMs(s.lastFiredAt) <= now)
        .map(s => {
            const hit = s.lastSessionId ? findings.get(s.lastSessionId) : null;
            return {
                id: s.id,
                title: scheduleTitle(s),
                lastFiredAt: tsMs(s.lastFiredAt),
                lastSessionId: s.lastSessionId || null,
                lastOutcome: s.lastOutcome || null,
                lastError: s.lastError || null,
                runs: Number(s.runs) || 0,
                findings: hit ? (hit.summary || null) : null,
            };
        })
        .sort((a, b) => b.lastFiredAt - a.lastFiredAt);

    // --- pull requests ------------------------------------------------------
    const prList = [];
    const seen = new Set();
    for (const [k, entry] of Object.entries(prs.terminal || {})) {
        const pull = entry && entry.pull;
        if (!pull) continue;
        const merged = pull.state === 'MERGED';
        const exact = tsMs(merged ? pull.mergedAt : pull.closedAt);
        const at = exact || tsMs(entry.at);
        if (!at || at < since || at > now) continue;
        seen.add(k);
        prList.push({
            repo: pull.repo || k.split('#')[0], number: pull.number, url: pull.url,
            title: pull.title || null, change: merged ? 'merged' : 'closed', at,
            // When GitHub's own timestamp was not cached, `at` is when this
            // bridge noticed — which may be well after the fact.
            approx: !exact,
        });
    }
    for (const [repo, entry] of Object.entries(prs.repos || {})) {
        for (const pull of (entry && entry.pulls) || []) {
            const at = tsMs(pull.createdAt);
            if (!at || at < since || at > now || seen.has(`${repo}#${pull.number}`)) continue;
            prList.push({
                repo, number: pull.number, url: pull.url, title: pull.title || null,
                change: 'opened', at, approx: false,
            });
        }
    }
    prList.sort((a, b) => b.at - a.at);

    // --- suggestions filed --------------------------------------------------
    const filed = suggestions
        .filter(s => s && tsMs(s.ts) >= since && tsMs(s.ts) <= now)
        .map(s => ({
            sessionId: s.sessionId,
            id: s.id,
            title: s.title || null,
            ts: s.ts,
            status: s.status || 'open',
            from: (s.session && s.session.title) || null,
        }))
        .sort((a, b) => tsMs(b.ts) - tsMs(a.ts));

    // --- orchestrator reports -----------------------------------------------
    const reports = [];
    for (const o of orchestrators) {
        if (!o || !Array.isArray(o.inbox) || isTest(o.id)) continue;
        const workers = new Map((o.workers || []).map(w => [w.id, w]));
        const orch = named(o.id);
        for (const item of o.inbox) {
            if (!item || !REPORT_KINDS.has(item.kind)) continue;
            if (!(item.at >= since && item.at <= now)) continue;
            const w = workers.get(item.workerId);
            reports.push({
                orchestratorId: o.id,
                orchestratorTitle: orch.title,
                workerId: item.workerId,
                workerTitle: (w && w.title) || named(item.workerId).title,
                kind: item.kind,
                text: item.text || '',
                at: item.at,
            });
        }
    }
    reports.sort((a, b) => b.at - a.at);

    const groups = {
        waiting, failed, finished, prs: prList, schedules: ran, suggestions: filed, reports,
    };
    const counts = {};
    let total = 0;
    for (const [k, v] of Object.entries(groups)) { counts[k] = v.length; total += v.length; }
    const out = { since, now, total, counts };
    for (const [k, v] of Object.entries(groups)) out[k] = capped(v);
    return out;
}

module.exports = { buildDigest, CAP, DUPLICATE_MS, FAILED_TYPES };
