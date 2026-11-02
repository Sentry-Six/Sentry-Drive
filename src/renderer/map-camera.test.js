import test from 'node:test';
import assert from 'node:assert/strict';
import mapCamera from './map-camera.cjs';

const {
  DEFAULT_CAMERA,
  STORAGE_KEY,
  fitMap,
  fitMode,
  glideTo,
  loadCamera,
  parseCamera,
  rememberCamera,
  serializeCamera,
  settleZooms,
} = mapCamera;

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
  };
}

function fakeMap({ lng = 0, lat = 0, zoom = 0, maxZoom = 20, camera = null } = {}) {
  const handlers = {};
  const calls = [];
  return {
    calls,
    handlers,
    camera: { lng, lat, zoom },
    on(type, fn) { (handlers[type] ??= []).push(fn); },
    emit(type) { for (const fn of handlers[type] ?? []) fn(); },
    getCenter() { return { lng: this.camera.lng, lat: this.camera.lat }; },
    getZoom() { return this.camera.zoom; },
    getMaxZoom() { return maxZoom; },
    cameraForBounds(bounds, options) { calls.push(['cameraForBounds', bounds, options]); return camera; },
    fitBounds(bounds, options) { calls.push(['fitBounds', bounds, options]); },
    jumpTo(options) { calls.push(['jumpTo', options]); },
    easeTo(options) { calls.push(['easeTo', options]); },
  };
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('startup and reload fits jump; user-driven fits settle', () => {
  assert.equal(fitMode('initial'), 'jump');
  assert.equal(fitMode('reload'), 'jump');
  for (const reason of ['select', 'back', 'zone', 'charging']) assert.equal(fitMode(reason), 'settle', reason);
});

test('an unknown fit reason is a programming error', () => {
  assert.throws(() => fitMode(undefined), /Unknown map fit reason/);
  assert.throws(() => fitMode('fly'), /Unknown map fit reason/);
  assert.throws(() => fitMap(fakeMap(), [[0, 0], [1, 1]], { padding: 30 }), /Unknown map fit reason/);
});

test('jump fits call fitBounds without animation, keeping padding and maxZoom', () => {
  const map = fakeMap();
  const bounds = [[-98, 30], [-97, 31]];
  fitMap(map, bounds, { padding: 30, reason: 'initial' });
  fitMap(map, bounds, { padding: 50, maxZoom: 13, reason: 'reload' });
  assert.deepEqual(map.calls, [
    ['fitBounds', bounds, { padding: 30, animate: false }],
    ['fitBounds', bounds, { padding: 50, maxZoom: 13, animate: false }],
  ]);
});

test('settle fits never fly: they jump in close and ease out on one tile level', () => {
  const center = { lng: -97.8, lat: 30.1 };
  const map = fakeMap({ camera: { center, zoom: 12.4 } });
  const bounds = [[-98, 30], [-97, 31]];
  fitMap(map, bounds, { padding: 50, maxZoom: 13, reason: 'select' });
  assert.deepEqual(map.calls[0], ['cameraForBounds', bounds, { padding: 50, maxZoom: 13 }]);
  const [, jump] = map.calls[1];
  const [, ease] = map.calls[2];
  assert.equal(map.calls.length, 3);
  assert.equal(map.calls[1][0], 'jumpTo');
  assert.equal(map.calls[2][0], 'easeTo');
  assert.equal(jump.center, center);
  assert.equal(ease.center, center);
  near(jump.zoom, 12.7);
  near(ease.zoom, 12.4);
  assert.equal(ease.duration, 300);
  assert.equal('linear' in ease, false);
  assert.equal(map.calls.some(([name]) => name === 'fitBounds' || name === 'flyTo'), false);
});

test('a settle fit does nothing when the bounds cannot be fitted', () => {
  const map = fakeMap({ camera: undefined });
  fitMap(map, [[0, 0], [0, 0]], { reason: 'zone' });
  assert.deepEqual(map.calls.map(([name]) => name), ['cameraForBounds']);
});

test('settle zooms stay on the destination tile level', () => {
  for (let step = 0; step < 2000; step++) {
    const z = step / 100;
    const zooms = settleZooms(z);
    assert.ok(zooms, `no settle at ${z}`);
    assert.equal(Math.floor(zooms.start), Math.floor(z), `start level at ${z}`);
    assert.equal(Math.floor(zooms.end), Math.floor(z), `end level at ${z}`);
    assert.ok(zooms.start > zooms.end, `direction at ${z}`);
    assert.ok(zooms.start - zooms.end >= 0.15 - 1e-9, `amplitude at ${z}`);
    assert.ok(zooms.start - zooms.end <= 0.3 + 1e-9, `amplitude at ${z}`);
    assert.ok(zooms.end <= z + 1e-9 && zooms.end >= z - 0.16 - 1e-9, `end near target at ${z}`);
  }
});

test('settle zooms: full settle low in a level, shorter near the top', () => {
  const low = settleZooms(13.2);
  near(low.start, 13.5);
  near(low.end, 13.2);
  const high = settleZooms(13.8);
  near(high.start, 13.99);
  near(high.end, 13.8);
  const top = settleZooms(13.95);
  near(top.start, 13.99);
  near(top.end, 13.84);
});

test('settle zooms respect the map max zoom', () => {
  const capped = settleZooms(19.9, 20);
  near(capped.start, 19.99);
  assert.equal(settleZooms(20, 20), null);
  const map = fakeMap({ maxZoom: 20 });
  glideTo(map, [1, 2], 20);
  assert.deepEqual(map.calls, [['jumpTo', { center: [1, 2], zoom: 20 }]]);
});

test('glideTo settles onto a point', () => {
  const map = fakeMap();
  glideTo(map, [-97.7, 30.3], 12);
  assert.equal(map.calls.length, 2);
  assert.deepEqual(map.calls[0][1].center, [-97.7, 30.3]);
  near(map.calls[0][1].zoom, 12.3);
  assert.deepEqual(map.calls[1], ['easeTo', { center: [-97.7, 30.3], zoom: 12, duration: 300 }]);
});

test('first run starts on the default camera', () => {
  const camera = loadCamera(memoryStorage());
  assert.deepEqual(camera, { center: [10, 50], zoom: 4 });
  assert.notEqual(camera.center, DEFAULT_CAMERA.center);
});

test('a saved camera is restored', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ center: [-97.74, 30.27], zoom: 9.5 }) });
  assert.deepEqual(loadCamera(storage), { center: [-97.74, 30.27], zoom: 9.5 });
});

test('invalid or unreadable saved cameras fall back to the default', () => {
  for (const raw of ['', 'not json', 'null', '{}', '{"center":[1],"zoom":3}',
    '{"center":[1,2]}', '{"center":["1",2],"zoom":3}', '{"center":[1,95],"zoom":3}',
    '{"center":[1,2],"zoom":-1}', '{"center":[1,2],"zoom":99}']) {
    assert.equal(parseCamera(raw), null, raw);
    assert.deepEqual(loadCamera(memoryStorage({ [STORAGE_KEY]: raw })), { center: [10, 50], zoom: 4 }, raw);
  }
  const throwing = { getItem() { throw new Error('denied'); } };
  assert.deepEqual(loadCamera(throwing), { center: [10, 50], zoom: 4 });
  assert.deepEqual(loadCamera(null), { center: [10, 50], zoom: 4 });
});

test('longitudes past the antimeridian are wrapped', () => {
  assert.deepEqual(parseCamera('{"center":[190,10],"zoom":3}'), { center: [-170, 10], zoom: 3 });
  const map = fakeMap({ lng: -200.1234567, lat: 45.1234567, zoom: 7.4567 });
  assert.deepEqual(JSON.parse(serializeCamera(map)), { center: [159.876543, 45.123457], zoom: 7.46 });
});

test('the camera is saved once, after moves settle', () => {
  const storage = memoryStorage();
  const timers = [];
  const map = fakeMap({ lng: -97.7, lat: 30.3, zoom: 10 });
  rememberCamera(map, storage, {
    setTimer: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimer: (i) => { timers[i].cleared = true; },
  });
  map.emit('moveend');
  map.camera.zoom = 11;
  map.emit('moveend');
  assert.equal(timers.length, 2);
  assert.equal(timers[0].cleared, true);
  assert.equal(timers[1].ms, 500);
  assert.equal(storage.data[STORAGE_KEY], undefined);
  timers[1].fn();
  assert.deepEqual(JSON.parse(storage.data[STORAGE_KEY]), { center: [-97.7, 30.3], zoom: 11 });
  assert.deepEqual(loadCamera(storage), { center: [-97.7, 30.3], zoom: 11 });
});

test('flush saves a pending camera immediately and is a no-op otherwise', () => {
  const storage = memoryStorage();
  const map = fakeMap({ lng: 2, lat: 3, zoom: 4 });
  let cleared = 0;
  const remembered = rememberCamera(map, storage, { setTimer: () => 1, clearTimer: () => { cleared++; } });
  remembered.flush();
  assert.equal(storage.data[STORAGE_KEY], undefined);
  map.emit('moveend');
  remembered.flush();
  assert.equal(cleared, 1);
  assert.deepEqual(JSON.parse(storage.data[STORAGE_KEY]), { center: [2, 3], zoom: 4 });
  remembered.flush();
  assert.equal(cleared, 1);
});

test('a storage write failure does not throw', () => {
  const storage = { getItem: () => null, setItem() { throw new Error('quota'); } };
  const map = fakeMap();
  let pending = null;
  rememberCamera(map, storage, { setTimer: (fn) => { pending = fn; return 1; }, clearTimer() {} });
  map.emit('moveend');
  assert.doesNotThrow(() => pending());
});
