import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {parseHistory, preparePoints, queryHistory, createHistoryQuery, wrappedBounds, project, timestamp, shiftPeriod, intervalSpeed, DAY} from '../js/data.mjs';
const point = (t, lon = 13.4, lat = 52.5, accuracy = null) => ({t, lon, lat, accuracy, duration: 0});
const records = locations => parseHistory({locations}).points;
const legacy = (time, lat = 525000000, lon = 134000000) => ({timestampMs: String(time), latitudeE7: lat, longitudeE7: lon});
test('point navigation preserves chronological ties, metadata and source records', () => {
  const points = [point(0), {...point(1000, 13.401, 52.5, 5), altitude: -10, recordedSpeed: 0}, point(1000, 13.402), point(2000)];
  const source = structuredClone(points), query = createHistoryQuery(points), options = {mode: 'points'};
  const rendered = query(options);
  for (let i = 0; i < points.length; i++) {
    const selected = query.point(i, options);
    assert.deepEqual(selected.feature, rendered.dots.features[i]);
    assert.equal(selected.previous, i ? i - 1 : null);
    assert.equal(selected.next, i < points.length - 1 ? i + 1 : null);
  }
  assert.deepEqual(points, source);
  assert.equal(query(options).bounds, rendered.bounds);
  assert.equal(query(options).histogram, rendered.histogram);
  for (const invalid of [undefined, null, NaN, -1, .5, '1', points.length]) assert.equal(query.point(invalid), null);
  assert.equal(createHistoryQuery([]).point(0), null);
});
test('point navigation respects window, UTC hours and measurement filters', () => {
  const points = Array.from({length: 8}, (_, i) => ({...point((10 * 60 + i * 20) * 60_000, 13.4, 52.5, i === 2 ? 500 : 5), altitude: i === 3 ? 200 : 50, recordedSpeed: i === 4 ? 100 : 5}));
  const query = createHistoryQuery(points), options = {start: points[1].t, end: points[7].t, hourStart: 10, hourEnd: 12, accuracy: 100, altitudeMax: 100, speedMax: 10};
  assert.equal(query.point(1, options).previous, null);
  assert.equal(query.point(1, options).next, 5);
  assert.equal(query.point(5, options).previous, 1);
  assert.equal(query.point(5, options).next, null);
  for (const index of [0, 2, 3, 4, 6, 7]) assert.equal(query.point(index, options), null);
  assert.equal(query.point(1, {start: points[1].t, end: points[1].t}).next, null);
  const single = query.point(1, {start: points[1].t, end: points[1].t});
  assert.equal(single.previous, null); assert.equal(single.next, null);
});
test('point navigation reaches observations omitted by sampling and viewport culling', () => {
  const points = Array.from({length: 20_002}, (_, i) => point(i * 60000));
  const query = createHistoryQuery(points), rendered = query({mode: 'points'}).dots.features;
  assert.ok(!rendered.some(feature => feature.properties.index === 1));
  assert.equal(query.point(0).next, 1);
  assert.equal(query.point(1).feature.properties.time, points[1].t);
  const local = createHistoryQuery([point(0), point(60000, -120, 35)]);
  assert.equal(local({mode: 'points', viewport: [13, 52, 14, 53]}).dots.features.length, 1);
  const next = local.point(local.point(0).next);
  assert.deepEqual(next.feature.geometry.coordinates, [-120, 35]);
});
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

test('chronological day counts remain exact in indexed bins across the Unix epoch and missing days', () => {
  const local = [-1, 0, 2].flatMap(day => [point(day * DAY + 7200000), point(day * DAY + 7260000)]);
  const remote = Array.from({length: 30}, (_, i) => point(i * 60000, -120, 35));
  const query = createHistoryQuery(preparePoints([...local, ...remote]).points);
  for (const mode of ['heat', 'hex']) for (const metric of ['records', 'days', 'time']) {
    const result = query({mode, metric, zoom: 5, viewport: [13, 52, 14, 53]});
    assert.equal(result.days, 3); assert.equal(result.visible, 6);
    assert.equal(result.density.features.length, 1);
    assert.equal(result.density.features[0].properties.days, 3);
    assert.equal(result.density.features[0].properties.count, 6);
  }
  const routes = query({mode: 'route', viewport: [13, 52, 14, 53]});
  assert.equal(routes.visible, 6); assert.equal(routes.days, 3);
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
test('routes skip inaccurate observations but still break at long gaps and implausible jumps', () => {
  const p = [point(0), point(60000, 13.401), point(120000, 13.402, 52.5, 500), point(180000, 13.403), point(240000, 13.404), point(DAY, 13.405), point(DAY + 60_000, 140)];
  const result = queryHistory(p, {mode: 'route', accuracy: 100});
  assert.equal(result.routes.features.length, 1); assert.equal(result.routes.features[0].geometry.coordinates.length, 4);
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
test('two-pixel hexagons give finer geometry without changing selection counts', () => {
  const points = Array.from({length: 100}, (_, i) => point(i, 13.4 + i % 10 * .0001, 52.5 + Math.floor(i / 10) * .0001));
  const query = createHistoryQuery(points);
  const small = query({mode: 'hex', radius: 2, zoom: 14});
  const large = query({mode: 'hex', radius: 8, zoom: 14});
  assert.equal(small.count, large.count);
  assert.ok(small.density.features.length > large.density.features.length);
  const width = feature => {
    const xs = feature.geometry.coordinates[0].map(c => c[0]);
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.ok(Math.abs(width(small.density.features[0]) * 4 - width(large.density.features[0])) < 1e-9);
  assert.deepEqual(query({mode: 'hex', radius: 1, zoom: 14}).density, small.density);
  for (const {geometry} of small.density.features) {
    assert.ok(geometry.coordinates[0].flat().every(Number.isFinite));
    assert.deepEqual(geometry.coordinates[0][0], geometry.coordinates[0][6]);
  }
});
test('point mode caps rendered observations, while counts stay exact', () => {
  const p = Array.from({length: 21000}, (_, i) => point(i));
  const result = queryHistory(p, {mode: 'points'});
  assert.equal(result.count, 21000); assert.ok(result.dots.features.length <= 20000);
});
test('bundled sample preserves every trimmed observation and its accuracy metadata', () => {
  const data = JSON.parse(gunzipSync(readFileSync(new URL('../data/sample-location-history.json.gz', import.meta.url))));
  const prepared = preparePoints(parseHistory(data).points);
  assert.equal(data.version, 2); assert.equal(prepared.duplicates, 0);
  assert.equal(prepared.points.length, 910311); assert.equal(data.accuracy.length, 910311);
  const query = createHistoryQuery(prepared.points);
  assert.equal(query().count, 910311); assert.equal(query({accuracy: 10}).count, 23671);
  assert.ok(prepared.points.at(-1).t < Date.parse('2020-04-02T00:00:00Z'));
});

test('malformed semantic waypoints are skipped without losing valid path observations', () => {
  const parsed = parseHistory({semanticSegments: [{timelinePath: [null, false, {point: 'geo:52.5,13.4', time: '2025-01-01T00:00:00Z'}]}]});
  assert.equal(parsed.skipped, 2); assert.equal(parsed.points.length, 1);
});

test('spatial index agrees with a chronological viewport scan across wrapping, poles, and filters', () => {
  let seed = 42;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const points = Array.from({length: 12000}, (_, i) => point((i - 6000) * 60000, random() * 360 - 180, random() * 180 - 90, i % 3 ? 20 : 500));
  points.push(point(8 * DAY, -180, -90), point(8 * DAY + 1, 180, 90));
  const query = createHistoryQuery(points);
  for (const viewport of [[13, 52, 14, 53], [178, -90, 182, 90], [-182, -90, -178, 90], [530, -90, 550, 90], [-720, -90, 720, 90], [-180, -90, 180, 90], [0, 89, 180, 90]]) {
    for (const accuracy of [0, 100]) for (const hourStart of [0, 8]) {
      const selected = points.filter(p => p.t >= -DAY && p.t <= 9 * DAY && (!accuracy || p.accuracy < accuracy) && new Date(p.t).getUTCHours() >= hourStart);
      const center = (viewport[0] + viewport[2]) / 2;
      const visible = selected.filter(p => { const lon = p.lon + 360 * Math.round((center - p.lon) / 360); return lon >= viewport[0] && lon <= viewport[2] && p.lat >= viewport[1] && p.lat <= viewport[3]; });
      const result = query({mode: 'points', viewport, accuracy, hourStart, start: -DAY, end: 9 * DAY});
      assert.equal(result.count, selected.length); assert.equal(result.visible, visible.length);
      assert.deepEqual(result.dots.features.map(f => f.geometry.coordinates), visible.map(p => [p.lon, p.lat]));
      assert.deepEqual(result.bounds, wrappedBounds(selected));
    }
  }
});

test('panning reuses selection statistics and route geometry; date and quality changes invalidate them', () => {
  const points = [point(0), point(60000, 13.401), point(DAY, 14), point(DAY + 60000, 14.001, 52.5, 500)];
  const query = createHistoryQuery(points);
  const first = query({mode: 'route'}), pan = query({mode: 'route', viewport: [13, 52, 15, 53]});
  assert.equal(first.routes, pan.routes); assert.equal(first.histogram, pan.histogram); assert.equal(first.bounds, pan.bounds);
  const day = query({mode: 'route', end: DAY - 1});
  assert.equal(day.count, 2); assert.notEqual(day.routes, first.routes); assert.equal(day.histogram, first.histogram);
  assert.equal(query({accuracy: 100}).count, 3);
  assert.equal(query({hourStart: 1}).count, 0);
  assert.equal(query().count, 4);
});

test('subpixel route simplification preserves both endpoints without allocating every coordinate', () => {
  const points = Array.from({length: 20001}, (_, i) => point(i * 1000, 13 + i / 1000000));
  const result = createHistoryQuery(points)({mode: 'route', end: 365 * DAY});
  const coordinates = result.routes.features[0].geometry.coordinates;
  assert.deepEqual(coordinates[0], [points[0].lon, points[0].lat]);
  assert.deepEqual(coordinates.at(-1), [points.at(-1).lon, points.at(-1).lat]);
  assert.ok(coordinates.length < 1000);
  assert.equal(result.density.features.length, 0);
});

test('journey colours follow timestamps rather than distance and stay fixed to the selected window', () => {
  const points = [point(0, 13), point(9000, 13.00001), point(10000, 13.0001)], query = createHistoryQuery(points);
  const result = query({mode: 'route', start: 0, end: 10000}), parts = result.routes.features;
  assert.ok(parts.length > 1 && parts.length <= 256);
  assert.deepEqual(parts[0].geometry.coordinates[0], [13, 52.5]);
  assert.deepEqual(parts.at(-1).geometry.coordinates.at(-1), [13.0001, 52.5]);
  const middle = parts.find(part => part.properties.time < 5000 && part.properties.time + 10000 / 512 >= 5000);
  assert.ok(Math.abs(middle.geometry.coordinates.at(-1)[0] - (13 + .00001 * 5000 / 9000)) < 1e-12);
  for (let i = 1; i < parts.length; i++) {
    assert.ok(parts[i].properties.time > parts[i - 1].properties.time);
    assert.deepEqual(parts[i].geometry.coordinates[0], parts[i - 1].geometry.coordinates.at(-1));
  }
  const pan = query({mode: 'route', start: 0, end: 10000, viewport: [12, 52, 14, 53]});
  assert.equal(pan.routes, result.routes);
  const wider = query({mode: 'route', start: 0, end: 20000}).routes.features;
  assert.ok(wider.length < parts.length);
  assert.ok(wider.at(-1).properties.time / 20000 < .51); // Last record is halfway through this window.
});

test('time-coloured routes retain simplification limits, exact endpoints and disconnected gaps', () => {
  const points = Array.from({length: 20001}, (_, i) => point(i * 1000, 13 + i / 1000000));
  points.push(point(2 * DAY, 15), point(2 * DAY + 60000, 15.001));
  const {routes} = createHistoryQuery(points)({mode: 'route', start: 0, end: 2 * DAY + 60000});
  const parts = routes.features, all = parts.flatMap(part => part.geometry.coordinates);
  assert.ok(parts.length <= 2 + 255);
  assert.ok(all.length <= 6668 + 2 + 2 * 255);
  assert.deepEqual(all[0], [points[0].lon, points[0].lat]);
  assert.deepEqual(all.at(-1), [points.at(-1).lon, points.at(-1).lat]);
  assert.ok(parts.every(part => part.geometry.coordinates.every(([lon]) => lon < 14) || part.geometry.coordinates.every(([lon]) => lon >= 15)));
});

test('speed estimates reject gaps and impossible travel but ignore GPS accuracy', () => {
  const a = point(0, 0, 0, 5), b = point(60000, .001, 0, 5);
  assert.ok(Math.abs(intervalSpeed(a, b) - 6.6717) < .001);
  assert.equal(intervalSpeed(a, {...b, t: 0}), null);
  assert.equal(intervalSpeed(a, {...b, t: 15 * 60000 + 1}), null);
  assert.ok(intervalSpeed(a, {...b, t: 15 * 60000}) > 0);
  assert.equal(intervalSpeed(a, {...b, accuracy: 1799}), intervalSpeed(a, b));
  assert.ok(intervalSpeed(a, {...b, lon: .00001}) > 0);
  assert.equal(intervalSpeed(a, {...b, lon: 2}), null);
  assert.equal(intervalSpeed(a, {...a, t: 60000}), 0);
  assert.ok(intervalSpeed({...a, accuracy: null}, {...b, accuracy: null}) > 0);
});

test('point speed is weighted by time and remains stable across display filters', () => {
  const points = [point(0, 0, 0, 0), point(60000, .0015, 0, 20), point(180000, .0075, 0, 0)];
  const query = createHistoryQuery(points), dots = query({mode: 'points'}).dots.features;
  const incoming = intervalSpeed(points[0], points[1]), outgoing = intervalSpeed(points[1], points[2]);
  assert.ok(Math.abs(dots[0].properties.speed - incoming) < 1e-4);
  assert.ok(Math.abs(dots[1].properties.speed - (incoming + outgoing * 2) / 3) < 1e-4);
  assert.ok(Math.abs(dots[2].properties.speed - outgoing) < 1e-4);
  const filtered = query({mode: 'points', accuracy: 10}).dots.features;
  assert.equal(filtered.length, 2); assert.equal(filtered[0].properties.speed, dots[0].properties.speed); assert.equal(filtered[1].properties.speed, dots[2].properties.speed);
  assert.equal(query({mode: 'points', start: 60000, end: 60000}).dots.features[0].properties.speed, dots[1].properties.speed);
  const gap = createHistoryQuery([point(0), point(DAY)])({mode: 'points'});
  assert.ok(gap.dots.features.every(dot => dot.properties.speed === null));
});

test('speed paths use interval averages, preserve endpoints, cache pans and rebuild when colour mode changes', () => {
  const points = [point(0, 0, 0), point(60000, .0015, 0), point(180000, .0075, 0)], query = createHistoryQuery(points);
  const time = query({mode: 'route'}).routes;
  const speed = query({mode: 'route', colorBy: 'speed'}).routes;
  assert.equal(speed.features.length, 2);
  assert.ok(Math.abs(speed.features[0].properties.speed - intervalSpeed(points[0], points[1])) < 1e-4);
  assert.ok(Math.abs(speed.features[1].properties.speed - intervalSpeed(points[1], points[2])) < 1e-4);
  assert.deepEqual(speed.features[0].geometry.coordinates[0], [0, 0]);
  assert.deepEqual(speed.features.at(-1).geometry.coordinates.at(-1), [.0075, 0]);
  assert.equal(query({mode: 'route', colorBy: 'speed', viewport: [-1, -1, 1, 1]}).routes, speed);
  assert.deepEqual(query({mode: 'route'}).routes, time);
  const poor = createHistoryQuery(points.map(p => ({...p, accuracy: 1799})))({mode: 'route', colorBy: 'speed'});
  assert.ok(poor.routes.features.every(part => part.properties.speed > 0));
});

test('large speed paths remain bounded and do not allocate a feature for every record', () => {
  const points = Array.from({length: 100001}, (_, i) => point(i * 60000, 13 + i * .000001));
  const {routes} = createHistoryQuery(points)({mode: 'route', colorBy: 'speed'});
  assert.ok(routes.features.length <= 20000);
  assert.deepEqual(routes.features[0].geometry.coordinates[0], [points[0].lon, points[0].lat]);
  assert.deepEqual(routes.features.at(-1).geometry.coordinates.at(-1), [points.at(-1).lon, points.at(-1).lat]);
  assert.ok(routes.features.every(part => part.properties.speed > 0));
});

test('date range queries preserve inclusive fractional timestamp boundaries', () => {
  assert.equal(queryHistory([point(.1), point(.5), point(.9)], {start: .1, end: .5}).count, 2);
});

test('GeoJSON preserves altitude and Android device speed with explicit unit handling', () => {
  const points = parseHistory({type: 'FeatureCollection', features: [
    {geometry: {type: 'Point', coordinates: [13, 52, -12]}, properties: {time: 0}},
    {geometry: {type: 'Point', coordinates: [13, 52, 123]}, properties: {time: 5000, altitude: 0, provider: 'gps', time_long: 5000, speed: 1.5, accuracy: 1799}},
    {geometry: {type: 'Point', coordinates: [13, 52]}, properties: {time: 10000, speed: 100}},
    {geometry: {type: 'Point', coordinates: [13, 52]}, properties: {time: 15000, altitude: 'bad', speedMetersPerSecond: 0}},
  ]}).points;
  assert.equal(points[0].altitude, -12); assert.equal(points[1].altitude, 0);
  assert.equal(points[1].recordedSpeed, 5.4); assert.equal(points[2].recordedSpeed, undefined);
  assert.equal(points[3].altitude, undefined); assert.equal(points[3].recordedSpeed, 0);
  const result = createHistoryQuery(preparePoints(points).points)({mode: 'points'});
  assert.deepEqual(result.altitudeRange, [-12, 0]);
  assert.ok(Math.abs(result.dots.features[1].properties.speed - 5.4) < 1e-5);
  assert.equal(result.dots.features[1].properties.speedRecorded, true);
});

test('altitude paths and their range follow the selection, not the viewport, including zero and missing heights', () => {
  const points = [{...point(0), altitude: -10}, {...point(60000, 13.401), altitude: 0}, point(120000, 13.402), {...point(180000, 13.403), altitude: 50}];
  const query = createHistoryQuery(points), result = query({mode: 'route', colorBy: 'altitude'});
  assert.deepEqual(result.altitudeRange, [-10, 50]);
  assert.equal(result.routes.features[0].properties.altitude, -5);
  assert.equal(result.routes.features[1].properties.altitude, null);
  const pan = query({mode: 'route', colorBy: 'altitude', viewport: [13, 52, 14, 53]});
  assert.deepEqual(pan.altitudeRange, result.altitudeRange); assert.equal(pan.routes, result.routes);
  assert.deepEqual(query({mode: 'points', start: 60000, end: 120000}).altitudeRange, [0, 0]);
});

test('accuracy exclusions connect retained paths without bridging jump exclusions', () => {
  const points = [point(-60000, 0, 0), point(0, .001, 0), point(60000, 80, 0), point(120000, .002, 0), point(180000, .003, 0), point(240000, .004, 0)];
  const query = createHistoryQuery(points);
  for (const colorBy of ['time', 'speed', 'altitude']) {
    const result = query({mode: 'route', colorBy, accuracy: 50, excludeJumps: true});
    assert.equal(result.count, 5); // Only the isolated spike is removed.
    assert.ok(result.routes.features.every(part => part.geometry.coordinates.every(([lon]) => lon <= .001) || part.geometry.coordinates.every(([lon]) => lon >= .002)));
  }
});

test('accuracy limits are strict for all five thresholds and retain unknown metadata', () => {
  const values = [null, 0, 9, 10, 49, 50, 99, 100, 499, 500, 999, 1000];
  const query = createHistoryQuery(values.map((accuracy, i) => point(i * 60_000, 13, 52, accuracy)));
  for (const [accuracy, count] of [[0, 12], [10, 3], [50, 5], [100, 7], [500, 9], [1000, 11]]) {
    assert.equal(query({accuracy}).count, count);
  }
});
