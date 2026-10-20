import test from 'node:test';
import assert from 'node:assert/strict';
import { cyclonesProxy } from '../../server/providers/cyclones.js';

function install(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(route, fn) {
        handler = fn;
      },
    },
  });
  return () =>
    new Promise((resolve) => {
      const res = {
        statusCode: 200,
        setHeader() {},
        end(body) {
          resolve({ statusCode: this.statusCode, body: JSON.parse(body) });
        },
      };
      handler({ url: '/', method: 'GET' }, res, () => {});
    });
}

const EONET = {
  events: [
    {
      id: 'EONET_1',
      title: 'Super Typhoon Test',
      geometry: [
        { date: '2026-10-20T06:00:00Z', type: 'Point', coordinates: [130, 18] },
      ],
    },
  ],
};

test('cyclones proxy keeps the last good EONET storms when one refresh fails', async (t) => {
  let eonetUp = true;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('nhc.noaa.gov'))
      return Response.json({ activeStorms: [] });
    if (!eonetUp) throw new Error('connect timeout');
    return Response.json(EONET);
  });
  const nowReal = Date.now;
  let offset = 0;
  t.mock.method(Date, 'now', () => nowReal() + offset);
  const request = install(cyclonesProxy());
  const first = await request();
  assert.equal(first.body.storms.length, 1);
  eonetUp = false;
  offset = 4 * 60_000; // past the 3 min TTL, inside the 20 min stale window
  const second = await request();
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.storms.length, 1, 'storms kept through one miss');
  offset = 30 * 60_000; // past the stale window: honest empty list
  const third = await request();
  assert.equal(third.body.storms.length, 0);
});
