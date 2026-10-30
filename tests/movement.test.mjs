import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryQuery, jumpFlags, distance, DAY} from '../js/data.mjs';
import {accuracyCircle} from '../js/maps.mjs';
import {rangePosition, rangeValue} from '../js/filters.mjs';
import {loadSettings, saveSettings} from '../js/settings.mjs';
const point = (t, x = 0, accuracy = null, extra = {}) => ({t, lon: x / 111195, lat: 0, accuracy, duration: 0, ...extra});
const box = {geometry: {coordinates: [[[-.01, -.01], [.01, -.01], [.01, .01], [-.01, .01], [-.01, -.01]]]}};

test('distance suppresses room-scale drift but accumulates small walking steps', () => {
  const jitter = Array.from({length: 1000}, (_, i) => point(i * 5000, Math.sin(i) * 4, 10));
  assert.equal(createHistoryQuery(jitter)().km, 0);
  const walk = Array.from({length: 1001}, (_, i) => point(i * 5000, i * .2, 3));
  assert.ok(Math.abs(createHistoryQuery(walk)().km - .2) < .005);
  const straight = Array.from({length: 101}, (_, i) => point(i * 60000, i * 100, 5));
  assert.ok(Math.abs(createHistoryQuery(straight)().km - 10) < .001);
});
test('short device-speed intervals retain a small walk and stationary fixes contribute zero', () => {
  const points = Array.from({length: 101}, (_, i) => point(i * 5000, Math.sin(i) * 5, 100, {recordedSpeed: 3.6}));
  assert.ok(Math.abs(createHistoryQuery(points)().km - .5) < 1e-9);
  for (const p of points) p.recordedSpeed = 0;
  assert.equal(createHistoryQuery(points)().km, 0);
  assert.equal(createHistoryQuery([point(0), point(DAY, 1000)])().km, 0);
});
test('jump detection preserves neighbours around speed and acceleration spikes', () => {
  assert.deepEqual([...jumpFlags([point(0), point(5000, 5000), point(10000, 10)])], [0, 1, 0]);
  assert.deepEqual([...jumpFlags([point(0), point(5000, 400), point(10000, 10)])], [0, 1, 0]);
  assert.deepEqual([...jumpFlags([point(0), point(600000, 1e6), point(1200000, 10)])], [0, 1, 0]);
  assert.deepEqual([...jumpFlags([point(0), point(0, 1e6), point(60000, 10)])], [0, 1, 0]);
  const normal = Array.from({length: 100}, (_, i) => point(i * 5000, i * 7));
  assert.ok(jumpFlags(normal).every(value => value === 0));
  const flight = Array.from({length: 20}, (_, i) => point(i * 60000, i * 15000));
  assert.ok(jumpFlags(flight).every(value => value === 0));
  assert.deepEqual([...jumpFlags([point(0, 0, 100), point(1000, 50, 100), point(2000, 0, 100)])], [0, 0, 0]);
});
test('known visits stop at the first later accepted exit, not an intervening inside fix', () => {
  const points = [point(0, 0, 5, {duration: 3600000}), point(60000, 10), point(120000, 5000), point(180000, 0)];
  const result = createHistoryQuery(points).place(box);
  assert.equal(result.minutes, 2);
  assert.equal(result.daily.reduce((n, row) => n + row.minutes, 0), 2);
  points[2].accuracy = 500;
  assert.equal(createHistoryQuery(points).place(box, {accuracy: 100}).minutes, 60);
});
test('block interval index finds long stays across several blocks and a next-day boundary', () => {
  const points = Array.from({length: 800}, (_, i) => point(i * 1000, 0));
  points[0].duration = 3 * DAY;
  const query = createHistoryQuery(points), options = {start: DAY, end: 2 * DAY - 1};
  assert.equal(query.place(box, options).minutes, 1440);
  assert.equal(query({...options, metric: 'time'}).density.features.reduce((n, row) => n + row.properties.minutes, 0), 1440);
});
test('height, speed and accuracy ranges share map and place filters, retaining unknowns by default', () => {
  const points = [point(0, 0, 5, {altitude: -10, recordedSpeed: 0}), point(60000, 1, 50, {altitude: 0, recordedSpeed: 5}), point(DAY, 2, null, {altitude: 100, recordedSpeed: 100}), point(3 * DAY, 3)];
  const query = createHistoryQuery(points);
  for (const [options, count] of [[{altitudeMin: 0, altitudeMax: 50}, 2], [{altitudeMin: 0, altitudeMax: 50, altitudeUnknown: false}, 1], [{speedMin: 1, speedMax: 10}, 2], [{speedMin: 1, speedMax: 10, speedUnknown: false}, 1], [{accuracyMin: 10, accuracy: 100}, 3], [{accuracyMin: 10, accuracy: 100, accuracyUnknown: false}, 1]]) {
    assert.equal(query({...options, mode: 'points'}).count, count);
    assert.equal(query.place(box, options).count, count);
  }
});
test('selected accuracy circle has the correct metre radius at high latitude and dateline', () => {
  for (const [lon, lat] of [[13, 52], [179.999, 80]]) {
    const ring = accuracyCircle([lon, lat], 250).features[0].geometry.coordinates[0];
    assert.equal(ring.length, 65); assert.deepEqual(ring[0], ring.at(-1));
    assert.ok(ring.every(([x, y]) => Math.abs(distance({lon, lat}, {lon: x, lat: y}) * 1000 - 250) < 1e-6));
  }
  assert.equal(accuracyCircle([0, 0], null).features.length, 0);
});
test('linear and logarithmic slider positions roundtrip endpoints and small values', () => {
  for (const logarithmic of [false, true]) for (const value of [0, 1, 5, 50, 1000]) {
    assert.ok(Math.abs(rangeValue(rangePosition(value, 0, 1000, logarithmic), 0, 1000, logarithmic) - value) < 1e-9);
  }
  assert.equal(rangeValue(0, -100, 500), -100);
  assert.equal(rangeValue(1000, -100, 500), 500);
});
test('numeric filter preferences persist and invalid or reversed ranges reset safely', () => {
  let value; const storage = {getItem: () => value, setItem: (_, v) => { value = v; }};
  const input = {accuracyMin: 3, accuracy: 25, speedMin: 0, speedMax: 5.5, altitudeMin: -10, altitudeMax: 0, speedUnknown: false};
  saveSettings(input, ['dark'], storage);
  const settings = loadSettings(['dark'], storage);
  for (const key of Object.keys(input)) assert.equal(settings[key], input[key]);
  assert.equal(saveSettings({speedMin: 20, speedMax: 0}, ['dark'], storage).speedMin, null);
});
