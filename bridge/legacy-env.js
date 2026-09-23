'use strict';
// The app was called Claude Sessions before it was called TGXCode, and every
// variable it reads was spelled CLAUDE_SESSIONS_<X>. They are TGXCODE_<X> now,
// but the old spelling is still out there: a packaged shell built before the
// rename exports CLAUDE_SESSIONS_PORT when it launches the bridge, and a
// crontab line or a shell profile may set any of the others.
//
// So the old name is read as a fallback, here, once, rather than at each of the
// thirty places a variable is read: copy every CLAUDE_SESSIONS_<X> the
// environment has across to TGXCODE_<X> unless the new one is already set. The
// new name wins when both are present.
//
// Required at the top of every module that reads one of these at load —
// config.js, host.js, platform.js, mcp.js — because several destructure the
// value into a constant and a later alias would be too late. Idempotent, so
// requiring it from more than one of them costs nothing.

const OLD = 'CLAUDE_SESSIONS_';
const NEW = 'TGXCODE_';

function applyLegacyEnv(env = process.env) {
    for (const key of Object.keys(env)) {
        if (!key.startsWith(OLD)) continue;
        const renamed = NEW + key.slice(OLD.length);
        if (env[renamed] === undefined) env[renamed] = env[key];
    }
    return env;
}

applyLegacyEnv();

/**
 * Remove a variable under both spellings. A session must not inherit the
 * bridge's port under either name — see sessionEnv() in runner.js.
 */
function deleteBoth(env, suffix) {
    delete env[NEW + suffix];
    delete env[OLD + suffix];
}

module.exports = { applyLegacyEnv, deleteBoth };
