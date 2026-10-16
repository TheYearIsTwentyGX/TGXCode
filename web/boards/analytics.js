// The analytics board and the open conversation's running total, drawn with
// Preact.
//
// Every figure here is API-equivalent: the tokens in the transcripts priced at
// Anthropic's list rates (bridge/pricing.js). On a subscription nobody is
// billed it, so the board says so in its subtitle and the header says it in
// its tooltip, and neither ever calls it a cost without the qualifier.
//
// Opening and closing the panel is app.js's (`showAnalytics`, beside showDash);
// this file is the fetch and the drawing.
//
// The charts are plain HTML rather than SVG: one series each (cost per day,
// cost per project), so there is no legend and the title names what is plotted.
// Bars are thin, rounded at the data end and square at the baseline, one hue
// (--blue), and every column is a hover target wider than its bar. The daily
// chart has a table view, because a tooltip is not something everyone can use.
//
// This imports from app.js and conversation.js, which import it back — safe
// because nothing here reads their bindings at module top level.

import { html, render, useState } from '../vendor/preact.js';
import { get } from '../api.js';
import { state } from '../state.js';
import { dom } from '../dom.js';
import { ago, clip } from '../format.js';
import { showAnalytics } from '../app.js';
import { openSession, renderHeader } from '../transcript/conversation.js';
import { paint } from './parts.js';

const RANGES = [7, 30, 90];

// ── formatting ──────────────────────────────────────────────────────────

export function money(n) {
    if (!n) return '$0';
    if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
    if (n >= 100) return '$' + n.toFixed(0);
    if (n >= 0.01) return '$' + n.toFixed(2);
    return '<$0.01';
}

export function tokens(n) {
    if (!n) return '0';
    const steps = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [v, s] of steps) {
        if (n >= v) {
            const x = n / v;
            return (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2))
                .replace(/\.?0+$/, '') + s;
        }
    }
    return String(n);
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function dayLabel(date, short = false) {
    const [y, m, d] = date.split('-').map(Number);
    const at = new Date(y, m - 1, d);
    return at.toLocaleDateString('en-US', short
        ? { month: 'numeric', day: 'numeric' }
        : { weekday: 'short', month: 'short', day: 'numeric' });
}

/** What a set of totals is made of, as one line of text. */
function breakdown(t) {
    return `${tokens(t.input)} input · ${tokens(t.output)} output · `
        + `${tokens(t.cacheRead)} cache read · ${tokens(t.cacheWrite)} cache write`;
}

/** A clean axis maximum: 1, 2 or 5 times a power of ten, at least `v`. */
function niceMax(v) {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
}

// ── the conversation header ─────────────────────────────────────────────

/**
 * Fetch the open session's spend and redraw the header with it. `id` is
 * checked against the session open when the answer arrives, so a slow answer
 * never lands on the next conversation.
 */
export async function loadSessionSpend(id) {
    if (!state.spend || state.spend.sessionId !== id) state.spend = null;
    try {
        const data = await get(`/api/analytics/sessions/${encodeURIComponent(id)}`);
        if (!state.current || state.current.sessionId !== id) return;
        state.spend = data;
        renderHeader();
    } catch { /* the header simply goes without */ }
}

/** A `session-spend` push: the open conversation's new totals. */
export function applySessionSpend(p) {
    if (!state.current || p.sessionId !== state.current.sessionId) return;
    state.spend = { ...(state.spend || {}), sessionId: p.sessionId, totals: p.totals };
    renderHeader();
}

/** The header's cost bit, or null when there is nothing to say. */
export function spendBit(sep) {
    const sp = state.spend;
    if (!sp || !state.current || sp.sessionId !== state.current.sessionId) return null;
    const t = sp.totals;
    if (!t || !t.messages) return null;
    const unpriced = t.unpricedTokens ? ` · ${tokens(t.unpricedTokens)} tokens on models with no known price` : '';
    const title = `API-equivalent cost: these tokens at API list prices`
        + `${sp.pricingAsOf ? ` (as of ${sp.pricingAsOf})` : ''}. Not what a subscription bills.\n`
        + `${tokens(t.tokens)} tokens over ${t.messages} responses, subagents included — `
        + `${breakdown(t)}${unpriced}`;
    return [sep('spend'), html`<span key="spend" class="an-head-cost" title=${title}
        >${`≈${money(t.costUsd)} API-eq · ${tokens(t.tokens)} tok`}</span>`];
}

// ── the board ───────────────────────────────────────────────────────────

export async function loadAnalytics() {
    if (state.analytics.loading) return;
    state.analytics.loading = true;
    state.analytics.error = null;
    renderAnalytics();
    try {
        state.analytics.data = await get(`/api/analytics?days=${state.analytics.days}`);
        state.analytics.at = Date.now();
    } catch (err) {
        state.analytics.error = err.message;
    } finally {
        state.analytics.loading = false;
        renderAnalytics();
    }
}

function setRange(days) {
    if (state.analytics.days === days) return;
    state.analytics.days = days;
    loadAnalytics();
}

export function renderAnalytics() {
    const a = state.analytics;
    const d = a.data;

    render(RANGES.map(n => html`<button key=${n} type="button" class="an-range-btn"
        aria-pressed=${String(a.days === n)} onClick=${() => setRange(n)}>${`${n} days`}</button>`),
    dom.anRange);

    const when = d ? ago(d.generatedAt) : null;
    dom.anSub.textContent = 'API-equivalent: the tokens in your transcripts at API list prices'
        + `${d ? ` as of ${d.pricingAsOf}` : ''}. A subscription does not bill this.`
        + (a.loading ? ' Reading…' : when ? ` Updated ${when === 'now' ? 'just now' : `${when} ago`}.` : '');

    if (a.error && !d) {
        paint(dom.anBody, html`<div class="dash-note">${`Could not load analytics: ${a.error}`}</div>`);
        return;
    }
    if (!d) {
        paint(dom.anBody, html`<div class="dash-note">Reading transcripts…</div>`);
        return;
    }
    paint(dom.anBody, html`<${Board} d=${d} />`);
}

function Board({ d }) {
    const t = d.totals;
    return html`
        <div class="an-kpis">
            <div class="an-kpi an-kpi-hero">
                <div class="an-kpi-label">${`API-equivalent cost, last ${d.days} days`}</div>
                <div class="an-kpi-value">${money(t.costUsd)}</div>
                <div class="an-kpi-note">${`${money(d.allTime.costUsd)} all time`}</div>
            </div>
            <div class="an-kpi">
                <div class="an-kpi-label">Tokens</div>
                <div class="an-kpi-value">${tokens(t.tokens)}</div>
                <div class="an-kpi-note">${`${t.messages.toLocaleString('en-US')} responses`}</div>
            </div>
            <div class="an-kpi">
                <div class="an-kpi-label">Output</div>
                <div class="an-kpi-value">${tokens(t.output)}</div>
                <div class="an-kpi-note">${`${tokens(t.input)} uncached input`}</div>
            </div>
            <div class="an-kpi">
                <div class="an-kpi-label">Served from cache</div>
                <div class="an-kpi-value">${`${pct(t.cacheRead, t.input + t.cacheRead + t.cacheWrite)}%`}</div>
                <div class="an-kpi-note">${`${tokens(t.cacheRead)} read · ${tokens(t.cacheWrite)} written`}</div>
            </div>
        </div>
        ${d.unpricedTokens ? html`<p class="an-warn">${`${tokens(d.unpricedTokens)} tokens are on models `
            + 'with no known price and are not in the cost.'}</p>` : null}
        <${Daily} d=${d} />
        <div class="an-split">
            <${Projects} d=${d} />
            <${Models} d=${d} />
        </div>
        <${Sessions} d=${d} />`;
}

function Daily({ d }) {
    const [hover, setHover] = useState(null);
    const [table, setTable] = useState(false);
    const days = d.daily;
    const max = niceMax(Math.max(...days.map(x => x.costUsd)));
    const ticks = [0, max / 2, max];
    // Label every day when there are few, otherwise about seven of them.
    const every = days.length <= 10 ? 1 : Math.ceil(days.length / 7);
    const h = hover === null ? null : days[hover];

    return html`
        <section class="an-card">
            <header class="an-card-head">
                <h2 class="an-card-title">API-equivalent cost per day</h2>
                <button type="button" class="an-link" onClick=${() => setTable(!table)}
                    >${table ? 'Show chart' : 'Show as table'}</button>
            </header>
            ${table ? html`
                <table class="an-table">
                    <thead><tr><th>Day</th><th class="num">Cost</th><th class="num">Tokens</th>
                        <th class="num">Output</th><th class="num">Responses</th></tr></thead>
                    <tbody>${[...days].reverse().map(x => html`<tr key=${x.date}>
                        <td>${dayLabel(x.date)}</td><td class="num">${money(x.costUsd)}</td>
                        <td class="num">${tokens(x.tokens)}</td><td class="num">${tokens(x.output)}</td>
                        <td class="num">${x.messages}</td></tr>`)}</tbody>
                </table>` : html`
                <div class="an-chart" onMouseLeave=${() => setHover(null)}>
                    <div class="an-grid" aria-hidden="true">
                        ${ticks.map(v => html`<div key=${v} class="an-tick"
                            style=${`bottom:${(v / max) * 100}%`}><span>${money(v)}</span></div>`)}
                    </div>
                    <div class="an-cols" role="list">
                        ${days.map((x, i) => html`
                            <div key=${x.date} class="an-col" role="listitem"
                                aria-label=${`${dayLabel(x.date)}: ${money(x.costUsd)}, ${tokens(x.tokens)} tokens`}
                                data-on=${hover === i ? '1' : null}
                                onMouseEnter=${() => setHover(i)}>
                                <div class="an-bar" style=${`height:${(x.costUsd / max) * 100}%`}></div>
                            </div>`)}
                    </div>
                    ${h ? html`<div class="an-tip" style=${tipPos(hover, days.length)}>
                        <div class="an-tip-title">${dayLabel(h.date)}</div>
                        <div class="an-tip-value">${money(h.costUsd)}</div>
                        <div class="an-tip-row">${`${tokens(h.tokens)} tokens · ${h.messages} responses`}</div>
                        <div class="an-tip-row">${`${tokens(h.output)} output · ${tokens(h.input)} input`}</div>
                        <div class="an-tip-row">${`${tokens(h.cacheRead)} cache read · ${tokens(h.cacheWrite)} cache write`}</div>
                    </div>` : null}
                </div>
                <div class="an-xaxis" aria-hidden="true">
                    ${days.map((x, i) => html`<span key=${x.date}
                        >${i % every === 0 || i === days.length - 1 ? dayLabel(x.date, true) : ''}</span>`)}
                </div>`}
        </section>`;
}

/** Keep the tooltip beside its column and inside the chart. */
function tipPos(i, n) {
    const x = ((i + 0.5) / n) * 100;
    return x > 60 ? `right:${100 - x + 1.5}%` : `left:${x + 1.5}%`;
}

/**
 * A project's label. The last path segment, unless two projects in the list
 * share it — a checkout on the Windows side and one in WSL, say — and then the
 * segment before it too, so the rows can be told apart.
 */
function projectLabels(rows) {
    const count = new Map();
    for (const p of rows) count.set(p.name, (count.get(p.name) || 0) + 1);
    return (p) => {
        if (count.get(p.name) < 2 || !p.cwd) return p.name;
        const parts = p.cwd.split('/').filter(Boolean);
        return parts.slice(-2).join('/');
    };
}

function Projects({ d }) {
    const rows = d.projects.slice(0, 12);
    const label = projectLabels(rows);
    const max = Math.max(...rows.map(p => p.costUsd), 0) || 1;
    return html`
        <section class="an-card">
            <header class="an-card-head"><h2 class="an-card-title">By project</h2></header>
            ${rows.length ? html`<table class="an-table an-bars">
                <thead><tr><th>Project</th><th></th><th class="num">Cost</th><th class="num">Tokens</th>
                    <th class="num">Sessions</th></tr></thead>
                <tbody>${rows.map(p => html`<tr key=${p.cwd || p.name} title=${`${p.cwd || ''}\n${breakdown(p)}`}>
                    <td class="an-name">${label(p)}</td>
                    <td class="an-barcell"><div class="an-hbar" style=${`width:${(p.costUsd / max) * 100}%`}></div></td>
                    <td class="num">${money(p.costUsd)}</td><td class="num">${tokens(p.tokens)}</td>
                    <td class="num">${p.sessions}</td></tr>`)}</tbody>
            </table>` : html`<p class="an-empty">Nothing in this range.</p>`}
        </section>`;
}

function Models({ d }) {
    return html`
        <section class="an-card an-models">
            <header class="an-card-head"><h2 class="an-card-title">By model</h2></header>
            ${d.models.length ? html`<table class="an-table">
                <thead><tr><th>Model</th><th class="num">Cost</th><th class="num">Tokens</th></tr></thead>
                <tbody>${d.models.map(m => html`<tr key=${m.model} title=${breakdown(m)}>
                    <td class="an-name">${m.model}</td>
                    <td class="num">${m.unpricedTokens && !m.costUsd ? 'no price' : money(m.costUsd)}</td>
                    <td class="num">${tokens(m.tokens)}</td></tr>`)}</tbody>
            </table>` : html`<p class="an-empty">Nothing in this range.</p>`}
        </section>`;
}

function Sessions({ d }) {
    const rows = d.sessions.slice(0, 20);
    const open = (id) => { showAnalytics(false); openSession(id); };
    return html`
        <section class="an-card">
            <header class="an-card-head"><h2 class="an-card-title">Most expensive sessions</h2></header>
            ${rows.length ? html`<table class="an-table">
                <thead><tr><th>Session</th><th>Project</th><th>Last active</th><th class="num">Cost</th>
                    <th class="num">Tokens</th></tr></thead>
                <tbody>${rows.map(s => html`<tr key=${s.sessionId} class="an-row-link"
                    title=${breakdown(s)} onClick=${() => open(s.sessionId)}>
                    <td class="an-name">${clip(s.title || s.sessionId, 70)}</td>
                    <td>${s.projectName}</td><td>${s.lastDay ? dayLabel(s.lastDay) : ''}</td>
                    <td class="num">${money(s.costUsd)}</td><td class="num">${tokens(s.tokens)}</td></tr>`)}</tbody>
            </table>` : html`<p class="an-empty">Nothing in this range.</p>`}
        </section>`;
}
