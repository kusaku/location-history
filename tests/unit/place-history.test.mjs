import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlaceHistory} from '../../assets/js/place-history.mjs';
const area = {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]}};
class Element {
  hidden = false; disabled = false; textContent = ''; style = {}; children = []; dataset = {}; attributes = {};
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() { this.focused = true; }
  addEventListener(key, callback) { this[key] = callback; }
}
function fixture() {
  const original = globalThis.document, elements = new Map(), sources = new Map(), handlers = new Map(), sent = [], statuses = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  globalThis.document = {getElementById: get, createElement: () => new Element(), addEventListener: (name, fn) => handlers.set(`document:${name}`, fn)};
  get('place-scope').children = ['window', 'all'].map(scope => { const button = new Element(); button.dataset.scope = scope; return button; });
  const canvas = new Element(); let zoom = true;
  const map = {
    getSource: key => sources.get(key),
    addSource(key) { sources.set(key, {setData(value) { this.data = value; }}); }, addLayer() {},
    getCanvas: () => canvas, doubleClickZoom: {isEnabled: () => zoom, enable: () => { zoom = true; }, disable: () => { zoom = false; }},
    on: (name, fn) => handlers.set(name, fn), project: coordinates => ({x: coordinates[0] * 100, y: coordinates[1] * 100}), getCenter: () => ({lng: 1, lat: 1})
  };
  const options = {start: 0, end: 1000, hourStart: 0, hourEnd: 24, accuracy: 0, exclude: 4};
  const controller = createPlaceHistory({map, report: () => ({min: 0, max: 100000}), options: () => options, send: message => sent.push(message), status: (...args) => statuses.push(args), selectDates() {}});
  controller.install();
  return {controller, sent, get, options, canvas, handlers, sources, zoom: () => zoom, statuses, cleanup: () => { globalThis.document = original; }};
}
test('place requests ignore viewport changes, coalesce filter changes and discard stale selection results', () => {
  const f = fixture();
  try {
    f.controller.select(area, 'Drawn area');
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].options.exclude, 4);
    f.options.viewport = [0, 0, 10, 10]; f.controller.refresh(); assert.equal(f.sent.length, 1);
    f.options.end = 2000; f.controller.refresh(); assert.equal(f.sent.length, 1);
    f.controller.receive({type: 'place', id: f.sent[0].id, result: {count: 99}});
    assert.equal(f.sent.length, 2); assert.equal(f.sent[1].options.end, 2000);
    f.controller.clear();
    f.controller.receive({type: 'place', id: f.sent[1].id, result: {count: 99}});
    assert.equal(f.get('place-history').hidden, true);
    assert.equal(f.sources.get('place-selection').data.features.length, 0);
  } finally { f.cleanup(); }
});
test('drawing supports finish, undo, keyboard input and restoration of map interactions', () => {
  const f = fixture();
  const click = (lng, lat) => ({lngLat: {lng, lat}, point: {x: lng * 100, y: lat * 100}});
  try {
    f.get('draw-area').onclick(); assert.equal(f.zoom(), false); assert.equal(f.canvas.focused, true);
    assert.equal(f.controller.handleClick(click(0, 0)), true);
    f.controller.handleClick(click(2, 0));
    f.canvas.keydown({key: ' ', preventDefault() {}});
    assert.equal(f.get('place-finish').disabled, false);
    f.get('place-undo').onclick(); assert.equal(f.get('place-finish').disabled, true);
    f.controller.handleClick(click(1, 1));
    f.get('place-finish').onclick();
    assert.equal(f.controller.drawing, false); assert.equal(f.zoom(), true); assert.equal(f.sent.length, 1);
    assert.equal(f.sources.get('place-selection').data.features[0].geometry.type, 'Polygon');
    f.get('draw-area').onclick(); f.handlers.get('document:keydown')({key: 'Escape', preventDefault() {}});
    assert.equal(f.zoom(), true); assert.equal(f.get('place-history').hidden, true);
  } finally { f.cleanup(); }
});
test('drawing rejects crossing edges and clears pending state across dataset changes', () => {
  const f = fixture();
  try {
    f.get('draw-area').onclick();
    for (const [lng, lat] of [[0, 0], [2, 2], [0, 2], [2, 0]]) f.controller.handleClick({lngLat: {lng, lat}, point: {x: lng * 100, y: lat * 100}});
    f.get('place-finish').onclick();
    assert.equal(f.sent.length, 0); assert.equal(f.controller.drawing, true); assert.match(f.statuses[0][0], /edges cross/);
    f.controller.clear(); assert.equal(f.controller.drawing, false); assert.equal(f.zoom(), true);
  } finally { f.cleanup(); }
});
