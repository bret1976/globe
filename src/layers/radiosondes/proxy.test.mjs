import test from 'node:test';
import assert from 'node:assert/strict';
import { radiosondesProxy } from '../../../server/providers/radiosondes.js';
import { RADIOSONDES_URL } from './parse.js';

const NOW = Date.parse('2026-10-07T14:30:00Z');

function harness(fetchImpl, clock = { t: NOW }) {
  const plugin = radiosondesProxy({ fetchImpl, now: () => clock.t });
  let handler;
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/radiosondes');
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

const SONDES = {
  Y1: {
    serial: 'Y1',
    subtype: 'RS41-SG',
    datetime: '2026-10-07T14:20:00Z',
    lat: 52.1,
    lon: 5.2,
    alt: 18000,
    vel_v: 5,
    uploader_callsign: 'HAM1',
    uploader_position: '52.0,5.0',
  },
};

test('serves normalized rows, caches, and never leaks receiver stations', async () => {
  let calls = 0;
  const { call, clock } = harness(async (url) => {
    calls += 1;
    assert.equal(url, RADIOSONDES_URL);
    return Response.json(SONDES);
  });
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 1);
  assert.equal(first.body.rawCount, 1);
  assert.equal(first.body.rows[0].phase, 'ascending');
  assert.equal(first.body.license, 'CC BY-SA 2.0');
  assert.equal(JSON.stringify(first.body).includes('HAM1'), false);
  assert.equal(JSON.stringify(first.body).includes('52.0,5.0'), false);
  clock.t += 60_000;
  await call();
  assert.equal(calls, 1);
});

test('serves stale on upstream failure, 502 when nothing cached', async () => {
  let fail = false;
  const { call, clock } = harness(async () => {
    if (fail) return new Response('down', { status: 503 });
    return Response.json(SONDES);
  });
  await call();
  fail = true;
  clock.t += 5 * 60_000;
  const stale = await call();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');

  const empty = harness(async () => new Response('down', { status: 503 }));
  const res = await empty.call();
  assert.equal(res.status, 502);
});
