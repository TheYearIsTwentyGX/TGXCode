// The models and effort levels the pickers offer — bridge/models.js's list, put
// in the page as a `tgx-models` <meta> tag by bridge/server.js.
//
// One list for every picker: the composer's, the Start dialog's, the
// orchestrator settings popover and Settings › Orchestrators. They were written
// out by hand in web/index.html before, where the bridge could not see them —
// so the names an orchestrator was told it could give a worker, and the ones it
// was refused for, could drift from the ones the window offered.
//
// Read at load, guarded: the node tests import modules that import this, and
// there is no `document` there.

const read = () => {
    try {
        if (typeof document === 'undefined') return null;
        const m = document.querySelector('meta[name="tgx-models"]');
        return m ? JSON.parse(decodeURIComponent(m.content)) : null;
    } catch { return null; }
};

const P = read() || {};

/** `[{id, label, note}]`. */
export const MODELS = Array.isArray(P.models) ? P.models : [];
/** `['low', …]`. */
export const EFFORTS = Array.isArray(P.efforts) ? P.efforts : [];

/**
 * Append an `<option>` per model (or effort) to a `<select>` that already holds
 * its `inherit` option. Kept to plain DOM: these selects are not Preact's.
 */
export function fillSelect(sel, kind = 'model') {
    if (!sel) return;
    const list = kind === 'effort' ? EFFORTS.map(e => ({ id: e, label: e })) : MODELS;
    for (const m of list) {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.label || m.id;
        if (m.note) o.title = m.note;
        sel.append(o);
    }
}

// ── per runtime ───────────────────────────────────────────────────────────
//
// Claude's list is the one above, in the page. Codex's is asked of Codex
// (`GET /api/models?runtime=codex`, which is `model/list` behind a cache) and is
// **never written down here**: it depends on the account and moves between
// versions (docs/plans/23-codex.md, Phase 3). Fetched once per page, on the
// first picker that needs it.

const lists = new Map();

/**
 * `{models, efforts, error?}` for a runtime, the shape the `tgx-models` tag has.
 * Claude's answers at once; another runtime's is fetched, and a failure is an
 * empty list with the bridge's reason rather than a throw.
 */
export function modelsFor(runtime = 'claude') {
    if (!runtime || runtime === 'claude') return Promise.resolve({ models: MODELS, efforts: EFFORTS });
    if (!lists.has(runtime)) {
        const p = import('./api.js').then(({ get }) => get(`/api/models?runtime=${encodeURIComponent(runtime)}`))
            .catch((err) => ({ models: [], efforts: [], error: err.message }));
        // A failed fetch is not cached for the page's life: the next picker asks again.
        p.then((v) => { if (v.error) lists.delete(runtime); });
        lists.set(runtime, p);
    }
    return lists.get(runtime);
}

/**
 * Refill a model or effort `<select>` for a runtime, keeping its first
 * (`inherit`) option. `sel.dataset.runtime` records which list it holds, so a
 * caller can ask whether it needs doing; the value is kept when the new list has
 * it. Resolves once filled.
 */
export async function fillSelectFor(sel, kind, runtime = 'claude') {
    if (!sel) return;
    const want = runtime || 'claude';
    sel.dataset.runtime = want;
    const list = await modelsFor(want);
    if (sel.dataset.runtime !== want) return;   // changed again while this was fetching
    const keep = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    const items = kind === 'effort' ? (list.efforts || []).map(e => ({ id: e, label: e })) : (list.models || []);
    for (const m of items) {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.label || m.id;
        if (m.note) o.title = m.note;
        if (m.default) o.textContent += ' (default)';
        sel.append(o);
    }
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
    sel.title = list.error || '';
}
