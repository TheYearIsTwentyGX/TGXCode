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
const os = require('os');
const { randomUUID } = require('crypto');

const cfg = require('./config');
const auth = require('./auth');
const { SessionIndex, projectName } = require('./sessions');
const { SessionRegistry } = require('./registry');
const { RunnerPool, PERMISSION_MODES, resolveWorkdir } = require('./runner');
const hostClient = require('./host-client');
const { Flags } = require('./flags');
const { Prefs } = require('./prefs');
const { ClaudeConfig } = require('./claude-config');
const { ClaudeVersion } = require('./claude-version');
const { ClaudeDocs, MAX_DOC_BYTES } = require('./claude-docs');
const keymap = require('./keymap');
const { Spinner, norm: spinnerNorm } = require('./spinner');
const { Suggestions, STATUSES: SUGGESTION_STATUSES } = require('./suggestions');
const { Drafts, MAX_DRAFTS } = require('./drafts');
const {
    Later, LATE_MS, MAX_PER_SESSION: MAX_LATER_PER_SESSION, MAX_AHEAD_MS,
} = require('./later');
const {
    Snippets, MAX_SNIPPETS, MAX_GROUPS, MAX_PARAMS, MAX_BODY, MAX_PROJECTS, MAX_TITLE,
    INSERT_STYLES, isParamName, isAccent, scanPlaceholders,
} = require('./snippets');
const {
    Schedules, MAX_SCHEDULES,
    parseCron, nextSlot, describeCron, cronForm,
    reviewKey,
} = require('./schedule');
const { SlashCommandCache } = require('./slash-commands');
const { NotificationLog, ReadState } = require('./notifications');
const { Usage } = require('./usage');
const { Beacon } = require('./beacon');
const devbrowser = require('./devbrowser');
const tailscale = require('./tailscale');
const devservers = require('./devservers');
const dashboard = require('./dashboard');
const git = require('./git');
const restart = require('./restart');
const changes = require('./changes');
const pulls = require('./pulls');
const prStore = require('./pr-store');
const taskboard = require('./taskboard');
const tasks = require('./tasks');
const { openInExplorer, openFile, isLaunchable } = require('./explorer');
const wispr = require('./wispr');
const attachments = require('./attachments');
const { TerminalPool } = require('./terminal');
const commands = require('./commands');
const { RunPool } = require('./runs');
// Written here, read back by transcript.js. One format, and the two halves of it
// live in one file so they cannot drift apart.
const { handoffEnvelope } = require('./transcript');
const { HandoffLimit, stateOf: handoffState, wakes, wakeFailure } = require('./handoff');
// The sections that used to live in this file — see each one's header.
const events = require('./events');
const scheduler = require('./scheduler');
const prRefresh = require('./pr-refresh');
const laterDelivery = require('./later-delivery');
const { pair } = require('./pairing');

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
// refused with a 409. Same event as the PUT below emits, because a listener has
// no use for the difference — and see the header there for why the watch is
// liveness while the 409 remains the correctness guarantee.
const claudeConfig = new ClaudeConfig({
    onChange: (e) => broadcast('claude-config', e),
});

/**
 * Which status a claude-config refusal is.
 *
 * The split is the same one PUT /api/prefs draws — the caller's mistake against
 * the machine's answer about what is possible — with one addition: a conflict
 * is neither. `409` says the request was well formed and would have been
 * accepted a moment ago, which is exactly the case a client has to handle
 * differently from both a bad value and a file it may not write.
 */
/**
 * The claude-config read, plus the two things the module cannot answer alone.
 *
 * `running` is how many sessions are live, because a change to these files
 * reaches the next session and not the ones already going — and "I changed it
 * and nothing happened" is the question that count exists to answer before it
 * is asked. Taken from the registry rather than from the runner pool on
 * purpose: a session under a terminal will not see the change either, and
 * leaving it out of the count would make the sentence wrong in the reassuring
 * direction.
 *
 * `ignored` is asked of git rather than of a `.gitignore`, because the answer
 * on this machine comes from a *global* excludes file — see git.ignored().
 * Only the local row is asked: the shared one is meant to be committed.
 */
async function claudeConfigPayload(cwd) {
    const base = claudeConfig.read(cwd);
    const here = cwd ? path.resolve(cfg.expandHome(cwd)) : null;
    const live = registry.running();
    const running = here
        ? live.filter(e => e.cwd && (e.cwd === here || e.cwd.startsWith(`${here}${path.sep}`))).length
        : live.length;

    const files = await Promise.all(base.files.map(async (f) => {
        if (f.scope !== 'project-local' || !here) return f;
        const answer = await git.ignored(here, `${cfg.CLAUDE_DIR}/${cfg.CLAUDE_SETTINGS_LOCAL_FILE}`);
        return { ...f, ignored: answer.ignored, ignoredBy: answer.source };
    }));
    return { ...base, files, running };
}

function claudeConfigStatus(code) {
    if (['scope', 'dir', 'body', 'path', 'value', 'json', 'stamp'].includes(code)) return 400;
    if (['stale', 'exists'].includes(code)) return 409;
    if (code === 'size') return 413;
    return 403;   // readonly, unparseable, write
}

// Claude Code's memory files, as opposed to its settings — see the header of
// bridge/claude-docs.js for why a whole text file is a different module from a
// key inside a JSON one.
const claudeDocs = new ClaudeDocs();

/**
 * Which status a claude-docs refusal is.
 *
 * The same split claudeConfigStatus draws, over a smaller set of codes: there
 * is no `patch` here and nothing to parse, so `path`, `value`, `json` and
 * `unparseable` have no way to happen and are deliberately absent rather than
 * carried across for symmetry.
 */
function claudeDocsStatus(code) {
    if (['scope', 'dir', 'body', 'stamp'].includes(code)) return 400;
    if (['stale', 'exists'].includes(code)) return 409;
    if (code === 'size') return 413;
    return 403;   // readonly, write
}

/**
 * Which status a refusal from the project-command editor is.
 *
 * The same split claudeConfigStatus draws — the caller's mistake against the
 * machine's answer about what is possible, with a conflict as neither. `invalid`
 * is this file's `value`: a document the reader would refuse wholesale, carrying
 * `detail.problems` so a form can put each message on the row and field it is
 * about rather than at the top of the card.
 */
function commandsConfigStatus(code) {
    if (['scope', 'dir', 'body', 'stamp', 'invalid', 'json', 'version'].includes(code)) return 400;
    if (['stale', 'exists'].includes(code)) return 409;
    if (code === 'size') return 413;
    return 403;   // readonly, write
}

/**
 * The editor's read, plus the one thing the module cannot answer cheaply.
 *
 * `commands.raw()` asks whether the local file is excluded with the synchronous
 * check the read path already uses, which returns a bare boolean. Here the
 * answer is a sentence on screen, so it is re-asked through git.ignored() for
 * the rule that matched — the same upgrade claudeConfigPayload makes, and for
 * the same reason: on this machine a file can be excluded by a *global* rule
 * that no amount of looking in the repository would reveal, and "add a line to
 * .gitignore" is bad advice when the line is already somewhere else.
 */
async function commandsConfigPayload(cwd) {
    const base = commands.raw(cwd);
    if (!base) return null;
    const files = await Promise.all(base.files.map(async (f) => {
        if (f.scope !== 'project-local') return f;
        const answer = await git.ignored(base.project,
            `${cfg.TGX_DIR}/${cfg.COMMANDS_LOCAL_FILE}`);
        return { ...f, ignored: answer.ignored, ignoredBy: answer.source };
    }));
    return { ...base, files };
}

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
// What `?status=` on /api/suggestions accepts: the decisions the store
// knows, plus `open` for a task nobody has decided about — which is the absence
// of an entry rather than a status, so the store has no name for it.
const SUGGESTION_STATES = new Set(['open', ...SUGGESTION_STATUSES]);
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
const {
    clients, sseSend, broadcast, streamBytes, dropClient, stopWatch,
    syncBoard, buildBoard, tickBoard, sendBoardNow, syncTaskboard, sendTaskboardNow,
    listPeers, startWatch, startAgentWatch, stopAgentWatch,
} = events;

// Whether a restart script has been handed over to. One-way: this process is
// being replaced, so there is nothing to set it back for. Two clicks would
// otherwise be two kills and two launch.sh racing for one port.
let handedOver = false;

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
// Drafts
// ---------------------------------------------------------------------------

/**
 * A draft as it goes out on the wire: the stored row plus the project label.
 *
 * Derived here rather than in the store and rather than in each client, so that
 * the desktop, the phone and the Android app cannot come to three different
 * answers about which project a directory belongs to. It is the same
 * `projectName` the rail and the session list use.
 */
function draftOut(draft) {
    return { ...draft, projectName: projectName(draft.cwd) };
}

/** The whole list, which is both the GET body and the SSE payload. */
function draftsPayload() {
    const rows = drafts.list().map(draftOut);
    return { at: Date.now(), drafts: rows, counts: { total: rows.length } };
}

/**
 * A scheduled message on the wire.
 *
 * `projectName` for draftOut's reason, and `late` because the window is the one
 * thing a client cannot work out for itself: LATE_MS lives in the bridge, and a
 * chip that said "in -20 minutes" for a row that is never going to be delivered
 * would be worse than one that says it was missed.
 */
function laterOut(row) {
    return {
        ...row,
        projectName: projectName(row.cwd),
        late: row.state === 'pending' && Date.now() - row.at > LATE_MS,
    };
}

/** The whole list, which is both the GET body and the SSE payload. */
function laterPayload() {
    const rows = later.list().map(laterOut);
    return {
        at: Date.now(),
        messages: rows,
        counts: {
            total: rows.length,
            pending: rows.filter(r => r.state === 'pending').length,
        },
    };
}

/**
 * Validate what a draft write is asking for, exactly as a create would.
 *
 * The point of checking at *write* time is that a draft you cannot start is
 * worse than a refused save: it sits on the board looking ready and fails every
 * time you press Start. So the directory has to exist and be inside the roots
 * here too — `resolveWorkdir` is the same function `pool.create` calls, so the
 * two cannot disagree — and a remote caller is refused the two modes it is
 * refused on creation, or a phone could stash a `bypassPermissions` draft it is
 * not allowed to run.
 *
 * `partial` is PATCH: a field absent from the body is left alone rather than
 * validated as missing. `cwd` comes back expanded, which is what gets stored, so
 * a `~` typed into the dialog means the same thing a shell would make of it.
 *
 * @returns {{fields: object} | {error: string, status: number, remote?: boolean}}
 */
function draftFields(body, who, { partial }) {
    const fields = {};

    if (!partial || body.cwd !== undefined) {
        if (!body.cwd) return { error: 'cwd is required', status: 400 };
        try {
            fields.cwd = resolveWorkdir(String(body.cwd));
        } catch (err) {
            return { error: err.message, status: 400 };
        }
    }

    if (!partial || body.prompt !== undefined) {
        const prompt = body.prompt && String(body.prompt).trim();
        if (!prompt) return { error: 'prompt is required', status: 400 };
        fields.prompt = prompt;
    }

    if (!partial || body.permissionMode !== undefined) {
        const mode = normalizeMode(body.permissionMode);
        const refusal = modeRefusal(mode, who);
        if (refusal) return { error: refusal, status: 403, remote: true };
        fields.permissionMode = mode;
    }

    // The two that mean "no choice made" when empty, rather than being invalid.
    if (!partial || body.model !== undefined) fields.model = body.model || null;
    if (!partial || body.title !== undefined) fields.title = body.title || null;
    if (!partial || body.test !== undefined) fields.test = !!body.test;

    return { fields };
}

/**
 * Validate what a scheduled-message write is asking for, exactly as a send would.
 *
 * `draftFields`' shape, and for its reason: the create and the edit have to reach
 * the same verdict, and a message that could be saved but never delivered is worse
 * than a refused save.
 *
 * Two rules that are not `/send`'s:
 *
 *   * **`permissionMode` is required, not defaulted.** `/send` normalises an absent
 *     one to `auto`, and that trap is much worse here: `auto` is the one mode that
 *     cannot work when nobody is watching, and the mistake would only show up as a
 *     session that stalled in the night. A client must say what it means.
 *   * **`at` must be in the future and inside a month.** The upper bound is what
 *     makes a typo'd year a 400 rather than a row that sits in the file forever.
 */
function laterFields(body, who, { partial }) {
    const fields = {};

    if (!partial || body.text !== undefined || body.attachments !== undefined) {
        const text = body.text ? String(body.text).trim() : '';
        const files = Array.isArray(body.attachments) ? body.attachments : [];
        // A screenshot with nothing typed under it is a real message, which is the
        // send route's rule and not worth having twice over.
        if (!text && !files.length) {
            return { error: 'text or an attachment is required', status: 400 };
        }
        fields.text = text;
        fields.attachments = files;
    }

    if (!partial || body.permissionMode !== undefined) {
        if (!body.permissionMode) {
            return {
                error: 'permissionMode is required — a message delivered while nobody is '
                    + 'watching has its permission asks denied automatically, so the mode '
                    + 'has to be a choice rather than a default',
                status: 400,
            };
        }
        const mode = normalizeMode(body.permissionMode);
        const refusal = modeRefusal(mode, who);
        if (refusal) return { error: refusal, status: 403, remote: true };
        fields.permissionMode = mode;
    }

    if (!partial || body.at !== undefined) {
        const at = Number(body.at);
        if (!Number.isFinite(at)) return { error: 'at is required', status: 400 };
        const now = Date.now();
        if (at <= now) {
            return { error: 'at is in the past — pick a time that has not happened yet', status: 400 };
        }
        if (at - now > MAX_AHEAD_MS) {
            return { error: 'at is more than a month away', status: 400 };
        }
        fields.at = at;
    }

    if (!partial || body.model !== undefined) fields.model = body.model || null;

    return { fields };
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

/**
 * A snippet as it goes out on the wire: the stored row, plus what its body and
 * its declared parameters say about each other.
 *
 * Derived here rather than in each client, the way `draftOut` derives
 * `projectName` and for the same reason — the desktop, the phone and the Android
 * app should not each get to decide what counts as an undeclared placeholder.
 *
 * **Neither list is an error**, and no route below refuses on either. `undeclared`
 * is left in the message verbatim when the snippet is used; `unused` is a
 * parameter you have declared and not wired up yet, which is a normal state to
 * save a half-finished snippet in. They are here so an editor can say so quietly
 * under the body.
 */
function snippetOut(row) {
    const { undeclared, unused } = scanPlaceholders(row.body, row.params);
    return { ...row, undeclared, unused };
}

/**
 * The whole list, which is both the GET body and the SSE payload.
 *
 * **Never filtered by `cwd`**, even though the GET route offers that filter: one
 * payload goes to every open window and each window's composer is in a different
 * directory. A client that narrowed its first load has to narrow the event too.
 */
function snippetsPayload() {
    const rows = snippetStore.list().map(snippetOut);
    const groups = snippetStore.listGroups();
    return {
        at: Date.now(),
        snippets: rows,
        groups,
        counts: {
            snippets: rows.length,
            groups: groups.length,
            pinned: rows.filter(r => r.pinned).length,
        },
    };
}

/**
 * A snippet's permission mode, where null means inherit.
 *
 * Deliberately not `normalizeMode`. That one answers an unrecognised mode with
 * `auto`, which is the right inert fallback for a send — `auto` is the app's
 * default — and exactly the wrong one here, because a snippet carrying a mode
 * *moves the user's selector* before it sends. Turning a typo into a silent change
 * to the permission mode of the next thing you send is the one direction this
 * field must not fail in. Null is the absence of a choice and there is nothing
 * safer to land on.
 *
 * Still a normalisation rather than a refusal, for the reason `normalizeMode`
 * exists at all: losing a whole snippet over one bad field is worse than the field
 * doing nothing.
 */
function snippetMode(v) {
    if (v == null || v === '') return null;
    return PERMISSION_MODES.includes(v) ? v : null;
}

/**
 * Validate what a snippet write is asking for.
 *
 * `partial` is PATCH: a field absent from the body is left alone rather than
 * validated as missing. The `{fields} | {error, status, remote?}` shape is
 * `draftFields`', and so is the habit of returning the first problem rather than
 * collecting them — a form with one bad field is the normal case.
 *
 * Two fields **normalise** rather than refuse and two do not, and the split is on
 * purpose. A parameter's `type` and a group's `accent` are open sets whose worst
 * case is a field that still holds the right value, so an unrecognised one widens
 * to `text` and to no accent. An unrecognised `insert` is a 400, because its three
 * values decide what happens to text the user has *already typed* and one of them
 * replaces it — there is no fallback that is both the natural default and
 * harmless. It is also a closed set of three drawn as a picker, so a bad value
 * cannot come from a person; it comes from a script, and a script is exactly the
 * caller worth telling.
 *
 * @returns {{fields: object} | {error: string, status: number, remote?: boolean}}
 */
function snippetFields(body, who, { partial }) {
    const fields = {};

    if (!partial || body.title !== undefined) {
        const title = body.title && String(body.title).trim();
        if (!title) return { error: 'title is required', status: 400 };
        if (title.length > MAX_TITLE) {
            return { error: `title is longer than ${MAX_TITLE} characters`, status: 400 };
        }
        fields.title = title;
    }

    if (!partial || body.body !== undefined) {
        const text = body.body == null ? '' : String(body.body);
        // Non-empty once trimmed, but **stored untrimmed**: an `insert` of
        // `append` or `cursor` makes leading and trailing whitespace part of what
        // the snippet means. Two different tests, deliberately.
        if (!text.trim()) return { error: 'body is required', status: 400 };
        if (text.length > MAX_BODY) {
            return { error: `body is longer than ${MAX_BODY} characters`, status: 400 };
        }
        fields.body = text;
    }

    if (!partial || body.groupId !== undefined) {
        const groupId = body.groupId == null ? null : String(body.groupId);
        // Checked on write and *not* on read, which is asymmetric on purpose: the
        // caller picked from a list of groups this bridge just sent it, so a bad
        // id here is a bug worth naming. A row already on disk pointing at a group
        // this process cannot see may belong to another bridge that still holds
        // it, and rewriting it would be the thing merge-on-write exists to avoid.
        if (groupId && !snippetStore.getGroup(groupId)) {
            return { error: 'no such snippet group', status: 400 };
        }
        fields.groupId = groupId;
    }

    if (!partial || body.params !== undefined) {
        const list = body.params === undefined ? [] : body.params;
        if (!Array.isArray(list)) return { error: 'params must be an array', status: 400 };
        if (list.length > MAX_PARAMS) {
            return { error: `a snippet may declare at most ${MAX_PARAMS} parameters`, status: 400 };
        }
        const seen = new Set();
        for (const p of list) {
            const name = p && p.name && String(p.name).trim();
            // All three failures mean one thing — this parameter can never be
            // referenced — because a parameter's identity *is* its name, and that
            // name is what `{{name}}` in the body looks up.
            if (!name || !isParamName(name)) {
                return {
                    error: `"${name || ''}" is not a usable parameter name — letters, `
                        + 'digits and underscores, not starting with a digit',
                    status: 400,
                };
            }
            if (seen.has(name)) {
                return { error: `two parameters are both called "${name}"`, status: 400 };
            }
            seen.add(name);
        }
        fields.params = list;
    }

    if (!partial || body.insert !== undefined) {
        const insert = body.insert === undefined ? 'overwrite' : body.insert;
        if (!INSERT_STYLES.includes(insert)) {
            return {
                error: `insert must be one of ${INSERT_STYLES.join(', ')}`,
                status: 400,
            };
        }
        fields.insert = insert;
    }

    if (!partial || body.permissionMode !== undefined) {
        const mode = snippetMode(body.permissionMode);
        // A snippet with `autoSubmit` and a mode is one pinned button that sets the
        // mode and sends — which is a sharper version of what REMOTE_FORBIDDEN_MODES
        // is about, not a weaker one. Refused twice over: here, so a phone cannot
        // stash one, and again by the send route when it is used.
        const refusal = mode ? modeRefusal(mode, who) : null;
        if (refusal) return { error: refusal, status: 403, remote: true };
        fields.permissionMode = mode;
    }

    if (!partial || body.projects !== undefined) {
        const list = body.projects === undefined ? [] : body.projects;
        if (!Array.isArray(list)) return { error: 'projects must be an array', status: 400 };
        if (list.length > MAX_PROJECTS) {
            return { error: `a snippet may name at most ${MAX_PROJECTS} projects`, status: 400 };
        }
        fields.projects = list;
    }

    if (!partial || body.order !== undefined) {
        if (body.order !== undefined && body.order !== null && !Number.isInteger(body.order)) {
            return { error: 'order must be an integer or null', status: 400 };
        }
        fields.order = body.order === undefined ? null : body.order;
    }

    // The rest mean "no" when absent rather than being invalid.
    if (!partial || body.hint !== undefined) fields.hint = body.hint || null;
    if (!partial || body.autoSubmit !== undefined) fields.autoSubmit = !!body.autoSubmit;
    if (!partial || body.pinned !== undefined) fields.pinned = !!body.pinned;

    return { fields };
}

/** The same, for a group: a name, a colour and a place in the row. */
function snippetGroupFields(body, { partial }) {
    const fields = {};

    if (!partial || body.name !== undefined) {
        const name = body.name && String(body.name).trim();
        if (!name) return { error: 'name is required', status: 400 };
        if (name.length > MAX_TITLE) {
            return { error: `name is longer than ${MAX_TITLE} characters`, status: 400 };
        }
        fields.name = name;
    }

    if (!partial || body.accent !== undefined) {
        // Normalised rather than refused — but strictly, because the client sets
        // this as a CSS custom property and anything looser is a declaration in
        // the page's stylesheet rather than a colour.
        fields.accent = isAccent(body.accent) ? body.accent : null;
    }

    if (!partial || body.order !== undefined) {
        if (body.order !== undefined && body.order !== null && !Number.isInteger(body.order)) {
            return { error: 'order must be an integer or null', status: 400 };
        }
        fields.order = body.order === undefined ? null : body.order;
    }

    return { fields };
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
    SCHEDULE_MS, SCHEDULE_ON_DEV, SWEEP_MS,
    scheduleOut, schedulesPayload, scheduleFields,
    fireSchedule, tickSchedules, recoverInterruptedReviews, noteScheduledOutcome,
} = scheduler;

prRefresh.init({ index, pool });
const { tickPrs, prsPayload } = prRefresh;

laterDelivery.init({
    later, index, pool, notifications, filed, laterPayload,
    normalizeMode, sessionCwd, resolveAttachments,
});
const { deliverLater, tickLater, recoverInterruptedLater } = laterDelivery;

/** A bounded `?limit=`, so one caller cannot ask for the whole index. */
function limitOf(url, fallback, max) {
    const n = Number(url.searchParams.get('limit'));
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
}

// The brake on handoffs. One per bridge; see bridge/handoff.js for the two
// windows it keeps and why a loop guard is needed at all.
const handoffLimit = new HandoffLimit();

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

// How many working-tree files the changes panel is sent. Well past what anybody
// scrolls, and low enough that a `node_modules` somebody forgot to ignore cannot
// turn one panel into a megabyte of JSON.
const CHANGED_FILE_CAP = 400;

// The three questions "what changed in this file" can mean, and the only three
// `/diff` will answer to. An unrecognised one is a 400 rather than a silent
// fallback to the default: a client asking for `cached` and being handed the
// worktree would draw a confident, wrong answer.
const DIFF_MODES = new Set(['worktree', 'staged', 'unstaged']);

async function api(req, res, url, pathname, who) {
    const seg = pathname.split('/').filter(Boolean); // ['api', ...]

    // --- events -----------------------------------------------------------
    if (pathname === '/api/events' && req.method === 'GET') {
        const id = randomUUID();
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const client = { res, subs: new Map(), agent: null, overview: false, taskboard: false };
        clients.set(id, client);
        sseSend(client, 'hello', { clientId: id, version: cfg.VERSION });

        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);
        ping.unref();
        req.on('close', () => { clearInterval(ping); dropClient(id); });
        return;
    }

    if (pathname === '/api/subscribe' && req.method === 'POST') {
        const body = await readJson(req);
        const { clientId, sessionId, offset, agent } = body;
        if (!clients.has(clientId)) return send(res, 404, { error: 'unknown client' });
        const client = clients.get(clientId);

        // The board is a separate follow from the conversation, and orthogonal to
        // it: it stays up while you read one session, and the session keeps
        // tailing while the board is on screen.
        const wants = Boolean(body.overview);
        if (client.overview !== wants) {
            client.overview = wants;
            syncBoard();
            if (wants) sendBoardNow(client);
        }
        // The task board is a third, independent follow, for the same reason.
        // It is not implied by `overview`: the two are different questions and a
        // window is almost never reading both at once.
        const wantsTb = Boolean(body.taskboard);
        if (client.taskboard !== wantsTb) {
            client.taskboard = wantsTb;
            syncTaskboard();
            if (wantsTb) sendTaskboardNow(client);
        }
        // One session in view at a time; drop other follows so we aren't polling
        // transcripts nobody is looking at.
        for (const [sid, sub] of client.subs) {
            if (sid !== sessionId) { stopWatch(sub); client.subs.delete(sid); }
        }
        if (sessionId) startWatch(clientId, sessionId, Number(offset) || 0);

        // The session keeps streaming while a subagent is on screen — switching
        // back should not have to re-read the parent from the top.
        if (agent && agent.toolUseId && sessionId) {
            startAgentWatch(clientId, sessionId, String(agent.toolUseId),
                Number(agent.offset) || 0);
        } else {
            stopAgentWatch(client);
        }
        return send(res, 200, { ok: true });
    }

    // --- health / meta ----------------------------------------------------
    if (pathname === '/api/health') {
        // The one route with no token, so it is also the one route that has to
        // think about what it gives away. Everything below is a count, a pid or a
        // flag — except root/home, which are paths on this machine and are only
        // here for the Windows shell's benefit. It always asks over loopback, so a
        // remote caller can be told less without costing anything.
        const local = !who.remote;
        return send(res, 200, {
            ok: true, app: 'tgxcode', version: cfg.VERSION,
            pid: process.pid, port: cfg.PORT, dev: cfg.IS_DEV, ready: index.ready,
            sessions: index.sessions.size, host: os.hostname(),
            // Whether this request arrived from off-machine, and whether the bridge
            // is asking for a token at all. The UI reads both: the first raises the
            // remote banner, the second tells an older client why it is getting 401s.
            remote: who.remote, authRequired: true,
            // Which checkout is being served, and the home directory to expand a
            // `~` in the shell's configured bridgeDir against. The Windows shell
            // compares these before it adopts a bridge it did not start: a port
            // answering is not proof it is answering for the right tree.
            ...(local ? { root: cfg.ROOT, home: cfg.HOME } : {}),
            worktree: cfg.IS_WORKTREE,
            // Whether sessions this bridge starts are given the task tools back.
            // False means a task list will usually be empty, which is worth a
            // client explaining rather than drawing as "no tasks". Says nothing
            // about sessions this bridge did not start.
            todoTools: cfg.TODO_TOOLS,
            // Live SSE connections — a quick way to tell whether a UI attached.
            clients: clients.size, runners: Object.keys(pool.statuses()).length,
            terminals: terminals.live().length, runs: runs.live().length,
            // Sessions with a process, from Claude Code's registry — including
            // every one running in a terminal, which no other count here sees.
            live: registry.liveCount, registered: registry.size,
            // Turns in flight, and of those, the ones a restart would end: a turn
            // in the session host survives one and is adopted by the next bridge.
            // Anything that restarts the bridge should look at `atRisk` — `busy`
            // is what it looked at before the host, and still means what it said.
            busy: pool.busyCount,
            atRisk: pool.atRiskCount,
            // The session host this bridge is running turns in, or null when it
            // is spawning them directly. Pid and protocol only; see bridge/host.js.
            sessionHost: hostClient.status(),
            permissionModes: PERMISSION_MODES,
        });
    }

    // Settings, for a caller that wants them fresh rather than as the page was
    // served with them — the settings page after a save, or a client checking
    // after the file was edited by hand. `?cwd=` asks what is in force for a
    // project; without it, the user-level answer. Not local-only: reading a
    // preference about how a transcript looks is not a capability a phone should
    // be refused, and prefs.forCwd() runs a cwd through cfg.withinRoots anyway.
    //
    // `?files=1` adds what each file in the chain says on its own, which is the
    // other half of the question and only the settings page asks it: "in force"
    // cannot tell a value you set from one you inherited, and a control that
    // cannot tell those apart offers to clear things that were never set and
    // appears not to work when a stronger file has taken over.
    if (pathname === '/api/prefs' && req.method === 'GET') {
        const cwd = url.searchParams.get('cwd') || '';
        const body = prefs.forCwd(cwd);
        if (url.searchParams.get('files')) return send(res, 200, { ...body, files: prefs.raw(cwd) });
        return send(res, 200, body);
    }

    // Save some of them. A patch of `{section: {key: value}}` rather than a
    // whole document, so two windows editing different settings do not clobber
    // each other, and `null` for a value removes the key so it falls back down
    // the chain. `scope` picks which of the three files it lands in — see
    // Prefs.targetFile. Local-only; see remoteRefusal.
    //
    // Refusals carry the code Prefs.save classified them with, so a client can
    // tell "you sent a value this key does not allow" from "that file is not
    // yours to write" without matching on prose.
    if (pathname === '/api/prefs' && req.method === 'PUT') {
        const body = await readJson(req);
        let saved;
        try {
            saved = prefs.save({
                scope: body.scope || 'user',
                dir: body.cwd || '',
                patch: body.patch,
            });
        } catch (err) {
            // A bad value or an unknown key is the caller's mistake; a file it
            // may not write, or one that does not parse, is the machine's
            // answer about what is possible.
            const status = (err.code === 'value' || err.code === 'section'
                || err.code === 'scope' || err.code === 'dir') ? 400 : 403;
            return send(res, status, { error: err.message, code: err.code || 'save' });
        }
        // Every window reads settings, and two of them are routinely open here —
        // the Electron shell and a browser tab on the same bridge. Only the
        // user-level answer is broadcast: a project's is the open session's
        // business and arrives with the transcript.
        broadcast('prefs', prefs.page(''));
        return send(res, 200, { file: saved.file, prefs: saved.prefs, files: saved.files });
    }

    // ── Claude Code's own settings ──────────────────────────────────────────
    //
    // The chain, the merged reading of it, and everything in the files that
    // this app has no control for — see bridge/claude-config.js for why that
    // last part is the whole point rather than a nicety.
    //
    // Local callers only, **including the GET**, which is the opposite of
    // /api/prefs. There the argument for an open GET was that a phone has a use
    // for how somebody wants a transcript folded. These files name hook
    // commands, permission rules and the *values* of environment variables, and
    // no client that is not on this machine has any use for them — so there is
    // nothing to weigh against caution. See docs/remote.md.
    if (pathname === '/api/claude-config' && req.method === 'GET') {
        const cwd = url.searchParams.get('cwd') || '';
        return send(res, 200, await claudeConfigPayload(cwd));
    }

    // Two bodies, one route. `patch` is `{dotted.path: value|null}` and touches
    // only the paths it names; `text` replaces the document and is the only
    // thing that can repair a file which no longer parses. Exactly one of them.
    //
    // `stamp` is the precondition that makes this safe to offer at all: these
    // files are written by `claude` itself, so "the file I read" is a claim
    // worth checking rather than an assumption. It is required for a whole
    // collection and for a whole document, and deliberately not for one scalar.
    if (pathname === '/api/claude-config' && req.method === 'PUT') {
        const body = await readJson(req);
        const hasPatch = body.patch !== undefined;
        const hasText = body.text !== undefined;
        if (hasPatch === hasText) {
            return send(res, 400, {
                error: 'send exactly one of patch or text', code: 'body',
            });
        }
        let saved;
        try {
            const req_ = {
                scope: body.scope || 'user',
                dir: body.cwd || '',
                // Absent and null mean different things — "I am only setting a
                // scalar" and "this file should not exist" — so the distinction
                // has to survive the JSON.
                stamp: Object.prototype.hasOwnProperty.call(body, 'stamp') ? body.stamp : undefined,
            };
            saved = hasPatch
                ? claudeConfig.save({ ...req_, patch: body.patch })
                : claudeConfig.saveText({ ...req_, text: body.text });
        } catch (err) {
            return send(res, claudeConfigStatus(err.code), {
                error: err.message,
                code: err.code || 'save',
                // A conflict carries the file as it is now, so the page can say
                // what changed instead of only that something did.
                ...(err.detail || {}),
            });
        }
        // The fact of a change, not its content: nothing in this app behaves
        // differently because of these files, so a listening window only needs
        // to know it should re-read. Broadcasting the content would also push a
        // file this route classifies as local-only down every open channel.
        broadcast('claude-config', {
            at: Date.now(), scope: body.scope || 'user', file: saved.file,
        });
        // The same shape the GET returns, so a client can take the answer
        // wholesale rather than patching its own copy — and so the `ignored`
        // and `running` fields do not vanish from a page's state on a save.
        return send(res, 200, {
            file: saved.file,
            stamp: saved.stamp,
            config: await claudeConfigPayload(body.cwd || ''),
        });
    }

    // ── Claude Code's memory files ─────────────────────────────────────
    //
    // The first route in this bridge that reads or writes a whole file's
    // contents. Everything else here reads a file the app owns, or a directory
    // listing, or a JSON key; /api/fs lists and /api/fs/mkdir creates, and that
    // was the entire filesystem surface before this.
    //
    // So the conservative parts are load-bearing rather than ceremony: the
    // request names a `scope` and the bridge builds the path, so there is
    // nothing to traverse with; the read and the write share one size cap; a
    // symlink is refused rather than followed; and every write carries the
    // stamp of the file it was read from. Local callers only, both methods, for
    // the reason remoteRefusal() gives.
    //
    // `cwd` is passed through rather than validated here, exactly as
    // /api/claude-config does it: cfg.withinRoots inside the module drops the
    // project row, so a directory this bridge will not read degrades to the
    // user file alone rather than 403-ing a group that has a perfectly good
    // user scope to show. The write refuses it outright, which is where it
    // matters.
    //
    // `maxBytes` rides along so a page can label its byte counter with the real
    // cap instead of hardcoding one. A client that hardcoded it would go on
    // saying "of 256 KB" after the constant moved, which is the sort of drift
    // that is only ever found by somebody hitting the limit.
    if (pathname === '/api/claude-docs' && req.method === 'GET') {
        const read = claudeDocs.read(url.searchParams.get('cwd') || '');
        return send(res, 200, { ...read, maxBytes: MAX_DOC_BYTES });
    }

    // One body, unlike the route above: there is no partial write of a prose
    // file, so `text` is the only shape and `stamp` is never optional.
    if (pathname === '/api/claude-docs' && req.method === 'PUT') {
        const body = await readJson(req);
        let saved;
        try {
            saved = claudeDocs.save({
                scope: body.scope || 'user',
                dir: body.cwd || '',
                // Absent and null mean different things — "I forgot the
                // precondition" and "this file should not exist yet" — so the
                // distinction has to survive the JSON.
                stamp: Object.prototype.hasOwnProperty.call(body, 'stamp') ? body.stamp : undefined,
                text: body.text,
            });
        } catch (err) {
            return send(res, claudeDocsStatus(err.code), {
                error: err.message,
                code: err.code || 'save',
                // A conflict carries the file as it is now, so the page can show
                // what it would have overwritten instead of only that it did not.
                ...(err.detail || {}),
            });
        }
        // The fact of a change, not its content — the same trade the
        // claude-config event makes, and for the same two reasons: nothing in
        // this app behaves differently because of these files, and pushing the
        // contents of a file this route classifies as local-only down every open
        // channel would be a poor way to save a fetch.
        broadcast('claude-docs', {
            at: Date.now(), scope: body.scope || 'user', file: saved.file,
        });
        return send(res, 200, { ...saved, maxBytes: MAX_DOC_BYTES });
    }

    // ── The commands a project declares, as an editor sees them ─────────────
    //
    // Not /api/commands. That route answers "what buttons does this directory
    // have", merged into one list with every placeholder expanded, and it is
    // readable from a phone. This one answers "what does each file *say*",
    // which is a different question with a different audience: a control seeded
    // from the merged answer writes the merged answer back, and one that meant
    // to add a single local override ends up copying every shared command into
    // a personal file. bridge/claude-config.js hit that exact bug twice.
    //
    // Local callers only, both methods — see remoteRefusal() for why the read
    // is refused here where the merged one is not.
    if (pathname === '/api/commands-config' && req.method === 'GET') {
        const payload = await commandsConfigPayload(url.searchParams.get('cwd') || '');
        if (!payload) {
            return send(res, 403, { error: 'that directory is outside the allowed roots' });
        }
        return send(res, 200, payload);
    }

    // Two bodies, one route, in the shape PUT /api/claude-config uses.
    // `commands` replaces the array and is what the form sends; `text` replaces
    // the document and is the only thing that can repair a file which no longer
    // parses. Exactly one of them.
    //
    // `stamp` is required by both and `undefined` is a refusal, unlike
    // claude-config where a single scalar patch may omit it. There is no partial
    // write here — every save replaces the whole array — so there is no write
    // that a read immediately beforehand could make safe.
    //
    // `version` is deliberately not in the body. A client that could send
    // `version: 7` is a client that can write a file this bridge then refuses to
    // read, so the writer stamps it.
    if (pathname === '/api/commands-config' && req.method === 'PUT') {
        const body = await readJson(req);
        const hasCommands = body.commands !== undefined;
        const hasText = body.text !== undefined;
        if (hasCommands === hasText) {
            return send(res, 400, { error: 'send exactly one of commands or text', code: 'body' });
        }
        let saved;
        try {
            const req_ = {
                scope: body.scope || 'project',
                dir: body.cwd || '',
                // Absent and null mean different things — "I forgot the
                // precondition" and "this file should not exist yet" — so the
                // distinction has to survive the JSON.
                stamp: Object.prototype.hasOwnProperty.call(body, 'stamp') ? body.stamp : undefined,
            };
            saved = hasCommands
                ? commands.saveDoc({ ...req_, commands: body.commands })
                : commands.saveText({ ...req_, text: body.text });
        } catch (err) {
            return send(res, commandsConfigStatus(err.code), {
                error: err.message,
                code: err.code || 'save',
                // A conflict carries the file as it is now; an invalid document
                // carries a problem per row. Both let the page say what is wrong
                // rather than only that something is.
                ...(err.detail || {}),
            });
        }
        // The fact of a change, not its content — the trade claude-config and
        // claude-docs both make, and here with a second reason: the content
        // carries env values this route has just classified as local-only, and
        // /api/events reaches every open window including a paired phone.
        //
        // A window listening for this re-reads the settings group, and reloads
        // the header buttons when the directory it has open belongs to the
        // project that changed. Without that second half you rename a command
        // and the button keeps its old label until you switch sessions.
        broadcast('commands-config', {
            at: Date.now(), scope: body.scope || 'project',
            project: saved.project, file: saved.file,
        });
        // The same shape the GET returns, so a client can take the answer
        // wholesale rather than patching its own copy — which is what keeps
        // `ignored` and `merged` from vanishing from a page's state on a save.
        return send(res, 200, {
            file: saved.file,
            stamp: saved.stamp,
            config: await commandsConfigPayload(saved.project),
        });
    }

    // What may be rebound, and the closed set of key names a combo may end in.
    // The catalogue lives in bridge/keymap.js rather than in the page for the
    // reason its header gives: `keyboard.bindings` is keyed by command id, and
    // ids only the page knows are ids nobody else can discover.
    //
    // Not local-only — a list of command names is not a capability — and served
    // in a `tgx-keymap` <meta> tag as well, so the window's first keystroke does
    // not race a fetch.
    if (pathname === '/api/keymap' && req.method === 'GET') {
        return send(res, 200, keymap.payload());
    }

    // Which spinner verb groups exist, so the answer to "what may I put in
    // spinner.groups?" is reachable without listing a directory by hand — and
    // where a group that failed to load says why. This is what the settings
    // page draws its checkboxes from; it was built when there was no settings
    // page, and it is the reason there did not have to be a second route now.
    //
    // `?verbs=1` adds each group's verbs, sorted. Only the settings page asks:
    // it puts them in the tooltip on a group, which is the difference between
    // choosing a voice and guessing from a name. Off by default because it is
    // 3,639 strings across the catalogue and a caller that wanted counts should
    // not pay for them.
    //
    // Not local-only, for the same reason /api/prefs is not: the names and
    // contents of verb groups are not a capability worth refusing a phone.
    if (pathname === '/api/spinner/groups' && req.method === 'GET') {
        const cwd = url.searchParams.get('cwd') || '';
        const withVerbs = Boolean(url.searchParams.get('verbs'));
        const { groups: all, problems } = spinner.groups(cwd);
        const settings = prefs.forCwd(cwd).spinner;
        const pool = spinner.pool(cwd);
        // A weight and a share on every group, because the bridge is where the
        // draw is decided — a page that recomputed a share from the weights
        // would be a second implementation of the algorithm, and the two would
        // disagree the first time this one changed. `null` for a group that is
        // not in play: it has no share of anything, which is a different
        // statement from a share of zero.
        // Keyed by the normalised name, not the written one: a bucket is named
        // however the settings file spelled it, and `Tech_Programming` and
        // `Tech / Programming` are the same group.
        const shares = new Map(pool.buckets.map(b => [spinnerNorm(b.name), b]));
        const enabledNames = new Set(settings.groups.map(spinnerNorm));
        const groups = all.map(({ verbs, ...g }) => {
            const bucket = shares.get(spinnerNorm(g.name));
            const enabled = enabledNames.has(spinnerNorm(g.name));
            const weight = !enabled ? null : bucket ? bucket.weight : 0;
            return {
                ...g,
                weight,
                share: weight && pool.weight ? weight / pool.weight : enabled ? 0 : null,
                ...(withVerbs ? { verbs } : {}),
            };
        });
        return send(res, 200, {
            randomize: settings.randomize,
            rerollMs: settings.rerollMs,
            enabled: settings.groups,
            weights: settings.weights,
            // What the spinner will actually draw from, which is not the same
            // as `enabled` when a name in settings matches no file — or when a
            // group is enabled and weighed 0.
            pool: pool.verbs.length,
            groups,
            problems: [...problems, ...pool.problems],
        });
    }

    if (pathname === '/api/shutdown' && req.method === 'POST') {
        // Only honour a shutdown aimed at this exact process. Without it, an app
        // window closing could take down a bridge somebody else started — say one
        // running in a terminal for frontend work.
        const want = url.searchParams.get('pid');
        if (want && Number(want) !== process.pid) {
            return send(res, 409, { error: 'not the bridge you started', pid: process.pid });
        }
        if (pool.busyCount > 0) {
            return send(res, 409, { error: 'a turn is still running', busy: pool.busyCount });
        }
        send(res, 200, { ok: true });
        setTimeout(() => shutdown(0), 100);
        return;
    }

    // What a restart decided, for a client that watched one fail to happen.
    //
    // The journal is the point. A restart that refuses leaves this process alive,
    // so nothing drops, no pid changes and no event fires — the outcome is only
    // ever written to a file, and the bridge that can serve it is whichever one
    // is up now. See the note on bridge/restart.js's `journal`.
    if (pathname === '/api/restart' && req.method === 'GET') {
        return send(res, 200, {
            pid: process.pid, port: cfg.PORT, root: cfg.ROOT,
            worktree: cfg.IS_WORKTREE, busy: pool.busyCount, atRisk: pool.atRiskCount,
            journal: restart.journal(),
        });
    }

    if (pathname === '/api/restart' && req.method === 'POST') {
        // Fast-forward this bridge's own checkout and hand over to
        // scripts/restart-bridge.sh. Sibling of /api/shutdown above, and the
        // ?pid= guard is there for the same reason: a window can adopt a bridge
        // it did not start, and this one's blast radius is larger.
        const want = url.searchParams.get('pid');
        if (want && Number(want) !== process.pid) {
            return send(res, 409, { error: 'not the bridge you started', pid: process.pid });
        }
        if (handedOver) {
            return send(res, 409, { error: 'a restart is already running', pid: process.pid });
        }

        const body = await readJson(req).catch(() => ({}));
        // One meaning only: go ahead with turns in flight. It is the answer to
        // what the dialog asked, not a blanket override — the script is passed
        // --yes on every invocation regardless, because there is never a terminal
        // here to answer its dirty-bridge prompt at.
        const force = body.force === true;
        const wantPull = body.pull !== false;

        // What is in the way, asked twice: before the pull so a refusal never
        // leaves the checkout moved, and after it because the pull takes a moment
        // and may itself have landed the bridge/ change now being complained
        // about.
        //
        // Skipped outright when forcing rather than asked and ignored. That is
        // not only thrift: asking first and refusing anyway is what would make
        // Restart anyway unable to pull.
        const gate = async (sofar) => {
            if (force) return null;
            const found = [
                ...(sofar && !sofar.ok ? [{ kind: 'pull', text: sofar.error }] : []),
                ...await restart.blockers(cfg.ROOT, { busy: pool.atRiskCount }),
            ];
            return found.length ? found : null;
        };

        let problems = await gate(null);
        if (problems) return send(res, 409, { blocked: true, pulled: null, problems });

        const pulled = wantPull
            ? await restart.pull(cfg.ROOT)
            : { ok: true, skipped: true, out: '', error: null, before: null, after: null, changed: [] };

        problems = await gate(pulled);
        if (problems) return send(res, 409, { blocked: true, pulled, problems });

        // The pull may just have replaced the script — which is wanted — or moved
        // it. An ENOENT after the 200 below is unrecoverable: nothing restarts and
        // nothing is left to say so.
        if (!restart.scriptPresent()) {
            return send(res, 500, {
                error: `${restart.SCRIPT} is missing — nothing was restarted`, pulled,
            });
        }

        handedOver = true;
        let fired = false;
        const go = () => {
            if (fired) return;
            fired = true;
            try {
                restart.launch({ force });
            } catch (err) {
                // Nothing was killed, so this process is still the bridge — and a
                // one-way flag would leave the button dead with no way to say why.
                // The 200 has already gone out, so the log is the only place left
                // to put this; the caller finds out by watching pid never change.
                handedOver = false;
                console.error(`[tgxcode] restart: could not start ${restart.SCRIPT}:`,
                    err.message);
            }
        };
        // The script's first act is to SIGTERM this process, so it is not started
        // until the reply is on the socket. /api/shutdown above guesses at this
        // with a 100ms timer; here the event itself is available, and the reply is
        // the only thing that will ever tell the caller the restart began. The
        // timer is the fallback for a client that hung up mid-reply, where
        // 'finish' may never fire.
        res.once('finish', go);
        setTimeout(go, 500).unref();

        const where = {
            log: path.join(cfg.CACHE_DIR, `restart-${cfg.PORT}.out`),
            journal: path.join(cfg.CACHE_DIR, `restart-${cfg.PORT}.log`),
        };
        return send(res, 200, {
            ok: true,
            // Not "restarted": the process that could confirm that is the one
            // being replaced. A caller learns it worked by polling /api/health
            // until `pid` differs from the one below.
            restarting: true,
            pid: process.pid, port: cfg.PORT, force,
            pulled, reach: restart.reach(pulled.changed),
            // Neither is a blocker — both die with the bridge by design — but a
            // dialog should be able to say what is about to go with it.
            warnings: { terminals: terminals.live().length, runs: runs.live().length },
            // The replacement comes back setsid'd from the script, so a bridge
            // started by `npm run dev` is no longer the child of that terminal
            // and Ctrl-C there stops working. Said out loud so the UI can.
            detached: true,
            ...where,
        });
    }

    // --- notification history ---------------------------------------------
    if (pathname === '/api/notifications' && req.method === 'GET') {
        return send(res, 200, {
            // Counted over the whole log rather than over the page below it.
            // The badge used to be worked out client-side from whatever had been
            // fetched, so it quietly saturated at the fetch limit — a number
            // that stops being true when it gets large is worse than no number.
            unread: notifications.countUnread(r => reads.isRead(r), { includeTest: cfg.IS_DEV }),
            read: reads.get(),
            notifications: notifications.list({
                limit: Math.min(Number(url.searchParams.get('limit')) || 200, 1000),
                // 'notable' is the default view: the entries that cleared the bar
                // for interrupting somebody. 'all' also has the quiet ones — a
                // six-second turn, a subagent finishing — which nothing ever
                // notified about but which answer "what has been going on".
                scope: url.searchParams.get('scope') === 'all' ? 'all' : 'notable',
                type: url.searchParams.get('type') || null,
                sessionId: url.searchParams.get('sessionId') || null,
                // Same rule as /api/sessions: a scratch session belongs to the
                // instance that started it.
                includeTest: cfg.IS_DEV,
            // `read` is derived per caller rather than stored on the row: the
            // row is one thing that happened, and whether it is news is a
            // question about the reader. Stamped here so a client need not
            // reimplement the watermark comparison to render a list.
            }).map(row => ({ ...row, read: reads.isRead(row) })),
        });
    }

    if (pathname === '/api/notifications/read' && req.method === 'POST') {
        const body = await readJson(req);
        // `all` and a session id are two different gestures, not one with a flag:
        // opening History says "I have seen everything", opening a chat says "I
        // have seen this conversation". Neither is not a third gesture, so it is
        // refused rather than treated as a no-op — a client that meant to send
        // one and sent nothing should hear about it.
        const wantsAll = body.all === true || Number.isFinite(body.all);
        const sessionId = wantsAll ? null : String(body.sessionId || '');
        if (sessionId === '') {
            return send(res, 400, { error: 'send either {all:true} or {sessionId}' });
        }
        // `all` may name the instant instead of meaning "now", which is what a
        // client migrating an older watermark of its own needs — it knows when it
        // last looked and that is not now. Clamped, because a mark in the future
        // would silence everything filed between here and then, and no honest
        // caller wants that.
        const now = Date.now();
        const at = Number.isFinite(body.all) ? Math.min(Number(body.all), now) : now;
        // `moved` is whether the badge changed, not whether a timestamp did.
        // Every repeat of this call advances the watermark by however long it has
        // been, so a timestamp almost always moves and says nothing; a loud row
        // going from unread to read is the only thing another window would have
        // to repaint for. Every navigation in the UI comes through here, so the
        // difference is a broadcast per rail click against a broadcast per thing
        // actually dealt with.
        const count = () =>
            notifications.countUnread(r => reads.isRead(r), { includeTest: cfg.IS_DEV });
        const before = count();
        if (sessionId === null) reads.markAll(at);
        else reads.markSession(sessionId, at);
        const unread = count();
        const moved = unread !== before;
        if (moved) broadcast('notification-read', { sessionId, at, unread });
        return send(res, 200, { ok: true, moved, unread, read: reads.get() });
    }

    if (pathname === '/api/notifications' && req.method === 'DELETE') {
        notifications.clear();
        broadcast('notifications-cleared', { at: Date.now() });
        return send(res, 200, { ok: true });
    }

    // --- projects & sessions ----------------------------------------------
    if (pathname === '/api/projects' && req.method === 'GET') {
        return send(res, 200, { projects: index.projects() });
    }

    if (pathname === '/api/sessions' && req.method === 'GET') {
        const sessions = index.list({
            query: url.searchParams.get('q') || '',
            project: url.searchParams.get('project') || null,
            limit: Number(url.searchParams.get('limit')) || 500,
            // Scratch sessions an agent started to try something out belong to
            // the instance that started them, not to the window the user leaves
            // open with real work in it.
            includeTest: cfg.IS_DEV,
        });
        const statuses = pool.statuses();
        for (const s of sessions) {
            const st = statuses[s.sessionId];
            // `queued` rides along so the rail can say a session has work waiting
            // even while you are looking at a different one, and `detail` so a
            // row too narrow for the whole label can show the half that matters.
            if (st) {
                s.runner = { state: st.state, activity: st.activity,
                    detail: st.detail, queued: st.queued, claudeVersion: st.claudeVersion };
            }
        }
        return send(res, 200, { sessions, ready: index.ready });
    }

    // Who an agent could hand work to. Registered above /api/sessions/:id, or
    // "addressable" would be read as a session id.
    //
    // **The counterpart to /api/peers, and the difference is the whole point.**
    // That route answers "who can receive a message right now", which means live
    // processes with an inbox, because Claude Code's own peer transport needs
    // one. This answers "who could be *given* work", which is nearly everybody:
    // a handoff goes through `pool.ensure`, so an idle session is resumed rather
    // than unreachable. Since MAX_LIVE is 4 and a runner is evicted after
    // fifteen idle minutes, having no process is the normal state of a session
    // and this list is mostly sessions /api/peers cannot see at all.
    //
    // Archived sessions are left out. Filing one away is a statement that it is
    // done, and an agent trawling for somewhere to send work should not reopen
    // it. The route below does not re-check that: an id had to come from
    // somewhere, and refusing one the user named themselves would be worse.
    if (pathname === '/api/sessions/addressable' && req.method === 'GET') {
        const from = url.searchParams.get('from');
        const statuses = pool.statuses();
        const rows = [];
        for (const s of index.list({
            query: url.searchParams.get('q') || '',
            project: url.searchParams.get('project') || null,
            limit: 100_000,
            includeTest: cfg.IS_DEV,
        })) {
            if (s.archived) continue;
            rows.push({
                sessionId: s.sessionId,
                title: s.title,
                cwd: s.cwd,
                projectName: s.projectName,
                // The worktree's short name, not the whole `worktree` object the
                // summary carries — this is a label a model prints in a line, and
                // the rest of that object is about paths it has no use for.
                branch: (s.worktree && s.worktree.name) || s.gitBranch || null,
                lastActive: s.lastTs || null,
                // idle | working | elsewhere — what a handoff would run into, and
                // three answers rather than the taskboard's two. See handoff.js.
                state: handoffState(s, statuses[s.sessionId] || null),
                self: !!from && s.sessionId === from,
            });
        }
        return send(res, 200, {
            sessions: rows.slice(0, limitOf(url, 30, 200)),
            ready: index.ready,
        });
    }

    // Every suggested follow-up, across every session.
    //
    // Until this existed a task was a tool call in one transcript and so was
    // discoverable only while that conversation was open. The offers are now
    // collected by the rescan that already reads every transcript, and the
    // decision beside each one comes off the store it has always lived in.
    //
    // **The offers stay derived.** Nothing here is copied into state this app
    // owns, so deleting a session removes its tasks along with its transcript —
    // see docs/api.md for what that means and why it was chosen.
    // POST /api/suggestions/:sessionId/:toolUseId/start — take a task up as a
    // session of its own.
    //
    // **One call, not the two the web client makes.** `startSuggestion` in
    // web/app.js creates the session and then records the decision, and if the
    // second call fails the task stays offered beside the session that is already
    // doing it. That is survivable when you are looking at the card. It is not for
    // an unattended agent working down a list, which would read "open" and start
    // it again — so here the order is the answer, the argument `fromDraft` makes
    // on `POST /api/sessions`.
    //
    // **Refused unless it is open**, with the status and the session that has it.
    // That refusal is the whole guard against a scheduled run starting a task a
    // second time; undoing a decision first (`status: null` on the per-session
    // route) is how you say you really mean it.
    //
    // `extra` is appended under a rule rather than woven in, so the task as
    // filed is still recognisable at the top of the new session's first message.
    if (seg[1] === 'suggestions' && seg[2] && seg[3] && seg[4] === 'start' && !seg[5]
        && req.method === 'POST') {
        const sourceId = seg[2];
        const toolUseId = seg[3];
        const body = await readJson(req);
        let task = index.listSuggestions({ session: sourceId, includeTest: true })
            .find(t => t.id === toolUseId);
        // A task filed a moment ago is on screen before the index has rescanned
        // the transcript it is in. The web client sends the prompt it is showing
        // so that Start on a fresh card is not a 404; the decision store is still
        // asked, below, whether it is taken.
        if (!task && typeof body.prompt === 'string' && body.prompt.trim()
            && index.summary(sourceId)) {
            const decision = suggestions.forSession(sourceId)[toolUseId] || null;
            task = {
                id: toolUseId, sessionId: sourceId, prompt: body.prompt.trim(),
                title: null, why: null, cwd: null,
                status: decision ? decision.status : 'open',
                startedId: decision ? decision.startedId : null,
                session: { test: flags.get(sourceId).test, projectCwd: null },
            };
        }
        if (!task) return send(res, 404, { error: 'no such task' });
        if (task.status !== 'open') {
            return send(res, 409, {
                error: `that task is already ${task.status}`
                    + (task.startedId ? ` (session ${task.startedId})` : ''),
                status: task.status,
                startedId: task.startedId,
            });
        }

        const cwd = body.cwd ? String(body.cwd) : (task.cwd || task.session.projectCwd);
        try {
            resolveWorkdir(cwd);
        } catch (err) {
            return send(res, 400, { error: err.message });
        }
        // Plan unless asked otherwise, which is what the card's Start button
        // does: a task was written by somebody else's agent, and reading it
        // before editing anything is the cheap default.
        const mode = normalizeMode(body.permissionMode || 'plan');
        const refusal = modeRefusal(mode, who);
        if (refusal) return send(res, 403, { error: refusal, remote: true });
        if (tooManyCreates()) {
            return send(res, 429, {
                error: `more than ${CREATE_LIMIT.max} sessions started in a minute — `
                    + 'slow down, or start the rest from the machine itself',
            });
        }

        const extra = typeof body.extra === 'string' ? body.extra.trim() : '';
        const prompt = extra ? `${task.prompt}\n\n---\n\n${extra}` : task.prompt;
        let out;
        try {
            out = pool.create({ cwd, prompt, model: body.model || null, permissionMode: mode });
        } catch (err) {
            return send(res, 400, { error: err.message });
        }
        const test = !!(task.session.test || body.test);
        if (test) flags.set(out.sessionId, { test: true });
        index.note(out.sessionId);
        const decision = suggestions.set(sourceId, toolUseId, {
            status: 'started', startedId: out.sessionId, via: 'session',
        });
        broadcast('suggestion-changed', { at: Date.now(), sessionId: sourceId, toolUseId });
        return send(res, 200, {
            ...out, test, task: { ...task, ...decision, status: 'started' },
        });
    }

    if (pathname === '/api/suggestions' && req.method === 'GET') {
        const status = url.searchParams.get('status');
        if (status) {
            const bad = status.split(',').map(v => v.trim()).filter(Boolean)
                .filter(v => !SUGGESTION_STATES.has(v));
            if (bad.length) {
                return send(res, 400, {
                    error: `unknown status ${bad.join(', ')}; `
                        + `expected ${[...SUGGESTION_STATES].join(', ')}`,
                });
            }
        }
        return send(res, 200, {
            suggestions: index.listSuggestions({
                session: url.searchParams.get('session') || null,
                project: url.searchParams.get('project') || null,
                status: status || null,
                q: url.searchParams.get('q') || null,
                limit: Number(url.searchParams.get('limit')) || 500,
                // Same rule as /api/sessions: a scratch session belongs to the
                // instance that started it.
                includeTest: cfg.IS_DEV,
            }),
            ready: index.ready,
        });
    }

    // Who an agent in this session could send a message to.
    //
    // Claude Code gives every live session a name and an inbox, and agents
    // address each other by that name — `SendMessage({to: "<name>"})`, with no
    // other form of address. This route is the list of names that are real,
    // which is what the composer's `@` picker offers.
    //
    // Read out of the registry rather than out of the session index, because
    // they answer different questions. The index knows about transcripts, and
    // filters some of them out — test sessions on the everyday bridge, anything
    // under /tmp. The registry knows about *processes*, and a background agent
    // with no indexed transcript is still perfectly able to receive a message.
    // Titles are joined on from the index where there is one; a peer without one
    // is still listed, because being unnamed here does not make it unreachable.
    if (pathname === '/api/peers' && req.method === 'GET') {
        return send(res, 200, { peers: listPeers(), at: Date.now() });
    }

    // Every live session at once: what it is doing, how far through its tasks it
    // is, and what it is blocked on. State rather than content, which is what
    // makes one payload enough for a screenful of sessions — see overview.js.
    // Pollable by anything; the UI takes it over SSE instead.
    if (pathname === '/api/overview' && req.method === 'GET') {
        return send(res, 200, buildBoard());
    }

    // Everything outstanding at once: open suggested tasks beside every
    // un-archived session, grouped by what state it is in. Derived from what is
    // already in memory and reads no transcripts — see taskboard.js.
    //
    // `?idle=all` drops the recent window on the idle column and returns every
    // un-archived session. Only ever answered here, never pushed: it is what the
    // Show-all button asks for once, and the rows it brings back are idle by
    // definition.
    if (pathname === '/api/taskboard' && req.method === 'GET') {
        return send(res, 200, taskboard.build(index, pool, {
            includeTest: cfg.IS_DEV,
            idle: url.searchParams.get('idle') === 'all' ? 'all' : 'recent',
        }));
    }

    // ── drafts ───────────────────────────────────────────────────────────
    //
    // A session set up but not started. Everything `POST /api/sessions` takes,
    // held in a file until you press Start — see bridge/drafts.js.
    //
    // All five in one block rather than split between the reading and writing
    // halves of this file: it is a small, self-contained surface and the write
    // routes are only interesting next to the read one.
    if (seg[1] === 'drafts') {
        if (!seg[2] && req.method === 'GET') {
            return send(res, 200, draftsPayload());
        }

        if (!seg[2] && req.method === 'POST') {
            const body = await readJson(req);
            const v = draftFields(body, who, { partial: false });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }
            const draft = drafts.create(v.fields);
            // The store says no by returning null rather than by throwing, so
            // the cap is a 409 and not a 500.
            if (!draft) {
                return send(res, 409, {
                    error: `there are already ${MAX_DRAFTS} drafts — start or delete `
                        + 'some before saving another',
                });
            }
            broadcast('drafts-changed', draftsPayload());
            return send(res, 200, { draft: draftOut(draft) });
        }

        if (seg[2] && !seg[3] && req.method === 'PATCH') {
            const body = await readJson(req);
            // Validated *before* the draft is looked up, so a refused mode is a
            // 403 whether or not the id exists. That is the order
            // `POST /api/sessions/:id/send` uses and the reason is the same: the
            // refusal is about what this caller may ask for, not about what it
            // aimed at, so it must not depend on the target being real. Checking
            // existence first made a phone's attempt to escalate an unknown draft
            // a 404, which reads as "wrong id" rather than "not allowed".
            const v = draftFields(body, who, { partial: true });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }
            const draft = drafts.update(seg[2], v.fields);
            if (!draft) return send(res, 404, { error: 'draft not found' });
            broadcast('drafts-changed', draftsPayload());
            return send(res, 200, { draft: draftOut(draft) });
        }

        if (seg[2] && !seg[3] && req.method === 'DELETE') {
            if (!drafts.remove(seg[2])) return send(res, 404, { error: 'draft not found' });
            broadcast('drafts-changed', draftsPayload());
            return send(res, 200, { ok: true, id: seg[2] });
        }

        // Start it, and only then forget it.
        //
        // A server route rather than the client doing create-then-delete,
        // because there are three clients of this API and one of them cannot
        // read this code — the sequence below is not something each should have
        // to get right. It is deliberately the same sequence `POST /api/sessions`
        // runs, including the rate limit, because it *is* that route with its
        // arguments read off a file.
        if (seg[2] && seg[3] === 'start' && req.method === 'POST') {
            const draft = drafts.get(seg[2]);
            if (!draft) return send(res, 404, { error: 'draft not found' });

            // Re-checked at the moment of spawning, not trusted from write time.
            // The roots are configuration and the mode is the caller's: a draft
            // saved locally must not become a way for a phone to start
            // bypassPermissions, and a directory can be moved after it is saved.
            // Normalised on the way out as well as on the way in. The draft was
            // written through `draftFields`, so its mode is already one of the
            // six — but this file is hand-editable and a draft outlives the
            // process that wrote it, so the value reaching `--permission-mode`
            // should not be taken on trust from JSON on disk.
            const mode = normalizeMode(draft.permissionMode);
            const refusal = modeRefusal(mode, who);
            if (refusal) return send(res, 403, { error: refusal, remote: true });

            if (tooManyCreates()) {
                return send(res, 429, {
                    error: `more than ${CREATE_LIMIT.max} sessions started in a minute — `
                        + 'slow down, or start the rest from the machine itself',
                });
            }

            let out;
            try {
                out = pool.create({
                    cwd: draft.cwd,
                    prompt: draft.prompt,
                    model: draft.model,
                    permissionMode: mode,
                });
            } catch (err) {
                // The draft is still there, which is the point of doing this in
                // this order: a directory that has been moved since you saved it
                // should cost you the press, not the message you wrote.
                return send(res, 400, { error: err.message });
            }

            if (draft.test) flags.set(out.sessionId, { test: true });
            index.note(out.sessionId);
            drafts.remove(seg[2]);
            broadcast('drafts-changed', draftsPayload());
            return send(res, 200, { ...out, test: !!draft.test });
        }
    }

    // ── messages on a clock ──────────────────────────────────────────────
    //
    // A send held back until a time you picked — see bridge/later.js. Written
    // against a session, which is why the create lives on
    // `POST /api/sessions/:id/later`; everything afterwards is about one message
    // and needs no session in the path.
    //
    // All four in one block, beside drafts and for the reason that block gives.
    if (seg[1] === 'later') {
        if (!seg[2] && req.method === 'GET') {
            return send(res, 200, laterPayload());
        }

        if (seg[2] && !seg[3] && req.method === 'PATCH') {
            const body = await readJson(req);
            // Validated before the message is looked up, the order the drafts PATCH
            // uses and for the reason it gives: the refusal is about what this
            // caller may ask for, not about what it aimed at.
            const v = laterFields(body, who, { partial: true });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }
            const out = later.update(seg[2], v.fields);
            if (!out) return send(res, 404, { error: 'no scheduled message with that id' });
            // Already handed to a process, or already past. Editing it now would be
            // editing the past, and the store refuses rather than pretending.
            if (out.conflict) {
                return send(res, 409, {
                    error: `that message is ${out.conflict} — it cannot be changed now`,
                });
            }
            broadcast('later-changed', laterPayload());
            return send(res, 200, { message: laterOut(out) });
        }

        if (seg[2] && !seg[3] && req.method === 'DELETE') {
            if (!later.remove(seg[2])) {
                return send(res, 404, { error: 'no scheduled message with that id' });
            }
            broadcast('later-changed', laterPayload());
            return send(res, 200, { ok: true, id: seg[2] });
        }

        // Deliver it now, whatever its clock says.
        //
        // The same function the tick calls, for the reason
        // `POST /api/schedules/:id/run` is: "the button delivers what the clock
        // delivers" is only true if there is one path. That includes the
        // wait-for-idle rule — pressing this must not end a turn either.
        if (seg[2] && seg[3] === 'send' && req.method === 'POST') {
            const row = later.get(seg[2]);
            if (!row) return send(res, 404, { error: 'no scheduled message with that id' });
            if (row.state !== 'pending') {
                return send(res, 409, {
                    error: `that message is ${row.state} — it has already been dealt with`,
                });
            }
            // Re-checked here and not only at write time: the file is hand-editable
            // and outlives the process that wrote it, and a message saved at the
            // machine must not become a way for a phone to send bypassPermissions.
            const refusal = modeRefusal(normalizeMode(row.permissionMode), who);
            if (refusal) return send(res, 403, { error: refusal, remote: true });

            if (!later.claim(seg[2])) {
                return send(res, 409, { error: 'a tick is already delivering that message' });
            }
            let out;
            try {
                out = await deliverLater(row);
            } catch (err) {
                out = { ok: false, error: err.message };
            }
            if (out.ok) {
                later.note(seg[2], { state: 'sent', sentAt: Date.now() });
            } else if (out.retry) {
                later.release(seg[2]);
            } else {
                later.note(seg[2], { state: 'failed', error: out.error });
            }
            broadcast('later-changed', laterPayload());
            if (!out.ok) {
                // 409 for the two retryable refusals — the message is untouched and
                // pressing again later is the right thing to do — and 502 for a
                // delivery that was attempted and did not land.
                return send(res, out.retry ? 409 : 502, { error: out.error });
            }
            return send(res, 200, {
                ok: true, message: laterOut(later.get(seg[2])),
                status: out.status, queued: out.queued, woke: out.woke,
            });
        }
    }

    // ── snippets ─────────────────────────────────────────────────────────
    //
    // Canned messages: a title, a body, what to ask before sending it and where
    // it lands in the compose box — see bridge/snippets.js. What replaced the one
    // hard-coded LGTM button.
    //
    // All eight in one block, beside drafts and for the reason that block gives.
    //
    // **`reorder` is matched before the `:id` branches**, and the order of these
    // `if`s is load-bearing rather than stylistic: a snippet id is a UUID or a
    // `seed-` string so a real collision is impossible, but a `POST` to
    // `/api/snippets/reorder` reaching the id branches instead would be a silent
    // miss rather than an error. Groups live at `/api/snippet-groups` rather than
    // under this prefix precisely so there is only one reserved word to remember.
    if (seg[1] === 'snippets') {
        if (!seg[2] && req.method === 'GET') {
            const cwd = url.searchParams.get('cwd');
            if (!cwd) return send(res, 200, snippetsPayload());
            // The filter is offered so a client need not implement the prefix rule
            // itself. The counts stay whole on purpose: a popover that says "2 more
            // here" needs both numbers, and a snippet you cannot find because you
            // are in the wrong directory is otherwise indistinguishable from one
            // you deleted.
            const all = snippetsPayload();
            return send(res, 200, {
                ...all,
                snippets: snippetStore.list({ cwd: cfg.expandHome(cwd) }).map(snippetOut),
            });
        }

        if (!seg[2] && req.method === 'POST') {
            const body = await readJson(req);
            const v = snippetFields(body, who, { partial: false });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }
            const snippet = snippetStore.create(v.fields);
            // The store says no by returning null rather than by throwing, so the
            // cap is a 409 and not a 500.
            if (!snippet) {
                return send(res, 409, {
                    error: `there are already ${MAX_SNIPPETS} snippets — delete some `
                        + 'before saving another',
                });
            }
            broadcast('snippets-changed', snippetsPayload());
            return send(res, 200, { snippet: snippetOut(snippet) });
        }

        // The whole arrangement in one call. A drag knows the final order and so
        // does an up arrow, and a swap done as two PATCHes has an instant in the
        // middle where both rows hold the same number and two events go out.
        if (seg[2] === 'reorder' && !seg[3] && req.method === 'POST') {
            const body = await readJson(req);
            for (const key of ['snippets', 'groups']) {
                if (body[key] === undefined) continue;
                if (!Array.isArray(body[key]) || body[key].some(id => typeof id !== 'string')) {
                    return send(res, 400, { error: `${key} must be an array of ids` });
                }
            }
            const moved = snippetStore.reorder(body);
            // Nothing moved is not an error and not worth a push: a drag that lands
            // where it started is a no-op all the way down.
            if (moved.snippets || moved.groups) {
                broadcast('snippets-changed', snippetsPayload());
            }
            return send(res, 200, snippetsPayload());
        }

        if (seg[2] && !seg[3] && req.method === 'PATCH') {
            const body = await readJson(req);
            // Validated *before* the snippet is looked up, so a refused mode is a
            // 403 whether or not the id exists — the order the drafts PATCH uses,
            // and the reason is the same: the refusal is about what this caller
            // may ask for, not about what it aimed at.
            const v = snippetFields(body, who, { partial: true });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }
            const snippet = snippetStore.update(seg[2], v.fields);
            if (!snippet) return send(res, 404, { error: 'snippet not found' });
            broadcast('snippets-changed', snippetsPayload());
            return send(res, 200, { snippet: snippetOut(snippet) });
        }

        if (seg[2] && !seg[3] && req.method === 'DELETE') {
            if (!snippetStore.remove(seg[2])) {
                return send(res, 404, { error: 'snippet not found' });
            }
            broadcast('snippets-changed', snippetsPayload());
            return send(res, 200, { ok: true, id: seg[2] });
        }
    }

    // ── snippet groups ───────────────────────────────────────────────────
    //
    // A heading and an accent colour for the snippets drawn under it. Its own
    // prefix rather than `/api/snippets/groups`, so that `reorder` above is the
    // only reserved word in that path and `groups` cannot be mistaken for an id.
    //
    // There is no `GET`: a group is only ever read as part of the snippet list,
    // and a route returning half the popover's data would be one more thing for a
    // client to keep in step.
    if (seg[1] === 'snippet-groups') {
        if (!seg[2] && req.method === 'POST') {
            const body = await readJson(req);
            const v = snippetGroupFields(body, { partial: false });
            if (v.error) return send(res, v.status, { error: v.error });
            const group = snippetStore.createGroup(v.fields);
            if (!group) {
                return send(res, 409, {
                    error: `there are already ${MAX_GROUPS} snippet groups — delete some `
                        + 'before making another',
                });
            }
            broadcast('snippets-changed', snippetsPayload());
            return send(res, 200, { group });
        }

        if (seg[2] && !seg[3] && req.method === 'PATCH') {
            const body = await readJson(req);
            const v = snippetGroupFields(body, { partial: true });
            if (v.error) return send(res, v.status, { error: v.error });
            const group = snippetStore.updateGroup(seg[2], v.fields);
            if (!group) return send(res, 404, { error: 'snippet group not found' });
            broadcast('snippets-changed', snippetsPayload());
            return send(res, 200, { group });
        }

        // Deleting a heading does not delete what was written under it. The
        // snippets come loose and keep their `groupId`, so recreating a group with
        // the same id puts them back — and so that one bridge is not rewriting
        // rows on the strength of a deletion another has not seen. `orphaned` is
        // how many moved, so the UI can say so rather than leaving somebody to
        // notice.
        if (seg[2] && !seg[3] && req.method === 'DELETE') {
            const out = snippetStore.removeGroup(seg[2]);
            if (!out) return send(res, 404, { error: 'snippet group not found' });
            broadcast('snippets-changed', snippetsPayload());
            return send(res, 200, { ok: true, id: seg[2], orphaned: out.orphaned });
        }
    }

    // ── schedules ────────────────────────────────────────────────────────
    //
    // A session that starts on a clock: everything `POST /api/sessions` takes,
    // plus a cron expression and a gate — see bridge/schedule.js.
    //
    // All five in one block, beside drafts and for the same reason: it is a
    // small self-contained surface, and the write routes are only interesting
    // next to the read one.
    if (seg[1] === 'schedules') {
        if (!seg[2] && req.method === 'GET') {
            return send(res, 200, schedulesPayload());
        }

        // What an expression means, without saving anything.
        //
        // The dialog shows "Tue–Sat at 2:00 AM" under the box as you type, and
        // this is where that sentence comes from. A second cron parser in the page
        // could only ever be a way for the page and the bridge to disagree about
        // when a schedule runs — so the process that will actually run it is the
        // one asked. A GET because it changes nothing; before this route existed
        // the page had to attempt a create to find out whether it had typed
        // something valid.
        if (seg[2] === 'describe' && !seg[3] && req.method === 'GET') {
            const text = url.searchParams.get('cron') || '';
            const spec = parseCron(text);
            if (spec.error) return send(res, 400, { error: spec.error });
            const next = nextSlot(spec, Date.now());
            // `once` because the dialog is asking what it is about to save, and a
            // dated expression means two different things with the flag and
            // without it. Read off the query rather than guessed from the shape.
            const once = url.searchParams.get('once') === '1';
            return send(res, 200, {
                cron: spec.text,
                text: describeCron(spec, { once }),
                // The controls that would produce this expression, so a client
                // that has one can select the right row without parsing it.
                form: cronForm(spec),
                // Null is a real answer — `0 0 30 2 *` parses and never matches —
                // and one the dialog says out loud rather than leaving blank.
                next,
            });
        }

        if (!seg[2] && req.method === 'POST') {
            let body = await readJson(req);
            // **Who asked, when it was a session.** `from` is what the agent
            // tools send (bridge/mcp.js), and it does three things. It is
            // recorded, so the card can say which conversation an unattended run
            // came from. It stands in for a missing `cwd` — the project the
            // session belongs to, not a worktree it may since have removed. And a
            // test session's schedule is a test schedule: a probe run from a dev
            // bridge must not leave a row the everyday bridge will fire, and the
            // agent making it cannot be relied on to say so.
            const fromSession = typeof body.from === 'string' && body.from.trim()
                ? body.from.trim() : null;
            const src = fromSession ? index.summary(fromSession) : null;
            if (src && !body.cwd) body = { ...body, cwd: src.projectCwd || src.cwd };
            const v = scheduleFields(body, who, { partial: false });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }

            // **Seed the marker before storing, not on the first run.** A gated
            // schedule whose marker starts empty would review the entire history
            // of the repository the first time it fired. Resolving the ref now
            // means the first run covers what arrives after you set it up, which
            // is what "since the prior run" means when there is no prior run.
            //
            // A ref that cannot be resolved is refused rather than seeded empty:
            // a typo'd `orgin/main` should cost you the save, not a month of
            // silent "nothing new".
            if (v.fields.gate && v.fields.gate.kind === 'git-commits') {
                const seed = await git.commitRange(v.fields.cwd, v.fields.gate.ref, null,
                    { fetch: v.fields.gate.fetch });
                if (!seed.ok) {
                    return send(res, 400, {
                        error: seed.error || `cannot resolve ${v.fields.gate.ref}`,
                    });
                }
                v.fields.lastMarker = seed.head;
            }

            // The same seeding for a PR gate, and it matters more: without it,
            // pressing Save starts a review session for every pull request already
            // open — five of them, on a machine where that is a normal number.
            // `seed: "all"` is how you ask for exactly that.
            if (v.fields.gate && v.fields.gate.kind === 'open-prs') {
                const repo = await pulls.repoOf(v.fields.cwd);
                if (!repo) {
                    return send(res, 400, {
                        error: `${v.fields.cwd} has no GitHub origin, so it has no `
                            + 'pull requests to watch',
                    });
                }
                // Asked now rather than read from the store: this is a press, and
                // seeding a reviewed map against a twenty-minute-old list would
                // quietly mark a PR raised since then as already reviewed.
                // `refreshRepo` folds the answer in, so the next tick inherits it.
                await prStore.refreshRepo(repo);
                const list = prStore.openPulls(repo);
                if (!list.ok) {
                    // Refused rather than seeded empty, for the reason a bad ref is
                    // refused: a schedule that cannot see the repository is one that
                    // will report "nothing new" every night and never say why.
                    return send(res, 400, {
                        error: list.error || `cannot list pull requests for ${repo}`,
                    });
                }
                if (String(body.seed || 'skip') !== 'all') {
                    const reviewed = {};
                    for (const pr of list.pulls) {
                        if (!pr.headSha) continue;
                        reviewed[reviewKey(repo, pr.number)] = {
                            sha: pr.headSha, at: Date.now(),
                            sessionId: null, outcome: null, posted: 'seeded', postError: null,
                        };
                    }
                    v.fields.reviewed = reviewed;
                }
            }

            if (fromSession) {
                v.fields.createdBy = {
                    sessionId: fromSession,
                    title: src ? (src.title || null) : null,
                };
                if (flags.get(fromSession).test) v.fields.test = true;
            }

            const row = schedules.create(v.fields);
            if (!row) {
                return send(res, 409, {
                    error: `there are already ${MAX_SCHEDULES} schedules — delete `
                        + 'some before adding another',
                });
            }

            // **The draft this schedule was converted from, consumed here rather
            // than by the client.**
            //
            // `POST /api/drafts/:id/start` makes the argument and this is the same
            // shape of it: a client doing this as two calls has to decide for
            // itself what happens when the second one fails, and there are three
            // clients to decide it three ways. Done here, the order is the answer
            // — the draft is the copy of this work that still exists if the save
            // above throws, so it goes last and only on success.
            //
            // Deliberately *not* stored on the row. `clean()` in schedule.js is a
            // whitelist another bridge would strip the field back out of within a
            // tick (docs/plans/15-scheduling.md), and nothing after this moment
            // has a use for it: the draft is gone.
            //
            // An id that names nothing is not an error. The schedule saved, which
            // is what was asked for; the draft was already deleted, or belonged to
            // a bridge with a different store.
            const from = typeof body.fromDraft === 'string' ? body.fromDraft : null;
            if (from && drafts.remove(from)) broadcast('drafts-changed', draftsPayload());

            broadcast('schedules-changed', schedulesPayload());
            return send(res, 200, { schedule: scheduleOut(row) });
        }

        if (seg[2] && !seg[3] && req.method === 'PATCH') {
            const body = await readJson(req);
            // Validated *before* the schedule is looked up, so a refused mode is
            // a 403 whether or not the id exists — the order
            // `POST /api/drafts/:id` uses, and for the reason given there: the
            // refusal is about what this caller may ask for, not about what it
            // aimed at.
            const v = scheduleFields(body, who, { partial: true });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }

            const before = schedules.get(seg[2]);
            if (!before) return send(res, 404, { error: 'schedule not found' });

            // **The mode already on the row is refused too, not just one in the
            // body.** Checking only what was sent leaves a real hole here that
            // the same check does not leave on a draft: a phone cannot *write*
            // `dontAsk`, but it could send `{enabled: true}` to a paused schedule
            // that already had it, and the local tick would then start an
            // unattended agent with no permission gate. A draft escapes this
            // because the second gate is somebody pressing Start, who is checked
            // in turn; a schedule's second gate is a timer, which is always local.
            //
            // So a remote caller may not touch a schedule it would not be allowed
            // to create. After the lookup rather than before, unavoidably — this
            // one is about the stored row — while the body check above stays
            // first, so "you may not ask for that mode" is still a 403 whether or
            // not the id is real.
            const effective = normalizeMode(
                v.fields.permissionMode !== undefined
                    ? v.fields.permissionMode : before.permissionMode);
            const refusal = modeRefusal(effective, who);
            if (refusal) return send(res, 403, { error: refusal, remote: true });

            // **Repointing the gate, or the checkout, invalidates the marker**, so
            // it has to be reseeded: the stored SHA is on the old ref, and against
            // the new one it is either an ancestor nothing has landed after —
            // "nothing new" forever, a schedule that silently stops reviewing — or
            // a commit on a diverged history, which makes `{{range}}` enormous.
            //
            // Resolved *before* the update, not after. Doing it after means a ref
            // that turns out not to exist leaves the row already edited, pointing
            // somewhere unresolvable, with a marker from the old ref — a 400 that
            // changed something. This way the refusal costs the edit and nothing
            // else, which is the same bargain `POST /api/schedules` strikes.
            const cwd = v.fields.cwd !== undefined ? v.fields.cwd : before.cwd;
            const gate = v.fields.gate !== undefined ? v.fields.gate : before.gate;
            const kind = gate ? gate.kind : null;
            const wasKind = before.gate ? before.gate.kind : null;
            const movedCwd = cwd !== before.cwd;

            let marker = null;
            let reseeded = null;

            // **Branch on the kind, which the first version did not.** It reached
            // for `gate.ref` whatever the gate was, so switching an existing
            // schedule to `open-prs` — which has no ref — called `commitRange` with
            // `undefined` and answered 400 "cannot resolve undefined". The edit
            // dialog could offer that gate and never save it.
            if (kind === 'git-commits'
                && (movedCwd || wasKind !== 'git-commits' || before.gate.ref !== gate.ref)) {
                // Repointing invalidates the marker: it is a SHA on the old ref, and
                // against the new one it is either an ancestor nothing has landed
                // after — "nothing new" forever — or a commit on a diverged history,
                // which makes `{{range}}` enormous. Resolved before the update so a
                // ref that turns out not to exist costs the edit and nothing else.
                const seed = await git.commitRange(cwd, gate.ref, null,
                    { fetch: gate.fetch });
                if (!seed.ok) {
                    return send(res, 400, {
                        error: seed.error || `cannot resolve ${gate.ref}`,
                    });
                }
                marker = seed.head;
            }

            // Becoming a PR gate, or pointing at a different checkout, means the
            // reviewed map describes the wrong repository. Reseeded for the reason
            // the create route seeds: otherwise saving the edit reviews everything
            // already open.
            if (kind === 'open-prs' && (movedCwd || wasKind !== 'open-prs')) {
                const repo = await pulls.repoOf(cwd);
                if (!repo) {
                    return send(res, 400, {
                        error: `${cwd} has no GitHub origin, so it has no pull `
                            + 'requests to watch',
                    });
                }
                // Asked now, not read from the store — see the create route.
                await prStore.refreshRepo(repo);
                const list = prStore.openPulls(repo);
                if (!list.ok) {
                    return send(res, 400, {
                        error: list.error || `cannot list pull requests for ${repo}`,
                    });
                }
                reseeded = {};
                if (String(body.seed || 'skip') !== 'all') {
                    for (const pr of list.pulls) {
                        if (!pr.headSha) continue;
                        reseeded[reviewKey(repo, pr.number)] = {
                            sha: pr.headSha, at: Date.now(),
                            sessionId: null, outcome: null, posted: 'seeded',
                            postError: null,
                        };
                    }
                }
            }

            const row = schedules.update(seg[2], v.fields);
            if (!row) return send(res, 404, { error: 'schedule not found' });
            if (marker) schedules.note(seg[2], { marker });
            if (reseeded) schedules.setReviewed(seg[2], reseeded);
            // A window belongs to the gate that opened it. Leaving one open across a
            // change of kind meant the drain pass skipped it on the kind guard and
            // nothing ever closed it, so the row carried a stale `sweepUntil`
            // indefinitely.
            if (kind !== wasKind && before.sweepUntil) schedules.closeSweep(seg[2]);

            broadcast('schedules-changed', schedulesPayload());
            return send(res, 200, { schedule: scheduleOut(schedules.get(seg[2])) });
        }

        if (seg[2] && !seg[3] && req.method === 'DELETE') {
            if (!schedules.remove(seg[2])) {
                return send(res, 404, { error: 'schedule not found' });
            }
            broadcast('schedules-changed', schedulesPayload());
            return send(res, 200, { ok: true, id: seg[2] });
        }

        // Run it now, whatever the clock says.
        //
        // The same function the tick calls, which is the point — a run produced
        // by this button has to be identical to one produced by the schedule, and
        // one code path is the only way to be sure. It skips the gate (you
        // pressed the button, so something should happen even with no new
        // commits) and it does not touch `lastSlotAt`, so tonight's scheduled run
        // still happens. It does *not* skip the mode refusal or the rate limit.
        if (seg[2] && seg[3] === 'run' && req.method === 'POST') {
            const row = schedules.get(seg[2]);
            if (!row) return send(res, 404, { error: 'schedule not found' });

            const fired = await fireSchedule(row, { force: true, who });

            if (!fired.started.length) {
                const first = fired.skipped[0]
                    || { reason: 'nothing-new', error: fired.gateError };
                schedules.note(row.id, { skipReason: first.reason, error: first.error || null });
                broadcast('schedules-changed', schedulesPayload());
                // The refusal a remote caller gets is a 403 and says so; a
                // rate limit is a 429; everything else is the directory or the
                // ref, which is a 400 about the request.
                const status = first.reason === 'rate-limited' ? 429
                    : (modeRefusal(normalizeMode(row.permissionMode), who) ? 403 : 400);
                return send(res, status, status === 403
                    ? { error: first.error, remote: true }
                    : { error: first.error || 'nothing to review' });
            }

            // A manual run advances the marker exactly as a scheduled one does.
            // Not doing so would mean pressing Run now caused tonight to review
            // the same commits over again. For a PR gate the per-PR entries were
            // already written by `fireSchedule` at the moment each session started.
            //
            // `note` returns null if the schedule was deleted while this was
            // running, which a gated run makes a real window rather than a
            // theoretical one — a fetch can take the best part of a minute. The
            // sessions have started either way, so their ids must still be
            // reported: answering with a 500 here would tell the caller the run
            // failed while an agent was already working.
            // One per session, so `runs` counts reviews rather than sweeps — see
            // the same loop in tickSchedules.
            const last = fired.started[fired.started.length - 1];
            let updated = null;
            for (const started of fired.started) {
                updated = schedules.note(row.id, {
                    sessionId: started.sessionId,
                    marker: fired.kind === 'open-prs' ? undefined : last.facts.head,
                });
            }

            // A PR sweep that could not start everything keeps its window open so
            // the rest drains on the ticks that follow, rather than waiting for
            // tomorrow's slot. Only on the everyday instance, which is the only one
            // whose tick will come back for it.
            if (fired.kind === 'open-prs' && fired.deferred && !row.sweepUntil) {
                schedules.openSweep(row.id, Date.now(), SWEEP_MS);
            }

            broadcast('schedules-changed', schedulesPayload());
            return send(res, 200, {
                // Singular first, and kept: `web/app.js` and the Android client
                // both read `sessionId`, and a client that has not been updated
                // should get the session it asked for rather than `undefined`.
                // It is the first of `sessionIds` — for a branch gate the only one.
                sessionId: fired.started[0].sessionId,
                sessionIds: fired.started.map(x => x.sessionId),
                deferred: fired.deferred,
                test: !!row.test,
                schedule: updated ? scheduleOut(updated) : null,
            });
        }
    }

    // Work in flight: uncommitted changes and unmerged pull requests, by project.
    // Still shells out to git — a working tree can only be read by looking at it —
    // but no longer to gh: pull requests come from the store the refresher fills.
    //
    // `?refresh=1` is the board's Refresh button. It drops the working-tree cache
    // *and* forces a pass of the refresher, which is the only way to ask GitHub
    // out of turn. Awaited, because the whole point of the press is to see the
    // answer it produces.
    if (pathname === '/api/dashboard' && req.method === 'GET') {
        const refresh = url.searchParams.get('refresh') === '1';
        if (refresh) {
            await tickPrs({ force: true }).catch(err => console.error(
                `[tgxcode] forced PR refresh failed: ${err.message}`));
        }
        const data = await dashboard.build(index, {
            includeTest: cfg.IS_DEV,
            refresh,
        });
        // The same live status the rail carries, so a row can say that one of
        // its sessions is working right now rather than looking abandoned.
        const statuses = pool.statuses();
        for (const p of data.projects) {
            for (const w of p.workspaces) {
                for (const s of w.sessions) {
                    const st = statuses[s.sessionId];
                    if (st) {
                        s.runner = { state: st.state, activity: st.activity,
                            detail: st.detail, queued: st.queued, claudeVersion: st.claudeVersion };
                    }
                }
            }
        }
        return send(res, 200, data);
    }

    // How much of the quota is gone. Deliberately open to a remote caller: it
    // carries no filesystem detail and names no session, and "release the work
    // from a phone when quota frees up" is a case the drafts routes are already
    // open for. The snapshot is cheap — one stat of a small file, and everything
    // else is in memory — so it needs no caching beyond the one in usage.js.
    if (pathname === '/api/quota' && req.method === 'GET') {
        return send(res, 200, quotaPayload());
    }

    // Installed Claude Code, the newest on the configured channel, and the live
    // sessions still running something older than what is installed. The
    // registry is asked at most hourly; `?refresh=1` asks now, and is what a
    // person pressing "check again" means.
    if (pathname === '/api/claude-version' && req.method === 'GET') {
        return send(res, 200, await claudeVersion.summary({ fresh: url.searchParams.get('refresh') === '1' }));
    }

    // `claude update`, on the machine. It replaces the binary new processes start
    // from and leaves every running one alone — restarting sessions is the
    // user's call, and the summary's `staleSessions` is how they find which.
    // Local only: see remoteRefusal().
    if (pathname === '/api/claude-version/update' && req.method === 'POST') {
        if (claudeVersion.updating) {
            return send(res, 409, { error: 'an update is already running', running: true,
                summary: claudeVersion.summaryNow() });
        }
        const out = await claudeVersion.update();
        const summary = await claudeVersion.summary({ fresh: true });
        claudeVersionSent = JSON.stringify(summary);
        broadcast('claude-version', summary);
        return send(res, 200, { ok: out.ok === true, output: out.output || '', summary });
    }

    // Refresh the percentage now, because the automatic clock is twenty minutes
    // and "how much is left" is a question people ask at the moment they need
    // the answer.
    //
    // It runs the beacon rather than doing anything new: the percentage lives in
    // the status line, and being a TUI for a few seconds remains the only way to
    // make one render. So this is the same operation the timer performs, on
    // demand — which is why it shares runBeaconNow() and pushes the interval out
    // just the same. Clicking Refresh should not be followed by an automatic run
    // a minute later.
    //
    // Deliberately allowed on a dev bridge, unlike the timer. The dev gate is
    // about a worktree bridge quietly spending quota to measure quota on a clock
    // nobody asked about; a person pressing a button has asked.
    //
    // The response is the whole quota payload rather than an acknowledgement, so
    // one round trip both runs the refresh and returns what it produced —
    // including `beacon.ok` and `beacon.reason`, which is what a client draws
    // when a run was blocked by a dialog.
    if (pathname === '/api/quota/refresh' && req.method === 'POST') {
        const q = quotaPrefs();
        if (!q.beaconDir) {
            // Not an error the user can retry past, so it says what to do. 409
            // rather than 400: the request is fine, the machine is not set up.
            return send(res, 409, {
                error: 'no quota beacon directory is configured',
                needsSetup: true,
                quota: quotaPayload(),
            });
        }
        if (beacon.busy) {
            // Not a failure. Somebody double-clicked, or the timer is mid-run,
            // and either way a reading is already on its way.
            return send(res, 409, {
                error: 'a refresh is already running',
                running: true,
                quota: quotaPayload(),
            });
        }

        // `quota.beacon` being false is not checked. That preference governs the
        // automatic clock — "do this every twenty minutes without me" — and a
        // machine that has named a trusted directory but left the timer off is
        // exactly the one where a manual refresh is the point.
        const out = await runBeaconNow(q.beaconDir);
        return send(res, 200, { ok: out.ok === true, quota: quotaPayload() });
    }

    // One PR status per session, for the rail. The same question the conversation
    // header asks about one session, asked about all of them at once — and reduced
    // to a single word each, because a rail row has space for one glyph.
    //
    // It reads the store and answers immediately; the only thing that asks GitHub
    // is `tickPrs`. It stays its own route rather than becoming a field on
    // `/api/sessions` because it is also the payload of `prs-changed`, and because
    // a client that has not received an event yet needs somewhere to start.
    if (pathname === '/api/prs' && req.method === 'GET') {
        return send(res, 200, await prsPayload());
    }

    if (pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readJson(req);
        const cwd = body.cwd && String(body.cwd);
        const prompt = body.prompt && String(body.prompt).trim();
        if (!cwd) return send(res, 400, { error: 'cwd is required' });
        // A screenshot with nothing typed is a message, exactly as it is on the send
        // route. Asked of the request rather than of the resolved list, also as it is
        // there: a file that has been tidied away since it was staged should not turn
        // into "prompt is required", which is advice about the wrong field.
        if (!prompt && !(Array.isArray(body.attachments) && body.attachments.length)) {
            return send(res, 400, { error: 'prompt is required' });
        }

        // Staged by POST /api/attachments a moment ago, and re-derived here against
        // the directory they claim to be in — the same guard the send route uses, and
        // for the same reason: the client is handing back a path we gave it, which is
        // not the same thing as a path we are willing to act on.
        let files = [];
        if (Array.isArray(body.attachments) && body.attachments.length) {
            let dir;
            try {
                dir = resolveWorkdir(cwd);
            } catch (err) {
                return send(res, 400, { error: err.message });
            }
            try {
                files = resolveAttachments(dir, body.attachments);
            } catch (err) {
                return send(res, 400, { error: err.message });
            }
        }

        const mode = normalizeMode(body.permissionMode);
        const refusal = modeRefusal(mode, who);
        if (refusal) return send(res, 403, { error: refusal, remote: true });

        if (tooManyCreates()) {
            return send(res, 429, {
                error: `more than ${CREATE_LIMIT.max} sessions started in a minute — `
                    + 'slow down, or start the rest from the machine itself',
            });
        }

        try {
            const out = pool.create({
                cwd,
                prompt,
                model: body.model || null,
                permissionMode: mode,
                attachments: files,
            });
            // Label it before it exists on disk, so it is never briefly visible
            // in the everyday window while the first rescan catches up.
            if (body.test) flags.set(out.sessionId, { test: true });
            index.note(out.sessionId);

            // **The draft this was started from, consumed here rather than by
            // the caller.**
            //
            // Pressing Start in the dialog you opened a draft in is the same act
            // as pressing Start on its card, so it has to leave the board the
            // same way. It did not: the card's button is
            // `POST /api/drafts/:id/start` and this route had never heard of
            // drafts, so editing a draft and starting it from the dialog spawned
            // the session and left the card sitting there to be started again.
            //
            // A field on this call rather than a `DELETE /api/drafts/:id` the
            // caller sends afterwards — the argument `POST /api/schedules` makes
            // about the same field. As two calls, each client has to decide for
            // itself what a failed second one means once the first has already
            // started a process, and there are three of them to decide it three
            // ways. Here the order *is* the answer.
            //
            // After `pool.create` and only if it returned: until then the draft
            // is the only copy of what was typed, so a directory moved since you
            // saved it costs you the press and nothing else. The rule
            // `/api/drafts/:id/start` states, for the reason it gives.
            //
            // Nothing is re-validated on the way through, unlike that route,
            // because nothing off the draft is used to spawn — `cwd`, `prompt`
            // and the mode all came off this request and are already past
            // `resolveWorkdir`, `normalizeMode` and `modeRefusal`. Consuming one
            // is a delete, which a remote caller may already do.
            //
            // An id naming no draft is not an error. The session started, which
            // is what was asked for, and an id goes missing for two innocent
            // reasons: it was already deleted, or it belongs to a bridge with
            // another state directory.
            const from = typeof body.fromDraft === 'string' ? body.fromDraft : null;
            if (from && drafts.remove(from)) broadcast('drafts-changed', draftsPayload());

            return send(res, 200, { ...out, test: !!body.test });
        } catch (err) {
            return send(res, 400, { error: err.message });
        }
    }

    // /api/sessions/:id[/...]
    if (seg[1] === 'sessions' && seg[2]) {
        const sessionId = seg[2];
        const tail = seg[3];

        if (!tail && req.method === 'GET') {
            const data = index.read(sessionId);
            if (!data) return send(res, 404, { error: 'session not found' });
            const st = pool.statuses()[sessionId];

            // `?tail=N` sends only the last N events, and says how many it left
            // behind so a client can offer to go and get them.
            //
            // For the desktop this would be pointless — it is on loopback and wants
            // the whole conversation anyway. For a phone it is the difference
            // between opening a long session and not: a 60-turn transcript is
            // ~1,800 events and half a megabyte of JSON, over a relay, before
            // anything appears. Slicing here rather than in the client is the whole
            // point; serializing all of it and then throwing most away would save
            // nothing. `offset` is deliberately left as-is — it is a byte position
            // in the file, so the live tail still resumes correctly from it.
            // What was already done about each suggested follow-up in here.
            // Sent whole rather than per event: it is a handful of keys, and a
            // card that arrives on the live tail — after this payload — still
            // needs to know whether it was acted on in another window.
            const acted = suggestions.forSession(sessionId);

            // The settings in force *for this conversation's directory*. The
            // page was served with the user-level answer before it knew which
            // session it was about to show, and a project may override it — so
            // the answer travels with the transcript it applies to, and lands
            // in the same await the client already does before it draws
            // anything. Fetching it separately would be a race the big payload
            // usually wins and sometimes does not.
            const settings = prefs.forCwd(data.summary && data.summary.cwd);

            // `tail=0` is not "no limit", it is "none of them": everything above
            // without the transcript. That is what a polling client wants for the
            // liveness it cannot get from a stream — runner state, the pending ask,
            // the offset to ask `/since` from — at a few hundred bytes rather than
            // half a megabyte. Spelled out rather than relying on `slice(-0)`,
            // which returns the whole array and would make `tail=0` the most
            // expensive call on this route instead of the cheapest.
            // Read as a string first, because `Number(null)` is 0 and the param
            // being absent must not read as "send none of them" — that is the
            // desktop's call, and it wants the whole conversation.
            const asked = url.searchParams.get('tail');
            const want = asked === null ? null : Number(asked);
            if (want !== null && Number.isFinite(want) && want >= 0
                && data.events.length > want) {
                const dropped = data.events.length - want;
                return send(res, 200, {
                    ...data,
                    events: want === 0 ? [] : data.events.slice(-want),
                    truncated: { dropped, total: data.events.length },
                    runner: st || null,
                    suggestions: acted,
                    prefs: settings,
                });
            }
            return send(res, 200, {
                ...data, runner: st || null, suggestions: acted, prefs: settings });
        }

        // Hard delete. Everywhere else in this app "remove" means archive; this
        // is the one place that means it, so it refuses to guess: a session with
        // a turn in flight is not deleted out from under the turn, because the
        // process would keep writing to an unlinked file and the work would be
        // gone with no transcript to show what happened.
        if (!tail && req.method === 'DELETE') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });

            const r = pool.get(sessionId);
            if (r && (r.state === 'busy' || r.state === 'starting')) {
                return send(res, 409, {
                    error: 'a turn is still running — stop it first, then delete',
                });
            }
            await pool.forget(sessionId);
            // The shell was opened on this session's directory and belongs to
            // it; with the session gone there is nothing left to reattach to.
            terminals.closeSession(sessionId);
            // Derived from transcripts that are about to be unlinked, so it goes
            // when they do — the same rule the suggestion cards follow.
            changes.forget(sessionId);

            let removed;
            try { removed = index.remove(sessionId); }
            catch (err) { return send(res, 500, { error: `could not delete: ${err.message}` }); }
            if (!removed) return send(res, 404, { error: 'session not found' });

            // Nothing left to deliver them to. The same rule the changes above
            // follow: what was about this session goes when the session does.
            if (later.forget(sessionId)) broadcast('later-changed', laterPayload());

            // Two events: one for windows showing this conversation, which have
            // to leave it, and the ordinary list refresh for everybody else.
            broadcast('session-deleted', { sessionId, title: summary.title });
            broadcast('sessions-changed', { at: Date.now() });
            return send(res, 200, { ok: true, sessionId, ...removed });
        }

        if (tail === 'since' && req.method === 'GET') {
            const delta = index.readSince(sessionId, Number(url.searchParams.get('offset')) || 0);
            if (!delta) return send(res, 404, { error: 'session not found' });
            return send(res, 200, delta);
        }

        if (tail === 'devservers' && req.method === 'GET') {
            const data = index.read(sessionId);
            if (!data) return send(res, 404, { error: 'session not found' });
            const s = data.summary;
            const candidates = [...devservers.detect(data.events).values()];
            const titles = await devbrowser.titles();
            const out = await devservers.enrich(candidates, titles, {
                id: sessionId,
                workspace: workingDir(s),
                worktreeName: s.worktree && s.worktree.name,
                projectName: s.projectName,
                lastTs: s.lastTs,
            });
            return send(res, 200, out);
        }

        // The session's own task list, items and all.
        //
        // The panel is fed by the `task-list` event on the transcript follow, so
        // this route is not what the desktop uses. It is here because SSE is
        // best-effort and polling is the guaranteed path — a Cloudflare quick
        // tunnel delivers zero event bytes in 75 seconds, measured — and a
        // feature reachable only over SSE is a feature a client behind one
        // cannot have. It is also what makes this answerable with curl.
        //
        // Read-only over the user's own files with nothing shelled out, so no
        // remote refusal rule: the same classification as `changes` below.
        if (tail === 'tasks' && req.method === 'GET') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const rec = index.get(sessionId);
            // Always 200, even with nothing in it. A session that kept no list
            // and a session that does not exist are different things, and only
            // the second is a 404.
            return send(res, 200, {
                sessionId,
                ...tasks.items(sessionId, rec ? rec.file : null),
            });
        }

        // What this session changed — the two answers, side by side.
        //
        // `edits` comes out of the transcript and is about this session: it holds
        // files it edited and has since committed, and it is still right when the
        // working tree has moved on or gone. `git` is the tree as it stands and is
        // about the directory: it holds work somebody else did, and drops work
        // this session did and reverted. Neither is a better version of the other,
        // which is why both are sent and the panel draws them as two lists.
        //
        // Not on the summary, for `prs`' reason one line further down: it shells
        // out, and the session list must never wait on that.
        if (tail === 'changes' && req.method === 'GET') {
            // The summary, not the transcript: `changes.js` reads the file itself,
            // from wherever it stopped last time. A panel that re-asked on every
            // turn would otherwise re-parse the whole conversation each time, and
            // the transcripts on this machine run to tens of megabytes.
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const rec = index.get(sessionId);
            const dir = workingDir(summary);
            if (url.searchParams.get('refresh') && dir) git.clearCache(dir);

            const tree = dir
                ? await git.statusOf(dir, { limit: CHANGED_FILE_CAP })
                : { ok: false, reason: 'no-directory' };
            // Line counts only where there is a tree to diff. Untracked files are
            // not in `git diff` and stay countless, which is what the UI's "new"
            // already says about them.
            if (tree && tree.ok) {
                const counts = await git.numstat(dir);
                tree.sample = tree.sample.map(f => ({ ...f, ...(counts.get(f.path) || {}) }));
            }

            const derived = changes.forSession(index, sessionId, {
                sessionDir: rec ? path.join(rec.dir, sessionId) : null,
                // The repository root where there is one, so a path reads the same
                // here as it does in the tree list beside it.
                root: (tree && tree.root) || dir,
            });
            if (!derived) return send(res, 404, { error: 'session not found' });

            return send(res, 200, {
                dir,
                checkedAt: new Date().toISOString(),
                git: tree,
                edits: derived.files,
                agents: derived.agents,
                added: derived.added,
                deleted: derived.deleted,
            });
        }

        // What changed inside one of those files.
        //
        // The content behind a row in `/changes`. This is the *tree's* answer —
        // the transcript's is the structured patch already on each tool result,
        // which a client that has the conversation loaded can assemble itself, and
        // which is the only answer left once a file has been committed. Sending
        // both from here would mean re-parsing the transcript for a file the
        // client can already see.
        //
        // Deliberately not refused to a remote caller, unlike its neighbours. Every
        // clause in `remoteRefusal` is either a write or a reach past the app into
        // the machine, and this is a read — one whose bytes a phone already gets,
        // in the tool results it renders today. What makes that safe rather than
        // merely convenient is `sessionFilePath`: the answer is scoped to this
        // session's own repository, so a leaked token cannot walk it to ~/.ssh.
        //
        // No cache. `statusOf`'s fifteen seconds exist because the dashboard asks
        // about forty directories on a timer; a diff is asked for once, by a person
        // who wants it as it is now, and caching 2MB strings per file would trade
        // memory for nothing.
        if (tail === 'diff' && req.method === 'GET') {
            const given = String(url.searchParams.get('path') || '').trim();
            const mode = url.searchParams.get('mode') || 'worktree';
            // Asked before the session is looked up, for `attachmentRefused`'s
            // reason: a request wrong about both should be refused for the thing
            // that was wrong, not have the difference read as an id oracle.
            if (!given) return send(res, 400, { error: 'path is required' });
            if (!DIFF_MODES.has(mode)) {
                return send(res, 400, {
                    error: `mode must be one of ${[...DIFF_MODES].join(', ')}`,
                });
            }

            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });

            const answer = (body) => send(res, 200, {
                path: given, mode, checkedAt: new Date().toISOString(), ...body,
            });

            const dir = workingDir(summary);
            if (!dir) return answer({ ok: false, reason: 'no-directory' });

            const tree = await git.statusOf(dir, { limit: CHANGED_FILE_CAP });
            if (!tree || !tree.ok) {
                return answer({ ok: false, reason: (tree && tree.reason) || 'status-failed',
                    error: tree && tree.error });
            }
            const root = tree.root;

            const file = cfg.sessionFilePath(root, given);
            if (!file) {
                // Not a 403 with the roots in it unless the roots are what refused
                // it: "outside this session's repository" is the ordinary case here
                // and is an answer the dialog draws, not an error.
                if (!cfg.withinRoots(path.resolve(root, given))) {
                    return send(res, 403, {
                        error: 'that directory is outside the allowed roots',
                        path: path.resolve(root, given), roots: cfg.ALLOWED_ROOTS,
                    });
                }
                return answer({ ok: false, reason: 'outside-repo', root });
            }

            // Every git argument from here is `rel`, recomputed from the resolved
            // path — never the string the client sent.
            const rel = path.relative(root, file);
            const entry = tree.sample.find(e => e.path === rel) || null;
            const untracked = !!entry && entry.status === '??';
            const counts = untracked ? null : (await git.numstat(dir)).get(rel) || null;

            const meta = {
                root, absPath: file, status: entry ? entry.status : null,
                added: counts ? counts.added : 0,
                deleted: counts ? counts.deleted : 0,
                binary: !!(counts && counts.binary),
            };

            // A binary file is a fact rather than a failure, and it is known before
            // the diff is asked for — the diff itself would only say "Binary files
            // differ", which is not something to render as a diff.
            if (meta.binary) return answer({ ok: true, ...meta, diff: '', bytes: 0, truncated: 0 });

            if (!fs.existsSync(file) && !entry) {
                return answer({ ok: false, reason: 'no-such-file', ...meta });
            }

            // Only when it was actually asked for. `Number(null)` is 0, so parsing
            // an absent parameter would ask git for a diff with no context at all.
            const askedContext = url.searchParams.get('context');
            const out = await git.diffText(dir, rel, {
                mode, untracked,
                context: askedContext == null ? undefined : Number(askedContext),
            });
            if (!out.ok) return answer({ ok: false, ...meta, reason: out.reason, error: out.error });
            return answer({ ok: true, ...meta,
                diff: out.diff, bytes: out.bytes, truncated: out.truncated });
        }

        // The status of the pull requests this session raised.
        //
        // Its own route rather than a field on the summary, because the summary is
        // free and this is a lookup into a store a timer fills — they answer
        // different questions and go stale on different clocks. It no longer waits
        // on gh; a PR the store has not resolved yet reports `unknown`, and the
        // header renders it from the summary uncoloured either way.
        if (tail === 'prs' && req.method === 'GET') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });

            // A `pr-link` entry usually names its repository. Where one did not,
            // the session's own directory is the best guess available.
            const list = summary.prs || [];
            const repo = list.some(pr => !pr.repo) && summary.cwd
                ? await pulls.repoOf(summary.cwd)
                : null;

            return send(res, 200, prStore.forSession(list, repo));
        }

        if (tail === 'subagents' && req.method === 'GET') {
            const agents = index.subagents(sessionId);
            if (!agents) return send(res, 404, { error: 'session not found' });
            return send(res, 200, { agents });
        }

        if (tail === 'subagent' && req.method === 'GET') {
            const toolUseId = url.searchParams.get('toolUseId');
            const from = Number(url.searchParams.get('offset')) || 0;
            const data = index.subagent(sessionId, toolUseId, from);
            if (!data) return send(res, 404, { error: 'subagent transcript not found' });
            return send(res, 200, data);
        }

        if (tail === 'output' && req.method === 'GET') {
            const p = url.searchParams.get('path');
            const data = index.persistedOutput(sessionId, p);
            if (!data) return send(res, 404, { error: 'output not available' });
            return send(res, 200, data);
        }

        if (tail === 'send' && req.method === 'POST') {
            const body = await readJson(req);
            const text = body.text ? String(body.text).trim() : '';
            // A screenshot with nothing typed under it is a real message — "look at
            // this" is the whole content — so an attachment satisfies this on its own.
            if (!text && !(Array.isArray(body.attachments) && body.attachments.length)) {
                return send(res, 400, { error: 'text or an attachment is required' });
            }

            // Sending is also how a mode changes, so the same refusal applies here
            // as on creation — otherwise a phone could start a session in `auto` and
            // escalate it to bypassPermissions with the next message.
            //
            // Checked before the session is looked up, so that the answer does not
            // depend on whether the session exists: a refusal that 404s for an
            // unknown id and 403s for a real one is a way to ask which ids are real.
            const sendMode = normalizeMode(body.permissionMode);
            const sendRefusal = modeRefusal(sendMode, who);
            if (sendRefusal) return send(res, 403, { error: sendRefusal, remote: true });

            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const cwd = sessionCwd(summary);

            // The client is telling us paths it was told a moment ago; this is what
            // makes that safe. Anything that is not in this session's own attachments
            // directory, or is no longer on disk, is dropped rather than refused —
            // losing the whole message because one staged file was tidied away would
            // be the wrong trade.
            let files;
            try {
                files = resolveAttachments(cwd, body.attachments);
            } catch (err) {
                return send(res, 400, { error: err.message });
            }

            const r = pool.ensure(sessionId, {
                cwd,
                model: body.model || null,
                permissionMode: sendMode,
                fork: !!body.fork,
            });
            const entry = r.send(text, files);
            // Which of the two happened matters to the caller: a message that is
            // still queued is safe on this side and will be handed back if the
            // process dies, so the UI only has to hold on to one that went out.
            const status = r.status();
            return send(res, 200, {
                ok: true, id: entry.id, cwd, fork: !!body.fork, status,
                queued: status.queue.some(q => q.id === entry.id),
            });
        }

        // --- the same message, later ---------------------------------------
        // The create half of /api/later, here because a scheduled message is
        // written *against a session* — everything after this is about one
        // message and needs no session in the path. See bridge/later.js.
        if (tail === 'later' && req.method === 'GET') {
            return send(res, 200, { messages: later.forSession(sessionId).map(laterOut) });
        }

        if (tail === 'later' && req.method === 'POST') {
            const body = await readJson(req);
            // Before the session is looked up, so a refused mode does not depend on
            // whether the id is real — `/send`'s order, two routes up.
            const v = laterFields(body, who, { partial: false });
            if (v.error) {
                return send(res, v.status,
                    v.remote ? { error: v.error, remote: true } : { error: v.error });
            }

            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });

            const row = later.create({
                ...v.fields,
                sessionId,
                cwd: sessionCwd(summary),
                // Copied off the session rather than asked for. It decides which
                // bridge delivers this, and a test session's messages belong to the
                // dev bridge for the same reason the session itself does.
                test: !!summary.test,
            });
            if (!row) {
                return send(res, 409, {
                    error: `that session already has ${MAX_LATER_PER_SESSION} messages `
                        + 'waiting — send or cancel some before scheduling another',
                });
            }
            broadcast('later-changed', laterPayload());
            return send(res, 200, { message: laterOut(row) });
        }

        // --- handoff -------------------------------------------------------
        // One session telling another something it needs to know, and waking it
        // to deal with it. Reached by `message_session` in bridge/mcp.js.
        //
        // **The wake needed no new machinery.** `pool.ensure` already spawns
        // `claude --resume` when there is no process, so /send has been able to
        // do this since it existed; what was missing was an address an agent
        // could use, since Claude Code's peer names only exist while a process
        // does. So this is /send with four differences, and each is the reason it
        // is not a flag on /send:
        //
        //   * the mode is not the caller's to choose. Forced to `plan`, so a
        //     woken session comes back with a plan for the user instead of
        //     editing a checkout nobody is watching.
        //   * refusals a person would never hit. Handing work to yourself, and
        //     handing it to a session running in a terminal, which /send only
        //     discovers by failing a spawn.
        //   * a rate limit, because the sender is a model and the recipient can
        //     send back. See bridge/handoff.js.
        //   * the message is wrapped, so it renders as work arriving rather than
        //     as something the user typed. See handoffEnvelope in transcript.js.
        //
        // Local callers only — see remoteRefusal.
        if (tail === 'handoff' && req.method === 'POST') {
            const body = await readJson(req);
            const text = body.text ? String(body.text).trim() : '';
            const from = body.from ? String(body.from) : null;
            if (!text) {
                return send(res, 400, {
                    error: 'text is required — say what the other session needs to know.',
                });
            }

            // Before the lookup, as on /send: an answer that depends on whether
            // the session exists is a way to ask which ids are real.
            if (from && from === sessionId) {
                return send(res, 400, {
                    error: 'that is this session. A handoff is for telling another session '
                        + 'something; write it in your own reply instead.',
                });
            }

            const summary = index.summary(sessionId);
            if (!summary) {
                return send(res, 404, {
                    error: 'no session with that id. Use list_sessions to get one — the id '
                        + 'has to come from there, not from a name or a title.',
                });
            }

            // A session held by a terminal, VS Code, or a background agent. Said
            // here rather than left to the spawn, which would fail with the same
            // reason a few seconds later and after a process had been started.
            const st = pool.statuses()[sessionId] || null;
            if (handoffState(summary, st) === 'elsewhere') {
                return send(res, 409, {
                    error: 'that session is running somewhere else — a terminal, or a '
                        + 'background agent — so it cannot be resumed from here. Two writers '
                        + 'cannot append to one transcript. Pick another session, or say what '
                        + 'you found in your reply.',
                });
            }

            const refusal = handoffLimit.refuse(from, sessionId);
            if (refusal) return send(res, 429, { error: refusal });

            const sender = from ? index.summary(from) : null;
            const cwd = sessionCwd(summary);
            // Read before ensure(), which is about to change the answer.
            const woke = wakes(st);

            const r = pool.ensure(sessionId, { cwd, permissionMode: 'plan' });
            const entry = r.send(handoffEnvelope({
                text,
                // Provenance, not authority. The id is whatever the sending
                // session was started as, so a session that later forked reports
                // the one it began with — which is why nothing downstream trusts
                // this to find a session, and why an unknown `from` is carried
                // through rather than refused.
                fromId: from,
                fromTitle: sender ? sender.title : null,
                fromProject: sender ? sender.projectName : null,
                title: body.title ? String(body.title).trim() : null,
            }));
            // A handoff that never landed must not be reported as delivered. The
            // sender is about to finish its turn and tell the user it passed the
            // work on; there is nobody to hand the message back to. So when the
            // send is what started the process, wait briefly to see whether it
            // started. See wakeFailure.
            if (woke) {
                const failure = await wakeFailure(r);
                if (failure) {
                    return send(res, 502, {
                        error: `that session could not be resumed, so nothing was delivered. `
                            + `${failure.message} Say what you found in your reply instead, and `
                            + 'mention that the handoff did not go through.',
                    });
                }
            }

            const status = r.status();
            return send(res, 200, {
                ok: true, id: entry.id, sessionId, cwd, woke, status,
                queued: status.queue.some(q => q.id === entry.id),
            });
        }

        // --- attachments ---------------------------------------------------
        // A file pasted or dropped onto the composer. Written before the message is
        // sent rather than with it: the strip shows real files with real names, the
        // send stays a small JSON POST, and a staged file survives a reload because
        // it is already on disk. See bridge/attachments.js for where it lands.
        //
        // The session in the path is only ever a way of naming a working directory —
        // that is the whole of what decides where the file goes. POST /api/attachments
        // is the same route for a composer that has no session to name yet, and the
        // two share everything from the cwd onward.
        if (tail === 'attachments' && !seg[4] && req.method === 'POST') {
            const name = url.searchParams.get('name');
            if (attachmentRefused(req, res, name)) return;

            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });

            return receiveAttachment(req, res, sessionCwd(summary), name);
        }

        // Open a staged or sent attachment in whatever Windows opens that kind of
        // file with. The path comes from the client, so it is re-derived against this
        // session's own attachments directory before anything is launched — this is
        // the one route here that hands a path to another program.
        if (tail === 'attachments' && seg[4] === 'open' && req.method === 'POST') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const cwd = sessionCwd(summary);
            const body = await readJson(req);

            const file = attachmentPath(cwd, body.path);
            if (!file) {
                return send(res, 404, {
                    error: 'that file is not one of this session\'s attachments',
                });
            }
            const out = await openFile(file);
            return send(res, out.ok ? 200 : 502, { ...out, file });
        }

        if (tail === 'stop' && req.method === 'POST') {
            const r = pool.get(sessionId);
            if (!r) return send(res, 404, { error: 'no live process for this session' });
            const body = await readJson(req);
            // Soft by default: ask the turn to stop rather than killing it, so
            // the session stays resumable. `hard` is the escalation, and the
            // answer says which one actually happened because the outcomes
            // differ enough for the user to care.
            const out = await r.stop({ hard: !!body.hard });
            // Whatever was still queued never reached the process, so it goes
            // back to the composer rather than into the bin.
            return send(res, 200, { ...out, dropped: out.dropped.map(q => q.text) });
        }

        // --- the send queue ------------------------------------------------
        // Messages waiting behind the turn in flight. They live in the runner, so
        // there is nothing to read when no process is live — that is an empty
        // queue, not an error.
        if (tail === 'queue') {
            const r = pool.get(sessionId);
            const qid = seg[4];

            if (req.method === 'GET') {
                const st = r && r.status();
                return send(res, 200, { queue: st ? st.queue : [], status: st || null });
            }

            if (req.method === 'DELETE' && qid) {
                if (!r) return send(res, 404, { error: 'nothing is queued for this session' });
                // Awaited: a message already handed to the running turn is taken
                // back from the CLI's own queue, which is a round trip.
                const removed = await r.dequeue(qid);
                // Already read by the turn, or written as one: it cannot be taken
                // back, and saying so beats silently doing nothing.
                if (!removed) return send(res, 409, { error: 'that message has already been sent' });
                return send(res, 200, { ok: true, removed, status: r.status() });
            }

            if (req.method === 'DELETE') {
                if (!r) return send(res, 200, { ok: true, dropped: [] });
                const dropped = await r.clearQueue();
                return send(res, 200, { ok: true, dropped, status: r.status() });
            }

            if (req.method === 'POST' && qid === 'reorder') {
                if (!r) return send(res, 404, { error: 'nothing is queued for this session' });
                const body = await readJson(req);
                if (!Array.isArray(body.ids)) return send(res, 400, { error: 'ids must be an array' });
                r.reorder(body.ids.map(String));
                return send(res, 200, { ok: true, status: r.status() });
            }
        }

        // Answer a pending approval. The runner owns the reply channel, so all
        // this does is hand the decision over and let it write.
        if (tail === 'permission' && req.method === 'POST') {
            const r = pool.get(sessionId);
            if (!r) return send(res, 404, { error: 'no live process for this session' });
            const body = await readJson(req);
            const decision = String(body.decision || '');
            if (!['allow', 'allow-always', 'deny'].includes(decision)) {
                return send(res, 400, { error: 'decision must be allow, allow-always or deny' });
            }
            // A plan and a question answer over the same route: the extras are
            // what make them more than yes or no — which mode an approved plan
            // continues in, what to tell the model when it is turned down, and
            // the answers themselves.
            const out = r.answerPermission(String(body.requestId || ''), decision, {
                updatedInput: body.updatedInput && typeof body.updatedInput === 'object'
                    ? body.updatedInput : null,
                answers: body.answers && typeof body.answers === 'object' ? body.answers : null,
                feedback: typeof body.feedback === 'string' ? body.feedback : '',
                mode: PERMISSION_MODES.includes(body.mode) ? body.mode : null,
            });
            // 409 rather than 500: losing the race with another window is an
            // ordinary outcome, not a failure.
            return send(res, out.ok ? 200 : 409, out);
        }

        if (tail === 'flags' && req.method === 'POST') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const body = await readJson(req);
            const next = flags.set(sessionId, {
                pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
                archived: typeof body.archived === 'boolean' ? body.archived : undefined,
                test: typeof body.test === 'boolean' ? body.test : undefined,
                // A string names the session and `null` or `""` clears the name.
                title: (typeof body.title === 'string' || body.title === null) ? body.title : undefined,
            });
            const stopped = next.archived ? archiveStoppedRuns(summary) : 0;
            broadcast('sessions-changed', { at: Date.now() });
            // `title` is the name the session now shows, not the flag: with the
            // name cleared, that is whatever the transcript or schedule calls it,
            // which the caller has no other cheap way to learn.
            const after = index.summary(sessionId) || summary;
            return send(res, 200, {
                ok: true, sessionId, ...next,
                title: after.title, titleSource: after.titleSource,
                runsStopped: stopped,
            });
        }

        // Just the decisions, for a client that has the conversation already and
        // only needs to know what moved. Refetching the whole transcript to
        // learn that one card was dismissed would be megabytes for two fields.
        if (tail === 'suggestions' && !seg[4] && req.method === 'GET') {
            if (!index.summary(sessionId)) return send(res, 404, { error: 'session not found' });
            return send(res, 200, { sessionId, suggestions: suggestions.forSession(sessionId) });
        }

        // What you did about one suggested follow-up.
        //
        // The suggestion itself is never written here — it is a tool call in the
        // transcript and stays the only copy. This records the *decision*, which
        // is the one part of it that is yours: `started`, with the session it
        // produced so the card can become a link, or `dismissed`. Posting with no
        // status takes the decision back and the card offers itself again, which
        // matters because dismiss is the easy one to hit by accident.
        //
        // Broadcast, so a second window showing the same conversation stops
        // offering something that has already been started.
        if (tail === 'suggestions' && seg[4] && req.method === 'POST') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const toolUseId = seg[4];
            const body = await readJson(req);
            const status = body.status == null ? null : String(body.status);

            if (status === null) {
                suggestions.clear(sessionId, toolUseId);
                broadcast('suggestion-changed', { at: Date.now(), sessionId, toolUseId });
                return send(res, 200, { ok: true, sessionId, toolUseId, status: null });
            }
            if (!SUGGESTION_STATUSES.has(status)) {
                return send(res, 400, {
                    error: `status must be one of ${[...SUGGESTION_STATUSES].join(', ')}, `
                        + 'or absent to undo',
                });
            }
            // `ifOpen` makes this a claim rather than an overwrite: refused when
            // a decision is already recorded. It is how an agent takes a task up
            // inside its own session (`start_task` as a subagent) without the
            // read-then-write gap in which a second run takes it too.
            const prior = suggestions.forSession(sessionId)[toolUseId];
            if (body.ifOpen && prior) {
                return send(res, 409, {
                    error: `that task is already ${prior.status}`
                        + (prior.startedId ? ` (session ${prior.startedId})` : ''),
                    status: prior.status,
                    startedId: prior.startedId,
                });
            }
            const next = suggestions.set(sessionId, toolUseId, {
                status,
                startedId: typeof body.startedId === 'string' ? body.startedId : null,
                via: typeof body.via === 'string' ? body.via : null,
                note: typeof body.note === 'string' ? body.note : null,
            });
            broadcast('suggestion-changed', { at: Date.now(), sessionId, toolUseId });
            return send(res, 200, { ok: true, sessionId, toolUseId, ...next });
        }

        // Show the session's working directory in Windows File Explorer.
        if (tail === 'reveal' && req.method === 'POST') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const dir = workingDir(summary);
            if (!dir) return send(res, 404, { error: 'no directory for this session' });
            const out = await openInExplorer(dir);
            return send(res, out.ok ? 200 : 502, { ...out, dir });
        }

        // Open one of the session's files in whatever Windows opens that kind of
        // file with — reveal's idea, one level finer.
        //
        // The second route here that takes a path from the client and hands it to
        // another program, and it re-derives it exactly as the first one does. See
        // `sessionFilePath`: joined to a root the bridge worked out itself, checked
        // against that root and against the allowed roots, and checked again
        // against its real path when it turns out to be a link.
        //
        // This used to argue that a file-extension denylist was not the answer,
        // on the grounds that the drawer only offers files git already reports as
        // changed and that refusing them would break opening the script you were
        // editing. The second half of that was wrong about what a denylist costs
        // here: `isLaunchable` does not refuse anything, it reveals the file in
        // its folder instead of launching it. So the cost is a click, and the
        // saving is that a `.ps1` an agent wrote into the checkout cannot be run
        // by clicking a row about it. Local-only on top of that, because the
        // window it opens is on this machine's desktop.
        if (tail === 'open-file' && req.method === 'POST') {
            const body = await readJson(req);
            const given = String(body.path == null ? '' : body.path).trim();
            // Before the session lookup, so a request wrong about both is refused
            // for the path rather than turning 400-vs-404 into an id oracle.
            if (!given) return send(res, 400, { error: 'path is required' });

            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const dir = workingDir(summary);
            if (!dir) return send(res, 404, { error: 'no directory for this session' });

            const file = cfg.sessionFilePath(await sessionRoot(dir), given);
            if (!file) {
                // 403 rather than 404, and the same 403 whether the file is absent
                // or out of bounds: the difference between those two is an
                // existence oracle for everything on the machine.
                return send(res, 403, {
                    error: 'that file is outside this session\'s working directory',
                });
            }

            // A file Windows would *run* is revealed in its folder instead of
            // launched, which is the rule POST /api/fs/open landed for text a
            // model wrote into a transcript. `isLaunchable`'s own docstring
            // argues the two callers naming a path this app computed do not need
            // it, and this route is one of those — but the argument is weaker
            // here than there: what this names is a file inside a checkout, and
            // a checkout is exactly where a `.ps1` an agent wrote ten minutes ago
            // would be. Revealing costs a click and refuses nothing; `how` says
            // which happened, so a client can explain it.
            if (isLaunchable(file)) {
                const shown = await openInExplorer(file);
                return send(res, shown.ok ? 200 : 502,
                    { ...shown, how: 'reveal', why: 'executable', file });
            }

            const out = await openFile(file);
            return send(res, out.ok ? 200 : 502, { ...out, how: 'open', file });
        }

        // Open (or come back to) a shell in the same directory reveal would
        // show. One per session, so the pane reopens where you left it.
        if (tail === 'terminal' && req.method === 'POST') {
            const summary = index.summary(sessionId);
            if (!summary) return send(res, 404, { error: 'session not found' });
            const dir = workingDir(summary);
            if (!dir) return send(res, 404, { error: 'no directory for this session' });
            const body = await readJson(req);
            try {
                const term = terminals.open({
                    sessionId, cwd: dir, rows: body.rows, cols: body.cols,
                });
                // `cwd` in the answer is the shell's own, which for one started
                // before the session moved is not the directory asked for.
                return send(res, 200, { ...term.info(), sessionCwd: dir });
            } catch (err) {
                return send(res, 409, { error: err.message });
            }
        }
    }

    // --- project commands --------------------------------------------------
    // What a directory declares in .tgxcode/, and the runs started from it. See
    // bridge/commands.js for why reading a file out of a project is new ground,
    // and bridge/runs.js for why a run is a terminal underneath.
    if (seg[1] === 'commands') {
        if (!seg[2] && req.method === 'GET') {
            const dir = url.searchParams.get('cwd');
            if (!dir) return send(res, 400, { error: 'cwd is required' });
            const listed = commands.load(dir);
            if (!listed) return send(res, 403, { error: 'that directory is outside the allowed roots' });
            // The live run travels with the command so one request paints the
            // whole row: a button that does not know it is already running is
            // a button that starts a second server.
            return send(res, 200, {
                ...listed,
                commands: listed.commands.map((c) => {
                    const run = runs.forCommand(listed.workspace, c.id);
                    return { ...c, run: run ? run.info() : null };
                }),
            });
        }

        if (seg[2] === 'run' && req.method === 'POST') {
            const body = await readJson(req);
            if (!body.cwd || !body.id) return send(res, 400, { error: 'cwd and id are required' });
            if (!cfg.withinRoots(body.cwd)) {
                return send(res, 403, { error: 'that directory is outside the allowed roots' });
            }
            const out = await runs.start(body.cwd, body.id);
            if (out.error) {
                return send(res, out.status || 400,
                    { error: out.error, run: out.run ? out.run.info() : undefined });
            }
            return send(res, 200, { run: out.run.info() });
        }
    }

    if (seg[1] === 'runs') {
        if (!seg[2] && req.method === 'GET') return send(res, 200, { runs: runs.list() });

        if (seg[2]) {
            const run = runs.get(seg[2]);
            if (!run) return send(res, 404, { error: 'no such run' });
            const tail = seg[3];

            if (!tail && req.method === 'GET') return send(res, 200, { run: run.info() });

            // The same byte pipe a terminal uses, for the same reason.
            if (tail === 'stream' && req.method === 'GET') {
                return streamBytes(req, res, run.term, run.info());
            }

            if (tail === 'input' && req.method === 'POST') {
                const body = await readJson(req);
                if (typeof body.b64 !== 'string') return send(res, 400, { error: 'b64 is required' });
                // Writable on purpose: vite's `r`, jest's watch keys, and Ctrl-C
                // as a gentler stop than the SIGHUP the stop button sends.
                const ok = run.term.write(Buffer.from(body.b64, 'base64'));
                return send(res, 200, { ok, exited: run.term.exited });
            }

            if (tail === 'resize' && req.method === 'POST') {
                const body = await readJson(req);
                run.term.resize(body.rows, body.cols);
                return send(res, 200, { ok: true, rows: run.term.rows, cols: run.term.cols });
            }

            if (tail === 'stop' && req.method === 'POST') {
                return send(res, 200, { ok: runs.stop(run.id), run: run.info() });
            }

            // Forgetting is not stopping. Conflating them is how somebody kills
            // a dev server by tidying a list.
            if (!tail && req.method === 'DELETE') {
                if (!run.exitedAt) {
                    return send(res, 409, { error: 'still running — stop it first', run: run.info() });
                }
                return send(res, 200, { ok: runs.forget(run.id) });
            }
        }
    }

    // --- terminals ---------------------------------------------------------
    // Keyed by terminal rather than by session so a pane keeps talking to the
    // shell it opened even if the session list moves underneath it.
    if (seg[1] === 'terminals' && seg[2]) {
        const term = terminals.get(seg[2]);
        if (!term) return send(res, 404, { error: 'no such terminal' });
        const tail = seg[3];

        // Its own stream, not the app's SSE channel: this is a byte pipe that
        // can move megabytes when a build is noisy, and it has no business
        // sharing a connection with transcript tailing.
        if (tail === 'stream' && req.method === 'GET') return streamBytes(req, res, term, term.info());

        if (tail === 'input' && req.method === 'POST') {
            const body = await readJson(req);
            // Base64 both ways: a keystroke is bytes, and half a multi-byte
            // character is a legitimate thing to send on its own.
            if (typeof body.b64 !== 'string') return send(res, 400, { error: 'b64 is required' });
            const ok = term.write(Buffer.from(body.b64, 'base64'));
            // The shell exiting while you were mid-keystroke is ordinary, and
            // the pane already knows from the exit event — say so, don't fail.
            return send(res, 200, { ok, exited: term.exited });
        }

        if (tail === 'resize' && req.method === 'POST') {
            const body = await readJson(req);
            term.resize(body.rows, body.cols);
            return send(res, 200, { ok: true, rows: term.rows, cols: term.cols });
        }

        if (!tail && req.method === 'DELETE') {
            terminals.close(term.id);
            return send(res, 200, { ok: true });
        }
    }

    // --- dev servers -------------------------------------------------------
    // Both of these are keyed by port, not by session: the chip is offered
    // because this session started the server, but what answers on the port —
    // and what ends up killed — is whoever holds the socket now, which is the
    // only thing that can be checked for real.

    // Who holds a port, so a chip about to stop one can say whose process it is.
    // Ports get reused across worktrees; the pid and command line are the only
    // things that tell you the server is still the one you meant.
    if (pathname === '/api/devservers/owner' && req.method === 'GET') {
        const port = Number(url.searchParams.get('port'));
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            return send(res, 400, { error: 'invalid port' });
        }
        const [owners, listening] = await Promise.all([
            devservers.owners(port), devservers.isListening(port),
        ]);
        return send(res, 200, { port, listening, owners });
    }

    if (pathname === '/api/devservers/stop' && req.method === 'POST') {
        const body = await readJson(req);
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            return send(res, 400, { error: 'invalid port' });
        }
        // The same list that keeps a port out of the chip row keeps it from being
        // killed through one — this bridge's own port included.
        if (cfg.PORT_DENYLIST.has(port)) {
            return send(res, 403, { error: `:${port} is not a dev server this app will stop` });
        }
        const out = await devservers.stop(port);
        if (out.ok) return send(res, 200, out);
        return send(res, STOP_STATUS[out.reason] || 502, { ...out, error: stopMessage(out, port) });
    }

    // --- devbrowser --------------------------------------------------------
    if (pathname === '/api/devbrowser/status' && req.method === 'GET') {
        const [health, tls] = await Promise.all([devbrowser.health(), devbrowser.titles()]);
        return send(res, 200, { ...health, titles: tls });
    }

    if (pathname === '/api/devbrowser/open' && req.method === 'POST') {
        const body = await readJson(req);
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return send(res, 400, { error: 'invalid port' });
        }
        // Name the tab on the way in when the transcript told us what it is —
        // DevBrowser identifies tabs by port alone, so an unnamed one is just a
        // number in a wall of numbers.
        if (body.title) {
            try { await devbrowser.setTitle(port, String(body.title).slice(0, 64)); } catch { /* best effort */ }
        }
        // `ifClosed: 'none'` asks for no launch. Not running is then an answer,
        // not an error — 200 with `running: false` — so the client can fall
        // back to its own preview without parsing a 502.
        const launch = body.ifClosed !== 'none';
        const out = await devbrowser.openTab(port, body.path || null, { launch });
        if (out.running === false) return send(res, 200, out);
        return send(res, out.ok ? 200 : 502, out);
    }

    if (pathname === '/api/devbrowser/title' && req.method === 'POST') {
        const body = await readJson(req);
        const port = Number(body.port);
        if (!Number.isInteger(port)) return send(res, 400, { error: 'invalid port' });
        const r = await devbrowser.setTitle(port, body.title == null ? null : String(body.title));
        return send(res, r.ok ? 200 : 502, { ok: r.ok });
    }

    // --- wispr flow --------------------------------------------------------
    // Whether the composer's Wispr button should be drawn at all. The answer is
    // about *this caller*: a remote one is refused the press below, so for it
    // there is nothing to draw, even on a host where the press would work.
    if (pathname === '/api/wispr' && req.method === 'GET') {
        return send(res, 200, { available: wispr.available() && !who.remote });
    }

    // By id and never by chord: the chord comes out of the user's own settings,
    // so a caller can press what the user set up and nothing else. See
    // bridge/wispr.js.
    if (pathname === '/api/wispr/press' && req.method === 'POST') {
        const body = await readJson(req);
        if (!wispr.available()) {
            return send(res, 409, { error: 'Wispr Flow shortcuts need the Windows host', available: false });
        }
        const found = prefs.forCwd('').wispr.transforms.find(t => t.id === body.id);
        if (!found) return send(res, 404, { error: 'no such transform' });
        const out = await wispr.press(found.combo);
        if (!out.ok) return send(res, 502, { error: out.error });
        return send(res, 200, { ok: true, combo: found.combo });
    }

    // --- pairing -----------------------------------------------------------
    // What the "Connect a phone" dialog needs to build a link that works: the
    // machine's real tailnet name, and whether HTTPS is available on it yet.
    //
    // Local callers only — not because it is secret, but because it is answering
    // "how would a *different* device reach this bridge", and a device that is
    // already talking to it remotely has its answer.
    if (pathname === '/api/pairing' && req.method === 'GET') {
        if (who.remote) return send(res, 403, { error: 'local callers only' });
        const info = await tailscale.pairingHosts(cfg.PORT);
        return send(res, 200, info);
    }

    // --- slash commands (composer completion) ------------------------------
    //
    // Not /api/commands: that is the project's own declared commands, a
    // different feature with a different payload. See bridge/slash-commands.js.
    //
    // Addressed by session or by directory, because both callers exist: the
    // composer knows a session id and nothing else, while a dialog that has not
    // started one yet knows only a path. Answering both here keeps the cwd
    // resolution — which needs the filesystem — on this side.
    if (pathname === '/api/slash-commands' && req.method === 'GET') {
        const session = url.searchParams.get('session');
        let cwd;

        if (session) {
            const summary = index.summary(session);
            if (!summary) return send(res, 404, { error: 'session not found' });
            cwd = sessionCwd(summary);
        } else {
            cwd = cfg.expandHome(url.searchParams.get('cwd') || '');
            if (!cwd) return send(res, 400, { error: 'session or cwd is required' });
            // Same rule as /api/fs: a directory a session could not be started in
            // is one whose commands are not this caller's business either.
            if (!cfg.withinRoots(cwd)) {
                return send(res, 403, {
                    error: 'that directory is outside the allowed roots',
                    path: path.resolve(cwd),
                    roots: cfg.ALLOWED_ROOTS,
                });
            }
        }

        // Never a 404 for "nothing recorded yet": an empty list is a real answer,
        // and it lets the menu say so quietly instead of raising an error at
        // somebody who only pressed a key.
        return send(res, 200, slashCommands.for(cwd));
    }

    // --- filesystem (new-session directory picker) -------------------------
    if (pathname === '/api/fs' && req.method === 'GET') {
        const dir = url.searchParams.get('path') || cfg.HOME;
        // This exists for the new-session directory picker, and a session can only
        // start inside the allowed roots — so listing outside them offers a choice
        // that cannot be taken, on top of enumerating the machine to a caller who
        // has no business doing so.
        if (!cfg.withinRoots(dir)) {
            return send(res, 403, {
                error: 'that directory is outside the allowed roots',
                path: path.resolve(dir),
                roots: cfg.ALLOWED_ROOTS,
            });
        }
        return send(res, 200, listDir(dir));
    }

    // --- attachments, before there is a session -----------------------------
    //
    // The same upload as POST /api/sessions/:id/attachments, for the composer in
    // the Start-a-session dialog. That one names a working directory by naming a
    // session; this one names it directly, because the session does not exist yet
    // and cannot until its first message — which is the message the file is going
    // on — has been composed.
    //
    // Beside /api/fs/mkdir rather than beside its own sibling, because these two
    // are the pair that matters: both take a client-supplied path and write into
    // the checkout it names, and remoteRefusal treats them the same way for the
    // same reason.
    if (pathname === '/api/attachments' && req.method === 'POST') {
        const name = url.searchParams.get('name');
        if (attachmentRefused(req, res, name)) return;

        const given = cfg.expandHome(url.searchParams.get('cwd') || '');
        if (!given) return send(res, 400, { error: 'cwd is required' });

        // The roots check by hand and first, so the refusal is the same shape every
        // other cwd-addressed route answers with. resolveWorkdir would refuse it
        // too, but only as a sentence — and a sentence is not something a client
        // can show a breadcrumb from.
        if (!cfg.withinRoots(given)) {
            return send(res, 403, {
                error: 'that directory is outside the allowed roots',
                path: path.resolve(given), roots: cfg.ALLOWED_ROOTS,
            });
        }

        // Unlike a session id, a client-supplied path is arbitrary: it may not
        // exist, and it may be a file. attachmentsDirFor would compute a plausible
        // directory beside either of those without complaint, so the question has
        // to be asked here — by the same function that asks it when a session is
        // about to be started in a directory.
        let cwd;
        try {
            cwd = resolveWorkdir(given);
        } catch (err) {
            return send(res, 400, { error: err.message });
        }

        return receiveAttachment(req, res, cwd, name);
    }

    // Somewhere to put a project that does not exist yet. The picker can navigate,
    // so this only ever has to make one directory in a place you are already
    // standing — which is why the body is {parent, name} rather than one joined
    // path. A separate `name` can be refused outright for containing a separator,
    // instead of being sanitised after the fact and hoping nothing was missed.
    if (pathname === '/api/fs/mkdir' && req.method === 'POST') {
        const body = await readJson(req);
        const parent = cfg.expandHome(body.parent || '');
        const name = String(body.name == null ? '' : body.name).trim();

        if (!parent) return send(res, 400, { error: 'parent is required' });
        if (!cfg.withinRoots(parent)) {
            return send(res, 403, {
                error: 'that directory is outside the allowed roots',
                path: path.resolve(parent),
                roots: cfg.ALLOWED_ROOTS,
            });
        }

        // Asked before mkdir so a missing or file-shaped parent is a sentence
        // rather than a bare ENOENT/ENOTDIR arriving from two layers down.
        if (!isDirectory(parent)) {
            return send(res, 400, { error: `No such directory: ${parent}` });
        }

        const bad = folderNameProblem(name);
        if (bad) return send(res, 400, { error: bad });

        const target = path.join(path.resolve(parent), name);
        // Belt and braces. The separator refusal above already makes this
        // unreachable, and it is still the check that must not be the one that
        // was left out.
        if (!cfg.withinRoots(target)) {
            return send(res, 403, {
                error: 'that directory is outside the allowed roots',
                path: target, roots: cfg.ALLOWED_ROOTS,
            });
        }

        try {
            // Deliberately not recursive: one segment is all the button offers, and
            // a non-recursive mkdir is what makes EEXIST below mean something.
            fs.mkdirSync(target);
            return send(res, 200, { ok: true, path: target, created: true });
        } catch (err) {
            if (err.code === 'EEXIST') {
                // The caller wanted a directory here by this name, and there is
                // one. Saying "already exists" would be technically true and
                // practically unhelpful — so this is idempotent, and the client
                // navigates into it either way.
                let st = null;
                try { st = fs.statSync(target); } catch { /* raced away */ }
                if (st && st.isDirectory()) {
                    return send(res, 200, { ok: true, path: target, created: false });
                }
                return send(res, 409, {
                    error: `${target} already exists and is not a directory`,
                });
            }
            if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
                return send(res, 404, { error: `${parent} is no longer a directory` });
            }
            if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') {
                return send(res, 403, { error: `Not allowed to create a folder in ${parent}` });
            }
            return send(res, 500, { error: err.message });
        }
    }

    // Open a path on the Windows host: the file itself, or the folder holding it.
    //
    // The one route here whose argument comes out of a transcript rather than out
    // of the app. Everywhere else that reaches explorer.js names a path this
    // bridge computed — a session's working directory, or a file re-derived
    // against that session's own attachments directory. Here the client is
    // repeating text a model wrote, and `explorer.exe` handed a file does not show
    // it, it launches it. So what Windows would do with the path is asked before
    // the path is handed over.
    //
    // No roots check, deliberately, and that is the refusal on this route that was
    // considered and dropped rather than the one that was forgotten.
    // cfg.ALLOWED_ROOTS defaults to $HOME, which would 403 every /tmp/claude-… and
    // /mnt/c/… link a transcript contains while buying nothing: an agent that
    // wanted a click on something malicious could write the file inside $HOME and
    // be inside the fence. What does the work instead is that this is local-only,
    // that the link text is the path itself so you see what you are opening, and
    // that isLaunchable is not negotiable.
    //
    // Session-free on purpose: this is about the machine, not about a
    // conversation, which is also what lets a path work on the second-monitor
    // board with nothing in focus.
    if (pathname === '/api/fs/open' && req.method === 'POST') {
        const body = await readJson(req);
        const given = cfg.expandHome(String(body.path == null ? '' : body.path).trim());
        if (!given) return send(res, 400, { error: 'path is required' });
        const target = path.resolve(given);

        // Asked here rather than left to explorer.js so a path that is simply gone
        // — a plan file from a worktree that has since been landed — is a 404 and
        // not a 502 about a program that could not be run.
        let st;
        try { st = fs.statSync(target); } catch {
            return send(res, 404, { error: `${target} does not exist` });
        }

        const answer = (out, how, why) => send(res, out.ok ? 200 : 502, {
            ok: out.ok,
            how,
            path: target,
            winPath: out.path || null,
            ...(why ? { why } : {}),
            ...(out.error ? { error: out.error } : {}),
        });

        // A directory belongs to Explorer, and a file Windows would execute is not
        // something a click on a sentence should do. Both degrade to the reveal
        // instead of refusing: the folder is the same information with none of the
        // execution. `how` is what happened rather than what was asked for, so a
        // client can say why the file it clicked did not open.
        const why = st.isDirectory() ? 'directory'
            : isLaunchable(target) ? 'executable'
                : null;
        if (why || body.reveal) {
            return answer(await openInExplorer(target), 'reveal', why);
        }
        return answer(await openFile(target), 'open');
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

/**
 * Refuse an upload for a reason that has nothing to do with where it was going.
 *
 * Both checks run before the caller has even worked out a working directory, and
 * that ordering is the point: answering "session not found" to a request that
 * also carried `../evil.png` hides the refusal that actually mattered behind an
 * unrelated one. The size is answered from Content-Length, so an oversized upload
 * is refused before its bytes travel rather than after.
 *
 * Returns true when it has already answered.
 */
function attachmentRefused(req, res, name) {
    const bad = attachments.attachmentNameProblem(name);
    if (bad) {
        send(res, 400, { error: bad });
        return true;
    }
    if (declaredOverMax(req, attachments.MAX_ATTACHMENT_BYTES)) {
        refuseUpload(req, res, 413, overMax(attachments.MAX_ATTACHMENT_BYTES));
        return true;
    }
    return false;
}

/**
 * Read an upload's bytes and write them into a working directory's attachments.
 *
 * Everything the two upload routes do once they agree on a directory, which is
 * everything that matters: the roots check before the write and the realpath
 * check after it, the empty-file refusal, the rename-on-collision, the
 * gitignore entry, and sniffing the media type from the bytes. One copy, because
 * two would be two places for the roots check to be got right and one of them to
 * be forgotten later.
 *
 * `cwd` is already resolved by the caller — from a session for one of them, from
 * a validated `?cwd=` for the other.
 */
async function receiveAttachment(req, res, cwd, name) {
    const { dir, root } = attachments.attachmentsDirFor(cwd);
    if (!cfg.withinRoots(dir)) {
        return send(res, 403, {
            error: 'that directory is outside the allowed roots',
            path: dir, roots: cfg.ALLOWED_ROOTS,
        });
    }

    let buffer;
    try {
        buffer = await readBinary(req, attachments.MAX_ATTACHMENT_BYTES);
    } catch (err) {
        if (err.oversized) return refuseUpload(req, res, err.status, err.message);
        return send(res, err.status || 400, { error: err.message });
    }
    if (!buffer.length) return send(res, 400, { error: 'that file is empty' });

    let written;
    try {
        written = attachments.writeAttachment({ dir, name, buffer });
    } catch (err) {
        if (err.code === 'ENOTDIR') {
            return send(res, 400, {
                error: `${dir} exists but is not a directory`,
            });
        }
        return send(res, 500, { error: `could not save the file: ${err.message}` });
    }

    // After the mkdir, not before: this is the check that catches an
    // attached_assets symlinked out of the roots, which cannot be seen until
    // the directory exists.
    let real = dir;
    try { real = fs.realpathSync(dir); } catch { /* just written; treat as itself */ }
    if (!cfg.withinRoots(real)) {
        try { fs.unlinkSync(written.path); } catch { /* nothing better to do */ }
        return send(res, 403, {
            error: 'that directory resolves outside the allowed roots',
            path: real, roots: cfg.ALLOWED_ROOTS,
        });
    }

    attachments.ensureExcluded(root);

    return send(res, 200, {
        ok: true,
        name: written.name,
        renamed: written.renamed,
        path: written.path,
        relPath: attachments.relativeTo(cwd, written.path),
        dir,
        bytes: buffer.length,
        // Sniffed from the bytes, not taken from Content-Type — this is what
        // decides whether the turn carries an inline image block.
        mediaType: attachments.sniffType(buffer, req.headers['content-type']),
    });
}

/**
 * One client-supplied attachment path, re-derived against this session's own
 * attachments directory — or null.
 *
 * The client is handing back a path the bridge gave it a moment ago, which is not the
 * same thing as a path the bridge is willing to act on: a different session's id with
 * this session's file, or a path edited in flight, both arrive looking identical. So
 * only the *basename* is taken from the caller and the directory is recomputed here.
 * That leaves nothing for a `..` to traverse out of.
 */
function attachmentPath(cwd, given) {
    const raw = String(given == null ? '' : given);
    if (!raw) return null;
    const name = path.basename(raw);
    if (attachments.attachmentNameProblem(name)) return null;

    const { dir } = attachments.attachmentsDirFor(cwd);
    if (!cfg.withinRoots(dir)) return null;

    const file = path.join(dir, name);
    if (path.dirname(file) !== dir) return null;      // belt and braces
    try {
        if (!fs.statSync(file).isFile()) return null;
    } catch {
        return null;
    }
    return file;
}
/**
 * The repository root a session's file paths are relative to.
 *
 * `tree.root` only when git said `ok`. A `left-behind` answer carries a `root`
 * too and it is the *parent* repository — the trap workingState documents — so
 * taking it would resolve a removed worktree's paths against the main checkout.
 */
async function sessionRoot(dir) {
    if (!dir) return null;
    const tree = await git.statusOf(dir, { limit: 0 });
    return (tree && tree.ok && tree.root) || dir;
}

/**
 * The attachments a send may carry, in the order the client staged them.
 *
 * A path that no longer resolves is dropped rather than refused. The alternative is
 * losing a message somebody typed because a file they staged was tidied away in the
 * meantime, and the message is worth more than the completeness of its file list.
 */
function resolveAttachments(cwd, given) {
    if (given == null) return [];
    if (!Array.isArray(given)) throw new Error('attachments must be an array');
    if (given.length > attachments.MAX_PER_MESSAGE) {
        throw new Error(`at most ${attachments.MAX_PER_MESSAGE} files per message`);
    }

    const out = [];
    for (const a of given) {
        const file = attachmentPath(cwd, a && (a.path || a.relPath || a));
        if (!file) continue;
        let bytes = 0;
        try { bytes = fs.statSync(file).size; } catch { /* raced; reported as 0 */ }
        out.push({
            path: file,
            name: path.basename(file),
            relPath: attachments.relativeTo(cwd, file),
            // Sniffed from the file on disk rather than believed from the client, for
            // the same reason the upload route sniffs it: this decides whether the turn
            // carries an inline image block, and a wrong answer is a failed turn.
            mediaType: attachments.sniffType(readHead(file), a && a.mediaType),
            bytes,
        });
    }
    return out;
}

/** The first few bytes of a file, for sniffing. Enough for every magic number. */
function readHead(file, n = 16) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(n);
        const read = fs.readSync(fd, buf, 0, n, 0);
        return buf.subarray(0, read);
    } catch {
        return Buffer.alloc(0);
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    }
}

// An unrecognised mode falls back to the app's default rather than erroring: the
// mode is a knob on a request that has real work in it, and refusing the whole
// send over a typo in one field loses the message.
function normalizeMode(mode) {
    return PERMISSION_MODES.includes(mode) ? mode : 'auto';
}

const STOP_STATUS = { protected: 403, 'no-owner': 409, 'not-permitted': 403 };

/** Why a stop did not happen, in words the chip can put in a toast. */
function stopMessage(out, port) {
    if (out.reason === 'protected') return `:${port} is ${out.what} — left alone`;
    if (out.reason === 'no-owner') {
        return out.listening
            ? `Something answers on :${port} but no Linux process owns it — it may be running on Windows`
            : `Nothing is listening on :${port}`;
    }
    if (out.reason === 'not-permitted') return `Not allowed to signal the process on :${port}`;
    return `:${port} is still listening after SIGKILL`;
}

/**
 * Where the agent is working now: its current cwd, which for a session that
 * entered a worktree is the worktree itself. Reveal and the terminal pane both
 * mean this directory when they say "where the session is".
 */
function workingDir(summary) {
    return [summary.cwd, summary.worktree && summary.worktree.path, summary.projectCwd]
        .find(d => d && fs.existsSync(d)) || null;
}

/**
 * Archiving a session stops the commands running in its directory — but only
 * once nothing else is using it.
 *
 * Archiving is how you say you are done with a piece of work, and a dev server
 * for a branch nobody is looking at any more is exactly the thing that ends up
 * holding a port for a week. Runs are keyed by directory rather than by session
 * though, and several sessions share a worktree routinely, so archiving one of
 * three would otherwise pull the server out from under the other two. The last
 * one out turns the lights off.
 *
 * @returns {number} how many runs were stopped
 */
function archiveStoppedRuns(summary) {
    const dir = workingDir(summary);
    // Asked first, and cheap: almost every archive is of a session in a
    // directory nothing is running in, and the scan below is not free.
    if (!dir || !runs.forWorkspace(dir).some(r => !r.exitedAt)) return 0;

    // Compared as strings rather than through workingDir(), which stats up to
    // three paths per session — a few thousand of those on every archive click,
    // to answer a question the recorded paths already answer.
    const others = index.list({ includeTest: true, limit: 1000 }).some(s =>
        s.sessionId !== summary.sessionId && !s.archived
        && (s.cwd === dir || (s.worktree && s.worktree.path === dir) || s.projectCwd === dir));
    if (others) return 0;
    const stopped = runs.stopWorkspace(dir);
    if (stopped) {
        console.log(`[tgxcode] archived ${summary.sessionId}: stopped ${stopped} run(s) in ${dir}`);
    }
    return stopped;
}

/**
 * Why this is not a usable folder name, or null if it is one.
 *
 * The leading-dot refusal is not prudishness: listDir() hides dotfiles, so a
 * `.foo` created here would be invisible in the very picker that made it. A name
 * the app will not show is worse than a name it will not accept.
 */
function folderNameProblem(name) {
    if (!name) return 'a name is required';
    if (name === '.' || name === '..') return `"${name}" is not a name`;
    if (name.includes('/')) return 'a folder name cannot contain "/" — make one level at a time';
    if (name.includes('\0')) return 'that name contains a null byte';
    if (name.startsWith('.')) return 'names starting with "." are hidden, and the picker would not show it';
    if (Buffer.byteLength(name) > 255) return 'that name is too long';
    return null;
}

/** Does this path exist and is it a directory? Follows symlinks, unlike a Dirent. */
function isDirectory(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

const LIST_CAP = 500;

function listDir(dir) {
    const resolved = path.resolve(cfg.expandHome(dir));
    let entries = [];
    let truncated = false;
    try {
        const all = fs.readdirSync(resolved, { withFileTypes: true })
            .filter(e => !e.name.startsWith('.'))
            // A symlink pointing at a directory reports isDirectory() false, so
            // without the second arm browsing cannot see a project tree that was
            // linked into place — and people do link them in. Only links pay for
            // the stat, and a dangling one drops out of the list by failing it.
            .filter(e => e.isDirectory()
                || (e.isSymbolicLink() && isDirectory(path.join(resolved, e.name))))
            .map(e => ({ name: e.name, path: path.join(resolved, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
        // The cap used to be silent, which reads as "this is all of it". Saying so
        // costs a boolean and stops the picker implying something false.
        truncated = all.length > LIST_CAP;
        entries = all.slice(0, LIST_CAP)
            // Which of these is a project, without having to click in. One stat
            // per row, capped, and all of it local.
            .map(e => ({ ...e, git: fs.existsSync(path.join(e.path, '.git')) }));
    } catch (err) {
        return {
            path: resolved, error: err.message, entries: [],
            parent: path.dirname(resolved), roots: cfg.ALLOWED_ROOTS,
        };
    }
    const isGit = fs.existsSync(path.join(resolved, '.git'));
    // Stop "up" at the edge of the allowed roots rather than offering a step the
    // route above will refuse. A dead end you can see is better than a button that
    // returns 403.
    const up = resolved === '/' ? null : path.dirname(resolved);
    return {
        path: resolved,
        parent: up && cfg.withinRoots(up) ? up : null,
        // The breadcrumb needs to know where the trail stops and what to call the
        // top of it, and when more than one root is configured this is the only
        // way a client can offer the second one at all. Learning the roots by
        // making a request that fails is backwards.
        roots: cfg.ALLOWED_ROOTS,
        isGit,
        truncated,
        entries,
    };
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function send(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > 4 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(new Error('invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

/**
 * The whole body as bytes, for the one route that takes a file rather than JSON.
 *
 * A sibling of readJson rather than a generalisation of it, for two reasons. It
 * needs a *caller-supplied* cap — 25MB for an attachment against readJson's 4MB —
 * and it needs to fail honestly: readJson's rejection reaches the catch-all in
 * `route`, which turns "body too large" into a 500, and that has been the answer
 * for long enough that other routes may be relying on the shape. So the new reader
 * throws a `status` and this route reads it, and readJson is left alone.
 *
 * Content-Length is checked first where the client sent one, so an oversized upload
 * is refused before the bytes travel rather than after.
 */
const overMax = (max) => `that file is larger than the `
    + `${Math.round(max / (1024 * 1024))}MB limit`;

/**
 * Refuse an upload, and hang up on the rest of it.
 *
 * Both halves matter and the order between them is the whole reason this is a function
 * rather than two lines at each caller. Destroying the socket is what stops a client
 * from spending thirty seconds sending a file that has already been refused; doing it
 * before the response has flushed truncates the sentence that says why, which is how
 * an oversized upload came to report a bare `100 Continue` and nothing else. `finish`
 * is the event that says the answer is out.
 */
function refuseUpload(req, res, status, error) {
    res.on('finish', () => req.destroy());
    return send(res, status || 413, { error });
}

/**
 * A Content-Length the caller already told us is too big.
 *
 * Split out so the route can ask *before* it looks a session up. Both refusals can be
 * true of one request, and the size is the more useful of the two to hear: "session not
 * found" in answer to a 40MB upload hides the thing that would still be wrong after
 * the id was fixed.
 */
function declaredOverMax(req, max) {
    const n = Number(req.headers['content-length']);
    return Number.isFinite(n) && n > max;
}

function readBinary(req, max) {
    return new Promise((resolve, reject) => {
        // Paused, not destroyed. Destroying the socket here was the first version and
        // it is wrong in a way worth remembering: the caller still has to write the
        // 413 onto that socket, and a client that sent `Expect: 100-continue` — curl
        // does, for a body this size — then sees the interim 100 and nothing else. It
        // reports "100" as the status and never learns what the limit was. So the
        // stream stops and the route answers; `oversized` tells it to hang up
        // afterwards, since nothing is going to read the rest of the upload.
        const tooBig = () => {
            req.pause();
            reject(Object.assign(new Error(overMax(max)), { status: 413, oversized: true }));
        };

        // Normally already handled by the caller; kept because this function's contract
        // is the cap, not the caller's diligence.
        if (declaredOverMax(req, max)) return tooBig();

        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            // A Content-Length that lied, or a chunked body. Same answer.
            if (size > max) return tooBig();
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
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
