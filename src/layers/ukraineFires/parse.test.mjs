import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bandForAge,
  coverageLabel,
  dayIndexToIso,
  decodeUkraineFires,
  summarizeBands,
} from './parse.js';

test('decodes the flat proxy array into coordinates and day indices', () => {
  const decoded = decodeUkraineFires({
    origin: { lat: 44000, lon: 22000, scale: 1000 },
    today: 1741,
    points: [6450, 8520, 0, 4950, 12100, 1740],
  });
  assert.equal(decoded.count, 2);
  assert.ok(Math.abs(decoded.lat[0] - 50.45) < 1e-4);
  assert.ok(Math.abs(decoded.lon[0] - 30.52) < 1e-4);
  assert.equal(decoded.day[1], 1740);
  assert.equal(decoded.today, 1741);
});

test('age bands and windows count detections', () => {
  assert.equal(bandForAge(0), 0);
  assert.equal(bandForAge(10), 1);
  assert.equal(bandForAge(200), 2);
  assert.equal(bandForAge(1500), 3);
  const decoded = decodeUkraineFires({
    today: 1000,
    points: [0, 0, 999, 0, 0, 980, 0, 0, 10],
  });
  assert.deepEqual(summarizeBands(decoded).counts, [1, 1, 0, 1]);
  assert.equal(summarizeBands(decoded, 30).shown, 2);
  assert.equal(summarizeBands(decoded, 7).shown, 1);
});

test('coverage label explains backfill and archive gaps honestly', () => {
  assert.equal(dayIndexToIso(0), '2022-01-01');
  assert.match(
    coverageLabel({ backfill: { running: true, done: 3, total: 10 } }),
    /3\/10/,
  );
  assert.match(
    coverageLabel({ coverage: { gap: { from: 1096, to: 1732 } } }),
    /2025-01-01/,
  );
  assert.equal(
    coverageLabel({ complete: true, coverage: {} }),
    'every detection since 1 Jan 2022',
  );
});
