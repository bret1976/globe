import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCycloneSnapshots, normalizeEonet, normalizeNhc } from './source.js';

test('NHC storms keep basin, wind, and position', () => {
  const storms = normalizeNhc({
    activeStorms: [
      {
        id: 'al092026',
        name: 'Leslie',
        longitude: -55.2,
        latitude: 22.1,
        intensity: 70,
        basin: 'AL',
        classification: 'HU',
      },
    ],
  });
  assert.equal(storms[0].id, 'nhc:al092026');
  assert.equal(storms[0].windKt, 70);
  assert.equal(storms[0].source, 'NHC');
});

test('EONET storms keep a track and skip incomplete events', () => {
  const storms = normalizeEonet({
    events: [
      { id: 'bad' },
      {
        id: 'EONET_1',
        title: 'Typhoon Dujuan',
        geometry: [
          { coordinates: [138.1, 20.2] },
          { coordinates: [139.4, 22.8] },
        ],
      },
    ],
  });
  assert.equal(storms.length, 1);
  assert.equal(storms[0].source, 'EONET');
  assert.equal(storms[0].track.length, 2);
});

test('merge prefers NHC when both sources share a location', () => {
  const merged = mergeCycloneSnapshots(
    {
      activeStorms: [
        {
          id: 'ep012026',
          name: 'Aletta',
          longitude: -110,
          latitude: 15,
          intensity: 35,
        },
      ],
    },
    {
      events: [
        {
          id: 'EONET_dup',
          title: 'Aletta',
          geometry: [{ coordinates: [-110.2, 15.1] }],
        },
      ],
    },
  );
  assert.equal(merged.storms.length, 1);
  assert.equal(merged.storms[0].source, 'NHC');
});
