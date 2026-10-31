// Pure import and geospatial functions shared by the worker and Node tests.
import {createDeviceIndex, createMotionQuery, deviceKey, SOURCE_NAMES} from './motion.mjs?v=1';
export const DAY = 86_400_000;
export const HISTOGRAM_BINS = 64;
export const SPEED_STOPS = Object.freeze([0, 5, 20, 50, 130, 1000]);
export const SPEED_UNKNOWN = '#8b929a';
export const DEFAULT_JUMP_TOLERANCE = 15;
// Date windows have inclusive endpoints. Keep their width when reaching a data boundary.
export function shiftPeriod(start, end, min, max, direction) {
  const shift = Math.max(min - start, Math.min(max - end, direction * (end - start + 1)));
  return {start: start + shift, end: end + shift};
}
export const MAX_POINTS = 5_000_000;
const rad = Math.PI / 180;
const SOURCE_CODES = Object.freeze({GPS: 1, WIFI: 2, CELL: 3, NETWORK: 4, FUSED: 5});
const motionOptions = options => options.trackMode ? {...options, excludeJumps: options.trackMode !== 'off', driftWindow: Number.isFinite(options.driftWindow) ? Math.max(15, Math.min(600, Math.round(options.driftWindow))) : 60} : options;
const streamRank = p => p.stream?.source === -1 ? 0 : p.stream?.source === 6 ? 1 : p.stream?.source ? 3 : 2;
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
  if (value?.latLng ?? value?.LatLng) return coordinate(value.latLng ?? value.LatLng);
  if (value?.latitudeE7 !== undefined || value?.latE7 !== undefined) return [number(value.longitudeE7 ?? value.lngE7) / 1e7, number(value.latitudeE7 ?? value.latE7) / 1e7];
  return [number(value?.longitude ?? value?.lng), number(value?.latitude ?? value?.lat)];
}
export function parseHistory(data, {allowEmpty = false, streams = new Map()} = {}) {
  const points = [];
  let skipped = 0;
  const identity = (value, prefix = 'google:') => (typeof value === 'string' && value.trim() && value.length <= 128 || Number.isSafeInteger(value)) ? prefix + String(value).trim() : '';
  const stream = (device = '', source = 0) => {
    if (!device && !source) return undefined;
    let sources = streams.get(device); if (!sources) { sources = new Map(); streams.set(device, sources); }
    if (!sources.has(source)) sources.set(source, {device, source});
    return sources.get(source);
  };
  const sourceCode = value => SOURCE_CODES[typeof value === 'string' ? value.toUpperCase() : ''] ?? 0;
  const add = (coords, time, accuracy, duration = 0, altitude, recordedSpeed, origin) => {
    const [lon, lat, z] = Array.isArray(coords) ? coords : [NaN, NaN], t = timestamp(time), a = number(accuracy), h = number(altitude ?? z), speed = number(recordedSpeed);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !Number.isFinite(t) || Math.abs(t) > 8.64e15) { skipped++; return; }
    if (points.length >= MAX_POINTS) throw new Error(`The import exceeds ${MAX_POINTS.toLocaleString('en')} points. Choose a smaller date range.`);
    points.push({lon, lat, t, accuracy: Number.isFinite(a) && a >= 0 ? a : null, duration: Math.max(0, Math.min(duration, 8.64e15 - t)) || 0, ...(Number.isFinite(h) ? {altitude: h} : {}), ...(Number.isFinite(speed) && speed >= 0 && speed <= 1000 ? {recordedSpeed: speed} : {}), ...(origin ? {stream: origin} : {})});
  };
  const segment = entry => {
    if (!entry || typeof entry !== 'object') { skipped++; return; }
    const visit = entry.visit ?? entry.placeVisit;
    const duration = entry.duration ?? visit?.duration ?? entry.activitySegment?.duration;
    const start = timestamp(entry.startTime ?? duration?.startTimestamp ?? duration?.startTimestampMs);
    const end = timestamp(entry.endTime ?? duration?.endTimestamp ?? duration?.endTimestampMs);
    const device = identity(entry.deviceTag);
    if (visit) add(coordinate(visit.topCandidate?.placeLocation ?? visit.location), start, undefined, Number.isFinite(end) ? end - start : 0, undefined, undefined, stream(device, -1));
    const activity = entry.activity ?? entry.activitySegment;
    const path = entry.timelinePath ?? activity?.simplifiedRawPath?.points ?? activity?.waypointPath?.waypoints;
    if (Array.isArray(path) && path.length) {
      for (const p of path) {
        if (!p || typeof p !== 'object') { skipped++; continue; }
        let t = p.time ?? p.timestamp ?? p.timestampMs;
        if (t === undefined && p.durationMinutesOffsetFromStartTime !== undefined) t = start + number(p.durationMinutesOffsetFromStartTime) * 60_000;
        // Untimed waypoints cannot be used as timestamped observations.
        add(coordinate(p.point ?? p), t, p.accuracyMeters ?? p.accuracy, 0, p.altitudeMeters ?? p.altitude, p.speedMetersPerSecond === undefined ? undefined : number(p.speedMetersPerSecond) * 3.6, stream(device, 6));
      }
    }
    if (activity) {
      add(coordinate(activity.start ?? activity.startLocation), start, undefined, 0, undefined, undefined, stream(device, -1));
      add(coordinate(activity.end ?? activity.endLocation), end, undefined, 0, undefined, undefined, stream(device, -1));
    }
  };
  if (data?.format === 'delta-compressed') {
    const invalid = () => { throw new Error('Invalid delta-compressed history.'); };
    if ((data.version !== undefined && data.version !== 2) || !Array.isArray(data.base) || data.base.length !== 3 || !Array.isArray(data.data) || data.data.length !== 3 || !data.data.every(Array.isArray) || !data.data.every(a => a.length === data.data[0].length)) invalid();
    const count = data.data[0].length + 1;
    if (count > MAX_POINTS) throw new Error(`The import exceeds ${MAX_POINTS.toLocaleString('en')} points. Choose a smaller date range.`);
    for (const key of ['accuracy', 'duration', 'altitude', 'recordedSpeed']) {
      const values = data[key];
      if (values !== undefined && (!Array.isArray(values) || values.length !== count || values.some(v => !(key !== 'duration' && v === null) && (typeof v !== 'number' || !Number.isFinite(v) || key !== 'altitude' && v < 0 || key === 'recordedSpeed' && v > 1000)))) invalid();
    }
    if (data.streams !== undefined || data.stream !== undefined) {
      if (!Array.isArray(data.streams) || data.streams.length > count || !Array.isArray(data.stream) || data.stream.length !== count) invalid();
      for (const entry of data.streams) if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Number.isInteger(entry.source) || entry.source < -1 || entry.source > 6 || typeof entry.device !== 'string' || entry.device.length > 128) invalid();
      if (data.stream.some(v => !Number.isInteger(v) || v < 0 || v > data.streams.length)) invalid();
    }
    let [lat, lon, t] = data.base.map(number);
    const append = i => {
      const before = points.length;
      const origin = data.stream?.[i] ? data.streams[data.stream[i] - 1] : null;
      add([lon / 1e7, lat / 1e7], t, data.accuracy?.[i], data.duration?.[i], data.altitude?.[i], data.recordedSpeed?.[i], origin ? stream(origin.device, origin.source) : undefined);
      if (points.length === before) invalid(); // A corrupt delta cannot be skipped safely.
    };
    append(0);
    for (let i = 0; i < data.data[0].length; i++) {
      lat += number(data.data[0][i]); lon += number(data.data[1][i]); t += number(data.data[2][i]);
      append(i + 1);
    }
  } else if (Array.isArray(data?.locations)) {
    for (const p of data.locations) {
      if (!p || typeof p !== 'object') { skipped++; continue; }
      add(coordinate(p), p.timestamp ?? p.timestampMs, p.accuracy, 0, p.altitudeMeters ?? p.altitude, p.speedMetersPerSecond === undefined ? undefined : number(p.speedMetersPerSecond) * 3.6, stream(identity(p.deviceTag), sourceCode(p.source)));
    }
  } else if (Array.isArray(data?.semanticSegments) || Array.isArray(data?.rawSignals)) {
    for (const key of ['semanticSegments', 'rawSignals']) if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error('Invalid Timeline collection.');
    for (const p of data.semanticSegments ?? []) segment(p);
    for (const entry of data.rawSignals ?? []) if (entry?.position) {
      const p = entry.position;
      add(coordinate(p), p.timestamp, p.accuracyMeters, 0, p.altitudeMeters, p.speedMetersPerSecond === undefined ? undefined : number(p.speedMetersPerSecond) * 3.6, stream(identity(p.deviceTag ?? entry.deviceTag), sourceCode(p.provider ?? p.source)));
    }
  } else if (Array.isArray(data?.semanticSegments ?? data?.timelineObjects ?? data)) {
    for (const p of data.semanticSegments ?? data.timelineObjects ?? data) segment(p);
  } else if (data?.type === 'FeatureCollection' && Array.isArray(data.features)) {
    for (const f of data.features) {
      if (f?.geometry?.type !== 'Point') { skipped++; continue; }
      const p = f.properties ?? {}, android = typeof p.provider === 'string' && Number.isFinite(p.time_long);
      const speed = p.speedMetersPerSecond ?? (android ? p.speed : undefined);
      add(f.geometry.coordinates, p.timestamp ?? p.time ?? p.time_long, p.accuracy, 0, p.altitudeMeters ?? p.altitude ?? p.elevation ?? p.ele, speed === undefined ? undefined : number(speed) * 3.6, stream(p.deviceTag !== undefined ? identity(p.deviceTag) : identity(p.deviceId, 'id:'), sourceCode(p.provider)));
    }
  } else throw new Error('Unsupported JSON. Use Google Records, Timeline, semantic history, delta-compressed history, or timestamped GeoJSON points.');
  if (!points.length && !allowEmpty) throw new Error('No valid timestamped locations were found in this file.');
  return {points, skipped};
}
export function preparePoints(points, {inferStationary = true} = {}) {
  points.sort((a, b) => a.t - b.t || a.lat - b.lat || a.lon - b.lon || (deviceKey(a) < deviceKey(b) ? -1 : deviceKey(a) > deviceKey(b) ? 1 : 0));
  // Compact the sorted array in place rather than cloning millions of objects.
  const unique = points;
  let duplicates = 0, length = 0, multipleDevices = false;
  for (const p of points) {
    const last = unique[length - 1];
    if (length && deviceKey(p) !== deviceKey(unique[0])) multipleDevices = true;
    if (last && last.t === p.t && last.lat === p.lat && last.lon === p.lon && deviceKey(last) === deviceKey(p)) {
      last.duration = Math.max(last.duration, p.duration);
      if (p.accuracy !== null && (last.accuracy === null || p.accuracy < last.accuracy)) {
        last.accuracy = p.accuracy;
        for (const key of ['altitude', 'recordedSpeed']) if (p[key] != null) last[key] = p[key];
      }
      for (const key of ['altitude', 'recordedSpeed']) if (last[key] == null && p[key] != null) last[key] = p[key];
      if (streamRank(p) > streamRank(last)) last.stream = p.stream;
      if (last.stream === undefined) delete last.stream;
      duplicates++; continue;
    }
    unique[length++] = p;
  }
  unique.length = length;
  // Stationary density excludes travel. Place history estimates area time separately.
  if (inferStationary) {
    const previous = multipleDevices ? new Map() : null;
    for (let i = 0; i < unique.length; i++) {
      const next = unique[i], p = previous ? previous.get(deviceKey(next)) : unique[i - 1];
      if (p) { const dt = next.t - p.t; if (!p.duration && dt > 0 && dt <= 30 * 60_000 && distance(p, next) <= 0.2) p.duration = dt; }
      previous?.set(deviceKey(next), next);
    }
  }
  return {points: unique, duplicates};
}
export function distance(a, b) {
  const lat = (b.lat - a.lat) * rad, lon = (b.lon - a.lon) * rad;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(lon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
// Accuracy filters visibility, not speed. Keep interval and jump safeguards;
// device speed, when present, is already normalized to km/h during import.
export function intervalSpeed(a, b) {
  if (deviceKey(a) !== deviceKey(b) || (a.stream?.source ?? 0) !== (b.stream?.source ?? 0) || a.stream?.source === -1) return null;
  const elapsed = b.t - a.t;
  if (elapsed <= 0 || elapsed > 15 * 60_000) return null;
  const km = distance(a, b), speed = km * 3_600_000 / elapsed;
  if (speed > 1000) return null;
  return a.recordedSpeed != null && b.recordedSpeed != null ? (a.recordedSpeed + b.recordedSpeed) / 2 : speed;
}
// Device measurements are independent of display filters. Estimate missing speed
// from temporal neighbours, skipping quality outliers without a per-point column.
export function pointSpeed(points, i, excluded, devices) {
  const p = points[i];
  if (p.stream?.source === -1) return null;
  if (p.recordedSpeed != null) return p.recordedSpeed;
  const neighbor = direction => {
    let next = devices ? devices.neighbor(i, direction) : i + direction;
    while (next >= 0 && next < points.length) {
      if (Math.abs(points[next].t - p.t) > 15 * 60_000) return -1;
      if (!excluded?.[next] && deviceKey(points[next]) === deviceKey(p) && (points[next].stream?.source ?? 0) === (p.stream?.source ?? 0)) return next;
      next = devices ? devices.neighbor(next, direction) : next + direction;
    }
    return -1;
  };
  const left = neighbor(-1), right = neighbor(1);
  const before = left >= 0 ? intervalSpeed(points[left], p) : null;
  const after = right >= 0 ? intervalSpeed(p, points[right]) : null;
  const dt1 = before === null ? 0 : p.t - points[left].t, dt2 = after === null ? 0 : points[right].t - p.t;
  return dt1 + dt2 ? ((before ?? 0) * dt1 + (after ?? 0) * dt2) / (dt1 + dt2) : null;
}
function projectY(lat) {
  const s = Math.sin(Math.max(-85.051129, Math.min(85.051129, lat)) * rad);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}
export function project(lon, lat) { return [(lon + 180) / 360, projectY(lat)]; }
function unproject(x, y) { return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / rad]; }
export function wrappedBounds(points, indices = null, runs = null) {
  const length = runs ? runs.reduce((n, [a, b]) => n + b - a, 0) : indices?.length ?? points.length;
  if (!length) return null;
  const lons = new Float64Array(length);
  let cursor = 0, south = 90, north = -90;
  for (const [a, b] of runs ?? [[0, length]]) for (let i = a; i < b; i++) {
    const p = points[indices ? indices[i] : i];
    lons[cursor++] = (p.lon + 360) % 360;
    south = Math.min(south, p.lat); north = Math.max(north, p.lat);
  }
  lons.sort();
  let gap = -1, index = 0;
  for (let i = 0; i < lons.length; i++) {
    const size = (i === lons.length - 1 ? lons[0] + 360 : lons[i + 1]) - lons[i];
    if (size > gap) { gap = size; index = i; }
  }
  let west = lons[(index + 1) % lons.length], east = lons[index];
  if (east < west) east += 360;
  if (west > 180) { west -= 360; east -= 360; }
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
function selectedMillis(from, until, {start = -Infinity, end = Infinity, hourStart = 0, hourEnd = 24}) {
  from = Math.max(from, start); until = Math.min(until, end + 1);
  if (until <= from) return 0;
  if (hourStart === 0 && hourEnd === 24) return until - from;
  const span = (hourEnd - hourStart) * 3_600_000;
  const elapsed = t => Math.floor(t / DAY) * span + Math.max(0, Math.min(span, t - Math.floor(t / DAY) * DAY - hourStart * 3_600_000));
  return elapsed(until) - elapsed(from);
}
function accepts(p, accuracy, hourStart, hourEnd, accuracyMin = 0, accuracyUnknown = true) {
  if (p.accuracy == null ? !accuracyUnknown : p.accuracy < accuracyMin || accuracy && !(p.accuracy < accuracy)) return false;
  if (hourStart === 0 && hourEnd === 24) return true;
  const h = hour(p.t);
  return h >= hourStart && h < hourEnd;
}

const uncertainty = (a, b) => Math.max(.006, ((a.accuracy ?? 0) + (b.accuracy ?? 0)) / 1000);
const impossible = (a, b, km = distance(a, b)) => b.t >= a.t && b.t - a.t <= 6 * 3_600_000 && km - uncertainty(a, b) > (b.t - a.t) / 3_600_000 * 1000;
// One byte per observation. First identify isolated spikes, preserving their
// neighbours. Unresolvable two-point conflicts are conservatively excluded.
export function jumpFlags(points, options = {}) {
  const firstDevice = points.length ? deviceKey(points[0]) : '', firstSource = points[0]?.stream?.source ?? 0;
  if (points.every(p => deviceKey(p) === firstDevice && (p.stream?.source ?? 0) === firstSource)) return firstSource === -1 ? new Uint8Array(points.length) : detectJumps(points, options);
  const byDevice = new Map(), groups = [];
  const groupFor = p => {
    const device = deviceKey(p), source = p.stream?.source ?? 0;
    if (source === -1) return null;
    let sources = byDevice.get(device); if (!sources) { sources = new Map(); byDevice.set(device, sources); }
    let group = sources.get(source);
    if (!group) { group = {count: 0}; sources.set(source, group); groups.push(group); }
    return group;
  };
  for (const p of points) { const group = groupFor(p); if (group) group.count++; }
  let size = 0; for (const group of groups) { group.from = group.cursor = size; size += group.count; }
  const indices = new Uint32Array(size), flags = new Uint8Array(points.length);
  for (let i = 0; i < points.length; i++) { const group = groupFor(points[i]); if (group) indices[group.cursor++] = i; }
  for (const group of groups) {
    const local = detectJumps(points, options, i => points[indices[group.from + i]], group.count);
    for (let i = 0; i < group.count; i++) flags[indices[group.from + i]] = local[i];
  }
  return flags;
}

function detectJumps(points, {tolerance = DEFAULT_JUMP_TOLERANCE} = {}, at = i => points[i], length = points.length) {
  tolerance = Number.isFinite(tolerance) ? Math.max(0, Math.min(200, tolerance)) : DEFAULT_JUMP_TOLERANCE;
  const flags = new Uint8Array(length);
  for (let i = 1; i < length - 1; i++) {
    if (flags[i - 1]) continue;
    const a = at(i - 1), b = at(i), c = at(i + 1);
    const dt1 = (b.t - a.t) / 1000, dt2 = (c.t - b.t) / 1000;
    if (dt1 < 0 || dt2 < 0 || dt1 + dt2 === 0 || dt1 > 21600 || dt2 > 21600) continue;
    const ab = distance(a, b), bc = distance(b, c), speedSpike = impossible(a, b, ab) && impossible(b, c, bc);
    if (!speedSpike && (dt1 <= 0 || dt2 <= 0 || dt1 > 120 || dt2 > 120)) continue;
    const ac = distance(a, c);
    if (impossible(a, c, ac)) continue;
    if (speedSpike) { flags[i] = 1; continue; }
    const excess = ab + bc - ac;
    const deltaV = Math.sqrt(Math.max(0, ab * ab / (dt1 * dt1) + bc * bc / (dt2 * dt2) - (ac * ac - ab * ab - bc * bc) / (dt1 * dt2))) * 1000;
    if (excess > Math.max(.05, 2 * (uncertainty(a, b) + uncertainty(b, c))) && deltaV * 2 / (dt1 + dt2) > 15) flags[i] = 1;
  }
  let previous = -1;
  for (let i = 1; i < length; i++) {
    if (flags[i - 1]) continue;
    if (!flags[i] && impossible(at(i - 1), at(i))) {
      const a = at(i - 1), b = at(i);
      // A stale location can repeat for several fixes. Reject the short burst
      // only when both transitions are impossible and bypassing it is plausible.
      let rejoined = -1, last = i;
      for (let j = i + 1, checked = 0; j < length && checked < 8; j++) {
        if (flags[j]) continue;
        const c = at(j);
        if (c.t - a.t > 6 * 3_600_000) break;
        checked++;
        if (!impossible(a, c)) { if (impossible(at(last), c)) rejoined = j; break; }
        last = j;
      }
      if (rejoined >= 0) {
        flags.fill(1, i, rejoined); i = rejoined - 1; continue;
      }
      const before = previous >= 0 && a.t > at(previous).t && a.t - at(previous).t <= 120_000 && !impossible(at(previous), a);
      const after = i + 1 < length && !flags[i + 1] && at(i + 1).t > b.t && at(i + 1).t - b.t <= 120_000 && !impossible(b, at(i + 1));
      if (before && !after || (b.accuracy ?? 0) > Math.max(50, 3 * (a.accuracy ?? 0))) flags[i] = 1;
      else if (after && !before || (a.accuracy ?? 0) > Math.max(50, 3 * (b.accuracy ?? 0))) flags[i - 1] = 1;
      else flags[i - 1] = flags[i] = 1;
    }
    if (!flags[i - 1]) previous = i - 1;
  }
  // Compare original neighbouring segments, before any display filters. A tiny
  // ring reuses distances; the two scratch arrays hold at most eight samples.
  // Soft decisions never alter the context, so raising the allowance can only
  // retain more observations, without adding a score/property to each point.
  const km = new Float64Array(16), samples = new Float64Array(8), deviations = new Float64Array(8);
  const context = 15 * 60_000;
  let loaded = 0;
  const median = (values, count) => count % 2 ? values[count >>> 1] : (values[count / 2 - 1] + values[count / 2]) / 2;
  for (let i = 1; i < length - 1; i++) {
    while (loaded < Math.min(length - 1, i + 5)) { loaded++; km[loaded & 15] = distance(at(loaded - 1), at(loaded)); }
    if (flags[i]) continue;
    const a = at(i - 1), b = at(i), c = at(i + 1), dt1 = b.t - a.t, dt2 = c.t - b.t;
    if (dt1 <= 0 || dt2 <= 0 || dt1 > context || dt2 > context) continue;
    const ab = km[i & 15], bc = km[(i + 1) & 15], speed = Math.min(ab * 3_600_000 / dt1, bc * 3_600_000 / dt2);
    if (speed <= tolerance) continue;
    let count = 0, before = 0;
    for (let side = -1; side <= 1; side += 2) {
      for (let offset = 0; offset < 4; offset++) {
        const j = side < 0 ? i - 1 - offset : i + 2 + offset;
        if (j < 1 || j >= length) break;
        const first = at(j - 1), last = at(j), elapsed = last.t - first.t;
        if (elapsed > context || Math.max(Math.abs(b.t - first.t), Math.abs(last.t - b.t)) > context) break;
        if (elapsed <= 0) continue;
        const value = km[j & 15] * 3_600_000 / elapsed;
        if (value <= 1000) { samples[count++] = value; if (side < 0) before++; }
      }
    }
    if (count < 4 || !before || before === count) continue;
    samples.fill(Infinity, count); samples.sort();
    const typical = median(samples, count);
    if (speed <= typical + tolerance) continue;
    for (let j = 0; j < count; j++) deviations[j] = Math.abs(samples[j] - typical);
    deviations.fill(Infinity, count); deviations.sort();
    const spread = 3 * 1.4826 * median(deviations, count);
    const limit = typical + Math.max(tolerance, spread);
    if (speed <= limit) continue;
    const ac = distance(a, c), bypass = Math.max(0, ac - uncertainty(a, c)) * 3_600_000 / (dt1 + dt2);
    const precision = Math.min(a.accuracy ?? Infinity, b.accuracy ?? Infinity, c.accuracy ?? Infinity);
    const resolution = Math.max(.01, Number.isFinite(precision) ? precision / 1000 : 0);
    // The bypass check has its own fixed noise allowance. Reusing the adjustable
    // limit here could make a looser setting accept a bypass and remove more fixes.
    if (bypass <= typical + Math.max(DEFAULT_JUMP_TOLERANCE, spread) && ab + bc - ac > resolution) flags[i] = 1;
  }
  return flags;
}

// Drawn areas use straight edges in the map's Mercator plane. Longitudes unwrap
// around the first corner so small areas crossing the dateline stay small.
export function placePolygon(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 3 || coordinates.length > 65) throw new Error('Choose an area with 3–64 corners.');
  const ring = [];
  for (const c of coordinates) {
    if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite) || Math.abs(c[0]) > 1e6 || Math.abs(c[1]) > 90) throw new Error('Invalid area coordinates.');
    let [lon, lat] = c;
    if (ring.length) lon += 360 * Math.round((ring.at(-1)[0] - lon) / 360);
    if (!ring.length || lon !== ring.at(-1)[0] || lat !== ring.at(-1)[1]) ring.push([lon, lat]);
  }
  if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
  if (ring.length < 3 || ring.length > 64) throw new Error('Choose an area with 3–64 distinct corners.');
  const xy = ring.map(([lon, lat]) => project(lon, lat));
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let area = 0;
  for (let i = 0; i < xy.length; i++) {
    const a = xy[i], b = xy[(i + 1) % xy.length];
    area += cross(xy[0], a, b);
    for (let j = i + 2; j < xy.length; j++) {
      if (i === 0 && j === xy.length - 1) continue;
      const c = xy[j], d = xy[(j + 1) % xy.length];
      if (cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0 && Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) && Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]))) throw new Error('Area edges cross. Undo a corner and try again.');
    }
  }
  if (Math.abs(area) < 1e-24 || Math.max(...ring.map(c => c[0])) - Math.min(...ring.map(c => c[0])) > 360) throw new Error('Choose a larger, non-overlapping area.');
  return {type: 'Polygon', coordinates: [[...ring, ring[0]]]};
}

// One compact index and one current filter/selection cache per committed dataset.
// Panning reuses selection statistics and the route-piece index. Visible route
// geometry is cached until its pieces or zoom level change.
export function createHistoryQuery(points) {
  const devices = createDeviceIndex(points), motionQuery = createMotionQuery(points, devices);
  const columns = 128, rows = 64, cells = columns * rows;
  const cell = p => Math.min(rows - 1, Math.floor((p.lat + 90) / 180 * rows)) * columns + Math.min(columns - 1, Math.floor((p.lon + 180) / 360 * columns));
  const offsets = new Uint32Array(cells + 1), order = new Uint32Array(points.length), projectedY = new Float64Array(points.length), intervalEnds = new Float64Array(Math.ceil(points.length / 256));
  const ranges = {accuracy: [0, 1000], altitude: [Infinity, -Infinity], speed: [0, 1000]};
  let latestEnd = -Infinity;
  for (let i = 0; i < points.length; i++) {
    offsets[cell(points[i]) + 1]++; projectedY[i] = projectY(points[i].lat);
    const p = points[i];
    latestEnd = Math.max(latestEnd, p.t + p.duration); intervalEnds[i >>> 8] = latestEnd;
    ranges.accuracy[1] = Math.max(ranges.accuracy[1], p.accuracy ?? 0);
    if (p.altitude != null) { ranges.altitude[0] = Math.min(ranges.altitude[0], p.altitude); ranges.altitude[1] = Math.max(ranges.altitude[1], p.altitude); }
  }
  for (let i = 1; i <= cells; i++) offsets[i] += offsets[i - 1];
  const cursors = offsets.slice();
  for (let i = 0; i < points.length; i++) order[cursors[cell(points[i])]++] = i;
  const min = points[0]?.t ?? 0, max = points.reduce((max, p) => Math.max(max, p.t + Math.max(0, p.duration - 1)), points.at(-1)?.t ?? 0);
  const firstDay = Math.floor(min / DAY), historyDays = Math.floor(max / DAY) - firstDay + 1;
  const histogramBins = Math.min(HISTOGRAM_BINS, historyDays);
  let filterKey, filter, selectionKey, selection, placeKey, placeResult;
  let jumps = new Uint8Array(0), jumpTolerance, motion = null, drift = false;
  const speedAt = (i, options) => drift ? Number.isFinite(motion.speeds[i]) ? motion.speeds[i] : null : pointSpeed(points, i, options.excludeJumps ? jumps : null, devices);
  const quality = (i, options) => {
    const {accuracy = 0, accuracyMin = 0, accuracyUnknown = true, excludeJumps = false, altitudeMin = null, altitudeMax = null, altitudeUnknown = true, speedMin = null, speedMax = null, speedUnknown = true} = options;
    const p = points[i];
    if (options.device != null && devices.idAt(i) !== options.device) return false;
    if (excludeJumps && jumps[i] || !accepts(p, accuracy, 0, 24, accuracyMin, accuracyUnknown)) return false;
    if (p.altitude == null ? !altitudeUnknown : altitudeMin !== null && p.altitude < altitudeMin || altitudeMax !== null && p.altitude > altitudeMax) return false;
    if (speedMin !== null || speedMax !== null || !speedUnknown) {
      const speed = speedAt(i, options);
      if (speed === null ? !speedUnknown : speedMin !== null && speed < speedMin || speedMax !== null && speed > speedMax) return false;
    }
    return true;
  };
  function intervalFrom(time) {
    let lo = 0, hi = intervalEnds.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (intervalEnds[m] <= time) lo = m + 1; else hi = m; }
    return Math.min(lo * 256, Math.max(0, lowerBound(points, time) - 1));
  }

  function ensureFilter(options) {
    const {accuracy = 0, hourStart = 0, hourEnd = 24, excludeJumps = false} = options;
    drift = options.trackMode === 'drift';
    const tolerance = Number.isFinite(options.jumpTolerance) ? Math.max(0, Math.min(200, options.jumpTolerance)) : DEFAULT_JUMP_TOLERANCE;
    if (excludeJumps && jumpTolerance !== tolerance) { jumps = jumpFlags(points, {tolerance}); jumpTolerance = tolerance; }
    if (drift) motion = motionQuery(options.driftWindow ?? 60, excludeJumps ? jumps : null);
    const nextFilterKey = JSON.stringify([options.device, options.trackMode, drift ? options.driftWindow : null, accuracy, options.accuracyMin, options.accuracyUnknown, hourStart, hourEnd, excludeJumps, excludeJumps ? tolerance : null, options.altitudeMin, options.altitudeMax, options.altitudeUnknown, options.speedMin, options.speedMax, options.speedUnknown]);
    if (filterKey !== nextFilterKey) {
      const bridge = accuracy || options.device != null || options.accuracyMin || options.altitudeMin != null || options.altitudeMax != null || options.speedMin != null || options.speedMax != null || options.accuracyUnknown === false || options.altitudeUnknown === false || options.speedUnknown === false;
      const mask = new Uint8Array(points.length), histogram = Array(histogramBins).fill(0), barriers = bridge ? new Uint32Array(points.length + 1) : null;
      for (let i = 0; i < points.length; i++) {
        const blocked = excludeJumps && jumps[i] || !accepts(points[i], 0, hourStart, hourEnd);
        if (barriers && !devices.order) barriers[i + 1] = barriers[i] + (blocked ? 1 : 0);
        if (!blocked && quality(i, options)) {
          mask[i] = 1;
          histogram[Math.floor((Math.floor(points[i].t / DAY) - firstDay) * histogramBins / historyDays)]++;
        }
      }
      if (barriers && devices.order) for (let at = 0; at < devices.order.length; at++) {
        const i = devices.order[at], blocked = excludeJumps && jumps[i] || !accepts(points[i], 0, hourStart, hourEnd);
        barriers[at + 1] = barriers[at] + (blocked ? 1 : 0);
      }
      filter = {mask, histogram, barriers}; filterKey = nextFilterKey;
    }
  }
  function pointFeature(index, options) {
    const p = points[index], speed = speedAt(index, options);
    return {type: 'Feature', properties: {index, time: p.t, accuracy: p.accuracy, speed: Number.isFinite(speed) ? speed : null, speedRecorded: !drift && p.recordedSpeed != null, ...(drift ? {speedSmoothed: true, reportedSpeed: p.recordedSpeed ?? null} : {}), altitude: p.altitude ?? null, ...(devices.groups.length > 1 ? {device: devices.labelAt(index)} : {}), ...(p.stream ? {source: p.stream.source < 0 ? 'Timeline event' : SOURCE_NAMES[p.stream.source]} : {})}, geometry: {type: 'Point', coordinates: [p.lon, p.lat]}};
  }
  function candidateRanges(viewport) {
    const center = (viewport[0] + viewport[2]) / 2;
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
    return {ranges, candidates};
  }
  function routeGeometry(options) {
    const {colorBy = 'time', zoom = 10, viewport = [-180, -90, 180, 90]} = options;
    const {indices, runs} = selection;
    if (selection.routeColor !== colorBy) { selection.routeParts = selection.routes = null; selection.routeColor = colorBy; }
    if (!selection.routeParts) {
      // Index small consecutive pieces without allocating their coordinates.
      // Colour averages stay fixed across pans; geometry retains their turns.
      const parts = [], step = colorBy === 'time' ? 128 : Math.max(1, Math.ceil(indices.length / 20_000));
      for (const [a, b] of runs) for (let from = a; from < b - 1; from += step) {
        const to = Math.min(from + step, b - 1), first = points[indices[from]], last = points[indices[to]];
        let west = first.lon, east = west, south = first.lat, north = south, weighted = 0, elapsed = 0;
        for (let k = from + 1; k <= to; k++) {
          const p = points[indices[k]];
          west = Math.min(west, p.lon); east = Math.max(east, p.lon); south = Math.min(south, p.lat); north = Math.max(north, p.lat);
          if (colorBy === 'time') continue;
          const previous = points[indices[k - 1]], dt = p.t - previous.t;
          let value;
          if (colorBy === 'altitude') value = previous.altitude != null && p.altitude != null ? (previous.altitude + p.altitude) / 2 : null;
          else if (drift) {
            const left = speedAt(indices[k - 1], options), right = speedAt(indices[k], options);
            value = left !== null && right !== null ? (left + right) / 2 : null;
          } else value = intervalSpeed(previous, p);
          if (value !== null) { weighted += value * dt; elapsed += dt; }
        }
        const value = elapsed && elapsed >= (last.t - first.t) / 2 ? weighted / elapsed : null;
        parts.push({from, to, run: a, west, east, south, north, value, time: first.t + (last.t - first.t) / 2});
      }
      selection.routeParts = parts;
    }
    const parts = selection.routeParts, visible = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i], shift = 360 * Math.ceil((viewport[0] - p.east) / 360);
      if (p.west + shift <= viewport[2] && p.south <= viewport[3] && p.north >= viewport[1]) visible.push(i);
    }
    const level = Number.isFinite(zoom) ? Math.floor(Math.max(0, Math.min(20, zoom))) : 10;
    if (selection.routes && selection.routeLevel === level && visible.length === selection.routeVisible.length && visible.every((value, i) => value === selection.routeVisible[i])) return selection.routes;
    const features = [], tolerance = (.5 / (512 * 2 ** level)) ** 2;
    let coordinates = [], keptLon, keptY;
    const append = (p, y, force = false) => {
      const dx = (p.lon - keptLon) / 360, dy = y - keptY, last = coordinates.at(-1);
      // Skip only subpixel movement, never every Nth recording. At fractional
      // zoom this stays below one map pixel; piece endpoints are always retained.
      if (!last || force || dx * dx + dy * dy >= tolerance) {
        if (last && last[0] === p.lon && last[1] === p.lat) return;
        coordinates.push([p.lon, p.lat]); keptLon = p.lon; keptY = y;
      }
    };
    const finish = properties => { if (coordinates.length > 1) features.push({type: 'Feature', properties, geometry: {type: 'LineString', coordinates}}); };
    if (colorBy !== 'time') {
      for (const id of visible) {
        const part = parts[id]; coordinates = [];
        for (let k = part.from; k <= part.to; k++) append(points[indices[k]], projectedY[indices[k]], k === part.to);
        finish({[colorBy]: part.value, time: part.time});
      }
    } else {
      const first = Number.isFinite(options.start) ? options.start : min, last = Number.isFinite(options.end) ? options.end : max;
      const width = Math.max(1, last - first) / 256;
      const bandAt = time => Math.max(0, Math.min(255, Math.floor((time - first) / width)));
      for (let n = 0; n < visible.length;) {
        const part = parts[visible[n++]], from = part.from; let to = part.to;
        while (n < visible.length && parts[visible[n]].run === part.run && parts[visible[n]].from === to) to = parts[visible[n++]].to;
        let previous = points[indices[from]], band = bandAt(previous.t);
        coordinates = []; append(previous, projectedY[indices[from]], true);
        for (let k = from + 1; k <= to; k++) {
          const next = points[indices[k]], nextBand = bandAt(next.t); let boundary;
          while (band < nextBand) {
            boundary = first + (band + 1) * width;
            const fraction = (boundary - previous.t) / (next.t - previous.t);
            const p = boundary === next.t ? next : {lon: previous.lon + (next.lon - previous.lon) * fraction, lat: previous.lat + (next.lat - previous.lat) * fraction};
            const y = projectY(p.lat); append(p, y, true); finish({time: first + (band + .5) * width});
            coordinates = []; append(p, y, true); band++;
          }
          if (boundary !== next.t) append(next, projectedY[indices[k]], k === to);
          previous = next;
        }
        finish({time: first + (band + .5) * width});
      }
    }
    selection.routeVisible = visible; selection.routeLevel = level;
    return selection.routes = collection(features);
  }
  const query = (options = {}) => {
    options = motionOptions(options);
    const {start = -Infinity, end = Infinity, hourEnd = 24, metric = 'records', mode = 'heat', colorBy = 'time', zoom = 10, radius = 24, viewport = [-180, -90, 180, 90]} = options;
    ensureFilter(options);
    const nextSelectionKey = `${filterKey}:${start}:${end}`;
    if (selectionKey !== nextSelectionKey) {
      const from = lowerBound(points, start), to = lowerBound(points, end, true);
      const indices = new Uint32Array(Math.max(0, to - from)), runs = [];
      let count = 0, km = 0, days = 0, lastDay, low = Infinity, high = -Infinity;
      const recordedDays = devices.order ? new Set() : null;
      for (const [begin, finish] of devices.ranges(from, to, options.device ?? null)) {
        let previous = -1, anchor = -1, run = count, moved = false;
        for (let position = begin; position < finish; position++) {
          const i = devices.order ? devices.order[position] : position;
          if (!filter.mask[i]) continue;
          const p = points[i];
          if (previous >= 0) {
            const dt = p.t - points[previous].t;
            const before = devices.positions ? devices.positions[previous] : previous;
            const adjacent = devices.neighbor(previous, 1) === i || filter.barriers && filter.barriers[position] === filter.barriers[before + 1];
            let connected = adjacent && dt > 0 && dt <= 6 * 3_600_000 && Math.abs(p.lon - points[previous].lon) < 180;
            if (connected) {
              const d = distance(points[previous], p);
              connected = d / (dt / 3_600_000) <= 1000;
              if (drift) connected = connected && dt <= (options.driftWindow ?? 60) * 2000 && speedAt(previous, options) !== null && speedAt(i, options) !== null;
              if (connected) {
                const a = points[previous];
                moved ||= p.lon !== a.lon || p.lat !== a.lat;
                if (drift) {
                  km += (speedAt(previous, options) + speedAt(i, options)) / 2 * dt / 3_600_000; anchor = i;
                } else if (dt <= 60_000 && a.recordedSpeed != null && p.recordedSpeed != null) {
                  km += (a.recordedSpeed + p.recordedSpeed) / 2 * dt / 3_600_000;
                  anchor = i;
                } else {
                  const origin = points[anchor], movement = anchor === previous ? d : distance(origin, p);
                  if (movement >= Math.max(.003, Math.hypot(origin.accuracy ?? 0, p.accuracy ?? 0) / 1000)) { km += movement; anchor = i; }
                }
              }
            }
            if (!connected) { if (count - run > 1 && moved) runs.push([run, count]); run = count; anchor = i; moved = false; }
          }
          else anchor = i;
          indices[count++] = i; previous = i;
          if (p.altitude != null) { low = Math.min(low, p.altitude); high = Math.max(high, p.altitude); }
          const day = Math.floor(p.t / DAY);
          if (recordedDays) recordedDays.add(day); else if (day !== lastDay) { days++; lastDay = day; }
        }
        if (count - run > 1 && moved) runs.push([run, count]);
      }
      if (recordedDays) days = recordedDays.size;
      const selected = indices.subarray(0, count);
      selection = {from, to, indices: selected, runs, routeCount: runs.reduce((n, [a, b]) => n + b - a, 0), count, days, km, bounds: undefined, routes: null, altitudeRange: low <= high ? [low, high] : null};
      selectionKey = nextSelectionKey;
    }
    const {from, to, indices} = selection;
    const center = (viewport[0] + viewport[2]) / 2;
    const inView = p => {
      const lon = p.lon + 360 * Math.round((center - p.lon) / 360);
      return lon >= viewport[0] && lon <= viewport[2] && p.lat >= viewport[1] && p.lat <= viewport[3];
    };
    const {ranges, candidates} = candidateRanges(viewport);
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
      if (devices.order) visible?.subarray(0, visibleCount).sort();
    }
    let densityIndices = visible?.subarray(0, visibleCount);
    if (metric === 'time' && (mode === 'heat' || mode === 'hex')) {
      const first = intervalFrom(start), active = new Uint32Array(Math.min(candidates, to - first)); let length = 0;
      const matches = i => i >= first && i < to && quality(i, options) && inView(points[i]) && (points[i].t >= start && filter.mask[i] || points[i].duration > 0 && selectedMillis(points[i].t, points[i].t + points[i].duration, options) > 0);
      if (candidates < to - first) {
        for (const [a, b] of ranges) for (let j = a; j < b; j++) { const i = order[j]; if (matches(i)) active[length++] = i; }
        active.subarray(0, length).sort();
      } else for (let i = first; i < to; i++) if (matches(i)) active[length++] = i;
      densityIndices = active.subarray(0, length);
    }
    let density = EMPTY, dots = EMPTY, routes = EMPTY, peak = 1, drawn = 0;
    if (mode === 'points') {
      const stride = Math.max(1, Math.ceil(visibleCount / 20_000)), features = [];
      for (let j = 0; j < visibleCount; j += stride) {
        features.push(pointFeature(visible[j], options));
      }
      dots = collection(features); drawn = features.length;
    } else if (mode === 'route') {
      routes = routeGeometry(options); drawn = routes.features.length;
    } else {
      const scale = 512 * 2 ** Math.floor(Math.max(0, Math.min(20, zoom)));
      const size = (mode === 'hex' ? Math.max(2, radius) : Math.max(3, radius / 4)) / scale;
      const grid = new Map(), bins = [];
      for (const i of densityIndices) {
        const p = points[i], lon = p.lon + 360 * Math.round((center - p.lon) / 360);
        const x = (lon + 180) / 360, y = projectedY[i];
        let a, b, cx, cy;
        if (mode === 'hex') {
          [a, b] = hexRound((Math.sqrt(3) / 3 * x - y / 3) / size, 2 / 3 * y / size);
          cx = size * Math.sqrt(3) * (a + b / 2); cy = size * 1.5 * b;
        } else { a = Math.floor(x / size); b = Math.floor(y / size); cx = (a + .5) * size; cy = (b + .5) * size; }
        let column = grid.get(a);
        if (!column) { column = new Map(); grid.set(a, column); }
        let bin = column.get(b);
        if (!bin) { bin = {q: a, r: b, x: cx, y: cy, count: 0, duration: 0, days: 0, lastDay: undefined, coveredUntil: -Infinity}; column.set(b, bin); bins.push(bin); }
        if (p.t >= start && filter.mask[i]) bin.count++;
        // Visible indices are chronological, so each bin sees UTC days in order.
        const day = Math.floor(p.t / DAY);
        if (day !== bin.lastDay) { bin.days++; bin.lastDay = day; }
        bin.duration += selectedMillis(Math.max(p.t, bin.coveredUntil), p.t + p.duration, options) / 60_000;
        bin.coveredUntil = Math.max(bin.coveredUntil, p.t + p.duration);
      }
      const value = b => metric === 'days' ? b.days : metric === 'time' ? b.duration : b.count;
      const values = bins.map(value).filter(v => v > 0).sort((a, b) => a - b);
      peak = values[Math.floor((values.length - 1) * .95)] || 1;
      const features = [];
      for (const b of bins) {
        const v = value(b);
        if (!v) continue;
        const properties = {...(mode === 'hex' ? {cell: `hex:${b.q}:${b.r}:${size}:${center}`} : {}), value: v, count: b.count, days: b.days, minutes: Math.round(b.duration), weight: Math.min(1, Math.sqrt(v / peak))};
        const coordinates = mode === 'hex' ? [Array.from({length: 7}, (_, i) => unproject(b.x + size * Math.cos(rad * (60 * (i % 6) - 30)), b.y + size * Math.sin(rad * (60 * (i % 6) - 30))))] : unproject(b.x, b.y);
        features.push({type: 'Feature', properties, geometry: {type: mode === 'hex' ? 'Polygon' : 'Point', coordinates}});
      }
      density = collection(features); drawn = features.length;
    }
    // Fit every drawable journey, not just viewport geometry or isolated fixes.
    // Cache both extents lazily; camera changes never repeat the longitude sort.
    const boundsKey = mode === 'route' ? 'routeBounds' : 'bounds';
    if (selection[boundsKey] === undefined) {
      selection[boundsKey] = wrappedBounds(points, indices, mode === 'route' ? selection.runs : null);
      if (selection.routeCount === selection.count) selection.bounds = selection.routeBounds = selection[boundsKey];
    }
    const bounds = selection[boundsKey] ?? (mode !== 'route' && metric === 'time' && densityIndices?.length ? wrappedBounds(points, densityIndices) : null);
    return {density, dots, routes, count: selection.count, visible: visibleCount, days: selection.days, km: selection.km, bounds, histogram: filter.histogram, altitudeRange: selection.altitudeRange, peak, drawn};
  };
  // Navigate the complete filtered window, independent of viewport and drawing stride.
  query.point = (index, options = {}) => {
    options = motionOptions(options);
    if (!Number.isInteger(index) || index < 0 || index >= points.length) return null;
    const {start = -Infinity, end = Infinity} = options;
    if (points[index].t < start || points[index].t > end) return null;
    ensureFilter(options);
    if (!filter.mask[index]) return null;
    const neighbor = direction => {
      for (let i = index + direction; i >= 0 && i < points.length; i += direction) {
        if (points[i].t < start || points[i].t > end) break;
        if (filter.mask[i]) return i;
      }
      return null;
    };
    return {feature: pointFeature(index, options), previous: neighbor(-1), next: neighbor(1)};
  };
  // Reuse the dataset index and filter mask, without replacing the map's current
  // date/route cache. Large areas stream chronologically; small areas sort only
  // their spatial candidates. Return every stay and day; the UI pages the rows.
  query.place = (feature, options = {}) => {
    options = motionOptions(options);
    const geometry = placePolygon(feature?.geometry?.coordinates?.[0]);
    const nextKey = JSON.stringify([feature.properties?.cell, geometry.coordinates, options]);
    if (nextKey === placeKey) return placeResult;
    ensureFilter(options);
    const {start = -Infinity, end = Infinity, hourEnd = 24} = options;
    const hour = DAY / 24, firstHour = Math.floor(start / hour), hourCount = Math.floor(end / hour) - firstHour + 1;
    if (options.hourly && (!Number.isFinite(hourCount) || hourCount < 1 || hourCount > 168)) throw new Error('Hourly place history requires a range of at most seven days.');
    const hours = options.hourly ? Array.from({length: hourCount}, (_, i) => ({start: (firstHour + i) * hour, count: 0, minutes: 0})) : null;
    const addHours = (from, until) => {
      for (let at = from; at < until;) {
        const index = Math.floor(at / hour), next = Math.min(until, (index + 1) * hour);
        if (hours[index - firstHour]) hours[index - firstHour].minutes += (next - at) / 60_000;
        at = next;
      }
    };
    const ring = geometry.coordinates[0], xy = ring.map(c => project(...c));
    const xs = ring.map(c => c[0]), ys = ring.map(c => c[1]);
    const viewport = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], center = (viewport[0] + viewport[2]) / 2;
    let hex = null;
    const cell = feature.properties?.cell;
    if (typeof cell === 'string' && cell.startsWith('hex:')) {
      hex = cell.slice(4).split(':').map(Number);
      if (hex.length !== 4 || !hex.every(Number.isFinite) || !Number.isInteger(hex[0]) || !Number.isInteger(hex[1]) || hex[2] <= 0 || hex[2] > 1) throw new Error('Invalid hexagon.');
      // Unprojection can round a bin-edge coordinate just outside its polygon.
      // Pad the candidate box only; exact hex rounding still decides membership.
      viewport[0] -= 1e-9; viewport[1] -= 1e-9; viewport[2] += 1e-9; viewport[3] += 1e-9;
      // Polar observations are rendered at Mercator's latitude limit.
      if (viewport[1] <= -85.051128) viewport[1] = -90;
      if (viewport[3] >= 85.051128) viewport[3] = 90;
    }
    const contains = i => {
      const p = points[i], lon = p.lon + 360 * Math.round((center - p.lon) / 360);
      if (lon < viewport[0] || lon > viewport[2] || p.lat < viewport[1] || p.lat > viewport[3]) return false;
      const sourceLon = hex ? p.lon + 360 * Math.round((hex[3] - p.lon) / 360) : lon;
      const x = (sourceLon + 180) / 360, y = projectedY[i];
      if (hex) { const [q, r] = hexRound((Math.sqrt(3) / 3 * x - y / 3) / hex[2], 2 / 3 * y / hex[2]); return q === hex[0] && r === hex[1]; }
      let inside = false;
      for (let j = 0; j < xy.length - 1; j++) {
        const [ax, ay] = xy[j], [bx, by] = xy[j + 1];
        const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
        if (Math.abs(cross) < 1e-12 * (Math.abs(bx - ax) + Math.abs(by - ay)) && x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return true;
        if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
      }
      return inside;
    };
    const from = intervalFrom(start), to = lowerBound(points, end, true), {ranges, candidates} = candidateRanges(viewport);
    let count = 0, first = null, last = null, minutes = 0, coveredUntil = -Infinity, knownFirst = null, knownLast = null;
    const contexts = devices.groups.map(() => ({scanned: null, nextExit: -1, visit: null}));
    const clipExit = (i, until, context) => {
      if (context.nextExit <= i) context.nextExit = -1;
      if (context.scanned === null || context.scanned >= 0 && context.scanned <= i) context.scanned = devices.neighbor(i, 1);
      // Each device shares one forward scan; another device cannot end its stay.
      while (context.nextExit < 0 && context.scanned >= 0 && context.scanned < to && points[context.scanned].t < until) {
        const j = context.scanned; context.scanned = devices.neighbor(j, 1);
        if (quality(j, options) && !contains(j)) context.nextExit = j;
      }
      return context.nextExit < 0 ? until : Math.min(until, points[context.nextExit].t);
    };
    const stays = [], days = new Map();
    const dayRow = day => {
      if (!days.has(day)) days.set(day, {start: day, count: 0, minutes: 0});
      return days.get(day);
    };
    const add = i => {
      const p = points[i], observed = p.t >= start && p.t <= end && filter.mask[i];
      const context = contexts[devices.idAt(i)], nextIndex = devices.neighbor(i, 1), next = nextIndex >= 0 ? points[nextIndex] : null;
      const nextAccepted = next && quality(nextIndex, options), nextInside = nextAccepted && contains(nextIndex);
      // Explicit intervals can span days; a rejected fix is not evidence of an exit.
      // Short consecutive recordings only establish time across accepted inside fixes.
      const interval = nextInside && next.t > p.t && next.t - p.t < 15 * 60_000 ? next.t - p.t : 0;
      const until = clipExit(i, Math.min(p.t + Math.max(p.duration, interval), end + 1), context);
      const from = Math.max(p.t, start);
      let currentVisit = null;
      const ensureVisit = at => {
        if (!currentVisit) {
          if (!context.visit || at - context.visit.end >= 15 * 60_000) { context.visit = {start: at, end: at, count: 0, minutes: 0}; stays.push(context.visit); }
          currentVisit = context.visit;
        }
        return currentVisit;
      };
      if (observed) {
        const stay = ensureVisit(p.t); stay.count++; stay.end = Math.max(stay.end, p.t); count++;
        dayRow(Math.floor(p.t / DAY) * DAY).count++;
        if (hours) hours[Math.floor(p.t / hour) - firstHour].count++;
        if (first === null) first = p.t; last = p.t;
      }
      for (let day = Math.floor(from / DAY) * DAY; day < until; day += DAY) {
        const a = Math.max(from, day + (options.hourStart ?? 0) * hour), b = Math.min(until, day + hourEnd * hour);
        if (b <= a) continue;
        const row = dayRow(day), stay = ensureVisit(a), credited = Math.max(a, coveredUntil);
        if (knownFirst === null) knownFirst = a; knownLast = Math.max(knownLast ?? b, b);
        if (b > credited) {
          const duration = (b - credited) / 60_000;
          if (hours) addHours(credited, b);
          minutes += duration; stay.minutes += duration; row.minutes += duration;
        }
        stay.end = Math.max(stay.end, b); coveredUntil = Math.max(coveredUntil, b);
      }
    };
    if (candidates < (to - from) / 2) {
      const matches = new Uint32Array(candidates); let length = 0;
      for (const [a, b] of ranges) for (let j = a; j < b; j++) {
        const i = order[j]; if (i >= from && i < to && quality(i, options) && contains(i)) matches[length++] = i;
      }
      for (const i of matches.subarray(0, length).sort()) add(i);
    } else for (let i = from; i < to; i++) if (quality(i, options) && contains(i)) add(i);
    const merged = [];
    for (const stay of stays.sort((a, b) => a.start - b.start)) {
      const previous = merged.at(-1);
      if (previous && stay.start - previous.end < 15 * 60_000) { previous.end = Math.max(previous.end, stay.end); previous.count += stay.count; previous.minutes += stay.minutes; }
      else merged.push(stay);
    }
    placeKey = nextKey;
    return placeResult = {count, days: days.size, first: first ?? knownFirst, last: last ?? (knownLast === null ? null : knownLast - 1), minutes, visits: merged.length, stays: merged.reverse(), daily: [...days.values()].sort((a, b) => b.start - a.start), ...(hours ? {hours} : {})};
  };
  query.ranges = ranges;
  query.devices = devices.groups.map(({id, label, count}) => ({id, label, count}));
  return query;
}

// Convenience for one-off queries. The worker retains createHistoryQuery's index.
export function queryHistory(points, options) { return createHistoryQuery(points)(options); }
