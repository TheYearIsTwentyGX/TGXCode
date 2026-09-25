// The trigger picker in the Start-a-session dialog, which builds a schedule's
// cron expression (or one time) out of controls, the pull-request gate fields
// beside it, and the Start, Save-draft and Schedule buttons that read the dialog.
// Moved out of app.js as it was.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.

import { get, patch, post } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { pad } from '../format.js';
import { state } from '../state.js';
import { draftsVisible, showDrafts, showSched } from '../app.js';
import { commitAttachments } from '../composer/attachments.js';
import { openSessionSoon } from '../transcript/conversation.js';
import { closeNew, newC, newDialogName, newDialogValues, openNew } from './dialog.js';

// ── the trigger picker ──────────────────────────────────────────────────────
//
// One direction only: **the picker composes cron and never parses it.** Reading
// an expression back — which the dialog has to do to open an existing schedule
// on the right row — is the bridge's `cronForm`, arriving on the row as
// `cronForm` and from `/api/schedules/describe` as `form`. That keeps the rule
// docs/api.md states: the process that decides when a schedule runs is the only
// one that gets an opinion about what an expression means.
//
// Composing is safe to do here because it cannot disagree with anything. There
// is no expression to misread — five fields get built out of controls whose
// values are already numbers — and the sentence under the picker is still the
// bridge's answer about the result.

const WHEN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The selected row, or null before the dialog has ever been opened. */
function whenKind() {
    const on = dom.newCronRow.querySelector('input[name="new-when"]:checked');
    return on ? on.value : null;
}

/** The seven day checkboxes, in the order `whenBuild` made them. */
function whenDayBoxes() {
    return [...dom.newWhenDays.querySelectorAll('input')];
}

/**
 * `"14:30"` → `{hour: 14, minute: 30}`, and null for a box nobody filled in.
 *
 * A time input hands back `""` when it is empty or half-typed, which is a real
 * state the caller says out loud rather than defaulting to midnight — a schedule
 * silently set to 00:00 is the kind of thing you find out about at midnight.
 */
function whenClock(input) {
    const m = /^(\d{1,2}):(\d{2})$/.exec((input.value || '').trim());
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
}

/**
 * The picker as `{cron, once}`, or null after saying what is missing.
 *
 * Returns null and toasts rather than throwing — the same bargain
 * `newDialogValues` strikes, and for the same reason: every caller's next line
 * is "then stop".
 *
 * `quiet` is for the live preview, which composes on every keystroke and must
 * not shout about a row somebody is halfway through filling in. One composer
 * with a mute rather than two: the preview and the save have to agree about what
 * the controls mean, and that is exactly the kind of thing that drifts.
 */
function whenValues({ quiet = false } = {}) {
    const say = quiet ? () => {} : toast;
    const kind = whenKind();

    if (kind === 'custom') {
        const cron = dom.newCron.value.trim();
        if (!cron) {
            say('Say when it should run — five cron fields, like 0 2 * * 2-6.', 'warn');
            return null;
        }
        return { cron, once: false };
    }

    if (kind === 'every') {
        const n = Number(dom.newWhenCount.value);
        const hours = dom.newWhenUnit.value === 'hours';
        const max = hours ? 23 : 59;
        if (!Number.isInteger(n) || n < 1 || n > max) {
            say(`How often? A whole number of ${hours ? 'hours' : 'minutes'}, 1 to ${max}.`,
                'warn');
            return null;
        }
        return { cron: hours ? `0 */${n} * * *` : `*/${n} * * * *`, once: false };
    }

    if (kind === 'daily') {
        const t = whenClock(dom.newWhenDailyTime);
        if (!t) { say('Pick a time for it to run.', 'warn'); return null; }
        return { cron: `${t.minute} ${t.hour} * * *`, once: false };
    }

    if (kind === 'weekly') {
        const t = whenClock(dom.newWhenWeeklyTime);
        if (!t) { say('Pick a time for it to run.', 'warn'); return null; }
        const days = whenDayBoxes().filter(b => b.checked).map(b => Number(b.value));
        if (!days.length) {
            say('Tick at least one day, or make it a daily schedule.', 'warn');
            return null;
        }
        return { cron: `${t.minute} ${t.hour} * * ${days.join(',')}`, once: false };
    }

    if (kind === 'monthly') {
        const t = whenClock(dom.newWhenMonthlyTime);
        if (!t) { say('Pick a time for it to run.', 'warn'); return null; }
        return { cron: `${t.minute} ${t.hour} ${Number(dom.newWhenDom.value)} * *`, once: false };
    }

    if (kind === 'once') {
        const date = (dom.newWhenDate.value || '').trim();
        if (!date) { say('Pick the date it should run on.', 'warn'); return null; }
        const t = whenClock(dom.newWhenOnceTime);
        if (!t) { say('Pick a time for it to run.', 'warn'); return null; }
        const [y, mo, d] = date.split('-').map(Number);

        // **The one check the bridge cannot make.** `once` rides on a dated
        // expression, and a dated expression in the past still matches — next
        // year. So `scheduleFields` sees a perfectly good cron and the card would
        // sit there saying the next run is eleven months away. Refused here,
        // where the date somebody actually picked is still in front of us.
        if (new Date(y, mo - 1, d, t.hour, t.minute, 0, 0).getTime() <= Date.now()) {
            say('That moment has already passed — pick a date and time still to come.',
                'warn');
            return null;
        }
        return { cron: `${t.minute} ${t.hour} ${d} ${mo} *`, once: true };
    }

    say('Say when it should run.', 'warn');
    return null;
}

/**
 * Fill the picker in from a schedule, or from nothing.
 *
 * `form` is the bridge's `cronForm`; `cron` is the raw expression, needed for the
 * Custom row and as the fallback for a shape no row can draw.
 *
 * **Every control is written on every open, in both directions** — the rule
 * `openNew`'s docstring states, and it matters more here than anywhere else in
 * this dialog. A picker that left last time's ticked days behind would attach
 * them to the next schedule you opened, and Weekly is exactly the row where you
 * would not notice.
 */
export function setWhen(form, cron, once, { newRow = 'weekly' } = {}) {
    const f = form || {};
    // `null` is "a schedule that does not exist yet", which is *not* the same as
    // `{kind: 'custom'}` — an existing schedule whose expression no row can draw.
    // The first opens on a suggestion, the second on its own raw expression, and
    // conflating them opened every new schedule on an empty cron box.
    const kind = form ? form.kind : 'new';

    // A dated expression is the One time row only when the row said so. Without
    // the flag it is an annual schedule, which no row draws — so it is Custom.
    //
    // `newRow` is which suggestion a *new* schedule opens on, and it is an
    // argument rather than a caller-supplied `cronForm` on purpose: a synthetic
    // `{kind: 'date'}` would reach the date maths below with no month and no day
    // and put `NaN-NaN-NaN` in the box.
    const row = kind === 'new' ? newRow
        : kind === 'date' ? (once ? 'once' : 'custom')
            : (kind === 'minutes' || kind === 'hours' ? 'every' : kind);

    const clock = f.hour === undefined ? '02:00' : `${pad(f.hour)}:${pad(f.minute)}`;

    dom.newCron.value = row === 'custom' ? (cron || '') : '';
    dom.newWhenCount.value = String(kind === 'minutes' || kind === 'hours' ? f.every : 15);
    dom.newWhenUnit.value = kind === 'hours' ? 'hours' : 'minutes';
    dom.newWhenDailyTime.value = clock;
    dom.newWhenWeeklyTime.value = clock;
    dom.newWhenMonthlyTime.value = clock;
    // The One time row's two controls are written together in the block below,
    // which has to decide a date and a time as one moment. This only leaves the
    // row something sane for the case where it is not the one selected.
    dom.newWhenOnceTime.value = '09:00';
    dom.newWhenDom.value = String(kind === 'monthly' ? f.day : 1);

    // Tue–Sat is the default week, which is what the cron box used to open on:
    // "review whatever landed overnight", on the days there was an overnight.
    const days = new Set(kind === 'weekly' ? f.days : [2, 3, 4, 5, 6]);
    for (const box of whenDayBoxes()) box.checked = days.has(Number(box.value));

    if (row === 'once' && kind === 'new') {
        // A suggestion, the way Weekly opens on Tue–Sat at 02:00, because the one
        // row that needs a *date* is the one row that says nothing at all until
        // it has one — a blank box means the preview underneath reads "fill in
        // the row you picked" and the first press of Save is a refusal.
        //
        // The next 09:00 still to come: this morning if it has not gone, else
        // tomorrow. Which also clears whenValues' one local check — a moment
        // already past is refused there, and offering one would be offering a
        // form that cannot be saved as it stands.
        const soon = new Date();
        soon.setHours(9, 0, 0, 0);
        if (soon.getTime() <= Date.now()) soon.setDate(soon.getDate() + 1);
        dom.newWhenOnceTime.value = `${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
        dom.newWhenDate.value =
            `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
    } else if (row === 'once') {
        // A dated expression carries no year, so an existing one-time schedule
        // can only be shown on the next date it matches — which is the date it
        // will actually run, and so the honest thing to put in the box.
        dom.newWhenOnceTime.value = clock;
        const now = new Date();
        const soon = new Date(now.getFullYear(), f.month - 1, f.day, f.hour, f.minute, 0, 0);
        if (soon.getTime() <= Date.now()) soon.setFullYear(now.getFullYear() + 1);
        dom.newWhenDate.value =
            `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
    } else {
        dom.newWhenDate.value = '';
    }

    const pick = document.getElementById(`new-when-${row}`);
    if (pick) pick.checked = true;
}

/** `1` → `"1st"`. The bridge says this too; here it is only ever a label. */
function ordinalDay(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Build the two lists too long to write out, and wire the picker. Called once.
 *
 * The day pills and the 1–31 select are generated because thirty-eight
 * hand-written controls in index.html is thirty-eight chances for a typo in a
 * value nobody would ever look at again.
 */
export function whenBuild() {
    dom.newWhenDays.replaceChildren(...WHEN_DAYS.map((name, i) =>
        el('label', { class: 'when-day' },
            el('input', { type: 'checkbox', value: String(i), 'aria-label': name }),
            el('span', {}, name))));

    dom.newWhenDom.replaceChildren(...Array.from({ length: 31 }, (_, i) =>
        el('option', { value: String(i + 1) }, ordinalDay(i + 1))));

    // Touching a row's arguments selects that row. Without this you could set a
    // time on Weekly, press Save, and have Daily's time be what got stored — every
    // control filled in and only the radio saying which one counted.
    // `renderQuestionDock`'s "Other" box does the same, for the same reason.
    for (const opt of dom.newCronRow.querySelectorAll('.when-opt')) {
        const radio = opt.querySelector('input[type="radio"]');
        for (const arg of opt.querySelectorAll('.when-args input, .when-args select')) {
            arg.addEventListener('input', () => { radio.checked = true; describeCronSoon(); });
        }
        radio.addEventListener('change', () => describeCronSoon());
    }
    // The day ticks live outside `.when-args`, so they are wired separately —
    // and a day is only ever meaningful on Weekly, which is the row they are in.
    for (const box of whenDayBoxes()) {
        box.addEventListener('change', () => {
            document.getElementById('new-when-weekly').checked = true;
            describeCronSoon();
        });
    }
}

/**
 * What the dialog's footer may do while files are held.
 *
 * Save as draft is disabled rather than quietly dropping them. Both buttons are on
 * screen at once in start mode, a draft cannot carry a file, and a Save that
 * discarded a screenshot without saying so is the one outcome here worth refusing
 * outright. Start is unaffected: it is the button that can honour them.
 */
export function paintNewAttach() {
    const held = newC.attach.length;
    // Both of the buttons that would keep this call rather than run it, because
    // neither store carries attachments — see docs/api.md. Saying so on the
    // button is the whole point: the files are bytes in this page and would
    // simply not be there afterwards, with nothing to say they had gone.
    dom.newSave.disabled = held > 0;
    dom.newSched.disabled = held > 0;
    dom.newSave.title = held
        ? 'A draft cannot carry attachments. Start the session, or remove the files.'
        : '';
    dom.newSched.title = held
        ? 'A schedule cannot carry attachments. Start the session, or remove the files.'
        : '';
}

/**
 * Show only the fields the chosen gate needs.
 *
 * A branch gate wants a ref and a PR gate does not — it watches whatever the
 * checkout's origin has open — so a single always-visible ref box would be a
 * field that silently means nothing half the time.
 */
export function paintGateFields() {
    const kind = dom.newGateKind.value;
    dom.newGateRefRow.hidden = kind !== 'git-commits';
    dom.newPrRow.hidden = kind !== 'open-prs';
    dom.newGateNote.textContent = kind === 'open-prs'
        ? 'One review session per open pull request that has not been reviewed at '
            + 'its current commit.'
        : (kind === 'git-commits'
            ? 'One session per run, and only when the ref below has moved.'
            : 'A gated run that finds nothing new starts no session at all.');
}

/**
 * The two extra fields, on top of what every caller of this dialog needs.
 *
 * Separate from `newDialogValues` rather than folded into it, because the shared
 * function is shared with Start and Save-as-draft: a `cron` key riding along on a
 * `POST /api/sessions` body would be silently ignored today and would be a
 * puzzle the first time somebody added a field by that name.
 *
 * The expression is composed from the picker and never parsed here. The bridge's
 * parser is the one that will actually decide when this runs, so a second parser
 * in the page could only ever be a way for the two to disagree. What the page
 * does is ask for the English, which is `describeCronSoon` below.
 */
function schedDialogValues() {
    const body = newDialogValues();
    if (!body) return null;
    body.title = newDialogName();

    const when = whenValues();
    if (!when) return null;
    body.cron = when.cron;
    body.once = when.once;

    const kind = dom.newGateKind.value;
    if (kind === 'open-prs') {
        body.gate = {
            kind: 'open-prs',
            includeDrafts: dom.newPrDrafts.checked,
            post: dom.newPrPost.checked,
        };
    } else if (kind === 'git-commits') {
        const ref = dom.newGateRef.value.trim();
        if (!ref) {
            toast('Name the ref to watch, or choose "every time".', 'warn');
            return null;
        }
        body.gate = { kind: 'git-commits', ref, fetch: true };
    } else {
        // No gate is a real choice rather than an unfinished one.
        body.gate = null;
    }
    return body;
}

/**
 * Show what the expression means, as typed.
 *
 * Asked of the bridge rather than worked out here, for the reason above: the
 * process that will run the schedule is the one that should say when it runs. A
 * `POST` that only wants an opinion would be the wrong verb, so this leans on the
 * validator already in the create route — the dry-run flag exists so this can ask
 * without saving.
 *
 * Debounced because it fires per keystroke, and silent on failure: a half-typed
 * expression is not an error to report, it is an expression that is not finished.
 */
let cronNoteTimer = null;
export function describeCronSoon() {
    clearTimeout(cronNoteTimer);
    cronNoteTimer = setTimeout(async () => {
        // Composed exactly the way a save composes it, so the sentence is about
        // the expression that would actually be stored rather than about the
        // controls' best guess at one.
        const when = whenValues({ quiet: true });
        if (!when) {
            dom.newCronNote.textContent = whenKind() === 'custom'
                ? 'Five fields, local time: minute hour day-of-month month day-of-week.'
                : 'Fill in the row you picked and this will say when it runs.';
            dom.newCronNote.classList.remove('bad');
            return;
        }
        try {
            const q = `cron=${encodeURIComponent(when.cron)}${when.once ? '&once=1' : ''}`;
            const r = await get(`/api/schedules/describe?${q}`);
            dom.newCronNote.textContent = r.next
                ? `${r.text} — next ${new Date(r.next).toLocaleString()}`
                : r.text;
            dom.newCronNote.classList.remove('bad');
        } catch (err) {
            dom.newCronNote.textContent = err.message;
            dom.newCronNote.classList.add('bad');
        }
    }, 250);
}

/**
 * Save the schedule.
 *
 * `drSave` for the other store, and a PATCH when the dialog was opened on an
 * existing row so editing one twice does not leave two.
 */
export async function schedSave() {
    const body = schedDialogValues();
    if (!body) return;

    const editing = state.sched.editing;
    // The bridge is what consumes the draft, in one call, after the row is
    // written — see POST /api/schedules. Doing it here as a second call would
    // mean this window deciding what happens when the delete fails and the
    // Android client deciding it again, which is the argument
    // POST /api/drafts/:id/start already settled. Only on a create: converting a
    // draft happens once, so an edit never carries it.
    if (!editing && state.sched.fromDraft) body.fromDraft = state.sched.fromDraft;

    const label = dom.newSchedSave.textContent;
    dom.newSchedSave.disabled = true;
    dom.newSchedSave.textContent = 'Saving';
    try {
        if (editing) await patch(`/api/schedules/${editing}`, body);
        else await post('/api/schedules', body);
        closeNew();
        toast(editing ? 'Schedule saved.' : 'Scheduled.', 'ok');
        // Straight to the panel after making a new one, so the thing you just
        // set up is in front of you with its next run on it — the one fact you
        // want to check and cannot see from the dialog.
        if (!editing) showSched(true);
    } catch (err) {
        toast(`Could not save the schedule: ${err.message}`, 'error');
        dom.newSchedSave.textContent = label;
    } finally {
        dom.newSchedSave.disabled = false;
    }
}

/**
 * Hand what is in the dialog to the clock instead.
 *
 * Not a fourth form. A schedule is the same create call a draft is, plus a
 * trigger — so this reopens *this* dialog in schedule mode with the fields
 * carried across, and the two extra rows appear underneath. `openNew` is asked
 * for it rather than the dialog being half-rewritten in place, so there is one
 * path in and no second state for it to drift into.
 *
 * It reads the boxes rather than the stored draft, so edits you have not saved
 * come across too — which is the behaviour you want from a button sitting beside
 * Save changes.
 *
 * **Three presets, and they are presets rather than inheritance.** One time,
 * because a draft is a thing you meant to do once and the clock is only standing
 * in for the Start you would have pressed. `dontAsk`, because a session that
 * stops at the first question at 2 AM has wasted the night — this overrides
 * whatever the draft had, deliberately, since the draft's mode was chosen for a
 * run you would be watching. And 09:00 tomorrow, so the row is answerable rather
 * than blank. All three are still controls; none of them is a decision taken
 * away from you.
 */
export function drToSchedule() {
    // The same validation Start and Save-as-draft get, and for the same reason:
    // a schedule you cannot run is worse than a refused save, because nobody is
    // there to read the failure.
    const body = newDialogValues();
    if (!body) return;

    openNew({
        schedule: true,
        seed: {
            cwd: body.cwd,
            prompt: body.prompt,
            title: newDialogName(),
            model: body.model,
            test: body.test,
            permissionMode: 'dontAsk',
            // Null from a plain Start-a-session dialog, where there is nothing to
            // consume. The save is what acts on it; see schedSave.
            fromDraft: state.drafts.editing,
        },
    });
}

/**
 * Keep it instead of running it.
 *
 * The same body Start would have sent, to the drafts route rather than the
 * sessions one — which is the whole idea, and why this is a button on that dialog
 * rather than a form of its own. A PATCH when the dialog was opened on an
 * existing draft, so editing one twice does not leave two.
 *
 * The label is not restored on success: `closeNew` has already hidden the dialog,
 * and the next `openNew` sets both the title and this button for whichever of the
 * two things it is about to be.
 */
export async function drSave() {
    const body = newDialogValues();
    if (!body) return;
    body.title = newDialogName();

    const editing = state.drafts.editing;
    const label = dom.newSave.textContent;
    dom.newSave.disabled = true;
    dom.newSave.textContent = 'Saving';
    try {
        if (editing) await patch(`/api/drafts/${editing}`, body);
        else await post('/api/drafts', body);
        closeNew();
        toast(editing ? 'Draft saved.' : 'Saved as a draft.', 'ok');
    } catch (err) {
        toast(`Could not save the draft: ${err.message}`, 'error');
        dom.newSave.textContent = label;
    } finally {
        dom.newSave.disabled = false;
    }
}

/**
 * Run it.
 *
 * **If the dialog was opened on a draft, this consumes it** — the same press the
 * card's Start button is, so it has to leave the board the same way. The id goes
 * to the bridge as `fromDraft` and the delete happens there, after the session
 * spawns: the reasoning `drStart` and `schedSave` both give, which is that as two
 * calls from here, every client has to decide separately what a failed delete
 * means once a process is already running.
 *
 * What the dialog holds is what starts, and it is *not* written back to the draft
 * first. Editing the prompt and pressing Start runs the edit and drops the draft
 * unedited — Start is a decision not to keep it. Save changes is next to it for
 * the other answer.
 */
export async function startNew() {
    const body = newDialogValues();
    if (!body) return;
    // Read before the post, because `closeNew` clears it and the panel close
    // below happens after. Null on every other way in: `openNew` writes this on
    // each open and `closeNew` clears it, so Ctrl+N and a Recent-directory open
    // carry nothing stale from the last draft you looked at. A snippet's
    // auto-submit *inside* an open draft does consume it, which is right — that
    // path presses this button.
    //
    // Set here rather than in `newDialogValues`, whose body is also `drSave`'s
    // and `schedSave`'s: a draft PATCHed with a key naming itself would be noise
    // on a route that ignores it.
    const fromDraft = state.drafts.editing;
    if (fromDraft) body.fromDraft = fromDraft;

    dom.newGo.disabled = true;
    dom.newGo.textContent = 'Starting';
    try {
        // Now, and not when they were pasted: this is the first moment the working
        // directory has stopped being editable, and it is what decides where they go.
        // A failure here stops the whole thing — see commitAttachments.
        if (newC.attach.length) {
            const files = await commitAttachments(newC);
            if (!files) return;
            body.attachments = files;
        }
        const r = await post('/api/sessions', body);
        closeNew();
        // Only when a draft was consumed, and the same move `drStart` makes: the
        // board has one fewer card and we are about to open a session behind it,
        // so leaving it up would put a list over the thing it just started. A
        // plain Ctrl+N from an open board is not that, and leaves it alone.
        if (fromDraft && draftsVisible()) showDrafts(false);
        toast('Session started.', 'ok');
        // The transcript only exists once `claude` writes its first line.
        openSessionSoon(r.sessionId);
    } catch (err) {
        toast(`Could not start the session: ${err.message}`, 'error');
    } finally {
        dom.newGo.disabled = false;
        dom.newGo.textContent = 'Start';
    }
}
