import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeUsgsGauges,
  parseUsgsGaugeFeature,
  usgsGaugeIntensityRank,
  usgsGaugesFirstPageUrl,
  usgsGaugesNextHref,
} from './parse.js';

test('parseUsgsGaugeFeature keeps streamflow points', () => {
  const row = parseUsgsGaugeFeature({
    type: 'Feature',
    id: 'da26',
    geometry: { type: 'Point', coordinates: [-79.13, 34.22] },
    properties: {
      monitoring_location_id: 'USGS-02134900',
      parameter_code: '00060',
      value: '149',
      unit_of_measure: 'ft^3/s',
      time: '2026-10-03T14:00:00+00:00',
    },
  });
  assert.equal(row.siteNumber, '02134900');
  assert.equal(row.cfs, 149);
  assert.equal(row.lat, 34.22);
  assert.equal(row.lon, -79.13);
  assert.equal(row.intensityRank, 0);
});

test('normalizeUsgsGauges ranks high discharge first and caps rows', () => {
  const features = [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-90, 30] },
      properties: {
        monitoring_location_id: 'USGS-1',
        parameter_code: '00060',
        value: '100',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-91, 31] },
      properties: {
        monitoring_location_id: 'USGS-2',
        parameter_code: '00060',
        value: '25000',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-92, 32] },
      properties: {
        monitoring_location_id: 'USGS-3',
        parameter_code: '00065',
        value: '12',
      },
    },
  ];
  const rows = normalizeUsgsGauges({ type: 'FeatureCollection', features }, {
    maxRows: 10,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].siteNumber, '2');
  assert.equal(rows[0].intensityRank, 3);
  assert.equal(usgsGaugeIntensityRank(60_000), 4);
});

test('usgsGaugesNextHref and first-page URL', () => {
  assert.match(usgsGaugesFirstPageUrl(), /parameter_code=00060/);
  assert.equal(
    usgsGaugesNextHref({
      links: [{ rel: 'next', href: 'https://example.test/next' }],
    }),
    'https://example.test/next',
  );
  assert.equal(usgsGaugesNextHref({ links: [] }), null);
});
