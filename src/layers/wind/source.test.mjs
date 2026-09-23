import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPoints, createWindSource, parseGrid } from './source.js';

test('wind grid is a coarse global lattice', () => {
  const points = buildPoints();
  assert.ok(points.length > 40);
  assert.ok(points.every((point) => Number.isFinite(point.lat)));
  assert.ok(points[0].lon === -180);
});

test('parseGrid keeps finite samples only', () => {
  const snapshot = parseGrid({
    latitude: [10, 20, 99],
    longitude: [30, 40, 50],
    current: {
      time: '2026-09-23T00:00',
      wind_speed_10m: [12, 40, Number.NaN],
      wind_direction_10m: [90, 180, 270],
    },
  });
  assert.equal(snapshot.samples.length, 2);
  assert.equal(snapshot.samples[1].speed, 40);
  assert.equal(snapshot.model, 'gfs');
});

test('wind source prefers the hosted proxy payload', async () => {
  const source = createWindSource({
    fetchImpl: async (url) => {
      assert.match(String(url), /\/api\/wind$/);
      return {
        ok: true,
        json: async () => ({
          samples: [{ lat: 1, lon: 2, speed: 15, direction: 90 }],
        }),
      };
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.samples[0].lon, 2);
});
