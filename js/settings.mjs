import {DAY} from './data.mjs?v=17';
import {resizeWindow} from './timeline.mjs?v=13';

const STORAGE_KEY = 'location-history.settings.v1';
export const RADIUS_MIN = Object.freeze({heat: 8, hex: 2, points: 8, route: 8});
const VIEW_DEFAULTS = Object.freeze({metric: 'records', palette: 'ember', radius: 24, intensity: 1, opacity: .85});
const DEFAULTS = Object.freeze({basemap: 'dark', mode: 'heat', hourStart: 0, hourEnd: 24, accuracy: 0, excludeJumps: false, period: 'all', periodDay: null, dateRange: null});

function validatedSettings(input, availableMaps) {
  const settings = {...DEFAULTS, views: Object.fromEntries(Object.keys(RADIUS_MIN).map(mode => [mode, {...VIEW_DEFAULTS}])), basemap: availableMaps.includes(DEFAULTS.basemap) ? DEFAULTS.basemap : availableMaps[0]};
  settings.views.route.lineWidth = 1.5;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return settings;
  for (const [key, values] of Object.entries({basemap: availableMaps, mode: Object.keys(RADIUS_MIN), accuracy: [0, 10, 50, 100, 500, 1000], period: ['all', '1', '7', '30', '90', '365', null]})) {
    if (values.includes(input[key])) settings[key] = input[key];
  }
  for (const [mode, view] of Object.entries(settings.views)) {
    // Older preferences had one shared set; migrate it into independent copies.
    const source = input.views && typeof input.views === 'object' && !Array.isArray(input.views) ? input.views[mode] : input;
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, values] of Object.entries({metric: ['records', 'days', 'time'], palette: ['ember', 'ocean', 'spectral']})) if (values.includes(source[key])) view[key] = source[key];
    const sliders = [['radius', RADIUS_MIN[mode], 60, 1], ['intensity', .2, 3, .1], ['opacity', .1, 1, .05]];
    if (mode === 'route') sliders.push(['lineWidth', .5, 10, .5]);
    for (const [key, min, max, step] of sliders) {
      const value = source[key];
      if (Number.isFinite(value) && value >= min && value <= max && Math.abs((value - min) / step - Math.round((value - min) / step)) < 1e-8) view[key] = value;
    }
  }
  for (const [key, min, max, step] of [['hourStart', 0, 23, 1], ['hourEnd', 1, 24, 1]]) {
    const value = input[key];
    if (!Number.isFinite(value) || value < min || value > max) continue;
    const steps = (value - min) / step;
    if (Math.abs(steps - Math.round(steps)) < 1e-8) settings[key] = value;
  }
  // Keep only the old jump preference; removed exclusions must never stay active.
  settings.excludeJumps = typeof input.excludeJumps === 'boolean' ? input.excludeJumps : Number.isInteger(input.exclude) && input.exclude >= 0 && input.exclude <= 15 && Boolean(input.exclude & 2);
  if (settings.hourStart >= settings.hourEnd) { settings.hourStart = 0; settings.hourEnd = 24; }
  const range = input.dateRange;
  if (settings.period !== 'all' && Array.isArray(range) && range.length === 2 && range.every(value => Number.isInteger(value) && Math.abs(value) < 8.64e15) && range[0] <= range[1] && range[0] % DAY === 0 && (range[1] + 1) % DAY === 0) settings.dateRange = [...range];
  if (settings.period === null && !settings.dateRange) settings.period = 'all';
  if (['30', '90', '365'].includes(settings.period) && Number.isInteger(input.periodDay) && input.periodDay >= 1 && input.periodDay <= 31) settings.periodDay = input.periodDay;
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
