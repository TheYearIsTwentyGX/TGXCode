'use strict';

// The tools this app gives a session that it would not otherwise have.
//
// Three of them started this file, and they exist for the same reason: a
// session knows something the next piece of work needs, and until now had
// nowhere to put it.
//
//   suggest_session  — offer the user a follow-up they can start in one click.
//   list_sessions    — find out which other sessions exist, live or not.
//   message_session  — hand a fact to one of them, waking it if it is idle.
//
// Four more close the loop on the first, so a list of suggested tasks can be
// worked through by an agent and not only by clicks:
//
//   find_tasks        — search suggested tasks, with their status and source.
//   start_task        — take one up, as a new session or inside this one.
//   set_task_status   — say one is done, or dismiss it, or offer it again.
//   schedule_session  — start a session later, once or on a cron.
//
// The permission modes those offer stop short of bypassPermissions. That is a
// guardrail on the tool, not a boundary — the agent can read the same token
// this process does — and it exists so the obvious call cannot produce an
// unattended run with every check switched off.
//
// **suggest_session records nothing, and that is still its whole design.** The
// card the user sees is rendered from the `tool_use` entry the CLI writes to the
// transcript — the same way web/app.js already reads a pending ExitPlanMode out
// of a session this bridge does not own. Storing the suggestion here as well
// would be a second source of truth, and the one in the transcript is the one
// that survives a restart, a different window, and this process not being around.
// The only state the app owns is whether you *acted* on a suggestion, which is a
// decision you made rather than something the agent said — that lives in
// bridge/suggestions.js beside flags.json.
//
// **The other two talk to the bridge, and that is the change worth flagging.**
// This file used to be stateless and offline; it is now a client. It still
// stores nothing: `list_sessions` is a read, and `message_session` posts a
// message that ends up in the *target's* transcript, which stays the single
// source of truth for what was said. What moved is only that a tool call here
// can have an effect outside this process.
//
// The bridge's port arrives in `--port`, because bridge/runner.js strips
// TGXCODE_PORT from a session's environment on purpose (see the header
// there). The **token is read from disk here** rather than passed in: argv is
// readable through `ps`, and the whole `--mcp-config` blob sits on the `claude`
// command line.
//
// `--session` is this session's own id, for provenance on a handoff. It is
// fixed at spawn, so a session that later *forks* reports the id it was started
// with; the bridge treats `from` as provenance rather than as an authority for
// exactly that reason.
//
// Spoken protocol is MCP over stdio: JSON-RPC 2.0, one object per line. Written
// out by hand rather than pulled in, because this repo has no node_modules and
// is not about to grow one for three methods. See bridge/runner.js, which passes
// this file to `claude --mcp-config`.

require('./legacy-env');
const fs = require('fs');
const http = require('http');
const readline = require('readline');

const cfg = require('./config');

// Named when a client asks for something we don't recognise. MCP wants the
// server to state a version it speaks rather than guess at the client's.
const PROTOCOL_VERSION = '2025-06-18';

// Versions we are happy to be spoken to in. The wire shape of the methods below
// has not changed across them, so agreeing is honest rather than hopeful.
const SPOKEN = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

// ---------------------------------------------------------------------------
// Who we are
// ---------------------------------------------------------------------------

function flag(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? null : (process.argv[i + 1] || null);
}

const PORT = Number(flag('port')) || 0;
const SESSION_ID = flag('session') || null;

// ---------------------------------------------------------------------------
// Talking to the bridge
// ---------------------------------------------------------------------------

/**
 * One request to the bridge, on loopback, with the token off disk.
 *
 * Every failure is returned rather than thrown: what a model can do about "the
 * bridge is not listening" is nothing, and a tool error saying so plainly is
 * more use than a transport exception it has to guess at.
 *
 * @returns {Promise<{ok: boolean, status: number, body: any, error: string|null}>}
 */
function api(method, route, body) {
    return new Promise((resolve) => {
        if (!PORT) {
            resolve({
                ok: false, status: 0, body: null,
                error: 'no bridge port was passed to this tool, so it cannot reach TGXCode',
            });
            return;
        }
        let token;
        try {
            token = fs.readFileSync(cfg.TOKEN_FILE, 'utf8').trim();
        } catch (err) {
            resolve({
                ok: false, status: 0, body: null,
                error: `could not read the access token at ${cfg.TOKEN_FILE}: ${err.message}`,
            });
            return;
        }

        const payload = body == null ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({
            host: '127.0.0.1',
            port: PORT,
            method,
            path: route,
            headers: {
                Authorization: `Bearer ${token}`,
                'X-TGXCode-Client': '1', 'X-Claude-Sessions-Client': '1',
                ...(payload
                    ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
                    : {}),
            },
        }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = raw ? JSON.parse(raw) : null; } catch { /* reported as a status */ }
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    body: parsed,
                    error: null,
                });
            });
        });
        req.on('error', (err) => resolve({
            ok: false, status: 0, body: null,
            error: `could not reach TGXCode on port ${PORT}: ${err.message}`,
        }));
        if (payload) req.write(payload);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const SUGGEST = {
    name: 'suggest_session',
    title: 'Suggest a follow-up session',
    description: [
        'Hand a piece of follow-up work to the user as a session they can start',
        'with one click, with the prompt already written.',
        '',
        'Use this when you identify work worth doing that is outside the scope of',
        'what you were asked — the refactor you noticed while fixing something',
        'else, the test that should exist, the shortcoming you had to leave alone.',
        'Instead of only mentioning it, file it: the user gets a card in the',
        'conversation offering to start a session on it.',
        '',
        'Write `prompt` as a full first message to an agent that has none of your',
        'context — name the files, say what is wrong and what done looks like.',
        '"Fix the thing we discussed" is useless to the session that receives it.',
        '',
        'This does not start anything. It offers. Do not also start the session',
        'yourself, and do not use this for work you were asked to do now.',
        '',
        'For work that belongs to a session that already exists, use',
        'message_session instead — that reaches the agent that owns the code.',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            prompt: {
                type: 'string',
                description: 'The first message the new session starts with. Self-contained.',
            },
            why: {
                type: 'string',
                description: 'One line on why this is out of scope for the work you are doing.',
            },
            title: {
                type: 'string',
                description: 'A short label for the card — a few words, not a sentence.',
            },
            cwd: {
                type: 'string',
                description:
                    "Absolute path to run in. Defaults to this session's working directory, "
                    + 'which is almost always right — pass one only for work that belongs in '
                    + 'a different checkout.',
            },
        },
        required: ['prompt'],
    },
};

const LIST = {
    name: 'list_sessions',
    title: 'List the other sessions',
    description: [
        'Every session TGXCode knows about — including ones that are not',
        'running. Use it to find who owns a piece of code before handing them',
        'something with message_session.',
        '',
        'This is not the same list as ListAgents. That one shows sessions that are',
        'alive right now, because a peer message needs a live inbox. This one shows',
        'sessions whether or not they have a process, because a handoff can wake an',
        'idle one — which is most of them.',
        '',
        '`state` is what a handoff would run into:',
        '  idle       no turn in flight. A handoff resumes it. This is the usual case.',
        '  working    a turn is running, or messages are queued. A handoff is queued',
        '             behind what it is doing.',
        '  elsewhere  running in a terminal or as a background agent, so it cannot be',
        '             resumed from here. A handoff to it is refused.',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description:
                    'Match against the title, the directory and the branch. Omit to list '
                    + 'everything, most recently active first.',
            },
            project: {
                type: 'string',
                description: 'Absolute path of a project to restrict to.',
            },
            limit: {
                type: 'integer',
                description: 'How many to return. Defaults to 30.',
            },
        },
    },
};

const MESSAGE = {
    name: 'message_session',
    title: 'Hand work to another session',
    description: [
        'Tell another session something it needs to know, and wake it up to deal',
        'with it. It does not have to be running: an idle session is resumed and',
        'your message becomes its next turn.',
        '',
        'Use this when the work you just did creates work somewhere else — you',
        'changed an API and the session that owns the client has to follow, you',
        'renamed a column and the importer still references it, you found the bug',
        'but it lives in a checkout somebody else is holding. Find the session with',
        'list_sessions first.',
        '',
        'Write `text` for an agent that has none of your context. Name the files',
        'you changed, say what changed about them, and say what you expect it to',
        'do. "I updated the API" is useless; "GET /api/sites now returns',
        '{sites:[...]} instead of a bare array, and web/app.js:412 still unwraps',
        'the old shape" is not.',
        '',
        'The session you wake resumes in plan mode, so it will investigate and come',
        'back with a plan for the user to approve rather than start editing. That is',
        'deliberate — you are handing over a fact, not issuing an order.',
        '',
        'One handoff per session. If you have more to say, say it in your reply',
        'rather than sending again; a second message to the same session a minute',
        'later is refused. Do not use this to chat, to ask something you could find',
        'out yourself, or to pass on work you were asked to do now.',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            sessionId: {
                type: 'string',
                description: 'The id of the session to hand this to, from list_sessions.',
            },
            text: {
                type: 'string',
                description: 'The message. Self-contained, names the files, says what you expect.',
            },
            title: {
                type: 'string',
                description: 'A short label for the card — a few words, not a sentence.',
            },
        },
        required: ['sessionId', 'text'],
    },
};

// A task is addressed by where it came from and which call filed it. Printed by
// find_tasks, so the model copies it rather than assembling it.
const TASK_REF_HELP = 'The task, as the `task:` line find_tasks prints '
    + '(<sourceSessionId>:<toolUseId>).';

// Offered to the model, and deliberately short of bypassPermissions — see the
// header.
const AGENT_MODES = ['plan', 'auto', 'acceptEdits', 'dontAsk'];

const FIND_TASKS = {
    name: 'find_tasks',
    title: 'Search suggested tasks',
    description: [
        'Search the follow-up tasks sessions have filed with suggest_session —',
        'yours or any other — with what has happened to each.',
        '',
        '`status` is one of:',
        '  open       offered, nobody has acted on it.',
        '  started    taken up; `started in` names the session doing it.',
        '  completed  somebody said it was done (set_task_status), often with a note.',
        '  dismissed  waved away.',
        '',
        'Results are oldest first, so a set of tasks filed in build order reads in',
        'that order. Use `session: "self"` for the ones this session filed.',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Words that must all appear in the title, the prompt, the reason '
                    + 'or the title of the session that filed it.',
            },
            session: {
                type: 'string',
                description: 'Only tasks filed by this session id, or "self" for this session.',
            },
            project: {
                type: 'string',
                description: 'Absolute path of a project to restrict to.',
            },
            status: {
                type: 'array',
                items: { type: 'string', enum: ['open', 'started', 'completed', 'dismissed'] },
                description: 'Only these statuses. Omit for all of them.',
            },
            limit: { type: 'integer', description: 'How many to return. Defaults to 50.' },
            full: {
                type: 'boolean',
                description: 'Print every prompt in full. Prompts are shortened when more '
                    + 'than three tasks match.',
            },
        },
    },
};

const START_TASK = {
    name: 'start_task',
    title: 'Take up a suggested task',
    description: [
        'Take up an open task from find_tasks. Two ways:',
        '',
        '  as: "session"   start it as a new session of its own, which runs on its',
        '                  own and shows up in the user\'s sidebar. Returns its id.',
        '  as: "subagent"  claim it for this session and get its full prompt back,',
        '                  so you can run it now with your Agent tool. This does not',
        '                  run anything itself — you do.',
        '',
        'Either way the task is marked started, so nobody else takes it up. A task',
        'that is not open is refused, with who has it — do not work around that.',
        'When the work is done, call set_task_status with status "completed" and a',
        'note saying where the result is (a pull request URL is ideal).',
        '',
        '`extra` is added to the end of the task\'s prompt — instructions of your own,',
        'such as which branch to start from or that it should open a pull request.',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            task: { type: 'string', description: TASK_REF_HELP },
            as: { type: 'string', enum: ['session', 'subagent'] },
            extra: {
                type: 'string',
                description: 'Added after the task\'s own prompt.',
            },
            permissionMode: {
                type: 'string',
                enum: AGENT_MODES,
                description: 'For as: "session" only. Defaults to plan, the same as the '
                    + 'Start button: the new session investigates and waits for the user '
                    + 'to approve. Pick another only when nobody will be there to approve.',
            },
            cwd: {
                type: 'string',
                description: 'For as: "session" only. Where to run; defaults to where the '
                    + 'task was filed.',
            },
        },
        required: ['task', 'as'],
    },
};

const SET_TASK_STATUS = {
    name: 'set_task_status',
    title: 'Mark a suggested task done, dismissed or open',
    description: [
        'Record what happened to a task.',
        '',
        '  completed  the work is done. Put where it is in `note` — a PR URL.',
        '  dismissed  it should not be done, or is no longer needed. Say why in `note`.',
        '  open       undo: offer it again.',
        '',
        'Mark a task completed only when its work actually exists, not when you have',
        'merely started it — start_task already recorded that.',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            task: { type: 'string', description: TASK_REF_HELP },
            status: { type: 'string', enum: ['completed', 'dismissed', 'open'] },
            note: { type: 'string', description: 'One line: the PR, or why. Up to 500 characters.' },
        },
        required: ['task', 'status'],
    },
};

const SCHEDULE = {
    name: 'schedule_session',
    title: 'Schedule a session',
    description: [
        'Start a new session later, unattended: once at a date and time (`at`), or',
        'repeatedly on a cron expression (`cron`). It shows up in the user\'s',
        'Schedules panel, marked as made by this session, and they can edit, pause or',
        'delete it there.',
        '',
        'Only do this when the user asked for something to happen later. Write',
        '`prompt` for an agent with none of your context, and remember nobody will be',
        'watching when it runs — it cannot ask questions, so say what to do when',
        'something is unclear.',
        '',
        'The usual pattern for working through suggested tasks later: file them with',
        'suggest_session, then schedule a session whose prompt tells it to call',
        'find_tasks with this session\'s id and status "open", take each one up with',
        'start_task in order, and set_task_status "completed" with the PR URL as each',
        'is finished. Put this session\'s id in that prompt — it is printed below.',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'The first message the session starts with.' },
            at: {
                type: 'string',
                description: 'When to run, once: a local date and time such as '
                    + '2026-09-25T09:00. Must be in the future and within a year.',
            },
            cron: {
                type: 'string',
                description: 'For a repeating schedule instead: five-field cron in local time, '
                    + 'e.g. "0 2 * * 1-5". Give at or cron, not both.',
            },
            title: { type: 'string', description: 'A short name for the schedule.' },
            permissionMode: {
                type: 'string',
                enum: AGENT_MODES,
                description: 'Defaults to auto. plan would stop at a plan nobody is there to '
                    + 'approve; dontAsk runs without asking and is refused anything not '
                    + 'already allowed.',
            },
            cwd: {
                type: 'string',
                description: "Where to run. Defaults to this session's project.",
            },
            model: { type: 'string', description: 'Model for the run. Defaults to the usual one.' },
        },
        required: ['prompt'],
    },
};

const TOOLS = [SUGGEST, LIST, MESSAGE, FIND_TASKS, START_TASK, SET_TASK_STATUS, SCHEDULE];

// What comes back to the model after a suggestion. It says the offer was made
// and, more usefully, says not to go and do it — an agent told only "ok"
// reasonably concludes it should now start the work itself, which is the
// opposite of suggesting it.
const ACCEPTED =
    'Recorded. This is now offered to the user in TGXCode as a follow-up '
    + 'they can start in one click. Do not start it yourself, and do not do the '
    + 'work now — mention it in your reply and move on.';

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

function reply(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function fail(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

/** Text back to the model. */
function say(id, body) {
    return reply(id, { content: [{ type: 'text', text: body }] });
}

/**
 * Refused as a tool error rather than a JSON-RPC one, so the model reads it as
 * "that call was wrong" and can fix it, instead of as a transport failure it can
 * do nothing about.
 */
function toolError(id, body) {
    return reply(id, { isError: true, content: [{ type: 'text', text: body }] });
}

/** What the bridge said went wrong. Its refusals are already written to be read. */
function msgOf(r) {
    if (r.body && typeof r.body.error === 'string') return r.body.error;
    return `TGXCode answered ${r.status || 'nothing'}`;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

function callSuggest(id, args) {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) {
        return toolError(id,
            'prompt is required — write the first message the new session should get.');
    }
    return say(id, ACCEPTED);
}

async function callList(id, args) {
    const params = new URLSearchParams();
    if (typeof args.query === 'string' && args.query.trim()) params.set('q', args.query.trim());
    if (typeof args.project === 'string' && args.project.trim()) {
        params.set('project', args.project.trim());
    }
    const limit = Number(args.limit);
    params.set('limit', String(limit > 0 ? Math.min(Math.floor(limit), 200) : 30));
    // So the list can mark this session, which is the one row the model must not
    // pick. Cheaper than a refusal it has to read and try again after.
    if (SESSION_ID) params.set('from', SESSION_ID);

    const r = await api('GET', `/api/sessions/addressable?${params}`);
    if (r.error) return toolError(id, r.error);
    if (!r.ok) return toolError(id, msgOf(r));

    const rows = (r.body && r.body.sessions) || [];
    if (!rows.length) return say(id, 'No sessions matched.');

    // Rendered rather than handed over as JSON: the model has to *pick* one, and
    // a line per session with the id under it reads better for that than a
    // nested object it has to walk.
    const lines = rows.map((s) => {
        const head = [s.title || '(untitled)', `[${s.state}]`];
        if (s.branch) head.push(s.branch);
        else if (s.projectName) head.push(s.projectName);
        if (s.self) head.push('— this session, you cannot message yourself');
        return `${head.join('  ')}\n    ${s.cwd || ''}\n    sessionId: ${s.sessionId}`;
    });
    const head = `${rows.length} session${rows.length === 1 ? '' : 's'}`;
    return say(id, `${head}, most recently active first:\n\n${lines.join('\n\n')}`);
}

async function callMessage(id, args) {
    const target = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
    const body = typeof args.text === 'string' ? args.text.trim() : '';
    if (!target) {
        return toolError(id,
            'sessionId is required — use list_sessions to find the session you mean.');
    }
    if (!body) {
        return toolError(id, 'text is required — write what the other session needs to know.');
    }

    const r = await api('POST', `/api/sessions/${encodeURIComponent(target)}/handoff`, {
        from: SESSION_ID,
        text: body,
        title: typeof args.title === 'string' ? args.title.trim() : null,
    });
    if (r.error) return toolError(id, r.error);
    // Every refusal the route makes is written for a model to read, so it goes
    // through verbatim rather than wrapped in a second sentence.
    if (!r.ok) return toolError(id, msgOf(r));

    const woke = !!(r.body && r.body.woke);
    const queued = !!(r.body && r.body.queued);
    const how = woke
        ? 'That session had no process, so it was resumed and your message is its first turn.'
        : queued
            ? 'That session is mid-turn, so your message is queued behind what it is doing.'
            : 'That session picked your message up as its next turn.';
    return say(id, [
        `Delivered. ${how}`,
        'It resumes in plan mode and will come back with a plan for the user rather than a',
        'finished change. Do not send again, and do not do the work yourself — say in your',
        'reply that you handed it over, and move on.',
    ].join(' '));
}

/** `<sessionId>:<toolUseId>` → the two halves, or null. */
function parseTaskRef(ref) {
    const s = typeof ref === 'string' ? ref.trim() : '';
    const i = s.indexOf(':');
    if (i <= 0 || i === s.length - 1) return null;
    return { sessionId: s.slice(0, i), toolUseId: s.slice(i + 1) };
}

const SHORT_PROMPT = 400;

function renderTask(t, { full }) {
    const where = t.session && (t.session.title || t.session.projectName);
    const lines = [`${t.title || '(untitled)'}  [${t.status}]`, `    task: ${t.sessionId}:${t.id}`];
    if (where) lines.push(`    filed by: ${where} (${t.sessionId})`);
    if (t.startedId) {
        lines.push(`    started in: ${t.startedId}${t.via === 'subagent' ? ' (as a subagent)' : ''}`);
    }
    if (t.note) lines.push(`    note: ${t.note}`);
    if (t.cwd) lines.push(`    cwd: ${t.cwd}`);
    if (t.why) lines.push(`    why: ${t.why}`);
    const prompt = String(t.prompt || '');
    const shown = full || prompt.length <= SHORT_PROMPT
        ? prompt
        : `${prompt.slice(0, SHORT_PROMPT)}… (shortened — pass full: true, or narrow the search)`;
    lines.push('    prompt:', ...shown.split('\n').map(l => `      ${l}`));
    return lines.join('\n');
}

async function callFindTasks(id, args) {
    const params = new URLSearchParams();
    if (typeof args.query === 'string' && args.query.trim()) params.set('q', args.query.trim());
    if (typeof args.session === 'string' && args.session.trim()) {
        const s = args.session.trim();
        if (s === 'self' && !SESSION_ID) {
            return toolError(id, 'this session does not know its own id, so "self" cannot be used');
        }
        params.set('session', s === 'self' ? SESSION_ID : s);
    }
    if (typeof args.project === 'string' && args.project.trim()) {
        params.set('project', args.project.trim());
    }
    const status = Array.isArray(args.status)
        ? args.status.filter(v => typeof v === 'string' && v.trim())
        : (typeof args.status === 'string' && args.status.trim() ? [args.status.trim()] : []);
    if (status.length) params.set('status', status.join(','));
    const limit = Number(args.limit);
    params.set('limit', String(limit > 0 ? Math.min(Math.floor(limit), 200) : 50));

    const r = await api('GET', `/api/suggestions?${params}`);
    if (r.error) return toolError(id, r.error);
    if (!r.ok) return toolError(id, msgOf(r));

    // The bridge answers newest first, for a board. Reversed here because a set
    // of tasks is usually filed in the order it should be built.
    const rows = ((r.body && r.body.suggestions) || []).slice().reverse();
    if (!rows.length) {
        return say(id, r.body && r.body.ready === false
            ? 'No tasks matched yet — TGXCode is still reading transcripts. Try again shortly.'
            : 'No tasks matched.');
    }
    const full = !!args.full || rows.length <= 3;
    const head = `${rows.length} task${rows.length === 1 ? '' : 's'}, oldest first:`;
    return say(id, `${head}\n\n${rows.map(t => renderTask(t, { full })).join('\n\n')}`);
}

function taskRoute(ref) {
    return `/api/sessions/${encodeURIComponent(ref.sessionId)}`
        + `/suggestions/${encodeURIComponent(ref.toolUseId)}`;
}

async function callStartTask(id, args) {
    const ref = parseTaskRef(args.task);
    if (!ref) return toolError(id, `task must look like <sessionId>:<toolUseId>. ${TASK_REF_HELP}`);
    const as = args.as;
    if (as !== 'session' && as !== 'subagent') {
        return toolError(id, 'as must be "session" or "subagent"');
    }
    const extra = typeof args.extra === 'string' ? args.extra.trim() : '';
    const mode = typeof args.permissionMode === 'string' ? args.permissionMode : null;
    if (mode && !AGENT_MODES.includes(mode)) {
        return toolError(id, `permissionMode must be one of ${AGENT_MODES.join(', ')}`);
    }

    if (as === 'session') {
        const r = await api('POST', `/api/suggestions/${encodeURIComponent(ref.sessionId)}/`
            + `${encodeURIComponent(ref.toolUseId)}/start`, {
            extra: extra || null,
            permissionMode: mode,
            cwd: typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : null,
            from: SESSION_ID,
        });
        if (r.error) return toolError(id, r.error);
        if (!r.ok) return toolError(id, msgOf(r));
        return say(id, [
            `Started as session ${r.body.sessionId}, in ${mode || 'plan'} mode.`,
            'It runs on its own; the task is marked started. When its work is done, mark it',
            'completed with set_task_status. Do not do the work yourself as well.',
        ].join(' '));
    }

    // As a subagent: find it, claim it, hand the prompt back. The claim is
    // `ifOpen`, so a second run racing this one is refused rather than both
    // going ahead.
    if (!SESSION_ID) {
        return toolError(id, 'this session does not know its own id, so it cannot claim a task');
    }
    const found = await api('GET', `/api/suggestions?session=${encodeURIComponent(ref.sessionId)}`);
    if (found.error) return toolError(id, found.error);
    if (!found.ok) return toolError(id, msgOf(found));
    const task = ((found.body && found.body.suggestions) || []).find(t => t.id === ref.toolUseId);
    if (!task) return toolError(id, 'no such task — check the ref with find_tasks');
    if (task.status !== 'open') {
        return toolError(id, `that task is already ${task.status}`
            + (task.startedId ? ` (session ${task.startedId})` : ''));
    }
    const claim = await api('POST', taskRoute(ref), {
        status: 'started', startedId: SESSION_ID, via: 'subagent', ifOpen: true,
    });
    if (claim.error) return toolError(id, claim.error);
    if (!claim.ok) return toolError(id, msgOf(claim));

    const prompt = extra ? `${task.prompt}\n\n---\n\n${extra}` : task.prompt;
    return say(id, [
        `Claimed "${task.title || 'task'}" for this session; it is marked started.`,
        'Run it now with your Agent tool, giving it exactly the prompt below. When it is',
        `done, call set_task_status with task "${ref.sessionId}:${ref.toolUseId}", status`,
        '"completed" and a note saying where the work is. If you decide not to run it after',
        'all, set it back to "open" so it is offered again.',
        task.cwd ? `The task was filed for ${task.cwd}.` : '',
        '',
        '--- prompt ---',
        prompt,
    ].join('\n'));
}

async function callSetTaskStatus(id, args) {
    const ref = parseTaskRef(args.task);
    if (!ref) return toolError(id, `task must look like <sessionId>:<toolUseId>. ${TASK_REF_HELP}`);
    const status = args.status;
    if (!['completed', 'dismissed', 'open'].includes(status)) {
        return toolError(id, 'status must be "completed", "dismissed" or "open"');
    }
    const r = await api('POST', taskRoute(ref), {
        // `open` is the absence of a decision, which the route spells as null.
        status: status === 'open' ? null : status,
        note: typeof args.note === 'string' ? args.note : null,
    });
    if (r.error) return toolError(id, r.error);
    if (!r.ok) return toolError(id, msgOf(r));
    return say(id, status === 'open'
        ? 'The task is open again and offered to the user.'
        : `Marked ${status}.`);
}

async function callSchedule(id, args) {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) {
        return toolError(id, 'prompt is required — write the message the session starts with.');
    }
    const at = typeof args.at === 'string' && args.at.trim() ? args.at.trim() : null;
    const cron = typeof args.cron === 'string' && args.cron.trim() ? args.cron.trim() : null;
    if (!at && !cron) return toolError(id, 'give at (a date and time) or cron');
    if (at && cron) return toolError(id, 'give at or cron, not both');
    const mode = typeof args.permissionMode === 'string' ? args.permissionMode : 'auto';
    if (!AGENT_MODES.includes(mode)) {
        return toolError(id, `permissionMode must be one of ${AGENT_MODES.join(', ')}`);
    }

    const r = await api('POST', '/api/schedules', {
        prompt,
        at,
        cron,
        title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : null,
        cwd: typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : null,
        model: typeof args.model === 'string' && args.model.trim() ? args.model.trim() : null,
        permissionMode: mode,
        from: SESSION_ID,
    });
    if (r.error) return toolError(id, r.error);
    if (!r.ok) return toolError(id, msgOf(r));

    const row = (r.body && r.body.schedule) || {};
    const next = row.nextRunAt ? new Date(row.nextRunAt).toString() : 'never';
    const lines = [
        `Scheduled: ${row.title || prompt.split('\n')[0]}`,
        `    id: ${row.id}`,
        `    when: ${row.cronText || row.cron}`,
        `    next run: ${next}`,
        `    runs in: ${row.cwd}, ${row.permissionMode} mode${row.test ? ', test only' : ''}`,
    ];
    if (SESSION_ID) lines.push(`    made by this session: ${SESSION_ID}`);
    lines.push('', 'The user can see and change it in the Schedules panel. '
        + 'Tell them it is set, and when.');
    return say(id, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function handle(msg) {
    const { id, method, params } = msg;
    // A notification has no id and takes no response — `notifications/initialized`
    // is the one that actually arrives. Answering it would be a protocol error.
    if (id === undefined || id === null) return;

    if (method === 'initialize') {
        const asked = params && params.protocolVersion;
        return reply(id, {
            protocolVersion: SPOKEN.has(asked) ? asked : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'tgxcode', version: '1.0.0' },
        });
    }

    if (method === 'tools/list') return reply(id, { tools: TOOLS });

    if (method === 'tools/call') {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        if (name === 'suggest_session') return callSuggest(id, args);
        if (name === 'list_sessions') return callList(id, args);
        if (name === 'message_session') return callMessage(id, args);
        if (name === 'find_tasks') return callFindTasks(id, args);
        if (name === 'start_task') return callStartTask(id, args);
        if (name === 'set_task_status') return callSetTaskStatus(id, args);
        if (name === 'schedule_session') return callSchedule(id, args);
        return toolError(id, `unknown tool: ${name}`);
    }

    // -32601 is JSON-RPC's "method not found". Anything else this client asks
    // for is something we genuinely do not implement, and saying so is better
    // than a silence it has to time out on.
    return fail(id, -32601, `unknown method: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        // No id to answer with, so there is nowhere to send an error. Dropping
        // it is what the spec asks for.
        return;
    }
    // Two of the three tools do I/O, so a call can still be in flight when the
    // next line arrives. Nothing here is ordered against anything else — every
    // reply carries its own id — so they are simply left to overlap.
    Promise.resolve()
        .then(() => handle(msg))
        .catch((err) => {
            if (msg && msg.id != null) fail(msg.id, -32603, String((err && err.message) || err));
        });
});

// The CLI closes our stdin when the session ends. Exiting on that rather than
// lingering keeps one of these from outliving the process that started it.
rl.on('close', () => process.exit(0));
