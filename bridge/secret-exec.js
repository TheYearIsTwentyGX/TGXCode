'use strict';

// Runs a Bash command with secrets in its environment, and keeps them out of
// what comes back. bridge/secret-hook.js rewrites a command that mentions one
// into
//
//     '<node>' '<bridge>/secret-exec.js' TEST_KEY -- '<the command>'
//
// and this is that. bridge/secrets.js has the design and its limits.
//
// 1. **Fetch** the values from the bridge, over loopback, with the token off
//    disk — the way bridge/mcp.js reaches it. The port is TGXCODE_SECRETS_PORT,
//    which bridge/runner.js puts in every session's environment. A bridge that
//    is restarting is waited for, briefly.
// 2. **Refuse rather than guess.** A name that is not set, or a bridge that never
//    answers, stops here with a sentence on stderr and exit 1. Running the
//    command anyway would run it with `$KEY` empty, and `rm -rf "$DIR/"` or an
//    unauthenticated request is what that looks like.
// 3. **Run** it as `bash -c`, the values exported, so they are never spliced into
//    the command text and quoting cannot go wrong. The cost is a child shell: a
//    `cd` in it, or a function Claude Code's shell snapshot defined, does not
//    carry over to the next Bash call.
// 4. **Redact** stdout and stderr as they stream, each value and the forms it is
//    most often printed in — URL-encoded, base64 (both alphabets, any
//    alignment, so `base64 <<< "user:$KEY"` is caught), hex — becoming
//    `[secret:NAME]`. A value split across two reads is still caught: the last
//    few bytes of each read are held back until the next one.
//
// The exit code is the command's, and a signal is passed on to it.

const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

// ── redaction ─────────────────────────────────────────────────────────────

/** Forms of a value shorter than this are not redacted: they match too much. */
const MIN_DERIVED = 8;
/** And a derived form shorter than this is not used, for the same reason. */
const MIN_NEEDLE = 6;

const toUrlSafe = (s) => s.replace(/\+/g, '-').replace(/\//g, '_');

/**
 * The base64 characters that encode `value` whatever its offset in a longer
 * input: for each of the three alignments, only the four-character groups made
 * entirely of the value's own bytes.
 */
function base64Cores(value) {
    const out = [];
    for (let k = 0; k < 3; k++) {
        const b64 = Buffer.concat([Buffer.alloc(k), value]).toString('base64');
        const first = Math.ceil(k / 3);
        const last = Math.floor((k + value.length) / 3);   // exclusive
        if (last > first) out.push(b64.slice(first * 4, last * 4));
    }
    return out;
}

/** Every byte string that stands for this value in output. */
function formsOf(value) {
    const raw = Buffer.from(value);
    const forms = new Set([value]);
    if (raw.length >= MIN_DERIVED) {
        forms.add(encodeURIComponent(value));
        const b64 = raw.toString('base64');
        for (const s of [b64, b64.replace(/=+$/, ''), ...base64Cores(raw)]) {
            forms.add(s);
            forms.add(toUrlSafe(s));
        }
        forms.add(raw.toString('hex'));
        forms.add(raw.toString('hex').toUpperCase());
    }
    return [...forms].filter(f => f === value || f.length >= MIN_NEEDLE).map(f => Buffer.from(f));
}

/**
 * A streaming find-and-replace over bytes. `push` returns what is safe to
 * write now; `end` returns the rest. Longest match first, so a value that
 * contains another secret is replaced whole.
 */
class Redactor {
    /** @param {Record<string, string>} values name → value */
    constructor(values) {
        this.needles = [];
        for (const [name, value] of Object.entries(values)) {
            const label = Buffer.from(`[secret:${name}]`);
            for (const bytes of formsOf(value)) if (bytes.length) this.needles.push({ bytes, label });
        }
        this.needles.sort((a, b) => b.bytes.length - a.bytes.length);
        this.byFirst = new Map();
        for (const n of this.needles) {
            const k = n.bytes[0];
            if (!this.byFirst.has(k)) this.byFirst.set(k, []);
            this.byFirst.get(k).push(n);
        }
        this.max = this.needles.length ? this.needles[0].bytes.length : 1;
        this.carry = Buffer.alloc(0);
    }

    push(chunk) { return this._run(Buffer.concat([this.carry, chunk]), false); }

    end() { return this._run(this.carry, true); }

    _run(buf, final) {
        const out = [];
        // A match starting at or after `limit` might run past what has arrived.
        const limit = final ? buf.length : Math.max(0, buf.length - this.max + 1);
        let last = 0;
        let i = 0;
        scan: while (i < limit) {
            const cands = this.byFirst.get(buf[i]);
            if (cands) {
                for (const n of cands) {
                    const end = i + n.bytes.length;
                    if (end <= buf.length && buf.compare(n.bytes, 0, n.bytes.length, i, end) === 0) {
                        if (i > last) out.push(buf.subarray(last, i));
                        out.push(n.label);
                        i = end;
                        last = end;
                        continue scan;
                    }
                }
            }
            i++;
        }
        const keep = Math.max(last, limit);
        if (keep > last) out.push(buf.subarray(last, keep));
        this.carry = Buffer.from(buf.subarray(keep));
        return Buffer.concat(out);
    }
}

// ── the wrapper ───────────────────────────────────────────────────────────

const say = (line) => process.stderr.write(`TGXCode: ${line}\n`);
const RETRY_MS = 20_000;

function parseArgs(argv) {
    const dash = argv.indexOf('--');
    if (dash < 1 || dash !== argv.length - 2) return null;
    const names = argv.slice(0, dash);
    if (!names.every(n => /^[A-Z][A-Z0-9_]*$/.test(n))) return null;
    return { names, command: argv[dash + 1] };
}

function fetchValues(names, { port, token, cwd, sessionId }) {
    const body = Buffer.from(JSON.stringify({ cwd, names, sessionId }));
    return new Promise((resolve) => {
        const req = http.request({
            host: '127.0.0.1', port, method: 'POST', path: '/api/secrets/resolve',
            headers: {
                Authorization: `Bearer ${token}`,
                'X-TGXCode-Client': '1',
                'Content-Type': 'application/json',
                'Content-Length': body.length,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* below */ }
                resolve({ status: res.statusCode, body: parsed || {} });
            });
            res.on('error', () => resolve({ status: 0, body: {} }));
        });
        req.on('error', () => resolve({ status: 0, body: {} }));
        req.end(body);
    });
}

async function resolveWithRetry(names, opts) {
    const started = Date.now();
    for (;;) {
        const r = await fetchValues(names, opts);
        if (r.status !== 0 || Date.now() - started > RETRY_MS) return r;
        await new Promise(res => setTimeout(res, 1000));
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args) {
        say('usage: secret-exec.js NAME [NAME…] -- <command>');
        process.exit(2);
    }
    const port = Number(process.env.TGXCODE_SECRETS_PORT);
    if (!Number.isInteger(port) || port <= 0) {
        say('this session was not started by TGXCode, so it has no secrets to use. Not run.');
        process.exit(1);
    }
    let token;
    try {
        token = fs.readFileSync(require('./config').TOKEN_FILE, 'utf8').trim();
    } catch {
        say('could not read the TGXCode access token. Not run.');
        process.exit(1);
    }

    const r = await resolveWithRetry(args.names, {
        port, token, cwd: process.cwd(), sessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
    });
    if (r.status === 0) {
        say('could not reach TGXCode to fetch the secrets this command uses. Not run.');
        process.exit(1);
    }
    if (r.status !== 200 || !r.body.values) {
        const missing = Array.isArray(r.body.missing) ? r.body.missing : [];
        say(missing.length
            ? `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set for this project. `
                + 'Ask for it with request_secret. Not run.'
            : `TGXCode refused the secrets: ${r.body.error || `HTTP ${r.status}`}. Not run.`);
        process.exit(1);
    }
    const values = r.body.values;

    const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    const child = spawn(shell, ['-c', args.command], {
        env: { ...process.env, ...values },
        stdio: ['inherit', 'pipe', 'pipe'],
    });
    for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
        const red = new Redactor(values);
        from.on('data', (c) => { const out = red.push(c); if (out.length) to.write(out); });
        from.on('end', () => { const out = red.end(); if (out.length) to.write(out); });
    }
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
    }
    child.on('error', (err) => { say(`could not start ${shell}: ${err.message}`); process.exit(1); });
    // 'close', not 'exit': the streams have been drained by then.
    child.on('close', (code, signal) => {
        const status = signal ? 128 + (require('os').constants.signals[signal] || 1) : (code ?? 1);
        const done = () => process.exit(status);
        // Let the last redacted bytes reach the pipe before exiting.
        if (process.stdout.writableNeedDrain) process.stdout.once('drain', done);
        else setImmediate(done);
    });
}

if (require.main === module) main();

module.exports = { Redactor, formsOf, base64Cores, parseArgs };
