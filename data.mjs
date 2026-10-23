// Pure import and geospatial functions shared by the worker and Node tests.
export const DAY = 86_400_000;
// Date windows have inclusive endpoints. Keep their width when reaching a data boundary.
export function shiftPeriod(start, end, min, max, direction) {
  const shift = Math.max(min - start, Math.min(max - end, direction * (end - start + 1)));
  return {start: start + shift, end: end + shift};
}
export const MAX_POINTS = 2_000_000;
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
export function parseHistory(data) {
  const points = [];
  let skipped = 0;
  const add = (coords, time, accuracy, duration = 0) => {
    const [lon, lat] = Array.isArray(coords) ? coords : [NaN, NaN], t = timestamp(time), a = number(accuracy);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !Number.isFinite(t) || Math.abs(t) > 8.64e15) { skipped++; return; }
    if (points.length >= MAX_POINTS) throw new Error(`The import exceeds ${MAX_POINTS.toLocaleString('en')} points. Split the export into smaller files.`);
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
  if (!points.length) throw new Error('No valid timestamped locations were found in this file.');
  return {points, skipped};
}
export function preparePoints(points) {
  points.sort((a, b) => a.t - b.t || a.lat - b.lat || a.lon - b.lon);
  const unique = [];
  let duplicates = 0;
  for (const p of points) {
    const last = unique.at(-1);
    if (last && last.t === p.t && last.lat === p.lat && last.lon === p.lon) {
      last.duration = Math.max(last.duration, p.duration);
      if (p.accuracy !== null && (last.accuracy === null || p.accuracy < last.accuracy)) last.accuracy = p.accuracy;
      duplicates++; continue;
    }
    unique.push({...p});
  }
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
export function project(lon, lat) {
  const s = Math.sin(Math.max(-85.051129, Math.min(85.051129, lat)) * rad);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}
function unproject(x, y) { return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / rad]; }
export function wrappedBounds(points) {
  if (!points.length) return null;
  const lons = points.map(p => (p.lon + 360) % 360).sort((a, b) => a - b);
  let gap = -1, index = 0, south = 90, north = -90;
  for (let i = 0; i < lons.length; i++) {
    const size = (i === lons.length - 1 ? lons[0] + 360 : lons[i + 1]) - lons[i];
    if (size > gap) { gap = size; index = i; }
  }
  let west = lons[(index + 1) % lons.length], east = lons[index];
  if (east < west) east += 360;
  if (west > 180) { west -= 360; east -= 360; }
  for (const p of points) { south = Math.min(south, p.lat); north = Math.max(north, p.lat); }
  return [[west, Math.max(-85, Math.min(85, south))], [east, Math.min(85, Math.max(-85, north))]];
}
function lowerBound(points, time) {
  let lo = 0, hi = points.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (points[m].t < time) lo = m + 1; else hi = m; }
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
export function queryHistory(points, options = {}) {
  const {start = -Infinity, end = Infinity, accuracy = 0, hourStart = 0, hourEnd = 24, metric = 'records', mode = 'heat', zoom = 10, radius = 24, viewport = [-180, -90, 180, 90]} = options;
  const selected = [], days = new Set(), histogram = Array(64).fill(0);
  const min = points[0]?.t ?? 0, max = points.at(-1)?.t ?? 0;
  const accepts = p => (!accuracy || p.accuracy === null || p.accuracy <= accuracy) && new Date(p.t).getUTCHours() >= hourStart && new Date(p.t).getUTCHours() < hourEnd;
  for (const p of points) if (accepts(p)) histogram[Math.min(63, Math.floor((p.t - min) / Math.max(1, max - min) * 64))]++;
  for (let i = lowerBound(points, start); i < points.length && points[i].t <= end; i++) {
    const p = points[i];
    if (accepts(p)) { selected.push({p, i}); days.add(Math.floor(p.t / DAY)); }
  }
  const scale = 512 * 2 ** Math.floor(Math.max(0, Math.min(20, zoom)));
  const size = (mode === 'hex' ? Math.max(8, radius) : Math.max(3, radius / 4)) / scale;
  const bins = new Map(), visible = [], routes = [], route = [];
  let km = 0, previous = null;
  const finishRoute = () => { if (route.length > 1) routes.push({type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: route.splice(0)}}); else route.length = 0; };
  const center = (viewport[0] + viewport[2]) / 2;
  for (const {p, i} of selected) {
    if (previous) {
      const dt = p.t - previous.p.t, d = distance(previous.p, p);
      if (i === previous.i + 1 && dt > 0 && dt <= 6 * 3_600_000 && d / (dt / 3_600_000) <= 1000 && Math.abs(p.lon - previous.p.lon) < 180) km += d;
      else finishRoute();
    }
    if (mode === 'route') route.push([p.lon, p.lat]);
    previous = {p, i};
    const lon = p.lon + 360 * Math.round((center - p.lon) / 360);
    if (lon < viewport[0] || lon > viewport[2] || p.lat < viewport[1] || p.lat > viewport[3]) continue;
    visible.push(p);
    const [x, y] = project(lon, p.lat);
    let a, b, cx, cy;
    if (mode === 'hex') {
      [a, b] = hexRound((Math.sqrt(3) / 3 * x - y / 3) / size, 2 / 3 * y / size);
      cx = size * Math.sqrt(3) * (a + b / 2); cy = size * 1.5 * b;
    } else { a = Math.floor(x / size); b = Math.floor(y / size); cx = (a + 0.5) * size; cy = (b + 0.5) * size; }
    const key = `${a}:${b}`;
    let bin = bins.get(key);
    if (!bin) { bin = {x: cx, y: cy, count: 0, duration: 0, days: new Set()}; bins.set(key, bin); }
    bin.count++; bin.days.add(Math.floor(p.t / DAY));
    bin.duration += Math.max(0, Math.min(p.t + p.duration, end + 1, (Math.floor(p.t / DAY) + 1) * DAY + (hourEnd - 24) * 3_600_000) - p.t) / 60_000;
  }
  finishRoute();
  const values = [...bins.values()].map(b => metric === 'days' ? b.days.size : metric === 'time' ? b.duration : b.count).filter(v => v > 0).sort((a, b) => a - b);
  const peak = values[Math.floor((values.length - 1) * 0.95)] || 1;
  const features = [];
  for (const b of bins.values()) {
    const value = metric === 'days' ? b.days.size : metric === 'time' ? b.duration : b.count;
    if (!value) continue;
    const properties = {value, count: b.count, days: b.days.size, minutes: Math.round(b.duration), weight: Math.min(1, Math.sqrt(value / peak))};
    const coordinates = mode === 'hex' ? [Array.from({length: 7}, (_, i) => unproject(b.x + size * Math.cos(rad * (60 * (i % 6) - 30)), b.y + size * Math.sin(rad * (60 * (i % 6) - 30))))] : unproject(b.x, b.y);
    features.push({type: 'Feature', properties, geometry: {type: mode === 'hex' ? 'Polygon' : 'Point', coordinates}});
  }
  const stride = Math.max(1, Math.ceil(visible.length / 20_000));
  return {
    density: collection(features),
    dots: collection(mode === 'points' ? visible.filter((_, i) => i % stride === 0).map(p => ({type: 'Feature', properties: {time: p.t, accuracy: p.accuracy}, geometry: {type: 'Point', coordinates: [p.lon, p.lat]}})) : []),
    // Simplify long paths for the browser; preserve endpoints and every break.
    routes: collection(mode === 'route' ? routes.map(f => { const c = f.geometry.coordinates, step = Math.max(1, Math.ceil(c.length / 10_000)); f.geometry.coordinates = c.filter((_, i) => i % step === 0 || i === c.length - 1); return f; }) : []),
    count: selected.length, visible: visible.length, days: days.size, km: Math.round(km), histogram, peak,
    bounds: wrappedBounds(selected.map(s => s.p)), drawn: mode === 'points' ? Math.ceil(visible.length / stride) : features.length,
  };
}
