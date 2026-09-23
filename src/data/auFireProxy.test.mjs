import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { auFireProxy } from '../../server/providers/auFire.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return routes.get('/api/au-fire');
}

function request(handler, { method = 'GET', url = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([]);
    Object.assign(req, {
      method,
      url,
      headers: { host: 'localhost:4173' },
    });
    const headers = {};
    const res = {
      statusCode: 200,
      headersSent: false,
      writeHead(status, values) {
        this.statusCode = status;
        this.headersSent = true;
        Object.assign(headers, values);
      },
      end(body = '') {
        resolve({
          status: this.statusCode,
          headers,
          json: () => JSON.parse(String(body)),
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('AU fire proxy merges NSW + VIC public feeds and drops non-fire VIC rows', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    if (href.includes('rfs.nsw.gov.au')) {
      return Response.json({
        features: [
          {
            id: 'guid-1',
            properties: {
              guid: 'guid-1',
              title: 'Blue Mountains',
              category: 'Watch and Act',
              description:
                'STATUS: Being controlled<br />TYPE: Bush Fire<br />FIRE: Yes<br />SIZE: 120 ha',
            },
            geometry: { type: 'Point', coordinates: [150.3, -33.7] },
          },
        ],
      });
    }
    if (href.includes('emergency.vic.gov.au')) {
      return Response.json({
        features: [
          {
            properties: {
              id: 'vic-1',
              name: 'Gippsland',
              category2: 'Fire',
              category1: 'Advice',
              cap: { category: 'Fire' },
              sizeFmt: '9.57 Ha.',
            },
            geometry: { type: 'Point', coordinates: [147.6, -37.8] },
          },
          {
            properties: {
              id: 'vic-flood',
              name: 'Flood watch',
              category2: 'Flood',
              cap: { category: 'Met' },
            },
            geometry: { type: 'Point', coordinates: [144.9, -37.8] },
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${href}`);
  });

  const handler = install(auFireProxy());
  const first = await request(handler);
  assert.equal(first.status, 200);
  const payload = first.json();
  assert.equal(payload.incidents.length, 2);
  assert.deepEqual(
    payload.incidents.map((row) => row.id),
    ['nsw:guid-1', 'vic:vic-1'],
  );
  assert.equal(payload.incidents[0].alertLevel, 'Watch and Act');
  assert.equal(payload.incidents[0].sizeHa, 120);
  assert.equal(payload.incidents[1].alertLevel, 'Advice');
  assert.equal(payload.incidents[1].sizeHa, 9.57);

  const cached = await request(handler);
  assert.equal(cached.json().fetchedAt, payload.fetchedAt);
});
