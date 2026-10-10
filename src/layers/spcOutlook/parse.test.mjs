import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSpcOutlook,
  parseSpcOutlookFeature,
  outerRingsFromGeometry,
  simplifyRing,
  spcOutlookColorCss,
  spcOutlookRank,
  LABELED_SPC_LABELS,
  SPC_DAY1_CAT_URL,
  countSpcOutlookLabels,
  countSpcOutlookDays,
} from './parse.js';
import { spcOutlookProxy } from '../../../server/providers/spcOutlook.js';

const DAY1_FEATURE = {
  type: 'Feature',
  properties: {
    LABEL: 'SLGT',
    LABEL2: 'Slight Risk',
    DN: 4,
    ISSUE: '100600Z',
    ISSUE_ISO: '2026-10-10T06:00:00Z',
    VALID: '101200Z',
    VALID_ISO: '2026-10-10T12:00:00Z',
  },
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [-100.0, 35.0],
          [-99.0, 35.0],
          [-99.0, 36.0],
          [-100.0, 36.0],
          [-100.0, 35.0],
        ],
      ],
      [
        [
          [-90.0, 30.0],
          [-89.0, 30.0],
          [-89.0, 31.0],
          [-90.0, 31.0],
          [-90.0, 30.0],
        ],
      ],
    ],
  },
};

const TSTM_FEATURE = {
  type: 'Feature',
  properties: { LABEL: 'TSTM', LABEL2: 'General Thunderstorms Risk', DN: 2 },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-110.0, 40.0],
        [-109.0, 40.0],
        [-109.0, 41.0],
        [-110.0, 41.0],
        [-110.0, 40.0],
      ],
    ],
  },
};

test('feed URLs point at keyless SPC categorical GeoJSON', () => {
  assert.match(SPC_DAY1_CAT_URL, /spc\.noaa\.gov.*day1otlk_cat/);
  assert.equal(spcOutlookColorCss('TSTM'), '#9be89b');
  assert.equal(spcOutlookColorCss('HIGH'), '#ff00ff');
  assert.equal(spcOutlookRank('HIGH') > spcOutlookRank('SLGT'), true);
  assert.ok(LABELED_SPC_LABELS.has('SLGT'));
  assert.equal(LABELED_SPC_LABELS.has('TSTM'), false);
});

test('outerRingsFromGeometry expands Polygon and MultiPolygon', () => {
  assert.equal(outerRingsFromGeometry(DAY1_FEATURE.geometry).length, 2);
  assert.equal(outerRingsFromGeometry(TSTM_FEATURE.geometry).length, 1);
  assert.deepEqual(outerRingsFromGeometry(null), []);
  assert.ok(simplifyRing(DAY1_FEATURE.geometry.coordinates[0][0]).length >= 3);
});

test('parseSpcOutlookFeature builds rows with centroid and ring', () => {
  const a = parseSpcOutlookFeature(DAY1_FEATURE, 1, 0);
  assert.equal(a.day, 1);
  assert.equal(a.label, 'SLGT');
  assert.equal(a.label2, 'Slight Risk');
  assert.equal(a.dn, 4);
  assert.ok(a.ring.length >= 3);
  assert.ok(Math.abs(a.lat - 35.5) < 0.6);
  assert.ok(Math.abs(a.lon - -99.5) < 0.6);
  assert.match(a.stableId, /^spc:d1:SLGT/);

  const b = parseSpcOutlookFeature(DAY1_FEATURE, 1, 1);
  assert.ok(Math.abs(b.lon - -89.5) < 0.6);

  assert.equal(parseSpcOutlookFeature({ properties: {}, geometry: null }, 1), null);
});

test('normalize merges day1/day2, ranks HIGH first, skips junk', () => {
  const day1 = { type: 'FeatureCollection', features: [DAY1_FEATURE, TSTM_FEATURE] };
  const day2 = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { LABEL: 'HIGH', LABEL2: 'High Risk', DN: 8 },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-95, 32],
              [-94, 32],
              [-94, 33],
              [-95, 33],
              [-95, 32],
            ],
          ],
        },
      },
      { type: 'Feature', properties: { LABEL: '' }, geometry: null },
    ],
  };
  const rows = normalizeSpcOutlook({ day1, day2 });
  assert.ok(rows.length >= 4);
  assert.equal(rows[0].label, 'HIGH');
  assert.equal(rows[0].day, 2);
  assert.equal(countSpcOutlookLabels(rows).SLGT, 2);
  assert.equal(countSpcOutlookDays(rows)[1] >= 3, true);
  assert.deepEqual(normalizeSpcOutlook(null), []);
});

function harness(fetchImpl, clock = { t: 1_000_000 }) {
  const plugin = spcOutlookProxy({
    fetchImpl,
    now: () => clock.t,
    sleep: async () => {},
  });
  let handler;
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/spc-outlook');
        handler = fn;
      },
    },
  });
  const call = () =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        destroyed: false,
        status: 0,
        body: null,
        headers: {},
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          this.body = JSON.parse(body);
          resolve(this);
        },
      };
      handler({ method: 'GET' }, res, () => resolve({ status: 'next' }));
    });
  return { call, clock };
}

test('spcOutlookProxy serves normalized rows with TTL cache', async () => {
  let hits = 0;
  const day1 = { type: 'FeatureCollection', features: [TSTM_FEATURE] };
  const day2 = { type: 'FeatureCollection', features: [] };
  const { call, clock } = harness(async (url) => {
    hits += 1;
    const body = String(url).includes('day2') ? day2 : day1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
    };
  });
  const a = await call();
  assert.equal(a.status, 200);
  assert.ok(a.body.count >= 1);
  assert.equal(a.body.rows[0].label, 'TSTM');
  assert.match(a.body.attribution, /SPC|Storm Prediction/i);
  const b = await call();
  assert.equal(b.status, 200);
  assert.equal(hits, 2, 'day1+day2 once, then TTL cache');
  clock.t += 16 * 60_000;
  await call();
  assert.equal(hits, 4);
});
