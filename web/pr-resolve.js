// Whose PR is `#151`? The rule, with nothing behind it.
//
// Split from web/pr-refs.js, which does the hover card and the click, so Node can
// load it: that module has a `dom` and a `state` behind it, and this is the part
// worth pinning — test/pr-owners.test.js does.
//
// Two rules decide everything here, and both are about not claiming too much:
//
// - **Only the repositories this conversation is about are consulted** — the one
//   its checkout points at, and the ones its own PRs live in. A bare `#151` in a
//   single-repository chat means that repository's #151; another project's #151
//   is never offered, however recently it was raised. Only a chat that has itself
//   raised PRs in more than one repository gets a section for each.
// - **A mention of this chat's own PR stays what it was** — plain text — when
//   nobody else raised it. It is the case the feature is not for, and drawing it
//   as a link that goes nowhere would be worse than leaving it alone.

/**
 * The repositories a `#N` in this conversation can mean, the checkout's first.
 *
 * @param {string|null} cwdRepo `repo` from `GET /api/sessions/:id/prs`
 * @param {Array<{repo?: string|null}>} prs the session's own `summary.prs`
 */
export function reposOf(cwdRepo, prs) {
    const out = [];
    for (const r of [cwdRepo, ...(prs || []).map(p => p && p.repo)]) {
        if (r && !out.includes(r)) out.push(r);
    }
    return out;
}

/**
 * Every place `#number` could point, one section per repository that has it.
 *
 * @param {number|string} number
 * @param {{repos: string[], owners: object, prs?: object, selfId?: string|null}} ctx
 *   `owners` and `prs` are `GET /api/pr-owners` as served.
 * @returns {Array<{repo: string, projectName: string|null,
 *   pr: {title, status, label}|null,
 *   entries: Array<{sessionId: string, title: string|null, projectName: string|null, self: boolean}>}>}
 */
export function resolvePrRef(number, { repos, owners, prs = {}, selfId = null }) {
    const sections = [];
    for (const repo of repos || []) {
        const key = `${repo}#${number}`;
        const seen = new Set();
        const entries = [];
        for (const o of (owners && owners[key]) || []) {
            if (!o || seen.has(o.sessionId)) continue;
            seen.add(o.sessionId);
            entries.push({
                sessionId: o.sessionId,
                title: o.title || null,
                projectName: o.projectName || null,
                self: o.sessionId === selfId,
            });
        }
        if (!entries.length) continue;
        // The project is named by whoever raised it — the label the rail groups
        // that session under — and by the repository only when nobody has one.
        const named = entries.find(e => !e.self && e.projectName) || entries.find(e => e.projectName);
        sections.push({
            repo,
            projectName: named ? named.projectName : repo,
            pr: (prs && prs[key]) || null,
            entries,
        });
    }
    return sections;
}

/** Somewhere to go: the chats in these sections that are not this one, in order. */
export function targetsOf(sections) {
    return sections.flatMap(s => s.entries.filter(e => !e.self)
        .map(e => ({ ...e, projectName: s.projectName })));
}

/** One row of the click list: `Project – (Chat)`. */
export const targetLabel = (t) => `${t.projectName || 'unknown'} – (${t.title || 'Untitled session'})`;
