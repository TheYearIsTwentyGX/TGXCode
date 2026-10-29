'use strict';

// The models and effort levels this app offers, in one place.
//
// The composer's picker, the Start dialog, the orchestrator settings popover,
// Settings › Orchestrators, `spawn_worker`'s tool description and its validation
// all read this list — the page gets it in a `tgx-models` <meta> tag
// (bridge/server.js) and a phone from `GET /api/models`. Before it existed the
// list was written out twice in web/index.html and nowhere the bridge could see,
// so an orchestrator could only guess at a model name, and a wrong guess was a
// worker whose process failed to start rather than a refusal it could correct.
//
// Aliases, not ids: `claude --model opus` follows the CLI to whatever opus is
// current, which is what a picker that is never edited should mean. `note` is
// the one-line guide an orchestrator reads when it chooses for a worker.
//
// No requires, on purpose: bridge/mcp.js is spawned by every `claude` the
// bridge starts and loads this, so it must stay a leaf.

const MODELS = Object.freeze([
    Object.freeze({ id: 'opus', label: 'opus',
        note: 'strong, mid-priced: design-heavy, security-sensitive or tricky debugging work' }),
    Object.freeze({ id: 'sonnet', label: 'sonnet',
        note: 'capable and cheaper: most ordinary feature work and fixes' }),
    Object.freeze({ id: 'haiku', label: 'haiku',
        note: 'fastest and cheapest: mechanical work such as renames, docs and small fixes' }),
    Object.freeze({ id: 'fable', label: 'fable',
        note: 'the most capable and the most expensive: the hardest problems, or when the user asks for it' }),
]);

/** `claude --effort`'s levels. `EFFORTS` in runner.js is this list. */
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const MODEL_IDS = Object.freeze(MODELS.map(m => m.id));

const isModel = (v) => MODEL_IDS.includes(v);
const isEffort = (v) => EFFORTS.includes(v);

/** What `GET /api/models` and the `tgx-models` <meta> tag carry. */
function payload() {
    return { models: MODELS.map(m => ({ ...m })), efforts: [...EFFORTS] };
}

/** The list as lines for a model to read: "- opus: the strongest: …". */
function guideLines() {
    return MODELS.map(m => `- ${m.id}: ${m.note}`);
}

module.exports = { MODELS, MODEL_IDS, EFFORTS, isModel, isEffort, payload, guideLines };
