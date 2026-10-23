import {DAY, shiftPeriod} from './data.mjs?v=4';

// Preset IDs stay compatible with saved preferences. Months and years use UTC
// calendar arithmetic; a preferred day avoids drifting after February or April.
function offset(start, period, amount, day = new Date(start).getUTCDate()) {
  if (period === '1') return start + amount * DAY;
  const date = new Date(start), months = amount * (period === '365' ? 12 : 1);
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
  if (period !== '30' && period !== '365') return shiftPeriod(start, end, min, max, direction);
  if ((direction < 0 && start <= min) || (direction > 0 && end >= max)) return {start, end};
  const nextStart = offset(start, period, direction, day);
  const nextEnd = offset(start, period, direction + 1, day) - 1;
  if (nextStart < min || nextEnd > max) return resizeWindow(Math.max(min, nextStart), period, min, max);
  return {start: nextStart, end: nextEnd};
}

// Histogram bins partition the original timestamps. Date controls operate on
// whole UTC days, so select the dates covering the clicked interval.
export function histogramWindow(min, max, index, count) {
  const duration = Math.max(1, max - min);
  const start = Math.min(max, Math.ceil(min + index / count * duration));
  const end = index === count - 1 ? max : Math.ceil(min + (index + 1) / count * duration) - 1;
  return {start: Math.floor(start / DAY) * DAY, end: Math.floor(Math.max(start, end) / DAY) * DAY + DAY - 1};
}
