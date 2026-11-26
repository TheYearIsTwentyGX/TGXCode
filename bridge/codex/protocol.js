'use strict';

// What the app-server says at the Codex version this bridge is tested against.
//
// The lists are copied out of docs/codex-schema/<TESTED.schema>/ — the
// `ServerNotification` and `ServerRequest` unions of the generated schema — and
// test/codex-rpc.test.js fails when they stop matching it, so an upgrade that
// regenerates the schema is told which names moved. That is the whole purpose of
// writing them out: `Connection` logs-once-and-drops any notification not in
// KNOWN_NOTIFICATIONS, and the set has to describe a real build for "unknown"
// to mean "newer than we have looked at".
//
// The range is in bridge/codex/README as well, which is where a person looks.
// Keep the two in step.

const TESTED = {
    /** Lowest `codex --version` the fixtures were recorded with. */
    min: '0.172.0',
    /** First version we have not looked at. Exclusive. */
    below: '0.173.0',
    /** Directory under docs/codex-schema/ that these lists come from. */
    schema: '0.172.0',
};

const KNOWN_NOTIFICATIONS = Object.freeze([
    'error', 'thread/started', 'thread/status/changed', 'thread/readState/changed',
    'thread/archived', 'thread/deleted', 'thread/unarchived', 'thread/closed',
    'thread/reverted', 'skills/changed', 'thread/name/updated', 'thread/section/changed',
    'thread/attachment/updated', 'thread/goal/updated', 'thread/prediction/updated',
    'thread/goal/cleared', 'thread/queue/changed', 'project/changed',
    'thread/project/updated', 'thread/environment/connected',
    'thread/environment/disconnected', 'thread/settings/updated',
    'thread/tokenUsage/updated', 'turn/started', 'hook/started', 'turn/completed',
    'hook/completed', 'turn/diff/updated', 'turn/plan/updated', 'item/started',
    'item/autoApprovalReview/started', 'item/autoApprovalReview/completed',
    'autoApprovalReview/strictReviewRequired', 'item/completed',
    'item/agentMessage/delta', 'item/plan/delta', 'command/exec/outputDelta',
    'process/outputDelta', 'thread/search/partial', 'process/exited',
    'item/commandExecution/outputDelta', 'item/commandExecution/terminalInteraction',
    'item/fileChange/outputDelta', 'item/fileChange/patchUpdated',
    'serverRequest/resolved', 'item/mcpToolCall/progress',
    'mcpServer/oauthLogin/completed', 'mcpServer/startupStatus/updated',
    'mcpServer/event/stream/notification', 'account/updated',
    'account/gatewayOAuth/changed', 'account/rateLimits/updated', 'app/list/updated',
    'remoteControl/status/changed', 'externalAgentConfig/import/progress',
    'externalAgentConfig/import/completed', 'fs/changed',
    'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded',
    'item/reasoning/textDelta', 'thread/compacted', 'model/rerouted',
    'model/verification', 'modelProvider/authRecoveryStarted',
    'modelProvider/authRecoveryCompleted', 'turn/moderationMetadata',
    'model/safetyBuffering/updated', 'warning', 'guardianWarning', 'deprecationNotice',
    'configWarning', 'fuzzyFileSearch/sessionUpdated', 'fuzzyFileSearch/sessionCompleted',
    'thread/realtime/started', 'thread/realtime/itemAdded',
    'thread/realtime/item/started', 'thread/realtime/item/transcript/delta',
    'thread/realtime/item/completed', 'thread/realtime/transcript/delta',
    'thread/realtime/transcript/done', 'thread/realtime/outputAudio/delta',
    'thread/realtime/sdp', 'thread/realtime/error', 'thread/realtime/closed',
    'windows/worldWritableWarning', 'windowsSandbox/setupCompleted',
    'account/login/completed',
]);

const SERVER_REQUESTS = Object.freeze([
    'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
    'item/tool/requestUserInput', 'mcpServer/elicitation/request',
    'item/permissions/requestApproval', 'item/tool/call',
    'account/chatgptAuthTokens/refresh', 'attestation/generate', 'applyPatchApproval',
    'execCommandApproval',
]);

/**
 * Notifications a conversation view never uses, to pass as
 * `capabilities.optOutNotificationMethods` so Codex does not send them at all.
 * Voice, fuzzy search and remote control belong to other clients.
 */
const OPT_OUT = Object.freeze(KNOWN_NOTIFICATIONS.filter(m =>
    m.startsWith('thread/realtime/') || m.startsWith('fuzzyFileSearch/')
    || m.startsWith('remoteControl/') || m.startsWith('windows')));

/** "codex-cli 0.172.0" → [0, 172, 0]; null for anything else. */
function parseVersion(s) {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a, b) {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
}

/** Is this `codex --version` output inside the tested range? null when unreadable. */
function inTestedRange(s) {
    const v = parseVersion(s);
    if (!v) return null;
    return cmp(v, parseVersion(TESTED.min)) >= 0 && cmp(v, parseVersion(TESTED.below)) < 0;
}

module.exports = {
    TESTED, KNOWN_NOTIFICATIONS, SERVER_REQUESTS, OPT_OUT, parseVersion, inTestedRange,
};
