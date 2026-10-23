import {DAY} from './data.mjs?v=4';
import {resizeWindow} from './timeline.mjs?v=1';

const STORAGE_KEY = 'location-history.settings.v1';
const DEFAULTS = Object.freeze({basemap: 'google', mode: 'heat', metric: 'records', palette: 'ember', radius: 24, intensity: 1, opacity: .85, hourStart: 0, hourEnd: 24, accuracy: 0, period: 'all', periodDay: null, dateRange: null});

function validatedSettings(input, availableMaps) {
  const settings = {...DEFAULTS, basemap: availableMaps.includes('google') ? 'google' : availableMaps.includes('dark') ? 'dark' : availableMaps[0]};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return settings;
  for (const [key, values] of Object.entries({basemap: availableMaps, mode: ['heat', 'hex', 'points', 'route'], metric: ['records', 'days', 'time'], palette: ['ember', 'ocean', 'spectral'], accuracy: [0, 100, 500, 1000], period: ['all', '1', '30', '365', null]})) {
    if (values.includes(input[key])) settings[key] = input[key];
  }
  for (const [key, min, max, step] of [['radius', 8, 60, 1], ['intensity', .2, 3, .1], ['opacity', .1, 1, .05], ['hourStart', 0, 23, 1], ['hourEnd', 1, 24, 1]]) {
    const value = input[key];
    if (!Number.isFinite(value) || value < min || value > max) continue;
    const steps = (value - min) / step;
    if (Math.abs(steps - Math.round(steps)) < 1e-8) settings[key] = value;
  }
  if (settings.hourStart >= settings.hourEnd) { settings.hourStart = 0; settings.hourEnd = 24; }
  const range = input.dateRange;
  if (settings.period !== 'all' && Array.isArray(range) && range.length === 2 && range.every(value => Number.isInteger(value) && Math.abs(value) < 8.64e15) && range[0] <= range[1] && range[0] % DAY === 0 && (range[1] + 1) % DAY === 0) settings.dateRange = [...range];
  if (settings.period === null && !settings.dateRange) settings.period = 'all';
  if (['30', '365'].includes(settings.period) && Number.isInteger(input.periodDay) && input.periodDay >= 1 && input.periodDay <= 31) settings.periodDay = input.periodDay;
  return settings;
}

export function loadSettings(availableMaps, storage) {
  try {
    return validatedSettings(JSON.parse((storage ?? globalThis.localStorage).getItem(STORAGE_KEY)), availableMaps);
  } catch { return validatedSettings(null, availableMaps); }
}

export function saveSettings(input, availableMaps, storage) {
  // Explicitly allowlist preferences: never serialize history, camera or API keys.
  const settings = validatedSettings(input, availableMaps);
  try { (storage ?? globalThis.localStorage).setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* Storage may be blocked or full; the app still works. */ }
  return settings;
}

export function dateSelection(settings, min, max) {
  min = Math.floor(min / DAY) * DAY;
  max = Math.floor(max / DAY) * DAY + DAY - 1;
  if (settings.dateRange) {
    const start = Math.max(min, settings.dateRange[0]), end = Math.min(max, settings.dateRange[1]);
    if (start <= end) return {start, end, period: settings.period, periodDay: start === settings.dateRange[0] ? settings.periodDay : null};
  }
  const period = settings.period ?? 'all';
  return {...resizeWindow(min, period, min, max), period, periodDay: null};
}
