import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSafecastMeasurements,
  radiationColorCss,
  radiationBand,
} from './parse.js';

test('normalizeSafecastMeasurements bins by max CPM and ranks hottest first', () => {
  const { rows, rawCount } = normalizeSafecastMeasurements(
    [
      {
        id: 1,
        latitude: 35.0,
        longitude: 139.0,
        value: 30,
        unit: 'cpm',
        captured_at: '2026-09-28T12:00:00.000Z',
      },
      {
        id: 2,
        latitude: 35.05,
        longitude: 139.05,
        value: 95,
        unit: 'cpm',
        captured_at: '2026-09-28T13:00:00.000Z',
      },
      {
        id: 3,
        latitude: 40.0,
        longitude: -74.0,
        value: 160,
        unit: 'cpm',
        captured_at: '2026-09-28T14:00:00.000Z',
      },
      { id: 4, latitude: 999, longitude: 0, value: 10 },
      null,
    ],
    { binDeg: 1, nowMs: Date.parse('2026-09-28T15:00:00.000Z'), lookbackMs: 7 * 86400000 },
  );
  assert.equal(rawCount, 3);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].band, 'hot');
  assert.equal(rows[0].cpm, 160);
  assert.equal(rows[1].cpm, 95);
  assert.equal(rows[1].band, 'high');
  assert.equal(radiationColorCss(160), '#FF2244');
  assert.equal(radiationBand(45), 'elevated');
});

test('normalizeSafecastMeasurements returns empty for non-arrays', () => {
  assert.deepEqual(normalizeSafecastMeasurements(null).rows, []);
  assert.deepEqual(normalizeSafecastMeasurements({}).rows, []);
});
