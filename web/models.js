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
