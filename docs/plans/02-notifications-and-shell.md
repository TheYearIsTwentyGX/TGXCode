# 02 — Notifications, tray, and deep links

**Effort:** M · **Depends on:** nothing; much better after 01 and 04 ·
**Touches:** `app/main.js`, `install.ps1`, `bridge/server.js`, `web/app.js`

> **Partly landed.** §2 (what earns a notification) is built in `web/app.js`,
> along with a sound, which this plan did not have. It listens from the page,
> so the rules apply whenever a window is open and nothing fires when one is
> not. §1 (a shell-side subscriber), §3 (tray) and §4 (close to tray) are
> untouched, and §1 is what makes a closed window audible.
>
> §2's `permission-request` row is built too, covering all three kinds — tool,
> plan and question — with Allow/Deny buttons on the toast. Those needed a
> service worker (`web/sw.js`): actions do not exist on a plain notification.
> Chromium's `Notification.maxActions` is **2**, so the third answer ("allow
> all session") stays on the card; three buttons would mean raw Windows toast
> XML from the main process and protocol activation to report which was
> pressed, which is most of §5 and Windows-only.
>
> §5 is not built, but its URL shape is: `#/session/<id>` is read on load, so
> a worker that has to open a window lands on the right session — and a
> `claude-sessions://` handler, when it exists, has a vocabulary to route into
> rather than inventing a second one.
>
> Two departures from §2, both from building it: a turn finishing in a focused
> window on a *different* session does notify — "never for the session that is
> open and focused" turned out to be the rule that matters, and the extra
> `window unfocused` condition only hid long turns from someone looking
> elsewhere. And the 30-second threshold is timed from `busySince` on the wire
> rather than the result's duration — the two agreed to within 10ms on a
> one-minute turn, but the result's is `duration_ms || duration_api_ms`, and
> falling back to API time would silently shrink the threshold.

## Why

`app/main.js` creates one window and nothing else — no `Tray`, no
`Notification`, no badge, no protocol handler. Closing the window quits the app
(`app.on('window-all-closed')`, `main.js:294`), even though the bridge is
deliberately built to outlive it.

That is backwards for what this app is. You start an agent, go do something
else, and the only way to find out it finished is to come back and look.

The events already exist and are already broadcast: `turn-complete`, `notice`,
`send-failed`, `session-forked`, `runner-status` (`server.js:456-464`). Nothing
consumes them outside the open conversation.

## Design

### 1. The shell subscribes independently of the window

Today only the renderer holds an `EventSource`. Notifications must fire when no
window is open, so the **main process** opens its own SSE connection to
`/api/events` on boot and holds it for the app's lifetime.

This is a plain `http.get` against `ORIGIN` with manual `event:`/`data:` line
parsing — a few dozen lines, no dependency, matching the zero-dep spirit of the
rest. Reconnect with backoff; the bridge restarting must not permanently deafen
the shell.

### 2. What earns a notification

Be strict. A notification that fires too often gets muted, and then the ones
that matter are lost too.

| Event | Notify | Body |
|---|---|---|
| `permission-request` (plan 01) | **always** | `Bash — rm -rf dist` · Allow / Deny buttons where the OS supports them |
| `send-failed` | **always** | the classified message |
| `turn-complete` where `isError` | always | the error |
| `turn-complete` normal | only if window unfocused **and** turn ran > 30s | session title + duration |
| `notice` kind `rate_limit` | always, deduped per window | see plan 05 |
| `notice` kind `permission_denied` | only until plan 01 lands, then drop | — |

Rules:
- Never notify for the session that is currently open **and** focused.
- Coalesce: at most one notification per session per 10s.
- Clicking any notification focuses the window and opens that session — which
  needs the deep-link mechanism below.

### 3. Tray

```js
tray = new Tray(icon)
tray.setToolTip('Claude Sessions — 2 running')
tray.setContextMenu(Menu.buildFromTemplate([...]))
```

Menu contents, built from a periodic `/api/health` + `/api/sessions?limit=8`
poll (cheap; the index is in memory):

- **Running sessions** — one item each, title + activity, click to open
- separator
- **New session…** — opens the window with the new-session dialog up
- **Show / Hide window**
- **Bridge: running (pid 1234)** — disabled, informational
- **Quit** — the only path that calls `stopBridgeIfIdle()`

Badge: on Windows, `win.setOverlayIcon()` with a small count badge when sessions
are running; `app.setBadgeCount()` for the taskbar where supported.

The tray icon needs its own small render. `app/make-icon.js` already generates
the `.ico` from signed distance fields with a hand-rolled PNG encoder — extend
it with a 16/24/32px monochrome tray variant and a "dot" overlay state for
"something is running". Keep the icon committed like `icon.ico` is, so a normal
build doesn't regenerate it.

### 4. Close to tray

Change `window-all-closed` to hide rather than quit when the tray is present and
anything is running:

```js
app.on('window-all-closed', async () => {
    if (tray && (await anyRunning())) return;   // stay resident
    await stopBridgeIfIdle();
    app.quit();
});
```

Make it a setting (`config.json`: `"closeToTray": "auto" | "always" | "never"`,
default `auto` = the behaviour above), because "closing the window didn't close
the app" is exactly the kind of surprise that annoys people who did mean to
quit. First time it happens, show a balloon saying so.

### 5. Deep links

Register `claude-sessions://` in the shell:

```js
app.setAsDefaultProtocolClient('claude-sessions')
```

`install.ps1` writes the registry keys as part of packaging. Handle
`second-instance` (and `open-url` for parity) to route:

| URL | Effect |
|---|---|
| `claude-sessions://session/<uuid>` | focus window, open that session |
| `claude-sessions://session/<uuid>/turn/<n>` | …and jump to that turn |
| `claude-sessions://new?cwd=<path>&prompt=<text>` | open the new-session dialog prefilled |

Routing into the renderer: append a hash to the loaded URL
(`${ORIGIN}/#/session/<id>`) and have `web/app.js` read `location.hash` on load
and on `hashchange`. That keeps the shell ignorant of UI internals and makes the
same links work in a plain browser, which the README already treats as a
first-class way to run the UI.

Single-instance lock is required for this (`app.requestSingleInstanceLock()`) —
without it a second launch opens a second window instead of routing the link.

Payoff beyond notifications: a terminal hook can print a clickable link to the
session it just started, and DevBrowser can link back.

## Risks

- **Notification permission/quiet hours.** Windows Focus Assist silently drops
  notifications. Don't treat "notified" as "informed" — the tray badge and the
  rail are the durable signals; notifications are the nicety.
- **Toast buttons.** Action buttons on Windows toasts need an AppUserModelID
  that matches the installed app. `install.ps1` sets the appId via
  electron-builder; verify it matches or buttons silently do nothing.
- **Tray on a machine with the app auto-started.** Not a goal now, but don't
  design anything that breaks if `app.setLoginItemSettings` is added later.

## Acceptance

- Window closed, agent finishes a 2-minute turn → notification appears, clicking
  it opens the window on that session.
- Tray shows a running count that matches the rail.
- `start claude-sessions://session/<uuid>` from PowerShell focuses the app on
  that session, launching it if needed.
- Quitting from the tray shuts the bridge down when idle, and leaves it up when
  a turn is running (the existing 409 path in `/api/shutdown`).
