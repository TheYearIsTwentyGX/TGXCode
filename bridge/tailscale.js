'use strict';

// Asking Tailscale what this machine is called, so the pairing dialog can offer a
// link that works instead of a blank to fill in.
//
// The first version of that dialog suggested `https://<machine>.<tailnet>.ts.net`
// and expected the name to be typed over the top. Offered in a dropdown, that is
// not a hint, it is a trap: picking it produces a URL containing literal angle
// brackets, which is exactly what happened the first time it was used. A
// suggestion you have to correct is worse than no suggestion, and the machine
// already knows the answer.
//
// Tailscale runs on the Windows host, not in WSL, so this goes through
// tailscale.exe — the same shape as bridge/explorer.js calling explorer.exe. If it
// is not there, not running, or not logged in, every one of these returns null and
// the dialog falls back to asking. Nothing here is load-bearing.

const fs = require('fs');
const { execFile } = require('child_process');

const { cached } = require('./memo');

// Where the Windows installer puts it. `tailscale` on PATH is tried first, so a
// WSL-side install also works.
const WINDOWS_EXE = '/mnt/c/Program Files/Tailscale/tailscale.exe';

// Shelling out to Windows costs ~200ms, and the answer changes when a machine is
// renamed or a tailnet gains HTTPS — neither of which happens while a dialog is
// open. A minute is generous and still picks up "I just enabled certs".
const TTL_MS = 60_000;

const store = new Map();

function binary() {
    // execFile with a bare name searches PATH; the .exe is a fallback rather than
    // the default so a real Linux tailscale wins where one exists.
    return new Promise((resolve) => {
        execFile('tailscale', ['version'], { timeout: 4000 }, (err) => {
            if (!err) return resolve('tailscale');
            resolve(fs.existsSync(WINDOWS_EXE) ? WINDOWS_EXE : null);
        });
    });
}

function statusJson(exe) {
    return new Promise((resolve) => {
        execFile(exe, ['status', '--json'], { timeout: 6000, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout) => {
                if (err) return resolve(null);
                try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
            });
    });
}

/**
 * What this machine is on the tailnet, or null.
 *
 * `{ name, https, running }` — `name` is the MagicDNS name with the trailing dot
 * stripped, `https` says whether the tailnet has certificates enabled (without
 * them `tailscale serve --https` cannot work, and the pairing URL has to be
 * http://), and `running` distinguishes "installed but not up" from "absent".
 */
async function identity() {
    return cached(store, 'identity', TTL_MS, async () => {
        const exe = await binary();
        if (!exe) return null;

        const status = await statusJson(exe);
        if (!status) return null;

        const self = status.Self || {};
        const name = (self.DNSName || '').replace(/\.$/, '');
        if (!name) return { name: null, https: false, running: false };

        return {
            name,
            // CertDomains is present and non-empty only once HTTPS certificates
            // are enabled for the tailnet in the admin console.
            https: Array.isArray(status.CertDomains) && status.CertDomains.length > 0,
            running: status.BackendState === 'Running',
        };
    }).catch(() => null);
}

/**
 * Where `tailscale serve` is already sending traffic for this port, if anywhere.
 *
 * Worth the second call purely so the dialog does not tell you to run a command
 * you have already run — advice you can see is stale is advice you stop reading.
 * Returns the public origin proxying to `port`, or null.
 */
async function servedOrigin(port) {
    return cached(store, `serve:${port}`, TTL_MS, async () => {
        const exe = await binary();
        if (!exe) return null;

        const cfg = await new Promise((resolve) => {
            execFile(exe, ['serve', 'status', '--json'], { timeout: 6000 },
                (err, stdout) => {
                    if (err) return resolve(null);
                    try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
                });
        });
        if (!cfg || !cfg.Web) return null;

        const want = `http://127.0.0.1:${port}`;
        for (const [hostPort, entry] of Object.entries(cfg.Web)) {
            for (const handler of Object.values((entry && entry.Handlers) || {})) {
                if (handler && handler.Proxy === want) {
                    // "host:443" is the ordinary HTTPS case and wants no port in the
                    // URL; anything else keeps it.
                    const [host, p] = hostPort.split(':');
                    const https = Boolean(cfg.TCP && cfg.TCP[p] && cfg.TCP[p].HTTPS);
                    const scheme = https ? 'https' : 'http';
                    const suffix = (https && p === '443') || (!https && p === '80') ? '' : `:${p}`;
                    return `${scheme}://${host}${suffix}`;
                }
            }
        }
        return null;
    }).catch(() => null);
}

/**
 * Addresses a phone could plausibly reach this bridge on, best first.
 *
 * Only ever real values — a caller can put these straight in a URL. When nothing
 * can be determined the list is empty, and the dialog asks rather than guessing.
 */
async function pairingHosts(port) {
    const out = [];
    const [ts, served] = await Promise.all([identity(), servedOrigin(port)]);

    // What is already published beats what could be: this one is known to work.
    if (served) out.push({ url: served, kind: 'served' });

    if (ts && ts.name) {
        const guess = `https://${ts.name}`;
        if (guess !== served) {
            // With certificates, `tailscale serve --https=443` is the documented
            // setup and the URL carries no port.
            out.push({ url: guess, kind: ts.https ? 'tailscale' : 'tailscale-nocert' });
        }
    }

    return { hosts: out, tailscale: ts, served, port };
}

module.exports = { identity, servedOrigin, pairingHosts };
