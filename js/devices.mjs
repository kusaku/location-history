// Compact device indexing. No dependencies.
export const SOURCE_NAMES = ['Recorded position', 'GPS', 'Wi-Fi', 'Cell', 'Network', 'Fused', 'Timeline path'];
export const deviceKey = p => p.stream?.device ?? '';

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
