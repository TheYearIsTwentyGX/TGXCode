'use strict';

// Drives `claude` processes on behalf of the UI.
//
// Each conversation the user is chatting with gets one long-lived process
// started with `--input-format stream-json --output-format stream-json`. That
// keeps the session warm across turns: send a JSON line on stdin, read events
// off stdout. Resuming reuses the original session id and appends to the same
// transcript, so a session driven from here is indistinguishable on disk from
// one driven from a terminal.
//
// Note on content: the UI does *not* render from this stream. It renders from
// the transcript file, which the index tails — that way a session running in
// somebody's terminal looks exactly like one this app started. What the runner
// contributes is liveness: is a turn in flight, which tool is executing, did the
// process die. Keeping the two concerns apart avoids de-duplicating the same
// message from two sources.
//
// The same stream is also used *backwards*, as a control channel. Alongside the
// user turns we write, `claude` and the bridge exchange correlated
// control_request/control_response pairs. Two of them matter here:
//
//   can_use_tool  — inbound. The CLI is asking whether a tool call may run.
//                   Without an answer it blocks, which is what makes a real
//                   approval prompt possible instead of the silent denial
//                   headless mode does by default. Enabled by
//                   `--permission-prompt-tool stdio`.
//   interrupt     — outbound. Ends the turn where it stands without killing the
//                   process, so the session stays resumable and no tool result
//                   is left half-written.
//   set_permission_mode
//                 — outbound. Changes the mode of the running process. Used when
//                   a plan is approved: the session has to leave plan mode or
//                   the work it just agreed to is refused.
//
// Two of the tools that come through can_use_tool are not really permission
// questions at all — they are the model talking to the user:
//
//   ExitPlanMode     — "here is the plan, may I start?". Allowing it is approval;
//                      denying it with a message is feedback, and the model
//                      plans again with that message in hand.
//   AskUserQuestion  — a multiple-choice question. The answer goes back in
//                      `updatedInput.answers`, keyed by question text, and the
//                      tool result echoes it to the model.
//
// Both arrive flagged `requires_user_interaction`, which for an ordinary tool
// means "this needs a dialog we cannot draw, so deny it". For these two the
// dialog is exactly what this app can draw, so they are carved out of that rule
// and answered properly instead of being turned away.
//
// A permission ask is state about a turn, not content of it, so it lives here
// next to the other liveness state and never goes near the transcript. The real
// record of what was allowed or denied still arrives from the file.
//
// None of this is a documented, stable surface, so every part of it is written
// to degrade rather than break: an unrecognised subtype is answered and ignored,
// a CLI that rejects the flag falls back to permission modes alone, and an
// interrupt that does not land falls through to the signal path.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');

const cfg = require('./config');

const { CLAUDE_BIN } = cfg;
const { describeTool } = require('./transcript');
const { ATTACHMENT_NOTE_HEAD, attachmentNoteLine } = require('./attachments');

// Queue entry ids only have to be unique per process; the UI never persists one.
let queueSeq = 0;

/**
 * The environment a session runs in.
 *
 * A session inherits the bridge's environment, and `CLAUDE_SESSIONS_PORT` has no
 * business travelling down it. The bridge sets that variable for itself; an agent
 * that inherits it is holding the port of *this* instance, so a bridge it starts
 * while working on this codebase silently binds the everyday one — which is
 * exactly how a worktree came to be serving the user's window. An agent that
 * genuinely wants a port picks one, and `npm run dev` picks a free one for it.
 *
 * CLAUDE_CODE_ENTRYPOINT goes the other way: it is set here so the CLI knows what
 * started it.
 */
function sessionEnv() {
    const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-sessions' };
    delete env.CLAUDE_SESSIONS_PORT;
    return env;
}

// The tools this app gives a session that it would not otherwise have: offer the
// next piece of work as a suggestion, find the other sessions, and hand one of
// them a fact — waking it if it is idle. See bridge/mcp.js for what each does.
//
// Passed as a JSON *string* rather than a file — `--mcp-config` takes either, and
// a string means there is no temp file to write, collide on between two bridges,
// or leave behind. `process.execPath` rather than `node`, because the node that
// is already running us is the only one we know exists: a login shell has none
// on PATH, which is the whole reason bridge/launch.sh exists.
//
// Deliberately *not* `--strict-mcp-config`, which would switch off every MCP
// server the user configured for themselves. We are adding one, not taking over.
//
// **The port and the session id are arguments, and the token is not.** Two of
// these tools call back into this bridge, so the server has to know where it is
// — and `sessionEnv()` strips CLAUDE_SESSIONS_PORT on purpose, so the
// environment is not the channel. This string lands on the `claude` command
// line, where `ps` can read it, which is why the port travels here and the token
// is read off disk at the other end instead.
const AGENT_TOOLS = [
    'mcp__claude-sessions__suggest_session',
    'mcp__claude-sessions__list_sessions',
    'mcp__claude-sessions__message_session',
];

function mcpConfig(sessionId) {
    return JSON.stringify({
        mcpServers: {
            'claude-sessions': {
                command: process.execPath,
                args: [
                    path.join(__dirname, 'mcp.js'),
                    '--port', String(cfg.PORT),
                    '--session', sessionId,
                ],
            },
        },
    });
}

// Processes are cheap to restart (resume is a warm cache hit), so don't hoard them.
const MAX_LIVE = 4;
const IDLE_EVICT_MS = 15 * 60 * 1000;

const PERMISSION_MODES = ['auto', 'acceptEdits', 'plan', 'manual', 'dontAsk', 'bypassPermissions'];

/**
 * Which tools are a conversation rather than a permission question.
 * @type {Record<string, 'plan'|'question'>}
 */
const ASK_KINDS = { ExitPlanMode: 'plan', AskUserQuestion: 'question' };

// An outstanding ask never expires. It used to: two minutes for a tool call,
// fifteen for a plan or a question, on the theory that a blocked turn holds a
// process open and nobody may be there to answer. But the cost landed on the
// person who *was* there — you read a plan, thought about it, and the card was
// denied out from under you. Claude Code itself does not do that, so neither
// does this. The case that mattered is still covered, and covered up front
// rather than on a clock: _handlePermission denies immediately when no window
// is open to answer. Once a card is on screen it waits as long as you do, and
// a window that closes and comes back finds it again — statuses() hands the
// pending ask to every viewer that attaches.

// Requests we make of the CLI, where no answer means the version in front of us
// does not speak this part of the protocol. Short, because every one of them has
// a working fallback.
const CONTROL_TIMEOUT_MS = 8_000;

// Denying forever is a spin: the model retries, gets denied, retries. Stop the
// turn instead and say why.
const MAX_AUTO_DENIES = 2;

// Types the API accepts as an image source. Kept here rather than imported from
// bridge/attachments.js so the runner has no opinion about where files come from —
// it is handed a list and asked to send it.
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// A cap on what one turn will inline, independent of the per-file upload cap. Five
// 25MB screenshots base64'd is a 160MB line on a pipe, and the paths are in the text
// either way — so past this the model reads the file instead of being handed it.
const MAX_INLINE_BYTES = 12 * 1024 * 1024;

/**
 * The content blocks for one user turn.
 *
 * With nothing attached this is what it always was: one text block. With files on it,
 * three things are going on, and they are worth separating.
 *
 * **The note is split across blocks, one line each, with an image block sitting
 * straight after the line that names it.** `userText` in bridge/transcript.js joins a
 * turn's text blocks with a newline, so this reassembles into exactly the message a
 * single block would have carried — the parser on the way back does not know or care
 * that it arrived in pieces. What it buys is that each screenshot is labelled with the
 * file it came from. Two anonymous images on one turn are genuinely ambiguous, and
 * asked which was which the model said so; "the second screenshot" is a thing people
 * say, and this is what makes it answerable.
 *
 * **The base64 is read here**, at flush time, rather than carried on the queue entry.
 * A queued message is broadcast to every viewer inside `status()` on every change, and
 * a screenshot on that path would put megabytes through an SSE stream for reasons
 * unrelated to it.
 *
 * **A file that has gone missing since it was staged is skipped**, not fatal. Its path
 * is still in the note, so the message stays true either way: it says a file was
 * attached, and the model finds out it cannot read it in the ordinary way.
 */
function userContent(entry) {
    const files = entry.attachments || [];
    if (!files.length) return [{ type: 'text', text: entry.text }];

    // The note's heading rides on the end of the typed message rather than in a block
    // of its own, so the blank line between the two survives the rejoin.
    const content = [{
        type: 'text',
        text: entry.text ? `${entry.text}\n\n${ATTACHMENT_NOTE_HEAD}` : ATTACHMENT_NOTE_HEAD,
    }];

    let budget = MAX_INLINE_BYTES;
    for (const a of files) {
        content.push({ type: 'text', text: attachmentNoteLine(a) });
        if (!INLINE_IMAGE_TYPES.has(a.mediaType) || a.bytes > budget) continue;
        let data;
        try { data = fs.readFileSync(a.path); } catch { continue; }
        budget -= data.length;
        content.push({
            type: 'image',
            source: { type: 'base64', media_type: a.mediaType, data: data.toString('base64') },
        });
    }

    return content;
}

class Runner extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.sessionId
     * @param {string} opts.cwd
     * @param {boolean} opts.isNew   start a fresh session rather than resuming
     * @param {{permissionPrompt:boolean, interrupt:boolean}} [opts.caps]
     *   What this `claude` build has been observed to support. Shared across the
     *   pool, so one runner discovering a gap spares the rest from rediscovering
     *   it.
     */
    constructor(opts) {
        super();
        this.sessionId = opts.sessionId;
        this.cwd = opts.cwd;
        this.isNew = !!opts.isNew;
        this.model = opts.model || null;
        this.permissionMode = opts.permissionMode || 'auto';
        // Branch off a copy instead of continuing in place. Needed when the
        // original is already live somewhere else.
        this.fork = !!opts.fork;
        this.errorKind = null;
        this.retry = null;             // set while the CLI is retrying the API

        // What to call a turn in progress, and how long each word stands.
        // Supplied by the pool, which the server supplies from bridge/spinner.js.
        // Null is a real answer and the default one: no verb composes to exactly
        // what this app said before there were any.
        this.thinking = opts.thinking || (() => null);
        this.rerollAfter = opts.rerollAfter || (() => 0);
        this._verb = null;             // the themed word, drifting on its own clock
        this._detail = null;           // and what is specifically happening, if anything
        this._reroll = null;           // the timer moving the verb along

        this.proc = null;
        this.state = 'stopped';        // stopped | starting | idle | busy | error
        this.activity = null;          // human-readable "what is it doing right now"
        this.lastError = null;
        this.lastResult = null;        // {costUsd, durationMs, numTurns, isError}
        this.lastResultText = null;    // the turn's final text, tail-capped; never broadcast
        this.lastResultBody = null;    // the same text from the front; never broadcast
        this.lastUsedAt = Date.now();
        // Messages waiting their turn: {id, text, at}. Held here rather than
        // written straight through, so they stay visible and cancellable — see
        // _flushQueue.
        this.queue = [];
        // Queue *entries*, not their text. It used to hold strings, and the retry
        // path below concatenates this straight back onto `queue` — which meant a
        // resumed queue held strings where every reader expects `{id, text, at}`,
        // and the next flush wrote a turn with `text: undefined` in it. Entries
        // throughout, so the two arrays are one shape.
        this.inFlight = [];            // written to the process, not yet answered
        this._buf = '';
        this._stderr = '';
        this._pendingTools = new Map();

        // -- control channel ------------------------------------------------
        this.caps = opts.caps || { permissionPrompt: true, interrupt: true };
        /** Is anyone actually in a position to answer an approval card? */
        this.hasViewer = opts.hasViewer || (() => false);
        /** @type {null | {id:string, tool:string, input:object, askedAt:number}} */
        this.pendingPermission = null;
        this._ctlSeq = 0;
        this._pending = new Map();     // request_id -> {resolve, reject, timer}
        // Tools the user said yes to for the rest of this session. The CLI is
        // told too (destination "session"), so this only does work after a
        // process restart, when the CLI's own copy is gone and ours is not.
        this._sessionAllow = new Set();
        this._autoDenies = 0;
        // This process did not answer an interrupt in time. Not the same claim as
        // `caps.interrupt`, which is about the build and is shared by the whole
        // pool — see stop().
        this._interruptTimedOut = false;
    }

    // -- lifecycle ---------------------------------------------------------

    start() {
        if (this.proc) return;

        // A process that has just spawned cannot have anything in flight, and a
        // restart that succeeds is not still carrying the last one's failure.
        // Both belong to the process that went away; the close handler decided
        // what to do about the text, and this is only the invariant.
        //
        // **Clear, never re-queue.** It is tempting, because the entry holds the
        // only copy of the message — but `claude` writes its user entry at
        // submission, seconds before the first assistant block, so by the time a
        // process has died holding a turn that turn is usually already in the
        // transcript. Re-sending it here would re-run work the user watched
        // happen, or explicitly cancelled. The one exit where re-queueing is
        // provably safe does it itself, in `close`.
        this.inFlight.length = 0;
        this.lastError = null;
        this.errorKind = null;
        // A fresh process is not the one that was too busy to answer.
        this._interruptTimedOut = false;

        const args = [
            '-p',
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--verbose',
            '--permission-mode', this.permissionMode,
        ];
        // The whole point of the control channel: route "may I?" back to us
        // instead of letting headless mode answer "no" on the user's behalf.
        // `stdio` is the CLI's sentinel for "ask over this stream" rather than
        // the name of an MCP tool.
        if (this.caps.permissionPrompt) args.push('--permission-prompt-tool', 'stdio');
        // Filing a suggestion is the agent offering the user something, not the
        // agent doing anything, so it must never raise an approval card — a
        // permission prompt for "may I suggest this?" is noise nobody wants.
        // `--allowedTools` is an auto-approve list, not a restriction on which
        // tools exist; `--tools` is the one that would narrow the set.
        //
        // `message_session` is on that list too, and that one is a real choice:
        // it wakes another session, which is an effect outside this
        // conversation, and auto-approving it means a session in *plan* mode can
        // still cause one. The alternative was worse. A handoff exists precisely
        // because the sender is finishing and the recipient is not around, so
        // gating it on an approval card means it is auto-denied exactly when it
        // was needed (see _handlePermission, which denies with no window open)
        // and stalls until somebody looks the rest of the time. The containment
        // is put where it survives that: the woken session resumes in plan mode
        // and stops at a plan, and the bridge rate-limits the pair.
        //
        // One flag per tool. Repeating it is the form that has been checked
        // against a real session; whether a comma-separated list is also accepted
        // has not, and there is nothing to gain by finding out.
        //
        // **Plan mode ignores this list, and that is worth knowing before you go
        // looking for a bug in it.** A session in `plan` routes every tool that
        // is not plainly read-only through `can_use_tool` whatever is on
        // `--allowedTools`, so `message_session` from a planning session raises a
        // card — and is auto-denied when no window is open. Measured, not assumed:
        // the same `list_sessions` call is denied in `plan` and runs unasked in
        // `auto`.
        //
        // It matters in two directions and is wanted in both. A session that has
        // just *changed* something is not in plan mode, so the handoff that
        // motivates this feature goes out. And a session woken *by* a handoff is
        // resumed in plan mode, so it cannot pass the work on to a third session
        // even though the tool is nominally allowed — which is exactly the
        // containment the wrapper asks for in prose, enforced.
        args.push('--mcp-config', mcpConfig(this.sessionId));
        for (const tool of AGENT_TOOLS) args.push('--allowedTools', tool);
        // `--session-id` mints the id; `--resume` continues it. Which one is right
        // is a fact about *this start*, not about the runner — see the reset below
        // the spawn, and the bug that reset fixes.
        if (this.isNew) args.push('--session-id', this.sessionId);
        else args.push('--resume', this.sessionId);
        if (this.fork) args.push('--fork-session');
        if (this.model) args.push('--model', this.model);

        this._setState('starting', 'Starting Claude…');

        try {
            this.proc = spawn(CLAUDE_BIN, args, {
                cwd: this.cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: sessionEnv(),
                // Its own process group, so a Ctrl-C aimed at the bridge is not
                // also delivered to a turn in flight; it gets to shut down on
                // stdin EOF instead of being interrupted mid-write.
                //
                // This does not make a turn outlive the bridge, and nothing can:
                // `claude` reads stdin for input, so when the bridge exits and
                // the pipe closes it treats that as end-of-input and stops. That
                // is exactly why the everyday instance runs on its own port —
                // see CLAUDE.md.
                detached: true,
            });
        } catch (err) {
            this.lastError = `Could not start ${CLAUDE_BIN}: ${err.message}`;
            this._setState('error', null);
            return;
        }

        // Both of these describe the *first* start of a conversation, and neither
        // survives it. They used to live for the life of the runner, which was
        // invisible for as long as a process only ever started once — but a runner
        // whose process died and is being restarted starts twice, and then:
        //
        //   `isNew` re-passed `--session-id` for an id that now exists on disk, and
        //   the CLI refuses with "Session ID … is already in use". So the second
        //   turn of a session created in this app, after anything killed its
        //   process, could never start at all.
        //
        //   `fork` re-passed `--fork-session`, which would branch again — off the
        //   copy this runner had already adopted — and quietly leave the user's
        //   message in a third transcript they were not looking at.
        //
        // Clearing them here rather than on `system/init`: the id exists from the
        // moment the CLI opens the file, so a restart has to resume whether or not
        // the handshake got as far as telling us so. The one exit that restarts
        // deliberately puts them back — see the permission-prompt branch of
        // `close`, which is reached before the CLI has done anything at all.
        const wasNew = this.isNew;
        const wasFork = this.fork;
        this.isNew = false;
        this.fork = false;

        this.proc.stdout.setEncoding('utf8');
        this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
        this.proc.stderr.setEncoding('utf8');
        this.proc.stderr.on('data', (chunk) => {
            this._stderr = (this._stderr + chunk).slice(-4000);
        });

        // A dying child reports a broken pipe *asynchronously*, as an 'error' on
        // the stream — which `_write`'s try/catch cannot see, and `proc.on('error')`
        // below is not: that one is the spawn channel. `stdin.writable` also stays
        // true until Node destroys the stream on 'close', so the guard misses it
        // too. An unhandled 'error' on a stream is thrown, and there is no
        // uncaughtException handler anywhere in this bridge, so losing that race
        // took down every session at once. Several writers aim straight at the
        // window: the interrupt in stop(), the stdin.end() beside it, the 1500ms
        // SIGKILL timer, a permission answered as the process dies, and the queue
        // flush itself.
        //
        // There is nothing to *do* about it — 'close' is already on its way and
        // accounts for the turn. Same case and same answer as bridge/pulls.js.
        this.proc.stdin.on('error', () => { /* the process is going away */ });
        this.proc.stdout.on('error', () => { /* ditto */ });
        this.proc.stderr.on('error', () => { /* ditto */ });

        this.proc.on('error', (err) => {
            this.lastError = err.message;
            this._setState('error', null);
        });

        this.proc.on('close', (code) => {
            this.proc = null;
            this._pendingTools.clear();
            this._abandonControl('the Claude process exited');
            // The turn this process was answering, taken before any branch below
            // gets an opinion about it.
            //
            // The invariant is *nothing is in flight when there is no process*,
            // and this is the line that holds it however the exit is classified —
            // so a branch added later cannot forget. Two of them used to: a hard
            // stop and a clean exit both left the entry sitting there, and since
            // _flushQueue refuses to write while anything is in flight, the next
            // message the user sent was accepted, chipped, and never delivered.
            // What happens to the *text* is each branch's decision. Whether it is
            // still held here is not.
            const flight = this.inFlight.splice(0);
            if (this._stopping) {
                this._stopping = false;
                // Stopping means stopping. `flight` is the turn the user asked to
                // end, and `claude` writes its user entry at submission rather
                // than at completion — so by the time anyone has decided to stop
                // a turn, that message is in the transcript and on screen. Handing
                // it back would put the same text in the composer as well.
                //
                // The queue is a different matter. `stop()` empties it and returns
                // it to the caller, which hands it to the composer — but retire()
                // sets `_stopping` too and does not, so anything still waiting here
                // came from a retire and has been offered to nobody.
                if (this.queue.length) {
                    this._handBack('retired',
                        'The Claude process was shut down before these messages were sent.');
                }
                this._setState('stopped', null);
            } else if (code === 0) {
                // An exit nobody asked for. There is no way to tell from here
                // whether the CLI got as far as reading the line, so this takes
                // the same side the error branch below does: text in the composer
                // beside a turn in the log is a confusion the user can undo, and a
                // message that is simply gone is not.
                if (flight.length || this.queue.length) {
                    this._handBack('exited',
                        'Claude Code exited without answering.', flight);
                }
                this._setState('stopped', null);
            } else {
                const raw = this._stderr.trim();

                // A build that does not know the flag rejects it before doing
                // any work. Drop approval prompts for the rest of the bridge's
                // life rather than letting a protocol difference break sending,
                // and put the turn back on the queue so nothing is lost.
                if (this.caps.permissionPrompt && /permission-prompt-tool/i.test(raw)) {
                    this.caps.permissionPrompt = false;
                    // The one branch where re-queueing is provably right: a build
                    // that does not know the flag rejects it while parsing argv,
                    // so the line was never read and no turn was ever recorded.
                    // Nothing was minted or branched either, which is why the
                    // start flags go back rather than the retry resuming an id
                    // that does not exist yet.
                    this.queue = flight.concat(this.queue);
                    this.isNew = wasNew;
                    this.fork = wasFork;
                    this._stderr = '';
                    this.emit('notice', {
                        level: 'warn', kind: 'no_permission_prompt',
                        text: 'This Claude Code version does not support approval prompts here — '
                            + 'using permission mode only.',
                    });
                    this.emit('exit', code);
                    this.start();
                    return;
                }

                const classified = classifyError(raw, code);
                this.errorKind = classified.kind;
                this.lastError = classified.message;
                // Mostly this catches a refusal at startup — busy-elsewhere,
                // no-claude, missing — where the CLI never read stdin and the text
                // exists nowhere else, so handing it back is the only thing that
                // saves it. It also catches deaths mid-turn, though: `code` is null
                // for a signal, so an OOM-killed `claude` lands here too, and for
                // that one the message is already in the transcript and this puts a
                // second copy in the composer. Kept anyway, deliberately — the two
                // outcomes are a confusion the user can undo and a message that is
                // gone, and they are not equally bad.
                this._handBack(classified.kind, classified.message, flight);
                this._setState('error', null);
            }
            this.emit('exit', code);
        });

        // The handshake the Agent SDK opens with. We need nothing from the
        // reply, but a CLI that expects a client to announce itself gets what it
        // is waiting for, and a round trip completing tells us the channel works
        // in both directions before anything depends on it.
        this._control('initialize', {}).catch(() => { /* older build; the fallbacks cover it */ });

        // The process is ready for input immediately; `system/init` confirms it.
        this._setState('idle', null);
        this._flushQueue();
    }

    /**
     * Queue or deliver a user turn. Starts the process if it isn't running.
     * Returns the queue entry, so a caller can tell whether its message went
     * out immediately or is still waiting.
     */
    send(text, attachments = []) {
        this.lastUsedAt = Date.now();
        // `text` stays a plain string and the files ride alongside it, rather than
        // the entry becoming a content-block array. Everything that already reads an
        // entry — the queue chips, the hand-back on death, dequeue, reorder, the
        // `dropped` a stop reports — reads `.text`, and all of it keeps working
        // untouched. Only _flushQueue knows these are here.
        const entry = { id: `q${++queueSeq}`, text, at: Date.now(), attachments };
        this.queue.push(entry);
        if (!this.proc) this.start();
        else this._flushQueue();
        if (this.queue.includes(entry)) this._queueChanged();
        return entry;
    }

    /**
     * Hand the next message to the process, one turn at a time.
     *
     * The CLI would happily take several lines at once, but then they are gone:
     * nothing can be reordered or taken back, and there is no queue left for the
     * UI to show. So only one message is in flight at a time and the rest wait
     * here, where they can still be edited, reordered or dropped.
     */
    _flushQueue() {
        if (!this.proc || !this.proc.stdin.writable) return;
        // `inFlight` is the gate, not just bookkeeping: while anything is in it
        // nothing else is written, which is what keeps one turn in flight at a
        // time. That makes a stale entry silent and total — the runner reports
        // `idle`, the route reports `queued`, and no message will ever be written
        // again. Every path that nulls `this.proc` therefore has to empty it; see
        // the close handler, `detach`, and the top of `start`.
        if (this.state === 'busy' || this.inFlight.length) return;
        const entry = this.queue.shift();
        if (!entry) return;
        // A rejected write means the process is going away. The message is still
        // ours at that point, so put it back rather than dropping it on the floor.
        if (!this._write({
            type: 'user',
            message: { role: 'user', content: userContent(entry) },
        })) {
            this.queue.unshift(entry);
            return;
        }
        // Held until a result arrives: if the process dies first, this text
        // was never written to the transcript and would otherwise be lost.
        this.inFlight.push(entry);
        this._work();
        // _setState only reports when the state or activity moved; a shorter
        // queue is news on its own.
        this._queueChanged();
    }

    /** Drop one waiting message. Returns it, or null if it already went out. */
    dequeue(id) {
        const i = this.queue.findIndex(q => q.id === id);
        if (i < 0) return null;
        const [entry] = this.queue.splice(i, 1);
        this._queueChanged();
        return entry;
    }

    /** Drop everything still waiting. Returns what was dropped. */
    clearQueue() {
        if (!this.queue.length) return [];
        const dropped = this.queue.slice();
        this.queue.length = 0;
        this._queueChanged();
        return dropped;
    }

    /**
     * Put the queue in the order given. Ids that are no longer waiting are
     * ignored, and anything the caller did not mention keeps its place at the
     * back — a message that flushed while the drag was in progress must not
     * take the rest of the queue with it.
     */
    reorder(ids) {
        const byId = new Map(this.queue.map(q => [q.id, q]));
        const next = [];
        for (const id of ids) {
            const entry = byId.get(id);
            if (entry && !next.includes(entry)) next.push(entry);
        }
        for (const entry of this.queue) if (!next.includes(entry)) next.push(entry);
        this.queue = next;
        this._queueChanged();
        return this.queue;
    }

    _queueChanged() {
        this.emit('status', this.status());
    }

    /**
     * Give unsent text back to whoever typed it, and stop holding it.
     *
     * The two halves are one call on purpose. Handing back *without* clearing is
     * how a lost message becomes a duplicated one: the copy still on the queue
     * flushes the next time the process starts, alongside the copy now sitting in
     * the composer. One or the other, never both.
     *
     * Always emits, even with nothing to hand back, because the event is also how
     * the UI learns the send failed at all — `handleSendFailure` toasts the
     * message on its own when there is no text with it.
     *
     * @param {string} kind matched by the UI; see the `send-failed` kinds in docs/api.md
     * @param {string} message what to tell the user, without "your message is back"
     * @param {Array} [extra] entries to hand back ahead of the queue — the turn
     *   that was in flight, where the branch has decided it was never recorded
     */
    _handBack(kind, message, extra = []) {
        const unsent = extra.concat(this.queue).map(q => q.text).filter(Boolean);
        this.queue.length = 0;
        this.emit('failed', { kind, message, unsent });
        this._queueChanged();
    }

    /**
     * End the current turn.
     *
     * The soft path asks the CLI to interrupt itself: the turn stops where it
     * is, the process stays alive, and the session is resumable with nothing
     * half-written. The hard path is the old behaviour — SIGTERM, then SIGKILL —
     * which ends the turn wherever it happens to be, possibly mid-tool-call.
     *
     * Soft is tried first and falls through to hard if the CLI does not answer,
     * so this never becomes a way to fail to stop something.
     *
     * Either way the send queue goes too — stopping means stopping — but those
     * messages are handed back rather than binned. They were never written to the
     * process, so the UI can put them back in the composer and nothing is lost.
     *
     * @returns {Promise<{ok:boolean, how:'soft'|'hard'|null, dropped:Array}>}
     */
    async stop({ hard = false } = {}) {
        // Nothing to signal, but there can still be messages waiting: a process
        // that died leaves its queue behind, and Stop is the obvious thing to
        // press when a session looks stuck with chips on the composer. Returning
        // an empty `dropped` from here left them in place while the UI announced
        // that it had killed something, so the one recovery the user had did
        // nothing and said otherwise.
        if (!this.proc) {
            const orphaned = this.queue.slice();
            if (orphaned.length) {
                this.queue.length = 0;
                this._queueChanged();
            }
            return { ok: false, how: null, dropped: orphaned };
        }

        // Taken before either path clears it, so both can hand it back.
        const dropped = this.queue.slice();

        // An unanswered ask is holding the turn open. Whichever path we take, it
        // has to be answered first — the CLI is blocked waiting on us and will
        // not process an interrupt until it is unblocked.
        if (this.pendingPermission) {
            const ask = this.pendingPermission;
            this._respondPermission(ask, {
                behavior: 'deny',
                message: 'Stopped from Claude Sessions before this was approved.',
            });
            this._clearPermission('stopped');
        }

        if (!hard && this.caps.interrupt && !this._interruptTimedOut) {
            this.queue.length = 0;
            try {
                await this._control('interrupt', { cancel_queued: true });
                // Leave the state alone: the CLI answers an interrupt with a
                // `result` like any other turn ending, and that is what should
                // move us back to idle.
                return { ok: true, how: 'soft', dropped };
            } catch (err) {
                // Fall through to the signal path either way — this must never
                // become a way to fail to stop something.
                //
                // What to remember from it is the part that was wrong. `caps` is
                // one object shared by every runner in the pool, and latching it
                // off on a *timeout* meant a single CLI whose event loop was
                // blocked by a long tool call turned every Stop for the rest of the
                // bridge's life into a hard kill — in every session, including ones
                // started afterwards. That is the road into the wedge this whole
                // area is about, and it was reached by pressing Stop once, gently,
                // some time earlier.
                //
                // So: a refusal is a fact about the build and stays pool-wide. A
                // timeout is a fact about this process, and is remembered only
                // here — enough that a second Stop does not wait another eight
                // seconds, and forgotten when the process is replaced.
                if (err && err.reason === 'refused') this.caps.interrupt = false;
                else this._interruptTimedOut = true;
            }
        }

        // Awaiting the interrupt gave the process time to exit on its own — a
        // failed interrupt and a dead process look the same from here. There is
        // nothing left to signal.
        if (!this.proc) return { ok: true, how: 'soft', dropped };

        this._stopping = true;
        this.queue.length = 0;
        try { this.proc.stdin.end(); } catch { /* already closed */ }
        const proc = this.proc;
        // Give it a moment to exit gracefully, then insist.
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 1500).unref();
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
        return { ok: true, how: 'hard', dropped };
    }

    // -- control channel ---------------------------------------------------

    _write(obj) {
        if (!this.proc || !this.proc.stdin.writable) return false;
        try {
            this.proc.stdin.write(JSON.stringify(obj) + '\n');
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Outbound request; resolves with the CLI's response payload.
     *
     * A rejection carries `reason` alongside its message, because the four ways
     * this fails are not interchangeable to a caller. Only `refused` means "this
     * build does not speak this request"; `timeout` means a busy CLI, and latching
     * a capability off on one of those is how a single slow turn degrades every
     * session in the bridge for the rest of its life.
     */
    _control(subtype, payload = {}, { timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
        return new Promise((resolve, reject) => {
            const id = `req_${++this._ctlSeq}`;
            if (!this._write({
                type: 'control_request', request_id: id, request: { subtype, ...payload },
            })) {
                reject(controlError('the Claude process is not accepting input', 'closed'));
                return;
            }
            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(controlError(`no answer to control request "${subtype}"`, 'timeout'));
            }, timeoutMs);
            timer.unref();
            this._pending.set(id, { resolve, reject, timer });
        });
    }

    /** Fail every outstanding request; the channel they were riding on is gone. */
    _abandonControl(why) {
        for (const [, p] of this._pending) {
            clearTimeout(p.timer);
            p.reject(controlError(why, 'gone'));
        }
        this._pending.clear();
        // Nothing can answer it now, and nothing is waiting for the answer.
        if (this.pendingPermission) {
            const { id } = this.pendingPermission;
            this.pendingPermission = null;
            this.emit('permission-resolved', {
                sessionId: this.sessionId, requestId: id, outcome: 'abandoned',
            });
        }
    }

    /**
     * An inbound request from the CLI.
     *
     * Only `can_use_tool` is ours to act on. Anything else is a newer CLI
     * expecting a client we are not — answer it with an error so it stops
     * waiting on us, and carry on.
     */
    _onControlRequest(msg) {
        const req = msg.request || {};
        if (req.subtype !== 'can_use_tool') {
            this._write({
                type: 'control_response',
                response: {
                    subtype: 'error', request_id: msg.request_id,
                    error: `claude-sessions does not handle the "${req.subtype}" control request`,
                },
            });
            return;
        }

        // A plan and a question are asks this app has a real answer for; every
        // other tool that wants its own dialog is one it does not.
        const kind = ASK_KINDS[req.tool_name] || 'tool';

        // Some MCP asks need a dialog of the server's own, which this channel
        // cannot carry. Offering Allow would be a lie — the call fails anyway —
        // so say what happened instead of pretending it was a choice.
        if (req.requires_user_interaction && kind === 'tool') {
            this._write({
                type: 'control_response',
                response: {
                    subtype: 'success', request_id: msg.request_id,
                    response: {
                        behavior: 'deny', toolName: req.tool_name,
                        message: 'This tool needs its own interactive prompt, which Claude '
                            + 'Sessions cannot show. Run it from a terminal.',
                    },
                },
            });
            this.emit('notice', {
                level: 'warn', kind: 'permission_uninteractive',
                text: `${req.tool_name} asked for an interactive prompt this app cannot show, `
                    + 'so it was denied. That tool needs a terminal.',
            });
            return;
        }

        const ask = {
            id: msg.request_id,
            kind,
            tool: req.tool_name,
            displayName: req.display_name || req.tool_name,
            input: req.input || {},
            toolUseId: req.tool_use_id || null,
            description: req.description || null,
            reason: req.decision_reason || null,
            blockedPath: req.blocked_path || null,
            // A call made by a subagent, not by the session itself.
            agentId: req.agent_id || null,
            askedAt: Date.now(),
        };

        // Said yes to this tool earlier in the session, before the process was
        // last restarted. The CLI has forgotten; we have not.
        //
        // Only tools: "always allow" is a statement about a kind of action, and
        // a plan or a question has no kind — each one is a different plan and a
        // different question, and answering the next one in advance is not
        // something anybody can mean.
        if (kind === 'tool' && this._sessionAllow.has(ask.tool)) {
            this._respondPermission(ask, {
                behavior: 'allow',
                updatedPermissions: sessionAllowRule(ask.tool),
            });
            return;
        }

        // Nothing is attached to answer, so the honest outcome is the one the
        // app produced before any of this existed: denied.
        if (!this.hasViewer()) {
            this._autoDeny(ask, kind === 'tool'
                ? 'No Claude Sessions window was open to approve this, so it was denied.'
                : `No Claude Sessions window was open to answer this, so ${
                    kind === 'plan' ? 'the plan was not approved' : 'the question went unanswered'}.`);
            return;
        }

        // Only one ask can be outstanding per process, but be defensive: a
        // second would otherwise silently orphan the first.
        if (this.pendingPermission) {
            this._respondPermission(this.pendingPermission, {
                behavior: 'deny',
                message: 'Superseded by a later permission request.',
            });
            this._clearPermission('superseded');
        }

        this.pendingPermission = ask;
        this._setState('busy', kind === 'plan' ? 'Waiting for you: a plan to approve'
            : kind === 'question' ? 'Waiting for you: a question'
            : `Waiting for you: ${ask.displayName}`);
        this.emit('permission-request', { sessionId: this.sessionId, ...publicAsk(ask) });
    }

    /**
     * Answer an outstanding ask. Called from the UI.
     *
     * @param {string} requestId
     * @param {'allow'|'allow-always'|'deny'} decision
     * @param {object} [extra]
     * @param {object} [extra.updatedInput] edited tool input to run instead
     * @param {Record<string,string>} [extra.answers] answers, keyed by question text
     * @param {string} [extra.feedback] what to tell the model when it is turned down
     * @param {string} [extra.mode] permission mode to continue an approved plan in
     */
    answerPermission(requestId, decision, extra = {}) {
        const ask = this.pendingPermission;
        if (!ask) return { ok: false, error: 'nothing is waiting for approval' };
        // Two windows, one ask: the first answer wins and the second is told so
        // rather than silently doing nothing.
        if (ask.id !== requestId) return { ok: false, error: 'that request was already answered' };

        this.lastUsedAt = Date.now();
        this._autoDenies = 0;   // somebody is here; the spin guard can reset

        if (ask.kind !== 'tool') return this._answerConversation(ask, decision, extra);

        if (decision === 'deny') {
            this._respondPermission(ask, {
                behavior: 'deny', message: 'Denied from Claude Sessions.',
            });
        } else {
            const always = decision === 'allow-always';
            if (always) this._sessionAllow.add(ask.tool);
            const { updatedInput } = extra;
            this._respondPermission(ask, {
                behavior: 'allow',
                updatedInput: updatedInput && Object.keys(updatedInput).length ? updatedInput : null,
                updatedPermissions: always ? sessionAllowRule(ask.tool) : null,
            });
        }
        this._clearPermission(decision);
        return { ok: true };
    }

    /**
     * Answer a plan or a question — the two asks that are the model talking to
     * you rather than asking to run something.
     *
     * Both ride the allow/deny channel, because that is the only channel there
     * is, but neither reads as a permission to the model: a denied plan comes
     * back as feedback to plan against, and an allowed question carries the
     * answers in its input.
     */
    _answerConversation(ask, decision, { answers, feedback, mode } = {}) {
        const turnedDown = decision === 'deny';

        if (turnedDown) {
            // The message is the whole point. A plan turned down without a word
            // leaves the model to guess what was wrong with it, and it will
            // usually guess "too long" and try again — so say something, and
            // when there is nothing to say, at least say which it was.
            const said = String(feedback || '').trim();
            this._respondPermission(ask, {
                behavior: 'deny',
                message: said || (ask.kind === 'plan'
                    ? 'Not yet — keep planning.'
                    : 'The question was dismissed unanswered. Use your own judgement and carry on.'),
            });
            this._clearPermission(ask.kind === 'plan' ? 'plan-rejected' : 'dismissed');
            return { ok: true };
        }

        if (ask.kind === 'question') {
            // `answers` is keyed by the question text, which is what the CLI
            // matches on; a key that names no question is dropped rather than
            // passed through, so a stale card cannot answer a live question.
            const asked = new Set((ask.input.questions || []).map(q => q.question));
            const clean = {};
            for (const [q, a] of Object.entries(answers || {})) {
                if (asked.has(q) && String(a || '').trim()) clean[q] = String(a);
            }
            if (!Object.keys(clean).length) {
                return { ok: false, error: 'no answers were given' };
            }
            this._respondPermission(ask, {
                behavior: 'allow',
                updatedInput: { ...ask.input, answers: clean },
            });
            this._clearPermission('answered');
            return { ok: true };
        }

        // An approved plan. Allowing the tool is what tells the model to start.
        //
        // "Yes, and…" rides on the plan itself. An allow response carries no
        // message the model ever sees — that was measured, not assumed — but
        // the approved plan is echoed back to it in full, and the CLI labels an
        // edited one "(edited by user)". So a note appended to the plan is
        // read as part of what was agreed to, which is where a condition on
        // approving belongs anyway.
        const note = String(feedback || '').trim();
        this._respondPermission(ask, {
            behavior: 'allow',
            updatedInput: note
                ? { ...ask.input, plan: `${ask.input.plan || ''}\n\n## Note from the user\n${note}\n` }
                : null,
        });
        this._clearPermission(note ? 'plan-approved-note' : 'plan-approved');
        // …but the session is still in plan mode, where the work it has just
        // been told to do is refused. Leaving it there would approve a plan and
        // then block it, which is worse than not asking.
        if (mode && mode !== this.permissionMode) this._setPermissionMode(mode);
        return { ok: true };
    }

    /**
     * Change the mode of the running process.
     *
     * Also kept locally, because the mode outlives the process: a later restart
     * builds its argv from `permissionMode`, and a session that had left plan
     * mode must not silently return to it.
     */
    _setPermissionMode(mode) {
        const previous = this.permissionMode;
        this.permissionMode = mode;
        this._queueChanged();   // the UI's mode selector follows this
        this._control('set_permission_mode', { mode }).catch(() => {
            // An older CLI that does not know the request leaves the process in
            // plan mode while we believe otherwise. Put our copy back and say
            // so — silently refusing every edit of an approved plan is the
            // worst version of this.
            this.permissionMode = previous;
            this._queueChanged();
            this.emit('notice', {
                level: 'warn', kind: 'mode_change_failed',
                text: `Approved, but this Claude Code version would not switch out of `
                    + `${previous} mode from here. Change the mode under the composer and `
                    + 'send a message to carry on.',
            });
        });
    }

    _respondPermission(ask, { behavior, message, updatedInput, updatedPermissions }) {
        const response = { behavior, toolName: ask.tool };
        if (behavior === 'allow' && updatedInput) response.updatedInput = updatedInput;
        if (behavior === 'deny') response.message = message || 'Denied from Claude Sessions.';
        if (updatedPermissions) response.updatedPermissions = updatedPermissions;
        this._write({
            type: 'control_response',
            response: { subtype: 'success', request_id: ask.id, response },
        });
    }

    _clearPermission(outcome) {
        const ask = this.pendingPermission;
        if (!ask) return;
        this.pendingPermission = null;
        this.emit('permission-resolved', {
            sessionId: this.sessionId, requestId: ask.id, outcome,
        });
        // The tool is about to run (or not); either way we are back to working.
        if (this.state === 'busy') this._work();
    }

    _autoDeny(ask, reason) {
        this._autoDenies++;
        this._respondPermission(ask, { behavior: 'deny', message: reason });
        if (this.pendingPermission && this.pendingPermission.id === ask.id) {
            this._clearPermission('auto-denied');
        }
        this.emit('notice', { level: 'warn', kind: 'permission_auto_denied', text: reason });

        if (this._autoDenies >= MAX_AUTO_DENIES) {
            this._autoDenies = 0;
            this.emit('notice', {
                level: 'warn', kind: 'permission_auto_denied',
                text: `${MAX_AUTO_DENIES} tool calls in a row were denied with nobody to approve `
                    + 'them, so the turn was stopped rather than left to spin.',
            });
            this.stop().catch(() => { /* the hard path already ran */ });
        }
    }

    /**
     * Hand any waiting messages back before something takes this runner away.
     *
     * For the pool: evicting a runner used to bin its queue, and a message the
     * user is still owed must not disappear because a fifth session was opened.
     * Silent when there is nothing waiting — most evictions are of a runner
     * nobody is owed anything by.
     */
    handOverQueue(message) {
        if (!this.queue.length) return;
        this._handBack('retired', message);
    }

    /**
     * Stop managing the process without signalling it.
     *
     * Used when the bridge is going away mid-turn. It buys the process a chance
     * to wind down on its own as our stdin pipe closes, rather than being killed
     * outright — but it does not save the turn. Nothing can: `claude` reads
     * stdin for input, so the pipe closing when we exit is end-of-input and it
     * stops there. Protecting work means not killing the bridge in the first
     * place, which is what the separate development port is for.
     */
    detach() {
        if (!this.proc) return;
        const proc = this.proc;
        this.proc = null;
        this._abandonControl('the bridge stopped managing this process');
        // The third place `this.proc` goes null, and so the third place the
        // in-flight invariant has to hold. Nothing is handed back: the bridge is
        // going away, there is no client left to hand it to, and the turn is in
        // the transcript.
        this.inFlight.length = 0;
        try { proc.unref(); } catch { /* already gone */ }
        this._setState('stopped', null);
    }

    /** Close stdin so the process exits once the current turn finishes. */
    retire() {
        if (!this.proc) return;
        this._stopping = true;
        try { this.proc.stdin.end(); } catch { /* already closed */ }
    }

    // -- stream ------------------------------------------------------------

    _onStdout(chunk) {
        this._buf += chunk;
        let i;
        while ((i = this._buf.indexOf('\n')) >= 0) {
            const line = this._buf.slice(0, i);
            this._buf = this._buf.slice(i + 1);
            if (!line.trim()) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                // stderr shares this stream now, so anything that is not an
                // event is diagnostic text — and it is what classifyError reads
                // to tell "already running elsewhere" from a generic failure.
                this._stderr = (this._stderr + line + '\n').slice(-4000);
                continue;
            }
            this._onMessage(msg);
        }
    }

    _onMessage(msg) {
        switch (msg.type) {
            case 'control_request':
                this._onControlRequest(msg);
                break;

            case 'control_response': {
                const r = msg.response || {};
                const p = this._pending.get(r.request_id);
                if (!p) break;
                this._pending.delete(r.request_id);
                clearTimeout(p.timer);
                if (r.subtype === 'error') {
                    p.reject(controlError(r.error || 'the request was refused', 'refused'));
                }
                else p.resolve(r.response || {});
                break;
            }

            case 'control_cancel_request': {
                // The CLI withdrew an ask — usually because the turn it belonged
                // to ended. Take the card down rather than leaving a dead one on
                // screen with a countdown running.
                const id = msg.request_id || (msg.request && msg.request.request_id);
                if (this.pendingPermission && this.pendingPermission.id === id) {
                    this._clearPermission('cancelled');
                }
                break;
            }

            case 'system':
                if (msg.subtype === 'init') {
                    // A resumed session keeps its id; a fork gets a new one, and
                    // the UI has to follow it or the user is left watching a
                    // transcript that will never move again.
                    if (msg.session_id && msg.session_id !== this.sessionId) {
                        const from = this.sessionId;
                        this.sessionId = msg.session_id;
                        this.emit('forked', { from, to: msg.session_id });
                    }
                    this.emit('init', msg);
                } else if (msg.subtype === 'permission_denied') {
                    this.emit('notice', {
                        level: 'warn', kind: 'permission_denied',
                        text: msg.content || 'A tool call was denied by the permission mode.',
                    });
                } else if (msg.subtype === 'task_notification') {
                    // A background subagent finished.
                    //
                    // The conversation gets this as an injected *user* message,
                    // which is the form transcript.js parses to draw the row —
                    // but the stream carries it structured, and the stream is
                    // here whether or not anybody is watching the session. A log
                    // that only filled up while somebody was looking would miss
                    // exactly the hours it exists for.
                    const u = msg.usage || {};
                    this.emit('agent-done', {
                        sessionId: this.sessionId,
                        taskId: msg.task_id,
                        toolUseId: msg.tool_use_id || null,
                        status: msg.status || 'completed',
                        summary: msg.summary || null,
                        durationMs: u.duration_ms || null,
                    });
                } else if (msg.subtype === 'api_retry') {
                    // The CLI retries a failing API call up to ten times with
                    // exponential backoff, which can run for several minutes.
                    // Without this the UI just says "Thinking" the whole time and
                    // the user has no idea anything is wrong, or that stopping is
                    // an option.
                    this.retry = {
                        attempt: msg.attempt,
                        max: msg.max_retries,
                        status: msg.error_status || null,
                        at: Date.now(),
                    };
                    this._setState('busy',
                        `Can't reach the API — retry ${msg.attempt} of ${msg.max_retries}`);
                    // One notice, not ten.
                    if (msg.attempt === 1) {
                        this.emit('notice', {
                            level: 'warn', kind: 'api_retry',
                            text: 'Trouble reaching the Anthropic API. Claude is retrying; '
                                + 'this can take several minutes before it gives up.',
                        });
                    }
                }
                break;

            case 'assistant': {
                const content = (msg.message && msg.message.content) || [];
                for (const b of content) {
                    if (b.type === 'tool_use') {
                        this._pendingTools.set(b.id, b.name);
                        this._work(describeTool(b));
                    } else if (b.type === 'text' && b.text.trim()) {
                        this._work('Writing…');
                    } else if (b.type === 'thinking') {
                        this._work();
                    }
                }
                break;
            }

            case 'user': {
                const content = (msg.message && msg.message.content) || [];
                for (const b of content) {
                    if (b.type !== 'tool_result') continue;
                    this._pendingTools.delete(b.tool_use_id);
                }
                // The call is over, so its name would now be a lie — back to
                // the verb alone until the next thing starts.
                if (this.state === 'busy') this._work();
                break;
            }

            case 'result': {
                // A turn that ends in an API error still counts as "finished" to
                // the CLI, so say what went wrong rather than quietly going idle.
                const failed = !!msg.is_error;
                const detail = typeof msg.result === 'string' ? msg.result : '';
                // What the turn actually said, kept off `lastResult` on purpose.
                //
                // `lastResult` is what `turn-complete` broadcasts, and that event
                // goes to every connected client — a desktop window, a phone over
                // Tailscale — on every turn. The final assistant message can be
                // pages long, and every client already has it: they tail the
                // transcript. So putting it there would be sending the same text
                // twice, over the slower path, to clients that did not ask.
                //
                // It is here because a scheduled run needs its verdict without
                // waiting for the index to catch up on a session that was created
                // seconds ago. Capped, since nothing reads more than the last few
                // lines of it.
                this.lastResultText = detail.slice(-4000);
                // The same message from the *front*, for a scheduled review the
                // bridge is going to post to GitHub.
                //
                // Two fields rather than one widened one, because the two readers
                // want opposite ends of the same string. `verdictOf` uses `exec`
                // and so takes the *first* match, and the tail slice above is what
                // makes that first match be the real trailing `VERDICT:` line — on
                // a 60KB body it would instead find whichever earlier paragraph
                // happens to mention a verdict. Meanwhile a comment that begins
                // mid-sentence, which is what posting the tail would produce, is
                // worse than no comment.
                //
                // 60KB against GitHub's 65536-character comment limit, leaving
                // room for the wrapper the bridge puts around it. Never broadcast,
                // for `lastResultText`'s reason; four live runners at 60KB is
                // nothing.
                this.lastResultBody = detail.slice(0, 60_000);
                this.lastResult = {
                    isError: failed,
                    detail: failed ? detail.slice(0, 300) : null,
                    retries: this.retry ? this.retry.attempt : 0,
                    costUsd: msg.total_cost_usd || 0,
                    durationMs: msg.duration_ms || msg.duration_api_ms || 0,
                    numTurns: msg.num_turns || 0,
                    stopReason: msg.stop_reason || null,
                };
                this._pendingTools.clear();
                this.inFlight.length = 0;   // safely in the transcript now
                this.retry = null;
                this._autoDenies = 0;       // a finished turn is not a spin
                this._setState('idle', null);
                // The turn that was holding the queue back has landed.
                this._flushQueue();
                if (failed) {
                    this.emit('notice', {
                        level: 'warn', kind: 'turn_failed',
                        text: detail || 'The turn ended with an error.',
                    });
                }
                this.emit('turn-complete', this.lastResult);
                break;
            }

            case 'rate_limit_event':
                if (!msg.rate_limit_info) break;
                // The whole payload, every time — not just the ones that are
                // going wrong. An `allowed` event is where `resetsAt` for a
                // window lives, so dropping it (which is what this did) threw
                // away the only free source of "when does the quota come back".
                // bridge/usage.js decides what is worth showing; see the note
                // there on why `utilization` is usually absent.
                this.emit('quota', msg.rate_limit_info);
                if (msg.rate_limit_info.status !== 'allowed') {
                    this.emit('notice', {
                        level: 'warn', kind: 'rate_limit',
                        text: `Rate limit: ${msg.rate_limit_info.status}`,
                    });
                }
                break;
        }
    }

    /**
     * Working, and on what.
     *
     * The label a turn shows has two halves. The **verb** is the themed word out
     * of bridge/spinner.js, and it drifts on its own clock — it is what says the
     * session is alive. The **detail** is whatever is specifically happening,
     * and it changes when reality does: a tool's name, or `Writing…`, or nothing
     * at all while Claude is only thinking.
     *
     * Showing both is the point. Before this the tool name *replaced* the verb,
     * so a long tool call sat on one string and a spinner that has stopped
     * spinning reads as a session that has stopped working — but dropping the
     * tool name to keep the verb moving would have traded the informative half
     * for the decorative one. `Percolating… Reading runner.js` gives up neither,
     * and lets the verb keep drifting straight through a call of any length.
     *
     * @param {string|null} [detail] what is specifically happening, or null for
     *   thinking with nothing more to say.
     */
    _work(detail = null) {
        // Drawn once when a turn starts working and then left to the timer.
        // Redrawing it here as well would change both halves at once on every
        // tool call, and the detail is already the half that says what moved.
        if (!this._verb) this._verb = this.thinking(this.cwd, null);
        this._detail = detail;
        this._say();
    }

    /** The timer firing: a new verb, the same detail. */
    _drift() {
        this._verb = this.thinking(this.cwd, this._verb);
        this._say();
    }

    /**
     * Put the two halves on the wire, and arm the next drift.
     *
     * With no verb — `randomize: false`, or no group that resolved — this is
     * exactly the string the app showed before any of it existed: the detail
     * alone, or `Thinking…`. That is the whole reason Spinner#pick answers null
     * rather than a fallback.
     */
    _say() {
        const verb = this._verb;
        const detail = this._detail;
        let activity;
        if (verb && detail) {
            // `Writing…` already ends in one, and `Percolating… Writing…` reads
            // like a stutter. One ellipsis to a label.
            activity = `${verb}… ${detail.replace(/…$/, '')}`;
        } else if (verb) {
            activity = `${verb}…`;
        } else {
            activity = detail || 'Thinking…';
        }

        this._setState('busy', activity, true);
        const ms = this.rerollAfter(this.cwd);
        // Nothing to drift towards without a verb, and nothing to drift to if
        // the interval is off.
        if (verb && ms > 0) {
            this._reroll = setTimeout(() => this._drift(), ms);
            // Never a reason to hold the process open, the same as the pool's
            // eviction sweep.
            this._reroll.unref();
        }
    }

    /**
     * @param {boolean} [work] whether this is the pair above talking. Anything
     *   else — a question waiting on a person, an API retry, starting, going
     *   idle, stopping — is not work with a verb in front of it, so it clears
     *   both halves. One line here rather than a rule at every call site.
     */
    _setState(state, activity, work = false) {
        if (this._reroll) { clearTimeout(this._reroll); this._reroll = null; }
        if (!work) { this._verb = null; this._detail = null; }

        const changed = this.state !== state || this.activity !== activity;
        // Stamped once per turn, not on every activity change, so the elapsed
        // time the UI shows covers the whole turn.
        if (state === 'busy' && this.state !== 'busy') this.busySince = Date.now();
        if (state !== 'busy') this.busySince = null;
        this.state = state;
        this.activity = activity;
        if (changed) this.emit('status', this.status());
    }

    status() {
        return {
            sessionId: this.sessionId,
            state: this.state,
            activity: this.activity,
            // The two halves `activity` is composed of, so a surface too narrow
            // for both can choose. The rail is the one that does: it has room
            // for about twenty characters, and the informative half is `detail`.
            // Everything wider just draws `activity` and needs neither of these.
            verb: this._verb,
            detail: this._detail,
            model: this.model,
            permissionMode: this.permissionMode,
            cwd: this.cwd,
            error: this.lastError,
            errorKind: this.errorKind,
            retry: this.retry,
            lastResult: this.lastResult,
            queued: this.queue.length,
            // The messages themselves, not just a count: the composer renders one
            // chip per entry and needs the id to cancel or reorder it. Every
            // status event carries this, so it stays a list of what is still
            // waiting — the message being answered is on its way to the transcript
            // and is read from there like any other.
            // `attachments` rides along so a chip can say a message has files on it,
            // and so editing one puts them back on the composer rather than dropping
            // them on the floor. Metadata only — the base64 is read at flush time and
            // never travels on a status event.
            queue: this.queue.map(q => ({
                id: q.id, text: q.text, at: q.at, attachments: q.attachments || [],
            })),
            // A window opening onto a session that is already blocked on an ask
            // has to be able to draw the card without having seen the event.
            pendingPermission: this.pendingPermission ? publicAsk(this.pendingPermission) : null,
            canPrompt: this.caps.permissionPrompt,
            // Lets the UI show how long a turn has been going, which matters
            // when the API is being retried for minutes at a time.
            busySince: this.state === 'busy' ? this.busySince : null,
        };
    }
}

/** The ask as the UI sees it — no timer handle, nothing it cannot serialise. */
/**
 * A control-channel rejection, with the reason machine-readable.
 *
 * `message` is for a human and drifts; `reason` is what code may branch on:
 * `refused` (the CLI answered "no"), `timeout` (it did not answer), `closed`
 * (stdin would not take the request) or `gone` (the process exited under it).
 */
function controlError(message, reason) {
    const err = new Error(message);
    err.reason = reason;
    return err;
}

function publicAsk(ask) {
    return {
        requestId: ask.id,
        // 'tool' | 'plan' | 'question'. Which card the UI draws — the plan and
        // the questions themselves are already in `input`.
        kind: ask.kind || 'tool',
        tool: ask.tool,
        displayName: ask.displayName,
        input: ask.input,
        toolUseId: ask.toolUseId,
        description: ask.description,
        reason: ask.reason,
        blockedPath: ask.blockedPath,
        agentId: ask.agentId,
        askedAt: ask.askedAt,
    };
}

/**
 * "Allow this tool for the rest of the session."
 *
 * `destination: 'session'` keeps it in the CLI's memory for this process only.
 * A wider scope would mean writing to Claude Code's own settings files, which is
 * not ours to do — a permanent allowlist belongs in Claude Code, not here.
 */
function sessionAllowRule(toolName) {
    return [{
        type: 'addRules',
        rules: [{ toolName }],
        behavior: 'allow',
        destination: 'session',
    }];
}

/**
 * Turn `claude`'s stderr into something the UI can act on.
 *
 * The case that matters: a session already running elsewhere — a background
 * agent, or a terminal — cannot be resumed, because two writers would be
 * appending to one transcript. Claude Code refuses and suggests branching off a
 * copy, which is exactly the recovery the UI should offer.
 */
function classifyError(stderr, code) {
    const text = String(stderr || '').trim();

    if (/currently running as a background agent|add --fork-session to branch/i.test(text)) {
        return {
            kind: 'busy-elsewhere',
            message: 'This session is already running somewhere else, so it cannot be '
                + 'continued here. Branch off a copy to keep going.',
        };
    }
    if (/ENOENT|command not found|not found/i.test(text) && /claude/i.test(text)) {
        return {
            kind: 'no-claude',
            message: 'Could not find the `claude` command in WSL. Check that it is on PATH.',
        };
    }
    if (/No conversation found|session .* not found/i.test(text)) {
        return { kind: 'missing', message: 'Claude Code could not find this session to resume.' };
    }

    const tail = text.split('\n').filter(Boolean).slice(-4).join('\n');
    return { kind: 'unknown', message: tail || `claude exited with code ${code}` };
}

/**
 * The expanded, checked working directory a session may run in, or a throw
 * saying exactly why not.
 *
 * Lifted out of `RunnerPool#create`, where it was the whole top half, because
 * there is now a second caller that has to reach the same verdict without
 * spawning anything: a draft is a create call held back, and `POST /api/drafts`
 * refuses a directory at write time so you cannot save something that could never
 * start. Two copies of these three rules would drift, and the way you would find
 * out is a draft that saves cleanly and then refuses forever.
 *
 * `~` is expanded here and the expanded form is what gets stored and handed to
 * spawn(), so this is also the one place the path is normalised.
 */
function resolveWorkdir(cwd) {
    const dir = cwd && cfg.expandHome(cwd);
    // A regular file passes existsSync perfectly happily, and the session then
    // dies at spawn with a bare ENOTDIR long after anyone could act on it.
    // Asking the question properly here turns that into a 400 that says so.
    let st = null;
    try { st = fs.statSync(dir); } catch { /* reported below */ }
    if (!dir || !st) {
        throw new Error(`Working directory does not exist: ${cwd}`);
    }
    if (!st.isDirectory()) {
        throw new Error(`Not a directory: ${cwd}`);
    }
    // Existing is not the same as allowed. /etc exists. Checked again at the
    // moment of spawning even when a draft already passed it: the roots are
    // configuration and a draft can outlive the setting that let it be saved.
    if (!cfg.withinRoots(dir)) {
        throw new Error(`Working directory is outside the allowed roots: ${cwd}`);
    }
    return dir;
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

class RunnerPool extends EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, Runner>} */
        this.runners = new Map();
        this._sweep = setInterval(() => this._evictIdle(), 60_000);
        this._sweep.unref();

        // What this `claude` build turned out to support, learned once and
        // shared: a runner that discovers a gap saves every later one from
        // rediscovering it the same expensive way.
        this.caps = { permissionPrompt: true, interrupt: true };

        // Replaced by the server with the real answer. Whether anything is
        // listening decides between blocking on a person and denying, so
        // guessing "yes" here would hang turns nobody is watching.
        this.hasViewer = () => false;

        // And what a turn in progress calls itself — replaced by the server
        // with bridge/spinner.js, which reads the groups the user enabled. No
        // verb is a real answer: a pool built without a server says exactly what
        // this app said before there were any.
        this.thinking = () => null;
        this.rerollAfter = () => 0;
    }

    get(sessionId) {
        return this.runners.get(sessionId) || null;
    }

    /** Existing runner for a session, or a new one bound to `cwd`. */
    ensure(sessionId, { cwd, model, permissionMode, isNew = false, fork = false } = {}) {
        let r = this.runners.get(sessionId);
        let carried = [];
        if (r) {
            // A mode, model or fork change only takes effect on a fresh process.
            const wants = { model: model ?? r.model, permissionMode: permissionMode ?? r.permissionMode };
            if (r.state !== 'busy'
                && (wants.model !== r.model || wants.permissionMode !== r.permissionMode
                    || fork !== r.fork || r.state === 'error')) {
                // A model or mode change replaces the process. Messages still
                // waiting belong to the user, not to the process, so they move
                // across rather than disappearing.
                carried = r.clearQueue();
                r.retire();
                this.runners.delete(sessionId);
                r = null;
            } else {
                return r;
            }
        }

        this._evictTo(MAX_LIVE - 1);

        // Delegated rather than handed over, so a runner asks the pool afresh
        // every time: settings change under a live session, and the answer
        // should not be the one that was true when it started.
        r = new Runner({ sessionId, cwd, model, permissionMode, isNew, fork, caps: this.caps,
            thinking: (dir, last) => this.thinking(dir, last),
            rerollAfter: (dir) => this.rerollAfter(dir) });
        // Read through `r.sessionId` rather than closing over the id it was
        // created with: a fork changes it, and the viewer check has to follow.
        r.hasViewer = () => this.hasViewer(r.sessionId);
        r.on('status', (s) => this.emit('status', s));
        r.on('notice', (n) => this.emit('notice', { sessionId: r.sessionId, ...n }));
        // Quota is account-wide, so this one deliberately does not carry a
        // sessionId: which session happened to observe it says nothing.
        r.on('quota', (info) => this.emit('quota', info));
        r.on('permission-request', (p) => this.emit('permission-request', p));
        r.on('permission-resolved', (p) => this.emit('permission-resolved', p));
        r.on('turn-complete', (res) => this.emit('turn-complete', { sessionId: r.sessionId, ...res }));
        r.on('failed', (f) => this.emit('failed', { sessionId: r.sessionId, ...f }));
        r.on('agent-done', (a) => this.emit('agent-done', a));
        // The only route by which the app learns what slash commands a directory
        // has. It arrives once per process start and is worth keeping: a session
        // sitting idle in the rail has no process of its own, and its composer
        // still has to be able to offer a menu. The CLI reports its own cwd, so
        // there is nothing to infer. On a fork, `forked` is emitted just above
        // this in the same handler, so `r.sessionId` is already the copy's.
        r.on('init', (msg) => this.emit('init', {
            sessionId: r.sessionId, cwd: msg.cwd || r.cwd, init: msg,
        }));
        r.on('exit', () => this.emit('status', r.status()));
        r.on('forked', ({ from, to }) => {
            // Re-key so a later send reaches the copy, not the original.
            if (this.runners.get(from) === r) this.runners.delete(from);
            this.runners.set(to, r);
            this.emit('forked', { from, to });
        });
        if (carried.length) {
            r.queue.push(...carried);
            r._queueChanged();
        }
        this.runners.set(sessionId, r);
        return r;
    }

    /** Create a brand-new session and deliver its first prompt. */
    create({ cwd, model, permissionMode, prompt, attachments = [] }) {
        const dir = resolveWorkdir(cwd);
        const sessionId = randomUUID();
        const r = this.ensure(sessionId, { cwd: dir, model, permissionMode, isNew: true });
        // The first message takes files like any other. `send` has always accepted
        // them and `userContent` has always known what to do with them; this was the
        // one caller that dropped them on the floor, so a session could not be
        // started with the screenshot that was the reason for starting it.
        r.send(prompt, attachments);
        return { sessionId, status: r.status() };
    }

    statuses() {
        const out = {};
        for (const [id, r] of this.runners) out[id] = r.status();
        return out;
    }

    /**
     * Kill a session's process and forget it, without waiting for the idle
     * sweep. For a session being deleted: the process holds the transcript we
     * are about to unlink open and would carry on writing to a file nobody can
     * see, so a polite interrupt is not enough here.
     */
    async forget(sessionId) {
        const r = this.runners.get(sessionId);
        if (!r) return false;
        this.runners.delete(sessionId);
        try { await r.stop({ hard: true }); } catch { /* already gone */ }
        return true;
    }

    /**
     * Retire a runner and take it out of the pool.
     *
     * Both eviction paths go through here so that neither can quietly take a
     * queue with it. `retire()` only closes stdin, so a runner holding messages
     * that were never written used to leave the map with them still inside — and
     * because the runner was then unreachable, the user's messages were not
     * delayed, they were gone. `ensure` already knew this (it carries the queue
     * across a model change); eviction did not.
     */
    _evict(id, r, why) {
        // Before retire(), so the pool's own `failed` listener is still attached
        // and the hand-back actually reaches a window.
        r.handOverQueue(why);
        r.retire();
        this.runners.delete(id);
    }

    _evictIdle() {
        const now = Date.now();
        for (const [id, r] of this.runners) {
            if (r.state === 'busy') continue;
            if (now - r.lastUsedAt < IDLE_EVICT_MS) continue;
            this._evict(id, r,
                'That session had been idle for a while, so its process was shut down.');
        }
    }

    _evictTo(limit) {
        const idle = [...this.runners.entries()]
            .filter(([, r]) => r.state !== 'busy')
            .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
        while (this.runners.size > limit && idle.length) {
            const [id, r] = idle.shift();
            this._evict(id, r,
                'That session\u2019s process was shut down to make room for another one.');
        }
    }

    /**
     * Stand down.
     *
     * A turn in flight is left unsignalled rather than killed, so it can wind
     * down cleanly as our pipes close and whatever it already wrote stays in the
     * transcript. It will still stop — see Runner#detach — which is why killing
     * the bridge someone is using costs them work, and why development runs on
     * its own port.
     */
    shutdown({ force = false } = {}) {
        clearInterval(this._sweep);
        let left = 0;
        for (const r of this.runners.values()) {
            if (r.state === 'busy' && !force) { left++; r.detach(); continue; }
            // Hard, deliberately: the bridge is going away, so there is nobody
            // left to wait for a polite interrupt to be answered.
            r.stop({ hard: true });
        }
        this.runners.clear();
        return { stillRunning: left };
    }

    get busyCount() {
        let n = 0;
        for (const r of this.runners.values()) if (r.state === 'busy') n++;
        return n;
    }
}

module.exports = { RunnerPool, Runner, PERMISSION_MODES, resolveWorkdir };
