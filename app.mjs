import {MAPS, MAP_ORDER, PALETTES, createYandexTileLoader} from './maps.mjs?v=3';
import {createNativeMaps} from './native-maps.mjs';
import {DAY, shiftPeriod} from './data.mjs?v=3';
const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('en');
const date = t => new Date(t).toISOString().slice(0, 10);
const formatDate = t => new Intl.DateTimeFormat('en', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'}).format(t);
const empty = () => ({type: 'FeatureCollection', features: []});
const state = {mode: 'heat', metric: 'records', palette: 'ember', basemap: 'dark', radius: 24, intensity: 1, opacity: .85, report: null, result: null, importing: false, start: 0, end: 0, period: 'all'};
const descriptions = {heat: 'Density of nearby recorded locations.', hex: 'Locations grouped into zoom-dependent hexagonal cells.', points: 'Individual observations. Click a point to see its timestamp.', route: 'Consecutive observations, with breaks for gaps and excluded data.'};
let map, mapLibrary, nativeMaps, attributionControl, worker, queryTimer, querying = false, queryDirty = false, exporting = false, queryId = 0, styleRequest = 0, attributionRequest = 0, sampleRequest = 0, playback, popup, statusTimer;
let currentAttribution = '';
function setAttribution(html) {
  if (html === currentAttribution) return;
  currentAttribution = html;
  map.removeControl(attributionControl);
  attributionControl = new mapLibrary.AttributionControl({compact: false, customAttribution: html});
  map.addControl(attributionControl, 'bottom-right');
}
async function refreshAttribution() {
  const key = state.basemap, provider = MAPS[key], request = ++attributionRequest, style = styleRequest;
  if (!provider.attribution) return;
  try {
    const credit = await provider.attribution(map);
    if (key !== state.basemap || request !== attributionRequest || style !== styleRequest) return;
    const source = map.getSource('basemap'), tiles = provider.tiles();
    if (source && map.getStyle()?.sources?.basemap?.tiles?.[0] !== tiles[0]) source.setTiles(tiles);
    setAttribution(credit);
  } catch {
    if (key !== state.basemap || request !== attributionRequest || style !== styleRequest) return;
    await selectBasemap('dark');
    status(`${provider.name} attribution could not load. Switched to Midnight.`, true);
  }
}
function status(message, error = false, persistent = false) {
  clearTimeout(statusTimer);
  $('status').textContent = message; $('status').hidden = !message; $('status').classList.toggle('error', error);
  if (message && !persistent) statusTimer = setTimeout(() => { $('status').hidden = true; }, error ? 12000 : 6500);
}
function setBusy(busy) {
  state.importing = busy;
  for (const id of ['import', 'sample', 'empty-sample', 'empty-import']) $(id).disabled = busy;
  $('history-file').disabled = busy;
  $('workspace').setAttribute('aria-busy', String(busy));
}
function setEnabled(enabled) {
  for (const id of ['clear', 'fit', 'export', 'date-start', 'date-end', 'range-start', 'range-end', 'play', 'period-back', 'period-forward']) $(id).disabled = !enabled;
  document.querySelectorAll('[data-period]').forEach(b => { b.disabled = !enabled; });
}
function currentOptions() {
  const bounds = map?.getBounds();
  // Pad the viewport so heat kernels and cells remain complete at its edges.
  const padX = bounds ? Math.max(.01, (bounds.getEast() - bounds.getWest()) * .15) : 0;
  const padY = bounds ? Math.max(.01, (bounds.getNorth() - bounds.getSouth()) * .15) : 0;
  const {start, end, mode, metric, radius} = state;
  return {start, end, mode, metric, radius, accuracy: Number($('accuracy').value), hourStart: Number($('hour-start').value), hourEnd: Number($('hour-end').value), zoom: map?.getZoom() ?? 2, viewport: bounds ? [bounds.getWest() - padX, bounds.getSouth() - padY, bounds.getEast() + padX, bounds.getNorth() + padY] : [-180, -90, 180, 90]};
}
function requestQuery() {
  if (!worker || !state.report || state.importing) return;
  if (querying) { queryDirty = true; return; }
  clearTimeout(queryTimer);
  querying = true; queryDirty = false;
  worker.postMessage({type: 'query', id: ++queryId, options: currentOptions(), known: state.result?.versions});
}
function refresh() { clearTimeout(queryTimer); if (querying) queryDirty = true; queryTimer = setTimeout(requestQuery, 90); }
function paintSources(changes = state.result) {
  if (!map?.getSource('history-density')) return;
  for (const [source, key] of [['density', 'density'], ['dots', 'dots'], ['route', 'routes']]) {
    if (!changes || key in changes) map.getSource(`history-${source}`).setData(changes?.[key] ?? empty());
  }
}
function colourExpression(input, includeTransparent = false) {
  const colors = PALETTES[state.palette].colors;
  const stops = includeTransparent ? [0, 'rgba(0,0,0,0)', .08, colors[0]] : [0, colors[0]];
  for (let i = 1; i < colors.length; i++) stops.push(i / (colors.length - 1), colors[i]);
  return ['interpolate', ['linear'], input, ...stops];
}
function paint() {
  const palette = PALETTES[state.palette];
  $('legend-ramp').style.background = `linear-gradient(90deg,${palette.colors.join(',')})`;
  $('palette-name').textContent = palette.name;
  $('legend-unit').textContent = {records: 'recorded locations', days: 'distinct UTC days', time: 'stationary minutes'}[state.metric];
  $('density-controls').hidden = !['heat', 'hex'].includes(state.mode);
  $('intensity-field').hidden = !['heat', 'hex'].includes(state.mode);
  $('radius-field').hidden = state.mode === 'route';
  $('radius-label').textContent = state.mode === 'hex' ? 'Cell size' : state.mode === 'points' ? 'Point size' : 'Spread';
  $('radius-value').textContent = state.mode === 'points' ? `${(state.radius / 8).toFixed(1)} px` : `${state.radius} px`;
  $('intensity-value').textContent = `${state.intensity.toFixed(1)}×`;
  $('opacity-value').textContent = `${Math.round(state.opacity * 100)}%`;
  $('mode-description').textContent = descriptions[state.mode];
  $('metric-note').textContent = {records: 'Every recorded location contributes equally.', days: 'One contribution per UTC day in each cell.', time: 'Recorded visits and short stationary intervals; an estimate. See Guide.'}[state.metric];
  const legend = document.querySelector('.legend');
  legend.hidden = state.mode === 'points' || state.mode === 'route';
  if (!map?.getLayer('history-heat')) return;
  for (const [id, mode] of [['history-heat', 'heat'], ['history-hex', 'hex'], ['history-dots', 'points'], ['history-route', 'route']]) map.setLayoutProperty(id, 'visibility', state.mode === mode ? 'visible' : 'none');
  map.setPaintProperty('history-heat', 'heatmap-color', colourExpression(['heatmap-density'], true));
  map.setPaintProperty('history-heat', 'heatmap-radius', ['interpolate', ['linear'], ['zoom'], 0, state.radius * .7, 14, state.radius, 20, state.radius * 1.3]);
  map.setPaintProperty('history-heat', 'heatmap-intensity', state.intensity);
  map.setPaintProperty('history-heat', 'heatmap-opacity', state.opacity);
  map.setPaintProperty('history-hex', 'fill-color', colourExpression(['min', 1, ['*', ['get', 'weight'], state.intensity]]));
  map.setPaintProperty('history-hex', 'fill-opacity', state.opacity);
  map.setPaintProperty('history-dots', 'circle-color', palette.colors[4]);
  map.setPaintProperty('history-dots', 'circle-radius', state.radius / 8);
  map.setPaintProperty('history-dots', 'circle-opacity', Math.min(1, state.opacity * state.intensity));
  map.setPaintProperty('history-route', 'line-color', palette.colors[3]);
  map.setPaintProperty('history-route', 'line-opacity', state.opacity);
  map.setPaintProperty('history-route', 'line-width', state.intensity * 1.5);
}
function installLayers() {
  // A base-map change replaces its style. Reattach local overlays without reimporting.
  const before = map.getStyle().layers.find(l => l.type === 'symbol' || l.id === 'basemap-labels')?.id;
  for (const name of ['density', 'dots', 'route']) map.addSource(`history-${name}`, {type: 'geojson', data: empty(), maxzoom: 18, tolerance: .5, buffer: 64});
  map.addLayer({id: 'history-heat', type: 'heatmap', source: 'history-density', paint: {'heatmap-weight': ['get', 'weight']}}, before);
  map.addLayer({id: 'history-hex', type: 'fill', source: 'history-density', paint: {'fill-outline-color': '#ffffff35'}}, before);
  map.addLayer({id: 'history-dots', type: 'circle', source: 'history-dots', paint: {'circle-stroke-color': '#142018', 'circle-stroke-width': .4}}, before);
  map.addLayer({id: 'history-route', type: 'line', source: 'history-route', layout: {'line-join': 'round', 'line-cap': 'round'}}, before);
  paintSources(); paint(); refresh();
}
async function selectBasemap(key) {
  const request = ++styleRequest, provider = MAPS[key];
  document.querySelectorAll('[data-map]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.map === key)));
  $('map-error').hidden = true;
  try {
    const native = provider.native ? await nativeMaps.prepare(provider.native) : null;
    if (request !== styleRequest) return;
    const style = typeof provider.style === 'function' ? await provider.style(map) : typeof provider.style === 'string' ? await (async () => {
      const response = await fetch(provider.style, {signal: AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })() : structuredClone(provider.style);
    if (request !== styleRequest) return;
    // OpenFreeMap's dark style currently references a missing sprite pattern.
    // Keep its solid forest fill so the map renders without a missing-image error.
    if (key === 'dark') for (const layer of style.layers) {
      if (layer.paint?.['fill-pattern'] === 'wood-pattern') delete layer.paint['fill-pattern'];
    }
    state.basemap = key;
    nativeMaps.activate(native);
    $('workspace').classList.toggle('native-map', Boolean(provider.native));
    $('workspace').classList.toggle('light-map', provider.tone === 'light');
    $('workspace').classList.toggle('google-map', key.startsWith('google'));
    $('workspace').classList.toggle('yandex-map', key.startsWith('yandex'));
    $('map-provider').textContent = provider.detail;
    map.setStyle(style, {diff: false});
    setAttribution(provider.attribution ? style.metadata?.providerAttribution ?? '' : '');
  } catch (error) {
    if (request !== styleRequest) return;
    $('map-error').textContent = `${provider.name} could not load. Try another base map. (${error.message})`;
    $('map-error').hidden = false;
    document.querySelectorAll('[data-map]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.map === state.basemap)));
  }
}
function showResult(result) {
  state.result = {...state.result, ...result};
  $('stat-records').textContent = number.format(result.count);
  $('stat-days').textContent = number.format(result.days);
  $('stat-distance').textContent = number.format(result.km);
  $('range-summary').textContent = result.count ? `${formatDate(state.start)} — ${formatDate(state.end)}` : 'No locations match these filters';
  $('render-note').textContent = state.mode === 'points' && result.visible > result.drawn ? `${number.format(result.drawn)} of ${number.format(result.visible)} nearby points drawn` : `${number.format(result.visible)} locations in area`;
  $('fit').disabled = !result.count;
  const max = Math.max(1, ...result.histogram);
  const duration = Math.max(1, state.report.max - state.report.min);
  [...$('histogram').children].forEach((bar, i) => {
    bar.style.height = `${Math.max(3, Math.sqrt(result.histogram[i] / max) * 100)}%`;
    const inRange = state.report.min + ((i + 1) / 64) * duration >= state.start && state.report.min + (i / 64) * duration <= state.end;
    bar.className = inRange ? 'selected' : 'outside';
    bar.title = `${number.format(result.histogram[i])} locations`;
  });
  paintSources(result);
}
function syncDates() {
  if (!state.report) return;
  $('date-start').value = date(state.start); $('date-end').value = date(state.end);
  const min = Math.floor(state.report.min / DAY) * DAY, max = Math.floor(state.report.max / DAY) * DAY;
  const span = Math.max(DAY, max - min);
  $('range-start').value = Math.round((state.start - min) / span * 1000);
  $('range-end').value = max === min ? 1000 : Math.round((Math.min(max, Math.floor(state.end / DAY) * DAY) - min) / span * 1000);
  $('range-start').disabled = $('range-end').disabled = max === min;
  $('period-back').disabled = state.start <= min;
  $('period-forward').disabled = state.end >= max + DAY - 1;
  document.querySelectorAll('[data-period]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.period === state.period)));
}
function stopPlayback() { clearTimeout(playback); playback = null; $('play').textContent = '▶'; $('play').setAttribute('aria-label', 'Play timeline'); }
function setDates(start, end, period = null) {
  state.start = start; state.end = end;
  state.period = period ?? (start <= state.report.min && end >= state.report.max ? 'all' : null);
  syncDates(); refresh();
}
function fitHistory() {
  if (!state.result?.bounds) return;
  map.fitBounds(state.result.bounds, {padding: {top: 190, bottom: Math.min(240, window.innerHeight * .32), left: 40, right: 50}, maxZoom: 14, duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700});
}
function importFiles(files, sample = false) {
  if (!files.length || state.importing) return;
  stopPlayback(); popup?.remove(); setBusy(true); status('Reading history on your device…', false, true);
  worker.postMessage({type: 'import', id: ++queryId, files});
  state.nextSample = sample;
}
async function loadSample() {
  if (state.importing) return;
  const request = ++sampleRequest;
  setBusy(true); status('Loading the bundled sample…', false, true);
  try {
    const response = await fetch(new URL('./sample-location-history.json.gz', import.meta.url), {signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (request !== sampleRequest) return;
    setBusy(false); importFiles([new File([blob], 'sample-location-history.json.gz')], true);
  } catch (error) { if (request === sampleRequest) { setBusy(false); status(`The sample could not load: ${error.message}. You can still open your own history.`, true); } }
}
function clearHistory() {
  sampleRequest++; stopPlayback(); popup?.remove();
  clearTimeout(queryTimer); worker.terminate(); createWorker(); querying = false; queryDirty = false; exporting = false; setBusy(false);
  state.report = null; state.result = null; state.period = 'all'; setEnabled(false); paintSources();
  $('empty-state').hidden = false; $('source-label').textContent = 'No history loaded'; $('dataset-tag').textContent = 'No history loaded';
  $('import-detail').textContent = ''; $('range-summary').textContent = 'Load history to filter by date'; $('render-note').textContent = '';
  for (const id of ['stat-records', 'stat-days', 'stat-distance']) $(id).textContent = '—';
  for (const id of ['date-start', 'date-end']) $(id).value = '';
  $('range-start').value = 0; $('range-end').value = 1000;
  for (const bar of $('histogram').children) { bar.style.height = '3%'; bar.className = ''; }
  status('History cleared from memory.');
}
function createWorker() {
  worker = new Worker(new URL('./worker.mjs?v=3', import.meta.url), {type: 'module'});
  worker.onmessage = ({data}) => {
    if (data.type === 'progress') status(data.message, false, true);
    else if (data.type === 'error') {
      if (data.operation === 'import') setBusy(false);
      if (data.operation === 'query') { querying = false; queryDirty = false; }
      if (data.operation === 'export') { exporting = false; $('export').disabled = !state.report; }
      status(data.message, true);
    } else if (data.type === 'imported') {
      state.report = data.report; setBusy(false); setEnabled(true); state.result = null;
      $('empty-state').hidden = true;
      $('source-label').textContent = state.nextSample ? 'Bundled sample' : data.report.files.length === 1 ? data.report.files[0] : `${data.report.files.length} files merged`;
      $('source-label').title = data.report.files.join(', ');
      $('dataset-tag').textContent = state.nextSample ? 'Sample data' : 'Imported history';
      $('import-detail').textContent = `${number.format(data.report.total)} locations · ${number.format(data.report.duplicates)} duplicates removed${data.report.skipped ? ` · ${number.format(data.report.skipped)} invalid records skipped` : ''}`;
      for (const id of ['date-start', 'date-end']) { $(id).min = date(data.report.min); $(id).max = date(data.report.max); }
      state.start = Math.floor(data.report.min / DAY) * DAY; state.end = Math.floor(data.report.max / DAY) * DAY + DAY - 1;
      state.period = 'all';
      syncDates(); querying = false; queryDirty = false; state.fitNext = true; requestQuery();
      status(`Loaded ${number.format(data.report.total)} locations.`);
    } else if (data.type === 'result') {
      querying = false;
      if (queryDirty) { queryDirty = false; requestQuery(); return; }
      showResult(data.result);
      if (state.fitNext) { state.fitNext = false; fitHistory(); }
    } else if (data.type === 'exported') {
      exporting = false; $('export').disabled = !state.report;
      const url = URL.createObjectURL(data.blob);
      const link = document.createElement('a'); link.href = url; link.download = `location-history-${date(data.start)}-${date(data.end)}.geojson`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      status(`Exported ${number.format(data.count)} filtered locations.`);
    }
  };
  worker.onerror = () => { setBusy(false); exporting = false; $('export').disabled = true; querying = false; status('The import worker could not run. Reload the page and try a smaller export.', true); };
}
function bindControls() {
  for (const key of MAP_ORDER) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'basemap-button'; button.dataset.map = key;
    button.setAttribute('aria-pressed', String(key === state.basemap)); button.setAttribute('aria-label', `${MAPS[key].name} base map`);
    const swatch = document.createElement('i'); swatch.className = `map-swatch swatch-${MAPS[key].swatch ?? key}`; swatch.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.textContent = MAPS[key].name; button.append(swatch, label); button.onclick = () => selectBasemap(key); $('basemaps').append(button);
  }
  for (let i = 0; i < 64; i++) $('histogram').append(document.createElement('span'));
  for (let i = 0; i <= 24; i++) {
    if (i < 24) $('hour-start').add(new Option(`${String(i).padStart(2, '0')}:00`, i));
    if (i > 0) $('hour-end').add(new Option(`${String(i).padStart(2, '0')}:00`, i));
  }
  $('hour-end').value = '24';
  $('hour-start').onchange = () => { stopPlayback(); if (+$('hour-start').value >= +$('hour-end').value) $('hour-end').value = String(+$('hour-start').value + 1); refresh(); };
  $('hour-end').onchange = () => { stopPlayback(); if (+$('hour-end').value <= +$('hour-start').value) $('hour-start').value = String(+$('hour-end').value - 1); refresh(); };
  $('accuracy').onchange = refresh;
  $('metric').onchange = event => { state.metric = event.target.value; paint(); refresh(); };
  document.querySelectorAll('[data-mode]').forEach(button => { button.onclick = () => { state.mode = button.dataset.mode; popup?.remove(); document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); paint(); refresh(); }; });
  document.querySelectorAll('[data-palette]').forEach(button => { button.onclick = () => { state.palette = button.dataset.palette; document.querySelectorAll('[data-palette]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); paint(); }; });
  for (const id of ['radius', 'intensity', 'opacity']) $(id).oninput = event => { state[id] = Number(event.target.value) / (id === 'opacity' ? 100 : 1); paint(); if (id === 'radius' && ['heat', 'hex'].includes(state.mode)) refresh(); };
  $('import').onclick = $('empty-import').onclick = () => $('history-file').click();
  $('history-file').onchange = event => { const files = [...event.target.files]; event.target.value = ''; importFiles(files); };
  $('sample').onclick = $('empty-sample').onclick = loadSample;
  $('clear').onclick = clearHistory; $('fit').onclick = fitHistory;
  $('export').onclick = () => { if (exporting) return; exporting = true; $('export').disabled = true; status('Preparing filtered GeoJSON…', false, true); worker.postMessage({type: 'export', id: ++queryId, options: currentOptions()}); };
  for (const id of ['date-start', 'date-end']) $(id).onchange = () => {
    stopPlayback();
    const start = Date.parse($('date-start').value), end = Date.parse($('date-end').value) + DAY - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || date(start) < date(state.report.min) || date(end) > date(state.report.max)) { status('Choose an ordered date range within your imported history.', true); syncDates(); return; }
    setDates(start, end);
  };
  for (const id of ['range-start', 'range-end']) $(id).oninput = () => {
    stopPlayback(); const min = Math.floor(state.report.min / DAY) * DAY, span = Math.floor(state.report.max / DAY) * DAY - min;
    let start = min + Math.round(Number($('range-start').value) / 1000 * span / DAY) * DAY;
    let end = min + Math.round(Number($('range-end').value) / 1000 * span / DAY) * DAY + DAY - 1;
    if (start > end) { if (id === 'range-start') end = start + DAY - 1; else start = end - DAY + 1; }
    setDates(start, end);
  };
  document.querySelectorAll('[data-period]').forEach(button => { button.onclick = () => {
    stopPlayback(); const end = Math.floor(state.report.max / DAY) * DAY + DAY - 1;
    const start = button.dataset.period === 'all' ? Math.floor(state.report.min / DAY) * DAY : Math.max(Math.floor(state.report.min / DAY) * DAY, end - Number(button.dataset.period) * DAY + 1);
    setDates(start, end, button.dataset.period);
  }; });
  for (const [id, direction] of [['period-back', -1], ['period-forward', 1]]) $(id).onclick = () => {
    stopPlayback();
    const min = Math.floor(state.report.min / DAY) * DAY, max = Math.floor(state.report.max / DAY) * DAY + DAY - 1;
    const next = shiftPeriod(state.start, state.end, min, max, direction);
    setDates(next.start, next.end, state.period);
  };
  $('play').onclick = () => {
    if (playback) { stopPlayback(); return; }
    const min = Math.floor(state.report.min / DAY) * DAY, max = Math.floor(state.report.max / DAY) * DAY + DAY - 1;
    const step = Math.max(DAY, Math.ceil((max - min) / DAY / 80) * DAY);
    if (state.end >= max) state.end = min + step - 1;
    state.start = min; state.period = null; syncDates(); refresh();
    $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', 'Pause timeline');
    const tick = () => { if (querying) { playback = setTimeout(tick, 500); return; } state.end = Math.min(max, state.end + step); state.period = state.end >= max ? 'all' : null; syncDates(); requestQuery(); if (state.end >= max) stopPlayback(); else playback = setTimeout(tick, 650); };
    playback = setTimeout(tick, 650);
  };
  $('help').onclick = () => $('guide').showModal(); $('close-guide').onclick = () => $('guide').close();
  $('guide').onclick = event => { if (event.target === $('guide')) { const r = $('guide').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('guide').close(); } };
  $('mobile-settings').onclick = () => $('settings').scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; } });
  window.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-overlay').hidden = true; });
  window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true; importFiles([...e.dataTransfer.files]); });
}
async function init() {
  bindControls(); paint(); setBusy(true);
  try {
    const maplibre = mapLibrary = await import('https://cdn.jsdelivr.net/npm/maplibre-gl@6.15.0/dist/maplibre-gl.mjs');
    maplibre.addProtocol('yandex-tiles', createYandexTileLoader());
    map = new maplibre.Map({container: 'map', style: {version: 8, sources: {}, layers: [{id: 'background', type: 'background', paint: {'background-color': '#202a27'}}]}, center: [13.4, 52.5], zoom: 10, attributionControl: false, maxZoom: 20, canvasContextAttributes: {antialias: true}});
    nativeMaps = createNativeMaps(map, $('workspace'), async message => { await selectBasemap('dark'); status(message, true); });
    map.addControl(new maplibre.NavigationControl({showCompass: false}), 'top-right');
    attributionControl = new maplibre.AttributionControl({compact: false});
    map.addControl(attributionControl, 'bottom-right');
    new ResizeObserver(entries => $('workspace').style.setProperty('--attribution-space', `${entries[0].contentRect.height + 10}px`)).observe(map.getContainer().querySelector('.maplibregl-ctrl-bottom-right'));
    map.on('style.load', installLayers); map.on('moveend', refresh); map.on('moveend', refreshAttribution);
    let errors = 0;
    map.on('error', event => {
      if (/source|tile|fetch|network|load/i.test(event.error?.message ?? '') && ++errors >= 3) { $('map-error').textContent = 'Some map tiles could not load. Your history is still available. Try another base map.'; $('map-error').hidden = false; }
    });
    map.on('click', event => {
      const layer = state.mode === 'hex' ? 'history-hex' : state.mode === 'points' ? 'history-dots' : null;
      if (!layer || !map.getLayer(layer)) return;
      const feature = map.queryRenderedFeatures(event.point, {layers: [layer]})[0];
      if (!feature) return;
      const p = feature.properties, node = document.createElement('div');
      node.textContent = state.mode === 'hex' ? `${number.format(p.count)} records · ${number.format(p.days)} UTC days · ${number.format(p.minutes)} stationary minutes` : `${new Date(p.time).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}${p.accuracy == null ? '' : ` · ±${p.accuracy} m`}`;
      popup?.remove(); popup = new maplibre.Popup({maxWidth: '280px'}).setLngLat(event.lngLat).setDOMContent(node).addTo(map);
    });
    createWorker(); setBusy(false); await selectBasemap('dark');
    // The existing public sample is explicit; personal imports are never persisted.
  } catch (error) { status(`The map could not start. Check WebGL support and your connection, then reload. ${error.message}`, true, true); }
}
init();
