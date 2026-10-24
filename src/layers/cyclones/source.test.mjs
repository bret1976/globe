import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classificationLabel,
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

// Shape of NOAA NHC CurrentStorms.json as published (2026-10-24, Hurricane
// Vance): positions as hemisphere strings plus *Numeric decimals, movement
// speed in mph, advisory number and link nested under publicAdvisory.
const NHC_VANCE = {
  activeStorms: [
    {
      id: 'ep222026',
      binNumber: 'EP2',
      name: 'Vance',
      classification: 'HU',
      intensity: '95',
      pressure: '965',
      latitude: '12.4N',
      longitude: '102.8W',
      latitudeNumeric: 12.4,
      longitudeNumeric: -102.8,
      movementDir: 335,
      movementSpeed: 7,
      lastUpdate: '2026-10-24T09:00:00.000Z',
      publicAdvisory: {
        advNum: '012',
        issuance: '2026-10-24T09:00:00.000Z',
        url: 'https://www.nhc.noaa.gov/text/MIATCPEP2.shtml',
      },
    },
  ],
};

test('NHC storms published with hemisphere-string positions are kept', () => {
  const [storm] = normalizeNhc(NHC_VANCE);
  assert.equal(storm.id, 'nhc:ep222026');
  assert.equal(storm.lat, 12.4);
  assert.equal(storm.lon, -102.8);
  assert.equal(storm.windKt, 95);
  assert.equal(storm.pressureMb, 965);
  assert.equal(storm.classification, 'HU');
  assert.equal(storm.classificationLabel, 'Hurricane');
  assert.equal(storm.advisory, '012');
  assert.equal(storm.link, 'https://www.nhc.noaa.gov/text/MIATCPEP2.shtml');
  assert.equal(storm.updatedAt, '2026-10-24T09:00:00.000Z');
});

test('NHC movement speed is converted from mph to knots', () => {
  const [storm] = normalizeNhc(NHC_VANCE);
  // 7 mph is 6 kt; 335° is NNW.
  assert.equal(storm.movementSpeedKt, 6);
  assert.equal(storm.movementDir, 335);
  assert.equal(storm.movement, 'NNW at 6 kt');
  const [still] = normalizeNhc({
    activeStorms: [
      { ...NHC_VANCE.activeStorms[0], movementSpeed: 0, movementDir: 0 },
    ],
  });
  assert.equal(still.movement, 'stationary');
});

test('hemisphere strings alone still place the storm', () => {
  const raw = { ...NHC_VANCE.activeStorms[0] };
  delete raw.latitudeNumeric;
  delete raw.longitudeNumeric;
  const [west] = normalizeNhc({ activeStorms: [raw] });
  assert.deepEqual([west.lat, west.lon], [12.4, -102.8]);
  const [south] = normalizeNhc({
    activeStorms: [{ ...raw, latitude: '15.1S', longitude: '170.5E' }],
  });
  assert.deepEqual([south.lat, south.lon], [-15.1, 170.5]);
  const bad = normalizeNhc({
    activeStorms: [{ ...raw, latitude: '95N', longitude: '10X' }],
  });
  assert.equal(bad.length, 0);
});

test('NHC classification codes use their published meanings', () => {
  assert.equal(classificationLabel('PTC'), 'Post-tropical cyclone');
  assert.equal(classificationLabel('PC'), 'Potential tropical cyclone');
  assert.equal(classificationLabel('STS'), 'Subtropical storm');
  assert.equal(classificationLabel('STD'), 'Subtropical depression');
  assert.equal(classificationLabel('ts'), 'Tropical storm');
  assert.equal(classificationLabel('XX'), null);
});

test('the NHC storm replaces its EONET duplicate and keeps the EONET track', () => {
  const { storms } = mergeCycloneSnapshots(NHC_VANCE, {
    events: [
      {
        id: 'EONET_25589',
        title: 'Hurricane Vance',
        geometry: [
          { type: 'Point', coordinates: [-101.9, 10.7] },
          { type: 'Point', coordinates: [-102.7, 12.1] },
        ],
      },
    ],
  });
  assert.equal(storms.length, 1);
  assert.equal(storms[0].source, 'NHC');
  assert.deepEqual(storms[0].track, [
    { lon: -101.9, lat: 10.7 },
    { lon: -102.7, lat: 12.1 },
    { lon: -102.8, lat: 12.4 },
  ]);
});

test('only https NHC links are passed through', () => {
  const [storm] = normalizeNhc({
    activeStorms: [
      {
        ...NHC_VANCE.activeStorms[0],
        publicAdvisory: { advNum: '1', url: 'javascript:alert(1)' },
      },
    ],
  });
  assert.equal(storm.link, 'https://www.nhc.noaa.gov/');
});
