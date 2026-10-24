import test from 'node:test';
import assert from 'node:assert/strict';
import {jumpFlags, createHistoryQuery, DAY} from '../../assets/js/data.mjs';
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
test('accuracy filtering never joins tracks across removed observations and panning reuses selection', () => {
  const query = createHistoryQuery([point(0), point(60_000, .001, 500), point(120_000, .002)]);
  const result = query({accuracy: 100, mode: 'route'});
  assert.equal(result.count, 2); assert.equal(result.km, 0); assert.equal(result.routes.features.length, 0);
  const pan = query({accuracy: 100, mode: 'route', viewport: [-1, -1, 1, 1]});
  assert.equal(pan.histogram, result.histogram); assert.equal(pan.bounds, result.bounds); assert.equal(pan.routes, result.routes);
});
