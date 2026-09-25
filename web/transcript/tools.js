// Tool calls in the transcript: the one-line summary, the collapsible block and
// the body built on first expand (fillTool), including the TodoWrite repair that
// test/tasks.test.js reads out of this file.
//
// This imports app.js and sibling modules here, which import it back. That is
// safe only because nothing in this file reads an imported binding while the
// module is evaluating — every use is inside a function called later. Keep it
// that way: a top-level `const X = someImport(...)` runs before app.js's body
// and throws in the temporal dead zone, and only loading the page shows it.

import { get } from '../api.js';
import { el, toast } from '../dom.js';
import { clip, dur, shortModel } from '../format.js';
import { escapeHtml, highlight } from '../highlight.js';
import { renderMarkdown } from '../markdown.js';
import { state } from '../state.js';
import { peerByName } from '../composer/mentions.js';
import { statusMark } from './checklist.js';
import { openSession } from './conversation.js';
import { markFindDirty } from './find.js';
import { kvView } from './review.js';
import { renderEvent, row } from './rows.js';
import { openAgent, STATUS_WORD, statusOfCall } from './subagents.js';

// ── tools ────────────────────────────────────────────────────────────────

/** One-line summary of what a tool call is doing, shown on the collapsed row. */
export function toolSummary(ev) {
    const i = ev.input || {};

    // Handing work to another session. Before the switch because the CLI prefixes
    // an MCP tool with its server — `mcp__tgxcode__message_session` — and
    // the suffix is the part worth matching, for the same reason
    // SUGGEST_TOOL_SUFFIX is matched that way in bridge/transcript.js.
    //
    // Worth a case of its own rather than the default's "first string value",
    // which would show a bare session id: the recipient is the whole point of the
    // call, and an id says nothing about who it reached.
    if (ev.name && ev.name.endsWith('__message_session')) {
        const to = state.sessions.find(s => s.sessionId === i.sessionId);
        const who = to ? (to.title || to.projectName || i.sessionId) : i.sessionId || '?';
        const said = typeof i.text === 'string' ? i.text : '';
        return said ? `to ${who}: ${clip(said, 60)}` : `to ${who}`;
    }

    switch (ev.name) {
        case 'Bash': return i.command || i.description || '';
        case 'Read': return i.file_path + (i.offset ? `  :${i.offset}` : '');
        case 'Edit': return i.file_path;
        case 'Write': return i.file_path;
        case 'Glob': return i.pattern + (i.path ? `  in ${i.path}` : '');
        case 'Grep': return i.pattern + (i.path ? `  in ${i.path}` : '');
        case 'Task':
        case 'Agent': return i.description || clip(i.prompt, 80);
        case 'WebFetch': return i.url;
        case 'WebSearch': return i.query;
        case 'TodoWrite': return `${todoItemsOf(i).length} items`;
        case 'Skill': return '/' + (i.skill || '');
        // The first heading of a plan is what it is a plan for.
        case 'ExitPlanMode': return clip((i.plan || '').replace(/^#+\s*/, ''), 80);
        case 'AskUserQuestion':
            return (i.questions || []).map(q => q.header || q.question).join(' · ');
        // The recipient is a peer's name, which is its address but not always
        // what you call it — so the row shows the session's title when this app
        // knows one, and the raw name when it does not.
        case 'SendMessage': {
            const to = i.to || i.recipient || '?';
            const peer = peerByName(to);
            const who = peer && peer.title && peer.title !== to ? `${to} — ${peer.title}` : to;
            const said = typeof i.message === 'string' ? i.message : (i.summary || '');
            return said ? `to ${who}: ${clip(said, 60)}` : `to ${who}`;
        }
        default: {
            const first = Object.values(i)[0];
            return typeof first === 'string' ? clip(first, 80) : '';
        }
    }
}

export function renderTool(ev) {
    const status = ev.status || 'pending';
    const summary = toolSummary(ev);

    const det = el('details', { class: 'tool', 'data-status': status },
        el('summary', {},
            el('span', { class: 'caret' }, '▶'),
            el('span', { class: 'tname' }, ev.name),
            el('span', { class: 'targ' }, summary),
            el('span', { class: 'tmeta' },
                [status === 'pending' ? 'running' : '', dur(ev.durationMs)]
                    .filter(Boolean).join('  ')),
        ),
    );

    // The body is the expensive half of a transcript — highlighted code, diffs,
    // rendered markdown — and it sits behind a summary that is closed by
    // default. Most tool calls are never opened, so build it on first expand.
    det.append(el('div', { class: 'tool-body' }));
    // `click` lands before the open state is applied, so the body is there in
    // the same frame the block expands. `toggle` is the backstop for opens that
    // do not come from a click — find-in-page, or `open` set in code.
    det.addEventListener('click', () => fillTool(det, ev));
    det.addEventListener('toggle', () => fillTool(det, ev));
    return row(ev, 'tool', det);
}

/** Build a tool's body the first time it is actually shown. */
export function fillTool(det, ev) {
    const body = det.querySelector('.tool-body');
    // Before the guard: re-opening a block that was already built still needs a
    // repaint, because closing it is not what invalidated the marks — the fold
    // moving rows around it was.
    markFindDirty();
    if (!body || body.dataset.filled) return;
    body.dataset.filled = '1';
    body.append(...toolBody(ev));
}

function toolBody(ev) {
    const out = [];
    const i = ev.input || {};
    const r = ev.result || {};

    // --- input ------------------------------------------------------------
    if (ev.name === 'Bash') {
        out.push(section('Command', codePre(i.command || '', 'bash')));
        if (i.run_in_background) out.push(note('Runs in the background.'));
    } else if (ev.name === 'Write') {
        out.push(section('Contents', codePre(i.content || '', langOf(i.file_path))));
    } else if (ev.name === 'Edit') {
        // The summary row already names the file; don't say it twice.
        if (r.patch) out.push(section('Changes', diffView(r.patch)));
        else {
            out.push(section('Replace', codePre(i.old_string || '', langOf(i.file_path))));
            out.push(section('With', codePre(i.new_string || '', langOf(i.file_path))));
        }
    } else if (ev.name === 'TodoWrite') {
        out.push(section('Tasks', todoView(todoItemsOf(i))));
    } else if (ev.name === 'Task' || ev.name === 'Agent') {
        out.push(section('Prompt', el('div', { class: 'prose', html: renderMarkdown(i.prompt || '') })));
    } else if (ev.name === 'ExitPlanMode') {
        // The card is long gone by the time anyone reads this back; the plan
        // that was approved is the whole content of the call.
        //
        // `r.plan` in preference to `i.plan`: the input is the plan as put
        // forward and the result is the plan as agreed to, and they differ when
        // it was edited or approved with a note. The note exists nowhere else.
        out.push(section('Plan',
            el('div', { class: 'prose', html: renderMarkdown(r.plan || i.plan || '') })));
    } else if (ev.name === 'AskUserQuestion') {
        out.push(section('Questions', questionsView(i.questions || [], r.answers)));
    } else if (ev.name === 'SendMessage') {
        // One half of a conversation between two sessions. Rendered as prose
        // rather than as a key-value dump because it is a message somebody
        // wrote, and the other half — the arrival — renders that way too.
        const said = typeof i.message === 'string' ? i.message : JSON.stringify(i.message, null, 2);
        if (i.summary) out.push(section('Summary', el('div', { class: 'prose' }, i.summary)));
        out.push(section('Message', el('div', { class: 'prose', html: renderMarkdown(said || '') })));
        const peer = peerByName(i.to || i.recipient || '');
        // Only when that session is one this app can show. Peers are often
        // background agents with no transcript indexed here, and a button that
        // 404s is worse than no button.
        if (peer && peer.sessionId) {
            out.push(el('div', { class: 'subagent-btns' },
                el('button', { class: 'more-btn', type: 'button',
                    onclick: () => openSession(peer.sessionId) }, 'Open that session')));
        }
    } else if (Object.keys(i).length) {
        out.push(section('Input', kvView(i)));
    }

    // --- output -----------------------------------------------------------
    if (ev.name === 'Write' || (ev.name === 'Edit' && r.patch)) {
        // The diff above already is the outcome; don't repeat the file body.
        if (ev.status === 'error') out.push(section('Error', codePre(r.text || '', null, true)));
    } else if (r.patch && ev.name !== 'Edit') {
        out.push(section('Changes', diffView(r.patch)));
    } else if (r.stdout || r.stderr) {
        if (r.stdout) out.push(section('stdout', codePre(r.stdout, null)));
        if (r.stderr) out.push(section('stderr', codePre(r.stderr, null, true)));
    } else if (r.text) {
        out.push(section(ev.status === 'error' ? 'Error' : 'Result',
            codePre(r.text, null, ev.status === 'error')));
    } else if (ev.status === 'pending') {
        out.push(note('Still running.'));
    }

    if (r.interrupted) out.push(note('Interrupted before it finished.'));
    if (r.backgroundTaskId) out.push(note(`Background task ${r.backgroundTaskId}.`));

    // --- spilled output ------------------------------------------------------
    if (ev.persistedPath) {
        const btn = el('button', { class: 'more-btn', type: 'button' }, 'Load full output');
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = 'Loading…';
            try {
                const d = await get(`/api/sessions/${state.current.sessionId}/output`
                    + `?path=${encodeURIComponent(ev.persistedPath)}`);
                btn.replaceWith(codePre(d.text + (d.truncated ? '\n\n… truncated' : ''), null));
            } catch (err) {
                btn.disabled = false;
                btn.textContent = 'Load full output';
                toast(`Could not read the saved output: ${err.message}`, 'error');
            }
        });
        out.push(el('div', { class: 'tool-section' }, btn));
    }

    // --- subagent -------------------------------------------------------------
    if (ev.agent) {
        const a = ev.agent;
        const st = statusOfCall(ev);
        const meta = [STATUS_WORD[st], a.agentType, a.model && shortModel(a.model),
            a.toolUses && `${a.toolUses} tools`, dur(a.durationMs)].filter(Boolean).join(' · ');
        const wrap = el('div', { class: 'tool-section subagent', 'data-status': st },
            el('h4', {}, 'Subagent'),
            el('div', { class: 'subagent-meta' }, meta));

        if (a.hasTranscript) {
            const btns = el('div', { class: 'subagent-btns' });
            // Two ways in on purpose: a peek that keeps your place in this
            // conversation, and a switch for when the subagent is the thing you
            // actually came to read.
            btns.append(el('button', {
                class: 'more-btn primary', type: 'button',
                onclick: () => openAgent(ev.id),
            }, 'Open this subagent'));

            const btn = el('button', { class: 'more-btn', type: 'button' }, 'Peek inline');
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = 'Loading…';
                try {
                    const d = await get(`/api/sessions/${state.current.sessionId}/subagent`
                        + `?toolUseId=${encodeURIComponent(ev.id)}`);
                    const log = el('div', { class: 'subagent-log' });
                    for (const sub of d.events) {
                        const n = renderEvent(sub);
                        if (n) log.append(n);
                    }
                    btn.replaceWith(log);
                } catch (err) {
                    btn.disabled = false;
                    btn.textContent = 'Peek inline';
                    toast(`Could not load the subagent transcript: ${err.message}`, 'error');
                }
            });
            btns.append(btn);
            wrap.append(btns);
        }
        out.push(wrap);
    }

    return out;
}

function section(title, node) {
    return el('div', { class: 'tool-section' }, el('h4', {}, title), node);
}

function note(text) {
    return el('div', { class: 'tool-section',
        style: 'font:400 11.5px/1.5 var(--mono); color:var(--text-4)' }, text);
}

function codePre(text, lang, isError) {
    const s = String(text == null ? '' : text);
    const MAX = 40000;
    const shown = s.length > MAX ? s.slice(0, MAX) : s;
    const pre = el('pre', { class: 'io' + (isError ? ' err' : ''),
        html: lang ? highlight(shown, lang) : escapeHtml(shown) });
    if (s.length > MAX) {
        const wrap = el('div', {}, pre);
        const btn = el('button', { class: 'more-btn', type: 'button' },
            `Show the remaining ${(s.length - MAX).toLocaleString()} characters`);
        btn.addEventListener('click', () => {
            pre.innerHTML = lang ? highlight(s, lang) : escapeHtml(s);
            btn.remove();
        });
        wrap.append(btn);
        return wrap;
    }
    return pre;
}

function langOf(path) {
    const ext = String(path || '').split('.').pop().toLowerCase();
    return ({ ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
        json: 'json', css: 'css', scss: 'scss', html: 'html', svelte: 'html',
        vue: 'html', py: 'py', sh: 'sh', bash: 'sh', sql: 'sql', yml: 'yaml',
        yaml: 'yaml', go: 'go', rs: 'rust', cs: 'cs', md: null })[ext] || null;
}

function diffView(patch) {
    const box = el('div', { class: 'diff' });
    for (const hunk of patch) {
        box.append(el('div', { class: 'hunk' },
            `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`));
        for (const line of hunk.lines || []) {
            const c = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
            box.append(el('div', { class: `dl ${c}` }, line || ' '));
        }
    }
    return box;
}

/**
 * The items out of a raw TodoWrite input — the client's half of `todoInput` in
 * bridge/transcript.js, and the same two malformed shapes.
 *
 * The panel gets its list normalised by the bridge, but a tool block in the
 * transcript is rendered from `ev.input` as the tool wrote it, so the repair has
 * to exist on this side too. There is a real transcript on this machine whose
 * `input.todos` is a JSON *string*, and every call site here read
 * `i.tasks || i.todos` and trusted it: the summary counted the string's
 * *characters* and reported "1041 items", and iterating it walked the list one
 * character at a time.
 */
export function todoItemsOf(input) {
    let items = input && (input.todos !== undefined ? input.todos : input.tasks);
    if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch { return []; }
    }
    return Array.isArray(items) ? items : [];
}

/**
 * The list inside a TodoWrite or Task tool block in the transcript.
 *
 * The same marks and colours the task list panel uses, off the same classes and
 * the same `statusMark`, so the two places a list is drawn cannot drift apart.
 * These items come straight off the tool input rather than through the bridge's
 * normaliser, so the name is still whichever of the keys the tool used.
 */
function todoView(items) {
    return el('ul', { class: 'cl-list' }, ...items.map((t) => {
        const status = t.status || t.state || 'pending';
        return el('li', {},
            el('div', { class: 'cl-row flat', 'data-status': status },
                el('span', { class: 'cl-mark', 'aria-hidden': 'true' }, statusMark(status)),
                el('span', { class: 'cl-name' },
                    t.subject || t.content || t.description || t.activeForm || '')));
    }));
}

/**
 * Which options an answer picked, and what was typed instead.
 *
 * `result.answers` is one string per question, and it carries three different
 * things with nothing to tell them apart: a single choice is the option's label
 * verbatim, a multi-select is the chosen labels joined `", "`, and an answer
 * typed into the tool's "Other" box is a sentence matching no label at all.
 * Measured over 414 real answers on this machine: 83% one label, 4% several
 * joined, 13% free text, 1% a label with typed words after it. All four are
 * common enough to get right.
 *
 * **It is not a split.** 187 of those questions had an option label containing
 * a comma of its own — `"Bar, count, cycling (Recommended)"` — so splitting on
 * `", "` shreds the label and marks nothing. This consumes whole labels off the
 * front instead, for as long as the front keeps being one.
 *
 * Longest first, and that is not a tidiness preference: one label is regularly
 * a prefix of another ("Approve" / "Approve with feedback"), and taking the
 * short one first leaves a fragment that then matches nothing and reads back as
 * free text. The separator is a pattern rather than the literal `", "` the dock
 * writes because a transcript on this machine joined with `","` and no space.
 *
 * **One case cannot be got right, because the data does not hold it.** Ticking
 * an option and then adding a condition in the "Other" box produces the same
 * string, byte for byte, as typing that whole sentence into "Other" alone — the
 * dock joins the picks and pushes the typed answer onto the end, and nothing
 * records which came from where. So `"Hard delete, but make them confirm"` is
 * read as the option plus a note. That is the reading the real answers support:
 * every mixed case on this machine is somebody agreeing with an option and
 * qualifying it. Treating the whole thing as free text instead would be wrong
 * about all of them to avoid being wrong about a sentence that happens to open
 * with a label and a comma, which is the rarer mistake and the cheaper one —
 * the typed words are shown either way, so what is at stake is one mark.
 *
 * Whatever is left over comes back verbatim rather than reassembled, so a typed
 * answer reads exactly as it was typed. `docs/api.md` documents this rule, so
 * the Android client derives it from one written contract rather than from a
 * second implementation of this function.
 */
export function readAnswer(answer, options) {
    const said = String(answer == null ? '' : answer).trim();
    const labels = (options || []).map(o => (o && o.label) || '').filter(Boolean);
    const chosen = new Set();
    if (!said) return { chosen, said: '' };

    // The common case, and the only one immune to every hazard above.
    if (labels.includes(said)) { chosen.add(said); return { chosen, said: '' }; }

    // Only from the front, and only while the front keeps being a label. That
    // is how the dock builds the string — `picks.join(', ')` and then the typed
    // answer pushed on the end — so labels are a prefix and free text is the
    // tail. Searching the whole string instead would match a label quoted in the
    // middle of a sentence ("Because of X, Wide modal, is wrong") and mark an
    // option the person was arguing against.
    const byLength = [...labels].sort((a, b) => b.length - a.length);
    let rest = said;
    while (rest) {
        const hit = byLength.find(l => rest.startsWith(l)
            && (rest.length === l.length || /^\s*,/.test(rest.slice(l.length))));
        if (!hit) break;
        chosen.add(hit);
        rest = rest.slice(hit.length).replace(/^\s*,\s*/, '');
    }
    return { chosen, said: rest.trim() };
}

/**
 * What was asked, read back later — and what was answered.
 *
 * The answer used to be missing here, because the bridge dropped it: every
 * option was drawn with the same `○` and the one fact worth reading back was
 * gone. `result.answers` carries it now, so this marks the option that was
 * picked and prints anything typed instead.
 *
 * The same two marks the review dialog uses, off the same `readAnswer`, for the
 * reason `todoView` above gives about its own list: the three places a question
 * is now drawn cannot be allowed to disagree about what was chosen.
 */
function questionsView(questions, answers) {
    const list = el('div', { class: 'qview' });
    for (const q of questions) {
        const { chosen, said } = readAnswer(answers && answers[q.question], q.options);
        list.append(el('div', { class: 'qview-q' },
            q.header ? el('span', { class: 'perm-q-chip' }, q.header) : null,
            el('span', {}, q.question || '')));
        for (const opt of q.options || []) {
            const picked = chosen.has(opt.label || '');
            list.append(el('div', { class: 'qview-o', 'data-chosen': picked ? '1' : null },
                el('span', { class: 'qview-mark' }, picked ? '●' : '○'),
                el('span', {}, opt.label || '')));
        }
        // Typed rather than picked. Shown as its own row rather than folded in
        // with the options, because it is not one of them.
        if (said) {
            list.append(el('div', { class: 'qview-o qview-said', 'data-chosen': '1' },
                el('span', { class: 'qview-mark' }, '●'), el('span', {}, said)));
        }
    }
    return list;
}
