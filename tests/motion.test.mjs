import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHistory, preparePoints, createHistoryQuery, pointSpeed, outlierFlags, DAY} from '../js/data.mjs';
import {createDeviceIndex} from '../js/devices.mjs';
import {readHistory} from '../js/import.mjs';
import {encodeHistory} from '../scripts/create-sample.mjs';
import {loadSettings, saveSettings} from '../js/settings.mjs';

const point = (t, metres = 0, device = '', source = 0, accuracy = 5) => ({t, lon: metres / 111195, lat: 0, accuracy, duration: 0, ...(device || source ? {stream: {device, source}} : {})});
const box = {geometry: {coordinates: [[[-.01, -.01], [.01, -.01], [.01, .01], [-.01, .01], [-.01, -.01]]]}};
const records = values => ({locations: values.map(([t, deviceTag, source = 'GPS']) => ({timestampMs: t, deviceTag, source, latitudeE7: 0, longitudeE7: 0}))});

test('streaming batches and files intern device/source metadata without retaining source records', async () => {
  const streams = new Map(), points = [];
  for (let file = 0; file < 2; file++) await readHistory(new Blob([JSON.stringify(records(Array.from({length: 1100}, (_, i) => [i, 'private-device', 'WIFI'])))]), batch => points.push(...batch), () => {}, {streams});
  assert.equal(points.length, 2200);
  assert.ok(points.every(p => p.stream === points[0].stream));
  assert.deepEqual(points[0].stream, {device: 'google:private-device', source: 2});
  const bad = parseHistory(records([[0, {}], [1, 'x'.repeat(129)], [2, null]]));
  assert.ok(bad.points.every(p => p.stream.device === ''));
  const geo = parseHistory({type: 'FeatureCollection', features: [{geometry: {type: 'Point', coordinates: [0, 0]}, properties: {time: 0, deviceId: 'phone', provider: 'network'}}]}).points[0];
  assert.deepEqual(geo.stream, {device: 'id:phone', source: 4});
});

test('exact deduplication merges overlapping files but preserves distinct devices and raw source priority', () => {
  const points = parseHistory(records([[0, 'a', 'CELL'], [0, 'b'], [0, 'a', 'GPS'], [1000, 'a']])).points;
  const result = preparePoints(points, {inferStationary: false});
  assert.equal(result.duplicates, 1); assert.equal(points.length, 3);
  assert.equal(new Set(points.filter(p => !p.t).map(p => p.stream.device)).size, 2);
  const event = point(0, 0, '', -1), path = point(0, 0, '', 6), raw = point(0);
  assert.equal(preparePoints([event, path, raw]).points[0].stream, undefined);
});

test('sample stream columns are deterministic and anonymize device IDs without losing group membership', async () => {
  const input = () => parseHistory(records([[0, 'private-a'], [1000, 'private-b', 'WIFI'], [2000, 'private-a']])).points;
  const a = encodeHistory(input()).encoded, b = encodeHistory(input()).encoded;
  assert.deepEqual(a, b); assert.ok(!JSON.stringify(a).includes('private-'));
  const decoded = parseHistory(a).points, streamed = [];
  await readHistory(new Blob([JSON.stringify(a)]), batch => streamed.push(...batch));
  assert.deepEqual(streamed, decoded);
  assert.equal(decoded[0].stream, decoded[2].stream);
  assert.notEqual(decoded[0].stream.device, decoded[1].stream.device);
  for (const changes of [{stream: [1]}, {stream: [0, -1, 1]}, {streams: [{device: {}, source: 1}]}, {streams: [{device: 'a', source: 7}]}, {stream: [99, 1, 1]}]) {
    assert.throws(() => parseHistory({...a, ...changes}), /Invalid delta/);
    await assert.rejects(readHistory(new Blob([JSON.stringify({...a, ...changes})]), () => {}), /Invalid delta/);
  }
});

test('speed ignores semantic event boundaries and estimates each provider and device independently', () => {
  const points = [point(0, 0, 'a', 6), point(4008000, 0, 'a', -1), point(4020000, 545, 'a', 6), point(4740000, 0, 'a', 6)];
  assert.equal(pointSpeed(points, 1), null);
  const mixed = [point(0, 0, 'a', 1), point(10, 10000, 'b', 1), point(20, 5000, 'a', 4), point(60000, 100, 'a', 1), point(60010, 10100, 'b', 1), point(60020, 5100, 'a', 4)];
  const devices = createDeviceIndex(mixed);
  for (let i = 0; i < mixed.length; i++) assert.ok(Math.abs(pointSpeed(mixed, i, null, devices) - 6) < .001);
});

test('journey speed stays known when one device alternates recording sources', () => {
  const points = Array.from({length: 8}, (_, i) => point(i * 10000, i * 10, 'a', i % 2 ? 2 : 1));
  const query = createHistoryQuery(points);
  for (const options of [{}, {trackMode: 'drift', driftWindow: 60}, {accuracy: 10}, {source: 1}]) {
    const dots = query({...options, mode: 'points'}).dots.features;
    const routes = query({...options, mode: 'route', colorBy: 'speed'}).routes.features;
    assert.ok(dots.every(f => Math.abs(f.properties.speed - 3.6) < .001));
    assert.ok(routes.length > 0 && routes.every(f => Math.abs(f.properties.speed - 3.6) < .001));
  }
});

test('journey speed uses recorded endpoints across source changes but does not fill unknowns or long gaps', () => {
  const points = [point(0, 0, 'a', 1), point(10000, 10, 'a', 2)];
  const speeds = input => createHistoryQuery(input)({mode: 'route', colorBy: 'speed'}).routes.features.map(f => f.properties.speed);
  assert.deepEqual(speeds(points), [null]);
  assert.deepEqual(speeds(points.map((p, i) => ({...p, recordedSpeed: i ? 15 : 5}))), [10]);
  assert.deepEqual(speeds(points.map((p, i) => ({...p, ...(i ? {recordedSpeed: 15} : {})}))), [null]);
  assert.deepEqual(speeds(points.map((p, i) => ({...p, t: i * 3600000, recordedSpeed: 5}))), [null]);
  const stops = createHistoryQuery([0, 3000, 6000, 3600000, 3603000, 3606000].map(t => point(t, t < 3600000 ? 0 : 1, 'a', 1)));
  const options = {trackMode: 'drift', driftWindow: 60};
  assert.ok(stops({...options, mode: 'points'}).dots.features.every(f => f.properties.speed === 0));
  assert.deepEqual(stops({...options, mode: 'route', colorBy: 'speed'}).routes.features.map(f => f.properties.speed), [null]);
});

test('device index stays allocation-free for a single device and outlier detection keeps devices separate across sources', () => {
  assert.equal(createDeviceIndex([point(0), point(1)]).order, null);
  const mixed = Array.from({length: 50}, (_, i) => [point(i * 10000, i, 'a', 1), point(i * 10000 + 10, 13000 + i, 'b', 1), point(i * 10000 + 20, 1 + i, 'a', 3)]).flat();
  assert.ok(outlierFlags(mixed).every(v => !v));
  const index = createDeviceIndex(mixed);
  assert.equal(index.order.byteLength + index.positions.byteLength, 8 * mixed.length);
  assert.equal(index.neighbor(0, 1), 2); assert.equal(index.neighbor(1, 1), 4);
});

test('precise moving GPS context excludes a lateral Network outlier before source and date filters', () => {
  const points = Array.from({length: 15}, (_, i) => point(i * 5000, i * 125, 'a', i === 7 ? 4 : 1, i === 7 ? 300 : 12));
  points[7].lat = 700 / 111195;
  points.push(point(355000, 4080, 'a', 4, 300));
  const original = structuredClone(points), query = createHistoryQuery(points);
  const area = {geometry: {coordinates: [[[-.1, -.1], [.1, -.1], [.1, .1], [-.1, .1], [-.1, -.1]]]}};
  assert.ok(query.point(7).feature.properties.speed > 36 && query.point(7).feature.properties.speed < 38);
  assert.deepEqual([...outlierFlags(points)], points.map((_, i) => i === 7 ? 1 : 0));
  for (const trackMode of ['outliers', 'drift']) {
    assert.equal(query({trackMode}).count, points.length - 1);
    assert.equal(query.point(7, {trackMode, source: 4}), null);
    assert.equal(query({trackMode, source: 4}).count, 1);
    assert.equal(query({trackMode, start: points[7].t, end: points[7].t}).count, 0);
    assert.equal(query.place(area, {trackMode}).count, points.length - 1);
    assert.ok(query.point(6, {trackMode})); assert.ok(query.point(8, {trackMode}));
  }
  assert.equal(query({trackMode: 'off'}).count, points.length);
  assert.deepEqual(points, original);
  const differentDevice = points.map((p, i) => i === 7 ? {...p, stream: {...p.stream, device: 'b'}} : p);
  assert.equal(outlierFlags(differentDevice)[7], 0);
});

test('a coarse-source majority cannot discard a much more precise GPS fix', () => {
  const points = Array.from({length: 21}, (_, i) => point(i * 1000, i === 10 ? 700 : 0, 'a', i === 10 ? 1 : 4, i === 10 ? 5 : 300));
  const flags = outlierFlags(points);
  assert.equal(flags[10], 0);
  // Claimed precision cannot excuse a physically impossible excursion.
  const impossible = points.map((p, i) => i === 10 ? {...p, lon: 30000 / 111195} : p);
  assert.equal(outlierFlags(impossible)[10], 1);
  // A persistent source handover is movement, not an isolated excursion.
  const handover = Array.from({length: 30}, (_, i) => point(i * 5000, i * 125, 'a', i < 15 ? 4 : 1, i < 15 ? 300 : 5));
  assert.ok(outlierFlags(handover).every(flag => !flag));
  const staleHandover = [...Array.from({length: 10}, (_, i) => point(i * 5000, i * 125, 'a', 1, 10)), ...Array.from({length: 10}, (_, i) => point(52000 + i * 5000, 500, 'a', 5, 15))];
  assert.equal(outlierFlags(staleHandover)[9], 0);
  // A stale second source must not erase either endpoint of a coherent GPS path.
  const precise = Array.from({length: 15}, (_, i) => point(i * 15000, i * 30, 'a', 1, 10));
  precise.splice(8, 0, point(105500, 462, 'a', 2, 20));
  const retained = outlierFlags(precise);
  assert.equal(retained[7], 0); assert.equal(retained[9], 0);
});

test('a coarse fix between GPS fixes is an outlier only beyond its own stated accuracy', () => {
  const flagged = (accuracy, offset, longitude = 0) => {
    const points = Array.from({length: 21}, (_, i) => point(i * 5000, i * 70, 'a', 1, 10));
    points.splice(11, 0, {...point(52500, 735, 'a', 2, accuracy), lat: offset / 111195});
    for (const p of points) p.lon = ((p.lon + longitude + 180) % 360 + 360) % 360 - 180;
    return outlierFlags(points)[11];
  };
  for (const longitude of [0, 179.9934]) {
    // No cliff at a fixed precision ratio, including a track across the dateline.
    assert.equal(flagged(30, 500, longitude), 1); assert.equal(flagged(31, 500, longitude), 1);
    // Consistent with its own stated accuracy, so it is not an outlier.
    assert.equal(flagged(300, 200, longitude), 0); assert.equal(flagged(40, 30, longitude), 0);
  }
});

test('GPS drift uses its whole context window for dense recordings', () => {
  const jitter = i => [Math.cos(i * 1.3) * 7, Math.sin(i * 2.1) * 7];
  const track = kmh => Array.from({length: 181}, (_, i) => { const [x, y] = jitter(i); return {...point(i * 1000, i * kmh / 3.6 + x, '', 1, 10), lat: y / 111195}; });
  const speeds = (points, driftWindow) => createHistoryQuery(points)({mode: 'points', trackMode: 'drift', driftWindow}).dots.features.slice(30, -30).map(f => f.properties.speed);
  // Walking is not stationary once the window spans more than the GPS noise.
  assert.ok(speeds(track(4.5), 15).some(speed => speed === 0));
  assert.ok(speeds(track(4.5), 60).every(speed => speed > 0));
  assert.ok(speeds(track(0), 60).every(speed => speed === 0));
});

test('GPS drift does not depend on the hidden Outliers allowance', () => {
  const points = Array.from({length: 15}, (_, i) => point(i * 60_000, i === 7 ? 1000 : 0));
  const query = createHistoryQuery(points), spike = {start: points[7].t, end: points[7].t, trackMode: 'drift', driftWindow: 60};
  assert.equal(query({...spike, outlierTolerance: 100}).count, 0);
  assert.equal(query({...spike, outlierTolerance: 100}).count, query({...spike, outlierTolerance: 0}).count);
  assert.equal(query({...spike, trackMode: 'outliers', outlierTolerance: 100}).count, 1);
});

test('map statistics, routes, point navigation and place filters share the selected device', () => {
  const points = Array.from({length: 11}, (_, i) => [point(i * 60000, i * 10, 'a'), point(i * 60000 + 1, 13000 + i * 10, 'b')]).flat();
  const query = createHistoryQuery(points), all = query({mode: 'route'});
  assert.equal(query.devices.length, 2); assert.equal(all.count, 22); assert.equal(all.days, 1);
  assert.ok(Math.abs(all.km - .2) < .001);
  for (const feature of all.routes.features) {
    const xs = feature.geometry.coordinates.map(p => p[0]);
    assert.ok(Math.max(...xs) - Math.min(...xs) < .002);
  }
  const a = query({mode: 'points', device: 0});
  assert.equal(a.count, 11); assert.equal(a.histogram.reduce((n, v) => n + v), 11);
  assert.ok(Math.abs(a.km - .1) < .001); assert.equal(a.dots.features[0].properties.device, 'Device 1');
  assert.equal(query.point(0, {device: 0}).next, 2); assert.equal(query.point(1, {device: 0}), null);
  assert.equal(query.place(box, {device: 0}).count, 11); assert.equal(query.place(box, {device: 1}).count, 0);
});

test('stationary inference and place intervals stay within a device and overlapping time is counted once', () => {
  const points = [point(0, 0, 'a'), point(60000, 5000, 'b'), point(120000, 0, 'a')];
  preparePoints(points); assert.equal(points[0].duration, 120000);
  assert.equal(createHistoryQuery(points).place(box).minutes, 2);
  const a = point(0, 0, 'a'), b = point(60000, 0, 'b'), exit = point(120000, 5000, 'b');
  a.duration = DAY; b.duration = DAY;
  const query = createHistoryQuery([a, b, exit]);
  assert.equal(query.place(box).minutes, 1440);
  assert.equal(query.place(box, {device: 1}).minutes, 1);
  assert.equal(query.place(box, {start: DAY / 2, end: DAY - 1, hourly: true}).minutes, 720);
});

test('source choices count imported observations and consistently filter maps, navigation and place history', () => {
  const points = [point(0, 0, 'a', 1), point(1000, 5000, 'a', 2), point(60000, 100, 'a', 1), point(61000, 5100, 'b', 2), point(120000, 200, 'a'), point(180000, 300, 'a', -1)];
  const query = createHistoryQuery(points), snapshot = structuredClone(points);
  assert.deepEqual(query.sources, [{id: -1, label: 'Timeline event', count: 1}, {id: 0, label: 'Recorded position', count: 1}, {id: 1, label: 'GPS', count: 2}, {id: 2, label: 'Wi-Fi', count: 2}]);
  for (const mode of ['heat', 'hex', 'points', 'route']) {
    const result = query({mode, source: 1, zoom: 18});
    assert.equal(result.count, 2); assert.equal(result.histogram.reduce((a, b) => a + b, 0), 2);
    if (mode === 'route') {
      assert.ok(result.routes.features.length > 0);
      assert.deepEqual(result.routes.features[0].geometry.coordinates[0], [points[0].lon, 0]);
      assert.deepEqual(result.routes.features.at(-1).geometry.coordinates.at(-1), [points[2].lon, 0]);
    }
  }
  assert.equal(query({source: 0}).count, 1); assert.equal(query({source: -1}).count, 1);
  assert.equal(query({source: 2, device: 0}).count, 1); assert.equal(query({source: 1, device: 1}).count, 0);
  assert.equal(query.point(0, {source: 1}).next, 2); assert.equal(query.point(1, {source: 1}), null);
  assert.equal(query.place(box, {source: 1}).count, 2);
  assert.equal(query({source: null}).count, points.length); assert.equal(query({source: 6}).count, 0);
  assert.deepEqual(createHistoryQuery([point(0)]).sources, [{id: 0, label: 'Recorded position', count: 1}]);
  assert.deepEqual(createHistoryQuery([]).sources, []); assert.deepEqual(points, snapshot);
});

test('GPS drift keeps real walking, driving and flights without averaging their speeds', () => {
  for (const kmh of [1, 5, 60, 900]) {
    const points = Array.from({length: 100}, (_, i) => [point(i * 5000, i * 5 * kmh / 3.6, '', 1), point(i * 5000 + 10, (i * 5 + .01) * kmh / 3.6, '', 4)]).flat();
    const query = createHistoryQuery(points), off = query({mode: 'points'});
    for (const driftWindow of [15, 60, 600]) {
      const result = query({mode: 'points', trackMode: 'drift', driftWindow});
      assert.equal(result.count, points.length);
      assert.deepEqual(result.dots, off.dots);
    }
  }
});

test('stationary jitter and sparse night records remain visible, with journeys independent of speed availability', () => {
  const points = Array.from({length: 100}, (_, i) => point(i * 60000, Math.sin(i * 2) * 8));
  const snapshot = structuredClone(points), query = createHistoryQuery(points), original = query({mode: 'route', colorBy: 'speed'});
  for (const driftWindow of [15, 60, 120, 300, 600]) {
    const options = {trackMode: 'drift', driftWindow};
    const route = query({...options, mode: 'route', colorBy: 'speed'});
    assert.equal(route.count, points.length); assert.deepEqual(route.routes.features.map(f => f.geometry), original.routes.features.map(f => f.geometry));
    assert.ok(route.routes.features.every(f => f.properties.speed === null || f.properties.speed < 6));
    assert.ok(query({...options, speedUnknown: false}).count >= points.length - 2);
    assert.equal(query.place(box, options).count, points.length);
  }
  const unknown = createHistoryQuery(points.map(p => ({...p, stream: {device: '', source: -1}})));
  const result = unknown({mode: 'route', colorBy: 'speed', trackMode: 'drift'});
  assert.ok(result.routes.features.length > 0);
  assert.ok(result.routes.features.every(f => f.properties.speed === null));
  assert.deepEqual(points, snapshot);
});

test('GPS drift excludes a brief distant burst among stationary neighbours without removing the cluster', () => {
  const points = Array.from({length: 100}, (_, i) => point(i * 10000, i === 50 || i === 51 ? 300 : Math.sin(i) * 2));
  const snapshot = structuredClone(points), ordinary = outlierFlags(points), flags = outlierFlags(points, {stationaryWindow: 120});
  assert.equal(ordinary.reduce((n, v) => n + v, 0), 0);
  assert.deepEqual([...flags.entries()].filter(([, flag]) => flag).map(([i]) => i), [50, 51]);
  const query = createHistoryQuery(points), options = {trackMode: 'drift', driftWindow: 120};
  const result = query({...options, mode: 'points'});
  assert.equal(result.count, 98); assert.equal(query.place(box, options).count, 98);
  assert.equal(result.qualityExcluded, 2);
  assert.ok(result.dots.features.every(f => f.properties.index !== 50 && f.properties.index !== 51));
  assert.ok(result.dots.features.every(f => f.properties.speed < 2));
  assert.equal(query({...options, driftWindow: 15}).count, 100);
  assert.equal(query(options).count, 98);
  assert.deepEqual(points, snapshot);
});

test('GPS drift distinguishes compact chaotic noise, insufficient evidence and resolvable local movement', () => {
  const points = Array.from({length: 41}, (_, i) => point(i * 1000, Math.sin(i * 2) * 8, '', 1, 20));
  const original = structuredClone(points), query = createHistoryQuery(points), options = {trackMode: 'drift', driftWindow: 167};
  const result = query({...options, mode: 'points'});
  assert.equal(result.count, points.length); assert.equal(result.qualityExcluded, 0);
  assert.ok(result.motionClassified > 30); assert.ok(result.dots.features.some(f => f.properties.speed === 0));
  assert.ok(result.dots.features.every(f => f.properties.speed === null || f.properties.speed === 0));
  const fast = query({...options, speedMin: 13.8, speedUnknown: false});
  assert.equal(fast.count, 0); assert.equal(fast.motionClassified, result.motionClassified);
  assert.equal(query({...options, mode: 'route', colorBy: 'speed'}).routes.features.every(f => f.properties.speed === null || f.properties.speed === 0), true);
  assert.equal(query({...options, mode: 'route'}).km, 0);
  const pair = createHistoryQuery([point(0, 0, '', 1, 20), point(800, 10, '', 1, 20)]);
  assert.equal(pair.point(0, options).feature.properties.speed, null);
  assert.ok(pair.point(0, {trackMode: 'off'}).feature.properties.speed > 40);
  // Fix acquisition can converge in one direction without sustained travel.
  const convergence = createHistoryQuery([[0, 0], [754, 11.7], [3535, 12.3], [8653, 12.4]].map(([t, x]) => point(t, x, '', 2, 20)));
  assert.ok(convergence({mode: 'points', ...options}).dots.features.every(f => f.properties.speed === 0));
  assert.deepEqual(points, original);
});

test('GPS drift is independent of time of day, hour filtering, location and other display filters', () => {
  const points = Array.from({length: 41}, (_, i) => point(i * 1000, Math.sin(i * 2) * 8, '', 2, 20));
  const options = {trackMode: 'drift', driftWindow: 167, mode: 'points'};
  const query = createHistoryQuery(points), base = query(options).dots.features.map(f => f.properties.speed);
  assert.deepEqual(query({...options, hourStart: 0, hourEnd: 1, accuracy: 50, source: 2}).dots.features.map(f => f.properties.speed), base);
  const shifted = points.map(p => ({...p, t: p.t + 7 * DAY + 13 * 3600000, lon: p.lon + 30}));
  assert.deepEqual(createHistoryQuery(shifted)(options).dots.features.map(f => f.properties.speed), base);
  assert.ok(base.some(speed => speed === 0));
});

test('sparse asymmetric stationary context catches short excursions without removing a sustained move', () => {
  const points = [-70000, -45000, -22000, 0, 22000].map(t => point(t, t === 0 ? 355 : 0, '', 3, 1900));
  assert.ok(outlierFlags(points).every(v => !v));
  const flags = outlierFlags(points, {stationaryWindow: 60});
  assert.deepEqual([...flags], [0, 0, 0, 1, 0]);
  const sustained = Array.from({length: 20}, (_, i) => point(i * 10000, i < 5 ? 0 : 300, '', 3, 1900));
  assert.ok(outlierFlags(sustained, {stationaryWindow: 600}).every(v => !v));
});

test('curved cycling paths and device speed do not change with the GPS drift context window', () => {
  const points = Array.from({length: 150}, (_, i) => ({...point(i * 5000, 50 * Math.cos(i * .3)), lat: 50 * Math.sin(i * .3) / 111195}));
  const query = createHistoryQuery(points), raw = query({mode: 'points'});
  for (const driftWindow of [60, 300, 600]) {
    const result = query({mode: 'points', trackMode: 'drift', driftWindow});
    assert.deepEqual(result.dots, raw.dots); assert.equal(result.km, raw.km);
  }
  const recorded = createHistoryQuery(points.map(p => ({...p, recordedSpeed: 25})))({mode: 'points', trackMode: 'drift', driftWindow: 600});
  assert.ok(recorded.dots.features.every(f => f.properties.speed === 25 && f.properties.speedRecorded));
  // Dense, directed travel can fit entirely inside its reported GPS uncertainty.
  for (const speed of [1, 5, 10, 20, 60]) {
    const path = Array.from({length: 41}, (_, i) => point(i * 1000, i * speed / 3.6, '', 1, 50));
    const q = createHistoryQuery(path), normal = q({mode: 'points'});
    assert.deepEqual(q({mode: 'points', trackMode: 'drift', driftWindow: 167}).dots, normal.dots);
  }
});

test('stationary drift needs two-sided context and does not erase slow real excursions or a second device', () => {
  const walk = Array.from({length: 20}, (_, i) => point(i * 60000, i === 10 ? 60 : 0));
  assert.ok(outlierFlags(walk, {stationaryWindow: 600}).every(v => !v));
  const mixed = Array.from({length: 100}, (_, i) => [point(i * 10000, 0, 'a'), point(i * 10000 + 1, 300, 'b')]).flat();
  assert.equal(createHistoryQuery(mixed)({trackMode: 'drift', driftWindow: 600}).count, mixed.length);
  const sparse = [point(0), point(DAY, 300), point(2 * DAY)];
  assert.ok(outlierFlags(sparse, {stationaryWindow: 600}).every(v => !v));
});

test('stationary GPS filtering wraps the dateline and caches repeated display queries', () => {
  const points = Array.from({length: 100}, (_, i) => ({...point(i * 10000, i === 50 || i === 51 ? 300 : Math.sin(i) * 2), lon: ((179.999 + (i === 50 || i === 51 ? 300 : Math.sin(i) * 2) / 111195 + 180) % 360) - 180}));
  const query = createHistoryQuery(points), options = {mode: 'route', trackMode: 'drift', driftWindow: 120, viewport: [179.99, -.01, 180.01, .01]};
  const first = query(options);
  assert.equal(first.count, 98); assert.ok(first.routes.features.length > 0);
  assert.equal(query(options).routes, first.routes);
  assert.equal(query({...options, mode: 'points'}).count, first.count);
});

test('motion preferences migrate old quality toggles and omit dataset-specific device choice', () => {
  let value; const storage = {getItem: () => value, setItem: (_, v) => { value = v; }};
  assert.equal(saveSettings({excludeOutliers: true}, ['dark'], storage).trackMode, 'outliers');
  saveSettings({trackMode: 'drift', driftWindow: 90, device: 1}, ['dark'], storage);
  const restored = loadSettings(['dark'], storage);
  assert.equal(restored.trackMode, 'drift'); assert.equal(restored.driftWindow, 90); assert.equal(restored.excludeOutliers, true);
  assert.equal(restored.device, undefined);
  assert.equal(saveSettings({trackMode: 'off', excludeOutliers: true, driftWindow: 0}, ['dark'], storage).excludeOutliers, false);
});
