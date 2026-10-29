// Fast reconnect after AISStream drops a healthy session, and the went-dark
// post-reconnect grace. Mock sockets and injected clocks/timers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAisWatchdog } from './aisWatchdog.js';
import { createAisStreamAdapter, isRecognizedAisEnvelope } from './aisStreamAdapter.js';
import { SHIP_DARK_CONFIG, createDarkTracker } from './wentDark.js';

const ENV = { hasKey: true, hasTransport: true, keyFingerprint: 'k' };
const MSG = JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: 123456789 }, Message: { PositionReport: { UserID: 123456789, Latitude: 1, Longitude: 2 } } });

function clock() {
  let mono = 10_000; let wall = 1_800_000_000_000;
  return { c: { mono: () => mono, wall: () => wall }, adv(ms) { mono += ms; wall += ms; } };
}

test('a healthy session dropped upstream re-dials after the short jittered delay, not the ladder', () => {
  const t = clock();
  const w = createAisWatchdog({ clock: t.c, backoffMs: [5_000, 15_000], quickReconnectMs: 1_000, jitterRatio: 0.25, random: () => 1 });
  w.configure(ENV);
  const [c1] = w.tick();
  w.onOpen(c1.generation);
  w.onMessage(c1.generation);
  t.adv(300_000);
  w.onMessage(c1.generation);
  w.onClose(c1.generation);
  const snap = w.snapshot();
  assert.equal(snap.status, 'reconnecting');
  assert.equal(snap.reconnectAttempt, 0);
  assert.equal(snap.retryInMs, 1_250);
  assert.equal(snap.sessions.quickReconnects, 1);
  assert.equal(snap.sessions.lastLifetimeMs, 300_000);
  assert.equal(snap.sessions.lastMessages, 2);
  t.adv(1_200);
  assert.deepEqual(w.tick(), []);
  t.adv(100);
  assert.equal(w.tick()[0].type, 'connect');
});

test('a session that dies quickly without data still walks the (jittered) backoff ladder', () => {
  const t = clock();
  const w = createAisWatchdog({ clock: t.c, backoffMs: [5_000, 15_000], jitterRatio: 0.2, random: () => 0 });
  w.configure(ENV);
  const [c1] = w.tick();
  w.onOpen(c1.generation);
  t.adv(2_000);
  w.onClose(c1.generation);
  assert.equal(w.snapshot().reconnectAttempt, 1);
  assert.equal(w.snapshot().retryInMs, 4_000);
  assert.equal(w.snapshot().sessions.quickReconnects, 0);
  // A short session with data is not "healthy" either.
  t.adv(4_000);
  const [c2] = w.tick();
  w.onMessage(c2.generation);
  t.adv(10_000);
  w.onClose(c2.generation);
  assert.equal(w.snapshot().retryInMs, 4_000);
});

test('the adapter re-drives the machine from the close event instead of waiting for the next tick', () => {
  const t = clock();
  const timers = [];
  const sockets = [];
  class Sock {
    constructor() { this.readyState = 0; this.h = new Map(); sockets.push(this); }
    on(e, f) { (this.h.get(e) || this.h.set(e, []).get(e)).push(f); }
    emit(e, ...a) { for (const f of this.h.get(e) || []) f(...a); }
    send() {}
    ping() {}
    terminate() { this.readyState = 3; }
  }
  const a = createAisStreamAdapter({
    createSocket: () => new Sock(),
    resolveUrl: () => 'ws://mock.invalid',
    buildSubscription: () => ({}),
    ingestEnvelope: isRecognizedAisEnvelope,
    clock: t.c,
    setTimer: (fn, ms) => { const x = { fn, ms }; timers.push(x); return x; },
    clearTimer: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
  });
  a.setWatchdogOptions({ quickReconnectMs: 1_000, backoffMs: [5_000] });
  a.ensure(ENV);
  sockets[0].readyState = 1; sockets[0].emit('open');
  sockets[0].emit('message', MSG);
  assert.equal(a.snapshot().status, 'live');
  t.adv(120_000);
  sockets[0].emit('message', MSG);
  sockets[0].emit('close', 1006, Buffer.from(''));
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms >= 1_000 && timers[0].ms < 2_000);
  t.adv(timers[0].ms);
  timers.shift().fn();
  assert.equal(sockets.length, 2, 'a new socket was opened by the redial timer');
  a.dispose();
});

test('went-dark holds flags during the post-reconnect grace and annotates feed-gap time', () => {
  const T0 = 1_800_000_000_000;
  const MIN = 60_000;
  const cfg = { ...SHIP_DARK_CONFIG, minPeers: 0, partialMinHistoryMin: 10_000 };
  const tr = createDarkTracker(cfg);
  const id = '111';
  for (let i = 0; i < 12; i += 1) {
    const now = T0 + i * 30_000;
    tr.observe({ id, lat: 10 + i * 0.001, lon: 20, at: now, speed: 10 }, now);
    tr.observe({ id: 'keep', lat: 11, lon: 21, at: now, speed: 10 }, now);
  }
  const last = T0 + 11 * 30_000;
  let now = last;
  const keep = (to) => { for (; now < to; now += 30_000) tr.observe({ id: 'keep', lat: 11, lon: 21, at: now, speed: 10 }, now); };
  keep(last + 25 * MIN);
  tr.noteFeedHealth(false, 'AIS feed connecting', now);
  now += 2_000;
  tr.noteFeedHealth(true, null, now);
  keep(now + 60_000);
  const during = tr.evaluate(now);
  assert.equal(during.status, 'recovering');
  assert.equal(during.flagged.length, 0);
  keep(now + 70_000);
  const after = tr.evaluate(now);
  assert.equal(after.status, 'ok');
  const f = after.flagged.find((x) => String(x.id) === id);
  assert.ok(f, 'still-silent ship is flagged once the grace ends');
  assert.ok(f.feedGapMs > 0, 'flag carries the feed-gap overlap');
});
