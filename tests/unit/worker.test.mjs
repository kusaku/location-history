import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {gzipSync} from 'node:zlib';

// Adapt browser worker messaging to Node without replacing the production worker code.
const url = new URL('../../assets/js/worker.mjs', import.meta.url).href;
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

test('worker merges files, preserves old data after failure, filters exact observations and clears memory', async () => {
  const {worker, request} = await startWorker();
  try {
    const imported = await request('import', {files: [json({locations: [record(0), record(1000)]}), json({locations: [record(1000), record(2000, 134010000, 500)]})]});
    assert.equal(imported.type, 'imported'); assert.equal(imported.report.total, 3); assert.equal(imported.report.duplicates, 1);
    const failed = await request('import', {files: [json({locations: [record(9000)]}), json({unsupported: true})]});
    assert.equal(failed.type, 'error'); assert.equal(failed.operation, 'import');
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
    assert.equal(discarded.routes.features.length, 1);
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
    assert.equal((await request('place', {area, options: {exclude: 4}})).result.count, 1);
    assert.equal((await request('place', {area: null})).type, 'error');
    assert.equal((await request('query')).result.count, 2);
    await request('import', {files: [json({locations: [record(100000)]})]});
    const after = (await request('place', {area})).result;
    assert.equal(after.count, 1); assert.equal(after.first, 100000);
    await request('clear');
    assert.equal((await request('place', {area})).result.count, 0);
  } finally { await worker.terminate(); }
});
