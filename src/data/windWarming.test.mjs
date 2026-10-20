import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windProxy } from '../../server/providers/wind.js';

/** Fresh empty cache dir so a dev machine's .gev-cache/wind.json is ignored. */
function tempCacheDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-wind-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  const handler = [...routes.values()][0];
  return async () => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url: '/', method: 'GET' }, res, () => {});
    return res;
  };
}

test('wind first request returns warming instead of blocking on Open-Meteo', async (t) => {
  const abort = new AbortController();
  t.mock.method(
    globalThis,
    'fetch',
    () =>
      new Promise((_, reject) => {
        abort.signal.addEventListener(
          'abort',
          () => reject(new Error('test done')),
          { once: true },
        );
      }),
  );
  t.after(() => abort.abort());
  const started = Date.now();
  const res = await install(windProxy({ cacheDir: tempCacheDir(t) }))();
  assert.ok(Date.now() - started < 1000, 'must not wait for the GFS grid');
  const body = JSON.parse(res.body);
  assert.equal(body.warming, true);
  assert.deepEqual(body.samples, []);
  assert.equal(body.model, 'gfs');
});

test('wind proxy backs off after a failed refresh instead of retrying each request', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        error: true,
        reason: 'Daily API request limit exceeded',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  });
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const request = install(windProxy({ cacheDir: tempCacheDir(t) }));
  const first = JSON.parse((await request()).body);
  assert.equal(first.warming, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterFirst = calls;
  assert.ok(afterFirst >= 1);
  for (let i = 0; i < 3; i += 1) {
    const body = JSON.parse((await request()).body);
    assert.equal(body.warming, true);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, afterFirst, 'no new Open-Meteo calls during the backoff');
  assert.ok(
    warnings.some((line) => line.includes('Daily API request limit exceeded')),
    'logs the Open-Meteo reason',
  );
});
