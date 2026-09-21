import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { focusEnabledLayer } from './layerFocus.js';
import {
  rememberOperatorLocation,
  clearCachedOperatorLocation,
} from '../data/operatorLocation.js';

function mockViewer() {
  const flights = [];
  return {
    flights,
    camera: {
      flyTo(options) {
        flights.push({ type: 'flyTo', options });
      },
      flyToBoundingSphere(sphere, options) {
        flights.push({ type: 'sphere', sphere, options });
      },
      positionCartographic: Cesium.Cartographic.fromDegrees(-115.15, 36.08, 80_000),
    },
    trackedEntity: undefined,
  };
}

test('ALPR enable waits for cameras then focuses operator lat/lon', async () => {
  clearCachedOperatorLocation();
  rememberOperatorLocation({
    lat: 30.27,
    lon: -97.74,
    source: 'geolocation',
  });
  const viewer = mockViewer();
  let updates = 0;
  const focused = [];
  const module = {
    records: [],
    focusNearest(options) {
      focused.push(options);
      return true;
    },
    async update() {
      updates += 1;
      this.records = [{ id: 'alpr:1', lat: 30.2672, lon: -97.7431 }];
    },
    getDetectableObjects() {
      return this.records;
    },
  };
  try {
    const result = await focusEnabledLayer({
      viewer,
      layerId: 'alpr-cameras',
      module,
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'alpr');
    assert.ok(updates >= 1);
    assert.equal(focused.length, 1);
    assert.equal(focused[0].lat, 30.27);
    assert.equal(focused[0].lon, -97.74);
  } finally {
    clearCachedOperatorLocation();
  }
});

test('flights enable waits for contacts before flying to the nearest', async () => {
  clearCachedOperatorLocation();
  rememberOperatorLocation({
    lat: 36.084,
    lon: -115.154,
    source: 'geolocation',
  });
  const viewer = mockViewer();
  let calls = 0;
  const module = {
    getDetectableObjects() {
      return [];
    },
    getAllPositions() {
      calls += 1;
      return calls < 3
        ? []
        : [{ id: 'N123', latitude: 36.09, longitude: -115.15 }];
    },
  };
  try {
    const result = await focusEnabledLayer({
      viewer,
      layerId: 'flights',
      module,
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'object');
    assert.equal(result.id, 'N123');
    assert.ok(calls >= 3);
    assert.ok(viewer.flights.length >= 1);
  } finally {
    clearCachedOperatorLocation();
  }
});

test('Military Flights click flies to Nellis and does not chase a jet', async () => {
  clearCachedOperatorLocation();
  const viewer = mockViewer();
  const tracked = [];
  const result = await focusEnabledLayer({
    viewer,
    layerId: 'military',
    module: {
      async update() {},
      getDetectableObjects: () => [{ id: 'R123', position: {} }],
      getAllPositions: () => [{ id: 'R123', latitude: 36.24, longitude: -115.03 }],
      trackById(id) {
        tracked.push(id);
        return true;
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'venue');
  assert.equal(tracked.length, 0, 'panel click must not latch tracking / cockpit');
  const first = viewer.flights[0];
  assert.equal(first.type, 'flyTo');
  const carto = Cesium.Cartographic.fromCartesian(first.options.destination);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  assert.ok(Math.abs(lat - 36.236) < 0.05, `expected Nellis lat, got ${lat}`);
  assert.ok(Math.abs(lon + 115.034) < 0.05, `expected Nellis lon, got ${lon}`);
  clearCachedOperatorLocation();
});

test('Satellites click flies to orbit even when CelesTrak is empty', async () => {
  clearCachedOperatorLocation();
  const viewer = mockViewer();
  const result = await focusEnabledLayer({
    viewer,
    layerId: 'satellites',
    module: {
      findByQuery: () => null,
      trackById: () => false,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'venue');
  assert.ok(viewer.flights.length >= 1);
  const carto = Cesium.Cartographic.fromCartesian(
    viewer.flights[0].options.destination,
  );
  assert.ok(carto.height > 1_000_000, `expected orbit height, got ${carto.height}`);
  clearCachedOperatorLocation();
});

test('Live Vessels click flies to Long Beach before AIS rows arrive', async () => {
  clearCachedOperatorLocation();
  rememberOperatorLocation({
    lat: 36.17,
    lon: -115.14,
    source: 'geolocation',
  });
  const viewer = mockViewer();
  const result = await focusEnabledLayer({
    viewer,
    layerId: 'ais-live-vessels',
    module: {
      async update() {},
      getDetectableObjects: () => [],
      getAllPositions: () => [],
      focusNearest: () => null,
      getSelectedInfo: () => null,
    },
  });
  assert.equal(result.ok, true);
  assert.ok(viewer.flights.length >= 1, 'the click must move the camera');
  const first = viewer.flights[0];
  assert.equal(first.type, 'flyTo');
  const cartesian = first.options.destination;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  assert.ok(Math.abs(lat - 33.754) < 0.05, `expected Long Beach lat, got ${lat}`);
  assert.ok(Math.abs(lon + 118.216) < 0.05, `expected Long Beach lon, got ${lon}`);
  clearCachedOperatorLocation();
});

test('Live Vessels click then flies to a ship once AIS rows arrive', async () => {
  clearCachedOperatorLocation();
  const viewer = mockViewer();
  let positions = [];
  let selected = null;
  const started = Date.now();
  const result = await focusEnabledLayer({
    viewer,
    layerId: 'ais-live-vessels',
    module: {
      async update() {},
      getDetectableObjects: () => [],
      getAllPositions: () => positions,
      focusNearest() {
        selected = {
          mmsi: '366999999',
          latitude: 33.751,
          longitude: -118.22,
        };
        return selected.mmsi;
      },
      getSelectedInfo: () => selected,
    },
  });
  assert.ok(
    Date.now() - started < 400,
    'the click must return before AIS rows arrive',
  );
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'venue');
  positions = [{ id: '366999999', latitude: 33.751, longitude: -118.22 }];
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(selected?.mmsi, 'a live ship must be selected once rows arrive');
  const last = viewer.flights.at(-1);
  assert.equal(last.type, 'flyTo');
  const carto = Cesium.Cartographic.fromCartesian(last.options.destination);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  assert.ok(Math.abs(lat - 33.751) < 0.05, `expected ship lat, got ${lat}`);
  assert.ok(Math.abs(lon + 118.22) < 0.05, `expected ship lon, got ${lon}`);
  assert.ok(carto.height < 12_000, `expected ship height, got ${carto.height}`);
  clearCachedOperatorLocation();
});
