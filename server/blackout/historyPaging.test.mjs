// SIMULATED flags only — nothing here is live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivity } from './activity.js';

test('history list pages with limit/offset, newest first', () => {
  const T = 1_800_000_000_000;
  const flags = Array.from({ length: 150 }, (_, i) => ({ id: `s${i}`, label: `s${i}`, lat: 10, lon: 10, lastAt: T + i * 1000, flaggedAt: T + i * 1000 + 1 }));
  const act = createActivity({ now: () => T + 10_000_000, sources: { shipFlags: () => flags } });
  act.tick(T + 10_000_000);
  const all = act.historyList({ limit: 1000 });
  assert.equal(all.total, 150);
  assert.equal(all.rows.length, 150);
  const p1 = act.historyList({ limit: 100 });
  const p2 = act.historyList({ limit: 100, offset: 100 });
  assert.equal(p1.rows.length, 100);
  assert.equal(p2.rows.length, 50);
  assert.equal(p2.offset, 100);
  assert.equal(p1.rows[0].id, 's149');
  assert.equal(p2.rows[49].id, 's0');
});
