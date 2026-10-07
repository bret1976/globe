import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  iowaDotCameraToSource,
  loadIowaDotSourcesFromOpenData,
  normalizeIowaDotImageUrl,
} from '../../server/providers/cctv/iowadot.js';
import {
  DEFAULT_IOWADOT_CCTV_URL,
  IOWADOT_IMAGE_ORIGIN,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

/** One feature shaped like the live Traffic_Cameras_View query response. */
const feature = (attrs = {}) => ({
  attributes: {
    device_id: 59632789,
    Desc_: 'CB - I-680 @ MM 1.1 (130th St)',
    ImageURL: 'https://atmsqf.iowadot.gov/SNAPSHOTS/PUBLIC/Metro/cbtv74hd.jpeg',
    latitude: 41.346072,
    longitude: -95.935793,
    REGION: 'Council Bluffs',
    COMMON_ID: 'CBTV74',
    Route: 'I-680',
    ...attrs,
  },
});

test('an Iowa DOT feature maps to a still on the pinned snapshot host', () => {
  const source = iowaDotCameraToSource(feature());
  assert.equal(source.id, 'us-iowadot-cbtv74');
  assert.equal(source.name, 'CB - I-680 @ MM 1.1 (130th St)');
  assert.equal(source.city, 'Iowa');
  assert.equal(source.cityId, 'iowa');
  assert.equal(source.provider, 'Iowa DOT');
  assert.equal(source.feedType, 'image');
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.sourceKind, 'iowadot-open-data');
  assert.match(source.license, /CC BY 4\.0/);
  assert.ok(source.url.startsWith(IOWADOT_IMAGE_ORIGIN));
  assert.equal(source.snapshotUrl, source.url);
  assert.ok(source.code.startsWith('I-680'));
});

test('frame URLs are pinned to the snapshot tree', () => {
  assert.equal(
    normalizeIowaDotImageUrl('http://atmsqf.iowadot.gov/snapshots/Public/Rural/D5TV06.jpg'),
    'https://atmsqf.iowadot.gov/snapshots/Public/Rural/D5TV06.jpg',
  );
  for (const bad of [
    'https://evil.test/snapshots/public/x.jpg',
    'https://atmsqf.iowadot.gov.evil.test/snapshots/public/x.jpg',
    'https://atmsqf.iowadot.gov/other/x.jpg',
    'https://atmsqf.iowadot.gov/snapshots/public/x.jpg?redirect=1',
    'https://user:pw@atmsqf.iowadot.gov/snapshots/public/x.jpg',
    'https://atmsqf.iowadot.gov:8443/snapshots/public/x.jpg',
    'https://atmsqf.iowadot.gov/snapshots/public/x.m3u8',
    'ftp://atmsqf.iowadot.gov/snapshots/public/x.jpg',
    '',
    null,
  ]) {
    assert.equal(normalizeIowaDotImageUrl(bad), null, String(bad));
  }
});

test('bad geometry, ids and frames are dropped', () => {
  // Omaha is plausible but across the river, outside the Iowa box.
  assert.equal(iowaDotCameraToSource(feature({ longitude: -97.5 })), null);
  assert.equal(iowaDotCameraToSource(feature({ latitude: null })), null);
  assert.equal(
    iowaDotCameraToSource(feature({ COMMON_ID: '../x', device_id: null })),
    null,
  );
  assert.equal(
    iowaDotCameraToSource(feature({ ImageURL: 'https://evil.test/a.jpg' })),
    null,
  );
  assert.equal(iowaDotCameraToSource(null), null);
  // A missing COMMON_ID falls back to the numeric device id.
  assert.equal(
    iowaDotCameraToSource(feature({ COMMON_ID: '' })).id,
    'us-iowadot-59632789',
  );
});

test('the loader dedupes, prioritizes and degrades to an empty pack', async (t) => {
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
          COMMON_ID: 'DMTV05',
          Desc_: 'DM - I-235 @ Keo Way',
          ImageURL: 'https://atmsqf.iowadot.gov/SNAPSHOTS/PUBLIC/Metro/dmtv05hd.jpeg',
          latitude: 41.5868,
          longitude: -93.625,
        }),
      ],
    });
  });
  const cameras = await loadIowaDotSourcesFromOpenData();
  assert.deepEqual(requested, [DEFAULT_IOWADOT_CCTV_URL]);
  assert.equal(cameras.length, 2);
  // Des Moines is the first anchor and sits on it.
  assert.equal(cameras[0].id, 'us-iowadot-dmtv05');

  fetchMock.mock.mockImplementation(async () => new Response('x', { status: 503 }));
  assert.deepEqual(await loadIowaDotSourcesFromOpenData(), []);
  fetchMock.mock.mockImplementation(
    async () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }),
  );
  assert.deepEqual(await loadIowaDotSourcesFromOpenData(), []);
  fetchMock.mock.mockImplementation(async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await loadIowaDotSourcesFromOpenData(), []);
});

const withEnv = async (patch, fn) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_IOWADOT_ENABLED;
    Object.assign(process.env, patch);
    await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
};

const runCatalog = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href === DEFAULT_IOWADOT_CCTV_URL) return Response.json({ features: [feature()] });
    return Response.json([]);
  });
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

test('the Iowa DOT lane is wired into the catalog and has a kill switch', async (t) => {
  await withEnv({}, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.ok(requested.includes(DEFAULT_IOWADOT_CCTV_URL));
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'iowa').map((s) => s.id),
      ['us-iowadot-cbtv74'],
    );
  });
  await withEnv({ CCTV_IOWADOT_ENABLED: '0' }, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.equal(requested.includes(DEFAULT_IOWADOT_CCTV_URL), false);
    assert.deepEqual(sources.filter((s) => s.cityId === 'iowa'), []);
  });
});
