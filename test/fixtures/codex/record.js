#!/usr/bin/env node
'use strict';

// Records a real `codex app-server` conversation as a replay fixture.
//
//   node test/fixtures/codex/record.js <scenario> [--home DIR] [--keep]
//   node test/fixtures/codex/record.js --list
//
// Each scenario is a short script against bridge/codex/client.js. Every message
// in both directions is written to `<scenario>.ndjson` here, one per line:
//
//   {"dir":"send"|"recv","t":<ms since start>,"msg":{…}}
//
// and, when the scenario started a thread, the rollout file Codex wrote for it is
// copied beside it as `<scenario>.rollout.jsonl` (forks get one per thread). The
// replay stub, `stub.js`, plays the `recv` lines back to a client that sends the
// same `send` lines, which is what test/codex-rpc.test.js does.
//
// The cwd is always a fresh directory under /tmp and never this repo: a turn can
// run commands and write files. `--home` points CODEX_HOME somewhere else, which
// is how the signed-out fixtures were recorded without touching ~/.codex; the
// signed-in ones need the home that `codex login` wrote to.
//
// The repo is public, so what is written is scrubbed: $HOME becomes /home/user,
// and an email, a ChatGPT user or account id, and anything that looks like a
// bearer token become placeholders. Look at a new recording before committing
// it anyway — the scrub only knows the shapes it was written for.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnAppServer, initialize } = require('../../../bridge/codex/client');
const { RpcError } = require('../../../bridge/codex/rpc');

const HERE = __dirname;

// ---- the scrub --------------------------------------------------------------

const scrubbers = [];
function addSecret(value, placeholder) {
    if (typeof value === 'string' && value.length >= 6) scrubbers.push([value, placeholder]);
}
addSecret(os.homedir(), '/home/user');

// The login name turns up in `ls -l` output a turn ran, at any length.
const LOGIN = os.userInfo().username;
const LOGIN_RE = new RegExp(`\\b${LOGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');

function scrub(text) {
    let out = text;
    for (const [v, p] of scrubbers) out = out.split(v).join(p);
    return out
        .replace(LOGIN_RE, 'user')
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.com')
        .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>')
        .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '<api-key>');
}

/** Learn identifiers from an account/read result, so they are scrubbed everywhere. */
function learnAccount(result) {
    if (!result) return;
    addSecret(result.userId, 'user-00000000');
    const a = result.account || {};
    addSecret(a.email, 'user@example.com');
    addSecret(a.accountId, 'account-00000000');
    addSecret(a.userId, 'user-00000000');
    addSecret(a.chatgptUserId, 'user-00000000');
    addSecret(a.chatgptAccountId, 'account-00000000');
    const w = result.workspaceRouting || {};
    addSecret(w.chatgptAccountId, 'account-00000000');
    addSecret(w.accountId, 'account-00000000');
}

// ---- a recording session ------------------------------------------------------

/** The rollout of thread `id` under `<home>/sessions`, newest days first, or null. */
function findRollout(home, id) {
    const walk = (dir, depth) => {
        let names;
        try { names = fs.readdirSync(dir).sort().reverse(); } catch { return null; }
        for (const n of names) {
            const full = path.join(dir, n);
            if (depth === 0) { if (n.includes(id) && n.endsWith('.jsonl')) return full; continue; }
            const hit = walk(full, depth - 1);
            if (hit) return hit;
        }
        return null;
    };
    return walk(path.join(home, 'sessions'), 3);
}

class Recording {
    constructor(name, { home }) {
        this.name = name;
        this.lines = [];
        this.t0 = Date.now();
        this.threads = new Map();   // threadId → rollout path
        this.cwd = fs.mkdtempSync(path.join('/tmp', `codex-fixture-${name}-`));
        const env = { ...process.env };
        if (home) env.CODEX_HOME = home;
        this.codexHome = home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
        try {
            const codexHome = this.codexHome;
            addSecret(fs.readFileSync(path.join(codexHome, 'installation_id'), 'utf8').trim(),
                'installation-00000000');
        } catch { /* none yet */ }
        // The scratch dir is not a git repo, and Codex asks before trusting one
        // that is not; say it is trusted up front so the turn is about the scenario.
        this.server = spawnAppServer({
            cwd: this.cwd, env,
            config: [`projects."${this.cwd}".trust_level="trusted"`],
            log: (l) => console.error('[rpc] ' + l),
            timeoutMs: 120000,
        });
        this.rpc = this.server.rpc;
        this.rpc.on('send', (msg) => this._log('send', msg));
        this.rpc.on('message', (msg) => this._log('recv', msg));
        this.waiters = [];
        this.rpc.on('message', (msg) => {
            for (const w of [...this.waiters]) {
                if (msg.method === w.method && w.pred(msg.params || {}, msg)) {
                    this.waiters.splice(this.waiters.indexOf(w), 1);
                    clearTimeout(w.timer);
                    w.resolve(msg.params);
                }
            }
        });
    }

    _log(dir, msg) {
        this.lines.push({ dir, t: Date.now() - this.t0, msg });
        if (msg.result && msg.result.thread && msg.result.thread.id) {
            this.threads.set(msg.result.thread.id, msg.result.thread.path || null);
        }
        // A subagent's thread is never a reply to us: it is announced.
        const announced = msg.method === 'thread/started' && msg.params && msg.params.thread;
        if (announced && announced.id && !this.threads.has(announced.id)) {
            this.threads.set(announced.id, announced.path || null);
        }
        // Nor is it always announced: on 0.172.0 a spawned agent's thread is only
        // named by the parent's `subAgentActivity` item, and its path is found on
        // disk at the end.
        const item = msg.params && msg.params.item;
        if (item && item.type === 'subAgentActivity' && item.agentThreadId
            && !this.threads.has(item.agentThreadId)) {
            this.threads.set(item.agentThreadId, null);
        }
    }

    /** Resolve with the params of the next message with this method that passes pred. */
    waitFor(method, pred = () => true, ms = 180000) {
        return new Promise((resolve, reject) => {
            const w = { method, pred, resolve };
            w.timer = setTimeout(() => {
                this.waiters.splice(this.waiters.indexOf(w), 1);
                reject(new Error(`timed out waiting for ${method}`));
            }, ms);
            this.waiters.push(w);
        });
    }

    async init() {
        return initialize(this.rpc, { version: '0.0.0-fixture' });
    }

    async account() {
        const r = await this.rpc.request('account/read', { refreshToken: false });
        learnAccount(r);
        return r;
    }

    async startThread(extra = {}) {
        const r = await this.rpc.request('thread/start', {
            cwd: this.cwd, historyMode: 'paginated', ...extra,
        });
        // The model is on the response, not the thread; plan mode has to name it.
        return { ...r.thread, model: r.model };
    }

    /** Start a turn and resolve with its turn/completed params. */
    async turn(threadId, text, extra = {}) {
        const done = this.waitFor('turn/completed', (p) => p.threadId === threadId);
        await this.rpc.request('turn/start', {
            threadId, input: [{ type: 'text', text }], ...extra,
        });
        return done;
    }

    async finish({ keep }) {
        this.rpc.close('recording finished');
        this.server.child.stdin.end();
        await new Promise((r) => {
            const k = setTimeout(() => { this.server.child.kill('SIGKILL'); r(); }, 5000);
            this.server.child.once('exit', () => { clearTimeout(k); r(); });
            this.server.child.kill('SIGTERM');
        });
        const out = path.join(HERE, `${this.name}.ndjson`);
        fs.writeFileSync(out, this.lines.map(l => scrub(JSON.stringify(l))).join('\n') + '\n');
        console.error(`wrote ${path.relative(process.cwd(), out)} (${this.lines.length} messages)`);
        let n = 0;
        for (const [id, known] of this.threads) {
            const file = known || findRollout(this.codexHome, id);
            if (!file || !fs.existsSync(file)) {
                console.error(`  thread ${id}: no rollout on disk${file ? '' : ' (no path)'}`);
                continue;
            }
            const suffix = this.threads.size > 1 ? `.${n}` : '';
            const dest = path.join(HERE, `${this.name}${suffix}.rollout.jsonl`);
            fs.writeFileSync(dest, scrub(fs.readFileSync(file, 'utf8')));
            console.error(`  thread ${id}: ${path.relative(process.cwd(), dest)}`);
            n++;
        }
        if (!keep) fs.rmSync(this.cwd, { recursive: true, force: true });
        else console.error(`  cwd kept: ${this.cwd}`);
    }
}

// ---- scenarios ----------------------------------------------------------------

const ASK = { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } };

/** Answer every requestUserInput question with its first option. */
function answerFirst(p) {
    const answers = {};
    for (const q of p.questions || []) {
        const o = (q.options || [])[0];
        answers[q.id] = { answers: [o ? o.label : 'blue'] };
    }
    return { answers };
}

const SCENARIOS = {
    /** What a second initialize and a request before the first one are told. */
    async handshake(r) {
        await r.rpc.request('thread/list', {}).catch(e => e);
        await r.init();
        await r.rpc.request('initialize', { clientInfo: { name: 'tgxcode', version: '0' } }).catch(e => e);
    },

    /** Signed out: what account/read says, that thread/start works, and the 401'd turn. */
    async 'signed-out'(r) {
        await r.init();
        await r.account();
        await r.rpc.request('model/list', {}).catch(e => e);
        const t = await r.startThread();
        await r.turn(t.id, 'Reply with the single word: pong');
    },

    async plain(r) {
        await r.init();
        await r.account();
        await r.rpc.request('model/list', {});
        await r.rpc.request('account/rateLimits/read', {}).catch(e => e);
        const t = await r.startThread();
        await r.turn(t.id, 'Reply with the single word: pong. Do not run any commands.');
    },

    async 'command-approval'(r) {
        await r.init();
        await r.account();
        r.rpc.handle('item/commandExecution/requestApproval', () => ({ decision: 'accept' }));
        const t = await r.startThread(ASK);
        await r.turn(t.id, 'Use the shell to run exactly this command: touch made-by-codex.txt',
            ASK);
    },

    async 'file-change-approval'(r) {
        await r.init();
        await r.account();
        fs.writeFileSync(path.join(r.cwd, 'notes.txt'), 'first line\n');
        r.rpc.handle('item/fileChange/requestApproval', () => ({ decision: 'accept' }));
        // Under `untrusted` even `cat -n notes.txt` asks (measured), so let reads
        // through and stop anything else, which would be the shell editing the file.
        r.rpc.handle('item/commandExecution/requestApproval', (p) => ({
            decision: (p.commandActions || []).every(a => a.type === 'read') ? 'accept' : 'cancel',
        }));
        const t = await r.startThread(ASK);
        await r.turn(t.id, 'Edit notes.txt with your file-editing tool (not the shell): '
            + 'add a second line that says "second line". Make no other changes.', ASK);
    },

    async interrupt(r) {
        await r.init();
        await r.account();
        const free = { approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' } };
        const t = await r.startThread(free);
        const started = r.waitFor('item/started',
            (p) => p.item && p.item.type === 'commandExecution');
        const done = r.waitFor('turn/completed', (p) => p.threadId === t.id);
        const turn = await r.rpc.request('turn/start', { threadId: t.id,
            input: [{ type: 'text', text: 'Use the shell to run exactly: sleep 60' }], ...free });
        await started;
        await r.rpc.request('turn/interrupt', { threadId: t.id, turnId: turn.turn.id });
        await done;
    },

    async fork(r) {
        await r.init();
        await r.account();
        const t = await r.startThread();
        await r.turn(t.id, 'Remember the word "heron". Reply with just: ok');
        const f = await r.rpc.request('thread/fork', { threadId: t.id, excludeTurns: true });
        await r.turn(f.thread.id, 'What word did I ask you to remember? One word.');
    },

    async 'request-user-input'(r) {
        await r.init();
        await r.account();
        r.rpc.handle('item/tool/requestUserInput', answerFirst);
        const t = await r.startThread();
        const model = t.model;
        await r.turn(t.id, 'Before doing anything else, use your request_user_input tool (the '
            + 'blocking one) to ask me which colour I prefer, offering red and blue. '
            + 'Then reply with just the colour I chose.',
        { collaborationMode: { mode: 'plan', settings: { model } } });
    },

    /** The blocking tool, named, in default mode: does Codex allow it there? */
    async 'request-user-input-default'(r) {
        await r.init();
        await r.account();
        r.rpc.handle('item/tool/requestUserInput', answerFirst);
        const t = await r.startThread();
        await r.turn(t.id, 'Before doing anything else, use your request_user_input tool (the '
            + 'blocking one) to ask me which colour I prefer, offering red and blue. '
            + 'Then reply with just the colour I chose.');
    },

    /**
     * A question with no tool named, in default mode. The model's choice is not
     * stable: on 0.172.0 one run asked in plain text and ended the turn, another
     * asked and then called `sleep` for twelve hours. So the answer goes in as a
     * new turn if the turn ended, and as a steer if it is still running.
     */
    async 'ask-unprompted'(r) {
        await r.init();
        await r.account();
        r.rpc.handle('item/tool/requestUserInput', answerFirst);
        const t = await r.startThread();
        const asked = r.waitFor('item/completed', (p) => p.item && p.item.type === 'agentMessage');
        let ended = false;
        const done = r.waitFor('turn/completed', (p) => p.threadId === t.id).then(() => { ended = true; });
        const turn = await r.rpc.request('turn/start', { threadId: t.id, input: [{ type: 'text',
            text: 'Ask me whether I prefer red or blue, and wait for my answer before you '
                + 'reply with anything else. Then reply with just the colour.' }] });
        await asked;
        await new Promise(res => setTimeout(res, 4000));
        if (ended) {
            await r.turn(t.id, 'blue');
        } else {
            await r.rpc.request('turn/steer', { threadId: t.id, expectedTurnId: turn.turn.id,
                input: [{ type: 'text', text: 'blue' }] });
            await done;
        }
    },

    /**
     * A steer while a command runs, and then one after the turn has ended — the
     * second is refused, and that refusal is the case the runner has to handle
     * when a message races the end of a turn.
     */
    async steer(r) {
        await r.init();
        await r.account();
        const free = { approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' } };
        const t = await r.startThread(free);
        const started = r.waitFor('item/started', (p) => p.item && p.item.type === 'commandExecution');
        const done = r.waitFor('turn/completed', (p) => p.threadId === t.id);
        const turn = await r.rpc.request('turn/start', { threadId: t.id, input: [{ type: 'text',
            text: 'Use the shell to run exactly: sleep 8 — then reply with just the word done.' }],
        ...free });
        await started;
        await r.rpc.request('turn/steer', { threadId: t.id, expectedTurnId: turn.turn.id,
            input: [{ type: 'text', text: 'Change of plan: when the command finishes, reply with just the word heron instead.' }] });
        await done;
        await r.rpc.request('turn/steer', { threadId: t.id, expectedTurnId: turn.turn.id,
            input: [{ type: 'text', text: 'too late' }] }).catch(e => e);
    },

    /** The blocking tool in default mode, with the feature that allows it turned on. */
    async 'request-user-input-feature'(r) {
        await r.init();
        await r.account();
        r.rpc.handle('item/tool/requestUserInput', answerFirst);
        const t = await r.startThread({ config: { 'features.default_mode_request_user_input': true } });
        await r.turn(t.id, 'Before doing anything else, use your request_user_input tool (the '
            + 'blocking one) to ask me which colour I prefer, offering red and blue. '
            + 'Then reply with just the colour I chose.');
    },

    /**
     * Branching from a turn: three turns, then a fork through the second
     * (`lastTurnId`, inclusive) and a fork before it (`beforeTurnId`, which drops
     * it), with a turn on each so each child's rollout has lines of its own.
     */
    async branch(r) {
        await r.init();
        await r.account();
        const t = await r.startThread();
        const turns = [];
        for (const w of ['heron', 'otter', 'lynx']) {
            const done = await r.turn(t.id, `Remember the word "${w}". Reply with just: ok`);
            turns.push(done.turn.id);
        }
        const through = await r.rpc.request('thread/fork',
            { threadId: t.id, excludeTurns: true, lastTurnId: turns[1] });
        await r.turn(through.thread.id, 'List every word I asked you to remember, comma-separated. Nothing else.');
        const before = await r.rpc.request('thread/fork',
            { threadId: t.id, excludeTurns: true, beforeTurnId: turns[1] });
        await r.turn(before.thread.id, 'List every word I asked you to remember, comma-separated. Nothing else.');
    },

    /** The checklist: `update_plan`, opt-in on 0.172.0, turned on in the thread config. */
    async 'plan-update'(r) {
        await r.init();
        await r.account();
        const t = await r.startThread({ config: { 'tools.update_plan.enabled': true } });
        await r.turn(t.id, 'Use your update_plan tool to keep a three-step checklist while you '
            + 'work: (1) think of a colour, (2) think of an animal, (3) reply. Mark each step '
            + 'in progress and then completed as you go, calling update_plan after every change. '
            + 'Do not run any commands. Finally reply with just the colour and the animal.');
    },

    /** A skill from `skills/list`, sent as a `{type:"skill"}` input beside the text. */
    async skill(r) {
        await r.init();
        await r.account();
        const dir = path.join(r.cwd, '.agents', 'skills', 'say-heron');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: say-heron\ndescription: '
            + 'Replies with the word heron and nothing else.\n---\n\nWhen this skill is used, '
            + 'reply with exactly the word heron. Run no commands.\n');
        const list = await r.rpc.request('skills/list', { cwds: [r.cwd] });
        const entry = (list.data || []).find(d => d.cwd === r.cwd) || (list.data || [])[0];
        const skill = entry.skills.find(s => s.name === 'say-heron');
        const t = await r.startThread();
        await r.turn(t.id, '$say-heron', {});
        // And once with an argument after the name, as a palette sends it.
        const done = r.waitFor('turn/completed', (p) => p.threadId === t.id);
        await r.rpc.request('turn/start', { threadId: t.id, input: [
            { type: 'skill', name: skill.name, path: skill.path },
            { type: 'text', text: '$say-heron then add the word twice' },
        ] });
        await done;
    },

    /** A subagent: `spawn_agent`, a child thread with a `parentThreadId`, and its activity. */
    async subagent(r) {
        await r.init();
        await r.account();
        const t = await r.startThread();
        await r.turn(t.id, 'Spawn exactly one subagent and give it this task: reply with just the '
            + 'word heron. Wait for it to finish, then tell me what it replied, in one word. '
            + 'Run no commands yourself.');
    },

    async plan(r) {
        await r.init();
        await r.account();
        const t = await r.startThread();
        const model = t.model;
        await r.turn(t.id, 'Plan how to add a README.md that explains this directory is a '
            + 'scratch space. Keep the plan to three steps. Do not ask me questions.',
        { collaborationMode: { mode: 'plan', settings: { model } } });
    },
};

// ---- main -------------------------------------------------------------------

async function main() {
    const argv = process.argv.slice(2);
    if (argv[0] === '--list' || !argv[0]) {
        console.log(Object.keys(SCENARIOS).join('\n'));
        return;
    }
    const name = argv[0];
    const fn = SCENARIOS[name];
    if (!fn) throw new Error(`no scenario ${name}; --list shows them`);
    const at = (f) => { const i = argv.indexOf(f); return i < 0 ? null : argv[i + 1]; };
    const r = new Recording(name, { home: at('--home') });
    try {
        await fn(r);
    } catch (e) {
        console.error(`scenario failed: ${e instanceof RpcError ? `${e.code} ${e.message}` : e.stack}`);
        process.exitCode = 1;
    } finally {
        await r.finish({ keep: argv.includes('--keep') });
    }
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
