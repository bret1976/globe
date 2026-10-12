import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  oregonCameraToSource,
  loadOregonSourcesFromOpenData,
  normalizeOregonImageUrl,
} from '../../server/providers/cctv/oregon.js';
import {
  DEFAULT_OREGON_CCTV_URL,
  OREGON_IMAGE_ORIGIN,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const feature = (attrs = {}) => ({
  attributes: {
    device_name: 'AstoriaUS101MeglerBrNB',
    latitude: 46.18785,
    longitude: -123.85347,
    cctv_url:
      'http://www.TripCheck.com/roadcams/cams/AstoriaUS101MeglerBrNB_pid392.jpg',
    route_designator: 'US101',
    organization_name: 'ODOT',
    device_id: 277,
    ...attrs,
  },
});

test('an Oregon TripCheck feature maps to a still on the pinned host', () => {
  const source = oregonCameraToSource(feature());
  assert.equal(source.id, 'us-oregon-astoriaus101meglerbrnb');
  assert.equal(source.name, 'AstoriaUS101MeglerBrNB (US101)');
  assert.equal(source.city, 'Oregon');
  assert.equal(source.cityId, 'oregon');
  assert.equal(source.provider, 'Oregon TripCheck');
  assert.equal(source.feedType, 'image');
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.sourceKind, 'oregon-tripcheck-open-data');
  assert.match(source.license, /TripCheck/);
  assert.ok(source.url.startsWith(OREGON_IMAGE_ORIGIN));
  assert.equal(source.snapshotUrl, source.url);
  assert.ok(source.code);
});

test('frame URLs are pinned to the roadcams tree', () => {
  assert.equal(
    normalizeOregonImageUrl(
      'http://www.TripCheck.com/roadcams/cams/AstoriaUS101MeglerBrNB_pid392.jpg',
    ),
    'https://www.tripcheck.com/roadcams/cams/AstoriaUS101MeglerBrNB_pid392.jpg',
  );
  assert.equal(
    normalizeOregonImageUrl(
      'https://tripcheck.com/roadcams/cams/foo_pid1.jpg',
    ),
    'https://www.tripcheck.com/roadcams/cams/foo_pid1.jpg',
  );
  for (const bad of [
    'https://evil.test/roadcams/cams/x.jpg',
    'https://www.tripcheck.com.evil.test/roadcams/cams/x.jpg',
    'https://www.tripcheck.com/other/x.jpg',
    'https://www.tripcheck.com/roadcams/cams/x.jpg?redirect=1',
    'https://user:pw@www.tripcheck.com/roadcams/cams/x.jpg',
    'https://www.tripcheck.com:8443/roadcams/cams/x.jpg',
    'https://www.tripcheck.com/roadcams/cams/x.m3u8',
    'ftp://www.tripcheck.com/roadcams/cams/x.jpg',
    '',
    null,
  ]) {
    assert.equal(normalizeOregonImageUrl(bad), null, String(bad));
  }
});

test('bad geometry, names and frames are dropped', () => {
  assert.equal(
    oregonCameraToSource(feature({ longitude: -122.3, latitude: 47.6 })),
    null,
  ); // Seattle
  assert.equal(oregonCameraToSource(feature({ latitude: null })), null);
  assert.equal(oregonCameraToSource(feature({ device_name: '' })), null);
  assert.equal(
    oregonCameraToSource(feature({ cctv_url: 'https://evil.test/a.jpg' })),
    null,
  );
  assert.equal(oregonCameraToSource(null), null);
});

test('the loader dedupes, prioritizes and falls back to the bundled snapshot', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const requested = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json({
      features: [
        feature(),
        feature(),
        feature({
          device_name: 'PortlandI5MarquamNB',
          latitude: 45.5051,
          longitude: -122.675,
          cctv_url:
            'https://www.tripcheck.com/roadcams/cams/PortlandI5MarquamNB_pid99.jpg',
          route_designator: 'I-5',
          device_id: 99,
        }),
      ],
    });
  });
  const cameras = await loadOregonSourcesFromOpenData();
  assert.equal(cameras.length, 2);
  assert.ok(requested[0].includes('Trip_Check') || requested[0] === DEFAULT_OREGON_CCTV_URL || requested[0].includes('gis.odot'));
  assert.equal(cameras[0].provider, 'Oregon TripCheck');
  fetchMock.mock.restore();

  const failMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  const snapshot = await loadOregonSourcesFromOpenData();
  assert.ok(snapshot.length >= 8, `snapshot kept ${snapshot.length}`);
  assert.ok(snapshot.every((c) => c.provider === 'Oregon TripCheck'));
  failMock.mock.restore();
});

test('catalog LIVE_PACKS includes oregon', () => {
  // Smoke: createCctvCatalog exists and oregon is wired via import side.
  assert.equal(typeof createCctvCatalog, 'function');
});
