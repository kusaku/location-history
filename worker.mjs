import {preparePoints, queryHistory, MAX_POINTS} from './data.mjs?v=2';
import {readHistory} from './import.mjs';
let points = [], report = null;
self.onmessage = async ({data}) => {
  const {id, type} = data;
  try {
    if (type === 'import') {
      // Stage all files before replacing the current dataset; a bad file never clears it.
      const staged = []; let skipped = 0;
      for (let i = 0; i < data.files.length; i++) {
        const file = data.files[i];
        self.postMessage({type: 'progress', id, message: `Reading ${file.name} (${i + 1}/${data.files.length})…`});
        let lastProgress = 0;
        const parsed = await readHistory(file, batch => {
          if (staged.length + batch.length > MAX_POINTS) throw new Error('The combined import exceeds five million points. Import a smaller date range.');
          for (const p of batch) staged.push(p);
        }, ({bytes, size}) => {
          if (Date.now() - lastProgress < 200) return;
          lastProgress = Date.now();
          self.postMessage({type: 'progress', id, message: `Reading ${file.name} (${i + 1}/${data.files.length}) · ${Math.min(100, Math.round(bytes / Math.max(1, size) * 100))}% · ${staged.length.toLocaleString('en')} locations…`});
        });
        skipped += parsed.skipped;
      }
      self.postMessage({type: 'progress', id, message: `Sorting and merging ${staged.length.toLocaleString('en')} locations…`});
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
