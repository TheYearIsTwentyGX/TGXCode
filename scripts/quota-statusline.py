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
        entry = {'used_percentage': float(pct)}
        resets = win.get('resets_at')
        if isinstance(resets, (int, float)) and not isinstance(resets, bool):
            entry['resets_at'] = int(resets)
        out[name] = entry
    return out


def save(found):
    """Write the block, but only if it says something new."""
    try:
        with open(QUOTA_FILE, 'r', encoding='utf8') as fh:
            prev = json.load(fh)
        if prev.get('windows') == found:
            return
    except Exception:
        # No file, unreadable file, or a shape from an older version of this
        # script. All three mean "write it".
        pass

    body = {'version': 1, 'windows': found, 'capturedAt': int(time.time())}
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = '%s.%d.tmp' % (QUOTA_FILE, os.getpid())
    with open(tmp, 'w', encoding='utf8') as fh:
        json.dump(body, fh)
    os.replace(tmp, QUOTA_FILE)


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
    if found:
        try:
            save(found)
        except Exception:
            # The status line is not the place to report a failed write. The
            # pill degrading to "as of a while ago" is the visible symptom, and
            # it is the honest one.
            pass

    print(line(payload, found))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('')
