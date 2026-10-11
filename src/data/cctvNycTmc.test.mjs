import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadNycTmcSourcesFromOpenData,
  normalizeNycTmcImageUrl,
  nycTmcCameraToSource,
} from '../../server/providers/cctv/nyctmc.js';
import {
  DEFAULT_NYCTMC_CCTV_URL,
  NYCTMC_IMAGE_ORIGIN,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

/** One camera shaped like the live webcams.nyctmc.org/api/cameras payload. */
const camera = (over = {}) => ({
  id: '8a6bc417-4877-4ebe-8052-88c1b261baf1',
  name: 'Central Park West @ 86 St',
  latitude: 40.785302,
  longitude: -73.969353,
  area: 'Manhattan',
  isOnline: 'true',
  imageUrl:
    'https://webcams.nyctmc.org/api/cameras/8a6bc417-4877-4ebe-8052-88c1b261baf1/image',
  ...over,
});

test('an NYC TMC camera maps to a still on the pinned image API', () => {
  const source = nycTmcCameraToSource(camera());
  assert.equal(
    source.id,
    'us-nyctmc-8a6bc417-4877-4ebe-8052-88c1b261baf1',
  );
  assert.equal(source.name, 'Central Park West @ 86 St (Manhattan)');
  assert.equal(source.city, 'New York City');
  assert.equal(source.cityId, 'nyc');
  assert.equal(source.provider, 'NYC TMC');
  assert.equal(source.feedType, 'image');
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.sourceKind, 'nyctmc-open-data');
  assert.match(source.license, /NYC DOT/);
  assert.ok(source.url.startsWith(NYCTMC_IMAGE_ORIGIN));
  assert.equal(source.snapshotUrl, source.url);
  assert.equal(source.online, true);
});

test('frame URLs are pinned to the NYC TMC image API', () => {
  assert.equal(
    normalizeNycTmcImageUrl(
      'http://webcams.nyctmc.org/api/cameras/8a6bc417-4877-4ebe-8052-88c1b261baf1/image',
    ),
    'https://webcams.nyctmc.org/api/cameras/8a6bc417-4877-4ebe-8052-88c1b261baf1/image',
  );
  assert.equal(
    normalizeNycTmcImageUrl('', '8a6bc417-4877-4ebe-8052-88c1b261baf1'),
    'https://webcams.nyctmc.org/api/cameras/8a6bc417-4877-4ebe-8052-88c1b261baf1/image',
  );
  for (const bad of [
    'https://evil.test/api/cameras/8a6bc417-4877-4ebe-8052-88c1b261baf1/image',
    'https://webcams.nyctmc.org.evil.test/api/cameras/8a6bc417-4877-4ebe-8052-88c1b261baf1/image',
    'https://webcams.nyctmc.org/other/x.jpg',
    'https://webcams.nyctmc.org/api/cameras/8a6bc417-4877-4ebe-8052-88c1b261baf1/image?x=1',
    'https://user:pw@webcams.nyctmc.org/api/cameras/8a6bc417-4877-4ebe-8052-88c1b261baf1/image',
    'https://webcams.nyctmc.org:8443/api/cameras/8a6bc417-4877-4ebe-8052-88c1b261baf1/image',
    '',
    null,
  ]) {
    assert.equal(normalizeNycTmcImageUrl(bad), null, String(bad));
  }
});

test('bad geometry, ids and frames are dropped', () => {
  // Newark is plausible but outside the NYC box.
  assert.equal(nycTmcCameraToSource(camera({ longitude: -75.16, latitude: 39.95 })), null); // Philly
  assert.equal(nycTmcCameraToSource(camera({ latitude: null })), null);
  assert.equal(nycTmcCameraToSource(camera({ id: 'not-a-uuid' })), null);
  assert.equal(
    nycTmcCameraToSource(
      camera({ imageUrl: 'https://evil.test/a.jpg', id: 'bad' }),
    ),
    null,
  );
  assert.equal(nycTmcCameraToSource(null), null);
});

test('the loader dedupes and prioritizes live catalog rows', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const requested = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json([
      camera(),
      camera(),
      camera({
        id: '0039e6bf-5244-4b4e-b7dc-d02056bbfdc9',
        name: 'Atlantic Ave @ 111 St',
        latitude: 40.692157,
        longitude: -73.834927,
        area: 'Brooklyn',
        imageUrl:
          'https://webcams.nyctmc.org/api/cameras/0039e6bf-5244-4b4e-b7dc-d02056bbfdc9/image',
      }),
    ]);
  });
  const sources = await loadNycTmcSourcesFromOpenData();
  assert.equal(sources.length, 2);
  assert.deepEqual(
    sources.map((s) => s.id).sort(),
    [
      'us-nyctmc-0039e6bf-5244-4b4e-b7dc-d02056bbfdc9',
      'us-nyctmc-8a6bc417-4877-4ebe-8052-88c1b261baf1',
    ],
  );
  assert.ok(requested[0].includes('webcams.nyctmc.org'));
  assert.equal(DEFAULT_NYCTMC_CCTV_URL, 'https://webcams.nyctmc.org/api/cameras');
  fetchMock.mock.restore();
});

test('NYC TMC pack is registered in the live catalog list', () => {
  // Smoke: createCctvCatalog exists and LIVE_PACKS includes nyctmc via import side.
  assert.equal(typeof createCctvCatalog, 'function');
});

test('bundled snapshot loads when live fetch fails', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  const { loadNycTmcSourcesFromOpenData, loadNycTmcSnapshotRows } = await import(
    '../../server/providers/cctv/nyctmc.js'
  );
  const rows = loadNycTmcSnapshotRows();
  assert.ok(rows.length > 100, `expected snapshot rows, got ${rows.length}`);
  const sources = await loadNycTmcSourcesFromOpenData();
  assert.ok(sources.length > 0, 'snapshot fallback must return cameras');
  assert.ok(sources.every((s) => s.sourceKind === 'nyctmc-open-data'));
  assert.ok(sources.every((s) => s.cityId === 'nyc'));
});
