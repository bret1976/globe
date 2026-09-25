import test from 'node:test';
import assert from 'node:assert/strict';
import { earthquakesProxy } from '../../server/providers/earthquakes.js';
import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';

function install(options = {}) {
  let handler;
  const plugin = earthquakesProxy(options);
  plugin.configurePreviewServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/earthquakes');
        handler = callback;
      },
    },
  });
  return async (method = 'GET') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ method, url: '/' }, res, () => {
      res.status = 404;
      res.body = { error: 'next' };
    });
    return res;
  };
}

const feature = {
  id: 'ci123',
  properties: {
    mag: 4.2,
    place: 'Test',
    time: 1_700_000_000_000,
    updated: 1_700_000_000_000,
    type: 'earthquake',
    status: 'reviewed',
  },
  geometry: { type: 'Point', coordinates: [-118.2, 34.1, 10] },
};

test('earthquakes proxy normalizes USGS geojson and caches briefly', async () => {
  let calls = 0;
  const request = install({
    now: (() => {
      let t = 1000;
      return () => t;
    })(),
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ type: 'FeatureCollection', features: [feature] });
    },
  });
  const a = await request();
  assert.equal(a.status, 200);
  assert.equal(a.body.count, 1);
  assert.equal(a.body.rows[0].mag, 4.2);
  const b = await request();
  assert.equal(b.status, 200);
  assert.equal(calls, 1, 'TTL should avoid a second upstream fetch');
});

test('client source prefers proxy rows then falls back to USGS', async () => {
  const urls = [];
  const source = createUsgsEarthquakeSource({
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes('/api/earthquakes')) {
        return {
          ok: false,
          status: 404,
          async json() {
            return { error: 'Unknown API route' };
          },
        };
      }
      return Response.json({ type: 'FeatureCollection', features: [feature] });
    },
  });
  const rows = await source.getSnapshot();
  assert.equal(rows.length, 1);
  assert.equal(urls[0], '/api/earthquakes');
  assert.match(urls[1], /earthquake\.usgs\.gov/);
});
