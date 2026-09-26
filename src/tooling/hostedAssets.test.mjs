import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import {
  hostedAssetsMiddleware,
  hostedAssetsPlugin,
} from '../../build/hostedAssets.js';
import { createBrowserViteConfig } from '../../build/vite.js';

function mockRes() {
  const headers = {};
  let payload = null;
  const res = {
    statusCode: 200,
    headers,
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    removeHeader(name) {
      delete headers[String(name).toLowerCase()];
    },
    writeHead(status) {
      this.statusCode = status;
    },
    write(chunk) {
      const next = Buffer.from(chunk);
      payload = payload ? Buffer.concat([payload, next]) : next;
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.body = payload || Buffer.alloc(0);
    },
  };
  return res;
}

test('preview plugin is registered on the browser Vite config', () => {
  const plugin = hostedAssetsPlugin();
  assert.equal(plugin.name, 'gev-hosted-assets');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  assert.equal(plugin.configureServer, undefined);
  assert.equal(
    createBrowserViteConfig().plugins.some((item) => item.name === plugin.name),
    true,
  );
});

test('hashed assets are gzipped and long-cached for preview clients', async () => {
  const middleware = hostedAssetsMiddleware();
  const res = mockRes();
  const body = Buffer.from(`${'A'.repeat(2048)};console.log('cesium');`);
  await new Promise((resolve) => {
    middleware(
      {
        url: '/cesium/Cesium.js',
        headers: { 'accept-encoding': 'gzip, deflate, br' },
      },
      res,
      () => {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(body);
        resolve();
      },
    );
  });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(
    res.headers['cache-control'],
    'public, max-age=31536000, immutable',
  );
  assert.equal(gunzipSync(res.body).toString(), body.toString());
  assert.ok(res.body.length < body.length);
});

test('API JSON is left uncompressed so live feeds stay no-store', async () => {
  const middleware = hostedAssetsMiddleware();
  const res = mockRes();
  const body = Buffer.from(JSON.stringify({ samples: [] }));
  await new Promise((resolve) => {
    middleware(
      { url: '/api/wind', headers: { 'accept-encoding': 'gzip' } },
      res,
      () => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
        resolve();
      },
    );
  });
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.toString(), body.toString());
});
