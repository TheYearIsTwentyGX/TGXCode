'use strict';

// The demo world: two small projects, the conversations Claude Code would have
// left behind working on them, and the state the bridge keeps about those —
// an orchestrator with workers, its brief, pull requests, flags.
//
// **Everything here is made up.** Nothing is read from ~/.claude, ~/.local/share
// or any real project; the only inputs are the files under ./demo and the text in
// this file. That is what makes the run repeatable on a machine with no history
// and what keeps a person's real work out of a public repository. `guard()` at
// the bottom is the backstop: it scans everything that was written and refuses to
// go on if a name, an address or a secret-shaped string got in.
//
// The projects are real git repositories with real files, so the things that read
// a working tree — the Changes drawer, the dashboard, dev-server detection —
// show real answers. The transcripts apply their edits to those files for the
// same reason (see transcript.js).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');

const { Conversation } = require('./transcript');

const DEMO = path.join(__dirname, 'demo');

/** A stable v4-shaped id for a name, so two runs of the script name sessions alike. */
function uid(name) {
    const h = createHash('sha1').update(`tgxcode-demo:${name}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const GIT_ENV = {
    GIT_AUTHOR_NAME: 'Demo User', GIT_AUTHOR_EMAIL: 'demo@example.invalid',
    GIT_COMMITTER_NAME: 'Demo User', GIT_COMMITTER_EMAIL: 'demo@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd, ...args) {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
        { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function copyTree(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, e.name);
        if (e.isDirectory()) copyTree(src, path.join(to, e.name));
        else fs.copyFileSync(src, path.join(to, e.name));
    }
}

/** A repository with two commits, ignoring the worktrees directory agents work in. */
function makeRepo(dir, name) {
    copyTree(path.join(DEMO, name), dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.claude/worktrees/\n');
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `Start ${name}`);
    fs.appendFileSync(path.join(dir, 'README.md'), '\nMIT licensed.\n');
    git(dir, 'commit', '-q', '-am', 'Mention the licence in the README');
}

/** `<repo>/.claude/worktrees/<name>` on `worktree-<name>`, the way EnterWorktree makes one. */
function makeWorktree(repo, name) {
    const dir = path.join(repo, '.claude', 'worktrees', name);
    git(repo, 'worktree', 'add', '-q', '-b', `worktree-${name}`, dir);
    return { dir, branch: `worktree-${name}` };
}

const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const MIN = 60_000;
const HOUR = 60 * MIN;

// ---------------------------------------------------------------------------

/**
 * Build the world under `ctx.home`, and say what is in it.
 *
 * @param {object} ctx
 * @param {string} ctx.home          the demo user's home directory (already created)
 * @param {string} ctx.stateDir      the bridge's XDG data dir for this run
 * @param {string} ctx.cacheDir      and its cache dir
 * @param {number} ctx.now
 * @param {(url: string, file: string, opts?: object) => Promise<Buffer>} ctx.render
 *        a screenshot of a page, for the pictures a conversation shows
 * @param {(cwd: string, sessionId: string) => Promise<{port: number, stop: Function}>} ctx.serve
 *        run the demo app from a directory as that session's own dev server —
 *        it is attributed the way a real one is, by CLAUDE_CODE_SESSION_ID
 */
async function seed(ctx) {
    const { home, now } = ctx;
    const projectsDir = path.join(home, '.claude', 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    // -- the projects ------------------------------------------------------

    const taskly = path.join(home, 'Projects', 'taskly');
    const weather = path.join(home, 'Projects', 'weather-board');
    makeRepo(taskly, 'taskly');
    makeRepo(weather, 'weather-board');

    const wt = {
        dueDates: makeWorktree(taskly, 'due-dates-4be1f2'),
        flaky: makeWorktree(taskly, 'flaky-filter-test-77c0de'),
        offline: makeWorktree(taskly, 'offline-sync-3a91b8'),
        shortcuts: makeWorktree(taskly, 'keyboard-shortcuts-9d20c4'),
        darkMode: makeWorktree(taskly, 'dark-mode-toggle-e51f07'),
        hourly: makeWorktree(weather, 'hourly-forecast-chart-61ac3e'),
    };

    const id = {
        dueDates: uid('due-dates'), orch: uid('orchestrator'), flaky: uid('flaky'),
        offline: uid('offline'), shortcuts: uid('shortcuts'), darkMode: uid('dark-mode'),
        notes: uid('release-notes'), hourly: uid('hourly'), cache: uid('cache'),
    };

    const saved = [];
    const save = (conv, endedAgo) => saved.push(conv.save(projectsDir, { endAt: now - endedAgo }));

    // -- 1. The conversation the README leads with: due dates --------------

    const c = new Conversation({
        sessionId: id.dueDates, cwd: wt.dueDates.dir, branch: wt.dueDates.branch,
        title: 'Add due dates to tasks', startedAt: 0, mode: 'acceptEdits',
    });

    c.user('Tasks in Taskly need due dates. Let a task take an optional `due` date when it is created, '
        + 'show it as a pill in the list (red once it is overdue), and sort the open list by due date, '
        + 'soonest first. Keep the model pure so it stays testable — and add tests.');
    c.think('The model is src/tasks.js: pure functions over an array, and the server only wires them up. '
        + 'So the shape of the change is: create() learns about due, two new pure helpers (isOverdue and '
        + 'sortByDue), the server passes the field through and sorts on the way out, and the page draws a pill. '
        + 'Dates should be plain YYYY-MM-DD strings rather than timestamps — a due date has no time zone, and '
        + 'comparing strings is enough to sort them. Let me look at the code before changing anything.');
    c.say('I\'ll start by reading the model and the server, then check where tags are rendered so the pill sits beside them.');
    c.read('src/tasks.js');
    c.read('src/server.js', { limit: 40 });
    c.grep('tags', 'public', `${wt.dueDates.dir}/public/app.js:21:        for (const tag of t.tags) {\n`
        + `${wt.dueDates.dir}/public/app.js:22:            const chip = document.createElement('span');`);
    c.todo([
        ['Teach create() about due dates', 'in_progress'],
        ['Add isOverdue and sortByDue to the model', 'pending'],
        ['Pass due through the server and sort on the way out', 'pending'],
        ['Draw the due pill, red when overdue', 'pending'],
        ['Write tests and run the suite', 'pending'],
    ]);

    c.edit('src/tasks.js',
        `function create(title, { tags = [] } = {}) {
    const text = String(title || '').trim();
    if (!text) throw new Error('A task needs a title');`,
        `const DATE = /^\\d{4}-\\d{2}-\\d{2}$/;

function create(title, { tags = [], due = null } = {}) {
    const text = String(title || '').trim();
    if (!text) throw new Error('A task needs a title');
    if (due !== null && !DATE.test(due)) {
        throw new Error('Due dates look like 2026-12-31');
    }`);
    c.edit('src/tasks.js',
        `        tags: tags.map(t => String(t).trim().toLowerCase()).filter(Boolean),
        done: false,`,
        `        tags: tags.map(t => String(t).trim().toLowerCase()).filter(Boolean),
        due,
        done: false,`);
    c.edit('src/tasks.js',
        `module.exports = { create, toggle, remove, filter, summary };`,
        `// Due dates are plain YYYY-MM-DD strings: they have no time zone, and comparing
// them as strings sorts them.
function isOverdue(task, today = new Date().toISOString().slice(0, 10)) {
    return !task.done && task.due !== null && task.due < today;
}

function sortByDue(tasks) {
    return [...tasks].sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        if (a.due === b.due) return a.id - b.id;
        if (a.due === null) return 1;
        if (b.due === null) return -1;
        return a.due < b.due ? -1 : 1;
    });
}

module.exports = { create, toggle, remove, filter, summary, isOverdue, sortByDue };`);
    c.wait(20);

    c.edit('src/server.js',
        `let list = [
    tasks.create('Draft the v1.4 release notes', { tags: ['docs'] }),
    tasks.create('Review the keyboard shortcut PR', { tags: ['review'] }),
    tasks.create('Fix the filter bar on narrow screens', { tags: ['bug', 'ui'] }),
    tasks.create('Add due dates to tasks', { tags: ['feature'] }),
    tasks.create('Set up nightly backups', { tags: ['ops'] }),
    tasks.create('Reply to the feedback thread', { tags: ['review'] }),
];`,
        `const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

let list = [
    tasks.create('Draft the v1.4 release notes', { tags: ['docs'], due: day(1) }),
    tasks.create('Review the keyboard shortcut PR', { tags: ['review'], due: day(-1) }),
    tasks.create('Fix the filter bar on narrow screens', { tags: ['bug', 'ui'], due: day(3) }),
    tasks.create('Add due dates to tasks', { tags: ['feature'], due: day(0) }),
    tasks.create('Set up nightly backups', { tags: ['ops'] }),
    tasks.create('Reply to the feedback thread', { tags: ['review'], due: day(-3) }),
];`);
    c.edit('src/server.js',
        `    if (m && req.method === 'GET' && !m[1]) return json(res, 200, { tasks: list, ...tasks.summary(list) });`,
        `    if (m && req.method === 'GET' && !m[1]) {
        return json(res, 200, { tasks: tasks.sortByDue(list), ...tasks.summary(list) });
    }`);
    c.edit('src/server.js',
        `const t = tasks.create(b.title, { tags: b.tags });`,
        `const t = tasks.create(b.title, { tags: b.tags, due: b.due || null });`);

    c.edit('public/app.js',
        `        li.querySelector('.title').textContent = t.title;`,
        `        li.querySelector('.title').textContent = t.title;
        if (t.due) {
            const pill = document.createElement('span');
            pill.className = 'due' + (isOverdue(t) ? ' late' : '');
            pill.textContent = new Date(t.due + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            li.append(pill);
        }`);
    c.edit('public/app.js',
        `let status = 'all';`,
        `let status = 'all';

// The server sorts; the page only needs to know which dates are in the past.
const isOverdue = (t) => !t.done && t.due < new Date().toISOString().slice(0, 10);`);
    c.edit('public/style.css',
        `.tag { font-size: 12px;`,
        `.due { font-size: 12px; color: var(--muted); background: #eef0f5; padding: 2px 9px; border-radius: 999px; }
.due.late { color: #b4283c; background: #fde8eb; font-weight: 600; }
.tag { font-size: 12px;`);

    c.write('test/due.test.js', `'use strict';

const test = require('node:test');
const assert = require('node:assert');
const tasks = require('../src/tasks');

test('create keeps a due date and defaults to none', () => {
    assert.strictEqual(tasks.create('a').due, null);
    assert.strictEqual(tasks.create('b', { due: '2026-12-31' }).due, '2026-12-31');
});

test('create refuses a malformed due date', () => {
    assert.throws(() => tasks.create('a', { due: 'next friday' }), /look like/);
});

test('isOverdue ignores finished tasks and tasks with no date', () => {
    const t = tasks.create('a', { due: '2026-01-01' });
    assert.strictEqual(tasks.isOverdue(t, '2026-01-02'), true);
    assert.strictEqual(tasks.isOverdue(t, '2026-01-01'), false);
    assert.strictEqual(tasks.isOverdue({ ...t, done: true }, '2026-01-02'), false);
    assert.strictEqual(tasks.isOverdue(tasks.create('b'), '2026-01-02'), false);
});

test('sortByDue puts the soonest first, undated last, finished at the bottom', () => {
    const a = tasks.create('later', { due: '2026-03-01' });
    const b = tasks.create('sooner', { due: '2026-02-01' });
    const c = tasks.create('someday');
    const d = { ...tasks.create('done', { due: '2026-01-01' }), done: true };
    assert.deepStrictEqual(tasks.sortByDue([a, c, d, b]).map(t => t.title), ['sooner', 'later', 'someday', 'done']);
});
`);
    c.todo([
        ['Teach create() about due dates', 'completed'],
        ['Add isOverdue and sortByDue to the model', 'completed'],
        ['Pass due through the server and sort on the way out', 'completed'],
        ['Draw the due pill, red when overdue', 'completed'],
        ['Write tests and run the suite', 'in_progress'],
    ]);
    c.bash('npm test', `✔ create keeps a due date and defaults to none (1.2ms)
✔ create refuses a malformed due date (0.4ms)
✔ isOverdue ignores finished tasks and tasks with no date (0.3ms)
✔ sortByDue puts the soonest first, undated last, finished at the bottom (0.5ms)
✔ create trims the title and lowercases tags (0.2ms)
✔ create refuses an empty title (0.1ms)
✔ filter by status, tag and text (0.2ms)
✔ summary counts open and done (0.2ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0`, { description: 'Run the test suite' });

    // The page, as the change leaves it — a picture the conversation shows and
    // the Images pane collects.
    const app = await ctx.serve(wt.dueDates.dir, id.dueDates);
    const shot = await ctx.render(`http://127.0.0.1:${app.port}/`, 'taskly-due-dates.png', { width: 760, height: 560 });
    c.say('Tests pass. Let me look at it in the browser to check the pills.');
    c.image('Taskly with due-date pills', path.join(wt.dueDates.dir, '.screenshots', 'taskly-due-dates.png'), shot);
    const shotOpen = await ctx.render(`http://127.0.0.1:${app.port}/`, 'taskly-open.png',
        { width: 760, height: 560, click: '[data-status="open"]' });
    c.image('Only the open tasks', path.join(wt.dueDates.dir, '.screenshots', 'taskly-open.png'), shotOpen);

    c.say(`Due dates are in, end to end. Overdue tasks get a red pill and the open list is sorted soonest-first.

**What changed**

| File | Change |
|---|---|
| \`src/tasks.js\` | \`create()\` takes \`due\` (validated as \`YYYY-MM-DD\`); new pure \`isOverdue\` and \`sortByDue\` |
| \`src/server.js\` | \`POST /api/tasks\` passes \`due\` through; \`GET\` returns the list sorted |
| \`public/app.js\`, \`style.css\` | The pill, red when overdue |
| \`test/due.test.js\` | Eight cases across validation, overdue and ordering |

A few decisions worth a glance:

- Dates are **plain strings**, not timestamps. A due date has no time zone, and \`'2026-02-01' < '2026-03-01'\` is all the sort needs.
- Finished tasks sink to the bottom whatever their date, so the top of the list is always what is still open.
- \`isOverdue\` takes \`today\` as an argument, which is what lets the tests pin it instead of racing the clock.

\`\`\`js
tasks.isOverdue(task, '2026-01-02');   // true when due before today and not done
\`\`\`

Everything passes (8/8). Want me to open a pull request?`, { last: true });
    c.wait(60);
    c.user('Yes — open the PR, and add recurring tasks as a follow-up suggestion.');
    c.bash('git add -A && git commit -q -m "Add due dates to tasks" && git push -u origin HEAD', 'branch \'worktree-due-dates-4be1f2\' set up to track \'origin/worktree-due-dates-4be1f2\'.', { description: 'Commit and push' });
    c.bash('gh pr create --fill', 'https://github.com/demo/taskly/pull/42', { description: 'Open the pull request' });
    c.pr(42, 'demo/taskly');
    c.tool('mcp__tgxcode__suggest_session', {
        title: 'Recurring tasks',
        prompt: 'Taskly now has due dates. Add recurring tasks: a task can repeat daily, weekly or monthly, and completing '
            + 'it creates the next one. Keep the recurrence rule a small pure function next to isOverdue, with tests.',
        why: 'Follows from #42 — due dates are the natural base for recurrence.',
    }, 'Suggestion recorded.', { suggested: true });
    c.say('PR #42 is open: https://github.com/demo/taskly/pull/42 — and I filed **Recurring tasks** as a suggested follow-up, with the prompt already written.', { last: true });

    // Committed, so the working tree is clean and the PR is what is left to talk about.
    git(wt.dueDates.dir, 'add', '-A', ':!.screenshots');
    git(wt.dueDates.dir, 'commit', '-q', '-m', 'Add due dates to tasks');
    save(c, 38 * MIN);

    // A note the agent left itself and did not commit: the sort of thing that
    // makes a worktree show as having work in it.
    fs.writeFileSync(path.join(wt.dueDates.dir, 'NOTES.md'),
        '# Follow-ups\n\n- Recurring tasks (filed as a suggestion)\n- Snooze until tomorrow\n');

    // Keep the demo app running from this worktree: it is the dev server the
    // conversation's port chip and the browser preview show.
    const devServer = app;

    // -- 2. The orchestrator ------------------------------------------------

    const workers = [
        { key: 'flaky', title: 'Fix the flaky filter test', wt: wt.flaky, spawnedAgo: 52 * MIN },
        { key: 'offline', title: 'Plan offline sync', wt: wt.offline, spawnedAgo: 47 * MIN },
        { key: 'shortcuts', title: 'Keyboard shortcuts', wt: wt.shortcuts, spawnedAgo: 41 * MIN },
        { key: 'darkMode', title: 'Dark mode toggle', wt: wt.darkMode, spawnedAgo: 130 * MIN },
    ];

    const o = new Conversation({
        sessionId: id.orch, cwd: taskly, title: 'Taskly 1.4 release', startedAt: 0, mode: 'auto',
    });
    o.user('You are the orchestrator for the Taskly 1.4 release. Goal: ship dark mode, keyboard shortcuts and '
        + 'offline sync. Work through the backlog with workers — one worktree each — read what they report, '
        + 'answer their plans, and keep me posted on the merge order. Ask me when a call is mine to make.');
    o.think('Four threads, mostly independent: dark mode is the smallest and should land first; shortcuts touch app.js '
        + 'and will conflict with anything else that does; offline sync needs a plan before anyone writes code. '
        + 'The flaky filter test is blocking CI for all of them, so it goes first.');
    o.say('Starting four workers. The flaky test goes first — it is failing CI for everyone else.');
    for (const w of workers) {
        o.tool('mcp__tgxcode__spawn_worker', { title: w.title, prompt: `${w.title}. Work in your own worktree; open a PR when done.` },
            `Started worker ${id[w.key].slice(0, 8)} in ${w.wt.dir}`, {});
    }
    o.wait(600);
    o.tool('mcp__tgxcode__next_message', {}, 'darkMode: PR #41 is up — theme tokens, a toggle in the header, and the choice persists. Tests pass.', {});
    o.tool('mcp__tgxcode__set_summary', {
        goal: 'Ship Taskly 1.4: dark mode, keyboard shortcuts, offline sync',
        text: 'Dark mode landed (#41). Due dates are in review (#42). Shortcuts is waiting on a permission, offline sync on a plan answer.',
        decisions: ['Should offline sync store tasks in IndexedDB or localStorage?'],
        mergeOrder: [41, 44],
    }, 'Summary updated.', {});
    o.say('Dark mode is merged-ready and due dates are in review. Merge order is 41 → 44; shortcuts will need a rebase once #42 lands.', { last: true });
    save(o, 2 * MIN);

    const workerChats = {
        flaky: () => {
            const w = new Conversation({ sessionId: id.flaky, cwd: wt.flaky.dir, branch: wt.flaky.branch,
                title: 'Fix the flaky filter test', startedAt: 0, mode: 'acceptEdits' });
            w.user('Fix the flaky filter test in Taskly: `filter by status, tag and text` fails about one run in ten on CI. Find out why and fix it properly.');
            w.think('A one-in-ten failure in a test with no I/O smells like shared state or ordering. `create()` uses a module-level `nextId`, '
                + 'so ids depend on which tests ran first — but this test only uses the returned objects. Let me run it in a loop and see.');
            w.say('Reproducing first: running the file fifty times.');
            w.bash('for i in $(seq 50); do node --test test/tasks.test.js >/dev/null 2>&1 || echo "run $i failed"; done',
                'run 17 failed\nrun 33 failed\nrun 41 failed', { description: 'Run the test 50 times' });
            w.read('test/tasks.test.js', { offset: 14, limit: 8 });
            w.say('The test toggles `list[0]` by id — and `toggle` matches on `id`, but two lists built in the same millisecond can share an id counter state across tests. The fix belongs in the test: build its own ids rather than trusting the module counter.');
            w.edit('test/tasks.test.js',
                `    let list = [tasks.create('Write docs', { tags: ['docs'] }), tasks.create('Fix bug', { tags: ['bug'] })];
    list = tasks.toggle(list, list[0].id);`,
                `    const docs = { ...tasks.create('Write docs', { tags: ['docs'] }), id: 1 };
    const bug = { ...tasks.create('Fix bug', { tags: ['bug'] }), id: 2 };
    const list = tasks.toggle([docs, bug], 1);`);
            return w;
        },
        offline: () => {
            const w = new Conversation({ sessionId: id.offline, cwd: wt.offline.dir, branch: wt.offline.branch,
                title: 'Plan offline sync', startedAt: 0, mode: 'plan' });
            w.user('Plan offline sync for Taskly: tasks created offline must reach the server once the connection is back, with no duplicates. Plan only — do not write code yet.');
            w.think('The server owns ids, so an offline-created task needs a client-side temporary id that the server maps on sync. '
                + 'The risk is the double-send when the connection flaps mid-request, so each queued write needs an idempotency key.');
            w.say('I\'ve read the server and the page. The plan is ready for your approval.');
            return w;
        },
        shortcuts: () => {
            const w = new Conversation({ sessionId: id.shortcuts, cwd: wt.shortcuts.dir, branch: wt.shortcuts.branch,
                title: 'Keyboard shortcuts', startedAt: 0, mode: 'default' });
            w.user('Add keyboard shortcuts to Taskly: `n` focuses the new-task box, `j`/`k` move the selection, `x` toggles the selected task, `/` focuses search.');
            w.read('public/app.js', { limit: 30 });
            w.say('Shortcuts are in and tested (PR #44). Rebasing onto main before I push.');
            w.pr(44, 'demo/taskly');
            w.open('Bash', { command: 'git push --force-with-lease origin worktree-keyboard-shortcuts-9d20c4', description: 'Push the rebased branch' });
            return w;
        },
        darkMode: () => {
            const w = new Conversation({ sessionId: id.darkMode, cwd: wt.darkMode.dir, branch: wt.darkMode.branch,
                title: 'Dark mode toggle', startedAt: 0, mode: 'acceptEdits' });
            w.user('Add a dark mode to Taskly with a toggle in the header. Remember the choice between visits.');
            w.edit('public/style.css',
                `:root { --ink: #1d2433; --muted: #7a8296; --line: #e6e9f0; --accent: #4f6bed; --bg: #f5f6fa; }`,
                `:root { --ink: #1d2433; --muted: #7a8296; --line: #e6e9f0; --accent: #4f6bed; --bg: #f5f6fa; --card: #fff; }
:root[data-theme="dark"] { --ink: #e8ebf3; --muted: #8b93a7; --line: #2a3144; --accent: #7b92ff; --bg: #12151d; --card: #1a1f2b; }`);
            w.say('Dark mode is done: theme tokens in the stylesheet, a toggle in the header, and the choice persists in localStorage. PR #41.', { last: true });
            w.pr(41, 'demo/taskly');
            git(wt.darkMode.dir, 'add', '-A');
            git(wt.darkMode.dir, 'commit', '-q', '-m', 'Add a dark mode with a header toggle');
            return w;
        },
    };
    const ended = { flaky: 90_000, offline: 9 * MIN, shortcuts: 4 * MIN, darkMode: 70 * MIN };
    for (const w of workers) {
        const conv = workerChats[w.key]();
        save(conv, ended[w.key]);
    }

    // -- 3. The rest of the rail ---------------------------------------------

    {
        const n = new Conversation({ sessionId: id.notes, cwd: taskly, title: 'Draft the v1.4 release notes',
            startedAt: 0, mode: 'default' });
        n.user('Draft release notes for Taskly 1.4 from the merged pull requests since 1.3.');
        n.bash('git log --oneline v1.3.0..HEAD', 'a1f3c02 Mention the licence in the README\n7be9d41 Start taskly', { description: 'List the commits since 1.3' });
        n.say(`Here is a first draft:

## Taskly 1.4

**New**
- Due dates, with a red pill once a task is overdue
- Dark mode, remembered between visits

**Fixed**
- The flaky filter test that failed one CI run in ten

I left offline sync and keyboard shortcuts out until they land.`, { last: true });
        save(n, 26 * HOUR);
    }
    {
        const h = new Conversation({ sessionId: id.hourly, cwd: wt.hourly.dir, branch: wt.hourly.branch,
            title: 'Hourly forecast chart', startedAt: 0, mode: 'acceptEdits' });
        h.user('Add an hourly temperature chart to the weather board: the next 24 hours, one bar per hour.');
        h.edit('src/forecast.js',
            `module.exports = { describe, daily };`,
            `// The next 24 hours as { hour, temp } pairs, ready to draw as bars.
function hourly(raw, from = 0) {
    return raw.hourly.time.slice(from, from + 24).map((t, i) => ({
        hour: t.slice(11, 16),
        temp: Math.round(raw.hourly.temperature_2m[from + i]),
    }));
}

module.exports = { describe, daily, hourly };`);
        h.say('The hourly series is in `src/forecast.js`. The chart itself is next — I\'d draw it as inline SVG so there is nothing to install.', { last: true });
        h.pr(12, 'demo/weather-board');
        git(wt.hourly.dir, 'add', '-A');
        git(wt.hourly.dir, 'commit', '-q', '-m', 'Add the hourly series');
        fs.appendFileSync(path.join(wt.hourly.dir, 'README.md'), '\n## Hourly view\n\nThe next 24 hours, one bar per hour.\n');
        save(h, 3 * HOUR);
    }
    {
        const k = new Conversation({ sessionId: id.cache, cwd: weather, title: 'Cache API responses',
            startedAt: 0, mode: 'default' });
        k.user('The weather board calls the API on every page load. Add a small in-memory cache with a five minute lifetime.');
        k.edit('src/api.js',
            `async function get(path, params = {}) {
    const url = new URL(BASE + path);`,
            `const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

async function get(path, params = {}) {
    const url = new URL(BASE + path);
    const hit = cache.get(url.href);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;`);
        k.edit('src/api.js',
            `    return res.json();`,
            `    const value = await res.json();
    cache.set(url.href, { at: Date.now(), value });
    return value;`);
        k.say('Responses are now cached for five minutes, keyed by the full URL. The cache is per process, so a restart starts cold — fine for a dashboard.', { last: true });
        git(weather, 'checkout', '-q', '-b', 'cache-api-responses');
        git(weather, 'add', '-A');
        git(weather, 'commit', '-q', '-m', 'Cache API responses for five minutes');
        git(weather, 'checkout', '-q', 'main');
        save(k, 2 * 24 * HOUR + 3 * HOUR);
    }

    // Leave one real uncommitted edit in the flaky-test worktree: it is still working.
    // (The edit above was applied on disk by the transcript and is deliberately not committed.)

    // -- state the bridge keeps ----------------------------------------------

    const stateDir = path.join(ctx.stateDir, 'tgxcode');
    fs.mkdirSync(stateDir, { recursive: true });

    const orchWorkers = workers.map(w => ({
        id: id[w.key], title: w.title, cwd: w.wt.dir,
        worktree: { path: w.wt.dir, branch: w.wt.branch },
        spawnedAt: now - w.spawnedAgo, closedAt: w.key === 'darkMode' ? now - 65 * MIN : null,
        reportedDone: w.key === 'darkMode', origin: null, model: null, effort: null, modelSource: null,
    }));

    const item = (seq, workerId, kind, text, agoMs, extra = {}) => ({
        id: uid(`inbox-${seq}`), workerId, kind, text, at: now - agoMs, seq, status: 'read',
        requestId: null, ask: null, outcome: null, by: null, settledAt: null, ...extra,
    });
    const planText = '# Offline sync\n\n## Approach\n\nQueue writes in the page while offline and replay them in order once the connection is back.\n\n'
        + '- Give every queued write a client-generated idempotency key, so a request that is sent twice is applied once\n'
        + '- A task created offline carries a temporary id; the server maps it to a real one in its response\n'
        + '- Store the queue in IndexedDB — it survives a closed tab, which localStorage does not do for large lists\n\n'
        + '## Out of scope\n\nConflict resolution when two devices edit the same task.';
    const inbox = [
        item(1, id.darkMode, 'turn', 'Theme tokens are in place and the toggle works in the header. Running the suite now.', 118 * MIN),
        item(2, id.darkMode, 'done', 'Dark mode is done — PR #41. The choice persists in localStorage and follows the OS setting on first visit.', 70 * MIN),
        item(3, id.flaky, 'update', 'Reproduced the flaky test (3 failures in 50 runs). It depends on ids handed out by a module-level counter; fixing the test to build its own ids.', 20 * MIN),
        item(4, id.offline, 'plan', planText, 9 * MIN, {
            status: 'new', requestId: 'req-offline-plan',
            ask: { kind: 'plan', tool: 'ExitPlanMode', displayName: 'ExitPlanMode', input: { plan: planText } },
        }),
        item(5, id.shortcuts, 'permission', 'Bash: git push --force-with-lease origin worktree-keyboard-shortcuts-9d20c4', 4 * MIN, {
            status: 'new', requestId: 'req-shortcuts-push',
            ask: { kind: 'permission', tool: 'Bash', displayName: 'Bash',
                input: { command: 'git push --force-with-lease origin worktree-keyboard-shortcuts-9d20c4' } },
        }),
    ];

    const orchestrators = {
        version: 1,
        orchestrators: {
            [id.orch]: {
                id: id.orch, createdAt: now - 3 * HOUR, updatedAt: now - 2 * MIN,
                settings: {
                    maxRunning: 3, worktree: true, orchestratorModel: null, orchestratorEffort: null,
                    workerModel: 'choose', workerEffort: 'choose', workerDefaultModel: null, workerDefaultEffort: null,
                    usageStop: { enabled: true, percent: 90, window: 'all',
                        limits: { five_hour: 90, seven_day: 95, seven_day_opus: null, seven_day_sonnet: null },
                        autoResume: true, autoResumeBy: null },
                },
                paused: null,
                summary: {
                    text: 'Dark mode landed (#41). Due dates are in review (#42). Shortcuts is waiting on a permission, offline sync on a plan answer.',
                    at: now - 2 * MIN,
                    goal: 'Ship Taskly 1.4: dark mode, keyboard shortcuts, offline sync',
                    decisions: [{
                        id: uid('decision-1'), text: 'Should offline sync store tasks in IndexedDB or localStorage?',
                        options: ['IndexedDB', 'localStorage'], workerId: id.offline, at: now - 8 * MIN,
                        answer: null, answeredAt: null,
                    }],
                    mergeOrder: [41, 44],
                },
                workers: orchWorkers, pendingSpawns: [], inbox, seq: 5, lastNudgedSeq: 5, cwdOverride: null,
            },
        },
    };
    fs.writeFileSync(path.join(stateDir, 'orchestrators.json'), JSON.stringify(orchestrators, null, 2));

    // Pull requests, as the bridge would have cached them from GitHub — there is no
    // remote to ask, and the point is what the rail and board do with the answer.
    const pr = (number, title, branch, extra) => ({
        number, title, url: `https://github.com/demo/taskly/pull/${number}`, branch, headSha: uid(`sha-${number}`).replace(/-/g, '').slice(0, 40),
        base: 'main', labels: [], draft: false, reviewDecision: null, author: 'demo', state: 'OPEN', mergeable: 'MERGEABLE',
        createdAt: new Date(now - 3 * HOUR).toISOString(), updatedAt: new Date(now - 20 * MIN).toISOString(),
        mergedAt: null, closedAt: null, ...extra,
    });
    const prs = {
        version: 1,
        repos: {
            'demo/taskly': {
                checkedAt: now, ok: true, error: null, attempts: 0, unknownStreak: 0, baseMovedAt: 0, baseShas: {}, baseCheckedAt: 0,
                pulls: [
                    pr(42, 'Add due dates to tasks', wt.dueDates.branch, { reviewDecision: 'APPROVED', checks: { total: 3, failed: 0, pending: 0, passed: 3 } }),
                    pr(44, 'Keyboard shortcuts', wt.shortcuts.branch, { checks: { total: 3, failed: 0, pending: 1, passed: 2 } }),
                ],
            },
            'demo/weather-board': {
                checkedAt: now, ok: true, error: null, attempts: 0, unknownStreak: 0, baseMovedAt: 0, baseShas: {}, baseCheckedAt: 0,
                pulls: [{ ...pr(12, 'Add the hourly series', wt.hourly.branch, { checks: { total: 3, failed: 1, pending: 0, passed: 2 } }),
                    url: 'https://github.com/demo/weather-board/pull/12' }],
            },
        },
        terminal: {
            'demo/taskly#41': {
                at: now - 65 * MIN,
                pull: pr(41, 'Add a dark mode with a header toggle', wt.darkMode.branch, {
                    state: 'MERGED', mergedAt: new Date(now - 65 * MIN).toISOString(), reviewDecision: 'APPROVED' }),
            },
        },
    };
    fs.mkdirSync(ctx.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.cacheDir, 'prs.json'), JSON.stringify(prs, null, 2));

    // The quota pill: what the status line would have harvested a minute ago.
    const sec = Math.floor(now / 1000);
    fs.writeFileSync(path.join(stateDir, 'quota-statusline.json'), JSON.stringify({
        version: 1,
        windows: {
            five_hour: { used_percentage: 34, resets_at: sec + 2 * 3600 + 14 * 60 },
            seven_day: { used_percentage: 12, resets_at: sec + 4 * 86400 },
        },
        observedAt: { five_hour: sec - 40, seven_day: sec - 40 }, capturedAt: sec - 40,
    }));

    // What the stub `claude` does for the sessions that are meant to be live.
    const stubPlan = {
        [id.flaky]: { kind: 'working', tool: 'Edit', toolUseId: 'toolu_demo_flaky',
            text: 'Fix is in; re-running the loop to be sure it holds.',
            input: { file_path: path.join(wt.flaky.dir, 'test/tasks.test.js'), old_string: 'x', new_string: 'y' } },
        [id.offline]: { kind: 'plan', plan: planText },
        [id.shortcuts]: { kind: 'permission', tool: 'Bash',
            input: { command: 'git push --force-with-lease origin worktree-keyboard-shortcuts-9d20c4', description: 'Push the rebased branch' } },
    };

    // -- the guard -----------------------------------------------------------
    guard([projectsDir, stateDir, ctx.cacheDir, path.join(home, 'Projects')]);

    return { id, wt, taskly, weather, devServer, stubPlan, saved };
}

// ---------------------------------------------------------------------------

/**
 * Nothing real may be in the demo. Scans every file written for the things a
 * public screenshot must never carry, and throws on the first hit.
 *
 * The patterns are the shapes of secrets, contact details and other people's
 * home directories; whatever is specific to the person running this (a project
 * that must stay out of every picture, a hostname) comes from `excluded()`. A false
 * positive here costs a rerun, and a miss costs a leak in a public repository,
 * so the patterns err wide.
 */
const FORBIDDEN = [
    [/\/home\/(?!demo\b)[a-z][\w.-]*\//i, 'a real home directory'],
    [/[\w.+-]+@[\w-]+\.(?!invalid\b)[a-z]{2,}/i, 'an email address'],
    [/\bsk-[A-Za-z0-9_-]{16,}/, 'an API key'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
    [/\bBearer\s+[A-Za-z0-9._-]{20,}/, 'a bearer token'],
    [/\b[0-9a-f]{64}\b/i, 'a token-shaped hex string'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
];

/**
 * Terms that are specific to whoever is running this and so cannot be written in
 * a public repository: the projects, hosts and names that must never appear in a
 * picture. Read from `TGXCODE_SHOTS_EXCLUDE` (comma-separated) and from
 * `~/.cache/tgxcode/screenshots/exclude.txt` (one per line, `#` comments), matched
 * case-insensitively as whole words. Your own username and home directory are
 * always on the list (index.js adds them for the page check; the home directory
 * and any other user's are caught by the patterns above).
 */
function excluded() {
    const terms = (process.env.TGXCODE_SHOTS_EXCLUDE || '').split(',');
    try {
        const file = path.join(process.env.XDG_CACHE_HOME || path.join(require('os').homedir(), '.cache'),
            'tgxcode', 'screenshots', 'exclude.txt');
        terms.push(...fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.trim().startsWith('#')));
    } catch { /* none */ }
    // Whole words only: a short project name is also a few letters that turn up
    // inside ordinary words ("defaultCommand").
    return terms.map(t => t.trim()).filter(Boolean).map(t => [
        new RegExp(`(?<![A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i'),
        `an excluded term (${t.length} characters)`]);
}

/** Every pattern a picture or a seeded file must not match. */
const forbidden = () => [...FORBIDDEN, ...excluded()];

function guard(roots) {
    const hits = [];
    const walk = (p) => {
        let st;
        try { st = fs.lstatSync(p); } catch { return; }
        if (st.isSymbolicLink()) return;
        if (st.isDirectory()) {
            if (path.basename(p) === '.git') return;
            for (const e of fs.readdirSync(p)) walk(path.join(p, e));
            return;
        }
        if (st.size > 8 * 1024 * 1024) return;
        let text;
        try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
        // A picture's base64 is long and random enough to look like a token.
        const scan = text.replace(/"data":"[A-Za-z0-9+/=]{200,}"/g, '"data":"…"');
        for (const [re, why] of forbidden()) {
            const m = re.exec(scan);
            if (m) hits.push(`${p}: ${why} (${JSON.stringify(m[0].slice(0, 40))})`);
        }
    };
    roots.forEach(walk);
    if (hits.length) {
        throw new Error(`The demo data contains something it must not:\n  ${hits.join('\n  ')}`);
    }
}

module.exports = { seed, guard, uid, FORBIDDEN, forbidden };
