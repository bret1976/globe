import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWentDark, wentDarkInfo, wentDarkItemText } from './model.js';
import { createWentDarkSource } from './source.js';

test('ships and aircraft merge most-recent-first with server skew removed', () => {
  const snap = {
    ships: { status: 'ok', generatedAt: 1000, receivedAtMs: 1500, flagged: [{ id: 's', label: 'SHIP A', lastAt: 100 }], tracked: 1, steady: 1 },
    aircraft: { status: 'ok', feedNowMs: 2000, flagged: [{ id: 'a', label: 'AIR B', lastAt: 900 }], tracked: 1, steady: 1 },
  };
  const items = mergeWentDark(snap, { localNowMs: 2000 });
  assert.deepEqual(items.map((i) => i.id), ['a', 's']);
  assert.equal(items[1].lastAtLocal, 600);
  assert.match(wentDarkItemText(items[0], 900 + 5 * 60_000), /AIR B · last seen 5 min ago/);
});

test('the row says plainly when a feed is stale instead of listing silences', () => {
  const info = wentDarkInfo({
    ships: { status: 'stale', reason: 'no reports for 12 min', flagged: [] },
    aircraft: { status: 'ok', flagged: [], tracked: 10, steady: 4 },
  });
  assert.match(info, /Ships: AIS feed is stale \(no reports for 12 min\) — not flagging/);
  assert.match(info, /Aircraft: 0 went dark · watching 4 steady of 10 tracked/);
});

test('the source degrades honestly when the server endpoint fails', async () => {
  const source = createWentDarkSource({
    fetchImpl: async () => new Response('nope', { status: 503 }),
    aircraft: () => ({ status: 'stale', flagged: [] }),
  });
  const snap = await source.getSnapshot();
  assert.equal(snap.ships.status, 'stale');
  assert.match(snap.ships.reason, /503/);
  assert.deepEqual(snap.ships.flagged, []);
});
