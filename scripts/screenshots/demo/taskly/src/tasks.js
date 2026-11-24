'use strict';

// The task model. Plain functions over a plain array, so the server and the
// tests use exactly the same code.

let nextId = 1;

function create(title, { tags = [] } = {}) {
    const text = String(title || '').trim();
    if (!text) throw new Error('A task needs a title');
    return {
        id: nextId++,
        title: text,
        tags: tags.map(t => String(t).trim().toLowerCase()).filter(Boolean),
        done: false,
        createdAt: Date.now(),
    };
}

function toggle(tasks, id) {
    return tasks.map(t => (t.id === id ? { ...t, done: !t.done } : t));
}

function remove(tasks, id) {
    return tasks.filter(t => t.id !== id);
}

function filter(tasks, { status = 'all', tag = null, query = '' } = {}) {
    const q = query.trim().toLowerCase();
    return tasks.filter(t => {
        if (status === 'open' && t.done) return false;
        if (status === 'done' && !t.done) return false;
        if (tag && !t.tags.includes(tag)) return false;
        return !q || t.title.toLowerCase().includes(q);
    });
}

function summary(tasks) {
    const done = tasks.filter(t => t.done).length;
    return { total: tasks.length, done, open: tasks.length - done };
}

module.exports = { create, toggle, remove, filter, summary };
