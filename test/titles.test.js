'use strict';

// What a session is called in the rail, when nothing named it.
//
// Here rather than against a live bridge for the reason handoff.test.js gives:
// the behaviour is a property of `scanMeta` reading a transcript, and the case
// that matters cannot be provoked through a request — it needs a transcript
// whose first user entry is a slash-command invocation.
//
// **The bug this is made of.** A session that has no `custom-title`,
// `agent-name` or `ai-title` — which is every headless run, so every scheduled
// one — falls through to the first line of its first prompt. Claude Code writes
// a slash command as XML-ish tags, and `stripEnvelope` leaves them alone on
// purpose (the conversation view parses them back into a command chip). So the
// first *line* of that prompt was the whole of the first tag, and a fortnight of
// nightly reviews sat in the rail all titled
// `<command-message>adversarial-reviewer</command-message>`.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanMeta, commandText, stripEnvelope } = require('../bridge/transcript.js');
const { scheduledTitle } = require('../bridge/sessions.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-titles-'));
process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* going away anyway */ }
});

function transcript(name, lines) {
    const file = path.join(TMP, `${name}.jsonl`);
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    return file;
}

// A command reaches the transcript as a *string* content, not as text blocks —
// this is copied from a real one rather than invented.
const said = (text, timestamp) => ({
    type: 'user',
    timestamp,
    cwd: '/home/dylan_hays/LTCDataPlus',
    message: { role: 'user', content: text },
});

// --- the unwrap itself ---------------------------------------------------

{
    const withArgs = '<command-message>adversarial-reviewer</command-message>\n'
        + '<command-name>/adversarial-reviewer</command-name>\n'
        + '<command-args>--diff 871f99db2d87..dfe876fad9e5\n\nReview 3 commit(s).</command-args>';
    assert.strictEqual(commandText(withArgs),
        '/adversarial-reviewer --diff 871f99db2d87..dfe876fad9e5\n\nReview 3 commit(s).');

    // A command that takes none omits the tag entirely, rather than sending an
    // empty one — so the trailing space has to be conditional.
    const noArgs = '<command-message>claude-md-improver</command-message>\n'
        + '<command-name>/claude-md-management:claude-md-improver</command-name>';
    assert.strictEqual(commandText(noArgs), '/claude-md-management:claude-md-improver');

    // Anything that is not a command passes through untouched. This runs over
    // every first prompt in the index, so it must be inert on ordinary prose.
    assert.strictEqual(commandText('have a look at the importer'),
        'have a look at the importer');
    assert.strictEqual(commandText(''), '');
    assert.strictEqual(commandText(null), null);

    // Prose that merely *mentions* the tag is not an invocation: there is no
    // <command-name>, so there is nothing to rewrite it to.
    assert.strictEqual(commandText('why does <command-message>x</command-message> appear?'),
        'why does <command-message>x</command-message> appear?');

    ok('commandText unwraps an invocation, with args and without, and leaves prose alone');
}

{
    // The division of labour, asserted so it cannot drift: stripEnvelope must
    // *keep* the command tags, because buildEvents parses them back out to draw
    // the command chip. Deleting them there would lose the command rather than
    // render it — which is why the unwrap is a separate function.
    const cmd = '<command-name>/foo</command-name>';
    assert.strictEqual(stripEnvelope(cmd), cmd);
    assert.strictEqual(stripEnvelope('a<system-reminder>x</system-reminder>b'), 'ab');
    ok('stripEnvelope still leaves a command invocation for buildEvents to parse');
}

// --- the title that comes out of it --------------------------------------

{
    const scheduled = scanMeta(transcript('scheduled', [
        said('<command-message>adversarial-reviewer</command-message>\n'
            + '<command-name>/adversarial-reviewer</command-name>\n'
            + '<command-args>--diff 871f99db2d87..dfe876fad9e5\n\n'
            + 'Review 3 commit(s) that landed.</command-args>',
        '2026-08-26T07:00:08.073Z'),
    ]));

    assert.strictEqual(scheduled.titleSource, 'prompt');
    assert.strictEqual(scheduled.title,
        '/adversarial-reviewer --diff 871f99db2d87..dfe876fad9e5');
    assert.ok(!scheduled.title.includes('<command-'),
        'the tag must not survive into the title');

    // firstPrompt is the search haystack and the fallback subtitle, so it is
    // unwrapped too rather than only the line taken off it.
    assert.ok(scheduled.firstPrompt.startsWith('/adversarial-reviewer --diff '));
    assert.ok(!scheduled.firstPrompt.includes('<command-'));

    ok('a session started by a slash command is titled with the command, not the tag');
}

{
    // A title somebody chose still wins over the prompt, command or not.
    const named = scanMeta(transcript('named', [
        said('<command-name>/foo</command-name>', '2026-08-26T07:00:08.073Z'),
        { type: 'custom-title', customTitle: 'the importer bug' },
    ]));
    assert.strictEqual(named.title, 'the importer bug');
    assert.strictEqual(named.titleSource, 'custom-title');
    ok('a title set by hand outranks the prompt');
}

{
    const prose = scanMeta(transcript('prose', [
        said('have a look at the importer\nand the second line', '2026-08-26T07:00:08.073Z'),
    ]));
    assert.strictEqual(prose.title, 'have a look at the importer');
    ok('an ordinary prompt still titles from its first line');
}

// --- and the title a schedule then puts on it ----------------------------
//
// One run of a schedule looks like the next, so the command alone is not enough
// to tell a fortnight of them apart. The schedule's name and the day it ran are.

{
    const sched = { id: 'sch-1', title: 'nightly review' };
    // Midday local, so the assertion cannot depend on the host's offset. The
    // *date* deliberately is local — "the day it ran" means the day it was here,
    // not in UTC, and a 2 AM schedule is on the wrong side of that boundary for
    // most of the world if it is read any other way.
    const local = (y, mo, d) => new Date(y, mo - 1, d, 12).toISOString();
    const firstTs = local(2026, 8, 31);

    assert.strictEqual(scheduledTitle({ titleSource: 'prompt', firstTs }, sched),
        'nightly review - 8/31/26');

    // The date is formatted on the bridge, not in a client, so the rail, the
    // header and the phone cannot disagree — and by hand, because
    // toLocaleDateString gives a four-digit year and moves with the locale.
    assert.strictEqual(scheduledTitle({ titleSource: 'prompt',
        firstTs: local(2026, 1, 5) }, sched), 'nightly review - 1/5/26');
    // A year that needs the leading zero it would not otherwise get.
    assert.strictEqual(scheduledTitle({ titleSource: 'prompt',
        firstTs: local(2000, 12, 25) }, sched), 'nightly review - 12/25/00');

    // A transcript with no timestamp at all still gets the name.
    assert.strictEqual(scheduledTitle({ titleSource: 'prompt', firstTs: null }, sched),
        'nightly review');
    assert.strictEqual(scheduledTitle({ titleSource: 'prompt', firstTs: 'nonsense' }, sched),
        'nightly review');

    // **A name somebody chose outranks where the session came from.** Renaming a
    // scheduled run is a decision about that one conversation; the schedule's
    // name is only a better fallback than the prompt. `agent-name` is likewise
    // a name something picked deliberately.
    for (const src of ['custom-title', 'agent-name']) {
        assert.strictEqual(scheduledTitle({ titleSource: src, firstTs }, sched), null,
            `${src} must not be overridden`);
    }
    // Everything below that is a fallback and this is a better one.
    for (const src of ['ai-title', 'prompt', 'none', 'registry']) {
        assert.ok(scheduledTitle({ titleSource: src, firstTs }, sched),
            `${src} should take the schedule's name`);
    }

    // No schedule, no override — which is nearly every session.
    assert.strictEqual(scheduledTitle({ titleSource: 'prompt', firstTs }, null), null);

    ok('a scheduled session is named for its schedule and the day, unless you renamed it');
}

console.log(`\n${pass} groups passed`);
