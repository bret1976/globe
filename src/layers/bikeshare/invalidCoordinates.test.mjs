// GBFS station_information with malformed coordinates (upstream #1232 port).
// JavaScript coercion turned blank, boolean, array and null values into 0, so
// a station with no valid location was drawn at 0°N 0°E.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.js';

function parse(stations) {
  return createModel({}).parseStationInformation({ data: { stations } });
}

test('stations with blank, boolean, array, null or out-of-range coordinates are skipped', () => {
  const map = parse([
    { station_id: 'blank', lat: '', lon: '  ' },
    { station_id: 'bool', lat: true, lon: false },
    { station_id: 'array', lat: [], lon: [1] },
    { station_id: 'null', lat: null, lon: null },
    { station_id: 'objects', lat: {}, lon: {} },
    { station_id: 'too-far-north', lat: 91, lon: 10 },
    { station_id: 'too-far-east', lat: 10, lon: 181 },
    { station_id: 'text', lat: 'north', lon: 'east' },
  ]);
  assert.equal(map.size, 0, [...map.keys()].join(','));
});

test('numeric zero, numeric strings, limits and latitude/longitude aliases still parse', () => {
  const map = parse([
    { station_id: 'zero', lat: 0, lon: 0 },
    { station_id: 'strings', lat: '40.4168', lon: ' -3.7038 ' },
    { station_id: 'limits', lat: -90, lon: 180 },
    { id: 'alias', latitude: 59.91, longitude: 10.75 },
  ]);
  assert.deepEqual(
    [...map.values()].map((s) => [s.stationId, s.lat, s.lon]),
    [
      ['zero', 0, 0],
      ['strings', 40.4168, -3.7038],
      ['limits', -90, 180],
      ['alias', 59.91, 10.75],
    ],
  );
});
