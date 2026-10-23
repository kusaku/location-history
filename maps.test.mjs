import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoogleProvider, googleViewport} from './maps.mjs';

const bounds = (west = 13, east = 14, south = 52, north = 53) => ({getWest: () => west, getEast: () => east, getSouth: () => south, getNorth: () => north});
const map = {getBounds: () => bounds(), getZoom: () => 10.5};
const session = () => ({session: 'test-session', expiry: Math.floor(Date.now() / 1000) + 3600, tileWidth: 256, tileHeight: 256});
const ok = data => ({ok: true, json: async () => data});

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
