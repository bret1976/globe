import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHurricaneCones,
  intensityCategory,
  stormKey,
  nhcLayerQueryUrl,
} from './parse.js';
import { buildHurricaneCard, stormAccent } from './cards.js';

const ring = [
  [-100, 15],
  [-99, 15],
  [-99, 16],
  [-100, 16],
  [-100, 15],
];
const pt = (tau, maxwind, extra = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-100 + tau / 12, 15] },
  properties: {
    stormname: 'Hurricane Simon',
    basin: 'EP',
    stormnum: 20,
    advisnum: '13',
    advdate: '900 AM CST Sat Oct 10 2026',
    tau,
    maxwind,
    gust: maxwind + 20,
    mslp: 940,
    stormtype: 'MH',
    tcdvlp: 'Major Hurricane',
    datelbl: '9:00 AM Sat',
    lat: 15,
    lon: -100 + tau / 12,
    tcdir: 300,
    tcspd: 8,
    ...extra,
  },
});

test('joins points, track and cone by basin+storm number', () => {
  const rows = normalizeHurricaneCones({
    points: { features: [pt(12, 135), pt(0, 130)] },
    track: {
      features: [
        {
          geometry: { type: 'LineString', coordinates: [[-100, 15], [-99, 15]] },
          properties: { basin: 'EP', stormnum: 20, advisnum: '13', stormname: 'Simon' },
        },
      ],
    },
    cone: {
      features: [
        {
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: { basin: 'EP', stormnum: 20, advisnum: '13' },
        },
      ],
    },
  });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.stableId, 'ep20');
  assert.equal(row.name, 'Hurricane Simon');
  assert.equal(row.points[0].tau, 0);
  assert.equal(row.category, 'Cat 4');
  assert.equal(row.peakWindKt, 135);
  assert.equal(row.tracks.length, 1);
  assert.equal(row.cones.length, 1);
  assert.deepEqual(row.anchor, { lat: 15, lon: -100 });
});

test('drops parts from a different advisory and bad geometry', () => {
  const rows = normalizeHurricaneCones({
    points: { features: [pt(0, 50)] },
    cone: {
      features: [
        {
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: { basin: 'EP', stormnum: 20, advisnum: '12' },
        },
        {
          geometry: { type: 'Polygon', coordinates: [[[999, 0], [0, 0], [1, 1], [999, 0]]] },
          properties: { basin: 'AL', stormnum: 9, advisnum: '1' },
        },
      ],
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cones.length, 0);
  assert.equal(stormKey({ basin: 'XX', stormnum: 1 }), null);
});

test('categories, card and url', () => {
  assert.equal(intensityCategory(30, 'PTC'), 'Potential TC');
  assert.equal(intensityCategory(50, 'TS'), 'Tropical storm');
  assert.equal(intensityCategory(65, 'HU'), 'Cat 1');
  assert.equal(stormAccent(130), '#ff2d55');
  const [row] = normalizeHurricaneCones({ points: { features: [pt(0, 130)] } });
  const card = buildHurricaneCard(row, row.points[0]);
  assert.equal(card.title, 'EP · HURRICANE SIMON');
  assert.match(card.details[0], /Cat 4 · 130 kt max/);
  assert.ok(card.details.some((line) => /advisory 13/.test(line)));
  assert.match(nhcLayerQueryUrl(7), /MapServer\/7\/query\?.*f=geojson/);
});
