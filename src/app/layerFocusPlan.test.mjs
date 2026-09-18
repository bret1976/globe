import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layerFocusHeightM,
  planEnabledLayerFocus,
  pickImmediateOperatorFocus,
  shouldFocusUserEnabledLayer,
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
