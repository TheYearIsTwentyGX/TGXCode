'use strict';

// The PreToolUse hook's body, for Bash — see bridge/secret-hook for how it is
// started and bridge/secrets.js for the whole design.
//
// Reads the hook input on stdin and answers in one of three ways:
//
//   - nothing at all, which lets the call through unchanged and unapproved: the
//     command mentions no secret this project has;
//   - `updatedInput` with the command wrapped in bridge/secret-exec.js, and **no
//     `permissionDecision`**. Measured on CLI 2.1.312: the rewritten input is
//     what runs, and it still goes through the permission flow, evaluated
//     against the rewritten command. An "allow" here would approve, without a
//     card, a command that should have had one;
//   - a deny, for a command that names the secrets directory. The agent's Read
//     and Edit tools are kept out of it by permission rules (sessionSettings());
//     this is the same for Bash, and as easy to step around on purpose.
//
// Reads the names straight from the store rather than asking the bridge, so a
// command is wrapped even while the bridge is restarting — and the wrapper then
// refuses to run it, which is better than running it with `$KEY` empty. It never
// prints a value: what a hook prints is written to the transcript.

const secrets = require('./secrets');

const STORE_PATH = /(?:tgxcode|claude-sessions)\/secrets\b/;

function decide(input) {
    if (!input || input.tool_name !== 'Bash') return null;
    const toolInput = input.tool_input || {};
    const command = toolInput.command;
    if (typeof command !== 'string' || !command) return null;

    if (STORE_PATH.test(command) || command.includes(secrets.storeDir())) {
        return {
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'TGXCode keeps secret values out of reach on purpose. '
                    + 'Use a secret as $NAME in a Bash command; list_secrets says which exist.',
            },
        };
    }

    // Already wrapped: it is given its secrets, and wrapping it again would only
    // nest a second shell.
    if (secrets.unwrapCommand(command)) return null;

    const mentioned = secrets.referencedNames(command);
    if (!mentioned.size) return null;
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const known = new Set(secrets.list(secrets.projectRoot(cwd)).map(s => s.name));
    const names = [...mentioned].filter(n => known.has(n)).sort();
    if (!names.length) return null;

    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            // The whole input, because updatedInput replaces it: a timeout or
            // run_in_background left out would be dropped.
            updatedInput: { ...toolInput, command: secrets.wrapCommand(command, names) },
        },
    };
}

function main() {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => {
        let out = null;
        try { out = decide(JSON.parse(raw)); } catch { out = null; }
        if (out) process.stdout.write(JSON.stringify(out));
    });
}

if (require.main === module) main();

module.exports = { decide };
