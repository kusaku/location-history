// Satellite imagery is rendered by the supported provider SDKs. MapLibre keeps
// rendering local history on a transparent, synchronized Mercator overlay.
const pendingSDKs = new Map();

export function nativeCamera(map) {
  const {lng, lat} = map.getCenter();
  return {lng, lat: Math.max(-85.051129, Math.min(85.051129, lat)), zoom: map.getZoom() + 1};
}

export function loadNativeSDK(provider, key, document = globalThis.document, window = globalThis.window) {
  if (pendingSDKs.has(provider)) return pendingSDKs.get(provider);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const callback = provider === 'google' ? '__locationHistoryGoogleReady' : '__locationHistoryYandexReady';
    let settled = false;
    const finish = (sdk, error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); delete window[callback];
      if (error) { script.remove(); reject(error); }
      else resolve(sdk);
    };
    const timer = setTimeout(() => finish(null, new Error(`${provider === 'google' ? 'Google' : 'Yandex'} Maps SDK timed out.`)), 20000);
    window[callback] = () => {
      if (provider === 'google') finish(window.google.maps);
      else window.ymaps.ready(() => finish(window.ymaps));
    };
    script.async = true;
    script.onerror = () => finish(null, new Error(`${provider === 'google' ? 'Google' : 'Yandex'} Maps SDK could not load. Check the browser key and website restriction.`));
    script.src = provider === 'google'
      ? `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=quarterly&loading=async&callback=${callback}`
      : `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(key)}&lang=en_US&load=Map,projection.sphericalMercator&onload=${callback}`;
    document.head.append(script);
  }).catch(error => { pendingSDKs.delete(provider); throw error; });
  pendingSDKs.set(provider, promise);
  return promise;
}

export function createNativeRenderer(provider, sdk, host, map, type) {
  const camera = nativeCamera(map);
  if (provider === 'google') {
    const native = new sdk.Map(host, {
      center: {lat: camera.lat, lng: camera.lng}, zoom: camera.zoom, mapTypeId: type,
      disableDefaultUI: true, clickableIcons: false, gestureHandling: 'none',
      keyboardShortcuts: false, isFractionalZoomEnabled: true, tilt: 0, heading: 0,
    });
    return {
      setType: value => native.setMapTypeId(value),
      sync: () => { const c = nativeCamera(map); native.moveCamera({center: {lat: c.lat, lng: c.lng}, zoom: c.zoom, tilt: 0, heading: 0}); },
      resize: () => sdk.event.trigger(native, 'resize'),
      destroy: () => { sdk.event.clearInstanceListeners(native); host.replaceChildren(); },
    };
  }
  const native = new sdk.Map(host, {
    center: [camera.lat, camera.lng], zoom: camera.zoom, type, controls: [], behaviors: [],
  }, {
    projection: sdk.projection.sphericalMercator, avoidFractionalZoom: false,
    suppressMapOpenBlock: true, copyrightLogoVisible: false,
  });
  return {
    setType: value => native.setType(value),
    sync: () => { const c = nativeCamera(map); native.setCenter([c.lat, c.lng], c.zoom, {duration: 0, checkZoomRange: false}); },
    resize: () => native.container.fitToViewport(),
    destroy: () => native.destroy(),
  };
}

// Cache one instance per SDK: switching satellite/hybrid does not create another
// billable map load. The inactive SDK does not follow map movements.
export function createNativeMaps(map, workspace, onError, {load = loadNativeSDK, render = createNativeRenderer} = {}) {
  const records = new Map(), preparing = new Map();
  const maxPitch = map.getMaxPitch();
  let active = null, locked = false;
  const sync = () => active?.renderer.sync();
  const resize = () => { active?.renderer.resize(); sync(); };
  map.on('move', sync); map.on('resize', resize);
  const previousAuthFailure = globalThis.window?.gm_authFailure;
  const authFailure = () => { if (active?.provider === 'google') onError('Google Maps authorization failed. Check API activation and browser-key restrictions.'); };
  if (globalThis.window) globalThis.window.gm_authFailure = authFailure;
  return {
    async prepare({sdk: provider, apiKey, mapType}) {
      if (!records.has(provider)) {
        if (!preparing.has(provider)) preparing.set(provider, (async () => {
          const sdk = await load(provider, apiKey);
          const host = workspace.ownerDocument.createElement('div');
          host.className = `native-basemap native-${provider}`;
          host.style.visibility = 'hidden'; workspace.prepend(host);
          try {
            const renderer = render(provider, sdk, host, map, mapType);
            host.hidden = true; host.style.visibility = '';
            records.set(provider, {provider, host, renderer});
          } catch (error) { host.remove(); throw error; }
        })().finally(() => preparing.delete(provider)));
        await preparing.get(provider);
      }
      return {record: records.get(provider), mapType};
    },
    activate(prepared = null) {
      active = prepared?.record ?? null;
      for (const record of records.values()) record.host.hidden = record !== active;
      if (Boolean(active) !== locked) {
        locked = Boolean(active);
        if (locked) map.jumpTo({bearing: 0, pitch: 0});
        map.setMaxPitch(locked ? 0 : maxPitch);
        map.dragRotate[locked ? 'disable' : 'enable']();
        map.touchPitch[locked ? 'disable' : 'enable']();
        map.touchZoomRotate[locked ? 'disableRotation' : 'enableRotation']();
      }
      if (active) { active.renderer.setType(prepared.mapType); resize(); }
    },
    destroy() {
      this.activate(null);
      map.off('move', sync); map.off('resize', resize);
      for (const {renderer, host} of records.values()) { renderer.destroy(); host.remove(); }
      records.clear(); active = null;
      if (globalThis.window?.gm_authFailure === authFailure) globalThis.window.gm_authFailure = previousAuthFailure;
    },
  };
}
