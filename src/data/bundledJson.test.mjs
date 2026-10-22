import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBundledJson } from './bundledJson.js';

const MARINE = new URL(
  './local_data/natural_earth/marine.json',
  import.meta.url,
);

test('bundled JSON: a file URL is read from disk under Node', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch');
  const pack = await loadBundledJson(MARINE);
  assert.ok(pack.features.some((ft) => ft.name === 'Gulf of Mexico'));
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('bundled JSON: a served URL is fetched as plain JSON', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return new Response('{"features":[]}', {
      headers: { 'content-type': 'application/json' },
    });
  });
  const url = new URL(
    'http://localhost/src/data/local_data/natural_earth/marine.json',
  );
  assert.deepEqual(await loadBundledJson(url), { features: [] });
  assert.deepEqual(requests, [url.href]);
});

test('bundled JSON: an HTTP error rejects so the retryable loader can retry', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 404 }),
  );
  await assert.rejects(
    loadBundledJson(new URL('http://localhost/missing.json')),
    /HTTP 404/,
  );
});

test('bundled JSON: an aborted load rejects before reading', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadBundledJson(MARINE, { signal: controller.signal }), {
    name: 'AbortError',
  });
});

// Upstream's repo-wide "no JSON pack imported as a module" guard is not
// ported: this fork still imports a few packs directly (separate migration).

test('bundled JSON: an older Node says which version is needed', async (t) => {
  // Node before 20.16 / 22.3 has no process.getBuiltinModule.
  const original = process.getBuiltinModule;
  t.after(() => {
    process.getBuiltinModule = original;
  });
  process.getBuiltinModule = undefined;
  await assert.rejects(loadBundledJson(MARINE), {
    message: /needs Node 24\.14 or newer to read marine\.json/,
  });
});
