import test from 'node:test';
import assert from 'node:assert/strict';
import { coralBleachingProxy } from '../../server/providers/coralBleaching.js';
import { createCoralBleachingSource } from '../layers/coralBleaching/source.js';

const CSV = [
  'time,latitude,longitude,CRW_BAA,CRW_DHW,CRW_SST,CRW_SSTANOMALY,CRW_HOTSPOT',
  'UTC,degrees_north,degrees_east,1,Celsius weeks,Celsius,Celsius,Celsius',
  '2026-10-18T12:00:00Z,-18.025,147.025,3,5,29,1.5,1.2',
].join('\n');

function install(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(_r, fn) {
        handler = fn;
      },
    },
  });
  return () =>
    new Promise((resolve) => {
      const res = {
        writeHead(status) {
          this.status = status;
        },
        end(body) {
          resolve({ status: this.status, body: JSON.parse(body) });
        },
      };
      handler({ method: 'GET', url: '/' }, res, () => {});
    });
}

test('proxy falls back to PacIOOS ERDDAP when the CRW host times out', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const plugin = coralBleachingProxy({
    sleep: async () => {},
    diskCache: null,
    fetchImpl: async (url) => {
      if (String(url).includes('coralreefwatch.noaa.gov'))
        throw Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
        });
      return new Response(CSV, { status: 200 });
    },
  });
  const r = await install(plugin)();
  assert.equal(r.status, 200);
  assert.equal(r.body.fallback, 'erddap');
  assert.equal(r.body.rows.length, 1);
});

test('browser loads ERDDAP directly when the proxy answers 502', async () => {
  const source = createCoralBleachingSource({
    fetchImpl: async (url) =>
      url === '/api/coral-bleaching'
        ? Response.json({ error: 'down' }, { status: 502 })
        : new Response(CSV, { status: 200 }),
  });
  const snap = await source.getSnapshot();
  assert.equal(snap.browserDirect, true);
  assert.equal(snap.rows[0].level, 3);
});
