// A layer whose first fetch hangs must not leave the toggle ENABLING forever:
// enable settles after the per-layer deadline, the row reports "loading data…",
// and the late answer is still adopted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from './manager.js';

test('enable settles after the first-update deadline and adopts the late result', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let count = 0;
  const mgr = new DataLayerManager({});
  mgr.register({
    id: 'slow-feed',
    name: 'Slow',
    icon: '',
    source: 'test',
    updateInterval: 60_000,
    firstUpdateDeadlineMs: 50,
    init() {},
    enable() {},
    disable() {},
    async update() {
      await gate;
      count = 7;
      return true;
    },
    getStats() {
      return { count, lastUpdate: count ? Date.now() : null };
    },
  });
  const started = Date.now();
  await mgr.setEnabled('slow-feed', true, { origin: 'user' });
  assert.ok(
    Date.now() - started < 2000,
    'enable must not wait for the hung fetch',
  );
  assert.equal(mgr.isEnabled('slow-feed'), true);
  const pending = mgr.getAll().find((l) => l.id === 'slow-feed');
  assert.equal(pending.stats.loading, true);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const settled = mgr.getAll().find((l) => l.id === 'slow-feed');
  assert.equal(settled.stats.loading, false);
  assert.equal(settled.stats.count, 7);
  await mgr.setEnabled('slow-feed', false);
  mgr.destroyAll?.();
});
