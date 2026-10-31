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

const corners = () => [[0, 0], [.001, 0], [.001, .001], [.002, .001]].map(([lon, lat], i) => point(i * 60000, lon, lat, {altitude: i * 10, recordedSpeed: 20}));

test('cubic journeys bound visual rounding and preserve measurements and colour boundaries in every colour mode', () => {
  const points = corners(), snapshot = JSON.stringify(points), query = createHistoryQuery(points);
  for (const colorBy of ['time', 'speed', 'altitude']) {
    const options = {mode: 'route', colorBy, zoom: 18};
    const straight = query(options), smooth = query({...options, smooth: true});
    assert.notDeepEqual(smooth.routes, straight.routes, colorBy);
    for (const key of ['count', 'visible', 'days', 'km', 'histogram', 'altitudeRange']) assert.deepEqual(smooth[key], straight[key], key);
    assert.ok(errorPixels(points, vertices(smooth), 18) < 4 * 512 * 2 ** 18 / 40_075_016.686 + .5);
    assert.ok(vertices(smooth).every(c => c.every(Number.isFinite)));
    const features = smooth.routes.features;
    for (let i = 1; i < features.length; i++) assert.deepEqual(features[i - 1].geometry.coordinates.at(-1), features[i].geometry.coordinates[0]);
    assert.deepEqual(vertices(smooth)[0], [points[0].lon, points[0].lat]);
    assert.deepEqual(vertices(smooth).at(-1), [points.at(-1).lon, points.at(-1).lat]);
    assert.deepEqual(query(options).routes, straight.routes);
  }
  assert.equal(JSON.stringify(points), snapshot);
});

test('smooth display falls back exactly to straight paths at overview zooms and for large visible tracks', () => {
  const query = createHistoryQuery(corners());
  for (const zoom of [2, 10.8, 11.9]) {
    const straight = query({mode: 'route', zoom});
    assert.equal(query({mode: 'route', zoom, smooth: true}).routes, straight.routes);
  }
  const dense = createHistoryQuery(Array.from({length: 10002}, (_, i) => point(i * 1000, i % 2 * .00003, i * .0000001)));
  const straight = dense({mode: 'route', colorBy: 'speed', zoom: 18});
  assert.equal(dense({mode: 'route', colorBy: 'speed', zoom: 18, smooth: true}).routes, straight.routes);
});

test('closely spaced and straight edges do not acquire unnecessary curve vertices', () => {
  for (const coordinates of [[[0, 0], [.000002, 0], [.000002, .000002]], [[0, 0], [.001, 0], [.002, 0]]]) {
    const query = createHistoryQuery(coordinates.map(([lon, lat], i) => point(i * 60000, lon, lat)));
    for (const colorBy of ['time', 'speed', 'altitude']) {
      const options = {mode: 'route', colorBy, zoom: 18};
      assert.deepEqual(query({...options, smooth: true}).routes, query(options).routes);
    }
  }
});

test('smooth journeys cache repeated pans, bound subdivision and keep uneven/U-turn geometry finite', () => {
  const points = [[0, 0], [.001, 0], [.001001, .000001], [.001, 0], [.001, 0], [.002, .001]].map(([lon, lat], i) => point(i * 60000, lon, lat));
  const query = createHistoryQuery(points), options = {mode: 'route', colorBy: 'speed', zoom: 18, smooth: true};
  const first = query({...options, viewport: [-1, -1, 1, 1]});
  assert.equal(query({...options, zoom: 18.7, viewport: [-.5, -.5, .5, .5]}).routes, first.routes);
  assert.ok(vertices(first).every(c => c.every(Number.isFinite)));
  assert.ok(vertices(first).length <= 50_000 + (points.length - 1) * 2);
  assert.ok(errorPixels(points, vertices(first), 18) < 4 * 512 * 2 ** 18 / 40_075_016.686 + .5);
});

test('uncertain anchors may round within accuracy while precise and unknown fixes stay close to their observations', () => {
  const coordinates = [[0, 0], [.001, .001], [.002, 0]], errors = [];
  for (const accuracy of [null, .1, 500]) {
    const points = coordinates.map(([lon, lat], i) => point(i * 60000, lon, lat, {accuracy: i === 1 ? accuracy : 4}));
    const result = createHistoryQuery(points)({mode: 'route', colorBy: 'speed', zoom: 18, smooth: true});
    errors.push(errorPixels([points[1]], vertices(result), 18));
  }
  assert.ok(errors[0] < .01);
  assert.ok(errors[1] < .5);
  const pixelsPerMetre = 512 * 2 ** 18 / 40_075_016.686;
  assert.ok(errors[2] > 50 * pixelsPerMetre && errors[2] <= 500 * pixelsPerMetre);
});

function knotAngle(coordinates, point) {
  const at = coordinates.findIndex(c => c[0] === point.lon && c[1] === point.lat);
  assert.ok(at > 0 && at < coordinates.length - 1, 'the shared knot must be retained');
  const a = project(...coordinates[at - 1]), p = project(...coordinates[at]), b = project(...coordinates[at + 1]);
  const ux = p[0] - a[0], uy = p[1] - a[1], vx = b[0] - p[0], vy = b[1] - p[1];
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / Math.hypot(ux, uy) / Math.hypot(vx, vy)))) * 180 / Math.PI;
}
const uniqueVertices = result => vertices(result).filter((c, i, all) => !i || c[0] !== all[i - 1][0] || c[1] !== all[i - 1][1]);

test('elastic spline bends scale with point spacing and preserve tangent direction through colour joins', () => {
  const points = corners().map(p => ({...p, accuracy: null})), query = createHistoryQuery(points);
  let previousBend;
  for (const zoom of [16, 18]) for (const colorBy of ['time', 'speed', 'altitude']) {
    const result = query({mode: 'route', zoom, colorBy, smooth: true}), line = uniqueVertices(result);
    const bend = Math.min(...line.map(c => c[1]));
    assert.ok(bend < -.00005, 'the curve must bow along the edge, not round only eight pixels near a corner');
    if (previousBend !== undefined) assert.ok(Math.abs(bend - previousBend) < .000002, 'zoom must not change the spline shape');
    previousBend = bend;
    for (const p of points.slice(1, -1)) assert.ok(knotAngle(line, p) < 4.05, `${colorBy} has a visible kink`);
  }
});

test('Fit includes exact spline extrema even before zooming in or from an empty viewport', () => {
  const points = corners().map(p => ({...p, accuracy: null})), query = createHistoryQuery(points);
  const straight = query({mode: 'route', zoom: 8});
  const far = query({mode: 'route', zoom: 8, smooth: true, viewport: [100, 0, 110, 10]});
  assert.equal(far.routes.features.length, 0);
  assert.ok(far.bounds[0][1] < -.00005); assert.ok(far.bounds[1][1] > .00105);
  assert.equal(query({mode: 'route', zoom: 18, smooth: true}).bounds, far.bounds);
  assert.equal(query({mode: 'route', zoom: 18}).bounds, straight.bounds);
  assert.deepEqual(straight.bounds.map(c => c[1]), [0, .001]);
});

test('spline Fit keeps wrapped longitudes and separate runs close to the dateline', () => {
  const points = [point(0, 179.1), point(60000, 179.2), point(86400000, -179.2), point(86460000, -179.1)];
  const query = createHistoryQuery(points), result = query({mode: 'route', smooth: true, zoom: 8});
  assert.ok(result.bounds[1][0] - result.bounds[0][0] < 2);
  assert.ok(result.bounds.flat().every(Number.isFinite));
});

test('spline Fit follows the displayed path when an uncertain fix rounds toward its neighbours', () => {
  const points = [point(0, 0, 0, {accuracy: 0}), point(60000, .001, .001, {accuracy: 500}), point(120000, .002, 0, {accuracy: 0})];
  const query = createHistoryQuery(points), raw = query({mode: 'route', zoom: 18});
  const smooth = query({mode: 'route', zoom: 18, smooth: true});
  assert.equal(raw.bounds[1][1], .001);
  assert.ok(smooth.bounds[1][1] < .0001);
  assert.equal(raw.count, smooth.count); assert.equal(raw.km, smooth.km);
});

test('a short edge between long edges stays part of the same continuous spline', () => {
  const points = [[0, 0], [.0004, 0], [.000402, .000002], [.0008, .0004]].map(([lon, lat], i) => point(i * 60000, lon, lat, {accuracy: null}));
  const query = createHistoryQuery(points);
  for (const colorBy of ['time', 'speed', 'altitude']) {
    const line = uniqueVertices(query({mode: 'route', colorBy, zoom: 18, smooth: true}));
    for (const p of points.slice(1, -1)) assert.ok(knotAngle(line, p) < 4.05, `${colorBy} spliced a straight edge into the spline`);
  }
});

test('zooming into a near reversal keeps the spline instead of reverting the whole track to chords', () => {
  const points = [[0, 0], [.001, 0], [.000999, .000001], [.002, .001]].map(([lon, lat], i) => point(i * 60000, lon, lat, {accuracy: null}));
  const snapshot = JSON.stringify(points), query = createHistoryQuery(points);
  for (const colorBy of ['time', 'speed', 'altitude']) for (const zoom of [16, 18, 20]) {
    const options = {mode: 'route', colorBy, zoom};
    const straight = query(options), smooth = query({...options, smooth: true});
    assert.notDeepEqual(smooth.routes, straight.routes, `${colorBy} reverted at zoom ${zoom}`);
    assert.ok(vertices(smooth).every(c => c.every(Number.isFinite)));
    assert.ok(vertices(smooth).length < 2000);
    assert.equal(smooth.count, straight.count); assert.equal(smooth.km, straight.km);
    assert.equal(query({...options, smooth: true}).routes, smooth.routes);
  }
  assert.equal(JSON.stringify(points), snapshot);
});

test('unevenly spaced spline samples agree with independent centripetal interpolation', () => {
  const points = [[-.002, .001], [0, 0], [.001, .003], [.02, .001]].map(([lon, lat], i) => point(i * 3600000, lon, lat, {accuracy: null}));
  const xy = points.map(p => project(p.lon, p.lat)), knots = [0];
  for (let i = 1; i < 4; i++) knots.push(knots.at(-1) + Math.sqrt(Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1])));
  const mix = (a, b, lo, hi, t) => a.map((value, i) => ((hi - t) * value + (t - lo) * b[i]) / (hi - lo));
  const samples = Array.from({length: 1001}, (_, i) => {
    const t = knots[1] + (knots[2] - knots[1]) * i / 1000;
    const a = xy.slice(0, 3).map((p, k) => mix(p, xy[k + 1], knots[k], knots[k + 1], t));
    const b = [mix(a[0], a[1], knots[0], knots[2], t), mix(a[1], a[2], knots[1], knots[3], t)];
    const [x, y] = mix(b[0], b[1], knots[1], knots[2], t);
    return {lon: x * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI};
  });
  const result = createHistoryQuery(points)({mode: 'route', colorBy: 'speed', zoom: 16, smooth: true});
  assert.ok(errorPixels(samples, result.routes.features[1].geometry.coordinates, 16) < .3);
});

test('subdivision budget falls back for the whole path and caches the fallback', () => {
  const corners = [[0, 0], [.001, 0], [.001, .001], [0, .001]];
  const points = Array.from({length: 9000}, (_, i) => point(i * 1000, ...corners[i % 4], {accuracy: null}));
  const query = createHistoryQuery(points), options = {mode: 'route', colorBy: 'speed', zoom: 18};
  const straight = query(options), result = query({...options, smooth: true});
  assert.deepEqual(result.routes, straight.routes);
  assert.equal(query({...options, smooth: true, viewport: [-1, -1, 1, 1]}).routes, result.routes);
});

test('curve overhang is included when original observations are just outside the viewport', () => {
  const points = [[-.001, .001], [0, 0], [.001, 0], [.002, .001]].map(([lon, lat], i) => point(i * 60000, lon, lat, {accuracy: null}));
  const query = createHistoryQuery(points), options = {mode: 'route', colorBy: 'speed', zoom: 18, viewport: [.0003, -.00002, .0007, -.000001]};
  assert.equal(query(options).routes.features.length, 0);
  const smooth = query({...options, smooth: true});
  assert.equal(smooth.visible, 0);
  assert.ok(vertices(smooth).some(([lon, lat]) => lon >= .0003 && lon <= .0007 && lat < -.000001));
});

test('smoothing never connects devices or recording gaps', () => {
  const a = {device: 'a', source: 1}, b = {device: 'b', source: 1};
  const points = [...corners().map(p => ({...p, stream: a})), ...corners().map(p => ({...p, t: p.t + 500, lon: p.lon + .1, stream: b})), ...corners().map(p => ({...p, t: p.t + DAY, lon: p.lon + 1, stream: a}))].sort((a, b) => a.t - b.t);
  const query = createHistoryQuery(points);
  for (const colorBy of ['time', 'speed', 'altitude']) {
    const result = query({mode: 'route', zoom: 18, smooth: true, colorBy});
    assert.ok(result.routes.features.every(f => Math.max(...f.geometry.coordinates.map(c => c[0])) - Math.min(...f.geometry.coordinates.map(c => c[0])) < .01));
  }
});
