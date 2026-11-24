'use strict';

const list = document.getElementById('list');
const summary = document.getElementById('summary');
let status = 'all';
let tasks = [];

async function load() {
    const res = await fetch('/api/tasks');
    const data = await res.json();
    tasks = data.tasks;
    summary.textContent = `${data.open} open · ${data.done} done`;
    render();
}

function render() {
    list.replaceChildren();
    for (const t of tasks) {
        if (status === 'open' && t.done) continue;
        if (status === 'done' && !t.done) continue;
        const li = document.createElement('li');
        li.className = t.done ? 'done' : '';
        li.innerHTML = '<span class="box"></span><span class="title"></span>';
        li.querySelector('.title').textContent = t.title;
        for (const tag of t.tags) {
            const chip = document.createElement('span');
            chip.className = 'tag';
            chip.textContent = tag;
            li.append(chip);
        }
        li.addEventListener('click', async () => {
            await fetch(`/api/tasks/${t.id}`, { method: 'PATCH' });
            load();
        });
        list.append(li);
    }
}

document.getElementById('add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('title');
    if (!input.value.trim()) return;
    await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: input.value }),
    });
    input.value = '';
    load();
});

document.getElementById('filters').addEventListener('click', (e) => {
    if (!e.target.dataset.status) return;
    status = e.target.dataset.status;
    for (const b of document.querySelectorAll('#filters button')) b.classList.toggle('on', b === e.target);
    render();
});

load();
