'use strict';

// Turns the provider's raw payload into what the dashboard draws.

const CONDITIONS = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 61: 'Rain', 71: 'Snow' };

function describe(code) {
    return CONDITIONS[code] || 'Unknown';
}

function daily(raw) {
    return raw.daily.time.map((day, i) => ({
        day,
        high: Math.round(raw.daily.temperature_2m_max[i]),
        low: Math.round(raw.daily.temperature_2m_min[i]),
        summary: describe(raw.daily.weather_code[i]),
    }));
}

module.exports = { describe, daily };
