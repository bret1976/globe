import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenSkySource } from './index.js';

test('OpenSky getTrack skips non-ICAO ids without a request', async () => {
  const calls = [];
  const source = createOpenSkySource({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ path: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  for (const id of ['~28963e', '~ABC123', 'abc12', 'abc1234', '', null, 'zzzzzz']) {
    const out = await source.getTrack(id);
    assert.deepEqual(out.records, []);
    assert.equal(out.complete, false);
  }
  assert.equal(calls.length, 0);
  await source.getTrack('AbC123');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /opensky-track\?icao24=AbC123$/);
});
