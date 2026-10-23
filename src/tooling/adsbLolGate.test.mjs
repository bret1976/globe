import test from 'node:test';
import assert from 'node:assert/strict';
import * as providers from '../../server/providers/live.js';
import {
  adsbLolCooldownRemainingMs,
  adsbLolMayRequest,
  noteAdsbLolResponse,
  resetAdsbLolGate,
} from '../../server/providers/aircraft/adsbLolGate.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (route, url = '/') => {
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [key, value] of Object.entries(headers))
          this.setHeader(key, value);
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get(route)({ url, method: 'GET' }, response);
    return response;
  };
}

const freshOpenSky = async (tag) =>
  install(
    (
      await import(
        `../../server/providers/aircraft/opensky.js?gate=${tag}-${Math.random()}`
      )
    ).openSkyProxy(),
  );

const frame = (hex, lat, lon) =>
  Response.json({
    now: Date.now() / 1000,
    ac: [{ hex, lat, lon, alt_baro: 9000 }],
  });

test.beforeEach(() => {
  resetAdsbLolGate();
  process.env.OPENSKY_AUTH_MODE = 'anon';
});

test('the gate honours Retry-After, doubles repeated 429s and resets on success', () => {
  const now = 1_000_000;
  assert.equal(adsbLolMayRequest(now), true);
  noteAdsbLolResponse(429, new Headers({ 'Retry-After': '45' }), now);
  assert.equal(adsbLolCooldownRemainingMs(now), 45_000);
  assert.equal(adsbLolMayRequest(now + 44_999), false);
  resetAdsbLolGate();
  noteAdsbLolResponse(429, new Headers(), now);
  assert.equal(adsbLolCooldownRemainingMs(now), 30_000);
  noteAdsbLolResponse(429, new Headers(), now + 30_000);
  assert.equal(adsbLolCooldownRemainingMs(now + 30_000), 60_000);
  noteAdsbLolResponse(429, new Headers({ 'Retry-After': '99999' }), now);
  assert.equal(adsbLolCooldownRemainingMs(now), 600_000);
  noteAdsbLolResponse(200, new Headers(), now + 700_000);
  noteAdsbLolResponse(429, new Headers(), now + 700_000);
  assert.equal(adsbLolCooldownRemainingMs(now + 700_000), 30_000);
});

test('a regional 429 pauses adsb.lol for flights and military, serving last-good frames', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  let limited = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    if (String(url).includes('/states/'))
      return new Response('', { status: 503 });
    if (limited) return new Response('{}', { status: 429 });
    if (String(url).includes('/v2/mil')) return Response.json({ ac: [] });
    return frame('abc123', 30, -97);
  });
  const opensky = await freshOpenSky('pause');
  const mil = install(providers.adsbLolProxy());
  assert.equal((await opensky('/api/opensky', '?lat=30&lon=-97')).statusCode, 200);
  assert.equal((await mil('/api/adsblol/mil')).statusCode, 200);

  now += 13_000;
  limited = true;
  calls.length = 0;
  const stale = await opensky('/api/opensky', '?lat=30&lon=-97');
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.headers['x-opensky-cache'], 'STALE');
  assert.equal(stale.headers['x-flight-stale-seconds'], '13');
  assert.equal(JSON.parse(stale.body).states[0][0], 'abc123');
  assert.equal(calls.filter((url) => url.includes('/lat/')).length, 1);

  // Every adsb.lol route now waits out the shared cooldown without calling.
  calls.length = 0;
  now += 1_000;
  assert.equal(
    (await opensky('/api/opensky', '?lat=30&lon=-97')).headers['x-opensky-cache'],
    'STALE',
  );
  const milStale = await mil('/api/adsblol/mil');
  assert.equal(milStale.statusCode, 200);
  assert.equal(milStale.headers['x-ads-b-cache'], 'STALE');
  assert.equal(milStale.headers['x-ads-b-upstream-status'], '429');
  assert.deepEqual(
    calls.filter((url) => url.includes('adsb.lol')),
    [],
  );
});

test('a never-fetched view borrows a nearby anchor frame instead of a 502', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let limited = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/states/'))
      return new Response('', { status: 503 });
    if (limited) return new Response('{}', { status: 429 });
    return frame('near01', 30, -97);
  });
  const opensky = await freshOpenSky('near');
  await opensky('/api/opensky', '?lat=30&lon=-97');
  limited = true;
  now += 60_000;
  const near = await opensky('/api/opensky', '?lat=31&lon=-98');
  assert.equal(near.statusCode, 200);
  assert.equal(near.headers['x-opensky-cache'], 'STALE-NEAR');
  assert.equal(near.headers['x-flight-stale-seconds'], '60');
  assert.equal(JSON.parse(near.body).states[0][0], 'near01');
  // Too far away to stand in for this view.
  const far = await opensky('/api/opensky', '?lat=51.5&lon=-0.1');
  assert.notEqual(far.headers['x-flight-source'], 'adsb.lol');
});

test('frozen frames past 20 minutes are not served, and a failing anchor is asked once per hold', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let failing = false;
  const regional = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/states/'))
      return new Response('', { status: 503 });
    regional.push(String(url));
    if (failing) throw new Error('network down');
    return frame('old001', 30, -97);
  });
  const opensky = await freshOpenSky('frozen');
  await opensky('/api/opensky', '?lat=30&lon=-97');
  failing = true;
  now += 21 * 60_000;
  regional.length = 0;
  const response = await opensky('/api/opensky', '?lat=30&lon=-97');
  assert.notEqual(response.headers['x-flight-source'], 'adsb.lol');
  // One upstream attempt even though the handler falls through several
  // regional-fallback branches.
  assert.equal(regional.length, 1);
  now += 2_000;
  await opensky('/api/opensky', '?lat=30&lon=-97');
  assert.equal(regional.length, 1);
});
