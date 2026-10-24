import {DAY, shiftPeriod} from './data.mjs?v=15';

// Preset IDs stay compatible with saved preferences. Calendar windows use UTC
// calendar arithmetic; a preferred day avoids drifting after February or April.
function offset(start, period, amount, day = new Date(start).getUTCDate()) {
  if (period === '1' || period === '7') return start + amount * Number(period) * DAY;
  const date = new Date(start), months = amount * (period === '365' ? 12 : period === '90' ? 3 : 1);
  const month = new Date(start);
  month.setUTCDate(1); month.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(month);
  last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
  month.setUTCDate(Math.min(day, last.getUTCDate()));
  return month.getTime();
}

export function resizeWindow(start, period, min, max, day) {
  if (period === 'all') return {start: min, end: max};
  start = Math.max(min, Math.floor(start / DAY) * DAY);
  let end = offset(start, period, 1, day) - 1;
  if (end > max) { end = max; start = Math.max(min, offset(max + 1, period, -1)); }
  return {start, end};
}

export function shiftWindow(start, end, min, max, direction, period, day) {
  if (!['30', '90', '365'].includes(period)) return shiftPeriod(start, end, min, max, direction);
  if ((direction < 0 && start <= min) || (direction > 0 && end >= max)) return {start, end};
  const nextStart = offset(start, period, direction, day);
  const nextEnd = offset(start, period, direction + 1, day) - 1;
  if (nextStart < min || nextEnd > max) return resizeWindow(Math.max(min, nextStart), period, min, max);
  return {start: nextStart, end: nextEnd};
}

// Match the worker's UTC-day bins exactly: selecting a bar must reproduce its
// count. Histories shorter than the bar count have empty, disabled intervals.
export function histogramWindow(min, max, index, count) {
  const firstDay = Math.floor(min / DAY), days = Math.floor(max / DAY) - firstDay + 1;
  const start = Math.ceil(index * days / count), end = Math.ceil((index + 1) * days / count);
  return start === end ? null : {start: (firstDay + start) * DAY, end: (firstDay + end) * DAY - 1};
}
