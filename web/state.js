// The page's one mutable store.
//
// `state` is a single object so that any module can read and write it by
// property — a module-level `let` cannot be assigned from another module, and
// a property can. When a surface moves out of app.js, what it needs to remember
// goes on here rather than into a `let` of its own that app.js would then need
// to reach. The bridge is still the truth; this is what the page knows of it.

// What the composer falls back to for a session nothing is known about. Matches
// the `selected` option in index.html and the bridge's own default, so all three
// agree about what "no mode was chosen" means.
export const DEFAULT_PERM = 'auto';

export const state = {
    clientId: null,
    dev: false,             // talking to a development bridge
    remote: false,          // this window reached the bridge from off-machine
    root: '',               // the checkout the bridge is serving, from /api/health
    restart: null,          // the 409 the restart button is currently asking about
    pairInfo: null,         // what /api/pairing said this machine is reachable as
    sessions: [],
    query: '',
    current: null,          // session summary
    offset: 0,
    openSeq: 0,             // bumped per open; a slow fetch checks it before drawing
    nodes: new Map(),       // event id -> {ev, node}
    tools: new Map(),       // tool_use id -> {ev, node}
    // Find in conversation. See the find section for what the two halves are:
    // `hits` is derived from the event data and is the truth, `painted` is a
    // cache of DOM ranges that any move or redraw invalidates.
    find: {
        open: false,
        q: '',              // the query, lowercased
        hits: [],           // {agentId, evId, n} in document order
        matched: [],        // {agentId, evId, count} — the same, one per event
        at: -1,             // which hit is current
        subagents: false,   // the Subagents toggle; off by default, not persisted
        subs: new Map(),    // toolUseId -> that subagent's events
        subsLoading: false,
        text: new Map(),    // `agentId\0evId` -> lowercased searchable text
        painted: [],        // the ranges currently registered
        capped: false,      // more hits than FIND_MAX; the count says so
        dirty: false,
        frame: 0,
    },
    // Just the ExitPlanMode calls among them, by id. `transcriptPlan` used to
    // find the pending one by walking every tool in the session — thousands of
    // them on a long transcript — and it is asked on every tail and every status
    // tick, which is several times a second while a plan is on screen. There are
    // never more than a handful of these, so the walk is over them instead. Ids
    // rather than events: a result landing rebuilds the event in place.
    plans: new Set(),
    // Settings for the open session's directory, from the bridge. Null until a
    // session is opened, when BOOT_PREFS is the answer.
    prefs: null,
    // Ids of the tool (and thinking) events seen since the last message, in
    // order — the run that is still being worked on. Ids and not nodes: a node
    // is replaced whenever a result lands, so a held reference goes stale.
    run: [],
    agentRun: [],
    turns: [],              // the user messages, in order, for the turn rail
    // The tick element per user turn, parallel to `turns`. markActiveTurn used
    // to index dom.turns.children, which stopped being the same list the moment
    // plans and questions joined the rail.
    turnTicks: [],
    activeTurn: -1,
    // The plan or question the review dialog is showing, by event id. An id and
    // not the event: patchTool rebuilds the object when a result lands.
    review: { evId: null },
    agents: [],             // subagent records for this session, from the bridge
    agent: null,            // the subagent being viewed, if any
    agentOffset: 0,
    agentNodes: new Map(),  // the viewed subagent's own event id -> {ev, node}
    agentTools: new Map(),
    runner: null,
    // A permission mode picked here and not yet sent, per session. Deliberately
    // not persisted: after a reload the transcript is the better answer, and this
    // only exists so that looking away and back does not quietly drop a choice.
    permChoice: new Map(),
    // The same for the model, and the same reasoning. It is a Map for a reason
    // worth writing down: the `#model` select used to be window-wide and sticky,
    // so picking `opus` for one conversation quietly picked it for the next one
    // you opened. A chord makes that far easier to do by accident, which is what
    // turned an oddity into a bug — see paintModel.
    modelChoice: new Map(),
    channels: [],
    // Ports this session mentioned that belong to another workspace, counted
    // so the strip can say they were left out rather than just look empty.
    channelsElsewhere: 0,
    // url -> {status, label, detail, title, updatedAt} from /api/sessions/:id/prs.
    // Null until that answers; the header draws its PRs from the summary either way.
    prStatus: null,
    // sessionId -> {status, label, total, counts} — one word for a whole session's
    // pull requests, which is all a rail row has space for. Seeded from /api/prs at
    // boot and kept current by the `prs-changed` event; empty until the first of
    // those, and rows draw a colourless glyph in the meantime.
    railPrs: new Map(),
    prsLoaded: false,       // the first /api/prs has been applied; see applyRailPrs
    // Why GitHub could not be reached, from the same payload. Grey glyphs with no
    // explanation is what an expired `gh` token used to look like on every surface
    // but the board.
    prsError: null,
    // What the session's directory declares in .tgxcode/, and what is running
    // from it. Keyed by nothing — there is only ever one conversation on screen,
    // and the payload is re-fetched when it changes. `cmdsFor` is the directory
    // they were read for, so a late answer for a session you have left is
    // dropped rather than drawn.
    cmds: null,
    cmdsFor: null,
    runs: new Map(),        // run id -> the bridge's record
    termTab: 'shell',       // 'shell', or the id of a run whose output is shown
    pinned: true,           // stick to the bottom as new events arrive
    // Which rail groups are shut. Storing the collapsed ones rather than the
    // open ones means a project seen for the first time defaults to open.
    collapsed: (() => {
        try {
            const raw = localStorage.getItem('railCollapsed');
            if (raw) return new Set(JSON.parse(raw));
            // Migrate the old single-group flag; archived stays shut by default.
            return new Set(localStorage.getItem('archiveOpen') === '1' ? [] : ['archived']);
        } catch { return new Set(['archived']); }
    })(),
    // And which Scheduled subsections are *open* — the other way round, on
    // purpose. See isOpen.
    schedOpen: (() => {
        try { return new Set(JSON.parse(localStorage.getItem('railSchedOpen') || '[]')); }
        catch { return new Set(); }
    })(),
    // Whether the rail is hiding sessions whose pull requests have all settled.
    // localStorage rather than prefs, like everything else about how this rail is
    // drawn: it is a view of one window, and the bridge has no use for it.
    hideDone: localStorage.getItem('railHideDone') === '1',
    // Where each row and each group card sits, decided once — see rememberOrder.
    order: new Map(),       // sessionId -> rank
    groupOrder: new Map(),  // group key -> rank
    freshRank: 0,           // ranks for what turns up after the first load
    // What each session's timestamps were on the last load, so `dynamic` can tell
    // a message arriving from a list merely being re-sent. See rememberOrder.
    seenTs: new Map(),      // sessionId -> {user, last}
    railRename: null,       // {id, draft} while a rail row's name is being edited
    railDrag: null,         // {cwd, order} while a project card is dragged, in `custom`
    sortMenu: false,        // the rail head's order menu is open
    unsent: new Map(),      // sessionId -> text written to a process but not yet in a transcript
    // The one message drawn in the log before the transcript has it:
    // {sessionId, node, timer}. Kept out of state.nodes on purpose — renderTurns
    // builds the turn rail from there, and a tick whose node is about to be
    // thrown away is worse than a tick that arrives one poll late.
    pendingSend: null,
    pendingDelete: null,    // the session the confirm dialog is asking about
    busyTimer: null,        // ticks the elapsed-time readout while a turn runs
    queue: [],              // the current session's waiting messages, from the bridge
    queueDrag: null,        // id of the chip being dragged
    queueOpen: new Set(),   // ids of chips expanded to their full text
    // Messages waiting on a clock — every session's, not just this one's, because
    // that is the shape the `later-changed` event carries and the rail wants the
    // whole list anyway. Filtered to the open session when the chips are drawn.
    later: [],
    laterOpen: new Set(),   // ids of chips expanded to their full text
    laterPick: false,       // is the popover showing the pick-a-time fields?
    // Slash commands the composer can complete, per working directory — the
    // bridge keys them that way because that is what decides them. Held here so
    // that pressing `/` draws from memory rather than waiting on a fetch; the
    // `slash-commands` SSE event drops an entry when a process reports a new
    // list. Not `commands`, which is `cmds` above — the project's own.
    slashCommands: new Map(),   // cwd -> {commands, at, exact}
    // Sessions an agent here could message, from GET /api/peers. One list for
    // the whole window rather than one per session, because it is a fact about
    // the machine — every composer offers the same names.
    //
    // Refetched when the rail changes rather than held forever: a peer that has
    // exited cannot be messaged, and offering its name would be offering a
    // failure. `at` is when it was answered, so opening the picker twice in a
    // row does not ask twice.
    peers: { list: [], at: 0 },
    // What has already been done about each suggested follow-up in the open
    // conversation, keyed by the id of the tool call that raised it. Arrives
    // whole on the session payload; changes arrive over SSE.
    suggestions: new Map(),   // toolUseId -> {status, startedId, at}
    // The suggestions themselves, in the order they were raised. They are pulled
    // out of the transcript on the way past — see appendEvents — because they are
    // drawn in the aside beside the log rather than in it.
    tasks: new Map(),         // toolUseId -> ev
    // Which task bodies are open. Only the ones you have actually opened: a card
    // starts folded whatever its status, so absence means folded rather than
    // "not decided yet".
    taskOpen: new Map(),      // toolUseId -> bool
    // Whether the aside is showing at all. A property of the window rather than
    // of a session, like the terminal pane's height — you either want these in
    // view while you work or you do not.
    tasksShut: localStorage.getItem('tasksShut') === '1',
    // Whether an already-open aside is holding its place while the new
    // conversation's suggestions are being fetched. See renderChecklist.
    tasksPending: false,
    // The task the big dialog is showing, if it is open. Held by id rather than
    // by object so a decision taken inside it can find its way back to the same
    // task after the panel behind has been rebuilt.
    taskDialog: null,
    queueSig: '',           // what the chips were last built from, to avoid churn
    queueFocus: null,       // the chip holding the queue's single tab stop
    ask: null,              // the approval this session is blocked on, if any
    planAside: false,       // the plan view is collapsed to its one-line bar
    planFor: null,          // which requestId that was decided about
    // The mode the bridge last reported, per session, so that a mode which moves
    // under a session can be told apart from one being seen for the first time.
    runnerMode: new Map(),
    // Its model twin. Null is a real value here — a process started without
    // `--model` reports one — so this holds what the bridge said, null included,
    // and `has()` is what tells "not seen yet" from "seen, and inheriting".
    runnerModel: new Map(),
    stopArmed: 0,           // when a soft Stop happened, for the force escalation
    // Sessions where "Send anyway" was clicked past the live-elsewhere lock.
    // Per session and not persisted: the next window, and this one after a
    // reload, should ask again rather than inherit somebody's earlier gamble.
    lockOverride: new Set(),
    // What this session changed. `on` is whether the drawer is in the layout at
    // all and `shut` whether it is collapsed to its strip — the same two states
    // the suggestions aside has, and remembered for the same reason: it is a
    // property of the window, not of a session. `at` is when the bridge last
    // answered, so re-opening it does not shell out to git again.
    changes: {
        on: localStorage.getItem('changesOn') === '1',
        shut: localStorage.getItem('changesShut') === '1',
        sessionId: null, data: null, at: 0, loading: false, error: null,
    },
    // The file on screen in the diff viewer.
    //
    // Values copied off a row, never the row itself. `renderChanges` calls
    // replaceChildren on every load, every refresh and every turn that ends, so
    // an element or a closure this held would be an orphan within seconds of the
    // dialog opening — and the dialog outlives several of those by design.
    //
    // `req` is a sequence rather than a loading flag, for the reason
    // `loadChanges` has an `at`: an answer that arrives for a file you have since
    // moved off is dropped rather than drawn over the one you are reading.
    //
    // `split`/`words`/`wrap` are remembered per window like `changesOn`, because
    // they are a property of how you read a diff and not of any one file.
    diff: {
        open: false, sessionId: null, kind: null,
        path: null, absPath: null, status: null, root: null,
        mode: 'worktree', source: null, text: null, meta: null,
        toolId: null, agent: null,
        loading: false, error: null, stale: false, req: 0,
        split: localStorage.getItem('diffSplit') === '1',
        words: localStorage.getItem('diffWords') !== '0',
        wrap: localStorage.getItem('diffWrap') === '1',
        // Set on first open when nothing has been remembered, from the window
        // width — side by side in a narrow window is two unreadable columns.
        sized: localStorage.getItem('diffSplit') != null,
    },
    // The right-click menu. `dom.ctxMenu.hidden` is whether it is open, the way
    // `dom.newMenu.hidden` is; this holds only what to give focus back to.
    ctx: { from: null },
    // The session's own task list. `on` and `shut` are the same two window
    // properties the drawers either side of the transcript have, remembered for
    // the same reason.
    //
    // Read as `!== '0'` rather than `=== '1'`, unlike `changesOn` right above:
    // this panel is on by default, so a window that has never been told
    // anything has to show it. That one character is the whole of "visible by
    // default", and an `=== '1'` habit silently undoes it.
    //
    // No `at`, `loading` or `error`, which `changes` needs: there is nothing to
    // fetch and nothing to go stale. The bridge pushes this on the same follow
    // the transcript arrives on.
    checklist: {
        on: localStorage.getItem('checklistOn') !== '0',
        shut: localStorage.getItem('checklistShut') === '1',
        sessionId: null, data: null,
        // Whether an already-open column is holding its place while the new
        // conversation's list is still on the wire. See resetChecklist.
        pending: false,
    },
    // The board of unfinished work. `at` is when the bridge last answered, so
    // opening it again does not re-run git over every worktree on the machine.
    dash: { open: false, data: null, at: 0, loading: false, error: null, files: new Set() },
    // The browser preview (web/preview.js). Not one of PANELS: those cover it the
    // way they cover the conversation, and it comes back when they close.
    // `overLive` is decided at open — whether this preview covers a docked Live
    // board or sits beside it — and `max` is the toolbar's Maximize.
    preview: { open: false, overLive: true, max: false },
    // A run id whose page should open once it answers HTTP — set by clicking a
    // task that is still starting. See applyRunChange.
    previewWhenUp: null,
    // The notification log. `read` is the bridge's watermarks — a floor moved by
    // opening this panel, and one per conversation moved by going to it — and
    // `unread` is the badge, counted over the whole log rather than over the
    // page we happen to have fetched. Both come from the bridge rather than from
    // localStorage, because two windows and a phone have to agree about a badge.
    notes: { open: false, rows: [], at: 0, loading: false, error: null,
        scope: 'notable', read: { all: 0, sessions: {} }, unread: 0, mark: null },
    // The live board. `watching` is what the bridge has been told, kept apart
    // from `open` so that a re-subscribe for some other reason does not turn the
    // board's timer on for a window that closed it.
    live: { open: false, watching: false, data: null, at: 0, clock: null,
        // Half-written messages per card, held here rather than in the DOM so
        // they outlive the redraws the board does while agents work.
        drafts: new Map(),
        // Which way the board and the conversation divide the window:
        // 'bottom' stacks them, 'side' puts them next to each other. A property
        // of the window rather than of a session, like the terminal pane, so it
        // is remembered and every session you move to keeps it.
        dock: localStorage.getItem('liveDock') === 'side' ? 'side' : 'bottom' },
    // The task board. `watching` is what the bridge has been told, apart from
    // `open` for the same reason the live board keeps them apart.
    //
    // `order` and `freshRank` are the rail's stable-ordering trick, per column:
    // where a card sits is decided once and then held, so nothing slides out
    // from under the cursor while an agent works. `allIdle` is what the Show-all
    // button fetched, held separately because the push never carries it.
    taskboard: { open: false, watching: false, data: null, at: 0,
        loading: false, error: null, allIdle: null,
        // Half-typed text in the Suggested column's box, held here rather than
        // in the DOM so it survives the redraws the board does while agents work.
        draft: '',
        // The focused view: suggested tasks only, spread one column per
        // project. A property of the window like `liveDock` above, so a board
        // you left focused comes back focused. `query` deliberately is not
        // remembered — a search still live on the next open would hide most of
        // the board and read as the tasks having gone.
        focus: localStorage.getItem('tbFocus') === '1',
        query: '',
        order: new Map(), freshRank: 0, tailRank: 0 },
    // Sessions set up but not started.
    //
    // **Not the other two `drafts` in this file.** `state.live.drafts` above and
    // `state.taskboard.draft` are half-typed text held so a redraw cannot eat it,
    // and `saveDraft`/`loadDraft` near the top are the composer's per-session
    // localStorage. These are the real thing: whole create calls, stored by the
    // bridge, that outlive the window.
    //
    // No `watching` and no stable-order machinery, unlike the two boards above.
    // Nothing here changes unless somebody changes it, so there is no tick to
    // gate and no card that could slide out from under the cursor — the bridge
    // pushes the whole list on `drafts-changed` and this holds it as sent.
    //
    // `editing` is the id the dialog is currently editing, or null when it is
    // about to make a new one. It is what tells Save which verb to use.
    drafts: { open: false, rows: [], at: 0, loading: false, error: null, editing: null },
    // The project card whose ⋮ menu is open, or null. The menu is fixed and
    // outside the rail, so this is how the card's ⋮ knows to draw itself
    // expanded, and how syncProjMenu() finds the button to follow.
    projMenu: null,
    // Canned messages, and the groups they are drawn in. Drafts' terms for the
    // push — the whole list, unconditional, held as sent — with one difference
    // that matters: **this list is read while its panel is shut.** The pinned
    // buttons on the composer are drawn from it, so it is loaded at boot rather
    // than when the settings panel opens, and kept current whether or not anybody
    // is looking at the editor.
    //
    // `editing` is the snippet the editor dialog has open, or null for a new one.
    // `fill` is what the parameter dialog is asking about, held from the click
    // that opened it until the insert that consumes it — it carries the composer
    // and the caret, because by then the focus has moved twice.
    // `order` is an arrangement the Settings editor is holding — `{groups: [id],
    // lists: {groupId or '': [snippetId]}}` — while a drag or an arrow is being
    // saved; the editor draws from it rather than from the rows until the push
    // answers it. `committing` is true while the one save loop is running.
    // `revs` is a per-group counter the group head's inputs are keyed on, bumped
    // to redraw them from the stored value when nothing else changed. See
    // web/snippets/settings.js.
    snippets: {
        rows: [], groups: [], at: 0, loading: false, error: null,
        editing: null, fill: null, drag: null, order: null, committing: false,
        revs: {},
    },
    // Schedules, on exactly the same terms as drafts above — an unconditional
    // push, held as sent. `editing` is the id the dialog has open, which is also
    // what puts the dialog into schedule mode at all: see openNew().
    // `fromDraft` is the draft a Schedule press converted, held from the moment
    // the dialog reopens in schedule mode until the save that consumes it. It is
    // not `editing` — the schedule does not exist yet — and it is deliberately
    // not stored on the schedule either; see drToSchedule().
    // `openDone` holds the projects whose Done band is unfolded, keyed by the
    // same project name the columns are. A Set of the *open* ones rather than the
    // shut ones, so the default is shut — the rail's nested Scheduled group makes
    // the same choice for the same reason (`isOpen`). In memory only: it is a
    // reading position within one sitting, not a preference.
    sched: {
        open: false, rows: [], at: 0, loading: false, error: null,
        editing: null, fromDraft: null, openDone: new Set(),
    },
    // The settings panel. `data` is a `?files=1` answer — what is in force plus
    // what each file in the chain says on its own, which is what lets a control
    // tell a value you set from one you inherited.
    //
    // `scope` and `project` are which file it is editing; they are the panel's
    // own state and not persisted, because a scope left selected from last week
    // is the kind of thing that gets a preference written to the wrong file.
    // `recording` is the command whose next keystroke becomes its binding.
    settings: {
        open: false, scope: 'user', project: '', projects: [],
        data: null, spinner: null, loading: false, error: null,
        saving: false, recording: null,
        jumpTo: null,       // a group to scroll to once loaded; see openSettingsAt
        // The order the verb groups are drawn in, fixed on the way in. See
        // settingGroups().
        groupOrder: null,
        // Bumped to remount the typed-into boxes (numbers, paths, weights, the
        // range) from the stored value when a save did not move it — a refused
        // or dropped save, or a number that is not one. See settingControl().
        rev: 0,
        // Which group the contents list lights. See markSettingsToc().
        toc: null,
        // The long rows somebody folded or opened, by key. See settings/fold.js.
        folds: (() => {
            try {
                const f = JSON.parse(localStorage.getItem('settingsFolds') || '{}');
                return f && typeof f === 'object' && !Array.isArray(f) ? f : {};
            } catch { return {}; }
        })(),
    },
    // Claude Code's own settings, which are a different four files with a
    // different owner — see the Claude Code section below. Its own `scope`
    // because its chain is four rows to the page's three, and its own `draft`
    // because the JSON tab is the one control here that is a draft by nature.
    claudeCfg: {
        scope: 'user', tab: 'form', data: null, loading: false, error: null,
        saving: false, draft: null, dirty: false, jsonError: null,
        stale: null, jumpTo: null,
        // The hooks editor's draft, which is the second one here: hooks are
        // written whole, on Save, after a review — see claudeHooksRow().
        // `hooksSeed` is the block the draft started from, as JSON, so a change
        // on disk can be told apart from the page's own saves of other keys.
        hooksDraft: null, hooksDirty: false, hooksReview: false,
        hooksProblems: null, hooksSeed: null,
    },
    // And Claude Code's memory files, which are two rather than four and are
    // additive rather than a chain — see the Memory section below. All of it is
    // a draft: the whole control is one document being typed into, so `draft`
    // is not an exception here the way it is above but the normal case.
    // `caret` survives the trip through Preview, which is a re-render and would
    // otherwise put the cursor back at the top of a 23KB file.
    claudeDocs: {
        scope: 'user', data: null, loading: false, error: null, saving: false,
        draft: null, dirty: false, stale: null, preview: false, caret: 0,
        expanded: false,
    },
    // And the commands a project declares, which are two files again but ours
    // rather than Claude Code's — see the Project commands section below. Its
    // own `scope` for the same reason the two above have one: the page's picker
    // means "which of *our* three settings files", and these are a different
    // pair. `draft` is an array of the selected file's own entries, and unlike
    // everywhere else on this page the form is a draft too, not just the JSON
    // box: a command is a record whose fields have to agree, so there is no
    // single field whose change is a document worth writing.
    cmdCfg: {
        scope: 'project', tab: 'form', data: null, loading: false, error: null,
        saving: false, draft: null, dirty: false, raw: null, rawDirty: false,
        jsonError: null, stale: null, problems: null,
        // Which command cards are expanded. Cards start shut, and this has to
        // live here because renderSettings() redraws the whole form on nearly
        // every edit. Held twice over: by the client-only `_k`, which is the
        // only name a card has while its id is blank or being typed, and by
        // id, because a save or a re-read reseeds the draft with new keys and
        // would otherwise fold up everything you had open.
        open: new Set(), openIds: new Set(),
    },
    // Sessions blocked on an answer, kept whether or not the board is open, so
    // the badge on a shut board still says how many people are waiting.
    waiting: new Set(),
    // A second-monitor window: no rail, no composer, just cards.
    focus: false,
    // The Browse tab of the new-session picker. `dir` is the folder on screen,
    // which is also the folder Start will use — walking into one is how you pick
    // it, and #new-cwd is written on every step. `seq` is the openSeq trick:
    // clicking down a tree faster than the listings come back would otherwise let
    // an older one paint over a newer one.
    browse: {
        tab: localStorage.getItem('newPickerTab') === 'browse' ? 'browse' : 'recent',
        dir: null, parent: null, roots: [], entries: [],
        truncated: false, error: null, seq: 0,
        known: new Map(),   // cwd -> project, from /api/projects, for the row tags
        focus: null,        // path holding the tree's single tab stop
        naming: false,      // the New folder name box is open
    },
};
