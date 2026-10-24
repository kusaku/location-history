import {DAY, placePolygon} from './data.mjs?v=17';

const $ = id => document.getElementById(id);
const empty = () => ({type: 'FeatureCollection', features: []});
const number = new Intl.NumberFormat('en');
const timestamp = new Intl.DateTimeFormat('en', {day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC'});
const time = value => value === null ? '—' : timestamp.format(value);
const utcDate = value => new Date(value).toISOString().slice(0, 10);
const utcTime = value => new Date(value).toISOString().slice(0, 16).replace('T', ' ');
const duration = minutes => {
  const rounded = Math.round(minutes);
  return minutes === 0 ? '0 min' : minutes < 1 ? '<1 min' : rounded < 60 ? `${rounded} min` : `${number.format(Math.floor(rounded / 60))} h ${rounded % 60} min`;
};
const calendarDate = new Intl.DateTimeFormat('en', {weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'});
const monthName = new Intl.DateTimeFormat('en', {month: 'short', timeZone: 'UTC'});
const yearStart = year => { const date = new Date(0); date.setUTCFullYear(year, 0, 1); return date.getTime(); };

// Calendar arithmetic stays in UTC, including leap years and Monday-first weeks.
export function placeCalendarPeriod(anchor, view) {
  const date = new Date(anchor); date.setUTCHours(0, 0, 0, 0);
  if (view === 'year') date.setUTCMonth(0, 1);
  if (view === 'quarter') date.setUTCMonth(Math.floor(date.getUTCMonth() / 3) * 3, 1);
  if (view === 'month') date.setUTCDate(1);
  if (view === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  const start = +date;
  if (view === 'year') date.setUTCFullYear(date.getUTCFullYear() + 1);
  else if (view === 'quarter' || view === 'month') date.setUTCMonth(date.getUTCMonth() + (view === 'quarter' ? 3 : 1));
  else date.setUTCDate(date.getUTCDate() + (view === 'week' ? 7 : 1));
  return {start, end: +date - 1};
}

// Daily views reuse aggregate totals. Hourly views ask the indexed worker for
// only the visible day/week, with one pending request and stale-result checks.
export function createPlaceCalendar(select, requestHours = () => {}) {
  let days = new Map(), scope = null, anchor = null, active = true, revision = 0;
  let hourId = 0, hourPending = null, hourWanted = null, hourKey = null, hours = [], hourError = '';
  const kind = () => $('place-calendar-view').value || 'year';
  const clamp = value => Math.max(scope.historyStart, Math.min(scope.historyEnd, value));
  const latest = () => { let at = scope.start; for (const day of days.keys()) at = Math.max(at, day); return at; };
  function navigate(direction) {
    const view = kind(), date = new Date(placeCalendarPeriod(anchor, view).start);
    if (view === 'year') date.setUTCFullYear(date.getUTCFullYear() + direction);
    else if (view === 'quarter' || view === 'month') date.setUTCMonth(date.getUTCMonth() + direction * (view === 'quarter' ? 3 : 1));
    else date.setUTCDate(date.getUTCDate() + direction * (view === 'week' ? 7 : 1));
    anchor = clamp(direction < 0 ? +new Date(placeCalendarPeriod(+date, view).end) : +date);
    render();
  }
  function keyboard(cells, right, down = 1) {
    let focused = cells.findIndex(cell => !cell.disabled);
    if (focused >= 0) cells[focused].tabIndex = 0;
    cells.forEach((button, i) => {
      button.onfocus = () => {
        if (focused >= 0) cells[focused].tabIndex = -1;
        focused = i; button.tabIndex = 0; $('place-calendar-detail').textContent = button.title;
      };
      button.onkeydown = event => {
        const step = {ArrowLeft: -right, ArrowRight: right, ArrowUp: -down, ArrowDown: down}[event.key];
        let next = event.key === 'Home' ? 0 : event.key === 'End' ? cells.length - 1 : i + (step ?? 0);
        if (step === undefined && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        while (cells[next]?.disabled) next += step ?? (event.key === 'Home' ? 1 : -1);
        cells[next]?.focus();
      };
    });
  }
  function cell(at, entry, peak, metric, hourly = false) {
    const button = document.createElement('button'), count = entry?.count ?? 0, value = entry?.[metric] ?? 0;
    const day = Math.floor(at / DAY) * DAY, hour = new Date(at).getUTCHours();
    button.type = 'button'; button.dataset.date = utcDate(at);
    if (hourly) button.dataset.hour = hour;
    button.dataset.level = value > 0 ? Math.ceil(Math.sqrt(value / peak) * 4) : 0;
    button.style.setProperty('--activity', value > 0 ? `${Math.max(3, Math.sqrt(value / peak) * 100)}%` : '0%');
    button.disabled = !count || day < scope.start || day > scope.end; button.tabIndex = -1;
    const clock = value => `${String(value).padStart(2, '0')}:00`;
    button.title = `${calendarDate.format(at)}${hourly ? ` · ${clock(hour)}–${clock(hour + 1)} UTC` : ''} · ${number.format(count)} locations · ${duration(entry?.minutes ?? 0)}${day < scope.start || day > scope.end ? ' · outside selected dates' : ''}`;
    button.setAttribute('aria-label', button.title);
    button.onclick = () => select({start: day, end: day + DAY, ...(hourly ? {hour} : {})});
    button.onpointerenter = () => { $('place-calendar-detail').textContent = button.title; };
    return button;
  }
  function summary(rows, metric) {
    const recorded = rows.filter(row => row.count).length, minutes = rows.reduce((sum, row) => sum + row.minutes, 0);
    $('place-calendar-summary').textContent = `${number.format(recorded)} recorded ${kind() === 'day' || kind() === 'week' ? recorded === 1 ? 'hour' : 'hours' : recorded === 1 ? 'day' : 'days'} · ${duration(minutes)}`;
    const peak = rows.reduce((max, row) => Math.max(max, row[metric]), 0);
    $('place-calendar-scale').title = `Maximum per ${kind() === 'day' || kind() === 'week' ? 'hour' : 'day'}: ${metric === 'minutes' ? duration(peak) : `${number.format(peak)} locations`}`;
    return peak;
  }
  function renderDaily(view, period, metric) {
    const dates = [];
    for (let at = period.start; at <= period.end; at += DAY) dates.push(at);
    const peak = summary(dates.map(at => days.get(at)).filter(Boolean), metric);
    $('place-calendar-chart').className = `place-calendar-chart is-${view}`;
    if (view === 'quarter') {
      const months = [], cells = [];
      for (let month = 0; month < 3; month++) {
        const start = new Date(period.start); start.setUTCMonth(start.getUTCMonth() + month);
        const at = +start, end = placeCalendarPeriod(at, 'month').end;
        const section = document.createElement('section'), heading = document.createElement('h3'), grid = document.createElement('div');
        section.className = 'place-calendar-month'; grid.className = 'place-quarter-days';
        heading.textContent = `${monthName.format(at)} ${start.getUTCFullYear()}`;
        grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', heading.textContent);
        for (const name of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
          const label = document.createElement('span'); label.textContent = name; grid.append(label);
        }
        const offset = (start.getUTCDay() + 6) % 7;
        for (let day = at, i = 0; day <= end; day += DAY, i++) {
          const button = cell(day, days.get(day), peak, metric);
          button.textContent = i + 1;
          button.style.gridColumn = (offset + i) % 7 + 1; button.style.gridRow = Math.floor((offset + i) / 7) + 2;
          grid.append(button); cells.push(button);
        }
        section.append(heading, grid); months.push(section);
      }
      $('place-calendar-months').replaceChildren();
      $('place-calendar-days').replaceChildren(...months); keyboard(cells, 1, 7); return;
    }
    const offset = (new Date(period.start).getUTCDay() + (view === 'month' ? 6 : 0)) % 7;
    const weeks = Math.ceil((offset + dates.length) / 7), labels = [];
    $('place-calendar-chart').style.setProperty('--weeks', weeks);
    if (view === 'year') {
      for (let i = 0; i < dates.length; i++) if (i === 0 || new Date(dates[i]).getUTCDate() === 1) {
        const label = document.createElement('span'); label.textContent = monthName.format(dates[i]);
        const column = Math.floor((offset + i) / 7), next = new Date(dates[i]); next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1);
        const nextColumn = Math.min(weeks, Math.floor((offset + (+next - period.start) / DAY) / 7));
        label.style.gridColumn = `${column + 1} / span ${Math.max(1, Math.min(3, nextColumn - column))}`;
        label.style.gridRow = 1; labels.push(label);
      }
    } else for (const name of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      const label = document.createElement('span'); label.textContent = name; labels.push(label);
    }
    $('place-calendar-months').replaceChildren(...labels);
    const cells = dates.map((at, i) => {
      const entry = days.get(at), button = cell(at, entry, peak, metric);
      button.style.gridColumn = view === 'year' ? Math.floor((offset + i) / 7) + 1 : (offset + i) % 7 + 1;
      button.style.gridRow = view === 'year' ? (offset + i) % 7 + 1 : Math.floor((offset + i) / 7) + 1;
      if (view === 'month') {
        button.textContent = new Date(at).getUTCDate();
        if (entry) { const total = document.createElement('small'); total.textContent = metric === 'count' ? number.format(entry.count) : entry.minutes >= 60 ? `${Math.floor(entry.minutes / 60)} h` : duration(entry.minutes); button.append(total); }
      }
      return button;
    });
    keyboard(cells, view === 'year' ? 7 : 1, view === 'month' ? 7 : 1); $('place-calendar-days').replaceChildren(...cells);
  }
  function renderHourly(view, period, metric) {
    const range = {start: Math.max(period.start, scope.start), end: Math.min(period.end, scope.end + DAY - 1)};
    const intersects = range.start <= range.end;
    const key = JSON.stringify([revision, range.start, range.end]);
    hourWanted = intersects ? {key, ...range} : null;
    if (intersects && hourKey !== key && !hourPending) {
      hourPending = {key, id: ++hourId}; hourError = '';
      requestHours({id: hourId, ...range});
    }
    const data = new Map((intersects && hourKey === key ? hours : []).map(row => [row.start, row]));
    const peak = summary([...data.values()], metric), nodes = [], cells = [];
    $('place-calendar-hours').className = `place-calendar-hours is-${view}`;
    $('place-calendar-hours').setAttribute('aria-busy', String(intersects && hourKey !== key));
    const headerDate = new Intl.DateTimeFormat('en', {weekday: 'short', day: 'numeric', timeZone: 'UTC'});
    if (view === 'week') for (let d = 0; d < 7; d++) {
      const at = period.start + d * DAY, button = document.createElement('button'); button.type = 'button';
      button.className = 'place-calendar-day-heading'; button.textContent = headerDate.format(at);
      button.style.gridColumn = 1; button.style.gridRow = d + 2; button.disabled = at < scope.start || at > scope.end;
      button.title = `Select ${calendarDate.format(at)}`; button.onclick = () => select({start: at, end: at + DAY}); nodes.push(button);
    }
    const count = view === 'week' ? 168 : 24;
    for (let i = 0; i < count; i++) {
      const at = period.start + i * DAY / 24, row = data.get(at), button = cell(at, row, peak, metric, true);
      button.style.gridColumn = view === 'week' ? i % 24 + 2 : i + 1;
      button.style.gridRow = view === 'week' ? Math.floor(i / 24) + 2 : 1;
      cells.push(button);
      if (i % 3 === 0 && (view === 'day' || i < 24)) {
        const label = document.createElement('span'); label.textContent = String(i % 24).padStart(2, '0');
        label.style.gridColumn = view === 'week' ? i + 2 : i + 1; label.style.gridRow = view === 'week' ? 1 : 2; nodes.push(label);
      }
    }
    keyboard(cells, 1, view === 'week' ? 24 : 1);
    $('place-calendar-hours').replaceChildren(...nodes, ...cells);
    if (intersects && (hourKey !== key || hourError)) $('place-calendar-detail').textContent = hourError || 'Calculating hourly activity…';
  }
  function render() {
    if (!scope || !active) return;
    const view = kind(), year = new Date(anchor).getUTCFullYear();
    const period = placeCalendarPeriod(anchor, view);
    const metric = $('place-calendar-metric').value === 'minutes' ? 'minutes' : 'count', hourly = view === 'day' || view === 'week';
    $('place-calendar-detail').textContent = 'Select a day/hour to filter the map · UTC. Arrow keys navigate.';
    $('place-calendar-year').hidden = view !== 'year'; $('place-calendar-anchor').hidden = view === 'year';
    $('place-calendar-year').value = year; $('place-calendar-year').min = new Date(scope.historyStart).getUTCFullYear(); $('place-calendar-year').max = new Date(scope.historyEnd).getUTCFullYear();
    $('place-calendar-anchor').value = utcDate(anchor); $('place-calendar-anchor').min = utcDate(scope.historyStart); $('place-calendar-anchor').max = utcDate(scope.historyEnd);
    $('place-calendar-previous').disabled = period.start <= scope.historyStart;
    $('place-calendar-next').disabled = period.end >= scope.historyEnd;
    $('place-calendar-previous').setAttribute('aria-label', `Previous calendar ${view}`);
    $('place-calendar-next').setAttribute('aria-label', `Next calendar ${view}`);
    $('place-calendar-caption').textContent = view === 'week' ? `${calendarDate.format(period.start)} — ${calendarDate.format(period.end)}` : view === 'year' ? String(year) : view === 'quarter' ? `Q${Math.floor(new Date(anchor).getUTCMonth() / 3) + 1} · ${year}` : view === 'month' ? `${monthName.format(anchor)} ${year}` : calendarDate.format(anchor);
    $('place-calendar-chart').hidden = hourly; $('place-calendar-hours').hidden = !hourly;
    if (hourly) {
      $('place-calendar-days').replaceChildren(); $('place-calendar-months').replaceChildren();
      renderHourly(view, period, metric);
    } else { hourWanted = null; $('place-calendar-hours').replaceChildren(); renderDaily(view, period, metric); }
  }
  $('place-calendar-previous').onclick = () => navigate(-1); $('place-calendar-next').onclick = () => navigate(1);
  function enterYear(commit) {
    if (!scope) return;
    const raw = $('place-calendar-year').value, value = Number(raw);
    const min = new Date(scope.historyStart).getUTCFullYear(), max = new Date(scope.historyEnd).getUTCFullYear();
    if (raw !== '' && Number.isInteger(value) && (commit || value >= min && value <= max)) {
      anchor = clamp(yearStart(Math.max(min, Math.min(max, value)))); $('place-calendar-view').value = 'year'; render();
    } else if (commit) render();
  }
  $('place-calendar-year').oninput = () => enterYear(false); $('place-calendar-year').onchange = () => enterYear(true);
  $('place-calendar-anchor').onchange = () => {
    const at = Date.parse($('place-calendar-anchor').value);
    if (Number.isFinite(at)) anchor = clamp(at); render();
  };
  $('place-calendar-view').onchange = render;
  $('place-calendar-metric').onchange = render;
  return {
    setRows(rows, value) {
      days = new Map(rows.map(entry => [entry.start, entry]));
      scope = {
        start: Math.floor(value.start / DAY) * DAY, end: Math.floor(value.end / DAY) * DAY,
        historyStart: Math.floor((value.historyStart ?? value.start) / DAY) * DAY,
        historyEnd: Math.floor((value.historyEnd ?? value.end) / DAY) * DAY
      }; revision++;
      if (anchor === null) anchor = latest();
      render();
    },
    setActive(value) { active = value; render(); },
    receive(message) {
      if (!hourPending || message.id !== hourPending.id) return;
      const pending = hourPending; hourPending = null;
      if (hourWanted?.key === pending.key) { hourKey = pending.key; hours = message.hours ?? []; hourError = message.type === 'error' ? message.message : ''; }
      render();
    },
    clear() { days.clear(); scope = null; anchor = null; hourId++; hourPending = hourWanted = hourKey = null; hours = []; $('place-calendar-days').replaceChildren(); $('place-calendar-months').replaceChildren(); $('place-calendar-hours').replaceChildren(); }
  };
}

// Keep every result available, while rendering at most 100 rows per table.
// Sorting applies to the complete numeric data, never the formatted page.
export function createPlaceTable(id, columns, select) {
  let rows = [], page = 0, key = 'start', direction = -1;
  const pageSize = 100;
  const headings = columns.map(column => {
    const cell = document.createElement('th'), button = document.createElement('button');
    cell.setAttribute('scope', 'col'); button.type = 'button'; button.textContent = column.label;
    button.onclick = () => { direction = key === column.key ? -direction : -1; key = column.key; page = 0; sort(); render(); };
    cell.append(button); return cell;
  });
  $(`${id}-head`).replaceChildren(...headings);
  function sort() { rows.sort((a, b) => direction * (a[key] - b[key]) || b.start - a.start); }
  function render() {
    columns.forEach((column, i) => {
      headings[i].setAttribute('aria-sort', column.key === key ? direction < 0 ? 'descending' : 'ascending' : 'none');
      headings[i].children[0].setAttribute('aria-label', `Sort by ${column.label}, ${column.key === key && direction < 0 ? 'ascending' : 'descending'}`);
    });
    $(id).replaceChildren(...rows.slice(page * pageSize, (page + 1) * pageSize).map(entry => {
      const row = document.createElement('tr');
      columns.forEach((column, i) => {
        const cell = document.createElement('td'), value = column.format(entry[column.key]);
        if (i === 0) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = value;
          button.title = 'Select these dates'; button.onclick = () => select(entry); cell.append(button);
        } else cell.textContent = value;
        row.append(cell);
      });
      return row;
    }));
    $(`${id}-pagination`).hidden = rows.length <= pageSize;
    $(`${id}-page`).textContent = rows.length ? `${number.format(page * pageSize + 1)}–${number.format(Math.min((page + 1) * pageSize, rows.length))} of ${number.format(rows.length)}` : '0 rows';
    $(`${id}-previous`).disabled = page === 0;
    $(`${id}-next`).disabled = (page + 1) * pageSize >= rows.length;
  }
  $(`${id}-previous`).onclick = () => { if (page > 0) { page--; render(); } };
  $(`${id}-next`).onclick = () => { if ((page + 1) * pageSize < rows.length) { page++; render(); } };
  return {setRows(value) { rows = value; page = 0; sort(); render(); }};
}

// Drawing and the optional panel share one source. Personal selections stay in
// memory; only their aggregate statistics cross back from the data worker.
export function createPlaceHistory({map, report, options, send, selectDates, status}) {
  let area = null, corners = [], drawing = false, allDates = false, zoomEnabled = false;
  let requestId = 0, pending = false, dirty = false, lastKey = null, ignoreClickUntil = 0;
  const panel = $('place-history');
  const selectRow = entry => {
    selectDates(Math.floor(entry.start / DAY) * DAY, Math.floor(Math.max(entry.start, (entry.end ?? entry.start + DAY) - 1) / DAY) * DAY + DAY - 1, entry.hour);
    refresh();
  };
  const calendar = createPlaceCalendar(selectRow, ({id, start, end}) => send({type: 'place-hours', id, area, options: {...options(), start, end}}));
  const stays = createPlaceTable('place-visits', [
    {key: 'start', label: 'From (UTC)', format: utcTime}, {key: 'end', label: 'To (UTC)', format: utcTime},
    {key: 'count', label: 'Locations', format: value => number.format(value)}, {key: 'minutes', label: 'Duration', format: duration},
  ], selectRow);
  const daily = createPlaceTable('place-daily', [
    {key: 'start', label: 'Date (UTC)', format: utcDate}, {key: 'count', label: 'Locations', format: value => number.format(value)},
    {key: 'minutes', label: 'Duration', format: duration},
  ], selectRow);
  function paintArea() {
    const source = map.getSource('place-selection');
    if (!source) return;
    const features = [];
    if (drawing) {
      if (corners.length >= 3) features.push({type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [[...corners, corners[0]]]}});
      if (corners.length >= 2) features.push({type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: corners}});
      for (const coordinates of corners) features.push({type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates}});
    } else if (area) features.push(area);
    source.setData({type: 'FeatureCollection', features});
    $('place-finish').disabled = corners.length < 3;
    $('place-undo').disabled = !corners.length;
    $('place-instruction').textContent = `${corners.length}/64 corners · Click corners, then Finish. Enter finishes; Esc cancels.`;
  }
  function stopDrawing() {
    if (!drawing) return;
    drawing = false; corners = [];
    map.getCanvas().style.cursor = '';
    if (zoomEnabled) map.doubleClickZoom.enable();
    $('draw-area').setAttribute('aria-pressed', 'false');
    $('place-drawing').hidden = true;
  }
  function clear() {
    stopDrawing(); area = null; requestId++; pending = dirty = false; lastKey = null;
    panel.hidden = true; panel.setAttribute('aria-busy', 'false');
    $('place-results').hidden = true;
    stays.setRows([]); daily.setRows([]); calendar.clear();
    paintArea();
  }
  function refresh() {
    const history = report();
    if (!area || !history || drawing) return;
    const current = options();
    const filters = {start: allDates ? Math.floor(history.min / DAY) * DAY : current.start, end: allDates ? Math.floor(history.max / DAY) * DAY + DAY - 1 : current.end, hourStart: current.hourStart, hourEnd: current.hourEnd, accuracy: current.accuracy, excludeJumps: current.excludeJumps};
    const key = JSON.stringify([area, filters]);
    if (key === lastKey) return;
    if (pending) { dirty = true; return; }
    lastKey = key; pending = true; dirty = false;
    panel.setAttribute('aria-busy', 'true'); $('place-message').textContent = 'Calculating place history…';
    $('place-results').hidden = true;
    send({type: 'place', id: ++requestId, area, options: filters});
  }
  function select(feature, label) {
    stopDrawing(); area = feature;
    $('place-kind').textContent = label; panel.hidden = false;
    $('place-scope').hidden = false; $('place-drawing').hidden = true;
    lastKey = null; paintArea(); refresh();
  }
  function addCorner(coordinate) {
    if (corners.length >= 64) { status('An area can have at most 64 corners. Finish it or undo a corner.', true); return; }
    const next = [...coordinate];
    if (corners.length) next[0] += 360 * Math.round((corners.at(-1)[0] - next[0]) / 360);
    if (!corners.length || next[0] !== corners.at(-1)[0] || next[1] !== corners.at(-1)[1]) corners.push(next);
    paintArea();
  }
  function finish() {
    if (corners.length < 3) return;
    try { select({type: 'Feature', properties: {}, geometry: placePolygon(corners)}, 'Drawn area'); ignoreClickUntil = Date.now() + 300; }
    catch (error) { status(error.message, true); }
  }
  function startDrawing() {
    if (!report()) return;
    clear(); drawing = true; zoomEnabled = map.doubleClickZoom.isEnabled(); map.doubleClickZoom.disable();
    $('draw-area').setAttribute('aria-pressed', 'true'); map.getCanvas().style.cursor = 'crosshair';
    panel.hidden = false; $('place-kind').textContent = 'Draw an area';
    $('place-drawing').hidden = false; $('place-scope').hidden = true;
    $('place-message').textContent = '';
    paintArea(); map.getCanvas().focus();
  }
  function receive(message) {
    if (message.type === 'place-hours' || message.operation === 'place-hours') { calendar.receive(message); return; }
    if (message.id !== requestId || !pending) return;
    pending = false;
    if (dirty) { lastKey = null; refresh(); return; }
    panel.setAttribute('aria-busy', 'false');
    if (message.type === 'error') { $('place-message').textContent = message.message; return; }
    const result = message.result;
    $('place-message').textContent = result.count ? '' : 'No locations in this area match the current filters.';
    $('place-results').hidden = false;
    for (const [id, value] of Object.entries({'place-records': number.format(result.count), 'place-days': number.format(result.days), 'place-total-visits': number.format(result.visits), 'place-time': duration(result.minutes), 'place-first': time(result.first), 'place-last': time(result.last)})) $(id).textContent = value;
    $('place-visits-label').textContent = `Recorded stays · ${number.format(result.visits)}`;
    $('place-daily-label').textContent = `By day · ${number.format(result.days)}`;
    const history = report(), current = options();
    calendar.setRows(result.daily, {start: allDates ? history.min : current.start, end: allDates ? history.max : current.end, historyStart: history.min, historyEnd: history.max});
    stays.setRows(result.stays); daily.setRows(result.daily);
  }
  function syncScope() {
    for (const button of $('place-scope').children) button.setAttribute('aria-pressed', String((button.dataset.scope === 'all') === allDates));
  }
  $('draw-area').onclick = () => drawing ? clear() : startDrawing();
  $('place-close').onclick = () => { clear(); $('draw-area').focus(); };
  $('place-finish').onclick = finish;
  $('place-undo').onclick = () => { corners.pop(); paintArea(); };
  for (const button of $('place-scope').children) button.onclick = () => { allDates = button.dataset.scope === 'all'; syncScope(); refresh(); };
  function showView(id) {
    for (const tab of $('place-views').children) {
      const selected = tab.dataset.view === id;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      $(`place-view-${tab.dataset.view}`).hidden = !selected;
    }
    calendar.setActive(id === 'calendar');
  }
  for (const tab of $('place-views').children) {
    tab.onclick = () => showView(tab.dataset.view);
    tab.onkeydown = event => {
      const tabs = [...$('place-views').children], index = tabs.indexOf(tab);
      const next = {ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1}[event.key];
      if (next === undefined) return;
      event.preventDefault(); tabs[next].click(); tabs[next].focus();
    };
  }
  function handleClick(event) {
    if (!drawing) return Date.now() < ignoreClickUntil;
    if (corners.length >= 3) {
      const first = map.project(corners[0]);
      if (Math.hypot(first.x - event.point.x, first.y - event.point.y) <= 10) { finish(); return true; }
    }
    addCorner([event.lngLat.lng, event.lngLat.lat]);
    return true;
  }
  map.on('dblclick', event => { if (drawing || Date.now() < ignoreClickUntil) { event.preventDefault(); if (drawing) finish(); } });
  map.getCanvas().addEventListener('keydown', event => {
    if (!drawing) return;
    if (event.key === ' ') { event.preventDefault(); const center = map.getCenter(); addCorner([center.lng, center.lat]); }
    else if (event.key === 'Enter') { event.preventDefault(); finish(); }
    else if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); corners.pop(); paintArea(); }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden && !$('guide').open) { event.preventDefault(); clear(); $('draw-area').focus(); } });
  return {
    get drawing() { return drawing; }, clear, refresh, receive, select, handleClick,
    install() {
      map.addSource('place-selection', {type: 'geojson', data: empty(), tolerance: 0});
      map.addLayer({id: 'place-fill', type: 'fill', source: 'place-selection', filter: ['==', '$type', 'Polygon'], paint: {'fill-color': '#d5f476', 'fill-opacity': .1}});
      map.addLayer({id: 'place-border', type: 'line', source: 'place-selection', paint: {'line-color': '#d5f476', 'line-width': 2, 'line-dasharray': [3, 2]}});
      map.addLayer({id: 'place-corners', type: 'circle', source: 'place-selection', filter: ['==', '$type', 'Point'], paint: {'circle-color': '#d5f476', 'circle-radius': 4, 'circle-stroke-color': '#142018', 'circle-stroke-width': 1}});
      paintArea();
    }
  };
}
