import test from 'node:test';
import assert from 'node:assert/strict';
import { windProxy } from '../../server/providers/wind.js';

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
  const res = await install(windProxy())();
  assert.ok(Date.now() - started < 1000, 'must not wait for the GFS grid');
  const body = JSON.parse(res.body);
  assert.equal(body.warming, true);
  assert.deepEqual(body.samples, []);
  assert.equal(body.model, 'gfs');
});
