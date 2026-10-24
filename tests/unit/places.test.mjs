import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryQuery, placePolygon, DAY, QUALITY} from '../../assets/js/data.mjs';
const minute = 60_000;
const point = (t, lon = 13, lat = 52, duration = 0, accuracy = null) => ({t, lon, lat, duration, accuracy});
const area = coordinates => ({type: 'Feature', properties: {}, geometry: placePolygon(coordinates)});
const box = area([[12, 51], [14, 51], [14, 53], [12, 53]]);
test('place history counts recorded visits, observations, days and conservative time', () => {
  const query = createHistoryQuery([point(0, 13, 52, 10 * minute), point(10 * minute, 13, 52, 10 * minute), point(20 * minute, 15), point(25 * minute, 13, 52, 10 * minute), point(65 * minute)]);
  const result = query.place(box);
  assert.equal(result.count, 4); assert.equal(result.visits, 3); assert.equal(result.days, 1);
  assert.equal(result.first, 0); assert.equal(result.last, 65 * minute); assert.equal(result.minutes, 30);
  assert.deepEqual(result.recent.map(v => v.start), [65 * minute, 25 * minute, 0]);
  assert.equal(result.recent[2].count, 2);
});
test('place time clips to exits, hours, date windows and the union of overlapping intervals', () => {
  const query = createHistoryQuery([point(8 * 60 * minute, 13, 52, 60 * minute), point(8 * 60 * minute + 10 * minute, 13, 52, 60 * minute)]);
  assert.equal(query.place(box, {hourStart: 8, hourEnd: 9}).minutes, 60);
  assert.equal(query.place(box, {end: 8 * 60 * minute + 30 * minute - 1}).minutes, 30);
  const exit = createHistoryQuery([point(0, 13, 52, 60 * minute), point(10 * minute, 15)]);
  assert.equal(exit.place(box).minutes, 10);
});
test('place queries honor accuracy and quality exclusions and retain empty results', () => {
  const query = createHistoryQuery([point(0, 13, 52, 0, 500), point(DAY)]);
  assert.equal(query.place(box, {accuracy: 100}).count, 1);
  assert.equal(query.place(box, {exclude: QUALITY.accuracy}).count, 1);
  assert.equal(query.place(box, {exclude: QUALITY.gaps}).count, 0);
  const empty = query.place(box, {start: DAY * 2});
  assert.deepEqual(empty, {count: 0, days: 0, first: null, last: null, minutes: 0, visits: 0, recent: []});
});
test('indexed place membership agrees with a chronological scan, including dateline wrapping', () => {
  const points = Array.from({length: 1000}, (_, i) => point(i, i % 2 ? 0 : 13, i % 2 ? 0 : 52));
  const query = createHistoryQuery(points);
  assert.equal(query.place(box, {start: 100, end: 500}).count, points.filter(p => p.lon === 13 && p.t >= 100 && p.t <= 500).length);
  const dateline = area([[179, -1], [-179, -1], [-179, 1], [179, 1]]);
  assert.equal(createHistoryQuery([point(0, 179.5, 0), point(1, -179.5, 0), point(2, 0, 0)]).place(dateline).count, 2);
});
test('concave polygons include their edges but exclude the missing corner of the bounding box', () => {
  const shape = area([[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]);
  const query = createHistoryQuery([point(0, .5, .5), point(1, 1.5, 1.5), point(2, 0, 1)]);
  assert.equal(query.place(shape).count, 2);
});
test('a clicked hexagon uses its original bin, even at minimum size and high zoom', () => {
  const points = Array.from({length: 50}, (_, i) => point(i * minute, 13 + i % 10 * .00001, 52 + Math.floor(i / 10) * .00001));
  const query = createHistoryQuery(points);
  for (const zoom of [10, 18, 20]) {
    const result = query({mode: 'hex', zoom, radius: 2});
    for (const feature of result.density.features) {
      assert.match(feature.properties.cell, /^hex:/);
      assert.equal(query.place(JSON.parse(JSON.stringify(feature))).count, feature.properties.count);
    }
  }
});
test('all-date place queries and repeat clicks preserve cached map statistics and routes', () => {
  const query = createHistoryQuery([point(0), point(minute), point(DAY), point(DAY + minute)]);
  const map = query({start: DAY, mode: 'route'});
  const place = query.place(box);
  assert.equal(place.count, 4); assert.equal(query.place(box), place);
  const after = query({start: DAY, mode: 'route'});
  assert.equal(after.routes, map.routes); assert.equal(after.histogram, map.histogram); assert.equal(after.bounds, map.bounds);
});
test('visit details are bounded while totals remain exact', () => {
  const result = createHistoryQuery(Array.from({length: 100}, (_, i) => point(i * 60 * minute))).place(box);
  assert.equal(result.visits, 100); assert.equal(result.count, 100); assert.equal(result.recent.length, 30);
  assert.equal(result.recent[0].start, 99 * 60 * minute);
});
test('invalid, self-crossing, degenerate and oversized areas fail explicitly', () => {
  for (const ring of [[], [[0, 0], [1, 1]], [[0, 0], [1, 0], [2, 0]], [[0, 0], [2, 2], [0, 2], [2, 0]], [[0, 91], [1, 0], [0, 1]], Array.from({length: 66}, (_, i) => [i, 0])]) assert.throws(() => placePolygon(ring));
  assert.throws(() => createHistoryQuery([]).place(null));
});
