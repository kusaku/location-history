import {DAY, shiftPeriod} from './data.mjs?v=42';

// Visible dates are ISO in every browser; all calendar arithmetic stays in UTC.
const weekday = new Intl.DateTimeFormat('en', {weekday: 'short', timeZone: 'UTC'});
export const formatDay = value => `${weekday.format(value)}, ${new Date(value).toISOString().slice(0, 10)}`;
export const formatDateTime = value => `${formatDay(value)}, ${new Date(value).toISOString().slice(11, 16)}`;
export function parseDay(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}

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

// Dragging a fixed window translates its existing duration, including across
// short months/leap years. Only All time lets either endpoint resize it.
export function dragWindow(start, end, min, max, target, edge, period) {
  const day = Math.floor(target / DAY) * DAY;
  if (period === 'all') {
    return edge === 'start'
      ? {start: Math.max(min, Math.min(Math.floor(end / DAY) * DAY, day)), end}
      : {start, end: Math.min(max, Math.max(start + DAY - 1, day + DAY - 1))};
  }
  const wanted = edge === 'start' ? day - start : day + DAY - 1 - end;
  const delta = Math.max(min - start, Math.min(max - end, wanted));
  return {start: start + delta, end: end + delta};
}
