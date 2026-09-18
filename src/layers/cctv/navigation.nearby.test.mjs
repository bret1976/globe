import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createNavigation } from './navigation.js';
import { MAX_CCTV_NEAREST_KM } from '../../app/layerFocusPlan.js';

function navigationAt(lat, lon, records) {
  return createNavigation({
    state: {
      _records: records,
      _viewer: {
        camera: {
          positionCartographic: Cesium.Cartographic.fromDegrees(lon, lat, 2500),
        },
      },
    },
    services: {},
    parts: {
      model: {
        haversineKm(lat1, lon1, lat2, lon2) {
          const toRad = (deg) => (deg * Math.PI) / 180;
          const dLat = toRad(lat2 - lat1);
          const dLon = toRad(lon2 - lon1);
          const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) *
              Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;
          return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        },
      },
    },
    source: {},
  });
}

const catalog = [
  {
    camera: { id: 'sf', lat: 37.7952, lon: -122.4028 },
  },
  {
    camera: { id: 'austin', lat: 30.2747, lon: -97.7403 },
  },
];

test('CCTV enable only auto-selects a camera in the current metro', () => {
  const vegas = navigationAt(36.1699, -115.1398, catalog);
  assert.equal(vegas.nearestCameraToLatLon(36.1699, -115.1398).id, 'sf');
  assert.ok(vegas.nearestCameraToLatLon(36.1699, -115.1398).distKm > 600);
  assert.equal(
    vegas.nearestNearbyCameraIdToViewer(MAX_CCTV_NEAREST_KM),
    null,
  );

  const austin = navigationAt(30.2747, -97.7403, catalog);
  assert.equal(
    austin.nearestNearbyCameraIdToViewer(MAX_CCTV_NEAREST_KM),
    'austin',
  );
});
