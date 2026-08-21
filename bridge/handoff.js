'use strict';

// The rules a handoff has to pass, kept apart from the route that applies them.
//
// One session handing work to another is the only thing in this app that starts a
// turn nobody asked for — `POST /api/sessions/:id/handoff` resumes an idle session
// and its message becomes the next turn. Everything that decides *whether* that
// happens lives here rather than inline in server.js, because it is the part with
// rules in it and therefore the part worth a test around it. server.js keeps the
// I/O: read the body, look the session up, wrap the message, send it.
//
// The wrapper itself is not here. It lives beside its parser in
// bridge/transcript.js, so the two halves of one format cannot drift apart.

// A handoff wakes a session, and a woken session can hand off in turn. Two agents
// that each think the other should know something will otherwise wake each other
// for as long as the machine allows, and every round costs a process and a turn.
// Nothing else in the system stops that: the pool caps how many runners stay live,
// not how many get started, and the sender is a model rather than a retrying
// client, so "it will notice and give up" is not something to rely on.
//
// Two windows, because they catch different mistakes.
//
//   pairMs   the ping-pong one. The same sender reaching the same session twice
//            inside a minute has nothing to say that could not have gone in the
//            first message, and a second message only interrupts the turn the
//            first one started.
//   windowMs the fan-out one. An agent working down a list of sessions, waking
//            every one of them.
//
// In memory and per bridge, deliberately. This is a brake rather than a security
// boundary, and a restart clearing it is right: whatever loop was running died
// with the processes.
const PAIR_MS = 60_000;
const MAX_PER_WINDOW = 20;
const WINDOW_MS = 60 * 60_000;

class HandoffLimit {
    constructor({ pairMs = PAIR_MS, max = MAX_PER_WINDOW, windowMs = WINDOW_MS } = {}) {
        this.pairMs = pairMs;
        this.max = max;
        this.windowMs = windowMs;
        /** @type {number[]} when each handoff went out, inside the window */
        this.hits = [];
        /** @type {Map<string, number>} "from::to" -> when it last went out */
        this.pairs = new Map();
    }

    /**
     * Ask, and record it if the answer is yes.
     *
     * `now` is a parameter so a test can move time without waiting for it.
     *
     * @returns {string|null} why this handoff is refused, written for the model
     *   that will read it, or null to let it through.
     */
    refuse(from, to, now = Date.now()) {
        // An absent sender still gets a pair key. It means every handoff with no
        // provenance shares one bucket, which is the safe direction to be wrong
        // in: a caller that will not say who it is gets the tighter limit.
        const key = `${from || '?'}::${to}`;

        const last = this.pairs.get(key);
        if (last != null && now - last < this.pairMs) {
            return 'you handed off to this session less than a minute ago. Say the rest in '
                + 'your reply instead of sending again — it read your first message as one '
                + 'turn, and a second one only interrupts it.';
        }

        this.hits = this.hits.filter(t => now - t < this.windowMs);
        if (this.hits.length >= this.max) {
            return `${this.max} handoffs have gone out in the last hour, which is more than `
                + 'this is for. Something is looping. Say what you found in your reply and '
                + 'stop there.';
        }

        this.hits.push(now);
        this.pairs.set(key, now);
        // Bounded: one entry per pair that has ever handed off would grow without
        // limit on a bridge that runs for weeks, and an entry older than the pair
        // window can never refuse anything again.
        for (const [k, t] of this.pairs) {
            if (now - t >= this.pairMs) this.pairs.delete(k);
        }
        return null;
    }
}

/**
 * What a handoff to this session would run into.
 *
 * Three answers where bridge/taskboard.js `column` gives two. That one folds "a
 * process, but not ours" into `working`, because from where the user sits both
 * are busy. For a handoff they are different outcomes — one is queued behind the
 * turn in flight, the other is refused outright — so the split is restored here,
 * using the same tests. See bridge/overview.js `why` for the original.
 *
 * `elsewhere` is the one worth naming. A session running in a terminal, in VS
 * Code, or as a background agent has no stdin of ours, and `claude --resume`
 * refuses it outright because two writers cannot append to one transcript (see
 * classifyError in bridge/runner.js). Telling a model that up front is the
 * difference between it picking another recipient and it watching a spawn fail.
 *
 * @param {{live: object|null}} summary from the session index
 * @param {{state: string, queued: number}|null} runner from the pool, if we hold one
 * @returns {'idle'|'working'|'elsewhere'}
 */
function stateOf(summary, runner) {
    if (runner && (runner.state === 'busy' || runner.state === 'starting')) return 'working';
    if (runner && runner.queued) return 'working';
    // A process this bridge started is never "elsewhere", however idle it is.
    if (!runner && summary && summary.live && summary.live.running) return 'elsewhere';
    return 'idle';
}

/**
 * Whether a handoff woke something, as opposed to joining a session already up.
 *
 * The one thing the sender cannot work out for itself, and the thing worth
 * telling it: "resumed for this" and "added to what it was doing" are different
 * pieces of news.
 */
function wakes(runner) {
    return !runner || runner.state === 'stopped' || runner.state === 'error';
}

// How long to wait, after asking a stopped session to resume, before reporting
// the handoff as delivered. Long enough for `claude --resume` to refuse — the
// refusals seen take one or two seconds — and short enough that a tool call is
// not left hanging. Nothing waits for *success*: a session that boots cleanly is
// still booting when this elapses, and that is fine.
const WAKE_GRACE_MS = 5_000;

/**
 * Watch a just-woken runner long enough to notice it never woke.
 *
 * This exists because of the one failure that is genuinely worse here than in the
 * composer. When `claude --resume` refuses — a session id still locked by a
 * process that was killed, a transcript another writer holds — the runner hands
 * the unsent text back on a `failed` event, and the UI puts it in the composer
 * for you to try again. A handoff has nobody to hand it back *to*: the session
 * that sent it is finishing its turn, and if the route has already said
 * "delivered" then the message is gone and the sender has told the user it was
 * passed on. So the route waits, briefly, and says what actually happened.
 *
 * Only worth calling when the send is what started the process. A runner that was
 * already up wrote the message to a live stdin, and there is nothing to wait for.
 *
 * @returns {Promise<{kind: string, message: string}|null>} why it failed, or null
 */
function wakeFailure(runner, graceMs = WAKE_GRACE_MS) {
    return new Promise((resolve) => {
        // Already failed, before anything could be attached — a spawn that threw
        // outright rather than exiting.
        if (runner.state === 'error') {
            resolve({
                kind: runner.errorKind || 'unknown',
                message: runner.lastError || 'the session could not be resumed',
            });
            return;
        }
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            runner.off('failed', onFailed);
            resolve(v);
        };
        const onFailed = (f) => finish({ kind: f.kind, message: f.message });
        const timer = setTimeout(() => finish(null), graceMs);
        // Unref'd: a handoff must never be the reason the bridge cannot exit.
        if (timer.unref) timer.unref();
        runner.on('failed', onFailed);
    });
}

module.exports = {
    HandoffLimit, stateOf, wakes, wakeFailure,
    PAIR_MS, MAX_PER_WINDOW, WINDOW_MS, WAKE_GRACE_MS,
};
