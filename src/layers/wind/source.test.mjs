import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPoints, createWindSource, parseGrid } from './source.js';

test('wind grid is a coarse global lattice', () => {
  const points = buildPoints();
  assert.ok(points.length > 40);
  assert.ok(points.every((point) => Number.isFinite(point.lat)));
  assert.ok(points[0].lon === -180);
});

test('parseGrid keeps finite samples only', () => {
  const snapshot = parseGrid({
    latitude: [10, 20, 99],
    longitude: [30, 40, 50],
    current: {
      time: '2026-09-23T00:00',
      wind_speed_10m: [12, 40, Number.NaN],
      wind_direction_10m: [90, 180, 270],
    },
  });
  assert.equal(snapshot.samples.length, 2);
  assert.equal(snapshot.samples[1].speed, 40);
  assert.equal(snapshot.model, 'gfs');
});

test('wind source prefers the hosted proxy payload', async () => {
  const source = createWindSource({
    fetchImpl: async (url) => {
      assert.match(String(url), /\/api\/wind$/);
      return {
        ok: true,
        json: async () => ({
          samples: [{ lat: 1, lon: 2, speed: 15, direction: 90 }],
        }),
      };
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.samples[0].lon, 2);
});

test('wind source fetches Open-Meteo directly when the proxy is only warming', async () => {
  const urls = [];
  const source = createWindSource({
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith('/api/wind')) {
        return {
          ok: true,
          json: async () => ({ samples: [], warming: true, model: 'gfs' }),
        };
      }
      if (String(url).includes('erddap')) return { ok: false, status: 503 };
      const lats = new URL(String(url)).searchParams.get('latitude').split(',');
      return {
        ok: true,
        json: async () =>
          lats.map((lat) => ({
            latitude: Number(lat),
            longitude: 10,
            current: {
              time: '2026-10-20T14:00',
              wind_speed_10m: 20,
              wind_direction_10m: 270,
            },
          })),
      };
    },
  });
  const snapshot = await source.getSnapshot();
  assert.ok(urls.some((url) => url.startsWith('https://api.open-meteo.com/')));
  assert.equal(snapshot.samples.length, buildPoints().length);
  assert.ok(!snapshot.warming, 'direct grid must not keep the layer warming');
});

test('ERDDAP wind URL asks for the same 8° lattice as buildPoints', async () => {
  const { buildErddapWindUrl } = await import('./source.js');
  const url = decodeURIComponent(buildErddapWindUrl(Date.parse('2026-10-25T14:23:00Z')));
  assert.match(url, /ugrd10m\[\(2026-10-25T14:00:00Z\)\]\[\(68\):16:\(-60\)\]\[\(4\):16:\(359\.5\)\]/);
  assert.match(url, /,vgrd10m\[/);
});

test('parseErddapWind converts u/v m/s to km/h and degrees-from, wraps longitude', async () => {
  const { parseErddapWind, windFromDirection } = await import('./source.js');
  assert.equal(windFromDirection(0, -5), 0); // blowing south → from north
  assert.equal(windFromDirection(-5, 0), 90); // blowing west → from east
  const snap = parseErddapWind({
    table: {
      columnNames: ['time', 'latitude', 'longitude', 'ugrd10m', 'vgrd10m'],
      rows: [
        ['2026-10-25T15:00:00Z', 20, 180, 10, 0],
        ['2026-10-25T15:00:00Z', 20, 188, null, 1],
        ['2026-10-25T15:00:00Z', 20, 196, -9.99e8, -9.99e8],
      ],
    },
  });
  assert.equal(snap.samples.length, 1);
  assert.deepEqual(snap.samples[0], { lat: 20, lon: -180, speed: 36, direction: 270 });
  assert.equal(snap.valid, '2026-10-25T15:00');
  assert.throws(() => parseErddapWind({ table: { columnNames: [], rows: [] } }));
});

test('wind source reads NOAA GFS from ERDDAP before Open-Meteo when the proxy is warming', async () => {
  const urls = [];
  const source = createWindSource({
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith('/api/wind'))
        return { ok: true, json: async () => ({ samples: [], warming: true }) };
      return {
        ok: true,
        json: async () => ({
          table: {
            columnNames: ['time', 'latitude', 'longitude', 'ugrd10m', 'vgrd10m'],
            rows: [['2026-10-25T15:00:00Z', 52, 4, -12, 1.5]],
          },
        }),
      };
    },
  });
  const snap = await source.getSnapshot();
  assert.equal(urls.length, 2);
  assert.match(urls[1], /erddap\/griddap\/ncep_global/);
  assert.equal(snap.samples[0].speed, 43.5);
});
