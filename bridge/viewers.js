'use strict';

// Viewers that are not on the stream: a polling client's lease.
//
// An ask (a tool approval, a plan, a question) is only held open while somebody
// is in a position to answer it; with nobody, the runner denies it at once —
// `hasViewer` in bridge/runner.js. "Somebody" was an open `/api/events`
// connection and nothing else. But docs/api.md tells a client to drop the stream
// and poll when its transport buffers SSE, and a client that followed that advice
// stopped counting the moment it did: every ask was auto-denied while the client
// looked perfectly healthy. The Android app worked around it by holding a
// buffered socket that would never deliver anything, purely to be counted.
//
// So a poll can say "I am watching". Two decisions, both deliberate:
//
// - **Opt-in, by header** (`X-TGXCode-Viewer: <id>`), not "any request counts".
//   Plenty of authenticated callers are not a person: `curl`, the MCP server,
//   a schedule's pull-request gate, the test suite. If any of them kept a lease
//   alive, an ask raised with no window open would sit unanswered instead of
//   being denied — which is a turn hanging forever, the worse of the two
//   outcomes. Only a client that will actually show the ask sends the header.
// - **Thirty seconds.** Six of the 5s board polls docs/api.md suggests, so a
//   dropped request or two does not flap it, and short enough that a client that
//   was killed or backgrounded without polling lapses inside one turn rather than
//   leaving asks waiting for a phone in a pocket.
//
// Keyed by the id the client sends so `/api/health` can say how many there are.
// Bounded both ways, because the id is caller-chosen text.

const LEASE_MS = 30_000;
const MAX_ID = 128;
const MAX_LEASES = 64;

class ViewerLeases {
    constructor({ now = Date.now, leaseMs = LEASE_MS, max = MAX_LEASES } = {}) {
        this.now = now;
        this.leaseMs = leaseMs;
        this.max = max;
        this.leases = new Map();   // id → expiry, in insertion (oldest-first) order
    }

    /** Renew the lease for `id`. A missing or blank id is not a lease. */
    touch(id) {
        if (typeof id !== 'string') return false;
        const key = id.trim().slice(0, MAX_ID);
        if (!key) return false;
        // Delete first so a renewal moves to the back: eviction takes the
        // longest-silent client, not the first one ever seen.
        this.leases.delete(key);
        this.leases.set(key, this.now() + this.leaseMs);
        while (this.leases.size > this.max) {
            this.leases.delete(this.leases.keys().next().value);
        }
        return true;
    }

    /** How many leases are still live. Expired ones are dropped as it counts. */
    active() {
        const t = this.now();
        for (const [k, until] of this.leases) if (until <= t) this.leases.delete(k);
        return this.leases.size;
    }
}

const HEADER = 'x-tgxcode-viewer';

module.exports = { ViewerLeases, leases: new ViewerLeases(), HEADER, LEASE_MS };
