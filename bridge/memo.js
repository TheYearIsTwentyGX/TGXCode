'use strict';

// Two small helpers for the parts of the bridge that ask expensive questions on
// a timer — the work-in-flight board shelling out to git and gh, and the live
// board asking after dev servers. Both want the same two things: don't ask again
// if the answer is fresh, and don't ask ten times at once.

/**
 * Memoise a promise-returning call, sharing one in-flight call between callers.
 *
 * Ten worktrees of the same repository ask for its PRs at the same instant, and
 * that has to be one request to GitHub rather than ten.
 */
function cached(store, key, ttl, produce) {
    const hit = store.get(key);
    if (hit) {
        if (hit.pending) return hit.pending;
        if (Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
    }
    const pending = produce().then(
        (value) => { store.set(key, { value, at: Date.now() }); return value; },
        (err) => { store.delete(key); throw err; },
    );
    store.set(key, { pending, at: 0 });
    return pending;
}

/** Run `fn` over `items` with at most `limit` in flight, results in input order. */
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const at = next++;
            out[at] = await fn(items[at], at);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

/** Drop entries nothing is asking about any more, so a cache is not a leak. */
function keepOnly(store, keys) {
    for (const key of store.keys()) if (!keys.has(key)) store.delete(key);
}

module.exports = { cached, mapLimit, keepOnly };
