'use strict';

// Tokens and API-equivalent cost: `/api/analytics` for the board and
// `/api/analytics/sessions/:id` for one conversation's header. Both are read
// out of bridge/spend-index.js, which this module brings up to date before it
// answers — a stat per transcript when nothing changed — so a session running
// in a terminal, which no runner event announces, is current on every request.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract.

const cfg = require('../config');
const { NEXT, send } = require('../http');
const { PRICING_AS_OF, BASIS } = require('../pricing');
const { rollup } = require('../spend-index');

// Handed over by server.js — see the note above ROUTES there.
let index = null;
let spend = null;

function init(deps) {
    ({ index, spend } = deps);
}

const DAYS_DEFAULT = 30;
const DAYS_MAX = 365;

async function handle(req, res, url, pathname, seg) {
    if (pathname === '/api/analytics' && req.method === 'GET') {
        const asked = Number(url.searchParams.get('days'));
        const days = Number.isInteger(asked) && asked >= 1
            ? Math.min(asked, DAYS_MAX) : DAYS_DEFAULT;
        await spend.refresh(index);
        const data = rollup(spend.entries(index, { includeTest: cfg.IS_DEV }), { days });
        // Titles only for the rows that are sent: a summary is not free, and
        // the rollup sees every session on the machine.
        for (const s of data.sessions) {
            const sum = index.summary(s.sessionId);
            s.title = sum ? sum.title : null;
        }
        return send(res, 200, {
            basis: BASIS, pricingAsOf: PRICING_AS_OF, generatedAt: Date.now(), ...data,
        });
    }

    if (seg[1] === 'analytics' && seg[2] === 'sessions' && seg.length === 4
        && req.method === 'GET') {
        const id = seg[3];
        if (!index.get(id)) return send(res, 404, { error: 'no such session' });
        const out = await spend.refreshSession(index, id);
        if (!out) return send(res, 404, { error: 'no such session' });
        return send(res, 200, { basis: BASIS, pricingAsOf: PRICING_AS_OF, ...out });
    }

    return NEXT;
}

module.exports = { init, handle };
