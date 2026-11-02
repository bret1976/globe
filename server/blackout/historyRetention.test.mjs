// Simulated flags only: checks the 90-day history is no longer cut at 20,000
// rows and that the split files restore after a restart (incl. v1 migration).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivity, HISTORY_MAX_BY_KIND } from './activity.js';
import { createPersistStore, MAX_FILE_BYTES } from './persist.js';

const DAY = 86_400_000;

test('90 days of ship + aircraft history survive a restart, beyond the old 20k cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-hist-'));
  const T = 1_800_000_000_000;
  const ships = [], mil = [];
  // 90 days x 400 ship flags + 165 aircraft flags = 50,850 rows.
  for (let d = 0; d < 90; d++) {
    for (let i = 0; i < 400; i++) ships.push({ id: `${200000000 + i}`, lat: 40, lon: 12, lastAt: T - (89 - d) * DAY + i * 1000, flaggedAt: T - (89 - d) * DAY + i * 1000 + 3_600_000, speed: 10 });
    for (let i = 0; i < 165; i++) mil.push({ id: `ae${i}`, lat: 50, lon: 20, lastAt: T - (89 - d) * DAY + i * 1000, flaggedAt: T - (89 - d) * DAY + i * 1000 + 1_200_000 });
  }
  const store = createPersistStore({ dir, warn: () => {} });
  const a = createActivity({ store, now: () => T + 2 * 3_600_000, sources: { shipFlags: () => ships, milFlags: () => mil } });
  a.tick();
  assert.equal(a.status().history, ships.length + mil.length);
  store.flushSync();
  for (const f of ['history-ships.json', 'history-aircraft.json', 'activity.json']) {
    const b = fs.statSync(path.join(dir, f)).size;
    assert.ok(b < MAX_FILE_BYTES, `${f} ${b}`);
  }
  const store2 = createPersistStore({ dir, warn: () => {} });
  const b = createActivity({ store: store2, now: () => T + 2 * 3_600_000, sources: {} });
  assert.equal(b.status().restoredHistory, ships.length + mil.length);
  assert.equal(b.historyList({ kind: 'military-aircraft', limit: 1 }).total, mil.length);
  assert.ok(HISTORY_MAX_BY_KIND.ship >= 90 * 1000);
});

test('v1 activity.json (history inside) migrates to the split files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-mig-'));
  const T = 1_800_000_000_000;
  const h = { key: 'ship:1:5', id: '1', kind: 'ship', label: 'X', lat: 1, lon: 2, place: 'p', areas: [], lastSeenAt: 5, flaggedAt: T - DAY, reappearedAt: null, durationMin: null };
  fs.writeFileSync(path.join(dir, 'activity.json'), JSON.stringify({ v: 1, seq: 7, events: [{ id: '7', at: T - DAY, type: 'went_dark' }], history: [h] }));
  const store = createPersistStore({ dir, warn: () => {} });
  const a = createActivity({ store, now: () => T, sources: {} });
  assert.equal(a.status().history, 1);
  assert.equal(a.status().events, 1);
  store.flushSync();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'history-ships.json'), 'utf8'));
  assert.equal(saved.rows.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'activity.json'), 'utf8')).history, undefined);
});
