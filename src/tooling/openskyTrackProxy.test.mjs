import test from 'node:test';
import assert from 'node:assert/strict';
import { trackBackfillProxies } from '../../server/providers/aircraft/tracks.js';

function mount() {
  const routes = new Map();
  const plugin = trackBackfillProxies();
  plugin.configureServer({ middlewares: { use: (p, h) => routes.set(p, h) } });
  return (url) =>
    new Promise((resolve) => {
      const headers = {};
      const res = {
        statusCode: 200,
        setHeader: (k, v) => (headers[k.toLowerCase()] = v),
        end: (body) => resolve({ status: res.statusCode, headers, body: JSON.parse(body) }),
      };
      routes.get('/api/opensky-track')({ url }, res);
    });
}

test('opensky track: upstream outage answers a friendly empty path, retries once, then pauses', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('timeout');
  };
  try {
    const get = mount();
    const r = await get('/api/opensky-track?icao24=abc123');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.path, []);
    assert.equal(r.body.fallback, 'local-trail');
    assert.match(r.body.message, /recorded/);
    assert.equal(calls, 2);
    await get('/api/opensky-track?icao24=abc123'); // cached failure
    assert.equal(calls, 2);
    await get('/api/opensky-track?icao24=abc124');
    await get('/api/opensky-track?icao24=abc125'); // third failure trips breaker
    const before = calls;
    const p = await get('/api/opensky-track?icao24=abc126');
    assert.equal(p.body.reason, 'upstream_paused');
    assert.equal(calls, before);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('opensky track: success is passed through and cached', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  const payload = { icao24: 'def456', path: [[1, 10, 20, 1000, 90, false]] };
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  try {
    const get = mount();
    const r = await get('/api/opensky-track?icao24=def456');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, payload);
    await get('/api/opensky-track?icao24=def456');
    assert.equal(calls, 1);
    const bad = await get('/api/opensky-track?icao24=zz');
    assert.equal(bad.status, 400);
  } finally {
    globalThis.fetch = realFetch;
  }
});
