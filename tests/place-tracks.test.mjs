import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryQuery, preparePoints, placePolygon, distance, DAY} from '../js/data.mjs';

const point = (t, x, y = 0, extra = {}) => ({t, lon: x / 111195, lat: y / 111195, accuracy: 0, duration: 0, ...extra});
const area = coordinates => ({geometry: placePolygon(coordinates.map(([x, y]) => [x / 111195, y / 111195]))});
const square = area([[0, 0], [100, 0], [100, 100], [0, 100]]);
const large = area([[-10000, -10000], [10000, -10000], [10000, 10000], [-10000, 10000]]);
const near = (actual, expected, tolerance = 1e-4) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const queryFor = points => createHistoryQuery(preparePoints(points, {inferStationary: false}).points);

test('place tracks clip entry and exit even when no recording lies inside', () => {
  const result = queryFor([point(0, -100, 50), point(60000, 200, 50)]).place(square);
  assert.equal(result.count, 0); assert.equal(result.visits, 0);
  near(result.km, .1); near(result.averageSpeed, 18); near(result.medianSpeed, 18);
});

test('concave outlines include separate crossings, boundary legs and no tangent length', () => {
  const outline = area([[0, 0], [300, 0], [300, 300], [200, 300], [200, 100], [100, 100], [100, 300], [0, 300]]);
  near(queryFor([point(0, -100, 200), point(60000, 400, 200)]).place(outline).km, .2);
  near(queryFor([point(0, -100), point(60000, 200)]).place(square).km, .1);
  const tangent = queryFor([point(0, -100), point(60000, 100, 200)]).place(square);
  near(tangent.km, 0); assert.equal(tangent.averageSpeed, null); assert.equal(tangent.medianSpeed, null);
});

test('place track clipping handles high latitudes and wrapped outlines without bridging the dateline', () => {
  const polarPoints = [{...point(0, 0), lon: -.1, lat: 80}, {...point(600000, 0), lon: .2, lat: 80}];
  const polar = {geometry: placePolygon([[0, 79], [.1, 79], [.1, 81], [0, 81]])};
  near(queryFor(polarPoints).place(polar).km, distance(...polarPoints) / 3, 1e-8);
  const wrapped = {geometry: placePolygon([[179.998, -.001], [-179.998, -.001], [-179.998, .001], [179.998, .001]])};
  const points = [179.997, 179.999, -179.999, -179.997].map((lon, i) => ({...point(i * 60000, 0), lon}));
  near(queryFor(points).place(wrapped).km, distance(points[0], points[1]), 1e-8);
});

test('average and median speeds are weighted by time, independent of recording density', () => {
  const track = (device, kmh, seconds, step, y) => Array.from({length: seconds / step + 1}, (_, i) => point(i * step * 1000, i * step * kmh / 3.6, y, {recordedSpeed: kmh, stream: {device, source: 1}}));
  for (const step of [60, 10, 1]) {
    const result = queryFor([...track('a', 10, 60, step, 100), ...track('b', 30, 180, 180, 200)]).place(large);
    near(result.km, 5 / 3); near(result.averageSpeed, 25); near(result.medianSpeed, 30);
  }
  const stops = queryFor([...track('a', 0, 180, 180, 100), ...track('b', 10, 60, 60, 200)]).place(large);
  near(stops.averageSpeed, 2.5); assert.equal(stops.medianSpeed, 0);
  const half = queryFor([...track('a', 10, 60, 60, 100), ...track('b', 30, 60, 60, 200)]).place(large);
  near(half.averageSpeed, 20); near(half.medianSpeed, 20);
});

test('speed weights use only the duration inside the selected outline', () => {
  const result = queryFor([
    point(0, -100, 50, {stream: {device: 'a', source: 1}}), point(60000, 200, 50, {stream: {device: 'a', source: 1}}),
    point(0, 10, 75, {stream: {device: 'b', source: 1}}), point(60000, 30, 75, {stream: {device: 'b', source: 1}}),
  ]).place(square);
  near(result.averageSpeed, 5.4); near(result.medianSpeed, 1.2);
});

test('place track length shares accuracy, outlier, speed, altitude and source filters with Journeys', () => {
  const points = [point(0, 0, 50, {accuracy: 4, altitude: 10}), point(5000, 400, 50, {accuracy: 500, altitude: 100}), point(10000, 10, 50, {accuracy: 4, altitude: 10})];
  const query = queryFor(points), original = structuredClone(points);
  const outliers = queryFor(points.map(p => ({...p, accuracy: 4})));
  for (const [q, options] of [[query, {accuracy: 100}], [query, {altitudeMax: 20}], [outliers, {trackMode: 'outliers'}], [outliers, {trackMode: 'drift'}]]) {
    const result = q.place(large, options);
    assert.equal(result.count, 2);
    near(result.km, .01); near(result.km, q(options).km, 1e-12); near(result.averageSpeed, 3.6);
  }
  const none = outliers.place(large, {trackMode: 'outliers', speedMin: 5, speedUnknown: false});
  assert.equal(none.km, 0); assert.equal(none.averageSpeed, null); assert.equal(none.medianSpeed, null);
  const sources = queryFor([point(0, 10, 50, {stream: {device: 'a', source: 1}}), point(1000, 80, 50, {stream: {device: 'a', source: 4}}), point(60000, 20, 50, {stream: {device: 'a', source: 1}})]);
  const gps = sources.place(square, {source: 1});
  near(gps.km, .01); near(gps.averageSpeed, .6);
  assert.deepEqual(points, original);
});

test('place tracks respect date windows, excluded daily hours, gaps and device boundaries', () => {
  const hour = DAY / 24, midnight = queryFor([point(22 * hour, 10, 50), point(DAY + 2 * hour, 90, 50)]);
  near(midnight.place(square).km, .08);
  assert.equal(midnight.place(square, {hourStart: 1}).km, 0);
  assert.equal(midnight.place(square, {start: DAY}).km, 0);
  for (const points of [
    [point(0, 10, 50), point(7 * hour, 90, 50)],
    [point(0, 10, 50, {stream: {device: 'a', source: 1}}), point(1000, 90, 50, {stream: {device: 'b', source: 1}})],
    [point(0, 10, 50), point(1, 90, 50)],
  ]) {
    const result = queryFor(points).place(square);
    assert.equal(result.km, 0); assert.equal(result.averageSpeed, null); assert.equal(result.medianSpeed, null);
  }
});

test('unknown speeds stay unknown and GPS drift includes known stationary speeds as zero', () => {
  const unknown = queryFor([point(0, 10, 50), point(3600000, 90, 50)]).place(square);
  near(unknown.km, .08); assert.equal(unknown.averageSpeed, null); assert.equal(unknown.medianSpeed, null);
  const points = Array.from({length: 61}, (_, i) => point(i * 1000, 50 + 8 * Math.sin(i * 2), 50, {accuracy: 20}));
  const query = queryFor(points), drift = query.place(square, {trackMode: 'drift'});
  assert.equal(drift.km, 0); assert.equal(drift.averageSpeed, 0); assert.equal(drift.medianSpeed, 0);
  assert.ok(query.place(square, {trackMode: 'off'}).averageSpeed > 1);
});

test('place track queries reuse results without replacing journey geometry or changing input locations', () => {
  const points = [point(0, 10, 50), point(60000, 50, 50), point(120000, 90, 50)], original = structuredClone(points);
  const query = queryFor(points), options = {mode: 'route', colorBy: 'speed', zoom: 18};
  const route = query(options), place = query.place(square);
  assert.equal(query.place(square), place); near(place.km, route.km, 1e-12);
  query.place(square, {start: 60000});
  assert.equal(query(options).routes, route.routes);
  const hex = query({mode: 'hex', radius: 24, zoom: 10}).density.features.find(f => f.properties.value === 3);
  assert.ok(hex); assert.ok(query.place(hex).km > 0);
  assert.deepEqual(points, original);
});

test('an encompassing outline matches map distance across devices, noisy stops and measurement filters', () => {
  const points = Array.from({length: 600}, (_, i) => {
    const step = Math.floor(i / 2), device = String(i % 2), moving = step % 100 < 70;
    return point(step * 10000 + i % 2, moving ? step * 5 : Math.floor(step / 100) * 500 + 350 + Math.sin(step * 2) * 8, 100 + i % 2 * 100,
      {accuracy: step % 11 ? 5 : 50, altitude: step % 40, stream: {device, source: step % 3 ? 1 : 2}, ...(step % 7 ? {} : {recordedSpeed: 1.8})});
  });
  const query = queryFor(points), original = structuredClone(points);
  for (const options of [{}, {accuracy: 20}, {trackMode: 'outliers'}, {trackMode: 'drift', driftWindow: 60}, {speedMin: 1, speedUnknown: false}, {source: 1}, {device: 1}, {altitudeMax: 20}]) {
    near(query.place(large, options).km, query(options).km, 1e-10);
  }
  assert.deepEqual(points, original);
});
