import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryQuery, project, DAY} from '../js/data.mjs';

const point = (t, lon, lat = 0, extra = {}) => ({t, lon, lat, accuracy: 4, duration: 0, ...extra});
const vertices = result => result.routes.features.flatMap(f => f.geometry.coordinates);

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
