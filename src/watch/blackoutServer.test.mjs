// Server-side Blackout modules. All targets here are SIMULATED test inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePersistDir, createPersistStore, resetBlackoutStoreForTest } from '../../server/blackout/persist.js';
import { createFlagLog } from '../../server/blackout/flagLog.js';
import { milReport, createMilAircraftWatcher, MIL_DARK_CONFIG } from '../../server/blackout/milAircraft.js';
import { darkRow, toCsv, toGeoJson, DARK_COLUMNS } from '../../server/blackout/export.js';
import { blackoutPlugin, blackoutPollersEnabled } from '../../server/blackout/plugin.js';
import { createDarkTracker, SHIP_DARK_CONFIG } from '../data/wentDark.js';
import { createGnssHistory } from '../layers/gnss/history.js';

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const memStore = () => createPersistStore({ dir: null, warn: () => {} });

test('persist dir: explicit env, then Railway volume, else memory', () => {
  assert.equal(resolvePersistDir({ BLACKOUT_DATA_DIR: '/x' }), '/x');
  assert.equal(resolvePersistDir({ RAILWAY_VOLUME_MOUNT_PATH: '/data' }), path.join('/data', 'blackout'));
  assert.equal(resolvePersistDir({}), null);
  const s = memStore();
  assert.equal(s.status().mode, 'memory');
  assert.match(s.status().note, /lost on restart/);
  assert.equal(s.register('a', () => ({ v: 1 })), null);
});

test('persist store saves atomically and restores on the next boot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackout-'));
  const a = createPersistStore({ dir, warn: () => {}, intervalMs: 1e9 });
  assert.equal(a.status().mode, 'disk');
  a.register('thing', () => ({ v: 1, n: 42 }));
  await a.saveAll();
  assert.deepEqual(fs.readdirSync(dir), ['thing.json']);
  const b = createPersistStore({ dir, warn: () => {}, intervalMs: 1e9 });
  assert.deepEqual(b.register('thing', () => null), { v: 1, n: 42 });
  const bad = path.join(dir, 'file');
  fs.writeFileSync(bad, '');
  assert.equal(createPersistStore({ dir: path.join(bad, 'sub'), warn: () => {} }).status().mode, 'memory');
});

test('went-dark tracker state round-trips and the restore gap is not a silence', () => {
  const tr = createDarkTracker(SHIP_DARK_CONFIG);
  for (let i = 0; i < 12; i += 1) for (const id of ['a', 'b', 'c']) tr.observe({ id, lat: 50 + id.charCodeAt(0) * 0.001, lon: i * 0.001, speed: 8 }, T0 + i * MIN);
  const saved = JSON.parse(JSON.stringify(tr.exportState()));
  const back = createDarkTracker(SHIP_DARK_CONFIG);
  back.importState(saved, T0 + 12 * MIN);
  assert.ok(Number.isFinite(back.restoredFrom));
  assert.equal(back.lastHeardAt('a'), T0 + 11 * MIN);
  // Long gap (restart) then reports resume: no false flags.
  const later = T0 + 40 * MIN;
  for (const id of ['a', 'b', 'c']) back.observe({ id, lat: 50, lon: 0.02, speed: 8 }, later);
  back.noteFeedHealth?.(true, null, later);
  const r = back.evaluate(later);
  assert.equal((r.flagged || []).length, 0);
});

test('flag log keeps 24 h, keeps first-flagged time, marks reappeared', () => {
  const log = createFlagLog();
  const f = { id: 'x', kind: 'ship', label: 'X', lat: 1, lon: 2, lastAt: T0, silentMs: 20 * MIN };
  log.update({ status: 'ok', flagged: [f] }, T0 + 20 * MIN);
  log.update({ status: 'ok', flagged: [{ ...f, silentMs: 25 * MIN }] }, T0 + 25 * MIN);
  assert.equal(log.list(T0 + 25 * MIN)[0].flaggedAt, T0 + 20 * MIN);
  log.update({ status: 'ok', flagged: [] }, T0 + 30 * MIN, () => T0 + 29 * MIN);
  assert.equal(log.list(T0 + 30 * MIN)[0].reappearedAt, T0 + 29 * MIN);
  const copy = createFlagLog();
  assert.equal(copy.importState(JSON.parse(JSON.stringify(log.exportState())), T0 + 31 * MIN), 1);
  assert.equal(copy.list(T0 + 25 * 60 * MIN).length, 0);
});

test('milReport converts units and uses position age', () => {
  const r = milReport({ hex: 'AE01CE', lat: 10, lon: 20, alt_baro: 30000, gs: 400, track: 90, seen_pos: 2, flight: 'RCH123 ' }, T0);
  assert.equal(r.id, 'ae01ce');
  assert.equal(r.label, 'RCH123');
  assert.ok(Math.abs(r.altitudeM - 9144) < 1);
  assert.ok(Math.abs(r.speed - 205.8) < 0.5);
  assert.equal(r.at, T0 - 2000);
  assert.equal(milReport({ hex: 'a', lat: null, lon: 1 }, T0), null);
  assert.equal(MIL_DARK_CONFIG.minPeers, 1);
});

test('military watcher polls a (fake) feed and reports honest status', async () => {
  let t = T0;
  const ac = [{ hex: 'aa', lat: 50, lon: 10, alt_baro: 25000, gs: 350, track: 0 }, { hex: 'bb', lat: 50.5, lon: 10.5, alt_baro: 25000, gs: 350, track: 0 }];
  let fail = false;
  const fetchImpl = async () => (fail ? { ok: false, status: 502, headers: new Map(), json: async () => ({}) }
    : { ok: true, status: 200, headers: new Map(), json: async () => ({ now: t, ac: ac.map((a) => ({ ...a, lat: a.lat + (t - T0) / 3.6e6 })) }) });
  const w = createMilAircraftWatcher({ fetchImpl, store: memStore(), now: () => t });
  assert.equal(w.snapshot().status, 'stale');
  assert.equal(await w.pollOnce(), true);
  const s = w.snapshot();
  assert.match(s.coverage, /worldwide/);
  assert.match(s.civilNote, /not checked/);
  assert.equal(s.aircraftInLastSnapshot, 2);
  fail = true; t += MIN;
  assert.equal(await w.pollOnce(), false);
  assert.match(w.snapshot().lastError, /502/);
});

test('export: CSV guards formulas, GeoJSON is valid points', () => {
  const rows = [darkRow({ id: '1', label: '=HYPERLINK("x")', lat: 1.234567, lon: -2, lastAt: T0, silentMs: 30 * MIN }, { kind: 'ship', source: 'AISStream', nowMs: T0 + 30 * MIN })];
  assert.equal(rows[0].silentMin, 30);
  const csv = toCsv(rows);
  assert.ok(csv.startsWith(DARK_COLUMNS.join(',')));
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  const gj = toGeoJson(rows, { kind: 'all' });
  assert.equal(gj.type, 'FeatureCollection');
  assert.deepEqual(gj.features[0].geometry.coordinates, [-2, 1.2346]);
});

test('GNSS history persists buckets and drops expired ones', () => {
  const h = createGnssHistory();
  assert.equal(h.record([{ lat: 50, lon: 10, degraded: true, hex: 'z' }], T0), 1);
  assert.equal(h.size, 1);
  const saved = JSON.parse(JSON.stringify(h.exportState()));
  const back = createGnssHistory();
  back.importState(saved, T0 + MIN);
  assert.equal(back.size, 1);
  const old = createGnssHistory();
  old.importState(saved, T0 + 25 * 60 * MIN);
  assert.equal(old.size, 0);
});

function call(plugin, url) {
  const mws = [];
  plugin.configureServer({ middlewares: { use: (p, fn) => mws.push([p, fn]) } });
  const [p, fn] = mws.find(([p]) => url.startsWith(p));
  return new Promise((resolve) => {
    const res = { headers: {}, writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { resolve({ status: this.status, headers: this.headers, body: b }); } };
    fn({ method: 'GET', url: url.slice(p.length) || '/' }, res, () => resolve({ status: 'next' }));
  });
}

test('public API routes: health, dark (json/csv/geojson), aircraft, index', async () => {
  resetBlackoutStoreForTest(memStore());
  assert.equal(blackoutPollersEnabled({}), false);
  assert.equal(blackoutPollersEnabled({ RAILWAY_PROJECT_ID: 'x' }), true);
  assert.equal(blackoutPollersEnabled({ RAILWAY_PROJECT_ID: 'x', BLACKOUT_POLLERS: 'off' }), false);
  const mil = createMilAircraftWatcher({ fetchImpl: async () => { throw new Error('offline'); }, store: memStore() });
  const plugin = blackoutPlugin({ env: {}, mil, regions: { status: () => ({ status: 'pending' }), latest: () => [], start() {} } });
  const h = await call(plugin, '/watch/health');
  assert.ok([200, 503].includes(h.status));
  const hb = JSON.parse(h.body);
  assert.ok(['ok', 'degraded', 'down'].includes(hb.status));
  assert.equal(hb.checks.storage.mode, 'memory');
  assert.equal(h.headers['Access-Control-Allow-Origin'], '*');
  const d = await call(plugin, '/api/blackout/v1/dark?window=24h');
  assert.equal(d.status, 200);
  assert.ok(Array.isArray(JSON.parse(d.body).rows));
  const c = await call(plugin, '/api/blackout/v1/dark?format=csv');
  assert.match(c.headers['Content-Type'], /text\/csv/);
  assert.match(c.headers['Content-Disposition'], /attachment/);
  const g = await call(plugin, '/api/blackout/v1/dark?format=geojson&kind=aircraft');
  assert.equal(JSON.parse(g.body).type, 'FeatureCollection');
  assert.equal((await call(plugin, '/api/blackout/v1/dark?kind=bogus')).status, 400);
  assert.equal(JSON.parse((await call(plugin, '/api/blackout/v1/aircraft')).body).status, 'stale');
  assert.equal((await call(plugin, '/api/blackout/v1')).status, 200);
  assert.equal((await call(plugin, '/api/blackout/v1/nope')).status, 404);
  resetBlackoutStoreForTest(null);
});
