// Simulated aircraft snapshots only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftWentDarkSnapshot,
  isWorldwideCoverage,
  observeAircraftSnapshot,
  resetAircraftWentDark,
  setAircraftWentDarkEnabled,
} from './wentDarkAircraft.js';

const T0 = 1_800_000_000_000;
const plane = (id, lat, t, extra = {}) => ({
  id, latitude: lat, longitude: 5, positionTimeMs: t, contactTimeMs: t,
  baroAltitudeM: 11_000, verticalRateMps: 0, onGround: false, callsign: id.toUpperCase(), ...extra,
});

test('only a worldwide snapshot can feed the detector', () => {
  assert.equal(isWorldwideCoverage('worldwide upstream snapshot'), true);
  assert.equal(isWorldwideCoverage('adsb.lol 250 nm around view'), false);
  resetAircraftWentDark();
  observeAircraftSnapshot({ observedAtMs: T0, coverage: 'regional fallback', records: [plane('a', 50, T0)] }, T0);
  const s = aircraftWentDarkSnapshot(T0);
  assert.equal(s.status, 'degraded');
  assert.match(s.reason, /regional/);
});

test('a cruising aircraft that drops out of worldwide snapshots is flagged on the feed clock', () => {
  resetAircraftWentDark();
  const ids = ['dark', 'p1', 'p2', 'p3'];
  let t = T0;
  for (let i = 0; i < 6; i += 1) {
    t = T0 + i * 15_000;
    observeAircraftSnapshot({ observedAtMs: t, coverage: 'worldwide upstream snapshot', records: ids.map((id, k) => plane(id, 50 + k * 0.01, t)) }, t);
  }
  const lastDark = t;
  for (let i = 1; i <= 16; i += 1) {
    t = lastDark + i * 15_000;
    observeAircraftSnapshot({ observedAtMs: t, coverage: 'worldwide upstream snapshot', records: ids.slice(1).map((id, k) => plane(id, 50 + (k + 1) * 0.01, t)) }, t);
  }
  // Local clock 1 hour ahead must not matter: evaluation uses feed time.
  const s = aircraftWentDarkSnapshot(t + 3_600_000 * 0);
  assert.equal(s.status, 'ok');
  assert.deepEqual(s.flagged.map((f) => f.id), ['dark']);
  assert.equal(s.flagged[0].label, 'DARK');
});

test('a stale snapshot degrades the detector; turning it off clears everything', () => {
  resetAircraftWentDark();
  observeAircraftSnapshot({ observedAtMs: T0, stale: true, coverage: 'worldwide upstream snapshot', records: [] }, T0);
  setAircraftWentDarkEnabled(false);
  assert.equal(aircraftWentDarkSnapshot().status, 'off');
  setAircraftWentDarkEnabled(true);
  assert.equal(aircraftWentDarkSnapshot().status, 'stale');
});
