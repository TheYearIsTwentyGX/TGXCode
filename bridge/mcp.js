'use strict';

// The tools this app gives a session that it would not otherwise have.
//
// Three of them, and they exist for the same reason: a session knows something
// the next piece of work needs, and until now had nowhere to put it.
//
//   suggest_session  — offer the user a follow-up they can start in one click.
//   list_sessions    — find out which other sessions exist, live or not.
//   message_session  — hand a fact to one of them, waking it if it is idle.
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
// CLAUDE_SESSIONS_PORT from a session's environment on purpose (see the header
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
                error: 'no bridge port was passed to this tool, so it cannot reach Claude Sessions',
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
                'X-Claude-Sessions-Client': '1',
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
            error: `could not reach Claude Sessions on port ${PORT}: ${err.message}`,
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
        'Every session Claude Sessions knows about — including ones that are not',
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
        '{sites:[...]} instead of a bare array, and web/mobile.js:412 still unwraps',
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

const TOOLS = [SUGGEST, LIST, MESSAGE];

// What comes back to the model after a suggestion. It says the offer was made
// and, more usefully, says not to go and do it — an agent told only "ok"
// reasonably concludes it should now start the work itself, which is the
// opposite of suggesting it.
const ACCEPTED =
    'Recorded. This is now offered to the user in Claude Sessions as a follow-up '
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
    return `Claude Sessions answered ${r.status || 'nothing'}`;
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
            serverInfo: { name: 'claude-sessions', version: '1.0.0' },
        });
    }

    if (method === 'tools/list') return reply(id, { tools: TOOLS });

    if (method === 'tools/call') {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        if (name === 'suggest_session') return callSuggest(id, args);
        if (name === 'list_sessions') return callList(id, args);
        if (name === 'message_session') return callMessage(id, args);
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
