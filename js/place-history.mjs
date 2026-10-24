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
    stays.setRows([]); daily.setRows([]);
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
    if (!result.count) { stays.setRows([]); daily.setRows([]); return; }
    for (const [id, value] of Object.entries({'place-records': number.format(result.count), 'place-days': number.format(result.days), 'place-total-visits': number.format(result.visits), 'place-time': duration(result.minutes), 'place-first': time(result.first), 'place-last': time(result.last)})) $(id).textContent = value;
    $('place-visits-label').textContent = `Recorded stays · ${number.format(result.visits)}`;
    $('place-daily-label').textContent = `By day · ${number.format(result.days)}`;
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
