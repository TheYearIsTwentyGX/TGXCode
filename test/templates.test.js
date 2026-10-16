'use strict';

// The template store and its placeholder helpers, with no bridge.
//
// **XDG_DATA_HOME is set before the require**, which is drafts.test.js's rule and
// for its reason: config.js reads it once to build STATE_DIR, and the everyday
// bridge reads the real templates.json.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-templates-'));
process.env.XDG_DATA_HOME = home;

const {
    Templates, STATE_FILE, MAX_TEMPLATES,
    matchesProject, projectOf, scanTemplate, fillTemplate, worktreeSlug, localDate,
} = require('../bridge/templates');

assert.ok(STATE_FILE.startsWith(home),
    `refusing to run: STATE_FILE is ${STATE_FILE}, outside the throwaway ${home}`);

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

function fresh() {
    try { fs.unlinkSync(STATE_FILE); } catch { /* first run */ }
    return new Templates();
}

// ── the store ────────────────────────────────────────────────────────────

{
    const t = fresh();
    const a = t.create({ name: '  Review  ', prompt: 'Review {{branch}}', permissionMode: 'plan',
        worktree: { name: '{{task}}', base: '' }, orchestrator: true, test: true, title: 'ignored' });
    assert.strictEqual(a.name, 'Review');
    assert.strictEqual(a.cwd, null);
    assert.strictEqual(a.project, null);
    assert.deepStrictEqual(a.worktree, { name: '{{task}}', base: null });
    assert.strictEqual(a.orchestrator, true);
    assert.strictEqual(a.test, true);
    assert.ok(!('title' in a), 'a key the store does not know is not kept');
    ok('create keeps the template fields and nothing else');

    const b = t.create({ name: 'Second', project: '/x/proj/' });
    assert.strictEqual(b.project, '/x/proj');
    assert.deepStrictEqual(t.list().map(r => r.name), ['Second', 'Review']);
    ok('project is normalised and the list is newest first');

    const p = t.update(a.id, { model: 'opus' });
    assert.strictEqual(p.model, 'opus');
    assert.strictEqual(p.prompt, 'Review {{branch}}');
    assert.strictEqual(p.orchestrator, true);
    assert.ok(p.updatedAt > a.updatedAt);
    t.update(a.id, { worktree: null });
    assert.strictEqual(t.get(a.id).worktree, null);
    ok('a patch is partial, and null clears');

    const listed = t.list();
    listed[0].worktree = { name: 'mutated' };
    assert.notDeepStrictEqual(t.get(listed[0].id).worktree, { name: 'mutated' });
    ok('list hands out copies');

    assert.strictEqual(t.update('nope', { name: 'x' }), null);
    assert.strictEqual(t.remove('nope'), false);
    assert.strictEqual(t.remove(b.id), true);
    assert.strictEqual(t.get(b.id), null);
    ok('unknown ids are null/false; remove removes');

    t.flush();
    const again = new Templates();
    assert.deepStrictEqual(again.list(), t.list());
    ok('a flushed store survives a reload');
}

{
    // The bridge flushes on every shutdown, and every dev and test bridge shares
    // this file, so one that changed nothing must not create it.
    fresh().flush();
    assert.ok(!fs.existsSync(STATE_FILE));
    ok('a flush with nothing changed writes nothing');
}

{
    const t = fresh();
    for (let i = 0; i < MAX_TEMPLATES; i++) t.rows.push({ id: String(i), name: 'n', updatedAt: 0 });
    assert.strictEqual(t.create({ name: 'one too many' }), null);
    ok('the cap refuses with null');
}

{
    fresh();
    fs.writeFileSync(STATE_FILE, '{not json');
    assert.deepStrictEqual(new Templates().list(), []);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 99, templates: [{ id: 'a', name: 'x' }] }));
    assert.deepStrictEqual(new Templates().list(), []);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 1, templates: [
        { id: 'a', name: 'kept', worktree: { name: '' }, prompt: 5 },
        { id: 'b' }, { name: 'no id' }, null,
    ] }));
    const rows = new Templates().list();
    assert.deepStrictEqual(rows.map(r => r.id), ['a']);
    assert.strictEqual(rows[0].worktree, null);
    assert.strictEqual(rows[0].prompt, '');
    ok('a bad file, a newer version and bad rows are tolerated');
}

{
    // Two bridges over one file: each keeps the other's rows, and a deletion
    // carries.
    fresh();
    const one = new Templates();
    const two = new Templates();
    const a = one.create({ name: 'from one' });
    one.flush();
    const b = two.create({ name: 'from two' });
    two.flush();
    const both = new Templates().list().map(r => r.name).sort();
    assert.deepStrictEqual(both, ['from one', 'from two']);

    one.load();
    one.remove(b.id);
    one.flush();
    assert.deepStrictEqual(new Templates().list().map(r => r.id), [a.id]);

    // A stale copy cannot roll back a newer edit.
    const stale = new Templates();
    const fresher = new Templates();
    fresher.update(a.id, { name: 'renamed' });
    fresher.flush();
    stale.flush();
    assert.strictEqual(new Templates().get(a.id).name, 'renamed');
    ok('merge-on-write keeps both bridges, carries deletes, and newer wins');
}

// ── scoping ──────────────────────────────────────────────────────────────

{
    const global = { project: null };
    const proj = { project: '/home/u/repo' };
    assert.ok(matchesProject(global, null));
    assert.ok(matchesProject(global, '/anywhere'));
    assert.ok(matchesProject(proj, '/home/u/repo'));
    assert.ok(matchesProject(proj, '/home/u/repo/sub'));
    assert.ok(matchesProject(proj, '/home/u/repo/.claude/worktrees/feat'));
    assert.ok(matchesProject(proj, '/home/u/repo/.claude/worktrees/feat/web'));
    assert.ok(!matchesProject(proj, '/home/u/repo2'));
    assert.ok(!matchesProject(proj, '/home/u/other'));
    assert.ok(!matchesProject(proj, null));
    assert.strictEqual(projectOf('/home/u/repo/.claude/worktrees/x'), '/home/u/repo');
    // A template scoped to one worktree applies there and not in its siblings.
    const wt = { project: '/home/u/repo/.claude/worktrees/a' };
    assert.ok(matchesProject(wt, '/home/u/repo/.claude/worktrees/a'));
    assert.ok(!matchesProject(wt, '/home/u/repo/.claude/worktrees/b'));
    ok('matchesProject: global, prefix, worktrees, and non-matches');
}

// ── placeholders ─────────────────────────────────────────────────────────

{
    const s = scanTemplate({ prompt: 'On {{ branch }}: {{task}} ({{date}}) {{task}}',
        worktree: { name: '{{ticket}}-{{task}}' } });
    assert.deepStrictEqual(s.builtins, ['branch', 'date']);
    assert.deepStrictEqual(s.asks, ['task', 'ticket']);
    assert.deepStrictEqual(scanTemplate({ prompt: '' }), { builtins: [], asks: [] });
    ok('scanTemplate splits built-ins from questions, once each');

    assert.strictEqual(fillTemplate('Fix {{task}} on {{ branch }}', { task: 'login', branch: 'main' }),
        'Fix login on main');
    assert.strictEqual(fillTemplate('Fix {{task}} {{other}}', { task: '' }), 'Fix {{task}} {{other}}');
    assert.strictEqual(fillTemplate('{{constructor}}', {}), '{{constructor}}');
    assert.strictEqual(fillTemplate('{ {x} } {{x y}}', { x: 1 }), '{ {x} } {{x y}}');
    ok('fillTemplate fills what it has and leaves the rest verbatim');

    assert.strictEqual(worktreeSlug('Fix the Login redirect!'), 'fix-the-login-redirect');
    assert.strictEqual(worktreeSlug('--.hidden..name--'), 'hidden.name');
    assert.strictEqual(worktreeSlug('x'.repeat(80)).length, 60);
    assert.strictEqual(worktreeSlug('{{task}}'), null);
    assert.strictEqual(worktreeSlug('   '), null);
    assert.strictEqual(worktreeSlug('thing.lock'), 'thing');
    const { nameProblem } = require('../bridge/worktree');
    for (const n of ['Fix the Login redirect!', '--.hidden..name--', 'a b/c', 'v1.2']) {
        assert.strictEqual(nameProblem(worktreeSlug(n)), null, `${n} slugs to an accepted name`);
    }
    ok('worktreeSlug makes names bridge/worktree.js accepts');

    assert.match(localDate(new Date(2026, 0, 5)), /^2026-01-05$/);
    ok('localDate is YYYY-MM-DD');
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`templates: ${pass} passed`);
