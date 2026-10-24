import {DAY, placePolygon} from './data.mjs?v=16';

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

// Index the worker's daily totals once. A year or metric change only draws one
// year (at most 366 buttons), without querying the observations again.
export function createPlaceCalendar(select) {
  let days = new Map(), year = null, firstYear = 0, lastYear = 0, start = 0, end = 0;
  function render() {
    const metric = $('place-calendar-metric').value === 'minutes' ? 'minutes' : 'count';
    const first = yearStart(year), offset = new Date(first).getUTCDay();
    $('place-calendar-detail').textContent = 'Select a square to filter the map to that UTC day. Arrow keys move between recorded days.';
    const dates = [];
    for (let at = first; new Date(at).getUTCFullYear() === year; at += DAY) dates.push(at);
    const weeks = Math.ceil((offset + dates.length) / 7);
    $('place-calendar-chart').style.setProperty('--weeks', weeks);
    $('place-calendar-year').value = year;
    $('place-calendar-previous').disabled = year <= firstYear;
    $('place-calendar-next').disabled = year >= lastYear;
    const months = [];
    for (let i = 0; i < dates.length; i++) if (new Date(dates[i]).getUTCDate() === 1) {
      const label = document.createElement('span'); label.textContent = monthName.format(dates[i]);
      label.style.gridColumn = `${Math.floor((offset + i) / 7) + 1} / span 3`; months.push(label);
    }
    $('place-calendar-months').replaceChildren(...months);
    let peak = 0, recorded = 0, minutes = 0;
    for (const at of dates) {
      const entry = days.get(at);
      if (entry) { peak = Math.max(peak, entry[metric]); recorded++; minutes += entry.minutes; }
    }
    let focused = -1;
    const cells = dates.map((at, i) => {
      const entry = days.get(at), count = entry?.count ?? 0, value = entry?.[metric] ?? 0;
      const button = document.createElement('button'); button.type = 'button'; button.dataset.date = utcDate(at);
      button.dataset.level = value > 0 ? Math.ceil(Math.sqrt(value / peak) * 4) : 0;
      button.style.gridColumn = Math.floor((offset + i) / 7) + 1; button.style.gridRow = (offset + i) % 7 + 1;
      button.disabled = !count || at < start || at > end; button.tabIndex = -1;
      button.title = `${calendarDate.format(at)} · ${number.format(count)} locations · ${duration(entry?.minutes ?? 0)}${at < start || at > end ? ' · outside selected dates' : ''}`;
      button.setAttribute('aria-label', button.title);
      button.onclick = () => select({start: at, end: at + DAY});
      button.onpointerenter = () => { $('place-calendar-detail').textContent = button.title; };
      button.onfocus = () => {
        if (focused >= 0) cells[focused].tabIndex = -1;
        focused = i; button.tabIndex = 0; $('place-calendar-detail').textContent = button.title;
      };
      button.onkeydown = event => {
        const step = {ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1}[event.key];
        let next = event.key === 'Home' ? 0 : event.key === 'End' ? cells.length - 1 : i + (step ?? 0);
        if (step === undefined && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const direction = step ?? (event.key === 'Home' ? 1 : -1);
        while (cells[next]?.disabled) next += direction;
        cells[next]?.focus();
      };
      return button;
    });
    focused = cells.findIndex(cell => !cell.disabled);
    if (focused >= 0) cells[focused].tabIndex = 0;
    $('place-calendar-days').replaceChildren(...cells);
    $('place-calendar-summary').textContent = `${number.format(recorded)} recorded ${recorded === 1 ? 'day' : 'days'} · ${duration(minutes)}`;
    $('place-calendar-scale').title = `Maximum per day: ${metric === 'minutes' ? duration(peak) : `${number.format(peak)} locations`}`;
  }
  $('place-calendar-previous').onclick = () => { if (year > firstYear) { year--; render(); } };
  $('place-calendar-next').onclick = () => { if (year < lastYear) { year++; render(); } };
  $('place-calendar-year').onchange = () => {
    const raw = $('place-calendar-year').value, value = Number(raw);
    if (raw !== '' && Number.isInteger(value)) year = Math.max(firstYear, Math.min(lastYear, value));
    render();
  };
  $('place-calendar-metric').onchange = render;
  return {
    setRows(rows, scope) {
      days = new Map(rows.map(entry => [entry.start, entry]));
      start = Math.floor(scope.start / DAY) * DAY; end = Math.floor(scope.end / DAY) * DAY;
      firstYear = new Date(start).getUTCFullYear(); lastYear = new Date(end).getUTCFullYear();
      $('place-calendar-year').min = firstYear; $('place-calendar-year').max = lastYear;
      if (year === null || year < firstYear || year > lastYear) year = rows.reduce((latest, entry) => Math.max(latest, new Date(entry.start).getUTCFullYear()), firstYear);
      render();
    },
    clear() { days.clear(); year = null; $('place-calendar-days').replaceChildren(); $('place-calendar-months').replaceChildren(); }
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
    allDates = false; syncScope();
    selectDates(Math.floor(entry.start / DAY) * DAY, Math.floor(Math.max(entry.start, (entry.end ?? entry.start + DAY) - 1) / DAY) * DAY + DAY - 1);
    refresh();
  };
  const calendar = createPlaceCalendar(selectRow);
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
    if (message.id !== requestId || !pending) return;
    pending = false;
    if (dirty) { lastKey = null; refresh(); return; }
    panel.setAttribute('aria-busy', 'false');
    if (message.type === 'error') { $('place-message').textContent = message.message; return; }
    const result = message.result;
    $('place-message').textContent = result.count ? '' : 'No locations in this area match the current filters.';
    $('place-results').hidden = !result.count;
    if (!result.count) { stays.setRows([]); daily.setRows([]); calendar.clear(); return; }
    for (const [id, value] of Object.entries({'place-records': number.format(result.count), 'place-days': number.format(result.days), 'place-total-visits': number.format(result.visits), 'place-time': duration(result.minutes), 'place-first': time(result.first), 'place-last': time(result.last)})) $(id).textContent = value;
    $('place-visits-label').textContent = `Recorded stays · ${number.format(result.visits)}`;
    $('place-daily-label').textContent = `By day · ${number.format(result.days)}`;
    const history = report(), current = options();
    calendar.setRows(result.daily, allDates ? {start: history.min, end: history.max} : current);
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
