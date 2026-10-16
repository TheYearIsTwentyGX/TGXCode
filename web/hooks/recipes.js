// Recipes: hooks people actually want, ready to drop into the draft.
//
// Client-only and static — there is no store, no seeding and nothing on the
// wire, because a recipe is not a thing anybody owns. Choosing one does what
// typing it would: it adds a group to the draft for the scope on screen, so it
// still goes through Review and save, and nothing runs until it has been read.
//
// A recipe with a `script` also opens that script under the new hook, prefilled,
// at `.claude/hooks/<name>` beside the file it is going into. The script is its
// own save (script.js), and an existing file of that name is opened rather than
// overwritten.
//
// Several of these read the event with `python3`, and the card says so. Not jq,
// though it is the idiom: it was missing on the machine this was built on, and
// a hook whose interpreter is missing exits 127 — which Claude Code treats as
// a non-blocking error, so a guard that cannot run lets everything through.
// The scripts fail closed where that matters (block-rm-rf, protect-env): a
// missing python3 blocks with a sentence rather than allowing silently.

import { html } from '../vendor/preact.js';
import { hkAddEventNamed, hkEditable, hkKey } from './editor.js';
import { hkState, renderHooks } from './page.js';
import { openScript, scriptMayLeave } from './script.js';

export const HOOK_RECIPES = [
    {
        id: 'block-rm-rf',
        title: 'Block rm -rf',
        blurb: 'Refuses a Bash call that runs rm with both -r and -f, and tells Claude why. Needs python3.',
        event: 'PreToolUse',
        matcher: 'Bash',
        script: {
            name: 'block-rm-rf.sh',
            body: `#!/usr/bin/env bash
# Refuse \`rm -rf\` in a Bash call. Exit 2 blocks the call and sends stderr to Claude.
set -euo pipefail
command -v python3 >/dev/null || { echo "Blocked: this hook needs python3 to read the call." >&2; exit 2; }
cmd=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))')
if printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])rm[[:space:]]+(-[[:alpha:]]*r[[:alpha:]]*f|-[[:alpha:]]*f[[:alpha:]]*r|-r[[:space:]]+-f|-f[[:space:]]+-r)'; then
  echo "Blocked by a hook: rm -rf is not allowed here. Remove specific paths instead." >&2
  exit 2
fi
exit 0
`,
        },
    },
    {
        id: 'protect-env',
        title: 'Keep .env files out',
        blurb: 'Blocks reading or editing .env and .env.* files, so secrets stay out of the transcript. Needs python3.',
        event: 'PreToolUse',
        matcher: 'Read|Edit|Write',
        script: {
            name: 'protect-env.sh',
            body: `#!/usr/bin/env bash
# Block Read, Edit and Write on .env files. Exit 2 blocks the call.
set -euo pipefail
command -v python3 >/dev/null || { echo "Blocked: this hook needs python3 to read the call." >&2; exit 2; }
file=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input", {}).get("file_path", ""))')
case "$(basename -- "$file")" in
  .env|.env.*)
    echo "Blocked by a hook: $file holds secrets and is off limits." >&2
    exit 2 ;;
esac
exit 0
`,
        },
    },
    {
        id: 'format-on-edit',
        title: 'Format after an edit',
        blurb: 'Runs the project’s own Prettier, gofmt or Black on a file Claude has just written. Skips quietly when none is installed. Needs python3.',
        event: 'PostToolUse',
        matcher: 'Edit|Write',
        script: {
            name: 'format-on-edit.sh',
            body: `#!/usr/bin/env bash
# Format the file that was just edited, with whatever the project already uses.
# Never fails the turn: a formatter that is missing or unhappy is not Claude's problem.
file=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input", {}).get("file_path", ""))' 2>/dev/null)
[ -f "$file" ] || exit 0
case "$file" in
  *.js|*.jsx|*.ts|*.tsx|*.css|*.scss|*.json|*.md|*.html)
    bin="\${CLAUDE_PROJECT_DIR:-.}/node_modules/.bin/prettier"
    [ -x "$bin" ] && "$bin" --write --log-level=warn "$file" ;;
  *.go) command -v gofmt >/dev/null && gofmt -w "$file" ;;
  *.py) command -v black >/dev/null && black -q "$file" ;;
esac
exit 0
`,
        },
    },
    {
        id: 'notify-stop',
        title: 'Notify when a turn ends',
        blurb: 'A desktop notification each time Claude finishes answering — notify-send on Linux, osascript on macOS.',
        event: 'Stop',
        matcher: null,
        script: {
            name: 'notify-stop.sh',
            body: `#!/usr/bin/env bash
# A desktop notification when a turn ends. Whichever notifier this machine has.
msg="Finished in $(basename -- "\${CLAUDE_PROJECT_DIR:-$PWD}")"
if command -v notify-send >/dev/null; then
  notify-send "Claude Code" "$msg"
elif command -v osascript >/dev/null; then
  osascript -e "display notification \\"$msg\\" with title \\"Claude Code\\""
else
  printf '\\a'
fi
exit 0
`,
        },
    },
    {
        id: 'log-prompts',
        title: 'Log every prompt',
        blurb: 'Appends each prompt, with its session and time, to ~/.claude/prompt-log.jsonl. One line, no script. Needs python3.',
        event: 'UserPromptSubmit',
        matcher: null,
        hook: {
            type: 'command',
            command: 'python3 -c \'import json,sys,datetime; e=json.load(sys.stdin); '
                + 'print(json.dumps({"at": datetime.datetime.now().isoformat(timespec="seconds"), '
                + '"session": e.get("session_id"), "cwd": e.get("cwd"), "prompt": e.get("prompt")}))\' '
                + '>> ~/.claude/prompt-log.jsonl',
        },
    },
    {
        id: 'git-context',
        title: 'Start with git status',
        blurb: 'At the start of a session, gives Claude the branch and the uncommitted files — SessionStart output is added to the context.',
        event: 'SessionStart',
        matcher: 'startup|resume',
        hook: {
            type: 'command',
            command: 'git status --short --branch 2>/dev/null | head -n 40',
            timeout: 10,
        },
    },
];

/**
 * Where a recipe's script goes for the scope on screen, and the command that
 * runs it from there.
 *
 * A project file names it through `$CLAUDE_PROJECT_DIR`, quoted whole — which is
 * what makes it work from any subdirectory, and the form the bridge's script
 * check reads as one path. A user file names it under `~`, which the shell
 * expands.
 */
function scriptPlace(name) {
    const s = hkState();
    if (s.scope === 'user') return { path: `~/.claude/hooks/${name}`, command: `~/.claude/hooks/${name}` };
    const dir = (s.dir || '').replace(/\/+$/, '');
    return {
        path: `${dir}/.claude/hooks/${name}`,
        command: `"$CLAUDE_PROJECT_DIR/.claude/hooks/${name}"`,
    };
}

/** Put a recipe into the draft, open on its event, with its script if it has one. */
export function addRecipe(r) {
    if (!scriptMayLeave()) return;
    const s = hkState();
    const place = r.script ? scriptPlace(r.script.name) : null;
    const hook = r.script
        ? { type: 'command', command: place.command }
        : { ...r.hook };
    hook._k = hkKey();
    hook._script = place ? { file: place.path, path: place.path, exists: false, executable: null } : null;
    // Matcher first, the order every example in the docs writes it in.
    const group = r.matcher ? { _k: hkKey(), matcher: r.matcher, hooks: [hook] } : { _k: hkKey(), hooks: [hook] };
    if (!hkAddEventNamed(r.event, { group, append: true })) return;
    s.event = r.event;
    s.recipes = false;
    if (place) openScript(hook._k, place.path, { seed: r.script.body });
    else renderHooks();
}

/** The picker, drawn above the editor while it is open. */
export function RecipePicker() {
    const s = hkState();
    const editable = hkEditable();
    return html`<div class="hkp-recipes">
        <div class="hkp-recipes-head">
            <strong>Start from a recipe</strong>
            <span class="cmd-field-note">${editable
                ? 'Each adds a hook to this file’s draft — nothing is written until you review and save.'
                : 'This file cannot be written. Pick a scope you can write first.'}</span>
            <div class="cmd-card-spacer"></div>
            <button class="cfg-list-x hk-mini" type="button" title="Close" aria-label="Close the recipes"
                onClick=${() => { s.recipes = false; renderHooks(); }}>×</button>
        </div>
        <div class="hkp-recipe-grid">
            ${HOOK_RECIPES.map(r => html`<div key=${r.id} class="hkp-recipe">
                <div class="hkp-recipe-title">${r.title}</div>
                <div class="hkp-recipe-on"><code>${r.event}${r.matcher ? ` · ${r.matcher}` : ''}</code>${
                    r.script ? html` <span class="cfg-tab-tag">${`+ ${r.script.name}`}</span>` : null}</div>
                <p class="hkp-recipe-blurb">${r.blurb}</p>
                <button class="btn small" type="button" disabled=${!editable} onClick=${() => addRecipe(r)}>Add</button>
            </div>`)}
        </div>
    </div>`;
}
