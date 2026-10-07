// The Start-a-session dialog: opening and closing it, the working-directory box
// and its project tint, the values its buttons send, and its first-message box as
// a composer (`newC`). Moved out of app.js as it was. The Recent/Browse picker is
// picker.js, the trigger and draft buttons trigger.js, the split button's menu
// recent.js. wireNewDialog() binds the dialog's listeners and is called by app.js
// where they ran.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.
//
// One exception: `newC` is built at load, by calling makeComposer from slash.js.
// That is safe because makeComposer is a function declaration, which exists
// before any module evaluates, and its body touches only its arguments and two
// other function declarations. growPrompt is defined here, above it, for the
// same reason: a `const` read at load has to be this file's own.

import { get } from '../api.js';
import { closeOnClickOutside, dom, el, toast } from '../dom.js';
import { clip } from '../format.js';
import { state } from '../state.js';
import { homely } from '../term-pane.js';
import { projectColor } from '../app.js';
import { closeSnips } from '../snippets/popover.js';
import { clearAttach } from '../composer/attachments.js';
import { grow } from '../composer/send.js';
import {
    closeMenus, live, makeComposer, menuOpen, repositionFloatingMenus, updateSlashMenu,
} from '../composer/slash.js';
import {
    browseNote, browseTo, cancelMkdir, setPickerTab, startMkdir, submitMkdir,
} from './picker.js';
import { describeCronSoon, paintGateFields, paintNewAttach, setWhen } from './trigger.js';
import { openPublish } from '../github/publish.js';

// ── new session ──────────────────────────────────────────────────────────

/**
 * Every directory a session has run in, newest first — the one list the dialog's
 * Recent tab and the rail's split menu both answer from.
 */
export async function loadProjects() {
    const { projects } = await get('/api/projects');
    // The same list, keyed by path, so a browsed row can say "you have worked
    // here" without a second request. It quietly joins the two tabs together.
    state.browse.known = new Map(projects.map(p => [p.cwd, p]));
    return projects;
}

// ── the Recent tab ───────────────────────────────────────────────────────

// The whole list from the last open, so the filter can reach past the rows on
// screen without asking the bridge again on every keystroke.
let recentProjects = [];
const RECENT_MAX = 40;

/**
 * Every term has to appear somewhere in the name or the path, in any order —
 * so `claude work` finds `~/Other/claude-sessions/.claude/worktrees/…`. The
 * `~` spelling is matched as well as the real one, because it is the spelling
 * every path in this app is shown in.
 */
export function matchesRecent(p, query) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const hay = `${p.name}\n${p.cwd}\n${homely(p.cwd)}`.toLowerCase();
    return terms.every(t => hay.includes(t));
}

function renderRecent() {
    const query = dom.newRecentFilter.value;
    const shown = recentProjects.filter(p => matchesRecent(p, query)).slice(0, RECENT_MAX);
    if (!shown.length) {
        dom.newPicker.replaceChildren(el('div', { class: 'picker-msg' },
            recentProjects.length
                ? 'No recent directory matches — Browse finds the rest.'
                : 'No directories yet — Browse to pick one.'));
        return;
    }
    dom.newPicker.replaceChildren(...shown.map((p, i) => {
        // A dot in the project's own colour, so what the dialog is about to
        // turn into is readable before the press rather than after it.
        const accent = projectColor(p.cwd);
        return el('button', {
            class: 'picker-row', type: 'button',
            'data-tinted': accent ? '1' : null,
            style: accent ? `--proj-accent: ${accent}` : null,
            onclick: () => pickRecent(p.cwd),
            onkeydown: (e) => onRecentKey(e, i),
        },
            el('span', { class: 'pdot' }, ''),
            el('span', {}, p.name),
            el('span', { class: 'path' }, clip(p.cwd, 44)),
            p.active ? el('span', { class: 'tag' }, `${p.active} live`) : null,
        );
    }));
}

function pickRecent(cwd) {
    setNewCwd(cwd);
    dom.newPrompt.focus();
}

const recentRows = () => [...dom.newPicker.querySelectorAll('.picker-row')];

/** Up from the first row is back into the filter, so the list and its search are one column. */
function onRecentKey(e, i) {
    const rows = recentRows();
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        rows[Math.min(i + 1, rows.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (i === 0) dom.newRecentFilter.focus();
        else rows[i - 1]?.focus();
    }
}

/**
 * The Start-a-session dialog, which is also the edit-a-draft dialog.
 *
 * @param {{cwd?: string, tab?: 'recent'|'browse', prompt?: string, draft?: object,
 *   schedule?: object|boolean, seed?: object}} [opts]
 *   `cwd` is a caller that has already answered "where" — the split menu passes
 *   the row you clicked. Without one the dialog opens where it always has: the
 *   session on screen, else the most recent project. `prompt` fills the first
 *   message, for a caller that has already written one — Edit first on a
 *   suggested follow-up, where the whole point is that the prompt exists and you
 *   want a look at it before it runs.
 *
 *   `draft` opens the dialog *as* that draft: every field prefilled, the title
 *   and the save button renamed, and Save writing back to it rather than making
 *   another. One dialog for both because a draft is exactly the set of fields
 *   this one already collects — a second form would be the same six controls
 *   with a different chance of drifting.
 *
 *   `schedule` is the same trick again: `true` for a new one, a row to edit that
 *   one. It shows the two rows only a schedule has, and swaps the footer.
 *
 *   `seed` is prefill for a schedule that has no row yet — what the Schedule
 *   button hands over when it converts what is on screen. It reads like a row
 *   here, so the prefills below take it as one; the difference is that it leaves
 *   `state.sched.editing` null, so the save is a POST rather than a PATCH. Its
 *   one extra key is `fromDraft`, the draft the save will consume.
 *
 * **Model and permission mode are written on every open, in both directions.**
 * They used to be left alone, which was harmless while the dialog only ever
 * started things: the selects kept your last choice, which was usually what you
 * wanted again. It stops being harmless once a draft can set them — opening a
 * `bypassPermissions` draft and then pressing Ctrl+N would offer that mode for a
 * brand-new session, having been asked for once, about something else.
 */
export async function openNew({ cwd = '', tab = null, prompt = '', draft = null,
    schedule = null, seed = null } = {}) {
    // `schedule: true` means "a new one"; a row means "edit that one". The two
    // have to be told apart because only the second has fields to prefill, and
    // both have to put the dialog in schedule mode.
    const sched = schedule && typeof schedule === 'object' ? schedule : null;
    const schedMode = Boolean(schedule);
    // A draft and a schedule are the same fields with a different owner, so one
    // local stands in for whichever is being edited and the prefill below reads
    // from it once instead of branching on every line. A `seed` joins them as a
    // third: the same fields again, from something that is not a stored row.
    const src = sched || seed || draft;

    state.drafts.editing = draft ? draft.id : null;
    // A seed is prefill, not an edit — the schedule it describes does not exist
    // yet — so `editing` stays null and schedSave still POSTs. What it does carry
    // is which draft it came from, if any.
    state.sched.editing = sched ? sched.id : null;
    state.sched.fromDraft = seed ? (seed.fromDraft || null) : null;

    // Ctrl+N over a live composer with `/rev` half-typed in it is reachable, and
    // a popover anchored to a box that is now behind a modal is nothing but
    // debris on screen.
    closeMenus(live);

    dom.newScrim.hidden = false;
    dom.newPrompt.value = src ? src.prompt : prompt;
    growPrompt();
    // Written on every open in both directions, the rule this docstring states:
    // a name left behind from the last draft you looked at would be attached to
    // the next thing you saved.
    dom.newName.value = src ? (src.title || '') : '';
    dom.newTest.checked = src ? !!src.test : false;
    dom.newModel.value = src ? (src.model || '') : '';
    dom.newEffort.value = src ? (src.effort || '') : '';
    // The dialog's own default, and deliberately not the composer's: the first
    // message of a session is the one written with the least idea of what it will
    // touch. Spelled out here rather than left to the `selected` attribute, which
    // only decides the very first open.
    //
    // A *new* schedule defaults to `dontAsk` instead, and that is the one place
    // this dialog's default depends on what is being made. `plan` is right for a
    // message you are about to watch run and wrong for one that runs at 2 AM: a
    // scheduled session in `plan` writes a plan nobody reads, and one in `auto`
    // stops at the first prompt and waits until morning. Editing an existing
    // schedule keeps whatever it already had.
    dom.newPerm.value = src ? src.permissionMode : (schedMode ? 'dontAsk' : 'plan');
    // **Only what somebody said.** A draft or schedule being edited carries its
    // own directory, and every caller that means a particular project passes
    // one — the suggested-task dialog, the rail's split button, the conversion
    // from a draft. What is gone is the guessing underneath that: the open
    // session's directory, and, below, the most recently active project. Both
    // scoped a session for you, and neither said so, which made the commonest
    // way to get this wrong "not noticing that it had been answered". Nothing
    // else has to change for the box to be empty: newDialogValues() has always
    // refused a dialog with no directory in it.
    setNewCwd((src && src.cwd) || cwd || '');

    // The two fields only a schedule has.
    dom.newCronRow.hidden = !schedMode;
    dom.newGateRow.hidden = !schedMode;
    // The picker rather than an expression, and filled from the bridge's own
    // reading of one: `cronForm` is what says which row an existing schedule
    // belongs on. A new schedule opens on Weekly, Tue–Sat at 02:00 — the same
    // suggestion the cron box used to open with, spelled as controls.
    // A seeded schedule opens on One time. It is the shape the conversion is
    // for — a draft is a thing you meant to do once, and the clock is only
    // standing in for the Start you would have pressed — and it is a choice you
    // can still change before saving, like every other preset here.
    setWhen(sched ? sched.cronForm : null, sched ? sched.cron : '',
        sched ? !!sched.once : false, { newRow: seed ? 'once' : 'weekly' });
    const gate = sched ? sched.gate : null;
    dom.newGateKind.value = gate ? gate.kind : '';
    dom.newGateRef.value = gate && gate.kind === 'git-commits' ? gate.ref : '';
    dom.newPrDrafts.checked = gate && gate.kind === 'open-prs'
        ? gate.includeDrafts !== false : true;
    dom.newPrPost.checked = gate && gate.kind === 'open-prs'
        ? gate.post !== false : true;
    paintGateFields();
    if (schedMode) describeCronSoon();

    // Schedule mode swaps Start and Save-as-draft for one button: a schedule you
    // have written has not run and is not meant to yet, so "keep this" and "do
    // this" are the same press.
    dom.newGo.hidden = schedMode;
    dom.newSave.hidden = schedMode;
    // Offered from Start-a-session as well as from a draft: the fields it needs
    // are the fields this dialog always collects, and refusing to schedule
    // something you had not saved first would be an extra step for no reason.
    dom.newSched.hidden = schedMode;
    dom.newSchedSave.hidden = !schedMode;
    dom.newSchedSave.textContent = sched ? 'Save changes' : 'Save schedule';

    // Only where the dialog is about to start a session. A draft and a schedule are
    // records of a create call, and neither store carries attachments — see
    // docs/api.md — so offering the control there would be offering something that
    // silently does not survive being saved.
    dom.newAttachRow.hidden = schedMode || Boolean(draft);
    clearAttach(newC);

    // The worktree row, on the same terms and for a stronger reason: a draft and a
    // schedule are validated when saved, before any worktree could exist. Reset on
    // every open, so a name typed for the last session is not offered for this one.
    // Painted again now because setNewCwd above painted it under the last open's
    // mode; the repo-state answer it is waiting on paints it once more.
    wt.offered = !schedMode && !draft;
    wt.named = false;
    dom.newWt.checked = false;
    // Starting as an orchestrator, on the worktree row's terms: Start only, reset
    // on every open so the last session's choice is not carried into this one.
    dom.newOrchRow.hidden = !wt.offered;
    dom.newOrch.checked = false;
    paintNewOrch();
    dom.newWtName.value = '';
    dom.newWtBase.value = '';
    paintNewWorktree();

    dom.newTitle.textContent = schedMode
        ? (sched ? 'Edit schedule'
            : (state.sched.fromDraft ? 'Schedule this draft' : 'Schedule a session'))
        : (draft ? 'Edit draft' : 'Start a session');
    dom.newSave.textContent = draft ? 'Save changes' : 'Save as draft';
    cancelMkdir();
    // A filter left over from the last open would hide rows for no reason you
    // can see from here, so every open starts from the whole list.
    dom.newRecentFilter.value = '';
    try {
        recentProjects = await loadProjects();
        renderRecent();
    } catch (err) {
        toast(`Could not list projects: ${err.message}`, 'error');
    }
    setPickerTab(tab || state.browse.tab, { load: true });
    dom.newPrompt.focus();
    // A prompt that arrived already written is there to be read and edited, so
    // put the caret at the end of it rather than in front of the first word.
    const written = dom.newPrompt.value;
    if (written) dom.newPrompt.setSelectionRange(written.length, written.length);
}

/**
 * Write the working-directory box, and repaint what hangs off it.
 *
 * The one way in, because three things used to write that input on their own —
 * openNew(), a row in the Recent list, and every step through the Browse tree —
 * and the dialog's colour and the project named in its head have to follow all
 * three. The `input` listener covers the fourth writer, which is a person typing.
 */
export function setNewCwd(value) {
    dom.newCwd.value = value;
    paintNewProject();
}

/**
 * Which project the dialog is about, and the colour it wears for it.
 *
 * Two separate jobs, deliberately in one function: the chip names the project
 * whether or not it has a colour, and the colour is only ever an addition to
 * that. A dialog with no project at all says so rather than showing nothing,
 * because an empty box is exactly the state the head exists to make visible.
 *
 * `data-tinted` rather than a bare custom property is what keeps the uncoloured
 * dialog identical to the one this app has always drawn: every tint rule in
 * web/css/colours.css hangs off that attribute, so without it not one of them
 * applies — rather than all of them applying through a colour-mix that happens
 * to land near the blue they replace.
 */
export function paintNewProject() {
    const cwd = dom.newCwd.value.trim();
    const accent = projectColor(cwd);
    const name = cwd ? (cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop() || cwd) : '';

    if (accent) dom.newScrim.style.setProperty('--proj-accent', accent);
    else dom.newScrim.style.removeProperty('--proj-accent');
    dom.newScrim.toggleAttribute('data-tinted', !!accent);

    dom.newProject.replaceChildren(
        el('span', { class: 'pdot' }, ''),
        el('span', { class: 'new-project-name' }, name || 'No project selected'),
    );
    dom.newProject.classList.toggle('none', !cwd);
    paintNewGh();
}

let ghTimer = null;
let ghAsked = 0;

/**
 * Show "Publish to GitHub…" under the directory box when the directory has no
 * origin to publish to. Asked a moment after the box stops changing, because
 * typing a path fires this on every character and each one is a `git` call on
 * the bridge. Hidden while the question is out, so a link never points at the
 * directory before the one now in the box.
 */
function paintNewGh() {
    clearTimeout(ghTimer);
    dom.newGh.hidden = true;
    // The same answer decides the worktree row, so it is withdrawn with the link
    // and comes back with it: a row offered for the directory before this one
    // would preview a path in the wrong repository.
    wt.root = null;
    paintNewWorktree();
    const cwd = dom.newCwd.value.trim();
    if (!cwd) return;
    ghTimer = setTimeout(async () => {
        const asked = ++ghAsked;
        let st;
        try { st = await get(`/api/github/repo-state?cwd=${encodeURIComponent(cwd)}`); } catch { return; }
        if (asked !== ghAsked || dom.newCwd.value.trim() !== cwd) return;
        dom.newGh.hidden = !!st.insideOther || st.remotes.some(r => r.name === 'origin');
        wt.root = worktreeRoot(st);
        paintNewWorktree();
    }, 300);
}

// ── start in a new worktree ───────────────────────────────────────────────

/**
 * What the worktree row knows. `root` is the repository a new worktree would go
 * under, or null when the directory is not one it can be made from; `offered` is
 * whether this open of the dialog is plain Start (see openNew); `named` is
 * whether the name box holds something somebody typed, after which the prompt
 * stops writing it.
 */
const wt = { root: null, offered: false, named: false };

// The rule bridge/worktree.js applies. Checked here too so the preview can say a
// name will be refused before the press rather than after it.
const WT_NAME_RE = /^[A-Za-z0-9._-]{1,60}$/;
const wtNameOk = (n) => WT_NAME_RE.test(n) && !/^[.-]/.test(n) && !n.endsWith('.lock') && !n.includes('..');

/**
 * The repository root a worktree for this directory would be made under, from
 * `/api/github/repo-state` — the question the Publish link already asks, so the
 * row costs no request of its own.
 *
 * A repository root needs a commit (there is nothing to branch from otherwise); a
 * directory inside one is offered on the parent's behalf. Either way, a root that
 * is itself `.claude/worktrees/<name>` is replaced by the checkout it belongs to,
 * because that is where the bridge will put the new one — it never nests them.
 * That last step is a preview of the bridge's `--git-common-dir` answer, not the
 * answer itself, and it only recognises the layout this app and `EnterWorktree`
 * make.
 */
function worktreeRoot(st) {
    const root = st.isGit ? (st.hasCommits ? st.cwd : null) : st.insideOther;
    if (!root) return null;
    const m = /^(.*)\/\.claude\/worktrees\/[^/]+\/?$/.exec(root);
    return m ? m[1] : root;
}

/** A name from the first few words of the prompt: `fix-the-login-redirect`. */
export function worktreeSlug(text) {
    return String(text || '').toLowerCase()
        .split(/[^a-z0-9]+/).filter(Boolean).slice(0, 4).join('-')
        .slice(0, 40).replace(/-+$/, '');
}

/**
 * Write the name from the prompt, unless somebody has typed one of their own.
 * Only ticking the box and editing the prompt call this — never a paint, or
 * clearing the name box to type a new one would refill it on the same keystroke.
 */
function fillWtName() {
    if (!wt.named) dom.newWtName.value = worktreeSlug(dom.newPrompt.value);
}

/** Show, hide and describe the worktree row. Cheap; called on every change. */
export function paintNewWorktree() {
    const show = wt.offered && !!wt.root;
    dom.newWtRow.hidden = !show;
    const on = show && dom.newWt.checked;
    dom.newWtFields.hidden = !on;
    dom.newWtNote.hidden = !on;
    if (!on) return;

    const name = dom.newWtName.value.trim();
    const base = dom.newWtBase.value.trim() || 'HEAD';
    if (!name) {
        dom.newWtNote.replaceChildren('Name the worktree — it becomes the folder and the branch.');
        dom.newWtNote.classList.add('warn');
        return;
    }
    if (!wtNameOk(name)) {
        dom.newWtNote.replaceChildren('Letters, digits, ".", "_" and "-" only, up to 60, '
            + 'not starting with "." or "-".');
        dom.newWtNote.classList.add('warn');
        return;
    }
    dom.newWtNote.classList.remove('warn');
    dom.newWtNote.replaceChildren(
        'Starts in ', el('code', {}, homely(`${wt.root}/.claude/worktrees/${name}`)),
        ' on a new branch ', el('code', {}, `worktree-${name}`),
        ' from ', el('code', {}, base), '.');
}

const ORCH_NOTE = 'It starts worker sessions and reads what they report from an inbox, '
    + 'rather than doing the work itself.';

/** The orchestrator row's note, which says so when the mode will fight it. */
function paintNewOrch() {
    const clash = dom.newOrch.checked && dom.newPerm.value === 'plan';
    dom.newOrchNote.classList.toggle('warn', clash);
    dom.newOrchNote.textContent = clash
        ? `${ORCH_NOTE} In plan mode every worker it starts waits on your approval first.`
        : ORCH_NOTE;
}

/**
 * The `orchestrator` field of `POST /api/sessions`: true when the row is offered
 * and ticked. Not part of `newDialogValues`, for `newDialogWorktree`'s reason
 * below — neither the drafts nor the schedules store has the field.
 */
export function newDialogOrchestrator() {
    return !dom.newOrchRow.hidden && dom.newOrch.checked;
}

/**
 * The `worktree` field of `POST /api/sessions`, or null for none, or false when
 * the row is ticked with a name that will be refused (and it has said so).
 *
 * **Deliberately not part of `newDialogValues`,** for the reason `newDialogName`
 * gives: that body is also the drafts' and the schedules' body, and neither store
 * has this field — so Start asks for it and the other two do not. The row is
 * hidden in draft and schedule mode anyway; this is what keeps Save-as-draft
 * from the plain Start dialog honest too.
 */
export function newDialogWorktree() {
    if (dom.newWtRow.hidden || !dom.newWt.checked) return null;
    const name = dom.newWtName.value.trim();
    if (!wtNameOk(name)) {
        toast('Give the worktree a name: letters, digits, ".", "_" and "-".', 'warn');
        dom.newWtName.focus();
        return false;
    }
    const base = dom.newWtBase.value.trim();
    return base ? { name, base } : { name };
}

/** Open Publish to GitHub over this dialog, for `cwd`, and look again afterwards. */
export function publishFromNew(cwd) {
    openPublish(cwd, { onDone: () => paintNewGh() });
}

export function closeNew() {
    dom.newScrim.hidden = true;
    // Hiding the scrim does not blur the box inside it, so the blur-to-close
    // never fires and a popover would still be up — fixed to the viewport, over
    // nothing — the next time the dialog opened.
    closeMenus(newC);
    closeSnips(newC);
    // Held files are bytes in this page and were never written anywhere, so closing
    // the dialog really does discard them — which is the whole benefit of holding
    // them rather than uploading on arrival.
    clearAttach(newC);
    // So a Save that somehow ran after this could not write to a draft the dialog
    // is no longer showing. openNew sets it on the way in either way.
    state.drafts.editing = null;
    state.sched.editing = null;
    // Otherwise a schedule saved later in this window would consume a draft that
    // an earlier, abandoned conversion had named.
    state.sched.fromDraft = null;
}

/**
 * What the dialog is currently describing, or null if it is not ready.
 *
 * Shared by the two buttons in the footer rather than copied into each: Start and
 * Save want exactly the same fields and exactly the same two complaints, and the
 * cost of having said them twice would be a save that accepted something a start
 * would refuse.
 *
 * Says so and returns null rather than throwing — the caller's next line is
 * always "then stop", and both callers are event handlers.
 */
export function newDialogValues() {
    const cwd = dom.newCwd.value.trim();
    const prompt = dom.newPrompt.value.trim();
    if (!cwd) { toast('Pick a working directory first.', 'warn'); return null; }
    // A screenshot with nothing typed is a message — "look at this" is the whole
    // content of it — and the create route takes it that way too.
    if (!prompt && !newC.attach.length) {
        toast('Write a first message so the session has something to do.', 'warn');
        return null;
    }
    const body = {
        cwd, prompt,
        model: dom.newModel.value || null,
        effort: dom.newEffort.value || null,
        permissionMode: dom.newPerm.value,
    };
    // `test` is only sent where the checkbox exists, which is the development
    // bridge alone — markInstance() hides the row otherwise. Sending it anyway
    // would be a silent lie in the one case that matters: a test-flagged draft
    // opened for editing in the everyday window would come back with
    // `test: false` from a control nobody could see, and the session it later
    // started would land in the user's real rail. PATCH leaves out what it is not
    // given, so omitting it preserves the flag; a create with it absent is
    // unflagged, which is right when the box was never offered.
    if (state.dev) body.test = dom.newTest.checked;
    return body;
}

/**
 * The name box, as the `title` field the two stores take.
 *
 * **Deliberately not part of `newDialogValues`.** That body is also the body of
 * `POST /api/sessions`, which takes no title — and the docstring above says why a
 * key a route ignores must not ride along on it. So the two callers that store a
 * title ask for it, and Start does not.
 *
 * `null` rather than `''`: a PATCH reads `null` as *clear this* and absence as
 * *leave it alone*, so emptying the box has to send something.
 */
export function newDialogName() {
    return dom.newName.value.trim() || null;
}


// ── the first-message box ─────────────────────────────────────────────────

// The dialog's own limits: two lines to start, and a ceiling low enough that a
// pasted-in briefing cannot push the Start button off the bottom of the modal.
const growPrompt = () => grow(dom.newPrompt, 62, 300);

/**
 * The first-message box, as a composer.
 *
 * Everything that differs from the live one is here and nowhere else, which is
 * the point of the descriptor: where the working directory comes from, what to
 * say when there is not one yet, and the two things about the box itself — it is
 * several lines tall, so Home and End stay with the caret; and it is inside a
 * modal that clips, so its popovers are positioned from script.
 *
 * No `closeOthers`: the bell and the recent-directories menu are main-window
 * furniture, and this dialog is laid over both of them already.
 */
export const newC = makeComposer({
    input: dom.newPrompt,
    slashNode: dom.newSlashMenu,
    mentionNode: dom.newMentionMenu,
    id: 'new',
    container: '.composer-field',
    snipBtn: dom.newBtnSnippets,
    snipNode: dom.newSnipMenu,
    // Read fresh on every keystroke, deliberately: the box below this one is a
    // text field, and walking into a folder in the picker writes it too, so the
    // directory can change while the menu is open. `sessionId: null` is what
    // sends the request as `?cwd=` and what leaves every running session in the
    // `@` menu rather than dropping the one you are in — there is not one yet.
    ctx: () => {
        const cwd = dom.newCwd.value.trim();
        return cwd ? { cwd, sessionId: null } : null;
    },
    notReady: 'Pick a working directory first.',
    homeEnd: false,
    float: true,

    // Held rather than uploaded, because where a file lands is decided by the box
    // above this one and that box is still editable. The drop zone is the field
    // rather than the whole modal: a file let go over the directory picker is much
    // more likely to be aimed at the picker than at the message.
    attachNode: dom.newAttach,
    attachInput: dom.newAttachInput,
    attachBtn: dom.newAttachBtn,
    dropZone: dom.newScrim.querySelector('.composer-field'),
    uploadMode: 'deferred',
    afterRender: () => paintNewAttach(),
    // Sizing the box is what this listener used to be for on its own. It stays
    // first: a popover placed against the box has to be placed against the height
    // it has now, not the height it had a keystroke ago.
    onInput: growPrompt,
    perm: dom.newPerm,
    model: dom.newModel,
});

/**
 * The dialog's own listeners. Called by app.js from where they were registered
 * when this was one file.
 */
export function wireNewDialog() {
    // A popover positioned from script has to be told when the page moves under it.
    // The modal body is the one scroll container between this box and the window.
    dom.newScrim.querySelector('.modal-body')
        .addEventListener('scroll', repositionFloatingMenus);

    // ✕, Cancel and a whole click outside — no Escape; see modalUp().
    for (const n of dom.newScrim.querySelectorAll('[data-close]')) {
        n.addEventListener('click', closeNew);
    }
    closeOnClickOutside(dom.newScrim, closeNew);

    dom.newTabRecent.addEventListener('click', () => setPickerTab('recent'));
    dom.newTabBrowse.addEventListener('click', () => setPickerTab('browse', { load: true }));

    // Two tabs, so both stay in the tab order and the arrows activate on move —
    // a roving rule would be machinery for a pair of buttons.
    for (const [tab, other] of [[dom.newTabRecent, 'browse'], [dom.newTabBrowse, 'recent']]) {
        tab.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            setPickerTab(other, { load: other === 'browse' });
            (other === 'browse' ? dom.newTabBrowse : dom.newTabRecent).focus();
        });
    }

    dom.newRecentFilter.addEventListener('input', renderRecent);
    dom.newRecentFilter.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            recentRows()[0]?.focus();
        } else if (e.key === 'Enter') {
            // The top match is the answer to a search you pressed Enter on. Never
            // let the key fall through to anything that would start the session.
            e.preventDefault();
            const first = recentProjects.find(p => matchesRecent(p, dom.newRecentFilter.value));
            if (first) pickRecent(first.cwd);
        } else if (e.key === 'Escape' && dom.newRecentFilter.value) {
            // Escape clears the search. The modal swallows the key otherwise, so
            // this is the only answer it has here — the New folder box's pattern.
            e.preventDefault();
            e.stopPropagation();
            dom.newRecentFilter.value = '';
            renderRecent();
        }
    });

    dom.newGh.addEventListener('click', () => publishFromNew(dom.newCwd.value.trim()));

    // The worktree row. The prompt writes the name until somebody types in the
    // name box; clearing that box hands it back to the prompt's next edit, and
    // leaves it empty until then.
    // Ticking it moves Permissions off `plan`, the dialog's default: an
    // orchestrator's whole job is calling its tools, and in plan mode each spawn
    // would stop for approval. Only off `plan`, and only on the way in — any
    // other mode was a choice, and so is putting it back.
    dom.newOrch.addEventListener('change', () => {
        if (dom.newOrch.checked && dom.newPerm.value === 'plan') dom.newPerm.value = 'auto';
        paintNewOrch();
    });
    dom.newPerm.addEventListener('change', paintNewOrch);
    dom.newWt.addEventListener('change', () => {
        if (dom.newWt.checked) fillWtName();
        paintNewWorktree();
        if (dom.newWt.checked) dom.newWtName.focus();
    });
    dom.newWtName.addEventListener('input', () => {
        wt.named = dom.newWtName.value.trim() !== '';
        paintNewWorktree();
    });
    dom.newWtBase.addEventListener('input', paintNewWorktree);
    dom.newPrompt.addEventListener('input', () => {
        if (wt.named) return;
        fillWtName();
        paintNewWorktree();
    });
    dom.newMkdir.addEventListener('click', startMkdir);
    dom.newMkdirGo.addEventListener('click', submitMkdir);
    dom.newMkdirName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitMkdir(); return; }
        // The central ladder swallows Escape over a modal, so nothing further down
        // it is at risk — but this handler is what gives the key an answer at all,
        // and stopPropagation keeps that answer "never mind the folder" rather than
        // whatever the ladder grows next.
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelMkdir(); dom.newMkdir.focus(); }
    });

    // Typing a path does not walk the tree on every keystroke — that is a request per
    // character, and it fights the typist. Enter is the commit, and until it comes the
    // pane says plainly that it is showing somewhere else.
    dom.newCwd.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        setPickerTab('browse');
        browseTo(dom.newCwd.value.trim());
    });
    dom.newCwd.addEventListener('input', () => {
        // The head and the tint follow what is typed, not only what is picked — a
        // path pasted into the box is the same decision as a row pressed in the list.
        paintNewProject();
        if (state.browse.tab === 'browse') dom.newBrowseNote.textContent = browseNote(state.browse);
        // The commands on screen belong to the directory that was in this box when
        // `/` was pressed. Leaving them there while the directory changes underneath
        // is offering a list that will not run.
        if (menuOpen(newC.slash)) updateSlashMenu(newC);
    });
}
