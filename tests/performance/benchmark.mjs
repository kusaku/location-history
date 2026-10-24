// Native Node benchmark. Optional file paths stay local; output contains no coordinates.
import {execFileSync} from 'node:child_process';
import {createReadStream, openSync, readSync, closeSync, statSync, readFileSync} from 'node:fs';
import {Readable} from 'node:stream';
import {resolve, basename} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readHistory} from '../../assets/js/import.mjs';

const args = process.argv.slice(2);
const revision = args[0] === '--revision' ? args.splice(0, 2)[1] : null;
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const git = args => execFileSync('git', args, {cwd: projectRoot, encoding: 'utf8'}).trim();
const commit = revision ? git(['rev-parse', '--verify', `${revision}^{commit}`]) : null;
const dataPath = commit ? git(['ls-tree', '-r', '--name-only', commit, '--', 'assets/js/data.mjs', 'data.mjs']).split('\n')[0] : null;
const source = commit ? git(['show', `${commit}:${dataPath}`]) : readFileSync(new URL('../../assets/js/data.mjs', import.meta.url), 'utf8');
const data = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const synthetic = args[0] === '--synthetic' ? Number(args.splice(0, 2)[1]) : 0;
if (!Number.isInteger(synthetic) || synthetic < 0 || synthetic > data.MAX_POINTS) throw new Error('Synthetic count must be within the import limit.');
const files = synthetic ? [] : args.length ? args.map(path => resolve(path)) : [fileURLToPath(new URL('../../data/sample-location-history.json.gz', import.meta.url))];
const points = []; let skipped = 0;
const started = performance.now();
for (let i = 0; i < synthetic; i++) points.push({t: i * 60000 + Math.floor(i / 100000) * data.DAY, lon: 13.3 + i % 1000 * .0001, lat: 52.4 + Math.floor(i / 1000) % 1000 * .0001, accuracy: i % 11 ? 20 : 500, duration: 0});
for (const path of files) {
  const head = new Uint8Array(2), fd = openSync(path, 'r');
  readSync(fd, head); closeSync(fd);
  const result = await readHistory({name: basename(path), size: statSync(path).size, slice: (start, end) => new Blob([head.slice(start, end)]), stream: () => Readable.toWeb(createReadStream(path))}, batch => { for (const p of batch) points.push(p); });
  skipped += result.skipped;
}
const prepared = data.preparePoints(points);
const setup = performance.now();
const query = data.createHistoryQuery ? data.createHistoryQuery(prepared.points) : options => data.queryHistory(prepared.points, options);
console.log(JSON.stringify({revision: revision ?? 'working', records: points.length, skipped, duplicates: prepared.duplicates, importMs: Math.round(setup - started), indexMs: Math.round(performance.now() - setup)}));

const lastDay = Math.floor(points.at(-1).t / data.DAY) * data.DAY;
const cases = [
  ['world_heat', {mode: 'heat', zoom: 2, viewport: [-180, -85, 180, 85]}],
  ['europe_pan', {mode: 'heat', zoom: 5, viewport: [-10, 40, 35, 65]}],
  ['city_pan', {mode: 'heat', zoom: 11, viewport: [13.2, 52.3, 13.7, 52.7]}],
  ['day_filter', {mode: 'heat', zoom: 8, start: lastDay, end: lastDay + data.DAY - 1, viewport: [-180, -85, 180, 85]}],
  ['hour_accuracy_hex', {mode: 'hex', metric: 'days', accuracy: 100, hourStart: 8, hourEnd: 20, zoom: 5, viewport: [-10, 40, 35, 65]}],
  ['points', {mode: 'points', zoom: 5, viewport: [-10, 40, 35, 65]}],
  ['journeys', {mode: 'route', zoom: 5, viewport: [-10, 40, 35, 65]}],
];
if (data.QUALITY) cases.push(['quality_exclusions', {mode: 'heat', exclude: 15, zoom: 5, viewport: [-10, 40, 35, 65]}]);
for (const [name, options] of cases) {
  const times = []; let result;
  for (let i = 0; i < 4; i++) {
    const viewport = options.viewport.map((v, j) => v + (j % 2 === 0 ? i * .001 : 0));
    const begin = performance.now(); result = query({...options, viewport});
    times.push(performance.now() - begin);
  }
  const geometry = options.mode === 'route' ? result.routes : options.mode === 'points' ? result.dots : result.density;
  const digest = createHash('sha256').update(JSON.stringify({...geometry, features: geometry.features.map(({id, properties, ...feature}) => { const {cell, ...values} = properties; return {type: feature.type, properties: values, geometry: feature.geometry}; })})).digest('hex').slice(0, 16);
  const median = times.slice(1).sort((a, b) => a - b)[1];
  console.log(JSON.stringify({case: name, firstQueryMs: +times[0].toFixed(2), medianPanMs: +median.toFixed(2), count: result.count, visible: result.visible, days: result.days, km: result.km, features: geometry.features.length, digest, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024)}));
}

if (query.place) {
  for (const [name, box] of [['place_city', [13.2, 52.3, 13.7, 52.7]], ['place_block', [13.39, 52.49, 13.4, 52.5]]]) {
    const [west, south, east, north] = box;
    const area = {type: 'Feature', geometry: {type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]}};
    const begin = performance.now(), result = query.place(area), elapsed = performance.now() - begin;
    const cached = performance.now(); query.place(area);
    console.log(JSON.stringify({case: name, firstQueryMs: +elapsed.toFixed(2), cachedMs: +(performance.now() - cached).toFixed(2), count: result.count, days: result.days, visits: result.visits, minutes: Math.round(result.minutes), details: result.recent.length, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024)}));
  }
}
