import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCoralStations,
  coralAlertLevel,
  coralAlertName,
  coralAlertColorCss,
  parseCoralGauge,
  simplifyCoralRing,
  coralOutlineRings,
  countCoralLevels,
  CRW_VS_URL,
  MAX_CORAL_RING_POINTS,
  MAX_CORAL_PARTS,
} from './parse.js';
import { coralStationLabel, buildCoralCard } from './cards.js';
import { coralBleachingProxy } from '../../../server/providers/coralBleaching.js';

const PROPS_ABC = {
  name: 'Aruba, Curacao, and Bonaire',
  date: '2026-10-12',
  sst: '29.410',
  ssta: '1.263',
  hs: '1.200',
  dhw: '1.109',
  alert: '2',
  ts_fig: 'caribbean.php#abc_islands',
  gauge_page: 'abc_islands.php',
  gauge: 'Coral_Bleaching_Alert_Level_1_to_2.bmp',
};
const PROPS_NLI = {
  name: 'Northern Line Islands',
  date: '2026-10-12',
  sst: '29.62',
  ssta: '2.28',
  hs: '1.77',
  dhw: '27.0',
  alert: '4',
  gauge_page: 'northern_line_islands.php',
  gauge: 'Coral_Bleaching_Alert_Level_4_to_4.bmp',
};
const PROPS_ABR = {
  name: 'Abrolhos Reefs, Brazil',
  date: '2026-10-12',
  sst: '26.77',
  ssta: '1.969',
  hs: '0.000',
  dhw: '0.000',
  alert: '0',
  gauge_page: 'abrolhos_reefs.php',
  gauge: 'Coral_Bleaching_Alert_Level_1_to_0.bmp',
};

const square = (lon, lat, d = 1) => [
  [lon, lat],
  [lon + d, lat],
  [lon + d, lat + d],
  [lon, lat + d],
  [lon, lat],
];

const FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: PROPS_ABC,
      geometry: { type: 'Point', coordinates: [-69.125, 12.3] },
    },
    {
      type: 'Feature',
      properties: PROPS_ABC,
      geometry: {
        type: 'MultiPolygon',
        coordinates: [[square(-70.2, 12.4, 0.3)], [square(-69.2, 12.0, 0.6)]],
      },
    },
    {
      type: 'Feature',
      properties: PROPS_NLI,
      geometry: { type: 'Point', coordinates: [-159.8, 3.025] },
    },
    {
      type: 'Feature',
      properties: PROPS_NLI,
      geometry: { type: 'Polygon', coordinates: [square(-160.5, 2.5, 2)] },
    },
    // Polygon only (no Point) → centroid fallback.
    {
      type: 'Feature',
      properties: PROPS_ABR,
      geometry: { type: 'Polygon', coordinates: [square(-39, -18.5, 1)] },
    },
    // Junk rows are dropped.
    {
      type: 'Feature',
      properties: { name: '', alert: '1' },
      geometry: { type: 'Point', coordinates: [0, 0] },
    },
    {
      type: 'Feature',
      properties: { name: 'Bad', alert: 'x' },
      geometry: { type: 'Point', coordinates: [0, 0] },
    },
    {
      type: 'Feature',
      properties: { name: 'No geom', alert: '1' },
      geometry: null,
    },
  ],
};

test('CRW URL is the keyless virtual-station GeoJSON', () => {
  assert.equal(
    CRW_VS_URL,
    'https://coralreefwatch.noaa.gov/product/vs/vs_polygons.json',
  );
});

test('alert levels map to the heritage CRW scale', () => {
  assert.equal(coralAlertLevel('0'), 0);
  assert.equal(coralAlertLevel('4'), 4);
  assert.equal(coralAlertLevel(' 3 '), 3);
  assert.equal(coralAlertLevel('9'), 4);
  assert.equal(coralAlertLevel(''), null);
  assert.equal(coralAlertLevel(undefined), null);
  assert.equal(coralAlertName(0), 'No Stress');
  assert.equal(coralAlertName(2), 'Bleaching Warning');
  assert.equal(coralAlertName(4), 'Alert Level 2');
  assert.match(coralAlertColorCss(4), /^#[0-9a-f]{6}$/i);
  assert.notEqual(coralAlertColorCss(0), coralAlertColorCss(4));
});

test('gauge filename gives the 7-day trend', () => {
  assert.deepEqual(parseCoralGauge('Coral_Bleaching_Alert_Level_1_to_2.bmp'), {
    from: 1,
    to: 2,
    trend: 'rising',
  });
  assert.deepEqual(parseCoralGauge('Coral_Bleaching_Alert_Level_4_to_1.bmp'), {
    from: 4,
    to: 1,
    trend: 'falling',
  });
  assert.equal(
    parseCoralGauge('Coral_Bleaching_Alert_Level_3_to_3.bmp').trend,
    'steady',
  );
  assert.equal(parseCoralGauge('nope'), null);
});

test('rings are decimated, closed point dropped, parts capped', () => {
  const big = [];
  for (let i = 0; i <= 400; i += 1) {
    const a = (i / 400) * Math.PI * 2;
    big.push([150 + Math.cos(a), -20 + Math.sin(a)]);
  }
  const ring = simplifyCoralRing(big);
  assert.equal(ring.length, MAX_CORAL_RING_POINTS);
  assert.deepEqual(
    simplifyCoralRing([
      [0, 0],
      [1, 1],
    ]),
    [],
  );
  assert.equal(simplifyCoralRing(square(0, 0)).length, 4);
  const parts = [];
  for (let i = 0; i < 10; i += 1) parts.push([square(i * 2, 0, 0.1 + i * 0.1)]);
  const rings = coralOutlineRings({ type: 'MultiPolygon', coordinates: parts });
  assert.equal(rings.length, MAX_CORAL_PARTS);
  // Largest part first.
  assert.equal(rings[0][0][0], 18);
  assert.deepEqual(
    coralOutlineRings({ type: 'Point', coordinates: [0, 0] }),
    [],
  );
});

test('stations merge Point + polygon by name and sort most severe first', () => {
  const rows = normalizeCoralStations(FIXTURE);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.level),
    [4, 2, 0],
  );
  const [nli, abc, abr] = rows;
  assert.equal(nli.name, 'Northern Line Islands');
  assert.equal(nli.dhw, 27);
  assert.equal(nli.trend, 'steady');
  assert.equal(nli.lat, 3.025);
  assert.equal(nli.lon, -159.8);
  assert.equal(nli.rings.length, 1);
  assert.equal(abc.stableId, 'aruba-curacao-and-bonaire');
  assert.equal(abc.levelName, 'Bleaching Warning');
  assert.equal(abc.trend, 'rising');
  assert.equal(abc.prevLevel, 1);
  assert.equal(abc.sst, 29.41);
  assert.equal(abc.ssta, 1.26);
  assert.equal(abc.rings.length, 2);
  assert.equal(
    abc.page,
    'https://coralreefwatch.noaa.gov/product/vs/gauges/abc_islands.php',
  );
  // Polygon-only station gets a centroid marker.
  assert.ok(Math.abs(abr.lon - -38.5) < 1e-6);
  assert.ok(Math.abs(abr.lat - -18) < 1e-6);
  assert.equal(abr.trend, 'falling');
  assert.deepEqual(countCoralLevels(rows), { 4: 1, 2: 1, 0: 1 });
  assert.equal(normalizeCoralStations(FIXTURE, { limit: 1 }).length, 1);
  assert.deepEqual(normalizeCoralStations(null), []);
});

test('label and card carry heat-stress numbers', () => {
  const [nli, abc] = normalizeCoralStations(FIXTURE);
  assert.match(coralStationLabel(abc), /Aruba.*WARNING ↑/);
  const card = buildCoralCard(nli);
  assert.equal(card.id, 'coral-bleaching-card:northern-line-islands');
  assert.match(card.title, /ALERT 2/);
  const text = card.details.join('\n');
  assert.match(text, /Alert Level 2/);
  assert.match(text, /DHW 27\.0 °C-weeks/);
  assert.match(text, /anomaly \+2\.28 °C/);
  assert.match(text, /2026-10-12/);
  assert.match(text, /NOAA Coral Reef Watch/);
});

function harness(fetchImpl, clock = { t: 1_000_000 }) {
  const plugin = coralBleachingProxy({
    fetchImpl,
    now: () => clock.t,
    sleep: async () => {},
  });
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  let handler;
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/coral-bleaching');
        handler = fn;
      },
    },
  });
  const call = (method = 'GET') =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        destroyed: false,
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
          this.headersSent = true;
        },
        end(body) {
          resolve({
            status: this.status,
            headers: this.headers,
            body: JSON.parse(body),
          });
        },
      };
      handler({ method }, res, () => resolve({ status: 'next' }));
    });
  return { call, clock };
}

test('proxy caches for hours, retries, and falls back stale', async () => {
  let calls = 0;
  let fail = 1;
  const { call, clock } = harness(async (url) => {
    calls += 1;
    if (fail-- > 0)
      throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });
    assert.match(String(url), /vs_polygons\.json$/);
    return Response.json(FIXTURE);
  });
  assert.equal((await call('POST')).status, 'next');
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 3);
  assert.equal(first.body.rawCount, FIXTURE.features.length);
  assert.equal(first.body.date, '2026-10-12');
  assert.deepEqual(first.body.levels, { 4: 1, 2: 1, 0: 1 });
  assert.match(first.body.license, /public domain/);
  assert.equal(calls, 2);
  clock.t += 2 * 60 * 60_000;
  await call();
  assert.equal(calls, 2, 'still cached inside 3 h TTL');
  clock.t += 2 * 60 * 60_000;
  fail = 99;
  const stale = await call();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  clock.t += 48 * 60 * 60_000;
  assert.equal((await call()).status, 502);
});

test('proxy rejects an empty station list instead of caching it', async () => {
  const { call } = harness(async () =>
    Response.json({ type: 'FeatureCollection', features: [] }),
  );
  const res = await call();
  assert.equal(res.status, 502);
});

test('ERDDAP gridded fallback keeps Watch+ cells, most severe first', async () => {
  const { coralErddapPayload } = await import('./parse.js');
  const csv = [
    'time,latitude,longitude,CRW_BAA,CRW_DHW,CRW_SST,CRW_SSTANOMALY,CRW_HOTSPOT',
    'UTC,degrees_north,degrees_east,1,Celsius weeks,Celsius,Celsius,Celsius',
    '2026-10-18T12:00:00Z,-18.025,147.025,2,3.1,28.2,1.1,0.9',
    '2026-10-18T12:00:00Z,10.025,120.025,0,0,28,0.2,0',
    '2026-10-18T12:00:00Z,5.025,-80.025,4,9.5,30.1,2.5,2.1',
    '2026-10-18T12:00:00Z,1.025,1.025,NaN,NaN,NaN,NaN,NaN',
  ].join('\n');
  const p = coralErddapPayload(csv, 1);
  assert.equal(p.count, 2);
  assert.equal(p.rows[0].level, 4);
  assert.equal(p.rows[1].name, 'Reef-belt cell 18.0°S 147.0°E');
  assert.equal(p.date, '2026-10-18');
  assert.equal(p.fallback, 'erddap');
});

test('OceanWatch single-variable CSVs join into one row per cell (lon 0–360 wrapped)', async () => {
  const { mergeCoralErddapCsvs, coralErddapPayload } =
    await import('./parse.js');
  const baa =
    'time,latitude,longitude,bleaching_alert_area\nUTC,n,e,s\n2026-10-18T12:00:00Z,-18.025,212.025,3';
  const dhw =
    'time,latitude,longitude,degree_heating_week\nUTC,n,e,w\n2026-10-18T12:00:00Z,-18.025,212.025,6.5';
  const p = coralErddapPayload(mergeCoralErddapCsvs([baa, dhw]), 1);
  assert.equal(p.count, 1);
  assert.equal(p.rows[0].lon, -147.975);
  assert.equal(p.rows[0].dhw, 6.5);
  assert.equal(p.rows[0].level, 3);
});
