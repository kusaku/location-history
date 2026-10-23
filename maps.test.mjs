import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoogleProvider, createAzureProvider, googleViewport, raiseBasemapLabels, MAPS, MAP_GROUPS, MAP_ORDER} from './maps.mjs';

const bounds = (west = 13, east = 14, south = 52, north = 53) => ({getWest: () => west, getEast: () => east, getSouth: () => south, getNorth: () => north});
const map = {getBounds: () => bounds(), getZoom: () => 10.5};
const session = () => ({session: 'test-session', expiry: Math.floor(Date.now() / 1000) + 3600, tileWidth: 256, tileHeight: 256});
const ok = data => ({ok: true, json: async () => data});

test('all history modes stay above vector roads and bridges while interleaved labels stay on top', () => {
  // OpenFreeMap Dark starts its symbols with water_name before the road layers;
  // Liberty similarly places direction arrows before bridges and buildings.
  const layers = [
    {id: 'background', type: 'background'}, {id: 'water_name', type: 'symbol'},
    {id: 'building', type: 'fill'}, {id: 'highway_major_inner', type: 'line'},
    {id: 'road_oneway', type: 'symbol'}, {id: 'bridge', type: 'line'},
    {id: 'boundary', type: 'line'}, {id: 'city-label', type: 'symbol'},
  ];
  const anchor = raiseBasemapLabels({
    getStyle: () => ({layers}),
    moveLayer(id) { layers.push(...layers.splice(layers.findIndex(layer => layer.id === id), 1)); },
  });
  const history = ['history-heat', 'history-hex', 'history-dots', 'history-route'];
  for (const id of history) layers.splice(layers.findIndex(layer => layer.id === anchor), 0, {id});
  assert.deepEqual(layers.map(layer => layer.id), ['background', 'building', 'highway_major_inner', 'bridge', 'boundary', ...history, 'water_name', 'road_oneway', 'city-label']);
});

test('raster label overlays remain above history and maps without labels need no anchor', () => {
  for (const layers of [[], [{id: 'basemap', type: 'raster'}], [{id: 'basemap', type: 'raster'}, {id: 'basemap-labels', type: 'raster'}]]) {
    const anchor = raiseBasemapLabels({
      getStyle: () => ({layers}),
      moveLayer(id) { layers.push(...layers.splice(layers.findIndex(layer => layer.id === id), 1)); },
    });
    layers.splice(anchor ? layers.findIndex(layer => layer.id === anchor) : layers.length, 0, {id: 'history-heat'});
    assert.equal(layers.at(anchor ? -2 : -1).id, 'history-heat');
    if (anchor) assert.equal(layers.at(-1).id, 'basemap-labels');
  }
});

test('Google viewport wraps the dateline and bounds global views', () => {
  assert.deepEqual(googleViewport(bounds(170, 190), 23), {west: 170, east: -170, south: 52, north: 53, zoom: 22});
  assert.deepEqual(googleViewport(bounds(-200, 200, -90, 90), -1), {west: -179.999999, east: 179.999999, south: -89.999999, north: 89.999999, zoom: 0});
  assert.equal(googleViewport(bounds(), 10.49).zoom, 11);
  assert.equal(googleViewport(bounds(), 10.5).zoom, 12);
});

test('Google uses one session, documented tile URLs and escaped viewport attribution', async () => {
  const calls = [];
  const provider = createGoogleProvider('test-key', 'terrain', async (url, options) => {
    calls.push({url: new URL(url), options});
    return ok(url.includes('/createSession?') ? session() : {copyright: '© <Example> & data'});
  });
  const [style, credit] = await Promise.all([provider.style(map), provider.attribution(map)]);
  assert.equal(calls.filter(c => c.url.pathname === '/v1/createSession').length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), {mapType: 'terrain', language: 'en-US', region: 'DE', layerTypes: ['layerRoadmap']});
  assert.match(style.sources.basemap.tiles[0], /^https:\/\/tile.googleapis.com\/v1\/2dtiles\/\{z\}\/\{x\}\/\{y\}\?session=test-session&key=test-key$/);
  assert.match(credit, /translate="no">Google Maps<\/span> © &lt;Example&gt; &amp; data/);
  assert.equal(style.metadata.providerAttribution, credit);
  const viewport = calls.find(c => c.url.pathname === '/tile/v1/viewport').url;
  assert.equal(viewport.searchParams.get('west'), '13');
  assert.equal(viewport.searchParams.get('zoom'), '12');
  await provider.attribution(map);
  assert.equal(calls.filter(c => c.url.pathname === '/v1/createSession').length, 1);
});

test('Google rejects invalid sessions and retries failed initialization', async () => {
  let attempts = 0;
  const provider = createGoogleProvider('test-key', 'roadmap', async url => {
    if (!url.includes('/createSession?')) return ok({copyright: '© Example'});
    return ok(++attempts === 1 ? {...session(), expiry: 0} : session());
  });
  await assert.rejects(provider.style(map), /invalid tile session/);
  assert.ok((await provider.style(map)).sources.basemap);
  assert.equal(attempts, 2);
});

test('Google errors do not expose credentials or omit mandatory attribution', async () => {
  const failed = createGoogleProvider('secret-test-key', 'roadmap', async () => ({ok: false, status: 403}));
  await assert.rejects(failed.style(map), error => error.message.includes('HTTP 403') && !error.message.includes('secret-test-key'));
  const noCredit = createGoogleProvider('test-key', 'roadmap', async url => ok(url.includes('/createSession?') ? session() : {}));
  await assert.rejects(noCredit.style(map), /required data attribution/);
});

test('Yandex uses Web Mercator and preserves terms and map links', async () => {
  const {createYandexProvider} = await import('./maps.mjs');
  const provider = createYandexProvider('test-key');
  const style = await provider.style({getCenter: () => ({lng: 13.4, lat: 52.5}), getZoom: () => 10});
  assert.match(style.sources.basemap.tiles[0], /projection=web_mercator/);
  assert.match(style.sources.basemap.tiles[0], /maptype=future_map/);
  assert.match(style.metadata.providerAttribution, /Terms of use/);
  assert.match(style.metadata.providerAttribution, /Open in Maps/);
  assert.match(style.metadata.providerAttribution, /13.4%2C52.5/);
});

test('Yandex tile requests are paced, cancellable and return cache headers', async () => {
  const {createYandexTileLoader} = await import('./maps.mjs');
  const starts = [];
  const loader = createYandexTileLoader(async url => {
    starts.push(Date.now());
    assert.equal(url, 'https://tiles.api-maps.yandex.ru/v1/tiles/?apikey=test-key');
    return {ok: true, arrayBuffer: async () => new ArrayBuffer(8), headers: new Headers({'Cache-Control': 'max-age=100'})};
  });
  const params = {url: 'yandex-tiles://tiles.api-maps.yandex.ru/v1/tiles/?apikey=test-key'};
  const results = await Promise.all(Array.from({length: 4}, () => loader(params, new AbortController())));
  assert.ok(starts[3] - starts[0] >= 115);
  assert.equal(results[0].data.byteLength, 8);
  assert.equal(results[0].cacheControl, 'max-age=100');
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(loader(params, cancelled), {name: 'AbortError'});
  assert.equal(starts.length, 4);
});

test('Azure renders the documented road, imagery and relief tilesets with matching attribution', async () => {
  const requests = [];
  for (const [type, tileset, maxzoom] of [['road', 'microsoft.base.road', 22], ['dark', 'microsoft.base.darkgrey', 22], ['satellite', 'microsoft.imagery', 19], ['relief', 'microsoft.terra.main', 6]]) {
    const provider = createAzureProvider('test-key', type, async url => { requests.push(new URL(url)); return ok({copyrights: ['<a data-azure-maps-attribution-tileset="example">&copy;2026 Example &amp; data</a>']}); });
    const style = await provider.style(map), source = style.sources.basemap;
    const tileSize = type === 'relief' ? 512 : 256;
    assert.match(source.tiles[0], /api-version=2024-04-01/); assert.ok(source.tiles[0].includes(`tileSize=${tileSize}`));
    assert.equal(source.tileSize, tileSize);
    assert.ok(source.tiles[0].includes(`tilesetId=${tileset}`)); assert.equal(source.maxzoom, maxzoom);
    assert.match(style.metadata.providerAttribution, /©2026 Example &amp; data/);
    assert.equal(requests.at(-1).searchParams.get('tilesetId'), tileset);
    assert.equal(requests.at(-1).searchParams.get('zoom'), String(Math.min(maxzoom, 12)));
  }
});

test('Azure hybrid combines imagery and road labels, and splits attribution at the dateline', async () => {
  const requests = [], provider = createAzureProvider('test-key', 'hybrid', async url => { requests.push(new URL(url)); return ok({copyrights: ['© Example']}); });
  const style = await provider.style({getBounds: () => bounds(170, 190), getZoom: () => 10});
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map(url => url.searchParams.get('bounds')), ['170,52,180,53', '-180,52,-170,53', '170,52,180,53', '-180,52,-170,53']);
  assert.equal(style.layers.at(-1).id, 'basemap-labels'); assert.match(style.sources.labels.tiles[0], /microsoft.base.hybrid.road/);
  assert.equal((style.metadata.providerAttribution.match(/© Example/g) ?? []).length, 1);
});

test('Azure rejects missing credits, escapes returned text and does not expose credentials in errors', async () => {
  const failed = createAzureProvider('secret-test-key', 'road', async () => ({ok: false, status: 403}));
  await assert.rejects(failed.style(map), error => /HTTP 403/.test(error.message) && !error.message.includes('secret-test-key'));
  const missing = createAzureProvider('test-key', 'road', async () => ok({}));
  await assert.rejects(missing.style(map), /required data attribution/);
  const escaped = createAzureProvider('test-key', 'road', async () => ok({copyrights: ['<img src=x onerror=alert(1)>© "Example" & data']}));
  const credit = await escaped.attribution(map);
  assert.ok(!credit.includes('<img')); assert.match(credit, /© &quot;Example&quot; &amp; data/);
  assert.throws(() => createAzureProvider('test-key', 'missing'), /Unknown Azure Maps style/);
});

test('Azure relief accepts empty contributor attribution and uses the 512px tile zoom', async () => {
  let requestedZoom;
  const provider = createAzureProvider('test-key', 'relief', async url => { requestedZoom = new URL(url).searchParams.get('zoom'); return ok({copyrights: []}); });
  const style = await provider.style({...map, getZoom: () => 3.2});
  assert.equal(requestedZoom, '3');
  assert.ok(style.metadata.providerAttribution.endsWith(`>©${new Date().getUTCFullYear()} Microsoft Azure Maps</a>`));
  assert.equal(style.sources.basemap.tileSize, 512);
});

test('map choices group views with consistent provider order and no unavailable or ambiguous option', () => {
  assert.deepEqual(MAP_GROUPS.map(group => group.id), ['roads', 'terrain', 'satellite', 'hybrid', 'dark']);
  assert.deepEqual(MAP_ORDER.slice(0, 4), ['google', 'yandex', 'osm', 'azure']);
  assert.deepEqual(MAP_GROUPS.find(group => group.id === 'satellite').maps, ['google-satellite', 'yandex-satellite', 'azure-satellite', 'satellite']);
  assert.deepEqual(MAP_GROUPS.find(group => group.id === 'hybrid').maps, ['google-hybrid', 'yandex-hybrid', 'azure-hybrid']);
  assert.equal(MAP_ORDER.length, Object.keys(MAPS).length); assert.equal(new Set(MAP_ORDER).size, MAP_ORDER.length);
  assert.equal(MAPS.satellite.name, 'Esri satellite');
  for (const key of MAP_ORDER) assert.ok(MAPS[key].provider);
});
