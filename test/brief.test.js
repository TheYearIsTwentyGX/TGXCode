'use strict';

// The agent brief — bridge/brief.js, and its keys in bridge/prefs.js.
//
// No bridge needed. The failures worth a test here are quiet ones: a section an
// agent is told about and then refused, a line about a feature that is switched
// off, a typo in an edited text that silently swallows the rest of the brief,
// and a project file that switches one section off and takes the user's edited
// texts with it. Every one of them reads as the agent being wrong rather than the
// app, which is why they are pinned here.
//
// **`HOME` is set before anything is required**, for test/prefs.test.js's reason:
// `new Prefs()` writes the defaults into the user's settings file.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'));
process.env.HOME = home;
process.env.TGXCODE_ROOTS = home;
delete process.env.TGXCODE_PREFS_DIR;

const brief = require('../bridge/brief.js');
const { Prefs, DEFAULTS } = require('../bridge/prefs.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const feats = (over = {}) => brief.featuresFor({ prefs: {}, ...over });
const yes = (names) => (n) => (names.includes(n) ? true : n.startsWith('no') ? false : undefined);

// --- the syntax --------------------------------------------------------------

{
    const t = yes(['a', 'b']);
    assert.strictEqual(brief.render('x{{#if a}}y{{/if}}z', t).text, 'xyz');
    assert.strictEqual(brief.render('x{{#if noA}}y{{/if}}z', t).text, 'xz');
    assert.strictEqual(brief.render('x{{#if !a}}y{{else}}Y{{/if}}z', t).text, 'xYz');
    assert.strictEqual(brief.render('{{#if a}}{{#if noB}}in{{else}}out{{/if}}{{/if}}', t).text, 'out',
        'nested, with else');
    assert.strictEqual(brief.render('{{#if noA}}{{#if a}}in{{/if}}{{/if}}gone', t).text, 'gone',
        'an inner true block inside an outer false one stays out');
    assert.strictEqual(brief.render('{{ #if a }}spaced{{ /if }}', t).text, 'spaced', 'whitespace inside a tag');
    ok('if, else, negation and nesting');
}

{
    // A tag alone on its line takes the line with it, so a left-out block
    // leaves no blank line behind — and neither does a kept one.
    const src = 'Tools:\n{{#if a}}\n- one\n{{/if}}\n{{#if noB}}\n- two\n{{/if}}\n- three';
    assert.strictEqual(brief.render(src, yes(['a'])).text, 'Tools:\n- one\n- three');
    assert.strictEqual(brief.render('  {{#if noA}}  \nhidden\n  {{/if}}\nshown', yes([])).text, 'shown',
        'indented standalone tags too');
    // Inline tags do not eat their line.
    assert.strictEqual(brief.render('a {{#if noA}}b {{/if}}c\nd', yes([])).text, 'a c\nd');
    // Three or more newlines left by removed content collapse to one blank line.
    assert.strictEqual(brief.render('p1\n\n{{#if noA}}gone{{/if}}\n\np2', yes([])).text, 'p1\n\np2');
    ok('standalone tags take their line; inline ones do not; blank runs collapse');
}

{
    // Unbalanced tags are kept as text and reported, never guessed at: a typo
    // must not silently swallow everything after it.
    let r = brief.render('a{{#if a}}b', yes(['a']));
    assert.strictEqual(r.text, 'a{{#if a}}b');
    assert.match(r.problems[0], /never closed/);
    r = brief.render('a{{#if noA}}b', yes([]));
    assert.strictEqual(r.text, 'a{{#if noA}}b', 'an unclosed false block is not dropped either');
    r = brief.render('a{{/if}}b', yes([]));
    assert.strictEqual(r.text, 'a{{/if}}b');
    assert.match(r.problems[0], /no open/);
    r = brief.render('{{else}}x', yes([]));
    assert.strictEqual(r.text, '{{else}}x');
    r = brief.render('{{#if a}}1{{else}}2{{else}}3{{/if}}', yes(['a']));
    assert.strictEqual(r.text, '1', 'a second else is text inside the else branch, which is not taken');
    assert.strictEqual(r.problems.length, 1);
    r = brief.render('{{#if a}}{{#if a}}in{{/if}}', yes(['a']));
    assert.strictEqual(r.text, '{{#if a}}in', 'the unclosed outer one is the one kept as text');
    // Unknown names are false and reported once; unknown variables stay text.
    r = brief.render('{{#if mystery}}x{{/if}}{{#if mystery}}y{{/if}}z', yes([]));
    assert.strictEqual(r.text, 'z');
    assert.strictEqual(r.problems.length, 1);
    assert.match(r.problems[0], /"mystery" is not a feature/);
    r = brief.render('{{nope}} {{sections}}', yes([]), { sections: 'S' });
    assert.strictEqual(r.text, '{{nope}} S');
    // Braces that are not one of our tags are left alone and not reported.
    r = brief.render('use ${port} and {{#if a b}} and {{ 1 + 1 }}', yes(['a']));
    assert.strictEqual(r.text, 'use ${port} and {{#if a b}} and {{ 1 + 1 }}');
    assert.strictEqual(r.problems.length, 0);
    ok('unbalanced tags and unknown names are kept or turned off, and reported');
}

{
    const { parts } = brief.renderParts('keep {{#if noA}}drop{{/if}} keep2 {{#if a}}x{{else}}y{{/if}}', yes(['a']));
    const off = parts.filter(p => !p.on);
    assert.deepStrictEqual(off.map(p => [p.text, p.why]), [['drop', 'noA'], ['y', 'else of a']]);
    ok('renderParts says what was left out and which condition did it, for the preview');
}

// --- composition ----------------------------------------------------------------

{
    const c = brief.compose({ brief: {}, features: feats() });
    const words = c.text.split(/\s+/).length;
    assert.ok(words >= 120 && words <= 260, `the default stays short (${words} words)`);
    assert.deepStrictEqual(c.problems, [], 'the shipped texts have no template problems');
    assert.match(c.text, /^# TGXCode/);
    assert.match(c.text, /may be reading on a phone/);
    assert.match(c.text, /tgxcode_guide/);
    for (const id of ['sessions', 'tasks', 'scheduling', 'phone', 'servers', 'browser']) {
        assert.match(c.text, new RegExp(`^- ${id}: `, 'm'), `${id} is listed`);
    }
    assert.doesNotMatch(c.text, /^- commands: /m, 'no project commands, no section');
    assert.doesNotMatch(c.text, /^- orchestration: /m, 'not a worker');
    assert.doesNotMatch(c.text, /report_to_orchestrator/);
    assert.doesNotMatch(c.text, /\{\{/, 'no tag survives');
    assert.doesNotMatch(c.text, /\n\n\n/);
    for (const s of brief.SECTIONS) {
        assert.ok(s.text.split(/\s+/).length < 220, `${s.id} stays a few short paragraphs`);
    }
    ok('the default brief is short, lists its sections, and has no stray tags');
}

{
    // Features off: the sections that need them go from the list and the tool,
    // and conditional lines inside the others follow.
    const on = brief.compose({ brief: {}, features: feats({ commands: [{ id: 'dev' }] }) });
    assert.match(on.text, /^- commands: /m);
    const servers = on.sections.find(s => s.id === 'servers');
    assert.match(servers.text, /DevBrowser/);

    const off = brief.compose({ brief: {},
        features: feats({ prefs: { devbrowser: { show: false }, agentBrowser: { mode: 'headless' } } }) });
    const s2 = off.sections.find(s => s.id === 'servers');
    assert.doesNotMatch(s2.text, /DevBrowser/, 'devbrowser off: not mentioned');
    assert.ok(s2.parts.some(p => !p.on && /DevBrowser/.test(p.text)), 'but the preview can show what went');
    const b = off.sections.find(s => s.id === 'browser');
    assert.match(b.text, /headless/);
    assert.match(off.text, /^- browser: testing pages in a browser \(headless here\)$/m, 'a summary can be conditional');
    const cmd = off.sections.find(s => s.id === 'commands');
    assert.strictEqual(cmd.available, false);
    assert.deepStrictEqual(cmd.missing, ['projectCommands']);
    ok('a section needing a feature that is off is left out, and conditional text inside one follows');
}

{
    // Switching a section off drops it from the list and drops the main brief's
    // line about it, because section ids are conditions too.
    const c = brief.compose({ brief: { phoneEnabled: false }, features: feats() });
    assert.doesNotMatch(c.text, /install_on_phone/);
    assert.doesNotMatch(c.text, /^- phone: /m);
    assert.strictEqual(c.sections.find(s => s.id === 'phone').available, false);
    // Every section off: no listing, and no sentence introducing one.
    const none = {};
    for (const id of brief.SECTION_IDS) none[`${id}Enabled`] = false;
    const bare = brief.compose({ brief: none, features: feats() });
    assert.doesNotMatch(bare.text, /tgxcode_guide/);
    assert.match(bare.text, /^# TGXCode/);
    // The master switch: nothing at all.
    const offAll = brief.compose({ brief: { enabled: false }, features: feats() });
    assert.strictEqual(offAll.enabled, false);
    assert.strictEqual(offAll.text, '');
    assert.ok(offAll.sections.every(s => !s.available));
    ok('section switches drop their lines; the master switch drops everything');
}

{
    // Edited texts replace the shipped ones whole; blank is not an edit.
    const c = brief.compose({ brief: {
        mainText: 'Mine. {{#if devbrowser}}DB{{/if}}{{#if sections}}\n{{sections}}{{/if}}',
        tasksText: 'My tasks text.', scheduling: 'ignored, not a key', serversText: '   ',
    }, features: feats() });
    assert.match(c.text, /^Mine\. DB\n- sessions: /);
    assert.strictEqual(c.main.edited, true);
    const tasks = c.sections.find(s => s.id === 'tasks');
    assert.strictEqual(tasks.text, 'My tasks text.');
    assert.strictEqual(tasks.edited, true);
    const servers = c.sections.find(s => s.id === 'servers');
    assert.strictEqual(servers.edited, false, 'whitespace alone is the default');
    assert.match(servers.text, /^## Dev servers/);
    const bad = brief.compose({ brief: { mainText: 'x {{#if devbrowser}} y' }, features: feats() });
    assert.match(bad.problems[0], /^Main brief: .*never closed/);
    ok('an edited text overrides the default whole, and its problems are reported by name');
}

// --- role ------------------------------------------------------------------

{
    const plain = brief.compose({ brief: {}, features: feats() });
    const worker = brief.compose({ brief: {}, features: feats({ role: 'worker' }) });
    const orch = brief.compose({ brief: {}, features: feats({ role: 'orchestrator' }) });
    assert.match(worker.text, /report_to_orchestrator/);
    assert.match(worker.text, /^- orchestration: /m);
    assert.doesNotMatch(plain.text, /orchestrat/i, 'nothing about orchestration for an ordinary session');
    // The orchestrator has its own brief; this one adds nothing orchestrator-only
    // and nothing meant for workers.
    assert.doesNotMatch(orch.text, /report_to_orchestrator|^- orchestration: /m);
    assert.strictEqual(orch.text, plain.text);
    assert.deepStrictEqual(brief.featuresFor({ prefs: {}, role: 'worker' }).worker, true);
    assert.deepStrictEqual(brief.featuresFor({ prefs: {}, role: 'bogus' }).worker, false);
    ok('worker lines reach workers only; an orchestrator gets what an ordinary session does');
}

// --- the guide tool's answers ------------------------------------------------

{
    const c = brief.compose({ brief: { phoneEnabled: false }, features: feats() });
    let g = brief.guide(c);
    assert.strictEqual(g.ok, true);
    assert.match(g.text, /- servers: /);
    assert.doesNotMatch(g.text, /- phone: /);
    g = brief.guide(c, ' Servers ');
    assert.strictEqual(g.ok, true);
    assert.match(g.text, /^## Dev servers & previews/);
    g = brief.guide(c, 'phone');
    assert.strictEqual(g.ok, false);
    assert.match(g.text, /switched off in Settings/);
    g = brief.guide(c, 'orchestration');
    assert.strictEqual(g.ok, false);
    assert.match(g.text, /applies only when the session is a worker/);
    g = brief.guide(c, 'nonsense');
    assert.strictEqual(g.ok, false);
    assert.match(g.text, /No topic "nonsense"[\s\S]*- tasks: /);
    g = brief.guide(brief.compose({ brief: { enabled: false }, features: feats() }), 'servers');
    assert.strictEqual(g.ok, false);
    assert.match(g.text, /switched off/);
    const w = brief.compose({ brief: {}, features: feats({ role: 'worker' }) });
    assert.match(brief.guide(w, 'orchestration').text, /^## Working for an orchestrator/);
    ok('the guide lists what is available and refuses what is not, saying why');
}

// --- the settings keys ----------------------------------------------------------

{
    const prefs = new Prefs();
    const userFile = path.join(home, '.tgxcode', 'settings.json');
    const project = path.join(home, 'proj');
    fs.mkdirSync(path.join(project, '.tgxcode'), { recursive: true });
    const projFile = path.join(project, '.tgxcode', 'settings.json');

    assert.strictEqual(DEFAULTS.brief.enabled, true);
    for (const id of brief.SECTION_IDS) {
        assert.strictEqual(DEFAULTS.brief[`${id}Enabled`], true);
        assert.strictEqual(DEFAULTS.brief[`${id}Text`], null);
    }
    const written = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    assert.strictEqual(written.brief.mainText, null, 'the defaults written out mean "the shipped text"');
    assert.deepStrictEqual(prefs.forCwd(project).problems, [], 'and read back without complaint');

    prefs.save({ scope: 'user', patch: { brief: { mainText: 'Mine', tasksText: 'T', phoneEnabled: false } } });
    // A project switches one section off without taking the user's texts with it.
    prefs.save({ scope: 'project', dir: project, patch: { brief: { serversEnabled: false } } });
    let b = prefs.forCwd(project).brief;
    assert.strictEqual(b.mainText, 'Mine');
    assert.strictEqual(b.tasksText, 'T');
    assert.strictEqual(b.phoneEnabled, false);
    assert.strictEqual(b.serversEnabled, false);
    assert.strictEqual(prefs.forCwd('').brief.serversEnabled, true, 'only in that project');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(projFile, 'utf8')).brief, { serversEnabled: false });

    // Reset to default is a null, which removes the key.
    prefs.save({ scope: 'user', patch: { brief: { mainText: null } } });
    b = prefs.forCwd(project).brief;
    assert.strictEqual(b.mainText, null);
    assert.ok(!('mainText' in JSON.parse(fs.readFileSync(userFile, 'utf8')).brief));

    assert.throws(() => prefs.save({ scope: 'user', patch: { brief: { mainText: 'x'.repeat(brief.MAX_TEXT + 1) } } }),
        (e) => e.code === 'value');
    assert.throws(() => prefs.save({ scope: 'user', patch: { brief: { nopeText: 'x' } } }),
        (e) => e.code === 'section');
    assert.throws(() => prefs.save({ scope: 'user', patch: { brief: { tasksEnabled: 'yes' } } }),
        (e) => e.code === 'value');

    // A hand-edited file with a bad value keeps the default for that key only.
    fs.writeFileSync(projFile, JSON.stringify({ brief: { tasksEnabled: 'no', phoneText: 'P' } }));
    prefs.cache.clear();
    const got = prefs.forCwd(project);
    assert.strictEqual(got.brief.tasksEnabled, true);
    assert.strictEqual(got.brief.phoneText, 'P');
    assert.ok(got.problems.some(p => /brief\.tasksEnabled/.test(p.message)));

    // And the whole path: what forCwd says is what compose is given.
    const c = brief.compose({ brief: got.brief, features: brief.featuresFor({ prefs: got }) });
    assert.strictEqual(c.sections.find(s => s.id === 'phone').text, 'P');
    ok('brief.* keys: defaults, per-key project override, null resets, bad values refused or dropped');
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} groups passed`);
