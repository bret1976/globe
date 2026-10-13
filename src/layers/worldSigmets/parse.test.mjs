import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWorldSigmets,
  parseWorldSigmet,
  worldSigmetFamily,
  worldSigmetColorCss,
  coordsToRings,
  simplifyRing,
  countWorldSigmetFamilies,
  countWorldSigmetHazards,
  AWC_ISIGMET_URL,
  MAX_WORLD_SIGMETS,
} from './parse.js';
import { worldSigmetLabel, buildWorldSigmetCard } from './cards.js';
import { worldSigmetsProxy } from '../../../server/providers/worldSigmets.js';

const VA = {
  icaoId: 'MHTG',
  firId: 'MHTG',
  firName: 'MHCC CENTRAL AMERICAN',
  receiptTime: '2026-10-13T09:52:46.078Z',
  validTimeFrom: 1791885000,
  validTimeTo: 1791906600,
  seriesId: '1',
  hazard: 'VA',
  qualifier: 'SANTA MARIA',
  base: 0,
  top: 13000,
  geom: 'AREA',
  coords: [
    { lon: -91.683, lat: 14.817 },
    { lon: -91.533, lat: 14.767 },
    { lon: -91.533, lat: 14.733 },
    { lon: -91.717, lat: 14.767 },
    { lon: -91.683, lat: 14.817 },
  ],
  dir: 'W',
  spd: '15',
  rawSigmet: 'MHTG SIGMET 1 VALID 130950/131550 MHTG- VA SANTA MARIA',
};

const TS = {
  icaoId: 'RJTD',
  firId: 'RJJJ',
  firName: 'RJJJ FUKUOKA',
  validTimeFrom: 1791885000,
  validTimeTo: 1791899400,
  seriesId: 'B05',
  hazard: 'TS',
  qualifier: 'EMBD',
  base: null,
  top: 45000,
  geom: 'AREA',
  coords: [
    { lon: 179.5, lat: 30 },
    { lon: -179.5, lat: 30 },
    { lon: -179.5, lat: 32 },
    { lon: 179.5, lat: 32 },
    { lon: 179.5, lat: 30 },
  ],
  rawSigmet: 'RJJJ SIGMET B05 EMBD TS',
};

const AREAS_TURB = {
  firId: 'FCCC',
  seriesId: 'F1',
  hazard: 'TURB',
  validTimeFrom: 1791895800,
  validTimeTo: 1791910200,
  geom: 'AREAS',
  coords: [
    [
      { lon: 17.933, lat: 5.783 },
      { lon: 21.533, lat: 5.5 },
      { lon: 21.533, lat: 7.5 },
      { lon: 17.933, lat: 5.783 },
    ],
    [
      { lon: 13.917, lat: 0.767 },
      { lon: 12.95, lat: -1.267 },
      { lon: 14.95, lat: -1.267 },
      { lon: 13.917, lat: 0.767 },
    ],
  ],
};

test('isigmet URL is the keyless AWC JSON feed', () => {
  assert.equal(AWC_ISIGMET_URL, 'https://aviationweather.gov/api/data/isigmet?format=json');
  assert.ok(MAX_WORLD_SIGMETS >= 200 && MAX_WORLD_SIGMETS <= 300);
});

test('family and color mapping', () => {
  assert.equal(worldSigmetFamily('VA'), 'ash');
  assert.equal(worldSigmetFamily('TC'), 'cyclone');
  assert.equal(worldSigmetFamily('TS'), 'convective');
  assert.equal(worldSigmetFamily('TURB'), 'turb');
  assert.equal(worldSigmetFamily('ice'), 'ice');
  assert.equal(worldSigmetFamily(undefined), 'other');
  assert.match(worldSigmetColorCss('ash'), /^#/);
  assert.equal(worldSigmetColorCss('VA'), worldSigmetColorCss('ash'));
  assert.notEqual(worldSigmetColorCss('ash'), worldSigmetColorCss('other'));
});

test('parses volcanic ash SIGMET with levels, movement, and closed ring', () => {
  const [row] = parseWorldSigmet(VA);
  assert.equal(row.product, 'isigmet');
  assert.equal(row.hazard, 'VA');
  assert.equal(row.family, 'ash');
  assert.equal(row.qualifier, 'SANTA MARIA');
  assert.equal(row.fir, 'MHTG');
  assert.equal(row.tag, 'MHTG 1');
  assert.equal(row.base, 0);
  assert.equal(row.top, 13000);
  assert.equal(row.dir, 'W');
  assert.equal(row.spd, 15);
  assert.equal(row.geometryType, 'area');
  assert.equal(row.ring.length, 4); // closing vertex dropped
  assert.equal(row.validFrom, new Date(1791885000 * 1000).toISOString());
  assert.ok(row.lat > 14.7 && row.lat < 14.9);
  assert.ok(row.radiusKm > 0);
  assert.match(row.raw, /SANTA MARIA/);
  assert.equal(worldSigmetLabel(row), 'SIGMET VA SANTA MARIA · MHTG');
  const card = buildWorldSigmetCard(row);
  assert.equal(card.title, worldSigmetLabel(row));
  assert.ok(card.details.some((d) => /SFC – FL130/.test(d)));
  assert.ok(card.details.some((d) => /not for flight planning/.test(d)));
});

test('antimeridian rings are unwrapped and center stays in range', () => {
  const [row] = parseWorldSigmet(TS);
  const lons = row.ring.map(([lon]) => lon);
  assert.ok(Math.max(...lons) - Math.min(...lons) < 5);
  assert.ok(row.lon >= -180 && row.lon <= 180);
  assert.ok(row.radiusKm < 300);
});

test('AREAS geometry yields one row per ring; junk is skipped', () => {
  const rows = parseWorldSigmet(AREAS_TURB);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].stableId, rows[1].stableId);
  assert.equal(coordsToRings(AREAS_TURB.coords).length, 2);
  assert.deepEqual(parseWorldSigmet({}), []);
  assert.deepEqual(parseWorldSigmet({ hazard: 'VA', coords: null }), []);
  assert.deepEqual(simplifyRing([[0, 0]]), []);
});

test('normalize ranks VA first, dedupes, counts, and caps', () => {
  const rows = normalizeWorldSigmets([AREAS_TURB, TS, VA, VA, null, {}]);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].hazard, 'VA');
  assert.equal(rows[1].hazard, 'TS');
  assert.deepEqual(countWorldSigmetHazards(rows), { VA: 1, TS: 1, TURB: 2 });
  assert.deepEqual(countWorldSigmetFamilies(rows), { ash: 1, convective: 1, turb: 2 });
  assert.equal(normalizeWorldSigmets([AREAS_TURB, TS, VA], { limit: 1 })[0].hazard, 'VA');
  assert.deepEqual(normalizeWorldSigmets(null), []);
});

function harness(fetchImpl, clock = { t: 1_000_000 }) {
  const plugin = worldSigmetsProxy({
    fetchImpl,
    now: () => clock.t,
    sleep: async () => {},
  });
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  let handler;
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/world-sigmets');
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

test('proxy caches, retries, and falls back stale', async () => {
  let calls = 0;
  let fail = 1;
  const { call, clock } = harness(async (url) => {
    calls += 1;
    if (fail-- > 0) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    assert.match(String(url), /isigmet/);
    return Response.json([VA, TS]);
  });
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 2);
  assert.equal(first.body.rawCount, 2);
  assert.equal(first.body.hazards.VA, 1);
  assert.match(first.body.note, /not for flight planning/i);
  assert.equal(calls, 2);
  await call();
  assert.equal(calls, 2);
  clock.t += 6 * 60_000;
  fail = 99;
  const stale = await call();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  clock.t += 3 * 60 * 60_000;
  const dead = await call();
  assert.equal(dead.status, 502);
});
