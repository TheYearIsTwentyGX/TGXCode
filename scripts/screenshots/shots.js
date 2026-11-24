'use strict';

// The pictures: one entry per file in docs/screenshots/. Each `run` gets a page
// on the demo bridge and a context, drives the real UI to the state worth
// showing, and returns a PNG buffer (usually `page.screenshot()`, sometimes
// clipped to the part of the window that is the point).
//
// The window is 1440×900 at 2× unless a shot says otherwise; index.js scales the
// capture down to `width` (default 1440) and writes it, so text stays crisp.
//
// Shots only click, type and scroll — they never reach round the UI to the API,
// except `ctx.api` to wait for something the page will draw (see `settled`).

const SEL = {
    rail: '.strip',
};

/**
 * Open the app on the demo bridge, and make the page safe to publish.
 *
 * Two things are done to the page, both before any script of its own runs:
 *
 *  - **Paths are rewritten.** The demo home is a directory under /var/tmp with a
 *    random name, which is where the bridge really reads and writes. Every place
 *    the UI prints one — headers, tool rows, Settings' "Writing to" line, titles
 *    and hover text — is rewritten to the path a person called `demo` would have,
 *    so no picture carries a temp directory's name. The text really is changed in
 *    the DOM; nothing is painted over.
 *  - **The development badge is hidden.** A bridge on a free port wears an amber
 *    `dev :NNNNN` badge so it is never mistaken for the everyday one; in a
 *    README picture it is just noise.
 */
async function boot(page, ctx, { width, height } = {}) {
    const root = ctx.root;
    await page.addInitScript(({ pairs }) => {
        const fix = (s) => {
            if (typeof s !== 'string' || !s.includes('/var/tmp/')) return s;
            for (const [from, to] of pairs) s = s.split(from).join(to);
            return s;
        };
        const ATTRS = ['title', 'placeholder', 'aria-label', 'value', 'href', 'alt'];
        const walk = (node) => {
            if (node.nodeType === 3) {
                const f = fix(node.nodeValue);
                if (f !== node.nodeValue) node.nodeValue = f;
                return;
            }
            if (node.nodeType !== 1) return;
            for (const a of ATTRS) {
                const v = node.getAttribute && node.getAttribute(a);
                if (v && v.includes('/var/tmp/')) node.setAttribute(a, fix(v));
            }
            for (const c of node.childNodes) walk(c);
        };
        const start = () => {
            const style = document.createElement('style');
            style.textContent = '.dev-badge { display: none !important; }';
            document.head.append(style);
            new MutationObserver((records) => {
                for (const r of records) {
                    if (r.type === 'characterData') walk(r.target);
                    else if (r.type === 'attributes') walk(r.target);
                    else r.addedNodes.forEach(walk);
                }
            }).observe(document.documentElement, { subtree: true, childList: true, characterData: true,
                attributes: true, attributeFilter: ATTRS });
            walk(document.documentElement);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
        else start();
    }, {
        pairs: [
            [`${root}/demo`, '/home/demo'],
            [`${root}/prefs`, '/home/demo/.tgxcode'],
            [`${root}/data`, '/home/demo/.local/share'],
            [`${root}/cache`, '/home/demo/.cache'],
            [root, '/home/demo'],
        ],
    });
    if (width && height) await page.setViewportSize({ width, height });
    await page.goto(`http://127.0.0.1:${ctx.port}/`);
    await page.waitForSelector(SEL.rail);
    await settle(page, 1200);
}

const settle = (page, ms = 800) => page.waitForTimeout(ms);

/** Click a session in the rail by its title. */
async function openSession(page, title, { after = 1800 } = {}) {
    await page.locator('.strip-title', { hasText: title }).first().click();
    await settle(page, after);
}

/** Workers live in a fold under their orchestrator; opening it first shows them. */
async function openWorker(page, orchestrator, worker) {
    await openSession(page, orchestrator, { after: 1200 });
    await openSession(page, worker, { after: 2200 });
}

/** The tool rows of a run, opened — the fold is "15 tool calls". */
async function openRun(page) {
    const run = page.locator('.trun').first();
    if (await run.count()) { await run.click(); await settle(page, 500); }
}

const clip = (page, selector, pad = 0) => async () => {
    const box = await page.locator(selector).first().boundingBox();
    return page.screenshot({ clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
        width: box.width + pad * 2, height: box.height + pad * 2 } });
};
void clip;

const shots = [
    // The one the README opens with: a conversation, what the session changed
    // (the drawer on the right), and a diff open in the log.
    {
        name: 'hero',
        async run(page, ctx) {
            await boot(page, ctx);
            await openSession(page, 'Add due dates to tasks');
            await page.click('#btn-changes');
            await page.click('#tasks-collapse');   // the suggestion can wait; the log wants the width
            await settle(page, 1200);
            await openRun(page);
            const edit = page.locator('.tool', { hasText: 'src/tasks.js' }).filter({ hasText: 'Edit' }).first();
            await edit.click();
            await settle(page, 500);
            await edit.scrollIntoViewIfNeeded();
            await page.evaluate(() => {
                const log = document.querySelector('#log');
                const open = [...document.querySelectorAll('.tool')].find(t => /Edit/.test(t.textContent) && t.querySelector('.tool-body'));
                if (log && open) log.scrollTop = open.offsetTop - 120;
            });
            await settle(page, 500);
            return page.screenshot();
        },
    },

    // Everything outstanding, in four columns.
    {
        name: 'task-board',
        async run(page, ctx) {
            await boot(page, ctx);
            await page.click('#btn-taskboard');
            await settle(page, 1800);
            return page.screenshot();
        },
    },

    // Every session running right now, with the asks that are waiting.
    {
        name: 'live-board',
        async run(page, ctx) {
            await boot(page, ctx);
            await page.click('#btn-live');
            await settle(page, 1800);
            return page.screenshot();
        },
    },

    // The orchestrator: goal, what needs you, the workers.
    {
        name: 'orchestrator',
        viewport: { width: 1440, height: 1000 },
        async run(page, ctx) {
            await boot(page, ctx);
            await openSession(page, 'Taskly 1.4 release', { after: 2500 });
            return page.screenshot();
        },
    },

    // A permission an agent is blocked on.
    {
        name: 'approval',
        async run(page, ctx) {
            await boot(page, ctx);
            await openWorker(page, 'Taskly 1.4 release', 'Keyboard shortcuts');
            return page.screenshot();
        },
    },

    // A plan, waiting for a yes.
    {
        name: 'plan',
        async run(page, ctx) {
            await boot(page, ctx);
            await openWorker(page, 'Taskly 1.4 release', 'Plan offline sync');
            return page.screenshot();
        },
    },

    // `@` in the composer.
    {
        name: 'composer-mention',
        async run(page, ctx) {
            await boot(page, ctx);
            await openSession(page, 'Add due dates to tasks');
            await page.click('textarea >> visible=true');
            await page.keyboard.type('Add a test for @t');
            await settle(page, 1200);
            return page.screenshot();
        },
    },

    // The browser preview: the demo app, running from the session's worktree.
    {
        name: 'preview',
        async run(page, ctx) {
            await boot(page, ctx);
            await openSession(page, 'Add due dates to tasks');
            const chip = page.locator('.channel').first();
            await chip.waitFor({ timeout: 15_000 });
            await chip.locator('button, .chan-main, a, span').first().click();
            await settle(page, 2500);
            return page.screenshot();
        },
    },

    // Work in flight: dirty worktrees and open pull requests.
    {
        name: 'dashboard',
        async run(page, ctx) {
            await boot(page, ctx);
            await page.click('#btn-dash');
            await settle(page, 2200);
            return page.screenshot();
        },
    },

    // Every image in the chat, once each.
    {
        name: 'images',
        async run(page, ctx) {
            await boot(page, ctx);
            await openSession(page, 'Add due dates to tasks');
            await page.click('#btn-images');
            await settle(page, 1000);
            await page.locator('.img-tile').first().click();
            await settle(page, 1200);
            return page.screenshot();
        },
    },

    // Settings.
    {
        name: 'settings',
        async run(page, ctx) {
            await boot(page, ctx);
            await page.click('#btn-settings');
            await settle(page, 1500);
            await page.getByText('Orchestrators', { exact: true }).first().click();
            await settle(page, 1200);
            return page.screenshot();
        },
    },

    // Ctrl+K.
    {
        name: 'palette',
        async run(page, ctx) {
            await boot(page, ctx);
            await openSession(page, 'Add due dates to tasks');
            await page.keyboard.press('Control+k');
            await settle(page, 600);
            await page.keyboard.type('keyboard');
            await settle(page, 800);
            return page.screenshot();
        },
    },
];

module.exports = { shots };
