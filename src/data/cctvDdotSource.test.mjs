import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ddotFeatureToSource,
  ddotCatalogId,
  loadDdotSourcesFromGis,
} from '../../server/providers/cctv/ddot.js';
import {
  DEFAULT_CCTV_MAX_SOURCES,
  DDOT_CCTV_FEATURE_QUERY_URL,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const sampleFeature = {
  attributes: {
    CameraID: 9,
    Location: '14 St Bridge',
    Description: 'Legacy Upgraded',
    Operation_Status: 1,
    Latitude: 38.88259888,
    Longitude: -77.03269958,
  },
  geometry: { x: -77.03270187720878, y: 38.882606659864386 },
};

test('ddotCatalogId prefixes stable ids', () => {
  assert.equal(ddotCatalogId(9), 'ddot:9');
  assert.equal(ddotCatalogId(''), null);
});

test('ddotFeatureToSource maps active GIS features without live media URLs', () => {
  const source = ddotFeatureToSource(sampleFeature);
  assert.ok(source);
  assert.equal(source.id, 'ddot:9');
  assert.equal(source.name, '14 St Bridge');
  assert.equal(
    source.provider,
    'District Department of Transportation / DC GIS',
  );
  assert.equal(source.sourceKind, 'ddot-gis-location-only');
  assert.equal(source.url, '');
  assert.equal(source.feedType, 'image');
});

test('ddotFeatureToSource rejects inactive cameras', () => {
  assert.equal(
    ddotFeatureToSource({
      ...sampleFeature,
      attributes: { ...sampleFeature.attributes, Operation_Status: 0 },
    }),
    null,
  );
});

test('ddotFeatureToSource rejects coordinates outside DC', () => {
  assert.equal(
    ddotFeatureToSource({
      ...sampleFeature,
      attributes: {
        ...sampleFeature.attributes,
        Latitude: 39.5,
        Longitude: -76.6,
      },
    }),
    null,
  );
});

test('ddot loader queries the official FeatureServer endpoint', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json({ features: [sampleFeature] });
  });
  const cameras = await loadDdotSourcesFromGis();
  assert.deepEqual(requested, [DDOT_CCTV_FEATURE_QUERY_URL]);
  assert.deepEqual(
    cameras.map((c) => c.id),
    ['ddot:9'],
  );
});

test('CCTV_DDOT_ENABLED=0 keeps the lane from being loaded at all', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    process.env.CCTV_DDOT_ENABLED = '0';
    const requested = [];
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(globalThis, 'fetch', async (url) => {
      requested.push(String(url));
      return Response.json([]);
    });
    const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
    assert.equal(
      requested.includes(DDOT_CCTV_FEATURE_QUERY_URL),
      false,
      'the disabled lane never reaches its upstream',
    );
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'washington-dc'),
      [],
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test('the shipped catalog ceiling is not raised to make room for this pack', () => {
  assert.equal(DEFAULT_CCTV_MAX_SOURCES, 4000);
});
