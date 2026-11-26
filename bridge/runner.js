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
// **What is Claude's and what is ours.** Everything about the CLI itself — its
// argv, the line a user turn is written as, what each line of its output means,
// how a control request is spelled, how its exits read — is the process adapter
// in bridge/runtimes/claude/process.js, whose header is the contract a second
// runtime implements. This file is the rest: the queue and `inFlight`, the
// approval cards and who may answer them, the stall clock and the activity label,
// eviction, the host note and adoption. It never parses a stream-json line; it
// acts on the adapter's events, so the parts below that say `can_use_tool` or
// `result` are describing what the Claude adapter turns into an `ask` or a
// `turn-end`. A runner takes `runtime` (default `claude`) and asks
// bridge/runtimes for its adapter.
//
// That process is normally not our child. It runs in the session host
// (bridge/host.js), which holds its pipes so that a bridge restart does not end
// the turn: `claude` stops at end-of-input, and the host is what keeps the input
// open while no bridge is there. A bridge on the way down *releases* its
// processes, leaving a note of what it knew (`_saveNote`), and the next one
// *adopts* them from that note and the output the host kept (`adopt`). Without a
// host, `spawnClaude` falls back to a plain child process and none of this
// happens.
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
// A turn that is busy and silent is *stalled*: `stalled` in status(), and a
// `stalled` event each way across the line. It exists because a hung `claude`,
// a lost `result` and an `inFlight` left full all look exactly like a slow turn
// from every surface otherwise. The rule, and why each part of it is there:
//
//   - Activity is any stream-json line, `lastActivityAt`. Tool starts and
//     results count by name too, and so does an ask being answered — the
//     wait for a person is not the process's silence.
//   - The clock runs from the later of that and `busySince`, and only while
//     busy, with no ask pending and no tool call open. The threshold is
//     `stallAfter(cwd)` from the pool (settings: `live.stalledAfterMinutes`);
//     zero turns it off.
//   - An open tool call stops the clock outright rather than lengthening it.
//     A build or a test run is silent on the stream for as long as it takes,
//     and any threshold short enough to be useful is one a real build crosses.
//     The cost, accepted: a wedged *tool* is not caught here. Bash bounds
//     itself (ten minutes at most), and an Agent call that runs for an hour is
//     ordinary — its subagent's lines carry `parent_tool_use_id` and count as
//     activity anyway. The clock restarts from the `tool_result`.
//   - One lazy timer per runner, armed on entering busy and re-armed on the
//     way past when activity moved the deadline, so a line costs a timestamp
//     and not a clearTimeout. Recovery is noticed inline, on the next line.
//
// None of this is a documented, stable surface, so every part of it is written
// to degrade rather than break: an unrecognised subtype is answered and ignored,
// a CLI that rejects the flag falls back to permission modes alone, and an
// interrupt that does not land falls through to the signal path.

const fs = require('fs');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');

const cfg = require('./config');
const runtimes = require('./runtimes');
const { toolDisplayName } = require('./tool-name');
const hostClient = require('./host-client');
const secrets = require('./secrets');

// The Claude adapter's helpers, re-exported below for the callers that imported
// them from here before the adapter existed: bridge/routes and the tests.
const claude = runtimes.get('claude').adapter;

// Queue entry ids only have to be unique per process; the UI never persists one.
let queueSeq = 0;

// Processes are cheap to restart (resume is a warm cache hit), so don't hoard them.
const MAX_LIVE = 4;
const IDLE_EVICT_MS = 15 * 60 * 1000;
// How long a background task is believed to be running with no word of it
// finishing. Generous: a dev server is the common case and runs for hours.
const BACKGROUND_STALE_MS = 12 * 60 * 60 * 1000;

const PERMISSION_MODES = ['auto', 'acceptEdits', 'plan', 'manual', 'dontAsk', 'bypassPermissions'];

// What `claude --effort` accepts. Anything else becomes null (inherit, which
// leaves the flag off) here, at the one place it would reach argv: the stores
// keep whatever string they were given, as they do for a model, so that a level
// added upstream is not silently erased from a draft by a build that predates it.
// The list itself is bridge/models.js's, which every picker also reads.
const { EFFORTS } = require('./models');
// Claude's levels are ours to list; another runtime's come from the runtime
// itself (Codex's `model/list`), so anything word-shaped is passed on and the
// runtime refuses what it does not offer.
const effortOrNull = (v, runtime = runtimes.DEFAULT) => (runtime === runtimes.DEFAULT
    ? (EFFORTS.includes(v) ? v : null)
    : (typeof v === 'string' && /^[a-z][a-z0-9_-]{0,30}$/.test(v) ? v : null));

/** Two held model/effort changes (either may be null) asking for the same thing. */
function sameSettings(a, b) {
    if (!a || !b) return !a === !b;
    return a.model === b.model && a.effort === b.effort;
}

/** "model", "effort" or "model and effort" — whichever `wants` changes. */
function settingsWord(r, wants) {
    const parts = [];
    if (wants.model !== r.model) parts.push('model');
    if (wants.effort !== r.effort) parts.push('effort');
    return parts.join(' and ');
}

// An outstanding ask never expires. It used to: two minutes for a tool call,
// fifteen for a plan or a question, on the theory that a blocked turn holds a
// process open and nobody may be there to answer. But the cost landed on the
// person who *was* there — you read a plan, thought about it, and the card was
// denied out from under you. Claude Code itself does not do that, so neither
// does this. The case that mattered is still covered, and covered up front
// rather than on a clock: _onAsk denies immediately when no window
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

/** The label an ask puts on a busy session while it waits. */
function waitingLabel(ask) {
    return ask.kind === 'plan' ? 'Waiting for you: a plan to approve'
        : ask.kind === 'question' ? 'Waiting for you: a question'
        : `Waiting for you: ${ask.displayName}`;
}

class Runner extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.sessionId
     * @param {string} opts.cwd
     * @param {boolean} opts.isNew   start a fresh session rather than resuming
     * @param {string} [opts.runtime] which CLI drives it; `claude` when absent
     * @param {{permissionPrompt:boolean, interrupt:boolean}} [opts.caps]
     *   What this `claude` build has been observed to support. Shared across the
     *   pool, so one runner discovering a gap spares the rest from rediscovering
     *   it.
     */
    constructor(opts) {
        super();
        this.sessionId = opts.sessionId;
        this.cwd = opts.cwd;
        // The CLI on the other end, and the adapter that speaks to it. Fixed for
        // the runner's life: a session does not change runtime, and its
        // capabilities are what clients hide controls by.
        this.runtime = opts.runtime || runtimes.DEFAULT;
        this.capabilities = runtimes.capabilitiesOf(this.runtime);
        // What clients call it, `{name, product}`; fixed for the runner's life too.
        this.agent = runtimes.agentOf(this.runtime);
        this.tools = runtimes.toolsOf(this.runtime);
        this.adapter = new (runtimes.get(this.runtime).adapter.Adapter)({
            rpc: (verb, payload) => this._control(verb, payload),
            // A line nobody waits on the answer to: JSON-RPC's notifications
            // (Codex's `initialized`). See the contract.
            notify: (line) => this._write(line),
        });
        this.isNew = !!opts.isNew;
        this.model = opts.model || null;
        this.effort = effortOrNull(opts.effort, this.runtime);
        this.permissionMode = opts.permissionMode || 'auto';
        // Branch off a copy instead of continuing in place. Needed when the
        // original is already live somewhere else.
        this.fork = !!opts.fork;
        // And where to cut that copy: `{fromUuid, parent, guard}`, from the send
        // route, when the fork is a branch from one of your earlier turns rather
        // than a copy of the whole conversation. Meaningless without `fork`, and
        // spent with it — see the reset below the spawn.
        this.branch = this.fork && opts.branch ? opts.branch : null;
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
        // How long a busy turn may be silent before it is reported stalled, in
        // ms; 0 is never. Delegated like the two above. See the header.
        this.stallAfter = opts.stallAfter || (() => 0);
        // Whether the browser an agent tests with gets a window. Supplied by the
        // pool from `agentBrowser.mode`; see the adapter's `env`.
        this.agentBrowser = opts.agentBrowser || (() => 'visible');
        // Whether this session may drive the browser preview — `preview.agentControl`,
        // supplied by the pool and read at each spawn. See the adapter's `argv`.
        this.previewControl = opts.previewControl || (() => false);
        // The agent brief for this session, or null — see bridge/brief.js.
        // Supplied by the pool and asked at each spawn, so a settings change
        // reaches the next process, resumed ones included.
        this.agentBrief = opts.agentBrief || (() => null);
        // `{key, port}` for the sudo askpass helper when Settings › Sudo is on,
        // else null; and the sudo ask this session is blocked on, if any. Both
        // supplied by the pool — see bridge/sudo.js.
        this.sudoAccess = opts.sudoAccess || (() => null);
        this.sudoAskFor = opts.sudoAskFor || (() => null);
        // The secret this session's agent asked for and you have not answered.
        this.secretAskFor = opts.secretAskFor || (() => null);
        this.lastActivityAt = null;    // the last stream line, tool or answered ask
        this.stalled = false;
        this._stallTimer = null;

        this.proc = null;
        // What `claude --version` the running process is, from its init line.
        // Not the transcript's `version`, which is the first one that ever wrote
        // to it: a session outlives the binary it started on, and the question
        // claude-version.js asks is whether *this process* predates an update.
        this.claudeVersion = null;
        this.context = null;
        this.state = 'stopped';        // stopped | starting | idle | busy | error
        this.activity = null;          // human-readable "what is it doing right now"
        this.lastError = null;
        this.lastResult = null;        // {costUsd, durationMs, numTurns, isError, usageLimit}
        this._limitInfo = null;        // this turn's `rejected` rate_limit_info, until its result
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
        // Has this process shown us its command queue? Every message written to a
        // build that has one comes back as `command_lifecycle` frames — our own
        // first send included, well before any tool runs — so seeing one is proof
        // enough that a message handed over mid-turn will be folded in rather than
        // misread. Per process, not pool-wide like `caps`: it is learned for free
        // on every start, and a build without it simply never sets it. See _handOver.
        this._lifecycle = false;
        this._buf = '';
        this._stderr = '';
        this._pendingTools = new Map();
        // Work this process started and has not reported finished: a command run
        // with `run_in_background`, a subagent sent off on its own. taskId ->
        // {type, startedAt}. It runs *inside* `claude`, so a turn that started it
        // and ended reports `idle` while it carries on — and replacing or evicting
        // an idle process killed it, which the resumed one then announces as
        // "background tasks didn't finish before the previous session ended".
        // Per process: cleared wherever the process goes. See `hasBackground`.
        this.background = new Map();
        // A model or effort change that arrived while `background` was not empty,
        // held until it is. {model, effort}, or null. Applied by the pool.
        this.pendingSettings = null;

        // -- control channel ------------------------------------------------
        this.caps = opts.caps || this.adapter.initialCaps();
        /** Is anyone actually in a position to answer an approval card? */
        this.hasViewer = opts.hasViewer || (() => false);
        /**
         * Is somebody other than a window going to answer this session's asks?
         * True for a worker whose orchestrator takes its prompts — see
         * bridge/orchestration.js. It is what keeps the no-window auto-deny from
         * firing on a worker nobody is looking at, which is most of them.
         */
        this.delegated = opts.delegated || (() => false);
        /**
         * `{role, brief}` for this session's part in an orchestration, or null.
         * Asked at each spawn, so a session marked an orchestrator gets its tools
         * on the next process it starts.
         */
        this.roleOf = opts.roleOf || (() => null);
        /** @type {null | {id:string, tool:string, input:object, askedAt:number}} */
        this.pendingPermission = null;
        this._ctlSeq = 0;
        this._pending = new Map();     // request_id -> {resolve, reject, timer}
        // Tools the user said yes to for the rest of this session. The CLI is
        // told too (destination "session"), so this only does work after a
        // process restart, when the CLI's own copy is gone and ours is not.
        this._sessionAllow = new Set();
        // The asks this runner has answered, most recent last and capped. Only
        // ever read by the next bridge: it is how an adopted process tells a card
        // still waiting on somebody from one that was answered moments before the
        // restart, since both look the same in the replayed output.
        this._answered = [];
        // Tags this runner's outbound control ids. A process adopted from the host
        // may still answer a request the previous bridge made, and without the tag
        // that answer would land on whichever request of ours had the same number.
        this._ctlTag = randomUUID().slice(0, 6);
        this._autoDenies = 0;
        // This process did not answer an interrupt in time. Not the same claim as
        // `caps.interrupt`, which is about the build and is shared by the whole
        // pool — see stop().
        this._interruptTimedOut = false;
        // True from the spawn until the adapter's handshake settles, for an
        // adapter whose handshake gates the queue (`handshakeGates`). Nothing is
        // written while it is set — see start().
        this._handshaking = false;
        // `{kind, message}` once a gated handshake has failed and the process is
        // being ended for it; the close handler reads it in place of stderr.
        this._fatal = null;
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
        this.background.clear();
        this.lastError = null;
        this.errorKind = null;
        // A fresh process is not the one that was too busy to answer.
        this._interruptTimedOut = false;
        this._fatal = null;
        this._handshaking = false;

        // Ours, whichever CLI is on the other end: which part of an orchestration
        // this session plays, whether it may drive the preview, and what TGXCode
        // is and offers (bridge/brief.js) followed by what that part is for, with
        // the user's own addendum. The adapter decides how each reaches the
        // process — see `argv` in bridge/runtimes/claude/process.js for why the
        // tools these name are auto-approved and how the prompt is appended.
        const role = this.roleOf(this.sessionId);
        this.role = role ? role.role : null;
        let preview = false;
        try { preview = this.previewControl(this.cwd) === true; } catch { /* off */ }
        let general = null;
        try { general = this.agentBrief(this.cwd, this.role); } catch { /* no brief beats no session */ }
        const systemPrompt = [general, role && role.brief].filter(Boolean).join('\n\n');
        // `isNew`, `fork` and `branch` are facts about *this start*, not about
        // the runner — see the reset below the spawn, and the bug that reset fixes.
        // The same object goes to the handshake below: a runtime that starts or
        // resumes its conversation by request rather than by flag needs exactly
        // what argv is told.
        const startOpts = {
            sessionId: this.sessionId, cwd: this.cwd, permissionMode: this.permissionMode,
            model: this.model, effort: this.effort,
            isNew: this.isNew, fork: this.fork, branch: this.branch,
            role: this.role, preview, systemPrompt: systemPrompt || null, caps: this.caps,
        };
        const args = this.adapter.argv(startOpts);

        this._setState('starting', `Starting ${this.adapter.label}…`);

        try {
            // In the session host when there is one (bridge/host.js), so the turn
            // outlives this bridge; as our own child when there is not. Either way
            // what comes back has the ChildProcess surface the rest of this file
            // uses, and nothing below needs to know which it got.
            this.proc = hostClient.spawnClaude(this.adapter.bin, args, {
                cwd: this.cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: this.adapter.env({ browser: this.agentBrowser(this.cwd),
                    sudo: this.sudoAccess(this.sessionId) }),
                // Its own process group, so a Ctrl-C aimed at the bridge is not
                // also delivered to a turn in flight; it gets to shut down on
                // stdin EOF instead of being interrupted mid-write.
                //
                // Spawned directly, this does not make a turn outlive the bridge:
                // `claude` reads stdin for input, so when the bridge exits and the
                // pipe closes it treats that as end-of-input and stops. Owning the
                // pipe somewhere else is the only thing that does, and that is
                // what the host is for.
                detached: true,
            }, this.sessionId);
        } catch (err) {
            this.lastError = `Could not start ${this.adapter.bin}: ${err.message}`;
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
        //   `branch` goes with `fork`, for the same reason and one more: re-passing
        //   `--resume-session-at` on the copy would cut *it* back as well, losing
        //   the turn this start was made to send.
        //
        // Clearing them here rather than on `system/init`: the id exists from the
        // moment the CLI opens the file, so a restart has to resume whether or not
        // the handshake got as far as telling us so. The one exit that restarts
        // deliberately puts them back — see the permission-prompt branch of
        // `close`, which is reached before the CLI has done anything at all.
        const wasNew = this.isNew;
        const wasFork = this.fork;
        const wasBranch = this.branch;
        this.isNew = false;
        this.fork = false;
        this.branch = null;

        this._bind(this.proc, { wasNew, wasFork, wasBranch });
        // Before anything is written, so a bridge that dies before the first line
        // still leaves the host a record of whose process this is.
        this._saveNote();

        // Whatever the CLI expects a client to open with; see the adapter's.
        // Called synchronously, so whatever it writes first is written before the
        // first turn is.
        let shake;
        try { shake = Promise.resolve(this.adapter.handshake(startOpts)); } catch (err) { shake = Promise.reject(err); }

        if (!this.adapter.handshakeGates) {
            shake.catch(() => { /* older build; the fallbacks cover it */ });
            // The process is ready for input immediately; `system/init` confirms it.
            this._setState('idle', null);
            this._flushQueue();
            return;
        }

        // A runtime that refuses everything until it has been introduced, and
        // cannot take a turn until its conversation has been opened by request
        // (Codex: `initialize`, then `thread/start` or `thread/resume`). The
        // runner stays `starting`, and the queue stays ours — editable, and
        // handed back if this never finishes — until the handshake settles. A
        // rejection is not "an older build" here: the process can do nothing, so
        // it is ended and the reason is the session's error.
        this._handshaking = true;
        const proc = this.proc;
        shake.then(() => {
            if (this.proc !== proc || !this._handshaking) return;
            this._handshaking = false;
            if (this.state === 'starting') this._setState('idle', null);
            this._flushQueue();
        }, (err) => {
            if (this.proc !== proc || !this._handshaking) return;
            this._handshaking = false;
            // `kind` is the adapter's, from docs/api.md's `send-failed` kinds; a
            // failure it did not classify is `unknown`, said in its own words.
            this._fatal = {
                kind: (err && err.kind) || 'unknown',
                message: (err && err.kind && err.message)
                    || `${this.adapter.product} did not finish starting: ${(err && err.message) || 'no reason given'}`,
            };
            try { proc.stdin.end(); } catch { /* already closed */ }
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 1500).unref();
            try { proc.kill('SIGTERM'); } catch { /* gone */ }
        });
    }

    /**
     * Listen to a process: its output, its errors, and above all its exit.
     *
     * Shared by the two ways a runner comes to have a process — starting one, and
     * adopting one a previous bridge left in the host — so that an adopted process
     * dies exactly the way a started one does. `wasNew`/`wasFork` are what the
     * permission-prompt retry puts back; an adopted process was never new here.
     */
    _bind(proc, { wasNew = false, wasFork = false, wasBranch = null } = {}) {
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (chunk) => this._onStdout(chunk));
        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', (chunk) => {
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
        proc.stdin.on('error', () => { /* the process is going away */ });
        proc.stdout.on('error', () => { /* ditto */ });
        proc.stderr.on('error', () => { /* ditto */ });

        proc.on('error', (err) => {
            this.lastError = err.message;
            this._setState('error', null);
        });

        proc.on('close', (code) => {
            this.proc = null;
            this.claudeVersion = null;
            // The transcript's reading takes over once nobody is saying it live.
            this.context = null;
            this._pendingTools.clear();
            // Whatever it was running in the background went with it.
            this.background.clear();
            this.pendingSettings = null;
            this._abandonControl(`the ${this.adapter.label} process exited`);
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
            // Whatever was handed over and never started went down with the
            // process's own queue. It is ours again — waiting, and unsent as far
            // as anything after this is concerned, including the next process.
            for (const q of this.queue) q.handed = false;
            this._lifecycle = false;
            this._handshaking = false;
            if (this._fatal) {
                // A gated handshake failed and start() ended the process for it.
                // Nothing was written past the handshake, so the queue — and
                // `flight`, which is empty — goes back whole, and the reason is
                // the adapter's rather than whatever the process said as it went.
                const fatal = this._fatal;
                this._fatal = null;
                this._stopping = false;
                this.errorKind = fatal.kind;
                this.lastError = fatal.message;
                this._handBack(fatal.kind, fatal.message, flight);
                this._setState('error', null);
            } else if (this._stopping) {
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
                        `The ${this.adapter.label} process was shut down before these messages were sent.`);
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
                        `${this.adapter.product} exited without answering.`, flight);
                }
                this._setState('stopped', null);
            } else {
                const raw = this._stderr.trim();

                // A build that does not know a flag rejects it before doing any
                // work — for Claude, `--permission-prompt-tool`. Drop that part of
                // the protocol for the rest of the bridge's life rather than
                // letting a version difference break sending, and put the turn
                // back on the queue so nothing is lost.
                const refusal = this.adapter.argvRefusal(raw, this.caps);
                if (refusal) {
                    this.caps[refusal.cap] = false;
                    // The one branch where re-queueing is provably right: a build
                    // that does not know the flag rejects it while parsing argv,
                    // so the line was never read and no turn was ever recorded.
                    // Nothing was minted or branched either, which is why the
                    // start flags go back rather than the retry resuming an id
                    // that does not exist yet.
                    this.queue = flight.concat(this.queue);
                    this.isNew = wasNew;
                    this.fork = wasFork;
                    this.branch = wasBranch;
                    this._stderr = '';
                    this.emit('notice', refusal.notice);
                    this.emit('exit', code);
                    this.start();
                    return;
                }

                const classified = this.adapter.classifyExit(raw, code);
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
        const entry = { id: `q${++queueSeq}`, uuid: randomUUID(), text, at: Date.now(), attachments };
        // A card answered by the next turn (`followUp`) is answered by this one:
        // typing past a plan or a question is the reply to it.
        if (this.pendingPermission && this.pendingPermission.followUp) {
            this._markAnswered(this.pendingPermission.id);
            this._clearPermission('superseded');
        }
        this.queue.push(entry);
        if (!this.proc) this.start();
        else { this._flushQueue(); this._handOver(); }
        if (this.queue.includes(entry)) this._queueChanged();
        return entry;
    }

    /**
     * Hand the next message to an idle process.
     *
     * The CLI would happily take several lines at once, but then they are gone:
     * nothing can be reordered or taken back, and there is no queue left for the
     * UI to show. So while nothing is running, one message goes at a time and the
     * rest wait here, where they can still be edited, reordered or dropped.
     *
     * While a turn *is* running, a tool call starting is what moves them on — see
     * _handOver, which is the other way out of this queue.
     */
    _flushQueue() {
        if (!this.proc || !this.proc.stdin.writable) return;
        // A gated handshake still under way: the process cannot take a turn yet.
        if (this._handshaking) return;
        // `inFlight` is the gate, not just bookkeeping: while anything is in it
        // nothing else is written, which is what keeps one turn in flight at a
        // time. That makes a stale entry silent and total — the runner reports
        // `idle`, the route reports `queued`, and no message will ever be written
        // again. Every path that nulls `this.proc` therefore has to empty it; see
        // the close handler, `detach`, and the top of `start`.
        if (this.state === 'busy' || this.inFlight.length) return;
        // A message already handed over is the process's next turn, and it will
        // start it on its own. Writing another would put this one ahead of it.
        if (this.queue.some(q => q.handed)) return;
        // A move is waiting for this turn to end (orchestration.settleMove). What
        // is queued goes across with it and is the new process's first turn;
        // written here, it would start one more turn in the directory being left,
        // and the move would wait for that one too.
        if (this.queue.length && this.holdQueue && this.holdQueue()) return;
        const entry = this.queue.shift();
        if (!entry) return;
        // Held until a result arrives: if the process dies first, this text
        // was never written to the transcript and would otherwise be lost.
        //
        // Recorded, and told to the host, *before* the write rather than after.
        // The host handles one connection's messages in order, so a bridge that
        // dies between the two still leaves a note saying a turn went out — and
        // the next bridge gates its queue on that note. After would leave a
        // window where the turn is in the process and the note says idle.
        this.inFlight.push(entry);
        this._saveNote();
        // A rejected write means the process is going away. The message is still
        // ours at that point, so put it back rather than dropping it on the floor.
        if (!this._write(this.adapter.turn(entry, { handOver: false }))) {
            this.inFlight.pop();
            this.queue.unshift(entry);
            return;
        }
        this._work();
        // _setState only reports when the state or activity moved; a shorter
        // queue is news on its own.
        this._queueChanged();
    }

    /**
     * Give everything waiting to the running turn, to be read at its next step.
     *
     * This is what a terminal does with a message typed while Claude works: the
     * CLI keeps its own queue, and a user message written to it mid-turn is folded
     * into that turn when the current tool round ends — the model gets it beside
     * the tool result, as "the user sent a new message while you were working",
     * and can change course there rather than after all of the work it was about.
     * Waiting for `result` instead, which is what this app used to do, meant a
     * "stop, wrong file" was read only once every wrong file had been edited.
     *
     * **Only while a tool is running.** The fold happens between tool rounds, so
     * a message handed over while the model is only writing text would simply be
     * the next turn — which is what staying here makes it anyway, and staying here
     * keeps it editable for longer. Both halves measured against 2.1.280.
     *
     * A handed message stays on `queue`, flagged, rather than moving somewhere
     * else. It is still the user's until the CLI says it started: the chip stays,
     * dequeue can still take it back (`cancel_async_message`), and every path that
     * hands the queue back on a failure keeps covering it without knowing about
     * this. It leaves the queue on the `command_lifecycle` frame that says what
     * became of it — see _onLifecycle.
     */
    _handOver() {
        if (!this._lifecycle || !this._pendingTools.size) return;
        if (!this.proc || !this.proc.stdin.writable || this._handshaking) return;
        const waiting = this.queue.filter(q => !q.handed);
        if (!waiting.length) return;
        for (const entry of waiting) {
            // Before the write, for _flushQueue's reason: a bridge that dies
            // between the two must leave a note saying the process has it.
            entry.handed = true;
            this._saveNote();
            // `handOver` tells the adapter this joins the running turn rather than
            // starting one: the same line for Claude, a different request for a
            // runtime that steers (Codex's `turn/steer`).
            if (!this._write(this.adapter.turn(entry, { handOver: true }))) { entry.handed = false; break; }
        }
        this._queueChanged();
    }

    /**
     * What the CLI did with a message we wrote, by the uuid we wrote it with.
     *
     *   queued     it is in the CLI's queue. Nothing to do; to us it already was.
     *   started    it reached the model, and its user entry (or, folded into a
     *              running turn, its `queued_command` attachment) is in the
     *              transcript. Off the queue and in flight, like a flushed turn.
     *   completed  the turn that took it ended; `result` accounts for that.
     *   cancelled  taken back — by cancel_async_message, or swept by an interrupt.
     *   discarded  the session ended with it still queued.
     *   returned   not taken, and still wanted: the turn it was handed to had
     *              already ended (Codex refuses a steer that loses that race). It
     *              is ours again, unhanded, at the front of the queue, and goes out
     *              as a turn of its own once nothing is running — never dropped.
     */
    _onLifecycle(ev) {
        this._lifecycle = true;
        const i = this.queue.findIndex(q => q.handed && q.uuid === ev.uuid);
        if (i < 0) return;
        if (ev.state === 'started') {
            const [entry] = this.queue.splice(i, 1);
            this.inFlight.push(entry);
            // Folded into the running turn, or starting the next one after a
            // `result` that went by first. Either way it is working.
            if (this.state !== 'busy') this._work();
            this._queueChanged();
        } else if (ev.state === 'cancelled' || ev.state === 'discarded') {
            this.queue.splice(i, 1);
            this._queueChanged();
            this._settleIfDone();
        } else if (ev.state === 'returned') {
            this.queue[i].handed = false;
            this._queueChanged();
            // Usually the turn has ended already and was only staying busy for
            // this one; settling flushes it. If a turn is still running it waits,
            // and the next tool call may hand it over again.
            this._settleIfDone();
            this._flushQueue();
        }
    }

    /**
     * Go idle once a `result` has gone by and nothing handed over is still coming.
     * The `result` handler stays busy while the CLI holds one of ours, since it
     * will start it as the next turn; this is how that ends when it does not.
     */
    _settleIfDone() {
        if (this.state !== 'busy' || this.inFlight.length || this._pendingTools.size) return;
        if (this.pendingPermission || this.queue.some(q => q.handed)) return;
        this._setState('idle', null);
        this._flushQueue();
    }

    /**
     * Drop one waiting message. Resolves to it, or to null if it already went out.
     *
     * A message handed over to the running turn is taken back from the CLI's own
     * queue first, and only dropped here if the CLI agrees it had not started it:
     * a chip that vanished for a message Claude then read anyway would be the one
     * lie this list must not tell.
     */
    async dequeue(id) {
        const entry = this.queue.find(q => q.id === id);
        if (!entry) return null;
        if (entry.handed && !(await this._withdraw(entry))) return null;
        // Possibly gone already. The CLI announces the cancel with a lifecycle
        // frame *before* its answer to the request — measured, both on 2.1.280 —
        // so _onLifecycle has usually taken it off by now. It was still withdrawn.
        const i = this.queue.indexOf(entry);
        if (i >= 0) {
            this.queue.splice(i, 1);
            this._queueChanged();
        }
        if (entry.handed) this._settleIfDone();
        return entry;
    }

    /** Drop everything still waiting. Resolves to what was actually dropped. */
    async clearQueue() {
        const dropped = [];
        for (const entry of this.queue.slice()) {
            const gone = await this.dequeue(entry.id);
            if (gone) dropped.push(gone);
        }
        return dropped;
    }

    /**
     * Take the queue for another process, synchronously. Only for a runner that is
     * not busy, which is when nothing can have been handed over — the `result`
     * handler stays busy while anything is — and an entry carried to a new process
     * must never also be sitting in this one's CLI queue.
     */
    takeQueue() {
        const taken = this.queue.filter(q => !q.handed);
        if (!taken.length) return [];
        this.queue = this.queue.filter(q => q.handed);
        this._queueChanged();
        return taken;
    }

    /**
     * Ask the CLI to give back a message handed over mid-turn. True only when it
     * says it did; a build or a moment that cannot answer counts as "too late",
     * which leaves the chip up rather than pretending.
     */
    async _withdraw(entry) {
        try {
            return await this.adapter.withdraw(entry.uuid);
        } catch {
            return false;
        }
    }

    /**
     * Put the queue in the order given. Ids that are no longer waiting are
     * ignored, and anything the caller did not mention keeps its place at the
     * back — a message that flushed while the drag was in progress must not
     * take the rest of the queue with it.
     */
    reorder(ids) {
        // Handed-over messages are in the CLI's queue in the order they were
        // written, so they keep their place at the front whatever the drag said.
        const byId = new Map(this.queue.filter(q => !q.handed).map(q => [q.id, q]));
        const next = this.queue.filter(q => q.handed);
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
        this._saveNote();
        this.emit('status', this.status());
    }

    /**
     * Leave the host what the next bridge needs and cannot read off the output.
     *
     * The replay says what `claude` did; this says what *we* did — which turn we
     * sent and are waiting on, what is still queued, which asks were answered,
     * what the user said yes to for the session. All of it lived only in this
     * object before, which is fine while the object outlives the process and is
     * the whole problem once the process can outlive the object.
     *
     * A no-op for a process spawned directly: there is nobody to leave it with,
     * and nothing will outlive us to read it.
     */
    _saveNote() {
        if (!this.proc || !this.proc.hosted) return;
        const entry = (q) => ({ uuid: q.uuid, text: q.text, at: q.at,
            attachments: q.attachments || [], ...(q.handed && { handed: true }) });
        this.proc.note({
            v: 1,
            sessionId: this.sessionId,
            cwd: this.cwd,
            model: this.model,
            effort: this.effort,
            permissionMode: this.permissionMode,
            claudeVersion: this.claudeVersion,
            inFlight: this.inFlight.map(entry),
            queue: this.queue.map(entry),
            lifecycle: this._lifecycle,
            background: [...this.background].map(([id, t]) => ({ id, ...t })),
            pendingSettings: this.pendingSettings,
            answered: this._answered,
            sessionAllow: [...this._sessionAllow],
            // The ask the process is blocked on, whole — its id is the runtime's
            // own request id (an integer for Codex, kept as `rpcId`), which is
            // what the next bridge answers. adopt() starts from it.
            ...(this.pendingPermission && { pending: this.pendingPermission }),
            // Only when it is not the default, so a Claude session's note is the
            // one it always was. adoptHeld makes the runner from it.
            ...(this.runtime !== runtimes.DEFAULT && { runtime: this.runtime }),
        });
    }

    _markAnswered(id) {
        this._answered.push(id);
        if (this._answered.length > 20) this._answered.shift();
        this._saveNote();
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
                message: 'Stopped from TGXCode before this was approved.',
            });
            this._clearPermission('stopped');
        }

        if (!hard && this.caps.interrupt && !this._interruptTimedOut) {
            this.queue.length = 0;
            try {
                await this.adapter.interrupt();
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
            const id = `req_${this._ctlTag}_${++this._ctlSeq}`;
            if (!this._write(this.adapter.request(id, subtype, payload))) {
                reject(controlError(`the ${this.adapter.label} process is not accepting input`, 'closed'));
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
     * The process is blocked on a person: an `ask` event from the adapter. For
     * Claude that is a `can_use_tool` control request; anything else inbound is
     * a `request` event, answered with the adapter's refusal in _onEvent.
     */
    _onAsk({ ask, uninteractive }) {
        // A plan and a question are asks this app has a real answer for; every
        // other tool that wants its own dialog is one it does not.
        const kind = ask.kind;

        // An ask nothing is blocked on: a runtime whose plan or question arrives
        // as part of a turn rather than as a request (Codex's `plan` item and its
        // async question tool). The card goes up and the session stays as it is;
        // the answer is the next turn (_answerFollowUp), and with no window open
        // it simply waits — denying it would send a turn nobody asked for.
        if (ask.followUp) {
            if (this.pendingPermission && this.pendingPermission.followUp) {
                this._markAnswered(this.pendingPermission.id);
                this._clearPermission('superseded');
            }
            if (this.pendingPermission) return;
            this.pendingPermission = ask;
            this._saveNote();
            this.emit('permission-request', { sessionId: this.sessionId, ...publicAsk(ask) });
            this.emit('status', this.status());
            return;
        }

        // Some MCP asks need a dialog of the server's own, which this channel
        // cannot carry. Offering Allow would be a lie — the call fails anyway —
        // so say what happened instead of pretending it was a choice.
        if (uninteractive && kind === 'tool') {
            this._respondPermission(ask, {
                behavior: 'deny',
                message: 'This tool needs its own interactive prompt, which Claude '
                    + 'Sessions cannot show. Run it from a terminal.',
            });
            this.emit('notice', {
                level: 'warn', kind: 'permission_uninteractive',
                text: `${toolDisplayName(ask.tool)} asked for an interactive prompt this app cannot show, `
                    + 'so it was denied. That tool needs a terminal.',
            });
            return;
        }

        if (this.tools.alwaysAllow.has(ask.tool)) {
            this._respondPermission(ask, { behavior: 'allow' });
            return;
        }

        // Said yes to this tool earlier in the session, before the process was
        // last restarted. The CLI has forgotten; we have not.
        //
        // Only tools: "always allow" is a statement about a kind of action, and
        // a plan or a question has no kind — each one is a different plan and a
        // different question, and answering the next one in advance is not
        // something anybody can mean.
        //
        // An ask that carries the runtime's own decisions is answered this way
        // only when one of them is allow-for-the-session; otherwise the yes given
        // earlier is not one this runtime can say, and the card goes up.
        const sessionChoice = ask.decisions
            ? choiceFor(ask, 'allow', { allowSession: true, strict: true }) : null;
        if (kind === 'tool' && this._sessionAllow.has(ask.tool) && (!ask.decisions || sessionChoice)) {
            this._respondPermission(ask, { behavior: 'allow', allowSession: true, choice: sessionChoice });
            return;
        }

        // Nothing is attached to answer, so the honest outcome is the one the
        // app produced before any of this existed: denied.
        if (!this.hasViewer() && !this.delegated()) {
            this._autoDeny(ask, kind === 'tool'
                ? 'No TGXCode window was open to approve this, so it was denied.'
                : `No TGXCode window was open to answer this, so ${
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
        // So a bridge that goes before this is answered leaves the request — and
        // the runtime's id for it — with the host. See adopt().
        this._saveNote();
        this._setState('busy', waitingLabel(ask));
        this.emit('permission-request', { sessionId: this.sessionId, ...publicAsk(ask) });
    }

    /**
     * Answer an outstanding ask. Called from the UI.
     *
     * A `{ok: false, invalid: true}` is a request that could never be right —
     * a choice the ask did not offer, or an old-style decision it has no
     * equivalent for — and the route answers it 400 rather than 409.
     *
     * @param {string} requestId
     * @param {'allow'|'allow-always'|'deny'|null} decision null when `extra.choice` says it
     * @param {object} [extra]
     * @param {string} [extra.choice] the `id` of one of the ask's `decisions`
     * @param {object} [extra.updatedInput] edited tool input to run instead
     * @param {Record<string,string|string[]>} [extra.answers] answers, keyed by
     *   question text or by a question's `id`
     * @param {string} [extra.feedback] what to tell the model when it is turned down
     * @param {string} [extra.mode] permission mode to continue an approved plan in
     */
    answerPermission(requestId, decision, extra = {}) {
        const ask = this.pendingPermission;
        if (!ask) return { ok: false, error: 'nothing is waiting for approval' };
        // Two windows, one ask: the first answer wins and the second is told so
        // rather than silently doing nothing.
        if (ask.id !== requestId) return { ok: false, error: 'that request was already answered' };

        // A choice from the runtime's own list (`decisions`, tool asks only),
        // which says the decision itself. Without one, an ask that carries a list
        // is answered with the entry the old word means — or refused, rather than
        // quietly answered with something stronger or weaker than the button said.
        let choice = null;
        if (extra.choice != null && extra.choice !== '') {
            choice = (ask.decisions || []).find(d => d.id === String(extra.choice)) || null;
            if (!choice) return { ok: false, invalid: true, error: 'that is not one of this ask\u2019s decisions' };
            decision = choice.behavior === 'deny' ? 'deny' : choice.scope === 'once' ? 'allow' : 'allow-always';
        } else if (ask.decisions && ask.kind === 'tool') {
            choice = choiceFor(ask, decision === 'deny' ? 'deny' : 'allow',
                { allowSession: decision === 'allow-always', strict: true });
            if (!choice) {
                return { ok: false, invalid: true, error: `this ask offers no ${
                    decision === 'allow-always' ? 'allow for the session' : decision}; choose one of its decisions` };
            }
        }

        this.lastUsedAt = Date.now();
        this._autoDenies = 0;   // somebody is here; the spin guard can reset

        if (ask.followUp) return this._answerFollowUp(ask, decision, extra);
        if (ask.kind !== 'tool') return this._answerConversation(ask, decision, extra);

        if (decision === 'deny') {
            this._respondPermission(ask, {
                behavior: 'deny', message: 'Denied from TGXCode.', choice,
            });
        } else {
            // "For the session" is ours to remember across a restart; a rule the
            // runtime keeps for good (`scope: 'always'`) is the runtime's.
            const always = choice ? choice.scope === 'session' : decision === 'allow-always';
            if (always) this._sessionAllow.add(ask.tool);
            let { updatedInput } = extra;
            // An edited command was edited unwrapped, as the card showed it; it
            // still needs its secrets, so it goes back into the same wrapper.
            if (ask.secrets && updatedInput && typeof updatedInput.command === 'string') {
                updatedInput = { ...updatedInput, command: secrets.wrapCommand(updatedInput.command,
                    ask.secrets.names, { node: ask.secrets.node, exec: ask.secrets.exec }) };
            }
            this._respondPermission(ask, {
                behavior: 'allow',
                updatedInput: updatedInput && Object.keys(updatedInput).length ? updatedInput : null,
                allowSession: always,
                choice,
            });
        }
        this._clearPermission(decision, choice);
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
            // `answers` is keyed by the question text, which is what Claude
            // matches on, or by a question's `id` where the runtime gives one
            // (Codex answers by id). A key that names no question is dropped
            // rather than passed through, so a stale card cannot answer a live
            // question. A value is one string or several.
            //
            // What reaches the adapter is a list, `[{id, question, answers:
            // [string]}]`, and the adapter says it in its runtime's shape: Claude
            // puts it in `updatedInput.answers` keyed by text, Codex in
            // `{answers: {<id>: {answers}}}`. The runner no longer builds either.
            const given = givenAnswers(ask, answers);
            if (!given.length) {
                return { ok: false, error: 'no answers were given' };
            }
            this._respondPermission(ask, { behavior: 'allow', answers: given });
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
     * Answer an ask that nothing is blocked on (`followUp`) by sending the next
     * turn — the plan card and the async question card of a runtime that has no
     * request behind either (docs/plans/23-codex.md, Phase 3). The card is drawn
     * the same and answered through the same route; what it does is ours.
     *
     *   plan, approved   switch out of plan mode (to `mode`, or acceptEdits) and
     *                    send "Implement the plan.", with the note if there is one
     *   plan, revised    send the feedback as another plan turn
     *   question         send the answers as the next turn; dismissed sends nothing
     */
    _answerFollowUp(ask, decision, { answers, feedback, mode } = {}) {
        const turnedDown = decision === 'deny';
        let text = null;
        let outcome;
        if (ask.kind === 'plan') {
            const said = String(feedback || '').trim();
            if (turnedDown) {
                text = said || 'Not yet — revise the plan.';
                outcome = 'plan-rejected';
            } else {
                text = said ? `Implement the plan.\n\n${said}` : 'Implement the plan.';
                outcome = said ? 'plan-approved-note' : 'plan-approved';
            }
        } else if (turnedDown) {
            outcome = 'dismissed';
        } else {
            const given = givenAnswers(ask, answers);
            if (!given.length) return { ok: false, error: 'no answers were given' };
            text = given.map(g => (ask.input.questions.length > 1 || g.question
                ? `${g.question}\n${g.answers.join(', ')}` : g.answers.join(', '))).join('\n\n');
            outcome = 'answered';
        }
        this._markAnswered(ask.id);
        this._clearPermission(outcome);
        if (ask.kind === 'plan' && !turnedDown) {
            const next = mode && mode !== 'plan' ? mode
                : this.permissionMode === 'plan' ? 'acceptEdits' : this.permissionMode;
            if (next !== this.permissionMode) this._setPermissionMode(next);
        }
        if (text) this.send(text);
        return { ok: true };
    }

    /**
     * Change the mode of the running process.
     *
     * Also kept locally, because the mode outlives the process: a later restart
     * builds its argv from `permissionMode`, and a session that had left plan
     * mode must not silently return to it.
     */
    _setPermissionMode(mode, { approved = true } = {}) {
        const previous = this.permissionMode;
        this.permissionMode = mode;
        this._queueChanged();   // the UI's mode selector follows this
        this.adapter.setPermissionMode(mode).catch(() => {
            // An older CLI that does not know the request leaves the process in
            // plan mode while we believe otherwise. Put our copy back and say
            // so — silently refusing every edit of an approved plan is the
            // worst version of this.
            this.permissionMode = previous;
            this._queueChanged();
            this.emit('notice', {
                level: 'warn', kind: 'mode_change_failed',
                text: approved
                    ? `Approved, but this ${this.adapter.product} version would not switch out of `
                        + `${previous} mode from here. Change the mode under the composer and `
                        + 'send a message to carry on.'
                    // From ensure(), which switches in place to spare background work.
                    : `This ${this.adapter.product} version would not switch to ${mode} mode without `
                        + `a restart, so that message ran in ${previous} mode. It will `
                        + 'switch on the first message after the background tasks finish.',
            });
        });
    }

    /**
     * Answer an ask on the wire. `allowSession` is "allow always": the tool is
     * allowed for the rest of the session, which the adapter says in the CLI's
     * own terms.
     *
     * `choice` is the entry of `ask.decisions` this answer is, for a runtime
     * that offers its own list. Every answer the bridge gives by itself — a
     * stop, an auto-deny, a superseded card, "allowed for the session" — passes
     * none, and the nearest entry is picked here, so no such path has to know
     * that lists exist. `answers` is a question's, as _answerConversation built
     * it.
     */
    _respondPermission(ask, { behavior, message, updatedInput, allowSession = false, choice, answers = null }) {
        // Before the write, for _flushQueue's reason.
        this._markAnswered(ask.id);
        if (choice === undefined || choice === null) choice = choiceFor(ask, behavior, { allowSession });
        const line = this.adapter.answer(ask, { behavior, message, updatedInput, allowSession, choice, answers });
        // Null for an ask answered by the next turn rather than on the wire.
        if (line) this._write(line);
    }

    _clearPermission(outcome, choice = null) {
        const ask = this.pendingPermission;
        if (!ask) return;
        this.pendingPermission = null;
        this._saveNote();
        this.emit('permission-resolved', {
            sessionId: this.sessionId, requestId: ask.id, outcome,
            // Which of the ask's own decisions it was, when it carried a list.
            ...(choice && { choice: choice.id }),
        });
        // Waiting on a person is not the process going quiet: the clock starts
        // again from the answer.
        this._touch();
        // The tool is about to run (or not); either way we are back to working.
        if (this.state === 'busy') this._work();
    }

    /**
     * Deny the ask this session is blocked on, if any, saying why. For a worker
     * whose orchestrator went away while it waited: delegation was the only thing
     * that kept the no-window auto-deny off it, and an ask already held never
     * passes that check again.
     */
    denyPending(reason) {
        if (!this.pendingPermission) return false;
        this._autoDeny(this.pendingPermission, reason);
        return true;
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
     * Used when the bridge is going away mid-turn with a process that is *not* in
     * the session host (see `release` for the one that is). It buys the process a
     * chance to wind down on its own as our stdin pipe closes, rather than being
     * killed outright — but it does not save the turn: `claude` reads stdin for
     * input, so the pipe closing when we exit is end-of-input and it stops there.
     * Only a pipe held somewhere else survives that, which is what the host is.
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

    /**
     * Let go of a process that lives in the host, and leave it running.
     *
     * What `detach()` wanted to be. The turn does not end, because its pipes are
     * not ours: the host keeps them open, and the next bridge adopts the process
     * from the note written here. False when there is no host behind this process,
     * and then the caller has only `detach()` left.
     */
    release() {
        if (!this.proc || !this.proc.hosted) return false;
        this._saveNote();
        const proc = this.proc;
        this.proc = null;
        proc.release();
        // Our half of the channel is going away; the requests on it will never be
        // answered to *us*. Nothing is emitted: there is nobody left to tell, and
        // the ask itself is still open on the far side for the next bridge to show.
        for (const [, p] of this._pending) {
            clearTimeout(p.timer);
            p.reject(controlError('the bridge let go of this process', 'gone'));
        }
        this._pending.clear();
        this.inFlight.length = 0;
        return true;
    }

    /**
     * Take over a process a previous bridge left in the host.
     *
     * `records` is everything the host kept of its output, `note` what the last
     * bridge wrote down before it went (see `_saveNote`), and `noteSeq` how far the
     * output had got when it did. Between them they rebuild what this object would
     * know had it been here all along — without *acting* on any of it. The replay
     * goes nowhere near `_onEvent`: that would answer asks, auto-deny them for
     * want of a window, and announce turns long finished.
     *
     * What is rebuilt:
     *
     *   - **the turn in flight**, from the note, unless a `result` arrived after
     *     the note was written — then the turn finished while nobody listened, and
     *     `turn-complete` is emitted for it now, since nobody heard it then;
     *   - **an unanswered ask**, the last `can_use_tool` with nothing after it that
     *     settled it. Put straight back on `pendingPermission` rather than through
     *     `_onAsk`, which would deny it: no window is attached this
     *     early in a bridge's life, and the CLI is still blocked waiting. The card
     *     waits, exactly as one does that was on screen when a window closed;
     *   - **the tool running**, for the activity line;
     *   - the queue, the permission mode, and what was allowed for the session.
     */
    adopt({ child, records = [], note = {}, noteSeq = 0 }) {
        this.proc = child;
        this.isNew = false;
        this.fork = false;
        // Fresh ids: the old bridge's counter restarted with this one, and a
        // carried-over `q3` would answer to a new `q3`'s dequeue.
        // The uuid is kept, not reissued: a handed-over message is known to the
        // process by it, and it is what the lifecycle frames below are matched on.
        const entry = (q) => ({ id: `q${++queueSeq}`, uuid: q.uuid || randomUUID(),
            text: q.text, at: q.at, attachments: q.attachments || [],
            ...(q.handed && { handed: true }) });
        this.queue = (note.queue || []).map(entry);
        this.inFlight = (note.inFlight || []).map(entry);
        this._lifecycle = !!note.lifecycle;
        this.background = new Map((note.background || [])
            .filter(t => t && t.id).map(({ id, ...t }) => [id, t]));
        this.pendingSettings = note.pendingSettings || null;
        this._answered = (note.answered || []).slice(-20);
        this._sessionAllow = new Set(note.sessionAllow || []);
        this.claudeVersion = note.claudeVersion || null;
        this.lastUsedAt = Date.now();

        // What an adapter with state of its own would have learned at the start
        // it never saw (Codex's thread id, mode and model), before the replay.
        if (typeof this.adapter.adopting === 'function') {
            this.adapter.adopting({ sessionId: this.sessionId, cwd: this.cwd, model: this.model,
                effort: this.effort, permissionMode: this.permissionMode });
        }

        // The ask the last bridge was holding, from its note. The replay below
        // finds it again when its request is still in the host's log; this is
        // for when it is not — a log that out-grew its cap dropped the front —
        // and it carries the runtime's own id for the request (Codex's integer).
        // Later lines settle it exactly as they would the replayed one.
        let ask = note.pending && note.pending.id ? note.pending : null;
        let finished = null;       // a result the previous bridge never saw
        const tools = new Map();
        // The adapter's own reading of each line, the same one the live stream
        // gets — acted on here only as far as rebuilding state.
        for (const r of records) {
            if (r.dir === 'err') { this._stderr = (this._stderr + r.data).slice(-4000); continue; }
            let msg;
            try { msg = JSON.parse(r.data); } catch { continue; }
            for (const ev of this.adapter.read(msg)) {
                switch (ev.type) {
                    case 'ask':
                        ask = ev.ask;
                        break;
                    case 'ask-withdrawn':
                        if (ask && ask.id === ev.id) ask = null;
                        break;
                    case 'tool-start':
                        tools.set(ev.id, ev);
                        break;
                    case 'tools-done':
                        for (const id of ev.ids) tools.delete(id);
                        break;
                    case 'lifecycle': {
                        // What became of a message handed over before the last
                        // bridge went. Replayed without _onLifecycle's side
                        // effects: the state is decided once, below, from
                        // everything at once.
                        this._lifecycle = true;
                        const i = this.queue.findIndex(q => q.handed && q.uuid === ev.uuid);
                        if (i < 0) break;
                        if (ev.state === 'started') this.inFlight.push(this.queue.splice(i, 1)[0]);
                        else if (ev.state === 'cancelled' || ev.state === 'discarded') this.queue.splice(i, 1);
                        else if (ev.state === 'returned') this.queue[i].handed = false;
                        break;
                    }
                    case 'turn-end':
                        // A card nothing was blocked on outlives its turn.
                        if (!ask || !ask.followUp) ask = null;
                        tools.clear();
                        if (r.seq > noteSeq) finished = ev.result;
                        break;
                    case 'task':
                        // Background work that started or finished while no
                        // bridge was listening. Without this an adopted process
                        // would look free to replace while something it started
                        // was still running.
                        this._noteTask(ev, { quiet: true });
                        break;
                    case 'context':
                        this.context = ev.context;
                        break;
                    case 'init':
                        if (ev.version) this.claudeVersion = ev.version;
                        // A fork the previous bridge had already followed is in
                        // the note; this catches one it did not live to see.
                        if (ev.sessionId && ev.sessionId !== this.sessionId) this.sessionId = ev.sessionId;
                        break;
                }
            }
        }
        if (ask && this._answered.includes(ask.id)) ask = null;
        for (const [id, t] of tools) this._pendingTools.set(id, t.name);

        this._bind(child);

        if (finished) {
            this._readResult(finished);
            this.inFlight.length = 0;
            // After the pool has wired its listeners, which happens once this
            // returns. The turn ended while no bridge was up to say so.
            setImmediate(() => this.emit('turn-complete', this.lastResult));
        }

        if (ask && !ask.followUp) {
            this.pendingPermission = ask;
            this._setState('busy', waitingLabel(ask));
        } else if (this.inFlight.length || tools.size || this.queue.some(q => q.handed)) {
            const last = [...tools.values()].pop();
            this._work(last ? last.label : null);
        } else {
            this._setState('idle', null);
        }
        if (ask && ask.followUp) this.pendingPermission = ask;
        this._saveNote();
        this._flushQueue();
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
                // event is diagnostic text — and it is what the adapter's classifyExit reads
                // to tell "already running elsewhere" from a generic failure.
                this._stderr = (this._stderr + line + '\n').slice(-4000);
                continue;
            }
            this._touch();
            for (const ev of this.adapter.read(msg)) this._onEvent(ev);
        }
    }

    /**
     * One event from the adapter, live. The contract in
     * bridge/runtimes/claude/process.js says what each one means; this says what
     * we do about it.
     */
    _onEvent(ev) {
        switch (ev.type) {
            case 'ask':
                this._onAsk(ev);
                break;

            case 'request':
                // A newer CLI expecting a client we are not: turn it away so it
                // stops waiting on us, and carry on.
                this._write(this.adapter.refuse(ev));
                break;

            case 'response': {
                const p = this._pending.get(ev.id);
                if (!p) break;
                this._pending.delete(ev.id);
                clearTimeout(p.timer);
                if (!ev.ok) {
                    p.reject(controlError(ev.error || 'the request was refused', 'refused'));
                }
                else p.resolve(ev.result || {});
                break;
            }

            case 'lifecycle':
                this._onLifecycle(ev);
                break;

            case 'ask-withdrawn':
                // Usually because the turn it belonged to ended. Take the card
                // down rather than leaving a dead one on screen.
                if (this.pendingPermission && this.pendingPermission.id === ev.id) {
                    this._clearPermission('cancelled');
                }
                break;

            case 'init':
                this.claudeVersion = ev.version || null;
                // A resumed session keeps its id; a fork gets a new one, and the
                // UI has to follow it or the user is left watching a transcript
                // that will never move again.
                //
                // `minted` is the other way an id can change, and it is not a
                // fork: a runtime that names its own sessions (Codex's thread id
                // comes back from `thread/start`) was started under a placeholder,
                // and this is the session that start created. Nothing was copied
                // and there is no original to leave behind, so it is a separate
                // event — the pool re-keys for both, but only a fork is a branch.
                if (ev.sessionId && ev.sessionId !== this.sessionId) {
                    const from = this.sessionId;
                    this.sessionId = ev.sessionId;
                    this.emit(ev.minted ? 'minted' : 'forked', { from, to: ev.sessionId });
                }
                // `raw` is Claude's system/init, for the slash palette; a runtime
                // with nothing of that shape sends none.
                this.emit('init', ev.raw || null);
                // Once per process, and the only moment the version is known:
                // the note so an adopting bridge has it, the status so every
                // window's stale-binary hint can clear.
                this._saveNote();
                this.emit('status', this.status());
                break;

            case 'notice':
                this.emit('notice', ev.notice);
                break;

            case 'task':
                this._noteTask(ev);
                break;

            case 'agent-done':
                // A background task finished — a subagent, or a command. The
                // stream is here whether or not anybody is watching the session,
                // which the transcript's copy of the same news is not: a log that
                // only filled up while somebody was looking would miss exactly the
                // hours it exists for.
                this.emit('agent-done', {
                    sessionId: this.sessionId,
                    taskId: ev.taskId,
                    toolUseId: ev.toolUseId,
                    status: ev.status,
                    summary: ev.summary,
                    durationMs: ev.durationMs,
                });
                break;

            case 'retry':
                // Retrying can run for several minutes. Without this the UI just
                // says "Thinking" the whole time and the user has no idea anything
                // is wrong, or that stopping is an option.
                this.retry = {
                    attempt: ev.attempt,
                    max: ev.max,
                    status: ev.status,
                    at: Date.now(),
                };
                this._setState('busy',
                    `Can't reach the API — retry ${ev.attempt} of ${ev.max}`);
                if (ev.notice) this.emit('notice', ev.notice);
                break;

            case 'tool-start':
                this._pendingTools.set(ev.id, ev.name);
                this._touch();
                this._work(ev.label);
                // The round this tool belongs to is where anything waiting gets
                // read, so hand it over now, while there is time.
                this._handOver();
                break;

            case 'writing':
                this._work('Writing…');
                break;

            case 'thinking':
                this._work();
                break;

            case 'tools-done':
                for (const id of ev.ids) {
                    this._pendingTools.delete(id);
                    this._touch();
                }
                // The call is over, so its name would now be a lie — back to the
                // verb alone until the next thing starts.
                if (this.state === 'busy') this._work();
                break;

            case 'turn-end': {
                const { failed, detail } = this._readResult(ev.result);
                this._limitInfo = null;     // read into lastResult.usageLimit
                this._pendingTools.clear();
                this.inFlight.length = 0;   // safely in the transcript now
                this._saveNote();
                this.retry = null;
                this._autoDenies = 0;       // a finished turn is not a spin
                // Something handed over that the turn did not fold in is the
                // process's next turn, and it starts it by itself. Staying busy
                // keeps everything that waits on `idle` — the queue, the pool's
                // eviction, a model change — from acting in between; its
                // lifecycle frame moves things on either way.
                if (this.queue.some(q => q.handed)) this._work();
                else this._setState('idle', null);
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

            // How full the thread's context window is, from a runtime that says.
            case 'context':
                this.context = ev.context;
                this.emit('status', this.status());
                break;

            // Another runtime's account-wide usage windows. Not `quota`, which is
            // Claude's and drives its meter and the orchestrators' usage cutoff.
            case 'limits':
                this.emit('limits', ev.limits);
                break;

            case 'quota':
                // Account-wide; bridge/usage.js decides what is worth showing.
                this.emit('quota', ev.info);
                // A refusal is what ends a turn on the usage limit. Kept until the
                // result, which says whether the turn actually ended on it.
                if (ev.rejected) this._limitInfo = ev.info;
                if (ev.notice) this.emit('notice', ev.notice);
                break;
        }
    }

    /**
     * What a `turn-end` says about the turn it ends. Split out of _onEvent so an
     * adopted process can read the result of a turn that ended while no bridge was
     * listening without also acting on it.
     */
    _readResult(res) {
        // A turn that ends in an API error still counts as "finished" to
        // the CLI, so say what went wrong rather than quietly going idle.
        const failed = !!res.isError;
        const detail = typeof res.text === 'string' ? res.text : '';
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
            costUsd: res.costUsd || 0,
            durationMs: res.durationMs || 0,
            numTurns: res.numTurns || 0,
            stopReason: res.stopReason || null,
            usageLimit: this._usageLimit(failed, detail),
        };
        return { failed, detail };
    }

    /**
     * `{resetsAt, window}` when this turn ended because the account hit its usage
     * limit, else null. `resetsAt` is epoch ms, or null when only the text said so
     * — bridge/wakes.js then asks bridge/usage.js. Read by the auto-resume after a
     * limit; see there.
     */
    _usageLimit(failed, detail) {
        // What counts as hitting the limit is the CLI's to say. `this.adapter` is
        // absent only when this is called off the prototype, as the wakes test
        // does, and then the answer is Claude's.
        return (this.adapter || claude).usageLimit(this._limitInfo, failed, detail);
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
        if (state === 'busy') {
            this._armStall();
        } else {
            if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null; }
            // Said here rather than through _setStalled, so the one status
            // below carries both changes.
            if (this.stalled) { this.stalled = false; this._emitStalled(); }
        }
        if (changed) this.emit('status', this.status());
    }

    // -- stall ------------------------------------------------------------

    /** Something happened. Clears a stall on the spot; see the header. */
    _touch() {
        this.lastActivityAt = Date.now();
        if (this.stalled) this._setStalled(false);
        if (this.state === 'busy') this._armStall();
    }

    /** Arm the stall timer if it is not already; a no-op while it is. */
    _armStall() {
        if (this._stallTimer) return;
        const ms = this.stallAfter(this.cwd);
        if (!(ms > 0)) return;
        const since = Math.max(this.lastActivityAt || 0, this.busySince || 0) || Date.now();
        const wait = Math.max(0, since + ms - Date.now());
        this._stallTimer = setTimeout(() => { this._stallTimer = null; this._checkStall(); }, wait);
        // Never a reason to keep the bridge alive, the same as _reroll.
        this._stallTimer.unref();
    }

    /**
     * The timer's half. Quiet while an ask or a tool call holds the clock —
     * whatever ends either of them is a touch, and the touch re-arms.
     */
    _checkStall() {
        if (this.state !== 'busy' || this.stalled) return;
        if (this.pendingPermission || this._pendingTools.size) return;
        const ms = this.stallAfter(this.cwd);
        if (!(ms > 0)) return;
        const since = Math.max(this.lastActivityAt || 0, this.busySince || 0);
        if (Date.now() - since < ms) { this._armStall(); return; }
        this._setStalled(true);
    }

    _setStalled(stalled) {
        if (this.stalled === stalled) return;
        this.stalled = stalled;
        this._emitStalled();
        this.emit('status', this.status());
    }

    _emitStalled() {
        this.emit('stalled', {
            sessionId: this.sessionId,
            stalled: this.stalled,
            lastActivityAt: this.lastActivityAt,
            busySince: this.busySince,
            stalledAfterMs: this.stallAfter(this.cwd) || 0,
        });
    }

    /**
     * Is this process running work it started and has not finished?
     *
     * Entries older than BACKGROUND_STALE_MS are dropped on the way past: the
     * finish is only ever learned from the stream, and one that went missing must
     * not pin a process open for good.
     */
    get hasBackground() {
        if (!this.proc) return false;
        const cutoff = Date.now() - BACKGROUND_STALE_MS;
        for (const [id, t] of this.background) if (t.startedAt < cutoff) this.background.delete(id);
        return this.background.size > 0;
    }

    /**
     * Keep `background` in step with the CLI's task events.
     *
     * `task_started` is sent for foreground subagents too; they finish with a
     * `task_notification` like any other, before their turn does, so tracking
     * every task rather than guessing which are backgrounded costs nothing.
     * `task_updated` is read for a terminal status in case a build sends that
     * without the notification. `quiet` is the adopt replay, which decides state
     * once at the end and must not act on each line.
     */
    _noteTask(ev, { quiet = false } = {}) {
        const id = ev.id;
        if (!id) return;
        const before = this.background.size;
        if (ev.state === 'started') {
            this.background.set(id, { type: ev.taskType || null, startedAt: Date.now() });
        } else if (ev.state === 'done') {
            this.background.delete(id);
        } else {
            return;
        }
        if (quiet || this.background.size === before) return;
        this._saveNote();
        this.emit('status', this.status());
        if (!this.background.size) this.emit('background-drained');
    }

    status() {
        return {
            sessionId: this.sessionId,
            // Which CLI this is and what it can do — static for the runner's
            // life. See bridge/runtimes/index.js and docs/api.md.
            runtime: this.runtime,
            capabilities: this.capabilities,
            // What clients call this CLI: `{name, product}`.
            agent: this.agent,
            state: this.state,
            activity: this.activity,
            // The two halves `activity` is composed of, so a surface too narrow
            // for both can choose. The rail is the one that does: it has room
            // for about twenty characters, and the informative half is `detail`.
            // Everything wider just draws `activity` and needs neither of these.
            verb: this._verb,
            detail: this._detail,
            model: this.model,
            effort: this.effort,
            permissionMode: this.permissionMode,
            // Null whenever there is no process, so a session sitting idle with
            // nothing running is never reported as on an old binary: its next
            // message starts whatever is installed then.
            claudeVersion: this.claudeVersion,
            // `{usedTokens, windowTokens}` or null: Codex says, Claude does not.
            context: this.context,
            cwd: this.cwd,
            error: this.lastError,
            errorKind: this.errorKind,
            retry: this.retry,
            lastResult: this.lastResult,
            queued: this.queue.length,
            // A busy turn gone quiet past the threshold; see the header.
            stalled: this.stalled,
            lastActivityAt: this.lastActivityAt,
            // Background tasks this process is still running. A session can be
            // `idle` with this above zero, and then it is not free to restart.
            background: this.proc ? this.background.size : 0,
            // A model/effort change waiting for those to finish, or null.
            pendingSettings: this.pendingSettings,
            // The messages themselves, not just a count: the composer renders one
            // chip per entry and needs the id to cancel or reorder it. Every
            // status event carries this, so it stays a list of what is still
            // waiting — the message being answered is on its way to the transcript
            // and is read from there like any other.
            // `attachments` rides along so a chip can say a message has files on it,
            // and so editing one puts them back on the composer rather than dropping
            // them on the floor. Metadata only — the base64 is read at flush time and
            // never travels on a status event.
            // `handed` marks one given to the running turn to be read at its next
            // step: still cancellable, no longer reorderable. See _handOver.
            queue: this.queue.map(q => ({
                id: q.id, text: q.text, at: q.at, attachments: q.attachments || [],
                handed: !!q.handed,
            })),
            // A window opening onto a session that is already blocked on an ask
            // has to be able to draw the card without having seen the event.
            pendingPermission: this.pendingPermission ? publicAsk(this.pendingPermission) : null,
            // A `sudo -A` waiting on a password, in bridge/sudo.js's public form
            // (kind 'sudo'), or null. Separate from the permission ask: that one
            // is the CLI's and is answered over its stdin; this one is answered
            // to the askpass helper. They are rarely up together — a Bash call
            // waiting on sudo has already been allowed to run — but can be, when
            // a subagent asks meanwhile, so neither hides the other.
            sudoAsk: this.sudoAskFor(this.sessionId),
            // A secret the agent asked for with request_secret, in
            // bridge/secrets.js's public form (kind 'secret'), or null. Names only.
            secretAsk: this.secretAskFor(this.sessionId),
            canPrompt: this.caps.permissionPrompt,
            // Lets the UI show how long a turn has been going, which matters
            // when the API is being retried for minutes at a time.
            busySince: this.state === 'busy' ? this.busySince : null,
        };
    }
}

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

/**
 * A question ask's answers as the adapter takes them, `[{id, question,
 * answers: [string]}]`, from a client's `answers` keyed by question text or by a
 * question's `id`. A key that names no question is dropped rather than passed
 * through, so a stale card cannot answer a live question; a value is one string
 * or several.
 */
function givenAnswers(ask, answers) {
    const byKey = new Map();
    for (const q of (ask.input && ask.input.questions) || []) {
        if (!q) continue;
        if (typeof q.question === 'string') byKey.set(q.question, q);
        if (q.id != null && !byKey.has(String(q.id))) byKey.set(String(q.id), q);
    }
    const given = [];
    const seen = new Set();
    for (const [key, a] of Object.entries(answers || {})) {
        const q = byKey.get(key);
        if (!q || seen.has(q)) continue;
        const values = Array.isArray(a)
            ? a.map(v => (v == null ? '' : String(v))).filter(v => v.trim())
            : (String(a || '').trim() ? [String(a)] : []);
        if (!values.length) continue;
        seen.add(q);
        given.push({ id: q.id != null ? String(q.id) : null, question: q.question, answers: values });
    }
    return given;
}

/**
 * The entry of an ask's `decisions` that an answer in the old words means, or
 * null for an ask with no list (every Claude ask). A decision is
 * `{id, label, behavior: 'allow'|'deny', scope: 'once'|'session'|'always',
 * endsTurn, raw}`; see the contract in bridge/runtimes/claude/process.js.
 *
 * `allow` is the one-off allow, and `allowSession` the for-the-session one.
 * `strict` is for an answer somebody chose: no stand-in, because a button that
 * said "for this session" must not be answered with "once". Without it — the
 * bridge answering by itself — "for the session" falls back to "once". A deny
 * prefers a decline that lets the turn go on over one that ends it, and takes
 * the one that ends it when that is all there is (Codex's `untrusted` list:
 * `accept`, an amendment, `cancel`).
 */
function choiceFor(ask, behavior, { allowSession = false, strict = false } = {}) {
    const list = ask && Array.isArray(ask.decisions) ? ask.decisions : null;
    if (!list || !list.length) return null;
    if (behavior === 'allow') {
        const scoped = (scope) => list.find(d => d.behavior === 'allow' && (d.scope || 'once') === scope);
        return (allowSession ? scoped('session') : scoped('once'))
            || (!strict && allowSession ? scoped('once') : null) || null;
    }
    return list.find(d => d.behavior === 'deny' && !d.endsTurn)
        || list.find(d => d.behavior === 'deny') || null;
}

/** The ask as the UI sees it — no timer handle, nothing it cannot serialise. */
function publicAsk(ask) {
    return {
        requestId: ask.id,
        // 'tool' | 'plan' | 'question'. Which card the UI draws — the plan and
        // the questions themselves are already in `input`.
        kind: ask.kind || 'tool',
        tool: ask.tool,
        displayName: ask.displayName,
        // Unwrapped: what you approve is the command that runs, with `secretNames`
        // in its environment. Exact — unwrapCommand refuses anything that is not
        // the wrapper and one quoted command, so nothing else can hide behind it.
        input: ask.secrets ? { ...ask.input, command: ask.secrets.command } : ask.input,
        ...(ask.secrets ? { secretNames: ask.secrets.names } : {}),
        toolUseId: ask.toolUseId,
        description: ask.description,
        reason: ask.reason,
        blockedPath: ask.blockedPath,
        agentId: ask.agentId,
        askedAt: ask.askedAt,
        // Answered by sending the next turn rather than unblocking this one: a
        // Codex plan, or a question its async tool asked. Nothing is waiting on
        // it, so the session can be idle with this card up. Absent otherwise.
        ...(ask.followUp && { followUp: true }),
        // The runtime's own answers, when it offers a list rather than allow and
        // deny (Codex's `availableDecisions`). Absent for every Claude ask. A card
        // draws one button per entry and answers with `choice: id`; `raw`, the
        // runtime's spelling, stays in the bridge.
        ...(Array.isArray(ask.decisions) && ask.decisions.length ? {
            decisions: ask.decisions.map(d => ({
                id: d.id, label: d.label, behavior: d.behavior,
                scope: d.scope || 'once', endsTurn: !!d.endsTurn,
            })),
        } : {}),
    };
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

        // Which runtime each session this pool has run is on, when it is not the
        // default — so a session evicted and sent to again comes back on its own
        // CLI. `runtimeOf` is the index's answer for one this pool never ran;
        // replaced by the server.
        this._runtimeOf = new Map();
        this.runtimeOf = () => null;

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
        // And how long a silent busy turn waits before it is called stalled, in
        // ms. Zero is off, which is what a pool without a server gets.
        this.stallAfter = () => 0;
        // And whether an agent's test browser draws a window. `visible` is what
        // every session did before there was a setting.
        this.agentBrowser = () => 'visible';
        // And whether a session gets the preview's tools. Off is what every
        // session had before there was a setting.
        this.previewControl = () => false;
        // And the agent brief, replaced by the server with bridge/brief.js.
        // None is what a session got before there was one.
        this.agentBrief = () => null;
        // And sudo approval, replaced by the server with bridge/sudo.js. Off is
        // what a session had before there was one.
        this.sudoAccess = () => null;
        this.sudoAskFor = () => null;
        this.secretAskFor = () => null;
        // Orchestration, replaced by the server with bridge/orchestration.js.
        // Without one no session has a role and nobody answers for a window.
        this.roleOf = () => null;
        this.delegateFor = () => false;
        // And whether a session's queue waits for a move at the end of its turn
        // — `(sessionId, runner) => boolean`. See Runner#_flushQueue.
        this.holdFor = () => false;
        // A model and effort a session must run with whatever a send asks for —
        // `(sessionId) => {model, effort} | null`, either field null for "no
        // say". An orchestrator's own model setting (bridge/orchestration.js):
        // with it here rather than in each caller, the send route, a nudge, a
        // recycle and a held change all start the process the same way.
        this.settingsFor = () => null;
    }

    /** `model`/`effort` as asked, with whatever `settingsFor` insists on put over them. */
    _forced(sessionId, model, effort) {
        const f = this.settingsFor(sessionId);
        if (!f) return { model, effort };
        return { model: f.model || model, effort: f.effort || effort };
    }

    get(sessionId) {
        return this.runners.get(sessionId) || null;
    }

    /** Existing runner for a session, or a new one bound to `cwd`. */
    ensure(sessionId, {
        cwd, model, effort, permissionMode, isNew = false, fork = false, branch = null, runtime,
    } = {}) {
        ({ model, effort } = this._forced(sessionId, model, effort));
        let r = this.runners.get(sessionId);
        // A caller that does not say which CLI keeps the one the session has: the
        // live runner's, then the one this pool last ran it on (an evicted Codex
        // session must not come back as `claude --resume <thread id>`), then the
        // index's. Claude when none of them knows.
        runtime = runtime || (r && r.runtime) || this._runtimeOf.get(sessionId)
            || this.runtimeOf(sessionId) || undefined;
        let carried = [];
        // Absent and null are different answers for effort, unlike model: absent
        // is "as you were" — a board card's send, which has no selector to read —
        // and null is `inherit`, picked in a selector that offers it. Folding the
        // two together, as `model ?? r.model` does, would make choosing `inherit`
        // do nothing while the dropdown said it had.
        if (r) {
            // A model, effort or fork change only takes effect on a fresh process:
            // `claude` reads them from its argv and nowhere else. A mode can also
            // be changed in place, which is used below only where a restart would
            // cost something.
            const wants = {
                model: model ?? r.model,
                effort: effort === undefined ? r.effort : effortOrNull(effort, r.runtime),
                permissionMode: permissionMode ?? r.permissionMode,
            };
            const settings = wants.model !== r.model || wants.effort !== r.effort;
            const mode = wants.permissionMode !== r.permissionMode;
            // A process still running background work is not replaced for a
            // settings change, because replacing it kills that work — the dev
            // server the last turn started, a subagent it sent off. A mode is
            // switched in place instead, which the CLI can do; a model or effort
            // cannot be, so it waits until the work finishes (_applyPending) and
            // the message goes to the process as it is. A fork or an error still
            // replaces it: the first is asked for outright, and in the second
            // there is nothing to keep.
            if (r.state !== 'busy' && r.hasBackground && !fork && r.state !== 'error') {
                if (mode) r._setPermissionMode(wants.permissionMode, { approved: false });
                // Null when the pick matches the process again, which withdraws one.
                const pending = settings ? { model: wants.model, effort: wants.effort } : null;
                if (!sameSettings(pending, r.pendingSettings)) {
                    r.pendingSettings = pending;
                    r._queueChanged();
                    // Said once per change asked for, not on every message after it.
                    if (pending) {
                        const n = r.background.size;
                        this.emit('notice', {
                            sessionId, level: 'info', kind: 'settings_deferred',
                            text: `Kept the current ${settingsWord(r, wants)} for this message: `
                                + `${n} background task${n === 1 ? ' is' : 's are'} still `
                                + 'running, and switching restarts Claude, which would stop '
                                + `${n === 1 ? 'it' : 'them'}. It switches once they finish.`,
                        });
                    }
                }
                return r;
            }
            if (r.state !== 'busy'
                && (settings || mode || fork !== r.fork || r.state === 'error'
                    // A branch is a fork with a cut in it; a different cut, or
                    // one where the live process has none, is as much a new
                    // process as a fork is. `r.branch` is null once started, so
                    // asking for a branch always replaces it.
                    || (branch ? branch.fromUuid : null)
                        !== (r.branch ? r.branch.fromUuid : null))) {
                // A model, effort or mode change replaces the process. Messages still
                // waiting belong to the user, not to the process, so they move
                // across rather than disappearing.
                carried = r.takeQueue();
                // So that a mode change on its own does not drop the effort the
                // process had.
                effort = wants.effort;
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
        r = this._make({ sessionId, cwd, model, effort, permissionMode, isNew, fork, branch, runtime });
        if (carried.length) {
            r.queue.push(...carried);
            r._queueChanged();
        }
        this.runners.set(sessionId, r);
        return r;
    }

    /** A runner with the pool's listeners on it — shared by `ensure` and `adoptHeld`. */
    _make(opts) {
        if (opts.runtime && opts.runtime !== runtimes.DEFAULT) this._runtimeOf.set(opts.sessionId, opts.runtime);
        const r = new Runner({ ...opts, caps: this.caps,
            thinking: (dir, last) => this.thinking(dir, last),
            rerollAfter: (dir) => this.rerollAfter(dir),
            stallAfter: (dir) => this.stallAfter(dir),
            agentBrowser: (dir) => this.agentBrowser(dir),
            sudoAccess: (id) => this.sudoAccess(id),
            sudoAskFor: (id) => this.sudoAskFor(id),
            secretAskFor: (id) => this.secretAskFor(id),
            previewControl: (dir) => this.previewControl(dir),
            agentBrief: (dir, role) => this.agentBrief(dir, role) });
        // Read through `r.sessionId` rather than closing over the id it was
        // created with: a fork changes it, and the viewer check has to follow.
        r.hasViewer = () => this.hasViewer(r.sessionId);
        r.delegated = () => this.delegateFor(r.sessionId);
        r.roleOf = (id) => this.roleOf(id);
        r.holdQueue = () => this.holdFor(r.sessionId, r);
        r.on('status', (s) => this.emit('status', s));
        r.on('notice', (n) => this.emit('notice', { sessionId: r.sessionId, ...n }));
        // Quota is account-wide, so this one deliberately does not carry a
        // sessionId: which session happened to observe it says nothing.
        r.on('quota', (info) => this.emit('quota', info));
        r.on('limits', (limits) => this.emit('limits', limits));
        r.on('permission-request', (p) => this.emit('permission-request', p));
        r.on('permission-resolved', (p) => this.emit('permission-resolved', p));
        r.on('turn-complete', (res) => this.emit('turn-complete', { sessionId: r.sessionId, ...res }));
        r.on('failed', (f) => this.emit('failed', { sessionId: r.sessionId, ...f }));
        r.on('agent-done', (a) => this.emit('agent-done', a));
        r.on('stalled', (p) => this.emit('stalled', p));
        // The only route by which the app learns what slash commands a directory
        // has. It arrives once per process start and is worth keeping: a session
        // sitting idle in the rail has no process of its own, and its composer
        // still has to be able to offer a menu. The CLI reports its own cwd, so
        // there is nothing to infer. On a fork, `forked` is emitted just above
        // this in the same handler, so `r.sessionId` is already the copy's.
        r.on('init', (msg) => this.emit('init', {
            sessionId: r.sessionId, cwd: (msg && msg.cwd) || r.cwd, init: msg,
        }));
        r.on('exit', () => this.emit('status', r.status()));
        // A model/effort change held for background work is applied at the first
        // moment it can be: the work finishing, or the turn running when it did.
        //
        // The same two moments carry out a `recycle` that was waiting for a turn
        // to end. A replacement made for a model change reads its role afresh as
        // well, so once `_applyPending` has acted there is nothing left to recycle.
        const settle = () => {
            this._applyPending(r);
            if (r._recycle && this.runners.get(r.sessionId) === r) this.recycle(r.sessionId);
        };
        r.on('background-drained', settle);
        r.on('turn-complete', settle);
        r.on('forked', ({ from, to }) => {
            // Re-key so a later send reaches the copy, not the original.
            if (this.runners.get(from) === r) this.runners.delete(from);
            this.runners.set(to, r);
            this.emit('forked', { from, to });
        });
        // A runtime that named the session it was started for (see the runner's
        // `init`). Re-keyed like a fork, and emitted under its own name so that
        // nothing treats the placeholder as an original that was branched.
        r.on('minted', ({ from, to }) => {
            if (this.runners.get(from) === r) this.runners.delete(from);
            this.runners.set(to, r);
            if (this._runtimeOf.has(from)) {
                this._runtimeOf.set(to, this._runtimeOf.get(from));
                this._runtimeOf.delete(from);
            }
            this.emit('minted', { from, to });
        });
        return r;
    }

    /**
     * Take back the processes a previous bridge left running in the session host.
     *
     * Called once, before the bridge serves anything: a send that arrived first
     * would find no runner, start a second `claude` on the same session, and be
     * refused as "already running elsewhere" — by the very process being adopted.
     *
     * A process with no usable note is ended rather than guessed at. It can only
     * be one that was spawned in the instant before its bridge died, and a turn
     * nobody can see or stop is worse than one that did not happen. An exited one
     * is forgotten: the transcript already has everything it did.
     *
     * @returns {Promise<number>} how many were adopted
     */
    async adoptHeld() {
        let n = 0;
        for (const h of await hostClient.held()) {
            if (h.exited) { await hostClient.forget(h.key); continue; }
            const note = h.note;
            if (!note || note.v !== 1 || !note.sessionId || !note.cwd
                // A runtime this build does not know cannot be driven, so its
                // note is as unusable as a missing one.
                || (note.runtime && !runtimes.known(note.runtime))) {
                await this._endHeld(h.key);
                continue;
            }
            // Two processes on one session is the case --resume refuses; keep the
            // one already adopted and end the other.
            if (this.runners.has(note.sessionId)) {
                await this._endHeld(h.key);
                continue;
            }
            let got;
            try { got = await hostClient.adopt(h.key); } catch { continue; }
            const r = this._make({
                sessionId: note.sessionId, cwd: note.cwd, model: note.model,
                effort: note.effort, permissionMode: note.permissionMode, runtime: note.runtime,
            });
            r.adopt({ child: got.child, records: got.records, note: got.note || note,
                noteSeq: got.noteSeq });
            this.runners.set(r.sessionId, r);
            n++;
        }
        return n;
    }

    async _endHeld(key) {
        try {
            const { child } = await hostClient.adopt(key);
            child.stdin.end();
        } catch { /* gone already */ }
    }

    /** Create a brand-new session and deliver its first prompt. */
    create({ cwd, model, effort, permissionMode, prompt, attachments = [], sessionId = randomUUID(), runtime }) {
        // `sessionId` is for a caller that has to file the id somewhere before the
        // process starts — an orchestrator's worker, whose role decides the argv.
        const dir = resolveWorkdir(cwd);
        const r = this.ensure(sessionId, { cwd: dir, model, effort, permissionMode, isNew: true, runtime });
        // The first message takes files like any other. `send` has always accepted
        // them and `userContent` has always known what to do with them; this was the
        // one caller that dropped them on the floor, so a session could not be
        // started with the screenshot that was the reason for starting it.
        r.send(prompt, attachments);
        return { sessionId, status: r.status() };
    }

    /**
     * Replace a session's process at the next moment it is free, so the next
     * start reads its argv afresh — how a session marked an orchestrator gets its
     * tools. Nothing is started here: the next message starts it, and anything
     * still waiting moves across, as it does for a model change.
     *
     * Returns true when it was done now, false when it is waiting for a turn or
     * background work to finish (`turn-complete` and `background-drained` try
     * again).
     */
    recycle(sessionId) {
        const r = this.runners.get(sessionId);
        if (!r) return true;
        if (r.state === 'busy' || r.state === 'starting' || r.hasBackground) {
            r._recycle = true;
            return false;
        }
        this._replace(r, { model: r.model, effort: r.effort });
        return true;
    }

    /**
     * Put a fresh, unstarted runner in place of `r` with the given model and
     * effort, carrying across anything still waiting. Shared by a held settings
     * change and by `recycle`, so the two cannot drift: the queue-carrying rule
     * `_evict` documents is exactly the kind of fix that lands in one copy only.
     */
    _replace(r, { model, effort, cwd = r.cwd }) {
        ({ model, effort } = this._forced(r.sessionId, model, effort));
        const carried = r.takeQueue();
        const fresh = this._make({ sessionId: r.sessionId, cwd, model, effort,
            permissionMode: r.permissionMode, runtime: r.runtime });
        this.runners.set(r.sessionId, fresh);
        // The old runner's exit reports *its* settings, and a window takes the
        // last status it hears for a session as the truth — so say the new one's
        // again after it.
        r.once('exit', () => this.emit('status', fresh.status()));
        r.retire();
        if (carried.length) {
            fresh.queue.push(...carried);
            fresh._queueChanged();
            fresh.start();
        }
        this.emit('status', fresh.status());
        return fresh;
    }

    /**
     * Put a session's process somewhere else: the live one is retired and an
     * unstarted runner bound to `cwd` takes its place, so the next message
     * resumes there. Anything still waiting moves across and starts it, as for a
     * model change. `ensure` cannot do this — it keeps a live runner whatever
     * `cwd` it is asked for. The caller decides whether now is a fair moment;
     * this replaces whatever is there. False when there was no process.
     */
    relocate(sessionId, cwd) {
        const r = this.runners.get(sessionId);
        if (!r) return false;
        this._replace(r, { model: r.model, effort: r.effort, cwd });
        return true;
    }

    /**
     * Let a held queue go — a move that was holding it (`holdFor`) was cancelled
     * or could not be made, and what is waiting should go to the process that
     * is there after all.
     */
    release(sessionId) {
        const r = this.runners.get(sessionId);
        if (r) r._flushQueue();
    }

    /**
     * Replace a session's live process with a fresh one now, and start it — the
     * Restart process action. A process reads `bridge/mcp.js`'s tool list once,
     * when it launches, and the session host keeps it alive across bridge
     * restarts, so a tool TGXCode gained since is invisible to it until it is
     * replaced. Started at once rather than left for the next message, so the
     * new tools are there before anybody asks for them.
     *
     * `_replace` does the work, so the queue moves across exactly as it does
     * for a model change. A model change still held for background work is
     * applied rather than lost: it was waiting for a moment like this one.
     *
     * The caller decides whether now is a fair moment, as for `relocate`; this
     * replaces whatever is there. Null when there was no live process.
     */
    restart(sessionId, cwd) {
        const r = this.runners.get(sessionId);
        if (!r || !r.proc) return null;
        const { model, effort } = r.pendingSettings || r;
        r.pendingSettings = null;
        const fresh = this._replace(r, { model, effort, cwd: cwd || r.cwd });
        fresh.start();
        return fresh;
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

    /**
     * Carry out a model/effort change `ensure` held back for background work.
     *
     * The process is retired and a runner with the new settings put in its place,
     * not started: nothing is waiting to be sent (anything queued moves across and
     * starts it), so the next message starts it with the right argv. Waits rather
     * than acting while a turn runs or work remains; `turn-complete` asks again.
     */
    _applyPending(r) {
        if (!r.pendingSettings || r.state === 'busy' || r.hasBackground) return;
        if (this.runners.get(r.sessionId) !== r) return;
        const { model, effort } = r.pendingSettings;
        r.pendingSettings = null;
        this._replace(r, { model, effort });
    }

    _evictIdle() {
        const now = Date.now();
        for (const [id, r] of this.runners) {
            // `starting` lasts no time for Claude; for a runtime whose handshake
            // gates the queue it is a process still being introduced.
            if (r.state === 'busy' || r.state === 'starting' || r.hasBackground) continue;
            if (now - r.lastUsedAt < IDLE_EVICT_MS) continue;
            this._evict(id, r,
                'That session had been idle for a while, so its process was shut down.');
        }
    }

    _evictTo(limit) {
        const idle = [...this.runners.entries()]
            // Not one running background work either: it is idle in name only, and
            // evicting it stops the work. MAX_LIVE gives way rather than that.
            .filter(([, r]) => r.state !== 'busy' && r.state !== 'starting' && !r.hasBackground)
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
     * Every process in the session host is released — idle ones too — and the next
     * bridge adopts them. Idle is not the same as finished: a session whose turn
     * ended after starting a background command or a subagent reports `idle` while
     * that work runs on inside `claude`, and stopping it here killed the work. The
     * first end-to-end run of the host lost exactly that, a `sleep` the model had
     * moved into the background, to this loop's old rule of stopping whatever was
     * not busy. An adopted idle process costs nothing and is retired by the idle
     * sweep like any other.
     *
     * A process spawned directly — no host, or none reachable when it started —
     * keeps the old rule: a busy one is left unsignalled rather than killed, so it
     * can wind down as our pipes close and whatever it wrote stays in the
     * transcript (it will still stop; see Runner#detach), and an idle one is
     * stopped.
     */
    shutdown({ force = false } = {}) {
        clearInterval(this._sweep);
        let left = 0;
        let held = 0;
        for (const r of this.runners.values()) {
            if (!force && r.release()) { held++; continue; }
            if (r.state === 'busy' && !force) {
                left++;
                r.detach();
                continue;
            }
            // Hard, deliberately: the bridge is going away, so there is nobody
            // left to wait for a polite interrupt to be answered.
            r.stop({ hard: true });
        }
        this.runners.clear();
        return { stillRunning: left, held };
    }

    get busyCount() {
        let n = 0;
        for (const r of this.runners.values()) if (r.state === 'busy') n++;
        return n;
    }

    /**
     * Busy or still starting: what bridge/keepawake.js counts as an agent at
     * work. `starting` counts because a message has been sent and a turn is on
     * its way — sleeping in that gap would freeze it before it began.
     */
    get workingCount() {
        let n = 0;
        for (const r of this.runners.values()) if (r.state === 'busy' || r.state === 'starting') n++;
        return n;
    }

    /**
     * Turns a restart would end: busy, and not in the session host. What a
     * restart should be asking about now, where `busyCount` is what it used to ask.
     */
    get atRiskCount() {
        let n = 0;
        for (const r of this.runners.values()) {
            if (r.state === 'busy' && !(r.proc && r.proc.hosted && hostClient.connected())) n++;
        }
        return n;
    }
}

/**
 * The narrow `runner` that `GET /api/sessions` and `GET /api/dashboard` carry on
 * each row, from a full status(). One definition for both routes: the rail draws
 * hundreds of rows and wants a label and a badge, not a queue and an ask each,
 * and docs/api.md promises exactly these fields. `runtime` and `capabilities`
 * ride along so a row can hide a control without the whole status.
 */
function rowStatus(st) {
    return { state: st.state, activity: st.activity,
        detail: st.detail, queued: st.queued, claudeVersion: st.claudeVersion,
        stalled: st.stalled, runtime: st.runtime, capabilities: st.capabilities };
}

module.exports = {
    RunnerPool, Runner, PERMISSION_MODES, EFFORTS, resolveWorkdir, rowStatus,
    // The Claude adapter's, re-exported from where they used to live.
    sessionEnv: claude.sessionEnv, mcpConfig: claude.mcpConfig,
    PREVIEW_TOOLS: claude.PREVIEW_TOOLS, LIMIT_TEXT: claude.LIMIT_TEXT,
};
