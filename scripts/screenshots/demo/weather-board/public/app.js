'use strict';

const board = document.getElementById('board');

async function load() {
    const res = await fetch('/api/forecast?place=oslo');
    const days = await res.json();
    board.textContent = days.map(d => `${d.day}: ${d.high}° / ${d.low}°`).join('\n');
}

load();
