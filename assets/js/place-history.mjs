import {DAY, placePolygon} from './data.mjs?v=9';

const $ = id => document.getElementById(id);
const empty = () => ({type: 'FeatureCollection', features: []});
const number = new Intl.NumberFormat('en');
const timestamp = new Intl.DateTimeFormat('en', {day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC'});
const time = value => value === null ? '—' : timestamp.format(value);
const duration = minutes => {
  const rounded = Math.round(minutes);
  return minutes === 0 ? '0 min' : minutes < 1 ? '<1 min' : rounded < 60 ? `${rounded} min` : `${number.format(Math.floor(rounded / 60))} h ${rounded % 60} min`;
};

// Drawing and the optional panel share one source. Personal selections stay in
// memory; only their aggregate statistics cross back from the data worker.
export function createPlaceHistory({map, report, options, send, selectDates, status}) {
  let area = null, corners = [], drawing = false, allDates = false, zoomEnabled = false;
  let requestId = 0, pending = false, dirty = false, lastKey = null, ignoreClickUntil = 0;
  const panel = $('place-history');
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
    $('place-results').hidden = true; $('place-visits').replaceChildren();
    paintArea();
  }
  function refresh() {
    const history = report();
    if (!area || !history || drawing) return;
    const current = options();
    const filters = {start: allDates ? Math.floor(history.min / DAY) * DAY : current.start, end: allDates ? Math.floor(history.max / DAY) * DAY + DAY - 1 : current.end, hourStart: current.hourStart, hourEnd: current.hourEnd, accuracy: current.accuracy, exclude: current.exclude};
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
    if (!result.count) return;
    for (const [id, value] of Object.entries({'place-records': number.format(result.count), 'place-days': number.format(result.days), 'place-total-visits': number.format(result.visits), 'place-time': duration(result.minutes), 'place-first': time(result.first), 'place-last': time(result.last)})) $(id).textContent = value;
    $('place-visits-label').textContent = `Recent visits · ${Math.min(30, result.visits)} of ${number.format(result.visits)}`;
    const rows = result.recent.map(visit => {
      const item = document.createElement('li'), button = document.createElement('button'), dates = document.createElement('span'), detail = document.createElement('small');
      button.type = 'button'; button.title = 'Select the dates of this visit';
      dates.textContent = `${time(visit.start)} → ${time(visit.end)}`;
      detail.textContent = `${number.format(visit.count)} locations · ${duration(visit.minutes)}`;
      button.append(dates, detail); item.append(button);
      button.onclick = () => {
        allDates = false; syncScope();
        selectDates(Math.floor(visit.start / DAY) * DAY, Math.floor(Math.max(visit.start, visit.end - 1) / DAY) * DAY + DAY - 1);
        refresh();
      };
      return item;
    });
    $('place-visits').replaceChildren(...rows);
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
