import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layerFocusHeightM,
  layerFocusPitchDeg,
  planEnabledLayerFocus,
  pickImmediateOperatorFocus,
  shouldFocusUserEnabledLayer,
  collectLayerFocusObjects,
  SPACE_VIEW_HEIGHT_M,
} from './layerFocusPlan.js';

test('only user Data Layer enables request operator focus', () => {
  assert.equal(
    shouldFocusUserEnabledLayer(true, { origin: 'user', focus: true }),
    true,
  );
  assert.equal(
    shouldFocusUserEnabledLayer(false, { origin: 'user', focus: true }),
    false,
  );
  assert.equal(
    shouldFocusUserEnabledLayer(true, { origin: 'user' }),
    false,
    'shorts / first-run stay on origin:user without a focus flag',
  );
  assert.equal(
    shouldFocusUserEnabledLayer(true, { origin: 'programmatic', focus: true }),
    false,
  );
});

test('layer focus plans CCTV, objects, then the operator area', () => {
  assert.ok(layerFocusHeightM('bikeshare') < 48_000);
  assert.ok(layerFocusHeightM('flights') >= 80_000);
  assert.ok(
    layerFocusHeightM('traffic') < 8_000,
    'traffic snap must sit below the 8 km activation gate',
  );
  assert.ok(
    layerFocusHeightM('traffic') > 4_500,
    'traffic snap must use the faster major-roads first pass',
  );
  assert.ok(layerFocusPitchDeg('traffic') < -42);
  assert.ok(layerFocusHeightM('military-installations') <= 12_000);
  assert.ok(layerFocusPitchDeg('military-installations') < -70);
  assert.equal(layerFocusPitchDeg('flights'), -42);
  const location = { lat: 30.27, lon: -97.74, source: 'geolocation' };
  assert.deepEqual(
    planEnabledLayerFocus({
      layerId: 'cctv',
      location,
      nearestCameraId: 'cam-austin',
    }),
    { mode: 'cctv', id: 'cam-austin' },
  );
  assert.deepEqual(
    planEnabledLayerFocus({
      layerId: 'flights',
      location,
      nearestObject: { id: 'N123', position: {} },
    }),
    { mode: 'object', id: 'N123', heightM: 80_000 },
  );
  assert.deepEqual(planEnabledLayerFocus({ layerId: 'bikeshare', location }), {
    mode: 'operator',
    heightM: 4_000,
  });
  assert.deepEqual(planEnabledLayerFocus({ layerId: 'cctv' }), {
    mode: 'skip',
  });
});

test('immediate operator focus prefers GPS cache and rejects space leftovers', () => {
  assert.ok(SPACE_VIEW_HEIGHT_M > 80_000);
  const cached = pickImmediateOperatorFocus({
    cached: { lat: 30.27, lon: -97.74, source: 'geolocation' },
    camera: { lat: 2.2, lon: -111.1, source: 'viewer' },
    cameraHeightM: 36_000_000,
  });
  assert.deepEqual(cached, {
    lat: 30.27,
    lon: -97.74,
    source: 'geolocation',
  });
  assert.equal(
    pickImmediateOperatorFocus({
      camera: { lat: 2.2, lon: -111.1, source: 'viewer' },
      cameraHeightM: 36_000_000,
    }),
    null,
  );
  assert.deepEqual(
    pickImmediateOperatorFocus({
      camera: { lat: 30.27, lon: -97.74, source: 'viewer' },
      cameraHeightM: 600,
    }),
    { lat: 30.27, lon: -97.74, source: 'viewer' },
  );
});

test('focus objects prefer a full position list over culled detectables', () => {
  const detectable = [{ id: 'KARIMATA', position: {} }];
  const positions = [
    { id: 'KARIMATA', latitude: 1.1, longitude: 104.0 },
    { id: 'GULF STAR', latitude: 29.3, longitude: -94.8 },
  ];
  const objects = collectLayerFocusObjects({ detectable, positions });
  assert.equal(objects.length, 2);
  assert.equal(objects[1].id, 'GULF STAR');
  assert.equal(objects[1].lat, 29.3);
  assert.equal(objects[1].lon, -94.8);
  assert.deepEqual(
    collectLayerFocusObjects({
      detectable: [{ id: 'ONLY' }],
      positions: [],
    }),
    [{ id: 'ONLY' }],
  );
});
