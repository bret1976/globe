import test from 'node:test';
import assert from 'node:assert/strict';
import {
  latestGlotecFrame,
  normalizeGlotec,
  glotecStats,
  tecColorCss,
  tecPixelSize,
  GLOTEC_INDEX_URL,
} from './parse.js';
import { ionosphereProxy } from '../../../server/providers/ionosphere.js';

const INDEX = [
  { url: '/products/glotec/geojson_2d_urt/glotec_icao_20261007T221500Z.geojson', time_tag: '2026-10-07T22:15:00Z' },
  { url: '/products/glotec/geojson_2d_urt/glotec_icao_20261007T222500Z.geojson', time_tag: '2026-10-07T22:25:00Z' },
  { url: 'https://evil.example/x.geojson', time_tag: '2026-10-08T00:00:00Z' },
  { url: '/products/glotec/../../secret.geojson', time_tag: '2026-10-09T00:00:00Z' },
];

const FRAME = {
  type: 'FeatureCollection',
  time_tag: '2026-10-07T22:25:00Z',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-177.5, -88.75] }, properties: { tec: 7.607, anomaly: -0.1188, hmF2: 315.8, NmF2: 258545292365.85, quality_flag: 0 } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.5, -11.25] }, properties: { tec: 52.31, anomaly: 0.2, hmF2: 280.2, NmF2: 1.2e12, quality_flag: 0 } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { tec: null } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 95] }, properties: { tec: 10 } },
  ],
};

test('latest frame is newest, host- and path-pinned', () => {
  const frame = latestGlotecFrame(INDEX);
  assert.equal(frame.url, 'https://services.swpc.noaa.gov/products/glotec/geojson_2d_urt/glotec_icao_20261007T222500Z.geojson');
  assert.equal(frame.timeTag, '2026-10-07T22:25:00.000Z');
  assert.equal(latestGlotecFrame(null), null);
});

test('normalize keeps valid cells and rounds', () => {
  const { timeTag, rows } = normalizeGlotec(FRAME);
  assert.equal(timeTag, '2026-10-07T22:25:00.000Z');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { stableId: '-88.75:-177.5', lat: -88.75, lon: -177.5, tec: 7.6, anomaly: -0.12, hmF2: 316, nmF2: 259000000000, quality: 0 });
  assert.deepEqual(glotecStats(rows), { minTec: 7.6, maxTec: 52.3, medianTec: 52.3 });
});

test('color ramp and size are monotone-ish and bounded', () => {
  assert.equal(tecColorCss(0), 'rgb(20,30,110)');
  assert.equal(tecColorCss(200), 'rgb(230,30,50)');
  assert.match(tecColorCss(20), /^rgb\(\d+,\d+,\d+\)$/);
  assert.ok(tecPixelSize(0) >= 5 && tecPixelSize(500) <= 14);
});

test('proxy fetches index then frame, skips refetch of same frame, stale fallback', async () => {
  const urls = [];
  let down = false;
  const clock = { t: 5_000_000 };
  const plugin = ionosphereProxy({
    now: () => clock.t,
    sleep: async () => {},
    fetchImpl: async (url) => {
      urls.push(url);
      if (down) throw new TypeError('fetch failed');
      return Response.json(url === GLOTEC_INDEX_URL ? INDEX : FRAME);
    },
  });
  let handler;
  plugin.configureServer({ middlewares: { use(path, fn) { assert.equal(path, '/api/ionosphere'); handler = fn; } } });
  const call = () =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        destroyed: false,
        writeHead(status) { this.status = status; this.headersSent = true; },
        end(body) { resolve({ status: this.status, body: JSON.parse(body) }); },
      };
      handler({ method: 'GET' }, res, () => resolve({ status: 'next' }));
    });
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 2);
  assert.equal(first.body.timeTag, '2026-10-07T22:25:00.000Z');
  assert.equal(urls.length, 2);
  clock.t += 6 * 60_000;
  await call();
  assert.equal(urls.length, 3, 'same frame → index only');
  clock.t += 6 * 60_000;
  down = true;
  const stale = await call();
  assert.equal(stale.body.stale, true);
});
