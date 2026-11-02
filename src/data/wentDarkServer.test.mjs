// Simulated AIS envelopes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  noteShipFeedStatus,
  observeShipForWentDark,
  resetShipWentDark,
  shipWentDarkSnapshot,
  wentDarkEnabled,
} from '../../server/providers/vessels/went-dark.js';

test('WENT_DARK_ENABLED switches the server detector off and on', () => {
  const prev = process.env.WENT_DARK_ENABLED;
  try {
    delete process.env.WENT_DARK_ENABLED;
    assert.equal(wentDarkEnabled(), true);
    process.env.WENT_DARK_ENABLED = '0';
    assert.equal(wentDarkEnabled(), false);
    const off = shipWentDarkSnapshot();
    assert.equal(off.status, 'off');
    assert.deepEqual(off.flagged, []);
    process.env.WENT_DARK_ENABLED = 'true';
    assert.equal(wentDarkEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.WENT_DARK_ENABLED;
    else process.env.WENT_DARK_ENABLED = prev;
  }
});

test('server snapshot flags a simulated dark ship and goes quiet when the AIS feed is not live', () => {
  resetShipWentDark();
  const T0 = 1_800_000_000_000;
  const MIN = 60_000;
  const ids = ['111111111', '222222222', '333333333', '444444444'];
  for (let i = 0; i < 10; i += 1)
    ids.forEach((mmsi, k) => observeShipForWentDark({ mmsi, lat: 40 + k * 0.01, lon: 12, speed: 12, name: `V${k}` }, T0 + i * MIN));
  let t = T0 + 9 * MIN;
  for (let i = 1; i <= 65; i += 1) {
    t = T0 + (9 + i) * MIN;
    ids.slice(1).forEach((mmsi, k) => observeShipForWentDark({ mmsi, lat: 40 + (k + 1) * 0.01, lon: 12, speed: 12 }, t));
  }
  noteShipFeedStatus('live', t);
  const snap = shipWentDarkSnapshot(t);
  assert.equal(snap.provenance, 'inferred');
  assert.equal(snap.status, 'ok');
  assert.deepEqual(snap.flagged.map((f) => f.id), ['111111111']);
  assert.equal(snap.flagged[0].label, 'V0');
  noteShipFeedStatus('reconnecting', t);
  const bad = shipWentDarkSnapshot(t);
  assert.equal(bad.status, 'degraded');
  assert.equal(bad.flagged.length, 0);
  resetShipWentDark();
});

test('ship noise filters: coastal fixes and repeat flags of the same MMSI are dropped', async () => {
  const { filterShipFlags, SHIP_FLAG_FILTER } = await import('../../server/providers/vessels/went-dark.js');
  const now = 1_800_000_000_000;
  const open = { id: '1', lat: 40, lon: 12, lastAt: now - 3_600_000 }; // Tyrrhenian Sea, open water
  const harbour = { id: '2', lat: 51.95, lon: 4.1, lastAt: now - 3_600_000 }; // Rotterdam approach
  const log = new Map([['3', { lastAt: now - 9 * 3_600_000, flaggedAt: now - 8 * 3_600_000 }]]);
  const repeat = { id: '3', lat: 40.2, lon: 12, lastAt: now - 3_600_000 };
  const out = filterShipFlags({ status: 'ok', flagged: [open, harbour, repeat], candidates: {} }, { get: (id) => log.get(id) || null }, now);
  assert.deepEqual(out.flagged.map((f) => f.id), ['1']);
  assert.equal(out.candidates.nearCoast, 1);
  assert.equal(out.candidates.repeat, 1);
  assert.equal(SHIP_FLAG_FILTER.minCoastKm, 20);
});
