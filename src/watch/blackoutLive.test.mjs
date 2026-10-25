// Live map, activity feed, disappearance history and email alerts.
// Every target, subscriber and mail here is a SIMULATED test fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPersistStore } from '../../server/blackout/persist.js';
import { placeName, areasAt } from '../../server/blackout/places.js';
import { createActivity, eventText } from '../../server/blackout/activity.js';
import { createAlerts, eventMatches, normalizeEmail } from '../../server/blackout/alerts.js';
import { createMailer, mailConfig } from '../../server/blackout/mailer.js';
import { createLive, parseBbox, thin, MAX_POINTS } from '../../server/blackout/live.js';
import { historyCsv } from '../../server/blackout/pages.js';
import { blackoutPlugin } from '../../server/blackout/plugin.js';

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const memStore = () => createPersistStore({ dir: null, warn: () => {} });
const fakeMailer = () => { const sent = []; return { sent, mode: 'live', send: async (m) => { sent.push(m); return { ok: true, mode: 'live' }; }, status: () => ({ mode: 'live', sent: sent.length }) }; };
const flag = (id, lastAt, extra = {}) => ({ id, label: `TEST-${id}`, lat: 43.2, lon: 34.1, lastAt, flaggedAt: lastAt + 20 * MIN, speed: 6, heading: 90, ...extra });

test('places: seas, straits, oceans and land are named honestly', () => {
  assert.equal(placeName(43, 34), 'Black Sea');
  assert.equal(placeName(26.5, 56.4), 'Strait of Hormuz');
  assert.match(placeName(49, 30), /^land at /);
  assert.equal(placeName(NaN, 0), null);
  assert.ok(areasAt(26.5, 56.4).includes('hormuz'));
});

test('activity: went dark, reappeared, GNSS rise; no duplicates; persists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-act-'));
  let shipFlags = [flag('111', T0)];
  let regions = [{ id: 'black-sea', name: 'Black Sea', anchor: { lat: 44, lon: 34 }, aircraft: 10, share: 0.05, at: T0 }];
  const store = createPersistStore({ dir, warn: () => {}, intervalMs: 1e9 });
  const a = createActivity({ store, sources: { shipFlags: () => shipFlags, milFlags: () => [], regions: () => regions } });
  a.tick(T0 + 25 * MIN);
  a.tick(T0 + 26 * MIN);
  let ev = a.list();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'went_dark');
  assert.equal(ev[0].text, 'Ship TEST-111 lost signal near Black Sea');
  assert.equal(ev[0].provenance, 'inferred');
  shipFlags = [flag('111', T0, { reappearedAt: T0 + 70 * MIN })];
  regions = [{ ...regions[0], share: 0.4, at: T0 + 30 * MIN }];
  a.tick(T0 + 71 * MIN);
  ev = a.list();
  assert.deepEqual(ev.map((e) => e.type).sort(), ['gnss_rise', 'reappeared', 'went_dark']);
  assert.match(ev.find((e) => e.type === 'reappeared').text, /reappeared after 70 min/);
  assert.match(eventText(ev.find((e) => e.type === 'gnss_rise')), /GPS interference rose in Black Sea: 40%/);
  const h = a.historyList({}, T0 + 72 * MIN);
  assert.equal(h.total, 1);
  assert.equal(h.rows[0].state, 'reappeared');
  assert.equal(h.rows[0].darkMin, 70);
  assert.equal(a.historyList({ state: 'dark' }).total, 0);
  assert.equal(a.historyList({ area: 'black-sea' }).total, 1);
  assert.equal(a.list({ since: ev[0].id }).length, 0);
  await store.saveAll();
  const b = createActivity({ store: createPersistStore({ dir, warn: () => {} }), sources: { shipFlags: () => shipFlags } });
  b.tick(T0 + 80 * MIN);
  assert.equal(b.list().length, 3, 'restored events, nothing re-emitted');
  assert.equal(b.historyList({}).total, 1);
  assert.match(historyCsv(b.historyList({}).rows).split('\r\n')[0], /^kind,id,label,state/);
});

test('live map: ships thinned on a grid, bbox, aircraft and dark list', () => {
  const rows = [];
  for (let i = 0; i < 20_000; i += 1) rows.push({ mmsi: 200000000 + i, lat: (i % 160) - 80, lon: ((i * 7) % 360) - 180, speed: 10, course: 45, last_position_epoch: T0 / 1000 - 60 });
  const live = createLive({ now: () => T0, shipRows: () => rows, aircraft: () => ({ at: T0, list: [{ id: 'ae0001', lat: 40, lon: -75, heading: 10, speed: 200, at: T0 - 5000, label: 'TEST01', type: 'C17' }] }), dark: () => [{ id: 'x', kind: 'ship' }] });
  const p = live.payload({}, T0);
  assert.equal(p.ships.total, 20_000);
  assert.ok(p.ships.rows.length <= MAX_POINTS);
  assert.equal(p.ships.rows.reduce((s, r) => s + r[6], 0), 20_000, 'cluster counts add up');
  assert.equal(p.aircraft.rows[0][4], 389);
  assert.equal(p.dark.length, 1);
  const box = live.payload({ bbox: parseBbox('-10,30,10,50') }, T0);
  assert.ok(box.ships.visible < 20_000 && box.ships.rows.every((r) => r[1] >= -10 && r[1] <= 10));
  assert.equal(parseBbox('1,2,3'), null);
  assert.deepEqual(thin([['a', 0.1, 0.1, 0, 0, 5], ['b', 0.2, 0.2, 0, 0, 1]], 1).map((r) => [r[0], r[6]]), [['b', 2]]);
  assert.deepEqual(p.provenance, { positions: 'observed', dark: 'inferred' });
});

test('mailer: dry run by default, live needs key and sender, never logs addresses', async () => {
  assert.equal(mailConfig({}).mode, 'dryrun');
  assert.equal(mailConfig({ BLACKOUT_MAIL_MODE: 'live' }).mode, 'dryrun');
  assert.match(mailConfig({ BLACKOUT_MAIL_MODE: 'live' }).reason, /RESEND_API_KEY/);
  assert.equal(mailConfig({ BLACKOUT_MAIL_MODE: 'live', RESEND_API_KEY: 'k', BLACKOUT_MAIL_FROM: 'Blackout <alerts@example.test>' }).mode, 'live');
  const logs = [];
  const m = createMailer({ env: {}, log: (s) => logs.push(s) });
  await m.send({ to: 'someone@example.test', subject: 'S', text: 'secret-link', ref: 'abc' });
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('someone@') && !logs[0].includes('secret-link'));
  let req;
  const live = createMailer({ env: { BLACKOUT_MAIL_MODE: 'live', RESEND_API_KEY: 'k', BLACKOUT_MAIL_FROM: 'a@example.test' }, fetchImpl: async (u, o) => { req = { u, o }; return { ok: true, json: async () => ({ id: 'm1' }) }; } });
  assert.deepEqual(await live.send({ to: 't@example.test', subject: 's', text: 't' }), { ok: true, mode: 'live', id: 'm1' });
  assert.equal(JSON.parse(req.o.body).to[0], 't@example.test');
});

test('alerts: double opt-in, filters, digest throttle, unsubscribe deletes', async () => {
  assert.equal(normalizeEmail(' A@Example.test '), 'a@example.test');
  assert.equal(normalizeEmail('nope'), null);
  let t = T0;
  const mailer = fakeMailer();
  const al = createAlerts({ store: memStore(), mailer, now: () => t, publicUrl: 'https://x.test', env: {} });
  const r = await al.subscribe({ email: 'fixture@example.test', areas: ['black-sea', 'bogus'], types: ['ship'], ip: '1.1.1.1' });
  assert.equal(r.ok, true);
  assert.equal(mailer.sent.length, 1);
  assert.match(mailer.sent[0].subject, /Confirm/);
  assert.match(mailer.sent[0].headers['List-Unsubscribe'], /unsubscribe\?t=/);
  const sub = [...al._subsForTest.values()][0];
  assert.deepEqual(sub.areas, ['black-sea']);
  const ev = { id: '1', type: 'went_dark', kind: 'ship', at: t, areas: ['black-sea'], text: 'Ship X lost signal near Black Sea' };
  assert.equal(al.onEvent(ev, t), 0, 'pending subscribers get nothing');
  await al.flush(t);
  assert.equal(mailer.sent.length, 1);
  assert.equal(al.confirm(sub.confirmToken, t).ok, true);
  assert.equal(al.confirm('wrong', t).ok, false);
  t += MIN;
  assert.equal(al.onEvent({ ...ev, at: t }, t), 1);
  assert.equal(al.onEvent({ ...ev, id: '2', at: t, kind: 'military-aircraft' }, t), 0, 'type filter');
  assert.equal(al.onEvent({ ...ev, id: '3', at: t, areas: ['baltic'] }, t), 0, 'area filter');
  await al.flush(t);
  assert.equal(mailer.sent.length, 2);
  assert.match(mailer.sent[1].text, /Unsubscribe \(one click\): https:\/\/x\.test\/watch\/alerts\/unsubscribe\?t=/);
  al.onEvent({ ...ev, id: '4', at: t + MIN }, t + MIN);
  await al.flush(t + 10 * MIN);
  assert.equal(mailer.sent.length, 2, 'throttled: one digest per hour');
  await al.flush(t + 61 * MIN);
  assert.equal(mailer.sent.length, 3);
  assert.equal(al.unsubscribe(sub.unsubToken).ok, true);
  assert.equal(al._subsForTest.size, 0);
  assert.equal(eventMatches({ type: 'reappeared', kind: 'ship', areas: [] }, { types: ['ship'], areas: [] }), false);
});

test('alerts: anti-abuse — honeypot, rate limits, generic answers, pending expiry', async () => {
  let t = T0;
  const mailer = fakeMailer();
  const al = createAlerts({ store: memStore(), mailer, now: () => t, env: {} });
  await al.subscribe({ email: 'bot@example.test', honeypot: 'http://spam', ip: '2.2.2.2' });
  assert.equal(al._subsForTest.size, 0);
  for (let i = 0; i < 5; i += 1) assert.equal((await al.subscribe({ email: `u${i}@example.test`, ip: '3.3.3.3' })).ok, true);
  assert.equal((await al.subscribe({ email: 'u9@example.test', ip: '3.3.3.3' })).error, 'rate_limited');
  const again = await al.subscribe({ email: 'u0@example.test', ip: '4.4.4.4' });
  assert.equal(again.ok, true);
  assert.equal(mailer.sent.length, 5, 'no repeat confirmation within 30 min');
  t += 49 * 3_600_000;
  await al.flush(t);
  assert.equal(al._subsForTest.size, 0, 'unconfirmed sign-ups expire after 48 h');
});

function serve(plugin) {
  const uses = [];
  plugin.configureServer({ middlewares: { use: (p, fn) => uses.push([p, fn]) } });
  const srv = http.createServer((req, res) => {
    const u = uses.find(([p]) => req.url === p || req.url.startsWith(`${p}/`) || req.url.startsWith(`${p}?`));
    if (!u) { res.writeHead(404); return res.end(); }
    req.url = req.url.slice(u[0].length) || '/';
    u[1](req, res, () => { res.writeHead(404); res.end(); });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

test('HTTP: live, events, history exports, sign-up, confirm page, unsubscribe', async () => {
  const mailer = fakeMailer();
  const mil = { positions: () => ({ at: T0, list: [] }), snapshot: () => ({ status: 'stale', flagged: [] }), recent: () => [], start() {}, stop() {} };
  const plugin = blackoutPlugin({ env: {}, store: memStore(), mailer, mil, regions: { status: () => ({ status: 'pending' }), latest: () => [], start() {} }, shipRowsImpl: () => [{ mmsi: 211000001, lat: 54, lon: 10, speed: 5, course: 0, last_position_epoch: Date.now() / 1000 }], shipVesselImpl: (id) => (id === '211000001' ? { mmsi: 211000001, name: 'TEST VESSEL', lat: 54, lon: 10 } : null) });
  const { srv, base } = await serve(plugin);
  try {
    const live = await (await fetch(`${base}/api/blackout/v1/live`)).json();
    assert.equal(live.ships.total, 1);
    const tgt = await fetch(`${base}/api/blackout/v1/target?kind=ship&id=211000001`);
    assert.equal(tgt.status, 200);
    assert.equal((await tgt.json()).place, 'Baltic Sea');
    assert.equal((await fetch(`${base}/api/blackout/v1/target?kind=ship&id=999`)).status, 404);
    assert.equal((await fetch(`${base}/api/blackout/v1/events`)).status, 200);
    const hc = await fetch(`${base}/api/blackout/v1/history?format=csv`);
    assert.match(hc.headers.get('content-disposition'), /blackout-disappearances/);
    assert.equal((await (await fetch(`${base}/api/blackout/v1/history?format=geojson`)).json()).type, 'FeatureCollection');
    assert.equal((await fetch(`${base}/api/blackout/v1/history?area=nowhere`)).status, 400);
    assert.equal((await fetch(`${base}/api/blackout/v1/alerts/subscribe`)).status, 405);
    const cross = await fetch(`${base}/api/blackout/v1/alerts/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' }, body: '{"email":"a@example.test"}' });
    assert.equal(cross.status, 403);
    const big = await fetch(`${base}/api/blackout/v1/alerts/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.test', pad: 'x'.repeat(5000) }) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
    const ok = await fetch(`${base}/api/blackout/v1/alerts/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'fixture2@example.test', types: ['ship', 'gnss'], areas: [] }) });
    assert.equal(ok.status, 200);
    const sub = [...plugin._core().alerts._subsForTest.values()][0];
    const page = await (await fetch(`${base}/watch/alerts/confirm?t=${sub.confirmToken}`)).text();
    assert.match(page, /<form method="post"/);
    assert.equal(sub.status, 'pending', 'GET alone never confirms');
    const conf = await fetch(`${base}/watch/alerts/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `t=${sub.confirmToken}` });
    assert.equal(conf.status, 200);
    assert.equal(sub.status, 'active');
    const un = await fetch(`${base}/watch/alerts/unsubscribe?t=${sub.unsubToken}`, { method: 'POST', body: 'List-Unsubscribe=One-Click' });
    assert.equal(un.status, 200);
    assert.equal(plugin._core().alerts._subsForTest.size, 0);
    const health = await (await fetch(`${base}/watch/health`)).json();
    assert.equal(health.checks.alerts.subscribers.active, 0);
    assert.ok(!JSON.stringify(health).includes('@example.test'));
  } finally { srv.close(); plugin._stop(); }
});
