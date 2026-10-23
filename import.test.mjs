import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {readHistory} from './import.mjs';
import {parseHistory} from './data.mjs';

const record = (timestampMs = '0') => ({latitudeE7: 525000000, longitudeE7: 134000000, timestampMs});
function chunked(input, size = 7, cancel = () => {}) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const blob = new Blob([bytes]);
  return {size: bytes.length, slice: (...args) => blob.slice(...args), stream() {
    let offset = 0;
    return new ReadableStream({pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + size);
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    }, cancel});
  }};
}
async function read(file) {
  const points = [], progress = [];
  const {skipped} = await readHistory(file, batch => { for (const point of batch) points.push(point); }, p => progress.push(p));
  return {points, skipped, progress};
}

test('streaming imports match every supported schema regardless of root property order', async () => {
  const segment = {startTime: '2025-01-01T00:00:00Z', timelinePath: [{point: 'geo:52.5,13.4', durationMinutesOffsetFromStartTime: 1}]};
  for (const data of [
    {locations: [record(), null, record('1000')]},
    [segment], {semanticSegments: [segment]}, {timelineObjects: [segment]},
    {features: [{geometry: {type: 'Point', coordinates: [0, 0]}, properties: {timestamp: 0}}], type: 'FeatureCollection'},
    {data: [[1], [2], [1000]], base: [0, 0, 0], format: 'delta-compressed'},
  ]) {
    const streamed = await read(chunked(JSON.stringify(data)));
    assert.deepEqual({points: streamed.points, skipped: streamed.skipped}, parseHistory(data));
  }
});

test('UTF-8, escaped quotes, brackets in strings, BOM and nested metadata cross byte boundaries', async () => {
  const data = {metadata: {nested: ['🗺️', '"\\}],{[', {empty: []}]}, locations: [{...record(), source: 'Москва 🗺️ "\\}],{['}]};
  for (const size of [1, 2, 3, 17, 65536]) {
    const result = await read(chunked('\uFEFF' + JSON.stringify(data) + '\n', size));
    assert.deepEqual(result.points, parseHistory(data).points);
    assert.equal(result.progress.at(-1).bytes, result.progress.at(-1).size);
  }
});

test('gzip streams incrementally without relying on a filename extension', async () => {
  const data = {locations: [record(), record('1000')]};
  const result = await read(chunked(gzipSync(JSON.stringify(data)), 3));
  assert.deepEqual(result.points, parseHistory(data).points);
  assert.equal(result.progress.at(-1).bytes, result.progress.at(-1).size);
});

test('invalid records can fill entire batches without preventing subsequent valid observations', async () => {
  const result = await read(new Blob([JSON.stringify({locations: [...Array(2003).fill(null), record()]})]));
  assert.equal(result.points.length, 1);
  assert.equal(result.skipped, 2003);
  await assert.rejects(read(chunked('{"locations":[null]}')), /No valid timestamped/);
});

test('truncation, invalid tokens, duplicate roots and trailing content are rejected', async () => {
  const valid = JSON.stringify(record());
  for (const text of [
    '', '{', '{"locations":[', `{"locations":[${valid}`, `{"locations":[${valid},]}`,
    `{"locations":[${valid}]`, `{"locations":[${valid}]}[]`, `{"locations":[${valid}],}`,
    '{"locations":[tru]}', '{"locations":[{"x":"unterminated}]}',
    `{"locations":[${valid}],"locations":[]}`, '{"features":[],"type":"Point"}',
    `{"locations":[${valid}],"semanticSegments":[]}`, '{"unknown":true}',
  ]) await assert.rejects(read(chunked(text, 2)));
  await assert.rejects(read(chunked(new Uint8Array([0x7b, 0xff]))));
});

test('record batches are bounded and reading stops when the consumer reaches capacity', async () => {
  let cancelled = false, batches = 0;
  const file = chunked(JSON.stringify({locations: Array.from({length: 4000}, (_, i) => record(String(i)))}), 1024, () => { cancelled = true; });
  await assert.rejects(readHistory(file, batch => {
    assert.equal(batch.length, 1000);
    if (++batches === 2) throw new Error('Capacity reached');
  }), /Capacity reached/);
  assert.equal(cancelled, true);
  assert.equal(batches, 2);
});

test('metadata-heavy records are normalized before a large batch can accumulate', async () => {
  const padding = 'x'.repeat(600_000), batches = [];
  const file = new Blob([JSON.stringify({locations: Array.from({length: 3}, (_, i) => ({...record(String(i)), padding}))})]);
  await readHistory(file, points => batches.push(points.length));
  assert.deepEqual(batches, [2, 1]);
});
