import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeCamera, loadNativeSDK, createNativeRenderer, createNativeMaps} from './native-maps.mjs';

function mapStub() {
  const events = new Map(), operations = [];
  const map = {
    center: {lng: 13.4, lat: 52.5}, zoom: 10.25, operations,
    getCenter: () => map.center, getZoom: () => map.zoom, getMaxPitch: () => 60,
    on: (name, callback) => events.set(name, callback), off: name => events.delete(name),
    emit: name => events.get(name)?.(), jumpTo: value => operations.push(value), setMaxPitch: value => operations.push(value),
    dragRotate: {disable() {}, enable() {}}, touchPitch: {disable() {}, enable() {}},
    touchZoomRotate: {disableRotation() {}, enableRotation() {}},
  };
  return map;
}
const hostStub = () => ({style: {}, hidden: false, remove() { this.removed = true; }, replaceChildren() { this.cleared = true; }});

test('SDK cameras preserve center and fractional zoom with the 256/512px zoom offset', () => {
  const map = mapStub();
  assert.deepEqual(nativeCamera(map), {lng: 13.4, lat: 52.5, zoom: 11.25});
  map.center = {lng: 181, lat: 90};
  assert.deepEqual(nativeCamera(map), {lng: 181, lat: 85.051129, zoom: 11.25});
});

test('Google SDK renders satellite/hybrid with fractional camera updates and native credits', () => {
  const map = mapStub(), host = hostStub(), calls = [];
  const sdk = {Map: class {
    constructor(element, options) { assert.equal(element, host); calls.push(options); }
    moveCamera(camera) { calls.push(camera); }
    setMapTypeId(type) { calls.push(type); }
  }, event: {trigger: (_, name) => calls.push(name), clearInstanceListeners: () => calls.push('cleared')}};
  const renderer = createNativeRenderer('google', sdk, host, map, 'satellite');
  assert.equal(calls[0].mapTypeId, 'satellite'); assert.equal(calls[0].isFractionalZoomEnabled, true);
  map.center = {lat: 40, lng: -74}; map.zoom = 12.5; renderer.sync();
  assert.deepEqual(calls[1], {center: {lat: 40, lng: -74}, zoom: 13.5, tilt: 0, heading: 0});
  renderer.setType('hybrid'); renderer.resize(); renderer.destroy();
  assert.deepEqual(calls.slice(2), ['hybrid', 'resize', 'cleared']); assert.equal(host.cleared, true);
});

test('Yandex SDK explicitly uses spherical Mercator, latitude/longitude ordering and fractional zoom', () => {
  const map = mapStub(), calls = [], projection = {};
  const sdk = {projection: {sphericalMercator: projection}, Map: class {
    constructor(_, state, options) { calls.push({state, options}); this.container = {fitToViewport: () => calls.push('resize')}; }
    setCenter(...args) { calls.push(args); }
    setType(type) { calls.push(type); }
    destroy() { calls.push('destroy'); }
  }};
  const renderer = createNativeRenderer('yandex', sdk, hostStub(), map, 'yandex#satellite');
  assert.deepEqual(calls[0].state.center, [52.5, 13.4]); assert.equal(calls[0].state.zoom, 11.25);
  assert.equal(calls[0].options.projection, projection); assert.equal(calls[0].options.avoidFractionalZoom, false);
  map.center = {lng: 30, lat: 60}; map.zoom = 5.75; renderer.sync();
  assert.deepEqual(calls[1], [[60, 30], 6.75, {duration: 0, checkZoomRange: false}]);
  renderer.setType('yandex#hybrid'); renderer.resize(); renderer.destroy();
  assert.deepEqual(calls.slice(2), ['yandex#hybrid', 'resize', 'destroy']);
});

test('SDK loading retries failures, shares one script per provider, and never includes keys in errors', async () => {
  const scripts = [], document = {head: {append: script => scripts.push(script)}, createElement: () => ({remove() { this.removed = true; }})};
  const google = {maps: {Map: class {}}}, ymaps = {ready: callback => callback()};
  const window = {google, ymaps};
  const failed = loadNativeSDK('google', 'secret-test-key', document, window);
  scripts[0].onerror();
  await assert.rejects(failed, error => !error.message.includes('secret-test-key') && /could not load/.test(error.message));
  assert.equal(scripts[0].removed, true);
  const first = loadNativeSDK('google', 'test-key', document, window), second = loadNativeSDK('google', 'test-key', document, window);
  assert.equal(first, second); assert.equal(scripts.length, 2);
  assert.equal(new URL(scripts[1].src).hostname, 'maps.googleapis.com');
  window.__locationHistoryGoogleReady();
  assert.equal(await first, google.maps);
  const yandex = loadNativeSDK('yandex', 'test-key', document, window);
  assert.equal(new URL(scripts[2].src).hostname, 'api-maps.yandex.ru');
  window.__locationHistoryYandexReady(); assert.equal(await yandex, ymaps);
});

test('native map lifecycle reuses SDK instances and syncs only the visible provider', async () => {
  const map = mapStub(), hosts = [], renderers = [], loads = [];
  const workspace = {ownerDocument: {createElement: hostStub}, prepend: host => hosts.push(host)};
  const manager = createNativeMaps(map, workspace, () => {}, {
    load: async provider => { loads.push(provider); return {}; },
    render: () => { const renderer = {types: [], syncs: 0, sizes: 0, setType(type) { this.types.push(type); }, sync() { this.syncs++; }, resize() { this.sizes++; }, destroy() { this.destroyed = true; }}; renderers.push(renderer); return renderer; },
  });
  const [satellite, hybrid] = await Promise.all(['satellite', 'hybrid'].map(mapType => manager.prepare({sdk: 'google', apiKey: 'test-key', mapType})));
  assert.deepEqual(loads, ['google']); assert.equal(renderers.length, 1); assert.equal(hosts[0].hidden, true);
  manager.activate(satellite); assert.equal(hosts[0].hidden, false); assert.equal(map.operations.at(-1), 0);
  map.emit('move'); assert.equal(renderers[0].syncs, 2);
  manager.activate(hybrid); assert.equal(renderers.length, 1); assert.deepEqual(renderers[0].types, ['satellite', 'hybrid']);
  const yandex = await manager.prepare({sdk: 'yandex', apiKey: 'test-key', mapType: 'yandex#satellite'});
  manager.activate(yandex); const oldSyncs = renderers[0].syncs; map.emit('move');
  assert.equal(renderers[0].syncs, oldSyncs); assert.equal(hosts[0].hidden, true); assert.equal(hosts[1].hidden, false);
  manager.activate(null); assert.equal(map.operations.at(-1), 60); const newSyncs = renderers[1].syncs; map.emit('move');
  assert.equal(renderers[1].syncs, newSyncs);
  manager.destroy(); assert.ok(hosts.every(host => host.removed)); assert.ok(renderers.every(renderer => renderer.destroyed));
});
