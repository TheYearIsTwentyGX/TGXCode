#!/usr/bin/env python3
"""
Harvest quota percentages out of the Claude Code status line.

Claude Code hands a status line command a JSON blob on stdin, and since CLI
2.1.x that blob carries the thing this app could not otherwise get:

    rate_limits.five_hour.used_percentage    (0-100)
    rate_limits.five_hour.resets_at          (unix seconds)
    rate_limits.seven_day.{used_percentage,resets_at}

The numbers come from `anthropic-ratelimit-unified-*` response headers, so they
are exact and they cover the whole account. The catch is where they appear: the
status line is an Ink component, rendered only by the interactive TUI. A session
the bridge spawns runs `claude -p --output-format stream-json` and never renders
one, so the bridge cannot ask for this itself. It has to be handed it.

Hence this script. It sits in the user's `statusLine` setting, and on every
render it does two things: prints a status line worth looking at, and drops the
rate-limit block in STATE_DIR where bridge/usage.js will find it. Quota is
account-wide, so a number harvested from any terminal is the right number for
every session in the app.

Two rules it must not break, because it runs on somebody's prompt:

  - **Never fail loudly.** Any exception exits 0 with a plain line. A traceback
    where the status line should be is worse than no quota pill.
  - **Only write when the content changed.** The render is debounced to 300ms
    and re-fires on every state change; rewriting an unchanged file that often
    is pointless disk churn, and it destroys `capturedAt` as a signal of when
    the number was actually new.

The write is tmpfile + os.replace so a reader never sees a torn file.
"""

import json
import os
import sys
import time

# The one Claude Code emits, and the one bridge/config.js derives. Kept in step
# with STATE_DIR there by hand — it is two lines, and the alternative is asking
# a python script to parse a node module.
STATE_DIR = os.path.join(
    os.environ.get('XDG_DATA_HOME') or os.path.join(os.path.expanduser('~'), '.local', 'share'),
    'claude-sessions')

QUOTA_FILE = os.path.join(STATE_DIR, 'quota-statusline.json')

# Every window id the CLI's rate-limit enum can name. We copy whatever is
# present rather than looking for two known keys, so a window Anthropic adds
# later arrives on its own and bridge/usage.js renders it from the raw id.
KNOWN_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet',
               'seven_day_overage_included', 'overage']


def windows(payload):
    """The rate_limits block, keyed by window id, with only the fields we use."""
    limits = payload.get('rate_limits')
    if not isinstance(limits, dict):
        return {}
    out = {}
    for name, win in limits.items():
        if not isinstance(win, dict):
            continue
        pct = win.get('used_percentage')
        if not isinstance(pct, (int, float)) or isinstance(pct, bool):
            continue
        # Rounded, and not only to keep 7.000000000000001 out of the file: the
        # status line multiplies a float fraction by 100, so two readings of the
        # same percentage can differ in the last bits. Without this the
        # unchanged-content check below would miss and rewrite on noise.
        entry = {'used_percentage': round(float(pct), 2)}
        resets = win.get('resets_at')
        if isinstance(resets, (int, float)) and not isinstance(resets, bool):
            entry['resets_at'] = int(resets)
        out[name] = entry
    return out


def receipt_path(argv):
    """`--receipt <path>` off our own command line, or None.

    Hand-parsed rather than argparse: this runs on somebody's prompt, and a
    usage error printed where the status line should be is exactly the loud
    failure the rest of this file is arranged to avoid.
    """
    for i, a in enumerate(argv):
        if a == '--receipt' and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith('--receipt='):
            return a.split('=', 1)[1] or None
    return None


def write_receipt(path, payload, found, seen_at):
    """Proof, for the one beacon run that asked for it, that we rendered.

    bridge/beacon.js used to decide a run had succeeded by watching the shared
    harvest file's `capturedAt` change. Any other open terminal changes that, so
    a beacon blocked behind a trust dialog — having rendered nothing at all —
    reported success while some unrelated terminal did the writing. This file is
    named by the beacon and written by nobody else, so it answers the question
    the beacon is actually asking.

    Written on **every** render, including one where the payload carries no
    `rate_limits` yet. That is what separates "a dialog is in the way" from "the
    CLI came up fine and the quota probe never answered", which were previously
    the same unhelpful ninety-second timeout. And written independently of
    `save()`: whether the shared file changed says nothing about whether we ran.
    """
    body = {
        'version': 1,
        'at': int(time.time()),
        'observedAt': seen_at,
        'windows': found,
        'sessionId': payload.get('session_id'),
        'pid': os.getpid(),
    }
    tmp = '%s.%d.tmp' % (path, os.getpid())
    with open(tmp, 'w', encoding='utf8') as fh:
        json.dump(body, fh)
    os.replace(tmp, path)


def num(v):
    """A real number, or None. `isinstance(True, int)` is the trap being avoided."""
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def session_file(sid):
    """Where we remember what we last saw of one session, or None."""
    if not isinstance(sid, str):
        return None
    safe = ''.join(c for c in sid if c.isalnum() or c in '-_')
    if not safe or len(safe) > 64:
        return None
    return os.path.join(STATE_DIR, 'quota-session.%s.json' % safe)


def observed_at(payload, now):
    """When the CLI last *learned* these numbers — not when we read them.

    This is the whole defence against a stale renderer, and the reason the
    obvious `int(time.time())` was wrong. Every writer stamped its reading with
    the current time, so a process holding a twenty-eight-hour-old snapshot
    overwrote a fresh one and labelled it current. Five orphaned beacons doing
    that every three seconds is what made the pill show a wrong number that
    never aged.

    Two exact bounds, no heuristics:

      - `total_api_duration_ms == 0` means the session has made no API call at
        all, so its rate-limit headers can only have come from the startup
        prefetch — which happened `total_duration_ms` ago. (Verified: a beacon
        session reports a populated `rate_limits` with `api` still at 0, and
        `total_duration_ms` tracks wall-clock, growing while the session idles.)

      - Otherwise, rate-limit state is refreshed by an API *response*, and every
        API response also moves `total_api_duration_ms`. So while that counter
        is unchanged, the numbers are exactly as old as they were. We remember
        the counter per session and return the moment it last moved.

    The second bound is what handles ordinary terminals, which the first cannot:
    a terminal that worked an hour ago and has idled since has `api > 0` and
    would otherwise claim its hour-old percentage is current.
    """
    cost = payload.get('cost')
    if not isinstance(cost, dict):
        return now

    api = num(cost.get('total_api_duration_ms'))
    dur = num(cost.get('total_duration_ms'))

    if api == 0:
        return now - int(dur / 1000) if dur is not None and dur >= 0 else now
    if api is None:
        return now

    path = session_file(payload.get('session_id'))
    if path is None:
        return now

    try:
        with open(path, 'r', encoding='utf8') as fh:
            prev = json.load(fh)
        if isinstance(prev, dict) and num(prev.get('api')) == api:
            at = num(prev.get('at'))
            if at is not None:
                return int(at)
    except Exception:
        pass

    # First sight of this session, or the counter moved: the numbers are new.
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = '%s.%d.tmp' % (path, os.getpid())
        with open(tmp, 'w', encoding='utf8') as fh:
            json.dump({'api': api, 'at': now}, fh)
        os.replace(tmp, path)
    except Exception:
        pass
    return now


def prune_sessions(now):
    """Drop the per-session notes of sessions that ended long ago.

    Only called when the harvest file is actually being written, which is rare —
    a readdir on every render would be a real cost for a status line.
    """
    try:
        names = os.listdir(STATE_DIR)
    except Exception:
        return
    for name in names:
        if not name.startswith('quota-session.'):
            continue
        full = os.path.join(STATE_DIR, name)
        try:
            if now - os.stat(full).st_mtime > 24 * 3600:
                os.remove(full)
        except Exception:
            pass


def save(found, seen_at, now):
    """Merge this reading into the shared file, newest observation per window.

    Three rules, and each one is a bug that happened:

      - **An older observation never overwrites a newer one.** The file is
        shared by every terminal and bridge on the machine, and they hold
        readings of wildly different ages.

      - **A window the payload does not mention is carried forward, not
        deleted.** `save()` used to replace the whole `windows` object, so a
        renderer whose five-hour window had expired (and was therefore dropped
        by the CLI) deleted everybody else's good five-hour reading. That is
        precisely why the pill showed "5h" with no percentage at all.

      - **An unchanged value does not move its timestamp.** Re-confirming 3% is
        not learning anything, and stamping it fresh is how a number nobody has
        updated goes on looking current. It also keeps `capturedAt` meaning what
        web/app.js's staleness greying has always assumed.
    """
    prev = {}
    try:
        with open(QUOTA_FILE, 'r', encoding='utf8') as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict):
            prev = loaded
    except Exception:
        pass

    prev_windows = prev.get('windows') if isinstance(prev.get('windows'), dict) else {}
    prev_stamps = prev.get('observedAt') if isinstance(prev.get('observedAt'), dict) else {}
    # A file written by an older copy of this script has no stamp map. Treating
    # its windows as observed at its `capturedAt` is exactly the assumption that
    # file was written under, so an old harvester degrades to the old behaviour
    # rather than losing every comparison.
    fallback = num(prev.get('capturedAt'))
    if fallback is None:
        fallback = now

    merged = {}
    stamps = {}
    for name, win in prev_windows.items():
        if not isinstance(win, dict):
            continue
        merged[name] = win
        st = num(prev_stamps.get(name))
        stamps[name] = int(st if st is not None else fallback)

    for name, win in found.items():
        if merged.get(name) == win:
            continue                                  # nothing learned
        if name in stamps and seen_at < stamps[name]:
            continue                                  # we are the stale one
        merged[name] = win
        stamps[name] = seen_at

    for name in list(merged):
        resets = num(merged[name].get('resets_at'))
        # A window whose reset has passed describes a period that no longer
        # exists. Absent is "unknown", which is the honest thing to say.
        stale = (resets is not None and resets <= now) \
            or (now - stamps.get(name, now) > 8 * 86400)
        if stale:
            merged.pop(name, None)
            stamps.pop(name, None)

    if merged == prev_windows and stamps == prev_stamps:
        return

    body = {
        'version': 1,
        'windows': merged,
        # A sibling map, deliberately not a third key inside each window entry:
        # ~60 worktree copies of this script detect change with
        # `prev['windows'] == found`, and a new key in there would make that
        # comparison never match, so every one of them would rewrite the file on
        # every render.
        'observedAt': stamps,
        'capturedAt': int(max(stamps.values())) if stamps else now,
    }
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = '%s.%d.tmp' % (QUOTA_FILE, os.getpid())
    with open(tmp, 'w', encoding='utf8') as fh:
        json.dump(body, fh)
    os.replace(tmp, QUOTA_FILE)
    prune_sessions(now)


def label(name):
    if name == 'five_hour':
        return '5h'
    if name == 'seven_day':
        return '7d'
    return name


def line(payload, found):
    """The status line itself. Dylan is paying a render for this; say something."""
    bits = []

    model = (payload.get('model') or {}).get('display_name')
    if model:
        bits.append(model)

    workspace = payload.get('workspace') or {}

    cwd = workspace.get('current_dir')
    if cwd:
        bits.append(os.path.basename(cwd.rstrip('/')) or cwd)

    worktree = workspace.get('git_worktree')
    if isinstance(worktree, dict) and worktree.get('branch'):
        bits.append(worktree['branch'])

    quota = []
    ordered = [k for k in KNOWN_ORDER if k in found]
    ordered += [k for k in sorted(found) if k not in KNOWN_ORDER]
    for name in ordered:
        quota.append('%s:%d%%' % (label(name), round(found[name]['used_percentage'])))
    if quota:
        bits.append(' '.join(quota))

    return ' · '.join(bits)


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except Exception:
        print('')
        return
    if not isinstance(payload, dict):
        print('')
        return

    found = windows(payload)
    now = int(time.time())
    if found:
        try:
            save(found, observed_at(payload, now), now)
        except Exception:
            # The status line is not the place to report a failed write. The
            # pill degrading to "as of a while ago" is the visible symptom, and
            # it is the honest one.
            pass

    # Unconditional, and outside the `if found` above on purpose — see
    # write_receipt(). Only a beacon run passes --receipt; an ordinary terminal
    # never has one and does none of this.
    receipt = receipt_path(sys.argv[1:])
    if receipt:
        try:
            write_receipt(receipt, payload, found, observed_at(payload, now))
        except Exception:
            pass

    print(line(payload, found))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('')
