import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as m from './model.js';
import { decodeLayerStateParams } from '../data/layerState.js';
import { LAYER_PROVENANCE } from '../provenance/provenance.js';
import { HTML_ENTRIES, stripCesiumFromWatch } from '../../build/vite.js';
import * as credits from '../data/dataCreditList.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const MIN = 60_000;

test('flights feed: regional coverage is not live; old snapshot is stale; failure is down', () => {
  const ok = { ok: true, payload: { time: NOW / 1000 - 5, states: [1, 2] }, headers: { coverage: '250nm regional live', source: 'adsb.lol' } };
  assert.equal(m.flightsFeed(ok, NOW).state, 'regional');
  assert.equal(m.flightsFeed(ok, NOW).count, 2);
  assert.equal(m.flightsFeed({ ...ok, payload: { time: NOW / 1000 - 600 } }, NOW).state, 'stale');
  assert.equal(m.flightsFeed({ ok: false, error: 'timeout' }, NOW).state, 'down');
});

test('military, ais, gpsjam and gnss feed states', () => {
  assert.equal(m.militaryFeed({ ok: true, payload: { ac: [1], now: NOW - 3000 } }, NOW).state, 'live');
  assert.equal(m.militaryFeed({ ok: true, payload: { ac: [], now: (NOW - 10 * MIN) / 1000 } }, NOW).state, 'stale');
  const ais = { status: 'ok', tracked: 10, lastReportAt: NOW - 1000, startedAt: NOW - 5 * MIN };
  assert.equal(m.aisFeed({ ok: true, payload: ais }, NOW).state, 'warming');
  assert.equal(m.aisFeed({ ok: true, payload: { ...ais, startedAt: NOW - 60 * MIN } }, NOW).state, 'live');
  assert.equal(m.aisFeed({ ok: true, payload: { ...ais, status: 'partial', startedAt: 0 } }, NOW).state, 'partial');
  assert.equal(m.aisFeed({ ok: true, payload: { status: 'stale' } }, NOW).state, 'stale');
  assert.equal(m.aisFeed({ ok: true, payload: { enabled: false } }, NOW).state, 'down');
  assert.equal(m.gpsjamFeed({ ok: true, payload: { latest: '2026-10-24', dates: ['2026-10-24'] } }, NOW).state, 'live');
  assert.equal(m.gpsjamFeed({ ok: true, payload: { latest: '2026-10-01' } }, NOW).state, 'stale');
  assert.equal(m.gnssFeed({ ok: true, payload: { frames: [] } }, NOW).state, 'warming');
  assert.equal(m.gnssFeed({ ok: true, payload: { frames: [{ at: NOW - 5 * MIN }], newestAt: NOW - 5 * MIN, bucketMs: 5 * MIN } }, NOW).state, 'regional');
});

test('health banner: null when all live, alert when any stale/down', () => {
  assert.equal(m.healthBanner([{ state: 'live' }]), null);
  const b = m.healthBanner([{ name: 'A', state: 'regional', detail: 'x' }, { name: 'B', state: 'down', detail: 'y' }]);
  assert.equal(b.level, 'alert');
  assert.match(b.text, /A: regional — x · B: down — y/);
  assert.equal(m.healthBanner([{ name: 'A', state: 'warming', detail: 'x' }]).level, 'caution');
  assert.equal(m.feedHealth({}, NOW).length, 5);
});

test('globe deep link decodes to the requested layers and position', () => {
  const href = m.globeDeepLink({ lat: 55.5, lon: 20.25, layers: ['went-dark', 'ais-live-vessels'] });
  assert.ok(href.startsWith('/#'));
  const params = new URLSearchParams(href.slice(2));
  assert.equal(params.get('lat'), '55.5000');
  assert.equal(params.get('lon'), '20.2500');
  const state = decodeLayerStateParams(params);
  assert.ok(state.enabledLayerIds.includes('went-dark'));
  assert.ok(state.enabledLayerIds.includes('ais-live-vessels'));
});

test('went-dark rows merge ships and aircraft, most recent first', () => {
  const ships = { status: 'ok', generatedAt: NOW, fetchedLocalMs: NOW, flagged: [
    { id: '1', label: 'OLD SHIP', lat: 1, lon: 2, lastAt: NOW - 30 * MIN },
    { id: '2', lat: -3, lon: -4, lastAt: NOW - 2 * MIN },
  ] };
  const air = { status: 'ok', feedNowMs: NOW, fetchedLocalMs: NOW, flagged: [{ id: 'abc', lat: 5, lon: 6, lastAt: NOW - 10 * MIN }] };
  const r = m.wentDarkRows(ships, air, NOW);
  assert.equal(r.ships, 2);
  assert.equal(r.aircraft, 1);
  assert.deepEqual(r.rows.map((x) => x.id), ['ship:2', 'aircraft:abc', 'ship:1']);
  assert.equal(r.rows[2].label, 'OLD SHIP');
  assert.equal(r.rows[0].position, '3.00°S 4.00°W');
  assert.ok(decodeLayerStateParams(new URLSearchParams(r.rows[1].href.slice(2))).enabledLayerIds.includes('flights'));
  assert.equal(m.wentDarkRows({ status: 'stale', flagged: [{ id: 'x' }] }, null, NOW).rows.length, 0);
});

test('went-dark side notes are honest about warming and paused feeds', () => {
  assert.match(m.wentDarkSideNote(null, 'Ships'), /not loaded/);
  assert.match(m.wentDarkSideNote({ status: 'stale', reason: 'no data' }, 'Ships', NOW), /paused — no data/);
  assert.match(m.wentDarkSideNote({ status: 'ok', startedAt: NOW - MIN, flagged: [] }, 'Ships', NOW), /20 minutes/);
  assert.match(m.wentDarkSideNote({ status: 'ok', startedAt: 0, flagged: [], steady: 3, tracked: 9 }, 'Ships', NOW), /3 steady of 9/);
  assert.equal(m.wentDarkSideNote({ status: 'ok', startedAt: 0, flagged: [{}] }, 'Ships', NOW), null);
});

test('jamming timeline is chronological: gpsjam days then GNSS frames', () => {
  const steps = m.jammingTimeline(['2026-10-24', '2026-10-23', 'bad'], [{ at: NOW - MIN }, { at: 'x' }]);
  assert.deepEqual(steps.map((s) => s.kind), ['gpsjam', 'gpsjam', 'gnss']);
  assert.equal(steps[0].key, '2026-10-23');
  assert.match(m.historyNote(['2026-09-25', '2026-10-24'], { frames: [], startedAt: NOW - MIN }, NOW), /2 daily files.*no frames yet.*lost on restart/);
  assert.match(m.historyNote([], { frames: [{}, {}], oldestAt: NOW - 5 * MIN, newestAt: NOW, bucketMs: 5 * MIN, startedAt: NOW - 60 * MIN }, NOW), /2 five-minute frames covering about 10 min/);
});

test('jam points, region counts and projection', () => {
  const pts = m.jamPoints({ kind: 'gpsjam' }, { rows: [{ lat: 60, lon: 20, level: 2 }, { lat: 0, lon: 0, level: 1 }] });
  const counts = Object.fromEntries(m.regionCounts(pts).map((r) => [r.id, r.count]));
  assert.equal(counts.baltic, 1);
  assert.equal(counts.myanmar, 0);
  const g = m.jamPoints({ kind: 'gnss' }, { frame: { cells: [{ state: 'nominal' }, { state: 'degraded', lat: 1, lon: 2, west: 1, south: 0, east: 3, north: 2 }] } });
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].box, [1, 0, 3, 2]);
  assert.deepEqual(m.project(-180, 90, 360, 180), [0, 0]);
  assert.deepEqual(m.project(0, 0, 360, 180), [180, 90]);
});

test('provenance rows cover every layer with a badge and licence', () => {
  const { rows, totals } = m.provenanceRows({ flights: { count: 5, atMs: NOW - 5000 } }, NOW);
  assert.equal(rows.length, Object.keys(LAYER_PROVENANCE).length);
  assert.equal(totals.observed + totals.inferred + totals.simulated, rows.length);
  const f = rows.find((r) => r.layerId === 'flights');
  assert.equal(f.count, 5);
  assert.match(f.freshness, /ago$/);
  for (const r of rows) { assert.ok(r.badge); assert.ok(r.licence); }
  for (const id of m.COUNTED_LAYERS) assert.ok(LAYER_PROVENANCE[id], id);
  assert.match(m.MAP_CREDIT_TEXT, /Natural Earth/);
});

test('updatedAgo wording', () => {
  assert.equal(m.updatedAgo(NaN, NOW), 'not updated yet');
  assert.equal(m.updatedAgo(NOW - 12_000, NOW), 'updated 12 s ago');
  assert.equal(m.updatedAgo(NOW - 5 * MIN, NOW), 'updated 5 min ago');
});

test('watch entry: build input, no external URLs, no Cesium, valid land data', () => {
  assert.ok(HTML_ENTRIES.index.endsWith('index.html'));
  assert.ok(HTML_ENTRIES.watch.endsWith('watch.html'));
  const html = readFileSync(new URL('../../watch.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /https?:\/\//);
  const css = readFileSync(new URL('./watch.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/);
  const js = readFileSync(new URL('./main.js', import.meta.url), 'utf8') + readFileSync(new URL('./model.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /from ['"]cesium['"]|dataCredits\.js/);
  const injected = '<link rel="stylesheet" href="/cesium/Widgets/widgets.css">\n<script src="/cesium/Cesium.js"></script>\n<p>x</p>';
  assert.equal(stripCesiumFromWatch(injected, '/watch.html'), '<p>x</p>');
  assert.equal(stripCesiumFromWatch(injected, '/index.html'), injected);
  const land = JSON.parse(readFileSync(new URL('../../public/watch/land-110m.json', import.meta.url), 'utf8'));
  const rings = Array.isArray(land) ? land : land.rings;
  assert.ok(rings.length > 50);
});

test('dataCredits split keeps credit exports available', () => {
  assert.ok(Array.isArray(credits.DATA_CREDITS) && credits.DATA_CREDITS.length > 10);
  assert.ok(credits.NATURAL_EARTH_CREDIT);
  const src = readFileSync(new URL('../data/dataCredits.js', import.meta.url), 'utf8');
  assert.match(src, /export \* from '\.\/dataCreditList\.js'/);
});
