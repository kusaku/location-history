import test from 'node:test';
import assert from 'node:assert/strict';
import {resizeWindow, shiftWindow, dragWindow} from '../js/timeline.mjs';
import {DAY, preparePoints, createHistoryQuery} from '../js/data.mjs';

const time = date => Date.parse(`${date}T00:00:00Z`);
const range = (start, end) => ({start: time(start), end: time(end) + DAY - 1});
const min = time('2020-01-01'), max = time('2030-12-31') + DAY - 1;

test('size buttons resize from the current start instead of jumping to the newest history', () => {
  const start = time('2024-02-10');
  assert.deepEqual(resizeWindow(start, '1', min, max), range('2024-02-10', '2024-02-10'));
  assert.deepEqual(resizeWindow(start, '30', min, max), range('2024-02-10', '2024-03-09'));
  assert.deepEqual(resizeWindow(start, '90', min, max), range('2024-02-10', '2024-05-09'));
  assert.deepEqual(resizeWindow(start, '365', min, max), range('2024-02-10', '2025-02-09'));
  assert.deepEqual(resizeWindow(start, 'all', min, max), {start: min, end: max});
});

test('calendar windows preserve their preferred day across short months and leap years', () => {
  let window = resizeWindow(time('2024-01-31'), '30', min, max);
  assert.deepEqual(window, range('2024-01-31', '2024-02-28'));
  window = shiftWindow(window.start, window.end, min, max, 1, '30', 31);
  assert.deepEqual(window, range('2024-02-29', '2024-03-30'));
  const february = {...window};
  assert.deepEqual(resizeWindow(window.start, '30', min, max, 31), february);
  window = shiftWindow(window.start, window.end, min, max, 1, '30', 31);
  assert.deepEqual(window, range('2024-03-31', '2024-04-29'));
  assert.deepEqual(shiftWindow(window.start, window.end, min, max, -1, '30', 31), february);
  assert.deepEqual(shiftWindow(february.start, february.end, min, max, -1, '30', 31), range('2024-01-31', '2024-02-28'));
  window = resizeWindow(time('2024-02-29'), '365', min, max);
  const leapYear = {...window};
  for (let year = 2025; year <= 2028; year++) {
    window = shiftWindow(window.start, window.end, min, max, 1, '365', 29);
    assert.equal(window.start, time(`${year}-02-${year === 2028 ? '29' : '28'}`));
  }
  for (let year = 2027; year >= 2024; year--) window = shiftWindow(window.start, window.end, min, max, -1, '365', 29);
  assert.deepEqual(window, leapYear);
});

test('day and custom navigation shift both endpoints by the full window duration', () => {
  for (const days of [1, 7, 29, 365]) for (const direction of [-1, 1]) {
    const start = time('2024-01-15'), end = start + days * DAY - 1;
    assert.deepEqual(shiftWindow(start, end, min, max, direction, days === 1 ? '1' : null), {start: start + direction * days * DAY, end: end + direction * days * DAY});
  }
});

test('resizing and stepping stay inside short histories and stop at the endpoints', () => {
  const min = time('2024-01-01'), max = time('2024-03-10') + DAY - 1;
  assert.deepEqual(resizeWindow(time('2024-03-10'), '30', min, max), range('2024-02-11', '2024-03-10'));
  assert.deepEqual(resizeWindow(min, '365', min, max), {start: min, end: max});
  for (const period of ['1', '7', '30', '90', '365', null]) {
    assert.deepEqual(shiftWindow(min, max, min, max, 1, period), {start: min, end: max});
    assert.deepEqual(shiftWindow(min, max, min, max, -1, period), {start: min, end: max});
  }
  let window = resizeWindow(min, '30', min, max), steps = 0;
  while (window.end < max) {
    window = shiftWindow(window.start, window.end, min, max, 1, '30', 1);
    assert.ok(++steps < 10);
    assert.ok(window.start >= min && window.end <= max && window.start <= window.end);
  }
  assert.deepEqual(shiftWindow(window.start, window.end, min, max, 1, '30', 1), window);
});

test('quarters step three calendar months and preserve month-end anchors in both directions', () => {
  const january = resizeWindow(time('2024-01-31'), '90', min, max);
  assert.deepEqual(january, range('2024-01-31', '2024-04-29'));
  const april = shiftWindow(january.start, january.end, min, max, 1, '90', 31);
  assert.deepEqual(april, range('2024-04-30', '2024-07-30'));
  assert.deepEqual(resizeWindow(april.start, '90', min, max, 31), april);
  const july = shiftWindow(april.start, april.end, min, max, 1, '90', 31);
  assert.deepEqual(july, range('2024-07-31', '2024-10-30'));
  assert.deepEqual(shiftWindow(july.start, july.end, min, max, -1, '90', 31), april);
  assert.deepEqual(shiftWindow(april.start, april.end, min, max, -1, '90', 31), january);
});

test('calendar histogram windows partition UTC dates and exactly reproduce filtered counts', () => {
  for (const [min, max] of [[1234, 1234], [DAY - 1, DAY - 1], [-5000, 5000], [0, 6 * DAY], [0, 62 * DAY], [0, 63 * DAY], [0, 64 * DAY], [time('2013-06-02') + 3600000, time('2022-09-18') + 7200000]]) {
    const points = preparePoints(Array.from({length: 257}, (_, i) => ({t: min + (max - min) * i / 256, lat: 52, lon: 13, accuracy: null, duration: 0}))).points;
    const query = createHistoryQuery(points);
    for (const histogramWidth of [96, 320, 1200]) for (const filter of [{}, {hourStart: 1, hourEnd: 3}, {accuracyUnknown: false}]) {
      const filters = {...filter, histogramWidth};
      const {histogram, histogramRanges, count} = query(filters);
      assert.equal(histogram.length, histogramRanges.length);
      let previousEnd = Math.floor(min / DAY) * DAY - 1, total = 0;
      for (let i = 0; i < histogram.length; i++) {
        const window = histogramRanges[i];
        assert.ok(window.start % DAY === 0);
        assert.ok((window.end + 1) % DAY === 0);
        assert.equal(window.start, previousEnd + 1);
        assert.equal(query({...filters, ...window}).count, histogram[i]);
        total += histogram[i]; previousEnd = window.end;
      }
      assert.equal(total, count);
      assert.equal(previousEnd, Math.floor(max / DAY) * DAY + DAY - 1);
    }
  }
});

test('daily bars are not capped at 64, fill the history and preserve empty days', () => {
  const point = t => ({t, lat: 52, lon: 13, accuracy: null, duration: 0});
  for (let days = 1; days <= 100; days++) {
    const points = Array.from({length: days}, (_, day) => point(day * DAY + 3600000));
    assert.deepEqual(createHistoryQuery(points)({histogramWidth: 1200}).histogram, Array(days).fill(1), `${days} days`);
  }
  assert.deepEqual(createHistoryQuery([point(0), point(3 * DAY)])().histogram, [1, 0, 0, 1]);
});

const histogramQuery = (start, end) => createHistoryQuery([
  {t: time(start), lat: 52, lon: 13, accuracy: null, duration: 0},
  {t: time(end), lat: 52, lon: 13, accuracy: null, duration: 0},
]);

test('weekly bars start on Monday and clip only the history edges across New Year', () => {
  const result = histogramQuery('2023-12-31', '2024-01-09')({histogramWidth: 96});
  assert.equal(result.histogramUnit, 'week');
  assert.deepEqual(result.histogramRanges, [range('2023-12-31', '2023-12-31'), range('2024-01-01', '2024-01-07'), range('2024-01-08', '2024-01-09')]);
  assert.deepEqual(result.histogram, [1, 0, 1]);
});

test('monthly and quarterly bars use real UTC calendar boundaries, including leap February', () => {
  const month = histogramQuery('2024-01-10', '2024-12-11')({histogramWidth: 144});
  assert.equal(month.histogramUnit, 'month');
  assert.equal(month.histogram.length, 12);
  assert.deepEqual(month.histogramRanges[0], range('2024-01-10', '2024-01-31'));
  assert.deepEqual(month.histogramRanges[1], range('2024-02-01', '2024-02-29'));
  assert.deepEqual(month.histogramRanges.at(-1), range('2024-12-01', '2024-12-11'));
  const quarter = histogramQuery('2023-09-14', '2024-05-11')({histogramWidth: 48});
  assert.equal(quarter.histogramUnit, 'quarter');
  assert.deepEqual(quarter.histogramRanges, [range('2023-09-14', '2023-09-30'), range('2023-10-01', '2023-12-31'), range('2024-01-01', '2024-03-31'), range('2024-04-01', '2024-05-11')]);
});

test('panel resizing changes resolution without invalidating selection, geometry or same-unit bins', () => {
  const query = histogramQuery('2023-01-01', '2026-12-31');
  const wide = query({mode: 'route', histogramWidth: 1200});
  assert.equal(wide.histogramUnit, 'month'); assert.equal(wide.histogram.length, 48);
  const same = query({mode: 'route', histogramWidth: 1100});
  assert.equal(same.histogram, wide.histogram); assert.equal(same.histogramRanges, wide.histogramRanges);
  const narrow = query({mode: 'route', histogramWidth: 320});
  assert.equal(narrow.histogramUnit, 'quarter'); assert.equal(narrow.histogram.length, 16);
  assert.equal(narrow.routes, wide.routes); assert.equal(narrow.bounds, wide.bounds);
  assert.equal(narrow.count, wide.count); assert.equal(narrow.km, wide.km);
  const selected = query({...range('2023-01-01', '2023-01-01'), mode: 'route', histogramWidth: 320});
  assert.equal(selected.histogram, narrow.histogram); assert.equal(selected.histogramRanges, narrow.histogramRanges);
  assert.equal(selected.count, 1); assert.equal(selected.histogram.reduce((n, v) => n + v, 0), 2);
});

test('block-prefix counts stay exact at partial/full blocks and repeated boundary timestamps', () => {
  for (const length of [0, 1, 255, 256, 257, 511, 512, 513, 1025]) {
    const points = Array.from({length}, (_, i) => ({t: Math.floor(i / 3) * DAY, lat: 52, lon: 13, accuracy: i % 3 ? 20 : 100, duration: 0}));
    const query = createHistoryQuery(points);
    for (const histogramWidth of [96, 320, 1200]) for (const accuracy of [0, 50]) {
      const result = query({accuracy, histogramWidth});
      assert.equal(result.histogram.reduce((n, v) => n + v, 0), points.filter(p => !accuracy || p.accuracy <= accuracy).length);
      result.histogramRanges.forEach(({start, end}, i) => assert.equal(result.histogram[i], points.filter(p => p.t >= start && p.t <= end && (!accuracy || p.accuracy <= accuracy)).length));
    }
  }
});

test('calendar bins cover visit end dates without inventing new observations', () => {
  const query = createHistoryQuery([{t: time('2024-01-01'), lat: 52, lon: 13, accuracy: null, duration: 40 * DAY}]);
  const result = query({histogramWidth: 1200});
  assert.equal(result.histogramUnit, 'day'); assert.equal(result.histogram.length, 40);
  assert.deepEqual(result.histogram, [1, ...Array(39).fill(0)]);
  assert.deepEqual(result.histogramRanges.at(-1), range('2024-02-09', '2024-02-09'));
});

test('very long and extreme valid histories keep a bounded number of calendar-year bins', () => {
  for (const [start, end] of [[time('1800-04-01'), time('2026-10-31')], [-8.64e15, 8.64e15]]) {
    const query = createHistoryQuery([start, end].map(t => ({t, lat: 52, lon: 13, accuracy: null, duration: 0})));
    const result = query({histogramWidth: 320});
    assert.match(result.histogramUnit, /year/);
    assert.ok(result.histogram.length <= 32);
    assert.equal(result.histogram.reduce((n, v) => n + v, 0), 2);
    assert.equal(result.histogramRanges[0].start, start);
    assert.ok(result.histogramRanges.every(({start, end}) => Number.isFinite(start) && Number.isFinite(end) && end >= start));
  }
});

test('Week resizes the current window to seven UTC days and steps by the whole week', () => {
  const week = resizeWindow(time('2024-02-26'), '7', min, max);
  assert.deepEqual(week, range('2024-02-26', '2024-03-03'));
  const next = shiftWindow(week.start, week.end, min, max, 1, '7');
  assert.deepEqual(next, range('2024-03-04', '2024-03-10'));
  assert.deepEqual(shiftWindow(next.start, next.end, min, max, -1, '7'), week);
  assert.deepEqual(resizeWindow(time('2024-03-10'), '7', time('2024-03-01'), time('2024-03-10') + DAY - 1), range('2024-03-04', '2024-03-10'));
});

test('both thumbs translate every fixed preset by whole UTC days without changing its duration', () => {
  for (const period of ['1', '7', '30', '90', '365']) {
    const window = resizeWindow(time('2024-02-10'), period, min, max);
    const shifted = {start: window.start + 45 * DAY, end: window.end + 45 * DAY};
    assert.deepEqual(dragWindow(window.start, window.end, min, max, shifted.start, 'start', period), shifted);
    assert.deepEqual(dragWindow(window.start, window.end, min, max, shifted.end, 'end', period), shifted);
    assert.deepEqual(dragWindow(shifted.start, shifted.end, min, max, window.start, 'start', period), window);
  }
});

test('dragging fixed windows clamps both ends to history bounds, including overshooting the opposite thumb', () => {
  const min = time('2024-01-01'), max = time('2024-12-31') + DAY - 1;
  for (const period of ['1', '7', '30', '90', '365']) {
    const window = resizeWindow(time('2024-04-15'), period, min, max), width = window.end - window.start;
    for (const edge of ['start', 'end']) {
      assert.deepEqual(dragWindow(window.start, window.end, min, max, min - DAY, edge, period), {start: min, end: min + width});
      assert.deepEqual(dragWindow(window.start, window.end, min, max, max + DAY, edge, period), {start: max - width, end: max});
    }
  }
});

test('calendar-preset dragging preserves actual day count through February and leap-year boundaries', () => {
  const month = range('2024-01-31', '2024-02-28');
  assert.deepEqual(dragWindow(month.start, month.end, min, max, time('2024-02-29'), 'start', '30'), range('2024-02-29', '2024-03-28'));
  const year = range('2024-01-01', '2024-12-31');
  assert.deepEqual(dragWindow(year.start, year.end, min, max, time('2025-01-01'), 'start', '365'), range('2025-01-01', '2026-01-01'));
  const dragged = dragWindow(month.start, month.end, min, max, time('2024-03-10'), 'start', '30');
  assert.deepEqual(shiftWindow(dragged.start, dragged.end, min, max, 1, '30', new Date(dragged.start).getUTCDate()), range('2024-04-10', '2024-05-09'));
});

test('unlocked thumbs resize independently, stay ordered and can expand again after meeting', () => {
  const window = range('2024-04-10', '2024-04-20');
  const day = range('2024-04-10', '2024-04-10');
  for (const period of ['all', null, undefined]) {
    assert.deepEqual(dragWindow(window.start, window.end, min, max, time('2024-04-15'), 'start', period), range('2024-04-15', '2024-04-20'));
    assert.deepEqual(dragWindow(window.start, window.end, min, max, time('2024-04-15'), 'end', period), range('2024-04-10', '2024-04-15'));
    assert.deepEqual(dragWindow(window.start, window.end, min, max, max, 'start', period), range('2024-04-20', '2024-04-20'));
    assert.deepEqual(dragWindow(window.start, window.end, min, max, min, 'end', period), range('2024-04-10', '2024-04-10'));
    assert.deepEqual(dragWindow(day.start, day.end, min, max, time('2024-04-20'), 'end', period), window);
  }
});

test('a fixed preset larger than the history stays fixed at that complete history', () => {
  const min = time('2024-01-01'), max = time('2024-01-03') + DAY - 1;
  const window = resizeWindow(min, '365', min, max);
  for (const edge of ['start', 'end']) for (const target of [min - DAY, max + DAY]) assert.deepEqual(dragWindow(window.start, window.end, min, max, target, edge, '365'), window);
});


test('ISO date entry rejects invalid dates and keeps UTC day labels independent of locale', async () => {
  const {parseDay, formatDay, formatDateTime} = await import('../js/timeline.mjs');
  assert.equal(parseDay('2024-02-29'), Date.UTC(2024, 1, 29));
  assert.equal(parseDay('2019-11-30'), Date.UTC(2019, 10, 30));
  assert.equal(formatDay(parseDay('2019-11-30')), 'Sat, 2019-11-30');
  assert.equal(formatDay(Date.UTC(2024, 2, 31, 23, 59)), 'Sun, 2024-03-31');
  assert.equal(formatDateTime(Date.UTC(2016, 6, 18, 5, 10)), 'Mon, 2016-07-18, 05:10');
  assert.equal(formatDateTime(Date.UTC(2024, 1, 29)), 'Thu, 2024-02-29, 00:00');
  assert.equal(formatDateTime(Date.parse('2024-03-31T00:30:00+02:00')), 'Sat, 2024-03-30, 22:30');
  for (const value of ['', '2023-02-29', '2024-02-30', '2024-04-31', '2024-13-01', '2024-00-01', '2024-01-00', '30/11/2019', '2019-1-01', '2019-11-30T00:00:00Z', '0000-01-01', null]) assert.ok(Number.isNaN(parseDay(value)));
});
