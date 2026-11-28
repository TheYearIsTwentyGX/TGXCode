'use strict';

// Codex's checklist (`update_plan`), as the TodoWrite list the rest of the bridge
// already reads — the adapter docs/plans/23-codex.md Phase 4 asks for, so that
// bridge/tasks.js, the checklist panel and the boards take a Codex list without
// knowing whose it is.
//
// `update_plan` is opt-in on 0.172.0 (`tools.update_plan.enabled` in the thread
// config, which the process adapter sets). Each call carries the whole list,
// `{explanation?, plan: [{step, status}]}`, exactly as TodoWrite carries its
// whole list, so the newest call is the current list and nothing accumulates.
//
// **On disk it is only a script.** The plan expected an `event_msg plan_update`
// line, and 0.160.1 wrote one; 0.172.0 does not. Codex runs the model in code
// mode, so the call is in a `custom_tool_call` `exec` whose input is JavaScript:
//
//   const r = await tools.update_plan({plan:[{step:"Think of a colour",status:"in_progress"}]}); text(r);
//
// and on the wire it is a `turn/plan/updated` notification, which a file does not
// keep. So this reads three forms, newest Codex first: the call inside an `exec`
// script, a plain `function_call` named `update_plan` (code mode off) with JSON
// arguments, and the old `plan_update` event. The script is read with a small
// parser for JavaScript *literals* — objects, arrays, strings, numbers, booleans,
// null, bare keys, trailing commas — plus names bound to a literal earlier in the
// same script (`const plan1 = […]; await tools.update_plan({plan: plan1})`, and
// `{plan}` shorthand), and nothing else: an argument built by a loop, a function
// call or a template with `${…}` is not a list this can know, and is skipped
// rather than guessed at. Measured on 0.172.0: the recorded turn called it with
// literals, and a live one bound six lists to `const`s and passed each by name,
// all in one script.
//
// Statuses: Codex says `pending | inProgress | completed` on the wire and
// `pending | in_progress | completed` in scripts; TodoWrite's three are
// `pending | in_progress | completed`. Anything else reads as `pending`, the
// rule bridge/tasks.js applies to every list.

/** `pending | in_progress | completed`, whichever spelling Codex used. */
function stepStatus(s) {
    if (s === 'inProgress' || s === 'in_progress') return 'in_progress';
    if (s === 'completed') return 'completed';
    return 'pending';
}

/** `{explanation, plan: [{step, status}]}` with statuses in TodoWrite's spelling, or null. */
function normalise(args) {
    if (!args || typeof args !== 'object' || !Array.isArray(args.plan)) return null;
    return {
        explanation: typeof args.explanation === 'string' ? args.explanation : null,
        plan: args.plan
            .filter(s => s && typeof s === 'object')
            .map(s => ({ step: String(s.step || ''), status: stepStatus(s.status) })),
    };
}

/** A plan as TodoWrite's items: `[{content, status, activeForm}]`. */
function todosOf(plan) {
    return (plan && plan.plan ? plan.plan : []).map(s => ({
        content: s.step, status: s.status, activeForm: s.step,
    }));
}

// ---------------------------------------------------------------------------
// A JavaScript literal, read
// ---------------------------------------------------------------------------

class NotLiteral extends Error {}

/**
 * Read one literal value of `src` from `i`: `{value, end}`. Throws NotLiteral.
 * `env` maps a name to the literal bound to it, for a bare identifier.
 */
function literal(src, i, env = null) {
    const bound = (name) => {
        if (!env || !env.has(name)) throw new NotLiteral();
        return env.get(name);
    };
    const ws = () => {
        for (;;) {
            while (i < src.length && /\s/.test(src[i])) i++;
            if (src.startsWith('//', i)) { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
            if (src.startsWith('/*', i)) { const n = src.indexOf('*/', i + 2); if (n < 0) throw new NotLiteral(); i = n + 2; continue; }
            return;
        }
    };
    const str = () => {
        const q = src[i++];
        let out = '';
        while (i < src.length && src[i] !== q) {
            let c = src[i++];
            if (q === '`' && c === '$' && src[i] === '{') throw new NotLiteral();
            if (c === '\\') {
                const e = src[i++];
                const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
                if (e === 'u') {
                    const braced = src[i] === '{';
                    const hex = braced ? src.slice(i + 1, src.indexOf('}', i)) : src.slice(i, i + 4);
                    if (!/^[0-9a-fA-F]+$/.test(hex)) throw new NotLiteral();
                    c = String.fromCodePoint(parseInt(hex, 16));
                    i += braced ? hex.length + 2 : 4;
                } else if (e === 'x') {
                    const hex = src.slice(i, i + 2);
                    if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new NotLiteral();
                    c = String.fromCharCode(parseInt(hex, 16));
                    i += 2;
                } else if (e === '\n') {
                    c = '';
                } else {
                    c = e in map ? map[e] : e;
                }
            }
            out += c;
        }
        if (i >= src.length) throw new NotLiteral();
        i++;
        return out;
    };
    const value = () => {
        ws();
        const c = src[i];
        if (c === '{') {
            i++;
            const o = {};
            for (;;) {
                ws();
                if (src[i] === '}') { i++; return o; }
                let key;
                if (src[i] === '"' || src[i] === "'") key = str();
                else {
                    const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
                    if (!m) throw new NotLiteral();
                    key = m[0];
                    i += key.length;
                }
                ws();
                // `{plan}`: shorthand for a name bound earlier.
                if (src[i] === ',' || src[i] === '}') {
                    o[key] = bound(key);
                    if (src[i] === ',') i++;
                    continue;
                }
                if (src[i] !== ':') throw new NotLiteral();
                i++;
                o[key] = value();
                ws();
                if (src[i] === ',') { i++; continue; }
                if (src[i] === '}') { i++; return o; }
                throw new NotLiteral();
            }
        }
        if (c === '[') {
            i++;
            const a = [];
            for (;;) {
                ws();
                if (src[i] === ']') { i++; return a; }
                a.push(value());
                ws();
                if (src[i] === ',') { i++; continue; }
                if (src[i] === ']') { i++; return a; }
                throw new NotLiteral();
            }
        }
        if (c === '"' || c === "'" || c === '`') return str();
        const rest = src.slice(i);
        const num = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
        if (num) { i += num[0].length; return Number(num[0]); }
        for (const [word, v] of [['true', true], ['false', false], ['null', null], ['undefined', undefined]]) {
            if (rest.startsWith(word) && !/[\w$]/.test(rest[word.length] || '')) { i += word.length; return v; }
        }
        const name = /^[A-Za-z_$][\w$]*/.exec(rest);
        if (name && !/^\s*[.([]/.test(rest.slice(name[0].length))) {
            i += name[0].length;
            return bound(name[0]);
        }
        throw new NotLiteral();
    };
    const v = value();
    return { value: v, end: i };
}

// In one pass, in the order they are written: `tools.update_plan(` (and a bare
// `update_plan(`, never `x.update_planner(`), and a name bound with `const`, `let`,
// `var` or a plain `=` at the start of a statement.
const STEP_RE = /(?:^|[^\w$.])(?:(?:tools\s*\.\s*)?update_plan\s*\(|(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=(?![=>]))/g;

/**
 * Every `update_plan` call in a code-mode script whose argument is a literal, or
 * names one bound earlier in the script, in order, normalised. `[]` for a script
 * with none.
 */
function plansInScript(script) {
    const src = String(script || '');
    if (!src.includes('update_plan')) return [];
    const out = [];
    const env = new Map();
    STEP_RE.lastIndex = 0;
    let m;
    while ((m = STEP_RE.exec(src))) {
        const at = m.index + m[0].length;
        try {
            const { value } = literal(src, at, env);
            if (m[1]) { env.set(m[1], value); continue; }
            const plan = normalise(value);
            if (plan) out.push(plan);
        } catch (err) {
            if (!(err instanceof NotLiteral)) throw err;
            // A name bound to something this cannot read is no longer known.
            if (m[1]) env.delete(m[1]);
        }
    }
    return out;
}

/**
 * The plan a rollout line records, or null. The three forms in the header: a
 * code-mode `exec` script (the last call in it wins), a `function_call` named
 * `update_plan`, and an `event_msg plan_update`.
 */
function planOfLine(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const p = entry.payload || {};
    if (entry.type === 'response_item' && p.type === 'custom_tool_call' && typeof p.input === 'string') {
        const all = plansInScript(p.input);
        return all.length ? all[all.length - 1] : null;
    }
    if (entry.type === 'response_item' && p.type === 'function_call' && p.name === 'update_plan') {
        let args = p.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
        return normalise(args);
    }
    if (entry.type === 'event_msg' && p.type === 'plan_update') return normalise(p);
    return null;
}

/** Cheap pre-filter for a raw line before it is parsed. */
function mayHavePlan(line) {
    return typeof line === 'string' && (line.includes('update_plan') || line.includes('"plan_update"'));
}

module.exports = { stepStatus, normalise, todosOf, plansInScript, planOfLine, mayHavePlan, literal };
