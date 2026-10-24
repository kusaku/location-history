import test from 'node:test';
import assert from 'node:assert/strict';
import {resizeWindow, shiftWindow, histogramWindow} from '../../assets/js/timeline.mjs';
import {DAY, preparePoints, createHistoryQuery} from '../../assets/js/data.mjs';

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

test('histogram windows partition UTC dates and exactly reproduce counts, including short histories', () => {
  for (const [min, max] of [[1234, 1234], [DAY - 1, DAY - 1], [-5000, 5000], [time('2013-06-02') + 3600000, time('2022-09-18') + 7200000]]) {
    const points = preparePoints(Array.from({length: 257}, (_, i) => ({t: min + (max - min) * i / 256, lat: 52, lon: 13, accuracy: null, duration: 0}))).points;
    const query = createHistoryQuery(points);
    for (const filters of [{}, {hourStart: 1, hourEnd: 3}]) {
      const {histogram, count} = query(filters);
      assert.equal(histogram.length, 64);
      let previousEnd = Math.floor(min / DAY) * DAY - 1, total = 0;
      for (let i = 0; i < histogram.length; i++) {
        const window = histogramWindow(min, max, i, histogram.length);
        if (!window) { assert.equal(histogram[i], 0); continue; }
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

test('Week resizes the current window to seven UTC days and steps by the whole week', () => {
  const week = resizeWindow(time('2024-02-26'), '7', min, max);
  assert.deepEqual(week, range('2024-02-26', '2024-03-03'));
  const next = shiftWindow(week.start, week.end, min, max, 1, '7');
  assert.deepEqual(next, range('2024-03-04', '2024-03-10'));
  assert.deepEqual(shiftWindow(next.start, next.end, min, max, -1, '7'), week);
  assert.deepEqual(resizeWindow(time('2024-03-10'), '7', time('2024-03-01'), time('2024-03-10') + DAY - 1), range('2024-03-04', '2024-03-10'));
});
