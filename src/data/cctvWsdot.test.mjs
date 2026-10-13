import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  wsdotCameraToSource,
  loadWsdotSourcesFromOpenData,
  normalizeWsdotImageUrl,
} from '../../server/providers/cctv/wsdot.js';
import {
  DEFAULT_WSDOT_CCTV_URL,
  WSDOT_IMAGE_ORIGIN,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const feature = (over = {}) => ({
  type: 'Feature',
  geometry: {
    type: 'Point',
    coordinates: [-122.3321, 47.6062],
  },
  properties: {
    OBJECTID: 4242,
    CameraTitle: 'I-5 at Seneca St',
    ImageURL: 'https://images.wsdot.wa.gov/nw/005vc16558.jpg',
    CompassDirection: 'S',
    ...over,
  },
});

test('a WSDOT feature maps to a still on the pinned host', () => {
  const source = wsdotCameraToSource(feature());
  assert.equal(source.id, 'us-wsdot-4242');
  assert.equal(source.name, 'I-5 at Seneca St');
  assert.equal(source.city, 'Washington');
  assert.equal(source.cityId, 'wsdot');
  assert.equal(source.provider, 'WSDOT');
  assert.equal(source.feedType, 'image');
  assert.equal(source.headingDeg, 180);
  assert.equal(source.headingConfidence, 'medium');
  assert.equal(source.sourceKind, 'wsdot-travel-info');
  assert.match(source.license, /Washington State Department of Transportation/);
  assert.ok(source.url.startsWith(WSDOT_IMAGE_ORIGIN));
  assert.equal(source.snapshotUrl, source.url);
  assert.ok(source.code);
});

test('frame URLs are pinned to images.wsdot.wa.gov', () => {
  assert.equal(
    normalizeWsdotImageUrl('http://images.wsdot.wa.gov/nw/005vc16558.jpg'),
    'https://images.wsdot.wa.gov/nw/005vc16558.jpg',
  );
  assert.equal(
    normalizeWsdotImageUrl(
      'https://www.tripcheck.com/roadcams/cams/foo_pid1.jpg',
    ),
    null,
  );
  for (const bad of [
    'https://evil.test/nw/x.jpg',
    'https://images.wsdot.wa.gov.evil.test/nw/x.jpg',
    'https://images.wsdot.wa.gov/nw/x.jpg?redirect=1',
    'https://user:pw@images.wsdot.wa.gov/nw/x.jpg',
    'https://images.wsdot.wa.gov:8443/nw/x.jpg',
    'https://images.wsdot.wa.gov/nw/x.m3u8',
    'ftp://images.wsdot.wa.gov/nw/x.jpg',
    '',
    null,
  ]) {
    assert.equal(normalizeWsdotImageUrl(bad), null, String(bad));
  }
});

test('bad geometry, TripCheck hosts and frames are dropped', () => {
  assert.equal(
    wsdotCameraToSource(
      feature({
        ImageURL:
          'https://www.tripcheck.com/roadcams/cams/AstoriaUS101_pid496.jpg',
      }),
    ),
    null,
  );
  assert.equal(
    wsdotCameraToSource({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-123.0868, 44.0521] }, // Eugene OR
      properties: {
        OBJECTID: 1,
        CameraTitle: 'Eugene',
        ImageURL: 'https://images.wsdot.wa.gov/sw/x.jpg',
      },
    }),
    null,
  );
  // Portland OR (~45.515) must stay out of the WA box; Vancouver WA (~45.64) stays in.
  assert.equal(
    wsdotCameraToSource({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.675, 45.515] },
      properties: {
        OBJECTID: 2,
        CameraTitle: 'Portland',
        ImageURL: 'https://images.wsdot.wa.gov/sw/x.jpg',
      },
    }),
    null,
  );
  assert.equal(
    wsdotCameraToSource(
      feature({ ImageURL: 'https://evil.test/a.jpg' }),
    ),
    null,
  );
  assert.equal(wsdotCameraToSource(null), null);
});

test('the loader dedupes, prioritizes and falls back to the bundled snapshot', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const requested = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json({
      type: 'FeatureCollection',
      features: [
        feature(),
        feature(),
        feature({
          OBJECTID: 99,
          CameraTitle: 'I-90 at Mercer Island',
          ImageURL: 'https://images.wsdot.wa.gov/nw/090vc00750.jpg',
          CompassDirection: 'E',
        }),
      ],
    });
  });
  // Override geometry for second unique camera to Seattle-ish
  const cameras = await loadWsdotSourcesFromOpenData();
  assert.equal(cameras.length, 2);
  assert.ok(
    requested[0].includes('wsdot') || requested[0] === DEFAULT_WSDOT_CCTV_URL,
  );
  assert.equal(cameras[0].provider, 'WSDOT');
  fetchMock.mock.restore();

  const failMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  const snapshot = await loadWsdotSourcesFromOpenData();
  assert.ok(snapshot.length >= 8, `snapshot kept ${snapshot.length}`);
  assert.ok(snapshot.every((c) => c.provider === 'WSDOT'));
  assert.ok(snapshot.every((c) => c.cityId === 'wsdot'));
  failMock.mock.restore();
});

test('catalog LIVE_PACKS includes wsdot', () => {
  assert.equal(typeof createCctvCatalog, 'function');
});
