# 14 — Bridge security

**Effort:** S for auth, M for remote · **Depends on:** none · **Blocks:** 05-C,
15 · **Touches:** `bridge/config.js`, `bridge/server.js`, `app/main.js`,
`install.ps1`, `web/app.js`

## Why

The bridge can start a Claude Code session with `bypassPermissions` in any
directory on the machine. What stands in front of that today:

```js
// server.js:109-114
const origin = req.headers.origin;
if (origin && !isOwnOrigin(origin)) return send(res, 403, {...});
if (pathname.startsWith('/api/') && pathname !== '/api/health'
    && req.method !== 'GET' && !req.headers[CLIENT_HEADER]) {
    return send(res, 403, { error: 'missing client header' });
}
```

Both checks are real and both are aimed at the right threat — a random web page
in another tab driving Claude. They work for that. Neither is authentication:

- The origin check only applies when an `Origin` header is *present*. Anything
  that isn't a browser simply omits it.
- `X-Claude-Sessions-Client: 1` is a constant, published in this repo.

So any process on the machine, and anything that can reach loopback, can
`POST /api/sessions` with `permissionMode: bypassPermissions` and a `cwd` of its
choosing. On a single-user desktop that is a modest risk. It stops being modest
the moment plan 05-C puts an OAuth token in the bridge's memory, or plan 15 lets
sessions start unattended.

Worth stating plainly: this is hardening a local tool, not fixing a live
vulnerability. It is cheap and it unblocks two other plans.

## A. Token auth

- Generate a token on first run: `randomUUID()` into
  `~/.local/share/claude-sessions/token` with mode `0600`.
- Require it on every `/api/` route except `/api/health` (which stays open so
  `app/main.js:59`'s `ping()` and any health check keep working — it already
  leaks only counts and a pid).
- Accept it as `Authorization: Bearer …` or `?token=` for the `EventSource`
  case, since `EventSource` cannot set headers.
- **Serving the token to the UI.** The bridge serves `web/` itself, so
  `index.html` can be served with the token injected as a `<meta>` tag when the
  request comes from loopback with no `Origin`. Simple, and it keeps the browser
  workflow (`npm run bridge`, open 127.0.0.1:45888) working with no login step.
- `app/main.js` reads the token the same way it reads the bridge log — through
  `wsl.exe bash -lc cat …` — for its own SSE connection (plan 02).
- Compare with `crypto.timingSafeEqual`.

Keep the origin and client-header checks. Defence in depth, and they catch
different mistakes.

## B. Bind and expose deliberately

`HOST` is already configurable (`config.js:20`). Add refusals rather than
trusting the operator:

- If `HOST` is not loopback and no token file exists, **refuse to start** with a
  clear message.
- If `HOST` is not loopback, log every authenticated request's source address.
- Never bind `0.0.0.0` by default, and say why in the config comment.

## C. Optional remote access

The real want: checking on a long run from a phone.

**Do not build a tunnel.** Recommend an existing one — Tailscale on this machine
already solves it, and `HOST` plus a token is all the app needs to work behind
it. Document that as the supported path.

If it is built later, the requirements are: TLS terminated by something else, a
token with an expiry, a read-only mode (`GET` and SSE only, no send, no new
session), and a visible banner in the UI when the session is remote. A phone
should be able to *watch*, and arguably to approve a permission prompt (plan
01), but not to start a `bypassPermissions` session.

## D. Smaller hardening, worth doing regardless

- **`cwd` validation on session creation.** `pool.create` only checks
  `fs.existsSync` (`runner.js:405`). Restrict to a configured set of roots —
  default `$HOME` — so a compromised caller can't start an agent in `/etc`.
- **Rate-limit session creation.** A loop calling `POST /api/sessions` currently
  spawns processes as fast as it can.
- **`/api/fs` traversal.** `listDir` (`server.js:374`) will list any directory
  on the machine. It is only used by the new-session picker; scope it to the
  same roots.
- **Redact the 500 handler.** `server.js:120` returns `err.stack` to the client.
  Fine for a local tool, sloppy if anything is ever exposed. Log the stack,
  return the message.

## Acceptance

- With a token file present, a `curl` without the token gets 401 on everything
  but `/api/health`.
- The Electron app and a plain browser both work with no visible change.
- Starting the bridge on a non-loopback host without a token fails loudly.
- `POST /api/sessions` with `cwd: "/etc"` is refused.
