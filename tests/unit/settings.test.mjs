import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSettings, saveSettings, dateSelection, RADIUS_MIN} from '../../assets/js/settings.mjs';
import {DAY} from '../../assets/js/data.mjs';

const maps = ['google', 'dark', 'yandex', 'google-satellite'];
function memoryStorage(value = null) {
  return {key: null, value, getItem(key) { this.key = key; return this.value; }, setItem(key, value) { this.key = key; this.value = value; }};
}

test('new visitors default to Google, with a configured-provider fallback', () => {
  assert.equal(loadSettings(maps, memoryStorage()).basemap, 'google');
  assert.equal(loadSettings(['dark', 'osm'], memoryStorage()).basemap, 'dark');
  assert.equal(loadSettings(['osm'], memoryStorage()).basemap, 'osm');
});

test('display, map and filter preferences survive a storage round trip', () => {
  const storage = memoryStorage();
  const input = {...loadSettings(maps, storage), basemap: 'google-satellite', mode: 'hex', hourStart: 8, hourEnd: 19, accuracy: 500, period: '1', periodDay: null, dateRange: [4 * DAY, 5 * DAY - 1]};
  input.views.heat = {metric: 'time', palette: 'spectral', radius: 39, intensity: 1.7, opacity: .65};
  input.views.hex = {metric: 'days', palette: 'ocean', radius: 2, intensity: 2, opacity: .5};
  input.views.points.radius = 32;
  input.views.route.opacity = .6;
  saveSettings(input, maps, storage);
  assert.equal(storage.key, 'location-history.settings.v1');
  assert.deepEqual(loadSettings(maps, storage), input);
});

test('storage excludes imported history, map position, credentials and unknown fields', () => {
  const storage = memoryStorage();
  const defaults = loadSettings(maps, storage);
  saveSettings({...defaults, report: {files: ['private.json']}, result: {points: [[13, 52]]}, start: 1, end: 2, center: [13, 52], zoom: 12, bearing: 10, pitch: 20, apiKey: 'private-key', views: {...defaults.views, heat: {...defaults.views.heat, points: [[13, 52]], apiKey: 'private-key'}}}, maps, storage);
  assert.deepEqual(JSON.parse(storage.value), defaults);
});

test('invalid and obsolete values fall back independently without losing valid preferences', () => {
  const storage = memoryStorage(JSON.stringify({basemap: 'removed-provider', mode: 'unknown', metric: 'days', palette: '__proto__', radius: 1e9, intensity: '2', opacity: .64, accuracy: 25, period: '999', dateRange: [0, 4], hourStart: 23, hourEnd: 2}));
  const expected = loadSettings(maps, memoryStorage());
  for (const view of Object.values(expected.views)) view.metric = 'days';
  assert.deepEqual(loadSettings(maps, storage), expected);
  const invalidRange = saveSettings({period: null, dateRange: [DAY, 0], radius: NaN, intensity: Infinity}, maps, storage);
  assert.equal(invalidRange.dateRange, null);
  assert.equal(invalidRange.period, 'all');
  assert.equal(saveSettings({metric: 'time', radius: {valueOf: null, toString: null}}, maps, storage).views.heat.metric, 'time');
});

test('legacy shared preferences migrate to independent mode settings', () => {
  const legacy = {metric: 'days', palette: 'ocean', radius: 39, intensity: 1.7, opacity: .65};
  const settings = loadSettings(maps, memoryStorage(JSON.stringify(legacy)));
  for (const [mode, view] of Object.entries(settings.views)) assert.deepEqual(view, {...legacy, ...(mode === 'route' ? {lineWidth: 1.5} : {})});
  settings.views.heat.radius = 50;
  assert.equal(settings.views.hex.radius, 39);
  assert.equal(settings.views.points.radius, 39);
  assert.equal(loadSettings(maps, memoryStorage()).views.heat.radius, 24);
});

test('each mode validates its own fields and hexagons support smaller cells', () => {
  const settings = saveSettings({views: {
    heat: {radius: 2, opacity: .6, intensity: 1.05},
    hex: {radius: 2, opacity: .64, palette: 'ocean', metric: 'time'},
    points: {radius: 2, intensity: 1.5},
    route: ['invalid']
  }}, maps, memoryStorage());
  assert.equal(settings.views.heat.radius, 24);
  assert.equal(settings.views.points.radius, 24);
  assert.equal(settings.views.hex.radius, RADIUS_MIN.hex);
  assert.equal(settings.views.heat.opacity, .6);
  assert.equal(settings.views.hex.opacity, .85);
  assert.equal(settings.views.heat.intensity, 1);
  assert.equal(settings.views.points.intensity, 1.5);
  assert.equal(settings.views.hex.palette, 'ocean');
  assert.equal(settings.views.hex.metric, 'time');
  assert.deepEqual(settings.views.route, loadSettings(maps, memoryStorage()).views.route);
});

test('malformed storage and storage failures never prevent loading or changing settings', () => {
  const defaults = loadSettings(maps, memoryStorage());
  for (const value of ['{broken', 'null', '[]', 'false', '42', '"text"']) assert.deepEqual(loadSettings(maps, memoryStorage(value)), defaults);
  const blocked = {getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); }};
  assert.deepEqual(loadSettings(maps, blocked), defaults);
  assert.equal(saveSettings({mode: 'route'}, maps, blocked).mode, 'route');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', {configurable: true, get() { throw new Error('SecurityError'); }});
    assert.deepEqual(loadSettings(maps), defaults);
    assert.equal(saveSettings({palette: 'spectral'}, maps).views.heat.palette, 'spectral');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('date filters restore after import, bounded to the newly opened history', () => {
  const storage = memoryStorage();
  const settings = saveSettings({period: null, dateRange: [4 * DAY, 9 * DAY - 1]}, maps, storage);
  assert.deepEqual(dateSelection(settings, 2 * DAY + 5000, 12 * DAY), {start: 4 * DAY, end: 9 * DAY - 1, period: null, periodDay: null});
  assert.deepEqual(dateSelection(settings, 6 * DAY, 10 * DAY), {start: 6 * DAY, end: 9 * DAY - 1, period: null, periodDay: null});
  assert.deepEqual(dateSelection(settings, 20 * DAY, 25 * DAY), {start: 20 * DAY, end: 26 * DAY - 1, period: 'all', periodDay: null});
  assert.deepEqual(dateSelection(saveSettings({period: '1', dateRange: [4 * DAY, 5 * DAY - 1]}, maps, storage), 20 * DAY, 25 * DAY), {start: 20 * DAY, end: 21 * DAY - 1, period: '1', periodDay: null});
  assert.deepEqual(dateSelection(saveSettings({period: '30'}, maps, storage), 20 * DAY, 25 * DAY), {start: 20 * DAY, end: 26 * DAY - 1, period: '30', periodDay: null});
  assert.deepEqual(dateSelection(saveSettings({period: 'all', dateRange: [4 * DAY, 5 * DAY - 1]}, maps, storage), 2 * DAY, 12 * DAY), {start: 2 * DAY, end: 13 * DAY - 1, period: 'all', periodDay: null});
});

test('calendar navigation retains its preferred day across reloads and validates stored anchors', () => {
  const storage = memoryStorage();
  const min = Date.parse('2024-01-01T00:00:00Z'), max = Date.parse('2025-01-01T00:00:00Z');
  const settings = saveSettings({period: '30', periodDay: 31, dateRange: [Date.parse('2024-02-29T00:00:00Z'), Date.parse('2024-03-31T00:00:00Z') - 1]}, maps, storage);
  assert.equal(loadSettings(maps, storage).periodDay, 31);
  assert.equal(dateSelection(settings, min, max).periodDay, 31);
  for (const periodDay of [0, 32, '31', Infinity, 1.5]) assert.equal(saveSettings({...settings, periodDay}, maps, storage).periodDay, null);
  assert.equal(saveSettings({...settings, period: 'all'}, maps, storage).periodDay, null);
});

test('jump preference migrates old masks without retaining removed exclusions', () => {
  const storage = memoryStorage();
  for (let exclude = 0; exclude < 16; exclude++) {
    const saved = saveSettings({exclude, area: {coordinates: [[13, 52]]}, place: {first: 123}}, maps, storage);
    assert.equal(loadSettings(maps, storage).excludeJumps, Boolean(exclude & 2));
    assert.equal('exclude' in saved, false);
    assert.equal('area' in saved, false); assert.equal('place' in saved, false);
  }
  for (const exclude of [-1, 16, 1.5, '3', null]) assert.equal(saveSettings({exclude}, maps, storage).excludeJumps, false);
  for (const excludeJumps of [true, false]) assert.equal(saveSettings({exclude: 15, excludeJumps}, maps, storage).excludeJumps, excludeJumps);
  for (const excludeJumps of ['true', 1, null]) assert.equal(saveSettings({excludeJumps}, maps, storage).excludeJumps, false);
});

test('journey thickness is independent, bounded and persisted with quarter windows', () => {
  const storage = memoryStorage();
  const settings = loadSettings(maps, storage);
  settings.views.route.lineWidth = 4.5;
  settings.views.heat.intensity = 2;
  Object.assign(settings, {period: '90', periodDay: 31, excludeJumps: true});
  saveSettings(settings, maps, storage);
  assert.deepEqual(loadSettings(maps, storage), settings);
  assert.equal(settings.views.hex.intensity, 1);
  for (const lineWidth of [0, 10.5, 1.1, '3', null, Infinity]) {
    assert.equal(saveSettings({views: {route: {lineWidth}}}, maps, storage).views.route.lineWidth, 1.5);
  }
  assert.equal(saveSettings({views: {route: {lineWidth: .5}}}, maps, storage).views.route.lineWidth, .5);
  assert.equal(saveSettings({views: {route: {lineWidth: 10}}}, maps, storage).views.route.lineWidth, 10);
});

test('all six accuracy choices and Week windows survive reloads', () => {
  const storage = memoryStorage();
  for (const accuracy of [0, 10, 50, 100, 500, 1000]) {
    saveSettings({accuracy, period: '7', dateRange: [DAY, 8 * DAY - 1]}, maps, storage);
    const saved = loadSettings(maps, storage);
    assert.equal(saved.accuracy, accuracy); assert.equal(saved.period, '7');
    assert.deepEqual(saved.dateRange, [DAY, 8 * DAY - 1]);
  }
});
