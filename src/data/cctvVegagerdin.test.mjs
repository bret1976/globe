import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadVegagerdinSourcesFromOpenData,
  normalizeVegagerdinImageUrl,
  vegagerdinCameraToSource,
} from '../../server/providers/cctv/vegagerdin.js';
import {
  DEFAULT_VEGAGERDIN_CCTV_URL,
  VEGAGERDIN_IMAGE_ORIGIN,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

/** One gagnaveita record, shaped like the live vefmyndavelar2014_1 payload. */
const record = (over = {}) => ({
  Maelist_nr: 7001,
  Myndavel: 'Hellisheiði',
  Vegheiti: 'Hringvegur',
  NrVegur: '1',
  Skyring: 'Hellisheiði séð til vesturs',
  Slod: 'https://www.vegagerdin.is/vgdata/vefmyndavelar/hellisheidi_1.jpg',
  PntX: 385465.0,
  PntY: 392681.0,
  Breidd: 64.018296,
  Lengd: -21.342636,
  ...over,
});

test('a Vegagerðin record maps to a still on the pinned camera folder', () => {
  const source = vegagerdinCameraToSource(record());
  assert.equal(source.id, 'is-vegagerdin-hellisheidi_1');
  assert.equal(source.name, '1 Hellisheiði séð til vesturs');
  assert.equal(source.city, 'Iceland');
  assert.equal(source.cityId, 'iceland');
  assert.equal(source.provider, 'Vegagerðin');
  assert.equal(source.lat, 64.018296);
  assert.equal(source.lon, -21.342636);
  assert.equal(source.feedType, 'image');
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.sourceKind, 'vegagerdin-gagnaveita');
  assert.match(source.license, /CC BY 4\.0/);
  assert.ok(source.url.startsWith(VEGAGERDIN_IMAGE_ORIGIN));
  assert.equal(source.snapshotUrl, source.url);
  assert.equal(source.code, 'HELLISHEIÐI');
});

test('frame URLs are pinned to the agency camera folder', () => {
  assert.deepEqual(
    normalizeVegagerdinImageUrl('http://www.vegagerdin.is/vgdata/vefmyndavelar/steinar_3.jpg'),
    {
      href: 'https://www.vegagerdin.is/vgdata/vefmyndavelar/steinar_3.jpg',
      name: 'steinar_3',
    },
  );
  for (const bad of [
    'https://evil.test/vgdata/vefmyndavelar/x.jpg',
    'https://www.vegagerdin.is/vgdata/other/x.jpg',
    'https://www.vegagerdin.is/vgdata/vefmyndavelar/sub/x.jpg',
    'https://www.vegagerdin.is/vgdata/vefmyndavelar/x.jpg?y=1',
    'https://www.vegagerdin.is/vgdata/vefmyndavelar/x.png',
    'https://u:p@www.vegagerdin.is/vgdata/vefmyndavelar/x.jpg',
    '',
    undefined,
  ]) {
    assert.equal(normalizeVegagerdinImageUrl(bad), null, String(bad));
  }
});

test('bad geometry and frames are dropped', () => {
  // Tórshavn (Faroe Islands): plausible, but outside the Iceland box.
  assert.equal(vegagerdinCameraToSource(record({ Breidd: 62.01, Lengd: -6.77 })), null);
  assert.equal(vegagerdinCameraToSource(record({ Breidd: null })), null);
  assert.equal(vegagerdinCameraToSource(record({ Slod: 'https://evil.test/a.jpg' })), null);
  assert.equal(vegagerdinCameraToSource(null), null);
});

test('the loader dedupes, prioritizes and degrades to an empty pack', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const requested = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json([
      record(),
      record(),
      record({
        Myndavel: 'Reykjavík',
        Skyring: '',
        Slod: 'https://www.vegagerdin.is/vgdata/vefmyndavelar/reykjavik_1.jpg',
        Breidd: 64.1466,
        Lengd: -21.9426,
      }),
    ]);
  });
  const cameras = await loadVegagerdinSourcesFromOpenData();
  assert.deepEqual(requested, [DEFAULT_VEGAGERDIN_CCTV_URL]);
  assert.deepEqual(
    cameras.map((c) => c.id),
    ['is-vegagerdin-reykjavik_1', 'is-vegagerdin-hellisheidi_1'],
  );
  assert.equal(cameras[0].name, '1 Reykjavík');

  fetchMock.mock.mockImplementation(async () => new Response('x', { status: 500 }));
  assert.deepEqual(await loadVegagerdinSourcesFromOpenData(), []);
  fetchMock.mock.mockImplementation(async () => Response.json({ not: 'a list' }));
  assert.deepEqual(await loadVegagerdinSourcesFromOpenData(), []);
  fetchMock.mock.mockImplementation(async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await loadVegagerdinSourcesFromOpenData(), []);
});

const withEnv = async (patch, fn) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_VEGAGERDIN_ENABLED;
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
    if (href === DEFAULT_VEGAGERDIN_CCTV_URL) return Response.json([record()]);
    return Response.json([]);
  });
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

test('the Vegagerðin lane is wired into the catalog and has a kill switch', async (t) => {
  await withEnv({}, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.ok(requested.includes(DEFAULT_VEGAGERDIN_CCTV_URL));
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'iceland').map((s) => s.id),
      ['is-vegagerdin-hellisheidi_1'],
    );
  });
  await withEnv({ CCTV_VEGAGERDIN_ENABLED: '0' }, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.equal(requested.includes(DEFAULT_VEGAGERDIN_CCTV_URL), false);
    assert.deepEqual(sources.filter((s) => s.cityId === 'iceland'), []);
  });
});
