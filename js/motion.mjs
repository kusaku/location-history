// Indexed device separation and optional GPS-drift estimates. No dependencies.
export const SOURCE_NAMES = ['Recorded position', 'GPS', 'Wi-Fi', 'Cell', 'Network', 'Fused', 'Timeline path'];
const SOURCES = SOURCE_NAMES.length, STRIDE = 10, METRES_PER_DEGREE = Math.PI * 6371000 / 180;
const sourceOf = p => p.stream?.source ?? 0;
export const deviceKey = p => p.stream?.device ?? '';

function update(stats, source, t, x, y, weight, direction) {
  const k = source * STRIDE;
  if (direction < 0 && stats[k] === 1) { stats.fill(0, k, k + STRIDE); return; }
  const deltaWeight = weight * direction, total = stats[k + 1] + deltaWeight;
  const dt = t - stats[k + 2], dx = x - stats[k + 3], dy = y - stats[k + 4];
  stats[k] += direction; stats[k + 1] = total;
  stats[k + 2] += deltaWeight / total * dt;
  stats[k + 3] += deltaWeight / total * dx;
  stats[k + 4] += deltaWeight / total * dy;
  stats[k + 5] += deltaWeight * dt * (t - stats[k + 2]);
  stats[k + 6] += deltaWeight * dt * (x - stats[k + 3]);
  stats[k + 7] += deltaWeight * dt * (y - stats[k + 4]);
  stats[k + 8] += deltaWeight * dx * (x - stats[k + 3]);
  stats[k + 9] += deltaWeight * dy * (y - stats[k + 4]);
}

function estimate(stats, latitude, span) {
  let count = 0, weight = 0, tt = 0, tx = 0, ty = 0;
  for (let k = 0; k < stats.length; k += STRIDE) {
    count += stats[k]; weight += stats[k + 1];
    tt += stats[k + 5]; tx += stats[k + 6]; ty += stats[k + 7];
  }
  if (count < 4 || tt <= 1e-12 || span < 1) return NaN;
  const vx = tx / tt, vy = ty / tt, sx = METRES_PER_DEGREE * Math.cos(latitude * Math.PI / 180);
  const speed = Math.hypot(vx * sx, vy * METRES_PER_DEGREE);
  let scatter = 0;
  for (let k = 0; k < stats.length; k += STRIDE) {
    scatter += Math.max(0, stats[k + 8] - 2 * vx * stats[k + 6] + vx * vx * stats[k + 5]) * sx * sx;
    scatter += Math.max(0, stats[k + 9] - 2 * vy * stats[k + 7] + vy * vy * stats[k + 5]) * METRES_PER_DEGREE ** 2;
  }
  // Preserve a noise floor: correlated observations must not manufacture
  // confidence merely because the device reports more frequently.
  const noise = Math.sqrt(Math.max(count / weight, scatter / weight));
  const threshold = 2 * Math.SQRT2 * noise / span;
  return speed > threshold && speed <= 1000 / 3.6 ? speed * 3.6 : NaN;
}

export function driftSpeeds(points, {windowSeconds = 60, bucketSeconds = 5, reference = false, excluded = null, indices, speeds = new Float32Array(points.length)} = {}) {
  windowSeconds = Number.isFinite(windowSeconds) ? Math.max(15, Math.min(600, windowSeconds)) : 60;
  bucketSeconds = Number.isFinite(bucketSeconds) ? Math.max(1, Math.min(windowSeconds, bucketSeconds)) : 5;
  const count = indices?.length ?? points.length;
  const at = indices ? i => points[indices[i]] : i => points[i];
  if (!count) return {speeds, scratchBytes: 0, representatives: 0};
  const epoch = at(0).t, half = windowSeconds / 2;
  const capacity = (Math.ceil(windowSeconds / bucketSeconds) + 4) * SOURCES;
  const time = new Float64Array(capacity), lon = new Float64Array(capacity), lat = new Float64Array(capacity), weights = new Float64Array(capacity), sources = new Uint8Array(capacity);
  const stats = new Float64Array(SOURCES * STRIDE), best = new Int32Array(SOURCES);
  const previousLon = new Float64Array(SOURCES), longitudeOffset = new Float64Array(SOURCES), seen = new Uint8Array(SOURCES);
  let cursor = 0, head = 0, length = 0, active = 0, representatives = 0, changes = 0;
  const change = (slot, direction) => { update(stats, sources[slot], time[slot], lon[slot], lat[slot], weights[slot], direction); changes++; };
  function readBucket() {
    const bucket = Math.floor((at(cursor).t - epoch) / (bucketSeconds * 1000));
    best.fill(-1);
    while (cursor < count && Math.floor((at(cursor).t - epoch) / (bucketSeconds * 1000)) === bucket) {
      const p = at(cursor), source = sourceOf(p);
      if (!excluded?.[indices ? indices[cursor] : cursor] && source >= 0 && source < SOURCES && (best[source] < 0 || (p.accuracy ?? Infinity) < (at(best[source]).accuracy ?? Infinity))) best[source] = cursor;
      cursor++;
    }
    // Only one candidate per source can exist in a bucket; sort without allocating.
    for (let i = 1; i < best.length; i++) {
      const value = best[i], timestamp = value < 0 ? Infinity : at(value).t;
      let j = i;
      while (j > 0 && (best[j - 1] < 0 || at(best[j - 1]).t > timestamp)) { best[j] = best[j - 1]; j--; }
      best[j] = value;
    }
    for (const index of best) if (index >= 0) {
      if (length === capacity) throw new Error('Rolling window capacity exceeded');
      const p = at(index), source = sourceOf(p), slot = (head + length++) % capacity;
      if (seen[source]) longitudeOffset[source] += 360 * Math.round((previousLon[source] - p.lon) / 360);
      seen[source] = 1; previousLon[source] = p.lon;
      time[slot] = (p.t - epoch) / 1000; lon[slot] = p.lon + longitudeOffset[source]; lat[slot] = p.lat;
      weights[slot] = 1 / Math.max(5, p.accuracy ?? 5) ** 2; sources[slot] = source; representatives++;
    }
  }
  for (let i = 0; i < count; i++) {
    const p = at(i), center = (p.t - epoch) / 1000, lower = center - half, upper = center + half;
    while (length && time[head] < lower) {
      if (active) { change(head, -1); active--; }
      head = (head + 1) % capacity; length--;
    }
    while (cursor < count && (at(cursor).t - epoch) / 1000 <= upper) readBucket();
    while (active < length && time[(head + active) % capacity] <= upper) { change((head + active) % capacity, 1); active++; }
    if (reference || changes >= 1024) {
      // Recompute each window for a numerical-equivalence oracle.
      // The optimized path occasionally rebases its tiny window to avoid drift
      // from subtracting floating-point moments millions of times.
      stats.fill(0);
      for (let j = 0; j < active; j++) change((head + j) % capacity, 1);
      changes = 0;
    }
    speeds[indices ? indices[i] : i] = !excluded?.[indices ? indices[i] : i] && sourceOf(p) >= 0 && sourceOf(p) < SOURCES ? estimate(stats, p.lat, active ? time[(head + active - 1) % capacity] - time[head] : 0) : NaN;
  }
  const scratchBytes = [time, lon, lat, weights, sources, stats, best, previousLon, longitudeOffset, seen].reduce((bytes, a) => bytes + a.byteLength, 0);
  return {speeds, scratchBytes, representatives};
}

export function createDeviceIndex(points) {
  const first = points.length ? deviceKey(points[0]) : '';
  if (points.every(p => deviceKey(p) === first)) {
    const label = first ? 'Device 1' : 'Unknown device';
    return {groups: points.length ? [{id: 0, key: first, label, count: points.length, from: 0, to: points.length}] : [], order: null, positions: null,
      idAt: () => 0, labelAt: () => label,
      neighbor: (i, direction) => i + direction >= 0 && i + direction < points.length ? i + direction : -1,
      ranges: (from, to, selected = null) => selected === null || selected === 0 ? [[from, to]] : [],
    };
  }
  const groups = [], byKey = new Map();
  for (const p of points) {
    const key = deviceKey(p);
    let group = byKey.get(key);
    if (!group) { group = {id: groups.length, key, count: 0}; byKey.set(key, group); groups.push(group); }
    group.count++;
  }
  let named = 0, offset = 0;
  for (const group of groups) {
    group.label = group.key ? `Device ${++named}` : 'Unknown device';
    group.from = offset; offset += group.count; group.to = offset;
  }
  const order = groups.length > 1 ? new Uint32Array(points.length) : null;
  const positions = order ? new Uint32Array(points.length) : null;
  if (order) {
    const cursors = groups.map(g => g.from);
    for (let i = 0; i < points.length; i++) { const at = cursors[byKey.get(deviceKey(points[i])).id]++; order[at] = i; positions[i] = at; }
  }
  const lower = (value, lo, hi) => { while (lo < hi) { const mid = (lo + hi) >>> 1; if (order[mid] < value) lo = mid + 1; else hi = mid; } return lo; };
  return {
    groups, order, positions,
    idAt: i => byKey.get(deviceKey(points[i])).id,
    labelAt: i => byKey.get(deviceKey(points[i])).label,
    neighbor(i, direction) {
      const at = order ? positions[i] + direction : i + direction;
      if (at < 0 || at >= points.length) return -1;
      const next = order ? order[at] : at;
      return deviceKey(points[next]) === deviceKey(points[i]) ? next : -1;
    },
    ranges(from, to, selected = null) {
      return groups.filter(g => selected === null || selected === g.id).map(g => order ? [lower(from, g.from, g.to), lower(to, g.from, g.to)] : [from, to]);
    },
  };
}

export function createMotionQuery(points, devices) {
  let lastWindow, lastExcluded, result;
  return (windowSeconds = 60, excluded = null) => {
    windowSeconds = Number.isFinite(windowSeconds) ? Math.max(15, Math.min(600, Math.round(windowSeconds))) : 60;
    if (result && lastWindow === windowSeconds && lastExcluded === excluded) return result;
    const speeds = result?.speeds ?? new Float32Array(points.length);
    if (!devices.order) result = driftSpeeds(points, {windowSeconds, excluded, speeds});
    else {
      let scratchBytes = 0;
      for (const group of devices.groups) {
        const part = driftSpeeds(points, {windowSeconds, excluded, speeds, indices: devices.order.subarray(group.from, group.to)});
        scratchBytes = Math.max(scratchBytes, part.scratchBytes);
      }
      result = {speeds, scratchBytes};
    }
    lastWindow = windowSeconds; lastExcluded = excluded;
    return result;
  };
}
