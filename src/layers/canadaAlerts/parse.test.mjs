import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCanadaAlerts,
  parseCanadaAlert,
  canadaAlertColorCss,
  canadaAlertTypeRank,
  summarizeAlertText,
  simplifyAlertRing,
  alertOutlineRings,
  countCanadaAlertTypes,
  countCanadaAlertNames,
  ECCC_ALERTS_URL,
  MAX_ALERT_RING_POINTS,
} from './parse.js';
import { canadaAlertLabel, buildCanadaAlertCard } from './cards.js';
import { canadaAlertsProxy } from '../../../server/providers/canadaAlerts.js';

const NOW = Date.parse('2026-10-14T14:30:00Z');

const square = (lon, lat, d = 1) => [
  [lon, lat],
  [lon + d, lat],
  [lon + d, lat + d],
  [lon, lat + d],
  [lon, lat],
];

function feature(id, props, geometry) {
  return {
    id,
    type: 'Feature',
    geometry: geometry || { type: 'Polygon', coordinates: [square(-114, 51)] },
    properties: {
      alert_code: 'WW',
      alert_type: 'warning',
      alert_name_en: 'wind warning',
      alert_short_name_en: 'wind',
      publication_datetime: '2026-10-14T13:15:27.649Z',
      expiration_datetime: '2026-10-15T05:15:27.649Z',
      validity_datetime: '2026-10-14T21:00:00.000Z',
      event_end_datetime: '2026-10-15T06:00:00.000Z',
      alert_text_en:
        'Damaging winds are expected.\n\nTime span: this evening until after midnight.\n\nMaximum wind gusts: 100 km/h.',
      risk_colour_en: 'yellow',
      confidence_en: 'High',
      impact_en: 'Moderate',
      feature_name_en: 'City of Calgary',
      province: 'AB',
      status_en: 'issued',
      feature_id: `fea-${id}`,
      ...props,
    },
  };
}

const FIXTURE = {
  type: 'FeatureCollection',
  numberMatched: 6,
  features: [
    feature('a1'),
    feature('a2', {
      alert_type: 'watch',
      alert_name_en: 'severe thunderstorm watch',
      risk_colour_en: 'orange',
      feature_name_en: 'Regina',
      province: 'SK',
    }),
    feature('a3', {
      alert_type: 'warning',
      alert_name_en: 'tornado warning',
      risk_colour_en: 'red',
      feature_name_en: 'Winnipeg',
      province: 'MB',
    }, {
      type: 'MultiPolygon',
      coordinates: [[square(-97.5, 49.8, 0.5)], [square(-96, 50, 0.1)]],
    }),
    feature('a4', { status_en: 'ended' }),
    feature('a5', { expiration_datetime: '2026-10-14T10:00:00Z' }),
    feature('a6', {}, { type: 'Point', coordinates: [-100, 50] }),
    feature('a1'),
  ],
};

test('ECCC URL is the keyless OGC API weather-alerts collection', () => {
  assert.match(ECCC_ALERTS_URL, /^https:\/\/api\.weather\.gc\.ca\/collections\/weather-alerts\/items\?/);
  assert.match(ECCC_ALERTS_URL, /f=json/);
});

test('type rank and colors follow ECCC risk colour, then type', () => {
  assert.equal(canadaAlertTypeRank('warning'), 3);
  assert.equal(canadaAlertTypeRank('WATCH'), 2);
  assert.equal(canadaAlertTypeRank('advisory'), 1);
  assert.equal(canadaAlertTypeRank('statement'), 0);
  assert.equal(canadaAlertTypeRank('weird'), 0);
  assert.equal(canadaAlertColorCss({ risk: 'red', type: 'statement' }), '#ff3b3b');
  assert.equal(canadaAlertColorCss({ risk: 'yellow', type: 'warning' }), '#ffd400');
  assert.equal(canadaAlertColorCss({ risk: null, type: 'watch' }), '#ff8c1a');
  assert.equal(canadaAlertColorCss({}), '#9e9e9e');
});

test('alert text summary is the first paragraph, trimmed', () => {
  assert.equal(summarizeAlertText('A.\n\nB.'), 'A.');
  assert.equal(summarizeAlertText(''), null);
  const long = summarizeAlertText('x'.repeat(500));
  assert.ok(long.length <= 180);
  assert.ok(long.endsWith('…'));
});

test('rings are decimated and multipolygon parts kept largest first', () => {
  const big = [];
  for (let i = 0; i <= 500; i += 1) {
    const a = (i / 500) * Math.PI * 2;
    big.push([-100 + Math.cos(a), 55 + Math.sin(a)]);
  }
  assert.equal(simplifyAlertRing(big).length, MAX_ALERT_RING_POINTS);
  assert.deepEqual(simplifyAlertRing([[0, 0], [1, 1], [0, 0]]), []);
  const rings = alertOutlineRings(FIXTURE.features[2].geometry);
  assert.equal(rings.length, 2);
  assert.equal(rings[0][0][0], -97.5);
});

test('parse drops ended, expired and non-polygon alerts', () => {
  assert.equal(parseCanadaAlert(FIXTURE.features[3], NOW), null);
  assert.equal(parseCanadaAlert(FIXTURE.features[4], NOW), null);
  assert.equal(parseCanadaAlert(FIXTURE.features[5], NOW), null);
  assert.equal(parseCanadaAlert(null, NOW), null);
  const row = parseCanadaAlert(FIXTURE.features[0], NOW);
  assert.equal(row.stableId, 'a1');
  assert.equal(row.type, 'warning');
  assert.equal(row.name, 'wind warning');
  assert.equal(row.area, 'City of Calgary');
  assert.equal(row.province, 'AB');
  assert.equal(row.summary, 'Damaging winds are expected.');
  assert.equal(row.expires, '2026-10-15T05:15:27.649Z');
  assert.ok(Math.abs(row.lon - -113.5) < 1e-6);
  assert.ok(Math.abs(row.lat - 51.5) < 1e-6);
});

test('normalize dedupes, sorts warnings/red first, counts', () => {
  const rows = normalizeCanadaAlerts(FIXTURE, { nowMs: NOW });
  assert.deepEqual(rows.map((r) => r.stableId), ['a3', 'a1', 'a2']);
  assert.deepEqual(countCanadaAlertTypes(rows), { warning: 2, watch: 1 });
  assert.deepEqual(countCanadaAlertNames(rows), {
    'tornado warning': 1,
    'wind warning': 1,
    'severe thunderstorm watch': 1,
  });
  assert.equal(normalizeCanadaAlerts(FIXTURE, { nowMs: NOW, limit: 1 }).length, 1);
  assert.deepEqual(normalizeCanadaAlerts(undefined), []);
});

test('label and card show type, risk, area and ECCC attribution', () => {
  const [tornado] = normalizeCanadaAlerts(FIXTURE, { nowMs: NOW });
  assert.equal(canadaAlertLabel(tornado), '🇨🇦 Tornado Warning · Winnipeg');
  const card = buildCanadaAlertCard(tornado);
  assert.equal(card.id, 'canada-alerts-card:a3');
  assert.equal(card.accent, '#ff3b3b');
  const text = card.details.join('\n');
  assert.match(text, /Warning · red risk/);
  assert.match(text, /Winnipeg, MB/);
  assert.match(text, /in effect 14\/2100Z – 15\/0600Z/);
  assert.match(text, /Environment and Climate Change Canada/);
});

function harness(fetchImpl, clock = { t: NOW }) {
  const plugin = canadaAlertsProxy({ fetchImpl, now: () => clock.t, sleep: async () => {} });
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  let handler;
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/canada-alerts');
        handler = fn;
      },
    },
  });
  const call = () =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        destroyed: false,
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
          this.headersSent = true;
        },
        end(body) {
          resolve({ status: this.status, headers: this.headers, body: JSON.parse(body) });
        },
      };
      handler({ method: 'GET' }, res, () => resolve({ status: 'next' }));
    });
  return { call, clock };
}

test('proxy caches, retries, and falls back stale', async () => {
  let calls = 0;
  let fail = 1;
  const { call, clock } = harness(async (url) => {
    calls += 1;
    if (fail-- > 0) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    assert.match(String(url), /weather-alerts/);
    return Response.json(FIXTURE);
  });
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 3);
  assert.equal(first.body.rawCount, FIXTURE.features.length);
  assert.equal(first.body.types.warning, 2);
  assert.match(first.body.attribution, /Data Source: Environment and Climate Change Canada/);
  assert.equal(calls, 2);
  await call();
  assert.equal(calls, 2);
  clock.t += 6 * 60_000;
  fail = 99;
  const stale = await call();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  clock.t += 3 * 60 * 60_000;
  assert.equal((await call()).status, 502);
});

test('proxy serves an empty list when Canada has no active alerts', async () => {
  const { call } = harness(async () => Response.json({ type: 'FeatureCollection', features: [] }));
  const res = await call();
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
  assert.deepEqual(res.body.rows, []);
});
