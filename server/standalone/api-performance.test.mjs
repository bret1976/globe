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
