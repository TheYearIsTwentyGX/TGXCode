'use strict';

// The bridge: an HTTP + SSE server that runs inside WSL and does all the real
// work — reading transcripts, driving `claude`, talking to DevBrowser. The
// Windows-side Electron shell is only a window pointed at this server, so the
// UI can be reloaded without rebuilding anything.
//
// Binding 127.0.0.1 is enough for the Windows side to reach us because this
// machine runs WSL with networkingMode=mirrored.

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const cfg = require('./config');
const auth = require('./auth');
const { SessionIndex } = require('./sessions');
const { SessionRegistry } = require('./registry');
const { RunnerPool, PERMISSION_MODES } = require('./runner');
const hostClient = require('./host-client');
const { Flags } = require('./flags');
const { Prefs } = require('./prefs');
const { ClaudeConfig } = require('./claude-config');
const { ClaudeVersion } = require('./claude-version');
const { ClaudeDocs } = require('./claude-docs');
const keymap = require('./keymap');
const { Spinner } = require('./spinner');
const { Suggestions } = require('./suggestions');
const { Drafts } = require('./drafts');
const { Later } = require('./later');
const { Snippets } = require('./snippets');
const { Schedules } = require('./schedule');
const { SlashCommandCache } = require('./slash-commands');
const { NotificationLog, ReadState } = require('./notifications');
const { Usage } = require('./usage');
const { Beacon } = require('./beacon');
const devbrowser = require('./devbrowser');
const prStore = require('./pr-store');
const { TerminalPool } = require('./terminal');
const { RunPool } = require('./runs');
// The sections that used to live in this file — see each one's header.
const events = require('./events');
const scheduler = require('./scheduler');
const prRefresh = require('./pr-refresh');
const laterDelivery = require('./later-delivery');
const { pair } = require('./pairing');
// Plumbing every route shares, and the API itself — see bridge/routes/.
const { send, NEXT } = require('./http');
const { laterPayload } = require('./routes/later');
const { resolveAttachments } = require('./routes/files');

const WEB_DIR = path.join(__dirname, '..', 'web');
// The CSRF header every non-GET /api/ call must carry. The old name is still
// accepted: a packaged shell or a phone build from before the rename sends it,
// and refusing it would 403 their entire write surface.
const CLIENT_HEADERS = ['x-tgxcode-client', 'x-claude-sessions-client'];

const flags = new Flags();
// How the person using the app wants it to behave, from their own file and from
// whatever the project they are looking at overrides — see bridge/prefs.js.
const prefs = new Prefs();

// Claude Code's own settings, as opposed to this app's. A separate instance of
// a separate module on purpose — see the header of bridge/claude-config.js for
// the three things that stopped it being a mode of Prefs.
// `onChange` is the watch: `claude` writes these files too, and until it
// existed a panel left open only found out on its next save, when the write was
// refused with a 409. Same event as PUT /api/claude-config emits (in
// bridge/routes/settings.js), because a listener has no use for the difference
// — and see the header there for why the watch is liveness while the 409
// remains the correctness guarantee.
const claudeConfig = new ClaudeConfig({
    onChange: (e) => broadcast('claude-config', e),
});

// Claude Code's memory files, as opposed to its settings — see the header of
// bridge/claude-docs.js for why a whole text file is a different module from a
// key inside a JSON one.
const claudeDocs = new ClaudeDocs();

// The words a turn in progress calls itself, out of the groups those settings
// enable. Shares the Prefs instance rather than making its own, so the two
// cannot read different settings out of the same file.
const spinner = new Spinner(prefs);
// What you did about a suggested follow-up — started it, or waved it away. The
// suggestion itself is in the transcript; only the decision is ours to keep.
const suggestions = new Suggestions();
// How much of the 5-hour window and the week are gone. Fed by the stream events
// the runner forwards and by whatever scripts/quota-statusline.py has harvested
// — see bridge/usage.js for why it takes two sources to answer one question.
const usage = new Usage();
// And the thing that keeps those percentages current with no terminal open: a
// `claude` started for a few seconds and killed. Off unless the user has named
// a directory they trust — see bridge/beacon.js for why that consent is theirs
// to give rather than ours to assume.
const beacon = new Beacon();
// Sessions set up but not started. The only store here that is not about a
// session that exists: a draft *is* a create call, held back until you press
// Start. See bridge/drafts.js.
const drafts = new Drafts();
// Messages written now and delivered to a session that already exists, at a time
// you picked. A draft is a create call held back; this is a *send* held back —
// see bridge/later.js.
const later = new Later();
// Canned messages, and the groups they are drawn in. What replaced the one
// hard-coded LGTM button on the composer — see bridge/snippets.js. Named
// `snippetStore` rather than `snippets` so that nothing here has to wonder
// whether it is looking at the store or at the array of rows the payload carries.
const snippetStore = new Snippets();
// Sessions that start on a clock. A draft that is never consumed, plus a cron
// expression, plus a gate — see bridge/schedule.js. Only the everyday instance
// fires them; the tick in bridge/scheduler.js says why.
const schedules = new Schedules();
const index = new SessionIndex(flags);
const registry = new SessionRegistry();
const pool = new RunnerPool();
// Installed Claude Code against the registry, and which live processes predate
// the installed one. See bridge/claude-version.js.
const claudeVersion = new ClaudeVersion({
    channel: () => {
        const e = claudeConfig.read(null).effective['autoUpdatesChannel'];
        return e ? e.value : null;
    },
    runners: () => pool.statuses(),
});
const terminals = new TerminalPool();
const slashCommands = new SlashCommandCache();
// State only, never bytes: a run's output goes down its own stream. This is what
// lets every open window paint a button green off one small payload.
const runs = new RunPool({ onChange: (e) => broadcast('run-changed', e) });
// Titles are copied onto an entry as it is filed, so the log still reads
// properly after a session is renamed or deleted; the test flag is asked for at
// read time, so labelling a session as scratch afterwards takes its rows out of
// the everyday window too.
const notifications = new NotificationLog({
    describe: (id) => index.summary(id),
    isTest: (id) => flags.get(id).test,
});
// What of that log you have already seen — a watermark per conversation, so
// going to a chat and dealing with the thing clears its rows rather than leaving
// them counted against you. Kept here rather than in the page because two
// windows and a phone all have to agree about the badge.
const reads = new ReadState();

// Which sessions are running, from Claude Code's own registry rather than from
// how recently a file changed. The index works without it; every summary simply
// carries `live: null` and the mtime window is all anyone has to go on.
index.registry = registry;
// So a decision about a suggestion goes when its transcript does, the way a pin
// or an archive does.
index.suggestions = suggestions;
// So a session a schedule started says so, and the rail can group them. Absent,
// every summary carries `schedule: null` and nothing else changes.
index.schedules = schedules;
// So a rail row can say that a message is due here overnight. Absent, every
// summary carries `later: null` and nothing else changes.
index.later = later;

// The /api/events stream — its connections, the two boards, the transcript
// follows and the peer list — is bridge/events.js. `clients` is its Map, shared
// by reference, so the health count and `hasViewer` below see the same one.
events.init({ index, pool, registry });
const { clients, broadcast, tickBoard } = events;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    // Where this request came from and whether it carries the token. One object,
    // computed once, because three separate things below need the same answer.
    const who = auth.classify(req, url);

    // Same guard DevBrowser uses: reject cross-origin callers outright. A page in
    // some other tab must not be able to drive Claude on this machine.
    const origin = req.headers.origin;
    if (origin && !isOwnOrigin(origin, req)) return send(res, 403, { error: 'forbidden origin' });

    // A name we do not answer to means somebody else's DNS is pointing at this
    // port — the rebinding case, where a page on a public hostname resolves to
    // 127.0.0.1 and then talks to us as same-origin. Only checked for remote
    // requests: a local Host is the one we already know is ours.
    if (who.remote && !isKnownHost(who.host)) {
        return send(res, 403, { error: 'unexpected host', host: who.host });
    }

    if (pathname.startsWith('/api/') && pathname !== '/api/health'
        && req.method !== 'GET' && !CLIENT_HEADERS.some(h => req.headers[h])) {
        return send(res, 403, { error: 'missing client header' });
    }

    // The token. /api/health stays open: app/main.js pings it to decide whether a
    // bridge is up and serving the right checkout, before it could know a token,
    // and it gives away only counts and a pid. Everything else needs the token,
    // loopback included — "any process on this machine" is precisely the hole this
    // closes. A local *browser* is spared a login step by injectToken(), not by an
    // exemption here.
    if (pathname.startsWith('/api/') && pathname !== '/api/health' && !who.ok) {
        if (who.remote) {
            console.warn(`[tgxcode] rejected ${req.method} ${pathname} from `
                + `${who.peer} — no valid token`);
        }
        return send(res, 401, {
            error: 'unauthorized',
            hint: 'send the token from ~/.local/share/tgxcode/token as '
                + 'Authorization: Bearer <token>',
        });
    }

    if (who.remote && who.ok && pathname.startsWith('/api/')) logRemote(req, pathname, who);

    // Powers a phone does not get, even holding a valid token.
    if (who.remote) {
        const refusal = remoteRefusal(pathname, req.method);
        if (refusal) {
            console.warn(`[tgxcode] refused ${req.method} ${pathname} from `
                + `${who.peer} — ${refusal}`);
            return send(res, 403, { error: refusal, remote: true });
        }
    }

    try {
        if (pathname === '/pair' || pathname === '/pair/forget') {
            return pair(req, res, url, pathname, who);
        }
        if (pathname.startsWith('/api/')) return await api(req, res, url, pathname, who);
        return serveStatic(req, res, pathname, who);
    } catch (err) {
        // The stack goes to the log, not to the client. It names paths on this
        // machine and the shape of the code, and a client can do nothing with it.
        console.error(`[tgxcode] ${req.method} ${pathname} failed:`, err.stack || err);
        send(res, 500, { error: err.message });
    }
});

/**
 * Is this origin one of ours?
 *
 * The check exists to stop a page in another tab driving Claude, and that intent is
 * what decides how far it can widen. "The origin matching the host this request was
 * addressed to" preserves it exactly: our own page, served by us, always matches,
 * and a page on any other origin never does — whatever hostname the bridge is
 * reached by. So a reverse proxy needs no configuration to work, and adds no hole.
 *
 * Loopback stays accepted outright because the Electron shell and `npm run dev`
 * reach us on 127.0.0.1 while the page may say localhost, or a different port.
 */
function isOwnOrigin(origin, req) {
    if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true;
    if (cfg.EXTRA_ORIGINS.includes(origin)) return true;

    let host;
    try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
    if (host === auth.effectiveHost(req)) return true;
    // Tailscale's own names, so `tailscale serve` works out of the box.
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host);
}

/** Hostnames this bridge will answer to when reached from off-machine. */
function isKnownHost(host) {
    if (auth.hostIsLocal(host)) return true;
    if (/\.ts\.net$/.test(host)) return true;
    // An IP address is the LAN-bind case: there is no name to spoof, so there is
    // nothing for a rebinding attack to gain.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true;
    return cfg.EXTRA_ORIGINS.some((o) => {
        try { return new URL(o).hostname.toLowerCase() === host; } catch { return false; }
    });
}

/**
 * What a request from off-machine may not do, and why — or null if it may.
 *
 * The principle, from docs/plans/14-C: a phone should be able to *watch*, and to
 * answer the questions a session is blocked on. It should not be able to reach past
 * the app into the machine. So this is not a general permission system; it is a
 * short list of the routes that stop being reasonable once the caller is not in the
 * room, and every entry earns its place:
 *
 *   - **Terminals** are a raw pty. Everything else here is mediated by the app —
 *     you answer an ask, you send a prompt — but this is a shell, and a leaked
 *     token that reaches it has the machine. A phone has no use for one.
 *   - **Shutdown**, **restarting** and **stopping a dev server** act on processes the
 *     person at the desk is using, and are trivially a denial of service from
 *     anywhere else. Restarting is the worst of the three to hand out: it ends every
 *     turn in flight and comes back running whatever is on disk.
 *   - **Reveal**, **opening a path** and **DevBrowser** drive windows on the
 *     Windows host. Opening Explorer on a desktop nobody is sitting at is at best
 *     pointless — and opening a path is the one of the three that also hands that
 *     desktop something to launch, from text a transcript happened to contain.
 *   - **Making a folder** writes to the filesystem. Note the asymmetry with the
 *     listing beside it, which stays allowed: reading the tree answers "where
 *     could a session start", and a phone may already start one. Creating a
 *     directory is reaching past the app into the machine, which is the line
 *     above — so the refusal is on the exact path, not on /api/fs.
 *   - **Saving settings** is the mkdir clause with a longer reach. It writes a
 *     file in the user's home directory, and one of the keys in it —
 *     `quota.beaconDir` — names a directory this app then starts `claude` in.
 *     Reading them stays allowed, because how somebody wants a transcript
 *     folded is not a capability.
 *   - **Runs** are a terminal wearing a config file's clothes: /api/runs/:id/input
 *     writes bytes to a pty, so the terminal clause above settles it without a
 *     new argument. Starting one is refused on the exact path, the same asymmetry
 *     as /api/fs — a phone reading what a project declares learns nothing it
 *     could not learn by reading the repo; a phone running it does not.
 *
 * Refusing at the route rather than in the UI is the point: a client not drawing a
 * button is a courtesy, and this is the rule.
 */
function remoteRefusal(pathname, method) {
    if (pathname.startsWith('/api/terminals')) {
        return 'terminals are not available remotely';
    }
    if (pathname.startsWith('/api/runs')) {
        return 'project commands can only be run from the machine they run on';
    }
    // Exact equality, not a prefix: GET /api/commands stays readable remotely.
    if (pathname === '/api/commands/run') {
        return 'project commands can only be started from the machine they run on';
    }
    // The editor, and a separate prefix rather than a path under /api/commands
    // precisely so this can be a `startsWith` while the rule above stays an
    // equality. Under that prefix the default for anything added later would be
    // *allowed*, and remembering to add a line is what this whole file is trying
    // not to depend on.
    //
    // **The GET is refused too, which is the opposite of GET /api/commands one
    // line up, and the asymmetry is real rather than caution.** What a project
    // *declares* is in its repository already and carries no `env` — that route
    // has never returned one. These files are where a person keeps
    // `{"STRIPE_KEY": "sk_live_…"}`, in a file whose whole premise is that it is
    // private, and no client off this machine configures a command that runs on
    // it. See docs/remote.md.
    if (pathname === '/api/commands-config' || pathname.startsWith('/api/commands-config/')) {
        return 'a project’s commands can only be edited on the machine they run on';
    }
    if (pathname === '/api/shutdown') {
        return 'the bridge can only be shut down from the machine it runs on';
    }
    // The GET stays open: which version is installed is harmless, and a phone
    // is a reasonable place to notice sessions on an old binary.
    if (pathname === '/api/claude-version/update') {
        return 'Claude Code can only be updated on the machine it runs on';
    }
    // Both methods: the GET is the journal, which names the checkout and what a
    // restart decided about it, and there is nothing a phone does with that.
    if (pathname === '/api/restart') {
        return 'the bridge can only be restarted from the machine it runs on';
    }
    if (pathname === '/api/devservers/stop') {
        return 'dev servers can only be stopped from the machine they run on';
    }
    if (pathname.startsWith('/api/devbrowser')) {
        return 'DevBrowser is only reachable from the machine it runs on';
    }
    if (/^\/api\/sessions\/[^/]+\/reveal$/.test(pathname) && method === 'POST') {
        return 'opening a folder only makes sense on the machine itself';
    }
    // The same sentence about a smaller thing, and for the same reason: what this
    // does is put a window on *this* machine's desktop, which is not somewhere a
    // phone can look. It is also the route that will run a `.ps1` in the checkout
    // if you point it at one, so being local is doing real work here and not only
    // being tidy — see the route for that.
    //
    // Note the sibling GET /api/sessions/:id/diff is deliberately *not* on this
    // list. It reads, its bytes already reach a phone through the transcript, and
    // it is scoped to the session's own repository.
    if (/^\/api\/sessions\/[^/]+\/open-file$/.test(pathname) && method === 'POST') {
        return 'opening a file only makes sense on the machine itself';
    }
    // Exact equality, not a prefix: GET /api/fs stays readable remotely.
    if (pathname === '/api/fs/mkdir') {
        return 'folders can only be created on the machine they live on';
    }
    // Exact equality again, and for a second reason on top of the first: the
    // window this opens is on a desk somebody is not at, and the thing it opens
    // came out of a transcript.
    if (pathname === '/api/fs/open') {
        return 'a file can only be opened on the machine it lives on';
    }
    // Pressing a Wispr Flow chord puts keystrokes on this machine's desktop, into
    // whichever window has the focus. From anywhere else that is a keyboard
    // somebody is not at, typing into a window nobody is watching.
    if (pathname === '/api/wispr/press') {
        return 'keys can only be pressed on the machine they reach';
    }
    // Saving settings writes a file in the user's home directory, or inside a
    // checkout — the mkdir clause above, with a worse blast radius, because
    // `quota.beaconDir` names a directory this app then starts `claude` in. The
    // GET stays open: reading how somebody wants a transcript folded is not a
    // capability, and a phone has a use for the answer.
    if (pathname === '/api/prefs' && method !== 'GET') {
        return 'settings can only be saved on the machine they live on';
    }
    // Claude Code's own settings, and unlike the clause above this one has **no
    // method test**: the GET is refused too.
    //
    // The asymmetry is deliberate and is the reverse of the reasoning for
    // /api/prefs. There the GET stays open because how somebody wants a
    // transcript folded is not a capability and a phone has a use for the
    // answer. These files are the opposite on both counts — they name hook
    // commands, permission rules and the values of environment variables, and
    // no client off this machine configures the CLI — so there is nothing to
    // weigh against caution, and a leaked token should not be able to read
    // them. A prefix rather than an exact path, so anything added under
    // /api/claude-config later is refused by default rather than by being
    // remembered.
    if (pathname === '/api/claude-config' || pathname.startsWith('/api/claude-config/')) {
        return 'Claude Code’s own settings can only be read and written on the machine they live on';
    }
    // Claude Code's memory files, refused the same way and for the same reason,
    // with one addition: a project's CLAUDE.md is repository source and a user's
    // describes the machine — what is installed, which ports are in use, which
    // instance not to touch. Neither is something a client off this machine has
    // a use for, and both are worth rather more than a theme.
    //
    // A prefix with no method test, like the clause above, so anything added
    // under /api/claude-docs later is refused by default rather than by being
    // remembered.
    if (pathname === '/api/claude-docs' || pathname.startsWith('/api/claude-docs/')) {
        return 'Claude Code’s memory files can only be read and written on the machine they live on';
    }
    // A handoff starts a turn in a session the caller is not looking at, and can
    // wake one that has no process at all. That is a reasonable thing for an
    // agent on this machine to do and not a reasonable thing to reach in for from
    // a phone: the blast radius of a leaked token would be every session on the
    // machine, each spending tokens on words nobody typed.
    if (/^\/api\/sessions\/[^/]+\/handoff$/.test(pathname) && method === 'POST') {
        return 'a session can only be handed work from the machine it runs on';
    }
    // Attaching a file writes it into a checkout, which is the mkdir clause above.
    //
    // This is the weakest of the refusals on this list and it is worth saying so:
    // a phone taking a photo has nowhere *else* to put it, so "write it on the
    // machine you are sitting at" is advice a phone cannot take. It was refused in
    // v1 because the phone surface of the day had no attach affordance to refuse
    // anything for, and it stays refused because nothing has replaced that reason
    // yet — not because the argument is strong. If the Android app grows an attach
    // button, the answer is a smaller cap for a remote caller, not deleting this
    // line and letting a leaked token write 25MB files into a repo.
    if (/^\/api\/sessions\/[^/]+\/attachments(\/open)?$/.test(pathname)
        || pathname === '/api/attachments') {
        return 'files can only be attached on the machine they are saved to';
    }
    return null;
}

/**
 * Modes a remote caller may not start a session in.
 *
 * bypassPermissions runs everything unasked, which is a reasonable thing to choose
 * deliberately while sitting in front of the machine and not a reasonable thing to
 * be one tap away from on a phone that might be in someone else's hand. dontAsk is
 * the same argument with a quieter name.
 *
 * This is a refusal rather than a silent downgrade: quietly running in a safer mode
 * than the one asked for would be its own kind of lie.
 */
const REMOTE_FORBIDDEN_MODES = new Set(['bypassPermissions', 'dontAsk']);

function modeRefusal(mode, who) {
    if (!who.remote || !REMOTE_FORBIDDEN_MODES.has(mode)) return null;
    return `${mode} cannot be started remotely — choose it at the machine itself`;
}

/**
 * A very small token bucket on session creation.
 *
 * Not a security boundary; a brake. `POST /api/sessions` spawns a process, and
 * nothing else stops a loop — or a retrying client — from spawning them as fast as
 * the machine will allow. The pool caps how many stay *live* (MAX_LIVE), which is a
 * different thing from how many get started.
 */
const CREATE_LIMIT = { max: 8, windowMs: 60_000, hits: [] };

function tooManyCreates({ reserve = 0, peek = false } = {}) {
    const now = Date.now();
    CREATE_LIMIT.hits = CREATE_LIMIT.hits.filter(t => now - t < CREATE_LIMIT.windowMs);
    // `reserve` keeps creates back for somebody pressing a button.
    //
    // This bucket is global, which was fine while every caller was a person: they
    // cannot press Start eight times a minute by accident. A scheduled sweep can
    // start a session per open pull request, and spending the whole budget on that
    // means the user's own next Start returns 429 from a limit they never touched.
    // So the sweep asks for less than the whole thing.
    if (CREATE_LIMIT.hits.length >= CREATE_LIMIT.max - reserve) return true;
    // `peek` asks without spending. This function charges a create as a side
    // effect of answering, which is fine for a route that goes on to create one —
    // but the pull-request sweep asks first, against a reserve, and then
    // `runSchedule` asks again. That charged two of the eight for every review:
    // three starts a minute instead of four, and a reserve of two that could be
    // eaten down to one. A pull request whose range would not resolve spent a hit
    // for a session that never happened.
    if (!peek) CREATE_LIMIT.hits.push(now);
    return false;
}

// ---------------------------------------------------------------------------
// Things on a clock
// ---------------------------------------------------------------------------
//
// Schedules firing (bridge/scheduler.js, with the pull-request gate's GitHub
// side in bridge/pr-gate.js), pull request status kept fresh
// (bridge/pr-refresh.js) and scheduled messages delivered
// (bridge/later-delivery.js). Each is handed the instances and the router's
// refusal rules it needs here, rather than requiring server.js back; the timers
// that drive them are still started in the listen callback at the bottom.

scheduler.init({
    schedules, pool, flags, index, notifications, filed,
    normalizeMode, modeRefusal, tooManyCreates, CREATE_LIMIT,
});
const {
    SCHEDULE_MS, SCHEDULE_ON_DEV,
    tickSchedules, recoverInterruptedReviews, noteScheduledOutcome,
} = scheduler;

prRefresh.init({ index, pool });
const { tickPrs } = prRefresh;

laterDelivery.init({
    later, index, pool, notifications, filed, laterPayload,
    normalizeMode, sessionCwd, resolveAttachments,
});
const { tickLater, recoverInterruptedLater } = laterDelivery;

/**
 * Log a remote request, once per minute per source rather than per request.
 *
 * Plan 14-B asks for the source address of every authenticated request when the
 * bridge is reachable from off-machine. Taken literally that is a line per SSE
 * poll, which buries the one line that matters. Per source, per minute, plus every
 * write, keeps it readable and still answers "who has been talking to this bridge".
 */
const remoteSeen = new Map();
function logRemote(req, pathname, who) {
    const writes = req.method !== 'GET';
    const last = remoteSeen.get(who.peer) || 0;
    if (!writes && Date.now() - last < 60_000) return;
    remoteSeen.set(who.peer, Date.now());
    console.log(`[tgxcode] remote ${req.method} ${pathname} from ${who.peer} `
        + `via ${who.host}`);
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------
//
// Every /api/ route lives in bridge/routes/, one file per family, and this is the
// whole of what is left of them here: the order they are asked in.
//
// **The order is the router.** Each module's `handle` is the `if` chain that used
// to sit in one 3,000-line function, moved verbatim, and it returns `NEXT` for a
// request that is none of its own — including one whose path it matched and whose
// method it did not, which then goes on to the modules below and finally to the
// 404, exactly as falling out of an `if` block used to. So a module earlier in
// this list can shadow a later one. Two pairs of routes overlap and their order is
// load-bearing: `sessions` (for `/api/sessions/addressable`) must come before
// `session` (`/api/sessions/:id`), and inside `suggestions` the start route comes
// before the list. Every other pair of families is disjoint — different
// `seg[1]`, or different exact paths — so where they sit relative to each other
// changes nothing.
//
// **What is not here, on purpose.** The origin and host checks, the CSRF header,
// the token and remoteRefusal() all run in the request handler above, before
// `api()` is called, and a route module never sees a request they refused. The
// rules that depend on the body rather than the path — modeRefusal(), the
// `who.remote` checks inside a route — stay textually beside the route they
// guard, in its module.
//
// **Why `init`.** The routes need the instances this file builds and owns, and
// requiring server.js back from a route module would hand it a half-filled
// exports object in the middle of this file's load. So each is given the same
// object once, here, and takes what it uses. Only things that are never
// reassigned go in it — instances, function declarations, one `const` object —
// so a module holding its own reference to one can never see a stale value. The
// one `let` a route writes, `claudeVersionSent`, is reached through a function.
const ROUTES = [
    require('./routes/events'),
    require('./routes/bridge'),
    require('./routes/settings'),
    require('./routes/notifications'),
    require('./routes/sessions'),
    require('./routes/suggestions'),
    require('./routes/drafts'),
    require('./routes/later'),
    require('./routes/snippets'),
    require('./routes/schedules'),
    require('./routes/dashboard'),
    require('./routes/quota'),
    require('./routes/session'),
    require('./routes/session-workspace'),
    require('./routes/commands'),
    require('./routes/terminals'),
    require('./routes/machine'),
    require('./routes/files'),
];

const ROUTE_DEPS = {
    index, pool, registry, flags, prefs, claudeConfig, claudeDocs, spinner, suggestions,
    beacon, drafts, later, snippetStore, schedules, claudeVersion, terminals,
    slashCommands, runs, notifications, reads,
    normalizeMode, modeRefusal, tooManyCreates, CREATE_LIMIT, sessionCwd, shutdown,
    quotaPayload, quotaPrefs, runBeaconNow, markClaudeVersionSent,
};
for (const routes of ROUTES) if (routes.init) routes.init(ROUTE_DEPS);

async function api(req, res, url, pathname, who) {
    const seg = pathname.split('/').filter(Boolean); // ['api', ...]
    for (const routes of ROUTES) {
        if (await routes.handle(req, res, url, pathname, seg, who) !== NEXT) return;
    }
    return send(res, 404, { error: 'no such endpoint', pathname });
}

/**
 * Where a session's process should run.
 *
 * The transcript's own cwd, unless it has since been deleted — a worktree that
 * has been landed and removed is the common case — in which case the project
 * directory it belonged to, and failing that home. Shared by the send route and
 * by /api/slash-commands so the two can never disagree about which directory a
 * session belongs to; a client cannot work this out for itself, having no way to
 * ask whether a path still exists.
 */
function sessionCwd(summary) {
    if (summary.cwd && fs.existsSync(summary.cwd)) return summary.cwd;
    if (summary.projectCwd && fs.existsSync(summary.projectCwd)) return summary.projectCwd;
    return cfg.HOME;
}

// An unrecognised mode falls back to the app's default rather than erroring: the
// mode is a knob on a request that has real work in it, and refusing the whole
// send over a typo in one field loses the message.
function normalizeMode(mode) {
    return PERMISSION_MODES.includes(mode) ? mode : 'auto';
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
    // The image types the composer will accept and inline, which would otherwise
    // be served as application/octet-stream and ignored. Nothing in web/ is a
    // jpeg today; the table being one short of the set it claims to cover is the
    // kind of gap that only shows up as a broken image months later.
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
};

// The one HTML entry point. There used to be a second, `/m`, serving a
// phone-shaped page; the phone is the native Android app now and `/m` 404s like
// any other path that is not a file.
const PAGES = new Map([
    ['/', 'index.html'],
]);

function serveStatic(req, res, pathname, who) {
    const rel = PAGES.get(pathname) || pathname.replace(/^\/+/, '');
    const file = path.resolve(WEB_DIR, rel);
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
        return send(res, 403, { error: 'forbidden' });
    }
    let body;
    try { body = fs.readFileSync(file); } catch { return send(res, 404, { error: 'not found' }); }

    // Hand our own page its credentials, so opening 127.0.0.1 in a browser — or the
    // Electron shell doing the same — needs no login step. Only for a local
    // navigation to a page of ours: see auth.localPageRequest.
    //
    // Two forms, for two different jobs.
    //
    // The **cookie** is what authenticates. It means nothing in web/ has to change
    // for the UI to keep working: `fetch` defaults to credentials:'same-origin' and
    // EventSource sends same-origin cookies too, so every existing call — including
    // the two SSE streams and the service worker's, which is the one place a header
    // could not have been threaded through — carries it already. It also puts the
    // desktop on exactly the path a paired remote browser uses, not a second one.
    //
    // The **<meta> tag** is not for authentication; it is so the page can *read* the
    // token, which it needs to build the pairing URL for "Connect a phone". An
    // HttpOnly cookie is deliberately unreadable, and that is the right trade for a
    // credential — hence both.
    const headers = {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
    };
    if (file.endsWith('.html')) {
        // Even same-origin: the token is in this response body, and a referrer is
        // the one way it could leave the page by accident.
        headers['Referrer-Policy'] = 'same-origin';
        if (auth.localPageRequest(req)) {
            body = Buffer.from(auth.injectToken(body.toString('utf8')), 'utf8');
            headers['Set-Cookie'] = auth.pairCookie(auth.current(), { secure: who.secure });
        }
        // Settings go to every page, local or not — they are not a credential,
        // and a remote browser renders the same transcript. In the page rather
        // than behind a fetch because the client opens a session synchronously
        // at startup: a transcript drawn before an async answer arrived would
        // stay drawn the wrong way, since nothing re-renders history.
        body = Buffer.from(auth.injectMeta(body.toString('utf8'),
            'tgx-prefs', JSON.stringify(prefs.page(''))), 'utf8');
        // The shortcut catalogue, for the same reason and one more: the first
        // key somebody presses may land before a fetch could answer, and a
        // Ctrl+3 that does nothing because the keymap has not arrived yet is
        // indistinguishable from a broken binding.
        body = Buffer.from(auth.injectMeta(body.toString('utf8'),
            'tgx-keymap', JSON.stringify(keymap.payload())), 'utf8');
        // Where this bridge's filesystem is, so a path in a transcript can be
        // drawn as a link to the Windows form of it. Local callers only, on the
        // same reasoning as `root` and `home` on /api/health: a path on this
        // machine is not something a browser off it can act on, and the route
        // that opens one refuses it anyway. A page without the tag renders paths
        // as plain text, which is the right remote answer rather than a degraded
        // one — and the same answer outside WSL, where there is no share to name.
        if (!who.remote && cfg.WSL_DISTRO) {
            body = Buffer.from(auth.injectMeta(body.toString('utf8'), 'tgx-host',
                JSON.stringify({ distro: cfg.WSL_DISTRO, home: cfg.HOME })), 'utf8');
        }
    }
    headers['Content-Length'] = body.length;

    res.writeHead(200, headers);
    res.end(body);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Is anyone in a position to answer an approval for this session?
 *
 * Any live SSE client counts, not just one already following this transcript:
 * the card is a session-level thing and a window that is open can be switched to
 * it. With nothing connected there is nobody to ask, and the runner denies —
 * which is exactly what the app did before approvals existed.
 */
pool.hasViewer = () => clients.size > 0;

// And what it says while it works. Every surface that shows a session working
// reads `runner.activity` off one SSE message, so deciding it here is what makes
// all of them — a phone included — agree. See bridge/spinner.js.
pool.thinking = (cwd, last) => spinner.pick(cwd, last);
pool.rerollAfter = (cwd) => spinner.rerollMs(cwd);

index.on('changed', () => broadcast('sessions-changed', { at: Date.now() }));

// A message from another Claude session, noticed in the transcript rather than
// in a process stream — see SessionIndex#rescan for why that is the only place
// it can be noticed. Broadcast as well as logged, so a window already showing
// that conversation does not have to wait for the rail to tell it something
// happened.
index.on('peer-message', (p) => {
    broadcast('peer-message', p);
    filed(notifications.peerMessage(p));
});
// A handoff this bridge delivered. Watched in the transcript rather than reported
// by the route that sent it, for the same reason as above and one more: the route
// knows a message was queued, and this knows it arrived.
index.on('handoff', (h) => {
    broadcast('handoff', h);
    filed(notifications.handoff(h));
});
// A session starting or stopping in a terminal writes nothing to a transcript,
// so the registry is the only thing that notices — the rail would otherwise wait
// for the next thing that happened to change a file.
registry.on('changed', () => broadcast('sessions-changed', { at: Date.now() }));
// Every status carries `busySince`, which is how the log measures a turn — see
// NotificationLog#noteRunner for why the result's own duration will not do.
pool.on('status', (s) => { notifications.noteRunner(s); broadcast('runner-status', s); });
// A card is answered from the board, so the board must not be up to a second
// behind on an ask appearing or being taken away.
pool.on('permission-request', (p) => {
    broadcast('permission-request', p);
    filed(notifications.ask(p));
    tickBoard();
});
pool.on('permission-resolved', (p) => {
    broadcast('permission-resolved', p);
    const row = notifications.resolve(p.requestId, p.outcome);
    if (row) {
        broadcast('notification-resolved',
            { id: row.id, outcome: row.outcome, outcomeAt: row.outcomeAt });
    }
    tickBoard();
});
pool.on('notice', (n) => broadcast('notice', n));
// The identical `allowed` event arrives on every turn, so only a reading that
// moved is worth a broadcast — `noteRateLimitEvent` says which.
pool.on('quota', (info) => {
    if (usage.noteRateLimitEvent(info)) broadcast('quota', quotaPayload());
});

// How often to *consider* running the beacon. Not how often it runs — that is
// `quota.beaconEveryMinutes`, read fresh each time so an edit to the settings
// file lands without a restart. Checking on a shorter clock than the interval
// is what makes that possible.
const BEACON_TICK_MS = 60_000;

// A development bridge does not probe the quota, for the same reason it does
// not fire schedules: the reading is account-wide, so the everyday instance is
// the one that should own it, and a worktree bridge doing it too is an API call
// spent to measure the API calls being spent. It was also where every orphaned
// beacon came from — a dev bridge is restarted constantly and killed abruptly,
// which is exactly the shape that leaks a detached child.
const BEACON_ON_DEV = process.env.TGXCODE_BEACON_ON_DEV === '1';

/** Why the beacon is not running, for the panel to say, or null. */
function beaconSuppressed() {
    return (cfg.IS_DEV && !BEACON_ON_DEV) ? 'dev-bridge' : null;
}

// Seeded from disk rather than 0, so a restart inherits the interval instead of
// firing a run on every bridge start. See usage.beaconRanAt().
let beaconLastRunAt = (usage.beaconRanAt() || 0) * 1000;

/**
 * The quota snapshot plus what the beacon is doing about it.
 *
 * One payload rather than two routes because they answer one question between
 * them: the number, and why it is or is not moving. A panel that showed a
 * two-hour-old percentage without being able to say "the beacon is off" or
 * "every run is hitting a dialog" would be the same unexplained staleness this
 * feature exists to avoid.
 */
function quotaPayload() {
    const snap = usage.snapshot();
    let q = {};
    try { q = prefs.forCwd().quota || {}; } catch { /* defaults below */ }
    snap.beacon = {
        enabled: !!q.beacon && !!q.beaconDir,
        suppressed: beaconSuppressed(),
        dir: q.beaconDir || null,
        everyMinutes: q.beaconEveryMinutes || null,
        ...beacon.status(),
    };
    return snap;
}

/**
 * Refresh the quota percentages, if it is time and the user asked for it.
 *
 * Deliberately quiet about failure. A beacon run that hits a dialog, or a
 * directory that was never trusted, leaves the last reading in place and the
 * pill goes on showing its age — which is the honest outcome and needs no
 * toast. The reason is kept for the panel, which is where somebody who wonders
 * why the number stopped moving will actually look.
 */
/** The user-level quota preferences, or {} if they cannot be read. */
function quotaPrefs() {
    try {
        // No cwd: the user-level file only. A project's `.tgxcode/settings.json`
        // is checked into a repository, and where this app starts Claude is not
        // a repository's decision to make.
        return prefs.forCwd().quota || {};
    } catch {
        return {};
    }
}

/**
 * One beacon run, plus the bookkeeping that has to go with any of them.
 *
 * Shared by the timer and by the Refresh button, so the two cannot drift: both
 * push the automatic interval out, and both broadcast only when the merged view
 * actually moved. A refresh that reconfirms 12% is not news to a client — though
 * its fresher timestamp is, which is why `capturedAt` counts as a change.
 */
async function runBeaconNow(dir) {
    beaconLastRunAt = Date.now();
    // Recorded before the run, not after: a run that hangs for its full ninety
    // seconds and then fails must still push the next attempt out by the
    // interval, or a broken beacon becomes a busy loop.
    usage.noteBeaconRun(Math.floor(beaconLastRunAt / 1000));

    const before = usage.snapshot();
    const out = await beacon.run(dir);
    if (out.ok) {
        // The harvester wrote a new file; usage.js will pick it up on its next
        // read.
        const after = usage.snapshot();
        if (JSON.stringify(after.windows) !== JSON.stringify(before.windows)
            || after.statusLine.capturedAt !== before.statusLine.capturedAt) {
            broadcast('quota', quotaPayload());
        }
    }
    return out;
}

async function tickBeacon() {
    if (beaconSuppressed()) return;

    const q = quotaPrefs();
    if (!q.beacon || !q.beaconDir) return;
    if (beacon.busy) return;

    const everyMs = Math.max(5, q.beaconEveryMinutes || 20) * 60_000;
    if (Date.now() - beaconLastRunAt < everyMs) return;

    await runBeaconNow(q.beaconDir);
}
// Every process announces what slash commands its directory has. Recorded so a
// composer can offer them without a process of its own, and broadcast only when
// the list actually moved — otherwise each session start would push an identical
// list to every open window for nothing.
// Pushed only when it moved. Runner statuses fire on every change of activity,
// and almost none of them change which sessions are on an old binary, so this
// is debounced and compared rather than sent each time.
let claudeVersionSent = '';
// The route that installs an update records what it broadcast here too, so the
// next status change does not send the same summary again. A function because a
// route module cannot assign a `let` in this file.
function markClaudeVersionSent(text) { claudeVersionSent = text; }
let claudeVersionTimer = null;
function pushClaudeVersion() {
    if (claudeVersionTimer) return;
    claudeVersionTimer = setTimeout(() => {
        claudeVersionTimer = null;
        const now = claudeVersion.summaryNow();
        const text = JSON.stringify(now);
        if (text === claudeVersionSent) return;
        claudeVersionSent = text;
        broadcast('claude-version', now);
    }, 1000);
    claudeVersionTimer.unref();
}
pool.on('status', pushClaudeVersion);
pool.on('init', ({ cwd, init }) => {
    const entry = slashCommands.note(cwd, init);
    if (entry) broadcast('slash-commands', { cwd, at: entry.at });
});
pool.on('turn-complete', (r) => {
    broadcast('turn-complete', r);
    filed(notifications.turn(r));
    noteScheduledOutcome(r);
});
pool.on('failed', (f) => { broadcast('send-failed', f); filed(notifications.sendFailed(f)); });
// Nothing notifies for a subagent finishing; it is logged so that "what has been
// happening" has an answer at all.
pool.on('agent-done', (a) => filed(notifications.agentDone(a)));

/**
 * Tell any open history view about a new row, so it does not have to re-fetch.
 *
 * `read` and `unread` ride along for the same reason the GET carries them: a
 * client that had to derive the badge itself would need the watermarks, and a
 * client that guessed "a new row means one more" would be wrong for a quiet row,
 * for a test session, and for a row filed against a conversation you are already
 * looking at.
 */
function filed(row) {
    if (!row) return;
    broadcast('notification', {
        ...row,
        read: reads.isRead(row),
        unread: notifications.countUnread(r => reads.isRead(r), { includeTest: cfg.IS_DEV }),
    });
}
pool.on('forked', ({ from, to }) => {
    index.note(to);
    broadcast('session-forked', { from, to });
});

let shuttingDown = false;
function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
        const { stillRunning, held } = pool.shutdown();
        if (held) {
            console.log(`[tgxcode] ${held} session(s) left running in the session host; `
                + 'the next bridge on this port picks them up.');
        }
        if (stillRunning) {
            console.log(`[tgxcode] ${stillRunning} turn(s) were in flight and will `
                + 'stop with this process — their transcripts keep whatever was written.');
        }
    } catch (err) {
        // Not "nothing to clean" any more: a throw here can be the difference
        // between a turn left running in the host and one that is lost.
        console.error(`[tgxcode] runner shutdown failed: ${err && err.stack || err}`);
    }
    // Terminals run in their own process groups, so unlike turns they would
    // outlive us if we did not take them with us. A run is the same, and worse
    // if left: its stdout is a pipe nobody is reading any more, so it would fill
    // the buffer, block on write() and go on holding its port while hung.
    //
    // The beacon is the third of these, and the worst of the three to leave: it
    // is a `claude` TUI re-rendering its status line every three seconds, and
    // every render writes a now-frozen quota reading over the shared harvest
    // file that every bridge on this machine reads. Five of them survived a
    // worktree's dev bridges for twenty-eight hours and made the pill show a
    // number that was wrong and looked fresh. Anything spawned `detached`
    // belongs on this list.
    try { terminals.shutdown(); } catch { /* nothing to clean */ }
    try { runs.shutdown(); } catch { /* nothing to clean */ }
    try { beacon.shutdown(); } catch { /* nothing to clean */ }
    // Drafts are written on a 400ms debounce and this process exits 200ms from
    // here, so a draft saved in the last moment before a restart would simply be
    // gone — having been acknowledged with a 200. Worse in one direction than the
    // other: the *deletion* that a start performs is on the same debounce, so
    // losing it means the draft comes back and can be started a second time.
    // flush() merges, so writing here cannot trample another bridge either.
    try { drafts.flush(); } catch { /* nothing to save */ }
    // Load-bearing rather than tidy: the process exits well inside the debounce
    // window, and an unflushed `delivering` claim would come back up looking like
    // `pending` — the one transition this store must never make.
    try { later.flush(); } catch { /* nothing to save */ }
    // The same argument one notch quieter: a snippet lost inside the debounce is a
    // paragraph to retype rather than a session started twice. It is on this list
    // because everything with a debounce belongs on it, and because a deletion is
    // on the same timer — losing that one puts a snippet you removed back in the
    // popover.
    try { snippetStore.flush(); } catch { /* nothing to save */ }
    // The same argument, and one case where it is sharper: an unflushed
    // `lastSlotAt` means the slot this bridge just fired is not on disk, so the
    // next bridge up owes it again and the run happens twice. `claim()` flushes
    // for exactly that reason, but an outcome or a skip recorded in the last
    // 400ms before a restart would otherwise be lost.
    try { schedules.flush(); } catch { /* nothing to save */ }
    try { index.stop(); } catch { /* nothing to clean */ }
    try { registry.stop(); } catch { /* nothing to clean */ }
    try { claudeConfig.stop(); } catch { /* nothing to clean */ }
    try { server.close(); } catch { /* already closed */ }
    setTimeout(() => process.exit(code), 200).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// A worktree may never be the everyday instance.
//
// The everyday port is not something anyone chose here: the bridge hands its own
// environment to every session it starts, so `TGXCODE_PORT=45888` is
// already set for an agent working in a worktree, and `bash bridge/launch.sh`
// there binds the user's port without a port ever being mentioned. What follows
// is worse than a clash — the bind succeeds if the everyday bridge is not up
// yet, /api/health reports `dev: false`, and the Windows shell adopts it. The
// window then looks exactly like the everyday one while serving a branch's UI
// out of a stale worktree.
//
// scripts/dev.js has always refused this, but only for `npm run dev`; the guard
// belongs where the port is bound so that no way of starting a bridge can get
// around it.
if (cfg.PORT === cfg.DEFAULT_PORT && cfg.IS_WORKTREE) {
    console.error(`[tgxcode] refusing to serve ${cfg.ROOT} on `
        + `${cfg.DEFAULT_PORT} — that is the everyday instance, and this is a `
        + 'worktree.');
    console.error('  Start a development bridge instead: npm run dev, or '
        + `TGXCODE_PORT=${cfg.DEV_PORT} bash bridge/launch.sh`);
    console.error('  TGXCODE_PORT is inherited from the bridge that '
        + 'started this session, so unset it rather than trusting it.');
    process.exit(4);
}

// Binding anything but loopback publishes the bridge, and on this machine that
// means publishing it to a /24 shared with the building — AT&T Community Wi-Fi for
// Apartments, with client isolation misconfigured. A token stands in front of it,
// but a token is not a reason to offer the socket to strangers when there is a
// better way: `tailscale serve` reaches a phone from anywhere while the socket stays
// on loopback. So this takes a second, explicit env var, and says what to do
// instead. Plan 14-B asked for a refusal when no token file existed; a token now
// always exists, so the refusal that still earns its place is this one.
if (!auth.hostIsLocal(cfg.HOST.replace(/^\[|\]$/g, '')) && !cfg.ALLOW_REMOTE_BIND) {
    console.error(`[tgxcode] refusing to bind ${cfg.HOST} — that offers this `
        + 'bridge to the network, and this machine is on a shared apartment subnet.');
    console.error('  For a phone, prefer `tailscale serve` on the Windows host: it '
        + 'reaches you from anywhere and the bridge never leaves loopback.');
    console.error('  See docs/remote.md. To bind anyway, set '
        + 'TGXCODE_ALLOW_REMOTE_BIND=1.');
    process.exit(5);
}

// Before the socket, so the first request cannot arrive before there is a token to
// check it against.
auth.ensureToken();

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[tgxcode] port ${cfg.PORT} is already in use — `
            + 'another bridge is probably running.');
        process.exit(3);
    }
    console.error('[tgxcode] server error:', err.message);
    process.exit(1);
});

/**
 * Is a bridge already answering on our port? Asked before touching the session
 * host, because that host is *its* host: adopting from it would put a second
 * runner on every live turn, both flushing the same queue, before our listen()
 * failed with EADDRINUSE and left.
 */
function portTaken() {
    return new Promise((resolve) => {
        const sock = net.connect(cfg.PORT, cfg.HOST.replace(/^\[|\]$/g, ''));
        sock.setTimeout(500);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.on('error', () => resolve(false));
    });
}

/**
 * Connect to the session host and take back whatever the last bridge on this port
 * left running in it. Before the socket, for `adoptHeld`'s reason: a message that
 * arrived first would start a second `claude` on a session that already has one.
 * Bounded, and never fatal — no host means spawning directly, as before.
 */
async function takeBackHeld() {
    if (!cfg.USE_HOST) return;
    if (await portTaken()) return;
    const up = await hostClient.ensureHost({ socketPath: cfg.HOST_SOCKET, logFile: cfg.HOST_LOG });
    if (!up) {
        console.warn('[tgxcode] no session host — turns will end if this bridge '
            + `restarts. See ${cfg.HOST_LOG}.`);
        return;
    }
    const n = await pool.adoptHeld();
    const st = hostClient.status();
    console.log(`[tgxcode] session host pid ${st && st.pid}`
        + (n ? `; picked up ${n} session(s) the last bridge left running` : ''));
}

takeBackHeld().catch((err) => {
    console.error(`[tgxcode] session host: ${err.message}`);
}).then(() => server.listen(cfg.PORT, cfg.HOST, async () => {
    console.log(`[tgxcode] bridge listening on http://${cfg.HOST}:${cfg.PORT}`);
    // Before the index, so the very first summaries it hands out already say
    // what is running rather than guessing at it for one scan.
    registry.start();
    claudeConfig.start();
    console.log(`[tgxcode] registry: ${registry.liveCount} of ${registry.size} `
        + 'session(s) still have a process');

    const t0 = Date.now();
    await index.start();
    console.log(`[tgxcode] indexed ${index.sessions.size} sessions in ${Date.now() - t0}ms`);

    if (cfg.IS_DEV) {
        console.log('[tgxcode] development instance — the everyday one on '
            + `${cfg.DEFAULT_PORT} is untouched.`);
    }

    // Schedules: catch up first, then keep looking.
    //
    // The pass here is the whole reason a missed run can be reported at all. The
    // bridge is not up continuously — the window closes, the machine sleeps, the
    // nightly restart happens — so a slot that fell while it was down is found on
    // the way back up rather than never. `tickSchedules` treats that pass and
    // every later one identically; catching up is not a second code path.
    //
    // After the index, because firing needs `index.note` and `flags` to be able
    // to keep a brand-new session out of the everyday window.
    if (!cfg.IS_DEV || SCHEDULE_ON_DEV) {
        // The same symmetric rule the tick applies: a dev bridge counts only test
        // schedules, and the everyday one counts only the rest.
        const armed = schedules.enabled()
            .filter(r => cfg.IS_DEV === !!r.test).length;
        if (cfg.IS_DEV) {
            console.log('[tgxcode] TGXCODE_SCHEDULE_ON_DEV=1 — this dev '
                + 'bridge will fire schedules marked as tests, and only those.');
        }
        if (armed) {
            console.log(`[tgxcode] ${armed} schedule(s) armed; `
                + `checking every ${SCHEDULE_MS / 1000}s`);
        }
        // Before the first tick: a review this process cannot own must be marked
        // before the sweep looks at what is still in flight.
        try { recoverInterruptedReviews(); } catch (err) {
            console.error(`[tgxcode] review recovery failed: ${err.message}`);
        }
        tickSchedules().catch(err => console.error(
            `[tgxcode] schedule catch-up failed: ${err.message}`));
        // `.unref()` for the reason handoff.js gives: a timer must never be the
        // thing keeping the bridge from exiting.
        setInterval(() => {
            tickSchedules().catch(err => console.error(
                `[tgxcode] schedule tick failed: ${err.message}`));
        }, SCHEDULE_MS).unref();
    }

    // Messages on a clock, on the schedule tick's clock and with its shape — a
    // catch-up pass first, then every SCHEDULE_MS, both `.unref()`ed.
    //
    // **Outside the block above on purpose.** That one is gated on
    // TGXCODE_SCHEDULE_ON_DEV because a schedule starts an unattended agent
    // in the user's own checkout out of a file every bridge shares. A scheduled
    // message can only speak to a session that already exists, and the dev/test
    // symmetry inside the tick already decides which bridge owns which rows — so
    // there is no blast radius for that variable to guard, and requiring it would
    // only mean every test of this feature needed an env var.
    //
    // The catch-up pass is what makes a missed message reportable at all: the
    // bridge is not up continuously, and a message due while it was down has to be
    // found on the way back up rather than never.
    try { recoverInterruptedLater(); } catch (err) {
        console.error(`[tgxcode] message recovery failed: ${err.message}`);
    }
    // Rows whose session is gone, and terminal ones past their week. Once at boot
    // rather than on a clock of its own: nothing here grows fast enough to need
    // more, and the index has just finished scanning.
    try { later.prune(index.knownIds()); } catch (err) {
        console.error(`[tgxcode] message prune failed: ${err.message}`);
    }
    tickLater().catch(err => console.error(
        `[tgxcode] scheduled message catch-up failed: ${err.message}`));
    setInterval(() => {
        tickLater().catch(err => console.error(
            `[tgxcode] scheduled message tick failed: ${err.message}`));
    }, SCHEDULE_MS).unref();

    // Pull request status. The only thing in this process that asks gh about a PR
    // on a clock, and the reason no route has to.
    //
    // Once at startup, before the interval, for `tickSchedules`' reason: a bridge
    // that has just come up should not be showing what GitHub looked like when it
    // went down. It is cheap where it used to be expensive — the store's settled
    // PRs come off disk, so a restart no longer costs a `gh pr view` per merged
    // PR on the machine.
    //
    // Unconditional on dev, unlike schedules: reading GitHub changes nothing on
    // GitHub, so there is no everyday-instance-only rule to draw here. Two bridges
    // both refreshing is two `gh pr list` calls and one file rewritten twice.
    tickPrs().catch(err => console.error(
        `[tgxcode] PR catch-up failed: ${err.message}`));
    setInterval(() => {
        tickPrs().catch(err => console.error(
            `[tgxcode] PR refresh failed: ${err.message}`));
    }, prStore.TICK_MS).unref();

    // The quota beacon. Its own timer rather than a fold into the schedule
    // tick: that one fires every SCHEDULE_MS and is about starting sessions,
    // and this is neither that often nor that consequential.
    //
    // The interval is read on every tick rather than captured here, so editing
    // `~/.tgxcode/settings.json` takes effect without a restart — the same
    // property every other preference in that file has.
    setInterval(() => { tickBeacon(); }, BEACON_TICK_MS).unref();

    // Warm the version check so the first window to open has an answer, then
    // ask the registry hourly. Read-only on every bridge, dev included.
    const checkClaudeVersion = () => claudeVersion.summary({ fresh: true })
        .then(pushClaudeVersion)
        .catch(err => console.error(`[tgxcode] version check failed: ${err.message}`));
    checkClaudeVersion();
    setInterval(checkClaudeVersion, 60 * 60 * 1000).unref();

    // Reap before anything else, and on *every* bridge including a dev one that
    // will never run a beacon of its own. A leaked beacon is machine-wide
    // damage — it writes to the shared harvest file — so whichever bridge comes
    // up next is the right one to clear it, not whichever bridge happens to be
    // configured to probe. This is also the only cleanup that survives the
    // bridge being killed with SIGKILL, where `shutdown()` never runs.
    try {
        const reaped = beacon.reap();
        if (reaped) {
            // Process groups, not beacons: `script` and the `claude` it runs
            // in the pty end up in groups of their own, so one leaked beacon
            // is two of these.
            console.log(`[tgxcode] killed ${reaped} orphaned quota beacon `
                + 'process group(s) left by a bridge that is no longer running.');
        }
    } catch { /* ps(1) is best-effort */ }

    // And a run once at startup, so a bridge that has just come up is not
    // showing a reading from before it went down. Gated by the persisted
    // interval, so this is a no-op on a restart that happened inside it.
    tickBeacon();

    if (!auth.hostIsLocal(cfg.HOST.replace(/^\[|\]$/g, ''))) {
        console.warn(`[tgxcode] bound ${cfg.HOST} — reachable from the network. `
            + 'Every remote request is logged below.');
    }

    // This port shows up in DevBrowser's detected list; name it so it isn't just
    // another anonymous number in the rail.
    devbrowser.setTitle(cfg.PORT,
        cfg.IS_DEV ? 'TGXCode (dev)' : 'TGXCode (app)').catch(() => {});
}));
