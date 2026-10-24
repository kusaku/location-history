import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, readdir, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createSample, encodeHistory, endOfDay} from '../../scripts/create-sample.mjs';
import {parseHistory, preparePoints, createHistoryQuery, DAY} from '../../assets/js/data.mjs';
const record = (timestamp, accuracy = 20, latitudeE7 = 525000000, longitudeE7 = 134000000) => ({timestamp, accuracy, latitudeE7, longitudeE7});
const encode = points => encodeHistory(points).encoded;

test('sample end dates include the entire UTC day and reject invalid calendar dates', () => {
  assert.equal(endOfDay('2020-04-01'), Date.parse('2020-04-02T00:00:00Z'));
  assert.equal(endOfDay('2024-02-29'), Date.parse('2024-03-01T00:00:00Z'));
  for (const value of ['', '2023-02-29', '2020-04-31', '2020-13-01', '2020-04-01T00:00:00Z']) assert.throws(() => endOfDay(value), /valid --end date/);
});

test('delta samples preserve accuracy, explicit durations and milliseconds without baking inferred time', () => {
  const raw = parseHistory({locations: [record('2020-04-01T12:00:00.123Z', 0), record('2020-04-01T12:01:00.456Z', null)]}).points;
  const encoded = encode(raw);
  assert.deepEqual(encoded.accuracy, [0, null]); assert.equal(encoded.duration, undefined);
  assert.deepEqual(parseHistory(encoded).points, raw);
  assert.ok(raw.every(p => p.duration === 0));
  const visit = parseHistory([{startTime: '2020-04-01T12:00:00Z', endTime: '2020-04-01T12:05:00Z', visit: {topCandidate: {placeLocation: {latLng: 'geo:52.5,13.4'}}}}]).points;
  const semantic = encode(visit);
  assert.equal(semantic.accuracy, undefined); assert.deepEqual(semantic.duration, [300000]);
  assert.deepEqual(parseHistory(semantic).points, visit);
});

test('sample deduplication merges exact observations while preserving repeated coordinates and simultaneous distinct locations', () => {
  const points = parseHistory({locations: [record(1000, 100), record(0, null), record(1000, 10), record(1000, 30, 525000001)]}).points;
  points[0].duration = 5000; points[2].duration = 1000;
  const {encoded, duplicates} = encodeHistory(points), decoded = parseHistory(encoded).points;
  assert.equal(duplicates, 1); assert.equal(decoded.length, 3);
  assert.deepEqual(decoded.map(p => [p.t, p.accuracy, p.duration]), [[0, null, 0], [1000, 10, 5000], [1000, 30, 0]]);
  const close = encodeHistory([{t: 0, lat: 52.5, lon: 13.400000001, accuracy: 20, duration: 0}, {t: 0, lat: 52.5, lon: 13.400000002, accuracy: 5, duration: 0}]);
  assert.equal(close.duplicates, 1); assert.equal(parseHistory(close.encoded).points[0].accuracy, 5);
});

test('sample generation is deterministic, clips the end date, preserves the input and replaces output atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'location-history-sample-'));
  try {
    const input = join(dir, 'input.json'), output = join(dir, 'sample.gz');
    const source = JSON.stringify({locations: [record('2020-04-02T00:00:00Z'), record('2020-04-01T23:59:59.999Z'), record('2020-04-01T00:00:00Z'), record('2020-04-01T00:00:00Z', 5)]});
    await writeFile(input, source); await writeFile(output, 'old');
    const result = await createSample(input, output, '2020-04-01'), first = await readFile(output);
    assert.equal(result.retained, 2); assert.equal(result.duplicates, 1); assert.equal(result.accuracy, 2);
    assert.equal(result.last, '2020-04-01T23:59:59.999Z');
    const decoded = parseHistory(JSON.parse(gunzipSync(first))).points;
    assert.deepEqual(decoded.map(p => p.accuracy), [5, 20]);
    await createSample(input, output, '2020-04-01'); assert.deepEqual(await readFile(output), first);
    assert.equal(await readFile(input, 'utf8'), source);
    await assert.rejects(createSample(input, input, '2020-04-01'), /output must differ/);
    const alias = join(dir, 'alias.json'); await symlink(input, alias);
    await assert.rejects(createSample(input, alias, '2020-04-01'), /output must differ/);
    await writeFile(input, '{"locations":[');
    await assert.rejects(createSample(input, output, '2020-04-01'));
    assert.deepEqual(await readFile(output), first);
    await writeFile(input, JSON.stringify({locations: [record('2020-04-02T00:00:00Z')]}));
    await assert.rejects(createSample(input, output, '2020-04-01'), /No locations match/);
    assert.deepEqual(await readFile(output), first);
    assert.ok((await readdir(dir)).every(name => !name.endsWith('.tmp')));
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('explicit visits crossing the sample cutoff retain only their selected duration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'location-history-sample-'));
  try {
    const input = join(dir, 'visits.json'), output = join(dir, 'sample.gz');
    await writeFile(input, JSON.stringify([{startTime: '2020-04-01T23:55:00Z', endTime: '2020-04-02T00:20:00Z', visit: {topCandidate: {placeLocation: {latLng: 'geo:52.5,13.4'}}}}]));
    assert.equal((await createSample(input, output, '2020-04-01')).durations, 1);
    const decoded = parseHistory(JSON.parse(gunzipSync(await readFile(output)))).points;
    assert.equal(decoded[0].duration, 5 * 60000);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('raw and compressed observations produce identical map and place results with every filter and metric', () => {
  const raw = parseHistory({locations: Array.from({length: 1000}, (_, i) => record(i * 60000 + Math.floor(i / 250) * DAY, i % 5 ? i % 100 : null, 525000000 + i % 19 * 100, 134000000 + i % 29 * 100))}).points;
  const compressed = parseHistory(encode(raw.map(p => ({...p})))).points;
  const a = createHistoryQuery(preparePoints(raw).points), b = createHistoryQuery(preparePoints(compressed).points);
  const area = {geometry: {type: 'Polygon', coordinates: [[[13.3, 52.4], [13.5, 52.4], [13.5, 52.6], [13.3, 52.6], [13.3, 52.4]]]}};
  for (const filters of [{}, {accuracy: 10}, {accuracy: 50, hourStart: 1, hourEnd: 3}, {excludeJumps: true, start: DAY, end: 3 * DAY}]) {
    for (const mode of ['heat', 'hex', 'points', 'route']) for (const metric of ['records', 'days', 'time']) assert.deepEqual(a({...filters, mode, metric}), b({...filters, mode, metric}));
    assert.deepEqual(a.place(area, filters), b.place(area, filters));
  }
});
