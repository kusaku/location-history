import {MAP_CONFIG} from './map-config.mjs?v=4';

// Keep every provider's attribution with its documented endpoint.
const osm = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>';
const raster = (tiles, attribution, maxzoom = 19, tileSize = 256) => ({
  version: 8,
  sources: {basemap: {type: 'raster', tiles: [tiles], tileSize, maxzoom, attribution}},
  layers: [{id: 'background', type: 'background', paint: {'background-color': '#dce3e5'}}, {id: 'basemap', type: 'raster', source: 'basemap'}],
});
export const MAPS = {
  dark: {name: 'Midnight', provider: 'OpenFreeMap', style: 'https://tiles.openfreemap.org/styles/dark'},
  light: {name: 'Paper', provider: 'OpenFreeMap', style: 'https://tiles.openfreemap.org/styles/positron'},
  streets: {name: 'Streets', provider: 'OpenFreeMap', style: 'https://tiles.openfreemap.org/styles/liberty'},
  bright: {name: 'Bright', provider: 'OpenFreeMap', style: 'https://tiles.openfreemap.org/styles/bright'},
  satellite: {name: 'Esri satellite', provider: 'Esri', style: raster('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', '<a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9">Esri World Imagery</a> · Esri, Vantor, Earthstar Geographics, GIS User Community', 19)},
  osm: {name: 'OpenStreetMap', provider: 'OpenStreetMap', style: raster('https://tile.openstreetmap.org/{z}/{x}/{y}.png', osm)},
};

const escapeHTML = text => String(text).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
export function raiseBasemapLabels(map) {
  // Some vector styles put water labels before roads and buildings. Move all
  // labels above the geometry before using the first label as the overlay anchor.
  const labels = map.getStyle().layers.filter(layer => layer.type === 'symbol' || layer.id === 'basemap-labels');
  for (const {id} of labels) map.moveLayer(id);
  return labels[0]?.id;
}

export function googleViewport(bounds, zoom) {
  const wrap = longitude => Math.max(-179.999999, Math.min(179.999999, ((longitude + 180) % 360 + 360) % 360 - 180));
  const west = bounds.getWest(), east = bounds.getEast();
  return {
    west: east - west >= 360 ? -179.999999 : wrap(west),
    east: east - west >= 360 ? 179.999999 : wrap(east),
    north: Math.min(89.999999, bounds.getNorth()),
    south: Math.max(-89.999999, bounds.getSouth()),
    // MapLibre uses a 512px world at zoom 0 and rounds raster tile zooms.
    // This source serves 256px tiles, so its tile level is one higher.
    zoom: Math.max(0, Math.min(22, Math.round(zoom + 1))),
  };
}

export function createGoogleProvider(apiKey, mapType = 'roadmap', fetcher = globalThis.fetch) {
  let session, pending;
  async function request(path, params = {}, options = {}) {
    const query = new URLSearchParams({...params, key: apiKey});
    const response = await fetcher(`https://tile.googleapis.com/${path}?${query}`, {signal: AbortSignal.timeout(15000), ...options});
    // Provider errors can echo the request URL. Never surface its credential.
    if (!response.ok) throw new Error(`Google Maps HTTP ${response.status}. Check API activation, billing, and website restrictions.`);
    return response.json();
  }
  async function getSession() {
    if (session && Number(session.expiry) * 1000 > Date.now() + 60000) return session;
    if (!pending) pending = request('v1/createSession', {}, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({mapType, language: 'en-US', region: 'DE', ...(mapType === 'terrain' ? {layerTypes: ['layerRoadmap']} : {})}),
    }).then(data => {
      if (typeof data.session !== 'string' || !data.session || !(Number(data.expiry) * 1000 > Date.now() + 60000) || data.tileWidth !== 256 || data.tileHeight !== 256) throw new Error('Google Maps returned an invalid tile session.');
      session = data;
      return data;
    }).finally(() => { pending = null; });
    return pending;
  }
  const tiles = () => [`https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(session.session)}&key=${encodeURIComponent(apiKey)}`];
  async function attribution(map) {
    const current = await getSession();
    const viewport = googleViewport(map.getBounds(), map.getZoom());
    const data = await request('tile/v1/viewport', {session: current.session, ...viewport});
    if (!data.copyright) throw new Error('Google Maps did not return the required data attribution.');
    return `<span class="google-maps-brand" translate="no">Google Maps</span> ${escapeHTML(data.copyright)}`;
  }
  return {
    name: mapType === 'terrain' ? 'Google terrain' : 'Google Maps', provider: 'Google',
    attribution, tiles,
    async style(map) {
      const credit = await attribution(map);
      const style = raster(tiles()[0], '', 22);
      style.metadata = {providerAttribution: credit};
      return style;
    },
  };
}

if (MAP_CONFIG.googleMapsApiKey) {
  MAPS.google = createGoogleProvider(MAP_CONFIG.googleMapsApiKey);
  MAPS['google-terrain'] = createGoogleProvider(MAP_CONFIG.googleMapsApiKey, 'terrain');
}

export function createYandexProvider(apiKey) {
  // The default Yandex projection is elliptical Mercator; explicitly request
  // Web Mercator so the tiles align with every history overlay.
  const tiles = () => [`yandex-tiles://tiles.api-maps.yandex.ru/v1/tiles/?apikey=${encodeURIComponent(apiKey)}&lang=en_US&l=map&projection=web_mercator&maptype=future_map&z={z}&x={x}&y={y}`];
  const attribution = async map => {
    const center = map.getCenter();
    const url = `https://yandex.com/maps/?ll=${encodeURIComponent(`${center.lng},${center.lat}`)}&z=${Math.max(0, Math.min(20, map.getZoom() + 1)).toFixed(2)}`;
    return `© Yandex · <a href="https://yandex.ru/legal/maps_termsofuse/">Terms of use</a> · <a href="${url}" target="_blank" rel="noopener">Open in Maps ↗</a>`;
  };
  return {name: 'Yandex Maps', provider: 'Yandex', tiles, attribution,
    async style(map) {
      const style = raster(tiles()[0], '', 20);
      style.metadata = {providerAttribution: await attribution(map)};
      return style;
    },
  };
}
if (MAP_CONFIG.yandexTilesApiKey) MAPS.yandex = createYandexProvider(MAP_CONFIG.yandexTilesApiKey);

const nativeProvider = (sdk, apiKey, mapType, name) => ({
  name, provider: sdk === 'google' ? 'Google' : 'Yandex',
  native: {sdk, apiKey, mapType}, style: {version: 8, sources: {}, layers: []},
});
if (MAP_CONFIG.googleMapsJavaScriptApiKey) {
  MAPS['google-satellite'] = nativeProvider('google', MAP_CONFIG.googleMapsJavaScriptApiKey, 'satellite', 'Google satellite');
  MAPS['google-hybrid'] = nativeProvider('google', MAP_CONFIG.googleMapsJavaScriptApiKey, 'hybrid', 'Google hybrid');
}
if (MAP_CONFIG.yandexJavaScriptApiKey) {
  MAPS['yandex-satellite'] = nativeProvider('yandex', MAP_CONFIG.yandexJavaScriptApiKey, 'yandex#satellite', 'Yandex satellite');
  MAPS['yandex-hybrid'] = nativeProvider('yandex', MAP_CONFIG.yandexJavaScriptApiKey, 'yandex#hybrid', 'Yandex hybrid');
}

const AZURE_STYLES = {
  road: {name: 'Azure Maps', tileset: 'microsoft.base.road', maxzoom: 22},
  dark: {name: 'Azure dark', tileset: 'microsoft.base.darkgrey', maxzoom: 22},
  satellite: {name: 'Azure satellite', tileset: 'microsoft.imagery', minzoom: 1, maxzoom: 19},
  hybrid: {name: 'Azure hybrid', tileset: 'microsoft.imagery', labels: 'microsoft.base.hybrid.road', minzoom: 1, maxzoom: 19},
  relief: {name: 'Azure relief', tileset: 'microsoft.terra.main', maxzoom: 6, tileSize: 512},
};
export function createAzureProvider(apiKey, type = 'road', fetcher = globalThis.fetch) {
  const spec = AZURE_STYLES[type];
  if (!spec) throw new Error('Unknown Azure Maps style.');
  const query = tileset => `api-version=2024-04-01&tilesetId=${tileset}&subscription-key=${encodeURIComponent(apiKey)}`;
  const tileSize = spec.tileSize ?? 256;
  const tile = tileset => `https://atlas.microsoft.com/map/tile?${query(tileset)}&tileSize=${tileSize}&language=en-US&view=Unified&zoom={z}&x={x}&y={y}`;
  const tiles = () => [tile(spec.tileset)];
  async function attribution(map) {
    const v = googleViewport(map.getBounds(), map.getZoom());
    const south = Math.max(-85.051129, v.south), north = Math.min(85.051129, v.north);
    const boxes = v.west > v.east ? [[v.west, south, 180, north], [-180, south, v.east, north]] : [[v.west, south, v.east, north]];
    const copyrights = new Set();
    for (const tileset of [spec.tileset, spec.labels].filter(Boolean)) for (const box of boxes) {
      const zoom = Math.max(spec.minzoom ?? 0, Math.min(spec.maxzoom, Math.round(map.getZoom() + (tileSize === 256 ? 1 : 0))));
      const response = await fetcher(`https://atlas.microsoft.com/map/attribution?${query(tileset)}&zoom=${zoom}&bounds=${box.join(',')}`, {signal: AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error(`Azure Maps HTTP ${response.status}. Check account activation and browser access.`);
      const data = await response.json();
      if (!Array.isArray(data.copyrights) || !data.copyrights.every(text => typeof text === 'string' && text.trim())) throw new Error('Azure Maps did not return the required data attribution.');
      // Keep readable credit text without inserting remote markup or URLs.
      for (const text of data.copyrights) {
        const credit = text.replace(/<[^>]*>/g, '').replace(/&copy;/g, '©').replace(/&amp;/g, '&').trim();
        if (!credit) throw new Error('Azure Maps returned unreadable data attribution.');
        copyrights.add(escapeHTML(credit));
      }
    }
    // Relief can return an empty list; still show the Microsoft provider credit.
    return [`<a href="https://www.microsoft.com/maps/product/terms.html">©${new Date().getUTCFullYear()} Microsoft Azure Maps</a>`, ...copyrights].join(' · ');
  }
  return {name: spec.name, provider: 'Azure', tiles, attribution,
    async style(map) {
      const style = raster(tiles()[0], '', spec.maxzoom, tileSize);
      style.sources.basemap.minzoom = spec.minzoom ?? 0;
      if (spec.labels) {
        style.sources.labels = {type: 'raster', tiles: [tile(spec.labels)], tileSize: 256, maxzoom: 22};
        style.layers.push({id: 'basemap-labels', type: 'raster', source: 'labels'});
      }
      style.metadata = {providerAttribution: await attribution(map)};
      return style;
    },
  };
}
if (MAP_CONFIG.azureMapsSubscriptionKey) for (const type of Object.keys(AZURE_STYLES)) {
  MAPS[type === 'road' ? 'azure' : `azure-${type}`] = createAzureProvider(MAP_CONFIG.azureMapsSubscriptionKey, type);
}

// Group by view, keeping provider order consistent and unavailable maps hidden.
export const MAP_GROUPS = [
  {id: 'roads', name: 'Roads', maps: ['google', 'yandex', 'osm', 'azure', 'streets', 'bright', 'light']},
  {id: 'terrain', name: 'Terrain', maps: ['google-terrain', 'azure-relief']},
  {id: 'satellite', name: 'Satellite', maps: ['google-satellite', 'yandex-satellite', 'azure-satellite', 'satellite']},
  {id: 'hybrid', name: 'Hybrid · satellite with labels', maps: ['google-hybrid', 'yandex-hybrid', 'azure-hybrid']},
  {id: 'dark', name: 'Dark', maps: ['azure-dark', 'dark']},
].map(group => ({...group, maps: group.maps.filter(key => MAPS[key])})).filter(group => group.maps.length);
export const MAP_ORDER = MAP_GROUPS.flatMap(group => group.maps);

// Spread requests below the free Tiles API's 30 requests/second allowance.
// A project-wide limit still applies when several visitors use the same key.
export function createYandexTileLoader(fetcher = globalThis.fetch) {
  let queue = Promise.resolve(), lastStart = 0;
  return async (params, controller) => {
    const signal = controller.signal;
    const turn = queue.then(async () => {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 40 - (Date.now() - lastStart))));
      signal.throwIfAborted();
      lastStart = Date.now();
    });
    queue = turn.catch(() => {});
    await turn;
    const url = params.url.replace(/^yandex-tiles:/, 'https:');
    const response = await fetcher(url, {signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])});
    if (!response.ok) throw new Error(`Yandex Maps HTTP ${response.status}. Check key activation or the request limit.`);
    return {data: await response.arrayBuffer(), cacheControl: response.headers.get('Cache-Control'), expires: response.headers.get('Expires')};
  };
}
export const PALETTES = {
  ember: {name: 'Ember', colors: ['#35266f', '#7546be', '#c65ea3', '#f18a76', '#ffc37e', '#fff1b0']},
  ocean: {name: 'Ocean', colors: ['#182a74', '#1761ab', '#1aa6b2', '#47d7bb', '#a3f1b5', '#f0ffce']},
  spectral: {name: 'Spectrum', colors: ['#4155b4', '#21a6cc', '#75d2a5', '#f6e683', '#f89b54', '#d94448']},
};

function colourExpression(palette, input, transparent = false) {
  const colors = PALETTES[palette].colors;
  const stops = transparent ? [0, 'rgba(0,0,0,0)', .08, colors[0]] : [0, colors[0]];
  for (let i = 1; i < colors.length; i++) stops.push(i / (colors.length - 1), colors[i]);
  return ['interpolate', ['linear'], input, ...stops];
}

// Fit cached selection bounds, reserving only the full-width overlays. A place
// panel floats in one corner and must not shrink the entire usable map.
export function fitHistoryBounds(map, bounds, {heading, timeline, controls}, reducedMotion = false) {
  if (!bounds) return;
  const frame = map.getContainer().getBoundingClientRect();
  if (!frame.width || !frame.height) return;
  const top = heading.getBoundingClientRect(), bottom = timeline.getBoundingClientRect(), right = controls.getBoundingClientRect();
  const padding = {
    top: Math.min(Math.max(24, top.bottom - frame.top + 12), frame.height * .25),
    bottom: Math.min(Math.max(24, frame.bottom - bottom.top + 12), frame.height * .5),
    left: Math.min(Math.max(24, top.left - frame.left + 12), frame.width * .25),
    right: Math.min(Math.max(24, frame.right - right.left + 12), frame.width * .25),
  };
  map.fitBounds(bounds, {padding, maxZoom: map.getMaxZoom(), bearing: 0, pitch: 0, roll: 0, linear: true, duration: reducedMotion ? 0 : 500});
}

// Apply only properties affected by a control. A newly loaded style needs all.
export function paintHistory(map, state, changed) {
  if (!map?.getLayer('history-heat')) return;
  const all = changed === undefined, colour = all || changed === 'palette', strength = all || changed === 'intensity';
  const opacity = all || changed === 'opacity', radius = all || changed === 'radius';
  if (all || changed === 'mode') for (const [id, mode] of [['history-heat', 'heat'], ['history-hex', 'hex'], ['history-dots', 'points'], ['history-route', 'route']]) map.setLayoutProperty(id, 'visibility', state.mode === mode ? 'visible' : 'none');
  if (colour) {
    map.setPaintProperty('history-heat', 'heatmap-color', colourExpression(state.palette, ['heatmap-density'], true));
  }
  if (colour || changed === 'time') {
    const position = ['max', 0, ['min', 1, ['/', ['-', ['get', 'time'], state.start ?? 0], Math.max(1, (state.end ?? 0) - (state.start ?? 0))]]];
    const color = colourExpression(state.palette, position);
    map.setPaintProperty('history-dots', 'circle-color', color);
    map.setPaintProperty('history-route', 'line-color', color);
  }
  if (colour || strength) map.setPaintProperty('history-hex', 'fill-color', colourExpression(state.palette, ['min', 1, ['*', ['get', 'weight'], state.intensity]]));
  if (strength) map.setPaintProperty('history-heat', 'heatmap-intensity', state.intensity);
  if (all || changed === 'lineWidth') map.setPaintProperty('history-route', 'line-width', state.lineWidth ?? 1.5);
  if (strength || opacity) map.setPaintProperty('history-dots', 'circle-opacity', Math.min(1, state.opacity * state.intensity));
  if (opacity) for (const [id, property] of [['history-heat', 'heatmap-opacity'], ['history-hex', 'fill-opacity'], ['history-route', 'line-opacity']]) map.setPaintProperty(id, property, state.opacity);
  if (radius) {
    map.setPaintProperty('history-heat', 'heatmap-radius', ['interpolate', ['linear'], ['zoom'], 0, state.radius * .7, 14, state.radius, 20, state.radius * 1.3]);
    map.setPaintProperty('history-dots', 'circle-radius', state.radius / 8);
  }
}
