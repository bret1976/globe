import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GNSS_HISTORY_BUCKET_MS,
  GNSS_HISTORY_RETENTION_MS,
  createGnssHistory,
  describeGnssHistoryCoverage,
  gnssTimelineSlider,
} from './history.js';

const T0 = 1_800_000_000_000 - (1_800_000_000_000 % GNSS_HISTORY_BUCKET_MS);
const rows = (n, degraded) => Array.from({ length: n }, (_, i) => ({ hex: `h${i}`, lat: 50.2, lon: 20.2, degraded: i < degraded }));

test('the series is five-minute buckets kept for 24 h, in memory only', () => {
  assert.equal(GNSS_HISTORY_BUCKET_MS, 5 * 60_000);
  assert.equal(GNSS_HISTORY_RETENTION_MS, 24 * 3_600_000);
  const h = createGnssHistory({ startedAt: T0 });
  assert.equal(h.record(rows(4, 3), T0 + 1000), 4);
  h.record(rows(4, 0), T0 + GNSS_HISTORY_BUCKET_MS + 1000);
  const tl = h.timeline(T0 + 2 * GNSS_HISTORY_BUCKET_MS);
  assert.equal(tl.persisted, false);
  assert.equal(tl.frames.length, 2);
  assert.equal(tl.frames[0].aircraft, 4);
  // Older than retention → dropped.
  assert.equal(h.timeline(T0 + GNSS_HISTORY_RETENTION_MS + 3 * GNSS_HISTORY_BUCKET_MS).frames.length, 0);
});

test('a frame replays what the live layer would have drawn then', () => {
  const h = createGnssHistory({ startedAt: T0 });
  h.record(rows(6, 5), T0 + 1000);
  const f = h.frame(T0 + 2000, T0 + 2000);
  assert.equal(f.buckets, 1);
  assert.ok(Array.isArray(f.cells));
  assert.deepEqual(h.frame(T0 - 10 * GNSS_HISTORY_BUCKET_MS, T0 + 2000).cells, []);
});

test('rejects future and too-old snapshots and bad rows', () => {
  const h = createGnssHistory({ startedAt: T0 });
  assert.equal(h.record(rows(1, 0), T0 + 3_600_000, T0), 0);
  assert.equal(h.record(rows(1, 0), T0 - GNSS_HISTORY_RETENTION_MS - 1, T0), 0);
  assert.equal(h.record([{ hex: '', lat: 1, lon: 1 }, { hex: 'a', lat: NaN, lon: 1 }], T0, T0), 0);
});

test('the UI says honestly how much history exists after a restart', () => {
  const h = createGnssHistory({ startedAt: T0 });
  assert.match(describeGnssHistoryCoverage(null, T0), /not loaded/);
  assert.match(describeGnssHistoryCoverage(h.timeline(T0), T0), /none yet .*restart/);
  h.record(rows(2, 0), T0 + 1000);
  const text = describeGnssHistoryCoverage(h.timeline(T0 + 10 * 60_000), T0 + 10 * 60_000);
  assert.match(text, /History: 5 min of 24 h \(server memory since .* UTC restart\)/);
});

test('the slider ends on LIVE and is disabled with no history', () => {
  assert.equal(gnssTimelineSlider(null, null, T0).disabled, true);
  const h = createGnssHistory({ startedAt: T0 });
  h.record(rows(1, 0), T0 + 1000);
  const tl = h.timeline(T0 + 20 * 60_000);
  const live = gnssTimelineSlider(tl, null, T0 + 20 * 60_000);
  assert.equal(live.live, true);
  assert.equal(live.valueText, 'LIVE');
  const past = gnssTimelineSlider(tl, 0, T0 + 20 * 60_000);
  assert.equal(past.live, false);
  assert.match(past.valueText, /UTC · 15 min ago/);
});
