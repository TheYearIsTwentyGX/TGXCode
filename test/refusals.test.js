'use strict';

// What a remote caller holding a valid token may and may not do.
//
//   node refusal-test.js [port]

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.argv[2] || 45901);
const TOKEN = fs.readFileSync(
    path.join(os.homedir(), '.local/share/claude-sessions/token'), 'utf8').trim();

const LOCAL = { authorization: `Bearer ${TOKEN}`, 'X-Claude-Sessions-Client': '1' };
// A phone behind `tailscale serve`.
const PHONE = {
    ...LOCAL,
    'x-forwarded-for': '100.88.1.2',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'tgdylanh.tail1234.ts.net',
};

/**
 * The attachments route takes raw bytes rather than JSON, so it needs its own caller.
 * Deliberately close to `call` below rather than folded into it: one body encoding per
 * function keeps the JSON path — every other route in this suite — unchanged.
 */
function upload(p, { headers, bytes, type = 'image/png' } = {}) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: p, method: 'POST',
            headers: { ...headers, 'Content-Type': type, 'Content-Length': payload.length },
        }, (res) => {
            const c = [];
            res.on('data', (x) => c.push(x));
            res.on('end', () => {
                const text = Buffer.concat(c).toString('utf8');
                let parsed = null;
                try { parsed = JSON.parse(text); } catch { /* html or empty */ }
                resolve({ status: res.statusCode, body: parsed, text });
            });
        });
        // A refused upload is answered and then hung up on, deliberately — see
        // refuseUpload in bridge/server.js. So the write end dies with EPIPE while the
        // body is still going out, and that is the correct outcome rather than a
        // failure: the answer has already arrived. Swallowed on the socket as well as
        // the request, because once the response has ended node stops forwarding
        // socket errors to the request and an unhandled one takes the process down.
        req.on('error', () => {});
        req.on('socket', (sock) => sock.on('error', () => {}));
        req.write(payload);
        req.end();
    });
}

function call(method, p, { headers, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: p, method,
            headers: {
                ...headers,
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
            },
        }, (res) => {
            const c = [];
            res.on('data', (x) => c.push(x));
            res.on('end', () => {
                const text = Buffer.concat(c).toString('utf8');
                let parsed = null;
                try { parsed = JSON.parse(text); } catch { /* html or empty */ }
                resolve({ status: res.statusCode, body: parsed, text });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

let fails = 0;
function check(name, got, want) {
    const okay = got === want;
    if (!okay) fails++;
    console.log(`  ${okay ? 'ok  ' : 'FAIL'} ${name} — got ${got}, want ${want}`);
}

const HOME = os.homedir();

(async () => {
    console.log('\n--- routes a phone may not reach ---');
    check('terminals stream', (await call('GET', '/api/terminals/x/stream', { headers: PHONE })).status, 403);
    check('terminals input', (await call('POST', '/api/terminals/x/input', { headers: PHONE, body: {} })).status, 403);
    check('shutdown', (await call('POST', '/api/shutdown', { headers: PHONE })).status, 403);
    // Both methods. The refusal has to land before the body is read, or a phone
    // could pull a checkout it is refused the restart of.
    check('restart', (await call('POST', '/api/restart', { headers: PHONE, body: {} })).status, 403);
    check('restart journal', (await call('GET', '/api/restart', { headers: PHONE })).status, 403);
    check('devservers stop', (await call('POST', '/api/devservers/stop', { headers: PHONE, body: { port: 1 } })).status, 403);
    check('devbrowser status', (await call('GET', '/api/devbrowser/status', { headers: PHONE })).status, 403);
    check('reveal', (await call('POST', '/api/sessions/abc/reveal', { headers: PHONE, body: {} })).status, 403);
    check('mkdir', (await call('POST', '/api/fs/mkdir', {
        headers: PHONE, body: { parent: HOME, name: 'x' },
    })).status, 403);
    // Same argument as mkdir: attaching a file writes it into a checkout. Refused
    // before the name or the session id is looked at, so this holds for any of them.
    check('attaching a file', (await upload('/api/sessions/abc/attachments?name=x.png', {
        headers: PHONE, bytes: 'x',
    })).status, 403);
    // The cwd-addressed upload is the same refusal for the same reason, and it
    // needs its own case: the clause it used to be covered by is a regex on
    // /api/sessions/:id/attachments, which this path does not match. Without this
    // assertion a future prefix rule could take one and leave the other.
    check('attaching a file by path', (await upload(`/api/attachments?cwd=${encodeURIComponent(HOME)}&name=x.png`, {
        headers: PHONE, bytes: 'x',
    })).status, 403);
    check('opening an attachment', (await call('POST', '/api/sessions/abc/attachments/open', {
        headers: PHONE, body: { path: 'x.png' },
    })).status, 403);
    // A handoff starts a turn in a session nobody is looking at, and can wake one
    // that has no process at all. Refused before the session id is looked at, so
    // a leaked token cannot even find out which ids are real this way.
    check('handing work to a session', (await call('POST', '/api/sessions/abc/handoff', {
        headers: PHONE, body: { text: 'do this' },
    })).status, 403);
    check('runs list', (await call('GET', '/api/runs', { headers: PHONE })).status, 403);
    check('runs stream', (await call('GET', '/api/runs/x/stream', { headers: PHONE })).status, 403);
    check('runs input', (await call('POST', '/api/runs/x/input', { headers: PHONE, body: {} })).status, 403);
    check('starting a project command', (await call('POST', '/api/commands/run', {
        headers: PHONE, body: { cwd: HOME, id: 'dev' },
    })).status, 403);
    // The same asymmetry as /api/fs below: what a project *declares* is in its
    // repository already, so reading it from a phone gives away nothing. Running
    // it is reaching past the app into the machine.
    check('reading what a project declares', (await call('GET',
        `/api/commands?cwd=${encodeURIComponent(HOME)}`, { headers: PHONE })).status, 200);
    // The asymmetry that decision rests on: reading the tree stays allowed, and
    // this is the line that pins it. A phone may already start a session, so it
    // may see where one could start; writing to the filesystem is the other side.
    check('listing home from a phone', (await call('GET',
        `/api/fs?path=${encodeURIComponent(HOME)}`, { headers: PHONE })).status, 200);

    console.log('\n--- and the same routes from the desk ---');
    // Not 403: they may fail for their own reasons (404, 409), but the gate must
    // not be what stops them.
    const localTerm = await call('GET', '/api/terminals/nope/stream', { headers: LOCAL });
    check('terminals locally is not a refusal', localTerm.status === 403, false);
    const localDb = await call('GET', '/api/devbrowser/status', { headers: LOCAL });
    check('devbrowser locally is not a refusal', localDb.status === 403, false);
    // 404 rather than 403: the gate lets it through and it fails on its own
    // terms, which is the distinction being tested.
    check('a run locally reaches its own not-found',
        (await call('GET', '/api/runs/nope', { headers: LOCAL })).status, 404);

    console.log('\n--- handing work to a session ---');
    // From the desk the gate lets it through, and it then fails on its own terms.
    // Each of these is a refusal a *model* reads, so the wording is checked too:
    // one that only says 404 leaves it with nothing to do but retry.
    const noSuch = await call('POST', '/api/sessions/nope/handoff', {
        headers: LOCAL, body: { from: 'me', text: 'the API changed' },
    });
    check('an id that names nothing', noSuch.status, 404);
    check('and says where to get a real one',
        /list_sessions/.test((noSuch.body && noSuch.body.error) || ''), true);
    // Checked before the lookup, so the answer cannot be used to ask which ids
    // are real — the same rule /send follows for permission modes.
    check('handing work to yourself', (await call('POST', '/api/sessions/abc/handoff', {
        headers: LOCAL, body: { from: 'abc', text: 'x' },
    })).status, 400);
    const empty = await call('POST', '/api/sessions/abc/handoff', {
        headers: LOCAL, body: { from: 'me', text: '   ' },
    });
    check('nothing to say', empty.status, 400);
    // No attachment escape hatch here, unlike /send: a screenshot with nothing
    // typed under it is a message somebody sent, and a handoff nobody wrote is
    // just a woken session with no idea why.
    check('and no session lookup happened first',
        /text is required/.test((empty.body && empty.body.error) || ''), true);
    // The one route in this file where the addressable list matters: it must be
    // reachable, or the tool that finds a recipient has nothing to call.
    check('the addressable list is readable locally',
        (await call('GET', '/api/sessions/addressable?limit=1', { headers: LOCAL })).status, 200);

    console.log('\n--- permission modes ---');
    const bypass = await call('POST', '/api/sessions', {
        headers: PHONE, body: { cwd: HOME, prompt: 'x', permissionMode: 'bypassPermissions' },
    });
    check('bypassPermissions remotely', bypass.status, 403);
    console.log(`       said: ${bypass.body && bypass.body.error}`);
    check('dontAsk remotely', (await call('POST', '/api/sessions', {
        headers: PHONE, body: { cwd: HOME, prompt: 'x', permissionMode: 'dontAsk' },
    })).status, 403);
    check('escalating an existing session by sending', (await call('POST', '/api/sessions/abc/send', {
        headers: PHONE, body: { text: 'x', permissionMode: 'bypassPermissions' },
    })).status, 403);
    // The same request from the desk must get past the mode check — it then fails
    // at "session not found", which is the point: a different error.
    const localSend = await call('POST', '/api/sessions/abc/send', {
        headers: LOCAL, body: { text: 'x', permissionMode: 'bypassPermissions' },
    });
    check('bypassPermissions locally is allowed through the gate', localSend.status, 404);

    // A draft carries a mode, so it is a second way to ask for one — and it is
    // asked twice, once when the draft is written and once when it is started.
    // Refusing only at the start would let a phone stash a mode it cannot run,
    // which is a draft that exists to fail; refusing only at the write would let
    // one saved at the desk be started from the phone, which is the actual hole.
    console.log('\n--- permission modes on a draft ---');
    const draftBypass = await call('POST', '/api/drafts', {
        headers: PHONE, body: { cwd: HOME, prompt: 'x', permissionMode: 'bypassPermissions' },
    });
    check('saving a bypassPermissions draft remotely', draftBypass.status, 403);
    console.log(`       said: ${draftBypass.body && draftBypass.body.error}`);
    check('saving a dontAsk draft remotely', (await call('POST', '/api/drafts', {
        headers: PHONE, body: { cwd: HOME, prompt: 'x', permissionMode: 'dontAsk' },
    })).status, 403);
    check('escalating a draft by editing it remotely', (await call('PATCH', '/api/drafts/abc', {
        headers: PHONE, body: { permissionMode: 'bypassPermissions' },
    })).status, 403);

    // The one that matters: a draft saved at the desk, started from the phone.
    // Made locally so it really exists, so the 403 can only be the mode check at
    // start time rather than a 404 standing in for it.
    const saved = await call('POST', '/api/drafts', {
        headers: LOCAL,
        body: { cwd: HOME, prompt: 'never started', permissionMode: 'bypassPermissions',
            test: true },
    });
    check('saving that draft from the desk is allowed', saved.status, 200);
    const savedId = saved.body && saved.body.draft && saved.body.draft.id;
    check('starting it from the phone is refused', (await call(
        'POST', `/api/drafts/${savedId}/start`, { headers: PHONE })).status, 403);
    // Still there — a refused start must not consume the draft.
    const after = await call('GET', '/api/drafts', { headers: LOCAL });
    check('and the refused draft is still on the board',
        (after.body.drafts || []).some(d => d.id === savedId), true);
    check('tidied up', (await call('DELETE', `/api/drafts/${savedId}`,
        { headers: LOCAL })).status, 200);

    // Reading and writing drafts is otherwise a phone's business: setting work up
    // at the desk and releasing it from a phone is the case they exist for.
    check('a phone may read drafts', (await call('GET', '/api/drafts',
        { headers: PHONE })).status, 200);
    const phoneDraft = await call('POST', '/api/drafts', {
        headers: PHONE, body: { cwd: HOME, prompt: 'from a phone', test: true },
    });
    check('and may save an ordinary one', phoneDraft.status, 200);
    if (phoneDraft.body && phoneDraft.body.draft) {
        check('and delete it again', (await call('DELETE',
            `/api/drafts/${phoneDraft.body.draft.id}`, { headers: PHONE })).status, 200);
    }
    check('an unknown draft is a 404, not a refusal', (await call('DELETE',
        '/api/drafts/nope', { headers: LOCAL })).status, 404);

    // The same rule on a schedule, where the stakes are higher and the second
    // gate is different. A draft in a refused mode still needs somebody to press
    // Start, and that somebody is checked in turn — which is why refusing the
    // write and the start is enough there. A schedule's second gate is a *timer*,
    // and the timer is always local, so refusing the write alone leaves a hole:
    // a phone that cannot save `dontAsk` could still send `{enabled: true}` to a
    // paused schedule that already had it, and the tick would start it.
    console.log('\n--- permission modes on a schedule ---');
    const CRON = '0 2 * * 2-6';
    const schedBypass = await call('POST', '/api/schedules', {
        headers: PHONE,
        body: { cwd: HOME, prompt: 'x', cron: CRON, permissionMode: 'bypassPermissions' },
    });
    check('saving a bypassPermissions schedule remotely', schedBypass.status, 403);
    console.log(`       said: ${schedBypass.body && schedBypass.body.error}`);
    check('saving a dontAsk schedule remotely', (await call('POST', '/api/schedules', {
        headers: PHONE, body: { cwd: HOME, prompt: 'x', cron: CRON, permissionMode: 'dontAsk' },
    })).status, 403);
    check('escalating a schedule by editing it remotely', (await call(
        'PATCH', '/api/schedules/abc',
        { headers: PHONE, body: { permissionMode: 'bypassPermissions' } })).status, 403);

    // The one that matters, and the one that was wrong: a dontAsk schedule saved
    // at the desk and paused, then armed from the phone. The body carries no
    // mode at all, so a check that only looks at what was sent lets it through
    // and the next tick starts an unattended agent with no permission gate.
    const armed = await call('POST', '/api/schedules', {
        headers: LOCAL,
        body: { cwd: HOME, prompt: 'never armed', cron: CRON,
            permissionMode: 'dontAsk', enabled: false, test: true },
    });
    check('saving that schedule from the desk is allowed', armed.status, 200);
    const armedId = armed.body && armed.body.schedule && armed.body.schedule.id;
    check('arming it from the phone is refused', (await call(
        'PATCH', `/api/schedules/${armedId}`,
        { headers: PHONE, body: { enabled: true } })).status, 403);
    check('and so is retiming it', (await call(
        'PATCH', `/api/schedules/${armedId}`,
        { headers: PHONE, body: { cron: '*/5 * * * *' } })).status, 403);
    check('and running it now', (await call(
        'POST', `/api/schedules/${armedId}/run`, { headers: PHONE })).status, 403);
    // None of that may have taken effect.
    const stillOff = await call('GET', '/api/schedules', { headers: LOCAL });
    const row = (stillOff.body.schedules || []).find(s => s.id === armedId);
    check('the schedule is still paused', row && row.enabled, false);
    check('and still on its original expression', row && row.cron, CRON);
    check('tidied up', (await call('DELETE', `/api/schedules/${armedId}`,
        { headers: LOCAL })).status, 200);

    // Otherwise a phone may manage schedules, for the reason it may manage
    // drafts: setting work up from anywhere is the case they exist for.
    check('a phone may read schedules', (await call('GET', '/api/schedules',
        { headers: PHONE })).status, 200);
    const phoneSched = await call('POST', '/api/schedules', {
        headers: PHONE,
        body: { cwd: HOME, prompt: 'from a phone', cron: CRON, test: true },
    });
    check('and may save an ordinary one', phoneSched.status, 200);
    if (phoneSched.body && phoneSched.body.schedule) {
        check('and delete it again', (await call('DELETE',
            `/api/schedules/${phoneSched.body.schedule.id}`, { headers: PHONE })).status, 200);
    }
    check('an unknown schedule is a 404, not a refusal', (await call('DELETE',
        '/api/schedules/nope', { headers: LOCAL })).status, 404);
    // An expression that parses and never fires is refused rather than saved as a
    // card that reads "next run: never" forever.
    const impossible = await call('POST', '/api/schedules', {
        headers: LOCAL, body: { cwd: HOME, prompt: 'x', cron: '0 0 30 2 *', test: true },
    });
    check('February 30th is refused', impossible.status, 400);
    console.log(`       said: ${impossible.body && impossible.body.error}`);

    // The second gate kind. A pull-request gate fans out to one unattended session
    // per PR, so the mode refusal matters at least as much here as on a branch one.
    console.log('\n--- the pull-request gate ---');
    const prRemote = await call('POST', '/api/schedules', {
        headers: PHONE,
        body: { cwd: HOME, prompt: 'x', cron: CRON, permissionMode: 'dontAsk',
            gate: { kind: 'open-prs' } },
    });
    check('a dontAsk PR schedule remotely', prRemote.status, 403);
    // A directory with no GitHub origin has no pull requests to watch, and saying
    // so now beats a card that reports "nothing new" every night forever. $HOME is
    // not a checkout, so this is the case.
    const noOrigin = await call('POST', '/api/schedules', {
        headers: LOCAL,
        body: { cwd: HOME, prompt: 'x', cron: CRON, test: true,
            gate: { kind: 'open-prs' } },
    });
    check('a PR gate on a directory with no origin', noOrigin.status, 400);
    console.log(`       said: ${noOrigin.body && noOrigin.body.error}`);
    // An unknown kind is still refused, and the message now names both.
    const badKind = await call('POST', '/api/schedules', {
        headers: LOCAL,
        body: { cwd: HOME, prompt: 'x', cron: CRON, test: true,
            gate: { kind: 'phase-of-moon' } },
    });
    check('an unknown gate kind', badKind.status, 400);
    check('and the message names both supported kinds',
        /git-commits/.test(String(badKind.body && badKind.body.error))
        && /open-prs/.test(String(badKind.body && badKind.body.error)), true);

    console.log('\n--- cwd roots ---');
    const etc = await call('POST', '/api/sessions', {
        headers: LOCAL, body: { cwd: '/etc', prompt: 'x' },
    });
    check('starting a session in /etc', etc.status, 400);
    console.log(`       said: ${etc.body && etc.body.error}`);
    check('a near-miss prefix is not inside the root', (await call('POST', '/api/sessions', {
        headers: LOCAL, body: { cwd: `${HOME}-evil`, prompt: 'x' },
    })).status, 400);
    check('listing /etc', (await call('GET', '/api/fs?path=/etc', { headers: LOCAL })).status, 403);
    // Same rule, same reason: a directory no session may start in is one whose
    // slash commands are nobody's business either, and the route takes a path.
    check('slash commands for /etc', (await call('GET', '/api/slash-commands?cwd=/etc',
        { headers: LOCAL })).status, 403);
    check('slash commands for home', (await call('GET',
        `/api/slash-commands?cwd=${encodeURIComponent(HOME)}`, { headers: LOCAL })).status, 200);
    // Naming neither is a bad request, not an empty answer — the two parameters
    // are the whole interface.
    check('slash commands with no target', (await call('GET', '/api/slash-commands',
        { headers: LOCAL })).status, 400);
    // And the same rule again for the upload that takes a path. A directory no
    // session may start in is not one a file may be written into either.
    check('attaching into /etc', (await upload('/api/attachments?cwd=/etc&name=x.png',
        { headers: LOCAL, bytes: 'x' })).status, 403);
    check('attaching with no directory', (await upload('/api/attachments?name=x.png',
        { headers: LOCAL, bytes: 'x' })).status, 400);
    // The name is checked before the directory is looked at, so a request that is
    // wrong about both is refused for the name. Worth pinning: the other order
    // hides the refusal that actually mattered behind an unrelated one.
    check('a traversing name beats a bad directory',
        (await upload('/api/attachments?cwd=/etc&name=../evil.png',
            { headers: LOCAL, bytes: 'x' })).status, 400);
    // A path that exists but is not a directory. The session form cannot reach
    // this — the bridge chose that path — and this form can, because a caller
    // typed it.
    check('attaching into a file rather than a directory',
        (await upload(`/api/attachments?cwd=${encodeURIComponent(`${HOME}/.bashrc`)}&name=x.png`,
            { headers: LOCAL, bytes: 'x' })).status, 400);
    check('listing home', (await call('GET', `/api/fs?path=${encodeURIComponent(HOME)}`, { headers: LOCAL })).status, 200);
    const home = await call('GET', `/api/fs?path=${encodeURIComponent(HOME)}`, { headers: LOCAL });
    check('and home reports no parent to climb to', home.body.parent, null);
    // The breadcrumb needs these to know where the trail stops.
    check('and reports the roots it is bounded by', Array.isArray(home.body.roots), true);
    check('a tilde is expanded rather than resolved against cwd',
        (await call('GET', '/api/fs?path=~', { headers: LOCAL })).body.path, HOME);

    console.log('\n--- making a folder ---');
    // The only test in this suite that writes to disk. It creates one directory
    // under $HOME — it has to be inside a root, so os.tmpdir() is not an option —
    // and removes it again in the finally below.
    const made = `${HOME}/cs-mkdir-test-${process.pid}`;
    try {
        const first = await call('POST', '/api/fs/mkdir', {
            headers: LOCAL, body: { parent: HOME, name: `cs-mkdir-test-${process.pid}` },
        });
        check('creating one', first.status, 200);
        check('says it created it', first.body && first.body.created, true);
        check('and hands back the path', first.body && first.body.path, made);

        const again = await call('POST', '/api/fs/mkdir', {
            headers: LOCAL, body: { parent: HOME, name: `cs-mkdir-test-${process.pid}` },
        });
        check('creating it twice is not an error', again.status, 200);
        check('but it says it made nothing', again.body && again.body.created, false);
    } finally {
        try { fs.rmdirSync(made); } catch { /* never created */ }
    }

    check('a slash in the name', (await call('POST', '/api/fs/mkdir', {
        headers: LOCAL, body: { parent: HOME, name: '../evil' },
    })).status, 400);
    check('a dotted name the picker could not show', (await call('POST', '/api/fs/mkdir', {
        headers: LOCAL, body: { parent: HOME, name: '.hidden' },
    })).status, 400);
    check('no name at all', (await call('POST', '/api/fs/mkdir', {
        headers: LOCAL, body: { parent: HOME, name: '  ' },
    })).status, 400);
    const outside = await call('POST', '/api/fs/mkdir', {
        headers: LOCAL, body: { parent: '/etc', name: 'x' },
    });
    check('a parent outside the roots', outside.status, 403);
    console.log(`       said: ${outside.body && outside.body.error}`);
    check('a parent that is a file', (await call('POST', '/api/fs/mkdir', {
        headers: LOCAL, body: { parent: `${HOME}/.bashrc`, name: 'x' },
    })).status, 400);

    console.log('\n--- attaching a file ---');
    // Nothing here needs a live session: every one of these is refused before the
    // session id is resolved, which is itself the thing being pinned. A name refused
    // for its own reasons must not come back as "session not found" — that hides the
    // refusal that mattered behind an unrelated one.
    const attachPath = '/api/sessions/abc/attachments';
    const traversal = await upload(`${attachPath}?name=${encodeURIComponent('../evil.png')}`, {
        headers: LOCAL, bytes: 'x',
    });
    check('a separator in the name', traversal.status, 400);
    console.log(`       said: ${traversal.body && traversal.body.error}`);
    check('a bare dot-dot', (await upload(`${attachPath}?name=..`, {
        headers: LOCAL, bytes: 'x',
    })).status, 400);
    check('no name at all', (await upload(attachPath, { headers: LOCAL, bytes: 'x' })).status, 400);
    // The one place this deliberately differs from folderNameProblem: nothing browses
    // attached_assets, so a dotfile is a reasonable thing to drag onto a composer. It
    // gets past the name check and fails on the session instead.
    check('a dotfile is allowed through the name check',
        (await upload(`${attachPath}?name=.env`, { headers: LOCAL, bytes: 'x' })).status, 404);
    // 413 and not the 500 that readJson's own cap produces through the catch-all.
    // Declared up front, so it is refused before the bytes travel.
    const big = await upload(`${attachPath}?name=big.bin`, {
        headers: LOCAL, bytes: Buffer.alloc(26 * 1024 * 1024), type: 'application/octet-stream',
    });
    check('a file over the cap', big.status, 413);
    console.log(`       said: ${big.body && big.body.error}`);
    check('a name for a session that does not exist',
        (await upload(`${attachPath}?name=x.png`, { headers: LOCAL, bytes: 'x' })).status, 404);
    check('opening one for a session that does not exist',
        (await call('POST', `${attachPath}/open`, {
            headers: LOCAL, body: { path: 'x.png' },
        })).status, 404);

    console.log('\n--- what a phone may still do ---');
    check('read sessions', (await call('GET', '/api/sessions?limit=1', { headers: PHONE })).status, 200);
    check('read the board', (await call('GET', '/api/overview', { headers: PHONE })).status, 200);
    check('answer an ask (404 = no such session, not refused)',
        (await call('POST', '/api/sessions/abc/permission', {
            headers: PHONE, body: { requestId: 'x', decision: 'allow' },
        })).status, 404);
    check('start an ordinary session (reaches its own validation)',
        (await call('POST', '/api/sessions', { headers: PHONE, body: { cwd: HOME } })).status, 400);

    console.log(fails ? `\n${fails} FAILED` : '\nall passed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
