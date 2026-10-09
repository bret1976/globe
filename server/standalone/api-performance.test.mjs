import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import {
  apiCompressionPlugin,
  apiKeepWarmPlugin,
  createApiCompressionMiddleware,
} from './api-performance.js';

function serve(handler) {
  const mw = createApiCompressionMiddleware();
  const server = http.createServer((req, res) =>
    mw(req, res, () => handler(req, res)),
  );
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server)),
  );
}

function get(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: '127.0.0.1', port: server.address().port, path, headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
        },
      )
      .on('error', reject);
  });
}

test('gzips large /api JSON for clients that accept it', async () => {
  const payload = JSON.stringify({
    points: Array.from({ length: 5000 }, (_, i) => i),
  });
  const server = await serve((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  });
  try {
    const zipped = await get(server, '/api/earthquakes', {
      'accept-encoding': 'gzip',
    });
    assert.equal(zipped.res.headers['content-encoding'], 'gzip');
    assert.ok(zipped.body.length < payload.length / 2);
    assert.equal(gunzipSync(zipped.body).toString(), payload);
    const plain = await get(server, '/api/earthquakes');
    assert.equal(plain.res.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString(), payload);
    const page = await get(server, '/index.html', {
      'accept-encoding': 'gzip',
    });
    assert.equal(page.res.headers['content-encoding'], undefined);
  } finally {
    server.close();
  }
});

test('preview hooks return nothing (Vite runs returned functions as post-hooks)', () => {
  const server = { middlewares: { use: () => () => {} }, httpServer: null };
  assert.equal(
    apiCompressionPlugin().configurePreviewServer(server),
    undefined,
  );
  assert.equal(
    apiKeepWarmPlugin({ enabled: () => true }).configurePreviewServer(server),
    undefined,
  );
});

test('SWR answers repeat clicks from the last good body and refreshes in the background', async () => {
  const { createSwrStore } = await import('./api-performance.js');
  let upstreamHits = 0;
  let clock = 1_000_000;
  let version = 1;
  const server = http.createServer();
  const store = createSwrStore({
    endpoints: { '/api/feed': { refreshAfterMs: 30_000, maxStaleMs: 600_000 } },
    now: () => clock,
  });
  server.on('request', (req, res) =>
    store.middleware(req, res, () => {
      upstreamHits += 1;
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-feed': String(version),
      });
      res.end(JSON.stringify({ version, pad: 'x'.repeat(4000) }));
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  store.setBase(`http://127.0.0.1:${server.address().port}`);
  try {
    const first = await get(server, '/api/feed');
    assert.equal(JSON.parse(first.body).version, 1);
    // copy captured after the first response
    for (let i = 0; i < 50 && !store.has('/api/feed'); i += 1)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(store.has('/api/feed'));
    const hitsAfterFill = upstreamHits;
    version = 2;
    const cached = await get(server, '/api/feed', {
      'accept-encoding': 'gzip',
    });
    assert.equal(cached.res.headers['content-encoding'], 'gzip');
    assert.equal(JSON.parse(gunzipSync(cached.body)).version, 1);
    assert.equal(cached.res.headers['x-feed'], '1');
    assert.equal(
      upstreamHits,
      hitsAfterFill,
      'fresh copy served without the proxy',
    );
    clock += 31_000; // older than refreshAfterMs: served at once, refreshed behind
    const stale = await get(server, '/api/feed');
    assert.equal(JSON.parse(stale.body).version, 1);
    for (let i = 0; i < 50 && upstreamHits === hitsAfterFill; i += 1)
      await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 30));
    const refreshed = await get(server, '/api/feed');
    assert.equal(JSON.parse(refreshed.body).version, 2);
    clock += 10 * 60_000 + 1; // beyond maxStaleMs: never served
    version = 3;
    const expired = await get(server, '/api/feed');
    assert.equal(JSON.parse(expired.body).version, 3);
    const withQuery = await get(server, '/api/feed?x=1');
    assert.equal(JSON.parse(withQuery.body).version, 3);
  } finally {
    server.close();
  }
});
