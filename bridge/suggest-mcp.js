'use strict';

// One tool, so an agent can hand the next piece of work over instead of
// mentioning it in a sentence nobody acts on.
//
// The case this exists for: an agent finishes, notices something real, and says
// "there's a shortcoming here, but that's outside the scope of this PR". It has
// already written the prompt for the session that would fix it. Without
// somewhere to put that, the thought dies in the transcript.
//
// **This server is stateless on purpose, and that is the whole design.** It
// records nothing and returns a sentence. The card the user sees is rendered
// from the `tool_use` entry the CLI writes to the transcript — the same way
// web/app.js already reads a pending ExitPlanMode out of a session this bridge
// does not own. Storing the suggestion here as well would be a second source of
// truth, and the one in the transcript is the one that survives a restart, a
// different window, and this process not being around.
//
// So there is nothing to persist, nothing to lock, and nothing to clean up. The
// only state the app owns is whether you *acted* on a suggestion, which is a
// decision you made rather than something the agent said — that lives in
// bridge/suggestions.js beside flags.json.
//
// Spoken protocol is MCP over stdio: JSON-RPC 2.0, one object per line. Written
// out by hand rather than pulled in, because this repo has no node_modules and
// is not about to grow one for three methods. See bridge/runner.js, which passes
// this file to `claude --mcp-config`.

const readline = require('readline');

// Named when a client asks for something we don't recognise. MCP wants the
// server to state a version it speaks rather than guess at the client's.
const PROTOCOL_VERSION = '2025-06-18';

// Versions we are happy to be spoken to in. The wire shape of the three methods
// below has not changed across them, so agreeing is honest rather than hopeful.
const SPOKEN = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

const TOOL = {
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

// What comes back to the model. It says the offer was made and, more usefully,
// says not to go and do it — an agent told only "ok" reasonably concludes it
// should now start the work itself, which is the opposite of suggesting it.
const ACCEPTED =
    'Recorded. This is now offered to the user in Claude Sessions as a follow-up '
    + 'they can start in one click. Do not start it yourself, and do not do the '
    + 'work now — mention it in your reply and move on.';

function reply(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function fail(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function handle(msg) {
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

    if (method === 'tools/list') return reply(id, { tools: [TOOL] });

    if (method === 'tools/call') {
        const args = (params && params.arguments) || {};
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        // Refused as a tool error rather than a JSON-RPC one, so the model reads
        // it as "that call was wrong" and can fix it, instead of as a transport
        // failure it can do nothing about.
        if (!prompt) {
            return reply(id, {
                isError: true,
                content: [{
                    type: 'text',
                    text: 'prompt is required — write the first message the new session should get.',
                }],
            });
        }
        return reply(id, { content: [{ type: 'text', text: ACCEPTED }] });
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
    try {
        handle(msg);
    } catch (err) {
        if (msg && msg.id != null) fail(msg.id, -32603, String((err && err.message) || err));
    }
});

// The CLI closes our stdin when the session ends. Exiting on that rather than
// lingering keeps one of these from outliving the process that started it.
rl.on('close', () => process.exit(0));
