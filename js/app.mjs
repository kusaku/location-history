import {MAPS, MAP_GROUPS, MAP_ORDER, PALETTES, createYandexTileLoader, raiseBasemapLabels, paintHistory, fitHistoryBounds} from './maps.mjs?v=12';
import {createPlaceHistory} from './place-history.mjs?v=14';
import {createNativeMaps} from './native-maps.mjs?v=2';
import {DAY, HISTOGRAM_BINS} from './data.mjs?v=17';
import {resizeWindow, shiftWindow, histogramWindow} from './timeline.mjs?v=14';
import {loadSettings, saveSettings, dateSelection, RADIUS_MIN} from './settings.mjs?v=17';
const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('en');
const date = t => new Date(t).toISOString().slice(0, 10);
const fullDate = new Intl.DateTimeFormat('en', {weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'});
const formatDate = t => fullDate.format(t);
const empty = () => ({type: 'FeatureCollection', features: []});
let preferences = loadSettings(MAP_ORDER);
const state = {...preferences, report: null, result: null, importing: false, start: 0, end: 0};
const descriptions = {heat: 'Density of nearby recorded locations.', hex: 'Locations grouped into zoom-dependent hexagonal cells.', points: 'Individual observations. Click a point to see its timestamp.', route: 'Consecutive observations, with breaks for gaps and excluded data.'};
let map, mapLibrary, nativeMaps, placeHistory, attributionControl, worker, queryTimer, querying = false, queryDirty = false, queryId = 0, styleRequest = 0, attributionRequest = 0, sampleRequest = 0, playback, popup, statusTimer;
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
  $('draw-area').disabled = busy || !state.report;
  $('workspace').setAttribute('aria-busy', String(busy));
}
function setEnabled(enabled) {
  for (const id of ['map-summary', 'map-bottom', 'fit', 'draw-area']) $(id).hidden = !enabled;
  for (const id of ['clear', 'fit', 'draw-area', 'date-start', 'date-end', 'range-start', 'range-end', 'play', 'period-back', 'period-forward']) $(id).disabled = !enabled;
  document.querySelectorAll('[data-period]').forEach(b => { b.disabled = !enabled; });
  for (const bar of $('histogram').children) bar.disabled = !enabled;
}
function currentOptions() {
  const bounds = map?.getBounds();
  // Pad the viewport so heat kernels and cells remain complete at its edges.
  const padX = bounds ? Math.max(.01, (bounds.getEast() - bounds.getWest()) * .15) : 0;
  const padY = bounds ? Math.max(.01, (bounds.getNorth() - bounds.getSouth()) * .15) : 0;
  const {start, end, mode, period} = state, {metric, radius} = state.views[mode];
  return {start, end, mode, period, metric, radius, excludeJumps: state.excludeJumps, accuracy: Number($('accuracy').value), hourStart: Number($('hour-start').value), hourEnd: Number($('hour-end').value), zoom: map?.getZoom() ?? 2, viewport: bounds ? [bounds.getWest() - padX, bounds.getSouth() - padY, bounds.getEast() + padX, bounds.getNorth() + padY] : [-180, -90, 180, 90]};
}
function requestQuery() {
  if (!worker || !state.report || state.importing) return;
  if (querying) { queryDirty = true; return; }
  clearTimeout(queryTimer);
  querying = true; queryDirty = false;
  worker.postMessage({type: 'query', id: ++queryId, options: currentOptions(), known: state.result?.versions});
}
function refresh() { clearTimeout(queryTimer); queryDirty = true; queryTimer = setTimeout(requestQuery, 90); }
function rememberSettings() {
  preferences = saveSettings({
    ...state,
    // An automatic provider fallback must not replace the user's choice.
    basemap: preferences.basemap,
    accuracy: Number($('accuracy').value), hourStart: Number($('hour-start').value), hourEnd: Number($('hour-end').value),
    period: state.report ? state.period : preferences.period,
    periodDay: state.report ? state.periodDay : preferences.periodDay,
    dateRange: state.report ? [state.start, state.end] : preferences.dateRange,
  }, MAP_ORDER);
}
function paintSources(changes = state.result) {
  if (!map?.getSource('history-density')) return;
  for (const [source, key] of [['density', 'density'], ['dots', 'dots'], ['route', 'routes']]) {
    if (!changes || key in changes) map.getSource(`history-${source}`).setData(changes?.[key] ?? empty());
  }
}
function paint(changed) {
  const view = state.views[state.mode], palette = PALETTES[view.palette];
  $('radius').min = RADIUS_MIN[state.mode];
  for (const [id, value] of Object.entries({metric: view.metric, radius: view.radius, intensity: view.intensity, lineWidth: view.lineWidth ?? 1.5, opacity: view.opacity * 100})) $(id).value = value;
  document.querySelectorAll('[data-palette]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.palette === view.palette)));
  $('legend-ramp').style.background = `linear-gradient(90deg,${palette.colors.join(',')})`;
  $('palette-name').textContent = palette.name;
  $('legend-unit').textContent = {records: 'recorded locations', days: 'distinct UTC days', time: 'stationary minutes'}[view.metric];
  $('density-controls').hidden = !['heat', 'hex'].includes(state.mode);
  $('intensity-field').hidden = !['heat', 'hex'].includes(state.mode);
  $('radius-field').hidden = state.mode === 'route';
  $('line-width-field').hidden = state.mode !== 'route';
  $('radius-label').textContent = state.mode === 'hex' ? 'Cell size' : state.mode === 'points' ? 'Point size' : 'Spread';
  $('radius-value').textContent = state.mode === 'points' ? `${(view.radius / 8).toFixed(1)} px` : `${view.radius} px`;
  $('intensity-value').textContent = `${view.intensity.toFixed(1)}×`;
  $('line-width-value').textContent = `${view.lineWidth ?? 1.5} px`;
  $('opacity-value').textContent = `${Math.round(view.opacity * 100)}%`;
  $('mode-description').textContent = descriptions[state.mode];
  $('metric-note').textContent = {records: 'Every recorded location contributes equally.', days: 'One contribution per UTC day in each cell.', time: 'Recorded visits and short stationary intervals; an estimate. See Guide.'}[view.metric];
  const legend = document.querySelector('.legend');
  legend.hidden = state.mode === 'points' || state.mode === 'route';
  paintHistory(map, {...state, ...view}, changed === 'mode' ? undefined : changed);
}
function installLayers() {
  // A base-map change replaces its style. Reattach local overlays without reimporting.
  const before = raiseBasemapLabels(map);
  for (const name of ['density', 'dots', 'route']) map.addSource(`history-${name}`, {type: 'geojson', data: empty(), maxzoom: 18, tolerance: .5, buffer: 64});
  map.addLayer({id: 'history-heat', type: 'heatmap', source: 'history-density', paint: {'heatmap-weight': ['get', 'weight']}}, before);
  map.addLayer({id: 'history-hex', type: 'fill', source: 'history-density', paint: {'fill-outline-color': '#ffffff35'}}, before);
  map.addLayer({id: 'history-dots', type: 'circle', source: 'history-dots', paint: {'circle-stroke-width': 0}}, before);
  map.addLayer({id: 'history-route', type: 'line', source: 'history-route', layout: {'line-join': 'round', 'line-cap': 'round'}}, before);
  placeHistory?.install();
  paintSources(); paint(); refresh();
}
async function selectBasemap(key, remember = false) {
  const request = ++styleRequest, provider = MAPS[key];
  showMapView(MAP_GROUPS.find(group => group.maps.includes(key)).id);
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
    // Fix two names absent from OpenFreeMap's published dark sprite.
    if (key === 'dark') for (const layer of style.layers) {
      if (layer.paint?.['fill-pattern'] === 'wood-pattern') delete layer.paint['fill-pattern'];
      const icon = layer.layout?.['icon-image'];
      if (Array.isArray(icon) && icon[0] === 'step' && icon[2] === 'circle-11') icon[2] = 'circle_11';
    }
    state.basemap = key;
    nativeMaps.activate(native);
    $('workspace').classList.toggle('native-map', Boolean(provider.native));
    $('workspace').classList.toggle('google-map', key.startsWith('google'));
    $('workspace').classList.toggle('yandex-map', key.startsWith('yandex'));
    map.setStyle(style, {diff: false});
    setAttribution(provider.attribution ? style.metadata?.providerAttribution ?? '' : '');
    if (remember) { preferences.basemap = key; rememberSettings(); }
  } catch (error) {
    if (request !== styleRequest) return;
    $('map-error').textContent = `${provider.name} could not load. Try another base map. (${error.message})`;
    $('map-error').hidden = false;
    document.querySelectorAll('[data-map]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.map === state.basemap)));
    showMapView(MAP_GROUPS.find(group => group.maps.includes(state.basemap)).id);
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
  [...$('histogram').children].forEach((bar, i) => {
    const range = histogramWindow(state.report.min, state.report.max, i, result.histogram.length);
    bar.style.setProperty('--bar-height', `${Math.max(3, Math.sqrt(result.histogram[i] / max) * 100)}%`);
    bar.disabled = !range;
    bar.className = range && range.end >= state.start && range.start <= state.end ? 'selected' : 'outside';
    bar.title = range ? `${formatDate(range.start)} — ${formatDate(range.end)} · ${number.format(result.histogram[i])} locations` : 'No dates in this interval';
    bar.setAttribute('aria-label', bar.title);
    bar.setAttribute('aria-pressed', String(!!range && state.start === range.start && state.end === range.end));
    if (!range) bar.tabIndex = -1;
  });
  if (!$('histogram').querySelector('button:not(:disabled)[tabindex="0"]')) $('histogram').querySelector('button:not(:disabled)')?.setAttribute('tabindex', '0');
  paintSources(result);
  placeHistory?.refresh();
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
  $('play').disabled = !playback && $('period-forward').disabled;
  document.querySelectorAll('[data-period]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.period === state.period)));
}
function stopPlayback() {
  clearTimeout(playback); playback = null;
  $('play').textContent = '▶'; $('play').setAttribute('aria-label', 'Play timeline'); $('play').setAttribute('aria-pressed', 'false');
  $('play').disabled = !state.report || $('period-forward').disabled;
}
function setDates(start, end, period = null, periodDay = null) {
  state.start = start; state.end = end;
  state.period = period ?? (start <= state.report.min && end >= state.report.max ? 'all' : null);
  state.periodDay = periodDay;
  syncDates(); refresh();
}
function moveWindow(direction) {
  const min = Math.floor(state.report.min / DAY) * DAY, max = Math.floor(state.report.max / DAY) * DAY + DAY - 1;
  const next = shiftWindow(state.start, state.end, min, max, direction, state.period, state.periodDay ?? undefined);
  if (next.start === state.start && next.end === state.end) return false;
  setDates(next.start, next.end, state.period, state.periodDay); rememberSettings();
  return true;
}
function fitHistory() {
  if (!state.report || state.importing) return;
  // Filters may still be debouncing or running in the worker. Fit their next
  // committed result instead of using the previous date window's bounds.
  if (querying || queryDirty) { state.fitNext = true; requestQuery(); return; }
  if (!state.result?.bounds) return;
  fitHistoryBounds(map, state.result.bounds, {heading: document.querySelector('.map-heading'), timeline: document.querySelector('.timeline'), controls: map.getContainer().querySelector('.maplibregl-ctrl-top-right')}, window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function importFiles(files, sample = false) {
  if (!files.length || state.importing) return;
  stopPlayback(); popup?.remove(); placeHistory?.clear(); setBusy(true); status('Reading history on your device…', false, true);
  worker.postMessage({type: 'import', id: ++queryId, files});
  state.nextSample = sample;
}
async function loadSample() {
  if (state.importing) return;
  const request = ++sampleRequest;
  setBusy(true); status('Loading the bundled sample…', false, true);
  try {
    const response = await fetch(new URL('../data/sample-location-history.json.gz?v=2', import.meta.url), {signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (request !== sampleRequest) return;
    setBusy(false); importFiles([new File([blob], 'sample-location-history.json.gz')], true);
  } catch (error) { if (request === sampleRequest) { setBusy(false); status(`The sample could not load: ${error.message}. You can still open your own history.`, true); } }
}
function clearHistory() {
  sampleRequest++; stopPlayback(); popup?.remove(); placeHistory?.clear();
  clearTimeout(queryTimer); worker.terminate(); createWorker(); querying = false; queryDirty = false; setBusy(false);
  state.report = null; state.result = null; state.period = 'all'; setEnabled(false); paintSources();
  $('empty-state').hidden = false; $('source-label').textContent = 'No history loaded'; $('dataset-tag').textContent = 'No history loaded';
  $('import-detail').textContent = ''; $('range-summary').textContent = 'Load history to filter by date'; $('render-note').textContent = '';
  for (const id of ['stat-records', 'stat-days', 'stat-distance']) $(id).textContent = '—';
  for (const id of ['date-start', 'date-end']) $(id).value = '';
  $('range-start').value = 0; $('range-end').value = 1000;
  for (const bar of $('histogram').children) { bar.style.setProperty('--bar-height', '3%'); bar.className = ''; bar.removeAttribute('title'); bar.setAttribute('aria-label', 'Load history to select dates'); bar.setAttribute('aria-pressed', 'false'); }
  status('History cleared from memory.');
}
function createWorker() {
  worker = new Worker(new URL('./worker.mjs?v=17', import.meta.url), {type: 'module'});
  worker.onmessage = ({data}) => {
    if (data.type === 'progress') status(data.message, false, true);
    else if (data.type === 'error') {
      if (data.operation === 'place' || data.operation === 'place-hours') { placeHistory?.receive(data); return; }
      if (data.operation === 'import') setBusy(false);
      if (data.operation === 'query') { querying = false; queryDirty = false; }
      status(data.message, true);
    } else if (data.type === 'place' || data.type === 'place-hours') {
      placeHistory?.receive(data);
    } else if (data.type === 'imported') {
      placeHistory?.clear();
      state.report = data.report; setBusy(false); setEnabled(true); state.result = null;
      $('empty-state').hidden = true;
      $('source-label').textContent = state.nextSample ? 'Bundled sample' : data.report.files.length === 1 ? data.report.files[0] : `${data.report.files.length} files merged`;
      $('source-label').title = data.report.files.join(', ');
      $('dataset-tag').textContent = state.nextSample ? 'Sample data' : 'Imported history';
      $('import-detail').textContent = `${number.format(data.report.total)} locations · ${number.format(data.report.duplicates)} duplicates removed${data.report.skipped ? ` · ${number.format(data.report.skipped)} invalid records skipped` : ''}`;
      for (const id of ['date-start', 'date-end']) { $(id).min = date(data.report.min); $(id).max = date(data.report.max); }
      Object.assign(state, dateSelection(preferences, data.report.min, data.report.max));
      syncDates(); querying = false; queryDirty = false; state.fitNext = true; requestQuery();
      status(`Loaded ${number.format(data.report.total)} locations.`);
    } else if (data.type === 'result') {
      querying = false;
      if (queryDirty) { queryDirty = false; requestQuery(); return; }
      showResult(data.result);
      if (state.fitNext) { state.fitNext = false; fitHistory(); }
    }
  };
  worker.onerror = () => { setBusy(false); querying = false; status('The import worker could not run. Reload the page and try a smaller export.', true); };
}
function showMapView(id) {
  for (const tab of $('map-views').children) {
    const selected = tab.dataset.view === id;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of $('basemaps').children) panel.hidden = panel.id !== `maps-${id}`;
}
function bindControls() {
  for (const group of MAP_GROUPS) {
    const tab = document.createElement('button'); tab.type = 'button'; tab.id = `view-${group.id}`; tab.dataset.view = group.id; tab.textContent = group.name.split(' ·')[0];
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `maps-${group.id}`);
    tab.onclick = () => showMapView(group.id);
    tab.onkeydown = event => {
      const tabs = [...$('map-views').children], i = tabs.indexOf(tab);
      const index = {ArrowLeft: (i + tabs.length - 1) % tabs.length, ArrowRight: (i + 1) % tabs.length, Home: 0, End: tabs.length - 1}[event.key];
      if (index === undefined) return;
      event.preventDefault(); tabs[index].click(); tabs[index].focus();
    };
    $('map-views').append(tab);
    const section = document.createElement('div'); section.id = `maps-${group.id}`; section.className = 'basemap-group'; section.setAttribute('role', 'tabpanel'); section.setAttribute('aria-labelledby', tab.id);
    const grid = document.createElement('div'); grid.className = 'basemap-grid'; section.append(grid); $('basemaps').append(section);
    for (const key of group.maps) {
      const provider = MAPS[key], button = document.createElement('button'); button.type = 'button'; button.className = 'basemap-button'; button.dataset.map = key;
      const name = provider.name.includes(provider.provider) ? provider.name : `${provider.provider} ${provider.name}`;
      button.setAttribute('aria-pressed', String(key === state.basemap)); button.setAttribute('aria-label', `${name} · ${group.name} base map`);
      const swatch = document.createElement('span'); swatch.className = `map-swatch provider-${provider.provider.toLowerCase()} style-${key}`; swatch.setAttribute('aria-hidden', 'true');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 160 80'); svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', new URL(`../images/map-previews.svg?v=1#${group.id}`, import.meta.url).href); svg.append(use); swatch.append(svg);
      const label = document.createElement('span'); label.className = 'basemap-label';
      const brand = document.createElement('strong'); brand.textContent = provider.provider;
      if (provider.provider === 'OpenStreetMap') brand.replaceChildren(document.createTextNode('OpenStreet'), document.createElement('wbr'), document.createTextNode('Map'));
      label.append(brand);
      if (provider.provider === 'OpenFreeMap' || key === 'azure-relief') {
        const detail = document.createElement('small'); detail.textContent = provider.provider === 'OpenFreeMap' ? provider.name : 'Shaded relief'; label.append(detail);
      }
      button.append(swatch, label); button.onclick = () => selectBasemap(key, true); grid.append(button);
    }
  }
  showMapView(MAP_GROUPS.find(group => group.maps.includes(state.basemap)).id);
  for (let i = 0; i < HISTOGRAM_BINS; i++) {
    const bar = document.createElement('button'); bar.type = 'button'; bar.disabled = true;
    bar.setAttribute('aria-label', 'Load history to select dates'); bar.setAttribute('aria-pressed', 'false');
    bar.tabIndex = i === 0 ? 0 : -1;
    bar.onclick = () => {
      stopPlayback();
      const range = histogramWindow(state.report.min, state.report.max, i, $('histogram').children.length);
      if (!range) return;
      setDates(range.start, range.end); rememberSettings();
    };
    bar.onkeydown = event => {
      const bars = [...$('histogram').children].filter(b => !b.disabled), current = bars.indexOf(bar);
      const index = {ArrowLeft: Math.max(0, current - 1), ArrowRight: Math.min(bars.length - 1, current + 1), Home: 0, End: bars.length - 1}[event.key];
      if (index === undefined) return;
      event.preventDefault(); bars[index].focus();
    };
    bar.onfocus = () => { for (const sibling of $('histogram').children) sibling.tabIndex = sibling === bar ? 0 : -1; };
    $('histogram').append(bar);
  }
  for (let i = 0; i <= 24; i++) {
    if (i < 24) $('hour-start').add(new Option(`${String(i).padStart(2, '0')}:00`, i));
    if (i > 0) $('hour-end').add(new Option(`${String(i).padStart(2, '0')}:00`, i));
  }
  for (const [id, value] of Object.entries({'hour-start': preferences.hourStart, 'hour-end': preferences.hourEnd, accuracy: preferences.accuracy})) $(id).value = value;
  $('hour-start').onchange = () => { stopPlayback(); if (+$('hour-start').value >= +$('hour-end').value) $('hour-end').value = String(+$('hour-start').value + 1); rememberSettings(); refresh(); };
  $('hour-end').onchange = () => { stopPlayback(); if (+$('hour-end').value <= +$('hour-start').value) $('hour-start').value = String(+$('hour-end').value - 1); rememberSettings(); refresh(); };
  $('accuracy').onchange = () => { stopPlayback(); rememberSettings(); refresh(); };
  $('exclude-jumps').setAttribute('aria-pressed', String(state.excludeJumps));
  $('exclude-jumps').onclick = () => {
    stopPlayback(); state.excludeJumps = !state.excludeJumps;
    $('exclude-jumps').setAttribute('aria-pressed', String(state.excludeJumps));
    rememberSettings(); refresh();
  };
  $('metric').onchange = event => { state.views[state.mode].metric = event.target.value; rememberSettings(); paint('metric'); refresh(); };
  document.querySelectorAll('[data-mode]').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode)); button.onclick = () => { state.mode = button.dataset.mode; popup?.remove(); document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); rememberSettings(); paint('mode'); refresh(); }; });
  document.querySelectorAll('[data-palette]').forEach(button => { button.onclick = () => { state.views[state.mode].palette = button.dataset.palette; rememberSettings(); paint('palette'); }; });
  for (const id of ['radius', 'intensity', 'lineWidth', 'opacity']) {
    $(id).oninput = event => { state.views[state.mode][id] = Number(event.target.value) / (id === 'opacity' ? 100 : 1); paint(id); if (id === 'radius' && ['heat', 'hex'].includes(state.mode)) refresh(); };
    $(id).onchange = rememberSettings;
  }
  $('import').onclick = $('empty-import').onclick = () => $('history-file').click();
  $('history-file').onchange = event => { const files = [...event.target.files]; event.target.value = ''; importFiles(files); };
  $('sample').onclick = $('empty-sample').onclick = loadSample;
  $('clear').onclick = clearHistory; $('fit').onclick = fitHistory;
  for (const id of ['date-start', 'date-end']) $(id).onchange = () => {
    stopPlayback();
    const start = Date.parse($('date-start').value), end = Date.parse($('date-end').value) + DAY - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || date(start) < date(state.report.min) || date(end) > date(state.report.max)) { status('Choose an ordered date range within your imported history.', true); syncDates(); return; }
    setDates(start, end); rememberSettings();
  };
  for (const id of ['range-start', 'range-end']) $(id).oninput = () => {
    stopPlayback(); const min = Math.floor(state.report.min / DAY) * DAY, span = Math.floor(state.report.max / DAY) * DAY - min;
    let start = min + Math.round(Number($('range-start').value) / 1000 * span / DAY) * DAY;
    let end = min + Math.round(Number($('range-end').value) / 1000 * span / DAY) * DAY + DAY - 1;
    if (start > end) { if (id === 'range-start') end = start + DAY - 1; else start = end - DAY + 1; }
    setDates(start, end);
  };
  for (const id of ['range-start', 'range-end']) $(id).onchange = rememberSettings;
  document.querySelectorAll('[data-period]').forEach(button => { button.onclick = () => {
    stopPlayback();
    const min = Math.floor(state.report.min / DAY) * DAY, max = Math.floor(state.report.max / DAY) * DAY + DAY - 1;
    const period = button.dataset.period;
    const day = period === state.period ? state.periodDay ?? undefined : undefined;
    const next = resizeWindow(state.start, period, min, max, day);
    setDates(next.start, next.end, period, ['30', '90', '365'].includes(period) ? day ?? new Date(next.start).getUTCDate() : null); rememberSettings();
  }; });
  for (const [id, direction] of [['period-back', -1], ['period-forward', 1]]) $(id).onclick = () => {
    stopPlayback(); moveWindow(direction);
  };
  $('play').onclick = () => {
    if (playback) { stopPlayback(); return; }
    if ($('period-forward').disabled) return;
    $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', 'Pause timeline'); $('play').setAttribute('aria-pressed', 'true');
    const tick = () => {
      if (querying) { playback = setTimeout(tick, 100); return; }
      if (!moveWindow(1) || $('period-forward').disabled) { stopPlayback(); return; }
      playback = setTimeout(tick, 650);
    };
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
    placeHistory = createPlaceHistory({map, report: () => state.report, options: currentOptions, send: message => worker.postMessage(message), status, navigateWindow: direction => { stopPlayback(); moveWindow(direction); }, selectDates: (start, end, hour) => { stopPlayback(); if (hour !== undefined) { $('hour-start').value = hour; $('hour-end').value = hour + 1; } setDates(start, end); rememberSettings(); }});
    map.addControl(new maplibre.NavigationControl({visualizePitch: true}), 'top-right');
    const compass = map.getContainer().querySelector('.maplibregl-ctrl-compass');
    compass.setAttribute('aria-label', 'Reset rotation and tilt'); compass.title = 'Reset rotation and tilt';
    const actions = $('map-actions');
    map.addControl({onAdd: () => actions, onRemove: () => actions.remove()}, 'top-right');
    attributionControl = new maplibre.AttributionControl({compact: false});
    map.addControl(attributionControl, 'bottom-right');
    new ResizeObserver(entries => $('workspace').style.setProperty('--attribution-space', `${entries[0].contentRect.height + 10}px`)).observe(map.getContainer().querySelector('.maplibregl-ctrl-bottom-right'));
    map.on('style.load', installLayers); map.on('moveend', refresh); map.on('moveend', refreshAttribution);
    let errors = 0;
    map.on('error', event => {
      if (/source|tile|fetch|network|load/i.test(event.error?.message ?? '') && ++errors >= 3) { $('map-error').textContent = 'Some map tiles could not load. Your history is still available. Try another base map.'; $('map-error').hidden = false; }
    });
    map.on('click', event => {
      if (state.importing || !state.report || placeHistory.handleClick(event)) return;
      const layer = state.mode === 'hex' ? 'history-hex' : state.mode === 'points' ? 'history-dots' : null;
      if (!layer || !map.getLayer(layer)) return;
      const feature = map.queryRenderedFeatures(event.point, {layers: [layer]})[0];
      if (!feature) return;
      if (state.mode === 'hex') {
        // Rendered polygons may be tile-clipped. Inspect the original cell.
        const original = state.result?.density?.features.find(f => f.properties.cell === feature.properties.cell);
        if (original) placeHistory.select(original, 'Selected hexagon');
        return;
      }
      const p = feature.properties, node = document.createElement('div');
      node.textContent = `${new Date(p.time).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}${p.accuracy == null ? '' : ` · ±${p.accuracy} m`}`;
      popup?.remove(); popup = new maplibre.Popup({maxWidth: '280px'}).setLngLat(event.lngLat).setDOMContent(node).addTo(map);
    });
    createWorker(); setBusy(false); await selectBasemap(state.basemap);
    // The existing public sample is explicit; personal imports are never persisted.
  } catch (error) { status(`The map could not start. Check WebGL support and your connection, then reload. ${error.message}`, true, true); }
}
init();
