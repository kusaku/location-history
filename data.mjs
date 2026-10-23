// Pure import and geospatial functions shared by the worker and Node tests.
export const DAY = 86_400_000;
// Date windows have inclusive endpoints. Keep their width when reaching a data boundary.
export function shiftPeriod(start, end, min, max, direction) {
  const shift = Math.max(min - start, Math.min(max - end, direction * (end - start + 1)));
  return {start: start + shift, end: end + shift};
}
export const MAX_POINTS = 5_000_000;
const rad = Math.PI / 180;
const number = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? Number(value) : NaN;
export function timestamp(value) {
  if (value === undefined || value === null || value === '') return NaN;
  const n = number(value);
  return Number.isFinite(n) ? n : Date.parse(value);
}
function coordinate(value) {
  if (typeof value === 'string') {
    const match = value.match(/^(?:geo:)?\s*([-+\d.e]+)\s*°,?\s*,\s*([-+\d.e]+)\s*°?$/i)
      || value.match(/^(?:geo:)?\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)$/i);
    return match ? [Number(match[2]), Number(match[1])] : [NaN, NaN];
  }
  if (value?.latLng) return coordinate(value.latLng);
  if (value?.latitudeE7 !== undefined || value?.latE7 !== undefined) return [number(value.longitudeE7 ?? value.lngE7) / 1e7, number(value.latitudeE7 ?? value.latE7) / 1e7];
  return [number(value?.longitude ?? value?.lng), number(value?.latitude ?? value?.lat)];
}
export function parseHistory(data, {allowEmpty = false} = {}) {
  const points = [];
  let skipped = 0;
  const add = (coords, time, accuracy, duration = 0) => {
    const [lon, lat] = Array.isArray(coords) ? coords : [NaN, NaN], t = timestamp(time), a = number(accuracy);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !Number.isFinite(t) || Math.abs(t) > 8.64e15) { skipped++; return; }
    if (points.length >= MAX_POINTS) throw new Error(`The import exceeds ${MAX_POINTS.toLocaleString('en')} points. Choose a smaller date range.`);
    points.push({lon, lat, t, accuracy: Number.isFinite(a) && a >= 0 ? a : null, duration: Math.max(0, duration) || 0});
  };
  const segment = entry => {
    if (!entry || typeof entry !== 'object') { skipped++; return; }
    const visit = entry.visit ?? entry.placeVisit;
    const duration = entry.duration ?? visit?.duration ?? entry.activitySegment?.duration;
    const start = timestamp(entry.startTime ?? duration?.startTimestamp ?? duration?.startTimestampMs);
    const end = timestamp(entry.endTime ?? duration?.endTimestamp ?? duration?.endTimestampMs);
    if (visit) add(coordinate(visit.topCandidate?.placeLocation ?? visit.location), start, undefined, Number.isFinite(end) ? end - start : 0);
    const activity = entry.activity ?? entry.activitySegment;
    const path = entry.timelinePath ?? activity?.simplifiedRawPath?.points ?? activity?.waypointPath?.waypoints;
    if (Array.isArray(path) && path.length) {
      for (const p of path) {
        if (!p || typeof p !== 'object') { skipped++; continue; }
        let t = p.time ?? p.timestamp ?? p.timestampMs;
        if (t === undefined && p.durationMinutesOffsetFromStartTime !== undefined) t = start + number(p.durationMinutesOffsetFromStartTime) * 60_000;
        // Untimed waypoints cannot be used as timestamped observations.
        add(coordinate(p.point ?? p), t, p.accuracyMeters ?? p.accuracy);
      }
    }
    if (activity) {
      add(coordinate(activity.start ?? activity.startLocation), start);
      add(coordinate(activity.end ?? activity.endLocation), end);
    }
  };
  if (data?.format === 'delta-compressed') {
    if (!Array.isArray(data.base) || data.base.length !== 3 || !Array.isArray(data.data) || data.data.length !== 3 || !data.data.every(Array.isArray) || !data.data.every(a => a.length === data.data[0].length)) throw new Error('Invalid delta-compressed history.');
    let [lat, lon, t] = data.base.map(number);
    add([lon / 1e7, lat / 1e7], t);
    for (let i = 0; i < data.data[0].length; i++) {
      lat += number(data.data[0][i]); lon += number(data.data[1][i]); t += number(data.data[2][i]);
      add([lon / 1e7, lat / 1e7], t);
    }
  } else if (Array.isArray(data?.locations)) {
    for (const p of data.locations) {
      if (!p || typeof p !== 'object') { skipped++; continue; }
      add(coordinate(p), p.timestamp ?? p.timestampMs, p.accuracy);
    }
  } else if (Array.isArray(data?.semanticSegments ?? data?.timelineObjects ?? data)) {
    for (const p of data.semanticSegments ?? data.timelineObjects ?? data) segment(p);
  } else if (data?.type === 'FeatureCollection' && Array.isArray(data.features)) {
    for (const f of data.features) {
      if (f?.geometry?.type !== 'Point') { skipped++; continue; }
      add(f.geometry.coordinates, f.properties?.timestamp ?? f.properties?.time, f.properties?.accuracy);
    }
  } else throw new Error('Unsupported JSON. Use Google Records, Timeline, semantic history, delta-compressed history, or timestamped GeoJSON points.');
  if (!points.length && !allowEmpty) throw new Error('No valid timestamped locations were found in this file.');
  return {points, skipped};
}
export function preparePoints(points) {
  points.sort((a, b) => a.t - b.t || a.lat - b.lat || a.lon - b.lon);
  // Compact the sorted array in place rather than cloning millions of objects.
  const unique = points;
  let duplicates = 0, length = 0;
  for (const p of points) {
    const last = unique[length - 1];
    if (last && last.t === p.t && last.lat === p.lat && last.lon === p.lon) {
      last.duration = Math.max(last.duration, p.duration);
      if (p.accuracy !== null && (last.accuracy === null || p.accuracy < last.accuracy)) last.accuracy = p.accuracy;
      duplicates++; continue;
    }
    unique[length++] = p;
  }
  unique.length = length;
  // Infer only short, stationary intervals; gaps and travel are never counted as stays.
  for (let i = 0; i < unique.length - 1; i++) {
    const p = unique[i], next = unique[i + 1], dt = next.t - p.t;
    if (!p.duration && dt > 0 && dt <= 30 * 60_000 && distance(p, next) <= 0.2) p.duration = dt;
  }
  return {points: unique, duplicates};
}
export function distance(a, b) {
  const lat = (b.lat - a.lat) * rad, lon = (b.lon - a.lon) * rad;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(lon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
function projectY(lat) {
  const s = Math.sin(Math.max(-85.051129, Math.min(85.051129, lat)) * rad);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}
export function project(lon, lat) { return [(lon + 180) / 360, projectY(lat)]; }
function unproject(x, y) { return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / rad]; }
export function wrappedBounds(points, indices = null) {
  const length = indices?.length ?? points.length;
  if (!length) return null;
  const at = i => points[indices ? indices[i] : i];
  const lons = Float64Array.from({length}, (_, i) => (at(i).lon + 360) % 360).sort();
  let gap = -1, index = 0, south = 90, north = -90;
  for (let i = 0; i < lons.length; i++) {
    const size = (i === lons.length - 1 ? lons[0] + 360 : lons[i + 1]) - lons[i];
    if (size > gap) { gap = size; index = i; }
  }
  let west = lons[(index + 1) % lons.length], east = lons[index];
  if (east < west) east += 360;
  if (west > 180) { west -= 360; east -= 360; }
  for (let i = 0; i < length; i++) { const p = at(i); south = Math.min(south, p.lat); north = Math.max(north, p.lat); }
  return [[west, Math.max(-85, Math.min(85, south))], [east, Math.min(85, Math.max(-85, north))]];
}
function lowerBound(points, time, inclusive = false) {
  let lo = 0, hi = points.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (points[m].t < time || (inclusive && points[m].t === time)) lo = m + 1; else hi = m; }
  return lo;
}
function hexRound(q, r) {
  const s = -q - r;
  let x = Math.round(q), y = Math.round(r), z = Math.round(s);
  const dx = Math.abs(x - q), dy = Math.abs(y - r), dz = Math.abs(z - s);
  if (dx > dy && dx > dz) x = -y - z;
  else if (dy > dz) y = -x - z;
  return [x, y];
}
const collection = features => ({type: 'FeatureCollection', features});
const EMPTY = collection([]);
const hour = t => Math.floor(((t % DAY) + DAY) % DAY / 3_600_000);
function accepts(p, accuracy, hourStart, hourEnd) {
  if (accuracy && p.accuracy !== null && !(p.accuracy <= accuracy)) return false;
  if (hourStart === 0 && hourEnd === 24) return true;
  const h = hour(p.t);
  return h >= hourStart && h < hourEnd;
}

// One compact index and one current filter/selection cache per committed dataset.
// Panning never recomputes the histogram, distance, date bounds, or route geometry.
export function createHistoryQuery(points) {
  const columns = 128, rows = 64, cells = columns * rows;
  const cell = p => Math.min(rows - 1, Math.floor((p.lat + 90) / 180 * rows)) * columns + Math.min(columns - 1, Math.floor((p.lon + 180) / 360 * columns));
  const offsets = new Uint32Array(cells + 1), order = new Uint32Array(points.length), projectedY = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) { offsets[cell(points[i]) + 1]++; projectedY[i] = projectY(points[i].lat); }
  for (let i = 1; i <= cells; i++) offsets[i] += offsets[i - 1];
  const cursors = offsets.slice();
  for (let i = 0; i < points.length; i++) order[cursors[cell(points[i])]++] = i;
  const min = points[0]?.t ?? 0, max = points.at(-1)?.t ?? 0;
  let filterKey, filter, selectionKey, selection;

  return (options = {}) => {
    const {start = -Infinity, end = Infinity, accuracy = 0, hourStart = 0, hourEnd = 24, metric = 'records', mode = 'heat', zoom = 10, radius = 24, viewport = [-180, -90, 180, 90]} = options;
    const nextFilterKey = `${accuracy}:${hourStart}:${hourEnd}`;
    if (filterKey !== nextFilterKey) {
      const mask = new Uint8Array(points.length), histogram = Array(64).fill(0);
      for (let i = 0; i < points.length; i++) if (accepts(points[i], accuracy, hourStart, hourEnd)) {
        mask[i] = 1;
        histogram[Math.min(63, Math.floor((points[i].t - min) / Math.max(1, max - min) * 64))]++;
      }
      filter = {mask, histogram}; filterKey = nextFilterKey;
    }
    const nextSelectionKey = `${filterKey}:${start}:${end}`;
    if (selectionKey !== nextSelectionKey) {
      const from = lowerBound(points, start), to = lowerBound(points, end, true);
      const indices = new Uint32Array(Math.max(0, to - from)), runs = [];
      let count = 0, km = 0, previous = -1, run = 0, days = 0, lastDay;
      for (let i = from; i < to; i++) {
        if (!filter.mask[i]) continue;
        const p = points[i];
        if (previous >= 0) {
          const dt = p.t - points[previous].t;
          let connected = i === previous + 1 && dt > 0 && dt <= 6 * 3_600_000 && Math.abs(p.lon - points[previous].lon) < 180;
          if (connected) {
            const d = distance(points[previous], p);
            connected = d / (dt / 3_600_000) <= 1000;
            if (connected) km += d;
          }
          if (!connected) { if (count - run > 1) runs.push([run, count]); run = count; }
        }
        indices[count++] = i; previous = i;
        const day = Math.floor(p.t / DAY);
        if (day !== lastDay) { days++; lastDay = day; }
      }
      if (count - run > 1) runs.push([run, count]);
      const selected = indices.subarray(0, count);
      selection = {from, to, indices: selected, runs, count, days, km: Math.round(km), bounds: wrappedBounds(points, selected), routes: null};
      selectionKey = nextSelectionKey;
    }
    const {from, to, indices} = selection;
    const center = (viewport[0] + viewport[2]) / 2;
    const inView = p => {
      const lon = p.lon + 360 * Math.round((center - p.lon) / 360);
      return lon >= viewport[0] && lon <= viewport[2] && p.lat >= viewport[1] && p.lat <= viewport[3];
    };
    const firstRow = Math.max(0, Math.min(rows - 1, Math.floor((viewport[1] + 90) / 180 * rows)));
    const lastRow = Math.max(0, Math.min(rows - 1, Math.floor((viewport[3] + 90) / 180 * rows)));
    const ranges = []; let candidates = 0;
    for (let x = 0; x < columns; x++) {
      const lon = (x + .5) / columns * 360 - 180;
      const wrapped = lon + 360 * Math.round((center - lon) / 360);
      if (wrapped + 180 / columns < viewport[0] || wrapped - 180 / columns > viewport[2]) continue;
      for (let y = firstRow; y <= lastRow; y++) {
        const cell = y * columns + x, a = offsets[cell], b = offsets[cell + 1];
        if (a !== b) { ranges.push([a, b]); candidates += b - a; }
      }
    }
    const visible = mode === 'route' ? null : new Uint32Array(Math.min(candidates, indices.length)); let visibleCount = 0;
    if (candidates < indices.length / 2) {
      for (const [a, b] of ranges) for (let j = a; j < b; j++) {
        const i = order[j];
        if (i >= from && i < to && filter.mask[i] && inView(points[i])) { if (visible) visible[visibleCount] = i; visibleCount++; }
      }
      // Chronological ordering preserves representative sampling and density sums.
      visible?.subarray(0, visibleCount).sort();
    } else {
      for (const i of indices) if (inView(points[i])) { if (visible) visible[visibleCount] = i; visibleCount++; }
    }
    let density = EMPTY, dots = EMPTY, routes = EMPTY, peak = 1, drawn = 0;
    if (mode === 'points') {
      const stride = Math.max(1, Math.ceil(visibleCount / 20_000)), features = [];
      for (let j = 0; j < visibleCount; j += stride) {
        const p = points[visible[j]];
        features.push({type: 'Feature', properties: {time: p.t, accuracy: p.accuracy}, geometry: {type: 'Point', coordinates: [p.lon, p.lat]}});
      }
      dots = collection(features); drawn = features.length;
    } else if (mode === 'route') {
      if (!selection.routes) selection.routes = collection(selection.runs.map(([a, b]) => {
        const coordinates = [], step = Math.max(1, Math.ceil((b - a) / 10_000));
        for (let j = a; j < b; j += step) { const p = points[indices[j]]; coordinates.push([p.lon, p.lat]); }
        if ((b - a - 1) % step) { const p = points[indices[b - 1]]; coordinates.push([p.lon, p.lat]); }
        return {type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates}};
      }));
      routes = selection.routes; drawn = routes.features.length;
    } else {
      const scale = 512 * 2 ** Math.floor(Math.max(0, Math.min(20, zoom)));
      const size = (mode === 'hex' ? Math.max(8, radius) : Math.max(3, radius / 4)) / scale;
      const grid = new Map(), bins = [];
      for (let j = 0; j < visibleCount; j++) {
        const i = visible[j], p = points[i], lon = p.lon + 360 * Math.round((center - p.lon) / 360);
        const x = (lon + 180) / 360, y = projectedY[i];
        let a, b, cx, cy;
        if (mode === 'hex') {
          [a, b] = hexRound((Math.sqrt(3) / 3 * x - y / 3) / size, 2 / 3 * y / size);
          cx = size * Math.sqrt(3) * (a + b / 2); cy = size * 1.5 * b;
        } else { a = Math.floor(x / size); b = Math.floor(y / size); cx = (a + .5) * size; cy = (b + .5) * size; }
        let column = grid.get(a);
        if (!column) { column = new Map(); grid.set(a, column); }
        let bin = column.get(b);
        if (!bin) { bin = {x: cx, y: cy, count: 0, duration: 0, days: 0, lastDay: undefined}; column.set(b, bin); bins.push(bin); }
        bin.count++;
        // Visible indices are chronological, so each bin sees UTC days in order.
        const day = Math.floor(p.t / DAY);
        if (day !== bin.lastDay) { bin.days++; bin.lastDay = day; }
        bin.duration += Math.max(0, Math.min(p.t + p.duration, end + 1, (day + 1) * DAY + (hourEnd - 24) * 3_600_000) - p.t) / 60_000;
      }
      const value = b => metric === 'days' ? b.days : metric === 'time' ? b.duration : b.count;
      const values = bins.map(value).filter(v => v > 0).sort((a, b) => a - b);
      peak = values[Math.floor((values.length - 1) * .95)] || 1;
      const features = [];
      for (const b of bins) {
        const v = value(b);
        if (!v) continue;
        const properties = {value: v, count: b.count, days: b.days, minutes: Math.round(b.duration), weight: Math.min(1, Math.sqrt(v / peak))};
        const coordinates = mode === 'hex' ? [Array.from({length: 7}, (_, i) => unproject(b.x + size * Math.cos(rad * (60 * (i % 6) - 30)), b.y + size * Math.sin(rad * (60 * (i % 6) - 30))))] : unproject(b.x, b.y);
        features.push({type: 'Feature', properties, geometry: {type: mode === 'hex' ? 'Polygon' : 'Point', coordinates}});
      }
      density = collection(features); drawn = features.length;
    }
    return {density, dots, routes, count: selection.count, visible: visibleCount, days: selection.days, km: selection.km, bounds: selection.bounds, histogram: filter.histogram, peak, drawn};
  };
}

// Convenience for one-off queries. The worker retains createHistoryQuery's index.
export function queryHistory(points, options) { return createHistoryQuery(points)(options); }

// Bounded strings and feature batches avoid the JS string-size limit on large exports.
export function exportHistory(points, {start = -Infinity, end = Infinity, accuracy = 0, hourStart = 0, hourEnd = 24} = {}) {
  const parts = ['{"type":"FeatureCollection","features":['];
  let batch = [], count = 0;
  const flush = () => {
    if (!batch.length) return;
    parts.push(count ? ',' : '', JSON.stringify(batch).slice(1, -1));
    count += batch.length; batch = [];
  };
  for (let i = lowerBound(points, start); i < points.length && points[i].t <= end; i++) {
    const p = points[i];
    if (!accepts(p, accuracy, hourStart, hourEnd)) continue;
    batch.push({type: 'Feature', properties: {timestamp: new Date(p.t).toISOString(), accuracy: p.accuracy}, geometry: {type: 'Point', coordinates: [p.lon, p.lat]}});
    if (batch.length === 2048) flush();
  }
  flush(); parts.push(']}');
  return {blob: new Blob(parts, {type: 'application/geo+json'}), count, start, end};
}
