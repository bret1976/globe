import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStormReports,
  stormReportColorCss,
  stormReportKind,
  stormReportRank,
} from './parse.js';

function feat(id, typetext, mag, lat, lon, valid = '2026-10-05T17:23:00Z') {
  return {
    id,
    type: 'Feature',
    properties: { typetext, magf: mag, unit: 'Inch', city: 'Town', st: 'KS', valid, product_id: 'P' },
    geometry: { type: 'Point', coordinates: [lon, lat] },
  };
}

test('kind and rank mapping', () => {
  assert.equal(stormReportKind('TORNADO'), 'tornado');
  assert.equal(stormReportKind('FLASH FLOOD'), 'flood');
  assert.equal(stormReportKind('NON-TSTM WND GST'), 'wind');
  assert.equal(stormReportKind('HEAVY SNOW'), 'winter');
  assert.equal(stormReportKind('RAIN'), 'rain');
  assert.equal(stormReportRank('HAIL', 2.5), 4);
  assert.equal(stormReportRank('HAIL', 0.75), 2);
  assert.equal(stormReportRank('TSTM WND GST', 80), 4);
  assert.equal(stormReportRank('TSTM WND DMG', null), 3);
  assert.equal(stormReportRank('RAIN', 4), 1);
  assert.equal(stormReportColorCss('tornado'), '#FF1744');
});

test('normalize drops bad points and sorts severe first', () => {
  const rows = normalizeStormReports({
    type: 'FeatureCollection',
    features: [
      feat('0', 'RAIN', 1.2, 31, -81),
      feat('1', 'TORNADO', null, 37, -97),
      feat('2', 'HAIL', 1.0, 999, -97),
      feat('3', '', 1, 37, -97),
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'tornado');
  assert.equal(rows[1].kind, 'rain');
  assert.equal(rows[1].state, 'KS');
});
