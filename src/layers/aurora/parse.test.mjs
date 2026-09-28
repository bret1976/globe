import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOvationAurora,
  normalizeLon,
  auroraColorCss,
  auroraBand,
} from './parse.js';

test('normalizeLon wraps 0..360 into -180..180', () => {
  assert.equal(normalizeLon(0), 0);
  assert.equal(normalizeLon(190), -170);
  assert.equal(normalizeLon(360), 0);
  assert.equal(normalizeLon(-20), -20);
});

test('normalizeOvationAurora max-pools and ranks by intensity', () => {
  const payload = {
    'Observation Time': '2026-09-28T14:00:00Z',
    'Forecast Time': '2026-09-28T15:00:00Z',
    coordinates: [
      [10, 70, 12],
      [11, 70, 8], // same 2° bin as above → lose to 12
      [10, 71, 3], // same bin
      [200, -70, 6],
      [0, 0, 1], // below default MIN_AURORA
      [10, 999, 20], // bad lat ignored
      null,
    ],
  };
  const out = normalizeOvationAurora(payload, { binDeg: 2, minAurora: 2 });
  assert.equal(out.observationTime, '2026-09-28T14:00:00Z');
  assert.equal(out.forecastTime, '2026-09-28T15:00:00Z');
  assert.equal(out.rawCount, 7);
  assert.ok(out.rows.length >= 2);
  assert.equal(out.rows[0].aurora, 12);
  assert.equal(out.rows[0].band, 'strong');
  assert.equal(auroraColorCss(12), '#66FFCC');
  assert.equal(auroraBand(16), 'intense');
});

test('normalizeOvationAurora returns empty for bad payloads', () => {
  assert.equal(normalizeOvationAurora(null).rows.length, 0);
  assert.equal(normalizeOvationAurora({}).rows.length, 0);
  assert.equal(normalizeOvationAurora({ coordinates: 'nope' }).rows.length, 0);
});

test('normalizeOvationAurora raises threshold to honor maxRows', () => {
  const coordinates = [];
  for (let lon = 0; lon < 40; lon++) {
    for (let lat = 60; lat < 80; lat++) {
      coordinates.push([lon, lat, 5]);
    }
  }
  const out = normalizeOvationAurora(
    { coordinates, 'Observation Time': 't', 'Forecast Time': 'f' },
    { binDeg: 1, minAurora: 2, maxRows: 50 },
  );
  assert.ok(out.rows.length <= 50);
  assert.ok(out.minAuroraUsed >= 2);
});
