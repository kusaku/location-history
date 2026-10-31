import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryQuery, project, DAY} from '../js/data.mjs';

const point = (t, lon, lat = 0, extra = {}) => ({t, lon, lat, accuracy: 4, duration: 0, ...extra});
const vertices = result => result.routes.features.flatMap(f => f.geometry.coordinates);

test('journey Fit excludes disconnected fixes and stationary runs while retaining all observations', () => {
  const points = [point(0, 13.4, 52.5), point(60000, 13.401, 52.501), point(DAY, 56, 25), point(DAY + 60000, 56, 25), point(3 * DAY, 100, 14)];
  const query = createHistoryQuery(points);
  for (const colorBy of ['time', 'speed', 'altitude']) {
    const result = query({mode: 'route', colorBy});
    assert.equal(result.count, 5);
    assert.ok(Math.abs(result.bounds[0][0] - 13.4) < 1e-9);
    assert.ok(Math.abs(result.bounds[1][0] - 13.401) < 1e-9);
    assert.deepEqual(result.bounds.map(b => b[1]), [52.5, 52.501]);
  }
  const dots = query({mode: 'points'});
  assert.equal(dots.count, 5); assert.equal(dots.dots.features.length, 5);
  assert.equal(dots.bounds[1][0], 100);
});

test('journey Fit uses all drawable runs even when the current viewport is empty and follows device selection', () => {
  const a = {stream: {device: 'a', source: 1}}, b = {stream: {device: 'b', source: 1}};
  const query = createHistoryQuery([point(0, 13.4, 52.5, a), point(1000, 2.3, 48.8, b), point(60000, 13.401, 52.501, a), point(61000, 2.301, 48.801, b)]);
  const options = {mode: 'route', viewport: [120, -10, 130, 10]};
  const all = query(options);
  assert.equal(all.routes.features.length, 0); assert.ok(all.bounds[0][0] < 3 && all.bounds[1][0] > 13);
  assert.equal(query({...options, viewport: [100, 0, 110, 10]}).bounds, all.bounds);
  const device = query({...options, device: 1});
  assert.equal(device.count, 2); assert.ok(device.bounds[1][0] < 3);
});

test('journey Fit has no target for isolated or entirely stationary observations', () => {
  for (const points of [[point(0, 13)], [point(0, 13), point(60000, 13)], [point(0, 13), point(DAY, 14)]]) {
    const query = createHistoryQuery(points), route = query({mode: 'route'});
    assert.equal(route.bounds, null); assert.equal(route.routes.features.length, 0);
    assert.ok(query({mode: 'points'}).bounds);
  }
});

test('a large date window preserves every visible turn in Time, Speed and Altitude', () => {
  const local = Array.from({length: 20}, (_, i) => point(i * 1000, 13.58 + Math.min(i, 10) * .0001, 52.5 + Math.max(0, i - 10) * .0001, {altitude: i, recordedSpeed: 40}));
  const points = [...local, ...Array.from({length: 260000}, (_, i) => point((i + 20) * 1000, 14 + i * .000001, 52.5, {altitude: 20, recordedSpeed: 0}))];
  const query = createHistoryQuery(points), viewport = [13.579, 52.499, 13.582, 52.502];
  for (const colorBy of ['time', 'speed', 'altitude']) {
    const result = query({mode: 'route', colorBy, start: 0, end: 365 * DAY, zoom: 18, viewport});
    const rendered = new Set(vertices(result).map(c => c.join(',')));
    assert.equal(result.count, points.length); assert.equal(result.visible, local.length);
    for (const p of local) assert.ok(rendered.has([p.lon, p.lat].join(',')), `${colorBy} lost a visible turn`);
    assert.ok(vertices(result).every(([lon]) => lon < 13.6)); // Distant geometry is not transferred.
    assert.ok(result.routes.features.length < 10);
  }
});

function errorPixels(points, coordinates, zoom) {
  const scale = 512 * 2 ** zoom, line = coordinates.map(c => project(...c));
  let largest = 0;
  for (const p of points) {
    const [x, y] = project(p.lon, p.lat); let nearest = Infinity;
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1], [bx, by] = line[i], dx = bx - ax, dy = by - ay;
      const along = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      nearest = Math.min(nearest, Math.hypot(x - ax - along * dx, y - ay - along * dy));
    }
    largest = Math.max(largest, nearest * scale);
  }
  return largest;
}

test('route simplification has a subpixel error bound and restores detail when zooming in', () => {
  const points = Array.from({length: 2000}, (_, i) => point(i * 1000, 13 + Math.cos(i / 200) * .001, 52.5 + Math.sin(i / 200) * .001));
  const query = createHistoryQuery(points), options = {mode: 'route', end: DAY, viewport: [12, 52, 14, 53]};
  const far = query({...options, zoom: 10.8}), near = query({...options, zoom: 18});
  assert.ok(vertices(far).length < points.length / 5);
  assert.ok(errorPixels(points, vertices(far), 10.8) < 1);
  assert.ok(errorPixels(points, vertices(near), 18) < 1);
  assert.ok(vertices(near).length > vertices(far).length);
  assert.equal(far.count, near.count); assert.equal(far.km, near.km);
});

test('a segment crossing the viewport remains visible even when both endpoint observations are outside', () => {
  const points = [point(0, -2), point(3600000, 2)];
  const query = createHistoryQuery(points);
  for (const colorBy of ['time', 'speed', 'altitude']) {
    const result = query({mode: 'route', colorBy, viewport: [-.1, -.1, .1, .1]});
    assert.equal(result.visible, 0); assert.ok(result.routes.features.length > 0);
  }
  assert.equal(query({mode: 'route', viewport: [-.1, 1, .1, 2]}).routes.features.length, 0);
});

test('viewport piece caching preserves statistics and never joins separate visible runs', () => {
  const points = [point(0, 0), point(60000, .001), point(DAY, 10), point(DAY + 60000, 10.001)];
  const query = createHistoryQuery(points);
  for (const colorBy of ['time', 'speed', 'altitude']) {
    const options = {mode: 'route', colorBy, zoom: 16};
    const a = query({...options, viewport: [-.1, -.1, .1, .1]});
    const nearby = query({...options, viewport: [-.2, -.2, .2, .2]});
    assert.equal(a.routes, nearby.routes);
    const b = query({...options, viewport: [9.9, -.1, 10.1, .1]});
    assert.notEqual(a.routes, b.routes); assert.equal(a.histogram, b.histogram); assert.equal(a.bounds, b.bounds);
    assert.equal(a.count, b.count); assert.equal(a.km, b.km);
    assert.ok(vertices(a).every(([lon]) => lon < 1)); assert.ok(vertices(b).every(([lon]) => lon > 9));
    const all = query({...options, viewport: [-1, -1, 11, 1]});
    assert.ok(all.routes.features.every(f => f.geometry.coordinates.every(([lon]) => lon < 1) || f.geometry.coordinates.every(([lon]) => lon > 9)));
  }
});

test('route viewport selection respects wrapped longitudes and rebuilds only at a new zoom level', () => {
  const query = createHistoryQuery([point(0, 179.1), point(60000, 179.2)]);
  const options = {mode: 'route', colorBy: 'speed', viewport: [-181, -1, -180, 1]};
  const first = query({...options, zoom: 12.1});
  assert.ok(first.routes.features.length > 0);
  assert.equal(query({...options, zoom: 12.8}).routes, first.routes);
  assert.notEqual(query({...options, zoom: 13}).routes, first.routes);
});
