'use strict';

// Builds `bridge/spinner-verbs.json` from the upstream collection at
// github.com/wynandw87/claude-code-spinner-verbs.
//
// That repository is a single README — no data files, no code — so the verbs
// have to be read out of its markdown. This exists rather than a hand-copied
// blob because upstream gains categories: a refresh should be one command whose
// output can be diffed, not an afternoon of pasting 113 tables.
//
// The format it parses is regular enough to rely on: `### Group Name (N)`
// followed by a one-column `| Verb |` table, plus one comma-separated paragraph
// under `## Built-in Default Verbs` for the verbs Claude Code already ships.
// Anything that does not look like that is reported and skipped, so a change in
// upstream's shape shows up as a warning and a smaller file rather than as
// silent nonsense.
//
//   node scripts/import-spinner-verbs.js              # fetch from GitHub
//   node scripts/import-spinner-verbs.js path/to/README.md
//
// The result is one file, checked in. It is both the seed for
// `~/.tgxcode/verbs/` and the fallback when that directory is unreadable — see
// bridge/spinner.js.

const fs = require('fs');
const path = require('path');

const SOURCE = 'https://raw.githubusercontent.com/wynandw87/claude-code-spinner-verbs/main/README.md';
const OUT = path.join(__dirname, '..', 'bridge', 'spinner-verbs.json');

// The verbs Claude Code ships with, given a name of our own. Upstream calls
// them "Built-in Default Verbs", which would read oddly in a settings file next
// to "Monty Python" — and they are not this app's defaults, they are the CLI's.
const DEFAULTS_GROUP = 'Claude Code Defaults';

// `###` headings that are prose, not groups. Everything else at that level is a
// category; matching on this short list rather than on a pattern means a new
// category is picked up without being taught about, while a new *section* is
// loud about needing attention.
const NOT_GROUPS = new Set(['Manual Setup', 'Modes', 'Spinner Verbs', 'Spinner Phrases']);

/**
 * One table cell as a verb, or null.
 *
 * Upstream wraps the Kaomoji group in backticks so the faces render, and one
 * entry needs doubled backticks because it contains a backtick itself. Both
 * come off; a verb is what the spinner would say.
 */
function cell(line) {
    let v = line.replace(/^\|\s*/, '').replace(/\s*\|$/, '').trim();
    const fence = v.match(/^(`+)([\s\S]*)\1$/);
    if (fence) v = fence[2];
    return v.trim() || null;
}

/** Add to a group, keeping order and dropping a repeat. */
function push(groups, name, verb) {
    const list = groups[name] || (groups[name] = []);
    if (!list.includes(verb)) list.push(verb);
}

/**
 * Parse the whole README.
 *
 * @returns {{groups: Object<string, string[]>, warnings: string[]}}
 */
function parse(md) {
    const lines = md.split(/\r?\n/);
    const groups = {};
    const warnings = [];
    const warn = (msg) => warnings.push(msg);
    const claimed = new Map();   // group -> the (N) upstream promised

    let group = null;            // the category we are inside, or null
    let inTable = false;
    let inDefaults = false;

    for (const line of lines) {
        if (line.startsWith('## ')) {
            // The stock verbs are a paragraph rather than a table, so they get
            // their own little mode instead of a row-by-row parse.
            inDefaults = /^## Built-in Default Verbs/.test(line);
            if (inDefaults) {
                const n = line.match(/\((\d+)\)/);
                if (n) claimed.set(DEFAULTS_GROUP, Number(n[1]));
            }
            group = null;
            inTable = false;
            continue;
        }

        if (line.startsWith('### ')) {
            inDefaults = false;
            inTable = false;
            const heading = line.slice(4).trim();
            const name = heading.replace(/\s*\(\d+\)\s*$/, '').trim();
            if (NOT_GROUPS.has(name)) { group = null; continue; }
            const n = heading.match(/\((\d+)\)\s*$/);
            if (!n) warn(`"${name}" has no count in its heading — taking whatever it lists`);
            else claimed.set(name, Number(n[1]));
            if (groups[name]) warn(`"${name}" appears twice — merging`);
            group = name;
            continue;
        }

        if (inDefaults) {
            // A prose line, a blank, or the list itself. The list is the one
            // with commas in it and no markdown furniture.
            const t = line.trim();
            if (!t || t.startsWith('#') || t.startsWith('-') || t.startsWith('|')) continue;
            if (!t.includes(',')) continue;
            for (const v of t.split(',')) {
                const verb = v.trim();
                if (verb) push(groups, DEFAULTS_GROUP, verb);
            }
            continue;
        }

        if (!group) continue;

        if (/^\|\s*Verb\s*\|$/i.test(line.trim())) { inTable = true; continue; }
        if (!inTable) continue;
        if (/^\|[\s|:-]+\|$/.test(line.trim())) continue;   // the ---- rule
        if (!line.startsWith('|')) { inTable = false; continue; }

        const verb = cell(line);
        if (verb) push(groups, group, verb);
    }

    for (const [name, n] of claimed) {
        const got = groups[name] ? groups[name].length : 0;
        // Upstream's own arithmetic is already off by one in places, so this is
        // a note rather than a failure. It is still the first thing to look at
        // if a refresh comes out the wrong size.
        if (got !== n) warn(`"${name}": heading says ${n}, parsed ${got}`);
    }
    return { groups, warnings };
}

async function readSource(arg) {
    if (arg) return fs.readFileSync(arg, 'utf8');
    const res = await fetch(SOURCE);
    if (!res.ok) throw new Error(`${SOURCE} → HTTP ${res.status}`);
    return res.text();
}

async function main() {
    const md = await readSource(process.argv[2]);
    const { groups, warnings } = parse(md);

    const names = Object.keys(groups);
    if (!names.length) throw new Error('parsed no groups at all — upstream shape has changed');
    if (!groups[DEFAULTS_GROUP]) warnings.push(`no "${DEFAULTS_GROUP}" group — the built-in list was not found`);

    // Sorted so a refresh diffs cleanly: upstream interleaves the phrase groups
    // alphabetically among the short ones, and a reordering there should not
    // look like a content change here.
    const sorted = {};
    for (const name of names.sort((a, b) => a.localeCompare(b))) sorted[name] = groups[name];

    const total = names.reduce((n, k) => n + groups[k].length, 0);
    const unique = new Set(names.flatMap(k => groups[k])).size;

    fs.writeFileSync(OUT, JSON.stringify({ version: 1, source: SOURCE, groups: sorted }, null, 2) + '\n');

    for (const w of warnings) console.warn(`  note: ${w}`);
    console.log(`${names.length} groups, ${total} verbs (${unique} unique) → ${path.relative(process.cwd(), OUT)}`);
}

// Exported for test/spinner.test.js, which parses a small fixture rather than
// the real 114KB README.
module.exports = { parse, cell, DEFAULTS_GROUP };

if (require.main === module) {
    main().catch((err) => { console.error(err.message); process.exit(1); });
}
