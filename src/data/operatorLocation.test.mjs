import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearCachedOperatorLocation,
  haversineKm,
  isFiniteLatLon,
  nearestByHaversine,
  peekOperatorLocation,
  readCachedOperatorLocation,
  rememberOperatorLocation,
  resolveOperatorLocation,
  resolveOperatorLocationFast,
  viewerCameraLatLon,
  OPERATOR_STORAGE_KEY,
} from './operatorLocation.js';

test('haversine and nearest pick the closest catalog item', () => {
  assert.ok(isFiniteLatLon(30.27, -97.74));
  assert.equal(isFiniteLatLon(91, 0), false);
  const austinToHouston = haversineKm(30.2672, -97.7431, 29.7604, -95.3698);
  assert.ok(austinToHouston > 220 && austinToHouston < 260);
  const cameras = [
    { id: 'sf', lat: 37.7952, lon: -122.4028 },
    { id: 'austin', lat: 30.2747, lon: -97.7403 },
    { id: 'london', lat: 51.5055, lon: -0.0754 },
  ];
  const nearest = nearestByHaversine(
    cameras,
    30.2672,
    -97.7431,
    (camera) => camera,
  );
  assert.equal(nearest.item.id, 'austin');
  assert.ok(nearest.distKm < 5);
});

test('viewer fallback reads cartographic radians through the supplied converter', () => {
  const toDegrees = (radians) => (radians * 180) / Math.PI;
  const location = viewerCameraLatLon(
    {
      camera: {
        positionCartographic: {
          latitude: (30.2672 * Math.PI) / 180,
          longitude: (-97.7431 * Math.PI) / 180,
        },
      },
    },
    toDegrees,
  );
  assert.equal(location.source, 'viewer');
  assert.ok(Math.abs(location.lat - 30.2672) < 1e-6);
  assert.ok(Math.abs(location.lon + 97.7431) < 1e-6);
});

test('resolveOperatorLocation prefers GPS, then cache, then viewer fallback', async () => {
  clearCachedOperatorLocation();
  const geo = {
    getCurrentPosition(success) {
      success({
        coords: { latitude: 40.758, longitude: -73.9855, accuracy: 12 },
      });
    },
  };
  const fromGeo = await resolveOperatorLocation({
    geolocation: geo,
    fallback: { lat: 30.2672, lon: -97.7431, source: 'viewer' },
  });
  assert.deepEqual(
    { lat: fromGeo.lat, lon: fromGeo.lon, source: fromGeo.source },
    { lat: 40.758, lon: -73.9855, source: 'geolocation' },
  );

  const denied = {
    getCurrentPosition(_success, error) {
      error(new Error('denied'));
    },
  };
  const fromCache = await resolveOperatorLocation({
    geolocation: denied,
    fallback: { lat: 0, lon: 0, source: 'viewer' },
  });
  assert.equal(fromCache.lat, 40.758);
  assert.equal(fromCache.source, 'geolocation');

  clearCachedOperatorLocation();
  const fromViewer = await resolveOperatorLocation({
    geolocation: denied,
    fallback: { lat: 30.2672, lon: -97.7431, source: 'viewer' },
  });
  assert.equal(fromViewer.source, 'viewer');
  assert.equal(fromViewer.lat, 30.2672);
});

test('operator cache expires and remember is a no-op for invalid coords', () => {
  clearCachedOperatorLocation();
  assert.equal(rememberOperatorLocation({ lat: 99, lon: 0 }), null);
  rememberOperatorLocation(
    { lat: 51.5, lon: -0.1, source: 'geolocation' },
    () => 1_000,
  );
  assert.equal(readCachedOperatorLocation(60_000, () => 10_000).lat, 51.5);
  assert.equal(
    readCachedOperatorLocation(60_000, () => 100_000),
    null,
  );
});

test('operator GPS persists to localStorage', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  clearCachedOperatorLocation();
  rememberOperatorLocation(
    { lat: 36.1699, lon: -115.1398, source: 'geolocation' },
    () => 5_000,
  );
  const persisted = JSON.parse(store.get(OPERATOR_STORAGE_KEY));
  assert.equal(persisted.lat, 36.1699);
  assert.equal(persisted.lon, -115.1398);
  clearCachedOperatorLocation();
  assert.equal(store.has(OPERATOR_STORAGE_KEY), false);
  delete globalThis.localStorage;
});

test('fast operator resolve uses cache and does not wait on GPS', async () => {
  clearCachedOperatorLocation();
  rememberOperatorLocation(
    { lat: 36.1699, lon: -115.1398, source: 'geolocation' },
    () => Date.now(),
  );
  let geoCalls = 0;
  const hanging = {
    getCurrentPosition() {
      geoCalls += 1;
    },
  };
  const started = Date.now();
  const fast = await resolveOperatorLocationFast({
    geolocation: hanging,
    fallback: { lat: 37.7952, lon: -122.4028, source: 'viewer' },
    timeoutMs: 40,
    waitMs: 5_000,
  });
  assert.ok(Date.now() - started < 200);
  assert.equal(fast.lat, 36.1699);
  assert.equal(fast.source, 'geolocation');
  assert.deepEqual(peekOperatorLocation({ lat: 0, lon: 0 }), {
    lat: 36.1699,
    lon: -115.1398,
    source: 'geolocation',
    accuracyM: null,
    cachedAt: fast.cachedAt,
  });
  clearCachedOperatorLocation();
  const peeked = peekOperatorLocation({
    lat: 36.1699,
    lon: -115.1398,
    source: 'viewer',
  });
  assert.equal(peeked.source, 'viewer');
  const raced = await resolveOperatorLocationFast({
    geolocation: hanging,
    fallback: { lat: 36.1699, lon: -115.1398, source: 'viewer' },
    timeoutMs: 40,
    waitMs: 20,
  });
  assert.equal(raced.source, 'viewer');
  assert.ok(geoCalls >= 1);
  clearCachedOperatorLocation();
});
