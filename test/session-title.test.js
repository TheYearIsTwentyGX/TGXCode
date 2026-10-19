'use strict';

// The name a session is started with: `title` on `POST /api/sessions`, and a
// draft's own title on `POST /api/drafts/:id/start`.
//
// The two routes driven directly with a stub pool, so nothing spawns `claude` —
// what is under test is which flags the new id ends up with, not the process.
// The flags and drafts stores are the real ones, because "a later rename still
// wins" is a property of the store and is the half of this that matters.
//
// **XDG_DATA_HOME before the require**, for the reason test/drafts.test.js
// gives: bridge/config.js builds STATE_DIR once, at load, and the real
// flags.json is the user's.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-session-title-'));
process.env.XDG_DATA_HOME = home;

const { Flags, STATE_FILE, TITLE_MAX } = require('../bridge/flags');
const { Drafts } = require('../bridge/drafts');
const sessionsRoute = require('../bridge/routes/sessions');
const draftsRoute = require('../bridge/routes/drafts');

assert.ok(STATE_FILE.startsWith(home),
    `refusing to run: STATE_FILE is ${STATE_FILE}, outside the throwaway ${home}`);

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const LOCAL = { remote: false, peer: 'test', host: null };
const flags = new Flags();
const drafts = new Drafts();
const created = [];
let n = 0;
const deps = {
    CREATE_LIMIT: { max: 8 },
    drafts,
    flags,
    index: { note() {} },
    modeRefusal: () => null,
    normalizeMode: (m) => m || 'plan',
    pool: {
        create(opts) {
            const sessionId = opts.sessionId || `s${++n}`;
            created.push({ ...opts, sessionId });
            return { sessionId, status: { state: 'idle' } };
        },
    },
    sessionCwd: () => null,
    slashCommands: null,
    tooManyCreates: () => false,
};
sessionsRoute.init(deps);
draftsRoute.init(deps);

/** Drive one route as the server would, and read back the JSON it sent. */
async function call(route, method, pathname, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    let status = 0;
    let payload = '';
    const res = {
        writeHead(s) { status = s; },
        end(b) { payload = b ? b.toString() : ''; },
    };
    const url = new URL(`http://127.0.0.1${pathname}`);
    const seg = pathname.split('/').filter(Boolean);
    await route.handle(req, res, url, pathname, seg, LOCAL);
    return { status, body: payload ? JSON.parse(payload) : null };
}

const CWD = home;

(async () => {
    {
        const r = await call(sessionsRoute, 'POST', '/api/sessions',
            { cwd: CWD, prompt: 'hello', title: '  Fix   the\texport  ', test: true });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const f = flags.get(r.body.sessionId);
        assert.strictEqual(f.title, 'Fix the export', 'cleaned the way a rename is');
        assert.strictEqual(f.test, true, 'test still set beside it');
        ok('a title names the session, cleaned, alongside test');

        // Renaming afterwards is the same flag, so it simply wins; clearing it
        // hands the session back to the name Claude gives it.
        flags.set(r.body.sessionId, { title: 'Renamed' });
        assert.strictEqual(flags.get(r.body.sessionId).title, 'Renamed');
        flags.set(r.body.sessionId, { title: null });
        assert.strictEqual(flags.get(r.body.sessionId).title, null);
        ok('a later rename replaces it, and a clear removes it');
    }

    for (const title of [undefined, null, '', '   ']) {
        const r = await call(sessionsRoute, 'POST', '/api/sessions',
            { cwd: CWD, prompt: 'hello', title });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(flags.get(r.body.sessionId),
            { pinned: false, archived: false, test: false, title: null },
            `no flag at all for ${JSON.stringify(title)}`);
    }
    ok('absent, null or blank: no name, so the session names itself');

    {
        const r = await call(sessionsRoute, 'POST', '/api/sessions',
            { cwd: CWD, prompt: 'hello', title: 'x'.repeat(500) });
        assert.strictEqual(flags.get(r.body.sessionId).title.length, TITLE_MAX);
        ok(`capped at ${TITLE_MAX} characters`);
    }

    {
        const before = created.length;
        for (const title of [42, ['a'], { a: 1 }, true]) {
            const r = await call(sessionsRoute, 'POST', '/api/sessions',
                { cwd: CWD, prompt: 'hello', title });
            assert.strictEqual(r.status, 400, `refused ${JSON.stringify(title)}`);
            assert.strictEqual(r.body.error, 'title must be a string');
        }
        assert.strictEqual(created.length, before, 'nothing started');
        ok('a title that is not a string is a 400 and starts nothing');
    }

    {
        const named = drafts.create({ cwd: CWD, prompt: 'from a draft', title: 'Draft name' });
        const r = await call(draftsRoute, 'POST', `/api/drafts/${named.id}/start`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(flags.get(r.body.sessionId).title, 'Draft name');
        assert.strictEqual(drafts.get(named.id), null, 'and the draft is consumed');

        const plain = drafts.create({ cwd: CWD, prompt: 'unnamed draft', test: true });
        const p = await call(draftsRoute, 'POST', `/api/drafts/${plain.id}/start`);
        assert.deepStrictEqual(flags.get(p.body.sessionId),
            { pinned: false, archived: false, test: true, title: null });
        ok('starting a draft uses its title, and an unnamed one still names itself');
    }

    clearTimeout(flags._saveTimer);
    clearTimeout(drafts._saveTimer);
    fs.rmSync(home, { recursive: true, force: true });
    console.log(`\n${pass} groups passed`);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
