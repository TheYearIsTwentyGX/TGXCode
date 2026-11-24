'use strict';

const test = require('node:test');
const assert = require('node:assert');
const tasks = require('../src/tasks');

test('create trims the title and lowercases tags', () => {
    const t = tasks.create('  Buy milk ', { tags: ['Home', ' '] });
    assert.strictEqual(t.title, 'Buy milk');
    assert.deepStrictEqual(t.tags, ['home']);
});

test('create refuses an empty title', () => {
    assert.throws(() => tasks.create('   '), /needs a title/);
});

test('filter by status, tag and text', () => {
    let list = [tasks.create('Write docs', { tags: ['docs'] }), tasks.create('Fix bug', { tags: ['bug'] })];
    list = tasks.toggle(list, list[0].id);
    assert.strictEqual(tasks.filter(list, { status: 'open' }).length, 1);
    assert.strictEqual(tasks.filter(list, { tag: 'bug' })[0].title, 'Fix bug');
    assert.strictEqual(tasks.filter(list, { query: 'DOCS' }).length, 1);
});

test('summary counts open and done', () => {
    let list = [tasks.create('a'), tasks.create('b')];
    list = tasks.toggle(list, list[0].id);
    assert.deepStrictEqual(tasks.summary(list), { total: 2, done: 1, open: 1 });
});
