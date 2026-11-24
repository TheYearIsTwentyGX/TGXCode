'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const tasks = require('./tasks');

const PORT = Number(process.env.PORT || 5173);
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let list = [
    tasks.create('Draft the v1.4 release notes', { tags: ['docs'] }),
    tasks.create('Review the keyboard shortcut PR', { tags: ['review'] }),
    tasks.create('Fix the filter bar on narrow screens', { tags: ['bug', 'ui'] }),
    tasks.create('Add due dates to tasks', { tags: ['feature'] }),
    tasks.create('Set up nightly backups', { tags: ['ops'] }),
    tasks.create('Reply to the feedback thread', { tags: ['review'] }),
];
list = tasks.toggle(list, 1);
list = tasks.toggle(list, 5);

function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

function body(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    });
}

http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/api\/tasks(?:\/(\d+))?$/.exec(url.pathname);

    if (m && req.method === 'GET' && !m[1]) return json(res, 200, { tasks: list, ...tasks.summary(list) });

    if (m && req.method === 'POST' && !m[1]) {
        const b = await body(req);
        try {
            const t = tasks.create(b.title, { tags: b.tags });
            list = [...list, t];
            return json(res, 201, t);
        } catch (err) {
            return json(res, 400, { error: err.message });
        }
    }

    if (m && req.method === 'PATCH' && m[1]) {
        list = tasks.toggle(list, Number(m[1]));
        return json(res, 200, { ok: true });
    }

    if (m && req.method === 'DELETE' && m[1]) {
        list = tasks.remove(list, Number(m[1]));
        return json(res, 200, { ok: true });
    }

    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
        res.writeHead(404);
        return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Taskly on http://localhost:${PORT}`));
