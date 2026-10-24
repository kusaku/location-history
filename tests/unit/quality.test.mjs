import test from 'node:test';
import assert from 'node:assert/strict';
import {qualityFlags, QUALITY, createHistoryQuery, DAY} from '../../assets/js/data.mjs';
const point = (t, lon = 0, accuracy = null) => ({t, lon, lat: 0, accuracy, duration: 0});
test('quality flags distinguish gap endpoints, jumps, poor accuracy and cadence changes', () => {
  const points = [point(0), point(60_000, 0, 100), point(660_000, 0, 101), point(DAY), point(DAY + 1000, 30)];
  assert.deepEqual([...qualityFlags(points)], [0, 0, QUALITY.accuracy | QUALITY.sampling | QUALITY.gaps, QUALITY.gaps | QUALITY.jumps, QUALITY.jumps]);
});
test('quality thresholds preserve unknown accuracy, ordinary flights and steady sampling', () => {
  assert.deepEqual([...qualityFlags([point(0, 0), point(3_600_000, 5), point(7_200_000, 10, 100)])], [0, 0, 0]);
  assert.deepEqual([...qualityFlags([point(0), point(0, 1)])], [QUALITY.jumps, QUALITY.jumps]);
  assert.deepEqual([...qualityFlags([point(0), point(1000), point(30_000)])], [0, 0, 0]);
});
test('exclusions use the union of selected issues and keep histogram and totals exact', () => {
  const query = createHistoryQuery([point(0), point(60_000), point(660_000, 0, 500), point(DAY), point(DAY + 1000, 30)]);
  for (let exclude = 0; exclude < 16; exclude++) {
    const result = query({exclude, mode: 'points'});
    const expected = [0, 0, 13, 3, 2].filter(flag => !(flag & exclude)).length;
    assert.equal(result.count, expected); assert.equal(result.dots.features.length, expected);
    assert.equal(result.histogram.reduce((a, b) => a + b, 0), expected);
  }
});
test('excluding accuracy never joins tracks across a removed observation and panning reuses selection', () => {
  const query = createHistoryQuery([point(0), point(60_000, .001, 500), point(120_000, .002)]);
  const result = query({exclude: QUALITY.accuracy, mode: 'route'});
  assert.equal(result.count, 2); assert.equal(result.km, 0); assert.equal(result.routes.features.length, 0);
  const pan = query({exclude: QUALITY.accuracy, mode: 'route', viewport: [-1, -1, 1, 1]});
  assert.equal(pan.histogram, result.histogram); assert.equal(pan.bounds, result.bounds); assert.equal(pan.routes, result.routes);
});

test('unobserved travel across a recording gap is classified as a gap, not a jump', () => {
  assert.deepEqual([...qualityFlags([point(0, 0), point(7 * 3_600_000, 150)])], [QUALITY.gaps, QUALITY.gaps]);
});
