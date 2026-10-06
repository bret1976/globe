import test from 'node:test';
import assert from 'node:assert/strict';
import {
  airQualityColorCss,
  airQualityLabel,
  airQualityRank,
  normalizeAirQuality,
  parseAirQualityRecord,
} from './parse.js';

function rec(id, lat, lon, p2, p1, extra = {}) {
  return {
    timestamp: '2026-10-06 01:29:14',
    location: { id, latitude: String(lat), longitude: String(lon), country: 'DE', indoor: 0, ...extra },
    sensordatavalues: [
      { value: String(p1), value_type: 'P1' },
      { value: String(p2), value_type: 'P2' },
    ],
  };
}

test('rank, label, color follow EPA PM2.5 breakpoints', () => {
  assert.equal(airQualityRank(5), 0);
  assert.equal(airQualityRank(20), 1);
  assert.equal(airQualityRank(40), 2);
  assert.equal(airQualityRank(100), 3);
  assert.equal(airQualityRank(200), 4);
  assert.equal(airQualityRank(300), 5);
  assert.equal(airQualityLabel(3), 'Unhealthy');
  assert.equal(airQualityColorCss(0), '#00E400');
});

test('parse skips indoor, null island, and saturated values', () => {
  assert.equal(parseAirQualityRecord(rec(1, 48.5, 9.2, 999.9, 5)), null);
  assert.equal(parseAirQualityRecord(rec(1, 0, 0, 5, 5)), null);
  assert.equal(parseAirQualityRecord(rec(1, 48.5, 9.2, 5, 5, { indoor: 1 })), null);
  const ok = parseAirQualityRecord(rec(1, 48.5, 9.2, 7.5, 12));
  assert.equal(ok.pm25, 7.5);
  assert.equal(ok.pm10, 12);
});

test('normalize pools sites into cells with median PM2.5', () => {
  const rows = normalizeAirQuality([
    rec(1, 48.51, 9.21, 10, 20),
    rec(2, 48.52, 9.22, 30, 40),
    rec(3, 48.53, 9.23, 50, 60),
    rec(3, 48.53, 9.23, 500, 600), // same site → ignored
    rec(4, -33.9, 151.2, 80, 90),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].intensityRank, 3); // worst first
  const de = rows.find((r) => r.lat > 0);
  assert.equal(de.sensors, 3);
  assert.equal(de.pm25, 30);
  assert.equal(de.intensityRank, 1);
  assert.ok(de.observedAt.endsWith('Z'));
});
