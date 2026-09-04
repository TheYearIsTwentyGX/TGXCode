# Reaching this from a phone

The app's premise is watching sessions you are not sitting in front of, and until
now that stopped at the edge of the desk. This is how it reaches further.

Two halves, and they are independent:

- **The bridge** now authenticates and tells local from remote apart. That part is
  done and needs no configuration.
- **The transport** — how a phone reaches the bridge at all — is a deployment
  choice, and this document is the runbook for it.

The phone itself is the native Android app in `~/Other/tgxcode-mobile`, a client of
the API in [`docs/api.md`](api.md). There was a phone-shaped web page at `/m` for a
while and it has been removed; everything below is about getting the bridge within
reach, which is the same problem either way.

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

   It matters for more than comfort: it is the difference between a token that only
   Tailscale can see and one that anything on the path can read. It is also what
   FCM push will need if it is ever built — see the note in `docs/api.md`.

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
   `bypassPermissions` both 403 while `/api/sessions` and `/api/overview` are fine.

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

   Get that link onto the phone and paste it into the Android app's settings form,
   which keeps the token and sends it as `Authorization: Bearer` from then on. The
   app never fetches `/pair`; it only wants the token out of the query. Opening the
   link in a phone browser still works too — it trades the token for a year-long
   `HttpOnly` cookie — but that only signs *that browser* in, and there is no longer
   a phone page for it to be signed in to.

   **If the app says it is not paired**, the token is wrong, mistyped, or from before
   the bridge last created one. The bridge log says so plainly:
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

## Cloudflare Tunnel — no VPN on the phone

The reason to prefer this over Tailscale: the phone gets an ordinary HTTPS URL and
needs nothing installed. That matters most for a native Android client, which would
otherwise inherit a VPN dependency.

Free, and nothing to host — `cloudflared` runs here and dials *out*, so there is no
port to forward and no server to pay for.

### Use a domain whose DNS you do not mind moving

Cloudflare Tunnel needs the hostname to live in a Cloudflare zone, and on the free
plan that means the **whole zone's** DNS moves to Cloudflare. Keeping your existing
DNS and delegating only a subdomain is not a free path: partial (CNAME) setup is
Business plan, subdomain zones are Enterprise.

So do not move a domain that carries mail you cannot afford to lose. `twentygx.com`
is the example to avoid: its MX is `149900537.pamx1.hotmail.com`, the legacy
Windows Live custom-domain service, which is no longer provisioned — if that record
is ever lost there is no documented way to get a new one, only a move to paid
Microsoft 365. A second domain registered at Cloudflare costs a few dollars a year
and takes the question off the table entirely.

### Measured: a named tunnel streams, a quick tunnel does not

This is worth being precise about, because the distinction is the difference
between the phone feeling live and the phone looking broken — and the open
`cloudflared` issues only ever tested the half that fails.

| `/api/events` | Loopback | Quick tunnel | Named tunnel |
|---|---|---|---|
| `hello` | 0.04s | **never** | **0.29s** |
| Pings at 25s / 50s | on time | never | on time |
| Chunks in ~75s | 9 | **0** | **36** |
| `X-Accel-Buffering: no` echoed | yes | stripped | stripped |

A **quick** tunnel (`cloudflared tunnel --url …`, `*.trycloudflare.com`) buffers
completely: HTTP 200, `text/event-stream`, and zero bytes for 75 seconds while the
immediate `hello` and three pings are all held. That reproduces
[cloudflared#1449](https://github.com/cloudflare/cloudflared/issues/1449) and
[#199](https://github.com/cloudflare/cloudflared/issues/199).

A **named** tunnel on a real hostname streams properly — 36 chunks spread across
75 seconds, pings landing at 25.28s and 50.28s. Both strip the
`X-Accel-Buffering` header, so that header is not what makes the difference and
there is no config knob to reach for; the buffering lives in the quick-tunnel path
specifically.

**So the named tunnel is the supported setup, and SSE works on it.** Do not judge
this transport by a quick tunnel — that is a test of a different code path.

**A client should keep the fallback anyway**, and the Android app does: watch for
`hello` and switch to polling if it does not arrive within six seconds. It costs
nothing when the stream works (it never engages) and it is what makes a quick tunnel,
a corporate proxy, or some hotel network degrade into "a couple of seconds behind"
instead of "silently frozen". Polling was measured through the same tunnel at 62ms
for the board and 42 bytes for an empty transcript delta, so the degraded mode is
barely degraded. `docs/api.md` has the cadence.

### Setup — and what is already done on this machine

The tunnel below exists and is configured. This records it so it can be rebuilt,
and so the next person knows which parts are decisions rather than defaults.

- **`cloudflared`** lives at `~/.local/bin/cloudflared`, not installed system-wide.
  `~/.bashrc` puts that directory on PATH, so `cloudflared` resolves in an
  interactive shell with no sudo anywhere.
- **Tunnel** `claude-sessions`, id `8fc8f334-b1fa-483f-8110-1fe6d2a4458e`.
- **Hostname** `tgxcode.com` — the apex, on a domain bought for this and nothing
  else. A CNAME to the tunnel was created by `tunnel route dns`.
- **Config** `~/.cloudflared/config.yml`, pointing at `http://127.0.0.1:45888`.

To rebuild from nothing:

1. **Authorise the machine.** Opens a browser; pick the zone.

   ```bash
   cloudflared tunnel login
   ```

2. **Create the tunnel and route the hostname to it.**

   ```bash
   cloudflared tunnel create claude-sessions
   cloudflared tunnel route dns claude-sessions tgxcode.com
   ```

3. **Point it at the bridge** in `~/.cloudflared/config.yml`. A single service
   needs no `hostname` match — whatever is routed to the tunnel reaches the bridge,
   and `tunnel route dns` is the only thing that decides what that is:

   ```yaml
   tunnel: 8fc8f334-b1fa-483f-8110-1fe6d2a4458e
   credentials-file: /home/dylan_hays/.cloudflared/8fc8f334-….json
   edge-ip-version: "4"
   ingress:
     - service: http://127.0.0.1:45888
   ```

   `edge-ip-version: "4"` is load-bearing here: this machine has no working IPv6
   route, and `cloudflared tunnel list` fails dialling Cloudflare over v6 while the
   same call succeeds over v4. Without the pin, every reconnect burns a timeout
   first. It must be a **string** — an int is rejected by the config parser.

   **`--url` on the command line does not override `ingress`.** It is echoed in the
   startup `Settings:` line, which makes it look like it took effect, but the config
   file's ingress rules are what route. To test against a different port, edit the
   config; do not trust the flag.

4. **Tell the bridge the hostname**, or every request comes back
   `403 {"error":"unexpected host"}` — the DNS-rebinding guard, which has no way to
   know about your domain until you say so.

   On this machine that lives in **`~/.profile`**:

   ```bash
   export CLAUDE_SESSIONS_ORIGINS=https://tgxcode.com
   ```

   That file rather than the app, because the Windows shell starts the bridge with
   `wsl.exe bash -lc`, and a login shell reads `~/.profile` — which is also the only
   one of the three login files present here, so it is definitely the one read.
   Setting it in `app/main.js` would work too and would need a rebuild, which is
   worse. **A running bridge does not pick this up**; it applies at next start.

5. **Run it as a service**, so it survives a reboot. WSL has systemd enabled
   (`/etc/wsl.conf` sets `systemd=true`):

   ```bash
   sudo cloudflared service install
   systemctl status cloudflared
   ```

6. **Pair the phone** exactly as with Tailscale — the phone button in the top bar,
   with `https://tgxcode.com` in *Reachable at*.

### Put something in front of it

This is the real cost of dropping Tailscale, and it is not the money. A tailnet
means only your own devices can reach the bridge at all. A public hostname means
anyone who finds it reaches the door, and the only thing behind that door is one
bearer token that never expires.

**Cloudflare Access** is free for up to 50 users: email or SSO for the browser, and
**service tokens** for a native client, which is exactly the Android story. One
thing to design around: an Access session expiring mid-request is a redirect to a
login page, so give the session a long duration.

The refusals in the bridge still apply — no pty, no `bypassPermissions`, no
shutdown — but they are a second line, not the first.

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
permissions, plans and questions, sending messages, stopping a turn, starting an
ordinary session, and refreshing the quota reading.

That last one is the newest and the one worth justifying, since it is a non-GET
that starts a process. `POST /api/quota/refresh` runs the quota beacon — a
few-second `claude` in a directory the user has already named and trusted, which
the bridge performs unattended on a timer anyway. It is allowed because the `GET`
beside it is open precisely so somebody can decide from a phone whether there is
room to start something, and a stale percentage is the whole problem with doing
that. It is not the class of thing `/api/runs` and `/api/commands/run` are
refused for: those execute whatever a repository declares, this executes one
fixed operation with nowhere new to reach, and only one can be in flight at a
time so it cannot be turned into a fan of processes.

**Refused, with a 403 from the route rather than a missing button:**

| | Why |
|---|---|
| `bypassPermissions`, `dontAsk` | Runs everything unasked. A deliberate choice at the desk, not one tap away on a device that might be in someone else's hand. Refused on send too, so a session cannot be escalated after the fact. |
| `/api/terminals/*` | A raw pty. Everything else is mediated by the app; this is a shell, and a leaked token that reaches it has the machine. |
| `/api/shutdown`, `/api/devservers/stop` | Acts on processes the person at the desk is using. |
| `/api/sessions/:id/reveal`, `/api/devbrowser/*` | Drives windows on the Windows host. Pointless from a phone. |
| `POST /api/sessions/:id/handoff` | Starts a turn in a session nobody is looking at, and wakes one that has no process at all. Reasonable for an agent on this machine that just changed something the other session depends on; not reasonable to reach in for from a phone, where a leaked token would mean every session on the machine spending tokens on words nobody typed. Note that a phone *may* still send to a session through `/send` — the difference is that a person is choosing the session and the words, one at a time. |
| `POST /api/fs/mkdir` | Writes to the filesystem. `GET /api/fs` stays allowed, and the asymmetry is the point: reading the tree answers "where could a session start", and a phone may already start one. Creating a directory is reaching past the app into the machine. |
| `PUT /api/prefs` | The mkdir clause with a longer reach: it writes a file in the user's home directory, and one of the keys in it — `quota.beaconDir` — names a directory this app then starts `claude` in. `GET /api/prefs` stays allowed, so the asymmetry is on the method rather than the path: how somebody wants a transcript folded is not a capability, and a phone has a use for the answer. |
| `/api/claude-config`, **every method** | Claude Code's own settings, and the one family where the *read* is refused too. The contrast with `/api/prefs` above is the whole entry: that file is this app's own and its worst key names a directory; these files name hook commands, permission rules and the values of environment variables, and no client off this machine configures the CLI. So there is nothing to weigh against caution, and a leaked token should not be able to read them. The refusal is on the prefix with no method test, so whatever is added under it later is refused by default rather than by somebody remembering to. If a phone ever needs one of these reads, the answer is a narrower route — not a deleted refusal. |
| `/api/claude-docs`, **every method** | Claude Code's `CLAUDE.md` files, refused on the same terms as the row above and for a stronger version of the same reason. A project's is repository source; a user's describes the machine — what is installed, which ports are in use, which instance not to touch. And writing one is not changing a setting: it changes what every session started on this machine is told before its first message, which is the largest thing on this list that is not a shell. Prefix, no method test, same as above. |

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
