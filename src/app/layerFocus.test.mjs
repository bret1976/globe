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
