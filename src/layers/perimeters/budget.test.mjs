import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetPerimeterPolygons, thinRing } from './budget.js';

const square = (s, n = 4) => {
  const r = [];
  for (let i = 0; i < n; i++) r.push([Math.cos((i / n) * 6.283) * s, Math.sin((i / n) * 6.283) * s]);
  r.push(r[0]);
  return [r];
};

test('thinRing keeps endpoints and caps vertex count', () => {
  const ring = Array.from({ length: 1000 }, (_, i) => [i, i]);
  const out = thinRing(ring, 200);
  assert.ok(out.length <= 201);
  assert.deepEqual(out[0], ring[0]);
  assert.deepEqual(out.at(-1), ring.at(-1));
  assert.equal(thinRing(ring.slice(0, 10), 200).length, 10);
});

test('budget keeps largest fragments per incident and every incident', () => {
  const rows = [
    { polygons: Array.from({ length: 50 }, (_, i) => square(i + 1)) },
    { polygons: [square(0.1)] },
  ];
  const kept = budgetPerimeterPolygons(rows, { perIncident: 5, total: 3 });
  assert.equal(kept[1].length, 1);
  assert.ok(kept[0].length >= 1 && kept[0].length <= 5);
  const areas = kept[0].map((p) => Math.abs(p[0][0][0]));
  assert.equal(areas[0], 50);
});
