# Reaching this from a phone

The app's premise is watching sessions you are not sitting in front of, and until
now that stopped at the edge of the desk. This is how it reaches further.

Two halves, and they are independent:

- **The bridge** now authenticates, tells local from remote apart, and serves a
  phone-shaped UI at `/m`. That part is done and needs no configuration.
- **The transport** — how a phone reaches the bridge at all — is a deployment
  choice, and this document is the runbook for it.

## The constraint this is designed around

There is no port forwarding available here: the connection is AT&T Community
Wi-Fi for Apartments. It is also worth being blunt about what that network *is* —
`10.11.64.0/24`, shared with the building, with client isolation misconfigured in
both directions. You can see your neighbours; they can see you.

So "just bind the LAN" is not a mild convenience with a small caveat. It is
offering a service that can start processes on this machine to a subnet full of
strangers. The bridge refuses to do it without a second, explicit environment
variable, and this document does not recommend it.

Everything below keeps the bridge bound to `127.0.0.1`.

## Recommended: `tailscale serve`

Free, no server to pay for, no port forwarding, and outbound-only — it makes an
outbound connection and relays through Tailscale's DERP servers when direct NAT
traversal fails, which is the shape you want when neither end has a reachable
address.

It also happens to be already installed on the Windows host.

**Why the bridge never has to leave loopback.** WSL runs with
`networkingMode=mirrored`, so Windows reaches the bridge on `127.0.0.1` — this is
how the Electron shell already talks to it. `tailscale serve` runs on the *Windows*
side and proxies to that same loopback address. The socket stays where it is; only
Tailscale is exposed, and only to your own devices.

### Setup

1. **Check Tailscale is up.** This machine is `tg-dylanh` on tailnet
   `taild5c420.ts.net`, so the bridge's public name will be
   `tg-dylanh.taild5c420.ts.net`.

   ```powershell
   tailscale status
   ```

2. **Enable HTTPS certificates for the tailnet**, once, in the admin console
   (*DNS → HTTPS Certificates*). **This is not yet done** — `tailscale status
   --json` reports `CertDomains: null` — and `--https=443` will not work until it
   is.

   It matters for more than comfort: the phone UI is a PWA, and a service worker,
   installability and (later) web push all require a secure context.

3. **Publish the bridge**, from a Windows shell:

   ```powershell
   tailscale serve --bg --https=443 http://127.0.0.1:45888
   tailscale serve status
   ```

   Until certificates are enabled you can prove the plumbing over plain HTTP, which
   is how the chain below was verified:

   ```powershell
   tailscale serve --bg --http=8099 http://127.0.0.1:45901   # a dev bridge
   tailscale serve --http=8099 off                           # and away again
   ```

   **This path is confirmed working.** A request to
   `http://tg-dylanh.taild5c420.ts.net:8099/api/health` from the Windows host
   reaches the WSL bridge and comes back with `"remote": true`, with `root` and
   `home` withheld — so Tailscale's `x-forwarded-*` headers are arriving and the
   classification in `bridge/auth.js` is reading them correctly against the real
   proxy. The refusals fire over the same path: `/api/terminals/*` and
   `bypassPermissions` both 403 while `/api/sessions` and `/m` are fine.

4. **Install Tailscale on the phone** and sign in to the same tailnet.

5. **Pair the phone.** In the desktop window, press the phone button in the top bar.
   It asks the bridge what this machine is actually called — `/api/pairing` shells
   out to `tailscale.exe` — so the link comes prefilled and correct, and the note
   underneath tells you whether `tailscale serve` is already pointing at this port
   or still needs running. Or build it by hand:

   ```bash
   echo "https://$(/mnt/c/Program\ Files/Tailscale/tailscale.exe status --json \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
     )/pair?token=$(cat ~/.local/share/claude-sessions/token)"
   ```

   Open it once on the phone. It sets an `HttpOnly` cookie good for a year and
   redirects to `/m`; after that the token is never in a URL again. Add it to the
   home screen and it opens standalone.

   **If the phone shows "This device is not paired"**, that is the pairing link not
   having been opened, or having been opened on a different browser than the one you
   are looking at. The bridge log says so plainly:
   `rejected GET /api/sessions from <ip> — no valid token`.

6. **Test it properly — with Wi-Fi off.** On the same Wi-Fi you may be talking
   directly over the LAN and learn nothing. Cellular is the test.

### Is the free tier enough?

Yes, with a lot of room. The Personal plan allows 6 users and unlimited *user*
devices; the per-plan caps apply to *tagged* infrastructure devices and to a
1,000-minute-per-month ephemeral-node pool, and this uses neither — one user, two
devices.

Bandwidth has no published cap, and only DERP-relayed traffic is rate-limited at
all. This pair will probably land on DERP, since one end is behind the apartment
NAT and the other is on cellular CGNAT. It does not matter: the payload is JSON
deltas and SSE events, the `overview` channel is deduplicated server-side and sends
nothing when nothing has changed, and the one bandwidth-hungry surface — terminal
streaming — is refused remotely anyway.

### Do not use `tailscale funnel`

`serve` publishes to your tailnet. `funnel` publishes to the internet. The bridge
can start processes on this machine; it should not be on the public internet behind
a single bearer token.

## Alternative: Cloudflare Tunnel

Worth knowing about because it gives a public HTTPS URL with **no VPN on the
phone**, which is nicer for a native Android client. Also free. But read the second
caveat before committing to it.

**Your GoDaddy registration stays where it is.** Cloudflare Tunnel needs the
domain's *DNS* hosted at Cloudflare, not its registration — you change the
nameservers at GoDaddy and the domain stays registered there. That is not a
transfer.

What is *not* free is keeping GoDaddy's DNS and delegating only a subdomain:
partial (CNAME) setup is a Business-plan feature and subdomain zones are
Enterprise. On the free plan the whole zone's DNS moves to Cloudflare. The
onboarding scan imports existing records, but check MX and TXT afterwards if the
domain carries email.

**The caveat that actually matters: `cloudflared` has an open SSE buffering bug.**
[cloudflared#1449](https://github.com/cloudflare/cloudflared/issues/1449) (open as
of April 2025) and the older
[#199](https://github.com/cloudflare/cloudflared/issues/199): server-sent events
over **GET** are held until roughly 100 KB accumulates or the connection closes,
while POST streams fine. `GET /api/events` is this app's entire live channel, so if
that bug applies, the phone shows a frozen board and a transcript that arrives in
lumps.

It is confirmed on quick tunnels and **untested on named tunnels**. So if you want
this route, spike it before building on it: stand up a named tunnel against a dev
bridge and watch a session tick for more than two minutes. If it buffers, the fix
is moving the live channel to WebSockets, which is real work — Tailscale needs none
of it, because WireGuard is not an HTTP proxy and has nothing to buffer.

Set `CLAUDE_SESSIONS_ORIGINS=https://sessions.example.com` so the origin check
knows the hostname, and put Cloudflare Access in front of it — a public URL with one
bearer token behind it is thinner than it should be.

## Last resort: binding the LAN

```bash
CLAUDE_SESSIONS_HOST=0.0.0.0 CLAUDE_SESSIONS_ALLOW_REMOTE_BIND=1 npm run dev
```

The token is required, the remote refusals apply, and every remote request is
logged. It is still the shared building subnet, over plain HTTP, and it only works
at home. Two variables, so it cannot happen by accident.

## What a phone can and cannot do

The rule, from `docs/plans/14-bridge-security.md` §C: a phone should be able to
watch, and to answer what a session is blocked on. It should not be able to reach
past the app into the machine.

**Allowed:** reading sessions and transcripts, the live board, answering
permissions, plans and questions, sending messages, stopping a turn, and starting
an ordinary session.

**Refused, with a 403 from the route rather than a missing button:**

| | Why |
|---|---|
| `bypassPermissions`, `dontAsk` | Runs everything unasked. A deliberate choice at the desk, not one tap away on a device that might be in someone else's hand. Refused on send too, so a session cannot be escalated after the fact. |
| `/api/terminals/*` | A raw pty. Everything else is mediated by the app; this is a shell, and a leaked token that reaches it has the machine. |
| `/api/shutdown`, `/api/devservers/stop` | Acts on processes the person at the desk is using. |
| `/api/sessions/:id/reveal`, `/api/devbrowser/*` | Drives windows on the Windows host. Pointless from a phone. |
| `POST /api/fs/mkdir` | Writes to the filesystem. `GET /api/fs` stays allowed, and the asymmetry is the point: reading the tree answers "where could a session start", and a phone may already start one. Creating a directory is reaching past the app into the machine. |

Independent of remoteness, and applying to every caller: a session can only start
inside `CLAUDE_SESSIONS_ROOTS` (default `$HOME`), `/api/fs` only lists and
`/api/fs/mkdir` only creates inside the same roots, and session creation is capped
at 8 a minute.

## Authentication, in one paragraph

A token is created on first run at `~/.local/share/claude-sessions/token`, mode
`0600`. Every `/api/` route requires it except `/api/health`, which stays open
because the Windows shell pings it before it could know a token and it gives away
only counts. It is accepted as `Authorization: Bearer`, as `?token=`, or as the
`cs_token` cookie, and any one of the three being valid is enough.

A local browser is spared a login step because the bridge serves its own UI: a page
fetched over loopback comes back with the cookie set and the token in a `<meta>`
tag. That is why nothing in `web/` had to change — `fetch` and `EventSource` both
send same-origin cookies already.

**This changes the `curl` examples.** Anything hitting the API now needs:

```bash
curl -s http://127.0.0.1:45899/api/sessions \
  -H "Authorization: Bearer $(cat ~/.local/share/claude-sessions/token)"
```

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_SESSIONS_HOST` | `127.0.0.1` | Interface to bind. Never defaults to anything else. |
| `CLAUDE_SESSIONS_ALLOW_REMOTE_BIND` | unset | Required in addition to `HOST` to bind a non-loopback interface. |
| `CLAUDE_SESSIONS_ROOTS` | `$HOME` | Colon-separated roots a session may start in, and the limit of `/api/fs`. |
| `CLAUDE_SESSIONS_ORIGINS` | empty | Extra allowed browser origins, for a proxy on a hostname this code cannot guess. Loopback and `*.ts.net` need no entry. |

## If something is wrong

**Everything 401s.** The cookie is missing or stale. Open the pairing URL again;
`/pair` accepts a valid cookie *or* a valid `?token=`, so a stale one does not have
to be cleared first.

**403 "unexpected host".** The bridge only answers to loopback, `*.ts.net`, a bare
IP, or a hostname in `CLAUDE_SESSIONS_ORIGINS`. This is the DNS-rebinding guard.

**403 "forbidden origin".** A browser sent an `Origin` the bridge does not
recognise. Same fix.

**The board is frozen but the page works.** The live channel is being buffered —
this is the `cloudflared` symptom above. Check what is in front of the bridge.

**The banner says remote when you are at the desk.** Something in front of the
bridge is adding `x-forwarded-*` headers, or you reached it by a name that is not
loopback. Both genuinely mean "not a direct local connection", and the bridge errs
towards withholding powers rather than granting them.
