// Native Node CLI; no packages or build step. End dates include the whole UTC day.
import {openAsBlob} from 'node:fs';
import {writeFile, rename, rm, realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {readHistory} from '../assets/js/import.mjs';
import {preparePoints, MAX_POINTS, DAY} from '../assets/js/data.mjs';

export function endOfDay(date) {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== date) throw new Error('Use a valid --end date in YYYY-MM-DD format (inclusive, UTC).');
  return t + DAY;
}

export function encodeHistory(points) {
  // Deduplicate at the precision actually written to the sample.
  for (const p of points) { p.lat = Math.round(p.lat * 1e7) / 1e7; p.lon = Math.round(p.lon * 1e7) / 1e7; }
  // Store original durations only; inference runs after import, never at export.
  const prepared = preparePoints(points, {inferStationary: false});
  if (!points.length) throw new Error('No locations match the requested sample dates.');
  const encoded = {format: 'delta-compressed', version: 2, base: [], data: [[], [], []]};
  if (points.some(p => p.accuracy !== null)) encoded.accuracy = [];
  if (points.some(p => p.duration > 0)) encoded.duration = [];
  let lat = 0, lon = 0, t = 0;
  for (const p of points) {
    const nextLat = Math.round(p.lat * 1e7), nextLon = Math.round(p.lon * 1e7);
    if (!encoded.base.length) encoded.base = [nextLat, nextLon, p.t];
    else { encoded.data[0].push(nextLat - lat); encoded.data[1].push(nextLon - lon); encoded.data[2].push(p.t - t); }
    encoded.accuracy?.push(p.accuracy); encoded.duration?.push(p.duration);
    lat = nextLat; lon = nextLon; t = p.t;
  }
  return {encoded, duplicates: prepared.duplicates};
}

export async function createSample(input, output, endDate) {
  const end = endOfDay(endDate), source = await realpath(input);
  const target = await realpath(output).catch(error => { if (error.code !== 'ENOENT') throw error; return resolve(output); });
  if (source === target) throw new Error('The output must differ from the input file.');
  const points = []; let read = 0;
  const {skipped} = await readHistory(await openAsBlob(source), batch => {
    read += batch.length;
    for (const p of batch) if (p.t < end) {
      if (points.length >= MAX_POINTS) throw new Error('The sample exceeds five million points. Choose an earlier --end date.');
      p.duration = Math.min(p.duration, end - p.t); points.push(p);
    }
  });
  const {encoded, duplicates} = encodeHistory(points), bytes = gzipSync(JSON.stringify(encoded), {level: 9});
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, {flag: 'wx', mode: 0o600}); await rename(temporary, target); }
  finally { await rm(temporary, {force: true}); }
  return {read, retained: points.length, skipped, duplicates, first: new Date(points[0].t).toISOString(), last: new Date(points.at(-1).t).toISOString(), accuracy: encoded.accuracy?.reduce((n, v) => n + (v !== null), 0) ?? 0, durations: encoded.duration?.reduce((n, v) => n + (v > 0), 0) ?? 0, bytes: bytes.length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const {values, positionals} = parseArgs({allowPositionals: true, options: {end: {type: 'string'}, output: {type: 'string'}, help: {type: 'boolean'}}});
    if (values.help) console.log('Usage: node scripts/create-sample.mjs INPUT.json[.gz] --end YYYY-MM-DD --output SAMPLE.json.gz\nIncludes the entire end date in UTC. Replaces the output atomically; never modifies the input.');
    else {
      if (positionals.length !== 1 || !values.end || !values.output) throw new Error('Provide one input file, --end YYYY-MM-DD and --output SAMPLE.json.gz. Use --help for usage.');
      console.log(JSON.stringify(await createSample(positionals[0], values.output, values.end)));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
