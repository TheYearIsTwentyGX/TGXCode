'use strict';

// What a transcript's tokens would have cost at Anthropic's API list prices.
//
// Not what anybody was billed. On a subscription plan `total_cost_usd` in a
// turn's result is literally 0 (see bridge/usage.js), so there is no bill to
// read; the useful number is the API-equivalent — the price of the same tokens
// bought one request at a time. Every surface that shows a figure from here
// says so, and `BASIS` is the word it uses.
//
// Decided:
//
// - **Prices per family, matched by prefix.** Transcripts carry ids with date
//   suffixes (`claude-haiku-4-5-20251001`), context markers (`claude-opus-5-5[1m]`)
//   and, rarely, bare aliases (`opus`). The table is keyed by the stem, longest
//   prefix wins, so `claude-opus-5-5` is not priced as `claude-opus-5`.
//
// - **An unknown model is unpriced, not free.** `priceFor` returns null and the
//   caller counts the tokens without a cost, and reports how many there were,
//   so a model released after this table reads as a gap rather than as $0.
//   `<synthetic>` entries carry zero usage and are skipped before they get here.
//
// - **Cache writes by TTL when the transcript says.** `usage.cache_creation`
//   splits the writes into 5-minute (1.25× input) and 1-hour (2× input); an
//   older entry without it is billed all at the 5-minute rate.
//
// - **Haiku 5.5's long-prompt tier is not modelled.** Its price doubles-and-a-
//   half above 100K prompt tokens; a single usage line does not say which side
//   of that a request fell, and Haiku is a rounding error on this machine.
//
// Source: the claude-api skill's model table (cached 2026-10-06) for the 4.6+
// generations; older rows are the published list prices at their retirement.
// Update PRICING_AS_OF with the table.

const PRICING_AS_OF = '2026-10-06';
const BASIS = 'api-equivalent';

// USD per million tokens. `cacheRead` is per model — it is not a fixed
// fraction of input any more (0.025× on Fable 5.1, 0.05× on Opus 5.5).
const row = (input, output, cacheRead) => ({
    input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2,
});

const PRICES = {
    'claude-fable-5-1': row(10, 50, 0.25),
    'claude-mythos-5-1': row(10, 50, 0.25),
    'claude-fable-5': row(10, 50, 1),
    'claude-mythos-5': row(10, 50, 1),
    'claude-opus-5-5': row(4, 20, 0.2),
    'claude-opus-5': row(5, 25, 0.5),
    'claude-opus-4-8': row(5, 25, 0.5),
    'claude-opus-4-7': row(5, 25, 0.5),
    'claude-opus-4-6': row(5, 25, 0.5),
    'claude-opus-4-5': row(5, 25, 0.5),
    'claude-opus-4-1': row(15, 75, 1.5),
    'claude-opus-4': row(15, 75, 1.5),
    'claude-3-opus': row(15, 75, 1.5),
    'claude-sonnet-5-5': row(2, 10, 0.2),
    'claude-sonnet-5': row(2, 10, 0.2),
    'claude-sonnet-4': row(3, 15, 0.3),
    'claude-3-7-sonnet': row(3, 15, 0.3),
    'claude-3-5-sonnet': row(3, 15, 0.3),
    'claude-haiku-5-5': row(0.1, 0.5, 0.01),
    'claude-haiku-4-5': row(1, 5, 0.1),
    'claude-3-5-haiku': row(0.8, 4, 0.08),
    'claude-3-haiku': row(0.25, 1.25, 0.03),
};
// Longest first, so the first match is the most specific.
const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

// Bare aliases Claude Code sometimes records in place of an id.
const ALIASES = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5',
    haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' };

/** The model id with context markers and whitespace removed. */
function normalizeModel(model) {
    const m = String(model || '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
    return ALIASES[m] || m;
}

/** List prices for a model, or null when it is not in the table. */
function priceFor(model) {
    const m = normalizeModel(model);
    if (!m) return null;
    for (const k of KEYS) {
        // A prefix must end at a separator: `claude-opus-5` must not take
        // `claude-opus-55` should one ever exist.
        if (m === k || m.startsWith(k + '-')) return PRICES[k];
    }
    return null;
}

/**
 * The four token counts a usage object bills on, plus the split of cache
 * writes by TTL. Missing fields are zero.
 */
function tokensOf(usage) {
    const u = usage || {};
    const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
    const cacheWrite = n(u.cache_creation_input_tokens);
    const cc = u.cache_creation || null;
    let write1h = cc ? n(cc.ephemeral_1h_input_tokens) : 0;
    if (write1h > cacheWrite) write1h = cacheWrite;
    return {
        input: n(u.input_tokens),
        output: n(u.output_tokens),
        cacheRead: n(u.cache_read_input_tokens),
        cacheWrite,
        cacheWrite1h: write1h,
    };
}

/** USD for one message's usage, or null when the model has no price. */
function costOf(usage, model) {
    const p = priceFor(model);
    if (!p) return null;
    const t = tokensOf(usage);
    const write5m = t.cacheWrite - t.cacheWrite1h;
    return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead
        + write5m * p.cacheWrite5m + t.cacheWrite1h * p.cacheWrite1h) / 1e6;
}

module.exports = { PRICING_AS_OF, BASIS, PRICES, normalizeModel, priceFor, tokensOf, costOf };
