import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {parseHistory, preparePoints, queryHistory, wrappedBounds, project, timestamp, shiftPeriod, DAY} from './data.mjs';
const point = (t, lon = 13.4, lat = 52.5, accuracy = null) => ({t, lon, lat, accuracy, duration: 0});
const records = locations => parseHistory({locations}).points;
const legacy = (time, lat = 525000000, lon = 134000000) => ({timestampMs: String(time), latitudeE7: lat, longitudeE7: lon});
test('day navigation steps full inclusive UTC days across month and leap-day boundaries', () => {
  const start = Date.parse('2024-02-29T00:00:00Z'), end = start + DAY - 1;
  const min = Date.parse('2024-01-01T00:00:00Z'), max = Date.parse('2024-04-01T00:00:00Z') - 1;
  assert.deepEqual(shiftPeriod(start, end, min, max, -1), {start: start - DAY, end: end - DAY});
  assert.deepEqual(shiftPeriod(start, end, min, max, 1), {start: Date.parse('2024-03-01T00:00:00Z'), end: Date.parse('2024-03-02T00:00:00Z') - 1});
});
test('period navigation advances a 30-day or custom range by its complete duration', () => {
  for (const days of [7, 30, 365]) {
    const start = 400 * DAY, end = start + days * DAY - 1;
    assert.deepEqual(shiftPeriod(start, end, 0, 1200 * DAY - 1, 1), {start: start + days * DAY, end: end + days * DAY});
    assert.deepEqual(shiftPeriod(start, end, 0, 1200 * DAY - 1, -1), {start: start - days * DAY, end: end - days * DAY});
  }
});
test('period navigation clamps at history boundaries without shrinking the range', () => {
  assert.deepEqual(shiftPeriod(5 * DAY, 35 * DAY - 1, 0, 100 * DAY - 1, -1), {start: 0, end: 30 * DAY - 1});
  assert.deepEqual(shiftPeriod(65 * DAY, 95 * DAY - 1, 0, 100 * DAY - 1, 1), {start: 70 * DAY, end: 100 * DAY - 1});
});
test('full-history and single-day histories cannot step outside their bounds', () => {
  for (const days of [1, 100]) for (const direction of [-1, 1]) {
    assert.deepEqual(shiftPeriod(0, days * DAY - 1, 0, days * DAY - 1, direction), {start: 0, end: days * DAY - 1});
  }
});
test('legacy millisecond strings, epoch zero, and zero coordinates are valid', () => {
  assert.deepEqual(records([legacy(0, 0, 0)]), [point(0, 0, 0)]);
  assert.equal(timestamp('1577836800000'), 1577836800000);
});
test('invalid coordinates, absent timestamps, and null records are skipped', () => {
  const parsed = parseHistory({locations: [null, legacy(0, 910000000), legacy(0, 0, 1810000000), {...legacy(1), timestampMs: ''}, legacy(2)]});
  assert.equal(parsed.skipped, 4); assert.equal(parsed.points.length, 1);
});
test('same timestamp at different coordinates survives, exact duplicates merge', () => {
  const prepared = preparePoints([point(10, 1, 1), point(10, 1, 1, 20), point(10, 2, 2)]);
  assert.equal(prepared.points.length, 2); assert.equal(prepared.duplicates, 1); assert.equal(prepared.points[0].accuracy, 20);
});
test('delta-compressed sample format validates array lengths and numeric deltas', () => {
  const p = parseHistory({format: 'delta-compressed', base: [0, 0, 0], data: [[10], [20], [1000]]}).points;
  assert.equal(p.length, 2); assert.equal(p[1].lon, .000002); assert.equal(p[1].t, 1000);
  assert.throws(() => parseHistory({format: 'delta-compressed', base: [0, 0, 0], data: [[1], [], [3]]}), /Invalid delta/);
});
test('on-device Timeline paths, visits, and activity endpoints', () => {
  const parsed = parseHistory({semanticSegments: [{startTime: '2025-01-01T10:00:00Z', endTime: '2025-01-01T11:00:00Z', visit: {topCandidate: {placeLocation: {latLng: 'geo:52.5,13.4'}}}, timelinePath: [{point: 'geo:52.51,13.41', durationMinutesOffsetFromStartTime: '10'}], activity: {start: {latLng: 'geo:52.5,13.4'}, end: {latLng: 'geo:52.52,13.42'}}}]});
  assert.equal(parsed.points.length, 4); assert.equal(parsed.points[0].duration, 3_600_000); assert.equal(parsed.points[1].t, Date.parse('2025-01-01T10:10:00Z'));
});
test('monthly semantic history reads nested visit and activity durations', () => {
  const p = parseHistory({timelineObjects: [{placeVisit: {location: {latitudeE7: 525000000, longitudeE7: 134000000}, duration: {startTimestampMs: '1000', endTimestampMs: '61000'}}}, {activitySegment: {startLocation: {latitudeE7: 525000000, longitudeE7: 134000000}, endLocation: {latitudeE7: 526000000, longitudeE7: 135000000}, duration: {startTimestamp: '2025-01-01T00:00:00Z', endTimestamp: '2025-01-01T01:00:00Z'}}}]}).points;
  assert.equal(p.length, 3); assert.equal(p[0].duration, 60000);
});
test('timestamped GeoJSON roundtrip and malformed points', () => {
  const parsed = parseHistory({type: 'FeatureCollection', features: [{type: 'Feature', geometry: {type: 'Point', coordinates: [0, 0]}, properties: {timestamp: '2025-01-01T00:00:00Z'}}, {geometry: {type: 'Point'}}]});
  assert.equal(parsed.points.length, 1); assert.equal(parsed.skipped, 1);
});
test('unknown or empty schemas are rejected', () => {
  for (const data of [{}, null, {locations: []}, {locations: [null]}]) assert.throws(() => parseHistory(data));
});
test('date endpoints are inclusive and empty ranges return empty collections', () => {
  const points = [point(0), point(1000), point(2000)];
  assert.equal(queryHistory(points, {start: 1000, end: 2000}).count, 2);
  const empty = queryHistory(points, {start: 3000, end: 4000});
  assert.equal(empty.count, 0); assert.equal(empty.bounds, null); assert.equal(empty.density.features.length, 0);
});
test('accuracy filters retain unknown metadata and hour filters use UTC', () => {
  const t = Date.parse('2025-01-01T10:00:00Z');
  const p = [point(t, 0, 0, null), point(t + 1000, 0, 0, 50), point(t + 2000, 0, 0, 800), point(t + 3_600_000, 0, 0, 10)];
  assert.equal(queryHistory(p, {accuracy: 100, hourStart: 10, hourEnd: 11}).count, 2);
});
test('distinct-day density counts a day once per spatial cell', () => {
  const p = [point(0), point(1000), point(DAY), point(DAY + 1000)];
  const result = queryHistory(p, {metric: 'days', mode: 'hex'});
  assert.equal(result.density.features.length, 1); assert.equal(result.density.features[0].properties.value, 2); assert.equal(result.days, 2);
});
test('stationary intervals exclude travel and long gaps', () => {
  const p = preparePoints([point(0), point(600_000), point(3_600_000), point(3_900_000, 14.4)]).points;
  assert.equal(p[0].duration, 600_000); assert.equal(p[1].duration, 0); assert.equal(p[2].duration, 0);
  const result = queryHistory(p, {metric: 'time'});
  assert.equal(result.density.features.reduce((s, f) => s + f.properties.value, 0), 10);
});
test('estimated time is clipped at the selected end and UTC hour boundary', () => {
  const p = point(Date.parse('2025-01-01T10:45:00Z')); p.duration = 3_600_000;
  assert.equal(queryHistory([p], {metric: 'time', hourStart: 10, hourEnd: 11}).density.features[0].properties.value, 15);
  assert.equal(queryHistory([p], {metric: 'time', end: p.t + 300_000 - 1}).density.features[0].properties.value, 5);
});
test('routes break at filtered observations, long gaps and implausible jumps', () => {
  const p = [point(0), point(60000, 13.401), point(120000, 13.402, 52.5, 500), point(180000, 13.403), point(240000, 13.404), point(DAY, 13.405), point(DAY + 60_000, 140)];
  const result = queryHistory(p, {mode: 'route', accuracy: 100});
  assert.equal(result.routes.features.length, 2); assert.equal(result.routes.features[0].geometry.coordinates.length, 2); assert.equal(result.routes.features[1].geometry.coordinates.length, 2);
});
test('dateline bounds select the short longitude arc and density wraps to view', () => {
  const p = [point(0, 179, 10), point(1, -179, 10)];
  assert.deepEqual(wrappedBounds(p), [[179, 10], [181, 10]]);
  assert.equal(queryHistory(p, {viewport: [178, 0, 182, 20]}).visible, 2);
});
test('polar coordinates project to finite values and fit bounds remain ordered', () => {
  assert.ok(project(0, 90).every(Number.isFinite));
  assert.deepEqual(wrappedBounds([point(0, 0, 90)]), [[0, 85], [0, 85]]);
});
test('hexagons are closed finite GeoJSON polygons', () => {
  const f = queryHistory([point(0)], {mode: 'hex'}).density.features[0];
  assert.equal(f.geometry.type, 'Polygon'); assert.equal(f.geometry.coordinates[0].length, 7);
  assert.deepEqual(f.geometry.coordinates[0][0], f.geometry.coordinates[0][6]);
});
test('point mode caps rendered observations, while counts stay exact', () => {
  const p = Array.from({length: 21000}, (_, i) => point(i));
  const result = queryHistory(p, {mode: 'points'});
  assert.equal(result.count, 21000); assert.ok(result.dots.features.length <= 20000);
});
test('bundled 266,682-point history imports and filters without dropping records', () => {
  const data = JSON.parse(gunzipSync(readFileSync(new URL('./sample-location-history.json.gz', import.meta.url))));
  const prepared = preparePoints(parseHistory(data).points);
  assert.equal(prepared.points.length, 266682);
  assert.equal(queryHistory(prepared.points).count, 266682);
});
