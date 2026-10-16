// Session templates in the Start-a-session dialog: the picker at the top, the
// boxes for the placeholders a template asks about, Save as template…, and the
// dialog's edit-a-template mode. The store and the routes are bridge/templates.js
// and bridge/routes/templates.js.
//
// **A template only fills the dialog.** Picking one writes the fields and Fill
// writes the prompt, but nothing starts until you press Start, which sends
// `POST /api/sessions` like any other start. So everything that route refuses is
// still refused, and you see the filled prompt before it runs.
//
// Placeholders are filled by the bridge (`POST /api/templates/:id/resolve`),
// not here, so the desktop and the phone fill `{{branch}}` the same way.
//
// Imports dialog.js, which imports this back. Safe for the reason dialog.js's
// header gives: nothing here reads an import while the module evaluates.

import { del, get, patch, post } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { state } from '../state.js';
import {
    closeNew, newDialogStartOptions, openNew, setNewCwd, setNewStartOptions,
} from './dialog.js';

// ── the list ─────────────────────────────────────────────────────────────

export function applyTemplates(data) {
    state.templates.rows = data.templates || [];
    // Redrawn only while the picker is on screen. The next openNew draws it anyway.
    if (!dom.newScrim.hidden && !dom.newTplRow.hidden) renderPicker();
}

export async function loadTemplates() {
    try {
        applyTemplates(await get('/api/templates'));
    } catch { /* the picker just stays empty; the next push or reconnect fills it */ }
}

/**
 * The project a directory is scoped to, on the bridge's terms: a worktree under
 * `.claude/worktrees/` belongs to the checkout it was made from. `projectOf` in
 * bridge/templates.js, which is what decides where the template is offered.
 */
function projectOf(cwd) {
    const dir = String(cwd || '').trim().replace(/\/+$/, '');
    if (!dir) return null;
    const m = /^(.*)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/.exec(dir);
    return m ? m[1] : dir;
}

const baseName = (p) => String(p).split('/').filter(Boolean).pop() || p;

/**
 * The picker: "Everywhere" first, then one group per project. Every template is
 * listed whatever directory is in the box, because the box is usually empty when
 * the dialog opens and a project template is how you pick the project.
 */
function renderPicker() {
    const keep = dom.newTpl.value;
    const rows = state.templates.rows;
    const global = rows.filter(r => !r.project);
    const byProject = new Map();
    for (const r of rows.filter(r => r.project)) {
        if (!byProject.has(r.project)) byProject.set(r.project, []);
        byProject.get(r.project).push(r);
    }
    const opt = (r) => el('option', { value: r.id }, r.name);
    dom.newTpl.replaceChildren(
        el('option', { value: '' }, rows.length ? 'None — start from scratch' : 'No templates yet'),
        ...(global.length ? [el('optgroup', { label: 'Everywhere' }, ...global.map(opt))] : []),
        ...[...byProject].map(([dir, list]) => el('optgroup',
            { label: list[0].projectName || baseName(dir) }, ...list.map(opt))),
    );
    dom.newTpl.value = rows.some(r => r.id === keep) ? keep : '';
    paintPickerButtons();
}

const pickedRow = () => state.templates.rows.find(r => r.id === dom.newTpl.value) || null;

function paintPickerButtons() {
    const on = !!pickedRow();
    dom.newTplEdit.disabled = !on;
    dom.newTplDel.disabled = !on;
    disarmDelete();
}

// ── on every open ────────────────────────────────────────────────────────

/**
 * Put the template parts of the dialog in the state this open wants. Called by
 * openNew() after it has written the shared fields. `plain` is whether this open is
 * the ordinary Start dialog, the only mode with the picker and Save as template….
 */
export function prepareTemplates({ plain, template }) {
    state.templates.editing = template ? template.id : null;
    state.templates.picked = null;
    dom.newTplRow.hidden = !plain;
    dom.newTplFill.hidden = true;
    dom.newTplFill.replaceChildren();
    dom.newTpl.value = '';
    if (plain) renderPicker();

    dom.newTplSave.hidden = !plain;
    dom.newTplSaveRow.hidden = !template;
    dom.newTplSaveCancel.hidden = !!template;
    dom.newTplName.value = template ? template.name : '';
    dom.newTplSaveGo.textContent = template ? 'Save changes' : 'Save template';
    if (template) {
        // Edit mode is about the template alone, so the buttons that would start,
        // draft or schedule what is on screen go.
        dom.newGo.hidden = true;
        dom.newSave.hidden = true;
        dom.newSched.hidden = true;
        dom.newOrchSend.hidden = true;
        setNewStartOptions({ worktree: template.worktree, orchestrator: template.orchestrator });
        paintScope(template.project);
    }
}

/**
 * The scope select: Everywhere, the project of the directory in the box, and,
 * while editing, the project the template already has if that is another one.
 * The value is the directory itself, so what is saved is what the label says.
 */
function paintScope(current = null) {
    const here = projectOf(dom.newCwd.value);
    const dirs = [...new Set([current, here].filter(Boolean))];
    dom.newTplScope.replaceChildren(
        el('option', { value: '' }, 'Everywhere'),
        ...dirs.map(d => el('option', { value: d }, `Only in ${baseName(d)}`)),
    );
    dom.newTplScope.value = current || '';
}

// ── using one ────────────────────────────────────────────────────────────

/**
 * Picked from the list: write every setting now and the skeleton into the prompt
 * box, so you can see what it is going to ask for. Then fill it at once if there
 * is nothing to ask, or draw a box per question if there is.
 */
function onPick() {
    paintPickerButtons();
    const t = pickedRow();
    state.templates.picked = t ? t.id : null;
    dom.newTplFill.hidden = true;
    dom.newTplFill.replaceChildren();
    if (!t) return;

    // A directory already in the box was put there on purpose, so a template
    // without one of its own keeps it. One with its own directory, or a project,
    // wins: that is what it was saved for.
    const dir = t.cwd || (t.project && projectOf(dom.newCwd.value) !== t.project ? t.project : null);
    if (dir) setNewCwd(dir);
    dom.newModel.value = t.model || '';
    dom.newEffort.value = t.effort || '';
    dom.newPerm.value = t.permissionMode;
    if (state.dev) dom.newTest.checked = !!t.test;
    setNewStartOptions({ worktree: t.worktree, orchestrator: t.orchestrator });
    dom.newPrompt.value = t.prompt || '';
    dom.newPrompt.dispatchEvent(new Event('input'));

    if (!t.asks.length) {
        if (t.builtins.length) fill();
        return;
    }
    dom.newTplFill.replaceChildren(
        ...t.asks.map((name) => el('label', { class: 'tpl-ask' },
            el('span', {}, name),
            el('input', {
                type: 'text', spellcheck: 'false', autocomplete: 'off', 'data-name': name,
                onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); fill(); } },
            }))),
        el('button', { class: 'btn small primary', type: 'button', onclick: fill }, 'Fill'),
    );
    dom.newTplFill.hidden = false;
    dom.newTplFill.querySelector('input')?.focus();
}

/** Ask the bridge to fill the picked template, and write what comes back. */
async function fill() {
    const id = state.templates.picked;
    if (!id) return;
    const values = {};
    for (const input of dom.newTplFill.querySelectorAll('input[data-name]')) {
        values[input.dataset.name] = input.value;
    }
    const cwd = dom.newCwd.value.trim();
    let r;
    try {
        r = await post(`/api/templates/${id}/resolve`, { ...(cwd ? { cwd } : {}), values });
    } catch (err) {
        toast(`Could not fill the template: ${err.message}`, 'error');
        return;
    }
    // Picked something else while the request was out.
    if (state.templates.picked !== id) return;
    const f = r.fields;
    if (!cwd && f.cwd) setNewCwd(f.cwd);
    dom.newPrompt.value = f.prompt;
    dom.newPrompt.dispatchEvent(new Event('input'));
    // After the prompt's input event, which writes the worktree name from the
    // prompt unless one is set. This one is set.
    setNewStartOptions({ worktree: f.worktree, orchestrator: f.orchestrator });
    if (r.missing.length) {
        toast(`Still unfilled: ${r.missing.map(n => `{{${n}}}`).join(', ')}`, 'warn');
    } else {
        dom.newTplFill.hidden = true;
        dom.newPrompt.focus();
    }
}

// ── saving, editing, deleting ────────────────────────────────────────────

function openSaveRow() {
    dom.newTplSaveRow.hidden = false;
    const t = pickedRow();
    // Saving over the one you started from is the commonest reason to be here,
    // but it is a new template unless you went through Edit, so only the name
    // is offered as a starting point.
    dom.newTplName.value = t ? `${t.name} (copy)` : '';
    paintScope(t ? t.project : null);
    dom.newTplName.focus();
    dom.newTplName.select();
}

/** The dialog as a template body. Unlike Start, nothing here is required but a name. */
function templateBody() {
    const name = dom.newTplName.value.trim();
    if (!name) {
        toast('Give the template a name.', 'warn');
        dom.newTplName.focus();
        return null;
    }
    const { worktree, orchestrator } = newDialogStartOptions();
    const body = {
        name,
        project: dom.newTplScope.value || null,
        cwd: dom.newCwd.value.trim() || null,
        prompt: dom.newPrompt.value.trim(),
        model: dom.newModel.value || null,
        effort: dom.newEffort.value || null,
        permissionMode: dom.newPerm.value,
        worktree, orchestrator,
    };
    // Only where the box exists: newDialogValues() says why.
    if (state.dev) body.test = dom.newTest.checked;
    return body;
}

async function saveTemplate() {
    const body = templateBody();
    if (!body) return;
    const editing = state.templates.editing;
    dom.newTplSaveGo.disabled = true;
    try {
        if (editing) {
            await patch(`/api/templates/${editing}`, body);
            closeNew();
            toast('Template saved.', 'ok');
        } else {
            const { template } = await post('/api/templates', body);
            // Stays open: saving the setup as a template is usually a step on
            // the way to starting it.
            state.templates.rows = [template, ...state.templates.rows.filter(r => r.id !== template.id)];
            renderPicker();
            dom.newTplSaveRow.hidden = true;
            // Picked as if from the list, so the boxes for its placeholders
            // appear. Every field it writes is the one just saved from.
            dom.newTpl.value = template.id;
            onPick();
            toast(`Saved as template "${template.name}".`, 'ok');
        }
    } catch (err) {
        toast(`Could not save the template: ${err.message}`, 'error');
    } finally {
        dom.newTplSaveGo.disabled = false;
    }
}

let armTimer = null;
function disarmDelete() {
    clearTimeout(armTimer);
    armTimer = null;
    dom.newTplDel.textContent = 'Delete';
    dom.newTplDel.classList.remove('armed');
}

/** Two presses: the first arms it for three seconds, the second deletes. */
async function deletePicked() {
    const t = pickedRow();
    if (!t) return;
    if (!armTimer) {
        dom.newTplDel.textContent = 'Delete?';
        dom.newTplDel.classList.add('armed');
        armTimer = setTimeout(disarmDelete, 3000);
        return;
    }
    disarmDelete();
    try {
        await del(`/api/templates/${t.id}`);
        state.templates.rows = state.templates.rows.filter(r => r.id !== t.id);
        state.templates.picked = null;
        dom.newTpl.value = '';
        renderPicker();
        dom.newTplFill.hidden = true;
        toast(`Deleted template "${t.name}".`, 'ok');
    } catch (err) {
        toast(`Could not delete the template: ${err.message}`, 'error');
    }
}

export function wireTemplates() {
    dom.newTpl.addEventListener('change', onPick);
    dom.newTplEdit.addEventListener('click', () => {
        const t = pickedRow();
        if (t) openNew({ template: t });
    });
    dom.newTplDel.addEventListener('click', deletePicked);
    dom.newTplSave.addEventListener('click', openSaveRow);
    dom.newTplSaveGo.addEventListener('click', saveTemplate);
    dom.newTplSaveCancel.addEventListener('click', () => { dom.newTplSaveRow.hidden = true; });
    dom.newTplName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); saveTemplate(); }
    });
}
