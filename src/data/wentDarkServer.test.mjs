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
    ids.forEach((mmsi, k) => observeShipForWentDark({ mmsi, lat: 40 + k * 0.01, lon: 10, speed: 12, name: `V${k}` }, T0 + i * MIN));
  let t = T0 + 9 * MIN;
  for (let i = 1; i <= 25; i += 1) {
    t = T0 + (9 + i) * MIN;
    ids.slice(1).forEach((mmsi, k) => observeShipForWentDark({ mmsi, lat: 40 + (k + 1) * 0.01, lon: 10, speed: 12 }, t));
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
