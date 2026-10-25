// All went-dark tests use SIMULATED targets — nothing here is live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIRCRAFT_DARK_CONFIG,
  SHIP_DARK_CONFIG,
  WENT_DARK_ENABLED_DEFAULT,
  createDarkTracker,
  describeDarkStatus,
  isMovingReport,
  lastSeenText,
} from './wentDark.js';

const MIN = 60_000;
const T0 = 1_800_000_000_000;

/** Ships every `stepMs` for `count` reports; returns the time of the last one. */
function feedShips(tracker, ids, { from = T0, stepMs = MIN, count = 10, lat = 50, lon = 0, speed = 10 } = {}) {
  let t = from;
  for (let i = 0; i < count; i += 1) {
    t = from + i * stepMs;
    ids.forEach((id, k) =>
      tracker.observe({ id, lat: lat + k * 0.01, lon: lon + i * 0.001, speed, label: id }, t),
    );
  }
  return t;
}

test('thresholds are named, frozen constants and the feature is on by default', () => {
  assert.equal(WENT_DARK_ENABLED_DEFAULT, true);
  assert.ok(Object.isFrozen(SHIP_DARK_CONFIG));
  assert.ok(Object.isFrozen(AIRCRAFT_DARK_CONFIG));
  assert.equal(SHIP_DARK_CONFIG.minReports, 8);
  assert.equal(SHIP_DARK_CONFIG.darkAfterMs, 20 * MIN);
  assert.equal(SHIP_DARK_CONFIG.minSpeedKt, 2);
  assert.equal(SHIP_DARK_CONFIG.minPeers, 3);
  assert.equal(AIRCRAFT_DARK_CONFIG.darkAfterMs, 3 * MIN);
  assert.equal(AIRCRAFT_DARK_CONFIG.minAltitudeM, 3000);
});

test('a steady moving ship that goes silent while neighbours keep reporting is flagged', () => {
  const tr = createDarkTracker(SHIP_DARK_CONFIG, { startedAt: T0 });
  const last = feedShips(tr, ['dark', 'p1', 'p2', 'p3', 'p4']);
  // Peers keep reporting for another 25 min; "dark" says nothing.
  let t = last;
  for (let i = 1; i <= 25; i += 1) {
    t = last + i * MIN;
    ['p1', 'p2', 'p3', 'p4'].forEach((id, k) => tr.observe({ id, lat: 50 + k * 0.01, lon: 0.02, speed: 10 }, t));
  }
  const result = tr.evaluate(t);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.flagged.map((f) => f.id), ['dark']);
  const f = result.flagged[0];
  assert.equal(f.lastAt, last);
  assert.ok(f.silentMs >= SHIP_DARK_CONFIG.darkAfterMs);
  assert.ok(f.peers >= 3);
  assert.ok(f.trail.length >= 2 && f.trail.length <= SHIP_DARK_CONFIG.trailPoints);
});

test('silence just under the threshold is not flagged', () => {
  const tr = createDarkTracker(SHIP_DARK_CONFIG);
  const last = feedShips(tr, ['dark', 'p1', 'p2', 'p3']);
  const t = last + SHIP_DARK_CONFIG.darkAfterMs - 1;
  ['p1', 'p2', 'p3'].forEach((id, k) => tr.observe({ id, lat: 50 + k * 0.01, lon: 0, speed: 10 }, t));
  assert.equal(tr.evaluate(t).flagged.length, 0);
});

test('coverage hole: when nobody nearby reports either, nothing is flagged', () => {
  const tr = createDarkTracker(SHIP_DARK_CONFIG);
  const last = feedShips(tr, ['a', 'b', 'c', 'd']);
  // Feed stays alive elsewhere (far away), so this is a regional hole.
  let t = last;
  for (let i = 1; i <= 30; i += 1) {
    t = last + i * MIN;
    ['x1', 'x2', 'x3'].forEach((id, k) => tr.observe({ id, lat: -30 + k * 0.01, lon: 100, speed: 5 }, t));
  }
  const result = tr.evaluate(t);
  assert.equal(result.status, 'ok');
  assert.equal(result.flagged.length, 0);
});

test('a stale feed (no reports at all) flags nothing and says so', () => {
  const tr = createDarkTracker(SHIP_DARK_CONFIG);
  const last = feedShips(tr, ['a', 'b', 'c', 'd']);
  const result = tr.evaluate(last + 40 * MIN);
  assert.equal(result.status, 'stale');
  assert.equal(result.flagged.length, 0);
  assert.match(describeDarkStatus(result, 'AIS feed'), /stale.*not flagging/);
});

test('targets last heard before a feed gap are never flagged after it recovers', () => {
  const tr = createDarkTracker(SHIP_DARK_CONFIG);
  const last = feedShips(tr, ['dark', 'p1', 'p2', 'p3']);
  // 10-minute whole-feed gap, then only the peers come back.
  let t = last + 10 * MIN;
  for (let i = 0; i < 20; i += 1, t += MIN) {
    ['p1', 'p2', 'p3'].forEach((id, k) => tr.observe({ id, lat: 50 + k * 0.01, lon: 0, speed: 10 }, t));
  }
  assert.equal(tr.evaluate(t).flagged.length, 0);
});

test('a degraded feed (watchdog not live) suppresses flags until healthy, and pre-outage silences stay excluded', () => {
  const tr = createDarkTracker(SHIP_DARK_CONFIG);
  const last = feedShips(tr, ['dark', 'p1', 'p2', 'p3']);
  let t = last;
  for (let i = 1; i <= 25; i += 1) {
    t = last + i * MIN;
    ['p1', 'p2', 'p3'].forEach((id, k) => tr.observe({ id, lat: 50 + k * 0.01, lon: 0, speed: 10 }, t));
  }
  tr.noteFeedHealth(false, 'AIS feed reconnecting', t);
  const degraded = tr.evaluate(t);
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.flagged.length, 0);
  tr.noteFeedHealth(true, null, t);
  // "dark" went quiet BEFORE the degradation → its silence may be the feed's.
  assert.equal(tr.evaluate(t).flagged.length, 0);
});

test('a partial feed (far fewer reports than usual) flags nothing', () => {
  const cfg = { ...SHIP_DARK_CONFIG };
  const tr = createDarkTracker(cfg);
  const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
  const last = feedShips(tr, ids, { count: 10 });
  // Next minutes: only 2 of 20 ships arrive.
  let t = last;
  for (let i = 1; i <= 3; i += 1) {
    t = last + i * MIN;
    tr.observe({ id: 's0', lat: 50, lon: 0, speed: 10 }, t);
    tr.observe({ id: 's1', lat: 50.01, lon: 0, speed: 10 }, t);
  }
  const result = tr.evaluate(t + 1000);
  assert.equal(result.status, 'partial');
  assert.equal(result.flagged.length, 0);
});

test('anchored ships, unsteady ships and too-few-report ships are not flagged', () => {
  const tr = createDarkTracker(SHIP_DARK_CONFIG);
  // Reports arrive in time order, as they do from the live feed.
  for (let m = -80; m < 40; m += 1) {
    const t = T0 + m * MIN;
    if (m >= 0) ['p1', 'p2', 'p3', 'p4'].forEach((id, k) => tr.observe({ id, lat: 50 + k * 0.01, lon: 0, speed: 10 }, t));
    if (m >= 0 && m < 10) tr.observe({ id: 'anchored', lat: 50.05, lon: 0, speed: 0.3 }, t);
    if (m >= 0 && m < 3) tr.observe({ id: 'fresh', lat: 50.06, lon: 0, speed: 10 }, t);
    if (m < 10 && m % 10 === 0) tr.observe({ id: 'sparse', lat: 50.07, lon: 0, speed: 10 }, t);
  }
  const t = T0 + 39 * MIN;
  const result = tr.evaluate(t);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.flagged.map((f) => f.id), []);
});

test('silence threshold scales with the target own interval (intervalMultiple)', () => {
  const tr = createDarkTracker(SHIP_DARK_CONFIG);
  const last = feedShips(tr, ['slow', 'p1', 'p2', 'p3'], { stepMs: 4 * MIN });
  // 4-min cadence × 6 = 24 min > 20 min floor.
  let t = last;
  for (let i = 1; i <= 22; i += 1) {
    t = last + i * MIN;
    ['p1', 'p2', 'p3'].forEach((id, k) => tr.observe({ id, lat: 50 + k * 0.01, lon: 0, speed: 10 }, t));
  }
  assert.equal(tr.evaluate(t).flagged.length, 0); // 22 min < 24 min
  for (let i = 23; i <= 26; i += 1) {
    t = last + i * MIN;
    ['p1', 'p2', 'p3'].forEach((id, k) => tr.observe({ id, lat: 50 + k * 0.01, lon: 0, speed: 10 }, t));
  }
  assert.deepEqual(tr.evaluate(t).flagged.map((f) => f.id), ['slow']);
});

test('aircraft: landing, low or on-ground aircraft are not "moving"', () => {
  const c = AIRCRAFT_DARK_CONFIG;
  assert.equal(isMovingReport({ altitudeM: 10_000, verticalRateMps: 0 }, c), true);
  assert.equal(isMovingReport({ altitudeM: 2_000 }, c), false);
  assert.equal(isMovingReport({ altitudeM: 10_000, onGround: true }, c), false);
  assert.equal(isMovingReport({ altitudeM: 6_000, verticalRateMps: -10 }, c), false);
});

test('flags are most recent first, capped, and old silences are pruned by retention', () => {
  const tr = createDarkTracker({ ...SHIP_DARK_CONFIG, maxFlagged: 2 });
  feedShips(tr, ['a', 'p1', 'p2', 'p3'], { count: 10 });
  feedShips(tr, ['b'], { count: 10, from: T0 + MIN });
  feedShips(tr, ['c'], { count: 10, from: T0 + 2 * MIN });
  let t = T0 + 11 * MIN;
  for (let i = 0; i < 30; i += 1, t += MIN) {
    ['p1', 'p2', 'p3'].forEach((id, k) => tr.observe({ id, lat: 50 + k * 0.01, lon: 0, speed: 10 }, t));
  }
  const result = tr.evaluate(t - MIN);
  assert.deepEqual(result.flagged.map((f) => f.id), ['c', 'b']);
  const later = tr.evaluate(t + SHIP_DARK_CONFIG.retentionMs + MIN);
  assert.equal(later.tracked, 0);
});

test('out-of-order and invalid reports are ignored', () => {
  const tr = createDarkTracker(SHIP_DARK_CONFIG);
  assert.equal(tr.observe({ id: 'x', lat: 95, lon: 0 }, T0), false);
  assert.equal(tr.observe({ id: 'x', lat: 1, lon: 1 }, T0), true);
  assert.equal(tr.observe({ id: 'x', lat: 1, lon: 1 }, T0 - 1000), false);
});

test('lastSeenText reads naturally', () => {
  assert.equal(lastSeenText(30_000), 'last seen 30 s ago');
  assert.equal(lastSeenText(23 * MIN), 'last seen 23 min ago');
  assert.equal(lastSeenText(150 * MIN), 'last seen 2 h 30 min ago');
});
