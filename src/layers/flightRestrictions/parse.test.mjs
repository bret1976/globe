import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFlightRestrictions,
  flightRestrictionKind,
  notamIdFromKey,
  faaTfrDetailUrl,
  faaStampToIso,
  simplifyRing,
  countFlightRestrictionKinds,
} from './parse.js';
import { flightRestrictionsProxy } from '../../../server/providers/flightRestrictions.js';

function circle(lon, lat, r, n = 120) {
  const ring = [];
  for (let i = 0; i <= n; i += 1) {
    const a = (i / n) * 2 * Math.PI;
    ring.push([lon + r * Math.cos(a), lat + r * Math.sin(a)]);
  }
  ring[n] = ring[0];
  return ring;
}

const BODY = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'V_TFR_LOC.6/6654',
      geometry: { type: 'Polygon', coordinates: [circle(-120.83, 48.35, 0.05)] },
      properties: {
        GID: 234257,
        CNS_LOCATION_ID: 'ZSE',
        NOTAM_KEY: '6/6654-1-FDC-F',
        TITLE: '28NM W TWISP, WA, Thursday, October 1, 2026 through Thursday, October 15, 2026 UTC',
        LAST_MODIFICATION_DATETIME: '202610011551',
        STATE: 'WA',
        LEGAL: 'HAZARDS',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [circle(-98.47, 29.53, 0.2, 40)] },
      properties: {
        GID: 1,
        NOTAM_KEY: '6/7105-1-FDC-F',
        TITLE: 'San Antonio, TX, Wednesday, October 7, 2026 Local',
        LEGAL: 'VIP',
        STATE: 'TX',
      },
    },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { GID: 2 } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }, properties: { GID: 3 } },
  ],
};

test('kinds, ids, urls, stamps', () => {
  assert.equal(flightRestrictionKind('VIP'), 'vip');
  assert.equal(flightRestrictionKind('AIR SHOWS/SPORTS'), 'sports');
  assert.equal(flightRestrictionKind('UAS PUBLIC GATHERING'), 'uas');
  assert.equal(flightRestrictionKind('SPACE OPERATIONS'), 'space');
  assert.equal(flightRestrictionKind('weird'), 'other');
  assert.equal(notamIdFromKey('6/6654-1-FDC-F'), '6/6654');
  assert.equal(notamIdFromKey('junk'), null);
  assert.equal(faaTfrDetailUrl('6/6654'), 'https://tfr.faa.gov/tfr3/?page=detail_6_6654');
  assert.equal(faaTfrDetailUrl('../x'), null);
  assert.equal(faaStampToIso('202610011551'), '2026-10-01T15:51:00Z');
  assert.equal(faaStampToIso(''), null);
});

test('simplifyRing decimates, drops closing point and junk', () => {
  const ring = simplifyRing(circle(0, 0, 1, 200), 50);
  assert.equal(ring.length, 50);
  assert.deepEqual(simplifyRing([[0, 0], [1, 1]]), []);
  assert.equal(simplifyRing([[0, 0], ['x', 1], [1, 0], [1, 1], [0, 0]]).length, 3);
});

test('normalize keeps polygons, ranks VIP first, skips junk', () => {
  const rows = normalizeFlightRestrictions(BODY);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'vip');
  assert.equal(rows[0].notamId, '6/7105');
  const haz = rows[1];
  assert.equal(haz.kind, 'hazards');
  assert.equal(haz.facility, 'ZSE');
  assert.equal(haz.modified, '2026-10-01T15:51:00Z');
  assert.ok(haz.ring.length <= 72 && haz.ring.length >= 3);
  assert.ok(Math.abs(haz.lat - 48.35) < 0.01 && Math.abs(haz.lon + 120.83) < 0.01);
  assert.ok(haz.radiusKm > 3 && haz.radiusKm < 7);
  assert.deepEqual(countFlightRestrictionKinds(rows), { vip: 1, hazards: 1 });
});

function harness(fetchImpl, clock = { t: 1_000_000 }) {
  const plugin = flightRestrictionsProxy({ fetchImpl, now: () => clock.t, sleep: async () => {} });
  let handler;
  plugin.configureServer({ middlewares: { use(path, fn) { assert.equal(path, '/api/flight-restrictions'); handler = fn; } } });
  const call = () =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        destroyed: false,
        writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
        end(body) { resolve({ status: this.status, headers: this.headers, body: JSON.parse(body) }); },
      };
      handler({ method: 'GET' }, res, () => resolve({ status: 'next' }));
    });
  return { call, clock };
}

test('proxy serves rows, caches, retries resets, and falls back stale', async () => {
  let calls = 0;
  let fail = 1;
  const { call, clock } = harness(async () => {
    calls += 1;
    if (fail-- > 0) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    return Response.json(BODY);
  });
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 2);
  assert.equal(first.body.rawCount, 4);
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
