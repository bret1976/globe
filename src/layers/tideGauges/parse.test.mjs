import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTideGauges,
  parseTideStation,
  parseTideLevelPayload,
  tideGaugeIntensityRank,
  tideGaugeLatestUrl,
} from './parse.js';

test('parseTideStation and intensity', () => {
  const row = parseTideStation({
    id: '9414290',
    name: 'San Francisco',
    lat: 37.8063,
    lng: -122.4659,
    state: 'CA',
  });
  assert.equal(row.id, '9414290');
  assert.equal(row.lat, 37.8063);
  assert.equal(tideGaugeIntensityRank(5.3), 3);
  assert.equal(tideGaugeIntensityRank(null), 0);
  assert.match(tideGaugeLatestUrl('9414290'), /station=9414290/);
});

test('normalizeTideGauges merges levels and ranks', () => {
  const levels = new Map([
    ['9414290', { waterLevelFt: 5.346, observedAt: '2026-10-04 14:06' }],
  ]);
  const rows = normalizeTideGauges(
    {
      stations: [
        {
          id: '9414290',
          name: 'San Francisco',
          lat: 37.8063,
          lng: -122.4659,
          state: 'CA',
        },
        { id: 'bad', name: 'Nope', lat: 0, lng: 0 },
      ],
    },
    levels,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].waterLevelFt, 5.346);
  assert.ok(rows[0].intensityRank >= 2);
  const parsed = parseTideLevelPayload({
    data: [{ t: '2026-10-04 14:06', v: '5.346' }],
  });
  assert.equal(parsed.waterLevelFt, 5.346);
});
