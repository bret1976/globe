import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUsdmDrought,
  ringCentroid,
  usdmColorCss,
  usdmLabel,
} from './parse.js';

test('ringCentroid and labels', () => {
  const c = ringCentroid([
    [-100, 40],
    [-99, 40],
    [-99, 41],
    [-100, 41],
    [-100, 40],
  ]);
  assert.ok(c);
  assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lon));
  assert.ok(c.lat > 40 && c.lat < 41);
  assert.ok(c.lon > -100.5 && c.lon < -99);
  assert.equal(usdmLabel(3), 'D3 Extreme');
  assert.equal(usdmColorCss(4), '#730000');
});

test('normalizeUsdmDrought samples MultiPolygon parts', () => {
  const rows = normalizeUsdmDrought({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { DM: 2 },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [-101, 35],
                [-100, 35],
                [-100, 36],
                [-101, 36],
                [-101, 35],
              ],
            ],
            [
              [
                [-98, 33],
                [-97, 33],
                [-97, 34],
                [-98, 34],
                [-98, 33],
              ],
            ],
          ],
        },
      },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dm, 2);
  assert.ok(Number.isFinite(rows[0].lat));
});
