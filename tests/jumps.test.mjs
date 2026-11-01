import test from 'node:test';
import assert from 'node:assert/strict';
import {jumpFlags, createHistoryQuery, DAY} from '../js/data.mjs';
const point = (t, lon = 0, accuracy = null) => ({t, lon, lat: 0, accuracy, duration: 0});

test('suspicious jumps flag both endpoints without classifying gaps, accuracy or cadence', () => {
  const points = [point(0), point(60_000, 0, 100), point(660_000, 0, 500), point(DAY), point(DAY + 1000, 30)];
  assert.deepEqual([...jumpFlags(points)], [0, 0, 0, 1, 1]);
  assert.deepEqual([...jumpFlags([])], []);
  assert.deepEqual([...jumpFlags([point(0)])], [0]);
});
test('jump thresholds preserve ordinary flights and detect conflicting simultaneous locations', () => {
  assert.deepEqual([...jumpFlags([point(0), point(3_600_000, 5), point(7_200_000, 10, 500)])], [0, 0, 0]);
  assert.deepEqual([...jumpFlags([point(0), point(0, 1)])], [1, 1]);
  assert.deepEqual([...jumpFlags([point(0), point(0)])], [0, 0]);
  assert.deepEqual([...jumpFlags([point(0), point(7 * 3_600_000, 150)])], [0, 0]);
});
test('jump exclusion keeps map, histogram and combined accuracy totals exact', () => {
  const query = createHistoryQuery([point(0), point(60_000), point(660_000, 0, 500), point(DAY), point(DAY + 1000, 30)]);
  for (const [excludeJumps, accuracy, expected] of [[false, 0, 5], [true, 0, 3], [true, 100, 2], [false, 100, 4]]) {
    const result = query({excludeJumps, accuracy, mode: 'points'});
    assert.equal(result.count, expected); assert.equal(result.dots.features.length, expected);
    assert.equal(result.histogram.reduce((a, b) => a + b, 0), expected);
  }
});
test('accuracy filtering connects retained locations and panning reuses selection', () => {
  const query = createHistoryQuery([point(0), point(60_000, .001, 500), point(120_000, .002)]);
  const result = query({accuracy: 100, mode: 'route'});
  assert.equal(result.count, 2); assert.ok(result.routes.features.length > 0);
  assert.deepEqual(result.routes.features[0].geometry.coordinates[0], [0, 0]);
  assert.deepEqual(result.routes.features.at(-1).geometry.coordinates.at(-1), [.002, 0]);
  const pan = query({accuracy: 100, mode: 'route', viewport: [-1, -1, 1, 1]});
  assert.equal(pan.histogram, result.histogram); assert.equal(pan.bounds, result.bounds); assert.equal(pan.routes, result.routes);
});

const fix = (t, metres, accuracy = 5) => ({t, lon: metres / 111195, lat: 0, accuracy, duration: 0});
test('an impossible burst keeps its return anchor when another conflict follows', () => {
  const points = [fix(0, 0), fix(100000, 0), fix(120000, 100000), fix(121000, 100000), fix(130000, 0), fix(140000, 1000000)];
  assert.deepEqual([...jumpFlags(points)], [0, 0, 1, 1, 0, 1]);
});

test('short repeated impossible excursions are excluded without discarding their valid neighbours', () => {
  for (const count of [2, 3, 7]) {
    const fixes = [fix(0, 0), fix(60000, 0), ...Array.from({length: count}, (_, i) => fix(300000 + i * 60000, 4700000)), fix(310000 + count * 60000, 0), fix(370000 + count * 60000, 0)];
    const snapshot = structuredClone(fixes);
    assert.deepEqual([...jumpFlags(fixes)], fixes.map((_, i) => i >= 2 && i < 2 + count ? 1 : 0));
    assert.deepEqual(fixes, snapshot);
    assert.equal(createHistoryQuery(fixes)({excludeJumps: true}).count, 4);
  }
  // Without a plausible return, the initial conflicting fix remains ambiguous.
  const relocation = jumpFlags([fix(0, 0), fix(60000, 4700000), fix(120000, 4700010)]);
  assert.equal(relocation[1], 0); assert.equal(relocation[2], 0);
});

test('local track quality removes a moderate isolated spike while preserving its neighbours', () => {
  const points = Array.from({length: 15}, (_, i) => fix(i * 60_000, i === 7 ? 1000 : 0));
  const source = structuredClone(points), flags = jumpFlags(points);
  assert.deepEqual([...flags], points.map((_, i) => i === 7 ? 1 : 0));
  assert.ok(jumpFlags(points, {tolerance: 100}).every(value => value === 0));
  assert.deepEqual(points, source); // Neither coordinates nor additional per-point fields change.
  const query = createHistoryQuery(points), selected = {start: points[7].t, end: points[7].t, mode: 'points', excludeJumps: true};
  assert.equal(query({...selected, jumpTolerance: 15}).count, 0);
  assert.equal(query({...selected, jumpTolerance: 100}).count, 1);
  assert.equal(query({...selected, jumpTolerance: 15}).count, 0);
  assert.equal(query({...selected, excludeJumps: false}).count, 1);
  const cleaned = query({mode: 'points', excludeJumps: true}).dots.features;
  assert.equal(cleaned.length, 14);
  assert.ok(cleaned.every(dot => dot.properties.speed === 0));
  assert.equal(query({excludeJumps: true, speedMin: 56, speedUnknown: false}).count, 0);
  assert.equal(query({excludeJumps: false, speedMin: 56, speedUnknown: false}).count, 1);
  assert.equal(query.point(6, {excludeJumps: true}).next, 8);
  assert.equal(query.point(8, {excludeJumps: true}).previous, 6);
  assert.equal(query.point(7, {excludeJumps: true}), null);
  assert.equal(query.point(6, {excludeJumps: true, jumpTolerance: 100}).next, 7);
  assert.equal(query.point(6, {excludeJumps: true}).feature.properties.speed, 0);
});
test('local quality keeps steady walking, driving, flight, turns and sustained acceleration', () => {
  for (const kph of [5, 60, 900]) {
    const points = Array.from({length: 30}, (_, i) => fix(i * 60_000, i * kph / 3.6 * 60));
    assert.ok(jumpFlags(points).every(value => value === 0));
  }
  let time = 0;
  const irregular = Array.from({length: 40}, (_, i) => { time += i % 3 ? 5000 : 60000; return fix(time, time / 1000 * 10); });
  assert.ok(jumpFlags(irregular).every(value => value === 0));
  let x = 0;
  const accelerating = Array.from({length: 40}, (_, i) => { x += Math.min(60, Math.max(0, i - 10) * 10) / 3.6 * 60; return fix(i * 60000, x); });
  assert.ok(jumpFlags(accelerating).every(value => value === 0));
  const turn = Array.from({length: 40}, (_, i) => ({...fix(i * 5000, 0), lon: Math.cos(i / 20) * .01, lat: Math.sin(i / 20) * .01}));
  assert.ok(jumpFlags(turn).every(value => value === 0));
});
test('local quality respects missing context, long gaps and measurement resolution', () => {
  const uncertain = Array.from({length: 15}, (_, i) => fix(i * 1000, i === 7 ? 20 : 0, 100));
  assert.ok(jumpFlags(uncertain).every(value => value === 0));
  const sparse = Array.from({length: 15}, (_, i) => fix(i * 3600000, i === 7 ? 1000 : 0));
  assert.ok(jumpFlags(sparse).every(value => value === 0));
  const short = [fix(0, 0), fix(60000, 1000), fix(120000, 0)];
  assert.ok(jumpFlags(short).every(value => value === 0));
});
test('raising the quality allowance never adds exclusions and pans keep the current geometry', () => {
  const points = Array.from({length: 100}, (_, i) => fix(i * 60_000, i % 13 === 7 ? 300 + (i % 5) * 400 : i * 2));
  let previous = jumpFlags(points, {tolerance: 0});
  for (const tolerance of [5, 15, 30, 100, 200]) {
    const current = jumpFlags(points, {tolerance});
    assert.ok(current.every((flag, i) => !flag || previous[i])); previous = current;
  }
  const query = createHistoryQuery(points), options = {mode: 'route', excludeJumps: true, jumpTolerance: 15};
  const first = query(options), pan = query({...options, viewport: [-1, -1, 1, 1]});
  assert.equal(first.routes, pan.routes); assert.equal(first.histogram, pan.histogram);
  assert.deepEqual(query({...options, jumpTolerance: NaN}).count, first.count);
  const relocated = Array.from({length: 15}, (_, i) => fix(i * 60000, i < 7 ? 0 : i === 7 ? 1000 : 333));
  assert.equal(jumpFlags(relocated, {tolerance: 5})[7], 1);
  assert.equal(jumpFlags(relocated, {tolerance: 15})[7], 1);
  assert.equal(jumpFlags(relocated, {tolerance: 50})[7], 0);
});
test('place history and date-window counts share the same adjustable quality filter', () => {
  const points = Array.from({length: 15}, (_, i) => fix(i * 60_000, i === 7 ? 1000 : 0));
  const query = createHistoryQuery(points), area = {geometry: {coordinates: [[[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]]]}};
  for (const jumpTolerance of [0, 15, 100]) {
    const options = {excludeJumps: true, jumpTolerance};
    assert.equal(query.place(area, options).count, query(options).count);
  }
});
