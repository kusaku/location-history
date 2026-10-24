import {preparePoints, createHistoryQuery, MAX_POINTS} from './data.mjs?v=16';
import {readHistory} from './import.mjs?v=15';
let points = [], query = createHistoryQuery(points), geometry = {}, version = 0;
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
      const nextQuery = createHistoryQuery(prepared.points);
      points = prepared.points; query = nextQuery; geometry = {};
      const report = {total: points.length, min: points[0].t, max: points.at(-1).t, skipped, duplicates: prepared.duplicates, files: data.files.map(f => f.name)};
      self.postMessage({type: 'imported', id, report});
    } else if (type === 'query') {
      const result = query(data.options), versions = {};
      for (const key of ['density', 'dots', 'routes']) {
        if (geometry[key]?.value !== result[key]) geometry[key] = {value: result[key], version: ++version};
        versions[key] = geometry[key].version;
        // Acknowledge what the UI actually displayed, including after a discarded query.
        if (data.known?.[key] === versions[key]) delete result[key];
      }
      self.postMessage({type: 'result', id, result: {...result, versions}});
    } else if (type === 'place') {
      self.postMessage({type: 'place', id, result: query.place(data.area, data.options)});
    } else if (type === 'clear') {
      points = []; query = createHistoryQuery(points); geometry = {};
      self.postMessage({type: 'cleared', id});
    }
  } catch (error) { self.postMessage({type: 'error', id, operation: type, message: error.message || 'The file could not be read.'}); }
};
