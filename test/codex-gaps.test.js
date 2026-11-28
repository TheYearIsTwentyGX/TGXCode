'use strict';

// The parts of the app that read a transcript beside the conversation view, on a
// Codex rollout — docs/plans/23-codex.md, *Parity at a glance*.
//
//   bridge/search-index.js   `GET /api/search` finds what was said in a rollout
//   bridge/spend-index.js    tokens from `token_usage_record`, never dollars
//   bridge/image-index.js    attached images and what a tool showed the model
//   bridge/sessions.js       `archived_sessions/` indexed, and shown as archived
//
// Each of these used to read a rollout with Claude's parser, find nothing and say
// nothing, which looks exactly like a session with nothing to find. So every case
// asserts that something was found, and what.
//
// No bridge and no Codex: the rollouts are the ones recorded against 0.172.0 in
// test/fixtures/codex/ (`images` was recorded for this), copied under the names
// Codex gives them into directories of the test's own.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-codex-gaps-'));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});
const PROJECTS = path.join(TMP, 'projects');
const SESSIONS = path.join(TMP, 'codex', 'sessions');
const ARCHIVED = path.join(TMP, 'codex', 'archived_sessions');
const DAY = path.join(SESSIONS, '2026', '11', '26');
for (const d of [PROJECTS, DAY, ARCHIVED]) fs.mkdirSync(d, { recursive: true });
process.env.TGXCODE_PROJECTS_DIR = PROJECTS;
process.env.TGXCODE_CODEX_SESSIONS_DIR = SESSIONS;
process.env.XDG_CACHE_HOME = path.join(TMP, 'cache');
process.env.XDG_DATA_HOME = path.join(TMP, 'data');

const { SessionIndex } = require('../bridge/sessions');
const { Flags } = require('../bridge/flags');
const { SearchIndex, search } = require('../bridge/search-index');
const { SpendIndex, rollup } = require('../bridge/spend-index');
const { TurnIndex } = require('../bridge/turn-index');
const reader = require('../bridge/runtimes/codex/transcript');

const FIX = path.join(__dirname, 'fixtures', 'codex');
const linesOf = (name) => fs.readFileSync(path.join(FIX, `${name}.rollout.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
const idOf = (name) => linesOf(name).find(e => e.type === 'session_meta').payload.id;

/** Put a recording where Codex would, in `dir`, optionally rewritten. */
function install(name, dir = DAY, { edit = null, zst = false } = {}) {
    const id = idOf(name);
    let text = fs.readFileSync(path.join(FIX, `${name}.rollout.jsonl`), 'utf8');
    // The recordings' directories are under /tmp, which the lists leave out.
    text = text.replace(/\/tmp\/codex-fixture-/g, '/work/codex-fixture-');
    if (edit) text = edit(text);
    const file = path.join(dir, `rollout-2026-11-26T12-00-00-${id}.jsonl${zst ? '.zst' : ''}`);
    fs.writeFileSync(file, zst ? zlib.zstdCompressSync(Buffer.from(text)) : text);
    return { id, file };
}

let pass = 0;
const ok = (what) => { pass++; console.log(`  ok  ${what}`); };

(async () => {
    const images = install('images');
    const command = install('command-approval');
    const parent = install('subagent.0');
    const child = install('subagent.1');
    const archived = install('plain', ARCHIVED);

    const flags = new Flags();
    const index = new SessionIndex(flags);
    await index.rescan();

    // --- archived threads ---------------------------------------------------------------------------
    {
        const row = () => index.list({ includeTest: true }).find(s => s.sessionId === archived.id);
        assert.ok(row(), 'a rollout in archived_sessions/ is a session');
        assert.strictEqual(row().archived, true);
        assert.strictEqual(index.summary(images.id).archived, false);
        assert.ok(index.read(archived.id).events.some(e => e.kind === 'user'), 'and it reads');
        ok('a thread in archived_sessions/ is listed, as archived');

        flags.set(archived.id, { pinned: true });
        assert.strictEqual(row().archived, false, 'pinned is not archived');
        flags.set(archived.id, { pinned: false });
        assert.strictEqual(row().archived, true, 'unpinned, Codex still has it archived');
        flags.set(archived.id, { archived: false });
        assert.strictEqual(row().archived, false, 'restoring it here takes');
        assert.ok(fs.existsSync(archived.file), 'without moving Codex\'s file');
        flags.set(archived.id, { archived: true });
        assert.strictEqual(row().archived, true);
        flags.set(archived.id, { archived: false });
        ok('it can be restored and filed again without touching Codex\'s store');

        // `codex unarchive`, then `codex archive` again.
        const live = path.join(DAY, path.basename(archived.file));
        fs.renameSync(archived.file, live);
        await index.rescan();
        assert.strictEqual(row().archived, false);
        assert.strictEqual(flags.isRestored(archived.id), false, 'the restore is forgotten once Codex lets go');
        fs.renameSync(live, archived.file);
        await index.rescan();
        assert.strictEqual(row().archived, true, 'so archiving it again counts');
        ok('a later archive by Codex is not outvoted by an earlier restore');
    }

    // --- search -------------------------------------------------------------------------------------
    {
        const sidx = new SearchIndex(path.join(TMP, 'search'));
        const find = (q, kinds) => search(sidx, index.searchCandidates({ includeTest: true }),
            { q, kinds, budgetMs: 10_000 });

        const said = find('view_image tool', ['user']);
        const hit = said.sessions.find(s => s.sessionId === images.id);
        assert.ok(hit, 'what you typed is found');
        assert.strictEqual(hit.runtime, 'codex');
        assert.deepStrictEqual({ ...hit.agent }, { name: 'Codex', product: 'Codex' });
        // The turn is the turn rail's: same id, same offset.
        const mark = new TurnIndex(path.join(TMP, 'turns'))
            .update(images.id, images.file, { runtime: 'codex' }).marks.find(m => m.kind === 'turn');
        assert.strictEqual(hit.hits[0].turnId, mark.id);
        assert.strictEqual(hit.hits[0].turnOffset, mark.offset);
        assert.strictEqual(hit.hits[0].turnNo, 1);
        ok('a message is found, on the turn the rail marks');

        const reply = find('"red blue"', ['assistant']).sessions.find(s => s.sessionId === images.id);
        assert.ok(reply, 'what Codex said is found');
        const events = index.read(images.id).events;
        assert.ok(events.some(e => e.id === reply.hits[0].eventId), 'with the event id the transcript uses');
        const tool = find('touch made-by-codex', ['tool']).sessions.find(s => s.sessionId === command.id);
        assert.ok(tool, 'a command is found when tools are asked for');
        assert.strictEqual(find('environment_context', ['user']).sessions.length, 0, 'the harness is not');
        ok('replies and commands are found, the harness\'s messages are not');

        assert.ok(find('pong', ['user']).sessions.some(s => s.sessionId === archived.id));
        ok('an archived thread is searched, as an archived Claude session is');

        // An index written when rollouts were read with Claude's parser.
        const old = new SearchIndex(path.join(TMP, 'search-old'));
        const size = fs.statSync(images.file).size;
        const made = old.update(images.id, images.file);
        delete made.codex;
        Object.assign(made, { turns: [], docs: [], consumed: size });
        assert.strictEqual(old.stale(images.id, images.file), true);
        assert.ok(old.update(images.id, images.file).docs.length, 'is rebuilt');
        ok('an index left empty by the old reader is rebuilt');

        if (reader.CAN_ZSTD) {
            const dir = path.join(TMP, 'zst');
            fs.mkdirSync(dir);
            const z = install('images', dir, { zst: true });
            const zs = new SearchIndex(path.join(TMP, 'search-zst'));
            assert.ok(zs.update('z', z.file).docs.length);
            assert.strictEqual(zs.stale('z', z.file), false, 'and is not forever behind its compressed size');
            ok('a compressed rollout is searched');
        }
    }

    // --- spend --------------------------------------------------------------------------------------
    {
        const spend = new SpendIndex({ cacheFile: path.join(TMP, 'spend.json') });
        await spend.refresh(index);
        const records = (name) => {
            const id = idOf(name);
            return linesOf(name).filter(e => e.type === 'token_usage_record' && e.payload.thread_id === id)
                .map(e => e.payload.usage);
        };
        const total = (list) => list.reduce((n, u) => n + u.input_tokens + u.output_tokens, 0);

        const one = spend.forSession(index, command.id);
        assert.strictEqual(one.priced, false);
        assert.strictEqual(one.totals.messages, records('command-approval').length);
        assert.strictEqual(one.totals.tokens, total(records('command-approval')));
        const cached = records('command-approval').reduce((n, u) => n + u.cached_input_tokens, 0);
        assert.strictEqual(one.totals.cacheRead, cached);
        assert.strictEqual(one.totals.input + one.totals.cacheRead + one.totals.cacheWrite + one.totals.output,
            one.totals.tokens, 'cached input is not counted twice');
        assert.strictEqual(one.totals.costUsd, 0);
        assert.strictEqual(one.totals.unpricedTokens, one.totals.tokens);
        ok('a Codex session counts its tokens, and prices none of them');

        const family = spend.forSession(index, parent.id);
        assert.strictEqual(family.totals.tokens,
            total(records('subagent.0')) + total(records('subagent.1')));
        assert.strictEqual(spend.forSession(index, child.id), null, 'an agent is not a session');
        ok('a spawned agent\'s tokens are its parent\'s, once');

        const r = rollup(spend.entries(index, { includeTest: true }), {
            days: 30, now: Date.parse('2026-11-30T12:00:00Z'),
        });
        assert.strictEqual(r.totals.tokens, 0, 'nothing of Codex\'s is in Claude\'s figures');
        assert.strictEqual(r.unpricedTokens, 0);
        assert.deepStrictEqual(r.projects, []);
        assert.ok(r.codex.totals.tokens > 0);
        assert.strictEqual(r.codex.totals.costUsd, 0);
        assert.ok(r.codex.sessions.some(s => s.sessionId === command.id));
        assert.deepStrictEqual(r.codex.models.map(m => m.model), ['gpt-6-luna']);
        assert.strictEqual(rollup([], { days: 7 }).codex, null);
        ok('the board keeps Codex apart, and says null with none');

        const before = spend.forSession(index, command.id).totals.tokens;
        fs.appendFileSync(command.file, linesOf('command-approval')
            .filter(e => e.type === 'token_usage_record').map(e => JSON.stringify(e)).join('\n') + '\n');
        await spend.refreshSession(index, command.id);
        assert.strictEqual(spend.forSession(index, command.id).totals.tokens, before);
        ok('a response written twice counts once');
    }

    // --- images -------------------------------------------------------------------------------------
    {
        const list = index.images(images.id, key => `/img/${key}`);
        assert.strictEqual(list.length, 2);
        const mine = list.find(i => i.source === 'user');
        const looked = list.find(i => i.source === 'tool');
        assert.strictEqual(mine.label, 'Your message');
        assert.deepStrictEqual([mine.width, mine.height], [24, 24]);
        assert.deepStrictEqual([looked.width, looked.height], [32, 32]);
        assert.strictEqual(looked.label, 'looked-at.png');
        assert.strictEqual(looked.count, 1, 'the item beside the output is not a second copy');
        ok('an attached image and one a tool looked at are both listed');

        const events = index.read(images.id).events;
        const you = events.find(e => e.kind === 'user');
        assert.strictEqual(mine.occurrences[0].anchor.id, you.id);
        const row = events.find(e => e.kind === 'tool' && e.name === 'view_image');
        assert.deepStrictEqual([looked.toolUseId, looked.n], [row.id, 0]);
        assert.deepStrictEqual([looked.occurrences[0].anchor.kind, looked.occurrences[0].anchor.id],
            ['tool', row.id]);
        ok('each jumps to the row that shows it');

        for (const i of list) assert.strictEqual(index.imageBytes(images.id, i.key).data.length, i.bytes);
        assert.strictEqual(index.toolImage(images.id, row.id, 0).data.length, looked.bytes);
        assert.strictEqual(index.toolImage(images.id, row.id, 1), null);
        ok('the bytes come back, by key and by tool call');

        assert.strictEqual(you.images.length, 1);
        assert.ok(!/<\/?image/.test(you.text), `Codex's tags are not your words: ${you.text}`);
        assert.ok(you.text.startsWith('Use your view_image tool'));
        assert.ok(!/<image/.test(index.summary(images.id).lastPrompt));
        ok('the tags Codex wraps an attachment in are not part of the message');

        if (reader.CAN_ZSTD) {
            const { ImageIndex } = require('../bridge/image-index');
            const dir = path.join(TMP, 'zst-images');
            fs.mkdirSync(dir);
            const z = install('images', dir, { zst: true });
            const imageIndex = new ImageIndex(path.join(TMP, 'images-zst'));
            const idx = imageIndex.update('z', z.file);
            const keys = Object.keys(idx.images);
            assert.strictEqual(keys.length, 2);
            assert.ok(keys.every(k => imageIndex.bytes(idx, k)));
            ok('a compressed rollout\'s images are read');
        }
    }

    console.log(`\ncodex-gaps: ${pass} passed`);
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
