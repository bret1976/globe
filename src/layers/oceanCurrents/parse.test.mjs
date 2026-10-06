import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOceanCurrents,
  oceanCurrentRank,
  oceanCurrentsGrid,
  oceanCurrentsBatchUrl,
  offsetByBearing,
} from './parse.js';

test('speed ranks', () => {
  assert.equal(oceanCurrentRank(0.1), 0);
  assert.equal(oceanCurrentRank(0.5), 1);
  assert.equal(oceanCurrentRank(1.5), 2);
  assert.equal(oceanCurrentRank(2.5), 3);
  assert.equal(oceanCurrentRank(5), 4);
  assert.equal(oceanCurrentRank('x'), 0);
});

test('grid and batch url', () => {
  const g = oceanCurrentsGrid(6);
  assert.equal(g.length, 25 * 60);
  assert.equal(oceanCurrentsGrid().length, 19 * 45);
  const url = oceanCurrentsBatchUrl(g.slice(0, 2));
  assert.match(url, /latitude=-72,-72&longitude=-180,-174/);
  assert.match(url, /ocean_current_velocity/);
});

test('normalize drops land/null cells and anchors to grid', () => {
  const pts = [
    [0, -30],
    [10, 60],
    [40, -100],
  ];
  const body = [
    {
      latitude: 0.04,
      longitude: -30.04,
      current: {
        time: '2026-10-06T14:15',
        ocean_current_velocity: 1.1,
        ocean_current_direction: 279,
      },
    },
    {
      latitude: 10.04,
      longitude: 59.96,
      current: {
        time: '2026-10-06T14:15',
        ocean_current_velocity: 4.2,
        ocean_current_direction: -10,
      },
    },
    {
      latitude: 40,
      longitude: -100,
      current: { ocean_current_velocity: null, ocean_current_direction: null },
    },
  ];
  const rows = normalizeOceanCurrents(body, pts);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].lat, 0);
  assert.equal(rows[0].lon, -30);
  assert.equal(rows[1].directionDeg, 350);
  assert.equal(rows[1].rank, 4);
  assert.equal(rows[0].observedAt, '2026-10-06T14:15Z');
});

test('offset by bearing moves north and wraps', () => {
  const [lat, lon] = offsetByBearing(0, 0, 0, 111.2);
  assert.ok(Math.abs(lat - 1) < 0.01 && Math.abs(lon) < 1e-6);
  const [, lon2] = offsetByBearing(0, 179.5, 90, 111.2);
  assert.ok(lon2 < -179);
});

test('proxy fills grid in spaced batches and serves rows', async () => {
  const { oceanCurrentsProxy } =
    await import('../../../server/providers/oceanCurrents.js');
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const n = new URL(url).searchParams.get('latitude').split(',').length;
    const body = Array.from({ length: n }, (_, i) => ({
      current:
        i % 2
          ? {
              ocean_current_velocity: 1.2,
              ocean_current_direction: 90,
              time: '2026-10-06T14:00',
            }
          : { ocean_current_velocity: null, ocean_current_direction: null },
    }));
    return { ok: true, status: 200, json: async () => body };
  };
  const proxy = oceanCurrentsProxy({
    fetchImpl,
    sleep: async () => {},
    warm: false,
  });
  await proxy._test.fill();
  const snap = proxy._test.snapshot();
  assert.equal(calls, 4);
  assert.equal(snap.partial, false);
  assert.equal(snap.gridPoints, 855);
  assert.ok(snap.count > 400 && snap.count < 430);
});
