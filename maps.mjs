import {MAP_CONFIG} from './map-config.mjs?v=4';

// Keep every provider's attribution with its documented endpoint.
const osm = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>';
const raster = (tiles, attribution, maxzoom = 19, tileSize = 256) => ({
  version: 8,
  sources: {basemap: {type: 'raster', tiles: [tiles], tileSize, maxzoom, attribution}},
  layers: [{id: 'background', type: 'background', paint: {'background-color': '#dce3e5'}}, {id: 'basemap', type: 'raster', source: 'basemap'}],
});
export const MAPS = {
  dark: {name: 'Midnight', detail: 'OpenFreeMap · dark vector', style: 'https://tiles.openfreemap.org/styles/dark', tone: 'dark'},
  light: {name: 'Paper', detail: 'OpenFreeMap · light vector', style: 'https://tiles.openfreemap.org/styles/positron', tone: 'light'},
  streets: {name: 'Streets', detail: 'OpenFreeMap · Liberty', style: 'https://tiles.openfreemap.org/styles/liberty', tone: 'light'},
  bright: {name: 'Bright', detail: 'OpenFreeMap · Bright', style: 'https://tiles.openfreemap.org/styles/bright', tone: 'light'},
  satellite: {name: 'Esri satellite', detail: 'Esri · World Imagery', tone: 'dark', swatch: 'satellite', style: raster('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', '<a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9">Esri World Imagery</a> · Esri, Vantor, Earthstar Geographics, GIS User Community', 19)},
  osm: {name: 'OpenStreetMap', detail: 'OpenStreetMap · standard', tone: 'light', style: raster('https://tile.openstreetmap.org/{z}/{x}/{y}.png', osm)},
};

const escapeHTML = text => String(text).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
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
    name: mapType === 'terrain' ? 'Google terrain' : 'Google Maps',
    detail: mapType === 'terrain' ? 'Google Maps · terrain' : 'Google Maps · roads', tone: 'light',
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
  return {name: 'Yandex Maps', detail: 'Yandex · map tiles', tone: 'light', tiles, attribution,
    async style(map) {
      const style = raster(tiles()[0], '', 20);
      style.metadata = {providerAttribution: await attribution(map)};
      return style;
    },
  };
}
if (MAP_CONFIG.yandexTilesApiKey) MAPS.yandex = createYandexProvider(MAP_CONFIG.yandexTilesApiKey);

const nativeProvider = (sdk, apiKey, mapType, name, detail) => ({
  name, detail, tone: 'dark', swatch: 'satellite',
  native: {sdk, apiKey, mapType}, style: {version: 8, sources: {}, layers: []},
});
if (MAP_CONFIG.googleMapsJavaScriptApiKey) {
  MAPS['google-satellite'] = nativeProvider('google', MAP_CONFIG.googleMapsJavaScriptApiKey, 'satellite', 'Google satellite', 'Google Maps · satellite');
  MAPS['google-hybrid'] = nativeProvider('google', MAP_CONFIG.googleMapsJavaScriptApiKey, 'hybrid', 'Google hybrid', 'Google Maps · satellite with labels');
}
if (MAP_CONFIG.yandexJavaScriptApiKey) {
  MAPS['yandex-satellite'] = nativeProvider('yandex', MAP_CONFIG.yandexJavaScriptApiKey, 'yandex#satellite', 'Yandex satellite', 'Yandex · satellite');
  MAPS['yandex-hybrid'] = nativeProvider('yandex', MAP_CONFIG.yandexJavaScriptApiKey, 'yandex#hybrid', 'Yandex hybrid', 'Yandex · satellite with labels');
}

const AZURE_STYLES = {
  road: {name: 'Azure Maps', detail: 'roads', tileset: 'microsoft.base.road', tone: 'light', maxzoom: 22},
  dark: {name: 'Azure dark', detail: 'dark roads', tileset: 'microsoft.base.darkgrey', tone: 'dark', maxzoom: 22},
  satellite: {name: 'Azure satellite', detail: 'satellite', tileset: 'microsoft.imagery', tone: 'dark', minzoom: 1, maxzoom: 19},
  hybrid: {name: 'Azure hybrid', detail: 'satellite with labels', tileset: 'microsoft.imagery', labels: 'microsoft.base.hybrid.road', tone: 'dark', minzoom: 1, maxzoom: 19},
  relief: {name: 'Azure relief', detail: 'shaded relief · world scale', tileset: 'microsoft.terra.main', tone: 'light', maxzoom: 6, tileSize: 512},
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
    return [`<a href="https://www.microsoft.com/maps/product/terms.html">Microsoft Azure Maps</a>`, ...copyrights].join(' · ');
  }
  return {name: spec.name, detail: `Microsoft Azure · ${spec.detail}`, tone: spec.tone, swatch: ['satellite', 'hybrid'].includes(type) ? 'satellite' : type === 'dark' ? 'dark' : 'light', tiles, attribution,
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

// Satellite labels identify the imagery provider; missing credentials stay hidden.
export const MAP_ORDER = ['google', 'yandex', 'osm', 'satellite', 'google-satellite', 'yandex-satellite', 'azure', 'azure-satellite', 'google-terrain', 'google-hybrid', 'yandex-hybrid', 'azure-hybrid', 'azure-dark', 'azure-relief', 'dark', 'light', 'streets', 'bright'].filter(key => MAPS[key]);

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
