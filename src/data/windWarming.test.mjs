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

function erddapTable(rows) {
  return {
    table: {
      columnNames: ['time', 'latitude', 'longitude', 'ugrd10m', 'vgrd10m'],
      columnTypes: ['String', 'double', 'double', 'float', 'float'],
      columnUnits: ['UTC', 'degrees_north', 'degrees_east', 'm s-1', 'm s-1'],
      rows,
    },
  };
}

test('wind proxy fills the grid from one NOAA GFS ERDDAP request', async (t) => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify(
        erddapTable([
          ['2026-10-25T15:00:00Z', 52, 4, -12, 1.5],
          ['2026-10-25T15:00:00Z', 36, 244, 0.3, -0.2],
        ]),
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const request = install(windProxy({ cacheDir: tempCacheDir(t), fetchImpl }));
  await request();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const body = JSON.parse((await request()).body);
  assert.equal(urls.length, 1, 'one request for the whole lattice');
  assert.match(urls[0], /pacioos\.hawaii\.edu\/erddap\/griddap\/ncep_global\.json\?ugrd10m/);
  assert.ok(!urls.some((url) => url.includes('open-meteo')));
  assert.equal(body.samples.length, 2);
  assert.equal(body.provider, 'noaa-gfs-pacioos');
  assert.equal(body.valid, '2026-10-25T15:00');
  assert.deepEqual(body.samples[1], { lat: 36, lon: -116, speed: 1.3, direction: 304 });
  assert.equal(body.samples[0].direction, 97);
  assert.ok(!body.warming);
});

test('wind proxy falls back to paced Open-Meteo batches when ERDDAP fails', async (t) => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('erddap')) return new Response('down', { status: 502 });
    const lats = new URL(String(url)).searchParams.get('latitude').split(',');
    return new Response(
      JSON.stringify(
        lats.map((lat) => ({
          latitude: Number(lat),
          longitude: 10,
          current: { time: '2026-10-25T14:00', wind_speed_10m: 20, wind_direction_10m: 270 },
        })),
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  t.mock.method(console, 'warn', () => {});
  const request = install(
    windProxy({ cacheDir: tempCacheDir(t), fetchImpl, chunkGapMs: 0 }),
  );
  await request();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const body = JSON.parse((await request()).body);
  assert.ok(urls[0].includes('erddap'));
  assert.ok(urls.slice(1).every((url) => url.startsWith('https://api.open-meteo.com/')));
  assert.equal(body.provider, 'open-meteo');
  assert.equal(body.samples.length, 765);
});
