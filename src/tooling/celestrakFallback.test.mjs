import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { celestrakProxy } from '../../server/providers/space/celestrak.js';
import { fallbackTleUrl, mirrorOmmUrl } from '../data/spaceProviderRequests.js';
import { parseOrbitalElements } from '../sources/orbitalElements.js';

function install(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(_r, h) {
        handler = h;
      },
    },
  });
  return async (url) => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url, method: 'GET' }, res);
    return res;
  };
}

const OLD =
  'ISS (ZARYA)\n1 25544U OLD-L1\n2 25544 OLD-L2\nCSS (TIANHE)\n1 48274U OLD-L1\n2 48274 OLD-L2\n';

function setup(t, t0, prior = OLD) {
  let now = t0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(fsp, 'readFile', async () =>
    JSON.stringify({ at: t0 - 7 * 3600_000, body: prior }),
  );
  t.mock.method(fsp, 'mkdir', async () => {});
  const writes = [];
  t.mock.method(fsp, 'writeFile', async (_p, data) =>
    writes.push(JSON.parse(data)),
  );
  return { advance: (ms) => (now += ms), writes };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('fallback URL is a fixed origin with a numeric id only', () => {
  const u = fallbackTleUrl('25544/../x');
  assert.equal(u.origin, 'https://tle.ivanstanojevic.me');
  assert.equal(u.pathname, '/api/tle/25544');
});

test('CelesTrak ban (timeout) refreshes the stale catalog from the fallback source', async (t) => {
  const { writes } = setup(t, 2_000_000_000_000);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(new URL(url).hostname);
    if (url.includes('celestrak'))
      throw new DOMException('timeout', 'TimeoutError');
    const id = url.split('/').pop();
    return Response.json({ line1: `1 ${id}U NEW-L1`, line2: `2 ${id} NEW-L2` });
  });
  const request = install(celestrakProxy());
  const stale = await request('/stations');
  assert.equal(stale.headers['x-tle-cache'], 'STALE');
  await settle();
  assert.deepEqual(seen.slice(0, 2), ['celestrak.org', 'celestrak.com']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].source, 'fallback');
  assert.match(
    writes[0].body,
    /ISS \(ZARYA\)\n1 25544U NEW-L1\n2 25544 NEW-L2/,
  );
  const hit = await request('/stations');
  assert.equal(hit.headers['x-tle-cache'], 'HIT');
  assert.equal(hit.headers['x-tle-source'], 'fallback');
  assert.doesNotMatch(hit.body, /OLD/);
});

test('failed refreshes back off instead of hammering a banned upstream', async (t) => {
  const { advance } = setup(t, 2_000_000_000_000);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new Error('down');
  });
  const request = install(celestrakProxy());
  await request('/stations');
  await settle();
  const afterFirst = calls;
  assert.ok(afterFirst >= 2);
  for (let i = 0; i < 5; i++) await request('/stations');
  await settle();
  assert.equal(calls, afterFirst, 'no refetch during backoff');
  advance(16 * 60_000);
  await request('/stations');
  await settle();
  assert.ok(calls > afterFirst, 'retries after the backoff window');
});

test('fallback keeps prior elements for satellites it cannot refresh, but needs half', async (t) => {
  const { writes } = setup(t, 2_000_000_000_000);
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('celestrak')) return new Response('', { status: 403 });
    if (url.endsWith('48274')) return new Response('nope', { status: 404 });
    return Response.json({ line1: '1 25544U NEW-L1', line2: '2 25544 NEW-L2' });
  });
  await install(celestrakProxy())('/stations');
  await settle();
  assert.equal(writes.length, 1);
  assert.match(writes[0].body, /1 25544U NEW-L1/);
  assert.match(writes[0].body, /1 48274U OLD-L1/);
});

test('SatNOGS bulk catalog refreshes every satellite in one request', async (t) => {
  const { writes } = setup(t, 2_000_000_000_000);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(new URL(url).hostname);
    if (url.includes('celestrak')) return new Response('', { status: 403 });
    if (url.includes('satnogs'))
      return Response.json([
        {
          norad_cat_id: 25544,
          tle1: '1 25544U BULK-L1',
          tle2: '2 25544 BULK-L2',
        },
        {
          norad_cat_id: 48274,
          tle1: '1 48274U BULK-L1',
          tle2: '2 48274 BULK-L2',
        },
      ]);
    return new Response('rate limited', { status: 429 });
  });
  await install(celestrakProxy())('/stations');
  await settle();
  assert.equal(writes.length, 1);
  assert.match(writes[0].body, /1 25544U BULK-L1/);
  assert.match(writes[0].body, /1 48274U BULK-L1/);
  assert.ok(!seen.includes('tle.ivanstanojevic.me'), 'no per-id calls needed');
});

test('CelesTrak mirror on GitHub is tried before per-satellite fallbacks', async (t) => {
  const { writes } = setup(t, Date.UTC(2026, 9, 16));
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(new URL(url).hostname);
    if (url.includes('celestrak.')) return new Response('', { status: 403 });
    if (url.includes('githubusercontent'))
      return new Response(
        'ISS (ZARYA)\n1 25544U 98067A   26288.82192346  MIRROR\n2 25544 MIRROR-L2\n',
      );
    return new Response('no', { status: 500 });
  });
  await install(celestrakProxy())('/stations');
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].source, 'mirror');
  assert.match(writes[0].body, /MIRROR/);
  assert.ok(!seen.includes('db.satnogs.org'));
});

test('a stale mirror is rejected and the per-satellite fallback runs', async (t) => {
  const { writes } = setup(t, Date.UTC(2026, 9, 16));
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('celestrak.')) return new Response('', { status: 403 });
    if (url.includes('githubusercontent'))
      return new Response(
        'ISS\n1 25544U 98067A   26200.00000000  OLDM\n2 25544 X\n',
      );
    if (url.includes('satnogs')) return Response.json([]);
    const id = url.split('/').pop();
    return Response.json({ line1: `1 ${id}U NEW-L1`, line2: `2 ${id} NEW-L2` });
  });
  await install(celestrakProxy())('/stations');
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].source, 'fallback');
});

// OMM fixtures: CelesTrak serves catalog numbers above 99999 only as OMM JSON.
const omm = (id, name, epoch, extra = {}) => ({
  OBJECT_NAME: name,
  OBJECT_ID: '2026-233A',
  EPOCH: epoch,
  MEAN_MOTION: 15.48899044,
  ECCENTRICITY: 0.00067481,
  INCLINATION: 51.6326,
  RA_OF_ASC_NODE: 58.3278,
  ARG_OF_PERICENTER: 271.9059,
  MEAN_ANOMALY: 88.1156,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: id,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 32,
  BSTAR: 0.0001501181,
  MEAN_MOTION_DOT: 0.00007803,
  MEAN_MOTION_DDOT: 0,
  ...extra,
});

test('mirror OMM URL is a fixed GitHub origin with a sanitized slug', () => {
  const u = mirrorOmmUrl('Stations/../x');
  assert.equal(u.origin, 'https://raw.githubusercontent.com');
  assert.equal(
    u.pathname,
    '/satvisorcom/satvisor-data/master/celestrak/json/stationsx.json',
  );
});

test('CelesTrak OMM JSON is forwarded as JSON with six-digit catalog numbers', async (t) => {
  const { writes } = setup(t, Date.UTC(2026, 9, 23));
  const body = JSON.stringify([
    omm(25544, 'ISS (ZARYA)', '2026-10-22T18:57:11.728512'),
    omm(101031, 'DRAGON CRS-35', '2026-10-22T18:57:11.728512'),
  ]);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(url);
    return new Response(body);
  });
  const request = install(celestrakProxy());
  await request('/stations');
  await settle();
  assert.equal(new URL(seen[0]).searchParams.get('FORMAT'), 'json');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].source, 'celestrak');
  const hit = await request('/stations');
  assert.equal(hit.headers['x-tle-cache'], 'HIT');
  assert.match(hit.headers['Content-Type'], /^application\/json/);
  assert.deepEqual(
    parseOrbitalElements(hit.body).map((e) => e.omm.NORAD_CAT_ID),
    [25544, 101031],
  );
});

test('the JSON mirror is preferred, and a stale one falls back to the TLE mirror', async (t) => {
  const { writes } = setup(t, Date.UTC(2026, 9, 23));
  let jsonEpoch = '2026-10-22T12:00:00.000000';
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(url);
    if (url.includes('celestrak.')) return new Response('', { status: 403 });
    if (url.endsWith('/json/stations.json'))
      return Response.json([
        omm(25544, 'ISS (ZARYA)', jsonEpoch),
        omm(101031, 'DRAGON CRS-35', jsonEpoch),
      ]);
    if (url.endsWith('/tle/stations.tle'))
      return new Response(
        'ISS (ZARYA)\n1 25544U 98067A   26295.50000000  TLEMIRROR\n2 25544 X\n',
      );
    return new Response('no', { status: 500 });
  });
  await install(celestrakProxy())('/stations');
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].source, 'mirror');
  assert.match(writes[0].body, /"NORAD_CAT_ID":101031/);
  assert.ok(!seen.some((url) => url.endsWith('.tle')));

  jsonEpoch = '2026-10-01T00:00:00.000000'; // > 5 days old
  seen.length = 0;
  writes.length = 0;
  await install(celestrakProxy())('/stations');
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].source, 'mirror');
  assert.match(writes[0].body, /TLEMIRROR/);
});

test('SatNOGS refreshes five-digit objects of an OMM catalog and keeps six-digit ones', async (t) => {
  const prior = JSON.stringify([
    omm(25544, 'ISS (ZARYA)', '2026-10-01T00:00:00.000000', {
      OBJECT_ID: '1998-067A',
    }),
    omm(101031, 'DRAGON CRS-35', '2026-10-01T00:00:00.000000'),
  ]);
  const { writes } = setup(t, Date.UTC(2026, 9, 23), prior);
  const iss = [
    '1 25544U 98067A   26295.78971908  .00007803  00000+0  15012-3 0  9993',
    '2 25544  51.6326  58.3278 0006748 271.9059  88.1156 15.48899044590607',
  ];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('celestrak.')) return new Response('', { status: 403 });
    if (url.includes('githubusercontent'))
      return new Response('', { status: 404 });
    if (url.includes('satnogs'))
      return Response.json([
        { norad_cat_id: 25544, tle1: iss[0], tle2: iss[1] },
      ]);
    return new Response('rate limited', { status: 429 });
  });
  await install(celestrakProxy())('/stations');
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].source, 'fallback');
  const rows = JSON.parse(writes[0].body);
  assert.equal(rows[0].TLE_LINE1, iss[0]);
  assert.equal(rows[0].OBJECT_ID, '1998-067A');
  assert.equal(rows[1].NORAD_CAT_ID, 101031);
  assert.equal(rows[1].EPOCH, '2026-10-01T00:00:00.000000');
  const entries = parseOrbitalElements(writes[0].body);
  assert.deepEqual(entries[0], {
    name: 'ISS (ZARYA)',
    line1: iss[0],
    line2: iss[1],
  });
  assert.equal(entries[1].omm.NORAD_CAT_ID, 101031);
});

test('a fresh TLE cache from before the OMM switch is served but refreshed at once', async (t) => {
  const t0 = Date.UTC(2026, 9, 23);
  const { writes } = setup(t, t0);
  t.mock.method(fsp, 'readFile', async () =>
    JSON.stringify({ at: t0 - 60_000, body: OLD, source: 'mirror' }),
  );
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(url);
    return Response.json([
      omm(25544, 'ISS (ZARYA)', '2026-10-22T18:57:11.728512'),
      omm(101031, 'DRAGON CRS-35', '2026-10-22T18:57:11.728512'),
    ]);
  });
  const request = install(celestrakProxy());
  const first = await request('/stations');
  assert.equal(first.headers['x-tle-cache'], 'STALE');
  assert.equal(first.body, OLD);
  await settle();
  assert.equal(new URL(seen[0]).searchParams.get('FORMAT'), 'json');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].v, 2);
  const hit = await request('/stations');
  assert.equal(hit.headers['x-tle-cache'], 'HIT');
  assert.match(hit.body, /101031/);
  assert.equal(seen.length, 1);
});
