import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {gzipSync} from 'node:zlib';

// Adapt browser worker messaging to Node without replacing the production worker code.
const url = new URL('../js/worker.mjs', import.meta.url).href;
async function startWorker() {
  const worker = new Worker(`
    const {parentPort} = require('node:worker_threads');
    self = {postMessage: message => parentPort.postMessage(message)};
    import(${JSON.stringify(url)}).then(() => {
      parentPort.on('message', data => self.onmessage({data}));
      parentPort.postMessage({type:'ready'});
    });
  `, {eval: true});
  await once(worker, 'message');
  let id = 0;
  return {worker, request(type, args = {}) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Worker response timed out')); }, 10000);
      const onMessage = message => { if (message.id === requestId && message.type !== 'progress') { cleanup(); resolve(message); } };
      const onError = error => { cleanup(); reject(error); };
      const cleanup = () => { clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError); };
      worker.on('message', onMessage); worker.once('error', onError);
      worker.postMessage({type, id: requestId, ...args});
    });
  }};
}
const json = data => new Blob([JSON.stringify(data)], {type: 'application/json'});
const record = (t, lon = 134000000, accuracy) => ({latitudeE7: 525000000, longitudeE7: lon, timestampMs: String(t), accuracy});

test('worker reports anonymous device choices and keeps their filters through queries and place history', async () => {
  const {worker, request} = await startWorker();
  try {
    const imported = await request('import', {files: [
      json({locations: [{...record(0), deviceTag: 'private-phone-a', source: 'GPS'}, {...record(1), deviceTag: 'private-phone-b', source: 'WIFI'}]}),
      json({locations: [{...record(0), deviceTag: 'private-phone-a', source: 'GPS'}, {...record(60000), deviceTag: 'private-phone-a', source: 'GPS'}]}),
    ]});
    assert.deepEqual(imported.report.devices, [{id: 0, label: 'Device 1', count: 2}, {id: 1, label: 'Device 2', count: 1}]);
    assert.deepEqual(imported.report.sources, [{id: 1, label: 'GPS', count: 2}, {id: 2, label: 'Wi-Fi', count: 1}]);
    assert.ok(!JSON.stringify(imported).includes('private-phone'));
    assert.equal(imported.report.duplicates, 1);
    const options = {device: 0, trackMode: 'drift', mode: 'points'};
    const result = (await request('query', {options})).result;
    assert.equal(result.count, 2); assert.equal(result.km, 0);
    assert.equal(result.dots.features[0].properties.device, 'Device 1');
    const area = {geometry: {coordinates: [[[13, 52], [14, 52], [14, 53], [13, 53], [13, 52]]]}};
    assert.equal((await request('place', {area, options})).result.count, 2);
    assert.equal((await request('point', {index: 1, options})).result, null);
    assert.equal((await request('query', {options: {source: 2}})).result.count, 1);
    assert.equal((await request('place', {area, options: {source: 2}})).result.count, 1);
  } finally { await worker.terminate(); }
});

test('worker navigates filtered points with matching metadata and resets navigation on import or clear', async () => {
  const {worker, request} = await startWorker();
  try {
    await request('import', {files: [json({locations: [record(0), {...record(60000, 134001000, 5), altitude: 20, speedMetersPerSecond: 0}, record(120000, 134002000, 500), record(180000, 134003000, 5)]})]});
    const options = {mode: 'points', accuracy: 100}, rendered = (await request('query', {options})).result;
    const selected = await request('point', {index: 1, options});
    assert.equal(selected.type, 'point'); assert.equal(selected.result.previous, 0); assert.equal(selected.result.next, 3);
    assert.deepEqual(selected.result.feature, rendered.dots.features[1]);
    assert.equal(selected.result.feature.properties.altitude, 20); assert.equal(selected.result.feature.properties.speed, 0);
    assert.equal((await request('point', {index: 2, options})).result, null);
    assert.equal((await request('point', {index: 3, options: {...options, end: 120000}})).result, null);
    const cached = (await request('query', {options, known: rendered.versions})).result;
    assert.equal(cached.routes, undefined); assert.equal(cached.count, 3);
    await request('import', {files: [json({locations: [record(900000)]})]});
    const replaced = (await request('point', {index: 0})).result;
    assert.equal(replaced.feature.properties.time, 900000); assert.equal(replaced.previous, null); assert.equal(replaced.next, null);
    await request('clear');
    assert.equal((await request('point', {index: 0})).result, null);
  } finally { await worker.terminate(); }
});

test('worker merges files, preserves old data after failure, filters exact observations and clears memory', async () => {
  const {worker, request} = await startWorker();
  try {
    const imported = await request('import', {files: [json({locations: [record(0), record(1000)]}), json({locations: [record(1000), record(2000, 134010000, 500)]})]});
    assert.equal(imported.type, 'imported'); assert.equal(imported.report.total, 3); assert.equal(imported.report.duplicates, 1);
    const failed = await request('import', {files: [json({locations: [record(9000)]}), json({unsupported: true})]});
    assert.equal(failed.type, 'error'); assert.equal(failed.operation, 'import');
    assert.match(failed.message, /^File 2: Unsupported JSON/);
    const result = await request('query');
    assert.equal(result.result.count, 3);
    const filtered = await request('query', {options: {mode: 'points', start: 0, end: 2000, accuracy: 100, hourStart: 0, hourEnd: 24}});
    assert.equal(filtered.result.count, 2);
    assert.equal(filtered.result.dots.features.length, 2);
    assert.equal(filtered.result.dots.features[0].properties.time, 0);
    await request('clear');
    assert.equal((await request('query')).result.count, 0);
  } finally { await worker.terminate(); }
});

test('worker detects gzip by magic bytes and recovers from malformed JSON and gzip', async () => {
  const {worker, request} = await startWorker();
  try {
    const compressed = new Blob([gzipSync(JSON.stringify({locations: [record(0)]}))]);
    assert.equal((await request('import', {files: [compressed]})).report.total, 1);
    for (const file of [new Blob(['{broken']), new Blob([new Uint8Array([0x1f, 0x8b, 0])])]) {
      assert.equal((await request('import', {files: [file]})).type, 'error');
      assert.equal((await request('query')).result.count, 1);
    }
  } finally { await worker.terminate(); }
});

test('a failure after streamed batches preserves the previously imported dataset', async () => {
  const {worker, request} = await startWorker();
  try {
    await request('import', {files: [json({locations: [record(0)]})]});
    const records = Array.from({length: 2001}, (_, i) => record(i + 1000));
    const truncated = JSON.stringify({locations: records}).slice(0, -2);
    const failed = await request('import', {files: [new Blob([truncated])]});
    assert.equal(failed.type, 'error');
    assert.equal((await request('query')).result.count, 1);
    assert.equal((await request('import', {files: [json({locations: records})]})).report.total, 2001);
  } finally { await worker.terminate(); }
});

test('worker sends changed geometry and never assumes a discarded response was displayed', async () => {
  const {worker, request} = await startWorker();
  try {
    await request('import', {files: [json({locations: [record(0), record(60000, 134010000)]})]});
    const first = (await request('query', {options: {mode: 'points'}})).result;
    const discarded = (await request('query', {options: {mode: 'route'}, known: first.versions})).result;
    assert.ok(discarded.routes.features.length > 1);
    assert.deepEqual(discarded.routes.features[0].geometry.coordinates[0], [13.4, 52.5]);
    assert.deepEqual(discarded.routes.features.at(-1).geometry.coordinates.at(-1), [13.401, 52.5]);
    const received = (await request('query', {options: {mode: 'route'}, known: first.versions})).result;
    assert.deepEqual(received.routes, discarded.routes);
    const pan = (await request('query', {options: {mode: 'route', viewport: [10, 50, 15, 55]}, known: received.versions})).result;
    assert.equal(pan.routes, undefined); assert.equal(pan.dots, undefined); assert.equal(pan.density, undefined);
    assert.equal(pan.count, 2);
    const points = (await request('query', {options: {mode: 'points'}, known: pan.versions})).result;
    assert.equal(points.routes.features.length, 0); assert.equal(points.dots.features.length, 2);
    await request('import', {files: [json({locations: [record(90000)]})]});
    const replaced = (await request('query', {known: points.versions})).result;
    assert.equal(replaced.count, 1); assert.ok(replaced.density);
  } finally { await worker.terminate(); }
});

test('worker place queries share filters and are replaced transactionally with their dataset', async () => {
  const {worker, request} = await startWorker();
  const area = {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [[[13, 52], [14, 52], [14, 53], [13, 53], [13, 52]]]}};
  try {
    await request('import', {files: [json({locations: [record(0), record(60000, 134000000, 500)]})]});
    assert.equal((await request('place', {area})).result.count, 2);
    const hourly = await request('place-hours', {area, options: {start: 0, end: 86_400_000 - 1}});
    assert.equal(hourly.type, 'place-hours'); assert.equal(hourly.hours.length, 24); assert.equal(hourly.hours[0].count, 2);
    const tooLarge = await request('place-hours', {area, options: {start: 0, end: 8 * 86_400_000 - 1}});
    assert.equal(tooLarge.type, 'error'); assert.equal(tooLarge.operation, 'place-hours');
    assert.equal((await request('place', {area, options: {accuracy: 100}})).result.count, 1);
    assert.equal((await request('place', {area: null})).type, 'error');
    assert.equal((await request('query')).result.count, 2);
    await request('import', {files: [json({locations: [record(100000)]})]});
    const after = (await request('place', {area})).result;
    assert.equal(after.count, 1); assert.equal(after.first, 100000);
    await request('clear');
    assert.equal((await request('place', {area})).result.count, 0);
  } finally { await worker.terminate(); }
});

test('combined phone imports ignore recognized empty files, preserve metadata and extend bounds through visits', async () => {
  const {worker, request} = await startWorker();
  try {
    const start = Date.UTC(2026, 0, 1, 18), end = start + 40 * 3600000;
    const imported = await request('import', {files: [json({rawSignals: []}), json({
      semanticSegments: [{startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(), visit: {topCandidate: {placeLocation: {latLng: 'geo:52.5,13.4'}}}}],
      rawSignals: [{position: {LatLng: '52.5,13.4', timestamp: start, altitudeMeters: 50, speedMetersPerSecond: 0, accuracyMeters: 5}}]
    })]});
    assert.equal(imported.type, 'imported'); assert.equal(imported.report.total, 1); assert.equal(imported.report.duplicates, 1);
    assert.equal(imported.report.max, end - 1);
    const points = (await request('query', {options: {mode: 'points'}})).result.dots.features;
    assert.equal(points[0].properties.altitude, 50); assert.equal(points[0].properties.speed, 0);
    const failed = await request('import', {files: [json({rawSignals: []})]});
    assert.equal(failed.type, 'error'); assert.equal((await request('query')).result.count, 1);
  } finally { await worker.terminate(); }
});

test('all six overlapping phone export variants merge in the same batch, including the empty variant', async () => {
  const {worker, request} = await startWorker();
  const semanticSegments = [{startTime: 0, timelinePath: [{point: 'geo:52.5,13.4', time: 0}]}];
  const rawSignals = [{position: {LatLng: '52.5,13.4', timestamp: 0, accuracyMeters: 5}}, {position: {LatLng: '52.5,13.401', timestamp: 1000}}];
  try {
    const variants = [{semanticSegments, rawSignals}, {rawSignals}, {semanticSegments, rawSignals: []}, {semanticSegments, rawSignals: []}, {rawSignals: []}, {semanticSegments, rawSignals}];
    const result = await request('import', {files: variants.map(data => json({...data, userLocationProfile: {}}))});
    assert.equal(result.type, 'imported'); assert.equal(result.report.total, 2); assert.equal(result.report.duplicates, 8);
    assert.equal((await request('query', {options: {mode: 'points', accuracy: 10}})).result.count, 2);
  } finally { await worker.terminate(); }
});
