'use strict';

const BASE = 'https://api.example.test/v1';

async function get(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather API said ${res.status}`);
    return res.json();
}

module.exports = { get };
