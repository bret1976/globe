import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuFireSource } from './source.js';

test('AU fire source reads /api/au-fire and returns incidents', async () => {
  const source = createAuFireSource({
    fetchImpl: async (url, init) => {
      assert.equal(url, '/api/au-fire');
      assert.equal(init.cache, 'no-store');
      return new Response(
        JSON.stringify({
          fetchedAt: 1,
          incidents: [
            {
              id: 'nsw:1',
              state: 'NSW',
              title: 'Gospers',
              alertLevel: 'Advice',
              lon: 150.3,
              lat: -33.4,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  const payload = await source.getSnapshot();
  assert.equal(payload.incidents.length, 1);
  assert.equal(payload.incidents[0].id, 'nsw:1');
});

test('AU fire source rejects a malformed snapshot', async () => {
  const source = createAuFireSource({
    fetchImpl: async () =>
      new Response(JSON.stringify({ fetchedAt: 1 }), { status: 200 }),
  });
  await assert.rejects(source.getSnapshot(), /Malformed AU fire snapshot/);
});

test('AU fire source surfaces HTTP failures', async () => {
  const source = createAuFireSource({
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: 'down' }), { status: 502 }),
  });
  await assert.rejects(source.getSnapshot(), /AU Fire HTTP 502/);
});
