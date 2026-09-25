// What this session changed — the drawer of edited files and the working tree —
// and the diff viewer that opens one of them in full.
//
// The diff viewer's renderer is web/vendor/diff2html.js, a UMD bundle loaded
// with a classic <script> in index.html and read as `window.Diff2Html` at call
// time. Do not turn that into an import: a UMD bundle imported as a module
// throws before the page runs a line (see CLAUDE.md, *Vendor a bundle*).
//
// This imports app.js and sibling modules here, which import it back. That is
// safe only because nothing in this file reads an imported binding while the
// module is evaluating — every use is inside a function called later. Keep it
// that way: a top-level `const X = someImport(...)` runs before app.js's body
// and throws in the temporal dead zone, and only loading the page shows it.

import { get } from '../api.js';
import { openPath } from '../app.js';
import { dom, el, toast } from '../dom.js';
import { ago } from '../format.js';
import { state } from '../state.js';
import { statusWord } from '../boards/dashboard.js';
import { closeMenus, live } from '../composer/slash.js';
import { closeContextMenu, fileTarget, openContextMenu, openFileMenu } from './context-menu.js';
import { renderHeaderActions } from './conversation.js';
import { slidePane, syncPaneInsets } from './layout.js';
import { openAgent } from './subagents.js';
import { jumpToTurn } from './turn-rail.js';

// ── what this session changed ────────────────────────────────────────────
//
// Two lists in one drawer, and the whole design is in why they are two.
//
// *Changed by this session* comes out of the transcript, so it is about the
// conversation: it holds files edited and since committed, files edited in a
// directory that has since been removed, and files a subagent edited on the
// session's behalf. *Working tree* comes from git, so it is about the directory:
// it holds whatever anybody else changed, and it drops what this session changed
// and then put back. Reconciling them would mean choosing which of those to lie
// about, so they are drawn as they are and the disagreement is the information.
//
// It lives beside the transcript rather than over it because a row is a way back
// into the conversation — the jump is on the right-click menu now, and on the
// diff dialog a click opens — and a panel you have to close first turns reaching
// it into two actions and something to remember. Clicking a row opens the diff,
// which is a dialog over the transcript; that is a deliberate exception rather
// than the end of the rule, because reading a diff is a thing you stop to do.

// Long enough that opening the drawer twice in a row does not shell out to git
// twice, short enough that it is never obviously wrong. A turn ending refetches
// regardless — see applyRunner — which is what actually keeps it current.
const CHANGES_STALE_MS = 20_000;

/** Put the drawer in the layout, or take it out. Remembered across sessions. */
export function showChanges(on) {
    state.changes.on = on;
    localStorage.setItem('changesOn', on ? '1' : '0');
    // Asking for it from the header means wanting to see it, not wanting a
    // 34px strip: an open drawer is what the button promises.
    if (on) collapseChanges(false, { render: false });
    renderChanges();
    renderHeaderActions();
    if (on) loadChangesIfStale();
}

/** Collapse it to its strip, or bring it back. */
export function collapseChanges(shut, { render = true } = {}) {
    state.changes.shut = shut;
    localStorage.setItem('changesShut', shut ? '1' : '0');
    if (!render) return;
    renderChanges();
    syncPaneInsets();   // this frame, so the composer starts moving with it
    // Focus follows whatever replaced the thing that was clicked.
    (shut ? dom.changesStrip : dom.changesCollapse).focus();
    if (!shut) loadChangesIfStale();
}

export function loadChangesIfStale() {
    const s = state.current;
    if (!s || !state.changes.on || state.changes.shut) return;
    const fresh = state.changes.sessionId === s.sessionId
        && Date.now() - state.changes.at < CHANGES_STALE_MS;
    if (!fresh) loadChanges();
}

/** Forget what is on screen — the conversation it was about has changed. */
export function resetChanges() {
    // The diff belongs to a file in the session being left, and its Jump to the
    // edit would resolve against the new session's tool map.
    closeDiff();
    state.changes.data = null;
    state.changes.scratch = null;
    state.changes.sessionId = null;
    state.changes.at = 0;
    state.changes.error = null;
}

export async function loadChanges({ refresh = false } = {}) {
    const s = state.current;
    if (!s || state.changes.loading) return;
    const id = s.sessionId;

    state.changes.loading = true;
    state.changes.error = null;
    renderChanges();
    try {
        // The scratchpad is asked alongside and allowed to fail on its own: it is
        // the third section, and a bridge that predates the route should still
        // draw the other two.
        const [d, scratch] = await Promise.all([
            get(`/api/sessions/${id}/changes${refresh ? '?refresh=1' : ''}`),
            get(`/api/sessions/${id}/scratchpad`).catch(() => null),
        ]);
        // Another conversation was opened while this was in flight; that one owns
        // the drawer now.
        if (!state.current || state.current.sessionId !== id) return;
        state.changes.data = d;
        state.changes.scratch = scratch;
        state.changes.sessionId = id;
        state.changes.at = Date.now();
        // A turn ending refetches this, and the dialog must not redraw under
        // somebody reading it. Say the tree moved and let them decide.
        if (state.diff.open) {
            state.diff.stale = true;
            paintDiff();
        }
    } catch (err) {
        state.changes.error = err.message;
    } finally {
        state.changes.loading = false;
        renderChanges();
    }
}

export function renderChanges() {
    // replaceChildren below destroys whichever row a context menu is anchored to,
    // and a menu left floating over a list that has moved under it is worse than
    // one that closes.
    closeContextMenu({ focus: false });

    // No pending hold here: whether this drawer is up is a window property, so
    // it does not change when the conversation does and there is nothing to wait
    // for. It slides for the same reason the other two do — the header button.
    const present = !!state.changes.on && !!state.current;
    slidePane(dom.changes, present);
    if (!present) return;

    const d = state.changes.data;
    const edits = (d && d.edits) || [];
    // The count is the transcript's, not the tree's: the drawer is about what
    // this session did, and the tree is the second opinion beside it.
    const label = d ? String(edits.length) : (state.changes.error ? '!' : '…');
    dom.changesCount.textContent = label;
    dom.changesStripCount.textContent = label;

    dom.changesStrip.hidden = !state.changes.shut;
    dom.changesOpen.hidden = state.changes.shut;
    dom.changes.classList.toggle('shut', state.changes.shut);
    dom.changesRefresh.disabled = state.changes.loading;
    if (state.changes.shut) return;   // nothing behind the strip needs building

    if (state.changes.error) {
        dom.changesBody.replaceChildren(
            el('p', { class: 'ch-note bad' }, state.changes.error),
        );
        return;
    }
    if (!d) {
        dom.changesBody.replaceChildren(el('p', { class: 'ch-note' }, 'Looking…'));
        return;
    }

    dom.changesBody.replaceChildren(editsSection(d), treeSection(d.git),
        scratchSection(state.changes.scratch));
}

/** The transcript's answer. */
function editsSection(d) {
    const edits = d.edits || [];
    const fromAgents = edits.filter(f => f.agent).length;

    const rows = edits.length
        ? edits.map(editRow)
        : [el('p', { class: 'ch-note' }, d.agents && d.agents.total
            ? 'Nothing in this conversation or its subagents changed a file.'
            : 'Nothing in this conversation changed a file.')];

    return el('section', { class: 'ch-sec' },
        el('div', { class: 'ch-head' },
            el('span', { class: 'ch-title' }, 'Changed by this session'),
            edits.length ? plusMinus(d) : null,
        ),
        // Only worth a line when some of the work was not done in this
        // conversation at all — which is exactly when the count looks wrong.
        fromAgents
            ? el('p', { class: 'ch-note' },
                `${fromAgents} of these ${fromAgents === 1 ? 'was' : 'were'} edited by a subagent.`)
            : null,
        el('ul', { class: 'ch-list' }, rows),
    );
}

/**
 * One file, and where clicking it goes.
 *
 * Clicking opens the diff, and the jump this row used to be has moved onto the
 * right-click menu and the dialog's own button. The trade is worth naming: the
 * jump was one click and is now two, and seeing what actually changed went from
 * several — find the turn, unfold the tool card, scroll — to one. The more
 * common question is now the closer one, and neither answer was lost.
 *
 * Everything is resolved at click rather than at render, which is unchanged and
 * still load-bearing: the transcript fills in as it loads and grows while a turn
 * runs, so a row built a second too early would be dead for the rest of its life.
 */
function editRow(f) {
    const agent = f.agent;

    const tip = [f.path, `${f.edits} ${f.edits === 1 ? 'edit' : 'edits'}`,
        agent && `by a ${agent.agentType || 'subagent'}${agent.description ? `: ${agent.description}` : ''}`,
        f.lastTs && `last ${ago(f.lastTs)} ago`].filter(Boolean).join('\n');

    return el('li', {},
        el('button', {
            class: 'ch-row', type: 'button', title: tip,
            onclick: () => openDiff(fileTarget(f, 'edit'), 'edit'),
            oncontextmenu: (e) => openFileMenu(e, f, 'edit'),
        },
            filePath(f.relPath),
            plusMinus(f),
            // One word, not the agent's type: the types run to `general-purpose`
            // and the column would then be wider than the paths. Which agent it
            // was is in the tooltip, where there is room for the description too.
            el('span', { class: 'ch-meta' }, agent ? 'agent' : `${f.edits}×`),
        ));
}

/** The working tree's answer. */
function treeSection(g) {
    const head = (...bits) => el('div', { class: 'ch-head' },
        el('span', { class: 'ch-title' }, 'Working tree'), ...bits);

    if (!g || !g.ok) {
        return el('section', { class: 'ch-sec' }, head(),
            el('p', { class: 'ch-note' }, treeReason(g)));
    }

    const files = g.sample || [];
    const branch = [
        g.branch || (g.detached ? 'detached HEAD' : null),
        g.ahead ? `${g.ahead} unpushed` : null,
        g.behind ? `${g.behind} behind` : null,
    ].filter(Boolean).join(' · ');

    return el('section', { class: 'ch-sec' },
        head(g.files ? el('span', { class: 'ch-tally' }, `${g.files} uncommitted`) : null),
        branch ? el('p', { class: 'ch-branch' }, branch) : null,
        files.length
            ? el('ul', { class: 'ch-list' }, files.map(treeFileRow),
                g.truncated ? el('li', { class: 'ch-note' }, `and ${g.truncated} more`) : null)
            : el('p', { class: 'ch-note' }, 'Nothing uncommitted.'),
    );
}

/**
 * One working-tree file.
 *
 * These used to be inert — a report rather than a way in — and are not any more,
 * because this is where the real diff lives: an edits row can only ever offer
 * what the conversation recorded, and this one is the tree itself.
 *
 * Two kinds stay flat, and `flat` now means "there is nothing behind this one"
 * rather than "this list is a report": an untracked *directory*, which git will
 * not diff and which is not a file, and a binary, which has no diff to render.
 */
function treeFileRow(f) {
    const inert = f.binary || /\/$/.test(f.path || '');
    const body = [
        el('span', { class: 'fstat', 'data-s': f.status }, statusWord(f.status)),
        filePath(f.path),
        // Untracked files are not in `git diff` and so have no counts. The
        // status word already said "new", which is the honest answer.
        f.added == null ? null : plusMinus(f),
    ];

    if (inert) return el('li', {}, el('div', { class: 'ch-row flat', title: f.path }, ...body));

    return el('li', {},
        el('button', {
            class: 'ch-row', type: 'button', title: f.path,
            onclick: () => openDiff(fileTarget(f, 'tree'), 'tree'),
            oncontextmenu: (e) => openFileMenu(e, f, 'tree'),
        }, ...body));
}

function treeReason(g) {
    const reason = (g && g.reason) || 'status-failed';
    if (reason === 'no-directory') return 'The directory this session worked in is gone.';
    if (reason === 'not-a-repo') return 'Not a git repository.';
    if (reason === 'left-behind') {
        return 'This directory is not a checkout of its own — a worktree that was removed, '
            + 'most likely.';
    }
    return `git status could not run${g && g.error ? `: ${g.error}` : ''}.`;
}

/**
 * The session's scratchpad — see bridge/scratchpad.js for where it lives.
 *
 * Its own section rather than rows folded into the edits list, because most of
 * what is in there was never an `Edit`: a probe written by `Bash` with a heredoc
 * is the ordinary case, and the transcript cannot see it. A session that crossed
 * into worktrees has one scratchpad per worktree, so the rows are grouped under
 * which one only when there is more than one to tell apart.
 */
function scratchSection(s) {
    const head = el('div', { class: 'ch-head' },
        el('span', { class: 'ch-title' }, 'Scratchpad'),
        s && s.files.length ? el('span', { class: 'ch-tally' }, String(s.files.length)) : null);
    if (!s) return el('section', { class: 'ch-sec' }, head,
        el('p', { class: 'ch-note' }, 'The bridge could not list the scratchpad.'));
    if (!s.files.length) return el('section', { class: 'ch-sec' }, head,
        el('p', { class: 'ch-note' },
            'No scratchpad files — this session never wrote one, or a restart cleared /tmp.'));

    const byKey = new Map(s.dirs.map(d => [d.key, d]));
    const rows = [];
    for (const d of s.dirs) {
        const mine = s.files.filter(f => f.dir === d.key);
        if (!mine.length) continue;
        if (s.dirs.length > 1) {
            rows.push(el('li', { class: 'ch-group', title: d.path }, d.where || 'main checkout'));
        }
        rows.push(...mine.map(f => scratchRow(f, byKey.get(f.dir))));
    }
    return el('section', { class: 'ch-sec' }, head,
        el('ul', { class: 'ch-list' }, rows,
            s.truncated ? el('li', { class: 'ch-note' }, 'and more, not listed') : null));
}

function scratchRow(f, dir) {
    const absPath = `${dir.path}/${f.path}`;
    return el('li', {},
        el('button', {
            class: 'ch-row', type: 'button',
            title: `${absPath}\n${size(f.size)} · ${new Date(f.mtimeMs).toLocaleString()}`,
            onclick: () => openScratch({ key: f.dir, path: f.path, absPath, size: f.size }),
            oncontextmenu: (e) => openContextMenu(e, [
                { label: 'Open', onClick: () => openPath(absPath) },
                { label: 'Show in folder', onClick: () => openPath(absPath, { reveal: true }) },
            ]),
        },
            filePath(f.path),
            el('span', { class: 'ch-meta' }, size(f.size)),
            el('span', { class: 'ch-meta' }, ago(f.mtimeMs)),
        ));
}

function size(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A path as two pieces, so the drawer can drop the directory and keep the file.
 *
 * A trailing slash — an untracked directory — belongs with the part that gets
 * clipped, not treated as an empty filename.
 */
function filePath(p) {
    const text = String(p || '');
    const cut = text.replace(/\/$/, '').lastIndexOf('/');
    return el('span', { class: 'fpath' },
        cut === -1 ? null : el('span', { class: 'fdir' }, text.slice(0, cut + 1)),
        el('span', { class: 'fbase' }, cut === -1 ? text : text.slice(cut + 1)));
}

/** `+84 −12`, or the word for a file git will not count. */
function plusMinus(f) {
    const box = el('span', { class: 'ch-nums' });
    if (f.binary) return el('span', { class: 'ch-nums ch-meta' }, 'binary');
    if (f.added) box.append(el('span', { class: 'ch-add' }, `+${f.added}`));
    if (f.deleted) box.append(el('span', { class: 'ch-del' }, `−${f.deleted}`));
    // An edit that added and removed nothing is a file written with the contents
    // it already had. Rare, and worth not drawing as a blank column.
    if (!box.childNodes.length) box.append(el('span', { class: 'ch-meta' }, '±0'));
    return box;
}

// ── one file, in full ──────────────────────────────────────────────────────
//
// The drawer says which files changed; this says what changed in them. Rendered
// by diff2html, vendored in web/vendor/ and reached as a global — see the script
// tag in index.html for why it is not an import.
//
// There are two possible answers and the dialog always names the one it is
// showing, because they disagree for the reasons the drawer itself exists for.
// The working tree is asked first: it is cumulative, and it includes whatever a
// `Bash sed -i` did, which the transcript cannot see. The transcript is the
// fallback, and the only answer left once a file has been committed or its
// directory has gone.

/** Tool names whose results carry a patch worth showing. Mirrors bridge/changes.js. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Past this many characters, side by side plus word matching is tens of
// thousands of DOM nodes and a tab that stops responding. Measured on a minified
// bundle, which is the realistic worst case in this repo.
const DIFF_HEAVY = 400_000;

/**
 * Open the viewer on one file.
 *
 * `row` is scalars copied out of a drawer row, never the row: see `state.diff`.
 */
function openDiff(row, kind) {
    // A composer popover left open under a modal is debris. Same call openNew makes.
    closeMenus(live);
    closeContextMenu({ focus: false });

    const d = state.diff;
    d.open = true;
    d.sessionId = state.current ? state.current.sessionId : null;
    d.kind = kind;
    d.path = row.path;
    d.absPath = row.absPath || null;
    d.status = row.status || null;
    d.toolId = row.toolId || null;
    d.agent = row.agent || null;
    d.scratchKey = row.key || null;
    d.mode = 'worktree';
    d.source = null;
    d.text = null;
    d.meta = { added: row.added, deleted: row.deleted, binary: row.binary };
    d.error = null;
    d.stale = false;

    if (!d.sized) {
        d.split = window.innerWidth >= 1100;
        d.sized = true;
    }

    dom.diffScrim.hidden = false;
    paintDiff();
    dom.diffBody.focus();
    fetchDiff();
}

export function closeDiff() {
    const d = state.diff;
    if (!d.open) return;
    d.open = false;
    // Any answer still in flight is now for a dialog nobody is looking at.
    d.req++;
    d.text = null;
    dom.diffScrim.hidden = true;
    // A five-thousand-line side-by-side diff is around twenty thousand nodes.
    // Leaving them attached to a hidden dialog costs that until the next open.
    dom.diffBody.replaceChildren();
    // Back to the drawer, deliberately not to the row: renderChanges may well
    // have replaced it while this was open.
    if (state.changes.on && !state.changes.shut) dom.changesBody.focus({ preventScroll: true });
}

export async function fetchDiff() {
    const d = state.diff;
    if (d.kind === 'scratch') return fetchScratch();
    const seq = ++d.req;
    d.loading = true;
    d.error = null;
    paintDiff();

    const q = new URLSearchParams({ path: d.path, mode: d.mode });
    let answer = null;
    try {
        answer = await get(`/api/sessions/${d.sessionId}/diff?${q}`);
    } catch (err) {
        // Dropped rather than drawn if it is no longer the question on screen.
        if (d.req !== seq || !d.open) return;
        d.loading = false;
        // The bridge could not answer, but the conversation may still be able to.
        // This is not a fringe case: a session that ran outside a repository has
        // absolute paths in `edits`, and asking about one earns the roots refusal
        // — so without this the drawer offers a row whose only answer is an error
        // message about allowed roots, for a file it is still holding the patches
        // for. Falling back for *any* failure rather than only that one, because
        // an answer beats a sentence about why there isn't one.
        const fallback = transcriptDiff(d.absPath || d.path);
        if (fallback) {
            d.source = 'transcript';
            d.text = fallback.text;
            d.meta = { ...(d.meta || {}), edits: fallback.edits };
        } else {
            d.error = err.message;
        }
        return paintDiff();
    }
    if (d.req !== seq || !d.open) return;
    if (!state.current || state.current.sessionId !== d.sessionId) return;

    d.loading = false;
    d.root = answer.root || null;
    if (answer.status) d.status = answer.status;
    d.meta = {
        added: answer.added, deleted: answer.deleted, binary: answer.binary,
        truncated: answer.truncated, reason: answer.reason, error: answer.error,
    };

    if (answer.ok && answer.diff) {
        d.source = 'worktree';
        d.text = answer.diff;
        return paintDiff();
    }

    // Nothing in the tree — committed since, gone, or never in a repository at
    // all. The conversation may still remember what it did.
    const fromTalk = transcriptDiff(d.absPath || answer.absPath || d.path);
    if (fromTalk) {
        d.source = 'transcript';
        d.text = fromTalk.text;
        d.meta = { ...d.meta, edits: fromTalk.edits };
    } else {
        d.source = answer.ok ? 'worktree' : null;
        d.text = '';
    }
    paintDiff();
}

// ── a scratchpad file ──────────────────────────────────────────────────────
//
// The same dialog, showing a file rather than a change to one. Not a second
// viewer: the content is drawn as one whole-file addition — the shape
// transcriptDiff already uses for a Write that created a file — so it gets
// diff2html's line numbers and wrapping for nothing, and `.file-view` in
// viewers.css takes the green and the `+` back off. The controls that only mean
// something for a diff are hidden while it is up.

function openScratch(f) {
    openDiff({ path: f.path, absPath: f.absPath, key: f.key }, 'scratch');
}

async function fetchScratch() {
    const d = state.diff;
    const seq = ++d.req;
    d.loading = true;
    d.error = null;
    paintDiff();

    const q = new URLSearchParams({ dir: d.scratchKey, path: d.path });
    let answer;
    try {
        answer = await get(`/api/sessions/${d.sessionId}/scratchpad/file?${q}`);
    } catch (err) {
        if (d.req !== seq || !d.open) return;
        d.loading = false;
        d.error = err.message;
        return paintDiff();
    }
    if (d.req !== seq || !d.open) return;

    d.loading = false;
    d.source = 'scratch';
    d.meta = { binary: !!answer.binary, reason: answer.ok ? null : answer.reason,
        fileTruncated: !!answer.truncated };
    d.text = answer.ok && !answer.binary ? answer.text : '';
    paintDiff();
}

/** A whole file as one addition, for diff2html to draw. */
function wholeFile(rel, text) {
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return [`diff --git a/${rel} b/${rel}`, 'new file mode 100644', '--- /dev/null', `+++ b/${rel}`,
        `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join('\n') + '\n';
}

/**
 * The conversation's answer for one file: every edit it recorded, in order.
 *
 * Built here rather than sent by the bridge because the data is already on this
 * page — `/changes` carries only the *first* tool id, and widening it would mean
 * the bridge re-parsing a transcript the client has open.
 *
 * One `diff --git` block per edit rather than one concatenated block, which
 * matters more than it looks: consecutive edits number their hunks against
 * different versions of the file, so joining them produces line numbers that go
 * backwards and are wrong in both directions. Separate blocks are honest, and
 * diff2html's file list then indexes them.
 */
function transcriptDiff(absPath) {
    if (!absPath) return null;
    const rel = state.diff.root && absPath.startsWith(state.diff.root + '/')
        ? absPath.slice(state.diff.root.length + 1)
        : absPath;

    const blocks = [];
    for (const { ev } of state.tools.values()) {
        if (!ev || ev.kind !== 'tool' || !EDIT_TOOLS.has(ev.name)) continue;
        const r = ev.result || {};
        const input = ev.input || {};
        const target = r.filePath || input.file_path || input.notebook_path;
        if (target !== absPath) continue;

        const head = [`diff --git a/${rel} b/${rel}`];
        if (Array.isArray(r.patch) && r.patch.length) {
            head.push(`--- a/${rel}`, `+++ b/${rel}`);
            for (const hunk of r.patch) {
                head.push(`@@ -${hunk.oldStart},${hunk.oldLines} `
                    + `+${hunk.newStart},${hunk.newLines} @@`);
                for (const line of hunk.lines || []) head.push(line || ' ');
            }
            blocks.push(head.join('\n'));
            continue;
        }

        // A Write that *created* a file records `patch: []` — there was nothing to
        // diff it against — and puts the whole file in `input.content`. Rendering
        // that as one addition is truthful, because the content is the file as of
        // that call, and it is the same fallback bridge/changes.js takes to count
        // those lines. Without it the commonest case of all, a file this session
        // created outside a repository, has no answer anywhere.
        //
        // An Edit or MultiEdit with no patch gets no such treatment: its inputs are
        // strings with no line numbers attached, and a hunk header invented for
        // them would be a confident lie.
        if (ev.name !== 'Write' || typeof input.content !== 'string') continue;
        const lines = input.content.split('\n');
        // A trailing newline splits to a final empty string that is not a line.
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        head.push('new file mode 100644', '--- /dev/null', `+++ b/${rel}`,
            `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`));
        blocks.push(head.join('\n'));
    }
    if (!blocks.length) return null;
    return { text: `${blocks.join('\n')}\n`, edits: blocks.length };
}

function diffConfig() {
    const d = state.diff;
    const heavy = (d.text || '').length > DIFF_HEAVY;
    // Matches the media query in web/css/viewers.css that hides the layout control: below
    // that width there is no room for two panes, so a remembered preference must
    // not be able to strand somebody in two unreadable columns.
    const roomForTwo = window.innerWidth > 900;
    return {
        outputFormat: d.split && !heavy && roomForTwo && d.kind !== 'scratch'
            ? 'side-by-side' : 'line-by-line',
        // Only once there is more than one block to index. The transcript's
        // answer is one block per edit and they all name the same file, so for a
        // single edit the list is the filename a third time.
        drawFileList: d.source === 'transcript' && !!(d.meta && d.meta.edits > 1),
        matching: d.words && !heavy && d.kind !== 'scratch' ? 'words' : 'none',
        matchWordsThreshold: 0.25,
        diffStyle: 'word',
        colorScheme: 'dark',
        renderNothingWhenEmpty: true,
        // Down from the default 10000. A minified bundle is one 400KB line, and
        // word-matching against it locks the tab for as long as it takes.
        maxLineLengthHighlight: 2000,
    };
}

function paintDiff() {
    const d = state.diff;
    if (!d.open) return;

    dom.diffTitle.replaceChildren(filePath(d.path));
    dom.diffTitle.title = d.absPath || d.path;
    dom.diffStat.replaceChildren(...[
        d.status ? el('span', { class: 'fstat', 'data-s': d.status }, statusWord(d.status)) : null,
        d.meta && (d.meta.added || d.meta.deleted || d.meta.binary) ? plusMinus(d.meta) : null,
    ].filter(Boolean));

    dom.diffUnified.setAttribute('aria-pressed', String(!d.split));
    dom.diffSplit.setAttribute('aria-pressed', String(d.split));
    dom.diffWords.checked = d.words;
    dom.diffWrap.checked = d.wrap;
    dom.diffBody.classList.toggle('wrap', d.wrap);
    // diff2html names the file in a header above every block. For the tree's
    // answer that is one block and the name is already in the dialog title, so
    // the header is the same string twice. The transcript's answer is one block
    // per edit, where the header is what separates them, so it stays.
    dom.diffBody.classList.toggle('one-file', d.source !== 'transcript');
    const file = d.kind === 'scratch';
    dom.diffBody.classList.toggle('file-view', file);
    dom.diffUnified.parentElement.hidden = file;
    dom.diffWords.parentElement.hidden = file;
    dom.diffOpen.hidden = !file;
    dom.diffCopy.textContent = file ? 'Copy' : 'Copy diff';

    // Only for a file that is staged and modified, where the three answers are
    // genuinely three. Anywhere else they are three names for one.
    const bothSides = !!d.status && d.status[0] !== '.' && d.status[1] !== '.' && d.status !== '??';
    dom.diffSource.hidden = !bothSides || file;
    dom.diffSource.value = d.mode;

    dom.diffJump.hidden = !(d.toolId || d.agent);
    dom.diffCopy.disabled = !d.text;
    dom.diffReload.classList.toggle('accent', d.stale);
    dom.diffNote.textContent = diffNote();

    if (d.loading) {
        return dom.diffBody.replaceChildren(el('p', { class: 'ch-note' },
            file ? 'Reading…' : 'Asking git…'));
    }
    if (d.error) {
        return dom.diffBody.replaceChildren(el('p', { class: 'ch-note bad' }, d.error));
    }
    if (!d.text) {
        return dom.diffBody.replaceChildren(el('p', { class: 'ch-note' }, diffEmptyReason()));
    }

    const d2h = window.Diff2Html;
    if (!d2h) {
        return dom.diffBody.replaceChildren(el('p', { class: 'ch-note bad' },
            'The diff renderer did not load.'));
    }
    // diff2html escapes the content it is given, the same guarantee renderMarkdown
    // and el()'s `html` rely on. Its word-level <ins>/<del> markup is where an
    // escaping bug would land, so it is worth knowing that is what this trusts.
    dom.diffBody.innerHTML = d2h.html(file ? wholeFile(d.path, d.text) : d.text, diffConfig());
    syncSideScroll(dom.diffBody);
}

/** The sentence under the controls: which answer this is, and what is missing from it. */
function diffNote() {
    const d = state.diff;
    if (d.loading || d.error) return '';
    const bits = [];
    if (d.source === 'transcript') {
        const n = d.meta && d.meta.edits;
        bits.push(n ? `From the conversation — ${n} ${n === 1 ? 'edit' : 'edits'}, in order.`
            : 'From the conversation.');
    }
    if (d.meta && d.meta.fileTruncated) bits.push('Showing the first 1 MB of a larger file.');
    if (d.meta && d.meta.truncated) {
        bits.push(`Showing the first ${Math.round(d.meta.truncated / 1024) > 0
            ? '2 MB' : 'part'} of a larger diff.`);
    }
    if ((d.text || '').length > DIFF_HEAVY && d.kind !== 'scratch') {
        bits.push('Large diff — shown unified, without word matching.');
    }
    if (d.stale) bits.push('The tree has changed since this was read.');
    return bits.join(' ');
}

function diffEmptyReason() {
    const d = state.diff;
    const meta = d.meta || {};
    if (d.kind === 'scratch') {
        if (meta.binary) return 'A binary file — use Open to see it.';
        if (meta.reason === 'no-such-file') return 'That file is no longer in the scratchpad.';
        if (meta.reason) return `Could not read that file (${meta.reason}).`;
        return 'That file is empty.';
    }
    if (meta.binary) return 'git calls this a binary file.';
    if (meta.reason === 'no-such-file') return 'That file is no longer on disk.';
    if (meta.reason === 'outside-repo') {
        return 'That file is outside the repository this session worked in.';
    }
    if (meta.reason) return treeReason(meta);
    if (d.kind === 'edit') {
        return 'Nothing uncommitted in this file, and no edit to it in the part of '
            + 'the conversation on screen.';
    }
    return 'Nothing to show for this file.';
}

/**
 * Keep the two side-by-side panes together horizontally.
 *
 * diff2html gives each pane its own scroller and no synchronisation — reading a
 * long line then means scrolling both halves by hand to compare them, which is
 * the one thing side by side is for.
 */
function syncSideScroll(root) {
    // Per file wrapper rather than across the whole body. The transcript source
    // renders one block per edit, so a body-wide query returns six panes for
    // three edits and pairing them globally would tie the wrong halves together.
    for (const wrap of root.querySelectorAll('.d2h-file-wrapper')) {
        const panes = [...wrap.querySelectorAll('.d2h-file-side-diff')];
        if (panes.length !== 2) continue;
        let mirroring = false;
        for (const pane of panes) {
            pane.addEventListener('scroll', () => {
                if (mirroring) return;
                mirroring = true;
                for (const other of panes) if (other !== pane) other.scrollLeft = pane.scrollLeft;
                // Cleared on the next frame rather than immediately: setting
                // scrollLeft queues a scroll event of its own, and clearing the
                // flag first would let the mirror echo back.
                requestAnimationFrame(() => { mirroring = false; });
            }, { passive: true });
        }
    }
}

/** A view option changed. Never refetches — every one of them is render-time. */
export function setDiffOpt(key, on) {
    state.diff[key] = on;
    localStorage.setItem(
        { split: 'diffSplit', words: 'diffWords', wrap: 'diffWrap' }[key], on ? '1' : '0');
    paintDiff();
}

export function jumpFromDiff() {
    const { toolId, agent } = state.diff;
    const entry = toolId ? state.tools.get(toolId) : null;
    closeDiff();
    if (entry) return jumpToTurn(entry);
    if (agent) return openAgent(agent.toolUseId);
    toast('That edit is not in the part of the conversation on screen.', 'warn');
}
