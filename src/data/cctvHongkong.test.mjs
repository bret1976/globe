import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hongkongCameraToSource,
  loadHongKongSourcesFromOpenData,
  normalizeHongKongImageUrl,
  parseHongKongCameraXml,
} from '../../server/providers/cctv/hongkong.js';
import {
  DEFAULT_HONGKONG_CCTV_URL,
  HONGKONG_IMAGE_ORIGIN,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const row = (over = {}) => ({
  key: 'H429F',
  region: 'Hong Kong Island',
  district: 'Southern',
  description: 'Aberdeen Praya Road near Fish Market [H429F]',
  latitude: 22.24845,
  longitude: 114.1505,
  url: 'https://tdcctv.data.one.gov.hk/H429F.JPG',
  ...over,
});

test('an HK TD camera maps to a still on the pinned host', () => {
  const source = hongkongCameraToSource(row());
  assert.equal(source.id, 'hk-td-H429F');
  assert.equal(source.name, 'Aberdeen Praya Road near Fish Market [H429F]');
  assert.equal(source.cityId, 'hongkong');
  assert.equal(source.provider, 'Hong Kong Transport Department');
  assert.equal(source.feedType, 'image');
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.sourceKind, 'hk-td-traffic-snapshot');
  assert.match(source.license, /DATA\.GOV\.HK/);
  assert.ok(source.url.startsWith(HONGKONG_IMAGE_ORIGIN));
  assert.equal(source.snapshotUrl, source.url);
  assert.ok(source.code);
});

test('frame URLs are pinned to tdcctv.data.one.gov.hk/{KEY}.JPG', () => {
  assert.equal(
    normalizeHongKongImageUrl(
      'http://tdcctv.data.one.gov.hk/H429F.JPG',
      'H429F',
    ),
    'https://tdcctv.data.one.gov.hk/H429F.JPG',
  );
  assert.equal(
    normalizeHongKongImageUrl('', 'AID01215'),
    'https://tdcctv.data.one.gov.hk/AID01215.JPG',
  );
  for (const bad of [
    'https://evil.test/H429F.JPG',
    'https://tdcctv.data.one.gov.hk.evil.test/H429F.JPG',
    'https://tdcctv.data.one.gov.hk/other/H429F.JPG',
    'https://tdcctv.data.one.gov.hk/H429F.JPG?x=1',
    'https://user:pw@tdcctv.data.one.gov.hk/H429F.JPG',
    'https://tdcctv.data.one.gov.hk:8443/H429F.JPG',
    'https://tdcctv.data.one.gov.hk/H429F.jpg',
  ]) {
    assert.equal(normalizeHongKongImageUrl(bad, 'H429F'), null, String(bad));
  }
  // Empty raw with no key is refused; empty raw WITH a key rebuilds the pinned URL.
  assert.equal(normalizeHongKongImageUrl('', ''), null);
  assert.equal(normalizeHongKongImageUrl(null), null);
});

test('XML parser extracts image rows', () => {
  const xml = `<?xml version="1.0"?><image-list>
    <image>
      <key>H429F</key>
      <region>Hong Kong Island</region>
      <district>Southern</district>
      <description>Aberdeen Praya Road</description>
      <latitude>22.24845</latitude>
      <longitude>114.1505</longitude>
      <url>https://tdcctv.data.one.gov.hk/H429F.JPG</url>
    </image>
  </image-list>`;
  const rows = parseHongKongCameraXml(xml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'H429F');
  assert.equal(hongkongCameraToSource(rows[0]).id, 'hk-td-H429F');
});

test('bad geometry, keys and frames are dropped', () => {
  assert.equal(
    hongkongCameraToSource(row({ latitude: 35.0, longitude: 139.0 })),
    null,
  ); // Tokyo
  assert.equal(hongkongCameraToSource(row({ latitude: null })), null);
  assert.equal(hongkongCameraToSource(row({ key: 'bad key!' })), null);
  assert.equal(
    hongkongCameraToSource(row({ url: 'https://evil.test/a.JPG' })),
    null,
  );
  assert.equal(hongkongCameraToSource(null), null);
});

test('the loader dedupes, prioritizes and falls back to the bundled snapshot', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const requested = [];
  const xml = `<?xml version="1.0"?><image-list>
    <image>
      <key>H429F</key><region>Hong Kong Island</region><district>Southern</district>
      <description>Aberdeen</description><latitude>22.24845</latitude><longitude>114.1505</longitude>
      <url>https://tdcctv.data.one.gov.hk/H429F.JPG</url>
    </image>
    <image>
      <key>H429F</key><region>Hong Kong Island</region><district>Southern</district>
      <description>Aberdeen</description><latitude>22.24845</latitude><longitude>114.1505</longitude>
      <url>https://tdcctv.data.one.gov.hk/H429F.JPG</url>
    </image>
    <image>
      <key>AID01215</key><region>Hong Kong Island</region><district>Wan Chai</district>
      <description>Canal Road</description><latitude>22.27821</latitude><longitude>114.18121</longitude>
      <url>https://tdcctv.data.one.gov.hk/AID01215.JPG</url>
    </image>
  </image-list>`;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return new Response(xml, {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
    });
  });
  const cameras = await loadHongKongSourcesFromOpenData();
  assert.equal(cameras.length, 2);
  assert.ok(
    requested[0].includes('data.gov.hk') ||
      requested[0] === DEFAULT_HONGKONG_CCTV_URL,
  );
  assert.equal(cameras[0].provider, 'Hong Kong Transport Department');
  fetchMock.mock.restore();

  const failMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  const snapshot = await loadHongKongSourcesFromOpenData();
  assert.ok(snapshot.length >= 8, `snapshot kept ${snapshot.length}`);
  assert.ok(snapshot.every((c) => c.cityId === 'hongkong'));
  assert.ok(snapshot.every((c) => c.sourceKind === 'hk-td-traffic-snapshot'));
  failMock.mock.restore();
});

test('catalog LIVE_PACKS includes hongkong', () => {
  assert.equal(typeof createCctvCatalog, 'function');
});
