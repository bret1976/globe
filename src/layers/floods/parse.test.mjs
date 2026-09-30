import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGdacsFloodDroughts,
  gdacsAlertColorCss,
} from './parse.js';

test('normalizeGdacsFloodDroughts maps FL/DR features and ranks by alert', () => {
  const rows = normalizeGdacsFloodDroughts({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [79.05, 30.02] },
        properties: {
          eventtype: 'FL',
          eventid: 1104121,
          episodeid: 19,
          name: 'Flood in India',
          alertlevel: 'Orange',
          alertscore: 2,
          country: 'India',
          fromdate: '2026-08-09T01:00:00',
          todate: '2026-09-28T01:00:00',
          url: {
            report: 'https://www.gdacs.org/report.aspx?eventid=1104121',
            geometry: 'https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=FL&eventid=1104121',
            details: 'https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=FL&eventid=1104121',
          },
        },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [33.6, 0.76] },
        properties: {
          eventtype: 'DR',
          eventid: 1027465,
          episodeid: 7,
          name: 'Drought in Uganda region',
          alertlevel: 'Red',
          alertscore: 3,
          country: 'Uganda',
        },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: { eventtype: 'EQ', eventid: 1, name: 'Quake skip' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [999, 0] },
        properties: { eventtype: 'FL', eventid: 2, name: 'Bad coords' },
      },
      null,
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].eventType, 'DR');
  assert.equal(rows[0].alertLevel, 'RED');
  assert.equal(rows[0].stableId, 'DR:1027465:7');
  assert.equal(rows[1].eventType, 'FL');
  assert.equal(rows[1].name, 'Flood in India');
  assert.equal(rows[1].lon, 79.05);
  assert.equal(rows[1].lat, 30.02);
  assert.equal(gdacsAlertColorCss('RED'), '#FF2244');
  assert.equal(gdacsAlertColorCss('ORANGE'), '#FF8800');
});

test('normalizeGdacsFloodDroughts returns [] for empty payloads', () => {
  assert.deepEqual(normalizeGdacsFloodDroughts(null), []);
  assert.deepEqual(normalizeGdacsFloodDroughts({}), []);
  assert.deepEqual(normalizeGdacsFloodDroughts({ features: [] }), []);
});
