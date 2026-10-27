// AIS feed reconnects: client keepalive pings and went-dark grace around
// feed outages. Simulated targets and mock sockets only — no live data, no
// network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAisStreamAdapter, isRecognizedAisEnvelope } from './aisStreamAdapter.js';
import { SHIP_DARK_CONFIG, createDarkTracker } from './wentDark.js';

const MIN = 60_000;
const T0 = 1_800_000_000_000;

function mockAdapter(keepaliveMs) {
  let mono = 10_000;
  let wall = T0;
  const sockets = [];
  const warnings = [];
  class Sock {
    constructor() { this.readyState = 0; this.pings = 0; this.h = new Map(); sockets.push(this); }
    on(e, f) { (this.h.get(e) || this.h.set(e, []).get(e)).push(f); }
    emit(e, ...a) { for (const f of this.h.get(e) || []) f(...a); }
    send() {}
    ping() { this.pings += 1; }
    terminate() { this.readyState = 3; }
    open() { this.readyState = 1; this.emit('open'); }
  }
  const adapter = createAisStreamAdapter({
    createSocket: () => new Sock(),
    resolveUrl: () => 'ws://mock.invalid',
    buildSubscription: () => ({}),
    ingestEnvelope: isRecognizedAisEnvelope,
    clock: { wall: () => wall, mono: () => mono },
    warn: (m) => warnings.push(m),
    keepaliveMs,
  });
  adapter.setWatchdogOptions({ staleMs: 120_000, recycleAfterMs: 300_000, backoffMs: [5_000] });
  return { adapter, sockets, warnings, advance: (ms) => { mono += ms; wall += ms; } };
}
const ENV = { hasKey: true, hasTransport: true, keyFingerprint: 'k' };

test('the adapter pings the open socket on the keepalive cadence, never a connecting one', () => {
  const m = mockAdapter(15_000);
  m.adapter.ensure(ENV); // connect
  assert.equal(m.sockets.length, 1);
  assert.equal(m.sockets[0].pings, 0, 'no ping before the handshake completes');
  m.sockets[0].open();
  m.adapter.ensure(ENV);
  assert.equal(m.sockets[0].pings, 1);
  m.advance(5_000);
  m.adapter.ensure(ENV); // a request-driven ensure inside the window: no extra ping
  assert.equal(m.sockets[0].pings, 1);
  m.advance(10_000);
  m.adapter.ensure(ENV);
  assert.equal(m.sockets[0].pings, 2);
  m.sockets[0].emit('pong');
  const ka = m.adapter.snapshot().keepalive;
  assert.equal(ka.pings, 2);
  assert.equal(ka.pongs, 1);
  assert.equal(ka.everyMs, 15_000);
});

test('pings and pongs never count as feed liveness', () => {
  const m = mockAdapter(15_000);
  m.adapter.ensure(ENV);
  m.sockets[0].open();
  for (let i = 0; i < 10; i += 1) { m.adapter.ensure(ENV); m.sockets[0].emit('pong'); m.advance(15_000); }
  assert.notEqual(m.adapter.snapshot().status, 'live');
  assert.equal(m.adapter.snapshot().lastMessageAt, null);
});

test('keepalive is off by default and an upstream close is recorded with its code', () => {
  const m = mockAdapter(undefined);
  m.adapter.ensure(ENV);
  m.sockets[0].open();
  m.adapter.ensure(ENV);
  assert.equal(m.sockets[0].pings, 0);
  m.sockets[0].emit('close', 1006, Buffer.from(''));
  const ka = m.adapter.snapshot().keepalive;
  assert.equal(ka.closes, 1);
  assert.equal(ka.lastClose.code, 1006);
  assert.ok(m.warnings.some((w) => /upstream closed the socket \(code 1006/.test(w)));
});

/** Steady ship + neighbours every minute; `dark` stops at `stopAt`. */
function run(tr, { until, stopAt, outages = [] }) {
  for (let t = T0; t <= until; t += MIN) {
    for (const [id, k] of [['dark', 0], ['p1', 1], ['p2', 2], ['p3', 3], ['p4', 4]]) {
      if (id === 'dark' && t > stopAt) continue;
      tr.observe({ id, lat: 50 + k * 0.01, lon: 0.001 * ((t - T0) / MIN), speed: 10 }, t);
    }
    for (const [a, b] of outages) {
      if (a > t && a < t + MIN) tr.noteFeedHealth(false, 'AIS feed reconnecting', a);
      if (b > t && b < t + MIN) tr.noteFeedHealth(true, null, b);
    }
  }
}

test('reconnect blips get grace: silence explained by feed outages is not flagged', () => {
  const stopAt = T0 + 10 * MIN;
  // Four ~30 s reconnects every 5 min during the ship's silence, as observed live.
  const outages = [1, 2, 3, 4].map((i) => [stopAt + i * 5 * MIN + 10_000, stopAt + i * 5 * MIN + 40_000]);
  const evalAt = stopAt + 23 * MIN;
  const tr = createDarkTracker(SHIP_DARK_CONFIG, { startedAt: T0 });
  run(tr, { until: evalAt, stopAt, outages });
  const res = tr.evaluate(evalAt);
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.flagged.map((f) => f.id), [], '23 min silent minus 4 padded outages (~12 min) is under 20 min');
  // Trip log keeps the raw outage times (30 s), not the padded span.
  const trip = res.feedTrips.recent[0];
  assert.equal(trip.end - trip.start, 30_000);
});

test('without grace the same history would have flagged (proves the grace is what suppresses it)', () => {
  const stopAt = T0 + 10 * MIN;
  const outages = [1, 2, 3, 4].map((i) => [stopAt + i * 5 * MIN + 10_000, stopAt + i * 5 * MIN + 40_000]);
  const evalAt = stopAt + 23 * MIN;
  const tr = createDarkTracker({ ...SHIP_DARK_CONFIG, outagePadBeforeMs: 0, outagePadAfterMs: 0 }, { startedAt: T0 });
  run(tr, { until: evalAt, stopAt, outages });
  assert.deepEqual(tr.evaluate(evalAt).flagged.map((f) => f.id), ['dark']);
});

test('a ship silent far beyond the outages is still flagged (grace does not hide real darkness)', () => {
  const stopAt = T0 + 10 * MIN;
  const outages = [1, 2, 3, 4].map((i) => [stopAt + i * 5 * MIN + 10_000, stopAt + i * 5 * MIN + 40_000]);
  const evalAt = stopAt + 35 * MIN;
  const tr = createDarkTracker(SHIP_DARK_CONFIG, { startedAt: T0 });
  run(tr, { until: evalAt, stopAt, outages });
  assert.deepEqual(tr.evaluate(evalAt).flagged.map((f) => f.id), ['dark']);
});

test('aircraft config has no outage padding (scope: AIS only)', async () => {
  const { AIRCRAFT_DARK_CONFIG } = await import('./wentDark.js');
  assert.equal(AIRCRAFT_DARK_CONFIG.outagePadBeforeMs, undefined);
  assert.equal(SHIP_DARK_CONFIG.outagePadBeforeMs, 90_000);
  assert.equal(SHIP_DARK_CONFIG.outagePadAfterMs, 60_000);
});
