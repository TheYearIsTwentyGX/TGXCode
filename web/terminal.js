// The terminal pane — a real shell in the session's working directory, or the
// output of a command the project declared.
//
// The emulator is xterm.js, vendored under web/vendor. Everything below is the
// wiring: one xterm instance reused across sessions, output over its own SSE
// stream, input posted back in order, and the pty resized to whatever the pane
// happens to be.
//
// A run is the same pty with a different first command (see bridge/runs.js), so
// it is the same pane with a different pair of endpoints behind it. That is what
// `base` is: everything after the open — stream, input, resize — is addressed
// relative to it, and only `attach` and `attachRun` know which is which. The
// pane stays writable for a run on purpose, because vite's `r`, jest's watch
// keys and a plain Ctrl-C are all things you want to reach a dev server with.

// Vendored as .js rather than the .mjs the packages ship, so that adding them
// needed no change to the bridge's MIME table — a web/ change should never
// depend on a bridge restart to take effect.
import { Terminal } from './vendor/xterm.js';
import { FitAddon } from './vendor/addon-fit.js';

const HEADERS = { 'X-Claude-Sessions-Client': '1', 'Content-Type': 'application/json' };

// Bytes both ways, base64 over JSON. A terminal stream is not text — half a
// multi-byte character can and does arrive on its own — so nothing here is
// allowed to guess at an encoding on the way past.

function decode(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function encode(bytes) {
    let s = '';
    // Chunked: a paste of any size arrives as one write, and spreading a large
    // array into String.fromCharCode overflows the argument stack.
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
}

const utf8 = new TextEncoder();

/** xterm hands binary responses back as one char per byte, already encoded. */
function latin1(str) {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    return bytes;
}

function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

// Deliberately the app's own palette rather than xterm's default: the pane sits
// inside the window, not in front of it, and a stock black terminal reads as a
// hole cut in the page.
function theme() {
    return {
        background: cssVar('--s2', '#202124'),
        foreground: cssVar('--text', '#e3e3e3'),
        cursor: cssVar('--blue', '#a8c7fa'),
        cursorAccent: cssVar('--s2', '#202124'),
        selectionBackground: '#2e4a75',
        // Not #000: a program painting a black background should sink into the
        // pane's surface rather than punch a hole through it.
        black: cssVar('--s1', '#1b1c1d'),
        red: cssVar('--red', '#f28b82'),
        green: cssVar('--green', '#6dd58c'),
        yellow: cssVar('--yellow', '#fdd663'),
        blue: cssVar('--blue', '#a8c7fa'),
        magenta: cssVar('--purple', '#d0bcff'),
        cyan: '#7fd1d9',
        white: cssVar('--text-2', '#c4c7c5'),
        brightBlack: cssVar('--text-4', '#6f7579'),
        brightRed: '#ffa39c',
        brightGreen: '#87eaa4',
        brightYellow: '#ffe083',
        brightBlue: '#c2d9ff',
        brightMagenta: '#e4d4ff',
        brightCyan: '#9fe6ed',
        brightWhite: '#ffffff',
    };
}

export class TerminalPane {
    /**
     * @param {{mount: HTMLElement, onOpen?: Function, onExit?: Function, onError?: Function}} opts
     */
    constructor(opts) {
        this.mount = opts.mount;
        this.onOpen = opts.onOpen || (() => {});
        this.onExit = opts.onExit || (() => {});
        this.onError = opts.onError || (() => {});

        this.term = null;
        this.fit = null;
        this.stream = null;         // EventSource
        this.info = null;           // the bridge's record of the live terminal
        this.sessionId = null;      // the session the pane is showing
        this.runId = null;          // …or the run, if it is showing one of those
        this.base = null;           // where stream/input/resize live for it
        this.pending = [];          // keystrokes waiting for the in-flight POST
        this.sending = false;
        this.reopening = false;
        this.lastSize = '';
    }

    /** Built on first use — no session ever pays for a pane it does not open. */
    build() {
        if (this.term) return;
        this.term = new Terminal({
            fontFamily: cssVar('--mono', 'monospace'),
            fontSize: 13,
            lineHeight: 1.25,
            letterSpacing: 0,
            cursorBlink: true,
            // The shell's own scrollback. The bridge keeps a much smaller replay
            // buffer, so this is what you actually scroll through in a session.
            scrollback: 10_000,
            theme: theme(),
            allowProposedApi: false,
        });
        this.fit = new FitAddon();
        this.term.loadAddon(this.fit);
        this.term.open(this.mount);

        this.term.onData((d) => this.input(utf8.encode(d)));
        // Anything the emulator answers on its own behalf — cursor position
        // reports and the like — goes back up the same pipe, already as bytes.
        this.term.onBinary((d) => this.input(latin1(d)));
        this.term.onResize(({ rows, cols }) => this.pushSize(rows, cols));

        // Ctrl+C has to stay an interrupt here, which is what the shell expects,
        // so copy takes the Ctrl+Shift pair a terminal normally uses. Copy needs
        // this handler because an xterm selection is not a DOM selection, so the
        // browser has nothing of its own to copy.
        //
        // Paste is deliberately absent. Ctrl+Shift+V already reaches xterm as an
        // ordinary paste event, which it brackets and forwards on its own; a
        // clipboard.readText() branch here delivers the same text a second time,
        // because returning false only stops xterm from handling the key and
        // never cancels the browser's own paste.
        this.term.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown') return true;
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
                const sel = this.term.getSelection();
                if (sel) navigator.clipboard.writeText(sel).catch(() => {});
                return false;
            }
            return true;
        });

        // The pane is resized by dragging its handle and by the window changing
        // shape; watching the element covers both without either knowing.
        this.observer = new ResizeObserver(() => this.refit());
        this.observer.observe(this.mount);
    }

    /** Open (or reattach to) the shell for a session and show it. */
    async attach(sessionId) {
        this.build();
        if (this.sessionId === sessionId && this.stream) { this.refit(); return; }
        this.detach();
        this.sessionId = sessionId;

        const size = this.measure();
        let info;
        try {
            const r = await fetch(`/api/sessions/${sessionId}/terminal`, {
                method: 'POST', headers: HEADERS, body: JSON.stringify(size),
            });
            info = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(info.error || `HTTP ${r.status}`);
        } catch (err) {
            this.onError(err.message);
            return;
        }
        // A slower open than the click that replaced it: drop the answer rather
        // than wiring a pane that has already moved on.
        if (this.sessionId !== sessionId) return;

        this.follow(`/api/terminals/${info.id}`, info);
    }

    /**
     * Show a run's output.
     *
     * No open step: bridge/runs.js started the process when the button was
     * clicked, and this only asks what it turned into. A run that has already
     * exited is a legitimate thing to attach to — its scrollback is still there,
     * which is the whole reason the record outlives the process.
     */
    async attachRun(runId) {
        this.build();
        if (this.runId === runId && this.stream) { this.refit(); return; }
        this.detach();
        this.runId = runId;

        let info;
        try {
            const r = await fetch(`/api/runs/${runId}`, { headers: HEADERS });
            const body = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
            info = body.run;
        } catch (err) {
            this.onError(err.message);
            return;
        }
        if (this.runId !== runId) return;

        this.follow(`/api/runs/${runId}`, info);
    }

    /** Everything after the open, for either kind. */
    follow(base, info) {
        this.base = base;
        this.info = info;
        this.onOpen(info);
        this.listen(base);
        this.refit();
        this.flush();       // anything typed while the open was in flight
    }

    listen(base) {
        const es = new EventSource(`${base}/stream`);
        this.stream = es;

        // Sent once per connection, so it doubles as the signal that a dropped
        // stream has come back and the replay below is about to arrive again.
        es.addEventListener('opened', () => {
            this.term.reset();
            this.lastSize = '';
        });
        es.addEventListener('data', (e) => {
            this.term.write(decode(JSON.parse(e.data).b64));
        });
        es.addEventListener('exit', (e) => {
            const { code, signal } = JSON.parse(e.data);
            const how = signal ? `signal ${signal}` : `status ${code}`;
            const what = this.runId ? 'command' : 'shell';
            this.term.write(`\r\n\x1b[2m[${what} exited — ${how}]\x1b[0m\r\n`);
            this.onExit({ code, signal });
        });
        es.onerror = () => {
            // A closed stream means the terminal is gone, usually because the
            // bridge restarted. Reattaching gets a fresh shell in the same
            // directory, which beats a dead pane with no explanation.
            //
            // A run is not reopened the same way: there is nothing to reopen,
            // because a run dies with its bridge and starting another would run
            // the command again without anyone asking for it. Ask what became of
            // it instead, and let attachRun report if it is gone.
            if (es.readyState !== EventSource.CLOSED || this.stream !== es) return;
            es.close();
            this.stream = null;
            if (this.reopening) return;
            const session = this.sessionId;
            const run = this.runId;
            if (!session && !run) return;
            this.reopening = true;
            setTimeout(() => {
                this.reopening = false;
                if (run && this.runId === run) this.attachRun(run);
                else if (session && this.sessionId === session) this.attach(session);
            }, 1200);
        };
    }

    /** Stop following, without touching the shell — it keeps running. */
    detach() {
        if (this.stream) { this.stream.close(); this.stream = null; }
        this.info = null;
        this.base = null;
        this.sessionId = null;
        this.runId = null;
        this.pending = [];
    }

    /**
     * End the shell for good.
     *
     * Only ever a shell: a run is stopped through its own button, which goes to
     * /api/runs/:id/stop and leaves the record behind so you can read why it
     * ended. DELETE on a run means "forget this", which is a different verb.
     */
    async kill() {
        const id = this.sessionId && this.info && this.info.id;
        this.detach();
        if (!id) return;
        try {
            await fetch(`/api/terminals/${id}`, { method: 'DELETE', headers: HEADERS });
        } catch { /* the bridge is gone, and so therefore is the shell */ }
    }

    input(bytes) {
        // Held rather than dropped when the shell is not open yet. The pane
        // takes focus the moment it is shown, which is well before the bridge
        // has answered, so the first thing typed reliably beats the answer
        // home — and losing it looks exactly like a dead terminal.
        if ((!this.sessionId && !this.runId) || !bytes.length) return;
        this.pending.push(bytes);
        this.flush();
    }

    /**
     * One request at a time. Keystrokes are bytes on a stream and arriving out
     * of order would be worse than arriving late, so a send in flight collects
     * what follows rather than racing it.
     */
    async flush() {
        if (this.sending || !this.pending.length || !this.base) return;
        this.sending = true;
        const batch = this.pending;
        this.pending = [];

        let total = 0;
        for (const b of batch) total += b.length;
        const joined = new Uint8Array(total);
        let at = 0;
        for (const b of batch) { joined.set(b, at); at += b.length; }

        try {
            await fetch(`${this.base}/input`, {
                method: 'POST', headers: HEADERS, body: JSON.stringify({ b64: encode(joined) }),
            });
        } catch { /* the stream's error handling covers a dead bridge */ }
        this.sending = false;
        if (this.pending.length) this.flush();
    }

    measure() {
        try {
            const dims = this.fit.proposeDimensions();
            if (dims && dims.rows && dims.cols) return { rows: dims.rows, cols: dims.cols };
        } catch { /* not laid out yet */ }
        return { rows: this.term ? this.term.rows : 24, cols: this.term ? this.term.cols : 80 };
    }

    refit() {
        if (!this.term || !this.mount.clientHeight) return;
        try { this.fit.fit(); } catch { /* mid-layout; the next call catches up */ }
    }

    pushSize(rows, cols) {
        if (!this.base) return;
        const sig = `${rows}x${cols}`;
        if (sig === this.lastSize) return;
        this.lastSize = sig;
        fetch(`${this.base}/resize`, {
            method: 'POST', headers: HEADERS, body: JSON.stringify({ rows, cols }),
        }).catch(() => { /* the stream's error handling covers a dead bridge */ });
    }

    focus() { if (this.term) this.term.focus(); }

    clear() { if (this.term) this.term.clear(); }
}
