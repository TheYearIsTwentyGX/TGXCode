'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { daily, describe } = require('../src/forecast');

test('describe names a known code', () => {
    assert.strictEqual(describe(61), 'Rain');
});

test('daily rounds the temperatures', () => {
    const raw = { daily: { time: ['2026-11-24'], temperature_2m_max: [4.6], temperature_2m_min: [-1.2], weather_code: [3] } };
    assert.deepStrictEqual(daily(raw), [{ day: '2026-11-24', high: 5, low: -1, summary: 'Overcast' }]);
});
