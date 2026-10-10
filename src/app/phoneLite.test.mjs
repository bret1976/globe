import test from 'node:test';
import assert from 'node:assert/strict';
import { footprintToPoint, isPhoneLite } from './phoneLite.js';

test('phone-lite follows the injected device detector', () => {
  assert.equal(isPhoneLite(() => true), true);
  assert.equal(isPhoneLite(() => false), false);
});

test('footprints collapse to their centre point; points pass through', () => {
  const square = { type: 'Feature', properties: { name: 'DC' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] } };
  const out = footprintToPoint(square);
  assert.deepEqual(out.geometry, { type: 'Point', coordinates: [1, 1] });
  assert.equal(out.properties.name, 'DC', 'properties (labels, cards) kept');
  const multi = { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]]] } };
  assert.deepEqual(footprintToPoint(multi).geometry.coordinates, [11, 11]);
  const point = { type: 'Feature', geometry: { type: 'Point', coordinates: [5, 6] } };
  assert.equal(footprintToPoint(point), point);
});
