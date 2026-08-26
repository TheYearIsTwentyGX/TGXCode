#!/usr/bin/env node
'use strict';

// Point Claude Code's status line at scripts/quota-statusline.py.
//
// The quota percentages the app shows come out of the status line payload, and
// the only way to receive that payload is to be the status line — so this is a
// setup step, and it edits a file outside this repository. That makes it worth
// being careful about three things:
//
//   - **It writes ~/.claude/settings.json, which is the user's.** It adds one
//     key and rewrites nothing else, and it prints the block before it does.
//   - **It refuses rather than clobbers.** A `statusLine` that is already there
//     and is not ours is somebody's deliberate choice; wrapping an arbitrary
//     shell command in ours would be fragile and silent. It prints what to do
//     and stops.
//   - **It refuses to install from a worktree.** The path is baked into the
//     setting, and `.claude/worktrees/<name>` is deleted when the work lands —
//     which would leave a status line pointing at nothing.
//
// `--uninstall` takes the key back out, and only if it is ours.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// Seconds. Without this the status line re-runs only when something in the
// session changes, so an open-but-idle terminal stops refreshing the number.
// Thirty seconds costs a python start twice a minute and keeps the pill live.
const REFRESH_INTERVAL = 30;

function fail(msg) {
    console.error(msg);
    process.exit(1);
}

/**
 * The main checkout, not this worktree.
 *
 * `--git-common-dir` is the one that points at the real .git for a worktree,
 * where `--git-dir` gives the worktree's own. Falling back to the script's
 * parent covers a copy of this repo that is not a git checkout at all.
 */
function repoRoot() {
    const here = path.resolve(__dirname, '..');
    try {
        const common = execFileSync('git',
            ['-C', here, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
            { encoding: 'utf8' }).trim();
        if (common) return path.dirname(common);
    } catch { /* not a checkout, or no git */ }
    return here;
}

function readSettings() {
    let raw;
    try {
        raw = fs.readFileSync(SETTINGS, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
    }
    try {
        return JSON.parse(raw.replace(/^﻿/, ''));
    } catch (err) {
        fail(`${SETTINGS} is not valid JSON (${err.message}). Fix it first — this script will not rewrite a file it cannot parse.`);
    }
}

function writeSettings(data) {
    // Two spaces and a trailing newline: this is a file people open and edit,
    // and it is what Claude Code itself writes.
    const tmp = `${SETTINGS}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, SETTINGS);
}

const isOurs = (line) => !!line && typeof line.command === 'string'
    && line.command.includes('quota-statusline.py');

function main() {
    const uninstall = process.argv.includes('--uninstall');
    const settings = readSettings();
    const current = settings.statusLine;

    if (uninstall) {
        if (!current) fail('No statusLine is set, so there is nothing to remove.');
        if (!isOurs(current)) {
            fail('The statusLine in your settings is not this one — leaving it alone.\n'
                + `  ${JSON.stringify(current)}`);
        }
        delete settings.statusLine;
        writeSettings(settings);
        console.log(`Removed the quota status line from ${SETTINGS}.`);
        console.log('The pill keeps working off turn events; it just stops getting percentages.');
        return;
    }

    const root = repoRoot();
    if (root.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`)) {
        fail('Refusing to install from a worktree.\n'
            + `  ${root}\n`
            + 'That directory is deleted when the work lands, and the status line would\n'
            + 'be left pointing at nothing. Run this from the main checkout instead.');
    }

    const script = path.join(root, 'scripts', 'quota-statusline.py');
    if (!fs.existsSync(script)) {
        // The likely case, and one worth naming: run from a worktree, where
        // `repoRoot` deliberately resolves to the main checkout — which is the
        // path that survives the worktree being deleted, but does not have the
        // script in it until the branch lands.
        const here = path.join(__dirname, 'quota-statusline.py');
        if (fs.existsSync(here)) {
            fail(`Cannot find ${script}.\n`
                + `It exists here — ${here} — but the setting has to point at the main\n`
                + 'checkout, which this branch has not landed in yet. Land it first, then\n'
                + 'run this again from there.');
        }
        fail(`Cannot find ${script}.`);
    }

    const block = {
        type: 'command',
        command: `python3 ${JSON.stringify(script)}`,
        refreshInterval: REFRESH_INTERVAL,
    };

    if (current && !isOurs(current)) {
        console.error('You already have a status line, and it is not this one:');
        console.error(`  ${JSON.stringify(current, null, 2).replace(/\n/g, '\n  ')}`);
        console.error('');
        console.error('Not touching it. To harvest quota as well, call the script from your own');
        console.error('command and print its output — it writes the quota file as a side effect:');
        console.error(`  python3 ${JSON.stringify(script)}`);
        process.exit(1);
    }

    if (current && isOurs(current)
        && current.command === block.command
        && current.refreshInterval === block.refreshInterval) {
        console.log('Already installed, unchanged:');
        console.log(`  ${JSON.stringify(block, null, 2).replace(/\n/g, '\n  ')}`);
        return;
    }

    settings.statusLine = block;
    writeSettings(settings);

    console.log(`Wrote statusLine to ${SETTINGS}:`);
    console.log(`  ${JSON.stringify(block, null, 2).replace(/\n/g, '\n  ')}`);
    console.log('');
    console.log('It takes effect in terminal sessions you start from now on. Quota is');
    console.log('account-wide, so one open terminal keeps the percentage fresh for every');
    console.log('session in the app.');
}

main();
