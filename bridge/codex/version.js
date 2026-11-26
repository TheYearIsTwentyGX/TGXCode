'use strict';

// Is the `codex` we run the newest one, one we have looked at, and are the
// sessions on it? bridge/claude-version.js asked about Claude, asked about Codex:
// `codex --version`, npm's dist-tags for @openai/codex, and each runner's version.
//
// Two differences, both on purpose:
//
//   - **No update.** Claude Code has `claude update`; Codex is installed by npm,
//     by brew or from a release tarball, and the bridge cannot tell which would
//     be right to run. So the summary says how, and nothing here runs it.
//   - **The tested range.** `app-server` is experimental and its surface moves
//     between minor versions, so a Codex outside the range the fixtures were
//     recorded with (protocol.js TESTED, and bridge/codex/README) is said to be:
//     `outsideTested`. It is a warning, not a refusal.

const { ClaudeVersion, compareVersions, fetchTags } = require('../claude-version');
const { CODEX_BIN } = require('./client');
const { TESTED } = require('./protocol');

const REGISTRY_URL = 'https://registry.npmjs.org/-/package/@openai/codex/dist-tags';

const HOW_TO_UPDATE = 'Update it the way it was installed: `npm i -g @openai/codex@latest`, '
    + '`brew upgrade codex`, or a release from github.com/openai/codex/releases.';

/** `older`, `newer` or null for a version against the tested range. */
function outsideTested(version, range = TESTED) {
    if (!version) return null;
    if (compareVersions(version, range.min) < 0) return 'older';
    if (compareVersions(version, range.below) >= 0) return 'newer';
    return null;
}

/** What the route and the event carry. */
function summarizeCodex({ installed = null, tags = null, runners = {},
    checkedAt = null, error = null } = {}) {
    const latest = (tags && tags.latest) || null;
    const staleSessions = [];
    if (installed) {
        for (const [id, st] of Object.entries(runners || {})) {
            if (!st || st.runtime !== 'codex') continue;
            // `claudeVersion` is the process's version whatever the CLI.
            const v = st.claudeVersion;
            if (v && compareVersions(v, installed) < 0) staleSessions.push({ id, version: v });
        }
    }
    return {
        installed, latest, tag: 'latest',
        behind: !!(installed && latest && compareVersions(installed, latest) < 0),
        staleSessions,
        tested: { min: TESTED.min, below: TESTED.below },
        outsideTested: outsideTested(installed),
        howToUpdate: HOW_TO_UPDATE,
        checkedAt, error,
    };
}

class CodexVersion extends ClaudeVersion {
    constructor({ runners, bin = CODEX_BIN, tagsOf = () => fetchTags(REGISTRY_URL) } = {}) {
        super({ runners, bin, tagsOf });
    }

    /** Like Claude's, but the registry is not asked about a CLI that is not here. */
    async summary({ fresh = false } = {}) {
        const installed = await this.installed({ fresh });
        const tags = installed ? await this.latest({ fresh }) : this.tags;
        return this.summaryNow(installed, tags);
    }

    summaryNow(installed = this._known('installed'), tags = this.tags) {
        return summarizeCodex({
            installed, tags, runners: this.runnersOf(),
            checkedAt: this.checkedAt, error: this.error,
        });
    }

    update() { throw new Error('Codex is not updated from here'); }
}

module.exports = { CodexVersion, summarizeCodex, outsideTested, REGISTRY_URL, HOW_TO_UPDATE };
