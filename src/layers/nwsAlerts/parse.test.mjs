import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeNwsAlerts,
  nwsSeverityColorCss,
  geometryCentroid,
} from './parse.js';

test('geometryCentroid handles Point Polygon MultiPolygon', () => {
  assert.deepEqual(
    geometryCentroid({ type: 'Point', coordinates: [-95.5, 30.2] }),
    { lon: -95.5, lat: 30.2 },
  );
  const poly = geometryCentroid({
    type: 'Polygon',
    coordinates: [
      [
        [-93.94, 39.33],
        [-93.65, 39.61],
        [-93.28, 39.62],
        [-93.94, 39.33],
      ],
    ],
  });
  assert.ok(poly);
  assert.ok(Math.abs(poly.lon - -93.623) < 0.01);
  assert.ok(Math.abs(poly.lat - 39.52) < 0.01);
  assert.equal(geometryCentroid(null), null);
  assert.equal(geometryCentroid({ type: 'LineString', coordinates: [] }), null);
});

test('normalizeNwsAlerts keeps geometry features and ranks by severity', () => {
  const rows = normalizeNwsAlerts({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-98.5, 30.0],
              [-98.0, 30.0],
              [-98.0, 30.5],
              [-98.5, 30.5],
              [-98.5, 30.0],
            ],
          ],
        },
        properties: {
          id: 'urn:test:flood',
          event: 'Flash Flood Warning',
          severity: 'Severe',
          urgency: 'Immediate',
          certainty: 'Likely',
          headline: 'Flash Flood Warning',
          areaDesc: 'Travis, TX',
          sent: '2026-10-01T12:00:00Z',
        },
      },
      {
        type: 'Feature',
        geometry: null,
        properties: {
          id: 'urn:test:zone-only',
          event: 'Small Craft Advisory',
          severity: 'Minor',
        },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-81.3, 28.5] },
        properties: {
          id: 'urn:test:tornado',
          event: 'Tornado Warning',
          severity: 'Extreme',
          urgency: 'Immediate',
          certainty: 'Observed',
          headline: 'Tornado Warning',
          areaDesc: 'Orange, FL',
        },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [999, 0] },
        properties: { id: 'bad', event: 'Bad coords', severity: 'Minor' },
      },
      null,
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event, 'Tornado Warning');
  assert.equal(rows[0].severity, 'Extreme');
  assert.equal(rows[0].stableId, 'urn:test:tornado');
  assert.equal(rows[1].event, 'Flash Flood Warning');
  assert.equal(rows[1].severity, 'Severe');
  assert.ok(Number.isFinite(rows[1].lat) && Number.isFinite(rows[1].lon));
  assert.equal(nwsSeverityColorCss('Extreme'), '#FF1144');
  assert.equal(nwsSeverityColorCss('Severe'), '#FF6600');
});

test('normalizeNwsAlerts returns [] for empty payloads', () => {
  assert.deepEqual(normalizeNwsAlerts(null), []);
  assert.deepEqual(normalizeNwsAlerts({}), []);
  assert.deepEqual(normalizeNwsAlerts({ features: [] }), []);
});
