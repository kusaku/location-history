import {parseHistory, preparePoints, queryHistory, MAX_POINTS} from './data.mjs';
let points = [], report = null;
const MAX_BYTES = 512 * 1024 * 1024;
async function readFile(file) {
  if (file.size > MAX_BYTES) throw new Error('This file exceeds the 512 MB import limit. Split it into smaller exports.');
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  let stream = file.stream();
  if (head[0] === 0x1f && head[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Gzip is unavailable in this browser. Unzip the JSON first.');
    stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  const reader = stream.getReader(), decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('The uncompressed file exceeds the 512 MB limit. Split it into smaller exports.');
      text += decoder.decode(value, {stream: true});
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
self.onmessage = async ({data}) => {
  const {id, type} = data;
  try {
    if (type === 'import') {
      // Stage all files before replacing the current dataset; a bad file never clears it.
      const staged = []; let skipped = 0;
      for (let i = 0; i < data.files.length; i++) {
        const file = data.files[i];
        self.postMessage({type: 'progress', id, message: `Reading ${file.name} (${i + 1}/${data.files.length})…`});
        const parsed = parseHistory(JSON.parse((await readFile(file)).replace(/^\uFEFF/, '')));
        if (staged.length + parsed.points.length > MAX_POINTS) throw new Error('The combined import exceeds two million points. Import a smaller date range.');
        for (const p of parsed.points) staged.push(p);
        skipped += parsed.skipped;
      }
      const prepared = preparePoints(staged);
      points = prepared.points;
      report = {total: points.length, min: points[0].t, max: points.at(-1).t, skipped, duplicates: prepared.duplicates, files: data.files.map(f => f.name)};
      self.postMessage({type: 'imported', id, report});
    } else if (type === 'query') {
      self.postMessage({type: 'result', id, result: queryHistory(points, data.options)});
    } else if (type === 'export') {
      const {start, end, accuracy, hourStart, hourEnd} = data.options;
      const features = points.filter(p => p.t >= start && p.t <= end && (!accuracy || p.accuracy === null || p.accuracy <= accuracy) && new Date(p.t).getUTCHours() >= hourStart && new Date(p.t).getUTCHours() < hourEnd).map(p => ({type: 'Feature', properties: {timestamp: new Date(p.t).toISOString(), accuracy: p.accuracy}, geometry: {type: 'Point', coordinates: [p.lon, p.lat]}}));
      self.postMessage({type: 'exported', id, text: JSON.stringify({type: 'FeatureCollection', features})});
    } else if (type === 'clear') {
      points = []; report = null;
      self.postMessage({type: 'cleared', id});
    }
  } catch (error) { self.postMessage({type: 'error', id, operation: type, message: error.message || 'The file could not be read.'}); }
};
