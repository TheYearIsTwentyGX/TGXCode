'use strict';

// Keeping the machine awake while an agent is working.
//
// When Windows sleeps, WSL is frozen with it, and so is every `claude` turn the
// bridge is running — a turn left to run over lunch is found an hour later at the
// tool call it was on when the screen locked. `power.keepAwake` (bridge/prefs.js)
// asks the bridge to hold off sleep while anything is busy, and this module is the
// holding.
//
// **In the bridge, not the Electron shell.** Electron has `powerSaveBlocker`, but
// an `app/main.js` change needs a rebuild the user has to run, and the blocker
// lives only as long as the window does — while the turns it would be protecting
// live in the bridge and the session host, with or without a window.
//
// **One child process is the lock.** Neither host lets a process take the lock on
// another's behalf, so the lock is held by a child that does nothing else, and
// releasing it is ending that child:
//
//   - Under WSL, `powershell.exe` P/Invokes SetThreadExecutionState with
//     ES_CONTINUOUS | ES_SYSTEM_REQUIRED. System only, not ES_DISPLAY_REQUIRED:
//     the screen still turns off, which is what someone walking away wants.
//     Windows drops the request when the process exits.
//   - On a Linux host, `systemd-inhibit --what=sleep:idle --mode=block`. Without
//     it there is nothing to do, and `/api/health` says so rather than claiming
//     a lock it does not have.
//
// **The stdin loop is the watchdog, and it is load-bearing.** Measured on this
// machine rather than assumed: SIGKILL the Node parent of a `powershell.exe` and
// the Windows process carries on, holding the lock, with nothing left that knows
// it exists. (A normal kill() of the child is fine — ending the Linux-side interop
// pid ends the Windows process.) So both commands block on reading stdin, which is
// a pipe from this process: when the bridge dies by any means, the kernel closes
// the pipe, the read returns EOF, and the child exits on its own. `cat` rather
// than `sleep infinity` under systemd-inhibit is the same watchdog on Linux. Do
// not replace either with a plain sleep — it reads as tidier and leaks a lock on
// every crash.
//
// **A linger, so the lock does not flap.** A conversation is turn, pause, turn,
// and sleep timers on Windows are minutes long anyway, so the lock is held for
// LINGER_MS after the last turn ends. Turning the setting off releases at once.
//
// The deps are injectable so test/keepawake.test.js can drive acquire, linger and
// release with a stub spawn and a fake clock, and assert on what gets spawned for
// each host kind.

const fs = require('fs');
const os = require('os');
const { spawn: realSpawn } = require('child_process');
const { hostKind: realHostKind } = require('./platform');

const LINGER_MS = 2 * 60 * 1000;
// After a child dies by itself while it should be holding, how long before the
// next try. A broken powershell must not become a process spawned every status
// event.
const RETRY_MS = 60 * 1000;

// ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1).
const PS_SCRIPT = [
    '$sig = \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);\';',
    '$k = Add-Type -MemberDefinition $sig -Name KeepAwake -Namespace TGXCode -PassThru;',
    '[void]$k::SetThreadExecutionState([uint32]2147483649);',
    // The watchdog: returns null when the bridge's end of the pipe closes.
    'while ($null -ne [Console]::In.ReadLine()) { }',
].join(' ');

function findInhibit() {
    for (const dir of String(process.env.PATH || '').split(':').concat(['/usr/bin', '/bin'])) {
        if (!dir) continue;
        try {
            fs.accessSync(`${dir}/systemd-inhibit`, fs.constants.X_OK);
            return true;
        } catch { /* next */ }
    }
    return false;
}

/**
 * What to run to hold the lock on this host, or `{unsupported}` when nothing can.
 * Pure, so the tests can ask it for either host from either machine.
 */
function command(kind, hasInhibit) {
    if (kind === 'wsl') {
        return { bin: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT] };
    }
    if (!hasInhibit) return { unsupported: 'systemd-inhibit not found' };
    // The reason is fixed text on purpose. It is an argv element, not shell
    // text, so it needs no escaping, and a count in it would go stale the moment
    // a second turn started — re-spawning to correct a label is not worth a gap
    // in the lock. The live count is in /api/health.
    return {
        bin: 'systemd-inhibit',
        args: ['--what=sleep:idle', '--who=TGXCode', '--why=Agents are working',
            '--mode=block', 'cat'],
    };
}

class KeepAwake {
    constructor(deps = {}) {
        this.spawn = deps.spawn || realSpawn;
        this.now = deps.now || Date.now;
        this.setTimeout = deps.setTimeout || setTimeout;
        this.clearTimeout = deps.clearTimeout || clearTimeout;
        this.hostKind = deps.hostKind || realHostKind;
        this.hasInhibit = deps.hasInhibit || findInhibit;
        this.lingerMs = deps.lingerMs || LINGER_MS;

        this.enabled = false;
        this.child = null;
        this.since = null;
        this.reason = null;
        this.linger = null;
        this.lingerUntil = null;
        this.unsupported = null;
        this.error = null;
        this.retryAt = 0;
    }

    /**
     * Called with the current answer whenever it may have changed. Idempotent:
     * the same answer twice does nothing, so callers can call it as often as
     * they like.
     */
    update({ enabled, working, reason = null }) {
        this.enabled = !!enabled;
        if (!this.enabled) {
            this._release();
            this.error = null;
            return;
        }
        if (working) {
            this.reason = reason;
            this._cancelLinger();
            if (!this.child) this._acquire();
            return;
        }
        if (this.child && !this.linger) {
            this.reason = 'finishing up';
            this.lingerUntil = this.now() + this.lingerMs;
            this.linger = this.setTimeout(() => {
                this.linger = null;
                this._release();
            }, this.lingerMs);
            if (this.linger && this.linger.unref) this.linger.unref();
        }
    }

    _acquire() {
        if (this.now() < this.retryAt) return;
        const cmd = command(this.hostKind(), this.hasInhibit());
        if (cmd.unsupported) {
            this.unsupported = cmd.unsupported;
            return;
        }
        this.unsupported = null;
        let child;
        try {
            child = this.spawn(cmd.bin, cmd.args, {
                // Under interop a Linux cwd makes cmd-style tools complain about
                // UNC paths; the temp directory is a path both sides accept.
                cwd: os.tmpdir(),
                stdio: ['pipe', 'ignore', 'ignore'],
            });
        } catch (err) {
            this._failed(err.message);
            return;
        }
        this.child = child;
        this.since = this.now();
        this.error = null;
        child.on('error', (err) => {
            if (this.child === child) this._failed(err.code === 'ENOENT'
                ? `${cmd.bin} not found on PATH` : err.message);
        });
        child.on('exit', (code, signal) => {
            // Ours to have ended if it is no longer this.child.
            if (this.child === child) this._failed(`${cmd.bin} exited (${signal || code})`);
        });
        // A broken pipe on the watchdog's stdin is the child already gone; the
        // exit handler reports it.
        if (child.stdin && child.stdin.on) child.stdin.on('error', () => {});
    }

    _failed(message) {
        this.child = null;
        this.since = null;
        this._cancelLinger();
        this.error = message;
        this.retryAt = this.now() + RETRY_MS;
    }

    _cancelLinger() {
        if (this.linger) this.clearTimeout(this.linger);
        this.linger = null;
        this.lingerUntil = null;
    }

    _release() {
        this._cancelLinger();
        const child = this.child;
        this.child = null;
        this.since = null;
        this.reason = null;
        if (child) {
            try { child.kill(); } catch { /* already gone */ }
        }
    }

    /** The bridge is going away. The stdin watchdog covers a kill that skips this. */
    shutdown() {
        this._release();
    }

    status() {
        return {
            enabled: this.enabled,
            holding: !!this.child,
            since: this.since,
            reason: this.child ? this.reason : null,
            lingerUntil: this.lingerUntil,
            ...(this.unsupported ? { unsupported: this.unsupported } : {}),
            ...(this.error ? { error: this.error } : {}),
        };
    }
}

module.exports = { KeepAwake, command, LINGER_MS, RETRY_MS, PS_SCRIPT };
