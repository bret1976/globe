import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { celestrakProxy } from '../../server/providers/space/celestrak.js';
import { fallbackTleUrl } from '../data/spaceProviderRequests.js';

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

function setup(t, t0) {
  let now = t0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(fsp, 'readFile', async () =>
    JSON.stringify({ at: t0 - 7 * 3600_000, body: OLD }),
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
