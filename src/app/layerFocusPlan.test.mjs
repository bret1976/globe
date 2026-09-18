import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layerFocusHeightM,
  planEnabledLayerFocus,
  shouldFocusUserEnabledLayer,
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
