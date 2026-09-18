import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layerFocusHeightM,
  layerFocusPitchDeg,
  planEnabledLayerFocus,
  pickImmediateOperatorFocus,
  shouldFocusUserEnabledLayer,
  shouldSnapOperatorBeforeEnable,
  collectLayerFocusObjects,
  isNearbyOperatorFocus,
  layerVenueFallback,
  layerLiveDestination,
  pickLayerFocusAnchor,
  pickVesselFocusAnchor,
  waitForLayerFocusObjects,
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
      nearestCameraDistKm: 1.2,
    }),
    { mode: 'cctv', id: 'cam-austin' },
  );
  const vegasCctv = planEnabledLayerFocus({
    layerId: 'cctv',
    location: { lat: 36.1699, lon: -115.1398, source: 'geolocation' },
    nearestCameraId: 'cam-sf',
    nearestCameraDistKm: 670,
  });
  assert.equal(vegasCctv.mode, 'venue');
  assert.equal(vegasCctv.lat, 51.5055);
  assert.equal(vegasCctv.lon, -0.0754);
  assert.equal(vegasCctv.label, 'London');
  assert.equal(isNearbyOperatorFocus(670), false);
  assert.equal(isNearbyOperatorFocus(8), true);
  assert.deepEqual(
    planEnabledLayerFocus({
      layerId: 'flights',
      location,
      nearestObject: { id: 'N123', position: {} },
    }),
    { mode: 'object', id: 'N123', heightM: 80_000 },
  );
  const bikes = planEnabledLayerFocus({ layerId: 'bikeshare', location });
  assert.equal(bikes.mode, 'operator');
  assert.equal(bikes.lat, location.lat);
  assert.equal(bikes.lon, location.lon);
  assert.equal(bikes.heightM, 4_000);
  const vessels = planEnabledLayerFocus({
    layerId: 'ais-live-vessels',
    location,
  });
  assert.equal(vessels.mode, 'venue');
  assert.equal(vessels.lat, 33.754);
  assert.equal(vessels.lon, -118.216);
  assert.equal(layerVenueFallback('satellites').heightM, 8_000_000);
  assert.equal(shouldSnapOperatorBeforeEnable('traffic'), true);
  assert.equal(shouldSnapOperatorBeforeEnable('ais-live-vessels'), true);
  assert.equal(shouldSnapOperatorBeforeEnable('satellites'), true);
  const vegasAnchor = pickVesselFocusAnchor({ lat: 36.1699, lon: -115.1398 });
  assert.equal(vegasAnchor.lat, 33.754);
  assert.equal(vegasAnchor.lon, -118.216);
  const coastal = { lat: 33.75, lon: -118.22 };
  assert.equal(pickVesselFocusAnchor(coastal).lat, coastal.lat);
  const featuredCctv = planEnabledLayerFocus({ layerId: 'cctv' });
  assert.equal(featuredCctv.mode, 'venue');
  assert.equal(featuredCctv.label, 'London');
});

test('Vegas GPS does not own CCTV or vessels; local layers stay over the operator', () => {
  const vegas = { lat: 36.1699, lon: -115.1398, source: 'geolocation' };
  const cctv = pickLayerFocusAnchor({
    layerId: 'cctv',
    location: vegas,
    nearestCameraDistKm: 670,
  });
  assert.equal(cctv.label, 'London');
  assert.equal(cctv.lat, 51.5055);
  const vessels = pickLayerFocusAnchor({
    layerId: 'ais-live-vessels',
    location: vegas,
  });
  assert.equal(vessels.lat, 33.754);
  const flights = pickLayerFocusAnchor({ layerId: 'flights', location: vegas });
  assert.equal(flights.mode, 'operator');
  assert.equal(flights.lat, vegas.lat);
  const noGpsFlights = pickLayerFocusAnchor({ layerId: 'flights' });
  assert.equal(noGpsFlights.label, 'Las Vegas');
  assert.equal(layerLiveDestination('traffic').label, 'Austin');
  assert.equal(layerLiveDestination('rocket-launches').label, 'Kennedy');
});

test('waitForLayerFocusObjects returns once data appears', async () => {
  let calls = 0;
  const objects = await waitForLayerFocusObjects({
    timeoutMs: 400,
    intervalMs: 20,
    collect() {
      calls += 1;
      return calls < 3 ? [] : [{ id: 'GULF STAR', lat: 29.3, lon: -94.8 }];
    },
  });
  assert.equal(objects[0].id, 'GULF STAR');
  assert.ok(calls >= 3);
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
  assert.equal(
    pickImmediateOperatorFocus({
      camera: { lat: 30.2672, lon: -97.7431, source: 'viewer' },
      cameraHeightM: 800,
    }),
    null,
    'Austin boot spawn is not the operator',
  );
  assert.deepEqual(
    pickImmediateOperatorFocus({
      camera: { lat: 36.1699, lon: -115.1398, source: 'viewer' },
      cameraHeightM: 600,
    }),
    { lat: 36.1699, lon: -115.1398, source: 'viewer' },
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
