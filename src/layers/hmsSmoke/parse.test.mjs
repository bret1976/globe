import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeHmsSmokeKml,
  countHmsSmokeDensities,
  hmsSmokeKmlUrlForDate,
  hmsSmokeColorCss,
  hmsSmokeRank,
  simplifyRing,
} from './parse.js';

const fixture = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/hms_smoke20261011.kml'),
  'utf8',
);

test('KML URL uses UTC date path', () => {
  const url = hmsSmokeKmlUrlForDate(new Date(Date.UTC(2026, 9, 11)));
  assert.equal(
    url,
    'https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/2026/10/hms_smoke20261011.kml',
  );
});

test('parses fixture plumes with density and rings', () => {
  const rows = normalizeHmsSmokeKml(fixture, { dateKey: '20261011' });
  assert.ok(rows.length >= 20, `got ${rows.length}`);
  assert.ok(rows.every((r) => Array.isArray(r.ring) && r.ring.length >= 3));
  assert.ok(rows.every((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)));
  const dens = countHmsSmokeDensities(rows);
  assert.ok(dens.LIGHT + dens.MEDIUM + dens.HEAVY === rows.length);
  assert.equal(hmsSmokeRank('HEAVY') > hmsSmokeRank('LIGHT'), true);
  assert.match(hmsSmokeColorCss('MEDIUM'), /^#/);
});

test('empty or logo-only KML yields no rows', () => {
  assert.deepEqual(normalizeHmsSmokeKml('<kml></kml>'), []);
  assert.deepEqual(normalizeHmsSmokeKml(''), []);
});

test('simplifyRing drops bad points and closes', () => {
  const ring = simplifyRing([
    [-120, 40],
    [-119, 40.5],
    [-118, 40],
    [-120, 40],
  ]);
  assert.equal(ring.length, 3);
  assert.deepEqual(simplifyRing([[1, 2]]), []);
});
