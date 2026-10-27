// open_in_preview, as this window carries it out — the decisions without the DOM.
//
// web/preview-agent.js wires it to the shell and the bridge; it is on its own so
// test/preview-open.test.js can drive it with a stub shell built on the real
// grant store (app/preview-grants.js), which is where the rules are. Imports
// nothing, so it loads in node as well as in the page.
//
// The answers it gives the bridge are what the agent reads, word for word,
// through bridge/mcp.js:
//
//   opened    the page is in the preview
//   waiting   the user has not answered yet; the ask stays open and the page
//             opens by itself on a yes
//   denied    the user said no to that site
//   failed    anything else — the window refused the URL, or could not show it

export const OPEN_WAIT_MS = 60_000;

export function hostOf(url) {
    try { return new URL(url).host; } catch { return String(url); }
}

export const deniedText = (host) => `Not opened: the user denied ${host} for agent control.`;
export const waitingText = (host) => `Waiting for the user to approve ${host}. The prompt stays open until they `
    + 'answer, and the page opens in the preview by itself when they allow it. Check back later, or call '
    + 'open_in_preview again to see the outcome.';

/**
 * @param {{id: string, url: string, sessionId?: string|null}} req
 * @param {object} d
 * @param {object} d.shell        window.claudeShell.previewAgent, or a stand-in
 * @param {(body: object) => Promise<any>} d.answer   POST to /api/preview/open/:id
 * @param {(url: string) => Promise<boolean>} d.show  put a URL in the preview
 * @param {() => void} d.reveal   make sure the preview, where the ask is, is on screen
 * @param {number} [d.waitMs]
 */
export async function openForAgent({ url, sessionId = null }, { shell, answer, show, reveal, waitMs = OPEN_WAIT_MS }) {
    const host = hostOf(url);
    const r = await shell.request(url, sessionId).catch(() => null);
    if (!r || r.state === 'refused') return answer({ ok: false, outcome: 'failed', error: 'the window refused that URL' });
    if (r.state === 'denied') return answer({ ok: false, outcome: 'denied', error: deniedText(host) });
    if (r.state === 'granted') {
        const ok = await show(url);
        return answer(ok ? { ok: true, outcome: 'opened', url }
            : { ok: false, outcome: 'failed', error: 'the preview could not show it' });
    }
    // Being asked. The bar is in the preview, so put the preview where it is seen.
    reveal();
    // The same session asking again gets where things stand, not another minute.
    if (r.repeat) return answer({ ok: false, outcome: 'waiting', error: waitingText(host) });
    await answer({ pending: true });
    const decision = await shell.wait(r.origin, waitMs).catch(() => 'waiting');
    // A yes was answered in the window, which opened the page there and then.
    if (decision === 'once' || decision === 'always') return answer({ ok: true, outcome: 'opened', url });
    if (decision === 'deny') return answer({ ok: false, outcome: 'denied', error: deniedText(host) });
    if (decision === 'gone') return answer({ ok: false, outcome: 'failed', error: 'the request was withdrawn' });
    return answer({ ok: false, outcome: 'waiting', error: waitingText(host) });
}
