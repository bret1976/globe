import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFireballs,
  parseFireball,
  signedDegree,
  fireballColorCss,
  fireballPixelSize,
  FIREBALLS_URL,
  MAX_FIREBALLS,
} from './parse.js';
import { fireballsProxy } from '../../../server/providers/fireballs.js';

const FIELDS = [
  'date',
  'energy',
  'impact-e',
  'lat',
  'lat-dir',
  'lon',
  'lon-dir',
  'alt',
  'vel',
];

const BODY = {
  signature: { version: '1.2', source: 'NASA/JPL Fireball Data API' },
  count: '5',
  fields: FIELDS,
  data: [
    ['2026-10-04 03:14:45', '5.4', '0.18', '41.8', 'S', '173.1', 'W', '26.9', '13.8'],
    ['2026-09-15 11:26:13', '2.2', '0.079', '37.6', 'S', '161.6', 'W', '37.0', null],
    ['2026-09-11 01:12:11', '24.6', '0.67', '54.4', 'N', '100.1', 'W', '38.0', '20.7'],
    ['2026-09-10 05:22:22', '11.1', '0.33', '19.3', 'S', '28.1', 'W', '33.6', '19.3'],
    // missing lat/lon — skip
    ['2026-08-01 00:00:00', '1.0', '0.01', null, null, null, null, '20.0', null],
  ],
};

test('feed URL is the keyless JPL fireball endpoint', () => {
  assert.match(FIREBALLS_URL, /^https:\/\/ssd-api\.jpl\.nasa\.gov\/fireball\.api/);
  assert.equal(MAX_FIREBALLS, 250);
});

test('signedDegree applies N/S E/W', () => {
  assert.equal(signedDegree('41.8', 'S', 'lat'), -41.8);
  assert.equal(signedDegree('54.4', 'N', 'lat'), 54.4);
  assert.equal(signedDegree('173.1', 'W', 'lon'), -173.1);
  assert.equal(signedDegree('28.1', 'E', 'lon'), 28.1);
  assert.equal(signedDegree(null, 'N', 'lat'), null);
  assert.equal(signedDegree('10', 'X', 'lat'), null);
});

test('color and size scale with energy', () => {
  assert.equal(fireballColorCss(0.5), '#ffcc80');
  assert.equal(fireballColorCss(3), '#ffab40');
  assert.equal(fireballColorCss(10), '#ff6d00');
  assert.equal(fireballColorCss(50), '#ff3d00');
  assert.equal(fireballColorCss(200), '#ff1744');
  assert.ok(fireballPixelSize(24.6) > fireballPixelSize(2.2));
});

test('parseFireball maps a JPL row and skips missing coords', () => {
  const row = parseFireball(BODY.data[0], FIELDS);
  assert.equal(row.lat, -41.8);
  assert.equal(row.lon, -173.1);
  assert.equal(row.altM, 26900);
  assert.equal(row.altKm, 26.9);
  assert.equal(row.energyKt, 5.4);
  assert.equal(row.velKms, 13.8);
  assert.equal(row.observedAt, '2026-10-04T03:14:45.000Z');
  assert.match(row.stableId, /^fb-2026-10-04/);

  const big = parseFireball(BODY.data[2], FIELDS);
  assert.equal(big.lat, 54.4);
  assert.equal(big.lon, -100.1);
  assert.equal(big.energyKt, 24.6);

  assert.equal(parseFireball(BODY.data[4], FIELDS), null);
  assert.equal(parseFireball([], FIELDS), null);
});

test('normalize keeps rows with coords, newest first, capped', () => {
  const rows = normalizeFireballs(BODY);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].observedAt, '2026-10-04T03:14:45.000Z');
  assert.equal(rows[0].energyKt, 5.4);
  assert.deepEqual(normalizeFireballs(null), []);
  assert.deepEqual(normalizeFireballs({ fields: FIELDS, data: [] }), []);

  const many = {
    fields: FIELDS,
    data: Array.from({ length: 300 }, (_, i) => {
      const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000);
      const stamp = d.toISOString().slice(0, 19).replace('T', ' ');
      return [stamp, '1.0', '0.01', '10', 'N', String(i % 180), 'E', '30', null];
    }),
  };
  assert.equal(normalizeFireballs(many).length, 250);
});

function harness(fetchImpl, clock = { t: 1_000_000 }) {
  const plugin = fireballsProxy({
    fetchImpl,
    now: () => clock.t,
    sleep: async () => {},
  });
  let handler;
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/fireballs');
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

test('proxy serves rows, caches, retries, and falls back stale', async () => {
  let calls = 0;
  let fail = 1;
  const { call, clock } = harness(async () => {
    calls += 1;
    if (fail-- > 0) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    return Response.json(BODY);
  });
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 4);
  assert.equal(first.body.rawCount, 5);
  assert.equal(first.body.license, 'U.S. Government work (public domain)');
  assert.equal(calls, 2);
  await call();
  assert.equal(calls, 2);
  clock.t += 2 * 60 * 60_000;
  fail = 99;
  const stale = await call();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  clock.t += 30 * 60 * 60_000;
  const dead = await call();
  assert.equal(dead.status, 502);
});
