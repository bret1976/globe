import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAviationHazards,
  parseAviationHazard,
  aviationHazardFamily,
  aviationHazardColorCss,
  coordsToRing,
  simplifyRing,
  toIsoTime,
  countAviationHazardFamilies,
  countAviationHazardProducts,
  AWC_SIGMET_URL,
} from './parse.js';
import { aviationHazardsProxy } from '../../../server/providers/aviationHazards.js';

const SIGMET = {
  icaoId: 'KKCI',
  seriesId: 'OSCAR 1',
  validTimeFrom: 1791548520,
  validTimeTo: 1791562920,
  airSigmetType: 'SIGMET',
  hazard: 'TURB',
  rawAirSigmet: 'SIGMET OSCAR 1 VALID UNTIL 091622\nOCNL SEV TURB BLW 160.',
  coords: [
    { lon: -110.487, lat: 49.008 },
    { lon: -109.107, lat: 45.809 },
    { lon: -112.192, lat: 45.866 },
    { lon: -113.697, lat: 49.038 },
    { lon: -110.487, lat: 49.008 },
  ],
};

const GAIRMET_AREA = {
  tag: '2W',
  hazard: 'TURB-HI',
  geometryType: 'AREA',
  validTime: '2026-10-09T15:00:00.000Z',
  issueTime: 1791554280,
  expireTime: 1791558000,
  coords: [
    { lat: '42.74', lon: '-79.28' },
    { lat: '41.08', lon: '-77.07' },
    { lat: '40.41', lon: '-72.40' },
    { lat: '40.78', lon: '-67.12' },
    { lat: '42.74', lon: '-79.28' },
  ],
};

const GAIRMET_LINE = {
  tag: '1C',
  hazard: 'FZLVL',
  geometryType: 'LINE',
  validTime: '2026-10-09T15:00:00.000Z',
  coords: [
    { lat: '45.37', lon: '-135.41' },
    { lat: '45.55', lon: '-133.51' },
    { lat: '45.29', lon: '-132.23' },
    { lat: '45.08', lon: '-130.53' },
  ],
};

const CWA = {
  cwsu: 'ZMA',
  name: 'Miami',
  seriesId: '103',
  hazard: 'TS',
  validTimeFrom: 1791554400,
  validTimeTo: 1791561600,
  rawText: 'ZMA CWA 103 VALID UNTIL 091600\nAREA TSRA.',
  coords: [
    { lat: '25.862', lon: '-77.450' },
    { lat: '25.096', lon: '-72.872' },
    { lat: '22.511', lon: '-73.005' },
    { lat: '24.703', lon: '-78.293' },
    { lat: '25.862', lon: '-77.450' },
  ],
};

test('hazard family and color mapping', () => {
  assert.equal(aviationHazardFamily('TURB'), 'turb');
  assert.equal(aviationHazardFamily('TURB-HI'), 'turb');
  assert.equal(aviationHazardFamily('ICE'), 'ice');
  assert.equal(aviationHazardFamily('FZLVL'), 'ice');
  assert.equal(aviationHazardFamily('CONVECTIVE'), 'convective');
  assert.equal(aviationHazardFamily('TS'), 'convective');
  assert.equal(aviationHazardFamily('IFR'), 'ifr');
  assert.equal(aviationHazardFamily('MT_OBSC'), 'ifr');
  assert.equal(aviationHazardFamily('LLWS'), 'wind');
  assert.equal(aviationHazardFamily('SFC_WND'), 'wind');
  assert.equal(aviationHazardFamily('weird'), 'other');
  assert.equal(aviationHazardColorCss('TURB'), '#ff8c1a');
  assert.equal(aviationHazardColorCss('ICE'), '#2ee6c8');
  assert.equal(aviationHazardColorCss('CONVECTIVE'), '#ff3b3b');
  assert.equal(aviationHazardColorCss('IFR'), '#b06cff');
  assert.equal(aviationHazardColorCss('LLWS'), '#ffd21a');
  assert.match(AWC_SIGMET_URL, /aviationweather\.gov/);
});

test('coordsToRing converts lat/lon objects (string or number) and simplifyRing caps', () => {
  const ring = coordsToRing(SIGMET.coords);
  assert.ok(ring.length >= 3 && ring.length <= 72);
  assert.equal(ring[0][0], -110.487);
  assert.equal(ring[0][1], 49.008);
  const fromStrings = coordsToRing(GAIRMET_AREA.coords);
  assert.ok(fromStrings.length >= 3);
  assert.equal(simplifyRing([[0, 0], [1, 1]]).length, 2);
  assert.deepEqual(coordsToRing([{ lat: 'x', lon: 1 }]), []);
});

test('toIsoTime accepts unix seconds and ISO', () => {
  assert.equal(toIsoTime(1791548520), '2026-10-09T12:22:00.000Z');
  assert.equal(toIsoTime('2026-10-09T15:00:00.000Z'), '2026-10-09T15:00:00.000Z');
  assert.equal(toIsoTime(''), null);
});

test('parseAviationHazard builds outline rows for SIGMET, G-AIRMET, CWA', () => {
  const sig = parseAviationHazard(SIGMET, 'sigmet');
  assert.equal(sig.product, 'sigmet');
  assert.equal(sig.hazard, 'TURB');
  assert.equal(sig.family, 'turb');
  assert.equal(sig.seriesId, 'OSCAR 1');
  assert.equal(sig.validFrom, '2026-10-09T12:22:00.000Z');
  assert.ok(sig.ring.length >= 3);
  assert.ok(sig.raw.includes('TURB'));
  assert.equal(sig.geometryType, 'area');

  const area = parseAviationHazard(GAIRMET_AREA, 'gairmet');
  assert.equal(area.product, 'gairmet');
  assert.equal(area.family, 'turb');
  assert.equal(area.geometryType, 'area');
  assert.ok(Math.abs(area.lat - 41.25) < 2);

  const line = parseAviationHazard(GAIRMET_LINE, 'gairmet');
  assert.equal(line.geometryType, 'line');
  assert.equal(line.family, 'ice');
  assert.ok(line.ring.length >= 2);

  const cwa = parseAviationHazard(CWA, 'cwa');
  assert.equal(cwa.product, 'cwa');
  assert.equal(cwa.family, 'convective');
  assert.equal(cwa.hazard, 'TS');

  assert.equal(parseAviationHazard({ hazard: 'TURB', coords: [] }, 'sigmet'), null);
});

test('normalize merges products, ranks SIGMET first, skips junk', () => {
  const rows = normalizeAviationHazards({
    sigmets: [SIGMET, { hazard: 'TURB', coords: null }],
    gairmets: [GAIRMET_AREA, GAIRMET_LINE],
    cwas: [CWA],
  });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].product, 'sigmet');
  assert.deepEqual(countAviationHazardProducts(rows), {
    sigmet: 1,
    gairmet: 2,
    cwa: 1,
  });
  assert.ok(countAviationHazardFamilies(rows).turb >= 2);
  assert.ok(countAviationHazardFamilies(rows).convective >= 1);
});

function harness(fetchImpl, clock = { t: 1_000_000 }) {
  const plugin = aviationHazardsProxy({
    fetchImpl,
    now: () => clock.t,
    sleep: async () => {},
  });
  let handler;
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/aviation-hazards');
        handler = fn;
      },
    },
  });
  const call = () =>
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
          resolve({ status: this.status, headers: this.headers, body: JSON.parse(body) });
        },
      };
      handler({ method: 'GET' }, res, () => resolve({ status: 'next' }));
    });
  return { call, clock };
}

test('proxy merges feeds, caches, retries, and falls back stale', async () => {
  let calls = 0;
  let fail = 1;
  const { call, clock } = harness(async (url) => {
    calls += 1;
    if (fail-- > 0) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    if (String(url).includes('airsigmet')) return Response.json([SIGMET]);
    if (String(url).includes('gairmet')) return Response.json([GAIRMET_AREA]);
    if (String(url).includes('cwa')) return Response.json([CWA]);
    throw new Error(`unexpected ${url}`);
  });
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 3);
  assert.equal(first.body.rawCount, 3);
  assert.match(first.body.note, /not for flight planning/i);
  assert.equal(calls, 6); // first attempt failed mid-flight → 3 retry fetches
  await call();
  assert.equal(calls, 6);
  clock.t += 6 * 60_000;
  fail = 99;
  const stale = await call();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  clock.t += 3 * 60 * 60_000;
  const dead = await call();
  assert.equal(dead.status, 502);
});
