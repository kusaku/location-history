import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHistory, preparePoints, createHistoryQuery, pointSpeed, jumpFlags, DAY} from '../js/data.mjs';
import {createDeviceIndex} from '../js/motion.mjs';
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

test('device index stays allocation-free for a single device and outlier detection never compares devices or providers', () => {
  assert.equal(createDeviceIndex([point(0), point(1)]).order, null);
  const mixed = Array.from({length: 50}, (_, i) => [point(i * 10000, i, 'a', 1), point(i * 10000 + 10, 13000 + i, 'b', 1), point(i * 10000 + 20, 30000 + i, 'a', 3)]).flat();
  assert.ok(jumpFlags(mixed).every(v => !v));
  const index = createDeviceIndex(mixed);
  assert.equal(index.order.byteLength + index.positions.byteLength, 8 * mixed.length);
  assert.equal(index.neighbor(0, 1), 2); assert.equal(index.neighbor(1, 1), 4);
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

test('GPS drift keeps real walking, driving and flights without averaging their speeds', () => {
  for (const kmh of [1, 5, 60, 900]) {
    const points = Array.from({length: 100}, (_, i) => [point(i * 5000, i * 5 * kmh / 3.6, '', 1), point(i * 5000 + 10, i * 5 * kmh / 3.6 + 500, '', 4)]).flat();
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
    assert.equal(route.count, points.length); assert.deepEqual(route.routes, original.routes);
    assert.equal(query({...options, speedUnknown: false}).count, points.length);
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
  const snapshot = structuredClone(points), ordinary = jumpFlags(points), flags = jumpFlags(points, {stationaryWindow: 120});
  assert.equal(ordinary.reduce((n, v) => n + v, 0), 0);
  assert.deepEqual([...flags.entries()].filter(([, flag]) => flag).map(([i]) => i), [50, 51]);
  const query = createHistoryQuery(points), options = {trackMode: 'drift', driftWindow: 120};
  const result = query({...options, mode: 'points'});
  assert.equal(result.count, 98); assert.equal(query.place(box, options).count, 98);
  assert.ok(result.dots.features.every(f => f.properties.index !== 50 && f.properties.index !== 51));
  assert.ok(result.dots.features.every(f => f.properties.speed < 2));
  assert.equal(query({...options, driftWindow: 15}).count, 100);
  assert.equal(query(options).count, 98);
  assert.deepEqual(points, snapshot);
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
});

test('stationary drift needs two-sided context and does not erase slow real excursions or a second device', () => {
  const walk = Array.from({length: 20}, (_, i) => point(i * 60000, i === 10 ? 60 : 0));
  assert.ok(jumpFlags(walk, {stationaryWindow: 600}).every(v => !v));
  const mixed = Array.from({length: 100}, (_, i) => [point(i * 10000, 0, 'a'), point(i * 10000 + 1, 300, 'b')]).flat();
  assert.equal(createHistoryQuery(mixed)({trackMode: 'drift', driftWindow: 600}).count, mixed.length);
  const sparse = [point(0), point(DAY, 300), point(2 * DAY)];
  assert.ok(jumpFlags(sparse, {stationaryWindow: 600}).every(v => !v));
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
  assert.equal(saveSettings({excludeJumps: true}, ['dark'], storage).trackMode, 'outliers');
  saveSettings({trackMode: 'drift', driftWindow: 90, device: 1}, ['dark'], storage);
  const restored = loadSettings(['dark'], storage);
  assert.equal(restored.trackMode, 'drift'); assert.equal(restored.driftWindow, 90); assert.equal(restored.excludeJumps, true);
  assert.equal(restored.device, undefined);
  assert.equal(saveSettings({trackMode: 'off', excludeJumps: true, driftWindow: 0}, ['dark'], storage).excludeJumps, false);
});
