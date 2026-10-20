import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeCycloneSnapshots,
  normalizeEonet,
  normalizeNhc,
} from './source.js';

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

test('browser goes direct when the proxy reports a feed down', async () => {
  const { createCycloneSource } = await import('./source.js');
  const eonet = {
    events: [
      { id: 'E1', title: 'Typhoon A', geometry: [{ coordinates: [130, 18] }] },
      { id: 'E2', title: 'Cyclone B', geometry: [{ coordinates: [80, -12] }] },
    ],
  };
  const source = createCycloneSource({
    fetchImpl: async (url) => {
      if (url === '/api/cyclones')
        return Response.json({
          storms: [],
          feeds: { nhc: 'ok', eonet: 'down' },
        });
      if (String(url).includes('eonet')) return Response.json(eonet);
      throw new TypeError('CORS');
    },
  });
  const snap = await source.getSnapshot();
  assert.equal(snap.storms.length, 2);
  assert.equal(snap.browserDirect, true);
});

test('healthy proxy answer is used as-is', async () => {
  const { createCycloneSource } = await import('./source.js');
  let direct = 0;
  const source = createCycloneSource({
    fetchImpl: async (url) => {
      if (url === '/api/cyclones')
        return Response.json({ storms: [], feeds: { nhc: 'ok', eonet: 'ok' } });
      direct += 1;
      return Response.json({});
    },
  });
  const snap = await source.getSnapshot();
  assert.equal(snap.storms.length, 0);
  assert.equal(direct, 0);
});
