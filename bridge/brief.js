'use strict';

// The agent brief: a short pre-prompt every session this bridge starts is given,
// saying what TGXCode is and what it offers, plus a handful of longer sections
// the agent reads on demand with the `tgxcode_guide` tool.
//
// A session used to learn about this app only from the descriptions of the MCP
// tools it happened to look at. That covers *how* to call schedule_session and
// says nothing about the things no tool describes — that the user may be reading
// on a phone, that a dev server it starts turns into a chip, that a permission
// prompt nobody is watching is denied. The brief is where those go.
//
// **Two layers, because every word of the first one is paid for on every
// session.** The main brief is appended with `--append-system-prompt` at each
// spawn (bridge/runner.js), so it stays a couple of hundred words: one line per
// capability and a list of the sections. The sections cost nothing until an
// agent asks for one, so they carry the detail.
//
// **Defaults live here, in code, and an edit overrides one whole.** Each text is
// stored in the settings file only when somebody changed it (`brief.mainText`,
// `brief.<id>Text`); absent or null means the shipped text, so a default nobody
// touched follows upgrades and an edited one is left alone. See bridge/prefs.js
// for the keys and the user/project precedence they take part in.
//
// **What a session is told depends on what is switched on for it.** A text may
// carry blocks that only render when a condition holds:
//
//     {{#if devbrowser}}…{{else}}…{{/if}}     {{#if !headless}}…{{/if}}
//
// A condition is one name, optionally negated with `!`. The names are:
//
//   - a feature, from the session's settings, project and role — see FEATURES;
//   - a section id, true when that section is available to this session, so a
//     main-brief line about phone installs goes when the Phone section does;
//   - `sections`, true when any section is available.
//
// An unknown name is false, and reported. `{{sections}}` in the main text is
// replaced with the list of available sections. A tag alone on its line takes
// the line with it, the way Mustache's standalone tags do, so a block that is
// left out leaves no blank line behind. A tag that does not balance — a stray
// `{{/if}}`, an `{{#if}}` never closed — is kept as literal text and reported,
// rather than guessed at: dropping text somebody wrote because of a typo two
// paragraphs up would be the worse surprise, and literal braces show up in the
// Settings preview where the problem list says why.
//
// A section additionally declares `requires`: the features it is meaningless
// without. It is left out of the list and refused by the tool when one is off,
// on top of its own on/off switch.
//
// **Role.** An orchestrator already has a brief of its own
// (bridge/orchestration.js) and this one composes with it, so nothing here is
// orchestrator-specific; the worker-facing parts are gated on `worker`.

const MAX_TEXT = 8000;

// What a condition can test, besides section ids. Each is derived in
// featuresFor() below; the descriptions are what the Settings page shows.
const FEATURES = {
    devbrowser: 'DevBrowser is shown (Settings → DevBrowser)',
    headless: 'the agent test browser runs headless (Settings → Agent test browser)',
    previewControl: 'agents may drive the browser preview (Settings → Browser preview)',
    projectCommands: 'the project declares commands in .tgxcode/commands.json',
    worker: 'the session is a worker started by an orchestrator',
    orchestrator: 'the session is an orchestrator',
    sudo: 'the user approves sudo commands from the app (Settings → Sudo)',
};

const DEFAULT_MAIN = `# TGXCode

You are running inside TGXCode, a desktop and phone app over Claude Code sessions. The user may be reading on a phone: lead with the outcome, keep replies short, avoid wide tables.

Its \`tgxcode\` MCP tools give you:
{{#if sessions}}
- list_sessions, message_session: find another session and hand it a fact, waking it if idle.
- suggest_session: offer the user a follow-up session instead of doing out-of-scope work yourself.
{{/if}}
{{#if tasks}}
- find_tasks, start_task, set_task_status: work through the user's suggested tasks.
{{/if}}
{{#if scheduling}}
- schedule_session: start a session later, once or on a cron.
{{/if}}
{{#if phone}}
- install_on_phone: put an APK you built on the user's phone, without adb.
{{/if}}
{{#if previewControl}}
- open_in_preview: put a page in the user's preview pane, to drive with the \`preview\` server's browser tools — only when they ask you to use the preview.
{{/if}}
{{#if worker}}
- report_to_orchestrator: questions, progress and "done" go to your orchestrator.
{{/if}}

Attached files arrive as paths under attached_assets/. Scratch files belong in your session scratchpad, which the user can see in the app.
{{#if sudo}}
To run something as root, use \`sudo -A …\` (plain sudo cannot prompt here) and give the Bash call a long timeout (up to 600000 ms): the user approves each command in the app, with their password. If it fails saying it was not approved, do not retry; tell the user what needed root.
{{/if}}
{{#if servers}}
Servers you start are detected by port and offered to the user to open.
{{/if}}
{{#if sections}}

More on demand: call tgxcode_guide with a topic when the work calls for it.
{{sections}}
{{/if}}`;

const SECTIONS = [
    {
        id: 'sessions',
        title: 'Sessions & handoffs',
        summary: 'messaging other sessions, suggesting follow-ups',
        requires: [],
        text: `## Sessions & handoffs

Three tools, three intents:
- message_session hands a fact to a session that owns related work: you changed an API it uses, or found a bug in its checkout. Find it with list_sessions. It wakes in plan mode and comes back to the user with a plan, so write for an agent with none of your context: the files, what changed, what you expect.
- suggest_session offers the user a new session as a one-click card. Use it for worthwhile work outside your task, and do not start that work yourself.
- Your own Agent tool is for work you were asked to do now.

One handoff per target: a second message to the same session within a minute is refused, so put everything in the first. A session listed as \`elsewhere\` runs in a terminal and cannot be woken from here.`,
    },
    {
        id: 'tasks',
        title: 'Suggested tasks',
        summary: 'the shared list of follow-ups, and working through it',
        requires: [],
        text: `## Suggested tasks

Every suggest_session call, from any session, becomes a task on the user's Tasks board. find_tasks searches them: open, started (with the session doing it), completed or dismissed.

To take one up, start_task as "session" (a session of its own, plan mode by default) or as "subagent" (claims it and hands you its prompt for your Agent tool). Either way it is marked started, so nobody else takes it; one that is not open is refused, and you should not work around that.

When the work exists, set_task_status "completed" with a note saying where (a PR URL is best), or "dismissed" with the reason. Starting a task is not completing it.`,
    },
    {
        id: 'scheduling',
        title: 'Scheduling',
        summary: 'running work later, and what an unattended run can do',
        requires: [],
        text: `## Scheduling

schedule_session starts a new session later: once (\`at\`, local time) or on a cron. It appears in the user's Schedules panel marked as yours, where they can edit, pause or delete it. Schedule only when the user asked for something to happen later.

A scheduled run is unattended. Nobody can answer a question, and a permission prompt raised while no TGXCode window or phone is watching is denied at once. So write the prompt for an agent with none of your context, say what to do when something is unclear, and keep the default permission mode (auto) unless the user chose another; plan mode stops at a plan nobody approves.

The user can also hold a message for an existing session until a set time (Send later, in the composer). That one is theirs; there is no tool for it.`,
    },
    {
        id: 'phone',
        title: 'Phone installs',
        summary: 'putting an Android build on the user\'s phone',
        requires: [],
        text: `## Phone installs

The user has the TGXCode app on their Android phone, and install_on_phone delivers an APK through it. Prefer it to adb for the user's own phone; use adb for an emulator or when asked. Do not ask the user to turn on wireless debugging for this.

- Pass the finished .apk once the build succeeds. It is copied at once, so rebuilding afterwards is safe.
- Android refuses a build signed with a different key from the installed app, or with a lower versionCode. That failure needs a fix in the build, not a retry.
- "Waiting on the user" means a tap on the phone. Say so and move on; check later with phone_install_status rather than filing the same build again.`,
    },
    {
        id: 'servers',
        title: 'Dev servers & previews',
        summary: 'starting servers the user can open, and which ports to use',
        requires: [],
        text: `## Dev servers & previews

TGXCode notices servers you start: it asks the kernel which process holds a port and which session started that process, and shows the port as a chip in this conversation. The user opens it with a click{{#if devbrowser}}, in DevBrowser (a tab per server) or in a preview inside the app{{else}}, in a preview inside the app{{/if}}.

- Run a long-lived server in the background so your turn can end while it keeps serving, and give the URL in your reply.
- Pick a free port rather than the framework default, and never take one an app the user is running already holds.
- Stop servers you no longer need; a chip for a dead port is noise.`,
    },
    {
        id: 'commands',
        title: 'Project commands',
        summary: 'the buttons this project declares in .tgxcode/commands.json',
        requires: ['projectCommands'],
        text: `## Project commands

This project declares commands in .tgxcode/commands.json (shared) and .tgxcode/commands.local.json (personal, in the main checkout). Each is a button in the conversation header that runs in a terminal pane of the app. You cannot press them, but you can read the file to see what each runs and tell the user which one to press.

In a command, \`\${port}\` becomes a free port from the command's range when it starts; \`\${cwd}\`, \`\${project}\`, \`\${worktree}\` and \`\${branch}\` are what they say. If the user asks for a new button, add it to commands.json; problems with the file show in Settings → Project commands.`,
    },
    {
        id: 'browser',
        title: 'Agent test browser',
        summary: 'testing pages in a browser{{#if headless}} (headless here){{/if}}',
        requires: [],
        text: `## Agent test browser

When you test a page with a browser tool (Playwright MCP, if the user has it), {{#if headless}}it runs headless: nothing is drawn on the user's screen, and screenshots and clicks still work. Take a screenshot when you need to see the page.{{else}}a real window opens on the user's desktop and can take the keyboard from whatever they are typing. Keep runs short and close the browser when you are done.{{/if}}

Test against a dev server of your own, not an app the user is running, and never sign in to a real account or submit a form that does anything outside your test.`,
    },
    {
        id: 'preview',
        title: 'The user\'s preview',
        summary: 'driving the browser preview in the user\'s window, when they ask',
        requires: ['previewControl'],
        text: `## The user's preview

The user lets agents drive the browser preview in their TGXCode window. Use it only when they ask you to use the preview, or for an interactive check they want to watch; it is their screen, not your test browser.

- Call open_in_preview({url}) to put the page there, then use the \`preview\` server's browser_* tools on it: browser_snapshot first, then browser_click, browser_type, browser_take_screenshot and the rest. They act on the page the user is looking at, and cannot open or close pages.
- Local pages (localhost, 127.0.0.1) need no approval. Any other site needs the user's yes, per site, asked in the preview. open_in_preview waits up to a minute for it; if they have not answered, the prompt stays open and the page opens by itself when they allow it, so check back later rather than retrying. A browser_navigate, link or redirect to a site they have not approved is refused and raises the same prompt.
- A bar over the page tells the user you are connected. If they press Stop you are disconnected: do not reconnect unless they ask.`,
    },
    {
        id: 'orchestration',
        title: 'Working for an orchestrator',
        summary: 'reports, questions and finishing as a worker',
        requires: ['worker'],
        text: `## Working for an orchestrator

Your orchestrator is a model running several workers and reading every report; the user mostly reads its summary, not your transcript.

- Report sparingly: "update" only for something that changes its plan, "question" when you are blocked (then end your turn), "done" once, with the branch, the PR and anything left undone.
- Your final message each turn is forwarded to it, so make its first line the status.
- Stay inside the task you were given. Out-of-scope work you notice goes in your report or to suggest_session, not into your branch.
- Do not message other workers or start sessions of your own unless told to; coordinating is its job.`,
    },
];

const SECTION_IDS = SECTIONS.map(s => s.id);
const byId = new Map(SECTIONS.map(s => [s.id, s]));

// ---------------------------------------------------------------------------
// The conditional syntax
// ---------------------------------------------------------------------------

const TAG_RE = /\{\{([^{}]*)\}\}/g;
const NAME_RE = /^!?[A-Za-z][\w-]*$/;

/**
 * Split a template into text and tags, with a standalone tag taking its line.
 *
 * @returns {Array<{type: 'text', text: string} | {type: 'tag', kind: string,
 *   name?: string, neg?: boolean, raw: string}>}
 */
function tokenize(src) {
    const out = [];
    let at = 0;
    for (const m of src.matchAll(TAG_RE)) {
        const body = m[1].trim();
        let tag = null;
        const ifm = /^#if\s+(\S+)$/.exec(body);
        if (ifm && NAME_RE.test(ifm[1])) {
            tag = { kind: 'if', neg: ifm[1].startsWith('!'), name: ifm[1].replace(/^!/, '') };
        } else if (body === 'else') tag = { kind: 'else' };
        else if (body === '/if') tag = { kind: 'end' };
        else if (/^[A-Za-z][\w-]*$/.test(body)) tag = { kind: 'var', name: body };
        // Anything else between braces is not ours and stays text.
        if (!tag) continue;

        let start = m.index;
        let end = m.index + m[0].length;
        if (tag.kind !== 'var') {
            const lineStart = src.lastIndexOf('\n', start - 1) + 1;
            const nl = src.indexOf('\n', end);
            const lineEnd = nl === -1 ? src.length : nl;
            if (!src.slice(lineStart, start).trim() && !src.slice(end, lineEnd).trim()) {
                start = lineStart;
                end = nl === -1 ? src.length : nl + 1;
            }
        }
        if (start > at) out.push({ type: 'text', text: src.slice(at, start) });
        out.push({ type: 'tag', ...tag, raw: src.slice(start, end) });
        at = end;
    }
    if (at < src.length) out.push({ type: 'text', text: src.slice(at) });
    return out;
}

/**
 * Tokens into a tree. Whatever does not balance becomes text, with a problem.
 *
 * @returns {{nodes: Array, problems: string[]}}
 */
function parse(src) {
    const problems = [];
    const root = { then: [] };
    const stack = [];
    const into = () => {
        const top = stack[stack.length - 1];
        return top ? (top.inElse ? top.node.else : top.node.then) : root.then;
    };
    for (const t of tokenize(src)) {
        if (t.type === 'text') { into().push(t); continue; }
        if (t.kind === 'var') { into().push({ type: 'var', name: t.name, raw: t.raw }); continue; }
        if (t.kind === 'if') {
            const node = { type: 'if', name: t.name, neg: t.neg, raw: t.raw, then: [], else: [], elseRaw: null };
            into().push(node);
            stack.push({ node, inElse: false });
            continue;
        }
        const top = stack[stack.length - 1];
        if (t.kind === 'else') {
            if (!top || top.inElse) {
                problems.push(`{{else}} with no open {{#if}} — kept as text`);
                into().push({ type: 'text', text: t.raw });
            } else {
                top.inElse = true;
                top.node.elseRaw = t.raw;
            }
            continue;
        }
        // kind === 'end'
        if (!top) {
            problems.push('{{/if}} with no open {{#if}} — kept as text');
            into().push({ type: 'text', text: t.raw });
        } else {
            top.node.endRaw = t.raw;
            stack.pop();
        }
    }
    // Anything still open was never closed: its tags go back to being text and
    // its contents are spliced in unconditionally, innermost first.
    while (stack.length) {
        const { node } = stack.pop();
        problems.push(`{{#if ${node.neg ? '!' : ''}${node.name}}} is never closed — kept as text`);
        const parent = stack.length
            ? (stack[stack.length - 1].inElse ? stack[stack.length - 1].node.else : stack[stack.length - 1].node.then)
            : root.then;
        const i = parent.lastIndexOf(node);
        const flat = [{ type: 'text', text: node.raw }, ...node.then,
            ...(node.elseRaw !== null ? [{ type: 'text', text: node.elseRaw }, ...node.else] : [])];
        parent.splice(i, 1, ...flat);
    }
    return { nodes: root.then, problems };
}

/**
 * Render a template to parts: what is kept and what a condition left out.
 *
 * @param {string} src
 * @param {(name: string) => boolean|undefined} truth undefined for a name it
 *   does not know, which counts as false and is reported.
 * @param {object} [vars] name -> replacement text for `{{name}}`
 * @returns {{parts: Array<{text: string, on: boolean, why?: string}>, problems: string[]}}
 */
function renderParts(src, truth, vars = {}) {
    const { nodes, problems } = parse(String(src || ''));
    const parts = [];
    const unknown = new Set();
    const push = (text, on, why) => {
        if (!text) return;
        const last = parts[parts.length - 1];
        if (last && last.on === on && last.why === why) last.text += text;
        else parts.push(on ? { text, on } : { text, on, why });
    };
    const walk = (list, on, why) => {
        for (const n of list) {
            if (n.type === 'text') push(n.text, on, why);
            else if (n.type === 'var') {
                if (Object.prototype.hasOwnProperty.call(vars, n.name)) push(vars[n.name], on, why);
                else {
                    if (!unknown.has(`var:${n.name}`)) problems.push(`{{${n.name}}} is not something that can be filled in — kept as text`);
                    unknown.add(`var:${n.name}`);
                    push(n.raw, on, why);
                }
            } else {
                let v = truth(n.name);
                if (v === undefined) {
                    if (!unknown.has(n.name)) problems.push(`"${n.name}" is not a feature or section — treated as off`);
                    unknown.add(n.name);
                    v = false;
                }
                const pass = n.neg ? !v : !!v;
                const label = `${n.neg ? '!' : ''}${n.name}`;
                walk(n.then, on && pass, on && !pass ? label : why);
                walk(n.else, on && !pass, on && pass ? `else of ${label}` : why);
            }
        }
    };
    walk(nodes, true, undefined);
    return { parts, problems };
}

/** The kept text, tidied: no run of blank lines, no blank ends. */
function textOf(parts) {
    return parts.filter(p => p.on).map(p => p.text).join('')
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function render(src, truth, vars) {
    const { parts, problems } = renderParts(src, truth, vars);
    return { text: textOf(parts), problems };
}

// ---------------------------------------------------------------------------
// Settings and features
// ---------------------------------------------------------------------------

/**
 * What the conditions can test, for one session.
 *
 * @param {{prefs: object, role?: string|null, commands?: Array|null}} input —
 *   `prefs` is a resolved Prefs.forCwd() answer; `commands` the project's
 *   declared commands (bridge/commands.js load().commands), or null for none.
 */
function featuresFor({ prefs, role = null, commands = null }) {
    const p = prefs || {};
    return {
        devbrowser: !p.devbrowser || p.devbrowser.show !== false,
        headless: !!(p.agentBrowser && p.agentBrowser.mode === 'headless'),
        previewControl: !!(p.preview && p.preview.agentControl === true),
        projectCommands: Array.isArray(commands) && commands.length > 0,
        worker: role === 'worker',
        orchestrator: role === 'orchestrator',
        sudo: !!(p.sudo && p.sudo.enabled === true),
    };
}

/** An edited text, or null for the shipped one. Whitespace alone is not an edit. */
const edited = (v) => (typeof v === 'string' && v.trim() ? v : null);

/**
 * The whole brief for one session: the main text, every section with whether
 * it is available and why not, and anything the templates got wrong.
 *
 * @param {{brief?: object, features: object}} input — `brief` is the resolved
 *   `brief` block of the settings (see bridge/prefs.js); missing keys mean the
 *   defaults.
 * @returns {{enabled: boolean, text: string, main: object, sections: object[],
 *   features: object, problems: string[]}}
 */
function compose({ brief = {}, features = {} } = {}) {
    const b = brief || {};
    const enabled = b.enabled !== false;
    const problems = [];

    const sections = SECTIONS.map((s) => {
        const on = b[`${s.id}Enabled`] !== false;
        const missing = s.requires.filter(f => !features[f]);
        const text = edited(b[`${s.id}Text`]);
        return {
            id: s.id, title: s.title, requires: s.requires,
            enabled: on, edited: text !== null, missing,
            available: enabled && on && !missing.length,
            source: text !== null ? text : s.text,
            summarySource: s.summary,
        };
    });
    const avail = new Map(sections.map(s => [s.id, s.available]));
    const truth = (name) => {
        if (name === 'sections') return sections.some(s => s.available);
        if (avail.has(name)) return avail.get(name);
        if (Object.prototype.hasOwnProperty.call(features, name)) return !!features[name];
        return undefined;
    };

    for (const s of sections) {
        s.summary = render(s.summarySource, truth).text;
        const r = renderParts(s.source, truth);
        s.parts = r.parts;
        s.text = textOf(r.parts);
        for (const m of r.problems) problems.push(`${s.title}: ${m}`);
        delete s.summarySource;
    }
    const listing = sections.filter(s => s.available)
        .map(s => `- ${s.id}: ${s.summary}`).join('\n');

    const mainSource = edited(b.mainText) !== null ? b.mainText : DEFAULT_MAIN;
    const main = renderParts(mainSource, truth, { sections: listing });
    for (const m of main.problems) problems.push(`Main brief: ${m}`);

    return {
        enabled,
        text: enabled ? textOf(main.parts) : '',
        main: { edited: edited(b.mainText) !== null, source: mainSource, parts: main.parts },
        sections,
        features,
        problems,
    };
}

/**
 * What `tgxcode_guide` answers: one section, or the list of them.
 *
 * Gated here as well as in the listing, because the listing an agent saw was
 * composed when its process started and the settings may have moved since.
 *
 * @returns {{ok: boolean, text: string}}
 */
function guide(composed, topic) {
    if (!composed.enabled) {
        return { ok: false, text: 'The TGXCode agent brief is switched off in Settings, so there is no guide to read.' };
    }
    const open = composed.sections.filter(s => s.available);
    const list = open.length
        ? open.map(s => `- ${s.id}: ${s.summary}`).join('\n')
        : '(none — every section is switched off for this session)';
    const want = typeof topic === 'string' ? topic.trim().toLowerCase() : '';
    if (!want) return { ok: true, text: `Topics, read one with tgxcode_guide({topic}):\n${list}` };
    const s = composed.sections.find(x => x.id === want);
    if (!s) return { ok: false, text: `No topic "${want}". Topics:\n${list}` };
    if (!s.available) {
        const why = !s.enabled ? 'it is switched off in Settings'
            : `it applies only when ${s.missing.map(f => FEATURES[f] || f).join(' and ')}`;
        return { ok: false, text: `The "${want}" topic is not available to this session: ${why}. Topics:\n${list}` };
    }
    return { ok: true, text: s.text };
}

module.exports = {
    DEFAULT_MAIN, SECTIONS, SECTION_IDS, FEATURES, MAX_TEXT,
    tokenize, parse, renderParts, render, featuresFor, compose, guide, byId,
};
